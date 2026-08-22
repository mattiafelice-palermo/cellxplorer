"""Benchmark-only cross-Cell concurrency ablation for Spec 050.9.

This script deliberately keeps concurrency out of the production request path.
It runs the current engine against a disposable golden-fixture database and
compares two isolated boundaries:

* B1/B2 resolve owner state before the candidate timer, prefetch indexed
  Parquet in 2/4 threads, then run the current engine sequentially with those
  prefetched frames;
* B3/B4 resolve the relational/request boundary once, then run each existing
  per-Cell read plus transform from immutable descriptors in 2/4 threads and
  merge results in selection order.

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
from typing import Any, Iterable
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
class ResolvedCellDescriptor:
    """Immutable per-Cell context resolved before a worker is submitted."""

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
    """Request state that is safe to pass to the benchmark worker."""

    type: str
    settings: dict[str, Any]
    calc_version: str
    current_calc_version: str
    protocol_badges: tuple[dict[str, Any], ...]
    viewport_width: int
    precision: str
    compact: bool


@dataclass(frozen=True)
class ReadJob:
    """Immutable worker input resolved by the owning relational context."""

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
    result: dict[str, Any]
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
        "read_plan_ms": stages.get("index_stitch_plan"),
        "raw_read_decode_ms": _sum_stage(
            stages,
            (
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
        "backend_stages_ms": profile.get("backend_stages_ms"),
        "transform_stages": profile.get("transform_stages"),
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


def resolved_request(spec: dict) -> ResolvedRequest:
    from app.services import analysis_engine

    protocol_context, protocol_badges = analysis_engine._protocol_filter_context(spec)
    if protocol_context.get("active"):
        raise RuntimeError("050.9 resolved-worker benchmark does not cover active protocol filters")
    settings = analysis_engine.time_capacity_settings(spec.get("computation", {}))
    return ResolvedRequest(
        type=spec.get("type", "cycling"),
        settings=deepcopy(settings),
        calc_version=analysis_engine.CALC_VERSION,
        current_calc_version=analysis_engine.CALC_VERSION,
        protocol_badges=tuple(deepcopy(protocol_badges)),
        viewport_width=1200,
        precision="standard",
        compact=True,
    )


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
    cells = []
    for cell_id in cell_ids:
        cell = env.db.get(analysis_engine.Cell, cell_id)
        if cell is None:
            raise RuntimeError(f"Fixture cell {cell_id} was not found")
        cells.append(cell)
    analysis_engine.preload_cell_sources(env.db, cells)
    scalar_metadata = analysis_engine.load_scalar_metadata(env.db, cells)
    selection = spec.get("selection", {})
    exclusions = selection.get("exclusions", [])
    hidden_group_ids = set(selection.get("hidden_replicate_group_ids", []))
    jobs: list[ReadJob] = []
    for index, (cell_id, cell) in enumerate(zip(cell_ids, cells)):
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
        available_columns = {
            column
            for source in plan.sources
            for column in source.index.get("raw_column_names", ())
        }
        requested_columns = time_capacity_path.time_capacity_request_columns(
            available_columns,
            settings,
            precision="standard",
            compact=True,
        )
        matched_files_by_quantity = {
            quantity: []
            for quantity in analysis_engine.canonical_cycling.VOLTAGE_QUANTITIES
        }
        if plan.path in {"indexed", "missing"}:
            source_by_hash = {source_file.hash: source_file for source_file in files}
            for source in plan.sources:
                for quantity, column in analysis_engine.canonical_cycling.VOLTAGE_QUANTITIES.items():
                    if source.voltage_data_availability.get(column) is True:
                        source_file = source_by_hash.get(source.ref.file_hash)
                        if source_file is not None:
                            matched_files_by_quantity[quantity].append(source_file)
        local_roles, local_references = analysis_engine._resolve_time_capacity_voltage_context(
            files,
            matched_files_by_quantity,
        )
        voltage_facts = tuple(
            (
                quantity,
                bool(matched_files_by_quantity[quantity]),
                local_roles[quantity],
                local_references[quantity],
            )
            for quantity in analysis_engine.canonical_cycling.VOLTAGE_QUANTITIES
        )
        unit = {
            "cell": cell,
            "group_id": None,
            "group_name": None,
            "label": cell.name,
            "entry_kind": "cell",
            "entry_ref_id": cell.id,
        }
        descriptor = ResolvedCellDescriptor(
            cell_id=int(cell.id),
            cell_name=str(cell.name),
            label=str(unit["label"]),
            group_id=None,
            group_name=None,
            active_mass_mg=analysis_engine.cell_active_mass_mg(
                cell,
                scalar_metadata.get(cell.id),
            ),
            nominal_capacity_mah=analysis_engine.cell_nominal_capacity_mah(
                cell,
                scalar_metadata.get(cell.id),
            ),
            electrode_area_cm2=analysis_engine.cell_electrode_area_cm2(
                cell,
                scalar_metadata.get(cell.id),
            ),
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
            excluded=(
                analysis_engine.exclusion_for_unit(exclusions, unit) is not None
                or unit["group_id"] in hidden_group_ids
            ),
        )
        jobs.append(
            ReadJob(
                index=index,
                cell_id=cell_id,
                refs=refs,
                explicit_cycles=tuple(settings["cycles"]),
                cycle_start=settings["cycle_start"],
                cycle_end=settings["cycle_end"],
                requested_columns=tuple(requested_columns),
                derived_columns=derived_columns,
                plan=plan,
                requested_cycles=tuple(requested_cycles),
                plan_diagnostics=deepcopy(plan_diagnostics),
                descriptor=descriptor,
            )
        )
    return jobs


def prepare_resolved_jobs(
    env: GoldenFixtureEnvironment,
    spec: dict,
    cell_ids: list[int],
) -> tuple[list[ReadJob], ResolvedRequest, dict[str, Any]]:
    """Resolve the once-per-request owner boundary and measure it separately."""

    from app.services import analysis_engine

    started_cpu = time.process_time()
    started = time.perf_counter()
    analysis_engine.ensure_canonical_cycling_available(env.db, spec)
    request = resolved_request(spec)
    jobs = build_read_jobs(env, spec, cell_ids)
    return jobs, request, {
        "wall_ms": (time.perf_counter() - started) * 1000.0,
        "cpu_seconds": time.process_time() - started_cpu,
        "resolved_cell_count": len(jobs),
    }


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
            requested_columns=job.requested_columns,
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


def _resolved_source_columns(frame: Any, descriptor: ResolvedCellDescriptor) -> dict[str, list]:
    """Build provenance columns from the immutable source descriptor."""

    from pandas import isna

    by_hash = {file_hash: filename for file_hash, filename in descriptor.source_names}
    positions = {
        file_hash: index
        for index, (file_hash, _filename) in enumerate(descriptor.source_names, start=1)
    }
    hashes = frame.get("source_hash", []).tolist()
    source_cycles = frame.get("source_cycle", []).tolist()

    def safe_int(value: object) -> int | None:
        if value is None or isna(value):
            return None
        return int(value)

    return {
        "source_cycle": [safe_int(value) for value in source_cycles],
        "source_position": [positions.get(value) for value in hashes],
        "source_filename": [by_hash.get(value) for value in hashes],
        "source_hash": [value if value in by_hash else None for value in hashes],
    }


def _empty_resolved_trace(
    descriptor: ResolvedCellDescriptor,
    segments: tuple[dict[str, Any], ...],
) -> dict[str, Any]:
    return {
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
        "segments": list(deepcopy(segments)),
        "source_descriptors": list(deepcopy(descriptor.source_descriptors)),
        "source_cycle": [],
        "source_position": [],
        "source_filename": [],
        "source_hash": [],
        "source_boundary_indices": [],
    }


def _resolved_cell_result(
    job: ReadJob,
    payload: ReadPayload,
    request: ResolvedRequest,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run the existing single-Cell scientific transform without a Session.

    All relational state is represented by ``job.descriptor`` and all physical
    input rows are loaded from the already-resolved cache plan. This is the
    worker boundary for B3/B4; it intentionally mirrors the current
    ``compute_time_capacity`` per-Cell transform and does not assemble a result
    from A0.
    """

    import numpy as np

    from app.services import analysis_engine, stitch, time_capacity_derived, time_capacity_path

    descriptor = job.descriptor
    plan = payload.plan
    cell_diagnostics: dict[str, Any] = {
        "cell_id": descriptor.cell_id,
        "cell_name": descriptor.cell_name,
        **deepcopy(payload.diagnostics),
    }
    raw = payload.raw.copy()
    segments = tuple(deepcopy(descriptor.segments))
    missing = list(descriptor.missing)
    cell_diagnostics["raw_rows_loaded_before_filter"] = len(raw)
    if plan.path not in {"indexed", "missing"}:
        cell_diagnostics["raw_rows_materialized"] = len(raw)
        cell_diagnostics["row_groups_read"] = "full"
        cell_diagnostics["row_groups_total"] = "full"

    badges: list[dict[str, Any]] = []
    versions = dict(descriptor.source_versions)
    for file_hash in missing:
        missing_identity = versions.get(file_hash, "unknown")
        badges.append(
            {
                "kind": "cache_missing",
                "cell_id": descriptor.cell_id,
                "cell_name": descriptor.cell_name,
                "detail": f"No raw cache at parser {missing_identity} for file {file_hash[:12]}...",
            }
        )

    complete = stitch.stitch_metadata(raw)["complete"]
    if not complete:
        badges.append(
            {
                "kind": "continuation_source_missing",
                "cell_id": descriptor.cell_id,
                "cell_name": descriptor.cell_name,
                "missing_source_hashes": missing,
                "missing_source_positions": list(descriptor.missing_positions),
                "detail": (
                    "The ordered Cell source chain is incomplete; the scientific "
                    "time/capacity trace was withheld until every source cache is available."
                ),
            }
        )
    if raw.empty or "cycle" not in raw.columns or not complete:
        return (
            {
                "trace": _empty_resolved_trace(descriptor, segments),
                "badges": badges,
                "voltage_facts": list(descriptor.voltage_facts),
                "source_versions": list(descriptor.source_versions),
                "current_parser_versions": list(descriptor.current_parser_versions),
            },
            {"cells": [cell_diagnostics]},
        )

    settings = request.settings
    transform_needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
        settings,
        precision=request.precision,
        compact=request.compact,
    )
    prepared_derived = payload.prepared
    with time_capacity_path.timed_stage(cell_diagnostics, "exact_cycle_filter_and_sort"):
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
        cell_diagnostics["selected_rows_before_transforms"] = len(raw)

    with time_capacity_path.timed_stage(cell_diagnostics, "continuous_time_phase_capacity"):
        transform_rows = len(raw)
        if transform_needs.continuous_time:
            with time_capacity_path.timed_stage(cell_diagnostics, "transform_continuous_time"):
                raw = analysis_engine._continuous_time(raw)
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "continuous_time",
            input_rows=transform_rows,
            output_rows=len(raw) if transform_needs.continuous_time else 0,
            consumed_by=tuple(
                [
                    *(
                        ["time_axis"]
                        if settings["view"] == "voltage_current" and settings["x_axis"] == "time"
                        else []
                    ),
                    *( ["full_export"] if request.precision == "full" or not request.compact else []),
                ]
            ),
        )
        with time_capacity_path.timed_stage(cell_diagnostics, "transform_source_provenance"):
            source_values = _resolved_source_columns(raw, descriptor)
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "source_provenance",
            input_rows=len(raw),
            output_rows=len(raw),
            consumed_by=("provenance_output",),
        )
        with time_capacity_path.timed_stage(cell_diagnostics, "transform_source_boundaries"):
            source_boundary_indices = (
                np.flatnonzero(
                    raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]
                )
                + 1
                if "segment" in raw.columns and len(raw) > 1
                else np.array([], dtype="int64")
            )
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "source_boundaries",
            input_rows=len(raw),
            output_rows=len(source_boundary_indices),
            consumed_by=("provenance_output", "display_downsampling"),
        )
        aligned_prepared = (
            analysis_engine._aligned_prepared_transform_values(
                raw,
                prepared_derived,
                need_capacity=transform_needs.phase_capacity,
            )
            if prepared_derived is not None
            else None
        )
        if aligned_prepared is not None:
            phases, prepared_capacity = aligned_prepared
            cell_diagnostics["derived_access"] = "prepared"
            phase_source = "prepared"
            capacity_source = "prepared" if transform_needs.phase_capacity else "not_needed"
        else:
            cell_diagnostics["derived_access"] = (
                "fallback" if transform_needs.phase_capacity else "not_needed"
            )
            with time_capacity_path.timed_stage(cell_diagnostics, "transform_phase_classification"):
                phases = analysis_engine._phase_from_raw(raw)
            phase_source = "computed"
            prepared_capacity = None
            capacity_source = "computed" if transform_needs.phase_capacity else "not_needed"
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "phase_classification",
            input_rows=len(raw),
            output_rows=len(phases),
            consumed_by=("phase_output", "display_coordinate", "derivative"),
        )
        if transform_needs.phase_capacity:
            if prepared_capacity is not None:
                capacity = prepared_capacity
            else:
                with time_capacity_path.timed_stage(cell_diagnostics, "transform_phase_capacity"):
                    capacity = analysis_engine._phase_capacity(raw, phases)
        else:
            capacity = None
        capacity_consumers: list[str] = []
        if transform_needs.phase_capacity:
            if settings["view"] != "voltage_current":
                capacity_consumers.append("derivative")
            elif settings["x_axis"] in {"capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}:
                capacity_consumers.append("capacity_axis")
            if request.precision == "full" or not request.compact:
                capacity_consumers.append("full_export")
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "phase_capacity",
            input_rows=len(raw),
            output_rows=len(capacity) if capacity is not None else 0,
            consumed_by=tuple(capacity_consumers),
        )
        cell_diagnostics["phase_source"] = phase_source
        cell_diagnostics["phase_capacity_source"] = capacity_source
        with time_capacity_path.timed_stage(cell_diagnostics, "transform_capacity_metadata"):
            active_mass_mg = descriptor.active_mass_mg
            nominal_capacity_mah = descriptor.nominal_capacity_mah
            electrode_area_cm2 = descriptor.electrode_area_cm2
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "capacity_metadata",
            input_rows=len(raw),
            output_rows=1,
            consumed_by=("capacity_normalization", "trace_metadata"),
        )
        active_mass_g = active_mass_mg / 1000.0 if active_mass_mg else None
        if transform_needs.specific_capacity:
            with time_capacity_path.timed_stage(cell_diagnostics, "transform_specific_capacity"):
                capacity_g = (
                    capacity / active_mass_g
                    if capacity is not None and active_mass_g and active_mass_g > 0
                    else np.full(len(raw), np.nan)
                )
        else:
            capacity_g = None
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "specific_capacity",
            input_rows=len(raw),
            output_rows=len(capacity_g) if capacity_g is not None else 0,
            consumed_by=tuple(
                [
                    *(
                        ["derivative"]
                        if settings["view"] != "voltage_current" and settings["derivative_specific"]
                        else []
                    ),
                    *(
                        ["capacity_axis"]
                        if settings["view"] == "voltage_current" and settings["x_axis"] == "capacity_mah_g"
                        else []
                    ),
                    *( ["full_export"] if request.precision == "full" or not request.compact else []),
                ]
            ),
        )
        area_cm2 = settings["electrode_area_cm2"] or electrode_area_cm2
        if transform_needs.areal_capacity:
            with time_capacity_path.timed_stage(cell_diagnostics, "transform_areal_capacity"):
                capacity_area = (
                    capacity / area_cm2
                    if capacity is not None and area_cm2 and area_cm2 > 0
                    else np.full(len(raw), np.nan)
                )
        else:
            capacity_area = None
        analysis_engine._record_transform_profile(
            cell_diagnostics,
            "areal_capacity",
            input_rows=len(raw),
            output_rows=len(capacity_area) if capacity_area is not None else 0,
            consumed_by=tuple(
                [
                    *(
                        ["capacity_axis"]
                        if settings["view"] == "voltage_current" and settings["x_axis"] == "capacity_mah_cm2"
                        else []
                    ),
                    *( ["full_export"] if request.precision == "full" or not request.compact else []),
                ]
            ),
        )

    with time_capacity_path.timed_stage(cell_diagnostics, "derivative"):
        derivative_x, derivative_y = analysis_engine._derivative_curve(
            raw,
            phases,
            capacity,
            capacity_g,
            settings,
            cell_diagnostics,
        )
    with time_capacity_path.timed_stage(cell_diagnostics, "protocol_masking"):
        plot_mask = np.zeros(len(raw), dtype=bool)
    voltage_column = analysis_engine.canonical_cycling.VOLTAGE_QUANTITIES[settings["voltage_channel"]]
    voltage = (
        raw[voltage_column].to_numpy(dtype="float64").copy()
        if voltage_column in raw.columns
        else np.full(len(raw), np.nan)
    )
    current = (
        raw["current_ma"].to_numpy(dtype="float64").copy()
        if "current_ma" in raw.columns
        else np.full(len(raw), np.nan)
    )
    with time_capacity_path.timed_stage(cell_diagnostics, "transform_plot_array_materialization"):
        capacity = capacity.copy() if capacity is not None else None
        capacity_g = capacity_g.copy() if capacity_g is not None else None
        capacity_area = capacity_area.copy() if capacity_area is not None else None
        derivative_x = derivative_x.copy()
        derivative_y = derivative_y.copy()
        for values in (voltage, current, capacity, capacity_g, capacity_area, derivative_x, derivative_y):
            if values is not None:
                values[plot_mask] = np.nan
    analysis_engine._record_transform_profile(
        cell_diagnostics,
        "plot_array_materialization",
        input_rows=len(raw),
        output_rows=len(raw),
        consumed_by=("response_projection",),
    )
    with time_capacity_path.timed_stage(cell_diagnostics, "display_coordinate"):
        display_x = analysis_engine._time_capacity_display_x(
            raw,
            phases,
            capacity,
            capacity_g,
            capacity_area,
            settings,
        )
    configured_max = max(100, settings["max_points_per_cell"])
    if len(raw) > configured_max and not (request.precision == "full" and not request.compact):
        envelope_series = (
            [derivative_x, derivative_y]
            if settings["view"] != "voltage_current"
            else [voltage]
        )
        primary_values = derivative_y if settings["view"] != "voltage_current" else voltage
        visible_values = ~plot_mask & np.isfinite(primary_values)
        with time_capacity_path.timed_stage(cell_diagnostics, "display_downsampling"):
            take = analysis_engine._downsample_indices(
                len(raw), configured_max, visible_values, envelope_series
            )
        take = np.unique(np.concatenate((take, source_boundary_indices)))
        raw = raw.iloc[take]
        display_x = display_x[take]
        phases = np.asarray(phases)[take].tolist()
        voltage = voltage[take]
        current = current[take]
        capacity = capacity[take] if capacity is not None else None
        capacity_g = capacity_g[take] if capacity_g is not None else None
        capacity_area = capacity_area[take] if capacity_area is not None else None
        derivative_x = derivative_x[take]
        derivative_y = derivative_y[take]
        source_values = {
            key: [values[int(index)] for index in take]
            for key, values in source_values.items()
        }
        source_boundary_indices = np.flatnonzero(
            raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]
        ) + 1
    else:
        source_boundary_indices = (
            np.flatnonzero(raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]) + 1
            if "segment" in raw.columns and len(raw) > 1
            else np.array([], dtype="int64")
        )

    full_precision = request.precision == "full" or not request.compact
    is_derivative = settings["view"] != "voltage_current"
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
        "display_x": analysis_engine._jsonsafe_plot(display_x, None if full_precision else 6),
        "time_s": (
            analysis_engine._jsonsafe_plot(
                raw["time_s"].to_numpy(), None if full_precision else 3
            )
            if (not request.compact or (not is_derivative and settings["x_axis"] == "time"))
            and "time_s" in raw.columns
            else []
        ),
        "capacity_mah": (
            analysis_engine._jsonsafe_plot(capacity, None if full_precision else 6)
            if not request.compact or (not is_derivative and settings["x_axis"] == "capacity_mah")
            else []
        ),
        "capacity_mah_g": (
            analysis_engine._jsonsafe_plot(capacity_g, None if full_precision else 5)
            if not request.compact or (not is_derivative and settings["x_axis"] == "capacity_mah_g")
            else []
        ),
        "capacity_mah_cm2": (
            analysis_engine._jsonsafe_plot(capacity_area, None if full_precision else 5)
            if not request.compact or (not is_derivative and settings["x_axis"] == "capacity_mah_cm2")
            else []
        ),
        "voltage_v": (
            analysis_engine._jsonsafe_plot(voltage, None if full_precision else 5)
            if not request.compact or not is_derivative
            else []
        ),
        "current_ma": (
            analysis_engine._jsonsafe_plot(current, None if full_precision else 5)
            if not request.compact or not is_derivative
            else []
        ),
        "phase": phases,
        "status": (
            analysis_engine._textsafe(raw["status"])
            if not request.compact and "status" in raw.columns
            else []
        ),
        "derivative_x": (
            analysis_engine._jsonsafe_plot(derivative_x, None if full_precision else 7)
            if not request.compact or is_derivative
            else []
        ),
        "derivative_y": (
            analysis_engine._jsonsafe_plot(derivative_y, None if full_precision else 7)
            if not request.compact or is_derivative
            else []
        ),
        "segments": list(deepcopy(segments)),
        "source_descriptors": list(deepcopy(descriptor.source_descriptors)),
        **source_values,
        "source_boundary_indices": [int(index) for index in source_boundary_indices],
    }
    return (
        {
            "trace": trace,
            "badges": badges,
            "voltage_facts": list(descriptor.voltage_facts),
            "source_versions": list(descriptor.source_versions),
            "current_parser_versions": list(descriptor.current_parser_versions),
        },
        {"cells": [cell_diagnostics]},
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

    def load_raw(
        plan: Any,
        requested_cycles: Iterable[int],
        *,
        requested_columns: Iterable[str] | None = None,
        diagnostics: dict[str, Any] | None = None,
    ):
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
    owner_setup: dict[str, Any],
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
    worker_phase_wall_ms = (time.perf_counter() - started) * 1000.0
    backend_wall_ms = float(owner_setup["wall_ms"]) + worker_phase_wall_ms
    cpu_seconds = float(owner_setup["cpu_seconds"]) + (time.process_time() - started_cpu)
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
            "owner_setup_ms": owner_setup["wall_ms"],
            "owner_setup_cpu_seconds": owner_setup["cpu_seconds"],
            "worker_phase_wall_ms": worker_phase_wall_ms,
            "composed_backend_wall_ms": backend_wall_ms,
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
    job: ReadJob,
    request: ResolvedRequest,
    index: int,
    submitted_at: float,
) -> WholeCellPayload:
    started = time.perf_counter()
    read_payload = _materialize_read(job, submitted_at)
    result, diagnostics = _resolved_cell_result(job, read_payload, request)
    return WholeCellPayload(
        index=index,
        cell_id=job.cell_id,
        result=result,
        diagnostics=diagnostics,
        queue_ms=(started - submitted_at) * 1000.0,
        worker_wall_ms=(time.perf_counter() - started) * 1000.0,
    )


