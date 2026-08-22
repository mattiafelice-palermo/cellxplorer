"""Benchmark-only cross-Cell concurrency ablation for Spec 050.9.

This script deliberately keeps concurrency out of the production request path.
It runs the current engine against a disposable golden-fixture database and
compares two isolated boundaries:

* B1/B2 prefetch indexed Parquet in 2/4 threads, then run the current engine
  sequentially with those prefetched frames;
* B3/B4 run the current one-Cell engine call in 2/4 threads, with one private
  SQLite session per worker, then merge results in selection order.

The JSON output is disposable evidence.  It contains no source paths, hashes,
raw rows, or user data and never touches the user's application data root.
"""
from __future__ import annotations

import argparse
import ctypes
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import platform
import sqlite3
import statistics
import sys
import tempfile
import time
from typing import Any, Callable, Iterable
from unittest.mock import patch

try:
    import resource
except ImportError:  # pragma: no cover - Windows has no resource module
    resource = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


REPETITIONS = 5
GOLDEN_CELL_ID = 101
IMPROVEMENT_THRESHOLD = 0.05


@dataclass(frozen=True)
class ReadJob:
    """Immutable worker input resolved by the owning relational context."""

    index: int
    cell_id: int
    refs: tuple[Any, ...]
    explicit_cycles: tuple[int, ...]
    cycle_start: int | None
    cycle_end: int | None
    derived_columns: tuple[str, ...]
    plan: Any
    requested_cycles: tuple[int, ...]
    plan_diagnostics: dict[str, Any]


@dataclass
class ReadPayload:
    job: ReadJob
    plan: Any
    requested_cycles: tuple[int, ...]
    raw: Any
    prepared: Any
    diagnostics: dict[str, Any]
    queue_ms: float
    worker_wall_ms: float


@dataclass
class WholeCellPayload:
    index: int
    cell_id: int
    result: dict
    diagnostics: dict[str, Any]
    queue_ms: float
    worker_wall_ms: float


class FileBackedFixtureDatabase:
    """Provide independent SQLAlchemy sessions over a disposable SQLite copy."""

    def __init__(self, source_db: Any):
        self.source_db = source_db
        self.temp_dir: tempfile.TemporaryDirectory[str] | None = None
        self.engine: Any = None
        self.session_factory: Any = None
        self.path: Path | None = None

    def __enter__(self) -> "FileBackedFixtureDatabase":
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        self.temp_dir = tempfile.TemporaryDirectory(prefix="cellxplorer-0509-db-")
        self.path = Path(self.temp_dir.name) / "fixture.sqlite"
        target = sqlite3.connect(self.path)
        try:
            source_connection = self.source_db.get_bind().raw_connection()
            try:
                source_driver = getattr(source_connection, "driver_connection", source_connection)
                source_driver.backup(target)
            finally:
                source_connection.close()
        finally:
            target.close()
        self.engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False},
            pool_size=8,
            max_overflow=0,
        )
        self.session_factory = sessionmaker(
            bind=self.engine,
            autoflush=False,
            expire_on_commit=False,
        )
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.engine is not None:
            self.engine.dispose()
            self.engine = None
        if self.temp_dir is not None:
            self.temp_dir.cleanup()
            self.temp_dir = None


@dataclass
class ApplicationEnvironment:
    """A writable disposable DB copy backed by the application's real caches."""

    db: Any
    data_root: Path
    database_copy: FileBackedFixtureDatabase

    def close(self) -> None:
        self.db.close()
        self.database_copy.__exit__(None, None, None)

    def __enter__(self) -> "ApplicationEnvironment":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def create_application_environment(data_root: Path) -> ApplicationEnvironment:
    """Copy the app DB for safe writes while reading its cache files in place."""

    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool
    from sqlalchemy.orm import sessionmaker
    from golden_analysis_support import bind_isolated_data_root

    data_root = data_root.resolve()
    database_path = data_root / "cellxplorer.db"
    if not database_path.is_file():
        raise FileNotFoundError(database_path)
    bind_isolated_data_root(data_root)
    sqlite_uri = f"file:{database_path.as_posix()}?mode=ro"
    source_engine = create_engine(
        "sqlite://",
        creator=lambda: sqlite3.connect(
            sqlite_uri,
            uri=True,
            check_same_thread=False,
        ),
        poolclass=NullPool,
    )
    source_factory = sessionmaker(
        bind=source_engine,
        autoflush=False,
        expire_on_commit=False,
    )
    source_db = source_factory()
    try:
        database_copy = FileBackedFixtureDatabase(source_db)
        database_copy.__enter__()
    finally:
        source_db.close()
        source_engine.dispose()
    return ApplicationEnvironment(
        db=database_copy.session_factory(),
        data_root=data_root,
        database_copy=database_copy,
    )


def discover_application_dataset(env: ApplicationEnvironment) -> tuple[dict, list[int], dict[str, Any]]:
    """Use the saved performance analysis and its contiguous real BQV batch."""

    from app.models import Analysis, Cell

    analysis = (
        env.db.query(Analysis)
        .filter(Analysis.title == "Performance analysis")
        .order_by(Analysis.id.desc())
        .first()
    )
    if analysis is None:
        raise RuntimeError("saved analysis 'Performance analysis' was not found")
    selected = [
        int(entry["ref_id"])
        for entry in (analysis.spec.get("selection", {}).get("entries", []))
        if entry.get("kind") == "cell" and isinstance(entry.get("ref_id"), int)
    ]
    if not selected:
        raise RuntimeError("saved performance analysis has no Cell entries")
    first = env.db.get(Cell, min(selected))
    if first is None:
        raise RuntimeError("saved performance analysis refers to a missing Cell")
    prefix = first.name.split("_", 1)[0] + "_"
    batch: list[int] = []
    for cell in env.db.query(Cell).filter(Cell.id >= first.id).order_by(Cell.id).all():
        if not cell.name.startswith(prefix):
            if batch:
                break
            continue
        batch.append(int(cell.id))
    if not set(selected).issubset(batch):
        batch = selected
    return (
        deepcopy(analysis.spec),
        batch,
        {
            "analysis_id": analysis.id,
            "analysis_title": analysis.title,
            "saved_selection_cell_count": len(selected),
            "benchmark_cell_count": len(batch),
        },
    )


