import os
import shutil
import sys
import tempfile
import unittest
import json
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Analysis, Cell, Folder, FolderCell, SourceFile, Test, TestFile
from app.routers.analyses import _portable_local_path
from app.services import analysis_engine, cache, calc, parsing, portable_analysis


def raw_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "record_index": 1,
                "cycle": 1,
                "step": 1,
                "step_index": 1,
                "status": "CC_Chg",
                "time_s": 10.0,
                "voltage_v": 3.5,
                "current_ma": 1.0,
                "charge_capacity_mah": 1.0,
                "discharge_capacity_mah": 0.0,
                "charge_energy_mwh": 3.5,
                "discharge_energy_mwh": 0.0,
                "timestamp": pd.Timestamp("2026-01-01T00:00:10"),
            },
            {
                "record_index": 2,
                "cycle": 1,
                "step": 2,
                "step_index": 2,
                "status": "CC_DChg",
                "time_s": 20.0,
                "voltage_v": 3.2,
                "current_ma": -1.0,
                "charge_capacity_mah": 1.0,
                "discharge_capacity_mah": 0.95,
                "charge_energy_mwh": 3.5,
                "discharge_energy_mwh": 3.04,
                "timestamp": pd.Timestamp("2026-01-01T00:00:20"),
            },
        ]
    )


class PortableAnalysisTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.original_cache_dir = cache.CACHE_DIR
        self.original_import_dir = portable_analysis.IMPORT_DIR
        cache.CACHE_DIR = self.root / "cache"
        portable_analysis.IMPORT_DIR = self.root / "imports"

    def tearDown(self):
        cache.CACHE_DIR = self.original_cache_dir
        portable_analysis.IMPORT_DIR = self.original_import_dir
        self.temporary.cleanup()

    def create_export(
        self,
        include_original_files: bool = False,
        *,
        include_saved_plots: bool = False,
    ):
        db, analysis, _, _, source_hash = self.create_analysis(
            include_saved_plots=include_saved_plots
        )
        destination = self.root / "portable.html"
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=include_original_files,
        )
        return destination, source_hash

    def create_analysis(self, *, include_saved_plots: bool = False):
        db = self.make_session()
        source_path = self.root / "cell.ndax"
        source_path.write_bytes(b"portable-neware-source")
        source_hash = portable_analysis._sha256_file(source_path)
        raw = raw_frame()
        cache.raw_path(source_hash).parent.mkdir(parents=True, exist_ok=True)
        cache._write_atomic(raw, cache.raw_path(source_hash))
        cache._write_atomic(calc.per_cycle(raw), cache.cycles_path(source_hash))

        cell = Cell(name="Portable cell", description="Round-trip test")
        db.add(cell)
        db.flush()
        source = SourceFile(
            hash=source_hash,
            path=str(source_path),
            filename=source_path.name,
            size=source_path.stat().st_size,
            ext="ndax",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            row_count=len(raw),
            cycle_count=1,
            capacity_summary_status="ready",
        )
        test = Test(cell_id=cell.id, name="Cycling")
        db.add_all([source, test])
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        spec = analysis_engine.default_spec("Portable study")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        if include_saved_plots:
            cycle_plot = {
                "id": "saved-cycle",
                "tab": "cycles",
                "name": "Saved cycle view",
                "subtitle": "Discharge capacity vs cycle",
                "description": None,
                "selection": {
                    "entries": [],
                    "exclusions": [],
                    "hidden_replicate_group_ids": [],
                },
                "computation": deepcopy(spec["computation"]),
                "aggregation": deepcopy(spec["aggregation"]),
                "presentation": deepcopy(spec["presentation"]),
            }
            time_plot = deepcopy(cycle_plot)
            time_plot.update(
                {
                    "id": "saved-time",
                    "tab": "time_capacity",
                    "name": "Saved time view",
                    "subtitle": "Voltage vs time",
                }
            )
            spec["saved_plots"] = [cycle_plot, time_plot]
        analysis = Analysis(title="Portable study", spec=spec)
        db.add(analysis)
        db.commit()
        return db, analysis, source, source_path, source_hash

    def read_report(self, destination: Path) -> dict:
        bounds = portable_analysis._index_script_bounds(destination)
        manifest = portable_analysis.read_manifest(destination, bounds)
        descriptor = next(
            payload for payload in manifest["payloads"] if payload["id"] == "report"
        )
        report_path = self.root / "decoded-report.json"
        portable_analysis._decode_payload(destination, descriptor, report_path, bounds)
        return json.loads(report_path.read_text(encoding="utf-8"))

    def fake_cache_build(self, source_hash, source_path):
        raw = raw_frame()
        cycles = calc.per_cycle(raw)
        cache.raw_path(source_hash).parent.mkdir(parents=True, exist_ok=True)
        cache._write_atomic(raw, cache.raw_path(source_hash))
        cache._write_atomic(cycles, cache.cycles_path(source_hash))
        return {
            "rows": len(raw),
            "cycles": len(cycles),
            "parser_version": parsing.PARSER_VERSION,
            "calc_version": portable_analysis.CALC_VERSION,
            "total_charge_capacity_mah": 1.0,
            "total_discharge_capacity_mah": 0.95,
        }

    def test_source_preflight_detects_changed_and_unavailable_originals(self):
        db, analysis, source, source_path, _ = self.create_analysis()

        current = portable_analysis.preflight_original_sources(db, analysis)
        self.assertTrue(current["ready"])
        self.assertEqual(current["current"], 1)

        source_path.write_bytes(b"changed-portable-neware-source")
        changed = portable_analysis.preflight_original_sources(db, analysis)
        self.assertFalse(changed["ready"])
        self.assertEqual(changed["changed"], 1)
        self.assertEqual(changed["sources"][0]["source_id"], source.id)
        self.assertEqual(changed["affected_analysis_ids"], [analysis.id])

        source_path.unlink()
        unavailable = portable_analysis.preflight_original_sources(db, analysis)
        self.assertFalse(unavailable["ready"])
        self.assertEqual(unavailable["unavailable"], 1)

    def test_source_update_adopts_stable_bytes_and_makes_preflight_ready(self):
        db, analysis, source, source_path, original_hash = self.create_analysis()
        source_path.write_bytes(b"updated-portable-neware-source")
        preflight = portable_analysis.preflight_original_sources(db, analysis)
        item = preflight["sources"][0]

        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            result = portable_analysis.update_original_sources(
                db,
                analysis,
                [
                    {
                        "source_id": source.id,
                        "expected_size": item["expected_size"],
                        "expected_mtime_ns": item["expected_mtime_ns"],
                    }
                ],
            )

        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["preflight"]["ready"])
        self.assertNotEqual(source.hash, original_hash)
        self.assertEqual(source.hash, portable_analysis._sha256_file(source_path))

    def test_strict_export_refuses_to_silently_omit_changed_original(self):
        db, analysis, _, source_path, _ = self.create_analysis()
        source_path.write_bytes(b"changed-before-final-packaging")
        destination = self.root / "strict-portable.html"

        with self.assertRaises(portable_analysis.PortableOriginalSourceError):
            portable_analysis.export_analysis_html(
                db,
                analysis,
                destination,
                include_original_files=True,
                strict_original_files=True,
            )

        self.assertFalse(destination.exists())

    def test_linked_round_trip_reuses_recorded_path_and_rebuilds_caches(self):
        destination, source_hash = self.create_export(include_original_files=False)
        manifest = portable_analysis.read_manifest(destination)
        self.assertEqual(manifest["format"], portable_analysis.FORMAT_ID)
        self.assertFalse(manifest["includes_original_files"])
        kinds = {payload["kind"] for payload in manifest["payloads"]}
        self.assertIn("plotly_runtime", kinds)
        self.assertNotIn("raw_cache", kinds)
        self.assertNotIn("cycle_cache", kinds)
        html = destination.read_bytes()
        self.assertIn(b"CellXplorer portable analysis", html)
        self.assertIn(b"cellxplorer://import-analysis", html)
        self.assertIn(b"Open in CellXplorer", html)
        self.assertIn(b'id="open-cellxplorer"', html)
        self.assertIn(b'encodeURIComponent(window.location.href)', html)
        self.assertIn(b'id="report-cover"', html)
        self.assertIn(b'rel="icon"', html)
        self.assertIn(b"window.Plotly.newPlot", html)
        self.assertIn(b"Standard precision", html)
        self.assertNotIn(b"row.map(quote)", html)
        self.assertIn(b"function figureRows(view)", html)
        self.assertIn(b"function renderFrozenSvg(chart, rawSvg)", html)
        self.assertIn(b"Interactive Plotly controls are unavailable", html)

        shutil.rmtree(cache.CACHE_DIR)
        imported_db = self.make_session()
        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            imported, warnings = portable_analysis.import_analysis_html(
                imported_db,
                destination,
            )

        imported_cell = imported_db.query(Cell).one()
        imported_source = imported_db.query(SourceFile).one()
        self.assertEqual(imported.title, "Portable study")
        self.assertEqual(imported_cell.name, "Portable cell")
        self.assertEqual(imported_source.location_status, "online")
        self.assertTrue(cache.raw_path(source_hash).exists())
        self.assertTrue(cache.cycles_path(source_hash).exists())
        self.assertFalse(any("offline" in warning.lower() for warning in warnings))
        result = analysis_engine.compute(imported_db, imported.spec, imported.provenance)
        self.assertEqual(result["cell_series"][0]["x"], [1])

    def test_export_uses_beta_deep_link_scheme_when_channel_is_beta(self):
        db, analysis, _, _, _ = self.create_analysis()
        destination = self.root / "beta-portable.html"
        with patch.dict(os.environ, {"CELLXPLORER_CHANNEL": "beta"}, clear=False):
            portable_analysis.export_analysis_html(
                db,
                analysis,
                destination,
                include_original_files=False,
            )
        html = destination.read_bytes()
        self.assertIn(b"cellxplorer-beta://import-analysis", html)
        self.assertNotIn(b"cellxplorer://import-analysis", html)

    def test_packaged_invalid_channel_fails_for_portable_deep_link(self):
        with patch.dict(
            os.environ,
            {"CELLXPLORER_STARTUP_MODE": "manual", "CELLXPLORER_CHANNEL": "preview"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "Unsupported CELLXPLORER_CHANNEL"):
                portable_analysis._deep_link_import_base()

    def test_desktop_deep_link_accepts_only_existing_local_html(self):
        destination, _ = self.create_export(include_original_files=False)
        self.assertEqual(_portable_local_path(destination.as_uri()), destination.resolve())
        self.assertEqual(_portable_local_path(str(destination)), destination.resolve())

        token = portable_analysis.stage_import(destination, preserve_source=True)
        self.assertTrue(destination.is_file())
        self.assertTrue(portable_analysis.pending_import_path(token).is_file())
        portable_analysis.discard_pending_import(token)

        with self.assertRaises(HTTPException) as remote_error:
            _portable_local_path("https://example.com/report.html")
        self.assertEqual(remote_error.exception.status_code, 400)

        with self.assertRaises(HTTPException) as missing_error:
            _portable_local_path((self.root / "missing.html").as_uri())
        self.assertEqual(missing_error.exception.status_code, 404)

    def test_round_trip_with_original_extracts_online_source(self):
        destination, source_hash = self.create_export(include_original_files=True)
        manifest = portable_analysis.read_manifest(destination)
        self.assertTrue(manifest["includes_original_files"])
        html = destination.read_bytes()
        self.assertIn(b"Download source files", html)
        self.assertIn(b"Download all as ZIP", html)
        self.assertIn(b"-sources.zip", html)

        shutil.rmtree(cache.CACHE_DIR)
        imported_db = self.make_session()
        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            imported, warnings = portable_analysis.import_analysis_html(
                imported_db,
                destination,
            )

        imported_source = imported_db.query(SourceFile).one()
        self.assertEqual(imported_source.location_status, "online")
        self.assertTrue(Path(imported_source.path).is_file())
        self.assertEqual(portable_analysis._sha256_file(Path(imported_source.path)), source_hash)
        self.assertFalse(any("Original Neware files were not included" in item for item in warnings))

    def test_linked_import_marks_missing_source_offline(self):
        destination, source_hash = self.create_export(include_original_files=False)
        (self.root / "cell.ndax").unlink()
        shutil.rmtree(cache.CACHE_DIR)

        imported_db = self.make_session()
        _, warnings = portable_analysis.import_analysis_html(imported_db, destination)

        imported_source = imported_db.query(SourceFile).one()
        self.assertEqual(imported_source.location_status, "offline")
        self.assertFalse(cache.raw_path(source_hash).exists())
        self.assertTrue(any("relink" in warning.lower() for warning in warnings))

    def test_import_rejects_tampered_payload(self):
        destination, _ = self.create_export(include_original_files=False)
        data = destination.read_bytes()
        marker = b'id="cellxplorer-payload-report" type="application/octet-stream">'
        start = data.index(marker) + len(marker)
        replacement = b"A" if data[start : start + 1] != b"A" else b"B"
        destination.write_bytes(data[:start] + replacement + data[start + 1 :])

        with self.assertRaises(HTTPException) as error:
            portable_analysis.import_analysis_html(self.make_session(), destination)
        self.assertEqual(error.exception.status_code, 400)

    def test_saved_plots_reuse_analysis_samples_in_portable_report(self):
        destination, _ = self.create_export(include_saved_plots=True)
        report = self.read_report(destination)

        self.assertEqual(len(report["views"]), 2)
        cycle_view, time_view = report["views"]
        self.assertEqual(cycle_view["result"]["cell_series"][0]["label"], "Portable cell")
        self.assertEqual(cycle_view["result"]["cell_series"][0]["x"], [1])
        self.assertEqual(time_view["result"]["cell_traces"][0]["label"], "Portable cell")
        self.assertGreater(len(time_view["result"]["cell_traces"][0]["time_s"]), 0)

    def test_draft_plot_is_not_exported(self):
        db, analysis, *_ = self.create_analysis(include_saved_plots=True)
        spec = deepcopy(analysis.spec)
        draft = {
            "tab": "cycles",
            "name": "Secret draft",
            "selection": deepcopy(spec["selection"]),
            "computation": deepcopy(spec["computation"]),
            "aggregation": deepcopy(spec["aggregation"]),
            "presentation": deepcopy(spec["presentation"]),
            "updated_at": "2026-07-25T00:00:00+00:00",
        }
        spec["draft_plot"] = draft
        spec["draft_plots"] = {"cycles": draft, "steps": {**draft, "tab": "steps", "name": "Steps draft"}}
        analysis.spec = spec
        db.commit()

        destination = self.root / "draft-export.html"
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=False,
        )
        report = self.read_report(destination)
        self.assertNotIn("draft_plot", report["analysis"]["spec"])
        self.assertNotIn("draft_plots", report["analysis"]["spec"])
        self.assertEqual(len(report["views"]), 2)
        self.assertTrue(
            all(view.get("name") != "Secret draft" for view in report["views"])
        )

    def test_inspection_reports_exact_match_and_import_reuses_library_cell(self):
        destination, source_hash = self.create_export(include_original_files=True)
        db = self.make_session()
        cell = Cell(name="Existing library cell")
        source = SourceFile(
            hash=source_hash,
            path=str(self.root / "cell.ndax"),
            filename="cell.ndax",
            size=(self.root / "cell.ndax").stat().st_size,
            ext="ndax",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            row_count=2,
            cycle_count=1,
        )
        test = Test(cell=cell, name="Existing test")
        folder = Folder(name="Imported work")
        db.add_all([cell, source, test, folder])
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.commit()

        review = portable_analysis.inspect_analysis_html(db, destination)
        self.assertEqual(review["analysis_title"], "Portable study")
        self.assertEqual(review["cells"][0]["status"], "reuse")
        self.assertEqual(review["sources"][0]["status"], "exact")
        self.assertIn("discarded", review["sources"][0]["message"])

        imported, _ = portable_analysis.import_analysis_html(
            db,
            destination,
            folder_id=folder.id,
            title="Reviewed portable study",
            add_cells_to_folder=True,
        )
        self.assertEqual(db.query(Cell).count(), 1)
        self.assertEqual(db.query(SourceFile).count(), 1)
        self.assertEqual(imported.spec["selection"]["entries"][0]["ref_id"], cell.id)
        self.assertEqual(
            db.query(FolderCell)
            .filter(FolderCell.folder_id == folder.id, FolderCell.cell_id == cell.id)
            .count(),
            1,
        )

    def test_possible_update_requires_explicit_choice_and_can_use_library_cell(self):
        destination, _ = self.create_export(include_original_files=True)
        db = self.make_session()
        newer_path = self.root / "newer" / "cell.ndax"
        newer_path.parent.mkdir()
        newer_path.write_bytes(b"newer-library-source-with-more-cycles")
        newer_hash = portable_analysis._sha256_file(newer_path)
        cell = Cell(name="Newer library cell")
        source = SourceFile(
            hash=newer_hash,
            path=str(newer_path),
            filename="cell.ndax",
            size=newer_path.stat().st_size,
            ext="ndax",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            row_count=20,
            cycle_count=10,
        )
        test = Test(cell=cell, name="Cycling")
        db.add_all([cell, source, test])
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.commit()

        review = portable_analysis.inspect_analysis_html(db, destination)
        source_review = review["sources"][0]
        self.assertEqual(source_review["status"], "possible_update")
        self.assertEqual(source_review["suggested_action"], "use_library")
        self.assertEqual(source_review["candidates"][0]["comparison"], "library_newer")

        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            imported, _ = portable_analysis.import_analysis_html(
                db,
                destination,
                title="Use newer library data",
                source_resolutions={
                    source_review["source_id"]: {
                        "action": "use_library",
                        "library_source_file_id": source.id,
                    }
                },
            )
        self.assertEqual(db.query(Cell).count(), 1)
        self.assertEqual(db.query(SourceFile).count(), 1)
        self.assertEqual(imported.spec["selection"]["entries"][0]["ref_id"], cell.id)


if __name__ == "__main__":
    unittest.main()