def _resolved_voltage_channels(payloads: list[WholeCellPayload]) -> dict[str, dict[str, Any]]:
    from app.services import canonical_cycling

    default_roles = {
        "voltage": "cell",
        "working_potential": "working_vs_reference",
        "counter_potential": "counter_vs_reference",
    }
    availability = {quantity: False for quantity in canonical_cycling.VOLTAGE_QUANTITIES}
    role_candidates: dict[str, set[str]] = {
        quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES
    }
    reference_candidates: dict[str, set[str | None]] = {
        quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES
    }
    for payload in payloads:
        for quantity, has_data, role, reference in payload.result.get("voltage_facts", []):
            if not has_data:
                continue
            availability[quantity] = True
            role_candidates[quantity].add(role)
            reference_candidates[quantity].add(reference)
    channels: dict[str, dict[str, Any]] = {}
    for quantity in canonical_cycling.VOLTAGE_QUANTITIES:
        candidates = role_candidates[quantity]
        role = (
            default_roles[quantity]
            if not candidates
            else next(iter(candidates))
            if len(candidates) == 1
            else canonical_cycling.MIXED_VOLTAGE_ROLE
        )
        references = reference_candidates[quantity]
        reference = (
            next(iter(references))
            if len(references) == 1 and next(iter(references)) is not None
            else None
        )
        item: dict[str, Any] = {
            "available": availability[quantity],
            "label": canonical_cycling.voltage_quantity_label(
                quantity,
                role=role,
                reference_electrode=reference,
            ),
            "role": role,
        }
        if reference is not None and role != canonical_cycling.MIXED_VOLTAGE_ROLE:
            item["reference_electrode"] = reference
        channels[quantity] = item
    return channels