def _finite(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _median(values: Iterable[object]) -> float | None:
    finite = [float(value) for value in values if _finite(value)]
    return statistics.median(finite) if finite else None


def _min_max(values: Iterable[object]) -> dict[str, float | None]:
    finite = [float(value) for value in values if _finite(value)]
    return {
        "min": min(finite) if finite else None,
        "max": max(finite) if finite else None,
    }


def _sum_stage(stages: dict[str, Any], names: Iterable[str]) -> float:
    return sum(float(stages.get(name) or 0.0) for name in names)


def _json_projection(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _json_projection(item)
            for key, item in value.items()
            if key not in {"computed_at", "cache_status", "data_signature", "source_data_signature"}
        }
    if isinstance(value, list):
        return [_json_projection(item) for item in value]
    return value


def scientific_digest(result: dict) -> str:
    payload = json.dumps(
        _json_projection(result),
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return sha256(payload).hexdigest()


def result_order(result: dict) -> list[int]:
    return [
        int(trace["cell_id"])
        for trace in result.get("cell_traces", [])
        if isinstance(trace, dict) and isinstance(trace.get("cell_id"), int)
    ]


def parity(reference: dict, candidate: dict) -> dict[str, Any]:
    reference_digest = scientific_digest(reference)
    candidate_digest = scientific_digest(candidate)
    reference_order = result_order(reference)
    candidate_order = result_order(candidate)
    return {
        "equal": reference_digest == candidate_digest,
        "reference_digest": reference_digest,
        "candidate_digest": candidate_digest,
        "ordering_equal": reference_order == candidate_order,
        "reference_trace_count": len(reference_order),
        "candidate_trace_count": len(candidate_order),
    }


def current_rss() -> dict[str, int | None]:
    """Return truthful process RSS facts without adding a dependency."""

    if os.name == "nt":
        class MemoryCounters(ctypes.Structure):
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
            counters = MemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            process = ctypes.windll.kernel32.GetCurrentProcess()
            ok = ctypes.windll.psapi.GetProcessMemoryInfo(
                process,
                ctypes.byref(counters),
                ctypes.sizeof(counters),
            )
            if ok:
                return {
                    "working_set_bytes": int(counters.WorkingSetSize),
                    "peak_working_set_bytes": int(counters.PeakWorkingSetSize),
                }
        except (AttributeError, OSError):
            pass
        return {"working_set_bytes": None, "peak_working_set_bytes": None}

    try:
        if resource is None:
            raise OSError("resource module unavailable")
        usage = resource.getrusage(resource.RUSAGE_SELF)
        # Linux reports KiB while macOS reports bytes.
        value = int(usage.ru_maxrss)
        if platform.system() != "Darwin":
            value *= 1024
        return {"working_set_bytes": value, "peak_working_set_bytes": value}
    except (AttributeError, OSError):
        return {"working_set_bytes": None, "peak_working_set_bytes": None}


def native_thread_settings() -> dict[str, Any]:
    names = (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "ARROW_NUM_THREADS",
        "POLARS_MAX_THREADS",
    )
    settings: dict[str, Any] = {
        "python_cpu_count": os.cpu_count(),
        "environment": {name: os.environ.get(name) for name in names},
    }
    try:
        import numpy as np

        settings["numpy_version"] = np.__version__
    except Exception as exc:  # pragma: no cover - diagnostic fallback only
        settings["numpy_error"] = type(exc).__name__
    try:
        import pyarrow as pa

        settings["pyarrow_version"] = pa.__version__
        settings["pyarrow_cpu_count"] = pa.cpu_count()
        settings["pyarrow_io_thread_count"] = pa.io_thread_count()
    except Exception as exc:  # pragma: no cover - diagnostic fallback only
        settings["pyarrow_error"] = type(exc).__name__
    try:
        from threadpoolctl import threadpool_info

        settings["threadpoolctl"] = [
            {
                key: item.get(key)
                for key in ("user_api", "internal_api", "num_threads", "prefix")
                if key in item
            }
            for item in threadpool_info()
        ]
    except Exception as exc:  # pragma: no cover - optional dependency
        settings["threadpoolctl"] = {"status": "unavailable", "reason": type(exc).__name__}
    return settings


def make_spec(
    base: dict,
    cell_ids: list[int],
    cycles: list[int],
    cycle_end: int | None,
    *,
    x_axis: str,
    view: str,
    derivative_specific: bool = False,
) -> dict:
    spec = deepcopy(base)
    spec["selection"]["entries"] = [
        {"kind": "cell", "ref_id": cell_id}
        for cell_id in cell_ids
    ]
    settings = spec["computation"]["time_capacity"]
    settings["cycles"] = cycles
    settings["cycle_start"] = 1
    settings["cycle_end"] = cycle_end
    settings["max_points_per_cell"] = 4000
    settings["x_axis"] = x_axis
    settings["view"] = view
    if view != "voltage_current":
        settings["derivative_phase"] = "both"
        settings["derivative_specific"] = derivative_specific
        settings["smoothing_window"] = 7
    return spec


def _stage_summary(profile: dict[str, Any], diagnostics: dict[str, Any]) -> dict[str, Any]:
    stages = profile.get("backend_stages_ms") or {}
    derivative_profile = profile.get("derivative_profile") or {}
    return {
        "relational_setup_ms": stages.get("relational_selection_source_resolution"),
        "raw_read_decode_ms": _sum_stage(
            stages,
            (
                "index_stitch_plan",
                "indexed_raw_access",
                "legacy_full_raw_read",
                "prepared_derived_read",
            ),
        ),
        "transform_ms": stages.get("continuous_time_phase_capacity"),
        "derivative_ms": stages.get("derivative"),
        "derivative_substages_ms": derivative_profile.get("stages_ms"),
        "downsampling_ms": stages.get("display_downsampling"),
        "cell_job_wall_ms": profile.get("cell_job_wall_ms"),
        "row_groups_read": profile.get("row_groups_read"),
        "row_groups_total": profile.get("row_groups_total"),
        "rows_materialized": profile.get("raw_rows_materialized"),
        "selected_rows": profile.get("selected_rows_before_transforms"),
        "prepared_rows_materialized": profile.get("prepared_rows_materialized"),
        "columns_read": _column_count(diagnostics),
    }


def _column_count(diagnostics: dict[str, Any]) -> int | None:
    columns: set[str] = set()
    for cell in diagnostics.get("cells", []):
        for source_read in cell.get("source_reads", []) if isinstance(cell, dict) else []:
            values = source_read.get("columns_read")
            if isinstance(values, list):
                columns.update(str(value) for value in values)
    return len(columns) if columns else None


def build_profile(result: dict, diagnostics: dict[str, Any], request_id: str) -> dict:
    from app.services.time_capacity_profiling import build_time_capacity_profile

    return build_time_capacity_profile(
        request_id=request_id,
        result_cache="miss",
        diagnostics=diagnostics,
        result=result,
    )


def _measurement_row(
    *,
    candidate: str,
    workers: int,
    scenario: str,
    cells: list[int],
    result: dict,
    diagnostics: dict[str, Any],
    reference: dict,
    backend_wall_ms: float,
    cpu_seconds: float,
    serialization_ms: float,
    queue_ms: float,
    dispatch_ms: float,
    rss_before: dict[str, Any],
    rss_after: dict[str, Any],
    native_settings: dict[str, Any],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    profile = build_profile(result, diagnostics, f"050.9-{candidate}-{scenario}")
    stage = _stage_summary(profile, diagnostics)
    parity_result = parity(reference, result)
    wall_seconds = backend_wall_ms / 1000.0
    row: dict[str, Any] = {
        "candidate": candidate,
        "workers": workers,
        "scenario": scenario,
        "cell_count": len(cells),
        "selection_count": len(cells),
        "backend_wall_ms": backend_wall_ms,
        "cpu_seconds": cpu_seconds,
        "effective_cores": cpu_seconds / wall_seconds if wall_seconds > 0 else None,
        "dispatch_ms": dispatch_ms,
        "queue_ms": queue_ms,
        "serialization_ms": serialization_ms,
        "rss_before": rss_before,
        "rss_after": rss_after,
        "peak_rss_bytes": rss_after.get("peak_working_set_bytes"),
        "peak_rss_scope": "process lifetime (Windows PeakWorkingSetSize)",
        "native_thread_settings": native_settings,
        "stages": stage,
        "scientific_parity": parity_result,
        "status": "PASS" if parity_result["equal"] and parity_result["ordering_equal"] else "REJECTED",
    }
    if extra:
        row.update(extra)
    return row


def _serialize_result(result: dict) -> float:
    started = time.perf_counter()
    json.dumps(result, separators=(",", ":"), allow_nan=False)
    return (time.perf_counter() - started) * 1000.0


def run_production_sample(
    env: GoldenFixtureEnvironment,
    spec: dict,
    reference: dict | None,
    *,
    scenario: str,
    candidate: str = "A0",
) -> tuple[dict[str, Any], dict]:
    from app.services import analysis_engine

    diagnostics: dict[str, Any] = {}
    rss_before = current_rss()
    started_cpu = time.process_time()
    started = time.perf_counter()
    result = analysis_engine.compute_time_capacity(
        env.db,
        spec,
        None,
        viewport_width=1200,
        precision="standard",
        compact=True,
        access_diagnostics=diagnostics,
    )
    backend_wall_ms = (time.perf_counter() - started) * 1000.0
    cpu_seconds = time.process_time() - started_cpu
    serialization_ms = _serialize_result(result)
    rss_after = current_rss()
    if reference is None:
        reference = result
    row = _measurement_row(
        candidate=candidate,
        workers=1,
        scenario=scenario,
        cells=result_order(result),
        result=result,
        diagnostics=diagnostics,
        reference=reference,
        backend_wall_ms=backend_wall_ms,
        cpu_seconds=cpu_seconds,
        serialization_ms=serialization_ms,
        queue_ms=0.0,
        dispatch_ms=0.0,
        rss_before=rss_before,
        rss_after=rss_after,
        native_settings=native_thread_settings(),
    )
    return row, result


def build_read_jobs(
    env: GoldenFixtureEnvironment,
    spec: dict,
    cell_ids: list[int],
) -> list[ReadJob]:
    from app.services import analysis_engine, time_capacity_derived, time_capacity_path
    from app.services.stitch import CachedSourceRef

    settings = analysis_engine.time_capacity_settings(spec.get("computation", {}))
    needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
        settings,
        precision="standard",
        compact=True,
    )
    derived_columns = ("phase_code", "phase_capacity_mah") if needs.phase_capacity else ()
    jobs: list[ReadJob] = []
    for index, cell_id in enumerate(cell_ids):
        cell = env.db.get(analysis_engine.Cell, cell_id)
        if cell is None:
            raise RuntimeError(f"Fixture cell {cell_id} was not found")
        _hashes, files = analysis_engine.cell_ordered_hashes(env.db, cell)
        versions = analysis_engine.resolve_source_parser_versions(
            files,
            None,
            cell.id,
            False,
        )
        refs = tuple(CachedSourceRef(file.hash, versions[file.hash]) for file in files)
        plan_diagnostics: dict[str, Any] = {}
        plan = time_capacity_path.build_time_capacity_stitch_plan(
            refs,
            diagnostics=plan_diagnostics,
        )
        requested_cycles = time_capacity_path.requested_global_cycles(
            plan,
            explicit_cycles=settings["cycles"],
            cycle_start=settings["cycle_start"],
            cycle_end=settings["cycle_end"],
        )
        jobs.append(
            ReadJob(
                index=index,
                cell_id=cell_id,
                refs=refs,
                explicit_cycles=tuple(settings["cycles"]),
                cycle_start=settings["cycle_start"],
                cycle_end=settings["cycle_end"],
                derived_columns=derived_columns,
                plan=plan,
                requested_cycles=tuple(requested_cycles),
                plan_diagnostics=deepcopy(plan_diagnostics),
            )
        )
    return jobs


def _materialize_read(job: ReadJob, submitted_at: float) -> ReadPayload:
    from app.services import time_capacity_path

    started = time.perf_counter()
    diagnostics: dict[str, Any] = deepcopy(job.plan_diagnostics)
    plan = job.plan
    requested = job.requested_cycles
    if plan.path in {"indexed", "missing"}:
        raw = time_capacity_path.load_indexed_time_capacity_raw(
            plan,
            requested,
            diagnostics=diagnostics,
            wait_for_layout=True,
        )
        if raw is None:
            raise RuntimeError("indexed read became unavailable during 050.9 prefetch")
    else:
        # The committed golden fixture is indexed.  Keep the fallback explicit
        # rather than silently claiming B1/B2 isolated indexed evidence for a
        # legacy cache.
        raise RuntimeError(
            "read/decode candidate requires indexed data, "
            f"got {plan.path} ({diagnostics.get('fallback_reason', 'no reason')})"
        )

    prepared = None
    if plan.path == "indexed" and requested and job.derived_columns:
        prepared = time_capacity_path.load_indexed_time_capacity_derived(
            plan,
            requested,
            job.derived_columns,
            diagnostics=diagnostics,
            wait_for_layout=True,
        )
    return ReadPayload(
        job=job,
        plan=plan,
        requested_cycles=tuple(requested),
        raw=raw,
        prepared=prepared,
        diagnostics=diagnostics,
        queue_ms=(started - submitted_at) * 1000.0,
        worker_wall_ms=(time.perf_counter() - started) * 1000.0,
    )


def run_read_prefetch(jobs: list[ReadJob], workers: int) -> tuple[list[ReadPayload], dict[str, float]]:
    submitted: dict[int, float] = {}
    dispatch_started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"spec0509-read-{workers}") as pool:
        futures = []
        for job in jobs:
            submitted[job.index] = time.perf_counter()
            futures.append(pool.submit(_materialize_read, job, submitted[job.index]))
        dispatch_ms = (time.perf_counter() - dispatch_started) * 1000.0
        payloads = [future.result() for future in futures]
    payloads.sort(key=lambda item: item.job.index)
    return payloads, {
        "dispatch_ms": dispatch_ms,
        "queue_ms": sum(item.queue_ms for item in payloads),
        "per_cell_wall_ms": [item.worker_wall_ms for item in payloads],
    }


def _merge_read_diagnostics(payloads: list[ReadPayload]) -> dict[str, Any]:
    return {"cells": [item.diagnostics for item in payloads]}


def _prefetched_engine_context(payloads: list[ReadPayload]):
    from app.services import time_capacity_path

    by_refs = {tuple(item.plan.refs): item for item in payloads}

    def find(refs: Iterable[Any]) -> ReadPayload:
        key = tuple(refs)
        try:
            return by_refs[key]
        except KeyError as exc:
            raise RuntimeError("050.9 prefetch returned an unexpected source plan") from exc

    def build_plan(refs: Iterable[Any], *, diagnostics: dict[str, Any] | None = None):
        item = find(refs)
        if diagnostics is not None:
            diagnostics.update(
                {
                    key: value
                    for key, value in item.diagnostics.items()
                    if key != "stages"
                }
            )
        return item.plan

    def load_raw(plan: Any, requested_cycles: Iterable[int], *, diagnostics: dict[str, Any] | None = None):
        item = find(plan.refs)
        if diagnostics is not None:
            diagnostics.update(
                {
                    key: value
                    for key, value in item.diagnostics.items()
                    if key != "stages"
                }
            )
        return item.raw.copy(deep=True)

    def load_derived(
        plan: Any,
        requested_cycles: Iterable[int],
        columns: Iterable[str],
        *,
        diagnostics: dict[str, Any] | None = None,
    ):
        item = find(plan.refs)
        if item.prepared is None:
            if diagnostics is not None:
                diagnostics["derived_access"] = "fallback"
            return None
        if diagnostics is not None:
            diagnostics.update(
                {
                    key: value
                    for key, value in item.diagnostics.items()
                    if key != "stages"
                }
            )
            diagnostics["derived_access"] = "prepared"
        return item.prepared.copy(deep=True)

    return patch.object(time_capacity_path, "build_time_capacity_stitch_plan", build_plan), patch.object(
        time_capacity_path,
        "load_indexed_time_capacity_raw",
        load_raw,
    ), patch.object(
        time_capacity_path,
        "load_indexed_time_capacity_derived",
        load_derived,
    )


def run_read_candidate(
    env: GoldenFixtureEnvironment,
    spec: dict,
    jobs: list[ReadJob],
    workers: int,
    reference: dict,
    *,
    scenario: str,
) -> tuple[dict[str, Any], dict]:
    from app.services import analysis_engine

    rss_before = current_rss()
    started_cpu = time.process_time()
    started = time.perf_counter()
    payloads, dispatch = run_read_prefetch(jobs, workers)
    read_wall_ms = (time.perf_counter() - started) * 1000.0
    transform_diagnostics: dict[str, Any] = {}
    transform_started = time.perf_counter()
    contexts = _prefetched_engine_context(payloads)
    with contexts[0], contexts[1], contexts[2]:
        result = analysis_engine.compute_time_capacity(
            env.db,
            spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            access_diagnostics=transform_diagnostics,
        )
    transform_wall_ms = (time.perf_counter() - transform_started) * 1000.0
    backend_wall_ms = (time.perf_counter() - started) * 1000.0
    cpu_seconds = time.process_time() - started_cpu
    serialization_ms = _serialize_result(result)
    rss_after = current_rss()
    read_diagnostics = _merge_read_diagnostics(payloads)
    row = _measurement_row(
        candidate=f"B{workers // 2}",
        workers=workers,
        scenario=scenario,
        cells=[job.cell_id for job in jobs],
        result=result,
        diagnostics=transform_diagnostics,
        reference=reference,
        backend_wall_ms=backend_wall_ms,
        cpu_seconds=cpu_seconds,
        serialization_ms=serialization_ms,
        queue_ms=dispatch["queue_ms"],
        dispatch_ms=dispatch["dispatch_ms"],
        rss_before=rss_before,
        rss_after=rss_after,
        native_settings=native_thread_settings(),
        extra={
            "ablation": "read_decode_only",
            "read_wall_ms": read_wall_ms,
            "read_decode_ms": sum(dispatch["per_cell_wall_ms"]),
            "read_per_cell_job_wall_ms": _min_max(dispatch["per_cell_wall_ms"]),
            "sequential_transform_wall_ms": transform_wall_ms,
            "read_rows": sum(
                int(item.diagnostics.get("raw_rows_materialized") or 0)
                for item in payloads
            ),
            "read_columns": _column_count(read_diagnostics),
            "prefetch_plan_order": [item.job.index for item in payloads],
        },
    )
    return row, result


def _whole_cell_task(
    session_factory: Callable[[], Any],
    index: int,
    cell_id: int,
    spec: dict,
    submitted_at: float,
) -> WholeCellPayload:
    from app.services import analysis_engine

    started = time.perf_counter()
    session = session_factory()
    try:
        diagnostics: dict[str, Any] = {}
        result = analysis_engine.compute_time_capacity(
            session,
            spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            access_diagnostics=diagnostics,
        )
    finally:
        session.close()
    return WholeCellPayload(
        index=index,
        cell_id=cell_id,
        result=result,
        diagnostics=diagnostics,
        queue_ms=(started - submitted_at) * 1000.0,
        worker_wall_ms=(time.perf_counter() - started) * 1000.0,
    )


def _merge_whole_cell_results(reference: dict, payloads: list[WholeCellPayload]) -> tuple[dict, float]:
    started = time.perf_counter()
    ordered = sorted(payloads, key=lambda item: item.index)
    result = deepcopy(reference)
    result["cell_traces"] = [
        trace
        for item in ordered
        for trace in item.result.get("cell_traces", [])
    ]
    result["rendering"] = dict(reference.get("rendering") or {})
    result["rendering"]["total_points"] = sum(
        int(item.result.get("rendering", {}).get("total_points") or 0)
        for item in ordered
    )
    return result, (time.perf_counter() - started) * 1000.0


def run_whole_cell_candidate(
    fixture_db: FileBackedFixtureDatabase,
    base: dict,
    cell_ids: list[int],
    cycles: list[int],
    cycle_end: int | None,
    *,
    x_axis: str,
    view: str,
    derivative_specific: bool,
    workers: int,
    reference: dict,
    scenario: str,
) -> tuple[dict[str, Any], dict]:
    from app.services import analysis_engine

    specs = [
        make_spec(
            base,
            [cell_id],
            cycles,
            cycle_end,
            x_axis=x_axis,
            view=view,
            derivative_specific=derivative_specific,
        )
        for cell_id in cell_ids
    ]
    rss_before = current_rss()
    started_cpu = time.process_time()
    started = time.perf_counter()
    submitted: dict[int, float] = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"spec0509-cell-{workers}") as pool:
        futures = []
        for index, (cell_id, spec) in enumerate(zip(cell_ids, specs)):
            submitted[index] = time.perf_counter()
            futures.append(
                pool.submit(
                    _whole_cell_task,
                    fixture_db.session_factory,
                    index,
                    cell_id,
                    spec,
                    submitted[index],
                )
            )
        dispatch_ms = (time.perf_counter() - started) * 1000.0
        payloads = [future.result() for future in futures]
    payloads.sort(key=lambda item: item.index)
    merged, merge_ms = _merge_whole_cell_results(reference, payloads)
    serialization_ms = _serialize_result(merged)
    backend_wall_ms = (time.perf_counter() - started) * 1000.0
    cpu_seconds = time.process_time() - started_cpu
    rss_after = current_rss()
    diagnostics = {"cells": [item.diagnostics["cells"][0] for item in payloads]}
    row = _measurement_row(
        candidate=f"B{workers // 2 + 2}",
        workers=workers,
        scenario=scenario,
        cells=cell_ids,
        result=merged,
        diagnostics=diagnostics,
        reference=reference,
        backend_wall_ms=backend_wall_ms,
        cpu_seconds=cpu_seconds,
        serialization_ms=serialization_ms,
        queue_ms=sum(item.queue_ms for item in payloads),
        dispatch_ms=dispatch_ms,
        rss_before=rss_before,
        rss_after=rss_after,
        native_settings=native_thread_settings(),
        extra={
            "ablation": "whole_existing_per_cell_job",
            "merge_ms": merge_ms,
            "per_cell_job_wall_ms": _min_max(item.worker_wall_ms for item in payloads),
            "per_cell_job_wall_ms_sum": sum(item.worker_wall_ms for item in payloads),
            "worker_order": [item.index for item in payloads],
        },
    )
    return row, merged


