"""Profile the Spec 050.16 cross-family analysis production boundary.

The profiler deliberately calls the real analysis routers.  It uses the
committed golden sources in a disposable database/cache and clones one
source-local Cell only for the representative six-Cell workload.  Clones are
content-identical copies of an existing fixture source, so they exercise
selection, cache identity, raw access, extraction, persistence, and response
scaling without inventing a protocol.

Each invocation uses three warm repetitions for every family/workload.  The
output is a diagnostic artifact, not a scientific approval record.
"""
from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
from concurrent.futures import ProcessPoolExecutor
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import sqlite3
import tempfile
from time import perf_counter
from typing import Any, Callable
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402


REPETITIONS = 3
FAMILY_CASES = {
    "steps": ("steps_baseline", 101),
    "dcir": ("dcir_baseline", 102),
    "chargeability": ("chargeability_baseline", 103),
    "rate_capability": ("rate_capability_baseline", 103),
}


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def _projection(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _projection(item)
            for key, item in value.items()
            if key not in {"computed_at", "cache_status", "data_signature"}
        }
    if isinstance(value, list):
        return [_projection(item) for item in value]
    return value


def _digest(value: Any) -> str:
    body = json.dumps(
        _projection(value),
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _series_order(value: dict[str, Any]) -> list[tuple[int, str | None]]:
    traces = value.get("cell_series") or []
    return [
        (int(item["cell_id"]), item.get("series_id"))
        for item in traces
        if isinstance(item, dict) and item.get("cell_id") is not None
    ]


def _case(manifest: dict[str, Any], case_id: str) -> dict[str, Any]:
    for case in manifest.get("cases") or []:
        if case.get("id") == case_id:
            return case
    raise RuntimeError(f"Golden fixture case not found: {case_id}")


def _clone_cells(env: GoldenFixtureEnvironment, family: str, source_cell_id: int, count: int) -> list[int]:
    """Create source-identical, source-distinct Cells for scale measurement."""

    from app.models import Cell, CellMetadata, SourceFile, Test, TestFile
    from app.services import analysis_engine, cache, parsing

    source_cell = env.db.get(Cell, source_cell_id)
    if source_cell is None:
        raise RuntimeError(f"Golden source Cell {source_cell_id} not found")
    analysis_engine.preload_cell_sources(env.db, [source_cell])
    _hashes, files = analysis_engine.cell_ordered_hashes(env.db, source_cell)
    if len(files) != 1:
        raise RuntimeError(f"Expected one source for cloned fixture Cell {source_cell_id}")
    source = files[0]
    parser_version = parsing.current_parser_identity_for_extension(source.ext) or source.parser_version
    if not parser_version:
        raise RuntimeError(f"No parser identity for fixture source {source.filename}")
    raw = cache.load_raw(source.hash, parser_version)
    if raw is None:
        raise RuntimeError(f"Raw fixture cache unavailable for {source.filename}")

    clone_ids = [source_cell_id]
    scalar_values = {
        entry.key: entry.value
        for entry in source_cell.metadata_entries
        if entry.key in {
            "active_material_mg",
            "active_mass_mg",
            "nominal_capacity_mah",
            "nominal_capacity",
            "electrode_area_cm2",
        }
    }
    for index in range(1, count):
        cell = Cell(name=f"050.16-{family}-fixture-cell-{index + 1}")
        env.db.add(cell)
        env.db.flush()
        for key, value in scalar_values.items():
            env.db.add(CellMetadata(cell_id=cell.id, key=key, value=str(value)))

        clone_hash = hashlib.sha256(
            f"cellxplorer-050.16:{family}:{source_cell_id}:{index}".encode("utf-8")
        ).hexdigest()
        clone_source = SourceFile(
            hash=clone_hash,
            path=clone_hash,
            filename=f"050.16-{family}-{index + 1}.ndax",
            size=source.size,
            ext=source.ext,
            header_meta=deepcopy(source.header_meta),
            nominal_capacity_mah=source.nominal_capacity_mah,
            row_count=source.row_count,
            cycle_count=source.cycle_count,
            parse_status="parsed",
            parser_version=parser_version,
        )
        env.db.add(clone_source)
        env.db.flush()
        cache._publish_optimized_raw(
            raw.copy(deep=True),
            cache.raw_path(clone_hash, parser_version),
            parser_version,
        )
        test = Test(cell_id=cell.id, name=f"050.16-{family}-fixture-test-{index + 1}")
        env.db.add(test)
        env.db.flush()
        env.db.add(TestFile(test_id=test.id, file_id=clone_source.id, position=0))
        clone_ids.append(cell.id)
    env.db.commit()
    return clone_ids


def _scaled_spec(base: dict[str, Any], family: str, cell_ids: list[int]) -> dict[str, Any]:
    spec = deepcopy(base)
    spec.setdefault("selection", {})["entries"] = [
        {"kind": "cell", "ref_id": cell_id} for cell_id in cell_ids
    ]
    computation = spec.setdefault("computation", {})
    if family == "steps":
        configured = computation.setdefault("steps", {}).get("series") or []
        templates = [item for item in configured if isinstance(item, dict)]
        series: list[dict[str, Any]] = []
        for cell_id in cell_ids:
            for index, template in enumerate(templates):
                item = deepcopy(template)
                item["cell_id"] = cell_id
                item["id"] = f"050.16-steps-{cell_id}-{index}"
                series.append(item)
        computation["steps"]["series"] = series
    elif family == "dcir":
        configured = computation.setdefault("dcir", {}).get("series") or []
        templates = [item for item in configured if isinstance(item, dict)]
        series = []
        for cell_id in cell_ids:
            for index, template in enumerate(templates):
                item = deepcopy(template)
                item["cell_id"] = cell_id
                item["id"] = f"050.16-dcir-{cell_id}-{index}"
                series.append(item)
        computation["dcir"]["series"] = series
    return spec


def _route_for(family: str) -> Callable[..., Any]:
    from app.routers import analyses

    return {
        "steps": analyses.compute_steps_analysis,
        "dcir": analyses.compute_dcir_analysis,
        "chargeability": analyses.compute_chargeability_analysis,
        "rate_capability": analyses.compute_rate_capability_analysis,
    }[family]


def _process_control_worker(descriptor: dict[str, Any]) -> dict[str, Any]:
    """Run one Cell using only an immutable descriptor and JSON result facts."""

    os.environ["CELLXPLORER_DATA"] = str(descriptor["data_root"])
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.services import analysis_engine, chargeability, rate_capability

    engine = create_engine(
        f"sqlite:///{Path(descriptor['db_path']).as_posix()}",
        connect_args={"check_same_thread": False},
    )
    db = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    try:
        family = descriptor["family"]
        spec = descriptor["spec"]
        started = perf_counter()
        if family == "steps":
            result = analysis_engine.compute_steps(db, spec, None)
        elif family == "dcir":
            result = analysis_engine.compute_dcir(db, spec, None)
        elif family == "chargeability":
            result = chargeability.compute(db, spec, None)
        else:
            result = rate_capability.compute(db, spec, None)
        elapsed_ms = (perf_counter() - started) * 1000.0
        return {
            "cell_id": descriptor["cell_id"],
            "elapsed_ms": elapsed_ms,
            "digest": _digest(result),
        }
    finally:
        db.close()
        engine.dispose()


def _file_backed_db(env: GoldenFixtureEnvironment, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    destination = sqlite3.connect(target)
    source_connection = env.db.get_bind().raw_connection()
    try:
        source_driver = getattr(source_connection, "driver_connection", source_connection)
        source_driver.backup(destination)
    finally:
        source_connection.close()
        destination.close()


def _process_control(
    env: GoldenFixtureEnvironment,
    family: str,
    *,
    count: int = 6,
) -> dict[str, Any]:
    """Measure serial versus disposable 2/4-process Cell controls."""

    _analysis_id, cell_ids = _family_workload(env, family, count=count)
    case_id, _source_cell_id = FAMILY_CASES[family]
    base_spec = load_case_spec(env.root, _case(env.manifest, case_id))
    with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05016-{family}-process-") as root:
        db_path = Path(root) / "control.sqlite"
        _file_backed_db(env, db_path)
        descriptors = [
            {
                "family": family,
                "cell_id": cell_id,
                "spec": _scaled_spec(base_spec, family, [cell_id]),
                "db_path": str(db_path),
                "data_root": str(env.data_root),
            }
            for cell_id in cell_ids
        ]
        serial_started = perf_counter()
        serial_results = [_process_control_worker(item) for item in descriptors]
        serial_wall_ms = (perf_counter() - serial_started) * 1000.0
        controls: dict[str, Any] = {
            "cell_count": count,
            "serial_wall_ms": serial_wall_ms,
            "serial_scientific_ms": sum(item["elapsed_ms"] for item in serial_results),
            "controls": {},
            "serial_digests": [item["digest"] for item in serial_results],
        }
        for workers in (2, 4):
            started = perf_counter()
            with ProcessPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(_process_control_worker, descriptors))
            wall_ms = (perf_counter() - started) * 1000.0
            controls["controls"][str(workers)] = {
                "wall_ms": wall_ms,
                "worker_scientific_ms": sum(item["elapsed_ms"] for item in results),
                "speedup_vs_serial_wall": serial_wall_ms / wall_ms if wall_ms else None,
                "scientific_parity": [
                    result["digest"] == serial["digest"]
                    for result, serial in zip(results, serial_results)
                ],
            }
        return controls


def _profile_call(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    family: str,
    *,
    recompute: bool,
    cache_root: Path,
    force_full_raw: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Call one real route and collect coarse production-boundary timings."""

    from app.routers import analyses
    from app.services import analysis_cache, analysis_engine, cache, chargeability, rate_capability, stitch

    metrics: dict[str, Any] = {
        "calls": {},
        "stages_ms": {},
        "raw_rows_loaded": 0,
        "raw_rows_returned": 0,
        "raw_rows_read_physical": 0,
        "raw_row_groups_read": 0,
        "raw_load_calls": 0,
        "body_bytes": 0,
    }

    def timed(name: str, original: Callable[..., Any], *, observe: Callable[[Any], None] | None = None) -> Callable[..., Any]:
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            started = perf_counter()
            result = original(*args, **kwargs)
            elapsed = (perf_counter() - started) * 1000.0
            metrics["stages_ms"][name] = metrics["stages_ms"].get(name, 0.0) + elapsed
            metrics["calls"][name] = metrics["calls"].get(name, 0) + 1
            if observe is not None:
                observe(result)
            return result

        return wrapped

    def observe_raw(result: Any) -> None:
        if result is not None:
            metrics["raw_load_calls"] += 1
            metrics["raw_rows_loaded"] += len(result)

    def observe_stitched(result: Any) -> None:
        if isinstance(result, tuple) and result and result[0] is not None:
            metrics["raw_rows_stitched"] = metrics.get("raw_rows_stitched", 0) + len(result[0])

    def observe_step(result: Any) -> None:
        if result is not None:
            metrics["raw_load_calls"] += 1
            metrics["raw_rows_returned"] += len(result)
            metrics["raw_rows_loaded"] += len(result)
            metrics["raw_rows_read_physical"] += int(result.attrs.get("_raw_step_rows_read") or 0)
            metrics["raw_row_groups_read"] += len(result.attrs.get("_raw_step_row_groups") or ())

    engine_compute_name = {
        "steps": "engine_compute_steps",
        "dcir": "engine_compute_dcir",
        "chargeability": "chargeability_compute",
        "rate_capability": "rate_capability_compute",
    }[family]
    compute_module, compute_attr = (
        (analysis_engine, "compute_steps")
        if family == "steps"
        else (analysis_engine, "compute_dcir")
        if family == "dcir"
        else (chargeability, "compute")
        if family == "chargeability"
        else (rate_capability, "compute")
    )

    route = _route_for(family)
    request = analyses.ComputeRequest(recompute=recompute)
    with ExitStack() as stack:
        stack.enter_context(patch.object(analysis_cache, "_ROOT", cache_root))
        stack.enter_context(patch.object(analysis_cache, "_RESULTS", cache_root / "results"))
        stack.enter_context(patch.object(analysis_cache, "_ARTIFACTS", cache_root / "artifacts"))
        stack.enter_context(patch.object(analysis_cache, "_THUMBNAILS", cache_root / "thumbnails"))
        stack.enter_context(patch.object(analysis_cache, "_THUMBNAIL_INDEXES", cache_root / "thumbnail-index"))
        stack.enter_context(patch.object(analysis_cache, "_PREPARED", cache_root / "prepared"))
        stack.enter_context(patch.object(analysis_cache, "_budget_total", None))
        stack.enter_context(patch.object(
            analysis_cache,
            "result_key",
            timed("owner_cache_key_setup", analysis_cache.result_key),
        ))
        stack.enter_context(patch.object(
            analysis_engine,
            "resolve_selection",
            timed("selection_resolution", analysis_engine.resolve_selection),
        ))
        stack.enter_context(patch.object(
            analysis_engine,
            "preload_cell_sources",
            timed("source_relationship_preload", analysis_engine.preload_cell_sources),
        ))
        stack.enter_context(patch.object(
            analysis_engine,
            "load_scalar_metadata",
            timed("scalar_metadata_resolution", analysis_engine.load_scalar_metadata),
        ))
        stack.enter_context(patch.object(
            analysis_engine,
            "cell_ordered_hashes",
            timed("ordered_source_resolution", analysis_engine.cell_ordered_hashes),
        ))
        stack.enter_context(patch.object(
            analysis_engine,
            "resolve_source_parser_versions",
            timed("parser_identity_resolution", analysis_engine.resolve_source_parser_versions),
        ))
        stack.enter_context(patch.object(
            cache,
            "load_raw",
            timed("raw_cache_read", cache.load_raw, observe=observe_raw),
        ))
        stack.enter_context(patch.object(
            cache,
            "load_raw_step_rows",
            timed("selective_raw_cache_read", cache.load_raw_step_rows, observe=observe_step),
        ))
        stack.enter_context(patch.object(
            stitch,
            "stitch_raw",
            timed("raw_materialization", stitch.stitch_raw, observe=observe_stitched),
        ))
        if force_full_raw:
            stack.enter_context(
                patch.object(stitch, "stitch_raw_steps", return_value=None)
            )
        else:
            stack.enter_context(patch.object(
                stitch,
                "stitch_raw_steps",
                timed("selective_raw_materialization", stitch.stitch_raw_steps, observe=observe_stitched),
            ))
        stack.enter_context(patch.object(
            compute_module,
            compute_attr,
            timed(engine_compute_name, getattr(compute_module, compute_attr)),
        ))
        stack.enter_context(patch.object(
            analysis_cache,
            "store_result",
            timed("cache_persistence", analysis_cache.store_result),
        ))
        stack.enter_context(patch.object(
            analyses,
            "fast_json",
            timed("response_serialization", analyses.fast_json),
        ))
        started = perf_counter()
        response = route(analysis_id, request, env.db)
        metrics["complete_route_ms"] = (perf_counter() - started) * 1000.0
        metrics["body_bytes"] = len(response.body or b"")

    payload = json.loads(response.body)
    metrics["cache_status"] = payload.get("cache_status")
    metrics["data_signature"] = payload.get("data_signature")
    metrics["scientific_digest"] = _digest(payload)
    metrics["series_order"] = _series_order(payload)
    return payload, metrics


def _family_workload(
    env: GoldenFixtureEnvironment,
    family: str,
    *,
    count: int,
) -> tuple[int, list[int]]:
    case_id, source_cell_id = FAMILY_CASES[family]
    case = _case(env.manifest, case_id)
    spec = _scaled_spec(load_case_spec(env.root, case), family, [source_cell_id])
    if count > 1:
        cell_ids = _clone_cells(env, family, source_cell_id, count)
        spec = _scaled_spec(load_case_spec(env.root, case), family, cell_ids)
    else:
        cell_ids = [source_cell_id]
    from app.models import Analysis

    analysis = Analysis(title=f"050.16 profiler {family} {count}", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    return analysis.id, cell_ids


def _run_workload(
    env: GoldenFixtureEnvironment,
    family: str,
    count: int,
    *,
    force_full_raw: bool = False,
) -> dict[str, Any]:
    analysis_id, cell_ids = _family_workload(env, family, count=count)
    miss_samples: list[dict[str, Any]] = []
    hit_samples: list[dict[str, Any]] = []
    parity: list[bool] = []

    for repetition in range(REPETITIONS):
        with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05016-{family}-miss-") as root:
            cache_root = Path(root)
            miss_payload, miss = _profile_call(
                env,
                analysis_id,
                family,
                recompute=True,
                cache_root=cache_root,
                force_full_raw=force_full_raw,
            )
            miss["repetition"] = repetition + 1
            miss_samples.append(miss)

        with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05016-{family}-hit-") as root:
            cache_root = Path(root)
            warm_payload, _warm = _profile_call(
                env,
                analysis_id,
                family,
                recompute=False,
                cache_root=cache_root,
                force_full_raw=force_full_raw,
            )
            hit_payload, hit = _profile_call(
                env,
                analysis_id,
                family,
                recompute=False,
                cache_root=cache_root,
                force_full_raw=force_full_raw,
            )
            hit["repetition"] = repetition + 1
            hit_samples.append(hit)
            parity.append(
                _digest(warm_payload) == _digest(hit_payload)
                and _series_order(warm_payload) == _series_order(hit_payload)
            )

    def summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "p50_complete_route_ms": _median([float(item["complete_route_ms"]) for item in samples]),
            "p50_result_bytes": _median([float(item["body_bytes"]) for item in samples]),
            "p50_raw_rows_loaded": _median([float(item.get("raw_rows_loaded", 0)) for item in samples]),
            "p50_raw_rows_returned": _median([float(item.get("raw_rows_returned", 0)) for item in samples]),
            "p50_raw_rows_read_physical": _median([float(item.get("raw_rows_read_physical", 0)) for item in samples]),
            "p50_raw_row_groups_read": _median([float(item.get("raw_row_groups_read", 0)) for item in samples]),
            "p50_raw_rows_stitched": _median([float(item.get("raw_rows_stitched", 0)) for item in samples]),
            "p50_stages_ms": {
                name: _median([
                    float(item.get("stages_ms", {}).get(name, 0.0))
                    for item in samples
                ])
                for name in sorted({
                    name
                    for item in samples
                    for name in item.get("stages_ms", {})
                })
            },
            "samples": samples,
        }

    return {
        "family": family,
        "cell_count": len(cell_ids),
        "cell_ids": cell_ids,
        "raw_mode": "full_legacy_control" if force_full_raw else "selective_if_available",
        "forced_miss": summary(miss_samples),
        "exact_persisted_hit": summary(hit_samples),
        "miss_to_hit_scientific_order_parity": all(parity),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--families",
        nargs="+",
        choices=sorted(FAMILY_CASES),
        default=sorted(FAMILY_CASES),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--force-full-raw",
        action="store_true",
        help="Force the current full-raw path for the Steps/DCIR control.",
    )
    parser.add_argument(
        "--process-control",
        action="store_true",
        help="Also measure disposable serial/2/4-process Cell controls.",
    )
    parser.add_argument(
        "--process-control-only",
        action="store_true",
        help="Skip route workloads and emit only the process controls.",
    )
    args = parser.parse_args()

    started = perf_counter()
    with GoldenFixtureEnvironment.create() as env:
        workloads: list[dict[str, Any]] = []
        if not args.process_control_only:
            for family in args.families:
                workloads.append(
                    _run_workload(env, family, 1, force_full_raw=args.force_full_raw)
                )
                workloads.append(
                    _run_workload(env, family, 6, force_full_raw=args.force_full_raw)
                )
        result = {
            "spec": "050.16",
            "fixture": str(env.root),
            "repetitions": REPETITIONS,
            "elapsed_ms": (perf_counter() - started) * 1000.0,
            "workloads": workloads,
        }
        if args.process_control:
            result["process_controls"] = {
                family: _process_control(env, family)
                for family in args.families
            }

    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
