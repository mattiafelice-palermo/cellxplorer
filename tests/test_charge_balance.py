"""Charge balance is anchored to the first recorded sample of each Cell."""
import os
import sys
import unittest
from copy import deepcopy
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
from app.services import charge_balance, portable_analysis


class ChargeBalanceTests(unittest.TestCase):
    def test_step_spans_standby_rest_partial_and_continued_sources(self):
        raw = pd.DataFrame({
            "segment": [0] * 7 + [1] * 3,
            "record_index": [1, 2, 3, 4, 5, 6, 7, 1, 2, 3],
            "step": [1, 1, 1, 2, 2, 3, 3, 1, 1, 2],
            "status": ["Chg", "Standby", "Chg", "CV_Chg", "CV_Chg", "Rest", "Rest", "DChg", "DChg", "OCV"],
            "maccor_standby_phase": [None, "charge"] + [None] * 8,
            "current_ma": [5, 0, 5, 4, 1, 0, 0, -5, -5, 0],
            "charge_capacity_mah": [70, 73, 80, 0, 2, 0, 0, 0, 0, 0],
            "discharge_capacity_mah": [0] * 7 + [1, 21, 0],
            "cycle": [1] * 7 + [0] * 3,
        })
        result = charge_balance.trajectory(raw)
        self.assertEqual(result.charge_balance_mah.tolist(), [0, 3, 10, 10, 12, 12, 12, 12, -8, -8])
        self.assertEqual(result.charge_throughput_mah.iloc[-1], 32)
        raw.loc[7, "capacity_verified"] = False
        self.assertTrue(charge_balance.trajectory(raw).charge_balance_mah.iloc[7:].isna().all())

    def test_omitted_mb_intervals_and_unverified_phase_stop_the_prefix(self):
        raw = pd.DataFrame({
            "segment": [0] * 4, "record_index": [1, 2, 10, 11], "step": [1, 1, 2, 2],
            "biologic_mb_time_s": [0, 1, 9, 10], "status": ["Chg"] * 4,
            "charge_capacity_mah": [0, 2, 0, 3],
        })
        self.assertEqual(charge_balance.trajectory(raw).charge_balance_mah.iloc[:2].tolist(), [0, 2])
        self.assertTrue(charge_balance.trajectory(raw).charge_balance_mah.iloc[2:].isna().all())
        raw.loc[0, "status"] = "Unverified"
        self.assertTrue(charge_balance.trajectory(raw).charge_balance_mah.isna().all())

    def test_per_cell_calibration_mass_units_and_portable_identity(self):
        references = {"7": {"start_soc_pct": 60, "capacity_mah": 100},
                      "8": {"start_soc_pct": 0, "basis": "mass", "mass_mg": 10}}
        settings = {"references": references}
        self.assertEqual(charge_balance.calibration(settings, 7), (60, 100))
        self.assertAlmostEqual(charge_balance.calibration(settings, 8)[1], 8.2)
        self.assertEqual(charge_balance.calibration(settings, 8)[0], 0)
        self.assertEqual(charge_balance.calibration(settings, 9), (None, None))
        comp = {"time_capacity": {"balance": settings}}
        spec = {"computation": comp, "saved_plots": [{"computation": deepcopy(comp)}]}
        restored = portable_analysis._remap_spec(spec, {7: 8, 8: 7}, {})
        for recipe in (restored, restored["saved_plots"][0]):
            self.assertEqual(recipe["computation"]["time_capacity"]["balance"]["references"]["8"], references["7"])
        for invalid in (0, -1, np.nan, np.inf):
            self.assertEqual(charge_balance.calibration({"references": {"7": {
                "capacity_mah": invalid, "start_soc_pct": 110,
            }}}, 7), (None, None))
