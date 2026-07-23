import unittest

import pandas as pd

from backend.app.services import dcir, protocol


class DcirCandidateTests(unittest.TestCase):
    def test_detects_long_rest_short_pulses_and_skips_other_pairs(self):
        protocol = {
            "signature": "protocol-a",
            "steps": [
                {"number": 1, "direction": "rest", "time_limit_s": 1800},
                {
                    "number": 2,
                    "direction": "discharge",
                    "time_limit_s": 30,
                    "current_ma": -75,
                    "c_rate": 1.5,
                },
                {"number": 3, "direction": "rest", "time_limit_s": 120},
                {
                    "number": 4,
                    "direction": "charge",
                    "time_limit_s": 30,
                    "current_ma": 25,
                    "c_rate": 0.5,
                },
            ],
        }
        candidates = dcir.detect_candidates(protocol)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["rest_step_index"], 1)
        self.assertEqual(candidates[0]["pulse_step_index"], 2)
        self.assertEqual(candidates[0]["label"], "Discharge 1.5C")

    def test_c_rate_formatter_prefers_fractions(self):
        self.assertEqual(dcir.format_c_rate(0.5), "C/2")
        self.assertEqual(dcir.format_c_rate(1 / 3), "C/3")
        self.assertEqual(dcir.format_c_rate(1.5), "1.5C")

    def test_detects_pair_from_reconstructed_neware_metadata(self):
        reconstructed = protocol.reconstruct_protocol(
            {
                "Step.Step_Info.Step26.Step_Type": "4",
                "Step.Step_Info.Step26.Limit.Main.Time.Value": "1800000",
                "Step.Step_Info.Step27.Step_Type": "2",
                "Step.Step_Info.Step27.Limit.Main.Curr.Value": "75.6",
                "Step.Step_Info.Step27.Limit.Main.Time.Value": "30000",
            },
            nominal_capacity_mah=50.37,
        )

        candidates = dcir.detect_candidates(reconstructed)

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["rest_step_index"], 26)
        self.assertEqual(candidates[0]["pulse_step_index"], 27)
        self.assertAlmostEqual(candidates[0]["rest_duration_s"], 1800)
        self.assertAlmostEqual(candidates[0]["pulse_duration_s"], 30)
        self.assertAlmostEqual(candidates[0]["rest_pulse_ratio"], 60)
        self.assertEqual(candidates[0]["direction"], "discharge")


class DcirOccurrenceTests(unittest.TestCase):
    def test_uses_last_voltages_and_median_absolute_pulse_current(self):
        timestamps = pd.date_range("2026-01-01", periods=8, freq="10s")
        frame = pd.DataFrame(
            {
                "cycle": [76] * 8,
                "step_index": [10, 10, 10, 10, 11, 11, 11, 11],
                "time_s": [0, 10, 20, 30, 0, 10, 20, 30],
                "timestamp": timestamps,
                "voltage_v": [3.50, 3.51, 3.52, 3.53, 3.30, 3.28, 3.27, 3.26],
                "current_ma": [0, 0, 0, 0, -49, -50, -51, -50],
            }
        )
        result = dcir.per_occurrence(
            frame,
            rest_step_index=10,
            pulse_step_index=11,
            direction="discharge",
            nominal_capacity_mah=50,
            origin_timestamp=timestamps[0],
        )
        self.assertEqual(len(result), 1)
        row = result.iloc[0]
        self.assertAlmostEqual(row["v_rest_v"], 3.53)
        self.assertAlmostEqual(row["v_pulse_v"], 3.26)
        self.assertAlmostEqual(row["current_ma"], 50)
        self.assertAlmostEqual(row["c_rate"], 1)
        self.assertAlmostEqual(row["dcir_mohm"], 5400)
        self.assertAlmostEqual(row["start_time_h"], 0)

    def test_charge_formula_and_multiple_occurrences(self):
        frame = pd.DataFrame(
            {
                "cycle": [1, 1, 1, 1, 77, 77, 77, 77],
                "step_index": [4, 4, 5, 5, 4, 4, 5, 5],
                "time_s": [0, 30, 0, 30, 0, 30, 0, 30],
                "voltage_v": [3.40, 3.41, 3.50, 3.51, 3.42, 3.43, 3.55, 3.56],
                "current_ma": [0, 0, 100, 100, 0, 0, 100, 100],
            }
        )
        result = dcir.per_occurrence(
            frame,
            rest_step_index=4,
            pulse_step_index=5,
            direction="charge",
        )
        self.assertEqual(result["occurrence"].tolist(), [1, 2])
        self.assertAlmostEqual(result.iloc[0]["dcir_mohm"], 1000)
        self.assertAlmostEqual(result.iloc[1]["dcir_mohm"], 1300)


if __name__ == "__main__":
    unittest.main()
