import os
from pathlib import Path
import sys
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch
from types import SimpleNamespace

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
from app.services import analysis_engine as engine, cycle_throughput as throughput
from app.services import calc


class CycleThroughputTests(unittest.TestCase):
    def frame(self):
        return pd.DataFrame({
            "cycle": [1, 2, 3],
            "charge_capacity_mah": [10, -8, 6],
            "discharge_capacity_mah": [-8, 6, 4],
            "charge_energy_mwh": [40, 32, 24],
            "discharge_energy_mwh": [24, 18, 12],
        })

    def test_directional_totals_throughput_imbalance_energy_mass_and_conventions(self):
        frame = throughput.add_columns(self.frame(), 10, 2000)
        expected = {
            "cumulative_charge_capacity_mah": [10, 18, 24],
            "cumulative_discharge_capacity_mah": [8, 14, 18],
            "capacity_throughput_mah": [18, 32, 42],
            "net_coulomb_imbalance_mah": [2, 4, 6],
            "cumulative_charge_energy_mwh": [40, 72, 96],
            "cumulative_discharge_energy_mwh": [24, 42, 54],
            "energy_throughput_mwh": [64, 114, 150],
            "net_energy_imbalance_mwh": [16, 30, 42],
            "fec": [.9, 1.6, 2.1],
        }
        for column, values in expected.items():
            np.testing.assert_allclose(frame[column], values)
            if column != "fec":
                np.testing.assert_allclose(frame[column + "_g"], np.array(values) / 2)
        discharge = throughput.add_columns(self.frame(), 10, None, "discharge")
        np.testing.assert_allclose(discharge.fec, [.8, 1.4, 1.8])

    def test_missing_reference_disables_only_fec(self):
        for reference in (None, 0, -1, float("inf"), float("nan")):
            frame = throughput.add_columns(self.frame(), reference, None)
            self.assertTrue(frame.fec.isna().all())
            self.assertEqual(frame.capacity_throughput_mah.iloc[-1], 42)
            self.assertTrue(frame.capacity_throughput_mah_g.isna().all())

    def test_gap_poison_is_directional_permanent_and_independent_of_energy(self):
        raw = self.frame()
        raw.loc[1, "charge_capacity_mah"] = np.nan
        frame = throughput.add_columns(raw, 10, 2000)
        for column in ("cumulative_charge_capacity_mah", "capacity_throughput_mah", "net_coulomb_imbalance_mah", "fec"):
            self.assertTrue(frame[column].iloc[1:].isna().all())
        self.assertEqual(frame.cumulative_discharge_capacity_mah.iloc[-1], 18)
        self.assertEqual(frame.energy_throughput_mwh.iloc[-1], 150)
        discharge = throughput.add_columns(raw, 10, 2000, "discharge")
        self.assertEqual(discharge.fec.iloc[-1], 1.8)

    def test_fixed_cohort_alignment_does_not_shrink_or_restart(self):
        members = [
            {"x": [1, 2, 3, 4], "quantities": {"fec": [1, 2, 3, 4], "capacity": [1, 2, 3, 4]}},
            {"x": [1, 3, 4], "quantities": {"fec": [2, 6, 8], "capacity": [2, 6, 8]}},
        ]
        result = engine.aggregate_series(members, ["fec", "capacity"], {"min_n_for_band": 2})
        self.assertEqual(result["x"], [1, 2, 3, 4])
        self.assertEqual(result["quantities"]["fec"]["mean"], [1.5, None, None, None])
        self.assertEqual(result["quantities"]["capacity"]["mean"], [1.5, 2, 4.5, 6])
        members[1] = {"x": [], "quantities": {"fec": [], "capacity": []}}
        result = engine.aggregate_series(members, ["fec", "capacity"], {})
        self.assertEqual(result["quantities"]["fec"]["mean"], [None] * 4)

    def test_real_summary_missing_counter_zero_is_not_a_known_increment(self):
        rows = []
        for cycle in (1, 2, 3):
            for status, direction in (("CC_Chg", "charge"), ("CC_DChg", "discharge")):
                for value in (0, 1):
                    rows.append({"cycle": cycle, "step": cycle * 2 + (direction == "discharge"), "status": status,
                        "charge_capacity_mah": np.nan if cycle == 2 and direction == "charge" else value if direction == "charge" else 0,
                        "discharge_capacity_mah": value if direction == "discharge" else 0})
        raw = pd.DataFrame(rows)
        summary = calc.per_cycle(raw)
        self.assertEqual(summary.charge_capacity_mah.tolist(), [1, 0, 1])
        summary["segment"] = 0
        summary["source_cycle"] = summary.cycle
        with TemporaryDirectory() as directory:
            path = Path(directory) / "raw.parquet"
            raw.to_parquet(path)
            ref = SimpleNamespace(file_hash="source", parser_version="parser")
            with patch.object(throughput.cache, "raw_path", return_value=path):
                first_identity = throughput.evidence_identity(ref)
                qualified = throughput.proven_increments(summary, [ref])
                os.utime(path, None)
                self.assertEqual(throughput.evidence_identity(ref), first_identity)
            actual = throughput.add_columns(qualified, 1, None)
            self.assertEqual(engine._jsonsafe(actual.fec.to_numpy()), [1, None, None])
            self.assertEqual(actual.cumulative_discharge_capacity_mah.tolist(), [1, 2, 3])

    def test_readable_raw_without_inode_bypasses_memo_and_versions_evidence_outcome(self):
        raw = pd.DataFrame({"cycle": [1, 1], "step": [1, 1], "status": ["CC_Chg", "CC_Chg"], "charge_capacity_mah": [0., 1.]})
        summary = pd.DataFrame({"cycle": [1], "source_cycle": [1], "segment": [0], "charge_capacity_mah": [1.]})
        ref = SimpleNamespace(file_hash="source", parser_version="parser")
        with TemporaryDirectory() as directory:
            path = Path(directory) / "raw.parquet"
            raw.to_parquet(path)
            with patch.object(throughput.cache, "raw_path", return_value=path), patch.object(throughput, "_cache_identity", return_value=None), patch.object(throughput, "_unknown_cycles", side_effect=AssertionError("uncacheable file was memoized")):
                first = throughput.evidence_identity(ref)
                self.assertEqual(throughput.proven_increments(summary, [ref]).charge_capacity_mah.tolist(), [1.])
                raw.charge_capacity_mah = np.nan
                raw.to_parquet(path)
                self.assertNotEqual(throughput.evidence_identity(ref), first)
                self.assertTrue(throughput.proven_increments(summary, [ref]).charge_capacity_mah.isna().all())
                path.unlink()
                self.assertIsNone(throughput.evidence_identity(ref))
                self.assertTrue(throughput.proven_increments(summary, [ref]).charge_capacity_mah.isna().all())


if __name__ == "__main__":
    unittest.main()