def _merge_whole_cell_results(
    request: ResolvedRequest,
    payloads: list[WholeCellPayload],
) -> tuple[dict, float]:
    from app.services import analysis_engine

    started = time.perf_counter()
    ordered = sorted(payloads, key=lambda item: item.index)
    traces = [item.result["trace"] for item in ordered]
    badges = list(deepcopy(request.protocol_badges))
    for item in ordered:
        badges.extend(deepcopy(item.result.get("badges") or []))
    pinned_versions = [
        version
        for item in ordered
        for _file_hash, version in item.result.get("source_versions", [])
    ]
    current_versions = [
        version
        for item in ordered
        for version in item.result.get("current_parser_versions", [])
    ]
    configured_max = max(100, request.settings["max_points_per_cell"])
    result = {
        "computed_at": analysis_engine.now_iso(),
        "type": request.type,
        "parser_version": analysis_engine.display_parser_version(pinned_versions),
        "calc_version": request.calc_version,
        "current_parser_version": analysis_engine.display_parser_version(current_versions),
        "current_calc_version": request.current_calc_version,
        "settings": deepcopy(request.settings),
        "cell_traces": traces,
        "badges": badges,
        "voltage_channels": _resolved_voltage_channels(ordered),
        "rendering": {
            "viewport_width": request.viewport_width,
            "configured_max_points_per_cell": configured_max,
            "max_points_per_cell": configured_max,
            "total_points": sum(len(trace.get("cycle") or []) for trace in traces),
            "precision": request.precision,
            "compact": request.compact,
        },
    }
    return result, (time.perf_counter() - started) * 1000.0


