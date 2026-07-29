from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
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
            state_db.close()


if __name__ == "__main__":
    unittest.main()
