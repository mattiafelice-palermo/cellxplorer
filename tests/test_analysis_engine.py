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
from app.models import Cell, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
from app.services import analysis_engine as engine
from app.services import cache, parsing


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
                    "step_index": 1, "status": status, "time_s": 1800.0 * frac,
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
                            parse_status="parsed", parser_version=parsing.PARSER_VERSION)
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

    def test_default_spec_has_saved_plot_container(self):
        spec = engine.default_spec("t")
        self.assertEqual(spec["spec_version"], engine.SPEC_VERSION)
        self.assertEqual(spec["saved_plots"], [])

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

    def test_sustained_cycles_to_80(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c2"].id}])
        res = engine.compute(self.db, spec, None)
        # c2 only fades to ~94% — never sustained below 80
        self.assertIsNone(res["cell_series"][0]["metrics"]["cycles_to_80_pct"])

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
