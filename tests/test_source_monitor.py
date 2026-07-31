import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import AppSetting, Cell, SourceFile, Test, TestFile
from app.routers import library
from app.routers import settings as settings_router
from app.services import analysis_engine, background_jobs, parsing, scanner, source_monitor


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
                retry_delay_seconds=60,
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
                retry_delay_seconds=60,
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
            "retry_delay_value": 7,
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
        self.assertEqual(loaded["retry_delay_value"], 7)


class SourceMonitorScheduleTests(unittest.TestCase):
    """Spec 027: weekly schedules, retry-delay units, and the legacy upgrade path."""

    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_a_config_written_by_an_older_build_keeps_its_schedule(self):
        db = self.make_session()
        # Exactly what 0.17.0-beta.5 and earlier persisted.
        db.add(
            AppSetting(
                key=source_monitor.CONFIG_KEY,
                value=json.dumps(
                    {
                        "enabled": True,
                        "schedule_mode": "daily",
                        "daily_every_days": 3,
                        "daily_time": "04:30",
                        "retry_count": 4,
                        "retry_delay_minutes": 15,
                    }
                ),
            )
        )
        db.commit()

        loaded = source_monitor.load_config(db)

        self.assertEqual(loaded["schedule_mode"], "scheduled")
        self.assertEqual(loaded["scheduled_every_value"], 3)
        self.assertEqual(loaded["scheduled_every_unit"], "days")
        self.assertEqual(loaded["retry_delay_value"], 15)
        self.assertEqual(loaded["retry_delay_unit"], "minutes")
        self.assertEqual(source_monitor.retry_delay_seconds(loaded), 900)
        # The dropped keys must not leak through, or save_config would round-trip them.
        self.assertNotIn("daily_every_days", loaded)
        self.assertNotIn("retry_delay_minutes", loaded)

    def test_a_new_style_key_wins_over_its_legacy_counterpart(self):
        upgraded = source_monitor.upgrade_config(
            {"daily_every_days": 3, "scheduled_every_value": 2, "scheduled_every_unit": "weeks"}
        )
        self.assertEqual(upgraded["scheduled_every_value"], 2)
        self.assertEqual(upgraded["scheduled_every_unit"], "weeks")

    def test_weekly_schedules_advance_seven_days_per_unit(self):
        config = {
            **source_monitor.DEFAULT_CONFIG,
            "schedule_mode": "scheduled",
            "scheduled_every_value": 2,
            "scheduled_every_unit": "weeks",
            "daily_time": "02:00",
        }
        self.assertEqual(source_monitor.scheduled_step_days(config), 14)
        # Compare local calendar dates: `daily_time` is a local wall-clock time, so
        # anchoring the test to a UTC instant would be off by the UTC offset.
        first = source_monitor.calculate_next_run(config).astimezone()
        second = source_monitor.following_scheduled_run(config, first).astimezone()
        self.assertEqual((second.date() - first.date()).days, 14)
        self.assertEqual((first.hour, first.minute), (2, 0))

    def test_tracked_tail_scope_captures_one_final_source_per_cell(self):
        db = self.make_session()
        cell = Cell(name="Continued", cycling_status="active")
        first = SourceFile(hash="tail-old", path="C:/data/old.ndax", filename="old.ndax", size=1, ext="ndax")
        tail = SourceFile(hash="tail-new", path="C:/data/new.ndax", filename="new.ndax", size=1, ext="ndax")
        db.add_all([cell, first, tail])
        db.flush()
        test = Test(cell_id=cell.id, name="Imported file")
        db.add(test)
        db.flush()
        db.add_all([
            TestFile(test_id=test.id, file_id=first.id, position=0),
            TestFile(test_id=test.id, file_id=tail.id, position=1),
        ])
        db.commit()

        class DeferredThread:
            def __init__(self, *args, **kwargs):
                pass

            def start(self):
                pass

        original_thread = library._JobThread
        background_jobs.clear_jobs()
        with library._source_check_job_lock:
            library._source_check_jobs.clear()
            library._latest_source_check_job_id = None
            library._next_source_check_job_id = 1
        try:
            library._JobThread = DeferredThread
            job = library.start_source_check_job(
                db,
                source_scope="tracked_tails",
                trigger="scheduled",
            )
        finally:
            library._JobThread = original_thread
            background_jobs.clear_jobs()
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
                library._next_source_check_job_id = 1

        self.assertEqual(job["source_scope"], "tracked_tails")
        self.assertEqual(job["source_cell_ids"], [cell.id])
        self.assertEqual(job["total"], 1)
        self.assertEqual(job["files"][0]["file_id"], tail.id)

    def test_tracked_tail_scope_rejects_multiple_internal_rows(self):
        db = self.make_session()
        cell = Cell(name="Legacy chain", cycling_status="active")
        first = SourceFile(hash="legacy-old", path="C:/data/legacy-old.ndax", filename="legacy-old.ndax", size=1, ext="ndax")
        final = SourceFile(hash="legacy-final", path="C:/data/legacy-final.ndax", filename="legacy-final.ndax", size=1, ext="ndax")
        db.add_all([cell, first, final])
        db.flush()
        internal_a = Test(cell_id=cell.id, name="Imported file")
        internal_b = Test(cell_id=cell.id, name="Compatibility row")
        db.add_all([internal_a, internal_b])
        db.flush()
        db.add_all([
            TestFile(test_id=internal_a.id, file_id=first.id, position=0),
            TestFile(test_id=internal_b.id, file_id=final.id, position=0),
        ])
        db.commit()

        background_jobs.clear_jobs()
        with library._source_check_job_lock:
            library._source_check_jobs.clear()
            library._latest_source_check_job_id = None
            library._next_source_check_job_id = 1
        try:
            with self.assertRaises(analysis_engine.CellSourceChainInvariantError) as context:
                library.start_source_check_job(
                    db,
                    source_scope="tracked_tails",
                    trigger="scheduled",
                )
        finally:
            background_jobs.clear_jobs()
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
                library._next_source_check_job_id = 1

        self.assertEqual(context.exception.detail["code"], "single_internal_test_required")
        self.assertEqual(context.exception.detail["cell_id"], cell.id)

    def test_daily_schedules_are_unchanged_by_the_unit(self):
        config = {
            **source_monitor.DEFAULT_CONFIG,
            "schedule_mode": "scheduled",
            "scheduled_every_value": 3,
            "scheduled_every_unit": "days",
        }
        self.assertEqual(source_monitor.scheduled_step_days(config), 3)

    def test_retry_delay_resolves_every_unit_to_seconds(self):
        base = dict(source_monitor.DEFAULT_CONFIG)
        cases = [("seconds", 30, 30), ("minutes", 5, 300), ("hours", 2, 7_200)]
        for unit, value, expected in cases:
            with self.subTest(unit=unit):
                config = {**base, "retry_delay_unit": unit, "retry_delay_value": value}
                self.assertEqual(source_monitor.retry_delay_seconds(config), expected)

    def test_schedule_period_covers_both_modes(self):
        interval = {**source_monitor.DEFAULT_CONFIG, "interval_value": 6, "interval_unit": "hours"}
        self.assertEqual(source_monitor.schedule_period_seconds(interval), 21_600)

        weekly = {
            **source_monitor.DEFAULT_CONFIG,
            "schedule_mode": "scheduled",
            "scheduled_every_value": 1,
            "scheduled_every_unit": "weeks",
        }
        self.assertEqual(source_monitor.schedule_period_seconds(weekly), 7 * 86_400)


