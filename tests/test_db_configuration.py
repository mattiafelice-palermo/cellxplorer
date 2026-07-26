import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine, event

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import _enable_write_ahead_logging, _set_sqlite_pragma


class DatabaseConfigurationTests(unittest.TestCase):
    def test_connections_use_foreign_keys_and_a_busy_timeout(self):
        connection = sqlite3.connect(":memory:")
        try:
            _set_sqlite_pragma(connection, None)
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
        finally:
            connection.close()

    def test_wal_is_enabled_once_before_concurrent_connections(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cellxplorer.db"
            engine = create_engine(
                f"sqlite:///{path.as_posix()}",
                connect_args={"check_same_thread": False, "timeout": 5.0},
            )
            event.listen(engine, "connect", _set_sqlite_pragma)

            _enable_write_ahead_logging(engine)

            with engine.connect() as connection:
                self.assertEqual(
                    connection.exec_driver_sql("PRAGMA journal_mode").scalar_one(),
                    "wal",
                )
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
