from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import step_blocks


def raw(records: list[tuple]) -> pd.DataFrame:
    """records: (step_index, status, time_s, charge_mah, discharge_mah)."""
    rows = []
    for i, (step, status, time_s, chg, dchg) in enumerate(records):
        rows.append(
            {
                "record_index": i,
                "cycle": 1 + i // 100,
                "step_index": step,
                "status": status,
                "time_s": time_s,
                "voltage_v": 3.6,
                "current_ma": 10.0,
                "charge_capacity_mah": chg,
                "discharge_capacity_mah": dchg,
                "timestamp": pd.Timestamp("2026-01-01") + pd.Timedelta(seconds=i * 60),
            }
        )
    return pd.DataFrame(rows)


def blocks(records, steps, mode):
    assigned = step_blocks.assign_blocks(raw(records), set(steps), mode)
    return [
        (int(b), sorted(g["step_index"].tolist()))
        for b, g in assigned.groupby("block", sort=True)
    ]


class SegmentationTests(unittest.TestCase):
    def test_contiguous_splits_repeated_block_into_occurrences(self):
        records = (
            [(s, "cc_dchg", 10, 0, 5) for s in (84, 85, 86)]
            + [(s, "rest", 10, 0, 0) for s in (70, 71)]
            + [(s, "cc_dchg", 10, 0, 5) for s in (84, 85, 86)]
        )
        self.assertEqual(
            blocks(records, {84, 85, 86}, "contiguous"),
            [(1, [84, 85, 86]), (2, [84, 85, 86])],
        )

    def test_back_to_back_full_block_still_splits(self):
        # No unselected step between occurrences: the boundary is the return to
        # the block's first step, not a gap.
        records = [(s, "cc_chg", 10, 5, 0) for s in (71, 72, 73)] * 2
        self.assertEqual(
            blocks(records, {71, 72, 73}, "contiguous"),
            [(1, [71, 72, 73]), (2, [71, 72, 73])],
        )

    def test_union_keeps_gap_separated_steps_together(self):
        # Two CCCV steps (86, 88) split by a rest (87): union is one block.
        records = [
            (86, "cccv_chg", 10, 5, 0),
            (87, "rest", 10, 0, 0),
            (88, "cccv_chg", 10, 5, 0),
        ] * 2
        self.assertEqual(
            blocks(records, {86, 88}, "union"), [(1, [86, 88]), (2, [86, 88])]
        )

    def test_contiguous_separates_the_same_gap_steps(self):
        records = [
            (86, "cccv_chg", 10, 5, 0),
            (87, "rest", 10, 0, 0),
            (88, "cccv_chg", 10, 5, 0),
        ] * 2
        self.assertEqual(
            blocks(records, {86, 88}, "contiguous"),
            [(1, [86]), (2, [88]), (3, [86]), (4, [88])],
        )

    def test_nested_repeat_does_not_split_an_occurrence(self):
        # Steps 71-80 with an inner "repeat 77-80", so the index falls back to
        # 77 mid-occurrence. That must not open a new occurrence.
        one = [71, 72, 77, 78, 79, 80, 77, 78, 79, 80]
        records = [(s, "cc_chg", 10, 5, 0) for s in one] * 2
        result = blocks(records, set(one), "union")
        self.assertEqual(len(result), 2, "the fallback to step 77 wrongly split the block")
        self.assertEqual([b for b, _ in result], [1, 2])

    def test_single_step_selection_splits_by_occurrence(self):
        # Selecting one step (e.g. only the CV phase): each execution is its own
        # block, told apart by the unselected records between them. Both modes
        # must agree here.
        records = (
            [(86, "cv_chg", t, 40 + t, 0) for t in (0, 100)]
            + [(70, "rest", 10, 0, 0)]
            + [(86, "cv_chg", t, 46 + t, 0) for t in (0, 100)]
            + [(70, "rest", 10, 0, 0)]
            + [(86, "cv_chg", t, 52 + t, 0) for t in (0, 100)]
        )
        # Three occurrences of the one step; both modes agree. (Each block holds
        # that step's two records, hence [86, 86].)
        self.assertEqual([b for b, _ in blocks(records, {86}, "union")], [1, 2, 3])
        self.assertEqual([b for b, _ in blocks(records, {86}, "contiguous")], [1, 2, 3])

    def test_no_selection_yields_no_blocks(self):
        records = [(1, "rest", 10, 0, 0)]
        self.assertTrue(step_blocks.assign_blocks(raw(records), set(), "union").empty)
        self.assertTrue(step_blocks.assign_blocks(raw(records), {99}, "union").empty)


