import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Analysis, Cell, CellMetadata, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
from app.routers import analyses as analyses_router
from app.routers.library import get_cell_protocol
from app.services import analysis_cache
from app.services import analysis_engine as engine
from app.services import cache, calc, canonical_cycling, parsing, protocol, scanner
from app.services import time_capacity_profiling, time_capacity_workers


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


def dcir_protocol_header() -> dict[str, str]:
    return {
        "Step.Step_Info.Step1.Step_Type": "4",
        "Step.Step_Info.Step1.Limit.Main.Time.Value": "1800000",
        "Step.Step_Info.Step2.Step_Type": "2",
        "Step.Step_Info.Step2.Limit.Main.Curr.Value": "-1",
        "Step.Step_Info.Step2.Limit.Main.Time.Value": "30000",
        "Step.Step_Info.Step3.Step_Type": "4",
        "Step.Step_Info.Step3.Limit.Main.Time.Value": "1800000",
        "Step.Step_Info.Step4.Step_Type": "1",
        "Step.Step_Info.Step4.Limit.Main.Curr.Value": "1",
        "Step.Step_Info.Step4.Limit.Main.Time.Value": "30000",
    }


def synth_dcir_raw(n_cycles: int = 3) -> pd.DataFrame:
    rows: list[dict] = []
    timestamp = pd.Timestamp("2026-01-01")
    record_index = 0
    for cycle in range(1, n_cycles + 1):
        drop = 0.08 + 0.01 * (cycle - 1)
        rise = 0.06 + 0.005 * (cycle - 1)
        for step_index, status, current, voltages, durations in (
            (1, "Rest", 0.0, (3.50, 3.50), (0.0, 1800.0)),
            (2, "CC_DChg", -1.0, (3.48, 3.50 - drop), (0.0, 30.0)),
            (3, "Rest", 0.0, (3.45, 3.45), (0.0, 1800.0)),
            (4, "CC_Chg", 1.0, (3.47, 3.45 + rise), (0.0, 30.0)),
        ):
            for voltage, time_s in zip(voltages, durations):
                record_index += 1
                timestamp += pd.Timedelta(seconds=max(time_s - (durations[0] or 0), 1))
                rows.append(
                    {
                        "record_index": record_index,
                        "cycle": cycle,
                        "step": step_index,
                        "step_index": step_index,
                        "status": status,
                        "time_s": time_s,
                        "voltage_v": voltage,
                        "current_ma": current,
                        "charge_capacity_mah": 0.0,
                        "discharge_capacity_mah": 0.0,
                        "charge_energy_mwh": 0.0,
                        "discharge_energy_mwh": 0.0,
                        "timestamp": timestamp,
                    }
                )
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
            # ".ndax" gives `cache.build` a recognizable extension for
            # per-source parser identity (Spec 040.3); `fake_parse` still
            # resolves by stem, which strips exactly that one extension.
            cache.build(h, f"{h}.ndax")

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

    def test_metadata_only_selection_fails_closed_before_any_timeseries_parse(self):
        source = self.cells["c1"].tests[0].file_links[0].file
        source.parse_status = "metadata_only"
        source.parse_error = "metadata-only source"
        source.header_meta = {"capabilities": {"canonical_cycling": False}}
        source.capacity_summary_status = "unavailable"
        self.db.commit()
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])

        detail = engine.canonical_cycling_capability(self.db, spec)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["code"], "canonical_cycling_unavailable")
        with patch.object(parsing, "parse_timeseries", side_effect=AssertionError("parsed")):
            with self.assertRaises(engine.CanonicalCyclingUnavailable) as raised:
                engine.compute(self.db, spec, None)
        self.assertEqual(raised.exception.detail["status"], "metadata_only")

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

    def test_legacy_protocol_signature_still_filters_cycles(self):
        spec = self.spec_with_protocol_mode("excluded")
        current = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )
        spec["protocol_segments"][0]["targets"][0]["protocol_signature"] = (
            current["legacy_signatures"][0]
        )

        result = engine.compute(self.db, spec, None)

        self.assertEqual(result["cell_series"][0]["x"], list(range(2, 51, 2)))
        self.assertNotIn(
            "protocol_segment_unmatched",
            {badge["kind"] for badge in result["badges"]},
        )

    def test_steps_compute_emits_one_series_per_cell_segment_pair(self):
        cell = self.cells["c1"]
        signature = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )["signature"]
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        spec["protocol_segments"] = [
            {
                "id": "charge",
                "name": "Charge",
                "targets": [
                    {"protocol_signature": signature, "step_indices": [1]}
                ],
            },
            {
                "id": "discharge",
                "name": "Discharge",
                "targets": [
                    {"protocol_signature": signature, "step_indices": [2]}
                ],
            },
        ]
        spec["computation"]["steps"] = {
            "series": [
                {"id": "charge-series", "cell_id": cell.id, "segment_id": "charge"},
                {
                    "id": "discharge-series",
                    "cell_id": cell.id,
                    "segment_id": "discharge",
                },
            ],
            "mode": "union",
        }

        result = engine.compute_steps(self.db, spec, None)

        self.assertEqual(result["type"], "steps")
        self.assertEqual(len(result["cell_series"]), 2)
        by_id = {series["series_id"]: series for series in result["cell_series"]}
        self.assertEqual(by_id["charge-series"]["label"], "c1 \u2014 Charge")
        self.assertEqual(by_id["discharge-series"]["label"], "c1 \u2014 Discharge")
        self.assertEqual(by_id["charge-series"]["n_blocks"], 25)
        self.assertEqual(by_id["discharge-series"]["n_blocks"], 50)
        for series in by_id.values():
            self.assertEqual(
                series["x_occurrence"],
                list(range(1, series["n_blocks"] + 1)),
            )
            self.assertEqual(len(series["x_cycle"]), series["n_blocks"])
            self.assertEqual(len(series["x_time"]), series["n_blocks"])
            self.assertIn("total_time_h", series["quantities"])
            self.assertIn("mean_voltage_v", series["quantities"])
            self.assertNotIn("active_time_h", series["quantities"])
        self.assertAlmostEqual(by_id["charge-series"]["x_time"][0], 0.0)
        self.assertAlmostEqual(by_id["discharge-series"]["x_time"][0], 1.0)

    def test_steps_reuse_equal_protocol_headers_within_one_request(self):
        signature = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )["signature"]
        cell_ids = [self.cells["c1"].id, self.cells["c2"].id]
        spec = self.spec_with([{"kind": "cell", "ref_id": cell_id} for cell_id in cell_ids])
        spec["protocol_segments"] = [
            {
                "id": "charge",
                "name": "Charge",
                "targets": [{"protocol_signature": signature, "step_indices": [1]}],
            }
        ]
        spec["computation"]["steps"] = {
            "series": [
                {"id": f"charge-{cell_id}", "cell_id": cell_id, "segment_id": "charge"}
                for cell_id in cell_ids
            ],
            "mode": "union",
        }

        with patch.object(
            protocol,
            "reconstruct_protocol",
            wraps=protocol.reconstruct_protocol,
        ) as reconstruct:
            result = engine.compute_steps(self.db, spec, None)

        self.assertEqual(reconstruct.call_count, 1)
        self.assertEqual(
            [series["cell_id"] for series in result["cell_series"]],
            cell_ids,
        )

    def test_steps_selective_and_full_raw_paths_have_same_result(self):
        cell = self.cells["c1"]
        signature = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )["signature"]
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        spec["protocol_segments"] = [
            {
                "id": "charge",
                "name": "Charge",
                "targets": [{"protocol_signature": signature, "step_indices": [1]}],
            }
        ]
        spec["computation"]["steps"] = {
            "series": [{"id": "charge-series", "cell_id": cell.id, "segment_id": "charge"}],
            "mode": "union",
        }

        selective = engine.compute_steps(self.db, spec, None)
        with patch.object(engine.stitch, "stitch_raw_steps", return_value=None):
            fallback = engine.compute_steps(self.db, spec, None)

        self.assertEqual(selective["cell_series"], fallback["cell_series"])
        self.assertEqual(selective["badges"], fallback["badges"])

    def test_protocol_family_cache_hits_bypass_compute_parsing_and_serialization(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        analysis = Analysis(title="Protocol hit path", spec=spec)
        self.db.add(analysis)
        self.db.commit()

        routes = (
            ("steps", analyses_router.compute_steps_analysis),
            ("dcir", analyses_router.compute_dcir_analysis),
            ("chargeability", analyses_router.compute_chargeability_analysis),
            ("rate_capability", analyses_router.compute_rate_capability_analysis),
        )
        compute_calls: list[str] = []

        def fake_compute(_db, _spec, _provenance, **_options):
            compute_calls.append("compute")
            return {
                "computed_at": "2026-08-23T00:00:00+00:00",
                "type": "protocol-test",
                "cell_series": [],
                "badges": [],
            }

        with tempfile.TemporaryDirectory(prefix="cellxplorer-analysis-hit-") as temp:
            cache_root = Path(temp)
            with (
                patch.object(analysis_cache, "_RESULTS", cache_root / "results"),
                patch.object(analysis_cache, "_ARTIFACTS", cache_root / "artifacts"),
                patch.object(analysis_cache, "_budget_total", None),
                patch.object(analyses_router.engine, "compute_steps", side_effect=fake_compute),
                patch.object(analyses_router.engine, "compute_dcir", side_effect=fake_compute),
                patch("app.services.chargeability.compute", side_effect=fake_compute),
                patch("app.services.rate_capability.compute", side_effect=fake_compute),
                patch.object(analyses_router, "fast_json", wraps=analyses_router.fast_json) as serializer,
            ):
                for family, route in routes:
                    with self.subTest(family=family):
                        miss = route(analysis.id, analyses_router.ComputeRequest(), self.db)
                        self.assertEqual(json.loads(miss.body)["cache_status"], "miss")
                        calls_after_miss = len(compute_calls)
                        serializations_after_miss = serializer.call_count
                        with patch.object(
                            analysis_cache,
                            "load_result",
                            side_effect=AssertionError("parsed result loader entered on hit"),
                        ):
                            hit = route(analysis.id, analyses_router.ComputeRequest(), self.db)
                        self.assertEqual(json.loads(hit.body)["cache_status"], "hit")
                        self.assertEqual(len(compute_calls), calls_after_miss)
                        self.assertEqual(serializer.call_count, serializations_after_miss)

    def test_steps_compute_expands_legacy_segment_to_selected_cells(self):
        signature = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )["signature"]
        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["c1"].id},
                {"kind": "cell", "ref_id": self.cells["c2"].id},
            ]
        )
        spec["protocol_segments"] = [
            {
                "id": "discharge",
                "name": "Discharge",
                "targets": [
                    {"protocol_signature": signature, "step_indices": [2]}
                ],
            }
        ]
        spec["computation"]["steps"] = {
            "series": [],
            "segment_id": "discharge",
            "mode": "union",
        }

        result = engine.compute_steps(self.db, spec, None)

        self.assertEqual(
            {series["cell_id"] for series in result["cell_series"]},
            {self.cells["c1"].id, self.cells["c2"].id},
        )
        self.assertTrue(
            all(
                series["series_id"].startswith("legacy-")
                for series in result["cell_series"]
            )
        )

    def test_steps_compute_resolves_a_pre_upgrade_protocol_target(self):
        cell = self.cells["c1"]
        current = protocol.reconstruct_protocol(
            analysis_protocol_header(), nominal_capacity_mah=2.0
        )
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        spec["protocol_segments"] = [
            {
                "id": "legacy-discharge",
                "name": "Legacy discharge",
                "targets": [
                    {
                        "protocol_signature": current["legacy_signatures"][0],
                        "step_indices": [2],
                    }
                ],
            }
        ]
        spec["computation"]["steps"] = {
            "series": [
                {
                    "id": "legacy-discharge-series",
                    "cell_id": cell.id,
                    "segment_id": "legacy-discharge",
                }
            ],
            "mode": "union",
        }

        result = engine.compute_steps(self.db, spec, None)

        self.assertEqual(result["cell_series"][0]["n_blocks"], 50)

    def test_dcir_compute_emits_explicit_cell_segment_series(self):
        cell = self.cells["c1"]
        source = cell.tests[0].file_links[0].file
        original_frame = self.FRAMES[self.HASHES["c1"]]
        original_header = source.header_meta
        try:
            self.FRAMES[self.HASHES["c1"]] = synth_dcir_raw()
            source.header_meta = dcir_protocol_header()
            self.db.flush()
            cache_dir = cache.raw_path(self.HASHES["c1"]).parent
            shutil.rmtree(cache_dir, ignore_errors=True)
            cache.build(self.HASHES["c1"], f"{self.HASHES['c1']}.ndax")
            signature = protocol.reconstruct_protocol(
                dcir_protocol_header(), nominal_capacity_mah=2.0
            )["legacy_signatures"][0]
            spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
            spec["dcir_segments"] = [
                {
                    "id": "discharge-pulse",
                    "name": "Discharge C/2",
                    "targets": [
                        {
                            "protocol_signature": signature,
                            "rest_step_index": 1,
                            "pulse_step_index": 2,
                            "direction": "discharge",
                            "current_ma": -1.0,
                            "c_rate": 0.5,
                        }
                    ],
                },
                {
                    "id": "charge-pulse",
                    "name": "Charge C/2",
                    "targets": [
                        {
                            "protocol_signature": signature,
                            "rest_step_index": 3,
                            "pulse_step_index": 4,
                            "direction": "charge",
                            "current_ma": 1.0,
                            "c_rate": 0.5,
                        }
                    ],
                },
            ]
            spec["computation"]["dcir"] = {
                "series": [
                    {
                        "id": "discharge-series",
                        "cell_id": cell.id,
                        "segment_id": "discharge-pulse",
                    },
                    {
                        "id": "charge-series",
                        "cell_id": cell.id,
                        "segment_id": "charge-pulse",
                    },
                ]
            }

            result = engine.compute_dcir(self.db, spec, None)
            with patch.object(engine.stitch, "stitch_raw_steps", return_value=None):
                fallback_result = engine.compute_dcir(self.db, spec, None)

            self.assertEqual(result["type"], "dcir")
            self.assertEqual(result["cell_series"], fallback_result["cell_series"])
            self.assertEqual(len(result["cell_series"]), 2)
            by_id = {series["series_id"]: series for series in result["cell_series"]}
            self.assertEqual(by_id["discharge-series"]["n_measurements"], 3)
            self.assertEqual(by_id["charge-series"]["n_measurements"], 3)
            self.assertEqual(by_id["discharge-series"]["x_occurrence"], [1, 2, 3])
            self.assertEqual(by_id["charge-series"]["x_cycle"], [1, 2, 3])
            self.assertEqual(by_id["discharge-series"]["direction"], "discharge")
            self.assertEqual(by_id["charge-series"]["direction"], "charge")
            self.assertAlmostEqual(
                by_id["discharge-series"]["quantities"]["dcir_change_pct"][0],
                0.0,
            )
            self.assertGreater(
                by_id["discharge-series"]["quantities"]["dcir_change_pct"][2],
                0.0,
            )
        finally:
            self.FRAMES[self.HASHES["c1"]] = original_frame
            source.header_meta = original_header
            self.db.flush()
            cache_dir = cache.raw_path(self.HASHES["c1"]).parent
            shutil.rmtree(cache_dir, ignore_errors=True)
            cache.build(self.HASHES["c1"], f"{self.HASHES['c1']}.ndax")

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

    def test_full_time_capacity_export_request_keeps_all_points_and_precision(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycle_start": 1,
            "cycle_end": None,
            "max_points_per_cell": 100,
        }

        compact = engine.compute_time_capacity(
            self.db, spec, None, precision="standard", compact=True
        )
        full = engine.compute_time_capacity(
            self.db, spec, None, precision="full", compact=False
        )

        compact_trace = compact["cell_traces"][0]
        full_trace = full["cell_traces"][0]
        self.assertEqual(compact["rendering"]["precision"], "standard")
        self.assertTrue(compact["rendering"]["compact"])
        self.assertEqual(full["rendering"]["precision"], "full")
        self.assertFalse(full["rendering"]["compact"])
        self.assertLess(len(compact_trace["voltage_v"]), len(full_trace["voltage_v"]))
        self.assertEqual(len(full_trace["voltage_v"]), 200)
        self.assertEqual(full_trace["voltage_v"][0], 3.5)

    def test_time_capacity_data_signature_includes_unit_scientific_inputs(self):
        cell = self.cells["c1"]
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        baseline = analysis_cache.time_capacity_data_signature(
            self.db, spec, None, use_current_versions=True
        )
        original_name = cell.name
        cell.name = "Renamed cell"
        self.db.flush()
        self.assertNotEqual(
            baseline,
            analysis_cache.time_capacity_data_signature(
                self.db, spec, None, use_current_versions=True
            ),
            "cell label",
        )
        cell.name = original_name
        self.db.flush()
        self.assertEqual(
            baseline,
            analysis_cache.time_capacity_data_signature(
                self.db, spec, None, use_current_versions=True
            ),
            "cell label restore",
        )

        for key, value in (
            ("active_mass_mg", "10"),
            ("nominal_capacity_mah", "2.5"),
            ("electrode_area_cm2", "3"),
        ):
            metadata = CellMetadata(cell_id=cell.id, key=key, value=value)
            self.db.add(metadata)
            self.db.flush()
            changed = analysis_cache.time_capacity_data_signature(
                self.db, spec, None, use_current_versions=True
            )
            self.assertNotEqual(baseline, changed, key)
            self.db.delete(metadata)
            self.db.flush()
            self.assertEqual(
                baseline,
                analysis_cache.time_capacity_data_signature(
                    self.db, spec, None, use_current_versions=True
                ),
                f"{key} restore",
            )

    def test_time_capacity_route_source_signature_is_stable_across_render_modes_and_cache_paths(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        analysis = Analysis(title="Time route", spec=spec)
        self.db.add(analysis)
        self.db.commit()

        stored_bodies: dict[str, bytes] = {}

        def fake_compute(_db, _spec, _provenance, **options):
            return {
                "cell_traces": [],
                "rendering": {
                    "precision": options["precision"],
                    "compact": options["compact"],
                },
            }

        def fake_load_body(_kind, key):
            body = stored_bodies.get(key)
            return (body, []) if body is not None else None

        def fake_store(_kind, key, result):
            value = dict(result)
            value.pop("cache_status", None)
            value.pop("badges", None)
            stored_bodies[key] = json.dumps(value, separators=(",", ":")).encode()

        standard_request = analyses_router.ComputeRequest(
            precision="standard", compact=True
        )
        full_request = analyses_router.ComputeRequest(
            precision="full", compact=False
        )
        with patch.object(
            analyses_router.engine,
            "compute_time_capacity",
            side_effect=fake_compute,
        ), patch.object(analysis_cache, "load_result_body", side_effect=fake_load_body), patch.object(
            analysis_cache, "load_result", return_value=None
        ), patch.object(analysis_cache, "store_result", side_effect=fake_store), patch.object(
            analyses_router.engine, "availability_badges", return_value=[]
        ):
            standard_miss = analyses_router.compute_time_capacity_analysis(
                analysis.id, standard_request, self.db
            )
            full_miss = analyses_router.compute_time_capacity_analysis(
                analysis.id, full_request, self.db
            )
            standard_hit = analyses_router.compute_time_capacity_analysis(
                analysis.id, standard_request, self.db
            )
            full_hit = analyses_router.compute_time_capacity_analysis(
                analysis.id, full_request, self.db
            )

        standard_miss_body = json.loads(standard_miss.body)
        full_miss_body = json.loads(full_miss.body)
        standard_hit_body = json.loads(standard_hit.body)
        full_hit_body = json.loads(full_hit.body)
        self.assertNotEqual(
            standard_miss_body["data_signature"], full_miss_body["data_signature"]
        )
        self.assertEqual(
            standard_miss_body["source_data_signature"],
            full_miss_body["source_data_signature"],
        )
        self.assertEqual(
            standard_hit_body["source_data_signature"],
            standard_miss_body["source_data_signature"],
        )
        self.assertEqual(
            full_hit_body["source_data_signature"], full_miss_body["source_data_signature"]
        )
        self.assertEqual(
            standard_hit_body["data_signature"], standard_miss_body["data_signature"]
        )
        self.assertEqual(
            full_hit_body["data_signature"], full_miss_body["data_signature"]
        )
        self.assertNotEqual(
            standard_hit_body["data_signature"], full_hit_body["data_signature"]
        )
        self.assertEqual(standard_hit_body["cache_status"], "hit")
        self.assertEqual(full_hit_body["cache_status"], "hit")
        self.assertNotEqual(
            standard_hit_body["rendering"], full_hit_body["rendering"]
        )

    def test_time_capacity_profiling_is_opt_in_and_distinguishes_miss_and_hit(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        analysis = Analysis(title="Time profiling", spec=spec)
        self.db.add(analysis)
        self.db.commit()

        stored_bodies: dict[str, bytes] = {}
        compute_options: list[dict] = []

        def fake_compute(_db, _spec, _provenance, **options):
            compute_options.append(options)
            diagnostics = options.get("access_diagnostics")
            if diagnostics is not None:
                diagnostics["cells"] = [
                    {
                        "path": "indexed",
                        "row_groups_read": 2,
                        "row_groups_total": 8,
                        "raw_rows_materialized": 40,
                        "selected_rows_before_transforms": 36,
                        "stages": {"index_stitch_plan": 0.001},
                    }
                ]
            return {
                "computed_at": "2026-08-21T00:00:00+00:00",
                "type": "cycling",
                "cell_traces": [{"cell_id": self.cells["c1"].id}],
                "badges": [],
                "rendering": {
                    "precision": options["precision"],
                    "compact": options["compact"],
                    "total_points": 24,
                },
            }

        def fake_load_body(_kind, key):
            body = stored_bodies.get(key)
            return (body, []) if body is not None else None

        def fake_store(_kind, key, result):
            value = dict(result)
            value.pop("cache_status", None)
            value.pop("badges", None)
            stored_bodies[key] = json.dumps(value, separators=(",", ":")).encode()

        profiled_request = analyses_router.ComputeRequest(
            precision="standard",
            compact=True,
            profile=True,
            profile_request_id="profile-miss",
        )
        ordinary_request = analyses_router.ComputeRequest(
            precision="full", compact=False
        )
        profiled_hit_request = analyses_router.ComputeRequest(
            precision="standard",
            compact=True,
            profile=True,
            profile_request_id="profile-hit",
        )
        with patch.object(
            analyses_router.engine,
            "compute_time_capacity",
            side_effect=fake_compute,
        ), patch.object(
            analysis_cache, "load_result_body", side_effect=fake_load_body
        ), patch.object(
            analysis_cache, "load_result", return_value=None
        ), patch.object(
            analysis_cache, "store_result", side_effect=fake_store
        ), patch.object(
            analyses_router.engine, "availability_badges", return_value=[]
        ), patch.object(
            analyses_router, "fast_json", wraps=analyses_router.fast_json
        ) as json_serializer:
            def scientific_serializations() -> list:
                return [
                    call
                    for call in json_serializer.call_args_list
                    if call.args
                    and isinstance(call.args[0], dict)
                    and "cell_traces" in call.args[0]
                ]

            profiled_miss = analyses_router.compute_time_capacity_analysis(
                analysis.id, profiled_request, self.db
            )
            self.assertEqual(len(scientific_serializations()), 1)
            json_serializer.reset_mock()
            ordinary_miss = analyses_router.compute_time_capacity_analysis(
                analysis.id, ordinary_request, self.db
            )
            self.assertEqual(len(scientific_serializations()), 1)
            json_serializer.reset_mock()
            profiled_hit = analyses_router.compute_time_capacity_analysis(
                analysis.id, profiled_hit_request, self.db
            )
            self.assertEqual(len(scientific_serializations()), 0)

        profiled_miss_body = json.loads(profiled_miss.body)
        ordinary_miss_body = json.loads(ordinary_miss.body)
        profiled_hit_body = json.loads(profiled_hit.body)
        miss_profile = profiled_miss_body["profiling"]
        hit_profile = profiled_hit_body["profiling"]
        self.assertEqual(miss_profile["profile_version"], 1)
        self.assertEqual(miss_profile["request_id"], "profile-miss")
        self.assertEqual(miss_profile["result_cache"], "miss")
        self.assertEqual(miss_profile["raw_access"], "indexed")
        self.assertEqual(miss_profile["row_groups_read"], 2)
        self.assertEqual(miss_profile["row_groups_total"], 8)
        self.assertEqual(miss_profile["raw_rows_materialized"], 40)
        self.assertEqual(miss_profile["selected_rows_before_transforms"], 36)
        self.assertEqual(miss_profile["returned_points"], 24)
        self.assertEqual(miss_profile["resolved_cell_count"], 1)
        self.assertIn("request_stages_ms", miss_profile)
        self.assertIn("source_data_signature", miss_profile["request_stages_ms"])
        self.assertIn("render_result_key", miss_profile["request_stages_ms"])
        self.assertIn("request_sql", miss_profile)
        self.assertGreaterEqual(miss_profile["request_residual_ms"], 0)
        self.assertNotIn("trace_count", miss_profile)
        self.assertEqual(hit_profile["request_id"], "profile-hit")
        self.assertEqual(hit_profile["result_cache"], "hit")
        self.assertEqual(hit_profile["raw_access"], "not_applicable")
        self.assertIn("result_cache_body_lookup", hit_profile["request_stages_ms"])
        self.assertNotIn("engine_timing", hit_profile)
        self.assertNotIn("profiling", ordinary_miss_body)
        self.assertEqual(
            profiled_miss_body["cell_traces"], ordinary_miss_body["cell_traces"]
        )
        self.assertEqual(
            profiled_hit_body["cell_traces"], ordinary_miss_body["cell_traces"]
        )
        self.assertEqual(
            profiled_hit_body["rendering"], profiled_miss_body["rendering"]
        )
        self.assertTrue(compute_options)
        self.assertEqual(len(compute_options), 2)
        self.assertIsNotNone(compute_options[0]["access_diagnostics"])
        self.assertNotIn("access_diagnostics", compute_options[1])

    def test_time_capacity_profiling_uses_the_interactive_standard_compact_contract(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        settings = spec["computation"].setdefault("time_capacity", {})
        settings["cycle_end"] = 20
        diagnostics: dict = {}
        result = engine.compute_time_capacity(
            self.db,
            spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            access_diagnostics=diagnostics,
        )
        profile = time_capacity_profiling.build_time_capacity_profile(
            request_id="interactive-contract",
            result_cache="miss",
            diagnostics=diagnostics,
            result=result,
        )
        self.assertEqual(result["rendering"]["precision"], "standard")
        self.assertTrue(result["rendering"]["compact"])
        self.assertEqual(result["rendering"]["configured_max_points_per_cell"], 4000)
        self.assertIn(profile["raw_access"], {"indexed", "legacy"})
        self.assertGreaterEqual(profile["returned_points"], 0)
        self.assertGreaterEqual(profile["raw_rows_materialized"], 0)
        self.assertGreater(profile["cell_job_wall_ms"], 0)
        self.assertEqual(profile["resolved_cell_count"], 1)

    def test_time_capacity_fine_transform_profile_is_opt_in_and_scientific_projection_is_unchanged(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycle_end": 20,
            "max_points_per_cell": 4000,
        }
        ordinary = engine.compute_time_capacity(
            self.db,
            deepcopy(spec),
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
        )
        diagnostics: dict = {}
        profiled = engine.compute_time_capacity(
            self.db,
            deepcopy(spec),
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            access_diagnostics=diagnostics,
        )

        self.assertEqual(profiled["cell_traces"], ordinary["cell_traces"])
        self.assertNotIn("transform_profile", profiled)
        cell = diagnostics["cells"][0]
        self.assertEqual(
            cell["transform_profile"]["phase_capacity"]["input_rows"],
            cell["selected_rows_before_transforms"],
        )
        self.assertEqual(cell["transform_profile"]["phase_capacity"]["consumed_by"], [])
        self.assertEqual(cell["transform_profile"]["phase_capacity"]["output_rows"], 0)
        self.assertNotIn("transform_phase_capacity", cell["stages"])

        derivative_spec = deepcopy(spec)
        derivative_spec["computation"]["time_capacity"].update({
            "view": "dqdv",
            "x_axis": "capacity_mah",
        })
        derivative_diagnostics: dict = {}
        engine.compute_time_capacity(
            self.db,
            derivative_spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            access_diagnostics=derivative_diagnostics,
        )
        derivative_profile = derivative_diagnostics["cells"][0]["derivative_profile"]
        self.assertGreater(derivative_profile["segments_processed"], 0)
        self.assertIn("derivative_rolling", derivative_diagnostics["cells"][0]["stages"])
        self.assertIn("derivative_gradient", derivative_diagnostics["cells"][0]["stages"])
        self.assertIn("derivative_ratio_filter", derivative_diagnostics["cells"][0]["stages"])
        self.assertIn("derivative_segment_scan", derivative_diagnostics["cells"][0]["stages"])
        self.assertIn("derivative_segment_prepare", derivative_diagnostics["cells"][0]["stages"])
        self.assertIn("derivative_status_classification", derivative_diagnostics["cells"][0]["stages"])
        self.assertIn("derivative_postprocess", derivative_diagnostics["cells"][0]["stages"])

    def test_time_capacity_profile_route_real_interactive_request_exposes_diagnostics(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycle_start": 1,
            "cycle_end": 20,
            "max_points_per_cell": 4000,
        }
        analysis = Analysis(title="Real Time profiling", spec=spec)
        self.db.add(analysis)
        self.db.commit()
        request = analyses_router.ComputeRequest(
            precision="standard",
            compact=True,
            profile=True,
            profile_request_id="real-interactive-contract",
        )
        with patch.object(analysis_cache, "load_result_body", return_value=None), patch.object(
            analysis_cache, "load_result", return_value=None
        ), patch.object(analysis_cache, "store_result"):
            response = analyses_router.compute_time_capacity_analysis(
                analysis.id, request, self.db
            )

        body = json.loads(response.body)
        profile = body["profiling"]
        self.assertEqual(body["rendering"]["precision"], "standard")
        self.assertTrue(body["rendering"]["compact"])
        self.assertEqual(body["rendering"]["configured_max_points_per_cell"], 4000)
        self.assertEqual(profile["request_id"], "real-interactive-contract")
        self.assertEqual(profile["result_cache"], "miss")
        self.assertIn(profile["raw_access"], {"indexed", "legacy"})
        self.assertGreaterEqual(profile["returned_points"], 0)
        self.assertGreaterEqual(profile["raw_rows_materialized"], 0)
        self.assertEqual(profile["resolved_cell_count"], 1)
        self.assertGreaterEqual(profile["backend_compute_ms"], 0)
        self.assertGreaterEqual(profile["backend_serialize_ms"], 0)
        self.assertGreater(profile["response_bytes"], 0)
        self.assertEqual(profile["response_bytes"], len(response.body))
        self.assertGreaterEqual(profile["backend_total_ms"], profile["backend_compute_ms"])

    def test_time_capacity_two_electrode_fixture_exposes_only_voltage_channel(self):
        # Spec 040.4 case 8: an ordinary two-electrode source must not gain
        # a working/counter potential option, and the default channel must
        # be "voltage" with unchanged values (no voltage_channel set at all,
        # exactly like an old saved spec).
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])

        res = engine.compute_time_capacity(self.db, spec, None)

        self.assertEqual(res["settings"]["voltage_channel"], "voltage")
        self.assertEqual(
            res["voltage_channels"],
            {
                "voltage": {"available": True, "label": "Cell voltage (V)", "role": "cell"},
                "working_potential": {
                    "available": False,
                    "label": "Working potential vs ref (V)",
                    "role": "working_vs_reference",
                },
                "counter_potential": {
                    "available": False,
                    "label": "Counter potential vs ref (V)",
                    "role": "counter_vs_reference",
                },
            },
        )
        trace = res["cell_traces"][0]
        self.assertTrue(any(value is not None for value in trace["voltage_v"]))

    def test_time_capacity_unavailable_channel_omits_trace_without_fallback(self):
        # Requesting working_potential against a source that never populated
        # it must yield an empty/all-None trace, never a silent substitution
        # of voltage_v under the "working potential" label.
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {"voltage_channel": "working_potential"}

        res = engine.compute_time_capacity(self.db, spec, None)

        trace = res["cell_traces"][0]
        self.assertTrue(len(trace["voltage_v"]) > 0)
        self.assertTrue(all(value is None for value in trace["voltage_v"]))
        self.assertFalse(res["voltage_channels"]["working_potential"]["available"])

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

    def test_time_capacity_areal_axis_uses_metadata_and_custom_override(self):
        cell = self.cells["c1"]
        self.db.add(CellMetadata(cell_id=cell.id, key="electrode_area_cm2", value="2"))
        self.db.flush()
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        spec["computation"]["time_capacity"] = {
            "x_axis": "capacity_mah_cm2",
            "max_points_per_cell": 500,
        }

        metadata_result = engine.compute_time_capacity(
            self.db, spec, None, compact=True
        )
        metadata_trace = metadata_result["cell_traces"][0]
        raw_values = [
            value for value in metadata_trace["capacity_mah_cm2"] if value is not None
        ]
        display_values = [
            value for value in metadata_trace["display_x"] if value is not None
        ]
        self.assertGreater(len(raw_values), 0)
        self.assertEqual(len(raw_values), len(display_values))
        for raw_value, display_value in zip(raw_values, display_values):
            self.assertAlmostEqual(
                display_value, raw_value - raw_values[0], places=4
            )

        spec["computation"]["time_capacity"]["electrode_area_cm2"] = 4
        override_result = engine.compute_time_capacity(
            self.db, spec, None, compact=True
        )
        override_trace = override_result["cell_traces"][0]
        metadata_values = [
            value for value in metadata_trace["display_x"] if value is not None
        ]
        override_values = [
            value for value in override_trace["display_x"] if value is not None
        ]
        self.assertGreater(len(metadata_values), 0)
        self.assertEqual(len(metadata_values), len(override_values))
        for metadata_value, override_value in zip(metadata_values, override_values):
            self.assertAlmostEqual(override_value, metadata_value / 2, places=4)

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

    def _remove_prepared_sidecar(self, source_hash: str, parser_version: str) -> None:
        cache.time_capacity_derived_path(source_hash, parser_version).unlink(missing_ok=True)
        cache.time_capacity_derived_index_path(source_hash, parser_version).unlink(missing_ok=True)

    def _restore_prepared_sidecar(self, source_hash: str, parser_version: str) -> None:
        result = cache.prepare_time_capacity_derived(source_hash, parser_version)
        self.assertEqual(result["status"], "ready")

    def test_compact_time_axis_skips_unconsumed_capacity_transforms(self):
        source = self.cells["c1"].tests[0].file_links[0].file
        parser_version = parsing.current_parser_identity_for_extension(source.ext) or source.parser_version
        self._remove_prepared_sidecar(source.hash, parser_version)
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {"cycle_end": 5, "x_axis": "time"}
        try:
            with patch.object(
                engine,
                "_phase_capacity",
                side_effect=AssertionError(
                    "phase capacity is not consumed by time-axis compact view"
                ),
            ):
                result = engine.compute_time_capacity(
                    self.db,
                    spec,
                    None,
                    precision="standard",
                    compact=True,
                )
        finally:
            self._restore_prepared_sidecar(source.hash, parser_version)
        trace = result["cell_traces"][0]
        self.assertEqual(trace["capacity_mah"], [])
        self.assertEqual(trace["capacity_mah_g"], [])
        self.assertEqual(trace["capacity_mah_cm2"], [])
        self.assertEqual(trace["phase"], [])

    def test_compact_time_axis_does_not_read_phase_only_prepared_sidecar(self):
        source = self.cells["c1"].tests[0].file_links[0].file
        parser_version = parsing.current_parser_identity_for_extension(source.ext) or source.parser_version
        self._restore_prepared_sidecar(source.hash, parser_version)
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {"cycle_end": 5, "x_axis": "time"}
        diagnostics: dict = {}
        with patch(
            "app.services.time_capacity_path.load_indexed_time_capacity_derived",
            side_effect=AssertionError("phase-only Time requests must not read the sidecar"),
        ), patch.object(
            engine,
            "_phase_capacity",
            side_effect=AssertionError("phase capacity is not consumed by time-axis compact view"),
        ):
            result = engine.compute_time_capacity(
                self.db,
                spec,
                None,
                precision="standard",
                compact=True,
                access_diagnostics=diagnostics,
            )

        cell_diagnostics = diagnostics["cells"][0]
        self.assertEqual(cell_diagnostics["derived_access"], "not_needed")
        self.assertEqual(cell_diagnostics["phase_source"], "not_needed")
        self.assertEqual(cell_diagnostics["phase_capacity_source"], "not_needed")
        self.assertNotIn("prepared_derived_read", cell_diagnostics.get("stages", {}))
        self.assertEqual(result["cell_traces"][0]["phase"], [])

    def test_compact_capacity_axis_skips_unconsumed_continuous_time(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycle_end": 5,
            "x_axis": "capacity_mah",
        }
        with patch.object(
            engine,
            "_continuous_time",
            side_effect=AssertionError(
                "continuous time is not consumed by capacity-axis compact view"
            ),
        ):
            result = engine.compute_time_capacity(
                self.db,
                spec,
                None,
                precision="standard",
                compact=True,
            )
        self.assertTrue(result["cell_traces"][0]["capacity_mah"])
        self.assertEqual(result["cell_traces"][0]["time_s"], [])

    def test_compact_provenance_is_built_for_display_rows_only(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "x_axis": "time",
            "max_points_per_cell": 100,
        }
        with patch.object(
            time_capacity_workers,
            "_compact_source_columns",
            wraps=time_capacity_workers._compact_source_columns,
        ) as provenance:
            result = engine.compute_time_capacity(
                self.db,
                spec,
                None,
                precision="standard",
                compact=True,
            )

        trace = result["cell_traces"][0]
        self.assertEqual(provenance.call_count, 1)
        self.assertEqual(len(provenance.call_args.args[0]), len(trace["cycle"]))
        self.assertEqual(len(trace["source_cycle"]), len(trace["cycle"]))
        self.assertEqual(len(trace["source_index"]), len(trace["cycle"]))
        self.assertEqual(
            trace["sources"],
            [
                {"position": 1, "filename": "c1.ndax", "hash": self.HASHES["c1"]},
            ],
        )
        self.assertNotIn("source_position", trace)
        self.assertNotIn("source_filename", trace)
        self.assertNotIn("source_hash", trace)
        self.assertTrue(all(index < len(trace["cycle"]) for index in trace["source_boundary_indices"]))

    def test_time_capacity_refinement_keeps_canonical_consecutive_origin(self):
        overview_spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        overview_spec["computation"]["time_capacity"] = {
            "cycle_start": 1,
            "cycle_end": 50,
            "x_axis": "time",
            "display_mode": "consecutive",
            "max_points_per_cell": 4000,
        }
        candidate_spec = deepcopy(overview_spec)
        candidate_spec["computation"]["time_capacity"]["cycle_start"] = 28
        candidate_spec["computation"]["time_capacity"]["cycle_end"] = 30

        overview = engine.compute_time_capacity(
            self.db,
            overview_spec,
            None,
            precision="standard",
            compact=True,
        )
        overview_trace = overview["cell_traces"][0]
        overview_cycle_29 = [
            value
            for value, cycle in zip(overview_trace["display_x"], overview_trace["cycle"])
            if cycle == 29
        ]
        self.assertTrue(overview_cycle_29)
        viewport_min = min(overview_cycle_29) - 1.0
        viewport_max = max(overview_cycle_29) + 1.0

        refined = engine.compute_time_capacity(
            self.db,
            candidate_spec,
            None,
            precision="standard",
            compact=True,
            display_origin_cycle_start=1,
            refinement=True,
            refinement_viewport_x_min=viewport_min,
            refinement_viewport_x_max=viewport_max,
        )
        trace = refined["cell_traces"][0]
        refined_cycle_29 = [
            value for value, cycle in zip(trace["display_x"], trace["cycle"]) if cycle == 29
        ]
        self.assertTrue(refined_cycle_29)
        self.assertEqual(refined_cycle_29, overview_cycle_29)
        self.assertTrue(all(viewport_min <= value <= viewport_max for value in trace["display_x"]))
        self.assertEqual(len(trace["source_index"]), len(trace["cycle"]))
        self.assertEqual(len(trace["sources"]), 1)

    def test_time_capacity_refinement_process_matches_forced_serial(self):
        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["c1"].id},
                {"kind": "cell", "ref_id": self.cells["c2"].id},
            ]
        )
        spec["computation"]["time_capacity"] = {
            "cycle_start": 18,
            "cycle_end": 24,
            "x_axis": "time",
            "display_mode": "consecutive",
            "max_points_per_cell": 4000,
        }
        kwargs = {
            "viewport_width": 1200,
            "precision": "standard",
            "compact": True,
            "display_origin_cycle_start": 1,
            "refinement": True,
            "refinement_viewport_x_min": 60_000.0,
            "refinement_viewport_x_max": 90_000.0,
        }
        pool = None
        published = False
        try:
            time_capacity_workers.shutdown_time_capacity_worker_pool()
            pool = time_capacity_workers._new_pool(2)
            time_capacity_workers._warm_pool(pool, 2)
            with time_capacity_workers._POOL_LOCK:
                time_capacity_workers._POOL = pool
                time_capacity_workers._POOL_WORKERS = 2
                time_capacity_workers._POOL_STATE = "ready"
            published = True
            serial = time_capacity_workers.try_compute_time_capacity(
                self.db,
                spec,
                None,
                force_serial=True,
                **kwargs,
            )
            process_decision = time_capacity_workers.ExecutionDecision(
                "process",
                2,
                "focused_test",
                logical_cpus=16,
                total_memory_bytes=32 * 1024 * 1024 * 1024,
                available_memory_bytes=16 * 1024 * 1024 * 1024,
            )
            with patch.object(time_capacity_workers, "choose_execution", return_value=process_decision):
                process = time_capacity_workers.try_compute_time_capacity(
                    self.db,
                    spec,
                    None,
                    **kwargs,
                )
            self.assertIsNotNone(serial)
            self.assertIsNotNone(process)
            self.assertEqual(process["cell_traces"], serial["cell_traces"])
            self.assertEqual(process["settings"], serial["settings"])
            self.assertEqual(process["rendering"], serial["rendering"])
        finally:
            time_capacity_workers.shutdown_time_capacity_worker_pool()
            if pool is not None and not published:
                pool.shutdown(wait=True, cancel_futures=True)

    def test_time_capacity_refinement_rejects_explicit_sparse_cycles(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycles": [1, 10, 20],
            "x_axis": "time",
            "display_mode": "consecutive",
        }
        analysis = Analysis(title="Sparse refinement", spec=spec)
        self.db.add(analysis)
        self.db.commit()
        request = analyses_router.TimeCapacityRefinementRequest(
            spec=spec,
            viewport_x_min=0.0,
            viewport_x_max=10.0,
            viewport_width=1200,
            cycle_start=1,
            cycle_end=20,
            request_generation="sparse",
        )
        with self.assertRaises(analyses_router.HTTPException) as raised:
            analyses_router.refine_time_capacity_analysis(analysis.id, request, self.db)
        self.assertEqual(raised.exception.status_code, 422)

    def test_time_capacity_refinement_is_ephemeral_and_returns_identity(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycle_start": 1,
            "cycle_end": 3,
            "x_axis": "time",
            "display_mode": "consecutive",
            "max_points_per_cell": 4000,
        }
        analysis = Analysis(title="Ephemeral refinement", spec=spec)
        self.db.add(analysis)
        self.db.commit()
        request = analyses_router.TimeCapacityRefinementRequest(
            spec=spec,
            viewport_x_min=0.0,
            viewport_x_max=10.0,
            viewport_width=1200,
            cycle_start=1,
            cycle_end=3,
            request_generation="g1",
        )
        with patch.object(analysis_cache, "load_result_body", side_effect=AssertionError("refinement cache read")), patch.object(
            analysis_cache, "store_result", side_effect=AssertionError("refinement cache write")
        ):
            response = analyses_router.refine_time_capacity_analysis(
                analysis.id,
                request,
                self.db,
            )
        body = json.loads(response.body)
        self.assertEqual(body["request_generation"], "g1")
        self.assertEqual(body["overview_data_signature"], body["data_signature"])
        self.assertTrue(body["cell_traces"])

    def test_ordinary_worker_process_matches_forced_serial_trace_order(self):
        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["c1"].id},
                {"kind": "cell", "ref_id": self.cells["c2"].id},
                {"kind": "replicate_group", "ref_id": self.group.id},
            ]
        )
        spec["computation"]["time_capacity"] = {"cycle_end": 5, "x_axis": "time"}
        pool = None
        published = False
        try:
            time_capacity_workers.shutdown_time_capacity_worker_pool()
            pool = time_capacity_workers._new_pool(2)
            time_capacity_workers._warm_pool(pool, 2)
            with time_capacity_workers._POOL_LOCK:
                time_capacity_workers._POOL = pool
                time_capacity_workers._POOL_WORKERS = 2
                time_capacity_workers._POOL_STATE = "ready"
            published = True
            serial = time_capacity_workers.try_compute_time_capacity(
                self.db,
                spec,
                None,
                viewport_width=1200,
                precision="standard",
                compact=True,
                force_serial=True,
            )
            process_decision = time_capacity_workers.ExecutionDecision(
                "process",
                2,
                "focused_test",
                logical_cpus=16,
                total_memory_bytes=32 * 1024 * 1024 * 1024,
                available_memory_bytes=16 * 1024 * 1024 * 1024,
            )
            with patch.object(
                time_capacity_workers,
                "choose_execution",
                return_value=process_decision,
            ):
                process = time_capacity_workers.try_compute_time_capacity(
                    self.db,
                    spec,
                    None,
                    viewport_width=1200,
                    precision="standard",
                    compact=True,
                )
            self.assertIsNotNone(serial)
            self.assertIsNotNone(process)
            self.assertEqual(process["cell_traces"], serial["cell_traces"])
            self.assertEqual(process["voltage_channels"], serial["voltage_channels"])
            self.assertEqual(process["settings"], serial["settings"])
            self.assertEqual(process["rendering"], serial["rendering"])
        finally:
            time_capacity_workers.shutdown_time_capacity_worker_pool()
            if pool is not None and not published:
                pool.shutdown(wait=True, cancel_futures=True)

    def test_ordinary_request_before_pool_ready_uses_serial_without_creating_pool(self):
        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["c1"].id},
                {"kind": "cell", "ref_id": self.cells["c2"].id},
                {"kind": "replicate_group", "ref_id": self.group.id},
            ]
        )
        spec["computation"]["time_capacity"] = {"cycle_end": 5, "x_axis": "time"}
        process_decision = time_capacity_workers.ExecutionDecision(
            "process",
            2,
            "focused_test",
            logical_cpus=16,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        diagnostics: dict = {}
        time_capacity_workers.shutdown_time_capacity_worker_pool()
        with patch.object(
            time_capacity_workers,
            "choose_execution",
            return_value=process_decision,
        ), patch.object(
            time_capacity_workers,
            "_POOL_STATE",
            "warming",
        ), patch.object(
            time_capacity_workers,
            "_POOL",
            None,
        ), patch.object(
            time_capacity_workers,
            "_new_pool",
            side_effect=AssertionError("request must not create a cold pool"),
        ):
            result = time_capacity_workers.try_compute_time_capacity(
                self.db,
                spec,
                None,
                viewport_width=1200,
                precision="standard",
                compact=True,
                access_diagnostics=diagnostics,
            )
        self.assertIsNotNone(result)
        self.assertEqual(diagnostics["execution"]["mode"], "serial")
        self.assertEqual(
            diagnostics["execution"]["reason"],
            "pool_warmup_pending_serial",
        )

    def test_ordinary_worker_process_failure_falls_back_to_exact_serial(self):
        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["c1"].id},
                {"kind": "cell", "ref_id": self.cells["c2"].id},
                {"kind": "replicate_group", "ref_id": self.group.id},
            ]
        )
        spec["computation"]["time_capacity"] = {"cycle_end": 5, "x_axis": "time"}
        serial = time_capacity_workers.try_compute_time_capacity(
            self.db,
            spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            force_serial=True,
        )
        process_decision = time_capacity_workers.ExecutionDecision(
            "process",
            2,
            "focused_test",
            logical_cpus=16,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        diagnostics: dict = {}
        with patch.object(
            time_capacity_workers,
            "choose_execution",
            return_value=process_decision,
        ), patch.object(
            time_capacity_workers,
            "_run_process",
            side_effect=RuntimeError("worker crashed"),
        ):
            fallback = time_capacity_workers.try_compute_time_capacity(
                self.db,
                spec,
                None,
                viewport_width=1200,
                precision="standard",
                compact=True,
                access_diagnostics=diagnostics,
            )
        self.assertIsNotNone(serial)
        self.assertIsNotNone(fallback)
        self.assertEqual(fallback["cell_traces"], serial["cell_traces"])
        self.assertEqual(fallback["settings"], serial["settings"])
        self.assertEqual(fallback["rendering"], serial["rendering"])
        self.assertEqual(
            diagnostics["execution"]["reason"],
            "process_failure_serial_fallback",
        )

    def test_prepared_and_forced_fallback_time_capacity_payloads_match(self):
        source = self.cells["c1"].tests[0].file_links[0].file
        parser_version = parsing.current_parser_identity_for_extension(source.ext) or source.parser_version
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        spec["computation"]["time_capacity"] = {
            "cycle_end": 12,
            "x_axis": "capacity_mah",
        }
        prepared = engine.compute_time_capacity(
            self.db,
            deepcopy(spec),
            None,
            precision="standard",
            compact=True,
        )
        self._remove_prepared_sidecar(source.hash, parser_version)
        try:
            fallback = engine.compute_time_capacity(
                self.db,
                deepcopy(spec),
                None,
                precision="standard",
                compact=True,
            )
        finally:
            self._restore_prepared_sidecar(source.hash, parser_version)
        self.assertEqual(prepared["cell_traces"], fallback["cell_traces"])

    def test_prepared_and_fallback_cover_time_capacity_consumer_matrix(self):
        cell = self.cells["c1"]
        source = cell.tests[0].file_links[0].file
        parser_version = parsing.current_parser_identity_for_extension(source.ext) or source.parser_version
        self.db.add(CellMetadata(cell_id=cell.id, key="active_mass_mg", value="10"))
        self.db.add(CellMetadata(cell_id=cell.id, key="electrode_area_cm2", value="2"))
        self.db.flush()

        settings_matrix = [
            {"cycle_end": 12, "x_axis": "time"},
            {"cycle_end": 12, "x_axis": "capacity_mah"},
            {"cycle_end": 12, "x_axis": "capacity_mah_g"},
            {"cycle_end": 12, "x_axis": "capacity_mah_cm2"},
            {
                "cycle_end": 12,
                "view": "dqdv",
                "x_axis": "capacity_mah",
                "smoothing_window": 3,
                "derivative_phase": "both",
                "derivative_specific": False,
            },
            {
                "cycle_end": 12,
                "view": "dvdq",
                "x_axis": "capacity_mah_g",
                "smoothing_window": 3,
                "derivative_phase": "both",
                "derivative_specific": True,
            },
        ]
        for settings in settings_matrix:
            with self.subTest(settings=settings):
                spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
                spec["computation"]["time_capacity"] = settings
                prepared = engine.compute_time_capacity(
                    self.db, deepcopy(spec), None, precision="standard", compact=True
                )
                self._remove_prepared_sidecar(source.hash, parser_version)
                try:
                    fallback = engine.compute_time_capacity(
                        self.db, deepcopy(spec), None, precision="standard", compact=True
                    )
                finally:
                    self._restore_prepared_sidecar(source.hash, parser_version)
                self.assertEqual(prepared["cell_traces"], fallback["cell_traces"])

        for mode in ("excluded", "only", "hidden"):
            with self.subTest(protocol_mode=mode):
                spec = self.spec_with_protocol_mode(mode)
                prepared = engine.compute_time_capacity(
                    self.db, deepcopy(spec), None, precision="standard", compact=True
                )
                self._remove_prepared_sidecar(source.hash, parser_version)
                try:
                    fallback = engine.compute_time_capacity(
                        self.db, deepcopy(spec), None, precision="standard", compact=True
                    )
                finally:
                    self._restore_prepared_sidecar(source.hash, parser_version)
                self.assertEqual(prepared["cell_traces"], fallback["cell_traces"])

        full_spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        full_spec["computation"]["time_capacity"] = {
            "cycle_start": 1,
            "cycle_end": None,
            "x_axis": "capacity_mah",
            "max_points_per_cell": 100,
        }
        prepared_full = engine.compute_time_capacity(
            self.db, deepcopy(full_spec), None, precision="full", compact=False
        )
        self._remove_prepared_sidecar(source.hash, parser_version)
        try:
            fallback_full = engine.compute_time_capacity(
                self.db, deepcopy(full_spec), None, precision="full", compact=False
            )
        finally:
            self._restore_prepared_sidecar(source.hash, parser_version)
        self.assertEqual(prepared_full["cell_traces"], fallback_full["cell_traces"])

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

    def test_scalar_metadata_reads_do_not_load_the_whole_collection(self):
        """The three scalar lookups must stay O(keys), not O(metadata rows).

        Cells accumulate thousands of metadata rows. Reading them through
        ``cell.metadata_entries`` made every analysis request — including pure
        cache hits — instantiate the entire collection as ORM objects, which
        dominated the response time. Guard both the values and the access.
        """
        cell = self.cells["c1"]
        self.db.add_all(
            [CellMetadata(cell_id=cell.id, key=f"filler.{i}", value=str(i)) for i in range(300)]
            + [
                CellMetadata(cell_id=cell.id, key="active_mass_mg", value="12.5"),
                CellMetadata(cell_id=cell.id, key="nominal_capacity_mah", value="3.4"),
                CellMetadata(cell_id=cell.id, key="electrode_area_cm2", value="1.5"),
            ]
        )
        self.db.commit()
        self.db.expire_all()

        fresh = self.db.get(Cell, cell.id)
        self.assertEqual(engine.cell_active_mass_mg(fresh), 12.5)
        self.assertEqual(engine.cell_nominal_capacity_mah(fresh), 3.4)
        self.assertEqual(engine.cell_electrode_area_cm2(fresh), 1.5)
        # The filler rows must never have been materialized.
        self.assertIn("metadata_entries", inspect(fresh).unloaded)

        # An override wins over the plain key, and the already-loaded path
        # (some other request touched the collection first) agrees.
        self.db.add(CellMetadata(cell_id=cell.id, key="override.active_mass_mg", value="99.0"))
        self.db.commit()
        self.db.expire_all()
        loaded = self.db.get(Cell, cell.id)
        self.assertEqual(len(loaded.metadata_entries), 304)
        self.assertEqual(engine.cell_active_mass_mg(loaded), 99.0)

    def test_preloading_sources_removes_the_per_cell_query_walk(self):
        """Walking cell.tests -> file_links -> file lazily is an N+1.

        Building a cache key for 25 cells issued 175 queries before any cached
        bytes were read. The preload must make those walks free, return the
        files in the same order, and leave header_meta unfetched — it holds the
        raw instrument header and nothing on the cache-hit path reads it.
        """
        cells = list(self.cells.values())
        expected = {}
        for cell in cells:
            hashes, files = engine.cell_ordered_hashes(self.db, cell)
            expected[cell.id] = (hashes, [f.id for f in files])

        self.db.expire_all()
        engine.preload_cell_sources(self.db, cells)

        queries: list[str] = []

        def record(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        bind = self.db.get_bind()
        event.listen(bind, "before_cursor_execute", record)
        try:
            for cell in cells:
                hashes, files = engine.cell_ordered_hashes(self.db, cell)
                self.assertEqual((hashes, [f.id for f in files]), expected[cell.id])
        finally:
            event.remove(bind, "before_cursor_execute", record)

        self.assertEqual(queries, [], f"preload left {len(queries)} lazy queries behind")

        # header_meta stays deferred until something actually asks for it.
        _hashes, files = engine.cell_ordered_hashes(self.db, cells[0])
        self.assertIn("header_meta", inspect(files[0]).unloaded)
        self.assertEqual(files[0].header_meta, analysis_protocol_header())

    def test_cell_source_chain_rejects_multiple_internal_rows(self):
        cell = self.cells["c1"]
        self.db.add(Test(cell_id=cell.id, name="Unexpected second row"))
        self.db.commit()

        with self.assertRaises(engine.CellSourceChainInvariantError) as ctx:
            engine.cell_ordered_hashes(self.db, cell)
        self.assertEqual(ctx.exception.detail["code"], "single_internal_test_required")
        self.assertEqual(ctx.exception.detail["test_count"], 2)

        with self.assertRaises(engine.CellSourceChainInvariantError):
            engine.compute(self.db, self.spec_with([{"kind": "cell", "ref_id": cell.id}]), None)

    def test_new_analysis_provenance_has_only_cell_source_chain_fields(self):
        result = engine.compute(
            self.db,
            self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}]),
            None,
        )
        self.assertTrue(result["sources"])
        self.assertTrue(all("test_ids" not in source for source in result["sources"]))

    def test_provenance_roundtrip_and_version_badge(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["c1"].id}])
        res = engine.compute(self.db, spec, None)
        prov = engine.build_provenance(res)
        self.assertEqual(prov["calc_version"], res["calc_version"])
        old_prov = dict(prov, calc_version="0.9.0")
        res2 = engine.compute(self.db, spec, old_prov)
        kinds = {b["kind"] for b in res2["badges"]}
        self.assertIn("newer_calc", kinds)

    def _make_pinned_cell(self, file_hash: str, filename: str = "legacy.ndax") -> Cell:
        cell = Cell(name=f"pinned-{file_hash[:6]}")
        self.db.add(cell)
        self.db.flush()
        sf = SourceFile(
            hash=file_hash,
            path=file_hash,
            filename=filename,
            size=1,
            ext="ndax",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            header_meta=analysis_protocol_header(),
            nominal_capacity_mah=2.0,
        )
        self.db.add(sf)
        test = Test(cell_id=cell.id, name="t")
        self.db.add(test)
        self.db.flush()
        self.db.add(TestFile(test_id=test.id, file_id=sf.id, position=0))
        self.db.commit()
        return cell

    def test_new_compute_pins_parser_identity_per_source(self):
        """Case 12: a fresh compute records each contributing source's own
        resolved identity in the new provenance shape."""
        cell = self.cells["c1"]
        result = engine.compute(
            self.db, self.spec_with([{"kind": "cell", "ref_id": cell.id}]), None
        )
        source_entry = result["sources"][0]
        self.assertEqual(len(source_entry["files"]), 1)
        file_entry = source_entry["files"][0]
        self.assertEqual(file_entry["hash"], self.HASHES["c1"])
        self.assertEqual(file_entry["position"], 1)
        self.assertEqual(file_entry["parser_version"], parsing.parser_identity("x.ndax"))

    def test_legacy_pinned_analysis_renders_from_pinned_cache_without_reparsing(self):
        """Cases 15-17: legacy single-scalar provenance normalizes to the one
        historical identity it covered; a saved analysis pinned to that
        identity renders from ITS cache, and the source is never silently
        reparsed under the current identity and relabeled as the pinned one
        — the exact silent-recompute bug this child must prevent."""
        file_hash = "9a" * 32
        cell = self._make_pinned_cell(file_hash)
        old_identity = "nb:vOLD.00.00:r1"

        raw = synth_raw(3, 2.0, 0.005)
        cycles = calc.per_cycle(raw)
        cache.raw_path(file_hash, old_identity).parent.mkdir(parents=True, exist_ok=True)
        cache._write_atomic(raw, cache.raw_path(file_hash, old_identity))
        cache._write_atomic(cycles, cache.cycles_path(file_hash, old_identity))
        try:
            # Legacy shape: one scalar `parser_version`, no per-source
            # `files` array — exactly what a pre-040.3 saved analysis has.
            legacy_provenance = {
                "calc_version": cache.CALC_VERSION,
                "parser_version": old_identity,
                "sources": [{"cell_id": cell.id, "file_hashes": [file_hash]}],
            }
            spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])

            with patch(
                "app.services.scanner.parse_file",
                side_effect=AssertionError("must not reparse a pinned historical source"),
            ):
                result = engine.compute(self.db, spec, legacy_provenance)

            self.assertEqual(result["cell_series"][0]["x"], [1, 2, 3])
            pinned_files = result["sources"][0]["files"]
            self.assertEqual(pinned_files[0]["parser_version"], old_identity)
            self.assertNotEqual(old_identity, parsing.parser_identity(f"{file_hash}.ndax"))
            kinds = {b["kind"] for b in result["badges"]}
            self.assertIn("newer_parser", kinds)
        finally:
            shutil.rmtree(cache.raw_path(file_hash, old_identity).parent, ignore_errors=True)

    def test_missing_legacy_cache_is_not_relabeled_as_current(self):
        """Case 17: when the pinned identity's cache does not exist, the
        result must show the source as missing — never silently reparse the
        current source and pretend the result is the old pinned identity."""
        file_hash = "9b" * 32
        cell = self._make_pinned_cell(file_hash)
        missing_identity = "nb:vNEVERBUILT:r1"
        legacy_provenance = {
            "calc_version": cache.CALC_VERSION,
            "parser_version": missing_identity,
            "sources": [{"cell_id": cell.id, "file_hashes": [file_hash]}],
        }
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])

        with patch(
            "app.services.scanner.parse_file",
            side_effect=AssertionError("must not reparse under a mismatched identity"),
        ):
            result = engine.compute(self.db, spec, legacy_provenance)

        self.assertEqual(result["cell_series"][0]["x"], [])
        kinds = {b["kind"] for b in result["badges"]}
        self.assertIn("cache_missing", kinds)
        missing_badge = next(b for b in result["badges"] if b["kind"] == "cache_missing")
        self.assertIn(missing_identity, missing_badge["detail"])

    def test_recompute_under_current_versions_persists_new_provenance_shape(self):
        """Case 18: recomputing with use_current_versions=True must produce
        (and, once saved via build_provenance, persist) the new per-source
        shape at the CURRENT identity, not the stale pinned one."""
        file_hash = "9c" * 32
        cell = self._make_pinned_cell(file_hash)
        self.FRAMES[file_hash] = synth_raw(2, 2.0, 0.004)
        cache.build(file_hash, f"{file_hash}.ndax")
        try:
            legacy_provenance = {
                "calc_version": cache.CALC_VERSION,
                "parser_version": "nb:vOLD.00.00:r1",
                "sources": [{"cell_id": cell.id, "file_hashes": [file_hash]}],
            }
            spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
            result = engine.compute(
                self.db, spec, legacy_provenance, use_current_versions=True
            )
            provenance = engine.build_provenance(result)
            file_entry = provenance["sources"][0]["files"][0]
            self.assertEqual(file_entry["parser_version"], parsing.parser_identity(f"{file_hash}.ndax"))
            self.assertNotEqual(file_entry["parser_version"], "nb:vOLD.00.00:r1")
        finally:
            shutil.rmtree(cache.raw_path(file_hash, parsing.parser_identity(f"{file_hash}.ndax")).parent, ignore_errors=True)

    def test_startup_preparation_rebuild_does_not_disturb_pinned_analysis(self):
        """Spec 042, tests 4-6 — the highest-risk property in that spec: a
        saved analysis pinned to an older identity must keep rendering from
        ITS OWN cache, unrecomputed and unrelabeled, after a startup
        preparation pass brings the underlying SourceFile's own registration
        forward to a fresh build at the CURRENT identity. Both caches must
        coexist; neither is deleted or relabeled; the "newer parser
        available" badge stays truthful throughout.

        `cache.build` and the `SourceFile.parser_version` assignment used
        here are the exact same calls Spec 042's startup preparation path
        (`scanner._prepare_capacity_source_worker` /
        `_apply_capacity_source_result`) makes; scheduling that call from
        the right work set is covered separately by
        `tests/test_scientific_preparation.py`."""
        old_identity = "nb:vOLD.00.00:r1"
        content = b"spec-042 bring-forward fixture bytes"
        file_hash = hashlib.sha256(content).hexdigest()
        current_identity = parsing.parser_identity(f"{file_hash}.ndax")
        self.assertNotEqual(old_identity, current_identity)

        cell = self._make_pinned_cell(file_hash)
        sf = self.db.query(SourceFile).filter(SourceFile.hash == file_hash).one()
        sf.parser_version = old_identity
        sf.location_status = "online"
        sf.capacity_summary_status = "ready"
        self.db.commit()
        self.assertTrue(scanner._needs_identity_bring_forward(sf))

        # The historical cache at the OLD identity — what the saved analysis
        # below pins to, exactly like a real pre-upgrade parsed source.
        old_raw = synth_raw(2, 2.0, 0.01)
        old_cycles = calc.per_cycle(old_raw)
        cache.raw_path(file_hash, old_identity).parent.mkdir(parents=True, exist_ok=True)
        cache._write_atomic(old_raw, cache.raw_path(file_hash, old_identity))
        cache._write_atomic(old_cycles, cache.cycles_path(file_hash, old_identity))

        # The frame the "upgraded" parser produces — deliberately a
        # different cycle count so a mixed-up render is unmistakable.
        self.FRAMES[file_hash] = synth_raw(5, 3.0, 0.02)
        try:
            # This is the real rebuild call Spec 042's startup preparation
            # makes for an identity-mismatched, reachable source.
            build_info = cache.build(file_hash, f"{file_hash}.ndax")
            sf.parser_version = build_info["parser_version"]
            self.db.commit()
            self.assertEqual(sf.parser_version, current_identity)

            # Both caches coexist — neither deleted, neither relabeled.
            self.assertTrue(cache.raw_path(file_hash, old_identity).exists())
            self.assertTrue(cache.raw_path(file_hash, current_identity).exists())
            self.assertTrue(
                cache.has_cycles(file_hash, old_identity, cache.CALC_VERSION)
            )
            self.assertTrue(
                cache.has_cycles(file_hash, current_identity, cache.CALC_VERSION)
            )

            legacy_provenance = {
                "calc_version": cache.CALC_VERSION,
                "parser_version": old_identity,
                "sources": [{"cell_id": cell.id, "file_hashes": [file_hash]}],
            }
            spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])

            with patch(
                "app.services.scanner.parse_file",
                side_effect=AssertionError(
                    "must not reparse a pinned historical source after a "
                    "preparation pass rebuilt it at the current identity"
                ),
            ):
                pinned_result = engine.compute(self.db, spec, legacy_provenance)

            # Still the OLD 2-cycle data, not the NEW 5-cycle data.
            self.assertEqual(pinned_result["cell_series"][0]["x"], [1, 2])
            pinned_files = pinned_result["sources"][0]["files"]
            self.assertEqual(pinned_files[0]["parser_version"], old_identity)
            kinds = {b["kind"] for b in pinned_result["badges"]}
            self.assertIn("newer_parser", kinds)

            # A fresh compute (no pinned provenance) now sees the brought-
            # forward current-identity cache -- proving the rebuild actually
            # took effect for future analyses without touching the old one.
            fresh_result = engine.compute(self.db, spec, None)
            self.assertEqual(fresh_result["cell_series"][0]["x"], [1, 2, 3, 4, 5])
        finally:
            del self.FRAMES[file_hash]
            shutil.rmtree(cache.raw_path(file_hash, old_identity).parent, ignore_errors=True)

    def test_result_key_changes_when_pinned_source_identity_changes(self):
        """Case 13: a cache key must vary when a contributing source's
        pinned parser identity changes, even with everything else fixed."""
        cell = self.cells["c1"]
        spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        provenance_a = {
            "calc_version": cache.CALC_VERSION,
            "sources": [
                {
                    "cell_id": cell.id,
                    "file_hashes": [self.HASHES["c1"]],
                    "files": [
                        {"hash": self.HASHES["c1"], "position": 1, "parser_version": "nb:vA:r1"}
                    ],
                }
            ],
        }
        provenance_b = deepcopy(provenance_a)
        provenance_b["sources"][0]["files"][0]["parser_version"] = "nb:vB:r1"

        key_a = analysis_cache.result_key(
            self.db, "cycles", spec, provenance_a, use_current_versions=False
        )
        key_b = analysis_cache.result_key(
            self.db, "cycles", spec, provenance_b, use_current_versions=False
        )
        self.assertNotEqual(key_a, key_b)

    def test_result_key_unaffected_by_an_unrelated_cells_source_identity(self):
        """Case 14: a parser-identity change for a source belonging to a cell
        NOT in this spec's selection must not change the cache key."""
        cell1, cell2 = self.cells["c1"], self.cells["c2"]
        spec = self.spec_with([{"kind": "cell", "ref_id": cell1.id}])
        base_provenance = {
            "calc_version": cache.CALC_VERSION,
            "sources": [
                {
                    "cell_id": cell1.id,
                    "file_hashes": [self.HASHES["c1"]],
                    "files": [
                        {"hash": self.HASHES["c1"], "position": 1, "parser_version": "nb:vFixed:r1"}
                    ],
                },
                {
                    "cell_id": cell2.id,
                    "file_hashes": [self.HASHES["c2"]],
                    "files": [
                        {"hash": self.HASHES["c2"], "position": 1, "parser_version": "nb:vA:r1"}
                    ],
                },
            ],
        }
        changed_provenance = deepcopy(base_provenance)
        changed_provenance["sources"][1]["files"][0]["parser_version"] = "nb:vDifferent:r1"

        key_before = analysis_cache.result_key(
            self.db, "cycles", spec, base_provenance, use_current_versions=False
        )
        key_after = analysis_cache.result_key(
            self.db, "cycles", spec, changed_provenance, use_current_versions=False
        )
        self.assertEqual(key_before, key_after)

    def test_multi_source_cycle_compute_uses_shared_dense_stitch(self):
        hash_a = "d1" * 32
        hash_b = "e2" * 32
        for h, n_cycles in ((hash_a, 3), (hash_b, 2)):
            self.FRAMES[h] = synth_raw(n_cycles, 2.0, 0.005)
            if cache.raw_path(h).parent.exists():
                import shutil

                shutil.rmtree(cache.raw_path(h).parent)
            cache.build(h, f"{h}.ndax")

        cell = Cell(name="multi")
        self.db.add(cell)
        self.db.flush()
        files = []
        for position, (h, name) in enumerate(((hash_a, "a.ndax"), (hash_b, "b.ndax"))):
            sf = SourceFile(
                hash=h,
                path=h,
                filename=name,
                size=1,
                ext="ndax",
                parse_status="parsed",
                parser_version=parsing.PARSER_VERSION,
                header_meta=analysis_protocol_header(),
                nominal_capacity_mah=2.0,
            )
            self.db.add(sf)
            files.append(sf)
        test = Test(cell_id=cell.id, name="t")
        self.db.add(test)
        self.db.flush()
        for position, sf in enumerate(files):
            self.db.add(TestFile(test_id=test.id, file_id=sf.id, position=position))
        self.db.commit()

        result = engine.compute(
            self.db,
            self.spec_with([{"kind": "cell", "ref_id": cell.id}]),
            None,
        )
        series = result["cell_series"][0]
        self.assertEqual(series["x"], [1, 2, 3, 4, 5])
        self.assertEqual(series["metrics"]["n_cycles"], 5)
        self.assertEqual(series["source_cycle"], [1, 2, 3, 1, 2])
        self.assertEqual(series["source_position"], [1, 1, 1, 2, 2])
        self.assertEqual(
            [source["filename"] for source in series["source_descriptors"]],
            ["a.ndax", "b.ndax"],
        )
        self.assertEqual(series["source_descriptors"][1]["global_cycle_start"], 4)
        self.assertTrue(series["source_descriptors"][1]["tracked_tail"])

        time_spec = self.spec_with([{"kind": "cell", "ref_id": cell.id}])
        time_spec["computation"]["time_capacity"] = {
            "cycle_start": 1,
            "cycle_end": None,
            "x_axis": "capacity_mah",
            "max_points_per_cell": 500,
        }
        prepared_time = engine.compute_time_capacity(
            self.db, deepcopy(time_spec), None, precision="standard", compact=True
        )
        parser_versions = {
            h: parsing.current_parser_identity_for_extension("ndax") or parsing.PARSER_VERSION
            for h in (hash_a, hash_b)
        }
        for h, parser_version in parser_versions.items():
            self._remove_prepared_sidecar(h, parser_version)
        try:
            fallback_time = engine.compute_time_capacity(
                self.db, deepcopy(time_spec), None, precision="standard", compact=True
            )
        finally:
            for h, parser_version in parser_versions.items():
                self.assertEqual(
                    cache.prepare_time_capacity_derived(h, parser_version)["status"],
                    "ready",
                )
        self.assertEqual(
            prepared_time["cell_traces"],
            fallback_time["cell_traces"],
        )

        compact_time_spec = deepcopy(time_spec)
        compact_time_spec["computation"]["time_capacity"]["x_axis"] = "time"
        compact_time = engine.compute_time_capacity(
            self.db,
            compact_time_spec,
            None,
            precision="standard",
            compact=True,
        )["cell_traces"][0]
        self.assertEqual(
            compact_time["sources"],
            [
                {"position": 1, "filename": "a.ndax", "hash": hash_a},
                {"position": 2, "filename": "b.ndax", "hash": hash_b},
            ],
        )
        self.assertEqual(
            set(compact_time["source_index"]),
            {0, 1},
        )
        self.assertNotIn("source_position", compact_time)

    def test_incomplete_multi_source_cycle_result_fails_closed(self):
        hash_a = "f1" * 32
        hash_b = "f2" * 32
        cell = Cell(name="incomplete-multi")
        self.db.add(cell)
        self.db.flush()
        first = SourceFile(
            hash=hash_a,
            path=hash_a,
            filename="first.ndax",
            size=1,
            ext="ndax",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            header_meta=analysis_protocol_header(),
        )
        second = SourceFile(
            hash=hash_b,
            path=hash_b,
            filename="second.ndax",
            size=1,
            ext="ndax",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            header_meta=analysis_protocol_header(),
        )
        test = Test(cell=cell, name="one internal test")
        test.file_links = [TestFile(file=first, position=0), TestFile(file=second, position=1)]
        self.db.add(test)
        self.db.commit()

        with patch(
            "app.services.stitch.cache.load_cycles",
            side_effect=lambda file_hash, *_: {
                hash_a: synth_raw(2, 2.0, 0.01),
                hash_b: None,
            }.get(file_hash),
        ):
            result = engine.compute(
                self.db,
                self.spec_with([{"kind": "cell", "ref_id": cell.id}]),
                None,
            )

        series = result["cell_series"][0]
        self.assertEqual(series["x"], [])
        self.assertEqual(series["quantities"]["discharge_capacity_mah"], [])
        self.assertEqual(
            [badge["kind"] for badge in result["badges"]].count("continuation_source_missing"),
            1,
        )
        self.assertEqual(series["source_descriptors"][1]["status"], "missing")

    def test_analysis_engine_uses_shared_raw_stitch_service(self):
        self.assertFalse(hasattr(engine, "_stitch_raw"))


