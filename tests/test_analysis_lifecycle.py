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
from app.models import Cell, Folder, ReplicateGroup, ReplicateGroupCell
from app.routers import analyses, tree


class AnalysisLifecycleTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_deleted_analysis_id_is_not_reused(self):
        db = self.make_session()
        first = analyses.create_analysis(analyses.AnalysisCreate(title="First"), db=db)
        analyses.delete_analysis(first["id"], db=db)
        second = analyses.create_analysis(analyses.AnalysisCreate(title="Second"), db=db)

        self.assertGreater(second["id"], first["id"])

    def test_duplicate_titles_are_prefixed_and_numbered(self):
        db = self.make_session()
        original = analyses.create_analysis(analyses.AnalysisCreate(title="Capacity study"), db=db)

        first = analyses.duplicate_analysis(original["id"], db=db)
        second = analyses.duplicate_analysis(original["id"], db=db)

        self.assertEqual(first["title"], "(copy) Capacity study")
        self.assertEqual(second["title"], "(copy 2) Capacity study")
        self.assertGreater(second["id"], first["id"])

    def test_duplicate_can_be_copied_directly_to_another_folder(self):
        db = self.make_session()
        source = Folder(name="Source")
        target = Folder(name="Target")
        db.add_all([source, target])
        db.commit()
        original = analyses.create_analysis(
            analyses.AnalysisCreate(title="Capacity study", folder_id=source.id), db=db
        )

        copied = analyses.duplicate_analysis(
            original["id"],
            analyses.AnalysisDuplicateRequest(folder_id=target.id),
            db=db,
        )

        self.assertEqual(copied["folder"]["id"], target.id)
        self.assertEqual(copied["title"], "(copy) Capacity study")

    def test_renaming_analysis_updates_spec_title(self):
        db = self.make_session()
        created = analyses.create_analysis(analyses.AnalysisCreate(title="Old title"), db=db)

        updated = analyses.update_analysis(
            created["id"], analyses.AnalysisUpdate(title="New title"), db=db
        )

        self.assertEqual(updated["title"], "New title")
        self.assertEqual(updated["spec"]["title"], "New title")

    def test_analysis_detail_includes_lightweight_selected_sample_identities(self):
        db = self.make_session()
        standalone = Cell(name="Standalone")
        grouped = Cell(name="Grouped")
        group = ReplicateGroup(name="Replicate A")
        group.cell_links = [ReplicateGroupCell(cell=grouped)]
        db.add_all([standalone, group])
        db.commit()
        spec = analyses.engine.default_spec("Identity test")
        spec["selection"]["entries"] = [
            {"kind": "cell", "ref_id": standalone.id},
            {"kind": "replicate_group", "ref_id": group.id},
        ]

        created = analyses.create_analysis(
            analyses.AnalysisCreate(title="Identity test", spec=spec), db=db
        )

        self.assertEqual(created["selection_cells"][0]["name"], "Standalone")
        self.assertEqual(created["selection_groups"][0]["name"], "Replicate A")
        self.assertEqual(created["selection_groups"][0]["cells"][0]["name"], "Grouped")

    def test_analysis_can_be_created_with_validated_initial_entries(self):
        db = self.make_session()
        cell = Cell(name="Selected cell")
        group = ReplicateGroup(name="Selected replicate")
        db.add_all([cell, group])
        db.commit()

        created = analyses.create_analysis(
            analyses.AnalysisCreate(
                title="Selected samples",
                entries=[
                    analyses.AnalysisSelectionEntryCreate(
                        kind="cell",
                        ref_id=cell.id,
                    ),
                    analyses.AnalysisSelectionEntryCreate(
                        kind="replicate_group",
                        ref_id=group.id,
                    ),
                    analyses.AnalysisSelectionEntryCreate(
                        kind="cell",
                        ref_id=cell.id,
                    ),
                ],
            ),
            db=db,
        )

        self.assertEqual(
            created["spec"]["selection"]["entries"],
            [
                {"kind": "cell", "ref_id": cell.id},
                {"kind": "replicate_group", "ref_id": group.id},
            ],
        )

    def test_analysis_initial_entries_reject_missing_references(self):
        db = self.make_session()

        with self.assertRaises(HTTPException) as error:
            analyses.create_analysis(
                analyses.AnalysisCreate(
                    title="Missing sample",
                    entries=[
                        analyses.AnalysisSelectionEntryCreate(
                            kind="cell",
                            ref_id=999,
                        )
                    ],
                ),
                db=db,
            )

        self.assertEqual(error.exception.status_code, 404)

    def test_analysis_index_summarizes_unique_cells_replicates_and_saved_plots(self):
        db = self.make_session()
        standalone = Cell(name="Standalone")
        shared = Cell(name="Shared")
        grouped = Cell(name="Grouped")
        group = ReplicateGroup(name="Replicate A")
        group.cell_links = [
            ReplicateGroupCell(cell=shared),
            ReplicateGroupCell(cell=grouped),
        ]
        db.add_all([standalone, shared, grouped, group])
        db.commit()
        spec = analyses.engine.default_spec("Index summary")
        spec["selection"]["entries"] = [
            {"kind": "cell", "ref_id": standalone.id},
            {"kind": "cell", "ref_id": shared.id},
            {"kind": "replicate_group", "ref_id": group.id},
        ]
        spec["saved_plots"] = [
            {
                "id": "capacity",
                "name": "Capacity",
                "tab": "cycles",
                "subtitle": "Discharge capacity vs cycle",
                "presentation": {"quantity": "discharge_capacity"},
            },
            {
                "id": "voltage",
                "name": "Voltage",
                "tab": "time_capacity",
                "subtitle": "Voltage vs time",
                "presentation": {"quantity": "voltage"},
            },
        ]
        analyses.create_analysis(
            analyses.AnalysisCreate(title="Index summary", spec=spec), db=db
        )

        summary = analyses.list_analyses(db=db)[0]

        self.assertEqual(summary["n_cells"], 3)
        self.assertEqual(summary["n_replicate_groups"], 1)
        self.assertEqual(summary["saved_plots"][0]["quantity"], "discharge_capacity")
        self.assertEqual(summary["saved_plots"][1]["subtitle"], "Voltage vs time")

    def test_copying_folder_tree_uses_monotonic_analysis_ids(self):
        db = self.make_session()
        folder = Folder(name="Source")
        db.add(folder)
        db.commit()
        original = analyses.create_analysis(
            analyses.AnalysisCreate(title="Folder analysis", folder_id=folder.id),
            db=db,
        )

        copied_folder = tree.copy_folder_tree(db, folder.id, None)
        db.commit()
        copied = db.query(analyses.Analysis).filter(
            analyses.Analysis.folder_id == copied_folder.id
        ).one()

        self.assertGreater(copied.id, original["id"])

    def test_analysis_names_are_unique_within_folder_only(self):
        db = self.make_session()
        first_folder = Folder(name="First folder")
        second_folder = Folder(name="Second folder")
        db.add_all([first_folder, second_folder])
        db.commit()
        analyses.create_analysis(
            analyses.AnalysisCreate(title="Capacity", folder_id=first_folder.id),
            db=db,
        )

        with self.assertRaises(HTTPException) as error:
            analyses.create_analysis(
                analyses.AnalysisCreate(title="capacity", folder_id=first_folder.id),
                db=db,
            )
        self.assertEqual(error.exception.status_code, 409)

        created = analyses.create_analysis(
            analyses.AnalysisCreate(title="Capacity", folder_id=second_folder.id),
            db=db,
        )
        self.assertEqual(created["folder"]["id"], second_folder.id)

    def test_moving_analysis_rejects_name_conflict_in_destination(self):
        db = self.make_session()
        first_folder = Folder(name="First folder")
        second_folder = Folder(name="Second folder")
        db.add_all([first_folder, second_folder])
        db.commit()
        analyses.create_analysis(
            analyses.AnalysisCreate(title="Capacity", folder_id=first_folder.id),
            db=db,
        )
        moving = analyses.create_analysis(
            analyses.AnalysisCreate(title="Capacity", folder_id=second_folder.id),
            db=db,
        )

        with self.assertRaises(HTTPException) as error:
            analyses.update_analysis(
                moving["id"],
                analyses.AnalysisUpdate(folder_id=first_folder.id),
                db=db,
            )
        self.assertEqual(error.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
