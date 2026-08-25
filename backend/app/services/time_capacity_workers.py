"""Owner-resolved ordinary Time/Capacity execution.

This module is the production boundary selected by Spec 050.14.  The owner
process resolves SQLAlchemy state, source identities and indexed stitch plans;
workers receive only immutable, pickle-safe descriptors and read their own
Parquet cache.  The same per-Cell function is used directly for the serial
path and by the persistent spawned process pool.

The optimized path is intentionally narrow.  Legacy caches, protocol filters,
derivatives, full exports and any publication/freshness failure return control
to the established analysis engine, which remains the fail-closed fallback.
"""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy
from dataclasses import dataclass, replace
import ctypes
import logging
import math
import multiprocessing
import os
import pickle
import threading
from time import perf_counter, sleep as _sleep
from typing import Any, Literal

import numpy as np

try:
    import resource
except ImportError:  # pragma: no cover - Windows has no resource module
    resource = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

_MEGABYTE = 1024 * 1024
_POOL_LOCK = threading.RLock()
_POOL: ProcessPoolExecutor | None = None
_POOL_WORKERS: int | None = None
_POOL_STATE: Literal["stopped", "warming", "ready", "failed"] = "stopped"
_WARMUP_THREAD: threading.Thread | None = None
_POOL_FAILURE_LOGGED = False


@dataclass(frozen=True)
class HostResources:
    logical_cpus: int | None
    total_memory_bytes: int | None
    available_memory_bytes: int | None


@dataclass(frozen=True)
class ExecutionDecision:
    mode: Literal["serial", "process"]
    workers: int
    reason: str
    logical_cpus: int | None
    total_memory_bytes: int | None
    available_memory_bytes: int | None


