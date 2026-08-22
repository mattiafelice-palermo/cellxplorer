"""Profile Spec 050.8 cross-family cache-miss access paths.

The harness uses the committed golden corpus in a disposable database/cache.
It compares exact-result hits, forced full-raw misses and indexed-detail
misses.  Structural access counters are the primary evidence; wall time is
reported descriptively from the same process and five repetitions.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import statistics
import sys
import time
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, dispatch_case, load_case_spec  # noqa: E402

from app.services import analysis_cache, analysis_detail, cache  # noqa: E402


CASES = (
    {"id": "cycles_baseline", "kind": "cycles", "spec_path": "specs/cycles_baseline.json"},
    {"id": "steps_baseline", "kind": "steps", "spec_path": "specs/steps_baseline.json"},
    {"id": "dcir_baseline", "kind": "dcir", "spec_path": "specs/dcir_baseline.json"},
    {
        "id": "chargeability_baseline",
        "kind": "chargeability",
        "spec_path": "specs/chargeability_baseline.json",
    },
    {
        "id": "rate_capability_baseline",
        "kind": "rate_capability",
        "spec_path": "specs/rate_capability_baseline.json",
    },
)
VOLATILE_KEYS = {"computed_at", "cache_status", "data_signature"}


def _stable(value):
    if isinstance(value, dict):
        return {
            key: _stable(item)
            for key, item in value.items()
            if key not in VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [_stable(item) for item in value]
    return value


def _digest(value) -> str:
    encoded = json.dumps(_stable(value), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _raw_layout_counts(file_hash: str, parser_version: str) -> tuple[int, int]:
    index = cache.try_load_raw_layout_index(file_hash, parser_version)
    if index is None:
        return 0, 0
    return int(index["raw_row_group_count"]), int(index["raw_row_count"])


def _profile_miss(env, case: dict, spec: dict, *, mode: str) -> dict:
    raw_calls = 0
    raw_rows = 0
    raw_read_ms = 0.0
    detail_calls = 0
    detail_rows_read = 0
    detail_rows_returned = 0
    detail_groups_read = 0
    detail_groups_total = 0
    detail_columns: set[str] = set()
    full_groups_total = 0
    full_columns: set[str] = set()
    original_raw = cache.load_raw
    original_detail = cache.load_raw_detail

    def load_raw(*args, **kwargs):
        nonlocal raw_calls, raw_rows, raw_read_ms, full_groups_total
        started = time.perf_counter()
        value = original_raw(*args, **kwargs)
        raw_read_ms += (time.perf_counter() - started) * 1000.0
        raw_calls += 1
        if value is not None:
            raw_rows += len(value)
            full_columns.update(str(column) for column in value.columns)
            if len(args) >= 2:
                groups, _rows = _raw_layout_counts(str(args[0]), str(args[1]))
                full_groups_total += groups
        return value

    def load_detail(*args, **kwargs):
        nonlocal detail_calls, detail_rows_read, detail_rows_returned
        nonlocal detail_groups_read, detail_groups_total
        started = time.perf_counter()
        value = original_detail(*args, **kwargs)
        raw_read_ms_nonlocal = (time.perf_counter() - started) * 1000.0
        # Assignment through the closure keeps the timing bucket comparable to
        # the full-raw reader without changing production diagnostics.
        nonlocal_raw_read[0] += raw_read_ms_nonlocal
        detail_calls += 1
        diagnostics = kwargs.get("diagnostics")
        if diagnostics is not None:
            detail_rows_read += int(diagnostics.rows_read)
            detail_rows_returned += int(diagnostics.rows_returned)
            detail_groups_read += len(diagnostics.row_groups_read)
            detail_groups_total += int(diagnostics.row_groups_total)
            detail_columns.update(diagnostics.columns_read)
        return value

    # Python's nonlocal declaration cannot target the scalar above after the
    # helper is defined, so keep the shared raw-read timer in a one-item list.
    nonlocal_raw_read = [0.0]
    with ExitStack() as stack:
        stack.enter_context(patch.object(cache, "load_raw", side_effect=load_raw))
        stack.enter_context(patch.object(cache, "load_raw_detail", side_effect=load_detail))
        if mode == "legacy":
            stack.enter_context(
                patch.object(analysis_detail, "load_indexed_stitched_raw", return_value=None)
            )
            stack.enter_context(
                patch.object(analysis_detail, "load_indexed_source_raw", return_value=None)
            )
        started = time.perf_counter()
        result = dispatch_case(env.db, case, spec)
        elapsed_ms = (time.perf_counter() - started) * 1000.0

    return {
        "result_digest": _digest(result),
        "source_count": len(result.get("sources") or []),
        "raw_access_mode": "indexed_detail" if mode == "indexed" else "legacy_full_raw",
        "raw_detail_calls": detail_calls,
        "raw_row_groups_total": detail_groups_total if mode == "indexed" else full_groups_total,
        "raw_row_groups_read": detail_groups_read if mode == "indexed" else full_groups_total,
        "raw_rows_materialized": detail_rows_read if mode == "indexed" else raw_rows,
        "rows_entering_family_science": detail_rows_returned if mode == "indexed" else raw_rows,
        "columns_read": sorted(detail_columns if mode == "indexed" else full_columns),
        "raw_read_ms": raw_read_ms + nonlocal_raw_read[0],
        "family_postprocessing_ms": max(0.0, elapsed_ms - raw_read_ms - nonlocal_raw_read[0]),
        "route_total_ms": elapsed_ms,
    }


def _profile_exact_hit(env, case: dict, spec: dict) -> dict:
    result = dispatch_case(env.db, case, spec)
    key = analysis_cache.result_key(
        env.db,
        case["kind"],
        spec,
        None,
        use_current_versions=False,
    )
    analysis_cache.store_result(case["kind"], key, result)
    calls = {"raw": 0, "detail": 0}

    def fail_raw(*_args, **_kwargs):
        calls["raw"] += 1
        raise AssertionError("exact result hit read raw cache")

    def fail_detail(*_args, **_kwargs):
        calls["detail"] += 1
        raise AssertionError("exact result hit read detail cache")

    with patch.object(cache, "load_raw", side_effect=fail_raw), patch.object(
        cache, "load_raw_detail", side_effect=fail_detail
    ):
        loaded = analysis_cache.load_result(case["kind"], key)
    return {
        "result_cache_state": "exact_hit",
        "hit_loaded": loaded is not None,
        "raw_calls": calls["raw"],
        "detail_calls": calls["detail"],
        "result_digest": _digest(loaded),
    }


def main() -> int:
    global analysis_cache
    summary_only = "--summary" in sys.argv[1:]
    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    output: dict = {
        "schema_version": 1,
        "repetitions": 5,
        "fixture": "committed golden_analysis",
        "families": {},
    }
    with GoldenFixtureEnvironment.create() as env:
        # GoldenFixtureEnvironment rebinds the scientific cache module to its
        # disposable root; analysis_cache has its own module-level paths and
        # must be rebound as well for the exact-hit control.
        analysis_cache = importlib.reload(
            importlib.import_module("app.services.analysis_cache")
        )
        for case in CASES:
            spec = load_case_spec(fixture_root, case)
            samples: dict[str, list[dict]] = {"legacy": [], "indexed": []}
            for mode in samples:
                for _ in range(output["repetitions"]):
                    samples[mode].append(_profile_miss(env, case, spec, mode=mode))
            # Measure the exact persisted-result hit after the forced misses so
            # the control entry cannot accidentally turn the miss runs into
            # cache hits.
            hit = _profile_exact_hit(env, case, spec)
            legacy_digest = samples["legacy"][0]["result_digest"]
            indexed_digest = samples["indexed"][0]["result_digest"]
            family = {
                "exact_result_hit": hit,
                "indexed_legacy_equal": legacy_digest == indexed_digest,
                "miss": {},
            }
            for mode, values in samples.items():
                miss_report = {
                    "median": {
                        key: statistics.median(item[key] for item in values)
                        for key in values[0]
                        if isinstance(values[0][key], (int, float))
                    },
                }
                if summary_only:
                    miss_report["sample_result_digests"] = sorted(
                        {item["result_digest"] for item in values}
                    )
                    miss_report["sample_route_total_ms"] = [
                        round(float(item["route_total_ms"]), 3) for item in values
                    ]
                    miss_report["sample_structural"] = [
                        {
                            "raw_detail_calls": item["raw_detail_calls"],
                            "raw_row_groups_total": item["raw_row_groups_total"],
                            "raw_row_groups_read": item["raw_row_groups_read"],
                            "raw_rows_materialized": item["raw_rows_materialized"],
                            "rows_entering_family_science": item[
                                "rows_entering_family_science"
                            ],
                        }
                        for item in values
                    ]
                else:
                    miss_report["samples"] = values
                family["miss"][mode] = miss_report
            if case["kind"] == "cycles":
                family["selected_production_path"] = "prepared_cycle_cache_control"
            else:
                indexed_median = family["miss"]["indexed"]["median"]
                legacy_median = family["miss"]["legacy"]["median"]
                selective = indexed_median["raw_rows_materialized"] < legacy_median[
                    "raw_rows_materialized"
                ]
                no_material_regression = indexed_median["route_total_ms"] <= (
                    legacy_median["route_total_ms"] * 1.10
                )
                family["selected_production_path"] = (
                    "indexed_detail" if selective and no_material_regression else "legacy_full_raw"
                )
            output["families"][case["kind"]] = family
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
