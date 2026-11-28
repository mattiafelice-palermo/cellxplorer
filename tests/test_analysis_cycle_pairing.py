import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import analysis_cycle_pairing as pairing


class AnalysisCyclePairingTests(unittest.TestCase):
    def test_initial_discharge_crosses_source_boundary_and_last_half_remains_visible(self):
        # Both sources restart their step numbers and capacity counters.
        raw = pd.DataFrame({
            "segment": [0, 0, 0, 1, 1, 1, 1, 1],
            "source_hash": ["a"] * 3 + ["b"] * 5,
            "source_cycle": [1] * 8,
            "cycle": [0] * 3 + [1] * 5,
            "status": ["OCV", "CC_DChg", "CC_DChg", "Rest", "CC_Chg", "CC_Chg", "CC_DChg", "CC_DChg"],
            "current_ma": [0, -10, -10, 0, 10, 10, -10, -10],
            "step": [1, 2, 2, 1, 2, 2, 3, 3],
            "discharge_capacity_mah": [0, 0, 462, 0, 0, 0, 0, 58],
            "charge_capacity_mah": [0, 0, 0, 0, 0, 57, 0, 0],
        })
        labeled = pairing.label_pairs(raw)
        self.assertEqual(labeled.cycle.tolist(), [0, 1, 1, 1, 1, 1, 0, 0])
        self.assertEqual(raw.cycle.tolist(), [0] * 3 + [1] * 5)
        result = pairing.summary(labeled)
        self.assertEqual(result.cycle.tolist(), [1])
        self.assertEqual(result.discharge_capacity_mah.tolist(), [462])
        self.assertEqual(result.charge_capacity_mah.tolist(), [57])
        self.assertTrue(pd.isna(result.source_hash.iloc[0]))
        standard = pairing.label_pairs(raw, charge_first=True)
        self.assertEqual(standard.cycle.tolist(), [0, 0, 0, 0, 1, 1, 1, 1])
        self.assertTrue(standard.attrs["initial_discharge_omitted"])
        self.assertEqual(pairing.summary(standard).discharge_capacity_mah.tolist(), [58])
        labeled.loc[5, "charge_capacity_mah"] = np.nan
        self.assertTrue(pd.isna(pairing.summary(labeled).charge_capacity_mah.iloc[0]))

    def test_neutral_rows_and_unknown_intervals(self):
        raw = pd.DataFrame({
            "segment": 0,
            "status": ["CC_Chg", "CC_DChg", "Unverified", "CC_Chg", "CC_DChg", "Rest", "CC_DChg", "CC_Chg"],
            "current_ma": [10, -10, np.nan, 10, -10, .001, -10, 10],
        })
        self.assertEqual(pairing.label_pairs(raw).cycle.tolist(), [0, 0, 0, 0, 1, 1, 1, 1])
        raw["mpr_acquisition_segment"] = [1] * 7 + [2]
        self.assertFalse(pairing.label_pairs(raw).cycle_complete.any())

    def test_separate_acquisition_clocks_do_not_complete_a_pair(self):
        raw = pd.DataFrame({"segment": [0, 1], "status": ["CC_Chg", "CC_DChg"],
                            "current_ma": [10., -10.], "total_time_s": [0., 60.],
                            "timestamp": pd.to_datetime(["2026-11-19 12:00", "2026-11-19 12:01"])})
        for restarted in (False, True):
            if restarted:
                raw.loc[1, "total_time_s"] = 0
            boundaries = pairing.run_boundaries(raw, [0, 1])
            paired = pairing.label_pairs(raw, charge_first=True, boundaries=boundaries)
            self.assertEqual(paired.cycle_complete.all(), not restarted)
        raw.loc[0, "current_ma"] = np.nan
        self.assertFalse(pairing.label_pairs(raw, charge_first=True).cycle_complete.any())

    def test_standard_pairs_only_in_unprogrammed_runs_and_keeps_programmed_evidence(self):
        # The middle run has a verified summary and an extra measurable pair.
        # The runs on either side lack labels. Each ends with an unmatched charge.
        refs = [pairing.stitch.CachedSourceRef(str(i), "bm:test") for i in range(4)]
        segments = [pairing.stitch.segment_metadata(file_hash=r.file_hash, segment=i,
                    local_labels=[8] if i == 1 else [], global_start=1) for i, r in enumerate(refs)]
        programmed = pd.DataFrame({"cycle": [1], "source_cycle": [8], "segment": [1],
                                   "discharge_capacity_mah": [19.5], "source_hash": ["1"]})
        segments_for_rows = [0]*4 + [1]*2 + [2]*2 + [3]*4
        current = [-1, 1, -1, 1, 1, -1, 1, -1, -1, 1, -1, 1]
        raw = pd.DataFrame({"segment": segments_for_rows, "current_ma": current,
            "cycle": [int(s == 1) for s in segments_for_rows], "source_cycle": 8,
            "status": ["CC_Chg" if i > 0 else "CC_DChg" for i in current],
            "step": range(len(current)), "charge_capacity_mah": 1., "discharge_capacity_mah": 2.,
            "source_hash": list(map(str, segments_for_rows))})
        with patch.object(pairing, "_source_origin", side_effect=["a", "b", "b", "c"]), \
             patch.object(pairing.stitch, "stitch_raw", return_value=(raw, segments, [])):
            result = pairing.supplement_programmed_runs(refs, programmed, segments)
        self.assertEqual(result.cycles.cycle.tolist(), [1, 2, 3])
        self.assertEqual(result.programmed_ids, {1: 2})
        self.assertEqual(result.cycles.iloc[1].discharge_capacity_mah, 19.5)
        self.assertEqual(result.detected_segments, {0, 3})
        self.assertEqual(result.raw.cycle.tolist(), [0, 1, 1, 0, 2, 2, 0, 0, 0, 3, 3, 0])
        self.assertEqual(result.cycles.segment.tolist(), [0, 1, 3])
        self.assertEqual(programmed.cycle.tolist(), [1])
        for origins in (["b"]*4, ["a", None, "b", "c"]):
            with patch.object(pairing, "_source_origin", side_effect=origins), \
                 patch.object(pairing.stitch, "stitch_raw") as load:
                self.assertIsNone(pairing.supplement_programmed_runs(refs, programmed, segments))
                load.assert_not_called()
