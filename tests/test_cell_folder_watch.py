import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Cell, CellFolderWatch, CellFolderWatchCandidate, SourceFile, Test, TestFile
from app.routers import files
from app.services import cell_folder_watch, import_inspection


class CellFolderWatchTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        return factory(), engine

    def add_watch(self, db, folder: Path):
        source_path = folder / "part-01.ndax"
        source_path.write_bytes(b"existing")
        source = SourceFile(
            hash="a" * 64,
            path=str(source_path),
            filename=source_path.name,
            size=source_path.stat().st_size,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
        )
        cell = Cell(name=f"Cell {folder.name}")
        test = Test(cell=cell, name="Imported file")
        link = TestFile(test=test, file=source, position=0)
        watch = CellFolderWatch(
            cell=cell,
            folder_path=str(folder),
            enabled=True,
            pattern_kind="glob",
            pattern="*.ndax",
            extensions=["ndax"],
            source_formats=[],
            ordering_rule="timestamp_filename_hash",
        )
        db.add_all([cell, source, test, link, watch])
        db.commit()
        return cell, watch

    @staticmethod
    def inspection(path: Path, *, hash_value: str, start_time: str = "2026-08-20T10:00:00"):
        stat = path.stat()
        return import_inspection.FileInspection(
            path=str(path),
            filename=path.name,
            size=stat.st_size,
            mtime_ns=stat.st_mtime_ns,
            ext=path.suffix.lower().lstrip("."),
            hash=hash_value,
            metadata={"source_format": "neware_ndax", "start_time": start_time},
        )

    def run_twice(self, db, now, *, stability_seconds=0, retry_count=3):
        first = cell_folder_watch.run_folder_watch_pass(
            db,
            monitor_enabled=True,
            automation_paused=False,
            stability_seconds=stability_seconds,
            retry_count=retry_count,
            now=now,
        )
        second = cell_folder_watch.run_folder_watch_pass(
            db,
            monitor_enabled=True,
            automation_paused=False,
            stability_seconds=stability_seconds,
            retry_count=retry_count,
            now=now + timedelta(seconds=max(1, stability_seconds)),
        )
        return first, second

    def test_validation_and_ordering_are_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            clean = cell_folder_watch.validate_watch_config(
                {
                    "folder_path": directory,
                    "pattern_kind": "glob",
                    "pattern": "*.ndax",
                    "extensions": [".ndax"],
                    "ordering_rule": "filename",
                }
            )
            self.assertEqual(clean["extensions"], ["ndax"])
            self.assertEqual(clean["ordering_rule"], "filename")
            with self.assertRaisesRegex(ValueError, "regular expression"):
                cell_folder_watch.validate_watch_config(
                    {
                        "folder_path": directory,
                        "pattern_kind": "regex",
                        "pattern": "[",
                        "extensions": ["ndax"],
                    }
                )
        self.assertLess(
            cell_folder_watch.candidate_order_key("part-2.ndax", "2026-08-20T10:00:00", "b" * 64),
            cell_folder_watch.candidate_order_key("part-10.ndax", "2026-08-20T10:00:00", "a" * 64),
        )

    def test_settings_preview_ignores_subfolders_and_filters_extensions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-01.ndax").write_bytes(b"one")
            (root / "ignore.mpr").write_bytes(b"other")
            nested = root / "nested"
            nested.mkdir()
            (nested / "part-02.ndax").write_bytes(b"two")
            preview = cell_folder_watch.preview_watch_files(
                {
                    "folder_path": str(root),
                    "pattern_kind": "glob",
                    "pattern": "part-*.ndax",
                    "extensions": ["ndax"],
                }
            )
            self.assertEqual(
                [item["relative_path"] for item in preview["files"]],
                ["part-01.ndax"],
            )

    def test_settings_preview_accepts_multiple_supported_extensions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-01.ndax").write_bytes(b"one")
            (root / "part-02.mpr").write_bytes(b"two")
            preview = cell_folder_watch.preview_watch_files(
                {
                    "folder_path": str(root),
                    "pattern_kind": "glob",
                    "pattern": "part-*",
                    "extensions": ["ndax", ".mpr", "ndax"],
                }
            )
            self.assertEqual(
                [item["filename"] for item in preview["files"]],
                ["part-01.ndax", "part-02.mpr"],
            )

    def test_stable_candidate_is_inspected_and_attached_through_existing_lifecycle(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                _cell, watch = self.add_watch(db, folder)
                candidate_path = folder / "part-02.ndax"
                candidate_path.write_bytes(b"candidate")
                inspection = self.inspection(candidate_path, hash_value="b" * 64)
                inspect_chain = Mock(
                    return_value={"inspection_complete": True, "findings": [], "can_submit": True}
                )
                attach = Mock()
                with (
                    patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection),
                    patch.object(files, "inspect_cell_continuation_sources", inspect_chain),
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    first, second = self.run_twice(
                        db,
                        datetime(2026, 8, 20, tzinfo=timezone.utc),
                    )
                self.assertEqual(first[0]["status"], "waiting_for_stability")
                self.assertEqual(second[0]["status"], "attached")
                self.assertEqual(second[0]["attached"], 1)
                attach.assert_called_once()
                self.assertEqual(db.query(CellFolderWatchCandidate).count(), 0)
                self.assertEqual(inspect_chain.call_count, 1)
        finally:
            engine.dispose()

    def test_baseline_file_is_ignored_until_explicit_retry(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                cell, watch = self.add_watch(db, folder)
                baseline_path = folder / "part-02.ndax"
                baseline_path.write_bytes(b"already present")
                cell_folder_watch.initialize_watch_baseline(db, watch)
                db.commit()

                baseline = db.query(CellFolderWatchCandidate).one()
                self.assertEqual(baseline.status, "ignored")
                self.assertIn("not selected", baseline.message or "")
                self.assertEqual(
                    cell_folder_watch.watch_payload(watch, global_monitor_enabled=True)["candidates"][0]["status"],
                    "ignored",
                )

                inspection = self.inspection(baseline_path, hash_value="b" * 64)
                inspect_chain = Mock(
                    return_value={"inspection_complete": True, "findings": [], "can_submit": True}
                )
                attach = Mock()
                with (
                    patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection) as inspect,
                    patch.object(files, "inspect_cell_continuation_sources", inspect_chain),
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    result = cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=True,
                        automation_paused=False,
                        stability_seconds=0,
                        retry_count=3,
                        now=datetime(2026, 8, 20, tzinfo=timezone.utc),
                    )
                self.assertEqual(result[0]["status"], "ready")
                inspect.assert_not_called()
                attach.assert_not_called()

                cell_folder_watch.reset_candidate(db, cell.id, baseline.id)
                db.commit()
                retry_now = datetime.now(timezone.utc) + timedelta(seconds=1)
                with (
                    patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection),
                    patch.object(files, "inspect_cell_continuation_sources", inspect_chain),
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    result = cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=True,
                        automation_paused=False,
                        stability_seconds=0,
                        retry_count=3,
                        now=retry_now,
                    )
                self.assertEqual(result[0]["status"], "attached")
                self.assertEqual(result[0]["attached"], 1)
                inspect_chain.assert_called()
                attach.assert_called_once()
        finally:
            engine.dispose()

    def test_unstable_candidate_is_not_inspected_until_stability_window_elapses(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                _cell, _watch = self.add_watch(db, folder)
                candidate_path = folder / "part-02.ndax"
                candidate_path.write_bytes(b"candidate")
                inspection = self.inspection(candidate_path, hash_value="b" * 64)
                attach = Mock()
                now = datetime(2026, 8, 20, tzinfo=timezone.utc)
                with (
                    patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection) as inspect,
                    patch.object(
                        files,
                        "inspect_cell_continuation_sources",
                        return_value={"inspection_complete": True, "findings": [], "can_submit": True},
                    ),
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    first = cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=True,
                        automation_paused=False,
                        now=now,
                        stability_seconds=10,
                        retry_count=3,
                    )
                    second = cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=True,
                        automation_paused=False,
                        stability_seconds=10,
                        retry_count=3,
                        now=now + timedelta(seconds=5),
                    )
                    self.assertEqual(first[0]["status"], "waiting_for_stability")
                    self.assertEqual(second[0]["status"], "waiting_for_stability")
                    inspect.assert_not_called()
                    attach.assert_not_called()
                    third = cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=True,
                        automation_paused=False,
                        stability_seconds=10,
                        retry_count=3,
                        now=now + timedelta(seconds=10),
                    )
                self.assertEqual(third[0]["status"], "attached")
                inspect.assert_called_once()
        finally:
            engine.dispose()

    def test_duplicate_content_in_this_chain_is_skipped_silently(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                _cell, _watch = self.add_watch(db, folder)
                candidate_path = folder / "part-02.ndax"
                candidate_path.write_bytes(b"duplicate")
                inspection = self.inspection(candidate_path, hash_value="a" * 64)
                with patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection) as inspect:
                    _first, second = self.run_twice(
                        db,
                        datetime(2026, 8, 20, tzinfo=timezone.utc),
                    )
                self.assertEqual(second[0]["status"], "ready")
                self.assertEqual(db.query(CellFolderWatchCandidate).count(), 0)
                inspect.assert_called_once()
        finally:
            engine.dispose()

    def test_duplicate_content_in_another_cell_is_actionable(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                watch_folder = folder / "watch"
                watch_folder.mkdir()
                _cell, _watch = self.add_watch(db, watch_folder)
                other_source_path = folder / "other.ndax"
                other_source_path.write_bytes(b"other")
                other_cell = Cell(name="Other cell")
                other_test = Test(cell=other_cell, name="Imported file")
                other_source = SourceFile(
                    hash="b" * 64,
                    path=str(other_source_path),
                    filename=other_source_path.name,
                    size=other_source_path.stat().st_size,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                )
                db.add_all([other_cell, other_source, other_test, TestFile(test=other_test, file=other_source, position=0)])
                db.commit()
                candidate_path = watch_folder / "part-02.ndax"
                candidate_path.write_bytes(b"candidate")
                inspection = self.inspection(candidate_path, hash_value="b" * 64)
                with patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection):
                    _first, second = self.run_twice(
                        db,
                        datetime(2026, 8, 20, tzinfo=timezone.utc),
                    )
                self.assertEqual(second[0]["status"], "candidates_pending")
                candidate = db.query(CellFolderWatchCandidate).one()
                self.assertEqual(candidate.status, "duplicate")
                self.assertIn("Other cell", candidate.message)
        finally:
            engine.dispose()

    def test_blocking_candidate_attaches_only_the_valid_prefix(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                _cell, _watch = self.add_watch(db, folder)
                first_path = folder / "part-02.ndax"
                second_path = folder / "part-03.ndax"
                first_path.write_bytes(b"first")
                second_path.write_bytes(b"second")
                inspections = {
                    str(first_path.resolve()): self.inspection(first_path, hash_value="b" * 64),
                    str(second_path.resolve()): self.inspection(second_path, hash_value="c" * 64),
                }
                def inspect(path):
                    return inspections[str(Path(path).resolve())]

                def inspect_chain(_cell_id, request, _db):
                    if len(request.sources) == 1:
                        return {"inspection_complete": True, "findings": [], "can_submit": True}
                    return {
                        "inspection_complete": True,
                        "findings": [{"severity": "blocking", "message": "Protocol gap"}],
                        "can_submit": False,
                    }

                attach = Mock()
                now = datetime(2026, 8, 20, tzinfo=timezone.utc)
                with (
                    patch.object(cell_folder_watch.import_inspection, "inspect_file", side_effect=inspect),
                    patch.object(files, "inspect_cell_continuation_sources", side_effect=inspect_chain),
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    self.run_twice(db, now)
                self.assertEqual(attach.call_count, 1)
                remaining = db.query(CellFolderWatchCandidate).one()
                self.assertEqual(remaining.filename, second_path.name)
                self.assertEqual(remaining.status, "blocked_by_finding")
        finally:
            engine.dispose()

    def test_confirmation_candidate_is_parked_without_acknowledgement_or_attach(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                _cell, _watch = self.add_watch(db, folder)
                candidate_path = folder / "part-02.ndax"
                candidate_path.write_bytes(b"candidate")
                inspection = self.inspection(candidate_path, hash_value="b" * 64)
                attach = Mock()
                with (
                    patch.object(cell_folder_watch.import_inspection, "inspect_file", return_value=inspection),
                    patch.object(
                        files,
                        "inspect_cell_continuation_sources",
                        return_value={
                            "inspection_complete": True,
                            "findings": [{"severity": "confirmation", "message": "Review timestamp overlap"}],
                            "can_submit": False,
                        },
                    ),
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    self.run_twice(db, datetime(2026, 8, 20, tzinfo=timezone.utc))
                candidate = db.query(CellFolderWatchCandidate).one()
                self.assertEqual(candidate.status, "needs_confirmation")
                attach.assert_not_called()
        finally:
            engine.dispose()

    def test_ambiguous_ordering_attaches_nothing(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                _cell, _watch = self.add_watch(db, folder)
                first_path = folder / "one" / "same.ndax"
                second_path = folder / "two" / "same.ndax"
                first_path.parent.mkdir()
                second_path.parent.mkdir()
                first_path.write_bytes(b"one")
                second_path.write_bytes(b"two")
                first = self.inspection(first_path, hash_value="b" * 64)
                second = self.inspection(second_path, hash_value="b" * 64)
                inspect_by_path = {
                    str(first_path.resolve()): first,
                    str(second_path.resolve()): second,
                }
                attach = Mock()
                with (
                    patch.object(
                        cell_folder_watch,
                        "_iter_files",
                        return_value=[first_path, second_path],
                    ),
                    patch.object(
                        cell_folder_watch.import_inspection,
                        "inspect_file",
                        side_effect=lambda path: inspect_by_path[str(Path(path).resolve())],
                    ),
                    patch.object(files, "inspect_cell_continuation_sources") as inspect_chain,
                    patch.object(files, "attach_cell_continuations", attach),
                ):
                    self.run_twice(db, datetime(2026, 8, 20, tzinfo=timezone.utc))
                self.assertEqual(inspect_chain.call_count, 0)
                attach.assert_not_called()
                self.assertEqual(
                    {candidate.status for candidate in db.query(CellFolderWatchCandidate).all()},
                    {"ambiguous_order"},
                )
        finally:
            engine.dispose()

    def test_missing_folder_does_not_disable_watch_and_scheduler_gates_are_fail_closed(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory) / "missing"
                folder.mkdir()
                _cell, watch = self.add_watch(db, folder)
                (folder / "part-01.ndax").unlink()
                folder.rmdir()
                now = datetime(2026, 8, 20, tzinfo=timezone.utc)
                self.assertEqual(
                    cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=False,
                        automation_paused=False,
                        stability_seconds=0,
                        retry_count=3,
                        now=now,
                    ),
                    [],
                )
                self.assertEqual(
                    cell_folder_watch.run_folder_watch_pass(
                        db,
                        monitor_enabled=True,
                        automation_paused=True,
                        stability_seconds=0,
                        retry_count=3,
                        now=now,
                    ),
                    [],
                )
                result = cell_folder_watch.run_folder_watch_pass(
                    db,
                    monitor_enabled=True,
                    automation_paused=False,
                    stability_seconds=0,
                    retry_count=3,
                    now=now,
                )
                self.assertEqual(result[0]["status"], "folder_missing")
                db.refresh(watch)
                self.assertTrue(watch.enabled)
                self.assertEqual(watch.last_status, "folder_missing")
                payload = cell_folder_watch.watch_payload(
                    watch,
                    global_monitor_enabled=False,
                )
                self.assertEqual(payload["status"], "paused")
                self.assertIn("source monitoring is disabled", payload["status_message"])
        finally:
            engine.dispose()

    def test_ignored_candidate_remains_visible_until_retry(self):
        db, engine = self.make_session()
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                cell, watch = self.add_watch(db, folder)
                candidate = CellFolderWatchCandidate(
                    watch=watch,
                    path=str(folder / "part-02.ndax"),
                    filename="part-02.ndax",
                    status="needs_confirmation",
                    stability_state="stable",
                )
                db.add(candidate)
                db.commit()
                self.assertTrue(cell_folder_watch.delete_candidate(db, cell.id, candidate.id))
                db.commit()
                self.assertEqual(
                    cell_folder_watch.watch_payload(watch, global_monitor_enabled=True)["candidates"][0]["status"],
                    "ignored",
                )
                cell_folder_watch.reset_candidate(db, cell.id, candidate.id)
                db.commit()
                self.assertEqual(
                    cell_folder_watch.watch_payload(watch, global_monitor_enabled=True)["candidates"][0]["status"],
                    "pending_stability",
                )
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
