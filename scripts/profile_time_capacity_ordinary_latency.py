"""Measure the ordinary warm Time/Capacity production path for Spec 050.12.

The harness uses the committed golden fixture and, when available, a read-only
copy of the saved ``Performance analysis`` database.  It runs only the current
sequential production executor (A0), keeps five warm repetitions per workload,
and records the existing opt-in backend stage profile.  Disposable database
copies and cache-hit controls keep the user's application state unchanged.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys
import tempfile
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
    run_production_sample,
    scientific_digest,
)
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


REPETITIONS = 5
GOLDEN_CELL_ID = 101


def _median(values: list[object]) -> float | None:
    finite = [float(value) for value in values if isinstance(value, (int, float))]
    return statistics.median(finite) if finite else None


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


def profile_workload(
    env: object,
    base: dict,
    workload: dict[str, object],
    *,
    repetitions: int,
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
    _, reference = run_production_sample(
        env,
        spec,
        None,
        scenario=f"{scenario}-warmup",
    )
    samples: list[dict[str, object]] = []
    for _ in range(repetitions):
        row, _result = run_production_sample(
            env,
            spec,
            reference,
            scenario=scenario,
        )
        samples.append(row)
    if any(row.get("status") != "PASS" for row in samples):
        raise RuntimeError(f"Scientific parity failed in {scenario}")
    return {
        **{key: value for key, value in workload.items() if key != "cell_ids"},
        "cell_count": len(cell_ids),
        "repetitions": repetitions,
        "warmup": "one sequential production request, not recorded",
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
) -> tuple[list[dict[str, object]], dict[str, object]]:
    workloads = ordinary_workload_matrix(cell_ids)
    if requested:
        workloads = [item for item in workloads if item["scenario"] in requested]
    results: list[dict[str, object]] = []
    for workload in workloads:
        print(f"profiling {workload['scenario']}", flush=True)
        results.append(
            profile_workload(env, base, workload, repetitions=repetitions)
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
    suites: dict[str, list[dict[str, object]]] = {}
    controls: dict[str, dict[str, object]] = {}
    skipped: dict[str, str] = {}

    with GoldenFixtureEnvironment.create() as env:
        clone_ids = clone_golden_source_cells(env, 10)
        fixture_cells = [GOLDEN_CELL_ID, *clone_ids]
        known = {str(item["scenario"]) for item in ordinary_workload_matrix(fixture_cells)}
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
        )

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
                )
                for item in suites["application_performance_batch"]:
                    item["dataset"] = metadata

    evidence = {
        "spec": "050.12",
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
            "executor": "current sequential Python production path",
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
