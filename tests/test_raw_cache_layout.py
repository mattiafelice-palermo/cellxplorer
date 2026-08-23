from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import cache, cache_maintenance, calc, canonical_cycling, parsing


def canonical_frame() -> pd.DataFrame:
    cycles = [1, 1, 1, 1, 1, 2, 2, 4, 4, 4, 4, 4]
    rows = len(cycles)
    return pd.DataFrame(
        {
            "record_index": range(rows),
            "cycle": cycles,
            "step_index": [1] * rows,
            "step": list(range(rows)),
            "status": ["CC_Chg"] * rows,
            "time_s": [float(index) for index in range(rows)],
            "voltage_v": [3.0 + index / 100 for index in range(rows)],
            "current_ma": [1.0] * rows,
            "charge_capacity_mah": [float(index) for index in range(rows)],
            "discharge_capacity_mah": [0.0] * rows,
            "charge_energy_mwh": [float(index) for index in range(rows)],
            "discharge_energy_mwh": [0.0] * rows,
            "timestamp": pd.date_range("2026-01-01", periods=rows, freq="s"),
        }
    )


class RawCacheLayoutTests(unittest.TestCase):
    FILE_HASH = "a" * 64
    PARSER = "nx:test:r1"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp.name)
        self.cache_dir_patch = patch.object(cache, "CACHE_DIR", self.cache_root)
        self.cache_dir_patch.start()
        self.row_group_patch = patch.object(cache, "RAW_CACHE_ROW_GROUP_SIZE", 4)
        self.row_group_patch.start()

    def tearDown(self) -> None:
        self.row_group_patch.stop()
        self.cache_dir_patch.stop()
        self.temp.cleanup()

    def _indexed(self, frame: pd.DataFrame | None = None) -> dict:
        frame = frame if frame is not None else canonical_frame()
        target = cache.raw_path(self.FILE_HASH, self.PARSER)
        return cache._publish_optimized_raw(frame, target, self.PARSER)

    def _legacy(self, frame: pd.DataFrame | None = None) -> Path:
        frame = frame if frame is not None else canonical_frame()
        target = cache.raw_path(self.FILE_HASH, self.PARSER)
        target.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(target, index=False)
        return target

    def test_index_records_exact_cycles_groups_voltage_and_timestamps(self) -> None:
        index = self._indexed()

        self.assertEqual(index["layout_version"], cache.RAW_CACHE_LAYOUT_VERSION)
        self.assertEqual(index["parser_version"], self.PARSER)
        self.assertEqual(index["canonical_raw_version"], canonical_cycling.CANONICAL_RAW_VERSION)
        self.assertEqual(index["observed_source_cycles"], [1, 2, 4])
        self.assertEqual(index["raw_row_count"], 12)
        self.assertEqual(index["raw_row_group_count"], 3)
        self.assertEqual(index["cycle_to_row_groups"]["1"], [0, 1])
        self.assertEqual(index["cycle_to_row_groups"]["2"], [1])
        self.assertEqual(index["cycle_to_row_groups"]["4"], [1, 2])
        self.assertEqual(index["row_groups"][1]["source_cycles"], [1, 2, 4])
        self.assertTrue(index["voltage_data_availability"]["voltage_v"])
        self.assertFalse(index["voltage_data_availability"]["working_potential_v"])
        self.assertFalse(index["voltage_data_availability"]["counter_potential_v"])
        self.assertEqual(index["timestamp_start"], "2026-01-01T00:00:00")
        self.assertEqual(index["timestamp_end"], "2026-01-01T00:00:11")
        self.assertEqual(index["consecutive_time"]["reset_total_s"], 0.0)
        self.assertEqual(
            index["consecutive_time"]["cycle_starts"]["2"],
            {"raw_time_s": 5.0, "reset_offset_s": 0.0},
        )
        self.assertEqual(cache.raw_layout_status(self.FILE_HASH, self.PARSER), "ready")

    def test_new_cache_build_writes_indexed_raw_without_changing_calc_content(self) -> None:
        frame = canonical_frame()
        identity = parsing.parser_identity("prepared.ndax")
        with patch.object(parsing, "parse_timeseries", return_value=frame):
            info = cache.build(self.FILE_HASH, "prepared.ndax")

        self.assertEqual(info["rows"], len(frame))
        self.assertTrue(cache.raw_index_path(self.FILE_HASH, identity).exists())
        optimized = cache.load_raw(self.FILE_HASH, identity)
        pd.testing.assert_frame_equal(optimized, frame, check_dtype=False)
        pd.testing.assert_frame_equal(
            calc.per_cycle(optimized),
            calc.per_cycle(frame),
            check_dtype=False,
        )

    def test_voltage_availability_distinguishes_absent_null_and_finite(self) -> None:
        absent = self._indexed(canonical_frame())
        self.assertFalse(absent["voltage_data_availability"]["working_potential_v"])

        all_null = canonical_frame()
        all_null["working_potential_v"] = [None] * len(all_null)
        all_null_index = self._indexed(all_null)
        self.assertFalse(all_null_index["voltage_data_availability"]["working_potential_v"])

        finite = canonical_frame()
        finite["working_potential_v"] = [0.1] + [None] * (len(finite) - 1)
        finite_index = self._indexed(finite)
        self.assertTrue(finite_index["voltage_data_availability"]["working_potential_v"])

        no_timestamps = canonical_frame().drop(columns=["timestamp"])
        no_timestamp_index = self._indexed(no_timestamps)
        self.assertIsNone(no_timestamp_index["timestamp_start"])
        self.assertIsNone(no_timestamp_index["timestamp_end"])

    def test_selective_reader_deduplicates_groups_filters_neighbors_and_preserves_order(self) -> None:
        full = canonical_frame()
        self._indexed(full)

        diagnostics = cache.RawCycleReadDiagnostics()
        selected = cache.load_raw_cycles(
            self.FILE_HASH,
            self.PARSER,
            [2],
            ["record_index", "voltage_v"],
            diagnostics=diagnostics,
        )
        self.assertIsNotNone(selected)
        expected = full.loc[full["cycle"] == 2, ["record_index", "voltage_v"]].reset_index(drop=True)
        pd.testing.assert_frame_equal(selected, expected, check_dtype=False)
        self.assertEqual(diagnostics.status, "ready")
        self.assertEqual(diagnostics.row_groups_read, (1,))
        self.assertEqual(diagnostics.rows_read, 4)
        self.assertEqual(diagnostics.rows_returned, 2)
        self.assertEqual(diagnostics.columns_read, ("record_index", "voltage_v", "cycle"))

        range_diagnostics = cache.RawCycleReadDiagnostics()
        range_result = cache.load_raw_cycles(
            self.FILE_HASH,
            self.PARSER,
            [1, 2],
            ["cycle", "record_index"],
            diagnostics=range_diagnostics,
        )
        expected_range = full.loc[full["cycle"].isin([1, 2]), ["cycle", "record_index"]].reset_index(drop=True)
        pd.testing.assert_frame_equal(range_result, expected_range, check_dtype=False)
        self.assertEqual(range_diagnostics.row_groups_read, (0, 1))
        self.assertEqual(range_diagnostics.rows_read, 8)

        non_contiguous = cache.load_raw_cycles(
            self.FILE_HASH,
            self.PARSER,
            [4, 1, 4],
            ["record_index", "cycle"],
        )
        expected_non_contiguous = full.loc[full["cycle"].isin([1, 4]), ["record_index", "cycle"]].reset_index(drop=True)
        pd.testing.assert_frame_equal(non_contiguous, expected_non_contiguous, check_dtype=False)

        unknown_diagnostics = cache.RawCycleReadDiagnostics()
        unknown = cache.load_raw_cycles(
            self.FILE_HASH,
            self.PARSER,
            [3],
            ["record_index"],
            diagnostics=unknown_diagnostics,
        )
        self.assertEqual(list(unknown.columns), ["record_index"])
        self.assertTrue(unknown.empty)
        self.assertEqual(unknown_diagnostics.row_groups_read, ())
        self.assertEqual(unknown_diagnostics.rows_read, 0)

    def test_legacy_readers_work_and_selective_reader_reports_layout_unavailable(self) -> None:
        frame = canonical_frame()
        self._legacy(frame)

        pd.testing.assert_frame_equal(
            cache.load_raw(self.FILE_HASH, self.PARSER),
            frame,
            check_dtype=False,
        )
        projected = cache.load_raw_columns(
            self.FILE_HASH,
            self.PARSER,
            ["cycle", "voltage_v"],
        )
        self.assertEqual(list(projected.columns), ["cycle", "voltage_v"])
        diagnostics = cache.RawCycleReadDiagnostics()
        self.assertIsNone(
            cache.load_raw_cycles(
                self.FILE_HASH,
                self.PARSER,
                [1],
                ["voltage_v"],
                diagnostics=diagnostics,
            )
        )
        self.assertEqual(diagnostics.status, "layout_unavailable")

    def test_legacy_conversion_uses_cache_bytes_and_publishes_raw_before_index(self) -> None:
        frame = canonical_frame()
        raw_target = self._legacy(frame)
        index_target = cache.raw_index_path(self.FILE_HASH, self.PARSER)
        replacements: list[str] = []
        original_replace = cache.os.replace

        def record_replace(source: str | os.PathLike[str], destination: str | os.PathLike[str]):
            replacements.append(Path(destination).name)
            return original_replace(source, destination)

        with patch.object(cache.os, "replace", side_effect=record_replace):
            result = cache.prepare_raw_layout(self.FILE_HASH, self.PARSER)

        self.assertTrue(result["prepared"])
        self.assertTrue(raw_target.exists())
        self.assertTrue(index_target.exists())
        self.assertLess(replacements.index(raw_target.name), replacements.index(index_target.name))
        optimized = cache.load_raw(self.FILE_HASH, self.PARSER)
        pd.testing.assert_frame_equal(optimized, frame, check_dtype=False)
        pd.testing.assert_frame_equal(
            calc.per_cycle(optimized),
            calc.per_cycle(frame),
            check_dtype=False,
        )
        self.assertEqual(list(raw_target.parent.glob("*.tmp-*")), [])
        self.assertEqual(list(raw_target.parent.glob("*.candidate-*")), [])

    def test_failed_conversion_keeps_legacy_raw_and_leaves_no_index_or_temps(self) -> None:
        frame = canonical_frame()
        raw_target = self._legacy(frame)
        original_bytes = raw_target.read_bytes()

        with patch.object(cache, "_write_raw_parquet", side_effect=OSError("candidate failed")):
            with self.assertRaises(OSError):
                cache.prepare_raw_layout(self.FILE_HASH, self.PARSER)

        self.assertEqual(raw_target.read_bytes(), original_bytes)
        self.assertFalse(cache.raw_index_path(self.FILE_HASH, self.PARSER).exists())
        self.assertEqual(list(raw_target.parent.glob("*.tmp-*")), [])
        self.assertEqual(list(raw_target.parent.glob("*.candidate-*")), [])
        pd.testing.assert_frame_equal(cache.load_raw(self.FILE_HASH, self.PARSER), frame, check_dtype=False)

    def test_stale_or_corrupt_index_fails_safe_without_partial_rows_or_parser_fallback(self) -> None:
        frame = canonical_frame()
        self._indexed(frame)
        raw_target = cache.raw_path(self.FILE_HASH, self.PARSER)
        replacement = frame.iloc[:-1].copy()
        replacement.to_parquet(raw_target, index=False)
        diagnostics = cache.RawCycleReadDiagnostics()
        self.assertIsNone(
            cache.load_raw_cycles(
                self.FILE_HASH,
                self.PARSER,
                [1],
                ["record_index"],
                diagnostics=diagnostics,
            )
        )
        self.assertEqual(diagnostics.status, "invalid_index")
        self.assertEqual(cache.raw_layout_status(self.FILE_HASH, self.PARSER), "invalid")

        other_parser = "nx:other:r1"
        other_diagnostics = cache.RawCycleReadDiagnostics()
        self.assertIsNone(
            cache.load_raw_cycles(
                self.FILE_HASH,
                other_parser,
                [1],
                ["record_index"],
                diagnostics=other_diagnostics,
            )
        )
        self.assertEqual(other_diagnostics.status, "missing")

        raw_target.unlink()
        raw_target = self._legacy(frame)
        cache.raw_index_path(self.FILE_HASH, self.PARSER).write_text("{not json", encoding="utf-8")
        corrupt_diagnostics = cache.RawCycleReadDiagnostics()
        self.assertIsNone(
            cache.load_raw_cycles(
                self.FILE_HASH,
                self.PARSER,
                [1],
                ["record_index"],
                diagnostics=corrupt_diagnostics,
            )
        )
        self.assertEqual(corrupt_diagnostics.status, "invalid_index")
        self.assertIsNotNone(cache.load_raw(self.FILE_HASH, self.PARSER))

    def test_layout_predicate_and_inventory_include_sidecar_bytes(self) -> None:
        frame = canonical_frame()
        self._legacy(frame)
        self.assertFalse(cache.raw_layout_is_current(self.FILE_HASH, self.PARSER))
        cache.prepare_raw_layout(self.FILE_HASH, self.PARSER)
        self.assertTrue(cache.raw_layout_is_current(self.FILE_HASH, self.PARSER))

        fake_db = MagicMock()
        fake_db.query.return_value.all.return_value = []
        with (
            patch.object(cache_maintenance, "CACHE_DIR", self.cache_root),
            patch.object(cache_maintenance, "_source_labels", return_value={}),
            patch.object(cache_maintenance, "load_policy", return_value=cache_maintenance.CachePolicy()),
        ):
            inventory = cache_maintenance.inventory(fake_db)
        scientific_dir = inventory["categories"]["scientific"]
        self.assertEqual(scientific_dir["files"], 2)
        self.assertEqual(
            scientific_dir["bytes"],
            sum(path.stat().st_size for path in cache.raw_path(self.FILE_HASH, self.PARSER).parent.iterdir()),
        )

    def test_conversion_protection_is_visible_to_cleanup_boundary(self) -> None:
        frame = canonical_frame()
        self._legacy(frame)
        started = threading.Event()
        release = threading.Event()
        original_publish = cache._publish_optimized_raw

        def blocking_publish(*args, **kwargs):
            started.set()
            release.wait(5)
            return original_publish(*args, **kwargs)

        with patch.object(cache, "_publish_optimized_raw", side_effect=blocking_publish):
            worker = threading.Thread(
                target=cache.prepare_raw_layout,
                args=(self.FILE_HASH, self.PARSER),
            )
            worker.start()
            self.assertTrue(started.wait(5))
            self.assertIn(self.FILE_HASH, cache.pending_hashes())
            release.set()
            worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertTrue(cache.raw_layout_is_current(self.FILE_HASH, self.PARSER))


if __name__ == "__main__":
    unittest.main()
