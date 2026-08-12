import sys
import tempfile
import unittest
import os
import shutil
from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pandas as pd
from fastapi import HTTPException
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Cell, CellMetadata, ImportSubmission, SourceFile, Test, TestFile
from app.routers import files
from app.routers import library
from app.services import cache, parsing
from app.services import background_jobs
from app.services import import_inspection


IMPORT_RECORD_HEADERS = [
    "DataPoint",
    "Cycle Index",
    "Step Index",
    "Step Type",
    "Time(min)",
    "Total Time(min)",
    "Current(mA)",
    "Voltage(V)",
    "Chg. Cap.(mAh)",
    "DChg. Cap.(mAh)",
    "Date",
    "Power(W)",
]


def _write_importable_neware_workbook(path: Path) -> None:
    workbook = Workbook()
    record = workbook.active
    record.title = "record"
    record.append(IMPORT_RECORD_HEADERS)
    start = datetime(2026, 1, 1, 12, 0, 0)
    rows = [
        (1, 1, 1, "Rest", 0.0, 0.0, 0.0, 3.5, 0.0, 0.0),
        (2, 1, 1, "Rest", 1.0, 1.0, 0.0, 3.5, 0.0, 0.0),
        (3, 1, 2, "CC Chg", 0.0, 1.0, 1.0, 3.5, 0.0, 0.0),
        (4, 1, 2, "CC Chg", 1.0, 2.0, 1.0, 3.7, 1.0, 0.0),
        (5, 1, 3, "CC DChg", 0.0, 2.0, -1.0, 3.7, 0.0, 0.0),
        (6, 1, 3, "CC DChg", 1.0, 3.0, -1.0, 3.0, 0.0, 1.0),
        (7, 2, 1, "Rest", 0.0, 3.0, 0.0, 3.0, 0.0, 0.0),
        (8, 2, 1, "Rest", 1.0, 4.0, 0.0, 3.0, 0.0, 0.0),
    ]
    for data_point, cycle, step_index, status, time_min, total_time_min, current, voltage, charge, discharge in rows:
        record.append(
            [
                data_point,
                cycle,
                step_index,
                status,
                time_min,
                total_time_min,
                current,
                voltage,
                charge,
                discharge,
                start + timedelta(minutes=total_time_min),
                voltage * current / 1000.0,
            ]
        )
    workbook.save(path)


class ImportFlowTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_import_filename_allows_only_neware_files(self):
        self.assertTrue(files.import_filename_allowed("formation.ndax"))
        self.assertTrue(files.import_filename_allowed("cycling.NDA"))
        self.assertTrue(files.import_filename_allowed("formation.xlsx"))
        self.assertTrue(files.import_filename_allowed("cycling.XLSX"))
        self.assertFalse(files.import_filename_allowed("notes.csv"))
        self.assertFalse(files.import_filename_allowed("legacy.xls"))
        self.assertFalse(files.import_filename_allowed("legacy.xlsm"))
        self.assertFalse(files.import_filename_allowed(""))

    def test_xlsx_inspection_requires_the_neware_record_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            valid = root / "formation.xlsx"
            _write_importable_neware_workbook(valid)
            inspected = import_inspection.inspect_file(str(valid))

            self.assertEqual(inspected.ext, "xlsx")
            self.assertEqual(inspected.metadata["source_format"], "Neware Excel")
            self.assertIsNotNone(
                import_inspection.cached_header_metadata(
                    inspected.hash,
                    inspected.size,
                    inspected.mtime_ns,
                )
            )

            unrelated = root / "unrelated.xlsx"
            Workbook().save(unrelated)
            with self.assertRaisesRegex(ValueError, "Not a recognized Neware Excel export"):
                import_inspection.inspect_file(str(unrelated))

    def test_folder_listing_is_recursive_and_filters_non_neware_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / "batch" / "nested"
            nested.mkdir(parents=True)
            (root / "root.nda").write_bytes(b"root")
            (root / "export.xlsx").write_bytes(b"export")
            (nested / "cell.ndax").write_bytes(b"nested")
            (nested / "notes.csv").write_text("ignore", encoding="ascii")

            result = files.list_import_folder_files(root)

        self.assertEqual(
            [item["relative_path"] for item in result["files"]],
            ["export.xlsx", "root.nda", "batch/nested/cell.ndax"],
        )
        self.assertTrue(all(item["selection_root"]["kind"] == "folder" for item in result["files"]))
        self.assertEqual(result["files"][0]["selection_root"]["path"], str(root.resolve()))

    def test_source_listing_combines_multiple_folders_and_loose_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            loose = root / "loose.nda"
            loose.write_bytes(b"loose")
            (first / "export.xlsx").write_bytes(b"export")
            (first / "one.ndax").write_bytes(b"one")
            (second / "two.nda").write_bytes(b"two")

            result = files.list_import_sources(
                [str(loose)],
                [str(first), str(second)],
            )

        self.assertEqual(
            [item["relative_path"] for item in result["files"]],
            ["loose.nda", "export.xlsx", "one.ndax", "two.nda"],
        )
        self.assertEqual(result["files"][0]["selection_root"]["label"], "Loose files")
        self.assertEqual(result["files"][1]["selection_root"]["path"], str(first.resolve()))
        self.assertEqual(result["files"][3]["selection_root"]["path"], str(second.resolve()))

    def test_source_listing_job_reports_roots_without_inspection(self):
        background_jobs.clear_jobs()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "batch"
            root.mkdir()
            loose = Path(tmp) / "loose.ndax"
            loose.write_bytes(b"loose")
            (root / "one.nda").write_bytes(b"one")
            with patch.object(parsing, "compute_hash", side_effect=AssertionError("hash called")):
                result = files.list_import_source_paths(
                    files.ImportSourceListRequest(
                        file_paths=[str(loose)],
                        folder_paths=[str(root)],
                        job_token="scan-test",
                    )
                )
        job = background_jobs.find_by_token("scan-test")
        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(job["kind"], "import_scan")
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["completed"], 2)
        self.assertEqual(job["discovered_files"], 2)
        self.assertIsNone(job["current_item_id"])
        background_jobs.clear_jobs()

    def test_inspection_job_reports_file_and_byte_progress(self):
        background_jobs.clear_jobs()
        preview = {"staged_name": "x", "size": 12, "filename": "x.ndax"}
        inspected = import_inspection.FileInspection(
            path="C:/data/x.ndax",
            filename="x.ndax",
            size=12,
            mtime_ns=1,
            ext="ndax",
            hash="hash",
            metadata={},
        )
        with patch.object(files.import_inspection, "build_identity_snapshot", return_value=Mock()), \
            patch.object(
                files.import_inspection,
                "inspect_files",
                return_value=[import_inspection.FileInspectionOutcome(
                    path=inspected.path,
                    inspection=inspected,
                    error=None,
                )],
            ), \
            patch.object(files, "_inspect_import_path", return_value=preview):
            result = files.inspect_import_paths(
                files.ImportPathInspectRequest(
                    paths=["C:/data/x.ndax"],
                    job_token="inspect-test",
                ),
                db=Mock(),
            )
        job = background_jobs.find_by_token("inspect-test")
        self.assertEqual(result["files"], [preview])
        self.assertEqual(result["failures"], [])
        self.assertEqual(job["kind"], "import_inspect")
        self.assertEqual(job["completed"], 1)
        self.assertEqual(job["completed_bytes"], 12)
        self.assertEqual(job["phase"], "completed")
        self.assertEqual(job["progress_percent"], 100.0)
        self.assertIsNone(job["current_item_label"])
        background_jobs.clear_jobs()

    def test_inspection_job_returns_successes_and_failures_without_aborting_batch(self):
        background_jobs.clear_jobs()
        good = import_inspection.FileInspection(
            path="C:/data/good.ndax",
            filename="good.ndax",
            size=12,
            mtime_ns=1,
            ext="ndax",
            hash="hash",
            metadata={},
        )
        outcomes = [
            import_inspection.FileInspectionOutcome("C:/data/good.ndax", good, None),
            import_inspection.FileInspectionOutcome("C:/data/broken.ndax", None, "Unreadable source"),
        ]
        preview = {"staged_name": "x", "size": 12, "filename": "good.ndax"}
        with patch.object(files.import_inspection, "build_identity_snapshot", return_value=Mock()), \
            patch.object(files.import_inspection, "inspect_files", return_value=outcomes), \
            patch.object(files, "_inspect_import_path", return_value=preview):
            result = files.inspect_import_paths(
                files.ImportPathInspectRequest(
                    paths=["C:/data/good.ndax", "C:/data/broken.ndax"],
                    job_token="inspect-partial-test",
                ),
                db=Mock(),
            )
        job = background_jobs.find_by_token("inspect-partial-test")
        self.assertEqual(result["files"], [preview])
        self.assertEqual(result["failures"], [{
            "path": "C:/data/broken.ndax",
            "filename": "broken.ndax",
            "error": "Unreadable source",
        }])
        failed_item = next(item for item in job["items"] if item["id"] == "C:/data/broken.ndax")
        self.assertEqual(failed_item["status"], "failed")
        self.assertEqual(failed_item["error"], "Unreadable source")
        self.assertEqual(job["status"], "completed")
        background_jobs.clear_jobs()

    def test_registration_job_failure_is_failed_and_rolls_back(self):
        background_jobs.clear_jobs()
        job_id = background_jobs.create_job(
            kind="import_register",
            title="Registering imported cells",
            description="Validating and registering Cells",
            total=1,
            token="register-test",
        )
        db = Mock()
        with patch.object(files, "SessionLocal", return_value=db), patch.object(
            files, "_create_imported_cells_impl", side_effect=RuntimeError("injected failure")
        ):
            files.run_import_registration_job(
                files.ImportCellsRequest(
                    cells=[files.ImportCellDraft(cell_name="Broken import", staged_name="x.ndax", filename="x.ndax")],
                    job_token="register-test",
                ),
                job_id,
            )
        job = background_jobs.find_by_token("register-test")
        self.assertEqual(job["kind"], "import_register")
        self.assertEqual(job["status"], "failed")
        self.assertIn("injected failure", job["error"])
        db.rollback.assert_called_once()
        background_jobs.clear_jobs()

    def test_duplicate_cell_names_are_rejected_before_parsing_or_continuation_checks(self):
        db = self.make_session()
        request = files.ImportCellsRequest(
            cells=[
                files.ImportCellDraft(
                    cell_name=" Same Cell ", staged_name="first.ndax", filename="first.ndax"
                ),
                files.ImportCellDraft(
                    cell_name="Same Cell", staged_name="second.ndax", filename="second.ndax"
                ),
            ]
        )
        with patch.object(
            files.continuations,
            "validate_staged_keys",
            side_effect=AssertionError("continuation validation must not run"),
        ), patch.object(
            parsing,
            "compute_hash",
            side_effect=AssertionError("hashing must not run"),
        ):
            with self.assertRaises(files.HTTPException) as raised:
                files._create_imported_cells_impl(request, db)

        self.assertEqual(raised.exception.status_code, 409)
        detail = raised.exception.detail
        self.assertEqual(detail["code"], "duplicate_submitted_cell_names")
        self.assertEqual(detail["conflicts"][0]["name"], "Same Cell")
        self.assertEqual(
            detail["conflicts"][0]["filenames"], ["first.ndax", "second.ndax"]
        )
        self.assertEqual(
            detail["conflicts"][0]["staged_names"], ["first.ndax", "second.ndax"]
        )

    def test_existing_cell_name_conflict_is_structured_and_precedes_parsing(self):
        db = self.make_session()
        db.add(Cell(name="Already there"))
        db.commit()
        request = files.ImportCellsRequest(
            cells=[
                files.ImportCellDraft(
                    cell_name=" Already there ", staged_name="candidate.ndax", filename="candidate.ndax"
                )
            ]
        )
        with patch.object(
            files.continuations,
            "validate_staged_keys",
            side_effect=AssertionError("continuation validation must not run"),
        ):
            with self.assertRaises(files.HTTPException) as raised:
                files._create_imported_cells_impl(request, db)

        self.assertEqual(raised.exception.detail["code"], "cell_name_already_exists")
        conflict = raised.exception.detail["conflicts"][0]
        self.assertEqual(conflict["cell_name"], "Already there")
        self.assertEqual(conflict["filenames"], ["candidate.ndax"])
        self.assertEqual(conflict["staged_names"], ["candidate.ndax"])

    def test_endpoint_rejects_duplicate_names_before_queueing_registration(self):
        db = self.make_session()
        background_jobs.clear_jobs()
        request = files.ImportCellsRequest(
            job_token="duplicate-before-queue",
            cells=[
                files.ImportCellDraft(cell_name="A", staged_name="a.ndax", filename="a.ndax"),
                files.ImportCellDraft(cell_name=" A ", staged_name="b.ndax", filename="b.ndax"),
            ],
        )
        with self.assertRaises(files.HTTPException) as raised:
            files._accept_imported_cells(request, db=db)

        self.assertEqual(raised.exception.detail["code"], "duplicate_submitted_cell_names")
        self.assertIsNone(background_jobs.find_by_token(request.job_token))
        self.assertEqual(db.query(ImportSubmission).count(), 0)
        background_jobs.clear_jobs()

    def test_integrity_error_is_translated_to_existing_name_conflict(self):
        db = self.make_session()
        db.add(Cell(name="Raced name"))
        db.commit()
        request = files.ImportCellsRequest(
            cells=[
                files.ImportCellDraft(
                    cell_name="Raced name", staged_name="raced.ndax", filename="raced.ndax"
                )
            ]
        )
        integrity_error = IntegrityError("INSERT", {}, RuntimeError("UNIQUE constraint failed"))
        with patch.object(files, "_create_imported_cells_impl_raw", side_effect=integrity_error):
            with self.assertRaises(files.HTTPException) as raised:
                files._create_imported_cells_impl(request, db)

        self.assertEqual(raised.exception.detail["code"], "cell_name_already_exists")
        self.assertNotIn("UNIQUE constraint", raised.exception.detail["message"])

    def test_registration_worker_setup_failure_marks_job_failed(self):
        background_jobs.clear_jobs()
        job_id = background_jobs.create_job(
            kind="import_register",
            title="Registering imported cells",
            description="Validating and registering Cells",
            total=1,
            token="setup-failure",
        )
        with patch.object(files, "SessionLocal", side_effect=RuntimeError("session unavailable")):
            files.run_import_registration_job(
                files.ImportCellsRequest(
                    cells=[files.ImportCellDraft(staged_name="x.ndax", filename="x.ndax", cell_name="Broken")],
                    job_token="setup-failure",
                ),
                job_id,
            )
        job = background_jobs.get_job(job_id)
        self.assertEqual(job["status"], "failed")
        self.assertIn("session unavailable", job["error"])
        background_jobs.clear_jobs()

    def test_cache_worker_setup_failure_marks_job_failed(self):
        background_jobs.clear_jobs()
        job_id = background_jobs.create_job(
            kind="import_cache",
            title="Preparing imported cells",
            description="Building cycling caches",
            total=1,
            items=[{"id": "x.ndax", "label": "x.ndax"}],
        )
        with patch.object(files, "SessionLocal", side_effect=RuntimeError("session unavailable")):
            files.run_import_cache_jobs(
                {"x.ndax": 1},
                [{"staged_name": "x.ndax", "hash": "hash", "path": "C:/data/x.ndax"}],
                job_id,
            )
        job = background_jobs.get_job(job_id)
        self.assertEqual(job["status"], "failed")
        self.assertIn("session unavailable", job["error"])
        self.assertEqual(job["items"][0]["status"], "failed")
        background_jobs.clear_jobs()

    def test_import_submission_returns_before_registration_worker_finishes(self):
        background_jobs.clear_jobs()
        request = files.ImportCellsRequest(
            cells=[files.ImportCellDraft(staged_name="x.ndax", filename="x.ndax", cell_name="Queued")],
            job_token="queued-import",
        )
        with patch.object(files, "run_import_registration_job") as worker:
            response = files.create_imported_cells(request)

        self.assertEqual(response["accepted"], True)
        self.assertEqual(response["submitted_cells"], 1)
        self.assertEqual(response["submitted_sources"], 1)
        self.assertEqual(response["status"], "running")
        worker.assert_called_once()
        self.assertEqual(background_jobs.find_by_token("queued-import")["status"], "running")
        background_jobs.clear_jobs()

    def test_import_submission_token_rejects_a_different_payload(self):
        background_jobs.clear_jobs()
        first = files.ImportCellsRequest(
            cells=[files.ImportCellDraft(staged_name="x.ndax", filename="x.ndax", cell_name="First")],
            job_token="single-use-token",
        )
        with patch.object(files, "run_import_registration_job"):
            files.create_imported_cells(first)

        changed = files.ImportCellsRequest(
            cells=[files.ImportCellDraft(staged_name="x.ndax", filename="x.ndax", cell_name="Changed")],
            job_token="single-use-token",
        )
        with self.assertRaises(files.HTTPException) as raised:
            files.create_imported_cells(changed)
        self.assertEqual(raised.exception.status_code, 409)
        background_jobs.clear_jobs()

    def test_durable_import_submission_is_idempotent_across_live_job_loss(self):
        background_jobs.clear_jobs()
        db = self.make_session()
        request = files.ImportCellsRequest(
            cells=[files.ImportCellDraft(staged_name="x.ndax", filename="x.ndax", cell_name="Durable")],
            job_token="durable-submission",
        )
        with patch.object(files, "run_import_registration_job") as worker:
            first = files._accept_imported_cells(request, db=db)
        original_job_id = first["job_id"]
        background_jobs.clear_jobs()

        second = files._accept_imported_cells(request, db=db)

        self.assertEqual(second["job_id"], original_job_id)
        self.assertEqual(second["status"], "accepted")
        self.assertEqual(db.query(ImportSubmission).count(), 1)
        worker.assert_called_once()
        background_jobs.clear_jobs()

    def test_real_registration_worker_commits_cells_before_cache_handoff(self):
        background_jobs.clear_jobs()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database_path = root / "worker.db"
            engine = create_engine(
                f"sqlite:///{database_path.as_posix()}",
                connect_args={"check_same_thread": False},
            )
            Base.metadata.create_all(engine)
            factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
            source_path = root / "cold.ndax"
            source_path.write_bytes(b"cold-cache-registration")
            request = files.ImportCellsRequest(
                cells=[files.ImportCellDraft(
                    staged_name="cold.ndax",
                    source_path=str(source_path),
                    filename="cold.ndax",
                    cell_name="Cold worker cell",
                )],
                job_token="real-worker-import",
            )
            request_db = factory()
            submission = ImportSubmission(
                token=request.job_token,
                fingerprint="b" * 64,
                job_id=1,
                submitted_cells=1,
                submitted_sources=1,
                status="accepted",
            )
            request_db.add(submission)
            request_db.commit()
            job_id = background_jobs.create_job(
                kind="import_register",
                title="Registering imported cells",
                description="Validating and registering Cells",
                total=1,
                token=request.job_token,
                fingerprint="b" * 64,
                items=[{"id": "0", "label": "cold.ndax"}],
            )
            submission.job_id = job_id
            request_db.commit()
            committed_counts = []

            def capture_cache_handoff(file_ids, jobs):
                observer = factory()
                try:
                    committed_counts.append(observer.query(Cell).count())
                finally:
                    observer.close()
                return {"queued": True, "count": len(jobs), "job_id": 99, "status": "running"}

            with patch.object(files, "SessionLocal", side_effect=factory), \
                patch.object(files, "start_import_cache_jobs", side_effect=capture_cache_handoff), \
                patch.object(files.parsing, "read_header_metadata", return_value={}):
                files.run_import_registration_job(request, job_id, submission.id)

            observer = factory()
            try:
                self.assertEqual(observer.query(Cell).count(), 1)
                self.assertEqual(observer.query(SourceFile).one().parse_status, "parsing")
                stored_submission = observer.get(ImportSubmission, submission.id)
                self.assertEqual(stored_submission.status, "completed")
            finally:
                observer.close()
            self.assertEqual(committed_counts, [1])
            self.assertEqual(background_jobs.get_job(job_id)["status"], "completed")
            request_db.close()
            engine.dispose()
        background_jobs.clear_jobs()

    def test_registration_commits_all_cells_before_blocked_cache_worker(self):
        background_jobs.clear_jobs()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database_path = root / "atomic-import.db"
            engine = create_engine(
                f"sqlite:///{database_path.as_posix()}",
                connect_args={"check_same_thread": False},
            )
            Base.metadata.create_all(engine)
            factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
            first = root / "first.ndax"
            second = root / "second.ndax"
            first.write_bytes(b"first-source")
            second.write_bytes(b"second-source")
            request = files.ImportCellsRequest(
                cells=[
                    files.ImportCellDraft(
                        staged_name=first.name,
                        source_path=str(first),
                        filename=first.name,
                        cell_name="First atomic cell",
                    ),
                    files.ImportCellDraft(
                        staged_name=second.name,
                        source_path=str(second),
                        filename=second.name,
                        cell_name="Second atomic cell",
                    ),
                ]
            )
            request_db = factory()
            prepared_jobs = []
            committed_snapshots = []

            def capture_cache_handoff(file_ids, jobs):
                prepared_jobs.extend(jobs)
                observer = factory()
                try:
                    committed_snapshots.append(
                        {
                            "cells": observer.query(Cell).count(),
                            "sources": [
                                (source.parse_status, source.capacity_summary_status)
                                for source in observer.query(SourceFile).order_by(SourceFile.id).all()
                            ],
                        }
                    )
                finally:
                    observer.close()
                return {"queued": True, "count": len(jobs), "job_id": 99, "status": "running"}

            with patch.object(files, "start_import_cache_jobs", side_effect=capture_cache_handoff), \
                patch.object(files.parsing, "read_header_metadata", return_value={}), \
                patch.object(files.cache, "build", side_effect=AssertionError("cache worker ran before commit")):
                result = files._create_imported_cells_impl(request, request_db)

            self.assertTrue(result["parsing_started"])
            self.assertEqual(len(prepared_jobs), 2)
            self.assertEqual(committed_snapshots, [{
                "cells": 2,
                "sources": [("parsing", "pending"), ("parsing", "pending")],
            }])

            cache_job_id = background_jobs.create_job(
                kind="import_cache",
                title="Preparing imported cells",
                description="Building cycling caches",
                total=len(prepared_jobs),
                items=[{"id": item["staged_name"], "label": item["staged_name"]} for item in prepared_jobs],
            )
            incremental_snapshots = []

            def fake_cache_builder(jobs, progress_callback=None, **_kwargs):
                results = {}
                for index, cache_job in enumerate(jobs):
                    result = {
                        "staged_name": cache_job["staged_name"],
                        "ok": index == 0,
                        "parser_version": parsing.PARSER_VERSION,
                        "rows": 12,
                        "cycles": 2,
                        "total_charge_capacity_mah": 3.0,
                        "total_discharge_capacity_mah": 2.5,
                        "max_discharge_capacity_mah": 2.5,
                    }
                    if not result["ok"]:
                        result["error"] = "blocked cache worker"
                    results[cache_job["staged_name"]] = result
                    if progress_callback:
                        progress_callback(cache_job, result)
                        observer = factory()
                        try:
                            incremental_snapshots.append([
                                (source.parse_status, source.capacity_summary_status)
                                for source in observer.query(SourceFile).order_by(SourceFile.id).all()
                            ])
                        finally:
                            observer.close()
                return results

            with patch.object(files, "SessionLocal", side_effect=factory), patch.object(
                files, "build_import_caches_parallel", side_effect=fake_cache_builder
            ):
                files.run_import_cache_jobs(
                    {item["staged_name"]: source_id for item, source_id in zip(
                        prepared_jobs,
                        [row[0] for row in request_db.query(TestFile.file_id).all()],
                    )},
                    prepared_jobs,
                    cache_job_id,
                )

            observer = factory()
            try:
                self.assertEqual(observer.query(Cell).count(), 2)
                final_sources = observer.query(SourceFile).order_by(SourceFile.id).all()
                self.assertEqual(final_sources[0].parse_status, "parsed")
                self.assertEqual(final_sources[1].parse_status, "error")
            finally:
                observer.close()
            self.assertEqual(incremental_snapshots[0], [("parsed", "ready"), ("parsing", "pending")])
            self.assertEqual(incremental_snapshots[1], [("parsed", "ready"), ("error", "error")])
            request_db.close()
            engine.dispose()
        background_jobs.clear_jobs()

    def test_committed_import_rejects_same_source_on_retry(self):
        background_jobs.clear_jobs()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database_path = root / "duplicate-import.db"
            engine = create_engine(
                f"sqlite:///{database_path.as_posix()}",
                connect_args={"check_same_thread": False},
            )
            Base.metadata.create_all(engine)
            factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
            source_path = root / "already-loaded.ndax"
            source_path.write_bytes(b"already-loaded-source")
            first_request = files.ImportCellsRequest(
                cells=[files.ImportCellDraft(
                    staged_name=source_path.name,
                    source_path=str(source_path),
                    filename=source_path.name,
                    cell_name="First loaded cell",
                )]
            )
            db = factory()
            try:
                with patch.object(files, "start_import_cache_jobs", return_value={"queued": False}), \
                    patch.object(files.parsing, "read_header_metadata", return_value={}):
                    files._create_imported_cells_impl(first_request, db)

                self.assertEqual(db.query(Cell).count(), 1)
                retry_request = files.ImportCellsRequest(
                    cells=[files.ImportCellDraft(
                        staged_name=source_path.name,
                        source_path=str(source_path),
                        filename=source_path.name,
                        cell_name="Retry loaded cell",
                    )]
                )
                with patch.object(files.parsing, "read_header_metadata", return_value={}):
                    with self.assertRaises(files.HTTPException) as raised:
                        files._create_imported_cells_impl(retry_request, db)
                self.assertEqual(raised.exception.status_code, 409)
                self.assertIn("already registered", str(raised.exception.detail))
                self.assertEqual(db.query(Cell).count(), 1)
            finally:
                db.close()
                engine.dispose()
        background_jobs.clear_jobs()

    def test_registration_consumes_inspection_identity_and_header_without_reopening_source(self):
        background_jobs.clear_jobs()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database_path = root / "inspection-backed-import.db"
            engine = create_engine(
                f"sqlite:///{database_path.as_posix()}",
                connect_args={"check_same_thread": False},
            )
            Base.metadata.create_all(engine)
            factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
            source_path = root / "inspection-backed.ndax"
            source_path.write_bytes(b"inspection-backed-source")
            source_stat = source_path.stat()
            inspected_hash = parsing.compute_hash(source_path)
            request = files.ImportCellsRequest(
                cells=[files.ImportCellDraft(
                    staged_name=source_path.name,
                    source_path=str(source_path),
                    filename=source_path.name,
                    inspection={
                        "hash": inspected_hash,
                        "size": source_stat.st_size,
                        "mtime_ns": str(source_stat.st_mtime_ns),
                        "header_metadata": {
                            "barcode": "INSPECTED-BARCODE",
                            "raw": {"Config.Barcode": "INSPECTED-BARCODE"},
                        },
                    },
                    cell_name="Inspection-backed cell",
                )]
            )
            db = factory()
            try:
                with patch.object(files, "start_import_cache_jobs", return_value={"queued": False}), \
                    patch.object(files.parsing, "compute_hash", side_effect=AssertionError("hash recomputed")), \
                    patch.object(files.parsing, "read_header_metadata", side_effect=AssertionError("header reopened")):
                    files._create_imported_cells_impl(request, db)
                source = db.query(SourceFile).one()
                self.assertEqual(source.hash, inspected_hash)
                self.assertEqual(source.barcode, "INSPECTED-BARCODE")
                self.assertEqual(db.query(Cell).count(), 1)
            finally:
                db.close()
                engine.dispose()
        background_jobs.clear_jobs()

    def test_inspection_response_does_not_ship_the_parsed_header(self):
        """~56 KB per file to the browser and back is ~58 MB each way at 1,000
        files. Inspection already stored the header server-side."""
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inspect.ndax"
            path.write_bytes(b"inspection-payload-content")
            with patch.object(files.parsing, "compute_hash", return_value="c" * 64), \
                patch.object(
                    files.parsing,
                    "read_header_metadata",
                    return_value={"barcode": "B1", "raw": {f"F{n}": "v" for n in range(200)}},
                ):
                payload = files._inspect_import_path(path, db, staged_name="inspect.ndax")

        self.assertNotIn("header_metadata", payload["inspection"])
        self.assertEqual(
            sorted(payload["inspection"]), ["hash", "mtime_ns", "size"]
        )
        # The curated display fields the modal actually shows still travel.
        self.assertEqual(payload["barcode"], "B1")

    def test_registration_reads_the_header_from_the_inspection_cache(self):
        """With no header in the payload, registration must not reopen the file."""
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cached.ndax"
            path.write_bytes(b"cached-header-content")
            stat = path.stat()
            file_hash = "d" * 64
            import_inspection.remember_header_metadata(
                file_hash,
                stat.st_size,
                stat.st_mtime_ns,
                {"barcode": "FROM-CACHE", "raw": {"Config.Barcode": "FROM-CACHE"}},
            )
            request = files.ImportCellsRequest(
                cells=[
                    files.ImportCellDraft(
                        staged_name=path.name,
                        source_path=str(path),
                        filename=path.name,
                        cell_name="Cache-backed cell",
                        inspection={
                            "hash": file_hash,
                            "size": stat.st_size,
                            "mtime_ns": str(stat.st_mtime_ns),
                        },
                    )
                ]
            )
            with patch.object(files, "start_import_cache_jobs", return_value={"queued": False}), \
                patch.object(files.parsing, "compute_hash", side_effect=AssertionError("hash recomputed")), \
                patch.object(files.parsing, "read_header_metadata", side_effect=AssertionError("header reopened")):
                files._create_imported_cells_impl(request, db)

            source = db.query(SourceFile).one()
            self.assertEqual(source.barcode, "FROM-CACHE")
            self.assertEqual(source.header_meta, {"Config.Barcode": "FROM-CACHE"})
        background_jobs.clear_jobs()

    def test_registration_rereads_the_header_when_the_cache_evicted_it(self):
        """A batch larger than the header cache arrives with its earliest
        entries gone. Registration must still succeed by reopening the file."""
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "evicted.ndax"
            path.write_bytes(b"evicted-header-content")
            stat = path.stat()
            file_hash = "e" * 64
            import_inspection._header_cache.clear()
            request = files.ImportCellsRequest(
                cells=[
                    files.ImportCellDraft(
                        staged_name=path.name,
                        source_path=str(path),
                        filename=path.name,
                        cell_name="Evicted-header cell",
                        inspection={
                            "hash": file_hash,
                            "size": stat.st_size,
                            "mtime_ns": str(stat.st_mtime_ns),
                        },
                    )
                ]
            )
            with patch.object(files, "start_import_cache_jobs", return_value={"queued": False}), \
                patch.object(files.parsing, "compute_hash", side_effect=AssertionError("hash recomputed")), \
                patch.object(
                    files.parsing, "read_header_metadata", return_value={"barcode": "REREAD"}
                ) as read_header:
                files._create_imported_cells_impl(request, db)

            # The bytes are never rehashed — only the header is reopened.
            read_header.assert_called_once()
            self.assertEqual(db.query(SourceFile).one().barcode, "REREAD")
        background_jobs.clear_jobs()

    def test_source_listing_keeps_same_named_roots_distinguishable(self):
        with tempfile.TemporaryDirectory() as tmp:
            outer = Path(tmp)
            first = outer / "one" / "batch"
            second = outer / "two" / "batch"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            (first / "a.ndax").write_bytes(b"a")
            (second / "b.ndax").write_bytes(b"b")

            result = files.list_import_sources([], [str(first), str(second)])

        roots = [item["selection_root"] for item in result["files"]]
        self.assertEqual([root["label"] for root in roots], ["batch", "batch"])
        self.assertNotEqual(roots[0]["path"], roots[1]["path"])

    def test_import_directory_browser_lists_folders_and_neware_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "nested").mkdir()
            (root / "cell.ndax").write_bytes(b"cell")
            (root / "export.xlsx").write_bytes(b"export")
            (root / "older.nda").write_bytes(b"older")
            (root / "notes.csv").write_text("ignore", encoding="ascii")

            result = files.browse_import_directory(str(root))

        self.assertEqual(result["current_path"], str(root.resolve()))
        self.assertEqual(
            [(entry["name"], entry["kind"]) for entry in result["entries"]],
            [
                ("nested", "folder"),
                ("cell.ndax", "file"),
                ("export.xlsx", "file"),
                ("older.nda", "file"),
            ],
        )
        self.assertEqual(result["parent_path"], str(root.resolve().parent))

    def test_quick_access_pins_and_recent_folders_are_persistent(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp).resolve()
            files.remember_import_folder(db, folder)
            files.update_import_pinned_folders(
                files.ImportPinnedFoldersRequest(paths=[str(folder)]),
                db=db,
            )
            items = files.import_quick_access(db)

        match = next(item for item in items if item["path"] == str(folder))
        self.assertTrue(match["pinned"])

    def test_staged_path_rejects_directory_escape(self):
        with self.assertRaises(ValueError):
            files.resolve_import_staged_path("../outside.ndax")

    def test_source_path_takes_precedence_over_staged_import_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "example.ndax"
            source.write_bytes(b"example")
            resolved = files.resolve_import_source_path(
                "missing-staged-file.ndax",
                str(source),
            )

            self.assertEqual(resolved, source.resolve())

    def test_capacity_preview_uses_cycle_capacity_points(self):
        cycles = pd.DataFrame(
            {
                "cycle": [1, 2, 3],
                "discharge_capacity_mah": [1.2, None, 1.4],
                "charge_capacity_mah": [1.3, 1.35, 1.45],
            }
        )

        preview = files.capacity_preview_from_cycles(cycles)

        self.assertEqual(
            preview,
            {
                "x": [1, 3],
                "y": [1.2, 1.4],
                "quantity": "discharge_capacity_mah",
                "label": "Discharge capacity (mAh)",
            },
        )

    def test_xlsx_capacity_preview_and_raw_table_use_normal_cache_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(cache, "CACHE_DIR", Path(tmp) / "cache"):
                path = Path(tmp) / "preview.xlsx"
                _write_importable_neware_workbook(path)
                file_hash = parsing.compute_hash(path)
                cache_dir = cache.raw_path(file_hash, parsing.PARSER_VERSION).parent
                try:
                    preview, error = files.build_capacity_preview(path, file_hash=file_hash)
                    self.assertIsNone(error)
                    self.assertIsNotNone(preview)
                    self.assertEqual(preview["x"], [1, 2])
                    self.assertEqual(preview["quantity"], "discharge_capacity_mah")

                    cache.wait_for_pending(file_hash)
                    raw = files.raw_import_file_data(
                        files.ImportRawDataRequest(
                            staged_name=path.name,
                            source_path=str(path),
                            limit=20,
                        )
                    )
                finally:
                    cache.wait_for_pending(file_hash)
                    if cache_dir.exists():
                        shutil.rmtree(cache_dir, ignore_errors=True)

        self.assertEqual(raw["total_rows"], 8)
        self.assertTrue(
            {
                "record_index",
                "cycle",
                "step",
                "step_index",
                "status",
                "time_s",
                "total_time_s",
                "voltage_v",
                "current_ma",
                "charge_capacity_mah",
                "discharge_capacity_mah",
                "charge_energy_mwh",
                "discharge_energy_mwh",
                "timestamp",
                "power_w",
            }.issubset(raw["columns"])
        )

    def test_xlsx_registration_preserves_one_full_source_header_and_curated_cell_metadata(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "registered.xlsx"
            _write_importable_neware_workbook(path)
            request = files.ImportCellsRequest(
                cells=[
                    files.ImportCellDraft(
                        cell_name="Excel source",
                        staged_name=path.name,
                        source_path=str(path),
                        filename=path.name,
                    )
                ]
            )
            with patch.object(files, "start_import_cache_jobs", return_value={}):
                result = files._create_imported_cells_impl(request, db)

        source = db.query(SourceFile).one()
        header = source.header_meta or {}
        cell_metadata = db.query(CellMetadata).all()
        self.assertEqual(result["created"][0]["filename"], "registered.xlsx")
        self.assertEqual(source.ext, "xlsx")
        self.assertEqual(source.parse_status, "parsing")
        self.assertTrue(header)
        self.assertEqual(header["Excel.SourceFormat.Value"], "neware_excel")
        self.assertLess(len(cell_metadata), 20)
        self.assertTrue(all(not item.key.startswith("Excel.") for item in cell_metadata))

    def test_structured_xlsx_continuation_uses_the_normal_source_chain_path(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "continuation.xlsx"
            _write_importable_neware_workbook(path)
            with patch.object(
                files.continuations.cache,
                "schedule_build",
                return_value={"status": "scheduled", "error": None},
            ):
                source = files._continuation_staged_source(
                    files.ContinuationInspectSourceRequest(
                        staged_name=path.name,
                        source_path=str(path),
                    ),
                    db,
                    existing_test_id=None,
                    input_order=0,
                )

        self.assertFalse(source["unsupported_extension"])
        self.assertEqual(source["inspection_status"], "pending")
        self.assertEqual(source["filename"], "continuation.xlsx")

    def test_mixed_binary_and_xlsx_continuation_persists_one_ordered_internal_test(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary_path = root / "part-01.ndax"
            excel_path = root / "part-02.xlsx"
            binary_path.write_bytes(b"controlled binary-shaped Neware fixture")
            _write_importable_neware_workbook(excel_path)

            first = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
            second = first + timedelta(minutes=1)
            third = second + timedelta(minutes=1)
            hashes = {
                parsing.compute_hash(binary_path): "binary",
                parsing.compute_hash(excel_path): "excel",
            }
            raw_by_kind = {
                "binary": pd.DataFrame({"timestamp": pd.to_datetime([first, second], utc=True)}),
                "excel": pd.DataFrame({"timestamp": pd.to_datetime([second, third], utc=True)}),
            }
            cycles_by_kind = {
                "binary": pd.DataFrame({"cycle": [1]}),
                "excel": pd.DataFrame({"cycle": [2]}),
            }
            shared_header = {
                "Protocol": "controlled-continuation",
                "Excel.SourceFormat.Value": "neware_excel",
            }

            def metadata_for(path):
                kind = "excel" if Path(path).suffix.casefold() == ".xlsx" else "binary"
                return {
                    "raw": shared_header,
                    "source_format": "Neware Excel" if kind == "excel" else None,
                    "start_time": first.isoformat() if kind == "binary" else second.isoformat(),
                    "device_info": "NEWARE",
                    "channel": "1-1",
                    "barcode": "CELL-1",
                    "remarks": None,
                    "nominal_capacity_mah": 3.0,
                    "active_mass_mg": 10.0,
                }

            request = files.ImportCellsRequest(
                cells=[
                    files.ImportCellDraft(
                        cell_name="Mixed source chain",
                        sources=[
                            files.ImportSourceDraft(
                                staged_name=binary_path.name,
                                source_path=str(binary_path),
                                filename=binary_path.name,
                            ),
                            files.ImportSourceDraft(
                                staged_name=excel_path.name,
                                source_path=str(excel_path),
                                filename=excel_path.name,
                            ),
                        ],
                    )
                ]
            )
            raw_path = SimpleNamespace(is_file=lambda: True)
            with (
                patch.object(files.parsing, "read_header_metadata", side_effect=metadata_for),
                patch.object(files.continuations.cache, "has_cycles", return_value=True),
                patch.object(files.continuations.cache, "raw_path", return_value=raw_path),
                patch.object(
                    files.continuations.cache,
                    "load_raw",
                    side_effect=lambda file_hash, *_: raw_by_kind[hashes[file_hash]],
                ),
                patch.object(
                    files.continuations.cache,
                    "load_cycles",
                    side_effect=lambda file_hash, *_: cycles_by_kind[hashes[file_hash]],
                ),
                patch.object(files, "start_import_cache_jobs", return_value={}),
            ):
                analysis = files._inspect_cell_draft_chain(request.cells[0], db)
                files.continuations.ensure_submittable_chain(analysis, [])
                result = files._create_imported_cells_impl(request, db)

            cell = db.get(Cell, result["created"][0]["cell_id"])
            tests = db.query(Test).filter(Test.cell_id == cell.id).all()
            self.assertEqual(len(tests), 1)
            links = sorted(tests[0].file_links, key=lambda link: link.position)
            self.assertEqual([link.position for link in links], [0, 1])
            self.assertEqual([link.file.ext for link in links], ["ndax", "xlsx"])
            self.assertEqual([link.file.filename for link in links], [binary_path.name, excel_path.name])

            duplicate_sources = [dict(source) for source in analysis["sources"]]
            duplicate_sources[1]["hash"] = duplicate_sources[0]["hash"]
            blocked = files.continuations.analyze_continuation_chain(
                duplicate_sources,
                staged_keys=[binary_path.name, excel_path.name],
                proposed_staged_order=[binary_path.name, excel_path.name],
            )
            self.assertFalse(blocked["can_submit"])
            self.assertIn("duplicate_hash", {finding["code"] for finding in blocked["findings"]})

    def test_preview_matching_fingerprint_reuses_inspected_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "preview.ndax"
            path.write_bytes(b"preview")
            stat = path.stat()
            with patch.object(files.parsing, "compute_hash") as compute_hash, patch.object(
                files,
                "build_capacity_preview",
                return_value=({"x": [1], "y": [2.0]}, None),
            ) as build_preview:
                response = files.preview_import_file(
                    files.ImportPreviewRequest(
                        staged_name=path.name,
                        source_path=str(path),
                        expected_hash="a" * 64,
                        expected_size=stat.st_size,
                        expected_mtime_ns=stat.st_mtime_ns,
                    )
                )

        compute_hash.assert_not_called()
        build_preview.assert_called_once_with(path.resolve(), file_hash="a" * 64)
        self.assertEqual(response["verified_hash"], "a" * 64)

    def test_preview_fingerprint_mismatch_rehashes_and_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "changed.ndax"
            path.write_bytes(b"changed")
            stat = path.stat()
            with patch.object(files.parsing, "compute_hash", return_value="b" * 64) as compute_hash:
                with self.assertRaises(Exception) as raised:
                    files.preview_import_file(
                        files.ImportPreviewRequest(
                            staged_name=path.name,
                            source_path=str(path),
                            expected_hash="a" * 64,
                            expected_size=stat.st_size + 1,
                            expected_mtime_ns=stat.st_mtime_ns,
                        )
                    )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "source_changed")
        compute_hash.assert_called_once_with(path.resolve())

    def test_preview_rehashed_matching_source_uses_fresh_verified_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "touched.ndax"
            path.write_bytes(b"touched")
            stat = path.stat()
            with patch.object(files.parsing, "compute_hash", return_value="a" * 64) as compute_hash, patch.object(
                files,
                "build_capacity_preview",
                return_value=(None, None),
            ) as build_preview:
                response = files.preview_import_file(
                    files.ImportPreviewRequest(
                        staged_name=path.name,
                        source_path=str(path),
                        expected_hash="a" * 64,
                        expected_size=stat.st_size + 1,
                        expected_mtime_ns=stat.st_mtime_ns,
                    )
                )

        compute_hash.assert_called_once_with(path.resolve())
        build_preview.assert_called_once_with(path.resolve(), file_hash="a" * 64)
        self.assertEqual(response["verified_hash"], "a" * 64)

    def test_capacity_preview_uses_verified_hash_without_recomputing(self):
        cycles = pd.DataFrame(
            {"cycle": [1], "discharge_capacity_mah": [1.5]},
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cached.ndax"
            path.write_bytes(b"cached")
            with patch.object(files.parsing, "compute_hash") as compute_hash, patch.object(
                files.cache,
                "build_write_behind",
                return_value=cycles,
            ) as build_write_behind:
                preview, error = files.build_capacity_preview(path, file_hash="c" * 64)

        compute_hash.assert_not_called()
        build_write_behind.assert_called_once_with("c" * 64, path)
        self.assertIsNone(error)
        self.assertEqual(preview["x"], [1])

    def test_start_import_cache_jobs_reports_background_handoff(self):
        with patch.object(files.background_jobs, "create_job", return_value=41), patch.object(
            files.threading,
            "Thread",
        ) as thread_cls:
            info = files.start_import_cache_jobs(
                {"a.ndax": 7},
                [{"staged_name": "a.ndax", "hash": "a" * 64, "path": "C:/a.ndax"}],
            )

        self.assertEqual(info, {"queued": True, "count": 1, "job_id": 41, "status": "running"})
        thread_cls.return_value.start.assert_called_once_with()
        self.assertEqual(
            files.start_import_cache_jobs({}, []),
            {"queued": False, "count": 0, "job_id": None, "status": "ready"},
        )

    def test_cache_worker_failure_marks_registered_source_error(self):
        db = self.make_session()
        source = SourceFile(
            hash="d" * 64,
            path="C:/data/failing.ndax",
            filename="failing.ndax",
            size=1,
            ext="ndax",
            parse_status="parsing",
            capacity_summary_status="pending",
        )
        db.add(source)
        db.commit()
        background_jobs.clear_jobs()
        job_id = background_jobs.create_job(
            kind="import_cache",
            title="Preparing imported cells",
            description="Building cycling caches",
            total=1,
            items=[{"id": "failing.ndax", "label": "failing.ndax"}],
        )
        try:
            db_worker = Mock(wraps=db)
            db_worker.close = Mock()
            with patch.object(files, "SessionLocal", return_value=db_worker), patch.object(
                files,
                "build_import_caches_parallel",
                side_effect=RuntimeError("worker unavailable"),
            ):
                files.run_import_cache_jobs(
                    {"failing.ndax": source.id},
                    [{"staged_name": "failing.ndax", "hash": source.hash, "path": source.path}],
                    job_id,
                )
        finally:
            background_jobs.clear_jobs()

        db.refresh(source)
        self.assertEqual(source.parse_status, "error")
        self.assertEqual(source.capacity_summary_status, "error")
        self.assertIn("registration succeeded", source.parse_error)

    def test_header_metadata_prefers_neware_head_remark(self):
        with patch.object(
            parsing,
            "_read_ndax_metadata_flat",
            side_effect=parsing._NdaxXmlFallback,
        ), patch.object(
            parsing.NewareNDA,
            "read_metadata",
            return_value={
                "Step": {
                    "Head_Info": {"Remark": {"Value": "actual-cell-remark"}},
                    "User_Info": {"VAR1": {"User_Remark": "Voltage"}},
                }
            },
        ):
            meta = parsing.read_header_metadata("fake.ndax")

        self.assertEqual(meta["remarks"], "actual-cell-remark")

    def test_header_metadata_extracts_neware_test_information_units(self):
        with patch.object(
            parsing,
            "_read_ndax_metadata_flat",
            side_effect=parsing._NdaxXmlFallback,
        ), patch.object(
            parsing.NewareNDA,
            "read_metadata",
            return_value={
                "Step": {
                    "Head_Info": {
                        "Start_Step": {"Value": "1"},
                        "PN": {"Value": "2026-03-17 14-04-28"},
                        "Creator": {"Value": "CY"},
                        "Remark": {"Value": "NG_20260317_LFP_LP_MoL_530_FM+CY"},
                        "SCQ": {"Value": "333770"},
                        "MultCap": {"Value": "185040"},
                    },
                    "Step_Info": {
                        "Step1": {
                            "Record": {"Main": {"Time": {"Value": "1000"}}},
                            "Protect": {
                                "Main": {
                                    "Volt": {
                                        "Upper": {"Value": "38500"},
                                        "Lower": {"Value": "27500"},
                                    }
                                }
                            },
                        }
                    },
                }
            },
        ):
            meta = parsing.read_header_metadata("fake.ndax")

        self.assertEqual(meta["start_step_id"], "1")
        self.assertEqual(meta["part_number"], "2026-03-17 14-04-28")
        self.assertEqual(meta["builder"], "CY")
        self.assertAlmostEqual(meta["active_mass_mg"], 333.77, places=6)
        self.assertAlmostEqual(meta["active_material_mg"], 333.77, places=6)
        self.assertAlmostEqual(meta["nominal_capacity_mah"], 51.4, places=6)
        self.assertAlmostEqual(meta["voltage_upper_v"], 3.85, places=6)
        self.assertAlmostEqual(meta["voltage_lower_v"], 2.75, places=6)
        self.assertAlmostEqual(meta["record_interval_s"], 1.0, places=6)

    def test_metadata_preview_includes_normalized_capacity_fields(self):
        preview = files._metadata_preview(
            {
                "active_mass_mg": 333.77,
                "nominal_capacity_mah": 51.4,
                "builder": "CY",
                "part_number": "P-1",
                "voltage_upper_v": 3.85,
                "voltage_lower_v": 2.75,
            }
        )

        self.assertEqual(preview["active_material_mg"], "333.77")
        self.assertEqual(preview["nominal_capacity_mah"], "51.4")
        self.assertEqual(preview["builder"], "CY")
        self.assertEqual(preview["part_number"], "P-1")

    def test_imported_cell_metadata_excludes_the_raw_header(self):
        """The raw header belongs to SourceFile.header_meta, not to the Cell.

        Expanding it here produced ~977 CellMetadata rows per Cell inside the
        relational write transaction, which is what delayed Cell visibility for
        a large import. The curated summary and user entries stay.
        """
        meta = {
            "active_mass_mg": 333.77,
            "builder": "CY",
            "raw": {
                "Step.Head_Info.Creator.Value": "CY",
                "Step.User_Info.Custom.Field": "all metadata survives",
            },
        }
        metadata = files.cell_metadata_from_header(meta, {"operator_note": "checked"})

        self.assertEqual(metadata["active_material_mg"], "333.77")
        self.assertEqual(metadata["builder"], "CY")
        self.assertEqual(metadata["operator_note"], "checked")
        self.assertEqual([key for key in metadata if key.startswith("raw.")], [])

    def test_raw_table_from_frame_returns_json_safe_page(self):
        raw = pd.DataFrame(
            {
                "record_index": [1, 2, 3],
                "voltage_v": [3.1, None, 3.3],
                "timestamp": pd.to_datetime(
                    ["2026-01-01 00:00:00", "2026-01-01 00:00:01", "2026-01-01 00:00:02"]
                ),
            }
        )

        table = files.raw_table_from_frame(raw, offset=1, limit=2)

        self.assertEqual(table["columns"], ["record_index", "voltage_v", "timestamp"])
        self.assertEqual(table["total_rows"], 3)
        self.assertEqual(table["offset"], 1)
        self.assertEqual(table["limit"], 2)
        self.assertEqual(
            table["rows"],
            [
                {"record_index": 2, "voltage_v": None, "timestamp": "2026-01-01T00:00:01"},
                {"record_index": 3, "voltage_v": 3.3, "timestamp": "2026-01-01T00:00:02"},
            ],
        )

    def test_import_match_finds_exact_hash_duplicate(self):
        class FakeDb:
            def __init__(self):
                cell = Cell(id=10, name="Cell A")
                test = Test(id=20, name="Imported file", cell=cell)
                sf = SourceFile(
                    id=30,
                    hash="abc123",
                    path="C:/data/cell_a.ndax",
                    filename="cell_a.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                )
                sf.test_link = TestFile(test=test, file=sf)
                self.rows = [sf]

            def query(self, model):
                return FakeQuery(self.rows)

        duplicate = files.import_match_info(
            FakeDb(),
            file_hash="abc123",
            filename="cell_a_copy.ndax",
            meta={},
        )

        self.assertEqual(duplicate["kind"], "exact_duplicate")
        self.assertEqual(duplicate["cell_name"], "Cell A")
        self.assertEqual(duplicate["source_file_id"], 30)

    def test_import_match_finds_possible_update_from_soft_identity(self):
        class FakeDb:
            def __init__(self):
                sf = SourceFile(
                    id=31,
                    hash="oldhash",
                    path="C:/data/cycling.ndax",
                    filename="cycling.ndax",
                    size=100,
                    ext="ndax",
                    barcode="B-7",
                    channel="1-2",
                    start_time="2026-01-01 10:00:00",
                    location_status="online",
                    parse_status="parsed",
                )
                self.rows = [sf]

            def query(self, model):
                return FakeQuery(self.rows)

        match = files.import_match_info(
            FakeDb(),
            file_hash="newhash",
            filename="cycling.ndax",
            meta={"barcode": "B-7", "channel": "1-2", "start_time": "2026-01-01 10:00:00"},
        )

        self.assertEqual(match["kind"], "possible_update")
        self.assertEqual(match["source_file_id"], 31)
        self.assertIn("filename", match["matched_on"])
        self.assertIn("barcode", match["matched_on"])

    def test_source_file_needs_cache_when_unparsed_or_counts_missing(self):
        unparsed = SourceFile(parse_status="unparsed", parser_version=None, cycle_count=None)
        parsed_missing_counts = SourceFile(
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            cycle_count=None,
        )
        parsed_ready = SourceFile(
            hash="hash-with-cache",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            row_count=100,
            cycle_count=10,
        )

        original = library.cache.has_cycles
        library.cache.has_cycles = lambda *args: True
        try:
            self.assertTrue(library.source_file_needs_cache(unparsed))
            self.assertTrue(library.source_file_needs_cache(parsed_missing_counts))
            self.assertFalse(library.source_file_needs_cache(parsed_ready))
        finally:
            library.cache.has_cycles = original

    def test_import_replicate_plan_files_groups_and_unassigned_cells(self):
        cells = [
            files.ImportCellDraft(staged_name="a.ndax", filename="a.ndax", cell_name="A"),
            files.ImportCellDraft(staged_name="b.ndax", filename="b.ndax", cell_name="B"),
            files.ImportCellDraft(staged_name="c.ndax", filename="c.ndax", cell_name="C"),
        ]
        groups = [
            files.ImportReplicateGroupDraft(
                name="Replicate A",
                staged_names=["a.ndax", "b.ndax"],
            )
        ]

        plan = files.import_replicate_plan(cells, groups)

        self.assertEqual(plan["groups"][0]["name"], "Replicate A")
        self.assertEqual(plan["groups"][0]["staged_names"], ["a.ndax", "b.ndax"])
        self.assertEqual(plan["unassigned_staged_names"], ["c.ndax"])

    def test_import_replicate_plan_rejects_single_cell_group(self):
        cells = [files.ImportCellDraft(staged_name="a.ndax", filename="a.ndax", cell_name="A")]
        groups = [files.ImportReplicateGroupDraft(name="Too small", staged_names=["a.ndax"])]

        with self.assertRaises(files.ImportPlanError):
            files.import_replicate_plan(cells, groups)

    def test_parallel_cache_builder_uses_multiple_workers_for_multiple_files(self):
        class FakeExecutor:
            calls = []

            def __init__(self, max_workers=None):
                self.max_workers = max_workers
                FakeExecutor.calls.append(("init", max_workers))

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def submit(self, fn, job):
                FakeExecutor.calls.append(("submit", job["staged_name"]))
                future = Future()
                future.set_result(
                    {
                        "staged_name": job["staged_name"],
                        "hash": job["hash"],
                        "rows": 10,
                        "cycles": 2,
                        "parser_version": "parser-test",
                        "calc_version": "calc-test",
                    }
                )
                return future

        jobs = [
            {"staged_name": f"file-{index}.ndax", "hash": f"hash-{index}", "path": f"C:/data/{index}.ndax"}
            for index in range(26)
        ]

        reported = []
        with patch.object(files.os, "cpu_count", return_value=8):
            results = files.build_import_caches_parallel(
                jobs,
                executor_cls=FakeExecutor,
                max_workers=8,
                progress_callback=lambda job, result: reported.append(
                    (job["staged_name"], result["staged_name"])
                ),
            )

        self.assertEqual(FakeExecutor.calls[0], ("init", 4))
        self.assertEqual(FakeExecutor.calls[1:], [("submit", f"file-{index}.ndax") for index in range(26)])
        self.assertEqual(results["file-0.ndax"]["rows"], 10)
        self.assertEqual(results["file-25.ndax"]["parser_version"], "parser-test")
        self.assertEqual(
            sorted(reported),
            sorted(
                (f"file-{index}.ndax", f"file-{index}.ndax")
                for index in range(26)
            ),
        )

    def test_import_cache_worker_count_uses_serial_threshold(self):
        with patch.object(files.os, "cpu_count", return_value=8):
            self.assertEqual(files.import_cache_worker_count(25, max_workers=8), 1)
            self.assertEqual(files.import_cache_worker_count(26, max_workers=8), 4)

    def test_create_imported_cells_starts_cache_jobs_after_committing_import(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "large.ndax"
            path.write_bytes(b"fake-import-test-content")
            started = []
            original_start = files.start_import_cache_jobs
            original_hash = parsing.compute_hash
            original_meta = parsing.read_header_metadata
            original_inspect = files._inspect_cell_draft_chain
            def capture_cache_jobs(file_ids, jobs):
                started.append((file_ids, jobs))
                return {"queued": True, "count": len(jobs), "job_id": 99, "status": "running"}

            files.start_import_cache_jobs = capture_cache_jobs
            files._inspect_cell_draft_chain = Mock(
                side_effect=AssertionError("separate-cell import must not inspect continuation timing")
            )
            parsing.compute_hash = lambda _path: "import-test-hash"
            parsing.read_header_metadata = lambda _path: {"builder": "test"}
            try:
                result = files._create_imported_cells_impl(
                    files.ImportCellsRequest(
                        cells=[
                            files.ImportCellDraft(
                                staged_name="large.ndax",
                                source_path=str(path),
                                filename=path.name,
                                cell_name="Async import cell",
                                test_name="Imported file",
                                active_mass_mg_override=25,
                                nominal_capacity_mah_override=4.25,
                                electrode_area_cm2_override=1.539,
                                active_material_preset_id="lfp-reference",
                                active_material_name="LFP",
                                active_material_specific_capacity_mah_g=170,
                                electrode_area_preset_id="coin-14mm",
                                electrode_area_preset_name="14 mm circular electrode",
                            )
                        ]
                    ),
                    db=db,
                )
                files._inspect_cell_draft_chain.assert_not_called()
            finally:
                files.start_import_cache_jobs = original_start
                files._inspect_cell_draft_chain = original_inspect
                parsing.compute_hash = original_hash
                parsing.read_header_metadata = original_meta

        self.assertEqual(result["created"][0]["cell_name"], "Async import cell")
        self.assertTrue(result["parsing_started"])
        self.assertEqual(
            result["cache_jobs"],
            {"queued": True, "count": 1, "job_id": 99, "status": "running"},
        )
        self.assertEqual(len(started), 1)
        imported_cell = db.get(Cell, result["created"][0]["cell_id"])
        self.assertIsNotNone(imported_cell)
        self.assertEqual(len(imported_cell.tests), 1)
        self.assertEqual(imported_cell.tests[0].name, "Imported file")
        source_file = db.query(SourceFile).filter(SourceFile.filename == path.name).one()
        self.assertEqual(source_file.parse_status, "parsing")
        self.assertEqual(started[0][0], {"large.ndax": source_file.id})
        metadata = {
            row.key: row.value
            for row in db.query(CellMetadata)
            .filter(CellMetadata.cell_id == result["created"][0]["cell_id"])
            .all()
        }
        self.assertEqual(metadata["override.active_material_name"], "LFP")
        self.assertEqual(
            metadata["override.active_material_specific_capacity_mah_g"],
            "170.0",
        )
        self.assertEqual(
            metadata["override.electrode_area_preset_name"],
            "14 mm circular electrode",
        )

    def test_cache_job_reaches_a_terminal_state_even_if_its_handler_fails(self):
        """A job left 'running' is counted by the UI forever.

        The failure handler does its own database work, so it can raise a second
        time on an already-broken session. When that happened the thread died
        silently and a large import stayed frozen at a partial count.
        """
        background_jobs.clear_jobs()
        job_id = background_jobs.create_job(
            kind="import_cache",
            title="Preparing imported cells",
            description="test",
            total=1,
            items=[{"id": "a.ndax", "label": "a.ndax"}],
        )
        broken = Mock()
        broken.query.side_effect = RuntimeError("session unusable")
        broken.get.side_effect = RuntimeError("session unusable")
        broken.commit.side_effect = RuntimeError("session unusable")
        broken.rollback.side_effect = RuntimeError("session unusable")

        with patch.object(files, "SessionLocal", return_value=broken), \
            patch.object(
                files,
                "build_import_caches_parallel",
                side_effect=RuntimeError("worker pool died"),
            ):
            # Must not raise: the thread has no caller to handle it.
            files.run_import_cache_jobs({"a.ndax": 1}, [{"staged_name": "a.ndax", "hash": "a" * 64, "path": "a"}], job_id)

        self.assertEqual(background_jobs.get_job(job_id)["status"], "failed")
        background_jobs.clear_jobs()

    def test_cache_job_stops_when_every_imported_cell_was_deleted(self):
        """Deleting the Cells mid-import must stop the work, not carry on
        building caches only to delete each one it just wrote."""
        background_jobs.clear_jobs()
        db = self.make_session()
        jobs = [
            {"staged_name": f"f{index}.ndax", "hash": f"{index:064d}", "path": f"f{index}.ndax"}
            for index in range(5)
        ]
        job_id = background_jobs.create_job(
            kind="import_cache",
            title="Preparing imported cells",
            description="test",
            total=len(jobs),
            items=[{"id": job["staged_name"], "label": job["staged_name"]} for job in jobs],
        )
        built = []

        def fake_parallel(cache_jobs, progress_callback=None, should_continue=None, **kwargs):
            results = {}
            for job in cache_jobs:
                built.append(job["staged_name"])
                result = {"staged_name": job["staged_name"], "ok": True,
                          "parser_version": "1", "rows": 1, "cycles": 1}
                results[job["staged_name"]] = result
                if progress_callback:
                    progress_callback(job, result)
                if should_continue is not None and not should_continue():
                    break
            return results

        # No SourceFile rows exist, so the very first result proves the import
        # was deleted and the run must abandon the rest.
        with patch.object(files, "SessionLocal", return_value=db), \
            patch.object(files, "build_import_caches_parallel", side_effect=fake_parallel), \
            patch.object(files.cache, "remove_hash_cache", return_value=0):
            files.run_import_cache_jobs(
                {job["staged_name"]: index + 1 for index, job in enumerate(jobs)},
                jobs,
                job_id,
            )

        self.assertEqual(built, ["f0.ndax"])
        job = background_jobs.get_job(job_id)
        self.assertEqual(job["status"], "completed")
        self.assertIn("deleted", job["description"])
        background_jobs.clear_jobs()

    def test_registration_stores_the_raw_header_only_on_the_source_file(self):
        """The header is one JSON document per source, not N CellMetadata rows.

        Expanding a ~977-field header into relational rows put ~993k inserts
        inside the Stage B write transaction, which is what kept imported Cells
        invisible until an entire large batch finished.
        """
        db = self.make_session()
        raw_header = {f"Step.Head_Info.Field_{n:04d}": f"value-{n}" for n in range(120)}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "header.ndax"
            path.write_bytes(b"fake-import-test-content")
            original_start = files.start_import_cache_jobs
            original_hash = parsing.compute_hash
            original_meta = parsing.read_header_metadata
            files.start_import_cache_jobs = lambda *_: {"queued": False, "count": 0}
            parsing.compute_hash = lambda _path: "header-test-hash"
            parsing.read_header_metadata = lambda _path: {
                "builder": "CY",
                "active_mass_mg": 12.5,
                "raw": raw_header,
            }
            try:
                result = files._create_imported_cells_impl(
                    files.ImportCellsRequest(
                        cells=[
                            files.ImportCellDraft(
                                staged_name="header.ndax",
                                source_path=str(path),
                                filename=path.name,
                                cell_name="Header ownership cell",
                                test_name="Imported file",
                                metadata={"operator_note": "checked"},
                            )
                        ]
                    ),
                    db=db,
                )
            finally:
                files.start_import_cache_jobs = original_start
                parsing.compute_hash = original_hash
                parsing.read_header_metadata = original_meta

        cell_id = result["created"][0]["cell_id"]
        metadata = {
            row.key: row.value
            for row in db.query(CellMetadata).filter(CellMetadata.cell_id == cell_id).all()
        }
        self.assertEqual([key for key in metadata if key.startswith("raw.")], [])
        # The curated summary and the user's own entry are Cell-level and stay.
        self.assertEqual(metadata["builder"], "CY")
        self.assertEqual(metadata["operator_note"], "checked")
        self.assertLess(len(metadata), 30)

        source_file = db.query(SourceFile).filter(SourceFile.filename == path.name).one()
        self.assertEqual(source_file.header_meta, raw_header)

    def test_cell_source_header_endpoint_serves_the_stored_header(self):
        db = self.make_session()
        cell = Cell(name="Header endpoint cell")
        source = SourceFile(
            hash="header-endpoint-hash",
            path="C:/data/header.ndax",
            filename="header.ndax",
            size=10,
            ext="ndax",
            header_meta={"Step.Head_Info.Creator.Value": "CY"},
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.flush()

        payload = library.get_cell_source_header(cell.id, source.id, db=db)
        self.assertEqual(payload["header"], {"Step.Head_Info.Creator.Value": "CY"})
        self.assertEqual(payload["filename"], "header.ndax")

        with self.assertRaises(HTTPException) as unknown_source:
            library.get_cell_source_header(cell.id, source.id + 999, db=db)
        self.assertEqual(unknown_source.exception.status_code, 404)

        with self.assertRaises(HTTPException) as unknown_cell:
            library.get_cell_source_header(cell.id + 999, source.id, db=db)
        self.assertEqual(unknown_cell.exception.status_code, 404)

    def test_cell_source_header_endpoint_is_empty_for_sources_without_a_header(self):
        """Sources registered before header capture are empty, not an error."""
        db = self.make_session()
        cell = Cell(name="Headerless cell")
        source = SourceFile(
            hash="headerless-hash",
            path="C:/data/old.ndax",
            filename="old.ndax",
            size=10,
            ext="ndax",
            header_meta=None,
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.flush()

        self.assertEqual(library.get_cell_source_header(cell.id, source.id, db=db)["header"], {})

    def test_ensure_cell_caches_does_not_parse_files_already_parsing(self):
        db = self.make_session()
        cell = Cell(name="Parsing cell")
        source = SourceFile(
            hash="hash-parsing",
            path=str(ROOT / "AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax"),
            filename="AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsing",
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.flush()

        calls = []
        original_parse = library.scanner.parse_file
        library.scanner.parse_file = lambda *_: calls.append("parse")
        try:
            library.ensure_cell_caches(db, cell)
        finally:
            library.scanner.parse_file = original_parse

        self.assertEqual(calls, [])

    def test_cell_dict_reports_parsing_sources(self):
        db = self.make_session()
        cell = Cell(name="Parsing cell")
        source = SourceFile(
            hash="hash-parsing",
            path="C:/data/parsing.ndax",
            filename="parsing.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsing",
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.flush()

        payload = library.cell_dict(db, cell)

        self.assertTrue(payload["has_parsing"])


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.predicates = []

    def filter(self, predicate):
        self.predicates.append(predicate)
        return self

    def first(self):
        if not self.predicates:
            return self.rows[0] if self.rows else None
        for row in self.rows:
            if all(predicate(row) for predicate in self.predicates):
                return row
        return None

    def all(self):
        return list(self.rows)


if __name__ == "__main__":
    unittest.main()
