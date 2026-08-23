"""Measure the ordinary warm Time/Capacity production path for Spec 050.12.

The harness uses the committed golden fixture and, when available, a read-only
copy of the saved ``Performance analysis`` database.  It runs only the current
production router/backend path, keeps bounded warm repetitions per workload,
and records an opt-in profiled twin beside each normal unprofiled miss.  The
``--s25`` mode is the Spec 050.14 route matrix. Disposable database copies and
cache-hit controls keep the user's application state unchanged.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time
from time import perf_counter
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402
from profile_time_capacity_concurrency import (  # noqa: E402
    create_application_environment,
    discover_application_dataset,
    make_spec,
    native_thread_settings,
    result_order,
    scientific_digest,
)
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


REPETITIONS = 5
GOLDEN_CELL_ID = 101


@contextmanager
def _null_context():
    yield


def _benchmark_hold_ping(delay: float) -> int:
    time.sleep(delay)
    return os.getpid()


@contextmanager
def _benchmark_worker_pool(worker_count: int):
    """Publish one warmed pool for a bounded worker-count benchmark pass."""

    from app.services import time_capacity_workers

    time_capacity_workers.shutdown_time_capacity_worker_pool()
    pool = time_capacity_workers._new_pool(worker_count)
    try:
        futures = [pool.submit(_benchmark_hold_ping, 0.25) for _ in range(worker_count)]
        pids = {future.result() for future in futures}
        if len(pids) < worker_count:
            raise RuntimeError(
                f"benchmark worker warmup acknowledged {len(pids)} of {worker_count} workers"
            )
        with time_capacity_workers._POOL_LOCK:
            time_capacity_workers._POOL = pool
            time_capacity_workers._POOL_WORKERS = worker_count
            time_capacity_workers._POOL_STATE = "ready"
        yield
    finally:
        time_capacity_workers.shutdown_time_capacity_worker_pool()


def _median(values: list[object]) -> float | None:
    finite = [float(value) for value in values if isinstance(value, (int, float))]
    return statistics.median(finite) if finite else None


def _profile_result_payload(body: dict[str, object]) -> dict:
    payload = dict(body)
    payload.pop("profiling", None)
    return payload


def run_profiled_route_sample(
    env: object,
    analysis_id: int,
    reference: dict | None,
    *,
    scenario: str,
    worker_override: int | None = None,
) -> tuple[dict[str, object], dict]:
    """Measure the complete production router boundary on a disposable cache."""

    from app.routers import analyses as analyses_router
    from app.services import analysis_cache

    from app.services import time_capacity_workers

    with tempfile.TemporaryDirectory(prefix="cellxplorer-05012-route-cache-") as root:
        cache_root = Path(root)
        with ExitStack() as stack:
            stack.enter_context(patch.object(analysis_cache, "_ROOT", cache_root))
            stack.enter_context(patch.object(analysis_cache, "_RESULTS", cache_root / "results"))
            stack.enter_context(patch.object(analysis_cache, "_ARTIFACTS", cache_root / "artifacts"))
            stack.enter_context(patch.object(analysis_cache, "_THUMBNAILS", cache_root / "thumbnails"))
            stack.enter_context(
                patch.object(analysis_cache, "_THUMBNAIL_INDEXES", cache_root / "thumbnail-index")
            )
            stack.enter_context(patch.object(analysis_cache, "_PREPARED", cache_root / "prepared"))
            stack.enter_context(patch.object(analysis_cache, "_budget_total", None))
            started = perf_counter()
            with (
                patch.object(
                    time_capacity_workers,
                    "choose_execution",
                    return_value=time_capacity_workers.ExecutionDecision(
                        "process",
                        worker_override,
                        "benchmark_worker_override",
                        **time_capacity_workers.host_resources().__dict__,
                    ),
                )
                if worker_override is not None
                else _null_context()
            ):
                response = analyses_router.compute_time_capacity_analysis(
                    analysis_id,
                    analyses_router.ComputeRequest(
                        recompute=False,
                        profile=True,
                        profile_request_id=f"050.12-route-{scenario}",
                        viewport_width=1200,
                        precision="standard",
                        compact=True,
                    ),
                    env.db,
                )
            complete_wall_ms = (perf_counter() - started) * 1000.0
    body = json.loads(response.body)
    payload = _profile_result_payload(body)
    profile = body.get("profiling") if isinstance(body.get("profiling"), dict) else {}
    if reference is None:
        reference = payload
    reference_digest = scientific_digest(reference)
    candidate_digest = scientific_digest(payload)
    reference_order = result_order(reference)
    candidate_order = result_order(payload)
    partition = profile.get("request_stages_ms") if isinstance(profile, dict) else {}
    partition_sum = (
        sum(float(value) for value in partition.values() if isinstance(value, (int, float)))
        if isinstance(partition, dict)
        else None
    )
    row: dict[str, object] = {
        "candidate": "ROUTE",
        "workers": worker_override or 1,
        "scenario": scenario,
        "cell_count": len(candidate_order),
        "selection_count": len(candidate_order),
        "backend_wall_ms": complete_wall_ms,
        "profile_backend_total_ms": profile.get("backend_total_ms"),
        "profiler_boundary_overhead_ms": (
            complete_wall_ms - float(profile["backend_total_ms"])
            if isinstance(profile.get("backend_total_ms"), (int, float))
            else None
        ),
        "request_total_ms": profile.get("request_total_ms"),
        "response_serialization_ms": profile.get("response_serialization_ms"),
        "request_partition_sum_ms": partition_sum,
        "request_partition_residual_ms": profile.get("request_residual_ms"),
        "request_stages_ms": partition,
        "request_sql": profile.get("request_sql"),
        "cache_store_stages_ms": profile.get("cache_store_stages_ms"),
        "engine_timing": profile.get("engine_timing"),
        "execution": profile.get("execution"),
        "returned_points": profile.get("returned_points"),
        "response_bytes": profile.get("response_bytes"),
        "rendering": payload.get("rendering"),
        "cell_exclusive_stages_ms": profile.get("cell_exclusive_stages_ms"),
        "cell_exclusive_partition_ms": profile.get("cell_exclusive_partition_ms"),
        "raw_read_stages_ms": profile.get("raw_read_stages_ms"),
        "scientific_parity": {
            "equal": reference_digest == candidate_digest,
            "reference_digest": reference_digest,
            "candidate_digest": candidate_digest,
            "ordering_equal": reference_order == candidate_order,
        },
        "status": "PASS"
        if reference_digest == candidate_digest and reference_order == candidate_order
        else "REJECTED",
    }
    return row, payload


def run_unprofiled_route_sample(
    env: object,
    analysis_id: int,
    reference: dict,
    *,
    scenario: str,
    worker_override: int | None = None,
) -> tuple[float, dict]:
    """Measure the same complete route miss without opt-in profiling overhead."""

    from app.routers import analyses as analyses_router
    from app.services import analysis_cache

    from app.services import time_capacity_workers

    with tempfile.TemporaryDirectory(prefix="cellxplorer-05012-route-cache-plain-") as root:
        cache_root = Path(root)
        with ExitStack() as stack:
            stack.enter_context(patch.object(analysis_cache, "_ROOT", cache_root))
            stack.enter_context(patch.object(analysis_cache, "_RESULTS", cache_root / "results"))
            stack.enter_context(patch.object(analysis_cache, "_ARTIFACTS", cache_root / "artifacts"))
            stack.enter_context(patch.object(analysis_cache, "_THUMBNAILS", cache_root / "thumbnails"))
            stack.enter_context(
                patch.object(analysis_cache, "_THUMBNAIL_INDEXES", cache_root / "thumbnail-index")
            )
            stack.enter_context(patch.object(analysis_cache, "_PREPARED", cache_root / "prepared"))
            stack.enter_context(patch.object(analysis_cache, "_budget_total", None))
            started = perf_counter()
            with (
                patch.object(
                    time_capacity_workers,
                    "choose_execution",
                    return_value=time_capacity_workers.ExecutionDecision(
                        "process",
                        worker_override,
                        "benchmark_worker_override",
                        **time_capacity_workers.host_resources().__dict__,
                    ),
                )
                if worker_override is not None
                else _null_context()
            ):
                response = analyses_router.compute_time_capacity_analysis(
                    analysis_id,
                    analyses_router.ComputeRequest(
                        recompute=False,
                        profile=False,
                        viewport_width=1200,
                        precision="standard",
                        compact=True,
                    ),
                    env.db,
                )
            wall_ms = (perf_counter() - started) * 1000.0
    payload = _profile_result_payload(json.loads(response.body))
    if scientific_digest(payload) != scientific_digest(reference) or result_order(payload) != result_order(reference):
        raise RuntimeError(f"Unprofiled scientific parity failed in {scenario}")
    return wall_ms, payload


def ordinary_workload_matrix(cell_ids: list[int]) -> list[dict[str, object]]:
    """Return the required ordinary matrix for the available Cell count."""

    counts = tuple(count for count in (1, 3, 6, 10, 11) if len(cell_ids) >= count)
    selected = {count: cell_ids[:count] for count in counts}
    workloads: list[dict[str, object]] = []

    if 1 in selected:
        workloads.append(
            {
                "scenario": "normal-1-cycles-1-3-time",
                "cell_ids": selected[1],
                "cycles": list(range(1, 4)),
                "cycle_end": 3,
                "x_axis": "time",
                "view": "voltage_current",
                "range_transition": None,
            }
        )
    for count in counts:
        workloads.append(
            {
                "scenario": f"normal-{count}-all-time",
                "cell_ids": selected[count],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "time",
                "view": "voltage_current",
                "range_transition": None,
            }
        )
    for count in counts:
        workloads.append(
            {
                "scenario": f"normal-{count}-all-capacity",
                "cell_ids": selected[count],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "capacity_mah",
                "view": "voltage_current",
                "range_transition": None,
            }
        )
    if 1 in selected:
        workloads.append(
            {
                "scenario": "range-1-cell-1-3-to-1-20-time",
                "cell_ids": selected[1],
                "cycles": list(range(1, 21)),
                "cycle_end": 20,
                "x_axis": "time",
                "view": "voltage_current",
                "range_transition": "cycles 1-3 -> 1-20",
            }
        )
    if 6 in selected:
        workloads.append(
            {
                "scenario": "range-6-cell-1-20-to-all-time",
                "cell_ids": selected[6],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "time",
                "view": "voltage_current",
                "range_transition": "cycles 1-20 -> All",
            }
        )
    return workloads


def s25_workload_matrix(cell_ids: list[int]) -> list[dict[str, object]]:
    """Return the bounded Spec 050.14 production-route workload matrix."""

    if len(cell_ids) < 6:
        return []
    return [
        {
            "scenario": "s25-1-cycles-1-3-time",
            "cell_ids": cell_ids[:1],
            "cycles": [1, 2, 3],
            "cycle_end": 3,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        },
        {
            "scenario": "s25-3-time",
            "cell_ids": cell_ids[:3],
            "cycles": [],
            "cycle_end": 48,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        },
        {
            "scenario": "s25-6-time",
            "cell_ids": cell_ids[:6],
            "cycles": [],
            "cycle_end": 48,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        },
        {
            "scenario": "s25-6-capacity",
            "cell_ids": cell_ids[:6],
            "cycles": [],
            "cycle_end": 48,
            "x_axis": "capacity_mah",
            "view": "voltage_current",
            "range_transition": None,
        },
    ]


def profile_workload(
    env: object,
    base: dict,
    workload: dict[str, object],
    *,
    repetitions: int,
    worker_count: int | None = None,
) -> dict[str, object]:
    scenario = str(workload["scenario"])
    cell_ids = list(workload["cell_ids"])
    spec = make_spec(
        base,
        cell_ids,
        list(workload["cycles"]),
        workload["cycle_end"],
        x_axis=str(workload["x_axis"]),
        view=str(workload["view"]),
    )
    from app.models import Analysis

    analysis = Analysis(title=f"050.12 route profiler {scenario}", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    pool_context = _benchmark_worker_pool(worker_count) if worker_count is not None else _null_context()
    with pool_context:
        _, reference = run_profiled_route_sample(
            env,
            analysis.id,
            None,
            scenario=f"{scenario}-warmup",
            worker_override=worker_count,
        )
        samples: list[dict[str, object]] = []
        for _ in range(repetitions):
            row, _result = run_profiled_route_sample(
                env,
                analysis.id,
                reference,
                scenario=scenario,
                worker_override=worker_count,
            )
            plain_wall_ms, _plain_result = run_unprofiled_route_sample(
                env,
                analysis.id,
                reference,
                scenario=scenario,
                worker_override=worker_count,
            )
            profiled_wall_ms = float(row["backend_wall_ms"])
            row["profiled_route_wall_ms"] = profiled_wall_ms
            row["profiling_overhead_ms"] = profiled_wall_ms - plain_wall_ms
            row["backend_wall_ms"] = plain_wall_ms
            samples.append(row)
    if any(row.get("status") != "PASS" for row in samples):
        raise RuntimeError(f"Scientific parity failed in {scenario}")
    return {
        **{key: value for key, value in workload.items() if key != "cell_ids"},
        "cell_count": len(cell_ids),
        "worker_count": worker_count or 1,
        "repetitions": repetitions,
        "warmup": "one complete router/backend request, not recorded",
        "samples": samples,
        "backend_median_ms": _median([row.get("backend_wall_ms") for row in samples]),
        "backend_range_ms": {
            "min": min(float(row["backend_wall_ms"]) for row in samples),
            "max": max(float(row["backend_wall_ms"]) for row in samples),
        },
        "reference_digest": scientific_digest(reference),
        "canonical_output_order": "original selection order",
    }


def run_cache_hit_control(env: object, base: dict, cell_ids: list[int]) -> dict[str, object]:
    """Verify exact result hits bypass compute, raw reads and workers."""

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
    analysis = Analysis(title="050.12 exact-cache control", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    with tempfile.TemporaryDirectory(prefix="cellxplorer-05012-result-cache-") as result_root:
        with patch.object(analysis_cache, "_RESULTS", Path(result_root) / "results"):
            first = analyses_router.compute_time_capacity_analysis(
                analysis.id,
                analyses_router.ComputeRequest(
                    recompute=True,
                    profile=True,
                    profile_request_id="050.12-cache-miss",
                ),
                env.db,
            )
            first_body = json.loads(first.body)
            try:
                with (
                    patch.object(
                        analysis_engine,
                        "compute_time_capacity",
                        side_effect=AssertionError("cache hit dispatched compute"),
                    ),
                    patch.object(cache, "load_raw", side_effect=AssertionError("cache hit read raw")),
                    patch.object(
                        time_capacity_path,
                        "load_indexed_time_capacity_raw",
                        side_effect=AssertionError("cache hit read indexed raw"),
                    ),
                ):
                    second = analyses_router.compute_time_capacity_analysis(
                        analysis.id,
                        analyses_router.ComputeRequest(
                            profile=True,
                            profile_request_id="050.12-cache-hit",
                        ),
                        env.db,
                    )
            except AssertionError as exc:
                return {"status": "FAIL", "reason": str(exc)}
            second_body = json.loads(second.body)
    return {
        "status": "PASS",
        "first_cache_state": first_body.get("profiling", {}).get("result_cache"),
        "hit_cache_state": second_body.get("profiling", {}).get("result_cache"),
        "hit_raw_access": second_body.get("profiling", {}).get("raw_access"),
        "scientific_payload_equal": {
            key: first_body.get(key) == second_body.get(key)
            for key in ("cell_traces", "settings", "rendering", "voltage_channels")
        },
    }


def run_suite(
    env: object,
    base: dict,
    cell_ids: list[int],
    *,
    repetitions: int,
    requested: set[str] | None = None,
    workload_builder=ordinary_workload_matrix,
    worker_count: int | None = None,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    workloads = workload_builder(cell_ids)
    if requested:
        workloads = [item for item in workloads if item["scenario"] in requested]
    results: list[dict[str, object]] = []
    for workload in workloads:
        print(f"profiling {workload['scenario']}", flush=True)
        results.append(
            profile_workload(
                env,
                base,
                workload,
                repetitions=repetitions,
                worker_count=worker_count,
            )
        )
    return results, run_cache_hit_control(env, base, cell_ids[: min(3, len(cell_ids))])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write disposable JSON evidence here")
    parser.add_argument("--repetitions", type=int, default=REPETITIONS)
    parser.add_argument(
        "--app-data-root",
        type=Path,
        default=Path.home() / ".cellxplorer",
        help="Saved application data root containing Performance analysis",
    )
    parser.add_argument("--fixture-only", action="store_true")
    parser.add_argument(
        "--s25",
        action="store_true",
        help="Run the bounded Spec 050.14 S25 production-route matrix",
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
    fixture_case = {
        "id": "time_capacity_profile",
        "kind": "time_capacity",
        "spec_path": "specs/time_capacity_baseline.json",
    }
    fixture_base = load_case_spec(fixture_root, fixture_case)
    requested = set(args.scenario or [])
    workload_builder = s25_workload_matrix if args.s25 else ordinary_workload_matrix
    suites: dict[str, list[dict[str, object]]] = {}
    controls: dict[str, dict[str, object]] = {}
    skipped: dict[str, str] = {}

    with GoldenFixtureEnvironment.create() as env:
        clone_ids = clone_golden_source_cells(env, 10)
        fixture_cells = [GOLDEN_CELL_ID, *clone_ids]
        known = {str(item["scenario"]) for item in workload_builder(fixture_cells)}
        if requested:
            unknown = requested - known
            if unknown:
                parser.error(f"unknown scenario(s): {', '.join(sorted(unknown))}")
        suites["golden_fixture"], controls["golden_fixture"] = run_suite(
            env,
            fixture_base,
            fixture_cells,
            repetitions=args.repetitions,
            requested=requested or None,
            workload_builder=workload_builder,
        )

    # The production pool binds imports and cache paths at worker spawn time.
    # This harness deliberately switches from an isolated fixture root to the
    # real application root in one interpreter, so close those workers before
    # the second disposable environment is opened.
    from app.services import time_capacity_workers

    time_capacity_workers.shutdown_time_capacity_worker_pool()

    if not args.fixture_only:
        app_root = args.app_data_root.resolve()
        if not (app_root / "cellxplorer.db").is_file():
            skipped["application_performance_batch"] = f"database not found at {app_root / 'cellxplorer.db'}"
        else:
            with create_application_environment(app_root) as app_env:
                app_base, app_cells, metadata = discover_application_dataset(app_env)
                suites["application_performance_batch"], controls["application_performance_batch"] = run_suite(
                    app_env,
                    app_base,
                    app_cells,
                    repetitions=args.repetitions,
                    requested=requested or None,
                    workload_builder=workload_builder,
                )
                for item in suites["application_performance_batch"]:
                    item["dataset"] = metadata

    evidence = {
        "spec": "050.14" if args.s25 else "050.12",
        "status": "PASS"
        if all(
            item.get("samples", [{}])[0].get("status") == "PASS"
            for items in suites.values()
            for item in items
        )
        and all(control.get("status") == "PASS" for control in controls.values())
        else "FAIL",
        "repetitions": args.repetitions,
        "request_contract": {
            "precision": "standard",
            "compact": True,
            "viewport_width": 1200,
            "executor": "complete synchronous /analyses/{id}/time-capacity router/backend path",
            "wall_boundary": "paired unprofiled direct router call from request start through final Response construction",
            "profile_boundary": "profile=True twin of each reported miss; profiling overhead is recorded separately",
            "partition_rule": "request_stages_ms are exclusive top-level scopes; engine/cell/raw detail tables are labelled separately",
        },
        "accepted_050_11_baseline_ms": {
            "application_performance_batch/normal-6-all-time": 586,
            "application_performance_batch/normal-10-all-time": 1052,
            "application_performance_batch/normal-11-all-time": 1097,
            "application_performance_batch/normal-6-all-capacity": 746,
        },
        "stage_contract": [
            "relational_selection_source_resolution",
            "index_stitch_plan",
            "indexed_raw_access",
            "row_group_io",
            "exact_cycle_filter_global_mapping_concatenation",
            "exact_cycle_filter_and_sort",
            "continuous_time_phase_capacity",
            "transform_source_provenance",
            "transform_source_boundaries",
            "transform_phase_classification",
            "transform_phase_capacity",
            "transform_plot_array_materialization",
            "display_coordinate",
            "display_downsampling",
            "display_post_downsample_materialization",
            "compact_trace_object_projection",
            "raw_index_plan_validation",
            "raw_index_read_validation",
            "raw_parquet_footer_schema",
            "raw_row_group_decode_arrow_to_pandas",
            "raw_exact_cycle_filter",
            "raw_record_index_sort",
            "raw_cycle_mapping",
            "raw_frame_concat",
            "analysis_lookup",
            "canonical_capability_guard",
            "source_data_signature",
            "render_result_key",
            "result_cache_body_lookup",
            "result_cache_legacy_lookup",
            "engine_compute",
            "compute_request_setup",
            "result_cache_persistence",
            "request_profile_finalization",
            "response_preparation_serialization",
            "response_object_construction",
            "response_profile_patch_and_body_assignment",
            "response_serialization_ms (profiled child of response preparation)",
            "cache_store_json_encode",
            "cache_store_gzip_compress",
            "cache_store_atomic_write_replace",
            "cache_store_sidecar_write",
            "cache_store_sidecar_prune",
        ],
        "suites": suites,
        "exact_cache_controls": controls,
        "skipped_suites": skipped,
        "frontend": {
            "status": "NOT RUN",
            "reason": "This backend harness does not claim installed-browser or Plotly completion timing; the existing 050.4 profiler remains the frontend/manual gate.",
        },
        "native_thread_settings": native_thread_settings(),
    }
    rendered = json.dumps(evidence, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "spec": evidence["spec"],
                "status": evidence["status"],
                "suites": {key: len(value) for key, value in suites.items()},
                "repetitions": args.repetitions,
                "output": str(args.output) if args.output else None,
            },
            indent=2,
        )
    )
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
