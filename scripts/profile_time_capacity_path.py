"""Profile indexed versus legacy Time/Capacity requests on the golden source.

This is a diagnostic harness, not a production benchmark gate.  It reports
the structural evidence required by Spec 050.3 alongside repeatable local
timings.  The golden fixture environment is isolated and is cleaned up when
the process exits.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import tracemalloc
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import (  # noqa: E402
    GoldenFixtureEnvironment,
    load_case_spec,
)


MATRIX = (
    ("single", [1], 1),
    ("twenty", list(range(1, 21)), 20),
    ("broad", list(range(1, 151)), 150),
    ("all", [], None),
)


def profile_request(
    env: GoldenFixtureEnvironment,
    engine,
    cache,
    case: dict,
    spec: dict,
    *,
    path: str,
) -> dict:
    diagnostics: dict = {}
    counts = {"load_raw_calls": 0, "load_raw_cycles_calls": 0}
    original_load_raw = cache.load_raw
    original_load_raw_cycles = cache.load_raw_cycles

    def load_raw(*args, **kwargs):
        counts["load_raw_calls"] += 1
        return original_load_raw(*args, **kwargs)

    def load_raw_cycles(*args, **kwargs):
        counts["load_raw_cycles_calls"] += 1
        return original_load_raw_cycles(*args, **kwargs)

    started = time.perf_counter()
    tracemalloc.start()
    layout_patch = (
        patch.object(cache, "load_raw_layout_index", return_value=None)
        if path == "legacy"
        else patch.object(cache, "load_raw_layout_index", wraps=cache.load_raw_layout_index)
    )
    with patch.object(cache, "load_raw", side_effect=load_raw), patch.object(
        cache, "load_raw_cycles", side_effect=load_raw_cycles
    ), layout_patch:
        result = engine.compute_time_capacity(
            env.db,
            spec,
            None,
            viewport_width=1200,
            precision="full",
            compact=False,
            access_diagnostics=diagnostics,
        )
    backend_elapsed = time.perf_counter() - started
    serialization_started = time.perf_counter()
    payload_bytes = len(json.dumps(result, separators=(",", ":")))
    serialization_elapsed = time.perf_counter() - serialization_started
    _current, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    cell = (diagnostics.get("cells") or [{}])[0]
    return {
        "path": path,
        "backend_elapsed_s": backend_elapsed,
        "serialization_elapsed_s": serialization_elapsed,
        "peak_tracemalloc_bytes": peak_bytes,
        "load_raw_calls": counts["load_raw_calls"],
        "load_raw_cycles_calls": counts["load_raw_cycles_calls"],
        "source_count": cell.get("source_count", 0),
        "row_groups_read": cell.get("row_groups_read", 0),
        "row_groups_total": cell.get("row_groups_total", 0),
        "raw_rows_materialized": cell.get("raw_rows_materialized", 0),
        "selected_rows_before_transforms": cell.get(
            "selected_rows_before_transforms", cell.get("selected_rows", 0)
        ),
        "returned_points": result["rendering"]["total_points"],
        "payload_bytes": payload_bytes,
        "stage_timings_s": cell.get("stages", {}),
    }


def main() -> int:
    root = ROOT / "tests" / "fixtures" / "golden_analysis"
    case = {
        "id": "time_capacity_profile",
        "kind": "time_capacity",
        "spec_path": "specs/time_capacity_baseline.json",
    }
    base = load_case_spec(root, case)
    results: list[dict] = []
    with GoldenFixtureEnvironment.create() as env:
        from app.services import analysis_engine, cache

        for request_name, cycles, cycle_end in MATRIX:
            for path in ("legacy", "indexed"):
                spec = deepcopy(base)
                settings = spec["computation"]["time_capacity"]
                settings["cycles"] = cycles
                settings["cycle_start"] = 1
                settings["cycle_end"] = cycle_end
                settings["max_points_per_cell"] = 500000
                samples = [
                    profile_request(
                        env,
                        analysis_engine,
                        cache,
                        case,
                        spec,
                        path=path,
                    )
                    for _ in range(3)
                ]
                numeric_keys = {
                    key: statistics.median(sample[key] for sample in samples)
                    for key in samples[0]
                    if isinstance(samples[0][key], (int, float))
                }
                results.append(
                    {
                        "request": request_name,
                        "median": numeric_keys,
                        "samples": samples,
                    }
                )

    print(json.dumps({"matrix": results, "frontend_profile": "not run"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
