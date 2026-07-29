from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import SourceFile
from app.services import background_jobs, scanner, scientific_preparation


class ScientificPreparationTests(unittest.TestCase):
    def setUp(self):
        background_jobs.clear_jobs()
        scanner._capacity_backfill_running = False
        scanner._capacity_backfill_job_id = None
        scanner._capacity_backfill_adaptive = False
        scanner._capacity_backfill_foreground_active = False
        scanner._capacity_backfill_background_requested.clear()
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(
            bind=self.engine,
            autoflush=False,
            expire_on_commit=False,
        )

    def tearDown(self):
        scanner._capacity_backfill_running = False
        scanner._capacity_backfill_job_id = None
        scanner._capacity_backfill_adaptive = False
        scanner._capacity_backfill_foreground_active = False
        scanner._capacity_backfill_background_requested.clear()
        background_jobs.clear_jobs()
        self.engine.dispose()

    def _source(self, db, path: Path, *, summary_status: str = "pending") -> SourceFile:
        payload = path.read_bytes()
        source = SourceFile(
            hash=hashlib.sha256(payload).hexdigest(),
            path=str(path),
            filename=path.name,
            size=len(payload),
            ext="ndax",
            parse_status="parsed",
            parser_version="1",
            capacity_summary_status=summary_status,
        )
        db.add(source)
        db.commit()
        return source

    def test_missing_cache_is_rebuilt_and_summary_becomes_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            source_path = Path(folder) / "cell.ndax"
            source_path.write_bytes(b"stable source bytes")
            db = self.factory()
            source = self._source(db, source_path)
            scientific_preparation.set_state(db, "pending", reason="stable-copy")
            db.commit()
            job_id = background_jobs.create_job(
                kind="scientific_preparation",
                title="Preparing copied library",
                description="Preparing one source",
                total=1,
                items=[{"id": source.id, "label": source.filename}],
            )
            db.close()

            info = {
                "rows": 100,
                "cycles": 4,
                "parser_version": "current",
                "calc_version": "current",
                "total_charge_capacity_mah": 12.5,
                "total_discharge_capacity_mah": 12.1,
                "max_discharge_capacity_mah": 3.2,
            }
            with (
                patch.object(scanner, "SessionLocal", self.factory),
                patch.object(scanner.cache, "load_cycles", return_value=None),
                patch.object(scanner.cache, "raw_path") as raw_path,
                patch.object(scanner.cache, "build", return_value=info),
            ):
                raw_path.return_value.is_file.return_value = False
                scanner._capacity_backfill_running = True
                scanner._capacity_backfill_job_id = job_id
                scanner._run_capacity_summary_backfill(
                    [source.id],
                    job_id,
                    True,
                )

            verify = self.factory()
            refreshed = verify.get(SourceFile, source.id)
            self.assertEqual(refreshed.capacity_summary_status, "ready")
            self.assertEqual(refreshed.max_discharge_capacity_mah, 3.2)
            self.assertEqual(
                scientific_preparation.get_state(verify)["status"],
                "complete",
            )
            self.assertEqual(background_jobs.get_job(job_id)["counters"]["ready"], 1)
            verify.close()

    def test_normal_startup_does_not_recreate_cleaned_ready_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            source_path = Path(folder) / "cell.ndax"
            source_path.write_bytes(b"source")
            db = self.factory()
            self._source(db, source_path, summary_status="ready")
            db.close()

            with (
                patch.object(scanner, "SessionLocal", self.factory),
                patch.object(scanner, "_has_current_scientific_cache", return_value=False),
            ):
                result = scanner.start_capacity_summary_backfill()

            self.assertEqual(result["total"], 0)
            self.assertFalse(scanner._capacity_backfill_running)

    def test_pending_copy_includes_ready_sources_with_missing_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            source_path = Path(folder) / "cell.ndax"
            source_path.write_bytes(b"source")
            db = self.factory()
            self._source(db, source_path, summary_status="ready")
            scientific_preparation.set_state(db, "pending", reason="stable-copy")
            db.commit()
            db.close()

            with (
                patch.object(scanner, "SessionLocal", self.factory),
                patch.object(scanner, "_has_current_scientific_cache", return_value=False),
                patch.object(scanner.threading, "Thread") as thread,
            ):
                result = scanner.start_capacity_summary_backfill()

            self.assertEqual(result["total"], 1)
            thread.return_value.start.assert_called_once_with()
            state_db = self.factory()
            self.assertEqual(
                scientific_preparation.get_state(state_db)["status"],
                "running",
            )
            job = background_jobs.get_job(result["id"])
            self.assertEqual(job["resource_mode"], "foreground")
            self.assertEqual(job["workers"], 1)
            state_db.close()

    def test_manual_prepare_missing_stays_serial_background_work(self):
        with tempfile.TemporaryDirectory() as folder:
            source_path = Path(folder) / "manual.ndax"
            source_path.write_bytes(b"manual source")
            db = self.factory()
            self._source(db, source_path, summary_status="ready")
            db.close()

            with (
                patch.object(scanner, "SessionLocal", self.factory),
                patch.object(scanner, "_has_current_scientific_cache", return_value=False),
                patch.object(scanner.threading, "Thread") as thread,
            ):
                result = scanner.start_capacity_summary_backfill(prepare_missing=True)

            thread.return_value.start.assert_called_once_with()
            job = background_jobs.get_job(result["id"])
            self.assertEqual(job["resource_mode"], "background")
            self.assertEqual(job["workers"], 1)
            self.assertFalse(scanner._capacity_backfill_adaptive)

    def test_foreground_worker_count_is_bounded_by_half_the_cpus_and_four(self):
        self.assertEqual(
            scanner.scientific_preparation_worker_count(12, logical_cpus=16),
            4,
        )
        self.assertEqual(
            scanner.scientific_preparation_worker_count(12, logical_cpus=6),
            3,
        )
        self.assertEqual(
            scanner.scientific_preparation_worker_count(12, logical_cpus=2),
            1,
        )
        self.assertEqual(
            scanner.scientific_preparation_worker_count(1, logical_cpus=16),
            1,
        )

    def test_single_source_worker_is_process_safe_and_does_not_touch_sqlite(self):
        with tempfile.TemporaryDirectory() as folder:
            source_job = {
                "id": 1,
                "hash": "f" * 64,
                "path": str(Path(folder) / "missing.ndax"),
                "size": 0,
                "filename": "missing.ndax",
                "summary_was_ready": False,
                "prepare_all_missing": True,
            }
            with ProcessPoolExecutor(max_workers=1) as executor:
                result = executor.submit(
                    scanner._prepare_capacity_source_worker,
                    source_job,
                ).result(timeout=20)

        self.assertFalse(result["ok"])
        self.assertEqual(result["location_status"], "offline")

    def test_background_request_is_one_way_and_updates_job_diagnostics(self):
        job_id = background_jobs.create_job(
            kind="scientific_preparation",
            title="Preparing copied library",
            description="Preparing sources",
            total=3,
        )
        scanner._capacity_backfill_running = True
        scanner._capacity_backfill_adaptive = True
        scanner._capacity_backfill_foreground_active = True
        scanner._capacity_backfill_job_id = job_id

        result = scanner.request_capacity_backfill_background()

        self.assertEqual(
            result,
            {
                "jobId": job_id,
                "resourceMode": "background",
                "workers": 1,
                "transitionPending": True,
            },
        )
        self.assertTrue(scanner._capacity_backfill_background_requested.is_set())
        snapshot = background_jobs.get_job(job_id)
        self.assertEqual(snapshot["resource_mode"], "background")
        self.assertTrue(snapshot["transition_pending"])

    def test_non_copied_preparation_cannot_be_promoted_or_switched(self):
        scanner._capacity_backfill_running = True
        scanner._capacity_backfill_adaptive = False
        scanner._capacity_backfill_job_id = 999

        self.assertIsNone(scanner.request_capacity_backfill_background())
        self.assertFalse(scanner._capacity_backfill_background_requested.is_set())

    def test_adaptive_scheduler_drains_then_runs_remaining_sources_serially(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.factory()
            sources = []
            for index in range(4):
                path = Path(folder) / f"cell-{index}.ndax"
                path.write_bytes(f"source-{index}".encode())
                sources.append(self._source(db, path))
            job_id = background_jobs.create_job(
                kind="scientific_preparation",
                title="Preparing copied library",
                description="Preparing sources",
                total=len(sources),
                items=[{"id": source.id, "label": source.filename} for source in sources],
            )
            calls: list[tuple[int, str]] = []
            foreground_barrier = threading.Barrier(2)

            def worker(source_job):
                thread_name = threading.current_thread().name
                calls.append((source_job["id"], thread_name))
                if "ThreadPoolExecutor" in thread_name:
                    foreground_barrier.wait(timeout=5)
                    scanner._capacity_backfill_background_requested.set()
                return {
                    "ok": True,
                    "built": False,
                    "info": {
                        "total_charge_capacity_mah": 1.0,
                        "total_discharge_capacity_mah": 0.9,
                        "max_discharge_capacity_mah": 0.9,
                    },
                    "location_status": None,
                }

            with (
                patch.object(scanner, "ProcessPoolExecutor", ThreadPoolExecutor),
                patch.object(scanner, "scientific_preparation_worker_count", return_value=2),
                patch.object(scanner, "_prepare_capacity_source_worker", side_effect=worker),
            ):
                ready, failed = scanner._run_adaptive_capacity_preparation(
                    db,
                    [source.id for source in sources],
                    job_id,
                    True,
                )

            self.assertEqual((ready, failed), (4, 0))
            foreground_calls = [
                source_id for source_id, name in calls if "ThreadPoolExecutor" in name
            ]
            serial_calls = [
                source_id for source_id, name in calls if "ThreadPoolExecutor" not in name
            ]
            self.assertEqual(len(foreground_calls), 2)
            self.assertEqual(len(serial_calls), 2)
            snapshot = background_jobs.get_job(job_id)
            self.assertEqual(snapshot["resource_mode"], "background")
            self.assertEqual(snapshot["workers"], 1)
            self.assertFalse(snapshot["transition_pending"])
            db.close()

    def test_foreground_pool_failure_falls_back_to_serial(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.factory()
            sources = []
            for index in range(2):
                path = Path(folder) / f"fallback-{index}.ndax"
                path.write_bytes(f"fallback-{index}".encode())
                sources.append(self._source(db, path))
            job_id = background_jobs.create_job(
                kind="scientific_preparation",
                title="Preparing copied library",
                description="Preparing sources",
                total=len(sources),
                items=[{"id": source.id, "label": source.filename} for source in sources],
            )

            class BrokenExecutor:
                def __init__(self, *args, **kwargs):
                    raise RuntimeError("pool unavailable")

            result = {
                "ok": True,
                "built": False,
                "info": {
                    "total_charge_capacity_mah": 1.0,
                    "total_discharge_capacity_mah": 0.9,
                    "max_discharge_capacity_mah": 0.9,
                },
                "location_status": None,
            }
            with (
                patch.object(scanner, "ProcessPoolExecutor", BrokenExecutor),
                patch.object(scanner, "scientific_preparation_worker_count", return_value=2),
                patch.object(scanner, "_prepare_capacity_source_worker", return_value=result),
            ):
                ready, failed = scanner._run_adaptive_capacity_preparation(
                    db,
                    [source.id for source in sources],
                    job_id,
                    True,
                )

            self.assertEqual((ready, failed), (2, 0))
            self.assertEqual(background_jobs.get_job(job_id)["completed"], 2)
            db.close()


if __name__ == "__main__":
    unittest.main()