class AggregationTests(unittest.TestCase):
    def test_phase_times_are_summed_per_block_excluding_rests(self):
        # 1h charge + 0.5h CV-charge + 0.25h rest + 2h discharge.
        records = [
            (84, "cc_chg", 3600, 40, 0),
            (85, "cccv_chg", 1800, 46, 0),
            (86, "rest", 900, 0, 0),
            (87, "cc_dchg", 7200, 0, 44),
        ]
        out = step_blocks.per_block(raw(records), {84, 85, 86, 87}, "union")
        self.assertEqual(len(out), 1)
        row = out.iloc[0]
        self.assertAlmostEqual(row["charge_time_h"], 1.5)  # cc + cccv
        self.assertAlmostEqual(row["discharge_time_h"], 2.0)
        self.assertAlmostEqual(row["rest_time_h"], 0.25)
        self.assertAlmostEqual(row["total_time_h"], 3.5)  # charge + discharge
        self.assertEqual(row["step_start"], 84)
        self.assertEqual(row["step_end"], 87)

    def test_elapsed_start_total_time_and_overall_voltage(self):
        frame = pd.DataFrame(
            [
                {
                    "record_index": 0,
                    "cycle": 1,
                    "step_index": 1,
                    "status": "cc_chg",
                    "time_s": 3600,
                    "voltage_v": 3.0,
                    "charge_capacity_mah": 1.0,
                    "discharge_capacity_mah": 0.0,
                    "timestamp": pd.Timestamp("2026-01-01 01:00:00"),
                },
                {
                    "record_index": 1,
                    "cycle": 1,
                    "step_index": 2,
                    "status": "rest",
                    "time_s": 1800,
                    "voltage_v": 3.5,
                    "charge_capacity_mah": 0.0,
                    "discharge_capacity_mah": 0.0,
                    "timestamp": pd.Timestamp("2026-01-01 01:30:00"),
                },
                {
                    "record_index": 2,
                    "cycle": 1,
                    "step_index": 3,
                    "status": "cc_dchg",
                    "time_s": 7200,
                    "voltage_v": 4.0,
                    "charge_capacity_mah": 0.0,
                    "discharge_capacity_mah": 1.0,
                    "timestamp": pd.Timestamp("2026-01-01 03:00:00"),
                },
            ]
        )
        out = step_blocks.per_block(
            frame,
            {1, 2, 3},
            "union",
            origin_timestamp=pd.Timestamp("2026-01-01"),
        )
        row = out.iloc[0]
        self.assertAlmostEqual(row["start_time_h"], 1.0)
        self.assertAlmostEqual(row["block_duration_h"], 2.0)
        self.assertAlmostEqual(row["total_time_h"], 3.0)
        self.assertAlmostEqual(row["mean_voltage_v"], 3.5)

    def test_cumulative_cv_time_across_separated_cv_steps(self):
        # The union use case: two explicit CV steps split by a rest. The block's
        # CV time is the sum of both (0.5h + 0.25h), which contiguous mode splits
        # into two blocks and cannot report as one figure.
        records = [
            (86, "cv_chg", 0, 40.0, 0),
            (86, "cv_chg", 1800, 46.0, 0),  # step 86 lasts 0.5h
            (87, "rest", 600, 0, 0),
            (88, "cv_chg", 0, 46.0, 0),
            (88, "cv_chg", 900, 46.4, 0),  # step 88 lasts 0.25h
        ]
        union = step_blocks.per_block(raw(records), {86, 88}, "union")
        self.assertEqual(len(union), 1)
        self.assertAlmostEqual(union.iloc[0]["cv_charge_time_h"], 0.75)

        contiguous = step_blocks.per_block(raw(records), {86, 88}, "contiguous")
        self.assertEqual(len(contiguous), 2)
        self.assertAlmostEqual(contiguous.iloc[0]["cv_charge_time_h"], 0.5)
        self.assertAlmostEqual(contiguous.iloc[1]["cv_charge_time_h"], 0.25)

    def test_capacity_is_the_per_step_delta_not_the_running_total(self):
        records = [
            (84, "cc_chg", 100, 10.0, 0),
            (84, "cc_chg", 200, 20.0, 0),
            (85, "cc_chg", 100, 5.0, 0),
            (85, "cc_chg", 200, 12.0, 0),
        ]
        out = step_blocks.per_block(raw(records), {84, 85}, "union")
        # (20-10) + (12-5) = 17, not the last reading 20.
        self.assertAlmostEqual(out.iloc[0]["charge_capacity_mah"], 17.0)


if __name__ == "__main__":
    unittest.main()
