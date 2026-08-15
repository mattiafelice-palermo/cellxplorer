"""Spec 041.6 closure regressions for the verified MPR source lifecycle.

The supported binary layout does not independently establish logical cycle
identity without a paired EC-Lab text export for general multi-phase runs.
The user-requested single-direction exception is covered here as a complete
header-inspection, registration and cache lifecycle. Array-level canonical
mapper behavior with an explicit cycle field is covered separately by
``test_biologic_gcpl``.
"""

from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base  # noqa: E402
from app.models import Analysis, Cell, SourceFile, Test, TestFile  # noqa: E402
from app.routers import analyses as analyses_router, library as library_router  # noqa: E402
from app.services import (  # noqa: E402
    analysis_cache,
    analysis_engine,
    background_jobs,
    cache,
    cache_maintenance,
    import_inspection,
    parsing,
    scanner,
)
from app.services.biologic_gcpl import (  # noqa: E402
    UnsupportedBiologicGcplError,
    read_gcpl_header_metadata,
)
from tests.biologic_mpr_fixture import (  # noqa: E402
    encode_gcpl_log,
    encode_gcpl_settings,
    write_gcpl_mpr,
)


def _rows() -> list[dict[str, object]]:
    """A small three-electrode GCPL source with no full-cycle field."""

    return [
        {
            "total_time_s": 0.0,
            "ns": 0,
            "half_cycle": 0,
            "mode": 1,
            "control": 10.0,
            "q_mAh": 0.0,
            "ewe_v": 3.6,
            "ece_v": 0.1,
            "ns_changed": True,
        },
        {
            "total_time_s": 360.0,
            "ns": 0,
            "half_cycle": 0,
            "mode": 1,
            "control": 10.0,
            "q_mAh": 1.0,
            "raw_dq_mAh": 1.0,
            "ewe_v": 3.8,
            "ece_v": 0.1,
        },
        {
            "total_time_s": 360.0,
            "ns": 1,
            "half_cycle": 0,
            "mode": 3,
            "control": 0.0,
            "q_mAh": 1.0,
            "ewe_v": 3.8,
            "ece_v": 0.1,
            "ns_changed": True,
        },
        {
            "total_time_s": 420.0,
            "ns": 1,
            "half_cycle": 0,
            "mode": 3,
            "control": 0.0,
            "q_mAh": 1.0,
            "ewe_v": 3.7,
            "ece_v": 0.1,
        },
    ]


def _settings() -> bytes:
    return encode_gcpl_settings(
        [
            {"set_i_c": 0, "current": 10.0, "t1_s": 360.0, "voltage_limit_v": 4.2},
            {"set_i_c": 0, "current": 0.0, "t1_s": 60.0, "rest_duration_s": 60.0},
        ],
        active_mass_g=0.001,
        reference_electrode="Ag/AgCl",
        battery_capacity=1.0,
        battery_capacity_unit=1,
    )


def _single_discharge_rows() -> list[dict[str, object]]:
    return [
        {
            "total_time_s": 0.0,
            "ns": 0,
            "half_cycle": 0,
            "mode": 1,
            "control": -1.0,
            "q_mAh": 1.0,
            "ewe_v": 3.6,
            "ece_v": 0.1,
            "ns_changed": True,
        },
        {
            "total_time_s": 3600.0,
            "ns": 0,
            "half_cycle": 0,
            "mode": 1,
            "control": -1.0,
            "q_mAh": 0.0,
            "raw_dq_mAh": -1.0,
            "ewe_v": 3.5,
            "ece_v": 0.1,
        },
        {
            "total_time_s": 3600.0,
            "ns": 1,
            "half_cycle": 0,
            "mode": 3,
            "control": 0.0,
            "q_mAh": 0.0,
            "ewe_v": 3.5,
            "ece_v": 0.1,
            "ns_changed": True,
        },
        {
            "total_time_s": 3660.0,
            "ns": 1,
            "half_cycle": 0,
            "mode": 3,
            "control": 0.0,
            "q_mAh": 0.0,
            "ewe_v": 3.4,
            "ece_v": 0.1,
        },
    ]


def _single_discharge_settings() -> bytes:
    return encode_gcpl_settings(
        [
            {"set_i_c": 0, "current": -1.0},
            {"set_i_c": 0, "current": 0.0, "rest_duration_s": 60.0},
        ],
        reference_electrode="Ag/AgCl",
        battery_capacity=1.0,
        battery_capacity_unit=1,
    )


class BiologicClosureIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tempdir.name)
        cls.mpr_path = write_gcpl_mpr(
            cls.root / "synthetic-gcpl.mpr",
            _rows(),
            settings_payload=_settings(),
            log_payload=encode_gcpl_log(ole_timestamp=45000.0),
            include_log=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tempdir.cleanup()

    def setUp(self) -> None:
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        self.db = self.factory()
        self.cache_root = self.root / f"cache-{id(self)}"
        self.old_cache_dir = cache.CACHE_DIR
        cache.CACHE_DIR = self.cache_root
        self.source = scanner.ingest_path(self.db, self.mpr_path, parse_now=True)

    def tearDown(self) -> None:
        cache.CACHE_DIR = self.old_cache_dir
        background_jobs.clear_jobs()
        self.db.close()

    def test_single_direction_source_registers_canonical_and_builds_cache(self) -> None:
        path = write_gcpl_mpr(
            self.root / "single-discharge.mpr",
            _single_discharge_rows(),
            settings_payload=_single_discharge_settings(),
            log_payload=encode_gcpl_log(ole_timestamp=45000.0),
            include_log=True,
        )

        source = scanner.ingest_path(self.db, path, parse_now=True)

        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(source.parser_version, "bm:gcpl7:r1")
        self.assertEqual(source.row_count, 4)
        self.assertEqual(source.cycle_count, 1)
        self.assertEqual(source.capacity_summary_status, "ready")
        self.assertFalse(parsing.source_record_metadata_only(source))
        self.assertTrue(
            cache.has_cycles(source.hash, source.parser_version, cache.CALC_VERSION)
        )
        cycles = cache.load_cycles(
            source.hash,
            source.parser_version,
            cache.CALC_VERSION,
        )
        self.assertIsNotNone(cycles)
        self.assertEqual(cycles["cycle"].tolist(), [1])

    def test_legacy_gcpl5_source_is_reinspected_under_the_new_cycle_contract(self) -> None:
        path = write_gcpl_mpr(
            self.root / "legacy-single-discharge.mpr",
            _single_discharge_rows(),
            settings_payload=_single_discharge_settings(),
            log_payload=encode_gcpl_log(ole_timestamp=45000.0),
            include_log=True,
        )
        source = scanner.ingest_path(self.db, path, parse_now=True)
        source.parser_version = "bm:gcpl5:r1"
        source.parse_status = "metadata_only"
        source.parse_error = "legacy metadata-only registration"
        source.row_count = None
        source.cycle_count = None
        source.capacity_summary_status = "unavailable"
        self.db.commit()

        self.assertEqual(scanner.reinspect_legacy_biologic_sources(self.db), 1)
        self.db.expire_all()
        refreshed = self.db.get(SourceFile, source.id)
        self.assertEqual(refreshed.parser_version, "bm:gcpl7:r1")
        self.assertEqual(refreshed.parse_status, "parsed")
        self.assertEqual(refreshed.cycle_count, 1)
        self.assertFalse(parsing.source_record_metadata_only(refreshed))

    def _add_retired_source(
        self,
        *,
        location_status: str = "online",
        hash_value: str = "ab" * 32,
    ) -> tuple[SourceFile, Cell]:
        header = deepcopy(self.source.header_meta or {})
        capabilities = dict(header.get("capabilities") or {})
        capabilities.update(
            {
                "cycling_rows": True,
                "canonical_cycling": True,
                "metadata_only": False,
            }
        )
        header["capabilities"] = capabilities
        source_path = (
            self.mpr_path
            if location_status == "online"
            else self.root / f"missing-{hash_value[:6]}.mpr"
        )
        source = SourceFile(
            hash=hash_value,
            path=str(source_path),
            filename="retired-gcpl3.mpr",
            size=source_path.stat().st_size if source_path.exists() else 1,
            ext="mpr",
            observed_size=source_path.stat().st_size if source_path.exists() else 1,
            observed_mtime_ns=(
                source_path.stat().st_mtime_ns if source_path.exists() else None
            ),
            location_status=location_status,
            parse_status="parsed",
            parser_version="bm:gcpl3:r1",
            header_meta=header,
            row_count=4,
            cycle_count=2,
            total_charge_capacity_mah=1.0,
            total_discharge_capacity_mah=0.9,
            max_discharge_capacity_mah=0.9,
            capacity_summary_status="ready",
        )
        cell = Cell(name=f"retired-{hash_value[:8]}")
        self.db.add(source)
        self.db.add(cell)
        self.db.flush()
        test = Test(cell_id=cell.id, name="retired-source")
        self.db.add(test)
        self.db.flush()
        self.db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        self.db.commit()
        return source, cell

    def _write_retired_cache(self, source: SourceFile) -> tuple[Path, Path]:
        old_identity = "bm:gcpl3:r1"
        old_raw = cache.raw_path(source.hash, old_identity)
        old_cycles = cache.cycles_path(source.hash, old_identity, cache.CALC_VERSION)
        old_raw.parent.mkdir(parents=True, exist_ok=True)
        old_raw.write_bytes(b"withdrawn canonical raw cache")
        old_cycles.write_bytes(b"withdrawn canonical cycles cache")
        return old_raw, old_cycles

    def _add_pre_r8_source(
        self,
        *,
        layout: str,
        location_status: str = "offline",
        hash_value: str = "34" * 32,
    ) -> tuple[SourceFile, Cell]:
        header = deepcopy(self.source.header_meta or {})
        data = dict(header.get("data") or {})
        if layout == parsing.BIOLOGIC_MPR_WITHDRAWN_LAYOUT:
            data["column_ids"] = [
                column_id
                for column_id in data.get("column_ids", [])
                if int(column_id) != 9
            ]
            data["n_columns"] = 15
            data["record_itemsize"] = 49
        header["data"] = data
        capabilities = dict(header.get("capabilities") or {})
        capabilities.update(
            {
                "cycling_rows": True,
                "canonical_cycling": True,
                "metadata_only": False,
                "requires_reinspection": False,
            }
        )
        header["capabilities"] = capabilities
        source_path = self.root / f"pre-r8-{hash_value[:6]}.mpr"
        source = SourceFile(
            hash=hash_value,
            path=str(source_path),
            filename="pre-r8-gcpl4.mpr",
            size=1,
            ext="mpr",
            observed_size=1,
            observed_mtime_ns=None,
            location_status=location_status,
            parse_status="parsed",
            parser_version="bm:gcpl4:r1",
            header_meta=header,
            row_count=4,
            cycle_count=2,
            total_charge_capacity_mah=1.0,
            total_discharge_capacity_mah=0.9,
            max_discharge_capacity_mah=0.9,
            capacity_summary_status="ready",
        )
        cell = Cell(name=f"pre-r8-{hash_value[:8]}")
        self.db.add(source)
        self.db.add(cell)
        self.db.flush()
        test = Test(cell_id=cell.id, name="pre-r8-source")
        self.db.add(test)
        self.db.flush()
        self.db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        self.db.commit()
        return source, cell

    def test_header_capabilities_advertise_single_direction_cycling(self) -> None:
        metadata = read_gcpl_header_metadata(self.mpr_path)
        capabilities = metadata["capabilities"]
        self.assertFalse(capabilities["canonical_cycling"])
        self.assertFalse(capabilities["cycling_rows"])
        self.assertTrue(capabilities["canonical_cycling_pending"])
        self.assertTrue(capabilities["single_direction_cycle_candidate"])
        self.assertFalse(capabilities["metadata_only"])
        self.assertEqual(
            capabilities["cycle_identity_source"],
            "single_direction_pending",
        )
        self.assertIn("pending", " ".join(metadata["protocol_warnings"]).casefold())

        voltage = metadata["voltage_capabilities"]
        self.assertEqual(voltage["voltage_roles"]["voltage_v"], "cell")
        self.assertEqual(voltage["voltage_roles"]["working_potential_v"], "working_vs_reference")
        self.assertEqual(voltage["voltage_roles"]["counter_potential_v"], "counter_vs_reference")
        self.assertEqual(voltage["reference_electrode"], "Ag/AgCl")

    def test_scanner_registers_single_direction_and_builds_a_cache(self) -> None:
        self.assertEqual(self.source.parse_status, "parsed")
        self.assertEqual(self.source.parser_version, "bm:gcpl7:r1")
        self.assertEqual(self.source.row_count, 4)
        self.assertEqual(self.source.cycle_count, 1)
        self.assertEqual(self.source.capacity_summary_status, "ready")
        capabilities = (self.source.header_meta or {}).get("capabilities") or {}
        self.assertTrue(capabilities["canonical_cycling"])
        self.assertTrue(capabilities["canonical_cycling_verified"])
        self.assertFalse(capabilities["canonical_cycling_pending"])
        self.assertEqual(
            capabilities["single_direction_cycle_verification"],
            "verified",
        )
        self.assertFalse(parsing.source_record_metadata_only(self.source))
        self.assertTrue(cache.raw_path(self.source.hash, self.source.parser_version).exists())

        scanner.parse_file(self.db, self.source)
        self.assertEqual(self.source.parse_status, "parsed")
        self.assertTrue(cache.raw_path(self.source.hash, self.source.parser_version).exists())

        frame = parsing.parse_timeseries(self.mpr_path)
        self.assertEqual(frame["cycle"].unique().tolist(), [1])

    def test_parser_revision_invalidates_the_previous_canonical_identity(self) -> None:
        current_identity = parsing.parser_identity(self.mpr_path)
        self.assertEqual(current_identity, "bm:gcpl7:r1")
        file_hash = parsing.capture_source_fingerprint(self.mpr_path).hash
        old_identity = "bm:gcpl3:r1"
        old_raw = cache.raw_path(file_hash, old_identity)
        old_cycles = cache.cycles_path(file_hash, old_identity, cache.CALC_VERSION)
        old_raw.parent.mkdir(parents=True, exist_ok=True)
        old_raw.write_bytes(b"old parser cache")
        old_cycles.write_bytes(b"old cycle cache")

        self.assertTrue(cache.raw_path(file_hash, current_identity).exists())
        self.assertTrue(cache.cycles_path(file_hash, current_identity, cache.CALC_VERSION).exists())
        self.assertTrue(old_raw.exists())
        self.assertTrue(old_cycles.exists())

    def test_startup_reclassifies_retired_online_and_offline_sources(self) -> None:
        online, _online_cell = self._add_retired_source(
            location_status="online", hash_value="ab" * 32
        )
        offline, _offline_cell = self._add_retired_source(
            location_status="offline", hash_value="cd" * 32
        )
        online_raw, online_cycles = self._write_retired_cache(online)
        offline_raw, offline_cycles = self._write_retired_cache(offline)

        with patch.object(scanner, "SessionLocal", side_effect=self.factory):
            result = scanner.start_capacity_summary_backfill()

        self.assertEqual(result["total"], 0)
        self.db.expire_all()
        for source in (online, offline):
            refreshed = self.db.get(SourceFile, source.id)
            self.assertEqual(refreshed.parser_version, "bm:gcpl7:r1")
            self.assertEqual(refreshed.parse_status, "metadata_only")
            self.assertEqual(refreshed.capacity_summary_status, "unavailable")
            self.assertTrue(parsing.source_record_metadata_only(refreshed))
            self.assertFalse(refreshed.header_meta["capabilities"]["canonical_cycling"])
            self.assertFalse(refreshed.header_meta["capabilities"]["cycling_rows"])
            self.assertTrue(refreshed.header_meta["capabilities"]["metadata_only"])
            self.assertIn("bm:gcpl3:r1", refreshed.parse_error)
        self.assertEqual(self.db.get(SourceFile, online.id).location_status, "online")
        self.assertEqual(self.db.get(SourceFile, offline.id).location_status, "offline")
        # Retired cache files may remain for forensic cleanup, but their
        # existence cannot keep either registration scientifically usable.
        self.assertTrue(online_raw.exists())
        self.assertTrue(online_cycles.exists())
        self.assertTrue(offline_raw.exists())
        self.assertTrue(offline_cycles.exists())

    def test_pre_r8_verified_layout_reconciles_offline_without_source_read(self) -> None:
        source, _cell = self._add_pre_r8_source(
            layout=parsing.BIOLOGIC_MPR_VERIFIED_LAYOUT,
            location_status="offline",
            hash_value="78" * 32,
        )
        with patch.object(
            parsing.biologic_gcpl,
            "read_gcpl_header_metadata",
            side_effect=AssertionError("pre-R8 reconciliation must use stored evidence"),
        ):
            self.assertEqual(scanner.reconcile_retired_biologic_sources(self.db), 1)

        self.db.expire_all()
        refreshed = self.db.get(SourceFile, source.id)
        self.assertEqual(refreshed.parser_version, "bm:gcpl7:r1")
        self.assertEqual(refreshed.parse_status, "metadata_only")
        self.assertEqual(refreshed.capacity_summary_status, "unavailable")
        self.assertTrue(parsing.source_record_metadata_only(refreshed))
        self.assertFalse(parsing.source_requires_biologic_mpr_reinspection(refreshed))
        self.assertFalse(refreshed.header_meta["capabilities"]["canonical_cycling"])
        self.assertTrue(refreshed.header_meta["capabilities"]["metadata_only"])
        self.assertIn("bm:gcpl4:r1", refreshed.parse_error)
        self.assertIsNone(refreshed.row_count)
        self.assertIsNone(refreshed.cycle_count)

    def test_pre_r8_withdrawn_layout_requires_reinspection_without_source_read(self) -> None:
        source, _cell = self._add_pre_r8_source(
            layout=parsing.BIOLOGIC_MPR_WITHDRAWN_LAYOUT,
            location_status="offline",
            hash_value="9a" * 32,
        )
        with patch.object(
            parsing.biologic_gcpl,
            "read_gcpl_header_metadata",
            side_effect=AssertionError("pre-R8 reconciliation must use stored evidence"),
        ):
            self.assertEqual(scanner.reconcile_retired_biologic_sources(self.db), 1)

        self.db.expire_all()
        refreshed = self.db.get(SourceFile, source.id)
        self.assertIsNone(refreshed.parser_version)
        self.assertEqual(refreshed.parse_status, "metadata_only")
        self.assertEqual(refreshed.capacity_summary_status, "unavailable")
        self.assertTrue(parsing.source_record_metadata_only(refreshed))
        self.assertTrue(parsing.source_requires_biologic_mpr_reinspection(refreshed))
        self.assertTrue(refreshed.header_meta["capabilities"]["requires_reinspection"])
        self.assertFalse(refreshed.header_meta["capabilities"]["canonical_cycling"])
        self.assertIn("Re-inspect", refreshed.parse_error)
        capability = parsing.source_record_capability(refreshed)
        self.assertTrue(capability["requires_reinspection"])
        self.assertEqual(scanner.reconcile_retired_biologic_sources(self.db), 0)

    def test_retired_pinned_analysis_is_blocked_before_old_cache_read(self) -> None:
        source, cell = self._add_retired_source(hash_value="ef" * 32)
        old_raw, old_cycles = self._write_retired_cache(source)
        spec = analysis_engine.default_spec("retired")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        provenance = {
            "calc_version": cache.CALC_VERSION,
            "parser_version": "bm:gcpl3:r1",
            "sources": [{"cell_id": cell.id, "file_hashes": [source.hash]}],
        }

        detail = analysis_engine.canonical_cycling_capability(self.db, spec)
        self.assertEqual(detail["code"], "canonical_cycling_unavailable")
        self.assertIn("bm:gcpl3:r1", detail["sources"][0]["warning"])
        with patch.object(
            cache,
            "load_cycles",
            side_effect=AssertionError("retired cache must not be read"),
        ):
            with self.assertRaises(analysis_engine.CanonicalCyclingUnavailable):
                analysis_engine.compute(self.db, spec, provenance)
        self.assertTrue(old_raw.exists())
        self.assertTrue(old_cycles.exists())

    def test_capability_guard_keeps_deferred_headers_unloaded(self) -> None:
        cells: list[Cell] = []
        for index in range(8):
            ext = "ndax" if index % 2 == 0 else "xlsx"
            source = SourceFile(
                hash=f"{index + 20:02x}" * 32,
                path=str(self.root / f"canonical-{index}.{ext}"),
                filename=f"canonical-{index}.{ext}",
                size=1,
                ext=ext,
                parse_status="parsed",
                parser_version=parsing.current_parser_identity_for_extension(ext),
                header_meta={
                    "capabilities": {"canonical_cycling": True},
                    "large_protocol_payload": "x" * 10_000,
                },
            )
            cell = Cell(name=f"canonical-{index}")
            self.db.add_all([source, cell])
            self.db.flush()
            test = Test(cell_id=cell.id, name=f"canonical-{index}")
            self.db.add(test)
            self.db.flush()
            self.db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
            cells.append(cell)

        metadata_source = SourceFile(
            hash="ab" * 32,
            path=str(self.root / "metadata-only.mpr"),
            filename="metadata-only.mpr",
            size=1,
            ext="mpr",
            parse_status="metadata_only",
            parser_version="bm:gcpl6:r1",
            parse_error="metadata-only MPR",
            header_meta={
                "capabilities": {"canonical_cycling": False},
                "large_protocol_payload": "y" * 10_000,
            },
        )
        metadata_cell = Cell(name="metadata-only")
        self.db.add_all([metadata_source, metadata_cell])
        self.db.flush()
        metadata_test = Test(cell_id=metadata_cell.id, name="metadata-only")
        self.db.add(metadata_test)
        self.db.flush()
        self.db.add(TestFile(test_id=metadata_test.id, file_id=metadata_source.id, position=0))
        self.db.commit()
        self.db.expunge_all()

        header_queries: list[str] = []

        def capture_header_query(_conn, _cursor, statement, _parameters, _context, _executemany):
            if "header_meta" in statement.casefold():
                header_queries.append(statement)

        event.listen(self.db.bind, "before_cursor_execute", capture_header_query)
        canonical_spec = analysis_engine.default_spec("canonical cache hit")
        canonical_spec["selection"]["entries"] = [
            {"kind": "cell", "ref_id": cell.id} for cell in cells
        ]
        metadata_spec = analysis_engine.default_spec("metadata cache hit")
        metadata_spec["selection"]["entries"] = [
            {"kind": "cell", "ref_id": metadata_cell.id}
        ]
        try:
            self.assertIsNone(
                analysis_engine.canonical_cycling_capability(self.db, canonical_spec)
            )
            detail = analysis_engine.canonical_cycling_capability(self.db, metadata_spec)
        finally:
            event.remove(self.db.bind, "before_cursor_execute", capture_header_query)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["code"], "canonical_cycling_unavailable")
        self.assertEqual(header_queries, [])

    def test_retired_saved_artifacts_and_warmup_fail_closed_before_cache_access(self) -> None:
        source, cell = self._add_retired_source(hash_value="ef" * 32)
        spec = analysis_engine.default_spec("retired artifact")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        spec["saved_plots"] = [
            {
                "id": "retired-plot",
                "name": "Retired plot",
                "tab": "cycles",
                "modified_at": "2026-08-15T00:00:00+00:00",
            }
        ]
        analysis = Analysis(
            title="Retired artifact",
            spec=spec,
            provenance={
                "calc_version": cache.CALC_VERSION,
                "parser_version": "bm:gcpl3:r1",
                "sources": [{"cell_id": cell.id, "file_hashes": [source.hash]}],
            },
        )
        self.db.add(analysis)
        self.db.commit()

        old_signature = analysis_cache.saved_plot_data_signature(
            self.db, analysis, spec["saved_plots"][0]
        )
        artifact = {
            "svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            "thumbnail": "data:image/png;base64,AA==",
            "preview_thumbnail": "data:image/webp;base64,AA==",
            "figure": {"data": [], "layout": {}},
            "summary": [],
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.multiple(
                analysis_cache,
                _ROOT=root,
                _ARTIFACTS=root / "artifacts",
                _THUMBNAILS=root / "thumbnails",
                _THUMBNAIL_INDEXES=root / "thumbnail-index",
                _PREPARED=root / "prepared",
                _budget_total=None,
                ANALYSIS_CACHE_LIMIT_BYTES=None,
            ):
                analysis_cache.store_artifact(
                    analysis.id,
                    "retired-plot",
                    f"client:{old_signature}",
                    artifact,
                    client_signature="client",
                    data_signature=old_signature,
                )
                analysis_cache.store_prepared_marker(
                    analysis.id,
                    "retired-plot",
                    old_signature,
                    spec["saved_plots"][0]["modified_at"],
                )

                self.assertEqual(
                    scanner.reconcile_retired_biologic_sources(self.db),
                    1,
                )
                self.db.expire_all()
                refreshed = self.db.get(Analysis, analysis.id)
                self.assertIsNotNone(refreshed)

                with patch.object(
                    analyses_router.analysis_cache,
                    "load_artifact",
                    side_effect=AssertionError("retired artifact must not be read"),
                ):
                    with self.assertRaises(HTTPException) as context:
                        analyses_router.get_plot_artifact(
                            analysis.id,
                            "retired-plot",
                            "client",
                            self.db,
                        )
                self.assertEqual(context.exception.status_code, 422)
                self.assertEqual(context.exception.detail["code"], "canonical_cycling_unavailable")

                with patch.object(
                    analyses_router.analysis_cache,
                    "load_artifact",
                    side_effect=AssertionError("retired artifact lookup must not be read"),
                ):
                    with self.assertRaises(HTTPException) as context:
                        analyses_router.lookup_plot_artifact(
                            analysis.id,
                            "retired-plot",
                            analyses_router.PlotArtifactLookup(signature="client"),
                            self.db,
                        )
                self.assertEqual(context.exception.status_code, 422)
                self.assertEqual(context.exception.detail["code"], "canonical_cycling_unavailable")

                with patch.object(
                    analyses_router.analysis_cache,
                    "load_indexed_thumbnail",
                    side_effect=AssertionError("retired thumbnail index must not be read"),
                ):
                    with self.assertRaises(HTTPException) as context:
                        analyses_router.lookup_plot_thumbnail(
                            analysis.id,
                            "retired-plot",
                            analyses_router.PlotArtifactLookup(signature="client"),
                            self.db,
                        )
                self.assertEqual(context.exception.status_code, 422)
                self.assertEqual(context.exception.detail["code"], "canonical_cycling_unavailable")

                with patch.object(
                    analyses_router.analysis_cache,
                    "load_latest_thumbnail",
                    side_effect=AssertionError("retired latest thumbnail must not be read"),
                ):
                    with self.assertRaises(HTTPException) as context:
                        analyses_router.latest_plot_thumbnail(
                            analysis.id,
                            "retired-plot",
                            db=self.db,
                        )
                self.assertEqual(context.exception.status_code, 422)
                self.assertEqual(context.exception.detail["code"], "canonical_cycling_unavailable")

                write_request = analyses_router.PlotArtifactRequest(
                    signature="client",
                    svg=artifact["svg"],
                    figure=artifact["figure"],
                    expected_data_signature=old_signature,
                )
                with patch.object(
                    analyses_router.analysis_cache,
                    "store_artifact",
                    side_effect=AssertionError("retired artifact must not be republished"),
                ):
                    with self.assertRaises(HTTPException) as context:
                        analyses_router.store_plot_artifact(
                            analysis.id,
                            "retired-plot",
                            write_request,
                            self.db,
                        )
                self.assertEqual(context.exception.status_code, 422)
                self.assertEqual(context.exception.detail["code"], "canonical_cycling_unavailable")

                with (
                    patch.object(
                        analysis_cache,
                        "load_prepared_marker",
                        side_effect=AssertionError("retired marker must not authorize warmup"),
                    ),
                    patch.object(
                        analysis_cache,
                        "load_latest_thumbnail",
                        side_effect=AssertionError("retired thumbnail must not authorize warmup"),
                    ),
                ):
                    coordinator = cache_maintenance.WarmupCoordinator()
                    started = coordinator.start(self.db, force=True)
                self.assertEqual(started["total"], 0)
                self.assertIsNone(coordinator.next_task(self.db))

                # Also cover the race where a task passed _is_current before
                # startup reconciliation withdrew the source.
                analysis_cache.store_prepared_marker(
                    analysis.id,
                    "retired-plot",
                    old_signature,
                    spec["saved_plots"][0]["modified_at"],
                )
                completion = cache_maintenance.WarmupCoordinator()
                stale_task = {
                    "id": "retired-task",
                    "analysis_id": analysis.id,
                    "plot_id": "retired-plot",
                    "expected_data_signature": old_signature,
                }
                with completion._lock:
                    completion._active = stale_task
                with patch.object(
                    analysis_cache,
                    "load_latest_thumbnail",
                    side_effect=AssertionError("retired completion must not read thumbnails"),
                ):
                    completed = completion.complete(
                        "retired-task",
                        status="ready",
                        detail="Ready",
                        error=None,
                        db=self.db,
                    )
                self.assertTrue(completed["ok"])
                self.assertIsNone(
                    analysis_cache.load_prepared_marker(analysis.id, "retired-plot")
                )

                # The old forensic artifact may remain physically, but its
                # prepared marker is removed so a later capability change
                # cannot adopt it by stale identity alone.
                self.assertIsNone(
                    analysis_cache.load_prepared_marker(analysis.id, "retired-plot")
                )

    def test_retired_worker_result_cannot_promote_source_back_to_canonical(self) -> None:
        source, _cell = self._add_retired_source(hash_value="12" * 32)
        self._write_retired_cache(source)
        job_id = background_jobs.create_job(
            kind="scientific_preparation",
            title="Retired source",
            description="retired parser publication guard",
            total=1,
            items=[{"id": source.id, "label": source.filename}],
        )
        source_job = scanner._capacity_source_job(source, prepare_all_missing=True)
        self.db.commit()
        result = {
            "ok": True,
            "built": True,
            "info": {
                "parser_version": "bm:gcpl5:r1",
                "rows": 4,
                "cycles": 2,
                "total_charge_capacity_mah": 1.0,
                "total_discharge_capacity_mah": 0.9,
                "max_discharge_capacity_mah": 0.9,
            },
        }

        self.assertEqual(
            scanner._apply_capacity_source_result(
                self.db, job_id, source_job, result
            ),
            (0, 1),
        )
        self.db.expire_all()
        refreshed = self.db.get(SourceFile, source.id)
        self.assertEqual(refreshed.parse_status, "metadata_only")
        self.assertEqual(refreshed.parser_version, "bm:gcpl7:r1")
        self.assertEqual(refreshed.capacity_summary_status, "unavailable")
        self.assertEqual(background_jobs.get_job(job_id)["counters"]["failed"], 1)

    def test_failed_single_direction_verification_persists_metadata_only_capability(self) -> None:
        path = write_gcpl_mpr(
            self.root / "failed-single-direction-verification.mpr",
            _single_discharge_rows(),
            # The decoded rows are discharge, while the settings declare
            # charge. Header inspection is still eligible, but full parsing
            # must downgrade the persisted source when row proof fails.
            settings_payload=_settings(),
            log_payload=encode_gcpl_log(ole_timestamp=45000.0),
            include_log=True,
        )

        source = scanner.ingest_path(self.db, path, parse_now=True)

        self.assertEqual(source.parse_status, "metadata_only")
        self.assertEqual(source.parser_version, "bm:gcpl7:r1")
        self.assertTrue(parsing.source_record_metadata_only(source))
        self.assertEqual(source.capacity_summary_status, "unavailable")
        self.assertIn("declared charge", source.parse_error or "")
        capabilities = source.header_meta["capabilities"]
        self.assertFalse(capabilities["canonical_cycling"])
        self.assertFalse(capabilities["cycling_rows"])
        self.assertTrue(capabilities["metadata_only"])
        self.assertFalse(capabilities["canonical_cycling_pending"])
        self.assertNotEqual(
            capabilities.get("cycle_identity_source"),
            "single_direction_inferred",
        )
        self.assertFalse(
            cache.raw_path(source.hash, "bm:gcpl7:r1").exists()
        )
        capability = parsing.source_record_capability(source)
        self.assertEqual(capability["status"], "metadata_only")
        self.assertFalse(capability["canonical_cycling"])

    def test_pending_candidate_is_unavailable_to_deferred_capability_checks(self) -> None:
        self.source.parse_status = "parsing"
        self.source.parser_version = None
        self.db.commit()
        self.db.expire_all()

        capability = parsing.source_record_capability(
            self.source,
            include_header=False,
        )

        self.assertEqual(capability["status"], "pending")
        self.assertTrue(capability["canonical_cycling_pending"])
        self.assertFalse(capability["canonical_cycling"])
        self.assertTrue(
            parsing.source_record_metadata_only(
                self.source,
                include_header=False,
            )
        )

    def test_previous_gcpl6_identity_is_reinspected_and_offline_rows_fail_closed(self) -> None:
        online = self.source
        online.parser_version = "bm:gcpl6:r1"
        online.parse_status = "parsed"
        self.db.commit()
        old_raw = cache.raw_path(online.hash, "bm:gcpl6:r1")
        old_cycles = cache.cycles_path(online.hash, "bm:gcpl6:r1", cache.CALC_VERSION)
        old_raw.parent.mkdir(parents=True, exist_ok=True)
        old_raw.write_bytes(b"unsafe gcpl6 raw cache")
        old_cycles.write_bytes(b"unsafe gcpl6 cycles cache")

        offline, _cell = self._add_retired_source(
            location_status="offline",
            hash_value="de" * 32,
        )
        offline.parser_version = "bm:gcpl6:r1"
        offline.parse_status = "parsed"
        self.db.commit()

        self.assertEqual(scanner.reinspect_legacy_biologic_sources(self.db), 2)
        self.db.expire_all()
        refreshed_online = self.db.get(SourceFile, online.id)
        refreshed_offline = self.db.get(SourceFile, offline.id)
        self.assertEqual(refreshed_online.parser_version, "bm:gcpl7:r1")
        self.assertEqual(refreshed_online.parse_status, "parsed")
        self.assertTrue(old_raw.exists())
        self.assertTrue(old_cycles.exists())
        self.assertIsNone(refreshed_offline.parser_version)
        self.assertEqual(refreshed_offline.parse_status, "metadata_only")
        self.assertEqual(refreshed_offline.capacity_summary_status, "unavailable")
        self.assertIsNone(refreshed_offline.row_count)
        self.assertIsNone(refreshed_offline.cycle_count)
        self.assertIsNone(refreshed_offline.total_charge_capacity_mah)
        self.assertIsNone(refreshed_offline.total_discharge_capacity_mah)
        self.assertIsNone(refreshed_offline.max_discharge_capacity_mah)
        self.assertTrue(parsing.source_record_metadata_only(refreshed_offline))
        self.assertTrue(
            refreshed_offline.header_meta["capabilities"]["requires_reinspection"]
        )
        self.assertIn("previous parser identity", (parsing.source_record_metadata_only_message(refreshed_offline)).casefold())
        self.assertEqual(
            library_router.cell_capacity_totals(refreshed_offline.test_link.test.cell),
            {
                "total_charge_capacity_mah": None,
                "total_discharge_capacity_mah": None,
                "max_discharge_capacity_mah": None,
            },
        )

    def test_header_batch_is_bounded_with_single_direction_capability(self) -> None:
        paths = []
        for index in range(50):
            path = self.root / f"header-{index}.mpr"
            write_gcpl_mpr(
                path,
                [{"total_time_s": 0.0, "ns": 0, "control": -1.0}],
                settings_payload=_settings(),
                include_log=False,
            )
            paths.append(path)

        phases: list[dict] = []
        outcomes = import_inspection.inspect_files(
            [str(path) for path in paths],
            on_phase=phases.append,
        )
        self.assertEqual(
            [Path(outcome.path).name for outcome in outcomes],
            [path.name for path in paths],
        )
        self.assertTrue(all(outcome.inspection is not None for outcome in outcomes))
        self.assertTrue(
            all(
                not outcome.inspection.metadata["capabilities"]["canonical_cycling"]
                and outcome.inspection.metadata["capabilities"]["canonical_cycling_pending"]
                for outcome in outcomes
                if outcome.inspection is not None
            )
        )
        startup = [phase for phase in phases if phase["phase"] == "starting_workers"]
        self.assertEqual(import_inspection.inspection_strategy(25), "serial")
        self.assertEqual(import_inspection.inspection_strategy(26), "multiprocessing")
        self.assertEqual([phase["phase_current"] for phase in startup], [1, 2, 3, 4])
        self.assertEqual(startup[-1]["worker_count"], 4)

    def test_generic_scientific_services_have_no_biologic_format_branch(self) -> None:
        service_paths = (
            ROOT / "backend" / "app" / "services" / "calc.py",
            ROOT / "backend" / "app" / "services" / "dcir.py",
            ROOT / "backend" / "app" / "services" / "chargeability.py",
            ROOT / "backend" / "app" / "services" / "rate_capability.py",
            ROOT / "backend" / "app" / "services" / "step_blocks.py",
        )
        for path in service_paths:
            text = path.read_text(encoding="utf-8").casefold()
            self.assertNotIn("biologic", text, path.name)
            self.assertNotIn(".mpr", text, path.name)


if __name__ == "__main__":
    unittest.main()
