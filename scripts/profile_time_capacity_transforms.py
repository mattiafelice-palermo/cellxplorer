"""Profile the 050.5 Time/Capacity transform and cache boundaries.

This is an isolated, diagnostic-only harness.  It uses the committed golden
source in a temporary CellXplorer database, creates disposable Cell records
for the multi-Cell matrix, and never touches the user's application data.
It does not implement or enable a derived-data cache.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402


REPETITIONS = 5
GOLDEN_CELL_ID = 101
MATRIX_RANGES = (
    ("1", list(range(1, 2)), 1),
    ("1-20", list(range(1, 21)), 20),
    ("1-150", list(range(1, 151)), 150),
    ("all", [], None),
)


def _is_finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def derivative_frontend_trace_count(result: dict) -> int:
    """Mirror the frontend's cycle/phase trace grouping for dQ/dV/dV/dQ."""

    count = 0
    for trace in result.get("cell_traces", []):
        if trace.get("excluded"):
            continue
        x_values = trace.get("derivative_x") or []
        y_values = trace.get("derivative_y") or []
        cycles = trace.get("cycle") or []
        phases = trace.get("phase") or []
        start = 0
        while start < len(x_values):
            cycle = cycles[start] if start < len(cycles) else None
            phase = phases[start] if start < len(phases) else None
            end = start + 1
            while end < len(x_values):
                next_cycle = cycles[end] if end < len(cycles) else None
                next_phase = phases[end] if end < len(phases) else None
                if next_cycle != cycle or next_phase != phase:
                    break
                end += 1
            if any(_is_finite(value) for value in x_values[start:end]) and any(
                _is_finite(value) for value in y_values[start:end]
            ):
                count += 1
            start = end
    return count


def _range_settings(settings: dict, cycles: list[int], cycle_end: int | None) -> None:
    settings["cycles"] = cycles
    settings["cycle_start"] = 1
    settings["cycle_end"] = cycle_end
    settings["max_points_per_cell"] = 4000


def make_spec(base: dict, cell_ids: list[int], cycles: list[int], cycle_end: int | None, *, x_axis: str = "time", view: str = "voltage_current") -> dict:
    spec = deepcopy(base)
    spec["selection"]["entries"] = [
        {"kind": "cell", "ref_id": cell_id}
        for cell_id in cell_ids
    ]
    settings = spec["computation"]["time_capacity"]
    _range_settings(settings, cycles, cycle_end)
    settings["x_axis"] = x_axis
    settings["view"] = view
    if view != "voltage_current":
        settings["derivative_phase"] = "both"
        settings["derivative_specific"] = False
        settings["smoothing_window"] = 7
    return spec


def _median_numeric(samples: list[dict], key: str) -> float | int | None:
    values = [sample[key] for sample in samples if _is_finite(sample.get(key))]
    if not values:
        return None
    value = statistics.median(values)
    return int(value) if all(isinstance(item, int) for item in values) else float(value)


