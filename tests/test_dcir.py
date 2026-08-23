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
        self.assertAlmostEqual(row["rest_duration_s"], 30)
        self.assertAlmostEqual(row["pulse_duration_s"], 30)

    def test_preserves_non_contiguous_runs_and_reports_compact_run_counts(self):
        frame = pd.DataFrame(
            {
                "record_index": [0, 1, 3, 4, 5, 6],
                "cycle": [1] * 6,
                "step_index": [10, 10, 10, 10, 11, 11],
                "time_s": [0, 1, 0, 1, 0, 1],
                "voltage_v": [3.5, 3.5, 3.51, 3.52, 3.3, 3.29],
                "current_ma": [0, 0, 0, 0, -10, -10],
            }
        )
        profiling: dict = {}
        result = dcir.per_occurrence(
            frame,
            rest_step_index=10,
            pulse_step_index=11,
            direction="discharge",
            profiling=profiling,
        )

        self.assertEqual(len(result), 1)
        self.assertEqual(profiling["counts"]["runs"], 3)
        self.assertEqual(profiling["counts"]["valid_occurrences"], 1)
        self.assertAlmostEqual(result.iloc[0]["v_rest_v"], 3.52)

    def test_true_and_false_adjacency_preserves_cycle_and_repeated_step_boundaries(self):
        frame = pd.DataFrame(
            {
                "record_index": list(range(12)),
                "cycle": [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2],
                "step_index": [10, 10, 12, 12, 10, 10, 10, 10, 11, 11, 10, 11],
                "time_s": [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
                "voltage_v": [
                    3.5, 3.5, 3.45, 3.45, 3.51, 3.51,
                    3.52, 3.52, 3.3, 3.29, 3.53, 3.2,
                ],
                "current_ma": [0, 0, 0, 0, 0, 0, 0, 0, -10, -10, 0, -20],
            }
        )
        result = dcir.per_occurrence(
            frame,
            rest_step_index=10,
            pulse_step_index=11,
            direction="discharge",
        )

        self.assertEqual(result["cycle"].tolist(), [2, 2])
        self.assertEqual(result["occurrence"].tolist(), [1, 2])
        self.assertAlmostEqual(result.iloc[0]["v_rest_v"], 3.52)
        self.assertAlmostEqual(result.iloc[1]["current_ma"], 20)

    def test_time_duration_fallback_is_used_without_timestamps(self):
        frame = pd.DataFrame(
            {
                "cycle": [4, 4, 4, 4],
                "step_index": [10, 10, 11, 11],
                "time_s": [100, 130, 0, 20],
                "voltage_v": [3.5, 3.51, 3.3, 3.29],
                "current_ma": [0, 0, -10, -10],
            }
        )
        result = dcir.per_occurrence(
            frame,
            rest_step_index=10,
            pulse_step_index=11,
            direction="discharge",
        )

        row = result.iloc[0]
        self.assertIsNone(row["start_time_h"])
        self.assertAlmostEqual(row["rest_duration_s"], 30)
        self.assertAlmostEqual(row["pulse_duration_s"], 20)

    def test_missing_nan_and_zero_current_values_are_rejected(self):
        frame = pd.DataFrame(
            {
                "cycle": [1] * 4 + [2] * 4 + [3] * 4 + [4] * 4 + [5] * 4,
                "step_index": [10, 10, 11, 11] * 5,
                "time_s": [0, 1] * 10,
                "voltage_v": [
                    3.5, 3.5, 3.3, 3.3,
                    3.5, 3.5, 3.3, 3.3,
                    3.5, 3.5, 3.3, 3.3,
                    3.5, 3.5, 3.3, 3.3,
                    3.5, 3.5, 3.3, 3.3,
                ],
                "current_ma": [
                    0, 0, -10, -10,
                    0, 0, -10, -10,
                    0, 0, float("nan"), float("nan"),
                    0, 0, 0, 0,
                    0, 0, -10, -10,
                ],
            }
        )
        frame.loc[[4, 5], "voltage_v"] = float("nan")
        result = dcir.per_occurrence(
            frame,
            rest_step_index=10,
            pulse_step_index=11,
            direction="discharge",
        )

        self.assertEqual(len(result), 2)
        self.assertEqual(result["cycle"].tolist(), [1, 5])
        self.assertTrue((result["current_ma"] > 0).all())

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
