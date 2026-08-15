"""Spec 041.6 closure regressions for the verified-but-metadata-only MPR path.

The supported binary layout does not independently establish logical cycle
identity without a paired EC-Lab text export. These tests therefore prove the
truthful production boundary: header inspection and source registration work,
while canonical parsing, cache creation, and scientific analysis remain
fail-closed. Array-level canonical mapper behavior with an explicit cycle
field is covered separately by ``test_biologic_gcpl``.
"""

from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base  # noqa: E402
from app.models import Cell, SourceFile, Test, TestFile  # noqa: E402
from app.services import (  # noqa: E402
    analysis_engine,
    background_jobs,
    cache,
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

    def test_header_capabilities_are_truthfully_metadata_only(self) -> None:
        metadata = read_gcpl_header_metadata(self.mpr_path)
        capabilities = metadata["capabilities"]
        self.assertFalse(capabilities["canonical_cycling"])
        self.assertFalse(capabilities["cycling_rows"])
        self.assertTrue(capabilities["metadata_only"])
        self.assertIn("logical cycle", " ".join(metadata["protocol_warnings"]).casefold())

        voltage = metadata["voltage_capabilities"]
        self.assertEqual(voltage["voltage_roles"]["voltage_v"], "cell")
        self.assertEqual(voltage["voltage_roles"]["working_potential_v"], "working_vs_reference")
        self.assertEqual(voltage["voltage_roles"]["counter_potential_v"], "counter_vs_reference")
        self.assertEqual(voltage["reference_electrode"], "Ag/AgCl")

    def test_scanner_registers_metadata_only_and_never_builds_a_cache(self) -> None:
        self.assertEqual(self.source.parse_status, "metadata_only")
        self.assertEqual(self.source.parser_version, "bm:gcpl4:r1")
        self.assertIsNone(self.source.row_count)
        self.assertIsNone(self.source.cycle_count)
        self.assertEqual(self.source.capacity_summary_status, "unavailable")
        self.assertTrue(parsing.source_record_metadata_only(self.source))
        self.assertFalse(cache.raw_path(self.source.hash, self.source.parser_version).exists())

        scanner.parse_file(self.db, self.source)
        self.assertEqual(self.source.parse_status, "metadata_only")
        self.assertFalse(cache.raw_path(self.source.hash, self.source.parser_version).exists())

        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "logical cycle identity"):
            parsing.parse_timeseries(self.mpr_path)

    def test_parser_revision_invalidates_the_previous_canonical_identity(self) -> None:
        current_identity = parsing.parser_identity(self.mpr_path)
        self.assertEqual(current_identity, "bm:gcpl4:r1")
        file_hash = parsing.capture_source_fingerprint(self.mpr_path).hash
        old_identity = "bm:gcpl3:r1"
        old_raw = cache.raw_path(file_hash, old_identity)
        old_cycles = cache.cycles_path(file_hash, old_identity, cache.CALC_VERSION)
        old_raw.parent.mkdir(parents=True, exist_ok=True)
        old_raw.write_bytes(b"old parser cache")
        old_cycles.write_bytes(b"old cycle cache")

        self.assertFalse(cache.raw_path(file_hash, current_identity).exists())
        self.assertFalse(cache.cycles_path(file_hash, current_identity, cache.CALC_VERSION).exists())
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
            self.assertEqual(refreshed.parser_version, "bm:gcpl4:r1")
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
                "parser_version": "bm:gcpl4:r1",
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
        self.assertEqual(refreshed.parser_version, "bm:gcpl4:r1")
        self.assertEqual(refreshed.capacity_summary_status, "unavailable")
        self.assertEqual(background_jobs.get_job(job_id)["counters"]["failed"], 1)

    def test_header_batch_is_bounded_without_promoting_cycling_capability(self) -> None:
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
