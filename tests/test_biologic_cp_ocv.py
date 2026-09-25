from __future__ import annotations

import unittest
from types import SimpleNamespace

import numpy as np

from backend.app.services import biologic_cp_ocv, biologic_mpr, calc, canonical_cycling


def cp_records(current: list[float], capacity: list[float]) -> np.ndarray:
    dtype = np.dtype([
        ("elapsed_time_s", "<f8"),
        ("raw_context_dependent_working_potential", "<f8"),
        ("raw_current_ma", "<f8"),
        ("raw_q_charge_discharge_mAh", "<f8"),
    ])
    records = np.zeros(len(current), dtype=dtype)
    records["elapsed_time_s"] = np.arange(len(current), dtype=np.float64) * 10
    records["raw_context_dependent_working_potential"] = np.linspace(1.0, 1.4, len(current))
    records["raw_current_ma"] = current
    records["raw_q_charge_discharge_mAh"] = capacity
    return records


class BiologicCpOcvTests(unittest.TestCase):
    def test_cp_infers_full_cycles_from_active_current_sign_alternation(self) -> None:
        records = cp_records(
            [10, 10, 0, -10, -10, 0, 10, 10, -10],
            [0, 1, 1, 1, 0, 0, 1, 2, 1],
        )
        source = SimpleNamespace(vmp_data=SimpleNamespace(records=records, flags={}))

        frame = biologic_cp_ocv.map_curve_to_canonical(
            source,
            technique_id=biologic_mpr.MPR_CP_TECHNIQUE_ID,
        )

        canonical_cycling.validate_raw_timeseries(frame)
        self.assertEqual(frame["cycle"].tolist(), [1, 1, 1, 1, 1, 1, 2, 2, 2])
        self.assertTrue(frame["cycle_complete"].all())
        self.assertEqual(frame["status"].tolist(), [
            "CC_Chg", "CC_Chg", "Rest", "CC_DChg", "CC_DChg", "Rest",
            "CC_Chg", "CC_Chg", "CC_DChg",
        ])
        self.assertGreater(float(frame["charge_capacity_mah"].max()), 0)
        self.assertGreater(float(frame["discharge_capacity_mah"].max()), 0)
        self.assertEqual(len(calc.per_cycle(frame)), 2)

    def test_unmatched_cp_half_cycle_is_plottable_but_not_counted(self) -> None:
        records = cp_records([10, 10, 10], [0, 1, 2])
        source = SimpleNamespace(vmp_data=SimpleNamespace(records=records, flags={}))

        frame = biologic_cp_ocv.map_curve_to_canonical(
            source,
            technique_id=biologic_mpr.MPR_CP_TECHNIQUE_ID,
        )

        self.assertGreater(float(frame["voltage_v"].max()), float(frame["voltage_v"].min()))
        self.assertFalse(frame["cycle_complete"].any())
        self.assertTrue(calc.per_cycle(frame).empty)

    def test_ocv_voltage_time_rows_are_not_reported_as_cycles(self) -> None:
        dtype = np.dtype([
            ("elapsed_time_s", "<f8"),
            ("raw_context_dependent_working_potential", "<f8"),
        ])
        records = np.zeros(3, dtype=dtype)
        records["elapsed_time_s"] = [1, 4, 9]
        records["raw_context_dependent_working_potential"] = [1.1, 1.2, 1.15]
        source = SimpleNamespace(vmp_data=SimpleNamespace(records=records, flags={}))

        frame = biologic_cp_ocv.map_curve_to_canonical(
            source,
            technique_id=biologic_mpr.MPR_OCV_TECHNIQUE_ID,
        )

        canonical_cycling.validate_raw_timeseries(frame)
        self.assertEqual(frame["time_s"].tolist(), [0, 3, 8])
        self.assertEqual(frame["voltage_v"].tolist(), [1.1, 1.2, 1.15])
        self.assertEqual(frame["status"].tolist(), ["OCV"] * 3)
        self.assertFalse(frame["cycle_complete"].any())
        self.assertTrue(calc.per_cycle(frame).empty)


if __name__ == "__main__":
    unittest.main()
