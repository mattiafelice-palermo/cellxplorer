import os
import shutil
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Cell, CellMetadata, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
from app.routers.library import get_cell_protocol
from app.services import analysis_engine as engine
from app.services import cache, parsing, protocol


def analysis_protocol_header() -> dict[str, str]:
    return {
        "Step.Step_Info.Step1.Step_Type": "1",
        "Step.Step_Info.Step1.Limit.Main.Curr.Value": "1000",
        "Step.Step_Info.Step1.Limit.Main.Stop_Volt.Value": "42000",
        "Step.Step_Info.Step2.Step_Type": "2",
        "Step.Step_Info.Step2.Limit.Main.Curr.Value": "-1000",
        "Step.Step_Info.Step2.Limit.Main.Stop_Volt.Value": "30000",
        "Step.Step_Info.Step3.Step_Type": "1",
        "Step.Step_Info.Step3.Limit.Main.Curr.Value": "1000",
        "Step.Step_Info.Step3.Limit.Main.Stop_Volt.Value": "41000",
    }


def synth_raw(n_cycles: int, cap0: float, fade: float) -> pd.DataFrame:
    rows, idx, t = [], 0, 0.0
    for cyc in range(1, n_cycles + 1):
        cap = cap0 * (1 - fade) ** (cyc - 1)
        for status, sign in (("CC_Chg", 1), ("CC_DChg", -1)):
            for frac in (0.5, 1.0):
                idx += 1
                t += 1800
                rows.append({
                    "record_index": idx, "cycle": cyc, "step": cyc * 2 + (0 if sign > 0 else 1),
                    "step_index": (1 if cyc % 2 else 3) if sign > 0 else 2,
                    "status": status, "time_s": 1800.0 * frac,
                    "voltage_v": 3.3 + sign * 0.2,
                    "current_ma": sign * 1000.0,
                    "charge_capacity_mah": cap * frac if sign > 0 else cap,
                    "discharge_capacity_mah": 0.0 if sign > 0 else cap * frac * 0.99,
                    "charge_energy_mwh": cap * frac * 3.5 if sign > 0 else cap * 3.5,
                    "discharge_energy_mwh": 0.0 if sign > 0 else cap * frac * 3.2,
                    "timestamp": pd.Timestamp("2026-01-01") + pd.Timedelta(seconds=t),
                })
    return pd.DataFrame(rows)