class PoolNotReadyError(RuntimeError):
    """The persistent pool is not ready for interactive dispatch."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class RefinementUnavailable(RuntimeError):
    """The bounded indexed facts required for a safe refinement are absent."""


@dataclass(frozen=True)
class ResolvedCellDescriptor:
    """Immutable per-Cell state resolved before a worker is submitted."""

    cell_id: int
    cell_name: str
    label: str
    group_id: int | None
    group_name: str | None
    active_mass_mg: float | None
    nominal_capacity_mah: float | None
    electrode_area_cm2: float | None
    source_names: tuple[tuple[str, str], ...]
    source_descriptors: tuple[dict[str, Any], ...]
    segments: tuple[dict[str, Any], ...]
    missing: tuple[str, ...]
    missing_positions: tuple[int, ...]
    source_versions: tuple[tuple[str, str], ...]
    current_parser_versions: tuple[str, ...]
    voltage_facts: tuple[tuple[str, bool, str, str | None], ...]
    excluded: bool


@dataclass(frozen=True)
class ResolvedRequest:
    """Request values safe to pass to a spawned worker."""

    type: str
    settings: dict[str, Any]
    calc_version: str
    current_calc_version: str
    protocol_badges: tuple[dict[str, Any], ...]
    viewport_width: int
    precision: str
    compact: bool
    display_max_points_per_cell: int
    display_origin_cycle_start: int | None = None
    display_origin_capacity_by_cell: dict[int, float] | None = None
    refinement: bool = False
    refinement_viewport_x_min: float | None = None
    refinement_viewport_x_max: float | None = None


@dataclass(frozen=True)
class ReadJob:
    """Immutable owner-resolved plan and descriptor for one Cell."""

    index: int
    cell_id: int
    refs: tuple[Any, ...]
    explicit_cycles: tuple[int, ...]
    cycle_start: int | None
    cycle_end: int | None
    requested_columns: tuple[str, ...]
    derived_columns: tuple[str, ...]
    plan: Any
    requested_cycles: tuple[int, ...]
    plan_diagnostics: dict[str, Any]
    descriptor: ResolvedCellDescriptor
    estimated_rows: int
    time_origin_prefix_s: float | None = None
    display_origin_time_s: float | None = None


@dataclass
class ReadPayload:
    job: ReadJob
    plan: Any
    raw: Any
    prepared: Any
    diagnostics: dict[str, Any]
    queue_ms: float
    worker_wall_ms: float


@dataclass
class CellResult:
    index: int
    cell_id: int
    result: dict[str, Any]
    diagnostics: dict[str, Any]
    queue_ms: float
    worker_wall_ms: float
    worker_pid: int | None = None
    worker_rss_before_bytes: int | None = None
    worker_rss_after_bytes: int | None = None


def process_rss_bytes() -> int | None:
    """Return current process RSS using Windows APIs when available."""

    if os.name == "nt":
        class _ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        try:
            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            get_current_process = kernel32.GetCurrentProcess
            get_current_process.argtypes = ()
            get_current_process.restype = ctypes.c_void_p
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            get_process_memory_info = psapi.GetProcessMemoryInfo
            get_process_memory_info.argtypes = (
                ctypes.c_void_p,
                ctypes.POINTER(_ProcessMemoryCounters),
                ctypes.c_ulong,
            )
            get_process_memory_info.restype = ctypes.c_int
            if get_process_memory_info(
                get_current_process(),
                ctypes.byref(counters),
                counters.cb,
            ):
                return int(counters.WorkingSetSize)
        except Exception:
            return None
        return None
    try:
        if resource is None:
            return None
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value * (1024 if value < 10_000_000 else 1))
    except (AttributeError, OSError, ValueError):
        return None


def _memory_status() -> tuple[int | None, int | None]:
    """Return total/available physical memory without a production package."""

    if os.name == "nt":
        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        try:
            status = _MemoryStatusEx()
            status.dwLength = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullTotalPhys), int(status.ullAvailPhys)
        except Exception:
            return None, None
        return None, None

    try:
        page = int(os.sysconf("SC_PAGE_SIZE"))
        total = int(os.sysconf("SC_PHYS_PAGES")) * page
        available = int(os.sysconf("SC_AVPHYS_PAGES")) * page
        return total, available
    except (AttributeError, OSError, ValueError):
        return None, None


def host_resources() -> HostResources:
    total, available = _memory_status()
    return HostResources(
        logical_cpus=os.cpu_count(),
        total_memory_bytes=total,
        available_memory_bytes=available,
    )


def _estimated_worker_bytes(selected_rows: int, cell_count: int) -> int:
    """Bound the host gate using request facts, never timing history."""

    rows_per_cell = max(0, selected_rows // max(1, cell_count))
    # The fixed part covers imported scientific modules and the indexed frame;
    # the small row term covers the temporary NumPy/pandas arrays and compact
    # result object. This is deliberately conservative and dependency-free.
    return 128 * _MEGABYTE + rows_per_cell * 180


def choose_execution(
    cell_count: int,
    selected_rows: int,
    *,
    resources: HostResources | None = None,
    force_serial: bool = False,
) -> ExecutionDecision:
    """Choose bounded execution from deterministic request/host facts."""

    resources = resources or host_resources()
    common = {
        "logical_cpus": resources.logical_cpus,
        "total_memory_bytes": resources.total_memory_bytes,
        "available_memory_bytes": resources.available_memory_bytes,
    }
    if force_serial:
        return ExecutionDecision("serial", 1, "forced_serial", **common)
    # Spec 052.4: one Cell is one job, so there is nothing to split and the
    # dispatch only adds IPC. Every larger request benefits.
    if cell_count < 2:
        return ExecutionDecision("serial", 1, "single_cell", **common)
    # The former `selected_rows < max(12_000, cell_count * 4_000)` workload
    # floor is deliberately gone. It was excluding exactly the interactive
    # requests that need the pool most: a 6-Cell 10-cycle slider preview is
    # ~16.5k rows against a 24k floor, so it ran serially while four warm
    # workers idled. Measured on a warm pool, process dispatch won at every
    # size tested down to ~8.2k rows (2.2x) and from two Cells upward (1.6x at
    # 2, 2.9x at 4, 2.4x at 6); no lower crossover was found. The host and
    # memory gates below still bound how many workers the machine can afford,
    # which is the concern that actually needs a limit.
    if resources.logical_cpus is None or resources.total_memory_bytes is None or resources.available_memory_bytes is None:
        return ExecutionDecision("serial", 1, "host_resources_unavailable", **common)

    per_worker = _estimated_worker_bytes(selected_rows, cell_count)
    reserve = 512 * _MEGABYTE
    # Spec 052.4: jobs are per Cell, so a pool narrower than the selection runs
    # in rounds -- six Cells across four workers is two rounds, and the second
    # round carries only two jobs. Measured on the six-Cell time-axis moving
    # preview, dispatch fell from 34.8 ms (4 workers) to 23.5 ms (6). The pool
    # is sized once at startup from this same function, so the tier here and
    # the per-request decision stay consistent with `_ready_pool`'s exact match.
    if resources.logical_cpus >= 12:
        required = 6 * per_worker
        if (
            resources.total_memory_bytes >= required + reserve
            and resources.available_memory_bytes >= required
        ):
            return ExecutionDecision("process", 6, "broad_host_gate_6", **common)

    if resources.logical_cpus >= 8:
        required = 4 * per_worker
        if (
            resources.total_memory_bytes >= required + reserve
            and resources.available_memory_bytes >= required
        ):
            return ExecutionDecision("process", 4, "broad_host_gate_4", **common)

    if resources.logical_cpus >= 4:
        required = 2 * per_worker
        if (
            resources.total_memory_bytes >= required + reserve
            and resources.available_memory_bytes >= required
        ):
            return ExecutionDecision("process", 2, "broad_host_gate_2", **common)

    return ExecutionDecision("serial", 1, "host_resource_gate", **common)


# Spec 052.4: an instant ping lets one fast process answer several
# acknowledgements before its siblings have spawned, so warmup could conclude
# that fewer workers were resident than requested and fail closed to serial.
# Holding each acknowledgement briefly forces the pool to start a distinct
# process per concurrent ping. This is a startup-only cost on an already
# asynchronous warmup thread.
_WARMUP_PING_HOLD_SECONDS = 0.2


def _worker_ping(hold_seconds: float = 0.0) -> int:
    """Return the acknowledging worker PID after importing this module.

    Spec 052.6: the acknowledgement also imports the scientific stack a real
    job needs. This module's own top level pulls in only numpy -- pandas,
    pyarrow, `analysis_engine` and `time_capacity_path` are all imported lazily
    inside the functions that use them. A ping that merely returned its PID
    therefore proved the process existed while leaving it unable to do work
    without first paying that import.

    The cost landed on the first *real* job in each worker, which is the first
    dispatch of a drag: measured at ~1.6 s against ~20-60 ms for every request
    after it. Because the navigator admits one moving request at a time, the
    whole drag waits on it and the plot visibly freezes while the pointer keeps
    moving. Paying it here moves it into the asynchronous startup warmup, where
    nothing is waiting on it.
    """

    try:
        from . import analysis_engine, time_capacity_path  # noqa: F401
    except Exception:  # pragma: no cover - warmup must not fail on import
        logger.debug("Time/Capacity worker warmup import failed", exc_info=True)
    if hold_seconds > 0:
        _sleep(hold_seconds)
    return os.getpid()


def _new_pool(workers: int) -> ProcessPoolExecutor:
    from .process_priority import background_pool_initializer

    context = multiprocessing.get_context("spawn")
    return ProcessPoolExecutor(
        max_workers=workers,
        mp_context=context,
        initializer=background_pool_initializer,
    )


def _warm_pool(
    pool: ProcessPoolExecutor,
    workers: int,
    *,
    timeout_seconds: float = 30.0,
) -> set[int]:
    """Prove that every selected worker bound has started and imported us."""

    # ProcessPoolExecutor starts processes lazily. Submit a bounded surplus of
    # tiny acknowledgements so a fast first process cannot make a one-ping
    # warmup look like a fully resident pool. Read every result and require the
    # selected number of distinct worker PIDs.
    futures = [
        pool.submit(_worker_ping, _WARMUP_PING_HOLD_SECONDS)
        for _ in range(max(1, workers * 4))
    ]
    deadline = perf_counter() + timeout_seconds
    pids: set[int] = set()
    try:
        for future in futures:
            remaining = deadline - perf_counter()
            if remaining <= 0:
                raise TimeoutError("Time/Capacity worker warmup timed out")
            pids.add(int(future.result(timeout=remaining)))
        if len(pids) < workers:
            raise RuntimeError(
                f"Time/Capacity worker warmup acknowledged {len(pids)} of {workers} workers"
            )
        return pids
    except Exception:
        for future in futures:
            future.cancel()
        raise


def _mark_pool_failed(pool: ProcessPoolExecutor | None = None) -> None:
    global _POOL, _POOL_WORKERS, _POOL_STATE, _POOL_FAILURE_LOGGED
    with _POOL_LOCK:
        current = _POOL
        if pool is not None and current is not pool:
            return
        failed_pool = current if current is not None else pool
        _POOL = None
        _POOL_WORKERS = None
        _POOL_STATE = "failed"
    if failed_pool is not None:
        failed_pool.shutdown(wait=False, cancel_futures=True)
    if not _POOL_FAILURE_LOGGED:
        logger.warning("Time/Capacity worker pool unavailable; using serial fallback", exc_info=True)
        _POOL_FAILURE_LOGGED = True


def _ready_pool(workers: int) -> ProcessPoolExecutor:
    with _POOL_LOCK:
        if _POOL_STATE == "ready" and _POOL is not None and _POOL_WORKERS == workers:
            return _POOL
        reason = (
            "pool_warmup_pending_serial"
            if _POOL_STATE == "warming"
            else "pool_failed_serial"
            if _POOL_STATE == "failed"
            else "pool_not_ready_serial"
        )
    raise PoolNotReadyError(reason)


def start_time_capacity_worker_pool() -> None:
    """Warm the bounded pool asynchronously after backend startup."""

    global _POOL, _POOL_STATE, _POOL_WORKERS, _WARMUP_THREAD
    with _POOL_LOCK:
        if _POOL_STATE in {"warming", "ready", "failed"}:
            return
        _POOL_STATE = "warming"

    def warm() -> None:
        global _POOL, _POOL_STATE, _POOL_WORKERS
        pool: ProcessPoolExecutor | None = None
        try:
            resources = host_resources()
            warmup_decision = choose_execution(6, 120_000, resources=resources)
            if warmup_decision.mode != "process":
                with _POOL_LOCK:
                    if _POOL_STATE == "warming":
                        _POOL_STATE = "stopped"
                return
            workers = warmup_decision.workers
            pool = _new_pool(workers)
            with _POOL_LOCK:
                if _POOL_STATE != "warming":
                    pool.shutdown(wait=False, cancel_futures=True)
                    return
                _POOL = pool
                _POOL_WORKERS = workers
            _warm_pool(pool, workers)
            with _POOL_LOCK:
                if _POOL is pool and _POOL_STATE == "warming":
                    _POOL_STATE = "ready"
                    return
            pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            _mark_pool_failed(pool)
            logger.info("Time/Capacity worker warmup did not complete", exc_info=True)

    with _POOL_LOCK:
        _WARMUP_THREAD = threading.Thread(
            target=warm,
            name="time-capacity-worker-warmup",
            daemon=True,
        )
        _WARMUP_THREAD.start()


def shutdown_time_capacity_worker_pool() -> None:
    global _POOL, _POOL_WORKERS, _POOL_STATE, _WARMUP_THREAD, _POOL_FAILURE_LOGGED
    with _POOL_LOCK:
        pool = _POOL
        warmup_thread = _WARMUP_THREAD
        _POOL = None
        _POOL_WORKERS = None
        _POOL_STATE = "stopped"
        _WARMUP_THREAD = None
        _POOL_FAILURE_LOGGED = False
    if warmup_thread is not None and warmup_thread is not threading.current_thread():
        warmup_thread.join(timeout=35)
    if pool is not None:
        pool.shutdown(wait=True, cancel_futures=True)


def _source_columns(frame: Any, descriptor: ResolvedCellDescriptor) -> dict[str, list[Any]]:
    from pandas import isna

    names = {file_hash: filename for file_hash, filename in descriptor.source_names}
    positions = {
        file_hash: index
        for index, (file_hash, _filename) in enumerate(descriptor.source_names, start=1)
    }
    hashes = frame["source_hash"].tolist() if "source_hash" in frame.columns else [None] * len(frame)
    source_cycles = frame["source_cycle"].tolist() if "source_cycle" in frame.columns else [None] * len(frame)

    def safe_int(value: object) -> int | None:
        if value is None or isna(value):
            return None
        return int(value)

    return {
        "source_cycle": [safe_int(value) for value in source_cycles],
        "source_position": [positions.get(value) for value in hashes],
        "source_filename": [names.get(value) for value in hashes],
        "source_hash": [value if value in names else None for value in hashes],
    }


def _compact_source_columns(frame: Any, descriptor: ResolvedCellDescriptor) -> dict[str, list[Any]]:
    from pandas import isna

    names = {file_hash: filename for file_hash, filename in descriptor.source_names}
    hashes = frame["source_hash"].tolist() if "source_hash" in frame.columns else [None] * len(frame)
    contributing_hashes = {value for value in hashes if value in names}
    sources = [
        {"position": index, "filename": filename, "hash": file_hash}
        for index, (file_hash, filename) in enumerate(descriptor.source_names, start=1)
        if file_hash in contributing_hashes
    ]
    source_indexes = {source["hash"]: index for index, source in enumerate(sources)}
    source_cycles = frame["source_cycle"].tolist() if "source_cycle" in frame.columns else [None] * len(frame)

    def safe_index(value: object) -> int | None:
        if value is None or isna(value):
            return None
        return source_indexes.get(value)

    return {
        "source_cycle": [None if value is None or isna(value) else int(value) for value in source_cycles],
        "sources": sources,
        "source_index": [safe_index(value) for value in hashes],
    }


def _empty_trace(
    descriptor: ResolvedCellDescriptor,
    *,
    compact_ordinary_time: bool = False,
) -> dict[str, Any]:
    trace = {
        "cell_id": descriptor.cell_id,
        "cell_name": descriptor.cell_name,
        "label": descriptor.label,
        "group_id": descriptor.group_id,
        "group_name": descriptor.group_name,
        "excluded": descriptor.excluded,
        "active_mass_mg": descriptor.active_mass_mg,
        "nominal_capacity_mah": descriptor.nominal_capacity_mah,
        "electrode_area_cm2": descriptor.electrode_area_cm2,
        "cycle": [],
        "display_x": [],
        "time_s": [],
        "capacity_mah": [],
        "capacity_mah_g": [],
        "capacity_mah_cm2": [],
        "voltage_v": [],
        "current_ma": [],
        "phase": [],
        "status": [],
        "derivative_x": [],
        "derivative_y": [],
        "segments": list(deepcopy(descriptor.segments)),
        "source_descriptors": list(deepcopy(descriptor.source_descriptors)),
        "source_cycle": [],
        "source_boundary_indices": [],
    }
    if compact_ordinary_time:
        trace.update({"sources": [], "source_index": []})
    else:
        trace.update(
            {
                "source_position": [],
                "source_filename": [],
                "source_hash": [],
            }
        )
    return trace


def _materialize_read(job: ReadJob, submitted_at: float) -> ReadPayload:
    from . import time_capacity_path

    started = perf_counter()
    diagnostics = deepcopy(job.plan_diagnostics)
    raw = time_capacity_path.load_indexed_time_capacity_raw(
        job.plan,
        job.requested_cycles,
        requested_columns=job.requested_columns,
        diagnostics=diagnostics,
        wait_for_layout=True,
    )
    if raw is None:
        raise RuntimeError("indexed Time/Capacity read became unavailable after planning")
    prepared = None
    if job.derived_columns and job.requested_cycles:
        prepared = time_capacity_path.load_indexed_time_capacity_derived(
            job.plan,
            job.requested_cycles,
            job.derived_columns,
            diagnostics=diagnostics,
            wait_for_layout=True,
        )
    return ReadPayload(
        job=job,
        plan=job.plan,
        raw=raw,
        prepared=prepared,
        diagnostics=diagnostics,
        queue_ms=max(0.0, (started - submitted_at) * 1000.0),
        worker_wall_ms=0.0,
    )


def _cell_result(
    job: ReadJob,
    payload: ReadPayload,
    request: ResolvedRequest,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run the shared production per-Cell scientific transform."""

    from . import analysis_engine, stitch, time_capacity_derived, time_capacity_path

    cell_started = perf_counter()
    descriptor = job.descriptor
    diagnostics: dict[str, Any] = {
        "cell_id": descriptor.cell_id,
        "cell_name": descriptor.cell_name,
        **deepcopy(payload.diagnostics),
    }
    raw = payload.raw.copy()
    settings = request.settings
    compact_ordinary_time = (
        request.compact
        and request.precision == "standard"
        and settings["view"] == "voltage_current"
        and settings["x_axis"] == "time"
        and settings["display_mode"] == "consecutive"
    )
    segments = tuple(deepcopy(descriptor.segments))
    diagnostics["raw_rows_loaded_before_filter"] = len(raw)
    if raw.empty or "cycle" not in raw.columns or not stitch.stitch_metadata(raw)["complete"]:
        analysis_engine._finish_time_capacity_cell_profile(diagnostics, cell_started)
        return (
            {
                "trace": _empty_trace(
                    descriptor,
                    compact_ordinary_time=compact_ordinary_time,
                ),
                "badges": [],
                "voltage_facts": list(descriptor.voltage_facts),
                "source_versions": list(descriptor.source_versions),
                "current_parser_versions": list(descriptor.current_parser_versions),
            },
            {"cells": [diagnostics]},
        )

    needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
        settings,
        precision=request.precision,
        compact=request.compact,
    )
    if (
        request.compact
        and request.precision == "standard"
        and settings["x_axis"] == "time"
        and settings["display_mode"] == "consecutive"
    ):
        needs = replace(needs, phase=False)
    with time_capacity_path.timed_stage(diagnostics, "exact_cycle_filter_and_sort"):
        if settings["cycles"]:
            raw = raw[raw["cycle"].isin(settings["cycles"])]
        else:
            if settings["cycle_start"] is not None:
                raw = raw[raw["cycle"] >= int(settings["cycle_start"])]
            if settings["cycle_end"] is not None:
                raw = raw[raw["cycle"] <= int(settings["cycle_end"])]
        raw = raw.sort_values(
            ["cycle", "segment", "record_index"]
            if "record_index" in raw.columns
            else ["cycle", "segment"]
        )
        diagnostics["selected_rows_before_transforms"] = len(raw)

    with time_capacity_path.timed_stage(diagnostics, "continuous_time_phase_capacity"):
        transform_rows = len(raw)
        if needs.continuous_time:
            with time_capacity_path.timed_stage(diagnostics, "transform_continuous_time"):
                raw = analysis_engine._continuous_time(raw)
        # Spec 052.7: the prefix is set only when an origin was resolved, for a
        # refinement or an explicitly requested absolute origin, so the guard
        # is the prefix itself rather than the refinement flag.
        if job.time_origin_prefix_s is not None and "time_s" in raw.columns:
            with time_capacity_path.timed_stage(diagnostics, "transform_refinement_time_origin"):
                raw = raw.assign(
                    time_s=raw["time_s"].to_numpy(dtype="float64")
                    + float(job.time_origin_prefix_s)
                )
        analysis_engine._record_transform_profile(
            diagnostics,
            "continuous_time",
            input_rows=transform_rows,
            output_rows=len(raw) if needs.continuous_time else 0,
            consumed_by=(
                ("time_axis",)
                if settings["view"] == "voltage_current" and settings["x_axis"] == "time"
                else ("full_export",)
                if request.precision == "full" or not request.compact
                else ()
            ),
        )
        source_boundary_indices = (
            np.flatnonzero(raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]) + 1
            if "segment" in raw.columns and len(raw) > 1
            else np.array([], dtype="int64")
        )
        analysis_engine._record_transform_profile(
            diagnostics,
            "source_boundaries",
            input_rows=len(raw),
            output_rows=len(source_boundary_indices),
            consumed_by=("provenance_output", "display_downsampling"),
        )

        if needs.phase:
            aligned = (
                analysis_engine._aligned_prepared_transform_values(
                    raw,
                    payload.prepared,
                    need_capacity=needs.phase_capacity,
                )
                if payload.prepared is not None
                else None
            )
            if aligned is not None:
                phases, prepared_capacity = aligned
                diagnostics["derived_access"] = "prepared"
                phase_source = "prepared"
                capacity_source = "prepared" if needs.phase_capacity else "not_needed"
            else:
                diagnostics["derived_access"] = "fallback" if needs.phase_capacity else "not_needed"
                with time_capacity_path.timed_stage(diagnostics, "transform_phase_classification"):
                    phases = analysis_engine._phase_from_raw(raw)
                prepared_capacity = None
                phase_source = "computed"
                capacity_source = "computed" if needs.phase_capacity else "not_needed"
        else:
            phases = []
            prepared_capacity = None
            diagnostics["derived_access"] = "not_needed"
            phase_source = "not_needed"
            capacity_source = "not_needed"
        analysis_engine._record_transform_profile(
            diagnostics,
            "phase_classification",
            input_rows=len(raw),
            output_rows=len(phases),
            consumed_by=("phase_output", "display_coordinate", "derivative") if needs.phase else (),
        )
        if needs.phase_capacity:
            if prepared_capacity is not None:
                capacity = prepared_capacity
            else:
                with time_capacity_path.timed_stage(diagnostics, "transform_phase_capacity"):
                    capacity = analysis_engine._phase_capacity(raw, phases)
        else:
            capacity = None
        analysis_engine._record_transform_profile(
            diagnostics,
            "phase_capacity",
            input_rows=len(raw),
            output_rows=len(capacity) if capacity is not None else 0,
            consumed_by=(
                ("derivative",)
                if settings["view"] != "voltage_current"
                else ("capacity_axis",)
                if settings["x_axis"] in {"capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}
                else ("full_export",)
                if request.precision == "full" or not request.compact
                else ()
            ),
        )
        diagnostics["phase_source"] = phase_source
        diagnostics["phase_capacity_source"] = capacity_source

        active_mass_mg = descriptor.active_mass_mg
        nominal_capacity_mah = descriptor.nominal_capacity_mah
        electrode_area_cm2 = descriptor.electrode_area_cm2
        active_mass_g = active_mass_mg / 1000.0 if active_mass_mg else None
        if needs.specific_capacity:
            with time_capacity_path.timed_stage(diagnostics, "transform_specific_capacity"):
                capacity_g = (
                    capacity / active_mass_g
                    if capacity is not None and active_mass_g and active_mass_g > 0
                    else np.full(len(raw), np.nan)
                )
        else:
            capacity_g = None
        area_cm2 = settings["electrode_area_cm2"] or electrode_area_cm2
        if needs.areal_capacity:
            with time_capacity_path.timed_stage(diagnostics, "transform_areal_capacity"):
                capacity_area = (
                    capacity / area_cm2
                    if capacity is not None and area_cm2 and area_cm2 > 0
                    else np.full(len(raw), np.nan)
                )
        else:
            capacity_area = None

    with time_capacity_path.timed_stage(diagnostics, "derivative"):
        derivative_x, derivative_y = analysis_engine._derivative_curve(
            raw, phases, capacity, capacity_g, settings, diagnostics
        )
    with time_capacity_path.timed_stage(diagnostics, "protocol_masking"):
        plot_mask = np.zeros(len(raw), dtype=bool)
    materialized_voltage_channels = (
        settings["voltage_channels"]
        if settings["view"] == "voltage_current"
        else [settings["voltage_channel"]]
    )
    voltage_by_channel = {
        quantity: (
            raw[analysis_engine.canonical_cycling.VOLTAGE_QUANTITIES[quantity]]
            .to_numpy(dtype="float64")
            .copy()
            if analysis_engine.canonical_cycling.VOLTAGE_QUANTITIES[quantity] in raw.columns
            else np.full(len(raw), np.nan)
        )
        for quantity in materialized_voltage_channels
    }
    voltage = voltage_by_channel.get(
        settings["voltage_channel"],
        np.full(len(raw), np.nan),
    )
    current = (
        raw["current_ma"].to_numpy(dtype="float64").copy()
        if "current_ma" in raw.columns
        else np.full(len(raw), np.nan)
    )
    with time_capacity_path.timed_stage(diagnostics, "transform_plot_array_materialization"):
        capacity = capacity.copy() if capacity is not None else None
        capacity_g = capacity_g.copy() if capacity_g is not None else None
        capacity_area = capacity_area.copy() if capacity_area is not None else None
        derivative_x = derivative_x.copy()
        derivative_y = derivative_y.copy()
        for values in (
            *voltage_by_channel.values(),
            voltage,
            current,
            capacity,
            capacity_g,
            capacity_area,
            derivative_x,
            derivative_y,
        ):
            if values is not None:
                values[plot_mask] = np.nan
    display_x = analysis_engine._time_capacity_display_x(
        raw,
        phases,
        capacity,
        capacity_g,
        capacity_area,
        settings,
        origin_cycle_start=request.display_origin_cycle_start,
        origin_time_s=job.display_origin_time_s,
        origin_capacity=(request.display_origin_capacity_by_cell or {}).get(job.cell_id),
    )
    display_x_cycle_origins = (
        {
            str(cycle): float(value)
            for cycle, value in analysis_engine._time_capacity_display_cycle_origins(
                raw, display_x
            ).items()
        }
        if (
            settings["view"] == "voltage_current"
            and settings["display_mode"] == "consecutive"
            and settings["x_axis"]
            in {"capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}
        )
        else {}
    )
    if (
        request.refinement
        and request.refinement_viewport_x_min is not None
        and request.refinement_viewport_x_max is not None
    ):
        window = np.isfinite(display_x)
        window &= display_x >= float(request.refinement_viewport_x_min)
        window &= display_x <= float(request.refinement_viewport_x_max)
        take = np.flatnonzero(window)
        raw = raw.iloc[take].reset_index(drop=True)
        display_x = display_x[take]
        phases = np.asarray(phases)[take].tolist() if phases else []
        plot_mask = plot_mask[take]
        voltage_by_channel = {
            quantity: values[take]
            for quantity, values in voltage_by_channel.items()
        }
        voltage = voltage[take]
        current = current[take]
        capacity = capacity[take] if capacity is not None else None
        capacity_g = capacity_g[take] if capacity_g is not None else None
        capacity_area = capacity_area[take] if capacity_area is not None else None
        derivative_x = derivative_x[take]
        derivative_y = derivative_y[take]
        source_boundary_indices = (
            np.flatnonzero(raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]) + 1
            if "segment" in raw.columns and len(raw) > 1
            else np.array([], dtype="int64")
        )
    full_response = request.precision == "full" or not request.compact
    if len(raw) > request.display_max_points_per_cell and not full_response:
        envelope_series = (
            [derivative_x, derivative_y]
            if settings["view"] != "voltage_current"
            else list(voltage_by_channel.values()) or [voltage]
        )
        primary_values = derivative_y if settings["view"] != "voltage_current" else voltage
        if settings["view"] == "voltage_current" and voltage_by_channel:
            visible_voltage_values = np.zeros(len(raw), dtype=bool)
            for values in voltage_by_channel.values():
                visible_voltage_values |= np.isfinite(values)
            visible_values = ~plot_mask & visible_voltage_values
        else:
            visible_values = ~plot_mask & np.isfinite(primary_values)
        with time_capacity_path.timed_stage(diagnostics, "display_downsampling"):
            take = analysis_engine._downsample_indices(
                len(raw), request.display_max_points_per_cell, visible_values, envelope_series
            )
        take = np.unique(np.concatenate((take, source_boundary_indices)))
        raw = raw.iloc[take]
        display_x = display_x[take]
        phases = np.asarray(phases)[take].tolist() if phases else []
        voltage_by_channel = {
            quantity: values[take]
            for quantity, values in voltage_by_channel.items()
        }
        voltage = voltage[take]
        current = current[take]
        capacity = capacity[take] if capacity is not None else None
        capacity_g = capacity_g[take] if capacity_g is not None else None
        capacity_area = capacity_area[take] if capacity_area is not None else None
        derivative_x = derivative_x[take]
        derivative_y = derivative_y[take]
        source_boundary_indices = (
            np.flatnonzero(raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]) + 1
            if "segment" in raw.columns and len(raw) > 1
            else np.array([], dtype="int64")
        )
    else:
        source_boundary_indices = (
            np.flatnonzero(raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]) + 1
            if "segment" in raw.columns and len(raw) > 1
            else np.array([], dtype="int64")
        )
    source_values = (
        _compact_source_columns(raw, descriptor)
        if compact_ordinary_time
        else _source_columns(raw, descriptor)
    )
    is_derivative = settings["view"] != "voltage_current"
    include_time = (
        not request.compact
        or not is_derivative
        and settings["x_axis"] == "time"
        and settings["display_mode"] != "consecutive"
    )
    trace = {
        "cell_id": descriptor.cell_id,
        "cell_name": descriptor.cell_name,
        "label": descriptor.label,
        "group_id": descriptor.group_id,
        "group_name": descriptor.group_name,
        "excluded": descriptor.excluded,
        "active_mass_mg": active_mass_mg,
        "nominal_capacity_mah": nominal_capacity_mah,
        "electrode_area_cm2": electrode_area_cm2,
        "cycle": analysis_engine._jsonsafe_int(raw["cycle"].to_numpy()),
        "display_x": analysis_engine._jsonsafe_plot(display_x, None if full_response else 6),
        **(
            {"display_x_cycle_origins": display_x_cycle_origins}
            if (
                settings["view"] == "voltage_current"
                and settings["display_mode"] == "consecutive"
                and settings["x_axis"]
                in {"capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}
            )
            else {}
        ),
        "time_s": (
            analysis_engine._jsonsafe_plot(raw["time_s"].to_numpy(), None if full_response else 3)
            if include_time and "time_s" in raw.columns
            else []
        ),
        "capacity_mah": (
            analysis_engine._jsonsafe_plot(capacity, None if full_response else 6)
            if not request.compact or (not is_derivative and settings["x_axis"] == "capacity_mah")
            else []
        ),
        "capacity_mah_g": (
            analysis_engine._jsonsafe_plot(capacity_g, None if full_response else 5)
            if not request.compact or (not is_derivative and settings["x_axis"] == "capacity_mah_g")
            else []
        ),
        "capacity_mah_cm2": (
            analysis_engine._jsonsafe_plot(capacity_area, None if full_response else 5)
            if not request.compact or (not is_derivative and settings["x_axis"] == "capacity_mah_cm2")
            else []
        ),
        "voltage_v": analysis_engine._jsonsafe_plot(voltage, None if full_response else 5)
        if not request.compact or not is_derivative
        else [],
        **(
            {
                "voltage_v_by_channel": {
                    quantity: analysis_engine._jsonsafe_plot(
                        values, None if full_response else 5
                    )
                    for quantity, values in voltage_by_channel.items()
                }
            }
            if not is_derivative and len(settings["voltage_channels"]) > 1
            else {}
        ),
        "current_ma": analysis_engine._jsonsafe_plot(current, None if full_response else 5)
        if not request.compact or not is_derivative
        else [],
        "phase": phases,
        "status": analysis_engine._textsafe(raw["status"])
        if not request.compact and "status" in raw.columns
        else [],
        "derivative_x": analysis_engine._jsonsafe_plot(derivative_x, None if full_response else 7)
        if not request.compact or is_derivative
        else [],
        "derivative_y": analysis_engine._jsonsafe_plot(derivative_y, None if full_response else 7)
        if not request.compact or is_derivative
        else [],
        "segments": list(deepcopy(segments)),
        "source_descriptors": list(deepcopy(descriptor.source_descriptors)),
        **source_values,
        "source_boundary_indices": [int(index) for index in source_boundary_indices],
    }
    analysis_engine._finish_time_capacity_cell_profile(diagnostics, cell_started)
    return (
        {
            "trace": trace,
            "badges": [],
            "voltage_facts": list(descriptor.voltage_facts),
            "source_versions": list(descriptor.source_versions),
            "current_parser_versions": list(descriptor.current_parser_versions),
        },
        {"cells": [diagnostics]},
    )


def _run_job(job: ReadJob, request: ResolvedRequest, submitted_at: float | None = None) -> CellResult:
    started = perf_counter()
    submitted = started if submitted_at is None else submitted_at
    rss_before = process_rss_bytes()
    payload = _materialize_read(job, submitted)
    result, diagnostics = _cell_result(job, payload, request)
    payload.worker_wall_ms = (perf_counter() - started) * 1000.0
    rss_after = process_rss_bytes()
    return CellResult(
        index=job.index,
        cell_id=job.cell_id,
        result=result,
        diagnostics=diagnostics,
        queue_ms=payload.queue_ms,
        worker_wall_ms=payload.worker_wall_ms,
        worker_pid=os.getpid(),
        worker_rss_before_bytes=rss_before,
        worker_rss_after_bytes=rss_after,
    )


def _voltage_channels(results: list[CellResult]) -> dict[str, dict[str, Any]]:
    from . import canonical_cycling

    defaults = {
        "voltage": "cell",
        "working_potential": "working_vs_reference",
        "counter_potential": "counter_vs_reference",
    }
    available = {quantity: False for quantity in canonical_cycling.VOLTAGE_QUANTITIES}
    roles = {quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES}
    references = {quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES}
    for item in sorted(results, key=lambda value: value.index):
        for quantity, has_data, role, reference in item.result.get("voltage_facts", []):
            if has_data:
                available[quantity] = True
                roles[quantity].add(role)
                references[quantity].add(reference)
    output: dict[str, dict[str, Any]] = {}
    for quantity in canonical_cycling.VOLTAGE_QUANTITIES:
        candidates = roles[quantity]
        role = defaults[quantity] if not candidates else next(iter(candidates)) if len(candidates) == 1 else canonical_cycling.MIXED_VOLTAGE_ROLE
        refs = references[quantity]
        reference = next(iter(refs)) if len(refs) == 1 and next(iter(refs)) is not None else None
        value = {
            "available": available[quantity],
            "label": canonical_cycling.voltage_quantity_label(quantity, role=role, reference_electrode=reference),
            "role": role,
        }
        if reference is not None and role != canonical_cycling.MIXED_VOLTAGE_ROLE:
            value["reference_electrode"] = reference
        output[quantity] = value
    return output


def _merge_results(
    request: ResolvedRequest,
    results: list[CellResult],
    missing_refs: list[dict[str, Any]],
) -> tuple[dict[str, Any], float]:
    from . import analysis_engine

    started = perf_counter()
    ordered = sorted(results, key=lambda item: item.index)
    traces = [item.result["trace"] for item in ordered]
    badges = list(deepcopy(request.protocol_badges))
    for item in ordered:
        badges.extend(deepcopy(item.result.get("badges") or []))
    for miss in missing_refs:
        badges.append(
            {
                "kind": "missing_reference",
                "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists.",
            }
        )
    pinned = [version for item in ordered for _hash, version in item.result.get("source_versions", [])]
    current = [version for item in ordered for version in item.result.get("current_parser_versions", [])]
    result = {
        "computed_at": analysis_engine.now_iso(),
        "type": request.type,
        "parser_version": analysis_engine.display_parser_version(pinned),
        "calc_version": request.calc_version,
        "current_parser_version": analysis_engine.display_parser_version(current),
        "current_calc_version": request.current_calc_version,
        "settings": deepcopy(request.settings),
        "cell_traces": traces,
        "badges": badges,
        "voltage_channels": _voltage_channels(ordered),
        "rendering": {
            "viewport_width": request.viewport_width,
            "configured_max_points_per_cell": max(100, request.settings["max_points_per_cell"]),
            "max_points_per_cell": request.display_max_points_per_cell,
            "total_points": sum(len(trace.get("cycle") or []) for trace in traces),
            "precision": request.precision,
            "compact": request.compact,
        },
    }
    return result, (perf_counter() - started) * 1000.0


def _estimated_rows(plan: Any, requested_cycles: tuple[int, ...]) -> int:
    requested = set(requested_cycles)
    total = 0
    for source in plan.sources:
        known = len(source.observed_source_cycles)
        selected = sum(1 for value in source.cycle_map.values() if value in requested)
        raw_rows = int(source.index.get("raw_row_count", 0))
        if selected and known:
            total += max(1, math.ceil(raw_rows * selected / known))
    return total


def _build_jobs(
    db: Any,
    spec: dict,
    provenance: dict | None,
    *,
    use_current_versions: bool,
    viewport_width: int | None,
    precision: str,
    compact: bool,
    display_origin_cycle_start: int | None = None,
    display_origin_capacity_by_cell: dict[int, float] | None = None,
    refinement: bool = False,
    refinement_viewport_x_min: float | None = None,
    refinement_viewport_x_max: float | None = None,
    request_context: Any | None = None,
) -> tuple[list[ReadJob], ResolvedRequest, list[dict[str, Any]]] | None:
    from . import analysis_engine, canonical_cycling, time_capacity_derived, time_capacity_path
    from .stitch import CachedSourceRef

    settings = analysis_engine.time_capacity_settings(spec.get("computation", {}))
    protocol_context, protocol_badges = analysis_engine._protocol_filter_context(spec)
    if protocol_context["active"]:
        return None
    if refinement and settings["cycles"]:
        return None
    # Spec 052.5: reuse the owner-side resolution the route already performed
    # for the cache key rather than repeating the selection walk, the source
    # preload and the metadata load. The context is request-local and is never
    # passed to a worker -- only the immutable descriptors built below are.
    if request_context is not None:
        units = list(request_context.units)
        missing_refs = list(request_context.missing_refs)
        scalar_metadata = request_context.scalar_metadata
    else:
        units, missing_refs = analysis_engine.resolve_selection(db, spec)
        cells = [unit["cell"] for unit in units]
        analysis_engine.preload_cell_sources(db, cells)
        scalar_metadata = analysis_engine.load_scalar_metadata(db, cells)
    exclusions = spec.get("selection", {}).get("exclusions", [])
    hidden_group_ids = set(spec.get("selection", {}).get("hidden_replicate_group_ids", []))
    needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
        settings,
        precision=precision,
        compact=compact,
    )
    jobs: list[ReadJob] = []
    for index, unit in enumerate(units):
        cell = unit["cell"]
        if request_context is not None and cell.id in request_context.files_by_cell:
            files = list(request_context.files_by_cell[cell.id])
            hashes = list(request_context.hashes_by_cell[cell.id])
            versions = request_context.parser_versions_by_cell[cell.id]
        else:
            hashes, files = analysis_engine.cell_ordered_hashes(db, cell)
            versions = analysis_engine.resolve_source_parser_versions(
                files, provenance, cell.id, use_current_versions
            )
        refs = tuple(CachedSourceRef(file.hash, versions[file.hash]) for file in files)
        plan_diagnostics: dict[str, Any] = {}
        plan = time_capacity_path.build_time_capacity_stitch_plan(refs, diagnostics=plan_diagnostics)
        if plan.path != "indexed" or not plan.complete:
            return None
        requested_cycles = time_capacity_path.requested_global_cycles(
            plan,
            explicit_cycles=settings["cycles"],
            cycle_start=settings["cycle_start"],
            cycle_end=settings["cycle_end"],
        )
        time_origin_prefix_s: float | None = None
        display_origin_time_s: float | None = None
        # Spec 052.7: ordinary requests may also ask for absolute positioning.
        # Without an origin, `_time_capacity_display_x` zeroes each response at
        # its own first finite point, so every cycle window comes back starting
        # at x=0 and cannot be panned through -- consecutive windows are
        # separate coordinate systems rather than views onto one timeline.
        # Supplying `display_origin_cycle_start` reuses the refinement origin
        # machinery to place the window at its true coordinate. Opt-in: when no
        # origin is requested this is unreachable and the per-window behaviour
        # is byte-identical.
        wants_absolute_origin = (
            refinement or display_origin_cycle_start is not None
        )
        if wants_absolute_origin and requested_cycles and settings["x_axis"] == "time":
            time_facts = time_capacity_path.consecutive_time_request_facts(
                plan,
                requested_cycles,
                display_origin_cycle_start,
            )
            if time_facts is None:
                return None
            time_origin_prefix_s, display_origin_time_s = time_facts
        available = {
            column
            for source in plan.sources
            for column in source.index.get("raw_column_names", ())
        }
        requested_columns = time_capacity_path.time_capacity_request_columns(
            available,
            settings,
            precision=precision,
            compact=compact,
            protocol_active=False,
        )
        matched = {quantity: [] for quantity in canonical_cycling.VOLTAGE_QUANTITIES}
        source_by_hash = {source.hash: source for source in files}
        for source in plan.sources:
            for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
                if source.voltage_data_availability.get(column) is True:
                    source_file = source_by_hash.get(source.ref.file_hash)
                    if source_file is not None:
                        matched[quantity].append(source_file)
        roles, references = analysis_engine._resolve_time_capacity_voltage_context(files, matched)
        voltage_facts = tuple(
            (
                quantity,
                bool(matched[quantity]),
                roles[quantity],
                references[quantity],
            )
            for quantity in canonical_cycling.VOLTAGE_QUANTITIES
        )
        excluded = (
            analysis_engine.exclusion_for_unit(exclusions, unit) is not None
            or unit["group_id"] in hidden_group_ids
        )
        descriptor = ResolvedCellDescriptor(
            cell_id=int(cell.id),
            cell_name=str(cell.name),
            label=str(unit["label"]),
            group_id=unit["group_id"],
            group_name=unit["group_name"],
            active_mass_mg=analysis_engine.cell_active_mass_mg(cell, scalar_metadata.get(cell.id)),
            nominal_capacity_mah=analysis_engine.cell_nominal_capacity_mah(cell, scalar_metadata.get(cell.id)),
            electrode_area_cm2=analysis_engine.cell_electrode_area_cm2(cell, scalar_metadata.get(cell.id)),
            source_names=tuple((str(file.hash), str(file.filename)) for file in files),
            source_descriptors=tuple(
                deepcopy(
                    analysis_engine.source_descriptors(
                        files,
                        list(plan.segments),
                        list(plan.missing),
                        None,
                        parser_versions=versions,
                        source_facts=plan.source_facts,
                    )
                )
            ),
            segments=tuple(deepcopy(plan.segments)),
            missing=tuple(str(value) for value in plan.missing),
            missing_positions=tuple(int(value) for value in plan.missing_positions),
            source_versions=tuple((str(file.hash), str(versions[file.hash])) for file in files),
            current_parser_versions=tuple(
                str(analysis_engine.current_parser_identity(file)) for file in files
            ),
            voltage_facts=voltage_facts,
            excluded=excluded,
        )
        jobs.append(
            ReadJob(
                index=index,
                cell_id=int(cell.id),
                refs=refs,
                explicit_cycles=tuple(settings["cycles"]),
                cycle_start=settings["cycle_start"],
                cycle_end=settings["cycle_end"],
                requested_columns=tuple(requested_columns),
                derived_columns=("phase_code", "phase_capacity_mah") if needs.phase_capacity else (),
                # Spec 052.3 Stage 2: no defensive copy here. The read path
                # treats `plan` as read-only, and `_materialize_read` already
                # deep-copies `plan_diagnostics` before handing it to the
                # readers that mutate it, so copying per Cell at planning time
                # was pure overhead in both execution modes -- the process path
                # is isolated by pickle, and the serial path never writes.
                # `test_owner_job_state_is_not_mutated_by_a_serial_run` pins
                # that invariant; reintroduce a copy here if it ever breaks.
                plan=plan,
                requested_cycles=tuple(requested_cycles),
                plan_diagnostics=plan_diagnostics,
                descriptor=descriptor,
                estimated_rows=_estimated_rows(plan, tuple(requested_cycles)),
                time_origin_prefix_s=time_origin_prefix_s,
                display_origin_time_s=display_origin_time_s,
            )
        )
    visible_count = sum(1 for job in jobs if not job.descriptor.excluded)
    width = max(320, min(10000, int(viewport_width or 1200)))
    configured = max(100, settings["max_points_per_cell"])
    display_max = (
        configured
        if refinement
        else analysis_engine.time_capacity_display_budget(configured, width, visible_count)
    )
    calc_version = analysis_engine.CALC_VERSION
    if provenance and not use_current_versions:
        calc_version = provenance.get("calc_version") or calc_version
    request = ResolvedRequest(
        type=spec.get("type", "cycling"),
        settings=deepcopy(settings),
        calc_version=calc_version,
        current_calc_version=analysis_engine.CALC_VERSION,
        protocol_badges=tuple(deepcopy(protocol_badges)),
        viewport_width=width,
        precision=precision,
        compact=compact,
        display_max_points_per_cell=display_max,
        display_origin_cycle_start=display_origin_cycle_start,
        display_origin_capacity_by_cell=(
            dict(display_origin_capacity_by_cell)
            if display_origin_capacity_by_cell is not None
            else None
        ),
        refinement=refinement,
        refinement_viewport_x_min=refinement_viewport_x_min,
        refinement_viewport_x_max=refinement_viewport_x_max,
    )
    return jobs, request, missing_refs


