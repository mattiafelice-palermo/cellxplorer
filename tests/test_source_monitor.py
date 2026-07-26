import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Cell, SourceFile, Test, TestFile
from app.routers import library
from app.services import background_jobs, parsing, scanner, source_monitor


class ImmediateThread:
    def __init__(self, *, target, args=(), kwargs=None, **_):
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}

    def start(self):
        self.target(*self.args, **self.kwargs)


class SourceMonitorTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        return factory(), factory

    def reset_jobs(self):
        background_jobs.clear_jobs()
        with library._source_check_job_lock:
            library._source_check_jobs.clear()
            library._latest_source_check_job_id = None
            library._next_source_check_job_id = 1

    def test_metadata_scan_hashes_only_candidates_after_one_shared_wait(self):
        db, factory = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            unchanged_path = Path(tmp) / "unchanged.ndax"
            changed_path = Path(tmp) / "changed.ndax"
            unchanged_path.write_bytes(b"same")
            changed_path.write_bytes(b"new bytes")
            unchanged_stat = unchanged_path.stat()

            unchanged = SourceFile(
                hash="same-hash",
                path=str(unchanged_path),
                filename=unchanged_path.name,
                size=unchanged_stat.st_size,
                ext="ndax",
                observed_size=unchanged_stat.st_size,
                observed_mtime_ns=unchanged_stat.st_mtime_ns,
                location_status="online",
                parse_status="parsed",
            )
            changed = SourceFile(
                hash="old-hash",
                path=str(changed_path),
                filename=changed_path.name,
                size=1,
                ext="ndax",
                observed_size=1,
                observed_mtime_ns=1,
                location_status="online",
                parse_status="parsed",
            )
            cells = [Cell(name="A"), Cell(name="B")]
            db.add_all([*cells, unchanged, changed])
            db.flush()
            tests = [Test(cell_id=cells[0].id, name="A"), Test(cell_id=cells[1].id, name="B")]
            db.add_all(tests)
            db.flush()
            db.add_all(
                [
                    TestFile(test_id=tests[0].id, file_id=unchanged.id, position=0),
                    TestFile(test_id=tests[1].id, file_id=changed.id, position=0),
                ]
            )
            db.commit()

            hash_paths = []
            waits = []
            originals = (
                library.SessionLocal,
                library._JobThread,
                library.parsing.compute_hash,
                library._sleep,
            )
            self.reset_jobs()
            try:
                library.SessionLocal = factory
                library._JobThread = ImmediateThread
                library.parsing.compute_hash = lambda path: hash_paths.append(Path(path)) or "new-hash"
                library._sleep = waits.append
                job = library.start_source_check_job(
                    db,
                    scan_mode="metadata",
                    batch_size=50,
                    stability_seconds=5,
                    trigger="scheduled",
                    low_impact=True,
                )
            finally:
                (
                    library.SessionLocal,
                    library._JobThread,
                    library.parsing.compute_hash,
                    library._sleep,
                ) = originals

            self.assertEqual(job["status"], "completed")
            self.assertEqual(job["online"], 1)
            self.assertEqual(job["changed"], 1)
            self.assertEqual(job["hashed"], 1)
            self.assertEqual(hash_paths, [changed_path])
            self.assertEqual(waits, [5])
            self.reset_jobs()

    def test_stable_update_rejects_a_file_that_changes_during_hashing(self):
        db, _ = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "growing.ndax"
            path.write_bytes(b"first")
            stat = path.stat()
            source = SourceFile(
                hash="registered-hash",
                path=str(path),
                filename=path.name,
                size=stat.st_size,
                ext="ndax",
                location_status="changed",
                parse_status="parsed",
            )
            db.add(source)
            db.commit()
            original_hash = parsing.compute_hash

            def change_during_hash(_):
                path.write_bytes(b"file grew while hashing")
                return "new-hash"

            parsing.compute_hash = change_during_hash
            try:
                with self.assertRaises(scanner.SourceChangedDuringRead):
                    scanner.update_source_from_path_if_stable(
                        db,
                        source,
                        expected_size=stat.st_size,
                        expected_mtime_ns=stat.st_mtime_ns,
                    )
            finally:
                parsing.compute_hash = original_hash

            self.assertEqual(source.hash, "registered-hash")
            self.assertEqual(source.location_status, "changed")

    def test_deferred_source_is_retried_without_rescanning_other_files(self):
        db, factory = self.make_session()
        source = SourceFile(
            hash="old-hash",
            path="C:/data/growing.ndax",
            filename="growing.ndax",
            size=1,
            ext="ndax",
            observed_size=1,
            observed_mtime_ns=1,
            location_status="online",
            parse_status="parsed",
        )
        cell = Cell(name="Growing")
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Growing")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.commit()

        stat_results = iter(
            [
                {"id": source.id, "location_status": "online", "size": 2, "mtime_ns": 2},
                {"id": source.id, "location_status": "online", "size": 3, "mtime_ns": 3},
                {"id": source.id, "location_status": "online", "size": 3, "mtime_ns": 3},
                {"id": source.id, "location_status": "online", "size": 3, "mtime_ns": 3},
                {"id": source.id, "location_status": "online", "size": 3, "mtime_ns": 3},
            ]
        )
        waits = []
        originals = (
            library.SessionLocal,
            library._JobThread,
            library._source_stat_worker,
            library.parsing.compute_hash,
            library._sleep,
        )
        self.reset_jobs()
        try:
            library.SessionLocal = factory
            library._JobThread = ImmediateThread
            library._source_stat_worker = lambda _: next(stat_results)
            library.parsing.compute_hash = lambda _: "new-hash"
            library._sleep = waits.append
            job = library.start_source_check_job(
                db,
                scan_mode="metadata",
                stability_seconds=5,
                trigger="scheduled",
                retry_count=3,
                retry_delay_minutes=1,
                retry_deadline_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            )
        finally:
            (
                library.SessionLocal,
                library._JobThread,
                library._source_stat_worker,
                library.parsing.compute_hash,
                library._sleep,
            ) = originals

        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["retry_attempt"], 1)
        self.assertEqual(job["deferred"], 0)
        self.assertEqual(job["changed"], 1)
        self.assertEqual(job["files"][0]["status"], "changed")
        self.assertEqual(waits, [5, 60, 5])
        db.expire_all()
        self.assertEqual(db.get(SourceFile, source.id).location_status, "changed")
        self.reset_jobs()

    def test_retries_stop_before_the_next_scheduled_check(self):
        db, factory = self.make_session()
        source = SourceFile(
            hash="old-hash",
            path="C:/data/growing.ndax",
            filename="growing.ndax",
            size=1,
            ext="ndax",
            observed_size=1,
            observed_mtime_ns=1,
            location_status="online",
            parse_status="parsed",
        )
        cell = Cell(name="Growing")
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Growing")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.commit()

        stat_results = iter(
            [
                {"id": source.id, "location_status": "online", "size": 2, "mtime_ns": 2},
                {"id": source.id, "location_status": "online", "size": 3, "mtime_ns": 3},
            ]
        )
        waits = []
        originals = (
            library.SessionLocal,
            library._JobThread,
            library._source_stat_worker,
            library._sleep,
        )
        self.reset_jobs()
        try:
            library.SessionLocal = factory
            library._JobThread = ImmediateThread
            library._source_stat_worker = lambda _: next(stat_results)
            library._sleep = waits.append
            job = library.start_source_check_job(
                db,
                scan_mode="metadata",
                stability_seconds=5,
                trigger="scheduled",
                retry_count=3,
                retry_delay_minutes=1,
                retry_deadline_at=(datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
            )
        finally:
            (
                library.SessionLocal,
                library._JobThread,
                library._source_stat_worker,
                library._sleep,
            ) = originals

        self.assertEqual(job["deferred"], 1)
        self.assertEqual(job["retry_attempt"], 0)
        self.assertEqual(job["retries_stopped"], "next_scheduled_check")
        self.assertEqual(waits, [5])
        db.expire_all()
        self.assertEqual(db.get(SourceFile, source.id).location_status, "changing")
        self.reset_jobs()

    def test_monitor_interval_and_stability_units(self):
        config = {
            **source_monitor.DEFAULT_CONFIG,
            "interval_value": 3,
            "interval_unit": "hours",
            "stability_value": 2,
            "stability_unit": "minutes",
        }
        start = datetime(2026, 7, 14, 10, 0, tzinfo=timezone.utc)
        self.assertEqual(
            source_monitor.calculate_next_run(config, start),
            datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(source_monitor.stability_seconds(config), 120)
        self.assertEqual(
            source_monitor.following_scheduled_run(config, start),
            datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc),
        )

    def test_cell_summary_exposes_a_changing_source(self):
        db, _ = self.make_session()
        cell = Cell(name="Still cycling")
        source = SourceFile(
            hash="hash",
            path="C:/data/growing.ndax",
            filename="growing.ndax",
            size=1,
            ext="ndax",
            location_status="changing",
            parse_status="parsed",
        )
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Growing")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.commit()

        payload = library.cell_dict(db, cell)

        self.assertTrue(payload["has_changing"])
        self.assertFalse(payload["has_changed"])

    def test_monitor_settings_persist_batch_and_stability_configuration(self):
        db, _ = self.make_session()
        config = {
            **source_monitor.DEFAULT_CONFIG,
            "enabled": True,
            "scan_batch_size": 250,
            "stability_value": 2,
            "stability_unit": "minutes",
            "auto_update": True,
            "retry_count": 4,
            "retry_delay_minutes": 7,
        }

        saved = source_monitor.save_config(db, config)
        loaded = source_monitor.load_config(db)

        self.assertTrue(saved["enabled"])
        self.assertIsNotNone(saved["next_run_at"])
        self.assertEqual(loaded["scan_batch_size"], 250)
        self.assertEqual(loaded["stability_value"], 2)
        self.assertEqual(loaded["stability_unit"], "minutes")
        self.assertTrue(loaded["auto_update"])
        self.assertEqual(loaded["retry_count"], 4)
        self.assertEqual(loaded["retry_delay_minutes"], 7)


if __name__ == "__main__":
    unittest.main()
