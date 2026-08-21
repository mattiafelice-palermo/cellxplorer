"""Indexed Time/Capacity source planning and selective-read tests (Spec 050.3)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import cache, canonical_cycling, stitch, time_capacity_path


def raw_frame(labels: list[int], *, rows_per_cycle: int = 3) -> pd.DataFrame:
    cycles = [label for label in labels for _ in range(rows_per_cycle)]
    rows = len(cycles)
    frame = pd.DataFrame(
        {
            "record_index": range(rows),
            "cycle": cycles,
            "step_index": [1 + index % 2 for index in range(rows)],
            "step": [index % 2 for index in range(rows)],
            "status": ["CC_Chg"] * rows,
            "time_s": [float(index % rows_per_cycle) for index in range(rows)],
            "voltage_v": [3.0 + index / 1000 for index in range(rows)],
            "current_ma": [1.0] * rows,
            "charge_capacity_mah": [float(index) for index in range(rows)],
            "discharge_capacity_mah": [0.0] * rows,
            "timestamp": pd.date_range("2026-01-01", periods=rows, freq="s"),
        }
    )
    return frame


class TimeCapacityPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp.name)
        self.cache_patch = patch.object(cache, "CACHE_DIR", self.cache_root)
        self.cache_patch.start()
        self.row_group_patch = patch.object(cache, "RAW_CACHE_ROW_GROUP_SIZE", 4)
        self.row_group_patch.start()

    def tearDown(self) -> None:
        self.row_group_patch.stop()
        self.cache_patch.stop()
        self.temp.cleanup()

    def _publish(
        self,
        file_hash: str,
        parser_version: str,
        labels: list[int],
    ) -> stitch.CachedSourceRef:
        frame = raw_frame(labels)
        target = cache.raw_path(file_hash, parser_version)
        cache._publish_optimized_raw(frame, target, parser_version)
        return stitch.CachedSourceRef(file_hash, parser_version)

    def test_projection_is_explicit_and_excludes_unused_timestamp(self) -> None:
        available = list(canonical_cycling.REQUIRED_CYCLING_COLUMNS) + [
            "working_potential_v",
            "counter_potential_v",
            "timestamp",
            "charge_energy_mwh",
        ]
        self.assertEqual(
            time_capacity_path.time_capacity_raw_columns(available),
            [
                *canonical_cycling.REQUIRED_CYCLING_COLUMNS,
                "working_potential_v",
                "counter_potential_v",
            ],
        )

    def test_sparse_local_labels_remain_dense_global_labels(self) -> None:
        ref = self._publish("a" * 64, "parser-a", [1, 2, 4])
        diagnostics: dict = {}
        plan = time_capacity_path.build_time_capacity_stitch_plan(
            [ref], diagnostics=diagnostics
        )
        self.assertEqual([1, 2, 3], list(plan.sources[0].cycle_map.values()))

        requested = time_capacity_path.requested_global_cycles(
            plan,
            explicit_cycles=[3],
            cycle_start=1,
            cycle_end=None,
        )
        selected = time_capacity_path.load_indexed_time_capacity_raw(
            plan, requested, diagnostics=diagnostics
        )
        self.assertIsNotNone(selected)
        self.assertEqual(set(selected["cycle"]), {3})
        self.assertEqual(set(selected["source_cycle"]), {4})
        self.assertEqual(diagnostics["source_reads"][0]["requested_source_cycles"], [4])
        self.assertEqual(diagnostics["selected_rows"], 3)

    def test_later_source_request_does_not_read_earlier_source(self) -> None:
        first = self._publish("b" * 64, "parser-a", [1, 2])
        second = self._publish("c" * 64, "parser-b", [7, 9])
        plan = time_capacity_path.build_time_capacity_stitch_plan([first, second])
        self.assertEqual(plan.path, "indexed")

        with patch.object(cache, "load_raw_cycles", wraps=cache.load_raw_cycles) as reader:
            selected = time_capacity_path.load_indexed_time_capacity_raw(plan, [3])

        self.assertIsNotNone(selected)
        self.assertEqual(list(selected["cycle"].unique()), [3])
        self.assertEqual(list(selected["source_cycle"].unique()), [7])
        self.assertEqual(reader.call_count, 1)
        self.assertEqual(reader.call_args.args[0], second.file_hash)
        self.assertEqual(reader.call_args.args[2], (7,))

    def test_range_crossing_boundary_reads_only_contributing_sources(self) -> None:
        first = self._publish("d" * 64, "parser-a", [1, 2])
        second = self._publish("e" * 64, "parser-b", [7, 9])
        plan = time_capacity_path.build_time_capacity_stitch_plan([first, second])
        diagnostics: dict = {}
        selected = time_capacity_path.load_indexed_time_capacity_raw(
            plan, [2, 3], diagnostics=diagnostics
        )

        self.assertIsNotNone(selected)
        self.assertEqual(list(selected["cycle"].unique()), [2, 3])
        self.assertEqual(list(selected["segment"].unique()), [0, 1])
        self.assertEqual(
            [item["requested_source_cycles"] for item in diagnostics["source_reads"]],
            [[2], [7]],
        )

    def test_missing_middle_source_fails_closed_and_skips_suffix(self) -> None:
        first = self._publish("f" * 64, "parser-a", [1, 2])
        missing = stitch.CachedSourceRef("1" * 64, "parser-missing")
        third = self._publish("2" * 64, "parser-c", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([first, missing, third])

        self.assertEqual(plan.path, "missing")
        self.assertEqual(plan.missing, [missing.file_hash])
        self.assertEqual(plan.missing_positions, [1])
        self.assertEqual(plan.skipped_segments, [2])
        self.assertEqual([segment["segment"] for segment in plan.segments], [0])

        with patch.object(cache, "load_raw_cycles") as reader:
            selected = time_capacity_path.load_indexed_time_capacity_raw(plan, [1, 2, 3])
        self.assertIsNotNone(selected)
        self.assertTrue(selected.empty)
        self.assertFalse(stitch.stitch_metadata(selected)["complete"])
        reader.assert_not_called()

    def test_valid_legacy_raw_without_index_uses_legacy_fallback(self) -> None:
        file_hash = "3" * 64
        parser_version = "legacy-parser"
        target = cache.raw_path(file_hash, parser_version)
        target.parent.mkdir(parents=True, exist_ok=True)
        raw_frame([1, 2]).to_parquet(target, index=False)

        plan = time_capacity_path.build_time_capacity_stitch_plan(
            [stitch.CachedSourceRef(file_hash, parser_version)]
        )

        self.assertEqual(plan.path, "legacy")
        self.assertEqual(plan.fallback_reason, "raw_layout_unavailable")
        self.assertEqual(plan.missing, [])

    def test_unknown_requested_cycles_do_not_fabricate_rows(self) -> None:
        ref = self._publish("4" * 64, "parser-a", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])
        diagnostics: dict = {}
        selected = time_capacity_path.load_indexed_time_capacity_raw(
            plan, [99], diagnostics=diagnostics
        )

        self.assertIsNotNone(selected)
        self.assertTrue(selected.empty)
        self.assertTrue(stitch.stitch_metadata(selected)["complete"])
        self.assertEqual(diagnostics["selected_rows"], 0)


class IndexedLegacyTimeCapacityParityTests(unittest.TestCase):
    def test_golden_time_capacity_result_is_equal_on_both_access_paths(self) -> None:
        sys.path.insert(0, str(ROOT / "tests"))
        from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec

        root = ROOT / "tests" / "fixtures" / "golden_analysis"

        def strip_volatile(value):
            if isinstance(value, dict):
                return {
                    key: strip_volatile(item)
                    for key, item in value.items()
                    if key not in {"computed_at", "current_parser_version", "current_calc_version"}
                }
            if isinstance(value, list):
                return [strip_volatile(item) for item in value]
            return value

        with GoldenFixtureEnvironment.create() as environment:
            from app.services import analysis_engine, cache as active_cache

            for case_id, cycle_end in (
                ("time_capacity_baseline", 3),
                ("time_capacity_derivative", 3),
                ("time_capacity_baseline", None),
            ):
                case = {
                    "id": case_id,
                    "kind": "time_capacity",
                    "spec_path": f"specs/{case_id}.json",
                }
                spec = load_case_spec(root, case)
                spec["computation"]["time_capacity"]["cycle_end"] = cycle_end
                indexed = analysis_engine.compute_time_capacity(
                    environment.db,
                    spec,
                    None,
                    precision="full",
                    compact=False,
                )
                with patch.object(active_cache, "load_raw_layout_index", return_value=None):
                    legacy = analysis_engine.compute_time_capacity(
                        environment.db,
                        deepcopy(spec),
                        None,
                        precision="full",
                        compact=False,
                    )
                with self.subTest(case=case_id, cycle_end=cycle_end):
                    self.assertEqual(strip_volatile(indexed), strip_volatile(legacy))


if __name__ == "__main__":
    unittest.main()
