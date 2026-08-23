"""Focused contract tests for the Spec 050.17 diagnostic harness."""
from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import profile_analysis_families as profiler  # noqa: E402


def _sample(*, hit: bool = False) -> dict:
    return {
        "complete_route_ms": 100.0 if not hit else 10.0,
        "body_bytes": 12,
        "cache_status": "hit" if hit else "miss",
        "scientific_digest": "digest",
        "series_order": [(1, None)],
        "root_stage_ms": {
            "cache_key": 1.0,
            "scientific_compute": None if hit else 80.0,
        },
        "taxonomy_stage_ms": {
            name: None for name in profiler.COMMON_STAGES
        },
        "nested_stages_ms": {"raw_scan": 30.0},
        "calls": {"scientific_compute": 0 if hit else 1},
        "counts": {"raw_load_calls": 0 if hit else 1, "final_response_points": 2},
        "reconciliation": {
            "route_ms": 100.0 if not hit else 10.0,
            "root_stage_sum_ms": 81.0 if not hit else 1.0,
            "unattributed_residual_ms": 19.0 if not hit else 9.0,
            "within_root_hierarchy": True,
        },
    }


class ProfileAnalysisFamiliesTests(unittest.TestCase):
    def test_all_families_have_common_workload_record(self) -> None:
        for family in profiler.FAMILIES:
            summary = profiler._summarize_samples([_sample()], family)
            self.assertTrue(set(profiler.COMMON_STAGES).issubset(summary["stages"]))
            self.assertEqual(summary["complete_route_ms"]["p50"], 100.0)
            self.assertIn("frontend", summary)

    def test_forced_miss_and_exact_hit_are_distinguished(self) -> None:
        miss = _sample()
        hit = _sample(hit=True)
        miss_summary = profiler._summarize_samples([miss], "cycles")
        hit_summary = profiler._summarize_samples([hit], "cycles")
        self.assertEqual(miss_summary["cache_statuses"], ["miss"])
        self.assertEqual(hit_summary["cache_statuses"], ["hit"])
        self.assertFalse(profiler._exact_hit_is_clean(miss))
        self.assertTrue(profiler._exact_hit_is_clean(hit))

    def test_projection_digest_and_order_preserve_scientific_payload(self) -> None:
        first = {
            "computed_at": "one",
            "cache_status": "miss",
            "cell_series": [{"cell_id": 1, "series_id": "a", "x": [1, 2]}],
        }
        second = {
            "computed_at": "two",
            "cache_status": "hit",
            "data_signature": "changed",
            "cell_series": [{"cell_id": 1, "series_id": "a", "x": [1, 2]}],
        }
        self.assertEqual(profiler._digest(first), profiler._digest(second))
        self.assertEqual(profiler._series_order(first), [(1, "a")])

    def test_nested_timers_are_not_double_counted_in_reconciliation(self) -> None:
        result = profiler._reconcile_root_stages(
            100.0,
            {"cache_key": 10.0, "scientific_compute": 70.0, "nested_child": 999.0},
        )
        self.assertEqual(result["root_stage_sum_ms"], 80.0)
        self.assertEqual(result["unattributed_residual_ms"], 20.0)
        self.assertTrue(result["within_root_hierarchy"])

    def test_missing_optional_instrumentation_is_explicit(self) -> None:
        record = profiler._stage_record(profiler._Recorder(), "not_available", 100.0)
        self.assertIsNone(record["ms"])
        self.assertFalse(record["available"])

    def test_analysis_cache_patch_restores_all_paths(self) -> None:
        from app.services import analysis_cache

        original = {
            name: getattr(analysis_cache, name)
            for name in (
                "_ROOT",
                "_RESULTS",
                "_ARTIFACTS",
                "_THUMBNAILS",
                "_THUMBNAIL_INDEXES",
                "_PREPARED",
                "_budget_total",
            )
        }
        with tempfile.TemporaryDirectory() as root:
            with profiler._analysis_cache_root(Path(root)):
                self.assertEqual(analysis_cache._ROOT, Path(root))
                self.assertEqual(analysis_cache._RESULTS, Path(root) / "results")
        for name, value in original.items():
            self.assertIs(getattr(analysis_cache, name), value)

    def test_rate_deep_profile_has_required_stage_contract(self) -> None:
        profile = profiler._rate_deep_summary([
            {
                "rate_deep": {
                    "stages_ms": {"execution_extraction": 5.0},
                    "calls": {"execution_extraction": 2},
                    "counts": {"rate_pairs": 3},
                }
            }
        ])
        self.assertIsNotNone(profile)
        required = profile["required_decomposition"]
        self.assertIn("invalid_neighbour_execution_validation", required)
        self.assertIn("execution_phase_row_filtering", required)
        self.assertEqual(profile["counts"]["rate_pairs"], 3.0)

    def test_cloned_spec_expands_selection_and_protocol_series_truthfully(self) -> None:
        base = {
            "selection": {"entries": [{"kind": "cell", "ref_id": 1}]},
            "computation": {
                "steps": {"series": [{"id": "original", "cell_id": 1, "segment_id": "s"}]},
                "dcir": {"series": [{"id": "original-dcir", "cell_id": 1, "segment_id": "d"}]},
            },
        }
        for family in ("steps", "dcir"):
            spec = profiler._scaled_spec(base, family, [1, 2, 3, 4, 5, 6])
            self.assertEqual(
                [entry["ref_id"] for entry in spec["selection"]["entries"]],
                [1, 2, 3, 4, 5, 6],
            )
            series = spec["computation"][family]["series"]
            self.assertEqual(len(series), 6)
            self.assertEqual({item["cell_id"] for item in series}, {1, 2, 3, 4, 5, 6})
            self.assertEqual(len({item["id"] for item in series}), 6)


if __name__ == "__main__":
    unittest.main()