def summarize_sample(
    result: dict,
    profile: dict,
    diagnostics: dict,
    *,
    elapsed_ms: float,
    cells: int,
    scenario: str,
    x_axis: str,
    view: str,
) -> dict:
    stages = profile.get("backend_stages_ms") or {}
    transforms = profile.get("transform_stages") or {}
    derivative = profile.get("derivative_profile") or {}
    return {
        "scenario": scenario,
        "cells": cells,
        "x_axis": x_axis,
        "view": view,
        "result_cache": "miss",
        "raw_access": profile.get("raw_access"),
        "selected_rows": profile.get("selected_rows_before_transforms"),
        "raw_rows_materialized": profile.get("raw_rows_materialized"),
        "row_groups_read": profile.get("row_groups_read"),
        "row_groups_total": profile.get("row_groups_total"),
        "returned_points": profile.get("returned_points"),
        "backend_total_ms": elapsed_ms,
        "stages_ms": {
            "indexed_io": stages.get("indexed_raw_access"),
            "continuous_time_phase_capacity": stages.get("continuous_time_phase_capacity"),
            "display_coordinate": stages.get("display_coordinate"),
            "display_downsampling": stages.get("display_downsampling"),
            "transform_continuous_time": transforms.get("continuous_time", {}).get("elapsed_ms"),
            "transform_phase": transforms.get("phase_classification", {}).get("elapsed_ms"),
            "transform_phase_capacity": transforms.get("phase_capacity", {}).get("elapsed_ms"),
            "transform_specific_capacity": transforms.get("specific_capacity", {}).get("elapsed_ms"),
            "transform_areal_capacity": transforms.get("areal_capacity", {}).get("elapsed_ms"),
            "transform_materialization": transforms.get("plot_array_materialization", {}).get("elapsed_ms"),
            "derivative": stages.get("derivative"),
            "derivative_segment_scan": derivative.get("stages_ms", {}).get("segment_scan"),
            "derivative_segment_prepare": derivative.get("stages_ms", {}).get("segment_prepare"),
            "derivative_rolling": derivative.get("stages_ms", {}).get("rolling"),
            "derivative_gradient": derivative.get("stages_ms", {}).get("gradient"),
            "derivative_ratio_filter": derivative.get("stages_ms", {}).get("ratio_filter"),
            "derivative_postprocess": derivative.get("stages_ms", {}).get("postprocess"),
        },
        "transform_consumers": {
            name: details.get("consumed_by", [])
            for name, details in transforms.items()
        },
        "derivative_counts": {
            key: derivative.get(key)
            for key in (
                "cells",
                "input_rows",
                "segments_processed",
                "eligible_segments",
                "finite_input_rows",
                "output_finite_rows",
                "output_segments",
                "phase_rows",
            )
            if key in derivative
        },
        "frontend_trace_count": derivative_frontend_trace_count(result) if view != "voltage_current" else None,
        "diagnostic_cell_count": len(diagnostics.get("cells", [])),
    }


