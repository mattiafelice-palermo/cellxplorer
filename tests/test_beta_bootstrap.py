import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
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
from app.services.scientific_preparation import SCIENTIFIC_PREPARATION_KEY
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


def _create_database_from_template(
    root: Path,
    template: bytes,
) -> tuple[sessionmaker, object]:
    """Open a private writable current-schema copy without rerunning migrations."""

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


class BetaBootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._schema_template_directory = tempfile.TemporaryDirectory(
            prefix="cellxplorer-beta-schema-template-"
        )
        cls.addClassCleanup(cls._schema_template_directory.cleanup)
        template_root = Path(cls._schema_template_directory.name) / "template"
        _, template_engine = _create_migrated_database(template_root)
        template_engine.dispose()
        # The migration path above is the source of truth for this immutable
        # setup input. Each test still receives a fresh writable database file.
        cls._current_schema_template = (template_root / "cellxplorer.db").read_bytes()

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
            patch("app.services.beta_bootstrap.INSTALL_INSTANCE_ID", "test-install"),
            patch("app.services.app_channel.resolve_app_channel", return_value="beta"),
            patch("app.services.beta_bootstrap.stable_library_root", return_value=self.stable_root),
        ]
        for item in self._patches:
            item.start()
        beta_bootstrap._active_stage_token = None

    def tearDown(self):
        beta_bootstrap._active_stage_token = None
        lock_path = beta_bootstrap.bootstrap_root() / beta_bootstrap.LOCK_NAME
        if lock_path.is_file():
            lock_path.unlink(missing_ok=True)
        self.dispose_engines()
        for item in reversed(self._patches):
            item.stop()

    def dispose_engines(self):
        for engine in self._engines:
            engine.dispose()
        self._engines.clear()

    def beta_session(self):
        factory, engine = _create_database_from_template(
            self.beta_root,
            self._current_schema_template,
        )
        self._engines.append(engine)
        return factory()

    def stable_session(self):
        factory, engine = _create_database_from_template(
            self.stable_root,
            self._current_schema_template,
        )
        self._engines.append(engine)
        return factory()

    @property
    def stable_db_path(self) -> Path:
        return self.stable_root / "cellxplorer.db"

    def write_raw_stable_database(self, statements: list[str]) -> Path:
        path = self.stable_db_path
        with closing(sqlite3.connect(path)) as connection:
            for statement in statements:
                connection.execute(statement)
            connection.commit()
        return path

    def stamp_stable_revision(self, revision: str) -> None:
        self.dispose_engines()
        with closing(sqlite3.connect(self.stable_db_path)) as connection:
            connection.execute("DELETE FROM alembic_version")
            connection.execute(
                "INSERT INTO alembic_version (version_num) VALUES (?)", (revision,)
            )
            connection.commit()

    def make_stage_dir(self, token: str, age_hours: float) -> Path:
        stage_dir = beta_bootstrap.bootstrap_root() / token
        stage_dir.mkdir(parents=True, exist_ok=True)
        (stage_dir / beta_bootstrap.STAGED_DB_NAME).write_bytes(b"placeholder")
        stamp = time.time() - age_hours * 3600
        os.utime(stage_dir, (stamp, stamp))
        return stage_dir

    def test_stable_router_endpoints_return_404(self):
        with patch("app.routers.beta_bootstrap.resolve_app_channel", return_value="stable"):
            with self.assertRaises(Exception) as raised:
                beta_bootstrap_router._require_beta_channel()
            self.assertEqual(getattr(raised.exception, "status_code", None), 404)
            with self.assertRaises(Exception) as transition:
                beta_bootstrap_router.beta_bootstrap_preparation_background()
            self.assertEqual(getattr(transition.exception, "status_code", None), 404)

    def test_preparation_background_rejects_when_no_copied_job_is_active(self):
        with (
            patch("app.routers.beta_bootstrap.resolve_app_channel", return_value="beta"),
            patch.object(
                beta_bootstrap_router.scanner,
                "request_capacity_backfill_background",
                return_value=None,
            ),
        ):
            with self.assertRaises(Exception) as raised:
                beta_bootstrap_router.beta_bootstrap_preparation_background()
        self.assertEqual(getattr(raised.exception, "status_code", None), 409)

    def test_preparation_background_returns_active_job_transition(self):
        expected = {
            "jobId": 42,
            "resourceMode": "background",
            "workers": 1,
            "transitionPending": True,
        }
        with (
            patch("app.routers.beta_bootstrap.resolve_app_channel", return_value="beta"),
            patch.object(
                beta_bootstrap_router.scanner,
                "request_capacity_backfill_background",
                return_value=expected,
            ),
        ):
            result = beta_bootstrap_router.beta_bootstrap_preparation_background()
        self.assertEqual(result, expected)

    def test_pristine_beta_requires_choice(self):
        db = self.beta_session()
        try:
            status = beta_bootstrap.build_status(db)
            self.assertTrue(status["needsChoice"])
            self.assertIsNone(status["decision"])
            self.assertTrue(status["betaPristine"])
            self.assertEqual(status["setupState"], "choice-required")
            self.assertIsNone(status["setupError"])
            self.assertIsNone(status["outstandingStageToken"])
            self.assertIsNone(status["applyFailureMessage"])
        finally:
            db.close()

    def test_start_empty_writes_marker(self):
        db = self.beta_session()
        try:
            result = beta_bootstrap.start_empty_library(db)
            self.assertEqual(result["decision"], "empty")
            marker = beta_bootstrap.read_marker()
            self.assertEqual(marker["decision"], "empty")
            self.assertEqual(marker["appVersion"], beta_bootstrap.APP_VERSION)
            self.assertEqual(marker["installInstanceId"], "test-install")
            status = beta_bootstrap.build_status(db)
            self.assertFalse(status["needsChoice"])
            self.assertEqual(status["decision"], "empty")
            self.assertEqual(status["setupState"], "complete")
        finally:
            db.close()

    def test_marker_suppresses_future_prompt(self):
        db = self.beta_session()
        try:
            beta_bootstrap.write_marker("empty")
            status = beta_bootstrap.build_status(db)
            self.assertFalse(status["needsChoice"])
            self.assertTrue(status["betaPristine"])
            self.assertFalse(status["betaHasExistingLibrary"])
        finally:
            db.close()

    def test_reinstall_of_same_version_requires_a_new_choice(self):
        db = self.beta_session()
        try:
            beta_bootstrap.write_marker("empty")
            with patch(
                "app.services.beta_bootstrap.INSTALL_INSTANCE_ID",
                "replacement-install",
            ):
                status = beta_bootstrap.build_status(db)
                self.assertTrue(status["needsChoice"])
                self.assertEqual(status["acknowledgedAppVersion"], beta_bootstrap.APP_VERSION)
                self.assertEqual(
                    status["acknowledgedInstallInstanceId"],
                    "test-install",
                )

                result = beta_bootstrap.start_empty_library(db)
                self.assertEqual(result["decision"], "empty")
                marker = beta_bootstrap.read_marker()
                self.assertEqual(
                    marker["installInstanceId"],
                    "replacement-install",
                )
                self.assertFalse(beta_bootstrap.build_status(db)["needsChoice"])
        finally:
            db.close()

    def test_current_version_acknowledgement_blocks_direct_copy(self):
        self.stable_session().close()
        db = self.beta_session()
        try:
            beta_bootstrap.write_marker("empty")
            with self.assertRaises(beta_bootstrap.BetaBootstrapConflict):
                beta_bootstrap.stage_stable_copy(
                    db,
                    confirm_replace_existing_beta=True,
                )
        finally:
            db.close()

    def test_marker_from_an_older_beta_requires_a_new_choice(self):
        db = self.beta_session()
        try:
            beta_bootstrap.marker_path().write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "decision": "copied",
                        "completedAt": "2026-07-01T00:00:00Z",
                        "sourceDatabaseInstanceId": "stable-id",
                        "sourceSchemaRevision": "0012",
                    }
                ),
                encoding="utf-8",
            )
            status = beta_bootstrap.build_status(db)
            self.assertTrue(status["needsChoice"])
            self.assertFalse(status["betaHasExistingLibrary"])
            self.assertIsNone(status["acknowledgedAppVersion"])

            result = beta_bootstrap.use_current_library(db)
            self.assertEqual(result["decision"], "copied")
            marker = beta_bootstrap.read_marker()
            self.assertEqual(marker["appVersion"], beta_bootstrap.APP_VERSION)
            self.assertEqual(marker["installInstanceId"], "test-install")
            self.assertEqual(marker["sourceDatabaseInstanceId"], "stable-id")
            self.assertFalse(beta_bootstrap.build_status(db)["needsChoice"])
        finally:
            db.close()

    def test_corrupt_marker_blocks_setup(self):
        db = self.beta_session()
        try:
            beta_bootstrap.marker_path().write_text("{not json", encoding="utf-8")
            status = beta_bootstrap.build_status(db)
            self.assertEqual(status["setupState"], "blocked-error")
            self.assertFalse(status["needsChoice"])
            self.assertIsNotNone(status["setupError"])
            self.assertEqual(status["blockingReason"], status["setupError"])
        finally:
            db.close()

    def test_apply_failure_keeps_choice_and_reports_message(self):
        db = self.beta_session()
        try:
            beta_bootstrap.apply_failure_path().write_text(
                json.dumps({"schemaVersion": 1, "message": "Activation failed and was rolled back."}),
                encoding="utf-8",
            )
            status = beta_bootstrap.build_status(db)
            self.assertTrue(status["needsChoice"])
            self.assertEqual(status["setupState"], "choice-required")
            self.assertEqual(
                status["applyFailureMessage"], "Activation failed and was rolled back."
            )
            self.assertIsNone(status["setupError"])
        finally:
            db.close()

    def test_unreadable_apply_failure_is_ignored(self):
        db = self.beta_session()
        try:
            beta_bootstrap.apply_failure_path().write_text("{broken", encoding="utf-8")
            status = beta_bootstrap.build_status(db)
            self.assertIsNone(status["applyFailureMessage"])
            self.assertTrue(status["needsChoice"])
        finally:
            db.close()

    def test_non_pristine_beta_stages_explicit_replacement(self):
        self.stable_session().close()
        db = self.beta_session()
        try:
            db.add(Cell(name="Existing cell"))
            db.commit()
            with self.assertRaises(beta_bootstrap.BetaBootstrapConflict):
                beta_bootstrap.stage_stable_copy(db)
            result = beta_bootstrap.stage_stable_copy(
                db,
                confirm_replace_existing_beta=True,
            )
            self.assertTrue(result["replaceExistingBeta"])
            manifest = json.loads(
                (
                    beta_bootstrap.bootstrap_root()
                    / result["token"]
                    / beta_bootstrap.MANIFEST_NAME
                ).read_text(encoding="utf-8")
            )
            self.assertTrue(manifest["replaceExistingBeta"])
        finally:
            db.close()

    def test_absent_stable_blocks_copy_but_allows_empty(self):
        db = self.beta_session()
        try:
            status = beta_bootstrap.build_status(db)
            self.assertTrue(status["needsChoice"])
            self.assertFalse(status["stableDatabaseCompatible"])
            self.assertIsNotNone(status["copyBlockingReason"])
            with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
                beta_bootstrap.stage_stable_copy(db)
            beta_bootstrap.start_empty_library(db)
        finally:
            db.close()

    # --- R7: Stable database recognition -------------------------------------------------

    def test_unrelated_sqlite_database_is_unrecognized(self):
        self.write_raw_stable_database(["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"])
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.exists)
        self.assertTrue(inspection.unrecognized)
        self.assertFalse(inspection.compatible)
        self.assertFalse(inspection.corrupt)
        self.assertFalse(inspection.too_new)

    def test_table_less_sqlite_database_is_unrecognized(self):
        self.write_raw_stable_database(
            ["CREATE TABLE placeholder (id INTEGER)", "DROP TABLE placeholder"]
        )
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.exists)
        self.assertTrue(inspection.unrecognized)
        self.assertFalse(inspection.compatible)

    def test_partial_cellxplorer_schema_is_unrecognized(self):
        self.write_raw_stable_database(["CREATE TABLE source_files (id INTEGER PRIMARY KEY)"])
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.unrecognized)
        self.assertFalse(inspection.compatible)

    def test_unknown_revision_is_unrecognized(self):
        self.stable_session().close()
        self.stamp_stable_revision("zz9")
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.unrecognized)
        self.assertFalse(inspection.too_new)
        self.assertFalse(inspection.compatible)
        self.assertEqual(inspection.schema_revision, "zz9")

    def test_future_revision_is_too_new(self):
        self.stable_session().close()
        self.stamp_stable_revision("9999")
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.too_new)
        self.assertFalse(inspection.unrecognized)
        self.assertFalse(inspection.compatible)

    def test_corrupt_stable_database_is_reported_corrupt(self):
        self.stable_db_path.write_bytes(b"this is not a sqlite database" * 40)
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.corrupt)
        self.assertFalse(inspection.compatible)

    def test_migrated_stable_database_is_compatible(self):
        self.stable_session().close()
        self.dispose_engines()
        inspection = beta_bootstrap.inspect_stable_database()
        self.assertTrue(inspection.compatible)
        self.assertIsNotNone(inspection.schema_revision)

    def test_inspection_never_migrates_stable(self):
        self.stable_session().close()
        self.dispose_engines()
        self.stamp_stable_revision("0001")
        before_hash = beta_bootstrap._sha256_file(self.stable_db_path)
        before_mtime = self.stable_db_path.stat().st_mtime_ns

        inspection = beta_bootstrap.inspect_stable_database()

        self.assertTrue(inspection.compatible)
        self.assertEqual(inspection.schema_revision, "0001")
        self.assertEqual(beta_bootstrap._sha256_file(self.stable_db_path), before_hash)
        self.assertEqual(self.stable_db_path.stat().st_mtime_ns, before_mtime)
        self.assertFalse(hasattr(beta_bootstrap, "migrate_database"))

    # --- Staging -------------------------------------------------------------------------

    def test_stage_copy_creates_manifest_and_new_instance_id(self):
        stable_db = self.stable_session()
        stable_instance = None
        stable_path = self.stable_db_path
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
            with closing(
                sqlite3.connect(stage_dir / beta_bootstrap.STAGED_DB_NAME)
            ) as staged:
                raw_preparation = staged.execute(
                    "SELECT value FROM app_settings WHERE key = ?",
                    (SCIENTIFIC_PREPARATION_KEY,),
                ).fetchone()
            self.assertIsNotNone(raw_preparation)
            self.assertEqual(json.loads(raw_preparation[0])["status"], "pending")
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

            staged_path = self._staged_source_paths(stage_dir)[0]
            self.assertEqual(
                Path(staged_path),
                (self.beta_root / "imports" / "batch" / "sample.nda").resolve(),
            )
        finally:
            beta_db.close()

    def test_external_source_paths_are_preserved(self):
        external_dir = Path(self._tmpdir.name) / "elsewhere"
        external_dir.mkdir()
        external_file = external_dir / "external.ndax"
        external_file.write_bytes(b"external-bytes")
        original = str(external_file.resolve())

        stable_db = self.stable_session()
        try:
            stable_db.add(
                SourceFile(
                    path=original,
                    filename="external.ndax",
                    ext="ndax",
                    hash=beta_bootstrap._sha256_file(external_file),
                    size=external_file.stat().st_size,
                )
            )
            stable_db.commit()
        finally:
            stable_db.close()

        beta_db = self.beta_session()
        try:
            result = beta_bootstrap.stage_stable_copy(beta_db)
            self.assertEqual(result["externalSourcePaths"], 1)
            self.assertEqual(result["copiedImports"], 0)
            stage_dir = beta_bootstrap.bootstrap_root() / result["token"]
            self.assertEqual(self._staged_source_paths(stage_dir), [original])
        finally:
            beta_db.close()

    def test_stage_contains_only_database_manifest_and_imports(self):
        (self.stable_root / "cache").mkdir()
        (self.stable_root / "cache" / "cycles.parquet").write_bytes(b"cache")
        (self.stable_root / "logs").mkdir()
        (self.stable_root / "logs" / "backend.log").write_text("log", encoding="utf-8")
        (self.stable_root / "backups").mkdir()
        (self.stable_root / "backups" / "old.db").write_bytes(b"backup")

        self.stable_session().close()

        beta_db = self.beta_session()
        try:
            result = beta_bootstrap.stage_stable_copy(beta_db)
            stage_dir = beta_bootstrap.bootstrap_root() / result["token"]
            names = {item.name for item in stage_dir.iterdir()}
            self.assertTrue(
                names <= {beta_bootstrap.MANIFEST_NAME, beta_bootstrap.STAGED_DB_NAME, "imports"},
                names,
            )
            self.assertFalse((stage_dir / "cache").exists())
            self.assertFalse((stage_dir / "logs").exists())
            self.assertFalse((stage_dir / "backups").exists())
        finally:
            beta_db.close()

    # --- R5: self-verifying manifest ------------------------------------------------------

    def test_manifest_records_database_digest_and_import_inventory(self):
        stable_imports = self.stable_root / "imports" / "batch"
        stable_imports.mkdir(parents=True)
        payload = b"a" * (beta_bootstrap.COPY_CHUNK_SIZE + 1234)
        import_file = stable_imports / "big.nda"
        import_file.write_bytes(payload)

        stable_db = self.stable_session()
        try:
            stable_db.add(
                SourceFile(
                    path=str(import_file.resolve()),
                    filename="big.nda",
                    ext="nda",
                    hash=beta_bootstrap._sha256_file(import_file),
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
            manifest = json.loads(
                (stage_dir / beta_bootstrap.MANIFEST_NAME).read_text(encoding="utf-8")
            )
            staged_db = stage_dir / beta_bootstrap.STAGED_DB_NAME
            self.assertEqual(manifest["schemaVersion"], beta_bootstrap.MANIFEST_SCHEMA_VERSION)
            self.assertEqual(manifest["token"], result["token"])
            self.assertEqual(manifest["stagedDatabase"], beta_bootstrap.STAGED_DB_NAME)
            self.assertEqual(
                manifest["stagedDatabaseSha256"], beta_bootstrap._sha256_file(staged_db)
            )
            self.assertEqual(manifest["stagedDatabaseSize"], staged_db.stat().st_size)
            self.assertEqual(manifest["copiedImports"], 1)
            self.assertFalse(manifest["replaceExistingBeta"])
            self.assertEqual(len(manifest["imports"]), 1)
            entry = manifest["imports"][0]
            self.assertEqual(entry["relativePath"], "batch/big.nda")
            self.assertEqual(entry["size"], len(payload))
            self.assertEqual(
                entry["sha256"],
                beta_bootstrap._sha256_file(stage_dir / "imports" / "batch" / "big.nda"),
            )
        finally:
            beta_db.close()

    # --- R8: streaming import copy ---------------------------------------------------------

    def test_copy_import_streaming_copies_large_file(self):
        source = Path(self._tmpdir.name) / "source.nda"
        payload = bytes(range(256)) * 12_000
        source.write_bytes(payload)
        target = Path(self._tmpdir.name) / "staged" / "source.nda"
        size, digest = beta_bootstrap._copy_import_streaming(
            source, target, len(payload), beta_bootstrap._sha256_file(source)
        )
        self.assertEqual(size, len(payload))
        self.assertEqual(digest, beta_bootstrap._sha256_file(source))
        self.assertEqual(target.read_bytes(), payload)
        self.assertFalse(target.with_suffix(target.suffix + ".tmp").exists())

    def test_copy_import_streaming_rejects_checksum_mismatch(self):
        source = Path(self._tmpdir.name) / "source.nda"
        source.write_bytes(b"payload")
        target = Path(self._tmpdir.name) / "staged" / "source.nda"
        with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
            beta_bootstrap._copy_import_streaming(source, target, 7, "0" * 64)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(target.suffix + ".tmp").exists())

    def test_stage_copy_aborts_on_import_checksum_mismatch(self):
        stable_imports = self.stable_root / "imports"
        stable_imports.mkdir(parents=True)
        import_file = stable_imports / "bad.nda"
        import_file.write_bytes(b"payload")

        stable_db = self.stable_session()
        try:
            stable_db.add(
                SourceFile(
                    path=str(import_file.resolve()),
                    filename="bad.nda",
                    ext="nda",
                    hash="0" * 64,
                    size=import_file.stat().st_size,
                )
            )
            stable_db.commit()
        finally:
            stable_db.close()

        beta_db = self.beta_session()
        try:
            with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
                beta_bootstrap.stage_stable_copy(beta_db)
            self.assertIsNone(beta_bootstrap.find_outstanding_stage_token())
            self.assertIsNone(beta_bootstrap._active_stage_token)
            leftovers = list(beta_bootstrap.bootstrap_root().rglob("*.nda*"))
            self.assertEqual(leftovers, [])
        finally:
            beta_db.close()

    # --- R6: stage ownership, discard, cleanup ---------------------------------------------

    def test_status_reports_outstanding_stage_token(self):
        self.stable_session().close()
        beta_db = self.beta_session()
        try:
            result = beta_bootstrap.stage_stable_copy(beta_db)
            status = beta_bootstrap.build_status(beta_db)
            self.assertEqual(status["outstandingStageToken"], result["token"])
        finally:
            beta_db.close()

    def test_outstanding_stage_is_recovered_after_restart(self):
        self.stable_session().close()
        beta_db = self.beta_session()
        try:
            result = beta_bootstrap.stage_stable_copy(beta_db)
            beta_bootstrap._active_stage_token = None
            status = beta_bootstrap.build_status(beta_db)
            self.assertEqual(status["outstandingStageToken"], result["token"])
            self.assertEqual(beta_bootstrap._active_stage_token, result["token"])
        finally:
            beta_db.close()

    def test_second_stage_copy_conflicts_while_staged(self):
        self.stable_session().close()
        beta_db = self.beta_session()
        try:
            beta_bootstrap.stage_stable_copy(beta_db)
            with self.assertRaises(beta_bootstrap.BetaBootstrapConflict) as raised:
                beta_bootstrap.stage_stable_copy(beta_db)
            self.assertIn("already staged", str(raised.exception))
        finally:
            beta_db.close()

    def test_discard_stage_removes_stage_and_allows_restage(self):
        self.stable_session().close()
        beta_db = self.beta_session()
        try:
            first = beta_bootstrap.stage_stable_copy(beta_db)
            stage_dir = beta_bootstrap.bootstrap_root() / first["token"]
            outcome = beta_bootstrap.discard_stage(first["token"])
            self.assertTrue(outcome["removed"])
            self.assertFalse(stage_dir.exists())
            self.assertIsNone(beta_bootstrap._active_stage_token)
            self.assertFalse(
                (beta_bootstrap.bootstrap_root() / beta_bootstrap.LOCK_NAME).is_file()
            )
            self.assertIsNone(beta_bootstrap.find_outstanding_stage_token())

            second = beta_bootstrap.stage_stable_copy(beta_db)
            self.assertNotEqual(second["token"], first["token"])
        finally:
            beta_db.close()

    def test_discard_stage_rejects_unknown_and_malformed_tokens(self):
        with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
            beta_bootstrap.discard_stage("../escape")
        with self.assertRaises(beta_bootstrap.BetaBootstrapValidation):
            beta_bootstrap.discard_stage("f" * 32)

    def test_cleanup_keeps_active_and_newest_stage(self):
        active = "a" * 32
        newest = "b" * 32
        middle = "c" * 32
        oldest = "d" * 32
        self.make_stage_dir(active, age_hours=0.0)
        self.make_stage_dir(newest, age_hours=30.0)
        self.make_stage_dir(middle, age_hours=48.0)
        self.make_stage_dir(oldest, age_hours=96.0)

        beta_bootstrap._cleanup_stale_staging(active_token=active)

        root = beta_bootstrap.bootstrap_root()
        self.assertTrue((root / active).is_dir())
        self.assertTrue((root / newest).is_dir())
        self.assertFalse((root / middle).exists())
        self.assertFalse((root / oldest).exists())

    def test_cleanup_keeps_recent_stages_within_retention(self):
        recent_a = "a" * 32
        recent_b = "b" * 32
        self.make_stage_dir(recent_a, age_hours=1.0)
        self.make_stage_dir(recent_b, age_hours=2.0)

        beta_bootstrap._cleanup_stale_staging(active_token=None)

        root = beta_bootstrap.bootstrap_root()
        self.assertTrue((root / recent_a).is_dir())
        self.assertTrue((root / recent_b).is_dir())

    def _staged_source_paths(self, stage_dir: Path) -> list[str]:
        staged_db = stage_dir / beta_bootstrap.STAGED_DB_NAME
        with closing(sqlite3.connect(staged_db)) as connection:
            rows = connection.execute("SELECT path FROM source_files ORDER BY id").fetchall()
        return [str(row[0]) for row in rows]


if __name__ == "__main__":
    unittest.main()
