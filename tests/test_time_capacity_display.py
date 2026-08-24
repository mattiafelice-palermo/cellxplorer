from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import analysis_engine, time_capacity_derived


class ConsecutiveCapacityDisplayTests(unittest.TestCase):
    def test_charge_rest_discharge_concatenates_and_rest_holds(self) -> None:
        values = np.array([0.0, 2.0, 5.0, 5.0, 0.0, 1.0, 1.0])
        phases = ["charge", "charge", "charge", "rest", "discharge", "discharge", "rest"]

        result = time_capacity_derived.consecutive_capacity_display(values, phases)

        np.testing.assert_allclose(result, [0.0, 2.0, 5.0, 5.0, 5.0, 6.0, 6.0])

    def test_discharge_rest_charge_and_cycle_transition(self) -> None:
        values = np.array([0.0, 3.0, 3.0, 0.0, 4.0, 0.0, 2.0])
        phases = [
            "discharge",
            "discharge",
            "rest",
            "charge",
            "charge",
            "rest",
            "discharge",
        ]

        result = time_capacity_derived.consecutive_capacity_display(values, phases)

        np.testing.assert_allclose(result, [0.0, 3.0, 3.0, 3.0, 7.0, 7.0, 7.0])

    def test_same_direction_steps_do_not_add_an_artificial_offset(self) -> None:
        values = np.array([10.0, 11.0, 10.0, 12.0, 13.0])
        phases = ["charge"] * len(values)

        result = time_capacity_derived.consecutive_capacity_display(values, phases)

        np.testing.assert_allclose(result, [0.0, 1.0, 0.0, 2.0, 3.0])

    def test_same_phase_cycle_reset_continues_from_previous_endpoint(self) -> None:
        values = np.array([0.0, 2.0, 0.0, 3.0])
        phases = ["charge"] * len(values)
        cycles = np.array([1, 1, 2, 2])

        result = time_capacity_derived.consecutive_capacity_display(
            values,
            phases,
            reset_ids=cycles,
        )

        np.testing.assert_allclose(result, [0.0, 2.0, 2.0, 5.0])

    def test_same_phase_discharge_cycle_reset_is_generic(self) -> None:
        values = np.array([0.0, 3.0, 0.0, 1.5])
        phases = ["discharge"] * len(values)

        result = time_capacity_derived.consecutive_capacity_display(
            values,
            phases,
            reset_ids=[1, 1, 2, 2],
        )

        np.testing.assert_allclose(result, [0.0, 3.0, 3.0, 4.5])

    def test_same_phase_source_boundary_uses_phase_capacity_carry(self) -> None:
        raw = pd.DataFrame(
            {
                "cycle": [1, 1, 1, 1],
                "segment": [0, 0, 1, 1],
                "charge_capacity_mah": [0.0, 2.0, 0.0, 1.0],
                "discharge_capacity_mah": [np.nan] * 4,
            }
        )
        phases = ["charge"] * len(raw)
        capacity = time_capacity_derived.phase_capacity(raw, phases)
        settings = {
            "x_axis": "capacity_mah",
            "time_unit": "min",
            "display_mode": "consecutive",
            "view": "voltage_current",
        }

        result = analysis_engine._time_capacity_display_x(
            raw, phases, capacity, None, None, settings
        )

        np.testing.assert_allclose(result, [0.0, 2.0, 2.0, 3.0])

    def test_initial_offset_supports_bounded_refinement(self) -> None:
        values = np.array([0.0, 2.0, 2.0, 0.0, 1.0])
        phases = ["charge", "charge", "rest", "discharge", "discharge"]

        result = time_capacity_derived.consecutive_capacity_display(
            values,
            phases,
            initial_offset=25.0,
        )

        np.testing.assert_allclose(result, [25.0, 27.0, 27.0, 27.0, 28.0])

    def test_scaled_capacity_axes_have_identical_concatenation_shape(self) -> None:
        mah = np.array([0.0, 2.0, 2.0, 0.0, 3.0])
        phases = ["charge", "charge", "rest", "discharge", "discharge"]

        base = time_capacity_derived.consecutive_capacity_display(mah, phases)
        specific = time_capacity_derived.consecutive_capacity_display(mah / 4.0, phases)
        areal = time_capacity_derived.consecutive_capacity_display(mah / 2.0, phases)

        np.testing.assert_allclose(specific, base / 4.0)
        np.testing.assert_allclose(areal, base / 2.0)

    def test_each_cell_has_an_independent_zero_origin(self) -> None:
        phases = ["charge", "rest", "discharge"]

        first = time_capacity_derived.consecutive_capacity_display(
            np.array([100.0, 100.0, 0.0]), phases
        )
        second = time_capacity_derived.consecutive_capacity_display(
            np.array([7.0, 7.0, 0.0]), phases
        )

        np.testing.assert_allclose(first, [0.0, 0.0, 0.0])
        np.testing.assert_allclose(second, [0.0, 0.0, 0.0])

    def test_engine_wrapper_changes_only_consecutive_capacity(self) -> None:
        raw = pd.DataFrame({"cycle": [1, 1, 1, 1], "time_s": [0.0] * 4})
        capacity = np.array([0.0, 2.0, 0.0, 1.0])
        phases = ["charge", "charge", "rest", "discharge"]
        consecutive = {
            "x_axis": "capacity_mah",
            "time_unit": "min",
            "display_mode": "consecutive",
            "view": "voltage_current",
        }
        overlap = {**consecutive, "display_mode": "overlap_reset"}

        np.testing.assert_allclose(
            analysis_engine._time_capacity_display_x(
                raw, phases, capacity, None, None, consecutive
            ),
            [0.0, 2.0, 2.0, 2.0],
        )
        np.testing.assert_allclose(
            analysis_engine._time_capacity_display_x(
                raw, phases, capacity, None, None, overlap
            ),
            [0.0, 2.0, np.nan, 0.0],
            equal_nan=True,
        )

    def test_time_consecutive_remains_the_existing_coordinate(self) -> None:
        raw = pd.DataFrame({"cycle": [1, 1, 2], "time_s": [10.0, 20.0, 5.0]})
        settings = {
            "x_axis": "time",
            "time_unit": "min",
            "display_mode": "consecutive",
            "view": "voltage_current",
        }

        result = analysis_engine._time_capacity_display_x(
            raw, ["charge", "charge", "charge"], None, None, None, settings
        )

        np.testing.assert_allclose(result, np.array([0.0, 10.0, -5.0]) / 60.0)

    def test_exact_cycle_origin_map_is_independent_of_downsampled_rows(self) -> None:
        raw = pd.DataFrame({"cycle": [1, 1, 2, 2, 3, 3]})
        display_x = np.array([0.0, 1.0, 1.0, 2.0, 2.0, 3.0])

        origins = analysis_engine._time_capacity_display_cycle_origins(raw, display_x)

        self.assertEqual(origins, {1: 0.0, 2: 1.0, 3: 2.0})

    def test_neware_and_biologic_reconstructed_rows_share_generic_transform(self) -> None:
        settings = {
            "x_axis": "capacity_mah",
            "time_unit": "min",
            "display_mode": "consecutive",
            "view": "voltage_current",
        }
        fixtures = (
            (
                pd.DataFrame(
                {
                    "cycle": [1, 1, 1, 1, 2, 2, 2, 2],
                    "segment": [0, 0, 0, 0, 0, 0, 0, 0],
                    "status": ["CC_Chg", "CC_Chg", "Rest", "CC_DChg"] * 2,
                    "current_ma": [1.0, 1.0, 0.0, -1.0] * 2,
                    "charge_capacity_mah": [0.0, 2.0, 2.0, 2.0, 0.0, 1.5, 1.5, 1.5],
                    "discharge_capacity_mah": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                }
                ),
                np.array([0.0, 2.0, 2.0, 2.0, 2.0, 3.5, 3.5, 3.5]),
            ),
            (
                pd.DataFrame(
                {
                    "cycle": [1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
                    "segment": [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
                    "status": [
                        "Rest", "CC_Chg", "CC_Chg", "CC_DChg", "CC_DChg",
                        "Rest", "CC_Chg", "CC_Chg", "CC_DChg", "CC_DChg",
                    ],
                    "current_ma": [0.0, 1.0, 1.0, -1.0, -1.0, 0.0, 1.0, 1.0, -1.0, -1.0],
                    "charge_capacity_mah": [0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.5, 0.5, 0.5],
                    "discharge_capacity_mah": [0.0, 0.0, 0.0, 0.0, 0.8, 0.0, 0.0, 0.0, 0.0, 0.6],
                }
                ),
                np.array([0.0, 0.0, 1.0, 1.0, 1.8, 1.8, 1.8, 2.3, 2.3, 2.9]),
            ),
        )
        for raw, expected in fixtures:
            with self.subTest(rows=len(raw)):
                phases = time_capacity_derived.phase_from_raw(raw)
                capacity = time_capacity_derived.phase_capacity(raw, phases)
                result = analysis_engine._time_capacity_display_x(
                    raw, phases, capacity, None, None, settings
                )
                np.testing.assert_allclose(result, expected)
                finite = result[np.isfinite(result)]
                self.assertGreater(len(finite), 0)
                self.assertEqual(
                    int(np.sum(np.diff(finite) < -1e-9)),
                    0,
                )


if __name__ == "__main__":
    unittest.main()
