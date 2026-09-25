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

    def _refs(self, ordered: list[str]) -> list[stitch.CachedSourceRef]:
        return [stitch.CachedSourceRef(file_hash, self.PARSER) for file_hash in ordered]

    def _stitch_cycles(self, ordered: list[str], frames: dict[str, pd.DataFrame | None]):
        with patch(
            "app.services.stitch.cache.load_cycles",
            side_effect=lambda h, _p, _c: frames.get(h),
        ):
            return stitch.stitch_cycles(self._refs(ordered), self.CALC)

    def _stitch_raw(self, ordered: list[str], frames: dict[str, pd.DataFrame | None]):
        with patch(
            "app.services.stitch.cache.load_raw",
            side_effect=lambda h, _p: frames.get(h),
        ):
            return stitch.stitch_raw(self._refs(ordered))

    def test_cp_summary_probe_skips_non_biologic_parser_identities(self):
        with patch(
            "app.services.stitch.cache.load_biologic_cp_half_cycle_summary",
            side_effect=AssertionError("non-BioLogic source was probed"),
        ):
            self.assertIsNone(stitch._cached_cp_half_cycle_summary(_hash("m"), "nb:v1:r1"))

    def test_validated_index_negative_cp_summary_is_memoized(self):
        stitch._memoized_indexed_cp_half_cycle_summary.cache_clear()
        try:
            with (
                patch("app.services.stitch.cache.raw_path", return_value=Path(__file__)),
                patch("app.services.stitch.cache.try_load_raw_layout_index", return_value={"stable": True}),
                patch("app.services.stitch.cache.load_biologic_cp_half_cycle_summary", return_value=None) as load_summary,
            ):
                self.assertIsNone(stitch._cached_cp_half_cycle_summary(_hash("n"), "bm:gcpl:r1"))
                self.assertIsNone(stitch._cached_cp_half_cycle_summary(_hash("n"), "bm:gcpl:r1"))
                self.assertEqual(load_summary.call_count, 1)
        finally:
            stitch._memoized_indexed_cp_half_cycle_summary.cache_clear()

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

    def test_display_only_source_does_not_shift_complete_cycle_numbering(self):
        curve_hash = _hash("x")
        cycling_hash = _hash("y")
        curve = _raw_frame([1, 1])
        curve["cycle_complete"] = False
        cycling = _raw_frame([7, 7])
        cycling["cycle_complete"] = True

        result, segments, missing = self._stitch_raw(
            [curve_hash, cycling_hash],
            {curve_hash: curve, cycling_hash: cycling},
        )

        self.assertEqual(missing, [])
        curve_rows = result[result["source_hash"] == curve_hash]
        cycling_rows = result[result["source_hash"] == cycling_hash]
        self.assertEqual(set(curve_rows["cycle"]), {0})
        self.assertTrue(curve_rows["display_only_cycle"].all())
        self.assertEqual(set(cycling_rows["cycle"]), {1})
        self.assertFalse(cycling_rows["display_only_cycle"].any())
        self.assertEqual(segments[0]["cycle_start"], None)
        self.assertEqual(segments[0]["display_only_source_cycles"], [1])
        self.assertEqual(segments[1]["cycle_start"], 1)

    @staticmethod
    def _cp_half(current: float, file_hash: str) -> pd.DataFrame:
        direction = "CC_Chg" if current > 0 else "CC_DChg"
        return pd.DataFrame(
            {
                "record_index": [1, 2],
                "cycle": [1, 1],
                "step": [1, 1],
                "status": [direction, direction],
                "current_ma": [current, current],
                "voltage_v": [1.0, 1.1],
                "charge_capacity_mah": [0.0, 1.0] if current > 0 else [0.0, 0.0],
                "discharge_capacity_mah": [0.0, 0.0] if current > 0 else [0.0, 1.0],
                "cycle_complete": [False, False],
                "measurement_type": ["biologic_cp", "biologic_cp"],
            }
        )

    def test_adjacent_opposite_cp_halves_complete_one_cycle(self):
        charge_hash, discharge_hash = _hash("c"), _hash("d")
        raw_frames = {
            charge_hash: self._cp_half(15.0, charge_hash),
            discharge_hash: self._cp_half(-15.0, discharge_hash),
        }
        with (
            patch("app.services.stitch.cache.load_cycles", return_value=pd.DataFrame(columns=["cycle"])),
            patch("app.services.stitch.cache.load_raw", side_effect=lambda h, _p: raw_frames[h]),
            patch("app.services.stitch._has_adjacent_opposite_cp_halves", return_value=True),
        ):
            result, segments, missing = stitch.stitch_cycles(
                self._refs([charge_hash, discharge_hash]), self.CALC
            )

        self.assertEqual(missing, [])
        self.assertEqual(result["cycle"].tolist(), [1])
        self.assertGreater(result.loc[0, "charge_capacity_mah"], 0)
        self.assertGreater(result.loc[0, "discharge_capacity_mah"], 0)
        self.assertEqual([item["cycle_start"] for item in segments], [1, 1])
        self.assertEqual([item["cycle_end"] for item in segments], [1, 1])

    def test_cp_pair_is_added_after_existing_cached_cycles(self):
        existing_hash, charge_hash, discharge_hash = _hash("g"), _hash("h"), _hash("i")
        raw_frames = {
            existing_hash: pd.DataFrame(
                {
                    "record_index": [1, 2],
                    "cycle": [1, 1],
                    "status": ["CC_DChg", "CC_DChg"],
                    "measurement_type": ["neware", "neware"],
                    "discharge_capacity_mah": [0.0, 8.0],
                }
            ),
            charge_hash: self._cp_half(15.0, charge_hash),
            discharge_hash: self._cp_half(-15.0, discharge_hash),
        }
        cycle_frames = {
            existing_hash: pd.DataFrame({"cycle": [1], "discharge_capacity_mah": [9.0]}),
            charge_hash: pd.DataFrame(columns=["cycle"]),
            discharge_hash: pd.DataFrame(columns=["cycle"]),
        }
        with (
            patch("app.services.stitch.cache.load_cycles", side_effect=lambda h, _p, _c: cycle_frames[h]),
            patch("app.services.stitch.cache.load_raw", side_effect=lambda h, _p: raw_frames[h]),
            patch("app.services.stitch._has_adjacent_opposite_cp_halves", return_value=True),
        ):
            result, segments, missing = stitch.stitch_cycles(
                self._refs([existing_hash, charge_hash, discharge_hash]), self.CALC
            )

        self.assertEqual(missing, [])
        self.assertEqual(result["cycle"].tolist(), [1, 2])
        # Preserve the existing cycle-cache result and append the independently
        # inferred cross-source CP summary under its dense global identity.
        self.assertEqual(result.loc[0, "discharge_capacity_mah"], 9.0)
        self.assertGreater(result.loc[1, "charge_capacity_mah"], 0)
        self.assertGreater(result.loc[1, "discharge_capacity_mah"], 0)
        self.assertEqual([item["cycle_start"] for item in segments], [1, 2, 2])

    def test_cp_pair_before_existing_cached_cycles_shifts_cached_global_cycle(self):
        charge_hash, discharge_hash, existing_hash = _hash("j"), _hash("k"), _hash("l")
        raw_frames = {
            charge_hash: self._cp_half(15.0, charge_hash),
            discharge_hash: self._cp_half(-15.0, discharge_hash),
            existing_hash: pd.DataFrame(
                {
                    "record_index": [1, 2],
                    "cycle": [1, 1],
                    "source_cycle": [1, 1],
                    "status": ["CC_DChg", "CC_DChg"],
                    "measurement_type": ["neware", "neware"],
                    "discharge_capacity_mah": [0.0, 8.0],
                }
            ),
        }
        cycle_frames = {
            charge_hash: pd.DataFrame(columns=["cycle"]),
            discharge_hash: pd.DataFrame(columns=["cycle"]),
            existing_hash: pd.DataFrame(
                {"cycle": [1], "discharge_capacity_mah": [9.0]}
            ),
        }
        with (
            patch("app.services.stitch.cache.load_cycles", side_effect=lambda h, _p, _c: cycle_frames[h]),
            patch("app.services.stitch.cache.load_raw", side_effect=lambda h, _p: raw_frames[h]),
            patch("app.services.stitch._has_adjacent_opposite_cp_halves", return_value=True),
        ):
            result, segments, missing = stitch.stitch_cycles(
                self._refs([charge_hash, discharge_hash, existing_hash]), self.CALC
            )

        self.assertEqual(missing, [])
        self.assertEqual(result["cycle"].tolist(), [1, 2])
        self.assertGreater(result.loc[0, "charge_capacity_mah"], 0)
        self.assertEqual(result.loc[1, "discharge_capacity_mah"], 9.0)
        self.assertEqual([item["cycle_start"] for item in segments], [1, 1, 2])

    def test_same_direction_cp_halves_do_not_complete_a_cycle(self):
        first, second = _hash("e"), _hash("f")
        result, _, missing = self._stitch_raw(
            [first, second],
            {first: self._cp_half(10.0, first), second: self._cp_half(12.0, second)},
        )
        self.assertEqual(missing, [])
        self.assertTrue(result["cycle"].eq(0).all())
        self.assertTrue(result["display_only_cycle"].all())

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

    def test_incomplete_first_source_cycle_remains_explicit(self):
        first = _hash("i")
        second = _hash("j")
        result, segments, missing = self._stitch_raw(
            [first, second],
            {
                first: _raw_frame([1, 1, 2]),
                second: _raw_frame([1, 1]),
            },
        )
        self.assertEqual(missing, [])
        self.assertEqual(result["source_hash"].tolist(), [first] * 3 + [second] * 2)
        self.assertEqual(result["source_cycle"].tolist(), [1, 1, 2, 1, 1])
        self.assertEqual([segment["cycle_start"] for segment in segments], [1, 3])

    def test_incomplete_last_source_cycle_remains_explicit(self):
        first = _hash("k")
        second = _hash("l")
        result, segments, missing = self._stitch_raw(
            [first, second],
            {
                first: _raw_frame([1, 2, 3]),
                second: _raw_frame([1, 1, 2]),
            },
        )
        self.assertEqual(missing, [])
        self.assertEqual(result["source_hash"].tolist(), [first] * 3 + [second] * 3)
        self.assertEqual(result["source_cycle"].tolist(), [1, 2, 3, 1, 1, 2])
        self.assertEqual(segments[-1]["cycle_start"], 4)

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

    def test_non_finite_cycles_fail_closed_for_cycle_and_raw_stitching(self):
        for invalid_value in (float("inf"), float("-inf")):
            with self.subTest(invalid_value=invalid_value):
                labels, errors = stitch.observed_local_cycles(
                    pd.Series([1, invalid_value])
                )
                self.assertEqual(labels, [])
                self.assertEqual(errors, ["non-finite cycle values"])

                hash_a = _hash("a")
                hash_b = _hash("b")
                invalid_cycle_frame = _cycle_frame([1, invalid_value])
                cycle_result, cycle_segments, cycle_missing = self._stitch_cycles(
                    [hash_a, hash_b],
                    {
                        hash_a: invalid_cycle_frame,
                        hash_b: _cycle_frame([1, 2]),
                    },
                )
                self.assertTrue(cycle_result.empty)
                self.assertEqual(cycle_missing, [hash_a])
                self.assertEqual(cycle_result.attrs["missing_positions"], [0])
                self.assertEqual(cycle_result.attrs["skipped_segments"], [1])
                self.assertEqual(cycle_segments, [])

                invalid_raw_frame = pd.DataFrame(
                    {
                        "record_index": [1, 2],
                        "cycle": [1, invalid_value],
                        "status": ["CC_DChg", "CC_DChg"],
                    }
                )
                raw_result, raw_segments, raw_missing = self._stitch_raw(
                    [hash_a, hash_b],
                    {
                        hash_a: invalid_raw_frame,
                        hash_b: _raw_frame([1, 2]),
                    },
                )
                self.assertTrue(raw_result.empty)
                self.assertEqual(raw_missing, [hash_a])
                self.assertEqual(raw_result.attrs["missing_positions"], [0])
                self.assertEqual(raw_result.attrs["skipped_segments"], [1])
                self.assertEqual(raw_segments, [])

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


