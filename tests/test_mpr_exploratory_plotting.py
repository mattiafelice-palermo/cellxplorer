"""Exploratory plots retain clock regressions without inventing scientific phases."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))

import numpy as np
import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.db import Base
from backend.app.models import Cell, Test, TestFile
from backend.app.services import analysis_engine, cache, calc, continuation_preview, parsing, scanner
from backend.app.services import time_capacity_derived, time_capacity_path
from backend.app.routers import library
from tests.biologic_mpr_fixture import encode_gcpl_settings, write_gcpl_mpr


class ExploratoryPlottingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(cache, "CACHE_DIR", self.root / "cache")
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        rows = [dict(total_time_s=t, ns=0, mode=1, control=1.,
                     ewe_v=3.+i/10., ece_v=.1, q_mAh=i/10., raw_dq_mAh=.1 if i else 0.)
                for i,t in enumerate((100.,110.,105.,115.))]
        self.path = write_gcpl_mpr(self.root / "clock.mpr", rows,
                                  settings_payload=encode_gcpl_settings([{"current":1.}]))

    def test_preview_preserves_order_native_clock_and_break(self):
        raw = parsing.parse_timeseries(self.path, read_mode="permissive")
        self.assertTrue(calc.per_cycle(raw).empty)
        self.assertEqual(time_capacity_derived.phase_from_raw(raw), ["unverified"] * 4)
        prepared = continuation_preview.prepare_segmented_raw([raw])
        preview = continuation_preview.voltage_preview_from_raw(prepared)
        self.assertEqual(preview["x"], [100.,110.,105.,115.])
        np.testing.assert_allclose(preview["y"], raw.voltage_v, rtol=0, atol=0)
        self.assertEqual(preview["display_break_before"], [2])
        sampled = continuation_preview.voltage_preview_from_raw(prepared, max_points=3)
        self.assertEqual(sampled["x"], [100.,105.,115.])
        self.assertEqual(sampled["display_break_before"], [1])

    def test_native_clock_survives_import_cache_exact_and_compact_analysis(self):
        source = scanner.ingest_path(self.db, self.path, parse_now=True, read_mode="permissive")
        self.assertEqual(source.parse_status, "parsed", source.parse_error)
        prepared = cache.load_time_capacity_derived(source.hash, source.parser_version, [1,2], ["phase_code"])
        self.assertIsNotNone(prepared)
        self.assertEqual(time_capacity_derived.decode_phases(prepared["phase_code"]), ["unverified"]*4)
        cell = Cell(name="Exploratory clock")
        self.db.add(cell)
        self.db.flush()
        internal = Test(cell_id=cell.id, name="internal")
        self.db.add(internal)
        self.db.flush()
        self.db.add(TestFile(test_id=internal.id, file_id=source.id, position=0))
        self.db.commit()
        detail = library.get_cell(cell.id, self.db)
        self.assertEqual(detail["sources"][0]["read_mode"], "permissive")
        self.assertTrue(detail["sources"][0]["exploratory"])
        self.assertEqual(detail["sources"][0]["scientific_interpretation"], "exploratory")
        self.assertTrue(detail["sources"][0]["interpretation_warnings"])
        overview = library.cell_voltage_preview(cell.id, self.db)
        self.assertEqual(overview["cycle_count"], 0)
        self.assertEqual(overview["segments"][0]["x"], [100.,110.,105.,115.])
        self.assertEqual(overview["segments"][0]["display_break_before"], [2])
        spec = analysis_engine.default_spec("Clock evidence")
        spec["selection"]["entries"] = [{"kind":"cell", "ref_id":cell.id}]
        spec["computation"]["time_capacity"] = {"x_axis":"time", "time_unit":"s", "display_mode":"consecutive"}
        for precision, compact in (("full", False), ("full", True), ("standard", True)):
            with self.subTest(precision=precision, compact=compact):
                result = analysis_engine.compute_time_capacity(self.db, spec, None,
                                                               use_current_versions=True,
                                                               precision=precision, compact=compact)
                trace = result["cell_traces"][0]
                self.assertEqual(trace["display_x"], [100.,110.,105.,115.])
                self.assertEqual(trace["display_break_before"], [2])
                self.assertEqual(trace["cycle"], [0]*4)
                self.assertTrue(all(trace["display_only_cycle"]))
                self.assertTrue(all(x is None for x in trace["current_ma"]))
                # Ordinary compact Time views omit unused phase arrays; full
                # scientific exports retain an explicit unverified phase.
                self.assertEqual(trace["phase"], [] if precision == "standard" and compact else ["unverified"]*4)
        with patch.object(cache, "try_load_raw_layout_index", return_value=None):
            trace = analysis_engine.compute_time_capacity(self.db, spec, None, use_current_versions=True,
                                                           precision="full")["cell_traces"][0]
            self.assertEqual(trace["display_x"], [100.,110.,105.,115.])
            self.assertEqual(trace["display_break_before"], [2])

    def test_index_projection_retains_native_clock_fields(self):
        raw = parsing.parse_timeseries(self.path, read_mode="permissive")
        settings = analysis_engine.time_capacity_settings({"time_capacity":{"x_axis":"time", "time_unit":"s"}})
        columns = time_capacity_path.time_capacity_request_columns(raw.columns, settings,
                                                                  precision="standard", compact=True)
        self.assertIn("mpr_elapsed_time_s", columns)
        self.assertIn("mpr_acquisition_segment", columns)
        transformed = analysis_engine._continuous_time(raw)
        np.testing.assert_array_equal(transformed.time_s, [100.,110.,105.,115.])
        for display in ("consecutive", "overlap", "overlap_mirror"):
            settings["display_mode"] = display
            x = analysis_engine._time_capacity_display_x(transformed, ["unverified"]*4,
                                                         None,None,None,settings,origin_time_s=100.)
            np.testing.assert_array_equal(x, [100.,110.,105.,115.])

    def test_mixed_frame_keeps_source_order_and_unverified_phase(self):
        raw = parsing.parse_timeseries(self.path, read_mode="permissive")
        raw["segment"] = 1
        ordinary = raw.iloc[:2].drop(columns=[c for c in raw if c.startswith("mpr_")]).copy()
        ordinary["segment"] = 0
        ordinary["status"] = "CC_Chg"
        ordinary["current_ma"] = 1.
        ordinary["cycle"] = 1
        mixed = pd.concat([ordinary,raw], ignore_index=True)
        ordered = mixed.sort_values(analysis_engine._time_capacity_sort_columns(mixed), kind="stable")
        self.assertEqual(ordered.segment.tolist(), [0,0,1,1,1,1])
        phases = time_capacity_derived.phase_from_raw(ordered)
        self.assertEqual(phases, ["charge","charge"] + ["unverified"]*4)
        ordered["source_hash"] = ["ordinary"]*2 + ["exploratory"]*4
        ordered["source_cycle"] = ordered["cycle"]
        prepared = ordered.copy()
        prepared["phase_code"] = time_capacity_derived.encode_phases(phases)
        prepared["phase_capacity_mah"] = np.arange(len(prepared), dtype=float)
        self.assertIsNone(analysis_engine._aligned_prepared_transform_values(ordered, prepared, need_capacity=True))


if __name__ == "__main__":
    unittest.main()
