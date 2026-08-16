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
from app.models import (
    Analysis,
    Cell,
    CellMetadata,
    Folder,
    FolderCell,
    ReplicateGroup,
    ReplicateGroupCell,
    SourceFile,
    Test,
    TestFile,
)
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
        views = (
            portable_analysis._report_views(db, analysis)
            if include_saved_plots
            else None
        )
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=include_original_files,
            views=views,
        )
        return destination, source_hash

    def create_analysis(self, *, include_saved_plots: bool = False):
        db = self.make_session()
        source_path = self.root / "cell.ndax"
        source_path.write_bytes(b"portable-neware-source")
        source_hash = portable_analysis._sha256_file(source_path)
        # Spec 040.3: caches are keyed by this source's own effective parser
        # identity (extension-only recognition for binary Neware, so no real
        # file content is needed), not the transitional global bundle.
        identity = parsing.parser_identity(source_path)
        raw = raw_frame()
        cache.raw_path(source_hash, identity).parent.mkdir(parents=True, exist_ok=True)
        cache._write_atomic(raw, cache.raw_path(source_hash, identity))
        cache._write_atomic(calc.per_cycle(raw), cache.cycles_path(source_hash, identity))

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
            parser_version=identity,
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

    def rewrite_report(self, source_html: Path, report: dict, destination: Path) -> None:
        bounds = portable_analysis._index_script_bounds(source_html)
        manifest = portable_analysis.read_manifest(source_html, bounds)
        with tempfile.TemporaryDirectory(prefix="portable-rewrite-") as temporary:
            temp_dir = Path(temporary)
            payload_paths: dict[str, Path] = {}
            payloads: list[dict] = []
            for descriptor in manifest["payloads"]:
                if descriptor["id"] == "report":
                    rewritten, path = portable_analysis._prepare_payload(
                        temp_dir,
                        payload_id="report",
                        kind="report",
                        content_type="application/json",
                        data=portable_analysis._json_bytes(report),
                    )
                    descriptor = rewritten
                else:
                    path = temp_dir / descriptor["id"]
                    portable_analysis._decode_payload(source_html, descriptor, path, bounds)
                payloads.append(descriptor)
                payload_paths[descriptor["id"]] = path
            manifest["payloads"] = payloads
            portable_analysis._write_html(destination, manifest, payload_paths)

    def fake_cache_build(self, source_hash, source_path, **_kwargs):
        # Spec 040.3: mirror what the real `cache.build` does — write/report
        # at THIS source's own effective parser identity, not the
        # transitional global bundle. Using the real path's extension keeps
        # this fake consistent with whatever `analysis_engine.compute()`
        # (unmocked at export time) already pinned into provenance.
        identity = parsing.parser_identity(source_path)
        raw = raw_frame()
        cycles = calc.per_cycle(raw)
        cache.raw_path(source_hash, identity).parent.mkdir(parents=True, exist_ok=True)
        cache._write_atomic(raw, cache.raw_path(source_hash, identity))
        cache._write_atomic(cycles, cache.cycles_path(source_hash, identity))
        return {
            "rows": len(raw),
            "cycles": len(cycles),
            "parser_version": identity,
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
        self.assertTrue(cache.raw_path(source_hash, imported_source.parser_version).exists())
        self.assertTrue(cache.cycles_path(source_hash, imported_source.parser_version).exists())
        self.assertFalse(any("offline" in warning.lower() for warning in warnings))
        result = analysis_engine.compute(imported_db, imported.spec, imported.provenance)
        self.assertEqual(result["cell_series"][0]["x"], [1])

    def _rewrite_as_metadata_only_mpr(self, source_html: Path, destination: Path) -> str:
        report = self.read_report(source_html)
        source = report["sources"][0]
        source_hash = source["hash"]
        source.update(
            {
                "filename": "metadata-only.mpr",
                "ext": "mpr",
                "header_meta": {
                    "capabilities": {"canonical_cycling": False},
                    "protocol_warnings": [
                        "Canonical cycling rows are unavailable until the cycle identity is verified."
                    ],
                },
                "parse_status": "metadata_only",
                "metadata_only": True,
                "canonical_cycling": False,
                "capability_warning": (
                    "Canonical cycling rows are unavailable until the cycle identity is verified."
                ),
                "row_count": 99,
                "cycle_count": 7,
                "capacity_summary_status": "ready",
            }
        )
        self.rewrite_report(source_html, report, destination)
        return source_hash

    def test_portable_import_preserves_metadata_only_source_and_skips_available_original_build(self):
        # The recorded original path is available to the importing process;
        # this exercises the same no-rebuild boundary without requiring the
        # test helper to rewrite a compressed original-source payload.
        destination, _ = self.create_export(include_original_files=False)
        rewritten = self.root / "metadata-only-original-portable.html"
        source_hash = self._rewrite_as_metadata_only_mpr(destination, rewritten)
        imported_db = self.make_session()

        with patch.object(portable_analysis.cache, "build", side_effect=AssertionError("metadata-only source was parsed")):
            imported, warnings = portable_analysis.import_analysis_html(imported_db, rewritten)

        source = imported_db.query(SourceFile).one()
        self.assertEqual(source.ext, "mpr")
        self.assertEqual(source.parse_status, "metadata_only")
        self.assertEqual(source.parser_version, parsing.current_parser_identity_for_extension("mpr"))
        self.assertIsNone(source.row_count)
        self.assertIsNone(source.cycle_count)
        self.assertEqual(source.capacity_summary_status, "unavailable")
        self.assertFalse(cache.raw_path(source_hash, source.parser_version).exists())
        self.assertFalse(
            cache.cycles_path(source_hash, source.parser_version, cache.CALC_VERSION).exists()
        )
        self.assertFalse(any("metadata-only source was parsed" in warning for warning in warnings))
        self.assertEqual(imported_db.query(Cell).count(), 1)
        self.assertIsNotNone(imported)

    def test_portable_import_ignores_embedded_metadata_only_cache_descriptors(self):
        destination, _ = self.create_export(include_original_files=False)
        rewritten = self.root / "metadata-only-embedded-cache-portable.html"
        source_hash = self._rewrite_as_metadata_only_mpr(destination, rewritten)
        original_payload_by_kind = portable_analysis._payload_by_kind

        def fake_payload_by_kind(manifest, kind):
            if kind == "raw_cache":
                return [{
                    "id": "stale-raw-cache",
                    "kind": "raw_cache",
                    "source_id": f"source-{source_hash}",
                    "parser_version": parsing.current_parser_identity_for_extension("mpr"),
                }]
            if kind == "cycle_cache":
                return [{
                    "id": "stale-cycle-cache",
                    "kind": "cycle_cache",
                    "source_id": f"source-{source_hash}",
                    "parser_version": parsing.current_parser_identity_for_extension("mpr"),
                    "calc_version": cache.CALC_VERSION,
                }]
            return original_payload_by_kind(manifest, kind)

        imported_db = self.make_session()
        with patch.object(portable_analysis, "_payload_by_kind", side_effect=fake_payload_by_kind), \
            patch.object(portable_analysis, "_decode_payload", wraps=portable_analysis._decode_payload) as decode_payload, \
            patch.object(portable_analysis.cache, "build", side_effect=AssertionError("metadata-only source was parsed")):
            portable_analysis.import_analysis_html(imported_db, rewritten)

        source = imported_db.query(SourceFile).one()
        self.assertEqual(source.parse_status, "metadata_only")
        self.assertFalse(
            any(
                call.args[1].get("id") in {"stale-raw-cache", "stale-cycle-cache"}
                for call in decode_payload.call_args_list
            )
        )
        self.assertFalse(cache.raw_path(source_hash, source.parser_version).exists())
        self.assertFalse(
            cache.cycles_path(source_hash, source.parser_version, cache.CALC_VERSION).exists()
        )

    def test_portable_report_cannot_downgrade_an_existing_canonical_source(self):
        destination, source_hash = self.create_export(include_original_files=False)
        rewritten = self.root / "metadata-only-for-canonical-existing.html"
        self._rewrite_as_metadata_only_mpr(destination, rewritten)

        existing_db = self.make_session()
        source_path = self.root / "cell.ndax"
        identity = parsing.current_parser_identity_for_extension("ndax")
        existing_db.add(
            SourceFile(
                hash=source_hash,
                path=str(source_path),
                filename=source_path.name,
                size=source_path.stat().st_size,
                ext="ndax",
                parse_status="parsed",
                parser_version=identity,
                row_count=2,
                cycle_count=1,
                capacity_summary_status="ready",
                total_charge_capacity_mah=1.0,
                total_discharge_capacity_mah=0.95,
            )
        )
        existing_db.commit()

        raw_path = cache.raw_path(source_hash, identity)
        cycle_path = cache.cycles_path(source_hash, identity, cache.CALC_VERSION)
        raw_before = raw_path.read_bytes()
        cycle_before = cycle_path.read_bytes()
        original_payload_by_kind = portable_analysis._payload_by_kind

        def fake_payload_by_kind(manifest, kind):
            if kind == "raw_cache":
                return [{
                    "id": "legacy-raw-cache",
                    "kind": "raw_cache",
                    "source_id": f"source-{source_hash}",
                    "parser_version": identity,
                }]
            if kind == "cycle_cache":
                return [{
                    "id": "legacy-cycle-cache",
                    "kind": "cycle_cache",
                    "source_id": f"source-{source_hash}",
                    "parser_version": identity,
                    "calc_version": cache.CALC_VERSION,
                }]
            return original_payload_by_kind(manifest, kind)

        with patch.object(portable_analysis, "_payload_by_kind", side_effect=fake_payload_by_kind), \
            patch.object(portable_analysis, "_decode_payload", wraps=portable_analysis._decode_payload) as decode_payload, \
            patch.object(portable_analysis.cache, "build", side_effect=AssertionError("existing canonical source was rebuilt")):
            portable_analysis.import_analysis_html(existing_db, rewritten)

        source = existing_db.query(SourceFile).one()
        self.assertEqual(source.hash, source_hash)
        self.assertEqual(source.filename, "cell.ndax")
        self.assertEqual(source.ext, "ndax")
        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(source.parser_version, identity)
        self.assertEqual(source.row_count, 2)
        self.assertEqual(source.cycle_count, 1)
        self.assertEqual(source.capacity_summary_status, "ready")
        self.assertFalse(
            any(
                call.args[1].get("id") in {"legacy-raw-cache", "legacy-cycle-cache"}
                for call in decode_payload.call_args_list
            )
        )
        self.assertEqual(raw_path.read_bytes(), raw_before)
        self.assertEqual(cycle_path.read_bytes(), cycle_before)

    def test_portable_report_cannot_upgrade_an_existing_metadata_only_source(self):
        destination, source_hash = self.create_export(include_original_files=False)
        existing_db = self.make_session()
        source_path = self.root / "cell.ndax"
        identity = parsing.current_parser_identity_for_extension("mpr")
        existing_db.add(
            SourceFile(
                hash=source_hash,
                path=str(source_path),
                filename="existing.mpr",
                size=source_path.stat().st_size,
                ext="mpr",
                header_meta={
                    "capabilities": {"canonical_cycling": False},
                    "protocol_warnings": ["Canonical cycling rows are unavailable."],
                },
                parse_status="metadata_only",
                parse_error="Canonical cycling rows are unavailable.",
                parser_version=identity,
                row_count=None,
                cycle_count=None,
                capacity_summary_status="unavailable",
            )
        )
        existing_db.commit()

        with patch.object(portable_analysis.cache, "build", side_effect=AssertionError("existing metadata-only source was parsed")):
            portable_analysis.import_analysis_html(existing_db, destination)

        source = existing_db.query(SourceFile).one()
        self.assertEqual(source.filename, "existing.mpr")
        self.assertEqual(source.ext, "mpr")
        self.assertEqual(source.parse_status, "metadata_only")
        self.assertEqual(source.parser_version, identity)
        self.assertIsNone(source.row_count)
        self.assertIsNone(source.cycle_count)
        self.assertEqual(source.capacity_summary_status, "unavailable")

    def test_portable_provenance_preserves_per_source_parser_identity_and_remaps_hash(self):
        """Case 20: exported provenance carries the new per-source
        `files[]` shape, and import remaps each entry's `hash` to the
        effective imported hash exactly like `file_hashes` — otherwise a
        reused-but-different-hash import would silently lose its pinned
        identity instead of carrying it forward."""
        db, analysis, cell_source, source_path, source_hash = self.create_analysis()
        spec = analysis.spec
        computed = analysis_engine.compute(db, spec, None)
        analysis.provenance = analysis_engine.build_provenance(computed)
        db.commit()

        pinned_identity = analysis.provenance["sources"][0]["files"][0]["parser_version"]
        self.assertEqual(analysis.provenance["sources"][0]["files"][0]["hash"], source_hash)

        destination = self.root / "provenance-portable.html"
        portable_analysis.export_analysis_html(
            db, analysis, destination, include_original_files=False
        )
        report = self.read_report(destination)
        exported_files = report["analysis"]["provenance"]["sources"][0]["files"]
        self.assertEqual(exported_files[0]["hash"], source_hash)
        self.assertEqual(exported_files[0]["parser_version"], pinned_identity)

        imported_db = self.make_session()
        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            imported, _ = portable_analysis.import_analysis_html(imported_db, destination)
        imported_source = imported_db.query(SourceFile).one()

        # Exact-hash reuse is the common case: the effective imported hash
        # equals the original, so the remap is a no-op here, but it proves
        # the pinned entry survives the round trip and stays consistent
        # with `file_hashes`.
        imported_files = imported.provenance["sources"][0]["files"]
        self.assertEqual(imported_files[0]["hash"], imported_source.hash)
        self.assertEqual(
            imported.provenance["sources"][0]["file_hashes"], [imported_source.hash]
        )

    def test_legacy_single_scalar_provenance_shape_is_still_importable(self):
        """Case 20: a portable package exported before Spec 040.3 carries a
        legacy provenance shape (one scalar `parser_version`, no per-source
        `files[]`). Import must accept it rather than requiring the new
        shape."""
        destination, source_hash = self.create_export(include_original_files=False)
        legacy_report = self.read_report(destination)
        legacy_report["analysis"]["provenance"] = {
            "computed_at": "2026-01-01T00:00:00+00:00",
            "parser_version": "v2026.06.11-cxp6",
            "calc_version": cache.CALC_VERSION,
            "sources": [
                {
                    "cell_id": legacy_report["analysis"]["provenance"]["sources"][0]["cell_id"]
                    if legacy_report["analysis"]["provenance"]
                    else 1,
                    "file_hashes": [source_hash],
                }
            ],
        }
        rewritten = self.root / "legacy-provenance-portable.html"
        self.rewrite_report(destination, legacy_report, rewritten)

        imported_db = self.make_session()
        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            imported, warnings = portable_analysis.import_analysis_html(imported_db, rewritten)

        self.assertEqual(imported.provenance["parser_version"], "v2026.06.11-cxp6")
        self.assertNotIn("files", imported.provenance["sources"][0])
        # legacy-shape provenance still resolves through
        # resolve_source_parser_versions' normalization path without raising
        result = analysis_engine.compute(imported_db, imported.spec, imported.provenance)
        self.assertIsInstance(result["cell_series"], list)

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
        self.assertFalse(any("original source files were not included" in item.lower() for item in warnings))

    def test_original_xlsx_source_is_embedded_with_normal_provenance(self):
        db, analysis, source, source_path, source_hash = self.create_analysis()
        xlsx_path = self.root / "cell.xlsx"
        source_path.rename(xlsx_path)
        source.path = str(xlsx_path)
        source.filename = xlsx_path.name
        source.ext = "xlsx"
        source.size = xlsx_path.stat().st_size
        db.commit()

        destination = self.root / "xlsx-portable.html"
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=True,
            strict_original_files=True,
        )
        manifest = portable_analysis.read_manifest(destination)
        report = self.read_report(destination)
        source_document = report["sources"][0]
        original_payloads = [
            payload
            for payload in manifest["payloads"]
            if payload["kind"] == "original_source"
        ]

        self.assertEqual(source_document["ext"], "xlsx")
        self.assertEqual(source_document["filename"], "cell.xlsx")
        self.assertEqual(source_document["hash"], source_hash)
        self.assertEqual(len(original_payloads), 1)
        self.assertEqual(original_payloads[0]["filename"], "cell.xlsx")

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

    def test_portable_export_rejects_snapshot_with_stale_scientific_identity(self):
        db, analysis, *_ = self.create_analysis(include_saved_plots=True)
        views = portable_analysis._report_views(db, analysis)
        views[0]["data_signature"] = "stale-source-identity"

        with self.assertRaises(HTTPException) as raised:
            portable_analysis.export_analysis_html(
                db,
                analysis,
                self.root / "stale-view.html",
                include_original_files=False,
                views=views,
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_plot_changed")

    def test_saved_plot_export_requires_browser_snapshots(self):
        db, analysis, *_ = self.create_analysis(include_saved_plots=True)

        with self.assertRaises(HTTPException) as raised:
            portable_analysis.export_analysis_html(
                db,
                analysis,
                self.root / "missing-snapshots.html",
                include_original_files=False,
                views=[],
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_snapshots_required")

    def test_saved_plot_export_rejects_forged_current_view_snapshot(self):
        db, analysis, *_ = self.create_analysis(include_saved_plots=True)
        views = [
            {
                "id": "current",
                "name": "Forged current view",
                "subtitle": "",
                "description": None,
                "tab": "cycles",
                "result": {},
                "data_signature": "forged",
                "plot_revision": None,
            }
        ]

        with self.assertRaises(HTTPException) as raised:
            portable_analysis.export_analysis_html(
                db,
                analysis,
                self.root / "forged-current.html",
                include_original_files=False,
                views=views,
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_snapshots_required")

    def test_portable_server_view_fallback_dispatches_each_plot_family(self):
        db, analysis, *_ = self.create_analysis()
        spec = deepcopy(analysis.spec)
        plots = []
        for index, tab in enumerate(
            ["cycles", "time_capacity", "steps", "dcir", "chargeability", "crate"]
        ):
            plots.append(
                {
                    "id": f"fallback-{index}",
                    "tab": tab,
                    "name": f"Fallback {tab}",
                    "subtitle": "",
                    "description": None,
                    "selection": deepcopy(spec["selection"]),
                    "computation": deepcopy(spec["computation"]),
                    "aggregation": deepcopy(spec["aggregation"]),
                    "presentation": deepcopy(spec["presentation"]),
                }
            )
        spec["saved_plots"] = plots
        analysis.spec = spec
        db.commit()

        with patch.object(
            analysis_engine, "compute", return_value={"family": "cycles"}
        ) as cycles, patch.object(
            analysis_engine, "compute_time_capacity", return_value={"family": "time_capacity"}
        ) as time_capacity, patch.object(
            analysis_engine, "compute_steps", return_value={"family": "steps"}
        ) as steps, patch.object(
            analysis_engine, "compute_dcir", return_value={"family": "dcir"}
        ) as dcir, patch.object(
            portable_analysis.chargeability,
            "compute",
            return_value={"family": "chargeability"},
        ) as chargeability_compute, patch.object(
            portable_analysis.rate_capability,
            "compute",
            return_value={"family": "crate"},
        ) as rate_compute:
            views = portable_analysis._report_views(db, analysis)

        self.assertEqual(
            [view["result"]["family"] for view in views],
            ["cycles", "time_capacity", "steps", "dcir", "chargeability", "crate"],
        )
        cycles.assert_called_once()
        time_capacity.assert_called_once()
        steps.assert_called_once()
        dcir.assert_called_once()
        chargeability_compute.assert_called_once()
        rate_compute.assert_called_once()

    def test_portable_export_rejects_snapshot_from_wrong_saved_plot_family(self):
        db, analysis, *_ = self.create_analysis(include_saved_plots=True)
        views = portable_analysis._report_views(db, analysis)
        views[0]["tab"] = "time_capacity"

        with self.assertRaises(HTTPException) as raised:
            portable_analysis.export_analysis_html(
                db,
                analysis,
                self.root / "wrong-family.html",
                include_original_files=False,
                views=views,
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_plot_changed")

    def test_portable_export_rechecks_state_after_separate_session_mutation(self):
        db, analysis, *_ = self.create_analysis()
        destination = self.root / "mutated-during-export.html"
        real_prepare = portable_analysis._prepare_payload
        calls = 0

        def prepare_and_mutate(*args, **kwargs):
            nonlocal calls
            calls += 1
            result = real_prepare(*args, **kwargs)
            if calls == 2:
                other = sessionmaker(
                    bind=db.get_bind(),
                    autoflush=False,
                    expire_on_commit=False,
                )()
                try:
                    other_analysis = other.get(Analysis, analysis.id)
                    changed_spec = deepcopy(other_analysis.spec)
                    changed_spec["selection"]["entries"] = []
                    other_analysis.spec = changed_spec
                    other_analysis.title = "Changed during export"
                    other.commit()
                finally:
                    other.close()
            return result

        with patch.object(
            portable_analysis, "_prepare_payload", side_effect=prepare_and_mutate
        ):
            with self.assertRaises(HTTPException) as raised:
                portable_analysis.export_analysis_html(
                    db,
                    analysis,
                    destination,
                    include_original_files=False,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_export_changed")
        self.assertFalse(destination.exists())

    def test_portable_export_rechecks_state_after_final_html_write_mutation(self):
        db, analysis, *_ = self.create_analysis()
        destination = self.root / "mutated-during-final-write.html"
        real_write = portable_analysis._write_html

        def write_and_mutate(path, manifest, payload_paths):
            changed_spec = deepcopy(analysis.spec)
            changed_spec["selection"]["entries"] = []
            analysis.spec = changed_spec
            db.flush()
            return real_write(path, manifest, payload_paths)

        with patch.object(portable_analysis, "_write_html", side_effect=write_and_mutate):
            with self.assertRaises(HTTPException) as raised:
                portable_analysis.export_analysis_html(
                    db,
                    analysis,
                    destination,
                    include_original_files=False,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_export_changed")
        self.assertFalse(destination.exists())

    def test_portable_export_generates_html_before_acquiring_writer_boundary(self):
        db, analysis, *_ = self.create_analysis()
        destination = self.root / "writer-order.html"
        events: list[str] = []
        writing = False
        real_write = portable_analysis._write_html
        real_begin = portable_analysis._begin_portable_publish_boundary

        def write_and_record(path, manifest, payload_paths):
            nonlocal writing
            events.append("write-start")
            writing = True
            try:
                return real_write(path, manifest, payload_paths)
            finally:
                writing = False
                events.append("write-end")

        def begin_and_record(session):
            self.assertFalse(writing)
            events.append("begin")
            return real_begin(session)

        with patch.object(
            portable_analysis, "_write_html", side_effect=write_and_record
        ), patch.object(
            portable_analysis,
            "_begin_portable_publish_boundary",
            side_effect=begin_and_record,
        ):
            portable_analysis.export_analysis_html(
                db,
                analysis,
                destination,
                include_original_files=False,
            )

        self.assertEqual(events, ["write-start", "write-end", "begin"])
        self.assertTrue(destination.exists())

    def test_portable_export_rejects_cell_description_and_metadata_mutation(self):
        db, analysis, *_ = self.create_analysis()
        cell_id = analysis.spec["selection"]["entries"][0]["ref_id"]
        destination = self.root / "mutated-cell.html"
        destination.write_text("sentinel", encoding="utf-8")
        real_write = portable_analysis._write_html

        def write_and_mutate(path, manifest, payload_paths):
            result = real_write(path, manifest, payload_paths)
            other = sessionmaker(
                bind=db.get_bind(),
                autoflush=False,
                expire_on_commit=False,
            )()
            try:
                other_cell = other.get(Cell, cell_id)
                other_cell.description = "Changed while exporting"
                other.add(CellMetadata(cell_id=cell_id, key="operator_note", value="changed"))
                other.commit()
            finally:
                other.close()
            return result

        with patch.object(portable_analysis, "_write_html", side_effect=write_and_mutate):
            with self.assertRaises(HTTPException) as raised:
                portable_analysis.export_analysis_html(
                    db,
                    analysis,
                    destination,
                    include_original_files=False,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_export_changed")
        self.assertEqual(destination.read_text(encoding="utf-8"), "sentinel")

    def test_portable_export_rejects_replicate_group_description_and_membership_mutation(self):
        db, analysis, *_ = self.create_analysis()
        cell_id = analysis.spec["selection"]["entries"][0]["ref_id"]
        second_cell = Cell(name="Unselected group member")
        db.add(second_cell)
        db.flush()
        db.add(Test(cell_id=second_cell.id, name="Empty test"))
        group = ReplicateGroup(name="Portable replicates", description="Initial group")
        db.add(group)
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell_id, position=0))
        spec = deepcopy(analysis.spec)
        spec["selection"]["entries"] = [{"kind": "replicate_group", "ref_id": group.id}]
        analysis.spec = spec
        db.commit()
        destination = self.root / "mutated-group.html"
        destination.write_text("sentinel", encoding="utf-8")
        real_write = portable_analysis._write_html

        def write_and_mutate(path, manifest, payload_paths):
            result = real_write(path, manifest, payload_paths)
            other = sessionmaker(
                bind=db.get_bind(),
                autoflush=False,
                expire_on_commit=False,
            )()
            try:
                other_group = other.get(ReplicateGroup, group.id)
                other_group.description = "Changed while exporting"
                other.add(
                    ReplicateGroupCell(
                        group_id=group.id,
                        cell_id=second_cell.id,
                        position=1,
                    )
                )
                other.commit()
            finally:
                other.close()
            return result

        with patch.object(portable_analysis, "_write_html", side_effect=write_and_mutate):
            with self.assertRaises(HTTPException) as raised:
                portable_analysis.export_analysis_html(
                    db,
                    analysis,
                    destination,
                    include_original_files=False,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "portable_export_changed")
        self.assertEqual(destination.read_text(encoding="utf-8"), "sentinel")

    def test_multi_source_portable_round_trip_preserves_cell_order_and_one_test(self):
        db = self.make_session()
        first_path = self.root / "first.ndax"
        second_path = self.root / "second.ndax"
        first_path.write_bytes(b"first-source")
        second_path.write_bytes(b"second-source")
        first_hash = portable_analysis._sha256_file(first_path)
        second_hash = portable_analysis._sha256_file(second_path)
        # Both sources are ".ndax", so they share one identity (extension-only
        # recognition for binary Neware; Spec 040.3).
        identity = parsing.parser_identity(first_path)
        for source_hash in (first_hash, second_hash):
            cache.raw_path(source_hash, identity).parent.mkdir(parents=True, exist_ok=True)
            cache._write_atomic(raw_frame(), cache.raw_path(source_hash, identity))
            cache._write_atomic(calc.per_cycle(raw_frame()), cache.cycles_path(source_hash, identity))

        cell = Cell(name="Continued portable cell")
        db.add(cell)
        db.flush()
        # Insert the later source first so database-ID order differs from the
        # scientific TestFile.position order.
        second = SourceFile(
            hash=second_hash,
            path=str(second_path),
            filename=second_path.name,
            size=second_path.stat().st_size,
            ext="ndax",
            parse_status="parsed",
            parser_version=identity,
            row_count=len(raw_frame()),
            cycle_count=1,
            capacity_summary_status="ready",
        )
        first = SourceFile(
            hash=first_hash,
            path=str(first_path),
            filename=first_path.name,
            size=first_path.stat().st_size,
            ext="ndax",
            parse_status="parsed",
            parser_version=identity,
            row_count=len(raw_frame()),
            cycle_count=1,
            capacity_summary_status="ready",
        )
        test = Test(cell_id=cell.id, name="Internal name must not be portable")
        db.add_all([second, first, test])
        db.flush()
        db.add_all(
            [
                TestFile(test_id=test.id, file_id=first.id, position=0),
                TestFile(test_id=test.id, file_id=second.id, position=1),
            ]
        )
        spec = analysis_engine.default_spec("Continued portable study")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        analysis = Analysis(title="Continued portable study", spec=spec)
        db.add(analysis)
        db.commit()

        destination = self.root / "continued-portable.html"
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=True,
        )
        report = self.read_report(destination)
        portable_cell = report["cells"][0]
        expected_source_ids = [f"source-{first_hash}", f"source-{second_hash}"]
        self.assertNotIn("tests", portable_cell)
        self.assertEqual(
            [item["source_id"] for item in portable_cell["sources"]],
            expected_source_ids,
        )
        self.assertEqual([item["position"] for item in portable_cell["sources"]], [1, 2])
        self.assertEqual(
            [item["tracked_tail"] for item in portable_cell["sources"]],
            [False, True],
        )
        self.assertEqual(
            [source["portable_id"] for source in report["sources"]],
            expected_source_ids,
        )

        imported_db = self.make_session()
        with patch.object(portable_analysis.cache, "build", self.fake_cache_build):
            portable_analysis.import_analysis_html(imported_db, destination)
        imported_cell = imported_db.query(Cell).one()
        self.assertEqual(imported_db.query(Test).filter(Test.cell_id == imported_cell.id).count(), 1)
        imported_test = imported_db.query(Test).filter(Test.cell_id == imported_cell.id).one()
        self.assertEqual(
            [link.file.hash for link in sorted(imported_test.file_links, key=lambda item: item.position)],
            [first_hash, second_hash],
        )

    def test_strict_portable_chain_decoder_accepts_current_and_single_legacy_shape(self):
        self.assertEqual(
            portable_analysis._portable_source_ids(
                {
                    "name": "Current",
                    "sources": [
                        {"source_id": "s1", "position": 1, "tracked_tail": False},
                        {"source_id": "s2", "position": 2, "tracked_tail": True},
                    ],
                },
                known_source_ids={"s1", "s2"},
            ),
            ["s1", "s2"],
        )
        self.assertEqual(
            portable_analysis._portable_source_ids(
                {"name": "Legacy", "tests": [{"source_ids": ["s1", "s2"]}]},
                known_source_ids={"s1", "s2"},
            ),
            ["s1", "s2"],
        )

    def test_malformed_portable_chains_fail_identically_before_import_writes(self):
        mutations = {
            "duplicate_position": lambda cell: cell["sources"][1].update(position=1),
            "missing_position": lambda cell: cell["sources"][1].update(position=3),
            "non_integer_position": lambda cell: cell["sources"][1].update(position="2"),
            "duplicate_source_id": lambda cell: cell["sources"][1].update(
                source_id=cell["sources"][0]["source_id"]
            ),
            "wrong_tail_flag": lambda cell: cell["sources"][0].update(tracked_tail=True),
            "unknown_source_reference": lambda cell: cell["sources"][0].update(
                source_id="source-does-not-exist"
            ),
            "multiple_legacy_envelopes": lambda cell: (
                cell.pop("sources"),
                cell.update(
                    tests=[
                        {"source_ids": ["source-one"]},
                        {"source_ids": ["source-two"]},
                    ]
                ),
            ),
        }
        source_html, _ = self.create_export()
        base_report = self.read_report(source_html)
        for case, mutate in mutations.items():
            with self.subTest(case=case):
                # The valid export is immutable setup shared by these
                # subcases; each mutated report and database remains private.
                report = deepcopy(base_report)
                cell = report["cells"][0]
                second_source = deepcopy(report["sources"][0])
                second_source.update(
                    portable_id="source-two",
                    hash="b" * 64,
                    filename="second.ndax",
                )
                report["sources"].append(second_source)
                cell["sources"].append(
                    {"source_id": "source-two", "position": 2, "tracked_tail": True}
                )
                mutate(cell)
                malformed = self.root / f"malformed-{case}.html"
                self.rewrite_report(source_html, report, malformed)

                inspection_db = self.make_session()
                with self.assertRaises(HTTPException) as inspected:
                    portable_analysis.inspect_analysis_html(inspection_db, malformed)
                imported_db = self.make_session()
                with self.assertRaises(HTTPException) as imported:
                    portable_analysis.import_analysis_html(imported_db, malformed)
                self.assertEqual(imported.exception.status_code, inspected.exception.status_code)
                self.assertEqual(imported.exception.detail, inspected.exception.detail)
                self.assertEqual(imported_db.query(Cell).count(), 0)
                self.assertEqual(imported_db.query(Test).count(), 0)
                self.assertEqual(imported_db.query(TestFile).count(), 0)

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
        views = portable_analysis._report_views(db, analysis)
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=False,
            views=views,
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