class MixedParserIdentityStitchTests(unittest.TestCase):
    """Spec 040.3 cases 7-9: ordered sources may carry different parser
    identities and each is loaded at its OWN pinned identity."""

    def test_cycles_stitch_loads_each_source_at_its_own_identity(self):
        hash_a, hash_b = _hash("a"), _hash("b")
        refs = [
            stitch.CachedSourceRef(hash_a, "nb:v2026.06.11:r1"),
            stitch.CachedSourceRef(hash_b, "nx:6:r1"),
        ]
        frames = {hash_a: _cycle_frame([1, 2]), hash_b: _cycle_frame([1])}
        requested: list[tuple[str, str, str]] = []

        def _load(file_hash, parser_version, calc_version):
            requested.append((file_hash, parser_version, calc_version))
            return frames.get(file_hash)

        with patch("app.services.stitch.cache.load_cycles", side_effect=_load):
            result, segments, missing = stitch.stitch_cycles(refs, "1.6.1")

        self.assertEqual(missing, [])
        self.assertEqual(
            requested,
            [
                (hash_a, "nb:v2026.06.11:r1", "1.6.1"),
                (hash_b, "nx:6:r1", "1.6.1"),
            ],
        )
        self.assertEqual(result["cycle"].tolist(), [1, 2, 3])
        self.assertEqual(len(segments), 2)

    def test_raw_stitch_loads_each_source_at_its_own_identity(self):
        hash_a, hash_b = _hash("a"), _hash("b")
        refs = [
            stitch.CachedSourceRef(hash_a, "nb:v2026.06.11:r1"),
            stitch.CachedSourceRef(hash_b, "nx:6:r1"),
        ]
        frames = {hash_a: _raw_frame([1]), hash_b: _raw_frame([1])}
        requested: list[tuple[str, str]] = []

        def _load(file_hash, parser_version):
            requested.append((file_hash, parser_version))
            return frames.get(file_hash)

        with patch("app.services.stitch.cache.load_raw", side_effect=_load):
            result, segments, missing = stitch.stitch_raw(refs)

        self.assertEqual(missing, [])
        self.assertEqual(
            requested,
            [(hash_a, "nb:v2026.06.11:r1"), (hash_b, "nx:6:r1")],
        )
        self.assertEqual(len(segments), 2)

    def test_missing_cache_at_middle_source_own_identity_blocks_later_segments(self):
        """One source-specific cache missing still fails closed for later
        sources, exactly like the single-identity case (spec case 10)."""
        hash_a, hash_b, hash_c = _hash("a"), _hash("b"), _hash("c")
        refs = [
            stitch.CachedSourceRef(hash_a, "nb:v2026.06.11:r1"),
            stitch.CachedSourceRef(hash_b, "nx:6:r1"),
            stitch.CachedSourceRef(hash_c, "nb:v2026.06.11:r1"),
        ]
        frames = {hash_a: _cycle_frame([1]), hash_b: None, hash_c: _cycle_frame([1])}
        with patch(
            "app.services.stitch.cache.load_cycles",
            side_effect=lambda h, _p, _c: frames.get(h),
        ):
            result, segments, missing = stitch.stitch_cycles(refs, "1.6.1")

        self.assertEqual(missing, [hash_b])
        self.assertEqual(result.attrs["missing_positions"], [1])
        self.assertEqual(result.attrs["skipped_segments"], [2])
        # only source A's cycle made it in; C was skipped after the gap
        self.assertEqual(result["cycle"].tolist(), [1])
        self.assertEqual(result["source_hash"].tolist(), [hash_a])