def _median_candidate(rows: list[dict[str, Any]], candidate: str, key: str) -> float | None:
    return _median(
        row.get(key)
        for row in rows
        if row.get("candidate") == candidate and row.get("status") == "PASS"
    )


def _decision_label(candidate_values: list[float], baseline_values: list[float]) -> str:
    comparisons = [
        candidate / baseline
        for candidate, baseline in zip(candidate_values, baseline_values)
        if baseline > 0
    ]
    if not comparisons:
        return "not_measurable"
    median_ratio = statistics.median(comparisons)
    if median_ratio <= 1.0 - IMPROVEMENT_THRESHOLD:
        return "useful"
    if median_ratio >= 1.0 + IMPROVEMENT_THRESHOLD:
        return "harmful"
    return "none"


def summarize_decisions(workloads: list[dict[str, Any]]) -> dict[str, Any]:
    baseline_rows: list[dict[str, Any]] = []
    read_rows: dict[str, list[dict[str, Any]]] = {"B1": [], "B2": []}
    whole_rows: dict[str, list[dict[str, Any]]] = {"B3": [], "B4": []}
    for workload in workloads:
        rows = workload["samples"]
        baseline_rows.extend(row for row in rows if row["candidate"] == "A0")
        for candidate in read_rows:
            read_rows[candidate].extend(row for row in rows if row["candidate"] == candidate)
        for candidate in whole_rows:
            whole_rows[candidate].extend(row for row in rows if row["candidate"] == candidate)

    def row_value(row: dict[str, Any], key: str) -> object:
        value: object = row
        for part in key.split("."):
            if not isinstance(value, dict):
                return None
            value = value.get(part)
        return value

    def paired_values(
        rows: list[dict[str, Any]],
        candidate_key: str,
        baseline_key: str,
    ) -> tuple[list[float], list[float]]:
        candidates: list[float] = []
        baselines: list[float] = []
        by_scenario: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_scenario.setdefault(row["scenario"], []).append(row)
        for scenario, scenario_rows in by_scenario.items():
            candidate_value = _median(
                row_value(row, candidate_key)
                for row in scenario_rows
                if row.get("status") == "PASS"
            )
            baseline_value = _median(
                row_value(row, baseline_key)
                for row in baseline_rows
                if row["scenario"] == scenario and row.get("status") == "PASS"
            )
            if _finite(candidate_value) and _finite(baseline_value):
                candidates.append(float(candidate_value))
                baselines.append(float(baseline_value))
        return candidates, baselines

    read_decisions: dict[str, str] = {}
    whole_decisions: dict[str, str] = {}
    for candidate, rows in read_rows.items():
        candidates, baselines = paired_values(
            rows,
            "read_wall_ms",
            "stages.raw_read_decode_ms",
        )
        read_decisions[candidate] = _decision_label(candidates, baselines)
    for candidate, rows in whole_rows.items():
        candidates, baselines = paired_values(
            rows,
            "backend_wall_ms",
            "backend_wall_ms",
        )
        whole_decisions[candidate] = _decision_label(candidates, baselines)

    baseline_stage_values: dict[str, list[float]] = {}
    for row in baseline_rows:
        for key in (
            "raw_read_decode_ms",
            "transform_ms",
            "derivative_ms",
            "downsampling_ms",
        ):
            value = row.get("stages", {}).get(key)
            if _finite(value):
                baseline_stage_values.setdefault(key, []).append(float(value))
    stage_medians = {
        key: statistics.median(values)
        for key, values in baseline_stage_values.items()
        if values
    }
    dominant = max(stage_medians, key=stage_medians.get) if stage_medians else "not_measurable"
    small = [
        workload
        for workload in workloads
        if "small" in workload["scenario"] or workload.get("cell_count") == 1
    ]
    small_regression = False
    for workload in small:
        base = _median_candidate(workload["samples"], "A0", "backend_wall_ms")
        if not _finite(base) or base <= 0:
            continue
        for candidate in ("B1", "B2", "B3", "B4"):
            value = _median_candidate(workload["samples"], candidate, "backend_wall_ms")
            if _finite(value) and value > float(base) * 1.10:
                small_regression = True
    return {
        "threshold": f"{IMPROVEMENT_THRESHOLD:.0%} median paired change",
        "read_concurrency": read_decisions,
        "whole_cell_python_threads": whole_decisions,
        "small_job_regression": "not_acceptable" if small_regression else "acceptable",
        "dominant_residual_backend_stage": dominant,
        "dominant_stage_medians_ms": stage_medians,
        "rust_050_10_handoff": (
            "Benchmark derivative rolling, gradient, ratio/filter and postprocess "
            "kernels separately in 050.10; derivative requests still spend "
            "approximately 136-1,263 ms in that stage across the measured one- to "
            "six-Cell suites, even though normal requests are transform-dominated."
        ),
    }


