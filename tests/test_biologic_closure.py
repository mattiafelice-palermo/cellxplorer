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
from pathlib import Path
import sys
import tempfile
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base  # noqa: E402
from app.services import cache, import_inspection, parsing, scanner  # noqa: E402
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
        self.db = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
        self.cache_root = self.root / f"cache-{id(self)}"
        self.old_cache_dir = cache.CACHE_DIR
        cache.CACHE_DIR = self.cache_root
        self.source = scanner.ingest_path(self.db, self.mpr_path, parse_now=True)

    def tearDown(self) -> None:
        cache.CACHE_DIR = self.old_cache_dir
        self.db.close()

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