class MultiVoltageStitchTests(unittest.TestCase):
    """Spec 040.4: stitch_raw preserves optional working/counter potential
    columns across source concatenation, using NaN — never a fabricated
    value — for a source that lacks them."""

    PARSER = "test-parser"

    def _refs(self, ordered: list[str]) -> list[stitch.CachedSourceRef]:
        return [stitch.CachedSourceRef(file_hash, self.PARSER) for file_hash in ordered]

    def test_aux_voltage_columns_preserved_and_nan_filled_for_missing_source(self):
        hash_three_electrode = _hash("t")
        hash_two_electrode = _hash("d")
        three_electrode = pd.DataFrame(
            {
                "record_index": [1, 2],
                "cycle": [1, 2],
                "status": ["CC_Chg", "CC_Chg"],
                "voltage_v": [0.5, 0.6],
                "working_potential_v": [3.0, 3.1],
                "counter_potential_v": [2.5, 2.5],
            }
        )
        two_electrode = pd.DataFrame(
            {
                "record_index": [1],
                "cycle": [1],
                "status": ["CC_Chg"],
                "voltage_v": [3.4],
            }
        )
        frames = {hash_three_electrode: three_electrode, hash_two_electrode: two_electrode}
        with patch(
            "app.services.stitch.cache.load_raw",
            side_effect=lambda h, _p: frames.get(h),
        ):
            result, segments, missing = stitch.stitch_raw(
                self._refs([hash_three_electrode, hash_two_electrode])
            )

        self.assertEqual(missing, [])
        self.assertIn("working_potential_v", result.columns)
        self.assertIn("counter_potential_v", result.columns)
        # Source A's two rows keep their real values...
        three_electrode_rows = result[result["source_hash"] == hash_three_electrode]
        self.assertEqual(three_electrode_rows["working_potential_v"].tolist(), [3.0, 3.1])
        self.assertEqual(three_electrode_rows["counter_potential_v"].tolist(), [2.5, 2.5])
        # ...source B's row is NaN, never fabricated as 0 or copied from A.
        two_electrode_rows = result[result["source_hash"] == hash_two_electrode]
        self.assertEqual(len(two_electrode_rows), 1)
        self.assertTrue(pd.isna(two_electrode_rows["working_potential_v"].iloc[0]))
        self.assertTrue(pd.isna(two_electrode_rows["counter_potential_v"].iloc[0]))
        # voltage_v (the primary/compatibility channel) is unaffected either way.
        self.assertEqual(result["voltage_v"].tolist(), [0.5, 0.6, 3.4])


if __name__ == "__main__":
    unittest.main()
