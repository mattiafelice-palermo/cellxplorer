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
from app.models import (Analysis, Cell, Folder, FolderCell, FolderReplicateGroup, ReplicateGroup,
                        ReplicateGroupCell, SourceFile, Test, TestFile)
from app.routers import tree


class TreeRouterTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_folder_dict_includes_ordered_cells_and_unprojected_analyses(self):
        folder = Folder(id=1, name="Root", parent_id=None)
        child = Folder(id=2, name="Child", parent_id=1)
        cells = [
            Cell(id=10, name="Cell B", description=None, archived=False),
            Cell(id=11, name="Cell A", description="desc", archived=False),
        ]
        links = [
            FolderCell(folder_id=1, cell_id=10, position=2),
            FolderCell(folder_id=1, cell_id=11, position=1),
        ]
        analyses = [
            Analysis(id=20, title="Folder analysis", folder_id=1, project_id=None, spec={}),
            Analysis(id=21, title="Project analysis", folder_id=1, project_id=5, spec={}),
        ]

        result = tree.folder_dict(
            folder,
            folders=[folder, child],
            folder_cells=links,
            folder_groups=[],
            cells=cells,
            replicate_groups=[],
            analyses=analyses,
            projects=[],
        )

        self.assertEqual([c["id"] for c in result["cells"]], [11, 10])
        self.assertEqual(result["cells"][0]["name"], "Cell A")
        self.assertEqual(
            result["analyses"], [{"id": 20, "title": "Folder analysis", "plot_count": 0}]
        )
        self.assertEqual(result["children"][0]["id"], 2)

    def test_move_folder_cells_moves_refs_without_duplication(self):
        db = self.make_session()
        source = Folder(name="Source")
        target = Folder(name="Target")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        db.add_all([source, target, cell_a, cell_b])
        db.flush()
        db.add_all(
            [
                FolderCell(folder_id=source.id, cell_id=cell_a.id, position=0),
                FolderCell(folder_id=source.id, cell_id=cell_b.id, position=1),
                FolderCell(folder_id=target.id, cell_id=cell_a.id, position=0),
            ]
        )
        db.flush()

        tree.move_folder_cells(db, source.id, target.id, [cell_a.id, cell_b.id])
        db.flush()

        source_ids = [row.cell_id for row in db.query(FolderCell).filter(FolderCell.folder_id == source.id).all()]
        target_ids = [row.cell_id for row in db.query(FolderCell).filter(FolderCell.folder_id == target.id).all()]
        self.assertEqual(source_ids, [])
        self.assertEqual(sorted(target_ids), sorted([cell_a.id, cell_b.id]))
        self.assertEqual(len(target_ids), 2)

    def test_move_folder_replicate_groups_moves_refs_without_duplication(self):
        db = self.make_session()
        source = Folder(name="Source")
        target = Folder(name="Target")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        group_a = ReplicateGroup(name="Group A")
        group_b = ReplicateGroup(name="Group B")
        db.add_all([source, target, cell_a, cell_b, group_a, group_b])
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group_a.id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group_a.id, cell_id=cell_b.id, position=1),
                ReplicateGroupCell(group_id=group_b.id, cell_id=cell_a.id, position=0),
                FolderReplicateGroup(folder_id=source.id, group_id=group_a.id, position=0),
                FolderReplicateGroup(folder_id=source.id, group_id=group_b.id, position=1),
                FolderReplicateGroup(folder_id=target.id, group_id=group_a.id, position=0),
            ]
        )
        db.flush()

        tree.move_folder_groups(db, source.id, target.id, [group_a.id, group_b.id])
        db.flush()

        source_ids = [
            row.group_id
            for row in db.query(FolderReplicateGroup)
            .filter(FolderReplicateGroup.folder_id == source.id)
            .all()
        ]
        target_ids = [
            row.group_id
            for row in db.query(FolderReplicateGroup)
            .filter(FolderReplicateGroup.folder_id == target.id)
            .all()
        ]
        self.assertEqual(source_ids, [])
        self.assertEqual(sorted(target_ids), sorted([group_a.id, group_b.id]))
        self.assertEqual(len(target_ids), 2)

    def test_move_folder_cells_into_the_same_folder_keeps_the_membership(self):
        """Spec 024: a same-folder move used to delete the cell.

        `add_cell_refs` skips ids already present, so the add was a no-op and the
        delete that follows stripped the only FolderCell row — dropping a cell back
        onto its own folder made it disappear.
        """
        db = self.make_session()
        folder = Folder(name="Folder")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        db.add_all([folder, cell_a, cell_b])
        db.flush()
        db.add_all(
            [
                FolderCell(folder_id=folder.id, cell_id=cell_a.id, position=7),
                FolderCell(folder_id=folder.id, cell_id=cell_b.id, position=8),
            ]
        )
        db.flush()

        tree.move_folder_cells(db, folder.id, folder.id, [cell_a.id, cell_b.id])
        db.flush()

        rows = (
            db.query(FolderCell)
            .filter(FolderCell.folder_id == folder.id)
            .order_by(FolderCell.position)
            .all()
        )
        self.assertEqual([row.cell_id for row in rows], [cell_a.id, cell_b.id])
        # Ordering must survive too: an early return preserves `position`, whereas
        # a delete-then-add "fix" would renumber both rows to the end of the folder.
        self.assertEqual([row.position for row in rows], [7, 8])

    def test_move_folder_groups_into_the_same_folder_keeps_the_membership(self):
        db = self.make_session()
        folder = Folder(name="Folder")
        group = ReplicateGroup(name="Group A")
        db.add_all([folder, group])
        db.flush()
        db.add(FolderReplicateGroup(folder_id=folder.id, group_id=group.id, position=3))
        db.flush()

        tree.move_folder_groups(db, folder.id, folder.id, [group.id])
        db.flush()

        rows = (
            db.query(FolderReplicateGroup)
            .filter(FolderReplicateGroup.folder_id == folder.id)
            .all()
        )
        self.assertEqual([row.group_id for row in rows], [group.id])
        self.assertEqual(rows[0].position, 3)

    def test_move_folder_cells_still_validates_folders_when_source_equals_target(self):
        db = self.make_session()
        cell = Cell(name="A")
        db.add(cell)
        db.flush()

        with self.assertRaises(HTTPException) as caught:
            tree.move_folder_cells(db, 4242, 4242, [cell.id])
        self.assertEqual(caught.exception.status_code, 404)

    def make_summarised_cell(self, db, name, files):
        """files: list of (cycle_count, max_discharge_mah, capacity_summary_status)."""
        cell = Cell(name=name)
        db.add(cell)
        db.flush()
        test = Test(cell_id=cell.id, name=f"{name} test")
        db.add(test)
        db.flush()
        for index, (cycles, max_mah, status) in enumerate(files):
            source = SourceFile(
                hash=f"{name}-{index}",
                path=f"C:/data/{name}-{index}.ndax",
                filename=f"{name}-{index}.ndax",
                size=1,
                ext="ndax",
                cycle_count=cycles,
                max_discharge_capacity_mah=max_mah,
                capacity_summary_status=status,
            )
            db.add(source)
            db.flush()
            db.add(TestFile(test_id=test.id, file_id=source.id, position=index))
        db.flush()
        return cell

    def test_cell_metrics_sum_cycles_and_take_the_peak_capacity(self):
        db = self.make_session()
        cell = self.make_summarised_cell(db, "A", [(100, 2.5, "ready"), (150, 3.25, "ready")])

        metrics = tree.cell_metrics(db, [cell.id])[cell.id]

        self.assertEqual(metrics["cycle_count"], 250)
        self.assertEqual(metrics["max_discharge_capacity_mah"], 3.25)
        self.assertFalse(metrics["summary_pending"])

    def test_a_cell_still_being_summarised_reports_nothing_rather_than_a_partial(self):
        db = self.make_session()
        # A half-counted total, or a 0 during import, reads to the user as data loss.
        cell = self.make_summarised_cell(db, "B", [(100, 2.5, "ready"), (None, None, "pending")])

        metrics = tree.cell_metrics(db, [cell.id])[cell.id]

        self.assertIsNone(metrics["cycle_count"])
        self.assertIsNone(metrics["max_discharge_capacity_mah"])
        self.assertTrue(metrics["summary_pending"])

    def test_a_replicate_group_averages_its_members(self):
        entries = [
            {"cycle_count": 100, "max_discharge_capacity_mah": 2.0, "summary_pending": False},
            {"cycle_count": 102, "max_discharge_capacity_mah": 3.0, "summary_pending": False},
        ]
        result = tree.aggregate_metrics(entries, average=True)
        self.assertEqual(result["max_discharge_capacity_mah"], 2.5)
        # Cycles are averaged too, then rounded — a group row showing "101.5 cycles"
        # would be nonsense.
        self.assertEqual(result["cycle_count"], 101)

    def test_a_folder_totals_cycles_and_takes_the_peak_capacity(self):
        entries = [
            {"cycle_count": 100, "max_discharge_capacity_mah": 2.0, "summary_pending": False},
            {"cycle_count": 150, "max_discharge_capacity_mah": 3.0, "summary_pending": False},
        ]
        result = tree.aggregate_metrics(entries, average=False)
        self.assertEqual(result["cycle_count"], 250)
        self.assertEqual(result["max_discharge_capacity_mah"], 3.0)

    def test_metrics_with_no_usable_members_are_absent_not_zero(self):
        entries = [{"cycle_count": None, "max_discharge_capacity_mah": None, "summary_pending": True}]
        for average in (True, False):
            with self.subTest(average=average):
                result = tree.aggregate_metrics(entries, average=average)
                self.assertIsNone(result["cycle_count"])
                self.assertIsNone(result["max_discharge_capacity_mah"])
                self.assertTrue(result["summary_pending"])

    def test_a_folder_rollup_counts_a_cell_filed_twice_only_once(self):
        db = self.make_session()
        cell = self.make_summarised_cell(db, "Shared", [(100, 2.0, "ready")])
        parent = Folder(name="Parent")
        child = Folder(name="Child")
        db.add_all([parent, child])
        db.flush()
        child.parent_id = parent.id
        links = [
            FolderCell(folder_id=parent.id, cell_id=cell.id, position=0),
            FolderCell(folder_id=child.id, cell_id=cell.id, position=0),
        ]
        db.add_all(links)
        db.flush()

        metrics = tree.cell_metrics(db, [cell.id])
        result = tree.folder_dict(
            parent,
            folders=[parent, child],
            folder_cells=links,
            folder_groups=[],
            cells=[cell],
            replicate_groups=[],
            analyses=[],
            projects=[],
            metrics=metrics,
        )

        self.assertEqual(result["metrics_cell_ids"], [cell.id])
        self.assertEqual(result["metrics"]["cycle_count"], 100)

    def test_copy_folder_tree_duplicates_structure_references_and_analyses(self):
        db = self.make_session()
        root = Folder(name="Root")
        target = Folder(name="Target")
        child = Folder(name="Child")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        db.add_all([root, target, child, cell_a, cell_b])
        db.flush()
        child.parent_id = root.id
        db.add_all(
            [
                FolderCell(folder_id=root.id, cell_id=cell_a.id, position=0),
                FolderCell(folder_id=child.id, cell_id=cell_b.id, position=0),
                Analysis(title="Analysis", folder_id=root.id, project_id=None, spec={"selection": []}),
            ]
        )
        db.flush()

        copied = tree.copy_folder_tree(db, root.id, target.id)
        db.flush()

        self.assertEqual(copied.parent_id, target.id)
        self.assertEqual(copied.name, "Root copy")
        copied_child = db.query(Folder).filter(Folder.parent_id == copied.id).one()
        self.assertEqual(copied_child.name, "Child")
        copied_root_cells = db.query(FolderCell).filter(FolderCell.folder_id == copied.id).all()
        copied_child_cells = db.query(FolderCell).filter(FolderCell.folder_id == copied_child.id).all()
        copied_analysis = db.query(Analysis).filter(Analysis.folder_id == copied.id).one()
        self.assertEqual([link.cell_id for link in copied_root_cells], [cell_a.id])
        self.assertEqual([link.cell_id for link in copied_child_cells], [cell_b.id])
        self.assertEqual(copied_analysis.title, "Analysis copy")


if __name__ == "__main__":
    unittest.main()
