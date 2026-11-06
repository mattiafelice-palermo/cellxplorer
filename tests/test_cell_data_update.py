import os
import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from alembic.migration import MigrationContext
from alembic.operations import Operations

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
from app.db import Base
from app.models import Cell, Test, TestFile, SourceFile
from app.migrations.versions import v0006_cell_data_update


class CellDataUpdateTests(unittest.TestCase):
    def test_import_refresh_and_checks_have_distinct_clocks(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            cell = Cell(name="clock")
            test = Test(cell=cell, name="internal")
            source = SourceFile(hash="a" * 64, path="a.mpr", filename="a.mpr", size=1, ext="mpr", parse_status="parsed")
            db.add_all([cell, test, source])
            db.flush()
            self.assertIsNone(cell.last_data_update_at)
            first = datetime(2026, 1, 1, tzinfo=timezone.utc)
            with patch("app.models.utcnow", return_value=first):
                db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
                db.commit()
            db.refresh(cell)
            self.assertEqual(cell.last_data_update_at, first.replace(tzinfo=None))
            source.last_source_check_at = datetime.now(timezone.utc)
            source.location_status = "changed"
            cell.description = "edited notes"
            db.commit()
            db.refresh(cell)
            self.assertEqual(cell.last_data_update_at, first.replace(tzinfo=None))
            second = datetime(2026, 1, 2, tzinfo=timezone.utc)
            with patch("app.models.utcnow", return_value=second):
                source.hash = "b" * 64
                source.row_count = 42
                db.commit()
            db.refresh(cell)
            self.assertEqual(cell.last_data_update_at, second.replace(tzinfo=None))
        engine.dispose()

    def test_migration_preserves_existing_cells_and_unknown_history(self):
        engine = create_engine("sqlite://")
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE cells (id INTEGER PRIMARY KEY, name TEXT)"))
            connection.execute(text("INSERT INTO cells VALUES (1, 'existing')"))
            operations = Operations(MigrationContext.configure(connection))
            v0006_cell_data_update.upgrade(operations, connection)
            v0006_cell_data_update.upgrade(operations, connection)
            self.assertEqual(tuple(connection.execute(text("SELECT id, name, last_data_update_at FROM cells")).one()), (1, "existing", None))
        engine.dispose()
