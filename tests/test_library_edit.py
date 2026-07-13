import os
import sys
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import ActivityEvent, Cell
from app.routers import library


class LibraryCellEditTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_update_cell_edits_user_fields_and_records_activity(self):
        db = self.make_session()
        cell = Cell(name="Cell A", description="Original notes")
        db.add(cell)
        db.commit()

        result = library.update_cell(
            cell.id,
            library.CellUpdate(name="  Cell A renamed  ", description="  Revised notes  "),
            db=db,
        )

        self.assertEqual(result["name"], "Cell A renamed")
        self.assertEqual(result["description"], "Revised notes")
        event = db.query(ActivityEvent).filter(ActivityEvent.action == "edit_cell").one()
        self.assertEqual(event.entity_id, cell.id)
        self.assertEqual(event.details["changed_fields"], ["name", "notes"])
        self.assertNotIn("Revised notes", str(event.details))

    def test_update_cell_rejects_blank_and_duplicate_names(self):
        db = self.make_session()
        first = Cell(name="Cell A")
        second = Cell(name="Cell B")
        db.add_all([first, second])
        db.commit()

        with self.assertRaises(HTTPException) as blank:
            library.update_cell(first.id, library.CellUpdate(name="   "), db=db)
        self.assertEqual(blank.exception.status_code, 400)

        with self.assertRaises(HTTPException) as duplicate:
            library.update_cell(first.id, library.CellUpdate(name="Cell B"), db=db)
        self.assertEqual(duplicate.exception.status_code, 409)
        self.assertEqual(db.get(Cell, first.id).name, "Cell A")


if __name__ == "__main__":
    unittest.main()
