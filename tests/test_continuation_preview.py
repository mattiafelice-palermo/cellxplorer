from __future__ import annotations

import unittest

import pandas as pd

from backend.app.services import calc
from backend.app.services.continuation_preview import (
    infer_contiguous_cycle_ids,
    prepare_stitched_raw,
    voltage_preview_from_raw,
)


class ContinuationPreviewServiceTests(unittest.TestCase):
    @staticmethod
    def _cp_half(current: float) -> pd.DataFrame:
        charge = current > 0
        return pd.DataFrame(
            {
                "record_index": [1, 2],
                "cycle": [1, 1],
                "step": [1, 1],
                "status": ["CC_Chg" if charge else "CC_DChg"] * 2,
                "total_time_s": [0.0, 1.0],
                "voltage_v": [1.0, 1.1],
                "current_ma": [current, current],
                "charge_capacity_mah": [0.0, 1.0] if charge else [0.0, 0.0],
                "discharge_capacity_mah": [0.0, 0.0] if charge else [0.0, 1.0],
                "cycle_complete": [False, False],
                "measurement_type": ["biologic_cp", "biologic_cp"],
            }
        )

    def test_discharge_fragments_across_sources_remain_one_cycle(self):
        statuses = pd.Series(["Rest", "CC DChg", "CC DChg", "Rest", "CC DChg"])

        self.assertEqual(infer_contiguous_cycle_ids(statuses).tolist(), [1, 1, 1, 1, 1])

    def test_charge_after_discharge_starts_the_next_cycle(self):
        statuses = pd.Series(["CC DChg", "Rest", "CC Chg", "CC Chg", "CC DChg"])

        self.assertEqual(infer_contiguous_cycle_ids(statuses).tolist(), [1, 1, 2, 2, 2])

    def test_opposite_cp_halves_preview_as_one_complete_capacity_cycle(self):
        merged = prepare_stitched_raw([self._cp_half(-10.0), self._cp_half(10.0)])

        self.assertEqual(merged["cycle"].unique().tolist(), [1])
        self.assertTrue(merged["cycle_complete"].all())
        cycles = calc.per_cycle(merged)
        self.assertEqual(cycles["cycle"].tolist(), [1])
        self.assertGreater(float(cycles.loc[0, "charge_capacity_mah"]), 0)
        self.assertGreater(float(cycles.loc[0, "discharge_capacity_mah"]), 0)

    def test_same_direction_cp_halves_stay_incomplete_in_preview(self):
        merged = prepare_stitched_raw([self._cp_half(10.0), self._cp_half(12.0)])

        self.assertFalse(merged["cycle_complete"].any())
        self.assertTrue(calc.per_cycle(merged).empty)

    def test_stitched_raw_preserves_file_segments_and_uses_source_local_steps(self):
        first = pd.DataFrame(
            {
                "record_index": [1, 2],
                "cycle": [1, 1],
                "step": [1, 1],
                "status": ["CC DChg", "CC DChg"],
                "total_time_s": [0.0, 1.0],
                "voltage_v": [4.1, 3.9],
                "discharge_capacity_mah": [0.0, 1.0],
            }
        )
        second = pd.DataFrame(
            {
                "record_index": [1, 2],
                "cycle": [1, 1],
                "step": [1, 1],
                "status": ["CC DChg", "CC DChg"],
                "total_time_s": [0.0, 1.0],
                "voltage_v": [3.8, 3.7],
                "discharge_capacity_mah": [0.0, 2.0],
            }
        )

        merged = prepare_stitched_raw([first, second])

        self.assertEqual(merged["cycle"].tolist(), [1, 1, 1, 1])
        self.assertEqual(merged["segment"].tolist(), [0, 0, 1, 1])
        self.assertEqual(merged["step"].tolist(), ["0:1", "0:1", "1:1", "1:1"])
        cycles = calc.per_cycle(merged)
        self.assertEqual(cycles["cycle"].tolist(), [1])
        self.assertAlmostEqual(float(cycles.loc[0, "discharge_capacity_mah"]), 3.0)

        voltage = voltage_preview_from_raw(merged)
        self.assertEqual(voltage["x"], [0.0, 1.0, 1.0, 2.0])
        self.assertEqual(voltage["y"], [4.1, 3.9, 3.8, 3.7])
        self.assertEqual(voltage["x_start"], 0.0)
        self.assertEqual(voltage["x_end"], 2.0)

    def test_capacity_voltage_preview_keeps_acquisition_order_across_counter_resets(self):
        frame = pd.DataFrame(
            {
                "record_index": [1, 2, 3, 4],
                "cycle": [1, 1, 1, 1],
                "status": ["CC Chg", "CC Chg", "CC DChg", "CC DChg"],
                "current_ma": [10.0, 10.0, -10.0, -10.0],
                "voltage_v": [3.0, 3.5, 3.4, 3.1],
                "charge_capacity_mah": [0.0, 1.0, 1.0, 1.0],
                "discharge_capacity_mah": [0.0, 0.0, 0.0, 1.0],
            }
        )

        preview = voltage_preview_from_raw(frame, x_axis="capacity")

        self.assertEqual(preview["y"], [3.0, 3.5, 3.4, 3.1])
        self.assertEqual(preview["x"], [0.0, 1.0, 1.0, 2.0])

    def test_voltage_preview_can_select_a_dense_cycle_window(self):
        frame = pd.DataFrame(
            {
                "record_index": [1, 2, 3, 4],
                "cycle": [10, 10, 30, 30],
                "total_time_s": [0.0, 1.0, 2.0, 3.0],
                "voltage_v": [3.0, 3.1, 3.2, 3.3],
            }
        )

        preview = voltage_preview_from_raw(frame, cycle_start=2, cycle_end=2)

        self.assertEqual(preview["x"], [2.0, 3.0])
        self.assertEqual(preview["y"], [3.2, 3.3])


if __name__ == "__main__":
    unittest.main()
