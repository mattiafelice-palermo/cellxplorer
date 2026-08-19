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
    def test_discharge_fragments_across_sources_remain_one_cycle(self):
        statuses = pd.Series(["Rest", "CC DChg", "CC DChg", "Rest", "CC DChg"])

        self.assertEqual(infer_contiguous_cycle_ids(statuses).tolist(), [1, 1, 1, 1, 1])

    def test_charge_after_discharge_starts_the_next_cycle(self):
        statuses = pd.Series(["CC DChg", "Rest", "CC Chg", "CC Chg", "CC DChg"])

        self.assertEqual(infer_contiguous_cycle_ids(statuses).tolist(), [1, 1, 2, 2, 2])

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


if __name__ == "__main__":
    unittest.main()
