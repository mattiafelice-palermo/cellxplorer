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

    def test_dominant_stage_uses_direct_children_not_descendants(self) -> None:
        workload = {
            "family": "cycles",
            "forced_miss": {
                "stage_hierarchy": {
                    "scientific_compute": {
                        "inclusive_ms": 100.0,
                        "parent": None,
                    },
                    "parent_helper": {
                        "inclusive_ms": 80.0,
                        "parent": "scientific_compute",
                    },
                    "nested_child": {
                        "inclusive_ms": 70.0,
                        "parent": "parent_helper",
                    },
                    "small_sibling": {
                        "inclusive_ms": 5.0,
                        "parent": "scientific_compute",
                    },
                }
            },
        }
        self.assertEqual(profiler._dominant_stage(workload), ("parent_helper", 80.0))

        unresolved = {
            **workload,
            "forced_miss": {
                "stage_hierarchy": {
                    "scientific_compute": {"inclusive_ms": 100.0, "parent": None},
                    "small_helper": {
                        "inclusive_ms": 20.0,
                        "parent": "scientific_compute",
                    },
                }
            },
        }
        self.assertEqual(
            profiler._dominant_stage(unresolved),
            ("unresolved scientific compute residual", 80.0),
        )

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
                    "stages_ms": {
                        "execution_extraction": 5.0,
                        "measurement_filtering_grouping": 1.0,
                        "execution_phase_row_filtering": 1.0,
                        "execution_cutoff_validation": 1.0,
                        "capacity_extraction": 0.5,
                        "current_extraction": 0.5,
                        "rate_normalization": 0.5,
                    },
                    "calls": {"execution_extraction": 2},
                    "counts": {"rate_pairs": 3},
                },
                "taxonomy_stage_ms": {},
            }
        ])
        self.assertIsNotNone(profile)
        required = profile["required_decomposition"]
        self.assertEqual(required["execution_phase_row_filtering"]["p50_ms"], 1.0)
        self.assertEqual(required["execution_cutoff_validation"]["p50_ms"], 1.0)
        self.assertEqual(required["capacity_extraction"]["p50_ms"], 0.5)
        self.assertIn("invalid_neighbour_execution_validation", required)
        self.assertEqual(
            profile["execution_extraction_reconciliation"]["p50_child_sum_ms"],
            4.5,
        )
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

    def test_real_five_family_routes_emit_common_profile_and_sql_contract(self) -> None:
        with profiler.GoldenFixtureEnvironment.create() as env:
            for family in profiler.FAMILIES:
                analysis_id, _cell_ids = profiler._family_workload(env, family, 1)
                with tempfile.TemporaryDirectory() as root:
                    payload, metrics = profiler._profile_route(
                        env,
                        analysis_id,
                        family,
                        recompute=True,
                        cache_root=Path(root),
                        instrumented=True,
                    )
                self.assertEqual(metrics["cache_status"], "miss")
                self.assertTrue(metrics["scientific_digest"])
                self.assertIn("scientific_compute", metrics["stage_hierarchy"])
                self.assertIn("sql", metrics)
                self.assertIsInstance(metrics["sql"]["statement_count"], (int, float))
                summary = profiler._summarize_samples([metrics], family)
                self.assertTrue(summary["sql"]["available"])
                self.assertIsInstance(summary["sql"]["statement_count"]["p50"], float)
                self.assertEqual(summary["series_order"], profiler._series_order(payload))

    def test_real_exact_hit_bypasses_family_compute_and_raw_reads_and_restores_patches(self) -> None:
        from app.services import analysis_cache, analysis_engine

        original_result_key = analysis_cache.result_key
        original_resolve_selection = analysis_engine.resolve_selection
        with profiler.GoldenFixtureEnvironment.create() as env:
            analysis_id, _cell_ids = profiler._family_workload(env, "cycles", 1)
            with tempfile.TemporaryDirectory() as root:
                cache_root = Path(root)
                warm_payload, _warm = profiler._profile_route_simple(
                    env,
                    analysis_id,
                    "cycles",
                    recompute=True,
                    cache_root=cache_root,
                )
                hit_payload, hit = profiler._profile_route(
                    env,
                    analysis_id,
                    "cycles",
                    recompute=False,
                    cache_root=cache_root,
                    instrumented=True,
                )
            self.assertTrue(profiler._exact_hit_is_clean(hit))
            self.assertEqual(hit["calls"].get("scientific_compute", 0), 0)
            self.assertEqual(hit["counts"].get("raw_load_calls", 0), 0)
            self.assertEqual(profiler._digest(warm_payload), profiler._digest(hit_payload))
        self.assertIs(analysis_cache.result_key, original_result_key)
        self.assertIs(analysis_engine.resolve_selection, original_resolve_selection)

    def test_real_clone_workload_has_distinct_relational_and_cache_identity(self) -> None:
        from app.models import Analysis, Cell, TestFile
        from app.services import analysis_engine, cache, parsing

        with profiler.GoldenFixtureEnvironment.create() as env:
            cell_ids = profiler._clone_cells(env, "cycles", 101, 6)
            source_hashes = []
            for cell_id in cell_ids:
                _hashes, files = analysis_engine.cell_ordered_hashes(
                    env.db,
                    env.db.get(Cell, cell_id),
                )
                self.assertEqual(len(files), 1)
                source_hashes.append(files[0].hash)
                self.assertTrue(
                    cache.raw_path(
                        files[0].hash,
                        parsing.current_parser_identity_for_extension(files[0].ext)
                        or files[0].parser_version,
                    ).exists()
                )
                self.assertTrue(
                    env.db.query(TestFile).filter(TestFile.file_id == files[0].id).first()
                )
            self.assertEqual(len(set(source_hashes)), 6)
            case_id, _ = profiler.FAMILY_CASES["cycles"]
            spec = profiler._scaled_spec(
                profiler.load_case_spec(env.root, profiler._case(env.manifest, case_id)),
                "cycles",
                cell_ids,
            )
            analysis = Analysis(title="050.17 clone contract", spec=spec)
            env.db.add(analysis)
            env.db.commit()
            analysis_id = analysis.id
            with tempfile.TemporaryDirectory() as root:
                _payload, metrics = profiler._profile_route(
                    env,
                    analysis_id,
                    "cycles",
                    recompute=True,
                    cache_root=Path(root),
                    instrumented=True,
                )
            self.assertEqual(metrics["counts"]["resolved_cells"], 6)
            self.assertEqual(metrics["counts"]["source_hashes"], 6)

    def test_real_rate_deep_profile_contains_measured_children_and_reconciliation(self) -> None:
        with profiler.GoldenFixtureEnvironment.create() as env:
            analysis_id, _cell_ids = profiler._family_workload(env, "rate_capability", 1)
            with tempfile.TemporaryDirectory() as root:
                _payload, metrics = profiler._profile_route(
                    env,
                    analysis_id,
                    "rate_capability",
                    recompute=True,
                    cache_root=Path(root),
                    instrumented=True,
                )
            raw_deep = metrics["rate_deep"]
            deep = profiler._rate_deep_summary([metrics])
            self.assertIsNotNone(deep)
            for name in profiler.RATE_EXECUTION_CHILDREN:
                self.assertIn(name, deep["stages_ms"])
                self.assertIsInstance(deep["stages_ms"][name]["p50"], float)
                self.assertGreaterEqual(deep["stages_ms"][name]["calls_p50"], 0.0)
            self.assertTrue(
                deep["execution_extraction_reconciliation"]["all_non_overlapping"]
            )
            self.assertIn("execution_index_building", deep["stages_ms"])
            self.assertGreaterEqual(
                deep["stages_ms"]["execution_index_building"]["calls_p50"],
                1.0,
            )
            self.assertIn("measurement_groups", raw_deep["counts"])
            self.assertIn("execution_rows", raw_deep["counts"])


if __name__ == "__main__":
    unittest.main()