class AnalysisEngineTests(unittest.TestCase):
    HASHES = {"c1": "a1" * 32, "c2": "b2" * 32}
    FRAMES = {}

    @classmethod
    def setUpClass(cls):
        cls._orig_parse = parsing.parse_timeseries
        cls.FRAMES = {
            cls.HASHES["c1"]: synth_raw(50, 2.0, 0.005),   # fades to ~78% by cycle 50
            cls.HASHES["c2"]: synth_raw(30, 2.0, 0.002),   # dies early, mild fade
        }

        def fake_parse(path):
            return cls.FRAMES[Path(str(path)).stem]

        parsing.parse_timeseries = fake_parse
        for h in cls.HASHES.values():
            d = cache.raw_path(h).parent
            if d.exists():
                shutil.rmtree(d)
            cache.build(h, h)  # path stem == hash → fake_parse resolves it

    @classmethod
    def tearDownClass(cls):
        parsing.parse_timeseries = cls._orig_parse
        for h in cls.HASHES.values():
            shutil.rmtree(cache.raw_path(h).parent, ignore_errors=True)

    def setUp(self):
        eng = create_engine("sqlite://", connect_args={"check_same_thread": False},
                            poolclass=StaticPool)
        Base.metadata.create_all(eng)
        self.db = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)()
        self.cells = {}
        for i, (name, h) in enumerate(self.HASHES.items(), start=1):
            cell = Cell(name=name)
            self.db.add(cell)
            self.db.flush()
            sf = SourceFile(hash=h, path=h, filename=f"{name}.ndax", size=1, ext="ndax",
                            parse_status="parsed", parser_version=parsing.PARSER_VERSION,
                            header_meta=analysis_protocol_header(), nominal_capacity_mah=2.0)
            self.db.add(sf)
            test = Test(cell_id=cell.id, name="t")
            self.db.add(test)
            self.db.flush()
            self.db.add(TestFile(test_id=test.id, file_id=sf.id, position=0))
            self.cells[name] = cell
        group = ReplicateGroup(name="G")
        self.db.add(group)
        self.db.flush()
        for j, cell in enumerate(self.cells.values()):
            self.db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell.id, position=j))
        self.db.commit()
        self.group = group

    def spec_with(self, entries, **comp):
        spec = engine.default_spec("t")
        spec["selection"]["entries"] = entries
        spec["computation"].update(comp)
        return spec

    def spec_with_protocol_mode(self, mode: str) -> dict:
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        signature = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )["signature"]
        spec["protocol_segments"] = [
            {
                "id": "odd-charge",
                "name": "Odd-cycle charge",
                "targets": [{"protocol_signature": signature, "step_indices": [1]}],
            }
        ]
        if mode == "hidden":
            spec["presentation"]["hidden_protocol_segment_ids"] = ["odd-charge"]
        else:
            spec["computation"]["protocol_filter"][f"{mode}_segment_ids"] = [
                "odd-charge"
            ]
        return spec

    def test_default_spec_has_saved_plot_container(self):
        spec = engine.default_spec("t")
        self.assertEqual(spec["spec_version"], engine.SPEC_VERSION)
        self.assertEqual(spec["saved_plots"], [])
        self.assertEqual(spec["protocol_segments"], [])
        self.assertEqual(
            spec["computation"]["protocol_filter"],
            {"excluded_segment_ids": [], "only_segment_ids": []},
        )
        self.assertEqual(spec["presentation"]["hidden_protocol_segment_ids"], [])

    def test_cycle_protocol_filters_distinguish_hidden_excluded_and_only(self):
        expected = {
            "excluded": (list(range(2, 51, 2)), 25),
            "hidden": (list(range(2, 51, 2)), 50),
            "only": (list(range(1, 51, 2)), 25),
        }
        for mode, (cycles, metric_count) in expected.items():
            with self.subTest(mode=mode):
                result = engine.compute(self.db, self.spec_with_protocol_mode(mode), None)
                series = result["cell_series"][0]
                self.assertEqual(series["x"], cycles)
                self.assertEqual(series["metrics"]["n_cycles"], metric_count)

    def test_cycle_compute_does_not_load_raw_without_protocol_filter(self):
        original = cache.load_raw_columns
        cache.load_raw_columns = (
            lambda *_args, **_kwargs: self.fail("raw cache fast path regressed")
        )
        try:
            result = engine.compute(
                self.db,
                self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}]),
                None,
            )
        finally:
            cache.load_raw_columns = original
        self.assertEqual(result["cell_series"][0]["metrics"]["n_cycles"], 50)

    def test_cell_protocol_payload_includes_source_hash_and_signature(self):
        result = get_cell_protocol(self.cells["c1"].id, self.db)
        source = result["tests"][0]["files"][0]

        self.assertEqual(source["hash"], self.HASHES["c1"])
        self.assertEqual(
            source["protocol"]["signature"],
            protocol.reconstruct_protocol(analysis_protocol_header(), 2.0)["signature"],
        )

    def test_stale_protocol_segment_id_is_badged_and_ignored(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["protocol_filter"]["only_segment_ids"] = ["gone"]

        result = engine.compute(self.db, spec, None)

        self.assertEqual(result["cell_series"][0]["metrics"]["n_cycles"], 50)
        self.assertIn(
            "protocol_segment_missing",
            {badge["kind"] for badge in result["badges"]},
        )

    def test_missing_protocol_metadata_is_badged(self):
        source = self.cells["c1"].tests[0].file_links[0].file
        source.header_meta = None
        self.db.flush()

        result = engine.compute(self.db, self.spec_with_protocol_mode("excluded"), None)

        self.assertIn("protocol_missing", {badge["kind"] for badge in result["badges"]})
        self.assertEqual(result["cell_series"][0]["metrics"]["n_cycles"], 50)

    def test_step_index_matching_is_scoped_by_protocol_signature(self):
        spec = self.spec_with_protocol_mode("excluded")
        source = self.cells["c1"].tests[0].file_links[0].file
        changed_header = analysis_protocol_header()
        changed_header["Step.Step_Info.Step1.Limit.Main.Stop_Volt.Value"] = "41500"
        source.header_meta = changed_header
        self.db.flush()

        result = engine.compute(self.db, spec, None)

        self.assertEqual(result["cell_series"][0]["x"], list(range(1, 51)))
        self.assertIn(
            "protocol_segment_unmatched",
            {badge["kind"] for badge in result["badges"]},
        )

    def test_time_protocol_filters_emit_null_gaps_without_dropping_rows(self):
        expected_non_null = {"excluded": 150, "hidden": 150, "only": 50}
        for mode, non_null_count in expected_non_null.items():
            with self.subTest(mode=mode):
                result = engine.compute_time_capacity(
                    self.db, self.spec_with_protocol_mode(mode), None
                )
                trace = result["cell_traces"][0]
                self.assertEqual(len(trace["cycle"]), 200)
                self.assertEqual(len(trace["time_s"]), 200)
                self.assertEqual(
                    sum(value is not None for value in trace["voltage_v"]),
                    non_null_count,
                )
                self.assertEqual(
                    sum(value is not None for value in trace["capacity_mah"]),
                    non_null_count,
                )

    def test_group_and_cell_selection(self):
        spec = self.spec_with([
            {"kind": "replicate_group", "ref_id": self.group.id},
            {"kind": "cell", "ref_id": self.cells["c1"].id, "label_override": "solo"},
        ])
        res = engine.compute(self.db, spec, None)
        self.assertEqual(len(res["cell_series"]), 3)  # 2 via group + 1 solo
        self.assertEqual(len(res["aggregates"]), 1)
        agg = res["aggregates"][0]
        self.assertEqual(agg["max_n"], 2)
        col = "discharge_capacity_mah"
        n = agg["quantities"][col]["n"]
        self.assertEqual(max(n), 2)
        self.assertEqual(min(n), 1)  # c2 dies at cycle 30
        # band hidden where n < 2
        lows = agg["quantities"][col]["band_low"]
        self.assertIsNone(lows[-1])
        self.assertIsNotNone(lows[5])

    def test_scoped_exclusion_does_not_hide_same_cell_in_other_context(self):
        cell_id = self.cells["c1"].id
        spec = self.spec_with([
            {"kind": "replicate_group", "ref_id": self.group.id},
            {"kind": "cell", "ref_id": cell_id},
        ])
        spec["selection"]["exclusions"] = [{
            "cell_id": cell_id,
            "entry_kind": "replicate_group",
            "entry_ref_id": self.group.id,
        }]

        result = engine.compute(self.db, spec, None)

        grouped = next(series for series in result["cell_series"] if series["cell_id"] == cell_id and series["group_id"] is not None)
        standalone = next(series for series in result["cell_series"] if series["cell_id"] == cell_id and series["group_id"] is None)
        self.assertTrue(grouped["excluded"])
        self.assertFalse(standalone["excluded"])

    def test_hidden_replicate_does_not_hide_standalone_copy(self):
        cell_id = self.cells["c1"].id
        spec = self.spec_with([
            {"kind": "replicate_group", "ref_id": self.group.id},
            {"kind": "cell", "ref_id": cell_id},
        ])
        spec["selection"]["hidden_replicate_group_ids"] = [self.group.id]

        result = engine.compute(self.db, spec, None)

        self.assertTrue(all(series["excluded"] for series in result["cell_series"] if series["group_id"] == self.group.id))
        standalone = next(series for series in result["cell_series"] if series["group_id"] is None)
        self.assertFalse(standalone["excluded"])
        self.assertEqual(result["aggregates"], [])

    def test_derived_quantities(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        res = engine.compute(self.db, spec, None)
        s = res["cell_series"][0]
        ve = s["quantities"]["voltaic_efficiency_pct"]
        # 3.1 / 3.5 * 100
        self.assertAlmostEqual(ve[0], 3.1 / 3.5 * 100, places=6)
        ret = s["quantities"]["capacity_retention_pct"]
        self.assertAlmostEqual(max(v for v in ret if v is not None), 100.0, delta=0.6)
        self.assertLess(ret[-1], 80.0)
        m = s["metrics"]
        self.assertEqual(m["n_cycles"], 50)
        self.assertIsNotNone(m["cycles_to_80_pct"])
        self.assertGreater(m["discharge_loss_mah_per_cycle"], 0)
        self.assertIsNotNone(m["mean_charge_time_h"])
        self.assertAlmostEqual(m["mean_ve_pct"], 3.1 / 3.5 * 100, places=4)

    def test_polarization_quantity_uses_absolute_mean_voltage_delta_by_default(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        res = engine.compute(self.db, spec, None)
        labels = {q["key"]: q["label"] for q in res["quantities"]}
        self.assertEqual(labels["polarization"], "Polarization ΔV (V)")
        self.assertEqual(labels["polarization_pct"], "Polarization ΔV/V (%)")
        s = res["cell_series"][0]
        pol = s["quantities"]["polarization_v"]
        self.assertAlmostEqual(pol[0], 0.4, places=6)
        pol_pct = s["quantities"]["polarization_pct"]
        self.assertAlmostEqual(pol_pct[0], (0.4 / 3.1) * 100.0, places=6)

    def test_polarization_definition_can_use_voltage_endpoint_pair(self):
        frame = pd.DataFrame(
            {
                "cycle": [1],
                "discharge_capacity_mah": [1.0],
                "mean_charge_voltage_v": [4.0],
                "mean_discharge_voltage_v": [3.5],
                "last_charge_voltage_v": [4.2],
                "first_discharge_voltage_v": [3.4],
            }
        )
        derived, _ref = engine.add_derived_columns(
            frame,
            {
                "polarization": {
                    "method": "last_charge_first_discharge",
                    "direction": "charge_minus_discharge",
                }
            },
        )
        self.assertAlmostEqual(derived["polarization_v"].iloc[0], 0.8, places=6)

    def test_specific_capacity_quantities_use_imported_active_mass(self):
        cell = self.cells["c1"]
        self.db.add(CellMetadata(cell_id=cell.id, key="active_material_mg", value="10"))
        self.db.flush()
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])

        res = engine.compute(self.db, spec, None)

        labels = {q["key"]: q["label"] for q in res["quantities"]}
        self.assertNotIn("discharge_capacity_specific", labels)
        self.assertIn("discharge_capacity", labels)
        series = res["cell_series"][0]
        self.assertAlmostEqual(
            series["quantities"]["discharge_capacity_mah_g"][0],
            series["quantities"]["discharge_capacity_mah"][0] / 0.01,
            places=6,
        )
        self.assertAlmostEqual(
            series["quantities"]["charge_capacity_loss_mah_g_cycle"][1],
            series["quantities"]["charge_capacity_loss_mah"][1] / 0.01,
            places=6,
        )

    def test_scientific_override_takes_priority_over_imported_mass(self):
        cell = self.cells["c1"]
        self.db.add_all(
            [
                CellMetadata(cell_id=cell.id, key="active_material_mg", value="10"),
                CellMetadata(cell_id=cell.id, key="override.active_mass_mg", value="20"),
            ]
        )
        self.db.flush()
        self.assertEqual(engine.cell_active_mass_mg(cell), 20.0)

    def test_time_capacity_traces_filter_cycles_and_specific_capacity(self):
        cell = self.cells["c1"]
        self.db.add(CellMetadata(cell_id=cell.id, key="active_material_mg", value="10"))
        self.db.flush()
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        spec["computation"]["time_capacity"] = {
            "cycle_start": 2,
            "cycle_end": 3,
            "cycles": [],
            "max_points_per_cell": 500,
        }

        res = engine.compute_time_capacity(self.db, spec, None)

        self.assertEqual(res["cell_traces"][0]["cell_id"], cell.id)
        trace = res["cell_traces"][0]
        self.assertEqual(sorted(set(trace["cycle"])), [2, 3])
        self.assertEqual(len(trace["time_s"]), 8)
        self.assertIn("voltage_v", trace)
        self.assertIn("current_ma", trace)
        self.assertAlmostEqual(trace["capacity_mah_g"][0], trace["capacity_mah"][0] / 0.01, places=6)
        self.assertEqual(res["settings"]["cycle_start"], 2)

    def test_downsample_extrema_keep_immediate_neighbours(self):
        values = np.zeros(1000, dtype="float64")
        values[500] = 10.0
        take = engine._downsample_indices(
            len(values),
            100,
            np.ones(len(values), dtype=bool),
            [values],
        )

        selected = set(take.tolist())
        self.assertTrue({499, 500, 501}.issubset(selected))

    def test_time_capacity_trace_includes_nominal_capacity_for_c_rate(self):
        cell = self.cells["c1"]
        self.db.add(CellMetadata(cell_id=cell.id, key="nominal_capacity_mah", value="2.5"))
        self.db.flush()
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])

        res = engine.compute_time_capacity(self.db, spec, None)

        self.assertAlmostEqual(res["cell_traces"][0]["nominal_capacity_mah"], 2.5, places=6)

    def test_sustained_cycles_to_80(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c2"].id}])
        res = engine.compute(self.db, spec, None)
        # c2 only fades to ~94% — never sustained below 80
        self.assertIsNone(res["cell_series"][0]["metrics"]["cycles_to_80_pct"])

    def test_phase_capacity_continuous_across_step_reset(self):
        # Neware resets capacity counters at step boundaries (e.g. CC→CV at
        # the cutoff voltage); the half-cycle capacity must stay cumulative.
        frame = pd.DataFrame({
            "cycle": [1, 1, 1, 1, 1, 1, 1, 1],
            "status": ["CC_Chg", "CC_Chg", "CV_Chg", "CV_Chg", "CC_DChg", "CC_DChg", "CC_DChg", "CC_DChg"],
            "current_ma": [1000, 1000, 400, 100, -1000, -1000, -1000, -1000],
            "charge_capacity_mah": [1.0, 2.6, 0.05, 0.15, np.nan, np.nan, np.nan, np.nan],
            "discharge_capacity_mah": [np.nan, np.nan, np.nan, np.nan, 0.5, 1.0, 2.0, 2.7],
        })
        phases = engine._phase_from_raw(frame)
        self.assertEqual(phases, ["charge"] * 4 + ["discharge"] * 4)
        cap = engine._phase_capacity(frame, phases)
        # CV hold continues from the CC maximum instead of restarting at 0
        np.testing.assert_allclose(cap[:4], [1.0, 2.6, 2.65, 2.75])
        # discharge is its own run and unaffected
        np.testing.assert_allclose(cap[4:], [0.5, 1.0, 2.0, 2.7])

    def test_continuous_time_offsets_step_resets(self):
        frame = pd.DataFrame({
            "time_s": [0.0, 100.0, 200.0, 0.0, 50.0, 0.0, 30.0],
        })
        out = engine._continuous_time(frame)
        np.testing.assert_allclose(
            out["time_s"].to_numpy(), [0, 100, 200, 200, 250, 250, 280]
        )

    def test_time_capacity_time_is_monotonic(self):
        # synth raw data has per-step time resets; the trace must not
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        res = engine.compute_time_capacity(self.db, spec, None)
        t = [v for v in res["cell_traces"][0]["time_s"] if v is not None]
        self.assertGreater(len(t), 2)
        self.assertTrue(all(b >= a for a, b in zip(t, t[1:])), "time_s must be monotonic")

    def test_time_capacity_derivative_trace(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "view": "dvdq",
            "derivative_phase": "both",
            "derivative_specific": False,
            "derivative_absolute_discharge": True,
            "smoothing_window": 1,
            "cycles": [2],
        }
        res = engine.compute_time_capacity(self.db, spec, None)
        trace = res["cell_traces"][0]
        self.assertEqual(len(trace["derivative_x"]), len(trace["voltage_v"]))
        self.assertEqual(len(trace["derivative_y"]), len(trace["voltage_v"]))
        self.assertTrue(any(value is not None for value in trace["derivative_y"]))

    def test_phase_capacity_ignores_minor_noise_decrease(self):
        frame = pd.DataFrame({
            "cycle": [1, 1, 1],
            "status": ["CC_Chg"] * 3,
            "current_ma": [1000.0] * 3,
            "charge_capacity_mah": [1.0, 0.999, 1.4],
            "discharge_capacity_mah": [np.nan] * 3,
        })
        cap = engine._phase_capacity(frame, engine._phase_from_raw(frame))
        np.testing.assert_allclose(cap, [1.0, 0.999, 1.4])

    def test_exclusion_and_group_metrics(self):
        spec = self.spec_with([{"kind": "replicate_group", "ref_id": self.group.id}])
        spec["selection"]["exclusions"] = [{"cell_id": self.cells["c2"].id, "reason": "leak"}]
        res = engine.compute(self.db, spec, None)
        self.assertEqual(res["aggregates"][0]["max_n"], 1)
        gm = res["group_metrics"][0]["metrics"]
        self.assertEqual(gm["n_members"], 1)
        excluded = [s for s in res["cell_series"] if s["excluded"]]
        self.assertEqual(len(excluded), 1)
        self.assertEqual(excluded[0]["exclusion_reason"], "leak")

    def test_filters(self):
        spec = self.spec_with(
            [{"kind": "cell", "ref_id": self.cells["c1"].id}],
            cycle_range={"start": 5, "end": 20},
            exclude_check_cycles_every_n=10,
        )
        res = engine.compute(self.db, spec, None)
        x = res["cell_series"][0]["x"]
        self.assertEqual(min(x), 5)
        self.assertEqual(max(x), 19)
        self.assertNotIn(10, x)
        self.assertNotIn(20, x)

    def test_missing_reference_badge(self):
        spec = self.spec_with([{"kind": "replicate_group", "ref_id": 999}])
        res = engine.compute(self.db, spec, None)
        self.assertEqual(res["badges"][0]["kind"], "missing_reference")

    def test_provenance_roundtrip_and_version_badge(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        res = engine.compute(self.db, spec, None)
        prov = engine.build_provenance(res)
        self.assertEqual(prov["calc_version"], res["calc_version"])
        old_prov = dict(prov, calc_version="0.9.0")
        res2 = engine.compute(self.db, spec, old_prov)
        kinds = {b["kind"] for b in res2["badges"]}
        self.assertIn("newer_calc", kinds)


if __name__ == "__main__":
    unittest.main()
