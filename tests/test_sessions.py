import os
import sys
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import AppSession
from app.services import sessions


class AppSessionTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_new_startup_closes_stale_session_and_clean_quit_records_finish(self):
        db = self.make_session()
        first = sessions.begin_session(
            db,
            startup_mode="manual",
            app_version="0.2.0",
            backend_pid=10,
        )
        second = sessions.begin_session(
            db,
            startup_mode="startup",
            app_version="0.2.0",
            backend_pid=11,
        )

        db.refresh(first)
        self.assertEqual(first.status, "interrupted")
        self.assertEqual(first.exit_reason, "process_ended_without_shutdown")
        self.assertIsNotNone(first.finished_at)
        self.assertEqual(second.status, "running")
        self.assertEqual(second.startup_mode, "startup")

        finished = sessions.finish_session(db, second.id, exit_reason="tray_quit")
        self.assertIsNotNone(finished)
        self.assertEqual(finished.status, "closed")
        self.assertEqual(finished.exit_reason, "tray_quit")
        self.assertIsNotNone(finished.finished_at)
        self.assertEqual(db.query(AppSession).count(), 2)


if __name__ == "__main__":
    unittest.main()
