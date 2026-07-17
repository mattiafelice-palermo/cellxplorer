import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from sqlalchemy import create_engine, inspect

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app import models  # noqa: F401
from app.db import Base
from app.migrations.registry import CURRENT_SCHEMA_REVISION
from app.services.database_migrations import migrate_database


class DatabaseMigrationTests(unittest.TestCase):
    def make_database(self, root: Path):
        path = root / "cellxplorer.db"
        engine = create_engine(
            f"sqlite:///{path.as_posix()}",
            connect_args={"check_same_thread": False},
        )
        return path, engine

    def test_fresh_database_is_created_and_versioned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)

            status = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertTrue(status.compatible)
            self.assertEqual(status.status, "ready")
            self.assertEqual(status.schema_revision, CURRENT_SCHEMA_REVISION)
            self.assertTrue(status.migration_performed)
            self.assertIsNone(status.backup_path)
            self.assertIn("cells", inspect(engine).get_table_names())
            with closing(sqlite3.connect(path)) as connection:
                revision = connection.execute(
                    "SELECT version_num FROM alembic_version"
                ).fetchone()[0]
            self.assertEqual(revision, CURRENT_SCHEMA_REVISION)
            engine.dispose()

    def test_unversioned_cellxplorer_database_is_backed_up_and_stamped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)
            Base.metadata.create_all(engine)
            with engine.begin() as connection:
                connection.exec_driver_sql(
                    "INSERT INTO cells "
                    "(name, archived, cycling_status, created_at) "
                    "VALUES ('Legacy cell', 0, 'active', CURRENT_TIMESTAMP)"
                )

            status = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertTrue(status.compatible)
            self.assertTrue(status.legacy_database)
            self.assertTrue(status.migration_performed)
            self.assertIsNotNone(status.backup_path)
            self.assertTrue(Path(status.backup_path).exists())
            with closing(sqlite3.connect(status.backup_path)) as backup:
                row = backup.execute(
                    "SELECT name FROM cells WHERE name = 'Legacy cell'"
                ).fetchone()
                version_table = backup.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'alembic_version'"
                ).fetchone()
            self.assertEqual(row[0], "Legacy cell")
            self.assertIsNone(version_table)
            engine.dispose()

    def test_baseline_adds_columns_from_the_old_runtime_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)
            Base.metadata.create_all(engine)
            with engine.begin() as connection:
                connection.exec_driver_sql(
                    "ALTER TABLE cells DROP COLUMN cycling_status"
                )

            status = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertTrue(status.compatible)
            columns = {
                column["name"]
                for column in inspect(engine).get_columns("cells")
            }
            self.assertIn("cycling_status", columns)
            engine.dispose()

    def test_current_database_opens_without_another_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)
            first = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )
            second = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertTrue(first.migration_performed)
            self.assertFalse(second.migration_performed)
            self.assertTrue(second.compatible)
            self.assertEqual(second.message, "The database schema is current.")
            engine.dispose()

    def test_future_database_revision_is_refused_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("BEGIN")
                connection.execute(
                    "CREATE TABLE alembic_version "
                    "(version_num VARCHAR(32) PRIMARY KEY NOT NULL)"
                )
                connection.execute(
                    "INSERT INTO alembic_version VALUES ('9999')"
                )
                connection.commit()

            status = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertFalse(status.compatible)
            self.assertEqual(status.status, "database_too_new")
            self.assertEqual(status.schema_revision, "9999")
            self.assertFalse((root / "backups").exists())
            engine.dispose()

    def test_unknown_nonempty_database_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("CREATE TABLE unrelated (id INTEGER)")
                connection.commit()

            status = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertFalse(status.compatible)
            self.assertEqual(status.status, "database_unrecognized")
            self.assertFalse((root / "backups").exists())
            engine.dispose()

    def test_corrupt_database_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, engine = self.make_database(root)
            path.write_bytes(b"this is not sqlite")

            status = migrate_database(
                engine,
                path,
                backup_dir=root / "backups",
            )

            self.assertFalse(status.compatible)
            self.assertEqual(status.status, "database_corrupt")
            self.assertFalse((root / "backups").exists())
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
