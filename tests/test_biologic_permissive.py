"""Explicit exploratory admission preserves evidence without claiming science."""
from __future__ import annotations
from backend.app.services.filesystem_cleanup import TemporaryDirectory

import os
import struct
from pathlib import Path
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
from app.db import Base
from app.models import SourceFile, Cell
from app.routers import files
from app.services import analysis_engine, cache, calc, canonical_cycling, import_inspection, parsing, scanner, source_readability
from tests.biologic_mpr_fixture import encode_gcpl_settings, write_gcpl_mpr


def rows():
    return [
        dict(total_time_s=10., ns=0, mode=1, control=1., q_mAh=0., raw_dq_mAh=0., ewe_v=3., ece_v=.1),
        dict(total_time_s=11., ns=0, mode=1, control=1., q_mAh=.1, raw_dq_mAh=.1, ewe_v=3.1, ece_v=.1),
        dict(total_time_s=8., ns=1, mode=1, control=-1., q_mAh=0., raw_dq_mAh=0., ewe_v=2.9, ece_v=.1, ns_changed=True, error=True),
        dict(total_time_s=9., ns=1, mode=1, control=-1., q_mAh=-.1, raw_dq_mAh=-.1, ewe_v=2.8, ece_v=.1),
    ]


class PermissiveMprTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = write_gcpl_mpr(Path(self.temp.name) / "source.mpr", rows(),
                                  settings_payload=encode_gcpl_settings([{"current": 1.}, {"current": -1.}]))
        source_readability.clear()
        self.addCleanup(source_readability.clear)

    def test_semantic_failure_preserves_all_records_and_native_clock(self):
        original = self.path.read_bytes()
        with self.assertRaises(parsing.SourceFormatError):
            parsing.parse_timeseries(self.path)
        rejected = source_readability.known_rejection(self.path)
        frame = parsing.parse_timeseries(self.path, read_mode="permissive")
        canonical_cycling.validate_raw_timeseries(frame)
        self.assertEqual(frame.record_index.tolist(), [1, 2, 3, 4])
        self.assertEqual(frame.mpr_elapsed_time_s.tolist(), [10., 11., 8., 9.])
        self.assertEqual(frame.mpr_acquisition_segment.tolist(), [1, 1, 2, 2])
        np.testing.assert_allclose(frame.voltage_v, [2.9, 3., 2.8, 2.7])
        self.assertTrue(frame.current_ma.isna().all())
        self.assertTrue(frame.charge_capacity_mah.isna().all())
        self.assertFalse(frame.cycle_complete.any())
        self.assertTrue(calc.per_cycle(frame).empty)
        self.assertIs(source_readability.known_rejection(self.path), rejected)
        self.assertEqual(self.path.read_bytes(), original)

    def test_structural_truncation_rejected_in_both_modes(self):
        self.path.write_bytes(self.path.read_bytes()[:-1])
        for mode in ("safe", "permissive"):
            with self.subTest(mode=mode), self.assertRaises(parsing.SourceFormatError):
                parsing.parse_timeseries(self.path, read_mode=mode)

    def test_mode_is_explicit_and_separate_in_cache_identity(self):
        safe = parsing.parser_identity(self.path)
        permissive = parsing.parser_identity(self.path, read_mode="permissive")
        self.assertNotEqual(safe, permissive)
        self.assertLessEqual(len(permissive), 30)
        self.assertEqual(permissive, parsing.current_parser_identity_for_extension("mpr", read_mode="permissive"))
        with self.assertRaises(ValueError):
            parsing.parse_timeseries(self.path, read_mode="loose")

    def test_inspection_metadata_cache_and_receipt_are_mode_bound(self):
        safe = import_inspection.inspect_file(str(self.path))
        loose = import_inspection.inspect_file(str(self.path), read_mode="permissive")
        self.assertEqual(parsing.source_read_mode(safe.metadata), "safe")
        self.assertEqual(parsing.source_read_mode(loose.metadata), "permissive")
        self.assertEqual(parsing.source_read_mode(import_inspection.cached_header_metadata(
            safe.hash, safe.size, safe.mtime_ns)), "safe")
        self.assertEqual(parsing.source_read_mode(import_inspection.cached_header_metadata(
            safe.hash, safe.size, safe.mtime_ns, read_mode="permissive")), "permissive")
        receipt = files.ImportIdentityReceipt(hash=safe.hash, size=safe.size, mtime_ns=str(safe.mtime_ns))
        with self.assertRaises(HTTPException) as rejected:
            files._prepare_import_source_file(None, source_path=self.path, filename=self.path.name,
                                              inspection=receipt, read_mode="permissive")
        self.assertEqual(rejected.exception.status_code, 409)

    def test_cache_reload_has_no_summary_and_keeps_warning(self):
        fingerprint = parsing.capture_source_fingerprint(self.path)
        info = cache.build(fingerprint.hash, self.path, read_mode="permissive", force=True)
        self.assertEqual(info["cycles"], 0)
        self.assertTrue(info["parser_version"].endswith(":p1"))
        restored = cache.load_raw(fingerprint.hash, info["parser_version"])
        self.assertEqual(restored.mpr_elapsed_time_s.tolist(), [10., 11., 8., 9.])
        self.assertTrue(cache.load_cycles(fingerprint.hash, info["parser_version"], cache.CALC_VERSION).empty)
        self.assertEqual(cache.load_parser_warnings(fingerprint.hash, info["parser_version"])[0]["code"],
                         "biologic_permissive_reading")
        diagnostics = {warning["code"]: warning for warning in cache.load_parser_warnings(fingerprint.hash, info["parser_version"])}
        self.assertEqual(diagnostics["biologic_instrument_errors"]["count"], 1)
        self.assertEqual(diagnostics["biologic_instrument_errors"]["examples"], [{"record_index": 3}])
        self.assertEqual(diagnostics["biologic_clock_regressions"]["examples"], [{"record_index": 3}])
        with patch.object(parsing, "parse_timeseries", side_effect=AssertionError("cached source must not reparse")):
            cached = cache.build(fingerprint.hash, self.path, read_mode="permissive")
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["scientific_interpretation"], "exploratory")
        with self.assertRaises(parsing.SourceFormatError):
            cache.build(fingerprint.hash, self.path)

    def test_registered_mode_survives_rebuild_and_current_identity(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()
        self.addCleanup(engine.dispose)
        self.addCleanup(session.close)
        source = scanner.ingest_path(session, self.path, parse_now=True, read_mode="permissive")
        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(source.cycle_count, 0)
        self.assertEqual(parsing.source_read_mode(source), "permissive")
        self.assertEqual(source.parser_version, parsing.current_parser_identity_for_source(source))
        self.assertFalse(scanner._needs_identity_bring_forward(source))
        scanner.parse_file(session, source)
        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(parsing.source_presentation(source)["read_mode"], "permissive")
        self.assertEqual(parsing.source_interpretation(source), "exploratory")
        source_warnings = {warning["code"]: warning for warning in parsing.source_presentation(source)["interpretation_warnings"]}
        self.assertEqual(source_warnings["biologic_instrument_errors"]["examples"], [{"record_index": 3}])
        self.assertEqual(source_warnings["biologic_clock_regressions"]["examples"], [{"record_index": 3}])

    def test_inspect_submit_and_worker_handoff_preserve_explicit_mode(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()
        self.addCleanup(engine.dispose)
        self.addCleanup(session.close)
        inspected = files.inspect_import_paths(files.ImportPathInspectRequest(
            paths=[str(self.path)], read_mode="permissive"), session)
        self.assertEqual(inspected["failures"], [])
        item = inspected["files"][0]
        self.assertEqual(item["read_mode"], "permissive")
        self.assertEqual(item["inspection"]["read_mode"], "permissive")
        request = files.ImportCellsRequest(cells=[files.ImportCellDraft(
            staged_name=item["staged_name"], source_path=str(self.path), filename=self.path.name,
            inspection=item["inspection"], read_mode="permissive", cell_name="Exploratory cell")])
        with patch.object(files, "start_import_cache_jobs", return_value={}) as handoff:
            result = files.create_imported_cells(request, session)
        self.assertEqual(len(result["created"]), 1)
        jobs = handoff.call_args.args[1]
        self.assertEqual(jobs[0]["read_mode"], "permissive")
        prepared = files._build_import_cache_worker(jobs[0])
        self.assertTrue(prepared["ok"], prepared)
        self.assertEqual(prepared["cycles"], 0)
        source = session.query(SourceFile).one()
        scanner.parse_file(session, source)
        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(parsing.source_read_mode(source), "permissive")
        refreshed = scanner.update_source_from_path(session, source)
        self.assertEqual(parsing.source_read_mode(refreshed), "permissive")
        self.assertEqual(refreshed.cycle_count, 0)

    def test_nested_settings_and_log_truncation_are_not_permissive(self):
        from app.services import biologic_gcpl
        full = encode_gcpl_settings([{"current": 1.}, {"current": -1.}])
        log_offset = next(iter(biologic_gcpl._GCPL_LOG_PASCAL_FIELDS.values()))
        log = bytearray(log_offset + 2)
        log[log_offset] = 255
        for index, (settings, extra) in enumerate([
            (b"\x77", {}), (full[:-1], {}),
            (full, {"include_log": True, "log_payload": bytes(log)}),
        ]):
            path = write_gcpl_mpr(Path(self.temp.name) / f"nested-{index}.mpr", rows(), settings_payload=settings, **extra)
            with self.subTest(index=index):
                with self.assertRaises(parsing.SourceFormatError):
                    parsing.parse_timeseries(path, read_mode="permissive")
                with self.assertRaises(parsing.SourceFormatError):
                    parsing.metadata_for_read_mode(path, parsing.read_header_metadata(path), "permissive")

    def test_requested_mode_and_actual_verified_science_are_distinct(self):
        values = rows()
        values[2].update(total_time_s=12., error=False)
        values[3]["total_time_s"] = 13.
        path = write_gcpl_mpr(Path(self.temp.name) / "verified.mpr", values,
                              settings_payload=encode_gcpl_settings([{"current": 1.}, {"current": -1.}]))
        metadata = parsing.metadata_for_read_mode(path, parsing.read_header_metadata(path), "permissive")
        self.assertEqual(parsing.source_interpretation(metadata), "pending")
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()
        self.addCleanup(engine.dispose)
        self.addCleanup(session.close)
        source = scanner.ingest_path(session, path, parse_now=True, read_mode="permissive")
        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(parsing.source_interpretation(source), "verified")
        self.assertFalse(parsing.source_is_exploratory(source))
        self.assertEqual(source.cycle_count, 1)
        cell = Cell(id=123, name="Verified permissive")
        context = SimpleNamespace(units=[{"cell": cell}], cells=[cell], files_by_cell={123: [source]})
        self.assertIsNone(analysis_engine.protocol_analysis_guard(session, {}, "steps", request_context=context))
        source.parse_status = "error"
        source.parser_version = parsing.current_parser_identity_for_extension("mpr")
        self.assertEqual(parsing.source_interpretation(source), "unavailable")

    def test_tiny_native_clock_regression_starts_a_display_segment(self):
        values = rows()
        values[2]["total_time_s"] = 11. - 5e-7
        values[3]["total_time_s"] = 12.
        path = write_gcpl_mpr(Path(self.temp.name) / "tiny.mpr", values,
                              settings_payload=encode_gcpl_settings([{"current": 1.}, {"current": -1.}]))
        frame = parsing.parse_timeseries(path, read_mode="permissive")
        self.assertEqual(frame.mpr_acquisition_segment.tolist(), [1, 1, 2, 2])
        self.assertTrue((frame.time_s >= 0).all())

    def test_ocv_fallback_preserves_technique_primary_voltage_with_extra_electrodes(self):
        from app.services.biologic_mpr import MPR_MAGIC, VMP_DATA_RECORD_OFFSET
        from tests.biologic_mpr_fixture import _module
        ids = (1, 3, 4, 174, 6, 9)
        header = struct.pack("<IB", 2, len(ids)) + struct.pack(">6H", *ids)

        def write(name, times):
            data = header.ljust(VMP_DATA_RECORD_OFFSET, b"\0") + b"".join(
                struct.pack("<Bdfff", 3, time, 3.3, .7, .5) for time in times)
            path = Path(self.temp.name) / name
            path.write_bytes(MPR_MAGIC + _module(short_name=b"VMP Set", long_name=b"VMP settings",
                                                payload=b"\x0bverified OCV", version=10)
                             + _module(short_name=b"VMP data", long_name=b"VMP data", payload=data, version=11))
            return path

        clean = write("clean-ocv.mpr", [10., 11.])
        regressed = write("regressed-ocv.mpr", [10., 9.])
        safe = parsing.parse_timeseries(clean)
        fallback = parsing.parse_timeseries(regressed, read_mode="permissive")
        np.testing.assert_array_equal(safe.voltage_v, fallback.voltage_v)
        np.testing.assert_allclose(fallback.voltage_v, [3.3, 3.3])
        self.assertNotIn("working_potential_v", fallback)
        self.assertNotIn("counter_potential_v", fallback)
        self.assertEqual(fallback.mpr_acquisition_segment.tolist(), [1, 2])
        metadata = parsing.read_header_metadata(regressed)
        permissive = parsing.metadata_for_read_mode(regressed, metadata, "permissive")
        self.assertEqual(metadata["voltage_capabilities"], permissive["voltage_capabilities"])

    def test_overlapping_mode_writers_remain_protected_until_both_finish(self):
        values = rows()
        values[2].update(total_time_s=12., error=False)
        values[3]["total_time_s"] = 13.
        path = write_gcpl_mpr(Path(self.temp.name) / "concurrent.mpr", values,
                              settings_payload=encode_gcpl_settings([{"current": 1.}, {"current": -1.}]))
        frame = parsing.parse_timeseries(path)
        fingerprint = parsing.capture_source_fingerprint(path)
        barrier = threading.Barrier(2)
        entered = {mode: threading.Event() for mode in ("safe", "permissive")}
        release = {mode: threading.Event() for mode in entered}

        def parse(*args, **kwargs):
            barrier.wait(timeout=10)
            return frame.copy(deep=True)

        def publish(raw, target, identity):
            mode = "permissive" if identity.endswith(":p1") else "safe"
            entered[mode].set()
            if not release[mode].wait(10):
                raise AssertionError("blocked test writer was not released")

        cache_root = Path(self.temp.name) / "concurrent-cache"
        with patch.object(cache, "CACHE_DIR", cache_root), patch.object(parsing, "parse_timeseries", side_effect=parse), \
             patch.object(cache, "_publish_optimized_raw", side_effect=publish), \
             patch.object(cache, "prepare_time_capacity_derived"), ThreadPoolExecutor(max_workers=3) as pool:
            try:
                futures = [pool.submit(cache.build_write_behind, fingerprint.hash, path, read_mode=mode) for mode in entered]
                for future in futures:
                    future.result(timeout=10)
                self.assertTrue(all(event.wait(10) for event in entered.values()))
                release["safe"].set()
                waiter = pool.submit(cache.wait_for_pending, fingerprint.hash)
                # The completed Safe writer must not clear the live Permissive owner.
                with self.assertRaises(TimeoutError):
                    waiter.result(timeout=.1)
                self.assertIn(fingerprint.hash, cache.pending_hashes())
                release["permissive"].set()
                waiter.result(timeout=10)
                self.assertNotIn(fingerprint.hash, cache.pending_hashes())
            finally:
                for event in release.values():
                    event.set()
                cache.wait_for_pending(fingerprint.hash)


if __name__ == "__main__":
    unittest.main()