def _run_serial(jobs: list[ReadJob], request: ResolvedRequest) -> list[CellResult]:
    return [_run_job(job, request) for job in jobs]


def _run_process(
    jobs: list[ReadJob],
    request: ResolvedRequest,
    workers: int,
    *,
    measure_ipc: bool = False,
) -> tuple[list[CellResult], int | None, int | None]:
    # Spec 052.3 Stage 4: `ipc_input_bytes`/`ipc_output_bytes` are diagnostic
    # facts only. Measuring them costs a second full pickle of every job and
    # every result on top of the one the pool already performs, so it is done
    # only when a profiled request actually asked for diagnostics.
    pool = _ready_pool(workers)
    futures = []
    input_bytes: int | None = None
    if measure_ipc:
        input_bytes = sum(
            len(pickle.dumps((job, request), protocol=pickle.HIGHEST_PROTOCOL))
            for job in jobs
        )
    for job in jobs:
        futures.append(pool.submit(_run_job, job, request, perf_counter()))
    try:
        results = [future.result() for future in futures]
    except Exception:
        for future in futures:
            future.cancel()
        _mark_pool_failed()
        raise
    output_bytes: int | None = None
    if measure_ipc:
        output_bytes = sum(
            len(pickle.dumps(result, protocol=pickle.HIGHEST_PROTOCOL))
            for result in results
        )
    return results, input_bytes, output_bytes