def synth_three_electrode_raw(n_cycles: int, cap0: float, fade: float) -> pd.DataFrame:
    """Deterministic synthetic three-electrode canonical frame (Spec 040.4):
    known working/counter potentials with voltage_v = working - counter, so
    the multi-voltage path can be proven end to end without a real BioLogic
    parser. Otherwise identical in shape to `synth_raw` above."""
    rows, idx, t = [], 0, 0.0
    for cyc in range(1, n_cycles + 1):
        cap = cap0 * (1 - fade) ** (cyc - 1)
        for status, sign in (("CC_Chg", 1), ("CC_DChg", -1)):
            for frac in (0.5, 1.0):
                idx += 1
                t += 1800
                working = 3.5 + sign * 0.2
                counter = 0.1
                rows.append({
                    "record_index": idx, "cycle": cyc, "step": cyc * 2 + (0 if sign > 0 else 1),
                    "step_index": (1 if cyc % 2 else 3) if sign > 0 else 2,
                    "status": status, "time_s": 1800.0 * frac,
                    "voltage_v": working - counter,
                    "working_potential_v": working,
                    "counter_potential_v": counter,
                    "current_ma": sign * 1000.0,
                    "charge_capacity_mah": cap * frac if sign > 0 else cap,
                    "discharge_capacity_mah": 0.0 if sign > 0 else cap * frac * 0.99,
                    "charge_energy_mwh": cap * frac * 3.5 if sign > 0 else cap * 3.5,
                    "discharge_energy_mwh": 0.0 if sign > 0 else cap * frac * 3.2,
                    "timestamp": pd.Timestamp("2026-01-01") + pd.Timedelta(seconds=t),
                })
    return pd.DataFrame(rows)