def run_whole_cell_candidate(
    jobs: list[ReadJob],
    request: ResolvedRequest,
    workers: int,
    reference: dict,
    scenario: str,
    owner_setup: dict[str, Any],
) -> tuple[dict[str, Any], dict]:
    specs = [
        job for job in jobs
    ]
    rss_before = current_rss()
    started_cpu = time.process_time()
    started = time.perf_counter()
    submitted: dict[int, float] = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"spec0509-cell-{workers}") as pool:
        futures = []
        for index, job in enumerate(specs):
            submitted[index] = time.perf_counter()
            futures.append(
                pool.submit(
                    _whole_cell_task,
                    job,
                    request,
                    index,
                    submitted[index],
                )
            )
        dispatch_ms = (time.perf_counter() - started) * 1000.0
        payloads = [future.result() for future in futures]
    payloads.sort(key=lambda item: item.index)
    merged, merge_ms = _merge_whole_cell_results(request, payloads)
    serialization_ms = _serialize_result(merged)
    worker_phase_wall_ms = (time.perf_counter() - started) * 1000.0
    backend_wall_ms = float(owner_setup["wall_ms"]) + worker_phase_wall_ms
    cpu_seconds = float(owner_setup["cpu_seconds"]) + (time.process_time() - started_cpu)
    rss_after = current_rss()
    diagnostics = {"cells": [item.diagnostics["cells"][0] for item in payloads]}
    row = _measurement_row(
        candidate=f"B{workers // 2 + 2}",
        workers=workers,
        scenario=scenario,
        cells=[job.cell_id for job in jobs],
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
            "ablation": "resolved_per_cell_read_transform",
            "owner_setup_ms": owner_setup["wall_ms"],
            "owner_setup_cpu_seconds": owner_setup["cpu_seconds"],
            "worker_phase_wall_ms": worker_phase_wall_ms,
            "composed_backend_wall_ms": backend_wall_ms,
            "merge_ms": merge_ms,
            "per_cell_job_wall_ms": _min_max(item.worker_wall_ms for item in payloads),
            "per_cell_job_wall_ms_sum": sum(item.worker_wall_ms for item in payloads),
            "per_cell_read_wall_ms": _min_max(
                item.diagnostics["cells"][0].get("stages", {}).get("indexed_raw_access")
                for item in payloads
            ),
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
    baseline_by_key: dict[tuple[str, str], list[dict[str, Any]]] = {}
    read_rows: dict[str, list[dict[str, Any]]] = {"B1": [], "B2": []}
    read_by_key: dict[str, dict[tuple[str, str], list[dict[str, Any]]]] = {
        "B1": {},
        "B2": {},
    }
    whole_rows: dict[str, list[dict[str, Any]]] = {"B3": [], "B4": []}
    whole_by_key: dict[str, dict[tuple[str, str], list[dict[str, Any]]]] = {
        "B3": {},
        "B4": {},
    }
    workload_class_by_key: dict[tuple[str, str], str] = {}
    for workload in workloads:
        suite = str(workload.get("suite") or "unknown")
        key = (suite, workload["scenario"])
        if workload["scenario"].startswith("derivative-") and workload.get("cell_count", 0) >= 3:
            workload_class_by_key[key] = "derivative_multi_cell"
        elif workload.get("cell_count", 0) >= 3:
            workload_class_by_key[key] = "normal_multi_cell"
        else:
            workload_class_by_key[key] = "small_or_single_cell"
        rows = workload["samples"]
        baseline = [row for row in rows if row["candidate"] == "A0"]
        baseline_rows.extend(baseline)
        baseline_by_key.setdefault(key, []).extend(baseline)
        for candidate in read_rows:
            candidate_rows = [row for row in rows if row["candidate"] == candidate]
            read_rows[candidate].extend(candidate_rows)
            read_by_key[candidate].setdefault(key, []).extend(candidate_rows)
        for candidate in whole_rows:
            candidate_rows = [row for row in rows if row["candidate"] == candidate]
            whole_rows[candidate].extend(candidate_rows)
            whole_by_key[candidate].setdefault(key, []).extend(candidate_rows)

    def row_value(row: dict[str, Any], key: str) -> object:
        value: object = row
        for part in key.split("."):
            if not isinstance(value, dict):
                return None
            value = value.get(part)
        return value

    def paired_values(
        candidate_map: dict[tuple[str, str], list[dict[str, Any]]],
        candidate_key: str,
        baseline_key: str,
    ) -> tuple[list[float], list[float]]:
        candidates: list[float] = []
        baselines: list[float] = []
        for key, scenario_rows in candidate_map.items():
            candidate_value = _median(
                row_value(row, candidate_key)
                for row in scenario_rows
                if row.get("status") == "PASS"
            )
            baseline_value = _median(
                row_value(row, baseline_key)
                for row in baseline_by_key.get(key, [])
                if row.get("status") == "PASS"
            )
            if _finite(candidate_value) and _finite(baseline_value):
                candidates.append(float(candidate_value))
                baselines.append(float(baseline_value))
        return candidates, baselines

    read_decisions: dict[str, str] = {}
    whole_decisions: dict[str, str] = {}
    for candidate in read_rows:
        candidates, baselines = paired_values(
            read_by_key[candidate],
            "read_wall_ms",
            "stages.raw_read_decode_ms",
        )
        read_decisions[candidate] = _decision_label(candidates, baselines)
    for candidate in whole_rows:
        candidates, baselines = paired_values(
            whole_by_key[candidate],
            "backend_wall_ms",
            "backend_wall_ms",
        )
        whole_decisions[candidate] = _decision_label(candidates, baselines)

    whole_decisions_by_class: dict[str, dict[str, str]] = {}
    for class_name in ("normal_multi_cell", "derivative_multi_cell"):
        class_decisions: dict[str, str] = {}
        class_keys = {
            key for key, value in workload_class_by_key.items() if value == class_name
        }
        for candidate in whole_rows:
            class_map = {
                key: rows
                for key, rows in whole_by_key[candidate].items()
                if key in class_keys
            }
            candidates, baselines = paired_values(
                class_map,
                "backend_wall_ms",
                "backend_wall_ms",
            )
            class_decisions[candidate] = _decision_label(candidates, baselines)
        whole_decisions_by_class[class_name] = class_decisions
    for candidate in whole_decisions:
        class_labels = {
            class_decisions[candidate]
            for class_decisions in whole_decisions_by_class.values()
            if candidate in class_decisions
        }
        if len(class_labels) > 1:
            whole_decisions[candidate] = "mixed"

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

    representative_keys = (
        ("golden_fixture", "normal-6-all-capacity"),
        ("application_performance_batch", "normal-11-all-time"),
    )
    read_stage_evidence: dict[str, Any] = {}
    for candidate in read_rows:
        representatives: dict[str, Any] = {}
        for suite, scenario in representative_keys:
            key = (suite, scenario)
            candidate_value = _median(
                row.get("read_wall_ms")
                for row in read_by_key[candidate].get(key, [])
                if row.get("status") == "PASS"
            )
            baseline_value = _median(
                row.get("stages", {}).get("raw_read_decode_ms")
                for row in baseline_by_key.get(key, [])
                if row.get("status") == "PASS"
            )
            total_candidate = _median(
                row.get("backend_wall_ms")
                for row in read_by_key[candidate].get(key, [])
                if row.get("status") == "PASS"
            )
            total_baseline = _median(
                row.get("backend_wall_ms")
                for row in baseline_by_key.get(key, [])
                if row.get("status") == "PASS"
            )
            ratio = (
                float(candidate_value) / float(baseline_value)
                if _finite(candidate_value) and _finite(baseline_value) and baseline_value > 0
                else None
            )
            total_ratio = (
                float(total_candidate) / float(total_baseline)
                if _finite(total_candidate) and _finite(total_baseline) and total_baseline > 0
                else None
            )
            representatives[f"{suite}/{scenario}"] = {
                "a0_read_decode_median_ms": baseline_value,
                "candidate_read_stage_median_ms": candidate_value,
                "read_stage_ratio": ratio,
                "read_stage_change_pct": (ratio - 1.0) * 100.0 if ratio is not None else None,
                "a0_total_backend_median_ms": total_baseline,
                "candidate_total_backend_median_ms": total_candidate,
                "total_backend_ratio": total_ratio,
                "total_backend_change_pct": (
                    (total_ratio - 1.0) * 100.0 if total_ratio is not None else None
                ),
            }
        all_candidates, all_baselines = paired_values(
            read_by_key[candidate],
            "read_wall_ms",
            "stages.raw_read_decode_ms",
        )
        all_ratios = [
            candidate_value / baseline_value
            for candidate_value, baseline_value in zip(all_candidates, all_baselines)
            if baseline_value > 0
        ]
        paired_ratio = statistics.median(all_ratios) if all_ratios else None
        read_stage_evidence[candidate] = {
            "paired_median_ratio": paired_ratio,
            "paired_median_change_pct": (
                (paired_ratio - 1.0) * 100.0 if paired_ratio is not None else None
            ),
            "representative_scenarios": representatives,
            "interpretation": (
                "isolated read/decode stage only; total backend wall time is reported separately"
            ),
        }
    owner_setup_evidence: dict[str, Any] = {}
    for candidate in ("B3", "B4"):
        representatives: dict[str, Any] = {}
        for suite, scenario in (
            ("golden_fixture", "normal-6-all-capacity"),
            ("application_performance_batch", "normal-11-all-time"),
            ("golden_fixture", "derivative-6-all-dqdv"),
            ("application_performance_batch", "derivative-6-all-dqdv"),
        ):
            key = (suite, scenario)
            candidate_rows = [
                row
                for row in whole_by_key[candidate].get(key, [])
                if row.get("status") == "PASS"
            ]
            baseline_values = [
                row.get("backend_wall_ms")
                for row in baseline_by_key.get(key, [])
                if row.get("status") == "PASS"
            ]
            representatives[f"{suite}/{scenario}"] = {
                "owner_setup_median_ms": _median(row.get("owner_setup_ms") for row in candidate_rows),
                "worker_phase_median_ms": _median(row.get("worker_phase_wall_ms") for row in candidate_rows),
                "composed_candidate_total_median_ms": _median(
                    row.get("composed_backend_wall_ms") for row in candidate_rows
                ),
                "a0_total_backend_median_ms": _median(baseline_values),
            }
        owner_setup_evidence[candidate] = {
            "representative_scenarios": representatives,
            "interpretation": (
                "owner setup is paid once per request; worker phase remains separately reported"
            ),
        }
    return {
        "threshold": f"{IMPROVEMENT_THRESHOLD:.0%} median paired change",
        "read_concurrency": read_decisions,
        "whole_cell_python_threads": whole_decisions,
        "whole_cell_python_threads_by_workload": whole_decisions_by_class,
        "owner_setup_evidence": owner_setup_evidence,
        "small_job_regression": "not_acceptable" if small_regression else "acceptable",
        "dominant_residual_backend_stage": dominant,
        "dominant_stage_medians_ms": stage_medians,
        "read_stage_evidence": read_stage_evidence,
        "rust_050_10_handoff": (
            "Benchmark derivative rolling, gradient, ratio/filter and postprocess "
            "kernels separately in 050.10; derivative requests still spend "
            "approximately 140-1,252 ms in that stage across the measured one- to "
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
        jobs, request, owner_setup = prepare_resolved_jobs(
            env,
            spec,
            workload["cell_ids"],
        )
        candidate_order = (2, 4) if repetition % 2 == 0 else (4, 2)
        for workers in candidate_order:
            read_row, _ = run_read_candidate(
                env,
                spec,
                jobs,
                workers,
                reference,
                scenario=scenario,
                owner_setup=owner_setup,
            )
            samples.append(read_row)
            whole_row, _ = run_whole_cell_candidate(
                jobs,
                request,
                workers=workers,
                reference=reference,
                scenario=scenario,
                owner_setup=owner_setup,
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
            profiled = []
            for workload in workloads:
                print(f"profiling fixture/{workload['scenario']}", flush=True)
                item = profile_workload(
                    env,
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
                        for workload in app_workloads:
                            print(f"profiling application/{workload['scenario']}", flush=True)
                            item = profile_workload(
                                app_env,
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
            "worker_session_policy": "B3/B4 create or use no SQLAlchemy Session in workers; owner context resolves immutable per-Cell descriptors once",
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
