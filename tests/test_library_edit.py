import os
import sys
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import ActivityEvent, Cell, CellMetadata, SourceFile, Test, TestFile
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

    def test_update_cell_scientific_overrides_preserve_source_values(self):
        db = self.make_session()
        cell = Cell(name="Cell A")
        test = Test(cell=cell, name="Cycling")
        source = SourceFile(
            hash="a" * 64,
            path="C:/cell.ndax",
            filename="cell.ndax",
            size=10,
            ext="ndax",
            active_mass_mg=10.0,
            nominal_capacity_mah=2.0,
        )
        db.add_all([cell, test, source])
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.commit()

        result = library.update_cell(
            cell.id,
            library.CellUpdate(
                active_mass_mg_override=12.5,
                nominal_capacity_mah_override=2.2,
                electrode_area_cm2_override=1.539,
                active_material_preset_id="lab-lfp",
                active_material_name="Lab LFP",
                active_material_specific_capacity_mah_g=176,
                electrode_area_preset_id="coin-14mm",
                electrode_area_preset_name="14 mm circular electrode",
            ),
            db=db,
        )

        self.assertEqual(source.active_mass_mg, 10.0)
        self.assertEqual(result["scientific_metadata"]["active_mass_mg"]["source_value"], 10.0)
        self.assertEqual(result["scientific_metadata"]["active_mass_mg"]["effective_value"], 12.5)
        self.assertEqual(result["scientific_metadata"]["electrode_area_cm2"]["effective_value"], 1.539)
        self.assertEqual(
            result["scientific_presets"]["active_material"]["name"],
            "Lab LFP",
        )
        self.assertEqual(
            result["scientific_presets"]["active_material"]["specific_capacity_mah_g"],
            176,
        )
        self.assertEqual(
            result["scientific_presets"]["electrode_area_preset_name"],
            "14 mm circular electrode",
        )
        keys = {row.key: row.value for row in db.query(CellMetadata).all()}
        self.assertEqual(keys["override.active_mass_mg"], "12.5")

        cleared = library.update_cell(
            cell.id,
            library.CellUpdate(active_mass_mg_override=None),
            db=db,
        )
        self.assertEqual(cleared["scientific_metadata"]["active_mass_mg"]["effective_value"], 10.0)


if __name__ == "__main__":
    unittest.main()