class DerivativeCurveTests(unittest.TestCase):
    @staticmethod
    def _settings(**overrides):
        settings = {
            "view": "dqdv",
            "derivative_phase": "both",
            "derivative_specific": False,
            "derivative_absolute_discharge": True,
            "smoothing_window": 1,
        }
        settings.update(overrides)
        return settings

    def _run(
        self,
        q,
        v,
        *,
        phases=None,
        cycles=None,
        segments=None,
        statuses=None,
        include_status=True,
        q_specific=None,
        settings=None,
    ):
        q = np.asarray(q, dtype="float64")
        v = np.asarray(v, dtype="float64")
        n = len(q)
        phases = list(phases) if phases is not None else ["charge"] * n
        cycles = list(cycles) if cycles is not None else [1] * n
        segments = list(segments) if segments is not None else [1] * n
        frame = pd.DataFrame({
            "cycle": cycles,
            "segment": segments,
            "voltage_v": v,
        })
        if include_status:
            frame["status"] = statuses if statuses is not None else ["CC_Chg"] * n
        diagnostics = {}
        x_out, y_out = engine._derivative_curve(
            frame,
            phases,
            q,
            q if q_specific is None else np.asarray(q_specific, dtype="float64"),
            self._settings(**(settings or {})),
            diagnostics,
        )
        return x_out, y_out, diagnostics

    def test_dqdv_charge_segment(self):
        x_out, y_out, _ = self._run([0, 1, 2, 3], [0, 1, 2, 3])
        np.testing.assert_allclose(x_out, [0, 1, 2, 3])
        np.testing.assert_allclose(y_out, [1, 1, 1, 1])

    def test_dqdv_discharge_absolute_toggle(self):
        _, absolute, _ = self._run(
            [0, 1, 2, 3], [3, 2, 1, 0], phases=["discharge"] * 4
        )
        _, signed, _ = self._run(
            [0, 1, 2, 3],
            [3, 2, 1, 0],
            phases=["discharge"] * 4,
            settings={"derivative_absolute_discharge": False},
        )
        np.testing.assert_allclose(absolute, [1, 1, 1, 1])
        np.testing.assert_allclose(signed, [-1, -1, -1, -1])

    def test_dvdq(self):
        x_out, y_out, _ = self._run(
            [0, 1, 2, 3], [0, 2, 4, 6], settings={"view": "dvdq"}
        )
        np.testing.assert_allclose(x_out, [0, 1, 2, 3])
        np.testing.assert_allclose(y_out, [2, 2, 2, 2])

    def test_derivative_specific_capacity(self):
        x_out, y_out, _ = self._run(
            [0, 1, 2, 3],
            [0, 1, 2, 3],
            q_specific=[0, 0.5, 1, 1.5],
            settings={"derivative_specific": True},
        )
        np.testing.assert_allclose(x_out, [0, 1, 2, 3])
        np.testing.assert_allclose(y_out, [0.5, 0.5, 0.5, 0.5])

    def test_even_smoothing_window_is_equivalent_to_next_odd_window(self):
        even_x, even_y, _ = self._run(
            range(7), [0, 1, 4, 9, 16, 25, 36], settings={"smoothing_window": 2}
        )
        odd_x, odd_y, _ = self._run(
            range(7), [0, 1, 4, 9, 16, 25, 36], settings={"smoothing_window": 3}
        )
        np.testing.assert_array_equal(even_x, odd_x)
        np.testing.assert_array_equal(even_y, odd_y)

    def test_explicit_cv_only_rows_are_masked(self):
        _, y_out, diagnostics = self._run(
            [0, 1, 2, 3],
            [0, 1, 2, 3],
            statuses=["CV_Chg"] * 4,
        )
        self.assertTrue(np.isnan(y_out).all())
        self.assertIn("derivative_status_classification", diagnostics["stages"])

    def test_cccv_is_not_masked_by_explicit_cv_rule(self):
        _, y_out, _ = self._run(
            [0, 1, 2, 3], [0, 1, 2, 3], statuses=["CCCV_Chg"] * 4
        )
        np.testing.assert_allclose(y_out, [1, 1, 1, 1])

    def test_mixed_status_rows_are_masked_locally(self):
        _, y_out, _ = self._run(
            [0, 1, 2, 3],
            [0, 1, 2, 3],
            statuses=["CC_Chg", "CV_Chg", "CCCV_Chg", "CC_Chg"],
        )
        self.assertTrue(np.isfinite(y_out[[0, 2, 3]]).all())
        self.assertTrue(np.isnan(y_out[1]))

    def test_denominator_near_zero_is_nan(self):
        _, y_out, _ = self._run([0, 1, 2, 3], [2, 2, 2, 2])
        self.assertTrue(np.isnan(y_out).all())

    def test_local_scale_outlier_is_rejected(self):
        _, y_out, _ = self._run(
            range(6), [0, 1, 1.000001, 1.000002, 1.000003, 2]
        )
        self.assertTrue(np.isnan(y_out).any())
        self.assertTrue(np.isfinite(y_out).any())

    def test_nan_capacity_or_voltage_does_not_escape_segment(self):
        _, y_out, _ = self._run([0, 1, np.nan, 3, 4], [0, 1, 2, 3, 4])
        self.assertEqual(np.isnan(y_out).tolist(), [False, True, False, True, False])

    def test_contiguous_boundaries_preserve_segment_counts_and_phase_rows(self):
        _, y_out, diagnostics = self._run(
            range(14),
            range(14),
            cycles=[1] * 8 + [2] * 6,
            segments=[1] * 6 + [2] * 2 + [1] * 4 + [2] * 2,
            phases=["charge"] * 4 + ["discharge"] * 4 + ["charge"] * 4 + ["rest"] * 2,
        )
        profile = diagnostics["derivative_profile"]
        self.assertEqual(profile["segments_processed"], 5)
        self.assertEqual(profile["eligible_segments"], 4)
        self.assertEqual(profile["output_segments"], 4)
        self.assertEqual(profile["phase_rows"], {"charge": 8, "discharge": 4, "rest": 2})
        self.assertTrue(all(type(value) is int for value in profile["phase_rows"].values()))
        self.assertTrue(np.isfinite(y_out[:12]).all())
        self.assertTrue(np.isnan(y_out[12:]).all())

    def test_selected_phase_limits_output_to_matching_runs(self):
        phases = ["charge"] * 4 + ["discharge"] * 4
        q = range(8)
        v = range(8)
        for selected, expected in (
            ("charge", ([True] * 4 + [False] * 4)),
            ("discharge", ([False] * 4 + [True] * 4)),
            ("both", ([True] * 8)),
        ):
            _, y_out, _ = self._run(
                q,
                v,
                phases=phases,
                segments=[1] * 4 + [2] * 4,
                settings={"derivative_phase": selected},
            )
            self.assertEqual(np.isfinite(y_out).tolist(), expected)

    def test_frame_without_status_preserves_derivative(self):
        _, y_out, _ = self._run(
            [0, 1, 2, 3], [0, 1, 2, 3], include_status=False
        )
        np.testing.assert_allclose(y_out, [1, 1, 1, 1])

    def test_empty_and_no_eligible_runs_are_empty_or_nan(self):
        x_out, y_out, diagnostics = self._run([], [])
        self.assertEqual(x_out.size, 0)
        self.assertEqual(y_out.size, 0)
        self.assertEqual(diagnostics["derivative_profile"]["segments_processed"], 0)

        _, rest_y, rest_diagnostics = self._run(
            [0, 1, 2], [0, 1, 2], phases=["rest"] * 3
        )
        self.assertTrue(np.isnan(rest_y).all())
        self.assertEqual(rest_diagnostics["derivative_profile"]["eligible_segments"], 0)