def try_compute_time_capacity(
    db: Any,
    spec: dict,
    provenance: dict | None,
    *,
    use_current_versions: bool = False,
    viewport_width: int | None = None,
    precision: str = "standard",
    compact: bool = False,
    progress: Any = None,
    access_diagnostics: dict[str, Any] | None = None,
    force_serial: bool = False,
    display_origin_cycle_start: int | None = None,
    display_origin_capacity_by_cell: dict[int, float] | None = None,
    refinement: bool = False,
    refinement_viewport_x_min: float | None = None,
    refinement_viewport_x_max: float | None = None,
    request_context: Any | None = None,
) -> dict[str, Any] | None:
    """Compute an eligible ordinary request or return ``None`` for fallback."""

    from . import analysis_engine

    settings = analysis_engine.time_capacity_settings(spec.get("computation", {}))
    if precision != "standard" or not compact or settings.get("view") != "voltage_current":
        return None
    if refinement and (
        settings.get("x_axis")
        not in {"time", "capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}
        or settings.get("display_mode") != "consecutive"
    ):
        raise RefinementUnavailable("refinement requires ordinary consecutive Time/Capacity")
    if refinement and settings.get("cycles"):
        raise RefinementUnavailable("refinement does not broaden explicit sparse cycles")
    started = perf_counter()
    try:
        analysis_engine.ensure_canonical_cycling_available(
            db, spec, request_context=request_context
        )
        built = _build_jobs(
            db,
            spec,
            provenance,
            use_current_versions=use_current_versions,
            viewport_width=viewport_width,
            precision=precision,
            compact=compact,
            display_origin_cycle_start=display_origin_cycle_start,
            display_origin_capacity_by_cell=display_origin_capacity_by_cell,
            refinement=refinement,
            refinement_viewport_x_min=refinement_viewport_x_min,
            refinement_viewport_x_max=refinement_viewport_x_max,
            request_context=request_context,
        )
        if built is None:
            if refinement:
                raise RefinementUnavailable("indexed consecutive display facts are unavailable")
            return None
        jobs, request, missing_refs = built
        selected_rows = sum(job.estimated_rows for job in jobs)
        decision = choose_execution(
            len(jobs),
            selected_rows,
            force_serial=force_serial,
        )
        if progress:
            progress(0, len(jobs), "", "Reading indexed cache")
        ipc_input: int | None = None
        ipc_output: int | None = None
        parent_rss_before = process_rss_bytes()
        if decision.mode == "process":
            try:
                results, ipc_input, ipc_output = _run_process(
                    jobs,
                    request,
                    decision.workers,
                    measure_ipc=access_diagnostics is not None,
                )
            except PoolNotReadyError as exc:
                decision = ExecutionDecision(
                    "serial",
                    1,
                    exc.reason,
                    decision.logical_cpus,
                    decision.total_memory_bytes,
                    decision.available_memory_bytes,
                )
                results = _run_serial(jobs, request)
            except Exception:
                decision = ExecutionDecision(
                    "serial",
                    1,
                    "process_failure_serial_fallback",
                    decision.logical_cpus,
                    decision.total_memory_bytes,
                    decision.available_memory_bytes,
                )
                results = _run_serial(jobs, request)
        else:
            results = _run_serial(jobs, request)
        parent_rss_after = process_rss_bytes()
        if progress:
            progress(len(jobs), len(jobs), "", "Read indexed cache")
        result, merge_ms = _merge_results(request, results, missing_refs)
        elapsed_ms = (perf_counter() - started) * 1000.0
        cells = [cell for item in results for cell in item.diagnostics.get("cells", [])]
        if access_diagnostics is not None:
            access_diagnostics["cells"] = cells
            worker_rss_samples: list[dict[str, int | None]] = []
            seen_worker_pids: set[int] = set()
            for item in results:
                if item.worker_pid is None or item.worker_pid in seen_worker_pids:
                    continue
                seen_worker_pids.add(item.worker_pid)
                worker_rss_samples.append(
                    {
                        "pid": item.worker_pid,
                        "rss_before_bytes": item.worker_rss_before_bytes,
                        "rss_after_bytes": item.worker_rss_after_bytes,
                    }
                )
            total_backend_rss_after = parent_rss_after
            if total_backend_rss_after is not None:
                child_rss = sum(
                    int(sample["rss_after_bytes"])
                    for sample in worker_rss_samples
                    if sample["pid"] != os.getpid()
                    and isinstance(sample["rss_after_bytes"], int)
                )
                total_backend_rss_after += child_rss
            access_diagnostics["execution"] = {
                "mode": decision.mode,
                "workers": decision.workers,
                "reason": decision.reason,
                "logical_cpus": decision.logical_cpus,
                "total_memory_bytes": decision.total_memory_bytes,
                "available_memory_bytes": decision.available_memory_bytes,
                "selected_rows": selected_rows,
                # Serial execution performs no IPC, so it keeps reporting 0 as
                # it always has; the process path reports its measured bytes
                # (always measured here, since diagnostics are on).
                "ipc_input_bytes": ipc_input if decision.mode == "process" else 0,
                "ipc_output_bytes": ipc_output if decision.mode == "process" else 0,
                "effective_cores": decision.workers if decision.mode == "process" else 1,
                "merge_ms": merge_ms,
                "parent_rss_before_bytes": parent_rss_before,
                "parent_rss_after_bytes": parent_rss_after,
                "worker_rss_before_bytes": [
                    item.worker_rss_before_bytes
                    for item in results
                    if item.worker_rss_before_bytes is not None
                ],
                "worker_rss_after_bytes": [
                    item.worker_rss_after_bytes
                    for item in results
                    if item.worker_rss_after_bytes is not None
                ],
                "worker_rss_samples": worker_rss_samples,
                "total_backend_rss_after_bytes": total_backend_rss_after,
            }
            cell_jobs_ms = sum(
                float(cell.get("cell_job_wall_ms", 0.0))
                for cell in cells
                if isinstance(cell.get("cell_job_wall_ms"), (int, float))
            )
            access_diagnostics["engine"] = {
                "total_ms": elapsed_ms,
                "owner_setup_ms": max(0.0, elapsed_ms - cell_jobs_ms - merge_ms),
                "cell_jobs_ms": cell_jobs_ms,
                "global_finalization_ms": merge_ms,
                "residual_ms": 0.0,
            }
        return result
    except Exception:
        if refinement:
            raise
        logger.exception("Optimized Time/Capacity path failed; using serial engine fallback")
        return None
