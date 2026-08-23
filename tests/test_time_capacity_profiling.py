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
                        "cell_job_wall_ms": 3.5,
                        "source_reads": [{"source_hash": "private hash"}],
                        "stages": {"index_stitch_plan": 0.0015},
                    },
                    {
                        "cell_id": 2,
                        "path": "legacy",
                        "row_groups_read": "full",
                        "row_groups_total": "full",
                        "raw_rows_materialized": 100,
                        "selected_rows_before_transforms": 80,
                        "cell_job_wall_ms": 4.5,
                        "stages": {"legacy_full_raw_read": 0.002},
                    },
                ]
            },
            backend_compute_ms=12.5,
            result={
                "cell_traces": [
                    {"cell_id": 1},
                    {"cell_id": 1},
                    {"cell_id": 2},
                ],
                "rendering": {"total_points": 24},
            },
        )

        self.assertEqual(profile["raw_access"], "mixed")
        self.assertEqual(profile["row_groups_read"], "full")
        self.assertEqual(profile["row_groups_total"], "full")
        self.assertEqual(profile["raw_rows_materialized"], 140)
        self.assertEqual(profile["selected_rows_before_transforms"], 116)
        self.assertAlmostEqual(profile["cell_job_wall_ms"], 8.0)
        self.assertEqual(profile["returned_points"], 24)
        self.assertEqual(profile["resolved_cell_count"], 2)
        self.assertNotIn("trace_count", profile)
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

    def test_request_and_engine_accounting_exposes_exclusive_partitions(self):
        profile = build_time_capacity_profile(
            request_id="accounting",
            result_cache="miss",
            diagnostics={
                "engine": {
                    "total_ms": 20.0,
                    "owner_setup_ms": 2.0,
                    "cell_jobs_ms": 16.0,
                    "global_finalization_ms": 1.0,
                    "residual_ms": 1.0,
                },
                "cells": [
                    {
                        "cell_id": 1,
                        "cell_job_wall_ms": 16.0,
                        "exclusive_partition_ms": {
                            "relational_selection_source_resolution": 1.0,
                            "raw_row_group_decode_arrow_to_pandas": 5.0,
                            "compact_trace_object_projection": 3.0,
                            "cell_residual": 7.0,
                        },
                    }
                ],
            },
            request_profile={
                "stages_ms": {
                    "analysis_lookup": 1.0,
                    "engine_compute": 20.0,
                },
                "sql": {
                    "statement_count": 4,
                    "cumulative_sql_ms": 0.5,
                    "source_header_lazy_loads": 1,
                },
            },
        )

        self.assertEqual(profile["request_stages_ms"]["analysis_lookup"], 1.0)
        self.assertEqual(profile["response_serialization_ms"], 0.0)
        self.assertEqual(profile["request_sql"]["statement_count"], 4)
        self.assertEqual(profile["engine_timing"]["residual_ms"], 1.0)
        self.assertEqual(
            profile["cell_exclusive_partition_ms"]["raw_row_group_decode_arrow_to_pandas"],
            5.0,
        )
        self.assertNotIn("cell_id", profile)
        self.assertNotIn("paths", str(profile))

    def test_aggregates_transform_and_derivative_profiles_without_private_fields(self):
        profile = build_time_capacity_profile(
            request_id="request-transform",
            result_cache="miss",
            diagnostics={
                "cells": [
                    {
                        "path": "indexed",
                        "stages": {
                            "derivative_status_classification": 0.002,
                            "derivative_segment_scan": 0.004,
                            "derivative_segment_prepare": 0.001,
                        "transform_continuous_time": 0.004,
                        "transform_phase_capacity": 0.012,
                        "prepared_derived_read": 0.002,
                            "derivative_rolling": 0.003,
                            "derivative_gradient": 0.002,
                            "derivative_ratio_filter": 0.001,
                            "derivative_postprocess": 0.006,
                        },
                        "transform_profile": {
                            "continuous_time": {
                                "input_rows": 100,
                                "output_rows": 100,
                                "consumed_by": ["time_axis"],
                            },
                            "phase_capacity": {
                                "input_rows": 100,
                                "output_rows": 100,
                                "consumed_by": [],
                            },
                        },
                        "derivative_profile": {
                            "input_rows": 100,
                            "segments_processed": 4,
                            "eligible_segments": 3,
                            "finite_input_rows": 90,
                            "output_finite_rows": 80,
                            "output_segments": 3,
                            "phase_rows": {"charge": 40, "discharge": 40, "rest": 20},
                        },
                        "derived_access": "prepared",
                        "phase_source": "prepared",
                        "phase_capacity_source": "prepared",
                        "prepared_row_groups_read": 2,
                        "prepared_rows_materialized": 40,
                    }
                ]
            },
        )

        self.assertEqual(profile["transform_stages"]["continuous_time"]["input_rows"], 100)
        self.assertEqual(profile["transform_stages"]["phase_capacity"]["consumed_by"], [])
        self.assertAlmostEqual(profile["transform_stages"]["continuous_time"]["elapsed_ms"], 4.0)
        self.assertEqual(profile["derived_access"], "prepared")
        self.assertEqual(profile["phase_source"], "prepared")
        self.assertEqual(profile["phase_capacity_source"], "prepared")
        self.assertEqual(profile["prepared_row_groups_read"], 2)
        self.assertEqual(profile["prepared_rows_materialized"], 40)
        derivative = profile["derivative_profile"]
        self.assertEqual(derivative["cells"], 1)
        self.assertEqual(derivative["segments_processed"], 4)
        self.assertEqual(derivative["phase_rows"]["discharge"], 40)
        self.assertAlmostEqual(derivative["stages_ms"]["segment_scan"], 4.0)
        self.assertAlmostEqual(derivative["stages_ms"]["segment_prepare"], 1.0)
        self.assertAlmostEqual(derivative["stages_ms"]["status_classification"], 2.0)
        self.assertAlmostEqual(derivative["stages_ms"]["rolling"], 3.0)
        self.assertAlmostEqual(derivative["stages_ms"]["postprocess"], 6.0)
        self.assertNotIn("path", profile)
        self.assertNotIn("transform_profile", str(profile))


if __name__ == "__main__":
    unittest.main()