class TimeCapacitySettingsVoltageChannelTests(unittest.TestCase):
    """Spec 040.4 case 9: old saved specs (no voltage_channel key at all)
    normalize to the default primary voltage; an invalid/unknown value is
    also rejected back to the default rather than passed through."""

    def test_missing_key_defaults_to_voltage(self):
        settings = engine.time_capacity_settings({"time_capacity": {}})
        self.assertEqual(settings["voltage_channel"], "voltage")

    def test_no_time_capacity_block_at_all_defaults_to_voltage(self):
        settings = engine.time_capacity_settings({})
        self.assertEqual(settings["voltage_channel"], "voltage")

    def test_explicit_electrode_channel_round_trips(self):
        for channel in ("working_potential", "counter_potential"):
            settings = engine.time_capacity_settings(
                {"time_capacity": {"voltage_channel": channel}}
            )
            self.assertEqual(settings["voltage_channel"], channel)

    def test_unrecognized_value_falls_back_to_voltage(self):
        settings = engine.time_capacity_settings(
            {"time_capacity": {"voltage_channel": "not-a-real-channel"}}
        )
        self.assertEqual(settings["voltage_channel"], "voltage")


class MultiVoltageTimeCapacityTests(unittest.TestCase):
    """Spec 040.4: Time/Capacity working/counter potential selection,
    end to end through cache -> stitch -> compute_time_capacity, using a
    synthetic three-electrode source alongside the real adapter contract."""

    HASHES = {"three": "3e" * 32, "two": "2e" * 32}
    FRAMES = {}

    @classmethod
    def setUpClass(cls):
        cls._orig_parse = parsing.parse_timeseries
        cls.FRAMES = {
            cls.HASHES["three"]: synth_three_electrode_raw(50, 2.0, 0.005),
            cls.HASHES["two"]: synth_raw(5, 2.0, 0.005),
        }

        def fake_parse(path):
            return cls.FRAMES[Path(str(path)).stem]

        parsing.parse_timeseries = fake_parse
        for h in cls.HASHES.values():
            d = cache.raw_path(h).parent
            if d.exists():
                shutil.rmtree(d)
            cache.build(h, f"{h}.ndax")

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
        for name, h in self.HASHES.items():
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
        self.db.commit()

    def spec_with(self, entries, **comp):
        spec = engine.default_spec("t")
        spec["selection"]["entries"] = entries
        spec["computation"].update(comp)
        return spec

    def test_working_potential_request_returns_correct_values_and_availability(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        spec["computation"]["time_capacity"] = {"voltage_channel": "working_potential"}

        res = engine.compute_time_capacity(self.db, spec, None)

        trace = res["cell_traces"][0]
        values = [value for value in trace["voltage_v"] if value is not None]
        self.assertGreater(len(values), 0)
        # working_potential_v is always exactly 3.5 +/- 0.2 in the fixture,
        # never voltage_v (working - counter = 3.4/3.6 - 0.1).
        for value in values:
            self.assertIn(round(value, 1), (3.3, 3.7))
        self.assertTrue(res["voltage_channels"]["working_potential"]["available"])

    def test_full_auxiliary_export_request_keeps_exact_values_above_plot_limit(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        spec["computation"]["time_capacity"] = {
            "voltage_channel": "working_potential",
            "max_points_per_cell": 100,
        }

        compact = engine.compute_time_capacity(
            self.db, spec, None, precision="standard", compact=True
        )
        full = engine.compute_time_capacity(
            self.db, spec, None, precision="full", compact=False
        )

        compact_values = [
            value for value in compact["cell_traces"][0]["voltage_v"] if value is not None
        ]
        full_values = [
            value for value in full["cell_traces"][0]["voltage_v"] if value is not None
        ]
        self.assertLess(len(compact_values), len(full_values))
        self.assertEqual(len(full_values), 200)
        self.assertEqual(full_values[0], 3.7)
        self.assertEqual(full["settings"]["voltage_channel"], "working_potential")

    def test_three_electrode_reference_context_is_reflected_in_generic_labels(self):
        source = self.db.query(SourceFile).filter(SourceFile.hash == self.HASHES["three"]).one()
        source.header_meta = {
            canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                working_potential_available=True,
                counter_potential_available=True,
                reference_electrode="Ag/AgCl",
                voltage_derived=True,
                voltage_origin="derived_working_minus_counter",
            )
        }
        self.db.commit()

        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        spec["computation"]["time_capacity"] = {"voltage_channel": "working_potential"}

        result = engine.compute_time_capacity(self.db, spec, None)

        self.assertEqual(
            result["voltage_channels"]["working_potential"]["label"],
            "Working potential vs Ag/AgCl (V)",
        )
        self.assertEqual(
            result["voltage_channels"]["counter_potential"]["label"],
            "Counter potential vs Ag/AgCl (V)",
        )
        self.assertEqual(
            result["voltage_channels"]["working_potential"]["reference_electrode"],
            "Ag/AgCl",
        )

    def test_explicit_non_cell_primary_role_is_preserved_in_generic_channel_labels(self):
        source = self.db.query(SourceFile).filter(SourceFile.hash == self.HASHES["three"]).one()
        source.header_meta = {
            canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                working_potential_available=True,
                counter_potential_available=True,
                voltage_role="working_vs_reference",
                reference_electrode="Ag/AgCl",
            )
        }
        self.db.commit()

        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        result = engine.compute_time_capacity(self.db, spec, None)

        self.assertEqual(
            result["voltage_channels"]["voltage"]["label"],
            "Working potential vs Ag/AgCl (V)",
        )
        self.assertEqual(
            result["voltage_channels"]["voltage"]["role"],
            "working_vs_reference",
        )

    def test_conflicting_primary_roles_are_neutral_not_relabelled_as_cell(self):
        three = self.db.query(SourceFile).filter(SourceFile.hash == self.HASHES["three"]).one()
        two = self.db.query(SourceFile).filter(SourceFile.hash == self.HASHES["two"]).one()
        three.header_meta = {
            canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                voltage_role="cell"
            )
        }
        two.header_meta = {
            canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                voltage_role="working_vs_reference"
            )
        }
        self.db.commit()

        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["three"].id},
                {"kind": "cell", "ref_id": self.cells["two"].id},
            ]
        )
        result = engine.compute_time_capacity(self.db, spec, None)

        self.assertEqual(
            result["voltage_channels"]["voltage"]["role"],
            canonical_cycling.MIXED_VOLTAGE_ROLE,
        )
        self.assertEqual(
            result["voltage_channels"]["voltage"]["label"],
            "Voltage role ambiguous (V)",
        )

    def test_conflicting_source_references_fall_back_to_generic_label_context(self):
        first = SimpleNamespace(
            hash="first",
            header_meta={
                canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                    working_potential_available=True,
                    reference_electrode="Ag/AgCl",
                )
            },
        )
        second = SimpleNamespace(
            hash="second",
            header_meta={
                canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                    working_potential_available=True,
                    reference_electrode="Hg/HgO",
                )
            },
        )
        raw = pd.DataFrame(
            {
                "working_potential_v": [1.0, 2.0],
                "source_hash": ["first", "second"],
            }
        )

        roles, references = engine._time_capacity_voltage_context(raw, [first, second])

        self.assertEqual(roles["working_potential"], "working_vs_reference")
        self.assertIsNone(references["working_potential"])

    def test_missing_role_mixed_with_explicit_role_is_neutral(self):
        missing = SimpleNamespace(
            hash="missing-role",
            header_meta={
                canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: {
                    "capabilities": {"primary_voltage": True},
                    "voltage_roles": {},
                }
            },
        )
        explicit = SimpleNamespace(
            hash="explicit-role",
            header_meta={
                canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                    voltage_role="working_vs_reference"
                )
            },
        )
        raw = pd.DataFrame(
            {
                "voltage_v": [3.0, 3.1],
                "source_hash": ["missing-role", "explicit-role"],
            }
        )

        roles, _references = engine._time_capacity_voltage_context(raw, [missing, explicit])

        self.assertEqual(roles["voltage"], canonical_cycling.MIXED_VOLTAGE_ROLE)

    def test_three_electrode_without_reference_keeps_generic_labels(self):
        source = self.db.query(SourceFile).filter(SourceFile.hash == self.HASHES["three"]).one()
        source.header_meta = {
            canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: canonical_cycling.voltage_capabilities(
                working_potential_available=True,
                counter_potential_available=True,
                reference_electrode=None,
            )
        }
        self.db.commit()

        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        result = engine.compute_time_capacity(self.db, spec, None)

        self.assertEqual(
            result["voltage_channels"]["working_potential"]["label"],
            "Working potential vs ref (V)",
        )
        self.assertNotIn(
            "reference_electrode", result["voltage_channels"]["working_potential"]
        )

    def test_counter_potential_request_returns_correct_values(self):
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        spec["computation"]["time_capacity"] = {"voltage_channel": "counter_potential"}

        res = engine.compute_time_capacity(self.db, spec, None)

        trace = res["cell_traces"][0]
        values = [value for value in trace["voltage_v"] if value is not None]
        self.assertGreater(len(values), 0)
        for value in values:
            self.assertAlmostEqual(value, 0.1, places=6)
        self.assertTrue(res["voltage_channels"]["counter_potential"]["available"])

    def test_primary_voltage_request_is_unaffected_by_aux_columns(self):
        # voltage_v on the three-electrode fixture is working - counter
        # (3.2 or 3.6), distinct from either electrode potential alone —
        # proving the default channel is not silently substituted.
        spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])

        res = engine.compute_time_capacity(self.db, spec, None)

        trace = res["cell_traces"][0]
        values = [value for value in trace["voltage_v"] if value is not None]
        self.assertGreater(len(values), 0)
        for value in values:
            self.assertIn(round(value, 1), (3.2, 3.6))
        self.assertEqual(res["settings"]["voltage_channel"], "voltage")

    def test_mixed_selection_omits_per_cell_rather_than_disabling_whole_quantity(self):
        """The locked mixed-sample availability rule (Spec 040.4): when one
        selected sample has the requested channel and another does not, the
        sample without it gets an omitted (all-None) trace — exactly how
        this architecture already treats any other missing-column case —
        rather than the whole quantity being marked unavailable for the
        entire selection."""
        spec = self.spec_with(
            [
                {"kind": "cell", "ref_id": self.cells["three"].id},
                {"kind": "cell", "ref_id": self.cells["two"].id},
            ]
        )
        spec["computation"]["time_capacity"] = {"voltage_channel": "working_potential"}

        res = engine.compute_time_capacity(self.db, spec, None)

        by_cell = {trace["cell_id"]: trace for trace in res["cell_traces"]}
        three_trace = by_cell[self.cells["three"].id]
        two_trace = by_cell[self.cells["two"].id]
        self.assertTrue(any(value is not None for value in three_trace["voltage_v"]))
        self.assertTrue(len(two_trace["voltage_v"]) > 0)
        self.assertTrue(all(value is None for value in two_trace["voltage_v"]))
        # Available at the selection level (at least one sample has data) —
        # the frontend selector may still offer the option.
        self.assertTrue(res["voltage_channels"]["working_potential"]["available"])

    def test_derivative_view_stays_restricted_to_primary_voltage(self):
        """`_derivative_curve` reads `voltage_v` directly regardless of the
        selected voltage_channel — dQ/dV and dV/dQ are scoped to primary
        voltage only for this child (locked decision), proven by showing the
        derivative trace is identical whether voltage_channel is left at its
        default or pointed at an electrode potential."""
        base_spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        base_spec["computation"]["time_capacity"] = {
            "view": "dvdq",
            "voltage_channel": "voltage",
            "cycles": [1],
        }
        aux_spec = self.spec_with([{"kind": "cell", "ref_id": self.cells["three"].id}])
        aux_spec["computation"]["time_capacity"] = {
            "view": "dvdq",
            "voltage_channel": "working_potential",
            "cycles": [1],
        }

        base_res = engine.compute_time_capacity(self.db, base_spec, None)
        aux_res = engine.compute_time_capacity(self.db, aux_spec, None)

        self.assertEqual(
            base_res["cell_traces"][0]["derivative_y"],
            aux_res["cell_traces"][0]["derivative_y"],
        )


if __name__ == "__main__":
    unittest.main()
