import os
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import ActivityEvent, Cell, Folder, FolderCell, FolderReplicateGroup, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
from app.services import background_jobs, cache, parsing, scanner
from app.routers import files, library, replicates


class SourceAndReplicateTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_update_source_file_from_path_replaces_hash_metadata_and_cache_counts(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cell.ndax"
            path.write_bytes(b"new content")
            sf = SourceFile(
                hash="oldhash",
                path=str(path),
                filename="cell.ndax",
                size=3,
                ext="ndax",
                location_status="changed",
                parse_status="parsed",
            )
            db.add(sf)
            db.commit()

            original_hash = parsing.compute_hash
            original_meta = parsing.read_header_metadata
            original_build = cache.build
            parsing.compute_hash = lambda _: "newhash"
            parsing.read_header_metadata = lambda _: {
                "nda_version": "17",
                "device_info": "24 #62",
                "channel": "2-1",
                "barcode": "B-1",
                "remarks": "updated",
                "start_time": "2026-01-01 10:00:00",
                "active_mass_mg": 4.2,
                "raw": {"hello": "world"},
            }
            cache.build = lambda file_hash, file_path: {
                "parser_version": "parser-x",
                "rows": 123,
                "cycles": 45,
            }
            try:
                updated = scanner.update_source_from_path(db, sf)
            finally:
                parsing.compute_hash = original_hash
                parsing.read_header_metadata = original_meta
                cache.build = original_build

            self.assertEqual(updated.hash, "newhash")
            self.assertEqual(updated.location_status, "online")
            self.assertEqual(updated.parse_status, "parsed")
            self.assertEqual(updated.parser_version, "parser-x")
            self.assertEqual(updated.row_count, 123)
            self.assertEqual(updated.cycle_count, 45)
            self.assertEqual(updated.remarks, "updated")

    def test_replicate_preview_aggregates_aligned_cycle_values_and_stats(self):
        frames = [
            {
                "cell_id": 1,
                "cell_name": "A",
                "rows": pd.DataFrame(
                    {"cycle": [1, 2, 3], "discharge_capacity_mah": [10.0, 9.0, 8.0]}
                ),
            },
            {
                "cell_id": 2,
                "cell_name": "B",
                "rows": pd.DataFrame(
                    {"cycle": [1, 2], "discharge_capacity_mah": [12.0, 10.0]}
                ),
            },
        ]

        preview = replicates.preview_from_cycle_frames(frames, "discharge_capacity_mah")

        self.assertEqual(preview["stats"]["n_cells"], 2)
        self.assertEqual(preview["stats"]["average_cycle_count"], 2.5)
        self.assertEqual(preview["aggregate"]["cycle"], [1, 2, 3])
        self.assertEqual(preview["aggregate"]["mean"], [11.0, 9.5, 8.0])
        self.assertEqual(preview["aggregate"]["median"], [11.0, 9.5, 8.0])
        self.assertEqual(preview["aggregate"]["q1"], [10.5, 9.25, 8.0])
        self.assertEqual(preview["aggregate"]["q3"], [11.5, 9.75, 8.0])
        self.assertEqual(preview["aggregate"]["count"], [2, 2, 1])
        self.assertEqual(preview["aggregate"]["min"], [10.0, 9.0, 8.0])
        self.assertEqual(preview["aggregate"]["max"], [12.0, 10.0, 8.0])
        self.assertEqual(preview["series"][0]["cell_name"], "A")

    def test_replicate_search_matches_description_and_member_cell_names(self):
        db = self.make_session()
        cell_a = Cell(name="NMC pouch A")
        cell_b = Cell(name="NMC pouch B")
        group = ReplicateGroup(name="Formulation Alpha", description="High salt control")
        db.add_all([cell_a, cell_b, group])
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=cell_b.id, position=1),
            ]
        )
        db.flush()

        by_description = replicates.list_replicate_groups(search="salt", db=db)
        by_member = replicates.list_replicate_groups(search="pouch b", db=db)

        self.assertEqual([row["id"] for row in by_description], [group.id])
        self.assertEqual([row["id"] for row in by_member], [group.id])

    def test_delete_cell_removes_folder_refs_but_keeps_nonempty_replicates(self):
        db = self.make_session()
        folder = Folder(name="Batch A")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        cell_c = Cell(name="C")
        group_two = ReplicateGroup(name="Two-cell replicate")
        group_three = ReplicateGroup(name="Three-cell replicate")
        db.add_all([folder, cell_a, cell_b, cell_c, group_two, group_three])
        db.flush()
        db.add_all(
            [
                FolderCell(folder_id=folder.id, cell_id=cell_a.id, position=0),
                FolderReplicateGroup(folder_id=folder.id, group_id=group_two.id, position=0),
                FolderReplicateGroup(folder_id=folder.id, group_id=group_three.id, position=1),
                ReplicateGroupCell(group_id=group_two.id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group_two.id, cell_id=cell_b.id, position=1),
                ReplicateGroupCell(group_id=group_three.id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group_three.id, cell_id=cell_b.id, position=1),
                ReplicateGroupCell(group_id=group_three.id, cell_id=cell_c.id, position=2),
            ]
        )
        db.flush()

        result = library.delete_cell_from_library(db, cell_a)
        db.flush()

        self.assertIsNone(db.get(Cell, cell_a.id))
        self.assertEqual(db.query(FolderCell).filter(FolderCell.cell_id == cell_a.id).count(), 0)
        single_remaining_group = db.get(ReplicateGroup, group_two.id)
        self.assertIsNotNone(single_remaining_group)
        self.assertEqual(result["deleted_replicate_group_ids"], [])
        self.assertEqual([link.cell_id for link in single_remaining_group.cell_links], [cell_b.id])
        remaining_group = db.get(ReplicateGroup, group_three.id)
        self.assertIsNotNone(remaining_group)
        self.assertEqual(
            [link.cell_id for link in remaining_group.cell_links],
            [cell_b.id, cell_c.id],
        )

    def test_delete_cell_removes_empty_replicate_group(self):
        db = self.make_session()
        cell = Cell(name="A")
        group = ReplicateGroup(name="Empty after delete")
        db.add_all([cell, group])
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell.id, position=0))
        db.flush()

        result = library.delete_cell_from_library(db, cell)
        db.flush()

        self.assertIsNone(db.get(ReplicateGroup, group.id))
        self.assertEqual(result["deleted_replicate_group_ids"], [group.id])

    def test_delete_cell_unregisters_source_file_for_reimport(self):
        db = self.make_session()
        cell = Cell(name="A")
        sf = SourceFile(
            hash="hash-a",
            path="C:/data/a.ndax",
            filename="a.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
        )
        db.add_all([cell, sf])
        db.flush()
        test = Test(cell_id=cell.id, name="Imported file")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=sf.id, position=0))
        db.flush()

        library.delete_cell_from_library(db, cell)
        db.flush()
        db.expire(sf, ["test_link"])

        self.assertIsNone(sf.test_link)
        self.assertIsNotNone(db.get(SourceFile, sf.id))

    def test_delete_cells_from_library_removes_many_and_empty_groups(self):
        db = self.make_session()
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        cell_c = Cell(name="C")
        group = ReplicateGroup(name="Rep")
        folder = Folder(name="Folder")
        db.add_all([cell_a, cell_b, cell_c, group, folder])
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=cell_b.id, position=1),
                FolderCell(folder_id=folder.id, cell_id=cell_a.id, position=0),
                FolderCell(folder_id=folder.id, cell_id=cell_b.id, position=1),
            ]
        )
        db.flush()

        result = library.delete_cells_from_library(db, [cell_a.id, cell_b.id])
        db.flush()

        self.assertEqual(result["deleted_cell_ids"], [cell_a.id, cell_b.id])
        self.assertEqual(result["deleted_replicate_group_ids"], [group.id])
        self.assertIsNone(db.get(Cell, cell_a.id))
        self.assertIsNone(db.get(Cell, cell_b.id))
        self.assertIsNotNone(db.get(Cell, cell_c.id))
        self.assertEqual(db.query(FolderCell).count(), 0)

    def test_import_cleanup_removes_archived_cell_blocking_existing_source(self):
        db = self.make_session()
        cell = Cell(name="Archived A", archived=True)
        sf = SourceFile(
            hash="hash-a",
            path="C:/data/a.ndax",
            filename="a.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
        )
        db.add_all([cell, sf])
        db.flush()
        test = Test(cell_id=cell.id, name="Imported file")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=sf.id, position=0))
        db.flush()

        self.assertIsNone(files.import_match_info(db, "hash-a", "a.ndax", {}))
        files.remove_archived_cell_blocking_source(db, sf)
        db.flush()
        db.expire(sf, ["test_link"])

        self.assertIsNone(db.get(Cell, cell.id))
        self.assertIsNone(sf.test_link)

    def test_replicate_group_dict_averages_cell_capacity_totals(self):
        cell_a = Cell(id=1, name="A")
        cell_b = Cell(id=2, name="B")
        cell_a.total_charge_capacity_mah = 10.0
        cell_a.total_discharge_capacity_mah = 8.0
        cell_b.total_charge_capacity_mah = 14.0
        cell_b.total_discharge_capacity_mah = 10.0
        group = ReplicateGroup(id=3, name="Rep")
        group.cell_links = [
            ReplicateGroupCell(group=group, cell=cell_a, position=0),
            ReplicateGroupCell(group=group, cell=cell_b, position=1),
        ]

        payload = replicates.group_dict(group)

        self.assertEqual(payload["average_total_charge_capacity_mah"], 12.0)
        self.assertEqual(payload["average_total_discharge_capacity_mah"], 9.0)

    def test_add_cells_to_existing_replicate_skips_existing_members(self):
        db = self.make_session()
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        cell_c = Cell(name="C")
        group = ReplicateGroup(name="Rep")
        db.add_all([cell_a, cell_b, cell_c, group])
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell_a.id, position=0))
        db.flush()

        result = replicates.add_cells_to_replicate_group(
            group.id,
            replicates.ReplicateGroupCellsAdd(cell_ids=[cell_a.id, cell_b.id, cell_c.id]),
            db=db,
        )

        self.assertEqual(result["added_cell_ids"], [cell_b.id, cell_c.id])
        self.assertEqual(result["skipped_cell_ids"], [cell_a.id])
        self.assertEqual(result["cell_ids"], [cell_a.id, cell_b.id, cell_c.id])

    def test_cell_capacity_totals_use_persisted_source_summaries(self):
        cell = Cell(name="A")
        sf = SourceFile(
            hash="hash-a",
            path="C:/data/a.ndax",
            filename="a.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            total_charge_capacity_mah=7.0,
            total_discharge_capacity_mah=6.0,
            capacity_summary_status="ready",
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=sf, position=0)]
        original = library.cache.load_cycles
        library.cache.load_cycles = lambda *_: self.fail("library totals read the cycle cache")
        try:
            totals = library.cell_capacity_totals(cell)
        finally:
            library.cache.load_cycles = original

        self.assertEqual(totals["total_charge_capacity_mah"], 7.0)
        self.assertEqual(totals["total_discharge_capacity_mah"], 6.0)

    def test_listing_cells_does_not_touch_sources_or_cycle_caches(self):
        db = self.make_session()
        cell = Cell(name="Fast library row", cycling_status="active")
        source = SourceFile(
            hash="hash-fast-row",
            path="C:/data/large.ndax",
            filename="large.ndax",
            size=10_000_000,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            row_count=100_000,
            cycle_count=250,
            total_charge_capacity_mah=25.0,
            total_discharge_capacity_mah=24.0,
            capacity_summary_status="ready",
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.commit()

        originals = (
            library.cache.load_cycles,
            library.scanner.check_location,
            library.scanner.parse_file,
        )
        library.cache.load_cycles = lambda *_: self.fail("cycle cache was read")
        library.scanner.check_location = lambda *_: self.fail("source file was checked")
        library.scanner.parse_file = lambda *_: self.fail("source file was parsed")
        try:
            payload = library.list_cells(db=db)
        finally:
            (
                library.cache.load_cycles,
                library.scanner.check_location,
                library.scanner.parse_file,
            ) = originals

        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["total_cycles"], 250)
        self.assertEqual(payload[0]["total_charge_capacity_mah"], 25.0)

    def test_cell_source_check_skips_completed_cells_and_marks_changed_active_sources(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            active_path = Path(tmp) / "active.ndax"
            complete_path = Path(tmp) / "complete.ndax"
            active_path.write_bytes(b"active updated")
            complete_path.write_bytes(b"complete updated")
            active_cell = Cell(name="Active", cycling_status="active")
            complete_cell = Cell(name="Complete", cycling_status="complete")
            active_file = SourceFile(
                hash="old-active",
                path=str(active_path),
                filename="active.ndax",
                size=10,
                ext="ndax",
                location_status="online",
                parse_status="parsed",
            )
            complete_file = SourceFile(
                hash="old-complete",
                path=str(complete_path),
                filename="complete.ndax",
                size=10,
                ext="ndax",
                location_status="online",
                parse_status="parsed",
            )
            db.add_all([active_cell, complete_cell, active_file, complete_file])
            db.flush()
            active_test = Test(cell_id=active_cell.id, name="Imported file")
            complete_test = Test(cell_id=complete_cell.id, name="Imported file")
            db.add_all([active_test, complete_test])
            db.flush()
            db.add_all(
                [
                    TestFile(test_id=active_test.id, file_id=active_file.id, position=0),
                    TestFile(test_id=complete_test.id, file_id=complete_file.id, position=0),
                ]
            )
            db.flush()

            original_hash = library.parsing.compute_hash
            library.parsing.compute_hash = lambda path: f"new-{Path(path).stem}"
            try:
                result = library.check_cell_sources(
                    db,
                    cell_ids=[active_cell.id, complete_cell.id],
                    max_workers=1,
                )
            finally:
                library.parsing.compute_hash = original_hash

            self.assertEqual(result["checked"], 1)
            self.assertEqual(result["skipped_complete"], 1)
            self.assertEqual(result["changed"], 1)
            self.assertEqual(active_file.location_status, "changed")
            self.assertEqual(complete_file.location_status, "online")
            event = db.query(ActivityEvent).filter(ActivityEvent.action == "check_sources").one()
            self.assertEqual(event.category, "source")
            self.assertEqual(event.severity, "warning")
            self.assertEqual(event.details["changed"], 1)
            self.assertEqual(event.details["skipped_complete"], 1)

    def test_source_check_job_exposes_files_and_parallel_worker_count_immediately(self):
        db = self.make_session()
        cell = Cell(name="Active", cycling_status="active")
        source = SourceFile(
            hash="old-hash",
            path="C:/data/active.ndax",
            filename="active.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
        )
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Imported file")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.flush()

        class DeferredThread:
            def __init__(self, *args, **kwargs):
                pass

            def start(self):
                pass

        original_thread = library.threading.Thread
        live_jobs = []
        try:
            background_jobs.clear_jobs()
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
                library._next_source_check_job_id = 1
            library.threading.Thread = DeferredThread
            job = library.start_source_check_job(db, cell_ids=[cell.id])
            live_jobs = background_jobs.list_jobs()
        finally:
            library.threading.Thread = original_thread
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
            background_jobs.clear_jobs()

        self.assertEqual(job["status"], "running")
        self.assertEqual(job["total"], 1)
        self.assertEqual(job["workers"], 1)
        self.assertEqual(job["requested_cell_ids"], [cell.id])
        self.assertEqual(job["files"][0]["filename"], "active.ndax")
        self.assertEqual(job["files"][0]["status"], "queued")
        self.assertEqual(live_jobs[0]["kind"], "source_check")
        self.assertEqual(live_jobs[0]["items"][0]["label"], "active.ndax")

    def test_update_changed_sources_returns_cells_that_are_ready(self):
        db = self.make_session()
        cell = Cell(name="Active", cycling_status="active")
        source = SourceFile(
            hash="old-hash",
            path="C:/data/active.ndax",
            filename="active.ndax",
            size=10,
            ext="ndax",
            location_status="changed",
            parse_status="parsed",
        )
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Imported file")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        db.flush()

        original_update = scanner.update_source_from_path
        scanner.update_source_from_path = lambda session, sf: (
            setattr(sf, "location_status", "online") or sf
        )
        try:
            result = library.update_changed_cell_sources(
                library.CellSourceUpdateRequest(cell_ids=[cell.id]),
                db=db,
            )
        finally:
            scanner.update_source_from_path = original_update

        self.assertEqual(result["updated_file_ids"], [source.id])
        self.assertEqual(result["ready_cell_ids"], [cell.id])
        self.assertEqual(source.location_status, "online")

    def test_set_cells_status_marks_selected_cells(self):
        db = self.make_session()
        cell_a = Cell(name="A", cycling_status="active")
        cell_b = Cell(name="B", cycling_status="active")
        db.add_all([cell_a, cell_b])
        db.flush()

        result = library.set_cells_status(
            library.CellStatusRequest(cell_ids=[cell_a.id, cell_b.id], cycling_status="complete"),
            db=db,
        )

        self.assertEqual(result["updated"], 2)
        self.assertEqual(cell_a.cycling_status, "complete")
        self.assertEqual(cell_b.cycling_status, "complete")
        event = db.query(ActivityEvent).filter(ActivityEvent.action == "set_status").one()
        self.assertEqual(event.message, "Marked 2 cells as complete")


if __name__ == "__main__":
    unittest.main()
