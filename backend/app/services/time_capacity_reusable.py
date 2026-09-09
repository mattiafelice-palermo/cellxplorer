"""Bounded exact per-Cell arrays for ordinary consecutive Time navigation.

Only explicit idle preparation builds whole-source artifacts. Foreground workers
consume immutable arrays when present and otherwise keep the indexed read path.
Metadata, visibility, provenance, point budgets and range origins remain owned by
the ordinary request. No overlapping-window results are generated here.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import gzip
import hashlib
import json
import threading
from time import perf_counter
import zipfile
import zlib

import numpy as np

FORMAT_VERSION = 1
MAX_ARRAY_BYTES = 32 * 1024 * 1024
MEMORY_LIMIT_BYTES = 32 * 1024 * 1024  # per backend/worker process
MEMORY_LIMIT_ENTRIES = 8
_COLUMNS = ("cycle", "time_s", "voltage_v", "current_ma", "source_cycle")
_memory: OrderedDict[str, tuple[tuple[int, int, int], dict[str, np.ndarray], int]] = OrderedDict()
_memory_lock = threading.RLock()
_prepare_lock = threading.Lock()


def clear_memory() -> None:
    with _memory_lock:
        _memory.clear()


def memory_stats() -> dict[str, int]:
    with _memory_lock:
        return {"entries": len(_memory), "bytes": sum(entry[2] for entry in _memory.values())}


def supports_settings(settings: dict, *, precision: str = "standard", compact: bool = True,
                      refinement: bool = False) -> bool:
    return bool(precision == "standard" and compact and not refinement
                and settings.get("view") == "voltage_current"
                and settings.get("x_axis") == "time"
                and settings.get("display_mode") == "consecutive"
                and settings.get("time_reference") == "selected_range"
                and settings.get("voltage_channels") == ["voltage"]
                and not settings.get("cycles"))


def artifact_key(job, request) -> str | None:
    if not supports_settings(request.settings, precision=request.precision,
                             compact=request.compact, refinement=request.refinement):
        return None
    if len(job.plan.sources) != 1 or not job.plan.complete or len(job.descriptor.source_names) != 1:
        return None
    source = job.plan.sources[0]
    index = source.index
    # Conservative full-materialization admission before reading any full array.
    rows = index.get("raw_row_count", 0)
    if not isinstance(rows, int) or rows < 1 or rows * 8 * len(_COLUMNS) > MAX_ARRAY_BYTES:
        return None
    identity = {
        "version": FORMAT_VERSION, "cell": job.cell_id,
        "source": source.ref.file_hash, "parser": source.ref.parser_version,
        "calc": request.calc_version, "current_calc": request.current_calc_version,
        "layout": index.get("raw_layout_version"),
        "shape": index.get("raw_shape_fingerprint"),
        "rows": rows,
    }
    if not identity["shape"]:
        return None
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def artifact_path(key: str) -> Path:
    from . import analysis_cache

    if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
        raise ValueError("Invalid reusable artifact identity")
    # .gz files under results participate in existing inventory/cleanup/LRU budgets.
    return analysis_cache._RESULTS / "time_capacity_reusable" / key[:2] / f"{key}.npz.gz"


def _stamp(path: Path) -> tuple[int, int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size, stat.st_ino


def load_arrays(key: str) -> dict[str, np.ndarray] | None:
    path = artifact_path(key)
    name = str(path)
    with _memory_lock:
        try:
            stamp = _stamp(path)
        except OSError:
            _memory.pop(name, None)
            return None
        cached = _memory.pop(name, None)
        if cached is not None and cached[0] == stamp:
            _memory[name] = cached
            return cached[1]
        try:
            # Bound both compression layers before allocating arrays; never unpickle.
            with gzip.open(path, "rb") as source:
                payload = source.read(MAX_ARRAY_BYTES + 65537)
            if len(payload) > MAX_ARRAY_BYTES + 65536:
                return None
            with zipfile.ZipFile(BytesIO(payload)) as archive:
                if sum(item.file_size for item in archive.infolist()) > MAX_ARRAY_BYTES + 65536:
                    return None
            with np.load(BytesIO(payload), allow_pickle=False) as archive:
                if set(archive.files) != {*_COLUMNS, "identity"} or str(archive["identity"].item()) != key:
                    return None
                arrays = {column: archive[column] for column in _COLUMNS}
            count = len(arrays["cycle"])
            if not count or any(value.ndim != 1 or len(value) != count or value.dtype.kind not in "ifu"
                                for value in arrays.values()):
                return None
            cycles = arrays["cycle"]
            if (not np.isfinite(cycles).all() or (cycles < 1).any()
                    or (cycles != np.floor(cycles)).any() or (cycles[1:] < cycles[:-1]).any()):
                return None
            size = sum(value.nbytes for value in arrays.values())
            if size > min(MAX_ARRAY_BYTES, MEMORY_LIMIT_BYTES) or MEMORY_LIMIT_ENTRIES < 1:
                return None
            if _stamp(path) != stamp:
                return None
        except (OSError, ValueError, TypeError, KeyError, EOFError, OverflowError,
                zipfile.BadZipFile, zlib.error):
            return None
        for value in arrays.values():
            value.flags.writeable = False
        while _memory and (len(_memory) >= MEMORY_LIMIT_ENTRIES
                           or sum(entry[2] for entry in _memory.values()) + size > MEMORY_LIMIT_BYTES):
            _memory.popitem(last=False)
        _memory[name] = (stamp, arrays, size)
        return arrays


def prepare_job(job, request) -> tuple[str, bytes] | None:
    """Worker-only preparation from an owner-resolved complete Cell plan."""
    from . import analysis_engine as engine, time_capacity_workers as workers

    key = artifact_key(job, request)
    if key is None:
        return None
    raw = workers._materialize_read(job, perf_counter()).raw
    if raw.empty or not set(_COLUMNS).issubset(raw.columns):
        return None
    raw = raw.sort_values(["cycle", "segment", "record_index"])
    raw = engine._continuous_time(raw)
    raw = engine._restore_time_capacity_cycle_times(raw, dict(job.time_cycle_starts))
    arrays = {column: raw[column].to_numpy(copy=True) for column in _COLUMNS}
    if sum(value.nbytes for value in arrays.values()) > MAX_ARRAY_BYTES:
        return None
    stream = BytesIO()
    np.savez(stream, identity=np.array(key), **arrays)
    return key, stream.getvalue()


def store_arrays(key: str, payload: bytes) -> bool:
    from . import analysis_cache

    if len(payload) > MAX_ARRAY_BYTES + 65536:
        return False
    with analysis_cache._lock:
        analysis_cache._store_budgeted(artifact_path(key), payload)
        analysis_cache._prune_locked()
    return load_arrays(key) is not None


def prepare(db, spec: dict, provenance: dict | None) -> dict:
    """Prepare at most four Cell jobs in flight using the existing shared pool."""
    from . import analysis_engine as engine, cache, time_capacity_workers as workers

    result = {"status": "unsupported", "total": 0, "prepared": 0, "reused": 0, "skipped": 0}
    settings = engine.time_capacity_settings(spec.get("computation", {}))
    if not supports_settings(settings):
        return result
    full = deepcopy(spec)
    full.setdefault("computation", {}).setdefault("time_capacity", {}).update(
        cycle_start=1, cycle_end=None, cycles=[])
    with _prepare_lock, cache.background_layout_reads(True):
        engine.ensure_canonical_cycling_available(db, full)
        built = workers._build_jobs(db, full, provenance, use_current_versions=False,
                                   viewport_width=1200, precision="standard", compact=True)
        if built is None:
            return result
        jobs, request, _ = built
        distinct = {job.cell_id: job for job in jobs}
        result["total"] = len(distinct)
        pending = []
        for job in distinct.values():
            key = artifact_key(job, request)
            if key is None:
                result["skipped"] += 1
            elif load_arrays(key) is not None:
                result["reused"] += 1
            else:
                pending.append(job)
        for offset in range(0, len(pending), 4):
            batch = pending[offset:offset + 4]
            decision = workers.choose_execution(max(2, len(batch)), sum(job.estimated_rows for job in batch))
            pool = None
            if decision.mode == "process":
                try:
                    pool = workers._ready_pool(decision.workers)
                except workers.PoolNotReadyError:
                    pass
            if pool is not None:
                futures = [pool.submit(prepare_job, job, request) for job in batch]
                outputs = [future.result() for future in futures]
            else:
                outputs = [prepare_job(job, request) for job in batch]
            for output in outputs:
                if output is not None and store_arrays(*output):
                    result["prepared"] += 1
                else:
                    result["skipped"] += 1
    result["status"] = "ready" if result["total"] and not result["skipped"] else "limited"
    return result


def try_cell_result(job, request):
    """Return a normal Cell payload, or None to retain the established read path."""
    from . import analysis_engine as engine, time_capacity_workers as workers

    key = artifact_key(job, request)
    arrays = load_arrays(key) if key is not None else None
    if arrays is None or job.cycle_start is None or job.cycle_end is None:
        return None
    started = perf_counter()
    low = int(np.searchsorted(arrays["cycle"], job.cycle_start, side="left"))
    high = int(np.searchsorted(arrays["cycle"], job.cycle_end, side="right"))
    descriptor = job.descriptor
    trace = workers._empty_trace(descriptor, compact_ordinary_time=True)
    if high > low:
        if job.display_origin_time_s is None:
            return None
        cycles = arrays["cycle"][low:high]
        voltage = arrays["voltage_v"][low:high]
        current = arrays["current_ma"][low:high]
        factor = 3600.0 if request.settings["time_unit"] == "h" else 60.0 if request.settings["time_unit"] == "min" else 1.0
        display_x = arrays["time_s"][low:high] / factor - float(job.display_origin_time_s) / factor
        take = np.arange(high - low)
        if high - low > request.display_max_points_per_cell:
            take = engine._downsample_indices(high - low, request.display_max_points_per_cell,
                                              np.isfinite(voltage), [voltage])
        file_hash, filename = descriptor.source_names[0]
        trace.update(
            cycle=engine._jsonsafe_int(cycles[take]), display_x=engine._jsonsafe_plot(display_x[take], 6),
            voltage_v=engine._jsonsafe_plot(voltage[take], 5), current_ma=engine._jsonsafe_plot(current[take], 5),
            source_cycle=engine._jsonsafe_int(arrays["source_cycle"][low:high][take]),
            source_index=[0] * len(take),
            sources=[{"position": 1, "filename": filename, "hash": file_hash}],
        )
    return ({"trace": trace, "badges": [], "voltage_facts": list(descriptor.voltage_facts),
             "source_versions": list(descriptor.source_versions),
             "current_parser_versions": list(descriptor.current_parser_versions)},
            {"cells": [{"cell_id": job.cell_id, "reusable_data": "hit",
                        "selected_rows_before_transforms": high - low,
                        "cell_job_wall_ms": (perf_counter() - started) * 1000.0}]})
