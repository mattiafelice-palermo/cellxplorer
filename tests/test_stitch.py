import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import stitch


def _hash(label: str) -> str:
    return (label * 32)[:64]


def _cycle_frame(cycles: list[int | float | str]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "cycle": cycles,
            "discharge_capacity_mah": [1.0] * len(cycles),
        }
    )


def _raw_frame(
    cycles: list[int],
    *,
    record_indices: list[int] | None = None,
) -> pd.DataFrame:
    rows: list[dict] = []
    for index, cycle in enumerate(cycles):
        record_index = record_indices[index] if record_indices is not None else index + 1
        rows.append(
            {
                "record_index": record_index,
                "cycle": cycle,
                "status": "CC_DChg",
            }
        )
    return pd.DataFrame(rows)


class StitchServiceTests(unittest.TestCase):
    PARSER = "test-parser"
    CALC = "1.6.1"

    def _stitch_cycles(self, ordered: list[str], frames: dict[str, pd.DataFrame | None]):
        with patch(
            "app.services.stitch.cache.load_cycles",
            side_effect=lambda h, _p, _c: frames.get(h),
        ):
            return stitch.stitch_cycles(ordered, self.PARSER, self.CALC)

    def _stitch_raw(self, ordered: list[str], frames: dict[str, pd.DataFrame | None]):
        with patch(
            "app.services.stitch.cache.load_raw",
            side_effect=lambda h, _p: frames.get(h),
        ):
            return stitch.stitch_raw(ordered, self.PARSER)

    def test_two_sources_map_to_dense_global_cycles(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        result, segments, missing = self._stitch_cycles(
            [hash_a, hash_b],
            {
                hash_a: _cycle_frame([1, 2, 3]),
                hash_b: _cycle_frame([1, 2]),
            },
        )

        self.assertEqual(missing, [])
        self.assertEqual(result["cycle"].tolist(), [1, 2, 3, 4, 5])
        self.assertEqual(result["source_cycle"].tolist(), [1, 2, 3, 1, 2])
        self.assertEqual(result["segment"].tolist(), [0, 0, 0, 1, 1])
        self.assertEqual(result["source_hash"].tolist(), [hash_a] * 3 + [hash_b] * 2)
        self.assertTrue(result.attrs["stitch_complete"])
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["cycle_start"], 1)
        self.assertEqual(segments[0]["cycle_end"], 3)
        self.assertEqual(segments[1]["cycle_start"], 4)
        self.assertEqual(segments[1]["cycle_end"], 5)

    def test_non_contiguous_local_labels_do_not_invent_cycles(self):
        hash_a = _hash("g")
        result, segments, missing = self._stitch_cycles(
            [hash_a],
            {hash_a: _cycle_frame([7, 8, 10])},
        )

        self.assertEqual(missing, [])
        self.assertEqual(result["cycle"].tolist(), [1, 2, 3])
        self.assertEqual(result["source_cycle"].tolist(), [7, 8, 10])
        self.assertEqual(segments[0]["source_cycle_count"], 3)
        self.assertEqual(segments[0]["cycle_end"], 3)

    def test_second_source_starts_after_previous_dense_count(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        for first_labels, second_labels, expected in (
            ([1, 2, 3], [0, 1], [1, 2, 3, 4, 5]),
            ([1, 2, 3], [1, 2], [1, 2, 3, 4, 5]),
            ([1, 2, 3], [7, 8], [1, 2, 3, 4, 5]),
        ):
            with self.subTest(first=first_labels, second=second_labels):
                result, _, _ = self._stitch_cycles(
                    [hash_a, hash_b],
                    {
                        hash_a: _cycle_frame(first_labels),
                        hash_b: _cycle_frame(second_labels),
                    },
                )
                self.assertEqual(result["cycle"].tolist(), expected)

    def test_raw_stitching_matches_cycle_mapping(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        cycle_frames = {
            hash_a: _cycle_frame([1, 2, 3]),
            hash_b: _cycle_frame([1, 2]),
        }
        raw_frames = {
            hash_a: _raw_frame([1, 2, 3]),
            hash_b: _raw_frame([1, 2]),
        }

        cycle_result, _, _ = self._stitch_cycles([hash_a, hash_b], cycle_frames)
        raw_result, _, _ = self._stitch_raw([hash_a, hash_b], raw_frames)

        self.assertEqual(
            raw_result[["cycle", "source_cycle", "segment", "source_hash"]].to_dict("list"),
            cycle_result[["cycle", "source_cycle", "segment", "source_hash"]].to_dict("list"),
        )
        self.assertEqual(raw_result.loc[raw_result["segment"] == 0, "record_index"].tolist(), [1, 2, 3])
        self.assertEqual(raw_result.loc[raw_result["segment"] == 1, "record_index"].tolist(), [1, 2])

    def test_incomplete_final_raw_cycle_stays_separate_global_cycle(self):
        hash_a = _hash("x")
        raw = pd.DataFrame(
            {
                "record_index": [1, 2, 3, 4, 5],
                "cycle": [1, 1, 2, 2, 3],
                "status": ["CC_DChg"] * 5,
            }
        )
        raw_result, segments, missing = self._stitch_raw([hash_a], {hash_a: raw})

        self.assertEqual(missing, [])
        self.assertEqual(raw_result["cycle"].tolist(), [1, 1, 2, 2, 3])
        self.assertEqual(raw_result["source_cycle"].tolist(), [1, 1, 2, 2, 3])
        self.assertEqual(segments[0]["source_cycle_count"], 3)
        self.assertEqual(segments[0]["cycle_end"], 3)

    def test_missing_middle_source_fails_closed(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        hash_c = _hash("c")
        result, segments, missing = self._stitch_cycles(
            [hash_a, hash_b, hash_c],
            {
                hash_a: _cycle_frame([1, 2]),
                hash_b: None,
                hash_c: _cycle_frame([1, 2]),
            },
        )

        self.assertEqual(missing, [hash_b])
        self.assertEqual(result.attrs["missing_positions"], [1])
        self.assertEqual(result.attrs["skipped_segments"], [2])
        self.assertFalse(result.attrs["stitch_complete"])
        self.assertEqual(result["cycle"].tolist(), [1, 2])
        self.assertTrue((result["segment"] == 0).all())
        self.assertEqual(len(segments), 1)

    def test_missing_leading_source_yields_empty_frame(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        result, segments, missing = self._stitch_cycles(
            [hash_a, hash_b],
            {
                hash_a: None,
                hash_b: _cycle_frame([1, 2]),
            },
        )

        self.assertEqual(missing, [hash_a])
        self.assertTrue(result.empty)
        self.assertEqual(result.attrs["missing_positions"], [0])
        self.assertEqual(result.attrs["skipped_segments"], [1])
        self.assertEqual(segments, [])

    def test_empty_source_and_empty_input_are_stable(self):
        hash_a = _hash("a")
        empty = pd.DataFrame(columns=["cycle", "discharge_capacity_mah"])
        result, segments, missing = self._stitch_cycles([hash_a], {hash_a: empty})
        self.assertTrue(result.empty)
        self.assertEqual(missing, [])
        self.assertTrue(result.attrs["stitch_complete"])
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["source_cycle_count"], 0)
        self.assertIsNone(segments[0]["cycle_start"])

        empty_result, empty_segments, empty_missing = self._stitch_cycles([], {})
        self.assertTrue(empty_result.empty)
        self.assertEqual(empty_segments, [])
        self.assertEqual(empty_missing, [])
        self.assertTrue(empty_result.attrs["stitch_complete"])

    def test_non_numeric_cycles_fail_closed(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        result, segments, missing = self._stitch_cycles(
            [hash_a, hash_b],
            {
                hash_a: _cycle_frame([1, 2, "bad"]),
                hash_b: _cycle_frame([1, 2]),
            },
        )

        self.assertEqual(missing, [hash_a])
        self.assertEqual(result.attrs["missing_positions"], [0])
        self.assertEqual(result.attrs["skipped_segments"], [1])
        self.assertTrue(result.empty)
        self.assertEqual(segments, [])

    def test_single_source_contiguous_cycles_unchanged(self):
        hash_a = _hash("s")
        labels = list(range(1, 51))
        result, segments, missing = self._stitch_cycles([hash_a], {hash_a: _cycle_frame(labels)})

        self.assertEqual(missing, [])
        self.assertEqual(result["cycle"].tolist(), labels)
        self.assertEqual(result["source_cycle"].tolist(), labels)
        self.assertEqual(segments[0]["cycle_start"], 1)
        self.assertEqual(segments[0]["cycle_end"], 50)

    def test_all_nan_cycles_fail_closed(self):
        hash_a = _hash("a")
        hash_b = _hash("b")
        frame = pd.DataFrame({"cycle": [float("nan"), float("nan")], "x": [1, 2]})
        result, segments, missing = self._stitch_cycles(
            [hash_a, hash_b],
            {
                hash_a: frame,
                hash_b: _cycle_frame([1, 2]),
            },
        )

        self.assertEqual(missing, [hash_a])
        self.assertEqual(result.attrs["missing_positions"], [0])
        self.assertEqual(result.attrs["skipped_segments"], [1])
        self.assertTrue(result.empty)
        self.assertEqual(segments, [])

    def test_raw_orders_by_record_index_within_source(self):
        hash_a = _hash("r")
        raw = _raw_frame([1, 2, 3], record_indices=[30, 10, 20])
        result, _, missing = self._stitch_raw([hash_a], {hash_a: raw})

        self.assertEqual(missing, [])
        self.assertEqual(result["record_index"].tolist(), [10, 20, 30])
        self.assertEqual(result["cycle"].tolist(), [2, 3, 1])
        self.assertEqual(result["source_cycle"].tolist(), [2, 3, 1])

    def test_observed_local_cycles_rejects_non_integer(self):
        labels, errors = stitch.observed_local_cycles(pd.Series([1.0, 2.5]))
        self.assertEqual(labels, [])
        self.assertTrue(errors)

    def test_stitch_metadata_exposes_completeness(self):
        hash_a = _hash("a")
        result, _, _ = self._stitch_cycles([hash_a], {hash_a: None})
        meta = stitch.stitch_metadata(result)
        self.assertFalse(meta["complete"])
        self.assertEqual(meta["missing_positions"], [0])
        self.assertEqual(meta["skipped_segments"], [])


if __name__ == "__main__":
    unittest.main()
