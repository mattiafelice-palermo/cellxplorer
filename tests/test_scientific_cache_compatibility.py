"""Compatible Neware upgrades reuse bytes; BioLogic invalidation stays scoped."""
from __future__ import annotations
from backend.app.services.filesystem_cleanup import TemporaryDirectory

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import SourceFile
from app.services import analysis_cache, analysis_engine, background_jobs, cache, calc, parsing, scanner
from app.services.scientific_cache_compatibility import compatible_calculation_versions
from tests.test_time_capacity_derived import derived_frame


class ScientificCacheCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sequence = 0
        self.patcher = patch.object(cache, "CACHE_DIR", self.root / "cache")
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                                    poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.addCleanup(self.engine.dispose)
        scanner._capacity_backfill_running = False
        scanner._capacity_backfill_job_id = None
        background_jobs.clear_jobs()
        self.addCleanup(background_jobs.clear_jobs)

    def seed(self, ext, versions=("1.6.4",)):
        self.sequence += 1
        path = self.root / f"source-{self.sequence}-{ext}-{'-'.join(versions)}.{ext}"
        path.write_bytes(path.name.encode())
        file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        parser = parsing.current_parser_identity_for_extension(ext)
        raw = derived_frame()
        cache._publish_optimized_raw(raw, cache.raw_path(file_hash, parser), parser)
        cycles = calc.per_cycle(raw)
        for version in versions:
            cycles.to_parquet(cache.cycles_path(file_hash, parser, version), index=False)
        # Represent an old, fully valid prepared cache without changing its science.
        cache.prepare_time_capacity_derived(file_hash, parser)
        if "1.6.5" not in versions:
            current_payload = cache.time_capacity_derived_path(file_hash, parser)
            current_index = cache.time_capacity_derived_index_path(file_hash, parser)
            old_index = cache.time_capacity_derived_index_path(file_hash, parser, "1.6.4")
            data = json.loads(current_index.read_text(encoding="utf-8"))
            data["calc_version"] = "1.6.4"
            current_payload.replace(cache.time_capacity_derived_path(file_hash, parser, "1.6.4"))
            current_index.unlink()
            old_index.write_text(json.dumps(data), encoding="utf-8")
        source = SourceFile(hash=file_hash, path=str(path), filename=path.name,
                            size=path.stat().st_size, ext=ext, parser_version=parser,
                            parse_status="parsed", capacity_summary_status="ready",
                            location_status="online")
        with self.factory() as db:
            db.add(source)
            db.commit()
        return source, cycles

    def snapshot(self, source):
        directory = cache.raw_path(source.hash, source.parser_version).parent
        return {p.name: (p.read_bytes(), p.stat().st_ino) for p in directory.iterdir()}

    def forbid_rebuild(self):
        stack = ExitStack()
        for owner, name in [(parsing, "parse_timeseries"), (calc, "per_cycle"),
                            (cache, "_write_atomic"), (cache, "_publish_optimized_raw"),
                            (cache.time_capacity_derived, "phase_capacity")]:
            stack.enter_context(patch.object(owner, name, side_effect=AssertionError(f"unexpected {name}")))
        return stack

    def test_existing_neware_artifacts_are_reused_in_place_at_either_version(self):
        for ext in ("nda", "ndax", "xlsx"):
            for versions in (("1.6.4",), ("1.6.5",), ("1.6.4", "1.6.5")):
                with self.subTest(ext=ext, versions=versions):
                    source, expected = self.seed(ext, versions)
                    before = self.snapshot(source)
                    with self.forbid_rebuild(), patch.object(parsing.neware_excel, "is_supported_workbook", return_value=True):
                        self.assertTrue(scanner._has_current_scientific_cache(source))
                        self.assertFalse(scanner._needs_raw_layout_preparation(source))
                        self.assertFalse(scanner._needs_time_capacity_derived_preparation(source))
                        self.assertFalse(scanner._needs_identity_bring_forward(source))
                        pd.testing.assert_frame_equal(cache.load_cycles(source.hash, source.parser_version, "1.6.5"), expected)
                        pd.testing.assert_frame_equal(cache.build_write_behind(source.hash, source.path), expected)
                        self.assertTrue(cache.build(source.hash, source.path)["cached"])
                        self.assertEqual(cache.schedule_build(source.hash, source.path)["status"], "ready")
                        self.assertFalse(cache.prepare_time_capacity_derived(source.hash, source.parser_version)["prepared"])
                        selected = cache.load_time_capacity_derived(source.hash, source.parser_version, [2], ["phase_code", "phase_capacity_mah"])
                        self.assertEqual(selected.record_index.tolist(), [4, 5, 6, 7])
                    self.assertEqual(self.snapshot(source), before)

    def test_startup_does_not_queue_compatible_sources_even_after_biologic_upgrade(self):
        sources = [self.seed(ext)[0] for ext in ("ndax", "xlsx")]
        before = {source.id: self.snapshot(source) for source in sources}
        bumped = parsing.SourceFormatDescriptor(parsing.FORMAT_BIOLOGIC_MPR,
                                                frozenset({".mpr"}), "gcpl999cpocv1")
        with (self.forbid_rebuild(), patch.object(scanner, "SessionLocal", self.factory),
              patch.dict(parsing._FORMAT_DESCRIPTORS, {parsing.FORMAT_BIOLOGIC_MPR: bumped}),
              patch.object(scanner.threading, "Thread") as thread):
            result = scanner.start_capacity_summary_backfill()
            self.assertEqual(result["total"], 0)
            thread.assert_not_called()
        self.assertEqual({source.id: self.snapshot(source) for source in sources}, before)

    def test_exact_cycles_take_precedence_and_unknown_versions_never_alias(self):
        source, expected = self.seed("ndax", ("1.6.4", "1.6.5"))
        old = expected.copy()
        old["charge_capacity_mah"] = -123.0
        old.to_parquet(cache.cycles_path(source.hash, source.parser_version, "1.6.4"), index=False)
        with self.forbid_rebuild():
            pd.testing.assert_frame_equal(cache.load_cycles(source.hash, source.parser_version, "1.6.5"), expected)
            self.assertFalse(cache.has_cycles(source.hash, source.parser_version, "1.6.6"))
            self.assertIsNone(cache.load_cycles(source.hash, source.parser_version, "1.6.6"))
            self.assertFalse(cache.has_cycles("f" * 64, source.parser_version, "1.6.5"))
            self.assertFalse(cache.has_cycles(source.hash, "nb:changed:r1", "1.6.5"))

    def test_biologic_and_unknown_formats_never_reuse_old_calculations(self):
        for parser in ("bm:gcpl18cpocv1:r1", "bm:gcpl18cpocv1:r1:p1", "legacy", "nx:test:r1", "nb::r1"):
            self.assertEqual(compatible_calculation_versions(parser, "1.6.5"), ("1.6.5",))
            file_hash = hashlib.sha256(parser.encode()).hexdigest()
            target = cache.cycles_path(file_hash, parser, "1.6.4")
            target.parent.mkdir(parents=True, exist_ok=True)
            pd.DataFrame({"cycle": [1]}).to_parquet(target)
            self.assertFalse(cache.has_cycles(file_hash, parser, "1.6.5"))
            self.assertIsNone(cache.load_cycles(file_hash, parser, "1.6.5"))

    def test_bad_preferred_prepared_cache_can_use_valid_equivalent_without_publication(self):
        source, expected = self.seed("xlsx")
        current = cache.time_capacity_derived_path(source.hash, source.parser_version)
        current_index = cache.time_capacity_derived_index_path(source.hash, source.parser_version)
        current.write_bytes(b"incomplete payload")
        current_index.write_text("{}", encoding="utf-8")
        before = self.snapshot(source)
        with self.forbid_rebuild():
            self.assertTrue(cache.time_capacity_derived_is_current(source.hash, source.parser_version))
            self.assertFalse(cache.prepare_time_capacity_derived(source.hash, source.parser_version)["prepared"])
            selected = cache.load_time_capacity_derived(source.hash, source.parser_version, [2], ["phase_code"])
            self.assertEqual(selected.record_index.tolist(), [4, 5, 6, 7])
            pd.testing.assert_frame_equal(cache.load_cycles(source.hash, source.parser_version, "1.6.4"), expected)
        self.assertEqual(self.snapshot(source), before)

    def test_prepared_compatibility_does_not_accept_mismatched_metadata_or_raw(self):
        for field, value in (("calc_version", "1.6.3"), ("parser_version", "nx:999:r1"),
                             ("raw_shape_fingerprint", "changed"), ("raw_layout_version", 999)):
            with self.subTest(field=field):
                source, _ = self.seed("ndax", ("1.6.4",))
                path = cache.time_capacity_derived_index_path(source.hash, source.parser_version, "1.6.4")
                original = path.read_text(encoding="utf-8")
                metadata = json.loads(original)
                metadata[field] = value
                path.write_text(json.dumps(metadata), encoding="utf-8")
                self.assertFalse(cache.time_capacity_derived_is_current(source.hash, source.parser_version))
                self.assertIsNone(cache.load_time_capacity_derived(source.hash, source.parser_version, [1], ["phase_code"]))
                path.write_text(original, encoding="utf-8")

    def test_biologic_upgrade_changes_only_affected_source_selection_and_result_keys(self):
        neware, _ = self.seed("ndax")
        mpr = SourceFile(hash="e" * 64, path="unopened.mpr", filename="unopened.mpr", size=1,
                         ext="mpr", parser_version=parsing.current_parser_identity_for_extension("mpr"),
                         parse_status="parsed", capacity_summary_status="ready", location_status="online")
        with self.factory() as db:
            db.add(mpr)
            db.commit()
        from app.models import Cell
        cell = Cell(id=7, name="sample")
        unit = {"cell": cell, "entry_kind": "cell", "entry_ref_id": 7, "label": "sample",
                "group_id": None, "group_name": None}
        def key(source):
            with (patch.object(analysis_engine, "resolve_selection", return_value=([unit], [])),
                  patch.object(analysis_engine, "preload_cell_sources"),
                  patch.object(analysis_engine, "load_scalar_metadata", return_value={7: {}}),
                  patch.object(analysis_engine, "cell_ordered_hashes", return_value=([source.hash], [source]))):
                return analysis_cache.result_key(object(), "cycles", {}, None, use_current_versions=True)
        before_neware, before_mpr = key(neware), key(mpr)
        bumped = parsing.SourceFormatDescriptor(parsing.FORMAT_BIOLOGIC_MPR,
                                                frozenset({".mpr"}), "gcpl999cpocv1")
        with patch.dict(parsing._FORMAT_DESCRIPTORS, {parsing.FORMAT_BIOLOGIC_MPR: bumped}):
            self.assertEqual(key(neware), before_neware)
            self.assertNotEqual(key(mpr), before_mpr)
            self.assertFalse(scanner._needs_identity_bring_forward(neware))
            self.assertTrue(scanner._needs_identity_bring_forward(mpr))
            with (patch.object(scanner, "SessionLocal", self.factory),
                  patch.object(scanner.threading, "Thread")):
                result = scanner.start_capacity_summary_backfill()
                self.assertEqual(result["total"], 1)
                self.assertEqual([item["id"] for item in background_jobs.get_job(result["id"])["items"]], [str(mpr.id)])
