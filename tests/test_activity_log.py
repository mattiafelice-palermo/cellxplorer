import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.routers import activity
from app.services.activity_log import record_activity


class ActivityLogTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_record_activity_persists_json_details_and_lists_newest_first(self):
        db = self.make_session()
        started_at = datetime(2026, 7, 14, 10, 0, tzinfo=timezone.utc)
        finished_at = started_at + timedelta(seconds=12)

        older = record_activity(
            db,
            category="import",
            action="created_cells",
            message="Imported 2 cells",
            severity="info",
            entity_type="cell",
            entity_id=10,
            details={"cell_ids": [10, 11]},
        )
        newer = record_activity(
            db,
            category="source",
            action="check_sources",
            message="Checked 3 source files",
            severity="warning",
            details={"changed": 1},
            started_at=started_at,
            finished_at=finished_at,
        )
        db.commit()

        rows = activity.list_activity(limit=20, db=db)

        self.assertEqual([row["id"] for row in rows], [newer.id, older.id])
        self.assertEqual(rows[0]["severity"], "warning")
        self.assertEqual(rows[0]["details"], {"changed": 1})
        self.assertEqual(rows[0]["started_at"], started_at.isoformat())
        self.assertEqual(rows[0]["finished_at"], finished_at.isoformat())
        self.assertEqual(rows[1]["entity_type"], "cell")
        self.assertEqual(rows[1]["entity_id"], 10)


if __name__ == "__main__":
    unittest.main()
