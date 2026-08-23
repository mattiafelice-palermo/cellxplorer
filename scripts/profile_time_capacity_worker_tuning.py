"""Benchmark the bounded 4/6/8-worker ordinary Time route for Spec 050.15.

This is disposable evidence only. It uses the committed fixture and a
read-only disposable copy of the saved ``Performance analysis`` database,
three warm repetitions per 10/11-Cell Time-All case, and never writes the
user's database or result cache.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402
from profile_time_capacity_concurrency import (  # noqa: E402
    create_application_environment,
    discover_application_dataset,
    native_thread_settings,
)
from profile_time_capacity_ordinary_latency import (  # noqa: E402
    GOLDEN_CELL_ID,
    profile_workload,
)
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


WORKERS = (4, 6, 8)
REPETITIONS = 3


def tuning_workloads(cell_ids: list[int]) -> list[dict[str, object]]:
    if len(cell_ids) < 11:
        return []
    return [
        {
            "scenario": f"normal-{count}-all-time",
            "cell_ids": cell_ids[:count],
            "cycles": [],
            "cycle_end": None,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        }
        for count in (10, 11)
    ]


def _median(values: list[object]) -> float | None:
    numeric = [float(value) for value in values if isinstance(value, (int, float))]
    return statistics.median(numeric) if numeric else None


def summarize_worker_result(
    worker_count: int,
    suite: str,
    workload: dict[str, object],
) -> dict[str, object]:
    samples = list(workload.get("samples") or [])
    route_times = [sample.get("backend_wall_ms") for sample in samples]
    response_bytes = [sample.get("response_bytes") for sample in samples]
    combined_rss = [
        (sample.get("execution") or {}).get("total_backend_rss_after_bytes")
        for sample in samples
        if isinstance(sample.get("execution"), dict)
    ]
    execution = [sample.get("execution") or {} for sample in samples]
    parity = all(
        sample.get("status") == "PASS"
        and (sample.get("scientific_parity") or {}).get("equal") is True
        and (sample.get("scientific_parity") or {}).get("ordering_equal") is True
        for sample in samples
    )
    return {
        "suite": suite,
        "scenario": workload["scenario"],
        "cell_count": workload["cell_count"],
        "worker_count": worker_count,
        "repetitions": len(samples),
        "backend_route_p50_ms": _median(route_times),
        "response_bytes_p50": _median(response_bytes),
        "returned_points_per_cell": _median(
            [
                float(sample.get("returned_points", 0)) / max(1, int(workload["cell_count"]))
                for sample in samples
            ]
        ),
        "combined_parent_worker_rss_p50_bytes": _median(combined_rss),
        "scientific_parity": parity,
        "execution_workers": sorted(
            {int(item["workers"]) for item in execution if isinstance(item.get("workers"), int)}
        ),
        "samples": samples,
    }


def _host_gate(worker_count: int, summaries: list[dict[str, object]]) -> dict[str, object]:
    from app.services import time_capacity_workers

    resources = time_capacity_workers.host_resources()
    selected_rows = max(
        [
            int((sample.get("execution") or {}).get("selected_rows", 0))
            for summary in summaries
            for sample in summary.get("samples", [])
        ]
        or [0]
    )
    required = worker_count * time_capacity_workers._estimated_worker_bytes(
        selected_rows,
        max([int(summary["cell_count"]) for summary in summaries] or [1]),
    )
    cpu_ok = resources.logical_cpus is not None and resources.logical_cpus >= worker_count
    memory_ok = (
        resources.available_memory_bytes is not None
        and resources.available_memory_bytes >= required
    )
    return {
        "logical_cpus": resources.logical_cpus,
        "available_memory_bytes": resources.available_memory_bytes,
        "estimated_required_memory_bytes": required,
        "cpu_ok": cpu_ok,
        "memory_ok": memory_ok,
        "passed": cpu_ok and memory_ok,
    }


def run_suite_for_workers(
    env: object,
    base: dict[str, object],
    cell_ids: list[int],
    *,
    suite: str,
    worker_count: int,
    repetitions: int,
) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for workload in tuning_workloads(cell_ids):
        print(f"profiling {suite} {workload['scenario']} workers={worker_count}", flush=True)
        result = profile_workload(
            env,
            base,
            workload,
            repetitions=repetitions,
            worker_count=worker_count,
        )
        summaries.append(summarize_worker_result(worker_count, suite, result))
    return summaries


def _collect_worker_pass(
    fixture_base: dict[str, object],
    app_data_root: Path | None,
    *,
    worker_count: int,
    repetitions: int,
    fixture_only: bool,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    summaries: list[dict[str, object]] = []
    with GoldenFixtureEnvironment.create() as env:
        clone_ids = clone_golden_source_cells(env, 10)
        summaries.extend(
            run_suite_for_workers(
                env,
                fixture_base,
                [GOLDEN_CELL_ID, *clone_ids],
                suite="golden_fixture",
                worker_count=worker_count,
                repetitions=repetitions,
            )
        )

    skipped: dict[str, object] = {}
    if not fixture_only and app_data_root is not None:
        if not (app_data_root / "cellxplorer.db").is_file():
            skipped["application_performance_batch"] = f"database not found at {app_data_root / 'cellxplorer.db'}"
        else:
            with create_application_environment(app_data_root) as env:
                app_base, app_cells, metadata = discover_application_dataset(env)
                summaries.extend(
                    run_suite_for_workers(
                        env,
                        app_base,
                        app_cells,
                        suite="application_performance_batch",
                        worker_count=worker_count,
                        repetitions=repetitions,
                    )
                )
                for summary in summaries:
                    if summary["suite"] == "application_performance_batch":
                        summary["dataset"] = metadata
    return summaries, skipped


def decide_promotion(
    summaries: list[dict[str, object]],
    host_gates: dict[int, dict[str, object]],
) -> dict[str, object]:
    baseline = {
        (summary["suite"], summary["scenario"]): summary
        for summary in summaries
        if summary["worker_count"] == 4
    }
    candidates: dict[int, dict[tuple[str, str], dict[str, object]]] = {
        worker: {
            (summary["suite"], summary["scenario"]): summary
            for summary in summaries
            if summary["worker_count"] == worker
        }
        for worker in (6, 8)
    }
    checks: dict[str, object] = {}
    selected = 4
    for worker in (6, 8):
        case_checks: list[dict[str, object]] = []
        for key, base in baseline.items():
            candidate = candidates[worker].get(key)
            if candidate is None:
                case_checks.append({"case": key, "passed": False, "reason": "missing case"})
                continue
            base_ms = float(base["backend_route_p50_ms"])
            candidate_ms = float(candidate["backend_route_p50_ms"])
            improvement_ms = base_ms - candidate_ms
            improvement_pct = improvement_ms / base_ms if base_ms else 0.0
            base_rss = float(base["combined_parent_worker_rss_p50_bytes"])
            candidate_rss = float(candidate["combined_parent_worker_rss_p50_bytes"])
            case_checks.append(
                {
                    "case": key,
                    "baseline_p50_ms": base_ms,
                    "candidate_p50_ms": candidate_ms,
                    "improvement_ms": improvement_ms,
                    "improvement_pct": improvement_pct,
                    "rss_ratio": candidate_rss / base_rss if base_rss else None,
                    "passed": (
                        (improvement_pct >= 0.10 or improvement_ms >= 15.0)
                        and candidate_rss <= base_rss * 1.5
                        and bool(candidate["scientific_parity"])
                    ),
                }
            )
        passed = bool(host_gates[worker]["passed"]) and bool(case_checks) and all(
            bool(case["passed"]) for case in case_checks
        )
        checks[str(worker)] = {
            "host_gate": host_gates[worker],
            "cases": case_checks,
            "passed": passed,
        }
        if passed and selected == 4:
            selected = worker
    return {"production_worker_count": selected, "candidate_checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repetitions", type=int, default=REPETITIONS)
    parser.add_argument("--app-data-root", type=Path, default=Path.home() / ".cellxplorer")
    parser.add_argument("--fixture-only", action="store_true")
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    fixture_base = load_case_spec(
        fixture_root,
        {"id": "time_capacity_profile", "kind": "time_capacity", "spec_path": "specs/time_capacity_baseline.json"},
    )
    all_summaries: list[dict[str, object]] = []
    skipped: dict[str, object] = {}
    host_gates: dict[int, dict[str, object]] = {}
    for worker_count in WORKERS:
        current, current_skipped = _collect_worker_pass(
            fixture_base,
            args.app_data_root.resolve(),
            worker_count=worker_count,
            repetitions=args.repetitions,
            fixture_only=args.fixture_only,
        )
        all_summaries.extend(current)
        skipped.update(current_skipped)
        host_gates[worker_count] = _host_gate(worker_count, current)

    evidence: dict[str, Any] = {
        "spec": "050.15",
        "status": "PASS",
        "workloads": "10-Cell and 11-Cell Time All only",
        "repetitions": args.repetitions,
        "summaries": all_summaries,
        "host_gates": host_gates,
        "decision": decide_promotion(all_summaries, host_gates),
        "skipped_suites": skipped,
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
                "worker_modes": WORKERS,
                "production_worker_count": evidence["decision"]["production_worker_count"],
                "output": str(args.output) if args.output else None,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