class SourceMonitorValidationTests(unittest.TestCase):
    """Spec 027 T3/T4: the frequency cap and the schedule preview."""

    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def payload(self, **overrides):
        return settings_router.SourceMonitoringSettings(**overrides)

    def test_retries_that_outlast_the_check_interval_are_rejected(self):
        db = self.make_session()
        payload = self.payload(
            enabled=True,
            interval_value=1,
            interval_unit="hours",
            retry_count=10,
            retry_delay_value=1,
            retry_delay_unit="hours",
        )
        with self.assertRaises(HTTPException) as caught:
            settings_router.update_source_monitor_settings(payload, db=db)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("does not fit inside", caught.exception.detail)
        # Nothing may be persisted by a rejected save.
        self.assertIsNone(db.get(AppSetting, source_monitor.CONFIG_KEY))

    def test_duration_labels_read_naturally(self):
        label = settings_router._duration_label
        self.assertEqual(label(30), "30 s")
        self.assertEqual(label(300), "5 min")
        self.assertEqual(label(3_600), "1 h")
        self.assertEqual(label(5_400), "1 h 30 min")
        # 1440 minutes is exactly one day; "1 days" showed up in the UI.
        self.assertEqual(label(86_400), "1 day")
        self.assertEqual(label(864_000), "10 days")

    def test_a_retry_span_that_fits_is_accepted(self):
        db = self.make_session()
        payload = self.payload(
            enabled=True,
            interval_value=6,
            interval_unit="hours",
            retry_count=3,
            retry_delay_value=5,
            retry_delay_unit="minutes",
        )
        saved = settings_router.update_source_monitor_settings(payload, db=db)
        self.assertEqual(saved["retry_delay_value"], 5)
        self.assertEqual(saved["retry_delay_unit"], "minutes")

    def test_sub_ten_second_retry_delays_are_rejected(self):
        db = self.make_session()
        payload = self.payload(retry_delay_value=2, retry_delay_unit="seconds")
        with self.assertRaises(HTTPException) as caught:
            settings_router.update_source_monitor_settings(payload, db=db)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("at least", caught.exception.detail)

    def test_a_thirty_second_retry_delay_is_allowed(self):
        db = self.make_session()
        payload = self.payload(
            enabled=True, retry_count=3, retry_delay_value=30, retry_delay_unit="seconds"
        )
        saved = settings_router.update_source_monitor_settings(payload, db=db)
        self.assertEqual(saved["retry_delay_unit"], "seconds")

    def test_preview_returns_three_increasing_interval_runs(self):
        preview = settings_router.preview_source_monitor_schedule(
            self.payload(interval_value=6, interval_unit="hours")
        )
        runs = [datetime.fromisoformat(value) for value in preview.runs]
        self.assertEqual(len(runs), 3)
        self.assertEqual((runs[1] - runs[0]).total_seconds(), 21_600)
        self.assertEqual((runs[2] - runs[1]).total_seconds(), 21_600)

    def test_preview_spaces_weekly_runs_fourteen_days_apart(self):
        preview = settings_router.preview_source_monitor_schedule(
            self.payload(
                schedule_mode="scheduled",
                scheduled_every_value=2,
                scheduled_every_unit="weeks",
                daily_time="02:00",
            )
        )
        runs = [datetime.fromisoformat(value).astimezone() for value in preview.runs]
        self.assertEqual((runs[1] - runs[0]).days, 14)
        self.assertEqual((runs[2] - runs[1]).days, 14)
        for run in runs:
            self.assertEqual((run.hour, run.minute), (2, 0))

    def test_preview_reports_the_same_error_a_save_would(self):
        with self.assertRaises(HTTPException) as caught:
            settings_router.preview_source_monitor_schedule(
                self.payload(
                    interval_value=1,
                    interval_unit="hours",
                    retry_count=10,
                    retry_delay_value=1,
                    retry_delay_unit="hours",
                )
            )
        self.assertEqual(caught.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
