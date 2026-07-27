import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import _enable_write_ahead_logging, _set_sqlite_pragma
from app.models import Cell, SourceFile
from app.routers import beta_bootstrap as beta_bootstrap_router
from app.services import beta_bootstrap
from app.services.database_migrations import migrate_database


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


class BetaBootstrapTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._engines = []
        self.beta_root = Path(self._tmpdir.name) / "beta"
        self.stable_root = Path(self._tmpdir.name) / "stable"
        self.beta_root.mkdir()
        self.stable_root.mkdir()
        self._patches = [
            patch.dict(
                os.environ,
                {
                    "CELLXPLORER_DATA": str(self.beta_root),
                    "CELLXPLORER_CHANNEL": "beta",
                },
                clear=False,
            ),
            patch("app.services.beta_bootstrap.APP_DATA_DIR", self.beta_root),
            patch("app.services.beta_bootstrap.IMPORT_DIR", self.beta_root / "imports"),
            patch("app.services.app_channel.resolve_app_channel", return_value="beta"),
            patch("app.services.beta_bootstrap.stable_library_root", return_value=self.stable_root),
        ]
        for item in self._patches:
            item.start()

    def tearDown(self):
        beta_bootstrap._active_stage_token = None
        lock_path = beta_bootstrap.bootstrap_root() / beta_bootstrap.LOCK_NAME
        if lock_path.is_file():
            lock_path.unlink(missing_ok=True)
        for engine in self._engines:
            engine.dispose()
        self._engines.clear()
        for item in reversed(self._patches):
            item.stop()

    def beta_session(self):
        factory, engine = _create_migrated_database(self.beta_root)
        self._engines.append(engine)
        return factory()

    def stable_session(self):
        factory, engine = _create_migrated_database(self.stable_root)
        self._engines.append(engine)
        return factory()

    def test_stable_router_endpoints_return_404(self):
        with patch("app.routers.beta_bootstrap.resolve_app_channel", return_value="stable"):
            with self.assertRaises(Exception) as raised:
                beta_bootstrap_router._require_beta_channel()
            self.assertEqual(getattr(raised.exception, "status_code", None), 404)

    def test_pristine_beta_requires_choice(self):
        db = self.beta_session()
        try:
            status = beta_bootstrap.build_status(db)
            self.assertTrue(status["needsChoice"])
            self.assertIsNone(status["decision"])
            self.assertTrue(status["betaPristine"])
        finally:
            db.close()

    def test_start_empty_writes_marker(self):
        db = self.beta_session()
        try:
            result = beta_bootstrap.start_empty_library(db)
            self.assertEqual(result["decision"], "empty")
            marker = beta_bootstrap.read_marker()
            self.assertEqual(marker["decision"], "empty")
            status = beta_bootstrap.build_status(db)
            self.assertFalse(status["needsChoice"])
            self.assertEqual(status["decision"], "empty")
        finally:
            db.close()

    def test_marker_suppresses_future_prompt(self):
        db = self.beta_session()
        try:
            beta_bootstrap.write_marker("empty")
            status = beta_bootstrap.build_status(db)
            self.assertFalse(status["needsChoice"])
        finally:
            db.close()

    def test_non_pristine_beta_rejects_copy(self):
        db = self.beta_session()
        try:
            db.add(Cell(name="Existing cell"))
            db.commit()
            with self.assertRaises(beta_bootstrap.BetaBootstrapConflict):
                beta_bootstrap.stage_stable_copy(db)
        finally:
            db.close()

    def test_absent_stable_blocks_copy_but_allows_empty(self):
        db = self.beta_session()
        try:
            status = beta_bootstrap.build_status(db)
            self.assertTrue(status["needsChoice"])
            self.assertFalse(status["stableDatabaseCompatible"])
            with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
                beta_bootstrap.stage_stable_copy(db)
            beta_bootstrap.start_empty_library(db)
        finally:
            db.close()

    def test_stage_copy_creates_manifest_and_new_instance_id(self):
        stable_db = self.stable_session()
        stable_instance = None
        stable_path = self.stable_root / "cellxplorer.db"
        try:
            stable_db.add(Cell(name="Cell A"))
            stable_db.commit()
            stable_instance = beta_bootstrap._read_instance_id(stable_path)
        finally:
            stable_db.close()

        beta_db = self.beta_session()
        try:
            before_hash = beta_bootstrap._sha256_file(stable_path)
            result = beta_bootstrap.stage_stable_copy(beta_db)
            self.assertTrue(result["restartRequired"])
            stage_dir = beta_bootstrap.bootstrap_root() / result["token"]
            self.assertTrue((stage_dir / beta_bootstrap.MANIFEST_NAME).is_file())
            self.assertTrue((stage_dir / beta_bootstrap.STAGED_DB_NAME).is_file())
            staged_instance = beta_bootstrap._read_instance_id(stage_dir / beta_bootstrap.STAGED_DB_NAME)
            self.assertIsNotNone(staged_instance)
            self.assertNotEqual(staged_instance, stable_instance)
            self.assertEqual(beta_bootstrap._sha256_file(stable_path), before_hash)
        finally:
            beta_db.close()

    def test_stage_copy_rewrites_managed_imports(self):
        stable_imports = self.stable_root / "imports" / "batch"
        stable_imports.mkdir(parents=True)
        payload = b"neware-bytes"
        import_file = stable_imports / "sample.nda"
        import_file.write_bytes(payload)
        digest = beta_bootstrap._sha256_file(import_file)

        stable_db = self.stable_session()
        try:
            stable_db.add(
                SourceFile(
                    path=str(import_file.resolve()),
                    filename="sample.nda",
                    ext="nda",
                    hash=digest,
                    size=len(payload),
                )
            )
            stable_db.commit()
        finally:
            stable_db.close()

        beta_db = self.beta_session()
        try:
            result = beta_bootstrap.stage_stable_copy(beta_db)
            stage_dir = beta_bootstrap.bootstrap_root() / result["token"]
            staged_import = stage_dir / "imports" / "batch" / "sample.nda"
            self.assertTrue(staged_import.is_file())
            self.assertEqual(staged_import.read_bytes(), payload)
            self.assertEqual(result["copiedImports"], 1)
        finally:
            beta_db.close()


if __name__ == "__main__":
    unittest.main()
