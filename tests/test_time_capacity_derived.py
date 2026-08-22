from __future__ import annotations

import json
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

from app.services import (
    cache,
    cache_maintenance,
    canonical_cycling,
    parsing,
    stitch,
    time_capacity_path,
)


def derived_frame() -> pd.DataFrame:
    cycles = [1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4]
    rows = len(cycles)
    return pd.DataFrame(
        {
            "record_index": list(range(rows)),
            "cycle": cycles,
            "step_index": [1, 1, 2, 2] * 3,
            "step": list(range(rows)),
            "status": ["CC_Chg", "CC_Chg", "CC_DChg", "CC_DChg"] * 3,
            "time_s": [float(index % 4) for index in range(rows)],
            "voltage_v": [3.0 + index / 100 for index in range(rows)],
            "current_ma": [1.0, 1.0, -1.0, -1.0] * 3,
            "charge_capacity_mah": [0.0, 1.0, 1.0, 1.0] * 3,
            "discharge_capacity_mah": [0.0, 0.0, 0.0, 1.0] * 3,
            "timestamp": pd.date_range("2026-01-01", periods=rows, freq="s"),
        }
    )


class TimeCapacityDerivedCacheTests(unittest.TestCase):
    FILE_HASH = "d" * 64
    PARSER = "nx:test:r1"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp.name)
        self.cache_patch = patch.object(cache, "CACHE_DIR", self.cache_root)
        self.cache_patch.start()
        self.row_group_patch = patch.object(cache, "RAW_CACHE_ROW_GROUP_SIZE", 4)
        self.row_group_patch.start()
        self.frame = derived_frame()
        cache._publish_optimized_raw(
            self.frame,
            cache.raw_path(self.FILE_HASH, self.PARSER),
            self.PARSER,
        )

    def tearDown(self) -> None:
        self.row_group_patch.stop()
        self.cache_patch.stop()
        self.temp.cleanup()

    def _prepare(self) -> dict:
        return cache.prepare_time_capacity_derived(self.FILE_HASH, self.PARSER)

    def test_prepared_contract_is_minimal_versioned_and_selective(self) -> None:
        result = self._prepare()
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["prepared"])
        payload = cache.time_capacity_derived_path(self.FILE_HASH, self.PARSER)
        index_path = cache.time_capacity_derived_index_path(self.FILE_HASH, self.PARSER)
        self.assertTrue(payload.is_file())
        self.assertTrue(index_path.is_file())

        index = json.loads(index_path.read_text(encoding="utf-8"))
        self.assertEqual(index["derived_cache_version"], cache.TIME_CAPACITY_DERIVED_CACHE_VERSION)
        self.assertEqual(index["parser_version"], self.PARSER)
        self.assertEqual(index["canonical_raw_version"], canonical_cycling.CANONICAL_RAW_VERSION)
        self.assertEqual(index["raw_layout_version"], cache.RAW_CACHE_LAYOUT_VERSION)
        self.assertEqual(index["row_count"], len(self.frame))
        self.assertEqual(index["row_group_count"], 3)
        self.assertNotIn("source_path", index)
        self.assertNotIn("path", index)

        import pyarrow.parquet as pq

        self.assertEqual(
            pq.read_schema(payload).names,
            ["record_index", "cycle", "phase_code", "phase_capacity_mah"],
        )
        diagnostics = cache.TimeCapacityDerivedReadDiagnostics()
        selected = cache.load_time_capacity_derived(
            self.FILE_HASH,
            self.PARSER,
            [2],
            ["phase_code"],
            diagnostics=diagnostics,
        )
        self.assertIsNotNone(selected)
        self.assertEqual(list(selected.columns), ["record_index", "cycle", "phase_code"])
        self.assertEqual(selected["record_index"].tolist(), [4, 5, 6, 7])
        self.assertEqual(diagnostics.row_groups_read, (1,))
        self.assertEqual(diagnostics.rows_read, 4)
        self.assertEqual(diagnostics.rows_returned, 4)
        self.assertEqual(diagnostics.columns_read, ("record_index", "cycle", "phase_code"))

        fake_db = MagicMock()
        fake_db.query.return_value.all.return_value = []
        with (
            patch.object(cache_maintenance, "CACHE_DIR", self.cache_root),
            patch.object(cache_maintenance, "_source_labels", return_value={}),
            patch.object(cache_maintenance, "load_policy", return_value=cache_maintenance.CachePolicy()),
        ):
            inventory = cache_maintenance.inventory(fake_db)
        scientific = inventory["categories"]["scientific"]
        directory_files = list(payload.parent.iterdir())
        self.assertEqual(scientific["files"], len(directory_files))
        self.assertEqual(scientific["bytes"], sum(path.stat().st_size for path in directory_files))

    def test_preparation_uses_cache_bytes_without_opening_or_parsing_source(self) -> None:
        with patch.object(parsing, "parse_timeseries", side_effect=AssertionError("source opened")):
            result = self._prepare()
        self.assertEqual(result["status"], "ready")
        self.assertTrue(cache.time_capacity_derived_is_current(self.FILE_HASH, self.PARSER))

    def test_identity_mismatch_fails_closed_to_fallback(self) -> None:
        self._prepare()
        index_path = cache.time_capacity_derived_index_path(self.FILE_HASH, self.PARSER)
        original = json.loads(index_path.read_text(encoding="utf-8"))
        for key, value in (
            ("parser_version", "other-parser"),
            ("calc_version", "old-calc"),
            ("derived_cache_version", 999),
            ("canonical_raw_version", 999),
            ("raw_layout_version", 999),
            ("raw_shape_fingerprint", "stale"),
            ("row_count", len(self.frame) - 1),
        ):
            mutated = dict(original)
            mutated[key] = value
            index_path.write_text(json.dumps(mutated), encoding="utf-8")
            diagnostics = cache.TimeCapacityDerivedReadDiagnostics()
            self.assertIsNone(
                cache.load_time_capacity_derived(
                    self.FILE_HASH,
                    self.PARSER,
                    [1],
                    ["phase_code"],
                    diagnostics=diagnostics,
                ),
                key,
            )
            self.assertNotEqual(diagnostics.status, "ready")
        index_path.write_text(json.dumps(original), encoding="utf-8")

    def test_raw_replacement_invalidates_prepared_artifact(self) -> None:
        self._prepare()
        payload = cache.time_capacity_derived_path(self.FILE_HASH, self.PARSER)
        index_path = cache.time_capacity_derived_index_path(self.FILE_HASH, self.PARSER)
        self.assertTrue(payload.exists())
        self.assertTrue(index_path.exists())
        replacement = self.frame.copy()
        replacement.loc[0, "voltage_v"] = 9.9
        cache._publish_optimized_raw(
            replacement,
            cache.raw_path(self.FILE_HASH, self.PARSER),
            self.PARSER,
        )
        self.assertFalse(payload.exists())
        self.assertFalse(index_path.exists())

    def test_nonwaiting_read_returns_while_preparation_owns_consistency_boundary(self) -> None:
        self._prepare()
        started = threading.Event()
        release = threading.Event()

        def hold_boundary() -> None:
            with cache._raw_layout_io_lock:
                started.set()
                release.wait(5)

        worker = threading.Thread(target=hold_boundary)
        worker.start()
        try:
            self.assertTrue(started.wait(5))
            diagnostics = cache.TimeCapacityDerivedReadDiagnostics()
            self.assertIsNone(
                cache.load_time_capacity_derived(
                    self.FILE_HASH,
                    self.PARSER,
                    [1],
                    ["phase_code"],
                    diagnostics=diagnostics,
                    wait_for_layout=False,
                )
            )
            self.assertEqual(diagnostics.status, "layout_preparing")
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())

    def test_stitched_prepared_read_maps_sparse_source_cycles_and_bounds_groups(self) -> None:
        self._prepare()
        ref = stitch.CachedSourceRef(self.FILE_HASH, self.PARSER)
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])
        diagnostics: dict = {}
        selected = time_capacity_path.load_indexed_time_capacity_derived(
            plan,
            [2],
            ["phase_code", "phase_capacity_mah"],
            diagnostics=diagnostics,
        )
        self.assertIsNotNone(selected)
        self.assertEqual(set(selected["cycle"]), {2})
        self.assertEqual(set(selected["source_cycle"]), {2})
        self.assertEqual(len(selected), 4)
        self.assertEqual(diagnostics["prepared_row_groups_read"], 1)
        self.assertEqual(diagnostics["prepared_rows_materialized"], 4)

    def test_stitched_prepared_read_can_wait_for_the_layout_boundary(self) -> None:
        self._prepare()
        ref = stitch.CachedSourceRef(self.FILE_HASH, self.PARSER)
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])

        with patch.object(cache, "load_time_capacity_derived", wraps=cache.load_time_capacity_derived) as reader:
            selected = time_capacity_path.load_indexed_time_capacity_derived(
                plan,
                [2],
                ["phase_code"],
                wait_for_layout=True,
            )

        self.assertIsNotNone(selected)
        self.assertEqual(reader.call_args.kwargs["wait_for_layout"], True)


if __name__ == "__main__":
    unittest.main()
