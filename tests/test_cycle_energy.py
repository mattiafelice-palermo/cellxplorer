import os
import sys
import unittest
from collections import OrderedDict
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
from app.services import cycle_energy as energy, cycle_throughput, calc, stitch


class CycleEnergyTests(unittest.TestCase):
    def raw(self):
        raw = pd.DataFrame({"record_index": [1, 2, 3, 4, 5, 6], "cycle": [1] * 6,
            "step": [1, 1, 1, 2, 2, 2], "status": ["CC_Chg"] * 3 + ["CC_DChg"] * 3,
            "current_ma": [1.] * 3 + [-1.] * 3, "voltage_v": [2., 3., 4., 3., 2., 1.],
            "total_time_s": [0., 1., 2., 3., 4., 5.], "segment": [0] * 6,
            "charge_capacity_mah": [0., 1., 2., 0., 0., 0.],
            "discharge_capacity_mah": [0., 0., 0., 0., 1., 2.]})
        raw.attrs["biologic_gcpl"] = {"adapter_revision": "gcpl18", "scientific_interpretation": "verified"}
        return raw

    def resolve(self, raw, names=None, summary=None):
        summary = calc.per_cycle(raw) if summary is None else summary
        with patch.object(energy, "_descriptor", return_value=set(raw) if names is None else names), patch.object(energy.cache, "raw_path", return_value=Path(__file__)), patch.object(energy.pd, "read_parquet", return_value=raw), patch.object(energy, "_MEMO", OrderedDict()):
            return energy.resolve(summary, [stitch.CachedSourceRef("test", "bm:test:r8")], summary)

    def test_analytic_trapezoid_both_directions_efficiency_mass_and_prefix(self):
        result, cumulative, provenance = self.resolve(self.raw())
        self.assertEqual(result.charge_energy_mwh.tolist(), [6])
        self.assertEqual(result.discharge_energy_mwh.tolist(), [4])
        self.assertAlmostEqual(result.energy_efficiency_pct.iloc[0], 100 * 4 / 6)
        totals = cycle_throughput.add_columns(cumulative, 2, 2000)
        self.assertEqual(totals.energy_throughput_mwh_g.iloc[0], 5)
        self.assertEqual(totals.fec.iloc[0], 1)
        self.assertEqual(provenance["charge"][0]["basis"], "calculated")

    def test_signed_cancellation_and_negative_net(self):
        raw = self.raw()
        raw.loc[:2, "voltage_v"] = [3, -1, 3]
        result, _, _ = self.resolve(raw)
        self.assertEqual(result.charge_energy_mwh.iloc[0], 2)
        raw.loc[:2, "voltage_v"] = [-3, 1, -3]
        result, _, provenance = self.resolve(raw)
        self.assertTrue(np.isnan(result.charge_energy_mwh.iloc[0]))
        self.assertEqual(result.discharge_energy_mwh.iloc[0], 4)
        self.assertEqual(provenance["charge"][0]["reason"], "negative net directional energy")

    def test_native_precedence_and_holes_are_not_filled(self):
        raw = self.raw()
        raw["charge_energy_mwh"] = [0, 50, 100, 0, 0, 0]
        raw["discharge_energy_mwh"] = np.nan
        result, _, provenance = self.resolve(raw)
        self.assertEqual(result.charge_energy_mwh.iloc[0], 100)
        self.assertTrue(np.isnan(result.discharge_energy_mwh.iloc[0]))
        self.assertEqual(provenance["discharge"][0]["basis"], "unavailable")

    def test_multistep_capacity_origin_and_no_bridge(self):
        raw = self.raw()
        raw.loc[:2, "charge_capacity_mah"] += 10
        value, reason = energy.integrate_phase(raw, "charge", 2)
        self.assertEqual((value, reason), (6, None))
        raw.loc[2, "step"] = 3
        self.assertIsNotNone(energy.integrate_phase(raw, "charge", 2)[1])

    def test_missing_voltage_record_time_direction_segment_and_reversal(self):
        cases = [("voltage_v", 1, np.nan), ("record_index", 1, 9),
            ("total_time_s", 1, -1), ("current_ma", 1, -1),
            ("charge_capacity_mah", 2, .5)]
        for column, row, value in cases:
            with self.subTest(column=column):
                raw = self.raw()
                raw.loc[row, column] = value
                self.assertIsNotNone(energy.integrate_phase(raw, "charge", 2)[1])
        raw = self.raw()
        raw["mpr_acquisition_segment"] = [0, 1, 1, 1, 1, 1]
        self.assertIsNotNone(energy.integrate_phase(raw, "charge", 2)[1])

    def test_zero_transfer_does_not_require_voltage_but_one_sample_insufficient(self):
        raw = self.raw()
        raw.loc[:2, "charge_capacity_mah"] = 0
        raw.loc[:2, "voltage_v"] = np.nan
        self.assertEqual(energy.integrate_phase(raw, "charge", 0), (0, None))
        self.assertIsNotNone(energy.integrate_phase(raw.iloc[[0]], "charge", 0)[1])
        raw.loc[1:2, "record_index"] = [9, 20]
        self.assertIsNotNone(energy.integrate_phase(raw, "charge", 0)[1])

    def test_reconciliation_withholds_only_affected_direction(self):
        raw = self.raw()
        summary = calc.per_cycle(raw)
        summary.loc[0, "charge_capacity_mah"] = 3
        result, _, provenance = self.resolve(raw, summary=summary)
        self.assertTrue(np.isnan(result.charge_energy_mwh.iloc[0]))
        self.assertEqual(result.discharge_energy_mwh.iloc[0], 4)
        self.assertIn("reconciliation", provenance["charge"][0]["reason"])

    def test_native_format_never_opens_raw(self):
        with patch.object(energy.pq, "ParquetFile", side_effect=AssertionError("native raw opened")):
            self.assertIsNone(energy._descriptor(stitch.CachedSourceRef("x", "nb:1:r8")))
            self.assertIsNone(energy.dependency_identity(stitch.CachedSourceRef("x", "nx:1:r8")))
        with np.errstate(over="ignore"):
            raw = self.raw()
            raw.loc[:2, "voltage_v"] = 1e308
            self.assertIn("non-finite", energy.integrate_phase(raw, "charge", 2)[1])

    def test_mixed_chain_reads_only_gcpl_and_preserves_native_summary_and_efficiency(self):
        raw = self.raw()
        first = calc.per_cycle(raw).assign(segment=0, source_cycle=1)
        native = first.copy().assign(cycle=2, segment=1, charge_energy_mwh=90., discharge_energy_mwh=60., energy_efficiency_pct=66.)
        summary = pd.concat([first, native], ignore_index=True)
        qualified = summary.copy()
        qualified.loc[1, ["charge_energy_mwh", "discharge_energy_mwh"]] = np.nan
        refs = [stitch.CachedSourceRef("gcpl", "bm:test:r8"), stitch.CachedSourceRef("native", "nb:test:r8")]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "gcpl.parquet"
            raw.to_parquet(path)
            def raw_path(file_hash, _version):
                self.assertEqual(file_hash, "gcpl", "unrelated native source raw opened")
                return path
            with patch.object(energy.cache, "raw_path", side_effect=raw_path):
                resolved, prefixes, _ = energy.resolve(summary, refs, qualified)
        self.assertEqual(resolved.charge_energy_mwh.tolist(), [6., 90.])
        self.assertEqual(resolved.energy_efficiency_pct.iloc[1], 66.)
        self.assertTrue(np.isnan(prefixes.charge_energy_mwh.iloc[1]))

    def test_paired_source_mapping_restores_record_order_without_crossing_sources(self):
        raw = self.raw()
        charge = raw.iloc[:3].copy().assign(cycle=7)
        discharge = raw.iloc[3:].iloc[::-1].copy().assign(cycle=19)
        refs = [stitch.CachedSourceRef("a", "bm:test:r8"), stitch.CachedSourceRef("b", "bm:test:r8")]
        summary = calc.per_cycle(raw).assign(cycle=4, segment=0, source_cycle=7)
        with TemporaryDirectory() as directory:
            paths = {h: Path(directory) / f"{h}.parquet" for h in ("a", "b")}
            charge.to_parquet(paths["a"])
            discharge.to_parquet(paths["b"])
            with patch.object(energy.cache, "raw_path", side_effect=lambda h, p: paths[h]):
                resolved, _, provenance = energy.resolve(summary, refs, summary,
                    [{"segment": 0, "cycle_mapping": {7: 4}}, {"segment": 1, "cycle_mapping": {19: 4}}])
        self.assertEqual(resolved.charge_energy_mwh.iloc[0], 6)
        self.assertEqual(resolved.discharge_energy_mwh.iloc[0], 4)
        self.assertEqual(provenance["discharge"][0]["basis"], "calculated")

    def test_no_inode_voltage_change_versions_outcome_and_bypasses_memo(self):
        raw = self.raw()
        ref = stitch.CachedSourceRef("a", "bm:test:r8")
        with TemporaryDirectory() as directory:
            path = Path(directory) / "raw.parquet"
            raw.to_parquet(path)
            with patch.object(energy.cache, "raw_path", return_value=path), patch.object(energy, "_storage_identity", return_value=None), patch.object(energy, "_MEMO", OrderedDict()) as memo:
                first = energy.dependency_identity(ref)
                raw.voltage_v *= 2
                raw.to_parquet(path)
                self.assertNotEqual(energy.dependency_identity(ref), first)
                self.assertEqual(len(memo), 0)

    def test_compact_memo_is_bounded_and_source_disappearance_is_unavailable(self):
        raw = self.raw()
        with TemporaryDirectory() as directory:
            paths = {}
            for h in ("a", "b", "c"):
                paths[h] = Path(directory) / f"{h}.parquet"
                raw.to_parquet(paths[h])
            with patch.object(energy.cache, "raw_path", side_effect=lambda h, p: paths[h]), patch.object(energy, "_MAX_ENTRIES", 2), patch.object(energy, "_MEMO", OrderedDict()) as memo:
                for h in paths:
                    energy._outcomes(stitch.CachedSourceRef(h, "bm:test:r8"), set(raw))
                self.assertEqual(len(memo), 2)
                self.assertTrue(all(isinstance(v, bytes) for v in memo.values()))
                paths["a"].unlink()
                self.assertIsNone(energy.dependency_identity(stitch.CachedSourceRef("a", "bm:test:r8")))

    def test_gap_stops_prefix_but_later_cycle_energy_remains_independent(self):
        first = self.raw()
        bad = self.raw().assign(cycle=2)
        bad.loc[:2, "voltage_v"] = -1
        later = self.raw().assign(cycle=3)
        raw = pd.concat([first, bad, later], ignore_index=True)
        result, cumulative, provenance = self.resolve(raw)
        self.assertEqual(result.discharge_energy_mwh.tolist(), [4, 4, 4])
        self.assertEqual(result.charge_energy_mwh.iloc[2], 6)
        full = cycle_throughput.add_columns(cumulative, 2, None)
        self.assertTrue(full.energy_throughput_mwh.iloc[1:].isna().all())
        self.assertEqual(full.cumulative_discharge_energy_mwh.tolist(), [4, 8, 12])
        self.assertEqual(provenance["charge"][2]["basis"], "calculated")
        self.assertEqual(provenance["charge"][2]["cumulative_basis"], "unavailable")

    def test_fixed_cohort_group_provenance_is_mixed_and_preserves_hidden_gap(self):
        measured = {"basis": "measured", "reason": None, "cumulative_basis": "measured", "cumulative_reason": None}
        calculated = {**measured, "basis": "calculated", "cumulative_basis": "calculated"}
        gap = {**calculated, "cumulative_basis": "unavailable", "cumulative_reason": "negative net directional energy"}
        member = lambda entries: {"x": [1, 3], "energy_provenance": {d: entries for d in energy.DIRECTIONS}}
        a, b = member([measured, measured]), member([calculated, gap])
        result = energy.aggregate_provenance([a, b], [a, b], [1, 3])
        self.assertEqual(result["charge"][0]["basis"], "mixed")
        self.assertEqual(result["charge"][1]["basis"], "mixed")
        self.assertEqual(result["charge"][1]["cumulative_basis"], "unavailable")
        complete = {"x": [1, 2, 3], "energy_provenance": {d: [measured] * 3 for d in energy.DIRECTIONS}}
        missing = member([calculated, calculated])
        recovered = energy.aggregate_provenance([complete, missing], [complete, missing], [3])
        self.assertEqual(recovered["charge"][0]["cumulative_basis"], "unavailable")

    def test_ordinary_gcpl_after_a_paired_cohort_keeps_its_own_mapping(self):
        raw = self.raw()
        refs = [stitch.CachedSourceRef(str(i), "bm:test:r8") for i in range(3)]
        summary = calc.per_cycle(raw).assign(cycle=2, segment=2, source_cycle=1)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "raw.parquet"
            raw.to_parquet(path)
            with patch.object(energy.cache, "raw_path", return_value=path):
                resolved, _, _ = energy.resolve(summary, refs, summary,
                    [{"segment": 0, "cycle_mapping": {1: 1}}, {"segment": 1, "cycle_mapping": {1: 1}}, {"segment": 2}])
        self.assertEqual(resolved.charge_energy_mwh.iloc[0], 6)

    def test_group_energy_basis_follows_efficiency_and_mass_contributors(self):
        measured = {"basis": "measured", "reason": None, "cumulative_basis": "measured", "cumulative_reason": None}
        calculated = {**measured, "basis": "calculated", "cumulative_basis": "calculated"}
        missing = {**measured, "basis": "unavailable", "reason": "negative net directional energy"}
        a = {"x": [1], "quantities": {"energy_efficiency_pct": [70.], "charge_energy_mwh_g": [10.]},
            "energy_provenance": {"charge": [measured], "discharge": [measured]}}
        b = {"x": [1], "quantities": {"energy_efficiency_pct": [None], "charge_energy_mwh_g": [None]},
            "energy_provenance": {"charge": [calculated], "discharge": [missing]}}
        agg = {"x": [1], "quantities": {"energy_efficiency_pct": {"mean": [70.]}, "charge_energy_mwh_g": {"mean": [10.]}}}
        provenance = energy.aggregate_quantity_provenance([a, b], [a, b], agg)
        self.assertEqual(provenance["energy_efficiency_pct"][0]["basis"], "measured")
        self.assertEqual(provenance["charge_energy_mwh_g"][0]["basis"], "measured")
        b["quantities"]["discharge_energy_mwh"] = [None]
        unavailable = energy.aggregate_quantity_provenance([b], [b], {"x": [1], "quantities": {"discharge_energy_mwh": {"mean": [None]}}})
        self.assertIn("negative net directional energy", unavailable["discharge_energy_mwh"][0]["reason"])

    def test_no_inode_digest_tracks_later_native_counter_holes(self):
        raw = pd.concat([self.raw().assign(cycle=i) for i in (1, 2, 3)], ignore_index=True)
        raw["charge_energy_mwh"] = raw.charge_capacity_mah * 10
        raw["discharge_energy_mwh"] = raw.discharge_capacity_mah * 10
        raw.loc[raw.cycle.isin([2, 3]) & raw.status.eq("CC_DChg"), "discharge_energy_mwh"] = np.nan
        ref = stitch.CachedSourceRef("a", "bm:test:r8")
        with TemporaryDirectory() as directory:
            path = Path(directory) / "raw.parquet"
            raw.to_parquet(path)
            with patch.object(energy.cache, "raw_path", return_value=path), patch.object(energy, "_storage_identity", return_value=None):
                first = energy.dependency_identity(ref)
                raw.loc[raw.cycle.eq(3), "discharge_energy_mwh"] = raw.loc[raw.cycle.eq(3), "discharge_capacity_mah"] * 10
                raw.to_parquet(path)
                self.assertNotEqual(energy.dependency_identity(ref), first)


if __name__ == "__main__":
    unittest.main()
