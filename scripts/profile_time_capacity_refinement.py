"""Run the focused Spec 050.15 adaptive-refinement S25 measurement.

This is a disposable golden-fixture route benchmark.  It warms one six-Cell
ordinary Time overview, then measures one refinement endpoint request at 25%,
10%, and 2% viewport spans for three repetitions each.  It records the
complete direct router/backend wall time, response size, visible points, and
the worker mode actually used.  It never opens a browser or touches the
user's application database.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import statistics
import sys
from time import perf_counter
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402
from profile_time_capacity_concurrency import GOLDEN_CELL_ID, make_spec  # noqa: E402
from profile_time_capacity_ordinary_latency import _benchmark_worker_pool  # noqa: E402
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


FRACTIONS = (0.25, 0.10, 0.02)


def _median(values: list[float]) -> float:
    return float(statistics.median(values))


def _finite_extent(body: dict) -> tuple[float, float]:
    values = [
        float(value)
        for trace in body.get("cell_traces", [])
        if not trace.get("excluded")
        for value in trace.get("display_x", [])
        if isinstance(value, (int, float))
    ]
    if not values:
        raise RuntimeError("overview returned no finite Time coordinates")
    return min(values), max(values)


def _visible_points(body: dict, minimum: float, maximum: float) -> int:
    return sum(
        1
        for trace in body.get("cell_traces", [])
        if not trace.get("excluded")
        for value in trace.get("display_x", [])
        if isinstance(value, (int, float)) and minimum <= float(value) <= maximum
    )


def _cycle_range(body: dict, minimum: float, maximum: float) -> tuple[int, int]:
    selected: list[int] = []
    all_cycles: list[int] = []
    for trace in body.get("cell_traces", []):
        if trace.get("excluded"):
            continue
        cycles = trace.get("cycle", [])
        x_values = trace.get("display_x", [])
        for cycle, value in zip(cycles, x_values):
            if not isinstance(cycle, int) or not isinstance(value, (int, float)):
                continue
            all_cycles.append(cycle)
            if minimum <= float(value) <= maximum:
                selected.append(cycle)
    if not selected or not all_cycles:
        raise RuntimeError("viewport did not intersect a cycle in the overview")
    return max(1, min(selected) - 1), min(max(all_cycles), max(selected) + 1)


def _payload(body: bytes) -> dict:
    return json.loads(body.decode("utf-8"))


def _run() -> dict:
    from app.models import Analysis
    from app.routers import analyses as analyses_router
    from app.services import time_capacity_workers

    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    fixture_case = {
        "id": "time_capacity_profile",
        "kind": "time_capacity",
        "spec_path": "specs/time_capacity_baseline.json",
    }
    base = load_case_spec(fixture_root, fixture_case)
    started = perf_counter()
    with GoldenFixtureEnvironment.create() as env:
        clone_ids = clone_golden_source_cells(env, 5)
        cell_ids = [GOLDEN_CELL_ID, *clone_ids]
        overview_spec = make_spec(
            base,
            cell_ids,
            [],
            None,
            x_axis="time",
            view="voltage_current",
        )
        analysis = Analysis(title="050.15 refinement S25", spec=deepcopy(overview_spec))
        env.db.add(analysis)
        env.db.commit()

        with _benchmark_worker_pool(4):
            # One complete request warms the route/cache/pool boundary.  The
            # returned body is the canonical overview used for every viewport.
            overview_response = analyses_router.compute_time_capacity_analysis(
                analysis.id,
                analyses_router.ComputeRequest(
                    viewport_width=1200,
                    precision="standard",
                    compact=True,
                ),
                env.db,
            )
            overview_body = _payload(overview_response.body)
            minimum, maximum = _finite_extent(overview_body)
            total_span = maximum - minimum
            if total_span <= 0:
                raise RuntimeError("overview Time extent is not positive")

            modes: list[str] = []
            original_process = time_capacity_workers._run_process
            original_serial = time_capacity_workers._run_serial

            def record_process(*args, **kwargs):
                modes.append("process")
                return original_process(*args, **kwargs)

            def record_serial(*args, **kwargs):
                modes.append("serial")
                return original_serial(*args, **kwargs)

            fractions: list[dict] = []
            with patch.object(time_capacity_workers, "_run_process", record_process), patch.object(
                time_capacity_workers, "_run_serial", record_serial
            ):
                for fraction in FRACTIONS:
                    span = total_span * fraction
                    center = minimum + total_span * 0.5
                    viewport_min = max(minimum, center - span / 2.0)
                    viewport_max = min(maximum, center + span / 2.0)
                    cycle_start, cycle_end = _cycle_range(
                        overview_body, viewport_min, viewport_max
                    )
                    request = analyses_router.TimeCapacityRefinementRequest(
                        spec=deepcopy(overview_spec),
                        viewport_x_min=viewport_min,
                        viewport_x_max=viewport_max,
                        viewport_width=1200,
                        cycle_start=cycle_start,
                        cycle_end=cycle_end,
                        request_generation=f"050.15-{fraction}",
                    )

                    # Warm each viewport once, outside the reported samples.
                    warm_response = analyses_router.refine_time_capacity_analysis(
                        analysis.id, request, env.db
                    )
                    warm_body = _payload(warm_response.body)
                    if warm_response.status_code != 200:
                        raise RuntimeError(f"refinement warmup failed: {warm_response.status_code}")
                    overview_visible = _visible_points(
                        overview_body, viewport_min, viewport_max
                    )
                    refined_visible = _visible_points(
                        warm_body, viewport_min, viewport_max
                    )
                    sample_rows: list[dict] = []
                    for repetition in range(3):
                        modes.clear()
                        sample_started = perf_counter()
                        response = analyses_router.refine_time_capacity_analysis(
                            analysis.id, request, env.db
                        )
                        elapsed_ms = (perf_counter() - sample_started) * 1000.0
                        body = _payload(response.body)
                        if response.status_code != 200:
                            raise RuntimeError(
                                f"refinement sample failed: {response.status_code}"
                            )
                        if body.get("data_signature") != overview_body.get("data_signature"):
                            raise RuntimeError("refinement changed the overview data signature")
                        points = [
                            len(trace.get("cycle", []))
                            for trace in body.get("cell_traces", [])
                            if not trace.get("excluded")
                        ]
                        sample_rows.append(
                            {
                                "repetition": repetition + 1,
                                "backend_wall_ms": elapsed_ms,
                                "response_bytes": len(response.body),
                                "points_per_cell": _median([float(value) for value in points]),
                                "worker_mode": modes[-1] if modes else "unknown",
                                "worker_events": list(modes),
                            }
                        )
                    p50_points = _median(
                        [float(row["points_per_cell"]) for row in sample_rows]
                    )
                    configured_max = int(
                        warm_body.get("rendering", {}).get("max_points_per_cell", 0)
                    )
                    raw_density_cap = p50_points < configured_max
                    fractions.append(
                        {
                            "fraction": fraction,
                            "viewport": {"min": viewport_min, "max": viewport_max},
                            "cycle_range": {"start": cycle_start, "end": cycle_end},
                            "overview_visible_points_per_cell": overview_visible / len(cell_ids),
                            "refined_visible_points_per_cell": refined_visible / len(cell_ids),
                            "resolution_ratio": (
                                refined_visible / overview_visible if overview_visible else None
                            ),
                            "configured_refinement_max_points_per_cell": configured_max,
                            "raw_density_cap": raw_density_cap,
                            "samples": sample_rows,
                            "backend_p50_ms": _median(
                                [float(row["backend_wall_ms"]) for row in sample_rows]
                            ),
                            "response_bytes_p50": _median(
                                [float(row["response_bytes"]) for row in sample_rows]
                            ),
                            "points_per_cell_p50": p50_points,
                            "worker_modes": sorted(
                                {str(row["worker_mode"]) for row in sample_rows}
                            ),
                        }
                    )

        return {
            "spec": "050.15",
            "status": "PASS",
            "measurement": "focused S25 adaptive refinement",
            "dataset": "golden fixture plus five source-identical disposable Cell clones",
            "cells": len(cell_ids),
            "repetitions": 3,
            "viewport_width": 1200,
            "overview": {
                "response_bytes": len(overview_response.body),
                "points_per_cell": _median(
                    [
                        float(len(trace.get("cycle", [])))
                        for trace in overview_body.get("cell_traces", [])
                        if not trace.get("excluded")
                    ]
                ),
                "extent": {"min": minimum, "max": maximum},
                "worker_mode": "warmup not reported",
            },
            "fractions": fractions,
            "elapsed_seconds": perf_counter() - started,
            "browser_manual": "NOT RUN (user requested no browser)",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    evidence = _run()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": evidence["status"],
                "elapsed_seconds": evidence["elapsed_seconds"],
                "output": str(args.output),
                "fractions": [
                    {
                        "fraction": item["fraction"],
                        "backend_p50_ms": item["backend_p50_ms"],
                        "resolution_ratio": item["resolution_ratio"],
                        "worker_modes": item["worker_modes"],
                    }
                    for item in evidence["fractions"]
                ],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
