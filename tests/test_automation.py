import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.routers import automation as automation_router
from app.services import automation, source_monitor


class AutomationPauseTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        return factory(), factory

    def test_pause_and_resume_round_trip(self):
        db, _ = self.make_session()
        idle = automation.pause_state(db)
        self.assertFalse(idle["paused"])
        self.assertIsNone(idle["paused_until"])
        self.assertIsNone(idle["seconds_remaining"])

        paused = automation.set_pause(db, 120)
        self.assertTrue(paused["paused"])
        self.assertIsNotNone(paused["paused_until"])
        self.assertGreater(paused["seconds_remaining"], 100 * 60)
        self.assertTrue(automation.is_paused(db))

        resumed = automation.set_pause(db, None)
        self.assertFalse(resumed["paused"])
        self.assertFalse(automation.is_paused(db))

    def test_expired_pause_is_not_active(self):
        db, _ = self.make_session()
        past = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        automation._set(db, automation.PAUSE_KEY, past)
        db.commit()
        state = automation.pause_state(db)
        self.assertFalse(state["paused"])
        self.assertIsNone(state["seconds_remaining"])

    def test_pause_endpoint_rejects_out_of_range_and_accepts_resume(self):
        db, _ = self.make_session()
        with self.assertRaises(HTTPException) as raised:
            automation_router.set_automation_pause(
                automation_router.PauseRequest(minutes=automation.MAX_PAUSE_MINUTES + 1),
                db,
            )
        self.assertEqual(raised.exception.status_code, 422)

        ok = automation_router.set_automation_pause(
            automation_router.PauseRequest(minutes=30),
            db,
        )
        self.assertTrue(ok["paused"])
        resumed = automation_router.set_automation_pause(
            automation_router.PauseRequest(minutes=0),
            db,
        )
        self.assertFalse(resumed["paused"])
        get_state = automation_router.get_automation_pause(db)
        self.assertFalse(get_state["paused"])

    def test_scheduler_skips_starting_work_while_paused(self):
        db, factory = self.make_session()
        source_monitor.save_config(
            db,
            {
                **source_monitor.DEFAULT_CONFIG,
                "enabled": True,
                "interval_value": 1,
                "interval_unit": "hours",
            },
        )
        before_next = source_monitor._get(db, source_monitor.NEXT_RUN_KEY)
        automation.set_pause(db, 60)

        started = []

        def fake_wait(_seconds):
            source_monitor._stop_event.set()
            return True

        originals = (
            source_monitor.SessionLocal,
            source_monitor._wake_event.wait,
        )
        try:
            source_monitor._stop_event.clear()
            source_monitor._wake_event.clear()
            source_monitor.SessionLocal = factory
            source_monitor._wake_event.wait = fake_wait
            with mock.patch(
                "app.routers.library.start_source_check_job",
                side_effect=lambda *args, **kwargs: started.append(True),
            ):
                source_monitor._run_scheduler()
        finally:
            (
                source_monitor.SessionLocal,
                source_monitor._wake_event.wait,
            ) = originals
            source_monitor._stop_event.clear()
            source_monitor._wake_event.clear()

        self.assertEqual(started, [])
        db.expire_all()
        self.assertEqual(source_monitor._get(db, source_monitor.LAST_STATUS_KEY), "paused")
        self.assertEqual(source_monitor._get(db, source_monitor.NEXT_RUN_KEY), before_next)


if __name__ == "__main__":
    unittest.main()
