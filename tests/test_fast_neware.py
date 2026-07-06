import os
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

import NewareNDA

from app.services import fast_neware

SAMPLE_FILES = [
    ROOT / "NG_20260317_LFP_LP_MoL_530_FM+CY.ndax",
    ROOT / "AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax",
]


class FastCycleNumberTests(unittest.TestCase):
    """The vectorized cycle-number generator must reproduce the original
    per-row state machine exactly, including SIM/Pause/Rest edge cases."""

    def assert_same(self, statuses, mode="chg"):
        df = pd.DataFrame({"Status": pd.Series(statuses, dtype="str")})
        orig = np.asarray(fast_neware._ORIG_GEN_CYCLE(df, mode), dtype="int64")
        fast = np.asarray(fast_neware._fast_generate_cycle_number(df, mode), dtype="int64")
        self.assertTrue(np.array_equal(orig, fast), f"{mode}: {orig} != {fast}")

    def test_simple_cycles(self):
        seq = ["Rest"] + ["CC_Chg"] * 3 + ["CC_DChg"] * 3 + ["CC_Chg"] * 3 + ["CC_DChg"] * 2
        for mode in ("chg", "dchg", "auto"):
            self.assert_same(seq, mode)

    def test_cccv_cp_and_rest_interleaved(self):
        seq = (
            ["Rest", "CCCV_Chg", "CCCV_Chg", "Rest", "CP_DChg", "Rest",
             "CC_Chg", "CV_Chg", "CC_DChg", "CCCV_Chg", "Rest", "CCCV_DChg",
             "CP_Chg", "CP_Chg", "CR_DChg", "CC_Chg"]
        )
        for mode in ("chg", "dchg", "auto"):
            self.assert_same(seq, mode)

    def test_sim_and_pause(self):
        seq = ["SIM", "SIM", "CC_Chg", "Pause", "CC_DChg", "SIM", "CC_Chg",
               "Pause", "CC_Chg", "CC_DChg", "CC_Chg"]
        for mode in ("chg", "dchg"):
            self.assert_same(seq, mode)

    def test_starts_with_discharge(self):
        seq = ["CC_DChg"] * 2 + ["CC_Chg"] * 2 + ["CC_DChg"] * 2 + ["CC_Chg"]
        for mode in ("chg", "dchg", "auto"):
            self.assert_same(seq, mode)

    def test_no_incremental_steps(self):
        self.assert_same(["Rest", "Rest", "Pause"], "chg")

    def test_bad_mode_raises_keyerror(self):
        df = pd.DataFrame({"Status": pd.Series(["Rest"], dtype="str")})
        with self.assertRaises(KeyError):
            fast_neware._fast_generate_cycle_number(df, "bogus")


class FastNdaxReadTests(unittest.TestCase):
    """Full-file comparison: NewareNDA.read with and without the fast paths
    must produce identical DataFrames (values, dtypes, column order)."""

    def compare(self, path, mode, softcyc):
        fast_neware.uninstall()
        orig = NewareNDA.read(str(path), software_cycle_number=softcyc,
                              cycle_mode=mode, log_level="ERROR")
        fast_neware.install()
        try:
            fast = NewareNDA.read(str(path), software_cycle_number=softcyc,
                                  cycle_mode=mode, log_level="ERROR")
        finally:
            fast_neware.uninstall()
        self.assertEqual(list(orig.columns), list(fast.columns))
        self.assertTrue((orig.dtypes == fast.dtypes).all(),
                        f"dtypes differ: {orig.dtypes} vs {fast.dtypes}")
        self.assertTrue(orig.equals(fast), f"{path.name} mode={mode} soft={softcyc}")

    def test_sample_files_identical(self):
        found = [p for p in SAMPLE_FILES if p.exists()]
        if not found:
            self.skipTest("no sample .ndax files present")
        for path in found:
            for mode in ("chg", "dchg", "auto"):
                for softcyc in (True, False):
                    with self.subTest(file=path.name, mode=mode, soft=softcyc):
                        self.compare(path, mode, softcyc)


if __name__ == "__main__":
    unittest.main()
