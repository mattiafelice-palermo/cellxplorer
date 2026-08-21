import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.time_capacity_profiling import build_time_capacity_profile


class TimeCapacityProfilingTests(unittest.TestCase):
    def test_aggregates_indexed_and_legacy_diagnostics_without_private_fields(self):
        profile = build_time_capacity_profile(
            request_id="request-1",
            result_cache="miss",
            diagnostics={
                "cells": [
                    {
                        "cell_id": 1,
                        "cell_name": "private cell name",
                        "path": "indexed",
                        "row_groups_read": 2,
                        "row_groups_total": 8,
                        "raw_rows_materialized": 40,
                        "selected_rows_before_transforms": 36,
                        "source_reads": [{"source_hash": "private hash"}],
                        "stages": {"index_stitch_plan": 0.0015},
                    },
                    {
                        "path": "legacy",
                        "row_groups_read": "full",
                        "row_groups_total": "full",
                        "raw_rows_materialized": 100,
                        "selected_rows_before_transforms": 80,
                        "stages": {"legacy_full_raw_read": 0.002},
                    },
                ]
            },
            backend_compute_ms=12.5,
            result={
                "cell_traces": [{"cell_id": 1}],
                "rendering": {"total_points": 24},
            },
        )

        self.assertEqual(profile["raw_access"], "mixed")
        self.assertEqual(profile["row_groups_read"], "full")
        self.assertEqual(profile["row_groups_total"], "full")
        self.assertEqual(profile["raw_rows_materialized"], 140)
        self.assertEqual(profile["selected_rows_before_transforms"], 116)
        self.assertEqual(profile["returned_points"], 24)
        self.assertEqual(profile["trace_count"], 1)
        self.assertAlmostEqual(profile["backend_stages_ms"]["index_stitch_plan"], 1.5)
        self.assertAlmostEqual(profile["backend_stages_ms"]["legacy_full_raw_read"], 2.0)
        self.assertNotIn("cell_id", profile)
        self.assertNotIn("cell_name", profile)
        self.assertNotIn("source_reads", profile)
        self.assertNotIn("source_hash", str(profile))

    def test_exact_result_cache_hit_does_not_invent_raw_access_or_scientific_cost(self):
        profile = build_time_capacity_profile(
            request_id="request-hit",
            result_cache="hit",
            diagnostics={"cells": [{"path": "legacy", "raw_rows_materialized": 999}]},
        )
        self.assertEqual(profile["result_cache"], "hit")
        self.assertEqual(profile["raw_access"], "not_applicable")
        self.assertNotIn("raw_rows_materialized", profile)
        self.assertNotIn("backend_compute_ms", profile)

    def test_legacy_fallback_is_reported_as_legacy(self):
        profile = build_time_capacity_profile(
            request_id="request-legacy",
            result_cache="miss",
            diagnostics={
                "cells": [
                    {
                        "path": "legacy",
                        "row_groups_read": "full",
                        "row_groups_total": "full",
                        "raw_rows_materialized": 100,
                    }
                ]
            },
        )
        self.assertEqual(profile["raw_access"], "legacy")
        self.assertEqual(profile["row_groups_read"], "full")
        self.assertEqual(profile["row_groups_total"], "full")


if __name__ == "__main__":
    unittest.main()