def run_cache_hit_control(env: GoldenFixtureEnvironment, base: dict, cell_ids: list[int]) -> dict[str, Any]:
    from app.models import Analysis
    from app.routers import analyses as analyses_router
    from app.services import analysis_cache, analysis_engine, cache, time_capacity_path

    spec = make_spec(
        base,
        cell_ids,
        list(range(1, 21)),
        20,
        x_axis="time",
        view="voltage_current",
    )
    analysis = Analysis(title="050.9 exact-cache control", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    with tempfile.TemporaryDirectory(prefix="cellxplorer-0509-result-cache-") as result_root:
        with patch.object(analysis_cache, "_RESULTS", Path(result_root) / "results"):
            first = analyses_router.compute_time_capacity_analysis(
                analysis.id,
                analyses_router.ComputeRequest(
                    recompute=True,
                    profile=True,
                    profile_request_id="050.9-cache-miss",
                ),
                env.db,
            )
            first_body = json.loads(first.body)
            try:
                with (
                    patch.object(analysis_engine, "compute_time_capacity", side_effect=AssertionError("cache hit dispatched compute")),
                    patch.object(cache, "load_raw", side_effect=AssertionError("cache hit read raw")),
                    patch.object(time_capacity_path, "load_indexed_time_capacity_raw", side_effect=AssertionError("cache hit read indexed raw")),
                    patch("concurrent.futures.ThreadPoolExecutor", side_effect=AssertionError("cache hit dispatched worker")),
                ):
                    second = analyses_router.compute_time_capacity_analysis(
                        analysis.id,
                        analyses_router.ComputeRequest(
                            profile=True,
                            profile_request_id="050.9-cache-hit",
                        ),
                        env.db,
                    )
            except AssertionError as exc:
                return {
                    "status": "FAIL",
                    "reason": str(exc),
                    "first_cache_state": first_body.get("profiling", {}).get("result_cache"),
                }
            second_body = json.loads(second.body)
    return {
        "status": "PASS",
        "first_cache_state": first_body.get("profiling", {}).get("result_cache"),
        "hit_cache_state": second_body.get("profiling", {}).get("result_cache"),
        "hit_raw_access": second_body.get("profiling", {}).get("raw_access"),
        "worker_dispatch": "not observed",
        "scientific_payload_equal": {
            key: first_body.get(key) == second_body.get(key)
            for key in ("cell_traces", "settings", "rendering", "voltage_channels")
        },
    }


def workload_matrix(cell_ids: list[int]) -> list[dict[str, Any]]:
    selected = {
        count: cell_ids[:count]
        for count in (1, 3, 6, 10)
    }
    workloads: list[dict[str, Any]] = []
    for count in (1, 3, 6, 10):
        workloads.append(
            {
                "scenario": f"normal-{count}-all-time",
                "cell_ids": selected[count],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "time",
                "view": "voltage_current",
                "derivative_specific": False,
            }
        )
    if len(cell_ids) >= 11:
        workloads.append(
            {
                "scenario": "normal-11-all-time",
                "cell_ids": cell_ids[:11],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "time",
                "view": "voltage_current",
                "derivative_specific": False,
            }
        )
    for count in (1, 3, 6):
        workloads.append(
            {
                "scenario": f"normal-{count}-all-capacity",
                "cell_ids": selected[count],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "capacity_mah",
                "view": "voltage_current",
                "derivative_specific": False,
            }
        )
    workloads.append(
        {
            "scenario": "control-6-cycles-1-20-time",
            "cell_ids": selected[6],
            "cycles": list(range(1, 21)),
            "cycle_end": 20,
            "x_axis": "time",
            "view": "voltage_current",
            "derivative_specific": False,
        }
    )
    for count in (1, 3, 6):
        workloads.append(
            {
                "scenario": f"derivative-{count}-all-dqdv",
                "cell_ids": selected[count],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "capacity_mah",
                "view": "dqdv",
                "derivative_specific": False,
            }
        )
    workloads.extend(
        [
            {
                "scenario": "derivative-1-all-dvdq",
                "cell_ids": selected[1],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "capacity_mah",
                "view": "dvdq",
                "derivative_specific": False,
            },
            {
                "scenario": "derivative-small-1-3-dqdv",
                "cell_ids": selected[1],
                "cycles": list(range(1, 4)),
                "cycle_end": 3,
                "x_axis": "capacity_mah",
                "view": "dqdv",
                "derivative_specific": False,
            },
        ]
    )
    return workloads


def profile_workload(
    env: GoldenFixtureEnvironment,
    fixture_db: FileBackedFixtureDatabase,
    base: dict,
    workload: dict[str, Any],
    *,
    repetitions: int,
) -> dict[str, Any]:
    scenario = workload["scenario"]
    spec = make_spec(
        base,
        workload["cell_ids"],
        workload["cycles"],
        workload["cycle_end"],
        x_axis=workload["x_axis"],
        view=workload["view"],
        derivative_specific=workload["derivative_specific"],
    )
    # Warm the same current path once, outside the reported repetitions.
    _, reference = run_production_sample(env, spec, None, scenario=f"{scenario}-warmup")
    samples: list[dict[str, Any]] = []
    for repetition in range(repetitions):
        baseline, baseline_result = run_production_sample(
            env,
            spec,
            reference,
            scenario=scenario,
        )
        samples.append(baseline)
        jobs = build_read_jobs(env, spec, workload["cell_ids"])
        candidate_order = (2, 4) if repetition % 2 == 0 else (4, 2)
        for workers in candidate_order:
            read_row, _ = run_read_candidate(
                env,
                spec,
                jobs,
                workers,
                reference,
                scenario=scenario,
            )
            samples.append(read_row)
            whole_row, _ = run_whole_cell_candidate(
                fixture_db,
                base,
                workload["cell_ids"],
                workload["cycles"],
                workload["cycle_end"],
                x_axis=workload["x_axis"],
                view=workload["view"],
                derivative_specific=workload["derivative_specific"],
                workers=workers,
                reference=reference,
                scenario=scenario,
            )
            samples.append(whole_row)
        if any(row["status"] != "PASS" for row in samples[-4:]):
            raise RuntimeError(f"Scientific parity failed in {scenario} repetition {repetition + 1}")
    return {
        **{key: value for key, value in workload.items() if key != "cell_ids"},
        "cell_count": len(workload["cell_ids"]),
        "repetitions": repetitions,
        "warmup": "one sequential production request, not recorded",
        "samples": samples,
        "candidate_medians_ms": {
            candidate: _median_candidate(samples, candidate, "backend_wall_ms")
            for candidate in ("A0", "B1", "B2", "B3", "B4")
        },
        "candidate_ranges_ms": {
            candidate: _min_max(
                row.get("backend_wall_ms")
                for row in samples
                if row.get("candidate") == candidate
            )
            for candidate in ("A0", "B1", "B2", "B3", "B4")
        },
        "reference_digest": scientific_digest(reference),
        "canonical_output_order": "original selection order",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write disposable JSON evidence here")
    parser.add_argument("--repetitions", type=int, default=REPETITIONS)
    parser.add_argument(
        "--app-data-root",
        type=Path,
        default=Path.home() / ".cellxplorer",
        help="Also profile a saved Performance analysis from this app data root when present",
    )
    parser.add_argument(
        "--fixture-only",
        action="store_true",
        help="Skip the real application database suite",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        help="Run only these scenario names; repeat for multiple focused scenarios",
    )
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    case = {
        "id": "time_capacity_profile",
        "kind": "time_capacity",
        "spec_path": "specs/time_capacity_baseline.json",
    }
    fixture_base = load_case_spec(fixture_root, case)
    native_settings = native_thread_settings()
    saved_data_root = os.environ.get("CELLXPLORER_DATA")
    suites: list[dict[str, Any]] = []
    cache_controls: dict[str, Any] = {}
    skipped_suites: dict[str, str] = {}
    requested_scenarios = set(args.scenario or [])
    try:
        with GoldenFixtureEnvironment.create() as env:
            clone_ids = clone_golden_source_cells(env, 10)
            selected_cells = [GOLDEN_CELL_ID, *clone_ids[:9]]
            workloads = workload_matrix(selected_cells)
            if requested_scenarios:
                workloads = [
                    workload
                    for workload in workloads
                    if workload["scenario"] in requested_scenarios
                ]
            with FileBackedFixtureDatabase(env.db) as fixture_db:
                profiled = []
                for workload in workloads:
                    print(f"profiling fixture/{workload['scenario']}", flush=True)
                    item = profile_workload(
                        env,
                        fixture_db,
                        fixture_base,
                        workload,
                        repetitions=args.repetitions,
                    )
                    item["suite"] = "golden_fixture"
                    profiled.append(item)
            suites.extend(profiled)
            cache_controls["golden_fixture"] = run_cache_hit_control(
                env,
                fixture_base,
                selected_cells[:3],
            )

        if not args.fixture_only:
            app_root = args.app_data_root.resolve()
            if not (app_root / "cellxplorer.db").is_file():
                skipped_suites["application"] = f"database not found at {app_root / 'cellxplorer.db'}"
            else:
                try:
                    with create_application_environment(app_root) as app_env:
                        app_base, app_cells, app_metadata = discover_application_dataset(app_env)
                        app_workloads = workload_matrix(app_cells)
                        if requested_scenarios:
                            app_workloads = [
                                workload
                                for workload in app_workloads
                                if workload["scenario"] in requested_scenarios
                            ]
                        with FileBackedFixtureDatabase(app_env.db) as app_fixture_db:
                            for workload in app_workloads:
                                print(f"profiling application/{workload['scenario']}", flush=True)
                                item = profile_workload(
                                    app_env,
                                    app_fixture_db,
                                    app_base,
                                    workload,
                                    repetitions=args.repetitions,
                                )
                                item["suite"] = "application_performance_batch"
                                item["dataset"] = app_metadata
                                suites.append(item)
                        cache_controls["application_performance_batch"] = run_cache_hit_control(
                            app_env,
                            app_base,
                            app_cells[: min(3, len(app_cells))],
                        )
                except (FileNotFoundError, RuntimeError, OSError) as exc:
                    skipped_suites["application"] = f"NOT RUN: {type(exc).__name__}: {exc}"
    finally:
        from golden_analysis_support import restore_data_root_binding

        restore_data_root_binding(saved_data_root)

    if requested_scenarios:
        known = {item["scenario"] for item in suites}
        missing = requested_scenarios - known
        if missing:
            parser.error(f"unknown scenario(s): {', '.join(sorted(missing))}")

    evidence = {
        "spec": "050.9",
        "suites": {
            "golden_fixture": "committed golden source plus 10 disposable source-identical Cell clones",
            "application_performance_batch": "real cached Cells from the saved Performance analysis batch when available",
        },
        "skipped_suites": skipped_suites,
        "request_contract": {
            "precision": "standard",
            "compact": True,
            "viewport_width": 1200,
            "max_points_per_cell": 4000,
        },
        "repetitions": args.repetitions,
        "native_thread_settings": native_settings,
        "matrix": suites,
        "controls": {
            "exact_persisted_result_cache_hit": cache_controls,
            "continuation_boundary": {
                "status": "NOT RUN",
                "reason": "The committed golden manifest has one source per Cell; no representative continuation boundary is available in this disposable harness.",
            },
            "narrow_viewport_like_range": "control-6-cycles-1-20-time",
        },
        "decisions": summarize_decisions(suites) if suites else {"status": "NOT RUN"},
        "execution_contract": {
            "production_executor": "not installed",
            "process_pool": "not used",
            "rust": "not used; reserved for 050.10",
            "adaptive_zoom_or_plotly": "not used",
            "whole_cell_ram_cache": "not used; prefetched frames are released per candidate",
            "worker_session_policy": "B3/B4 create one independent SQLite session per worker; no Session is shared",
            "merge_policy": "selection index, never completion order",
        },
    }
    rendered = json.dumps(evidence, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "spec": evidence["spec"],
                "workloads": len(suites),
                "repetitions": args.repetitions,
                "decisions": evidence["decisions"],
                "cache_control": cache_controls,
                "skipped_suites": skipped_suites,
                "output": str(args.output) if args.output else None,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
