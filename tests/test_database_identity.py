import os
import sys
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import AppSetting
from app.services.database_identity import (
    DATABASE_INSTANCE_ID_KEY,
    ensure_database_instance_id,
)


class DatabaseIdentityTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_database_identity_is_created_once_and_remains_stable(self):
        db = self.make_session()

        first = ensure_database_instance_id(db)
        second = ensure_database_instance_id(db)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 36)
        setting = db.get(AppSetting, DATABASE_INSTANCE_ID_KEY)
        self.assertIsNotNone(setting)
        self.assertEqual(setting.value, first)
        self.assertEqual(
            db.query(AppSetting)
            .filter(AppSetting.key == DATABASE_INSTANCE_ID_KEY)
            .count(),
            1,
        )


if __name__ == "__main__":
    unittest.main()
