import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer-alpha"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import _enable_write_ahead_logging, _set_sqlite_pragma
from app.models import (
    Analysis,
    Cell,
    Folder,
    FolderCell,
    Group,
    GroupCell,
    Project,
    ProjectCell,
    ReplicateGroup,
    ReplicateGroupCell,
    SourceFile,
    Test,
    TestFile,
)
from app.routers import beta_bootstrap as bootstrap_router
from app.services import beta_bootstrap
from app.services.database_identity import DATABASE_INSTANCE_ID_KEY
from app.services.database_migrations import migrate_database
from app.services.scientific_preparation import SCIENTIFIC_PREPARATION_KEY


def _create_migrated_database(root: Path) -> tuple[sessionmaker, object]:
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "cellxplorer.db"
    engine = create_engine(
        f"sqlite:///{db_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    event.listen(engine, "connect", _set_sqlite_pragma)
    status = migrate_database(engine, db_path)
    if not status.compatible:
        raise RuntimeError(status.message)
    _enable_write_ahead_logging(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False), engine


def _create_database_from_template(root: Path, template: bytes) -> tuple[sessionmaker, object]:
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "cellxplorer.db"
    db_path.write_bytes(template)
    engine = create_engine(
        f"sqlite:///{db_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    event.listen(engine, "connect", _set_sqlite_pragma)
    _enable_write_ahead_logging(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False), engine


class AlphaBootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._template_directory = tempfile.TemporaryDirectory(
            prefix="cellxplorer-alpha-schema-template-"
        )
        cls.addClassCleanup(cls._template_directory.cleanup)
        template_root = Path(cls._template_directory.name) / "template"
        _, engine = _create_migrated_database(template_root)
        engine.dispose()
        cls._template = (template_root / "cellxplorer.db").read_bytes()

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._engines = []
        self.alpha_root = Path(self._tmpdir.name) / "alpha"
        self.stable_root = Path(self._tmpdir.name) / "stable"
        self.beta_root = Path(self._tmpdir.name) / "beta"
        for root in (self.alpha_root, self.stable_root, self.beta_root):
            root.mkdir()
        self._patches = [
            patch.dict(
                os.environ,
                {
                    "CELLXPLORER_DATA": str(self.alpha_root),
                    "CELLXPLORER_CHANNEL": "alpha",
                },
                clear=False,
            ),
            patch("app.services.beta_bootstrap.APP_DATA_DIR", self.alpha_root),
            patch("app.services.beta_bootstrap.IMPORT_DIR", self.alpha_root / "imports"),
            patch("app.services.beta_bootstrap.INSTALL_INSTANCE_ID", "alpha-test-install"),
            patch("app.services.beta_bootstrap.resolve_app_channel", return_value="alpha"),
            patch(
                "app.services.beta_bootstrap.stable_library_root",
                return_value=self.stable_root,
            ),
            patch(
                "app.services.beta_bootstrap.beta_library_root",
                return_value=self.beta_root,
            ),
        ]
        for item in self._patches:
            item.start()
        beta_bootstrap._active_stage_token = None

    def tearDown(self):
        beta_bootstrap._active_stage_token = None
        for root in (self.alpha_root, self.stable_root, self.beta_root):
            lock = root / "bootstrap" / beta_bootstrap.LOCK_NAME
            lock.unlink(missing_ok=True)
        for engine in self._engines:
            engine.dispose()
        for item in reversed(self._patches):
            item.stop()

    def _session(self, root: Path):
        factory, engine = _create_database_from_template(root, self._template)
        self._engines.append(engine)
        return factory()

    def _source_session(self, root: Path):
        return self._session(root)

    def _alpha_session(self):
        return self._session(self.alpha_root)

    def _populate_source(self, root: Path, label: str):
        imports = root / "imports" / "batch"
        imports.mkdir(parents=True)
        managed = imports / f"{label}.nda"
        managed.write_bytes(f"{label}-managed".encode())
        external = Path(self._tmpdir.name) / f"{label}-external.ndax"
        external.write_bytes(f"{label}-external".encode())

        db = self._source_session(root)
        first = SourceFile(
            path=str(managed.resolve()),
            filename=managed.name,
            ext="nda",
            hash=beta_bootstrap._sha256_file(managed),
            size=managed.stat().st_size,
        )
        second = SourceFile(
            path=str(external.resolve()),
            filename=external.name,
            ext="ndax",
            hash=beta_bootstrap._sha256_file(external),
            size=external.stat().st_size,
        )
        first_cell = Cell(name=f"{label} cell 1")
        second_cell = Cell(name=f"{label} cell 2")
        test = Test(name=f"{label} test", cell=first_cell)
        db.add_all([first, second, first_cell, second_cell, test])
        db.flush()
        db.add_all([
            TestFile(test_id=test.id, file_id=second.id, position=2),
            TestFile(test_id=test.id, file_id=first.id, position=1),
        ])
        folder = Folder(name=f"{label} folder", position=3)
        group = ReplicateGroup(name=f"{label} replicates")
        project = Project(name=f"{label} project")
        analysis = Analysis(
            title=f"{label} analysis",
            spec={
                "version": 1,
                "samples": {"cellIds": [first_cell.id, second_cell.id]},
                "savedPlots": [{"id": "plot-1", "title": "Saved plot"}],
            },
        )
        db.add_all([folder, group, project, analysis])
        db.flush()
        db.add_all([
            FolderCell(folder_id=folder.id, cell_id=second_cell.id, position=1),
            FolderCell(folder_id=folder.id, cell_id=first_cell.id, position=2),
            ReplicateGroupCell(group_id=group.id, cell_id=first_cell.id, position=1),
            ReplicateGroupCell(group_id=group.id, cell_id=second_cell.id, position=2),
            ProjectCell(project_id=project.id, cell_id=first_cell.id),
            ProjectCell(project_id=project.id, cell_id=second_cell.id),
        ])
        project_group = Group(project_id=project.id, name=f"{label} project group", position=1)
        db.add(project_group)
        db.flush()
        db.add(GroupCell(group_id=project_group.id, cell_id=second_cell.id, position=1))
        db.commit()
        db.close()
        return managed, external

    def _root_snapshot(self, root: Path) -> dict[str, tuple[int, bytes]]:
        return {
            str(path.relative_to(root)): (path.stat().st_size, path.read_bytes())
            for path in root.rglob("*")
            if path.is_file()
        }

    def test_status_lists_stable_then_beta_with_product_reasons(self):
        db = self._alpha_session()
        try:
            status = beta_bootstrap.build_alpha_status(db)
        finally:
            db.close()
        self.assertEqual([item["channel"] for item in status["sources"]], ["stable", "beta"])
        self.assertEqual(
            [item["productName"] for item in status["sources"]],
            ["CellXplorer", "CellXplorer Beta"],
        )
        self.assertTrue(all(not item["compatible"] for item in status["sources"]))
        self.assertTrue(all(item["blockingReason"] for item in status["sources"]))
        self.assertTrue(all("library database was found" in item["blockingReason"] for item in status["sources"]))

    def test_start_empty_uses_only_alpha_marker(self):
        db = self._alpha_session()
        try:
            result = beta_bootstrap.start_alpha_empty_library(db)
            self.assertEqual(result["decision"], "empty")
        finally:
            db.close()
        marker = beta_bootstrap.read_alpha_marker()
        self.assertEqual(marker["decision"], "empty")
        self.assertTrue(beta_bootstrap.alpha_marker_path().is_file())
        self.assertFalse(beta_bootstrap.marker_path().exists())

    def test_stage_copy_from_stable_preserves_content_and_rewrites_only_managed_paths(self):
        managed, external = self._populate_source(self.stable_root, "stable")
        source_before = self._root_snapshot(self.stable_root)
        db = self._alpha_session()
        try:
            result = beta_bootstrap.stage_source_copy(db, "stable", destination_channel="alpha")
        finally:
            db.close()
        stage_dir = beta_bootstrap.alpha_bootstrap_root() / result["token"]
        manifest = json.loads((stage_dir / beta_bootstrap.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest["sourceChannel"], "stable")
        self.assertEqual(result["sourceChannel"], "stable")
        self.assertTrue((stage_dir / "imports" / "batch" / managed.name).is_file())
        self.assertEqual(manifest["copiedImports"], 1)
        with closing(sqlite3.connect(stage_dir / beta_bootstrap.STAGED_DB_NAME)) as connection:
            paths = [row[0] for row in connection.execute("SELECT path FROM source_files ORDER BY id")]
            instance_id = connection.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (DATABASE_INSTANCE_ID_KEY,),
            ).fetchone()[0]
            preparation = connection.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (SCIENTIFIC_PREPARATION_KEY,),
            ).fetchone()[0]
            counts = {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in (
                    "cells",
                    "source_files",
                    "tests",
                    "test_files",
                    "analyses",
                    "folders",
                    "folder_cells",
                    "replicate_groups",
                    "replicate_group_cells",
                    "projects",
                    "project_cells",
                    "groups",
                    "group_cells",
                )
            }
        self.assertNotEqual(instance_id, None)
        self.assertEqual(json.loads(preparation)["status"], "pending")
        self.assertTrue(paths[0].startswith(str(self.alpha_root / "imports")))
        self.assertEqual(Path(paths[1]), external.resolve())
        self.assertEqual(counts["cells"], 2)
        self.assertEqual(counts["test_files"], 2)
        self.assertEqual(counts["analyses"], 1)
        self.assertEqual(counts["folders"], 1)
        self.assertEqual(counts["folder_cells"], 2)
        self.assertEqual(counts["replicate_groups"], 1)
        self.assertEqual(counts["replicate_group_cells"], 2)
        self.assertEqual(counts["projects"], 1)
        self.assertEqual(counts["project_cells"], 2)
        self.assertEqual(counts["groups"], 1)
        self.assertEqual(counts["group_cells"], 1)
        self.assertEqual(self._root_snapshot(self.stable_root), source_before)

    def test_stage_copy_from_beta_and_invalid_sources(self):
        self._populate_source(self.beta_root, "beta")
        db = self._alpha_session()
        try:
            result = beta_bootstrap.stage_source_copy(db, "beta", destination_channel="alpha")
            self.assertEqual(result["sourceChannel"], "beta")
            beta_bootstrap.discard_alpha_stage(result["token"])
            for source in ("alpha", "unknown", ""):
                with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
                    beta_bootstrap.stage_source_copy(db, source, destination_channel="alpha")
            self.assertFalse(beta_bootstrap.alpha_bootstrap_root().exists() and any(
                beta_bootstrap.alpha_bootstrap_root().iterdir()
            ))
        finally:
            db.close()

    def test_stage_copy_rejects_source_changed_mid_copy_without_partial_stage(self):
        managed, _ = self._populate_source(self.stable_root, "changed")
        source_db = self.stable_root / "cellxplorer.db"
        original_copy = beta_bootstrap._copy_import_streaming

        def copy_then_change_source(*args, **kwargs):
            result = original_copy(*args, **kwargs)
            source_db.write_bytes(source_db.read_bytes() + b"changed-mid-copy")
            return result

        db = self._alpha_session()
        try:
            with patch(
                "app.services.beta_bootstrap._copy_import_streaming",
                side_effect=copy_then_change_source,
            ):
                with self.assertRaisesRegex(
                    beta_bootstrap.BetaBootstrapError,
                    "CellXplorer library changed during copying",
                ):
                    beta_bootstrap.stage_source_copy(
                        db,
                        "stable",
                        destination_channel="alpha",
                    )
        finally:
            db.close()
        self.assertTrue(managed.is_file())
        self.assertIsNone(beta_bootstrap.find_outstanding_stage_token())
        self.assertIsNone(beta_bootstrap._active_stage_token)
        self.assertFalse(
            any(
                item.is_dir()
                for item in beta_bootstrap.alpha_bootstrap_root().glob("[0-9a-f]" * 32)
            )
        )

    def test_alpha_router_is_off_channel_and_request_rejects_non_sources(self):
        with patch("app.routers.beta_bootstrap.resolve_app_channel", return_value="beta"):
            with self.assertRaises(Exception) as raised:
                bootstrap_router._require_alpha_channel()
        self.assertEqual(getattr(raised.exception, "status_code", None), 404)
        with self.assertRaises(Exception):
            bootstrap_router.AlphaStageCopyRequest.model_validate({"source": "alpha"})


if __name__ == "__main__":
    unittest.main()