def run_engine_sample(engine, env, spec: dict, *, scenario: str, x_axis: str, view: str, cells: int) -> dict:
    diagnostics: dict = {}
    started = time.perf_counter()
    result = engine.compute_time_capacity(
        env.db,
        spec,
        None,
        viewport_width=1200,
        precision="standard",
        compact=True,
        access_diagnostics=diagnostics,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    from app.services.time_capacity_profiling import build_time_capacity_profile

    profile = build_time_capacity_profile(
        request_id=f"050.5-{scenario}",
        result_cache="miss",
        diagnostics=diagnostics,
        result=result,
    )
    return summarize_sample(
        result,
        profile,
        diagnostics,
        elapsed_ms=elapsed_ms,
        cells=cells,
        scenario=scenario,
        x_axis=x_axis,
        view=view,
    )


def run_repetitions(engine, env, base: dict, cell_ids: list[int], cycles: list[int], cycle_end: int | None, *, x_axis: str, view: str, label: str) -> dict:
    samples = [
        run_engine_sample(
            engine,
            env,
            make_spec(base, cell_ids, cycles, cycle_end, x_axis=x_axis, view=view),
            scenario=label,
            x_axis=x_axis,
            view=view,
            cells=len(cell_ids),
        )
        for _ in range(REPETITIONS)
    ]
    numeric_keys = {
        key
        for key, value in samples[0].items()
        if _is_finite(value)
    }
    median = {
        key: _median_numeric(samples, key)
        for key in numeric_keys
    }
    stage_names = set().union(*(sample.get("stages_ms", {}).keys() for sample in samples))
    median["stages_ms"] = {
        name: statistics.median(
            sample["stages_ms"][name]
            for sample in samples
            if _is_finite(sample.get("stages_ms", {}).get(name))
        )
        if any(_is_finite(sample.get("stages_ms", {}).get(name)) for sample in samples)
        else None
        for name in sorted(stage_names)
    }
    median["transform_consumers"] = samples[0]["transform_consumers"]
    median["derivative_counts"] = samples[0]["derivative_counts"]
    median["result_cache"] = "miss"
    median["raw_access"] = samples[0]["raw_access"]
    return {
        "scenario": label,
        "cells": len(cell_ids),
        "x_axis": x_axis,
        "view": view,
        "repetitions": REPETITIONS,
        "median": median,
        "min_backend_total_ms": min(sample["backend_total_ms"] for sample in samples),
        "max_backend_total_ms": max(sample["backend_total_ms"] for sample in samples),
        "samples": samples,
    }


def clone_golden_source_cells(env, count: int) -> list[int]:
    from app.models import Cell, CellMetadata, SourceFile, Test, TestFile
    from app.services import cache

    source = env.db.query(SourceFile).filter(SourceFile.hash == env.manifest["sources"][0]["sha256"]).one()
    parser_version = source.parser_version
    raw = cache.load_raw(source.hash, parser_version)
    if raw is None:
        raise RuntimeError("Golden source raw cache was not available for clone profiling")
    clone_ids: list[int] = []
    for index in range(count):
        cell = Cell(name=f"050.5-disposable-cell-{index + 1}")
        env.db.add(cell)
        env.db.flush()
        env.db.add(CellMetadata(cell_id=cell.id, key="active_mass_mg", value="328.62"))
        clone_hash = f"{0xD0 + index:02x}" * 32
        clone_source = SourceFile(
            hash=clone_hash,
            path=clone_hash,
            filename=f"050.5-disposable-{index + 1}.ndax",
            size=source.size,
            ext="ndax",
            parse_status="parsed",
            parser_version=parser_version,
            header_meta=deepcopy(source.header_meta),
            nominal_capacity_mah=source.nominal_capacity_mah,
            row_count=source.row_count,
            cycle_count=source.cycle_count,
        )
        env.db.add(clone_source)
        env.db.flush()
        cache._publish_optimized_raw(raw.copy(deep=True), cache.raw_path(clone_hash, parser_version), parser_version)
        test = Test(cell_id=cell.id, name=f"050.5-disposable-test-{index + 1}")
        env.db.add(test)
        env.db.flush()
        env.db.add(TestFile(test_id=test.id, file_id=clone_source.id, position=0))
        clone_ids.append(cell.id)
    env.db.commit()
    return clone_ids


def run_cache_probe(env, base: dict, cell_id: int) -> dict:
    from app.models import Analysis
    from app.routers import analyses as analyses_router

    spec = make_spec(base, [cell_id], list(range(1, 21)), 20)
    analysis = Analysis(title="050.5 persisted cache probe", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    results: list[dict] = []
    bodies: list[dict] = []
    for attempt in range(1, 7):
        request = analyses_router.ComputeRequest(
            precision="standard",
            compact=True,
            profile=True,
            profile_request_id=f"050.5-cache-{attempt}",
        )
        started = time.perf_counter()
        response = analyses_router.compute_time_capacity_analysis(analysis.id, request, env.db)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        body = json.loads(response.body)
        profile = body["profiling"]
        bodies.append(body)
        results.append(
            {
                "attempt": attempt,
                "cache_state": profile["result_cache"],
                "raw_access": profile["raw_access"],
                "route_elapsed_ms": elapsed_ms,
                "backend_total_ms": profile.get("backend_total_ms"),
                "backend_compute_ms": profile.get("backend_compute_ms"),
                "response_bytes": profile.get("response_bytes"),
                "route_minus_profile_ms": elapsed_ms - float(profile.get("backend_total_ms") or 0),
            }
        )
    first = {key: value for key, value in bodies[0].items() if key not in {"profiling", "cache_status"}}
    cache_bodies_equal = all(
        {key: value for key, value in body.items() if key not in {"profiling", "cache_status"}} == first
        for body in bodies[1:]
    )
    return {
        "request_contract": {
            "precision": "standard",
            "compact": True,
            "viewport_width": 1200,
            "react_query_bypassed": True,
        },
        "first_call": results[0],
        "persisted_hit_repetitions": results[1:],
        "scientific_payload_identical": cache_bodies_equal,
        "hit_gap_summary_ms": {
            "median_route_minus_profile": statistics.median(item["route_minus_profile_ms"] for item in results[1:]),
            "min_route_minus_profile": min(item["route_minus_profile_ms"] for item in results[1:]),
            "max_route_minus_profile": max(item["route_minus_profile_ms"] for item in results[1:]),
        },
    }


def run_route_gap_probe(env, base: dict, cell_ids: list[int]) -> dict:
    """Repeat the representative multi-Cell miss with persisted-cache bypass."""

    from app.models import Analysis
    from app.routers import analyses as analyses_router

    spec = make_spec(base, cell_ids, list(range(1, 21)), 20)
    analysis = Analysis(title="050.5 controlled route-gap probe", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    results: list[dict] = []
    for attempt in range(1, REPETITIONS + 1):
        request = analyses_router.ComputeRequest(
            precision="standard",
            compact=True,
            profile=True,
            recompute=True,
            profile_request_id=f"050.5-gap-{attempt}",
        )
        started = time.perf_counter()
        response = analyses_router.compute_time_capacity_analysis(analysis.id, request, env.db)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        body = json.loads(response.body)
        profile = body["profiling"]
        results.append(
            {
                "attempt": attempt,
                "cache_state": profile["result_cache"],
                "raw_access": profile["raw_access"],
                "route_elapsed_ms": elapsed_ms,
                "backend_total_ms": profile.get("backend_total_ms"),
                "backend_compute_ms": profile.get("backend_compute_ms"),
                "response_bytes": profile.get("response_bytes"),
                "route_minus_profile_ms": elapsed_ms - float(profile.get("backend_total_ms") or 0),
            }
        )
    gaps = [item["route_minus_profile_ms"] for item in results]
    return {
        "cells": len(cell_ids),
        "cycle_range": "1-20",
        "repetitions": REPETITIONS,
        "persisted_cache_bypassed": True,
        "samples": results,
        "gap_summary_ms": {
            "median_route_minus_profile": statistics.median(gaps),
            "min_route_minus_profile": min(gaps),
            "max_route_minus_profile": max(gaps),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Write the JSON evidence to this disposable path")
    args = parser.parse_args()
    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    case = {
        "id": "time_capacity_profile",
        "kind": "time_capacity",
        "spec_path": "specs/time_capacity_baseline.json",
    }
    base = load_case_spec(fixture_root, case)
    with GoldenFixtureEnvironment.create() as env:
        from app.services import analysis_engine

        clone_ids = clone_golden_source_cells(env, 6)
        matrix: list[dict] = []
        for label, cycles, cycle_end in MATRIX_RANGES:
            print(f"profiling 1-cell {label}", flush=True)
            matrix.append(
                run_repetitions(
                    analysis_engine,
                    env,
                    base,
                    [GOLDEN_CELL_ID],
                    cycles,
                    cycle_end,
                    x_axis="time",
                    view="voltage_current",
                    label=f"one-cell/{label}",
                )
            )
        for x_axis in ("time", "capacity_mah"):
            print(f"profiling 1-cell all x={x_axis}", flush=True)
            matrix.append(
                run_repetitions(
                    analysis_engine,
                    env,
                    base,
                    [GOLDEN_CELL_ID],
                    [],
                    None,
                    x_axis=x_axis,
                    view="voltage_current",
                    label=f"one-cell/all/{x_axis}",
                )
            )
        for clone_count in (3, 6):
            for label, cycles, cycle_end in MATRIX_RANGES[1:]:
                print(f"profiling {clone_count}-cell {label}", flush=True)
                matrix.append(
                    run_repetitions(
                        analysis_engine,
                        env,
                        base,
                        clone_ids[:clone_count],
                        cycles,
                        cycle_end,
                        x_axis="time",
                        view="voltage_current",
                        label=f"{clone_count}-cell/{label}",
                    )
                )
        for label, cycles, cycle_end in (("1-3", list(range(1, 4)), 3), ("1-20", list(range(1, 21)), 20), ("all", [], None)):
            print(f"profiling dqdv {label}", flush=True)
            matrix.append(
                run_repetitions(
                    analysis_engine,
                    env,
                    base,
                    [GOLDEN_CELL_ID],
                    cycles,
                    cycle_end,
                    x_axis="capacity_mah",
                    view="dqdv",
                    label=f"dqdv/{label}",
                )
            )
        print("profiling persisted result-cache miss/hit", flush=True)
        cache_probe = run_cache_probe(env, base, GOLDEN_CELL_ID)
        print("profiling controlled five-cell route gap", flush=True)
        route_gap_probe = run_route_gap_probe(env, base, clone_ids[:5])
    evidence = {
        "spec": "050.5",
        "fixture": "golden cycles_time_steps.ndax (71,190 rows, 193 cycles)",
        "multi_cell_note": "3- and 6-Cell matrices use disposable Cell/source clones of the committed golden raw cache; they are not the user's six-cell dataset.",
        "request_contract": {
            "precision": "standard",
            "compact": True,
            "viewport_width": 1200,
            "max_points_per_cell": 4000,
            "repetitions_per_scenario": REPETITIONS,
        },
        "matrix": matrix,
        "persisted_cache_probe": cache_probe,
        "route_gap_probe": route_gap_probe,
        "http_gap_interpretation": "Direct route-level repetitions are not a browser transport measurement; use the route-minus-profile distribution to test for local server prelude/response overhead. Browser/network gaps remain external evidence.",
    }
    rendered = json.dumps(evidence, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
