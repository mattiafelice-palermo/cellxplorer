"""Spec 052.3 evidence harness: fixed per-request overhead and scientific parity.

Measures the complete production router boundary for the Time/Capacity
workloads that Spec 052.3 targets, on a disposable result cache so every
measurement is a genuine cache miss -- which is what a moving slider preview
always is.

Each workload records a median latency, the opt-in stage breakdown, the
execution decision, and a ``scientific_digest``.  Two runs (before/after a
change) are compared with ``--compare``; a digest mismatch is a hard failure,
because Spec 052.3 may not alter scientific output.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import statistics
import sys
import tempfile
from time import perf_counter
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

from profile_time_capacity_concurrency import (  # noqa: E402
    create_application_environment,
    discover_application_dataset,
    make_spec,
    result_order,
    scientific_digest,
)

REPETITIONS = 7


def _payload(body: dict) -> dict:
    """Strip response-envelope fields that are not scientific output."""

    value = dict(body)
    for key in ("profiling", "cache_status", "badges", "data_signature", "source_data_signature"):
        value.pop(key, None)
    return value


def workload_matrix(cell_ids: list[int]) -> list[dict]:
    """The Spec 052.3 parity/performance matrix."""

    one = cell_ids[:1]
    six = cell_ids[:6]
    return [
        {
            "name": "single-cell-explicit-cycles",
            "cells": one,
            "cycles": [1, 2, 3],
            "cycle_start": 1,
            "cycle_end": 3,
            "x_axis": "time",
            "view": "voltage_current",
            "max_points": 4000,
        },
        {
            "name": "six-cell-full-range-time",
            "cells": six,
            "cycles": [],
            "cycle_start": 1,
            "cycle_end": None,
            "x_axis": "time",
            "view": "voltage_current",
            "max_points": 4000,
        },
        {
            # The moving slider preview: narrow window, reduced resolution.
            "name": "six-cell-moving-preview",
            "cells": six,
            "cycles": [],
            "cycle_start": 1,
            "cycle_end": 10,
            "x_axis": "time",
            "view": "voltage_current",
            "max_points": 1000,
            # Spec 052.3 Stage 3: moving previews are transient.
            "persist": False,
        },
        {
            "name": "six-cell-full-range-capacity",
            "cells": six,
            "cycles": [],
            "cycle_start": 1,
            "cycle_end": None,
            "x_axis": "capacity_mah",
            "view": "voltage_current",
            "max_points": 4000,
        },
        {
            "name": "six-cell-derivative",
            "cells": six,
            "cycles": [],
            "cycle_start": 1,
            "cycle_end": 20,
            "x_axis": "capacity_mah",
            "view": "dqdv",
            "max_points": 4000,
        },
    ]


def build_spec(base: dict, workload: dict) -> dict:
    spec = make_spec(
        base,
        list(workload["cells"]),
        list(workload["cycles"]),
        workload["cycle_end"],
        x_axis=str(workload["x_axis"]),
        view=str(workload["view"]),
    )
    settings = spec["computation"]["time_capacity"]
    settings["cycle_start"] = workload["cycle_start"]
    settings["cycle_end"] = workload["cycle_end"]
    settings["max_points_per_cell"] = workload["max_points"]
    return spec


def run_workload(env, base: dict, workload: dict, repetitions: int) -> dict:
    """Measure one workload on a disposable cache at the router boundary."""

    from app.models import Analysis
    from app.routers import analyses as analyses_router
    from app.services import analysis_cache

    spec = build_spec(base, workload)
    analysis = Analysis(title=f"052.3 overhead {workload['name']}", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    env.db.refresh(analysis)

    def call(profile: bool):
        request = analyses_router.ComputeRequest(
            recompute=True,
            persist=bool(workload.get("persist", True)),
            profile=profile,
            profile_request_id=f"052.3-{workload['name']}" if profile else None,
            viewport_width=1200,
            precision="standard",
            compact=True,
        )
        started = perf_counter()
        response = analyses_router.compute_time_capacity_analysis(analysis.id, request, env.db)
        elapsed = (perf_counter() - started) * 1000.0
        return elapsed, json.loads(response.body)

    with tempfile.TemporaryDirectory(prefix="cellxplorer-0523-cache-") as root:
        cache_root = Path(root)
        with ExitStack() as stack:
            for attribute, child in (
                ("_ROOT", ""),
                ("_RESULTS", "results"),
                ("_ARTIFACTS", "artifacts"),
                ("_THUMBNAILS", "thumbnails"),
                ("_THUMBNAIL_INDEXES", "thumbnail-index"),
                ("_PREPARED", "prepared"),
            ):
                stack.enter_context(
                    patch.object(analysis_cache, attribute, cache_root / child if child else cache_root)
                )
            stack.enter_context(patch.object(analysis_cache, "_budget_total", None))

            call(False)  # warm imports; not recorded

            samples: list[float] = []
            reference: dict | None = None
            for _ in range(repetitions):
                elapsed, body = call(False)
                samples.append(elapsed)
                payload = _payload(body)
                if reference is None:
                    reference = payload
                elif scientific_digest(payload) != scientific_digest(reference):
                    raise RuntimeError(
                        f"{workload['name']}: result is not deterministic across repetitions"
                    )

            _, profiled_body = call(True)

    assert reference is not None
    profiling = profiled_body.get("profiling") or {}
    stages = profiling.get("request_stages_ms") or {}
    execution = profiling.get("execution") or {}
    engine = profiling.get("engine_timing") or {}
    samples.sort()

    return {
        "workload": workload["name"],
        "cells": len(workload["cells"]),
        "persist": bool(workload.get("persist", True)),
        "max_points_per_cell": workload["max_points"],
        "repetitions": repetitions,
        "median_ms": statistics.median(samples),
        "min_ms": samples[0],
        "max_ms": samples[-1],
        "moving_preview_fps": round(1000.0 / statistics.median(samples), 1),
        "scientific_digest": scientific_digest(reference),
        "trace_order": result_order(reference),
        "execution_mode": execution.get("mode"),
        "execution_reason": execution.get("reason"),
        "selected_rows": execution.get("selected_rows"),
        "engine_timing": engine,
        "request_stages_ms": {
            key: round(float(value), 2)
            for key, value in stages.items()
            if isinstance(value, (int, float)) and float(value) >= 0.05
        },
    }


def compare(before: dict, after: dict) -> int:
    """Report parity and improvement; return a process exit code."""

    index = {row["workload"]: row for row in after["workloads"]}
    failures = 0
    print(f"{'workload':<32} {'before':>10} {'after':>10} {'change':>12}   parity")
    print("-" * 84)
    for row in before["workloads"]:
        name = row["workload"]
        other = index.get(name)
        if other is None:
            print(f"{name:<32} {'-':>10} {'MISSING':>10}")
            failures += 1
            continue
        same = (
            row["scientific_digest"] == other["scientific_digest"]
            and row["trace_order"] == other["trace_order"]
        )
        if not same:
            failures += 1
        delta = other["median_ms"] - row["median_ms"]
        pct = (delta / row["median_ms"]) * 100.0 if row["median_ms"] else 0.0
        print(
            f"{name:<32} {row['median_ms']:>9.1f}ms {other['median_ms']:>9.1f}ms "
            f"{delta:>+8.1f}ms {pct:>+5.1f}%   {'OK' if same else 'DIGEST MISMATCH'}"
        )
    print("-" * 84)
    if failures:
        print(f"FAIL: {failures} workload(s) changed scientific output or are missing")
    else:
        print("PASS: scientific output identical across every workload")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write JSON evidence here")
    parser.add_argument("--label", default="unlabelled", help="Name for this run, e.g. 'baseline'")
    parser.add_argument("--repetitions", type=int, default=REPETITIONS)
    parser.add_argument(
        "--app-data-root",
        type=Path,
        default=Path.home() / ".cellxplorer",
        help="Application data root containing the saved 'Performance analysis'",
    )
    parser.add_argument("--with-pool", action="store_true", help="Start the persistent worker pool")
    parser.add_argument(
        "--compare",
        nargs=2,
        type=Path,
        metavar=("BEFORE", "AFTER"),
        help="Compare two evidence files instead of measuring",
    )
    args = parser.parse_args()

    if args.compare:
        before = json.loads(args.compare[0].read_text(encoding="utf-8"))
        after = json.loads(args.compare[1].read_text(encoding="utf-8"))
        return compare(before, after)

    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    with create_application_environment(args.app_data_root) as env:
        base, cell_ids, _meta = discover_application_dataset(env)
        if len(cell_ids) < 6:
            raise RuntimeError(f"need at least 6 Cells in the performance batch, found {len(cell_ids)}")

        if args.with_pool:
            from app.services import time_capacity_workers

            time_capacity_workers.start_time_capacity_worker_pool()

        rows = []
        for workload in workload_matrix(cell_ids):
            print(f"measuring {workload['name']}", flush=True)
            rows.append(run_workload(env, base, workload, args.repetitions))

        if args.with_pool:
            from app.services import time_capacity_workers

            time_capacity_workers.shutdown_time_capacity_worker_pool()

    evidence = {
        "spec": "052.3",
        "label": args.label,
        "repetitions": args.repetitions,
        "boundary": "complete synchronous /analyses/{id}/time-capacity router path, disposable result cache",
        "workloads": rows,
    }

    for row in rows:
        print(
            f"  {row['workload']:<32} {row['median_ms']:>7.1f} ms  "
            f"({row['moving_preview_fps']:>5.1f} fps)  {row['execution_mode']}/{row['execution_reason']}"
        )

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        print(f"\nwrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
