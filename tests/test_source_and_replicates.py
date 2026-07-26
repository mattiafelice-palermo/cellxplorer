import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import ActivityEvent, Cell, CellMetadata, Folder, FolderCell, FolderReplicateGroup, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
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
                with patch.object(cache, "remove_hash_cache") as remove_old:
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
            remove_old.assert_called_once_with("oldhash")

    def test_failed_source_update_preserves_previous_cache(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cell.ndax"
            path.write_bytes(b"new content")
            source = SourceFile(
                hash="a" * 64,
                path=str(path),
                filename=path.name,
                size=3,
                ext="ndax",
                location_status="changed",
                parse_status="parsed",
            )
            db.add(source)
            db.commit()

            with (
                patch.object(parsing, "compute_hash", return_value="b" * 64),
                patch.object(parsing, "read_header_metadata", return_value={}),
                patch.object(cache, "build", side_effect=ValueError("parse failed")),
                patch.object(cache, "remove_hash_cache") as remove_old,
            ):
                scanner.update_source_from_path(db, source)

            self.assertEqual(source.parse_status, "error")
            remove_old.assert_not_called()

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

    def test_replicate_edit_allows_one_cell_but_rejects_empty_group(self):
        db = self.make_session()
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        group = ReplicateGroup(name="Replicate")
        db.add_all([cell_a, cell_b, group])
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=cell_b.id, position=1),
            ]
        )
        db.commit()

        updated = replicates.update_replicate_group(
            group.id,
            replicates.ReplicateGroupUpdate(
                name="Edited replicate",
                description="One member remains",
                cell_ids=[cell_b.id],
            ),
            db=db,
        )

        self.assertEqual(updated["name"], "Edited replicate")
        self.assertEqual(updated["cell_ids"], [cell_b.id])
        with self.assertRaises(HTTPException) as empty:
            replicates.update_replicate_group(
                group.id,
                replicates.ReplicateGroupUpdate(cell_ids=[]),
                db=db,
            )
        self.assertEqual(empty.exception.status_code, 400)

    def test_create_replicate_group_files_group_and_removes_cell_refs_atomically(self):
        db = self.make_session()
        folder = Folder(name="Batch A")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        db.add_all([folder, cell_a, cell_b])
        db.flush()
        db.add_all(
            [
                FolderCell(folder_id=folder.id, cell_id=cell_a.id, position=0),
                FolderCell(folder_id=folder.id, cell_id=cell_b.id, position=1),
            ]
        )
        db.commit()

        result = replicates.create_replicate_group(
            replicates.ReplicateGroupCreate(
                name="A replicates",
                cell_ids=[cell_a.id, cell_b.id],
                folder_ids=[folder.id],
                remove_folder_cells=[
                    replicates.FolderCellRef(folder_id=folder.id, cell_id=cell_a.id),
                    replicates.FolderCellRef(folder_id=folder.id, cell_id=cell_b.id),
                ],
            ),
            db=db,
        )

        self.assertEqual(result["cell_ids"], [cell_a.id, cell_b.id])
        self.assertEqual(result["folder_ids"], [folder.id])
        self.assertEqual(db.query(FolderCell).count(), 0)
        self.assertEqual(
            db.query(FolderReplicateGroup)
            .filter(
                FolderReplicateGroup.folder_id == folder.id,
                FolderReplicateGroup.group_id == result["id"],
            )
            .count(),
            1,
        )

    def test_create_replicate_group_validation_leaves_no_partial_group(self):
        db = self.make_session()
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        db.add_all([cell_a, cell_b])
        db.commit()

        with self.assertRaises(HTTPException) as missing_folder:
            replicates.create_replicate_group(
                replicates.ReplicateGroupCreate(
                    name="Should not exist",
                    cell_ids=[cell_a.id, cell_b.id],
                    folder_ids=[999],
                ),
                db=db,
            )

        self.assertEqual(missing_folder.exception.status_code, 404)
        self.assertEqual(db.query(ReplicateGroup).count(), 0)
        self.assertEqual(db.query(ReplicateGroupCell).count(), 0)

    def test_explode_replicate_refiles_cells_and_deletes_group_atomically(self):
        db = self.make_session()
        folder = Folder(name="Batch A")
        other_folder = Folder(name="Batch B")
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        group = ReplicateGroup(name="A replicates")
        db.add_all([folder, other_folder, cell_a, cell_b, group])
        db.flush()
        group_id = group.id
        db.add_all(
            [
                ReplicateGroupCell(group_id=group_id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group_id, cell_id=cell_b.id, position=1),
                FolderReplicateGroup(folder_id=folder.id, group_id=group_id, position=0),
                FolderReplicateGroup(folder_id=other_folder.id, group_id=group_id, position=0),
            ]
        )
        db.commit()

        result = replicates.explode_replicate_groups(
            replicates.ReplicateExplodeRequest(
                groups=[
                    replicates.ReplicateExplodeTarget(
                        group_id=group_id,
                        folder_ids=[folder.id],
                    )
                ]
            ),
            db=db,
        )

        self.assertEqual(result["deleted_empty_groups"], [group_id])
        self.assertIsNone(db.get(ReplicateGroup, group_id))
        self.assertEqual(
            [
                row.cell_id
                for row in db.query(FolderCell)
                .filter(FolderCell.folder_id == folder.id)
                .order_by(FolderCell.position)
                .all()
            ],
            [cell_a.id, cell_b.id],
        )
        self.assertEqual(
            {
                row.cell_id
                for row in db.query(FolderCell)
                .filter(FolderCell.folder_id == other_folder.id)
                .all()
            },
            {cell_a.id, cell_b.id},
        )

    def test_explode_validation_leaves_group_untouched(self):
        db = self.make_session()
        cell_a = Cell(name="A")
        cell_b = Cell(name="B")
        group = ReplicateGroup(name="A replicates")
        db.add_all([cell_a, cell_b, group])
        db.flush()
        group_id = group.id
        db.add_all(
            [
                ReplicateGroupCell(group_id=group_id, cell_id=cell_a.id, position=0),
                ReplicateGroupCell(group_id=group_id, cell_id=cell_b.id, position=1),
            ]
        )
        db.commit()

        with self.assertRaises(HTTPException) as missing_folder:
            replicates.explode_replicate_groups(
                replicates.ReplicateExplodeRequest(
                    groups=[
                        replicates.ReplicateExplodeTarget(
                            group_id=group_id,
                            folder_ids=[999],
                        )
                    ]
                ),
                db=db,
            )

        self.assertEqual(missing_folder.exception.status_code, 404)
        self.assertIsNotNone(db.get(ReplicateGroup, group_id))
        self.assertEqual(
            db.query(ReplicateGroupCell)
            .filter(ReplicateGroupCell.group_id == group_id)
            .count(),
            2,
        )
        self.assertEqual(db.query(FolderCell).count(), 0)

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
            max_discharge_capacity_mah=6.0,
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
        self.assertEqual(totals["max_discharge_capacity_mah"], 6.0)

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
        cell.metadata_entries = [
            CellMetadata(key="raw.large.header", value="x" * 20_000),
            CellMetadata(key="active_material_mg", value="12.5"),
        ]
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
        self.assertNotIn("metadata", payload[0])
        detail = library.get_cell(cell.id, db=db)
        self.assertEqual(detail["metadata"]["raw.large.header"], "x" * 20_000)

    def test_optimized_cell_listing_matches_detail_summary_semantics(self):
        db = self.make_session()
        ready = Cell(name="Ready summary", cycling_status="active")
        ready.metadata_entries = [
            CellMetadata(key="override.active_mass_mg", value="9.5"),
            CellMetadata(key="override.electrode_area_cm2", value="1.54"),
        ]
        ready_test = Test(cell=ready, name="Ready files")
        ready_test.file_links = [
            TestFile(
                position=0,
                file=SourceFile(
                    hash="summary-ready-1",
                    path="C:/data/ready-1.ndax",
                    filename="ready-1.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                    cycle_count=10,
                    active_mass_mg=8.0,
                    nominal_capacity_mah=2.0,
                    total_charge_capacity_mah=3.25,
                    total_discharge_capacity_mah=3.0,
                    max_discharge_capacity_mah=3.0,
                    capacity_summary_status="ready",
                ),
            ),
            TestFile(
                position=1,
                file=SourceFile(
                    hash="summary-ready-2",
                    path="C:/data/ready-2.ndax",
                    filename="ready-2.ndax",
                    size=100,
                    ext="ndax",
                    location_status="changed",
                    parse_status="parsed",
                    cycle_count=12,
                    active_mass_mg=8.5,
                    nominal_capacity_mah=2.1,
                    total_charge_capacity_mah=4.5,
                    total_discharge_capacity_mah=4.25,
                    max_discharge_capacity_mah=4.25,
                    capacity_summary_status="ready",
                ),
            ),
        ]
        pending = Cell(name="Pending summary", cycling_status="complete")
        pending_test = Test(cell=pending, name="Pending file")
        pending_test.file_links = [
            TestFile(
                position=0,
                file=SourceFile(
                    hash="summary-pending",
                    path="C:/data/pending.ndax",
                    filename="pending.ndax",
                    size=100,
                    ext="ndax",
                    location_status="offline",
                    parse_status="parsed",
                    cycle_count=4,
                    total_charge_capacity_mah=1.0,
                    total_discharge_capacity_mah=0.9,
                    capacity_summary_status="pending",
                ),
            )
        ]
        empty = Cell(name="No files", cycling_status="active")
        db.add_all([ready, pending, empty])
        db.commit()

        payload = {row["id"]: row for row in library.list_cells(db=db)}

        self.assertEqual(payload[ready.id]["n_tests"], 1)
        self.assertEqual(payload[ready.id]["n_files"], 2)
        self.assertEqual(payload[ready.id]["total_cycles"], 22)
        self.assertEqual(payload[ready.id]["total_charge_capacity_mah"], 7.75)
        self.assertEqual(payload[ready.id]["total_discharge_capacity_mah"], 7.25)
        self.assertAlmostEqual(
            payload[ready.id]["max_specific_discharge_capacity_mah_g"],
            447.368421,
            places=6,
        )
        self.assertTrue(payload[ready.id]["has_changed"])
        self.assertEqual(
            payload[ready.id]["scientific_metadata"]["active_mass_mg"],
            {
                "source_value": 8.0,
                "override_value": 9.5,
                "legacy_value": None,
                "effective_value": 9.5,
            },
        )
        self.assertIsNone(payload[pending.id]["total_charge_capacity_mah"])
        self.assertIsNone(payload[pending.id]["max_specific_discharge_capacity_mah_g"])
        self.assertTrue(payload[pending.id]["has_offline"])
        self.assertTrue(payload[pending.id]["has_summary_pending"])
        self.assertEqual(payload[empty.id]["n_tests"], 0)
        self.assertEqual(payload[empty.id]["n_files"], 0)
        self.assertIsNone(payload[empty.id]["total_discharge_capacity_mah"])

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

        original_thread = library._JobThread
        live_jobs = []
        try:
            background_jobs.clear_jobs()
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
                library._next_source_check_job_id = 1
            library._JobThread = DeferredThread
            job = library.start_source_check_job(db, cell_ids=[cell.id])
            upgraded = library.start_source_check_job(
                db,
                cell_ids=[cell.id],
                update_after_check=True,
            )
            live_jobs = background_jobs.list_jobs()
        finally:
            library._JobThread = original_thread
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
        self.assertEqual(upgraded["id"], job["id"])
        self.assertTrue(upgraded["update_after_check"])
        self.assertEqual(live_jobs[0]["kind"], "source_check_update")
        self.assertEqual(live_jobs[0]["title"], "Checking and updating sources")
        self.assertEqual(live_jobs[0]["items"][0]["label"], "active.ndax")

    def _start_deferred_source_job(self, db, starter):
        class DeferredThread:
            def __init__(self, *args, **kwargs):
                pass

            def start(self):
                pass

        original_thread = library._JobThread
        try:
            background_jobs.clear_jobs()
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
                library._next_source_check_job_id = 1
            library._JobThread = DeferredThread
            return starter()
        finally:
            library._JobThread = original_thread
            with library._source_check_job_lock:
                library._source_check_jobs.clear()
                library._latest_source_check_job_id = None
            background_jobs.clear_jobs()

    def _add_cell_with_source(self, db, *, name: str, cycling_status: str = "active"):
        cell = Cell(name=name, cycling_status=cycling_status)
        source = SourceFile(
            hash=f"hash-{name}",
            path=f"C:/data/{name}.ndax",
            filename=f"{name}.ndax",
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
        return cell, source

    def test_check_update_job_without_body_targets_all_active_cells(self):
        db = self.make_session()
        self._add_cell_with_source(db, name="active")
        self._add_cell_with_source(db, name="complete", cycling_status="complete")
        db.commit()

        job = self._start_deferred_source_job(
            db,
            lambda: library.create_source_check_update_job(db=db),
        )

        self.assertTrue(job["update_after_check"])
        self.assertEqual(job["total"], 1)
        self.assertEqual(job["requested_cell_ids"], [])

    def test_check_update_job_with_cell_ids_forwards_selected_scope(self):
        db = self.make_session()
        active_cell, _ = self._add_cell_with_source(db, name="active")
        self._add_cell_with_source(db, name="other")
        db.commit()

        job = self._start_deferred_source_job(
            db,
            lambda: library.create_source_check_update_job(
                req=library.CellSourceCheckRequest(cell_ids=[active_cell.id]),
                db=db,
            ),
        )

        self.assertTrue(job["update_after_check"])
        self.assertEqual(job["requested_cell_ids"], [active_cell.id])
        self.assertEqual(job["total"], 1)

    def test_check_update_job_skips_completed_cells_by_default(self):
        db = self.make_session()
        active_cell, _ = self._add_cell_with_source(db, name="active")
        complete_cell, _ = self._add_cell_with_source(db, name="complete", cycling_status="complete")
        db.commit()

        job = self._start_deferred_source_job(
            db,
            lambda: library.create_source_check_update_job(
                req=library.CellSourceCheckRequest(cell_ids=[active_cell.id, complete_cell.id]),
                db=db,
            ),
        )

        self.assertTrue(job["update_after_check"])
        self.assertEqual(job["skipped_complete"], 1)
        self.assertEqual(job["total"], 1)

    def test_check_only_job_endpoint_leaves_update_after_check_false(self):
        db = self.make_session()
        cell, _ = self._add_cell_with_source(db, name="active")
        db.commit()

        job = self._start_deferred_source_job(
            db,
            lambda: library.create_source_check_job(
                req=library.CellSourceCheckRequest(cell_ids=[cell.id]),
                db=db,
            ),
        )

        self.assertFalse(job["update_after_check"])

    def test_combined_source_job_adopts_changed_file_and_marks_it_ready(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "active.ndax"
            path.write_bytes(b"new bytes")
            cell = Cell(name="Active", cycling_status="active")
            source = SourceFile(
                hash="old-hash",
                path=str(path),
                filename=path.name,
                size=3,
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
            db.commit()

            class ImmediateThread:
                def __init__(self, *, target, args=(), kwargs=None, **_):
                    self.target = target
                    self.args = args
                    self.kwargs = kwargs or {}

                def start(self):
                    self.target(*self.args, **self.kwargs)

            factory = sessionmaker(
                bind=db.get_bind(),
                autoflush=False,
                expire_on_commit=False,
            )
            original_thread = library._JobThread
            original_session_local = library.SessionLocal
            original_hash = library.parsing.compute_hash
            original_update = library.scanner.update_source_from_path

            def adopt_source(update_db, update_source):
                update_source.hash = "new-hash"
                update_source.location_status = "online"
                update_source.parse_status = "parsed"
                update_db.commit()
                return update_source

            try:
                background_jobs.clear_jobs()
                with library._source_check_job_lock:
                    library._source_check_jobs.clear()
                    library._latest_source_check_job_id = None
                    library._next_source_check_job_id = 1
                library._JobThread = ImmediateThread
                library.SessionLocal = factory
                library.parsing.compute_hash = lambda _: "new-hash"
                library.scanner.update_source_from_path = adopt_source
                job = library.start_source_check_job(db, update_after_check=True)
            finally:
                library._JobThread = original_thread
                library.SessionLocal = original_session_local
                library.parsing.compute_hash = original_hash
                library.scanner.update_source_from_path = original_update

            try:
                self.assertEqual(job["status"], "completed")
                self.assertEqual(job["phase"], "completed")
                self.assertEqual(job["changed"], 1)
                self.assertEqual(job["updated"], 1)
                self.assertEqual(job["ready_cell_ids"], [cell.id])
                self.assertEqual(job["files"][0]["status"], "ready")
                db.expire_all()
                self.assertEqual(db.get(SourceFile, source.id).location_status, "online")
                event = (
                    db.query(ActivityEvent)
                    .filter(ActivityEvent.action == "check_update_sources")
                    .one()
                )
                self.assertEqual(event.details["updated"], 1)
            finally:
                with library._source_check_job_lock:
                    library._source_check_jobs.clear()
                    library._latest_source_check_job_id = None
                background_jobs.clear_jobs()

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


class MaxSpecificDischargeTests(unittest.TestCase):
    def make_session(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool

        from app.db import Base

        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_helper_rejects_missing_or_invalid_mass(self):
        self.assertIsNone(
            library.max_specific_discharge_capacity(4.0, None)
        )
        self.assertIsNone(
            library.max_specific_discharge_capacity(4.0, 0)
        )
        self.assertIsNone(
            library.max_specific_discharge_capacity(None, 10.0)
        )
        self.assertIsNone(
            library.max_specific_discharge_capacity(4.0, float("inf"))
        )

    def test_finite_max_rejects_infinite_cached_values(self):
        self.assertIsNone(library._finite_max([float("inf"), float("nan")]))
        self.assertEqual(library._finite_max([1.0, float("inf"), 3.0]), 3.0)

    def test_helper_uses_override_mass_precedence_via_list_cells(self):
        db = self.make_session()
        cell = Cell(name="Specific discharge", cycling_status="active")
        cell.metadata_entries = [
            CellMetadata(key="override.active_mass_mg", value="10"),
        ]
        test = Test(cell=cell, name="Imported file")
        test.file_links = [
            TestFile(
                position=0,
                file=SourceFile(
                    hash="specific-discharge",
                    path="C:/data/specific.ndax",
                    filename="specific.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                    active_mass_mg=20.0,
                    total_charge_capacity_mah=5.0,
                    total_discharge_capacity_mah=4.0,
                    max_discharge_capacity_mah=4.0,
                    capacity_summary_status="ready",
                ),
            )
        ]
        db.add(cell)
        db.commit()

        payload = library.list_cells(db=db)[0]
        self.assertEqual(payload["max_specific_discharge_capacity_mah_g"], 400.0)

    def test_multiple_files_use_maximum_not_sum(self):
        db = self.make_session()
        cell = Cell(name="Two files", cycling_status="active")
        cell.metadata_entries = [CellMetadata(key="active_material_mg", value="5")]
        test = Test(cell=cell, name="Imported file")
        test.file_links = [
            TestFile(
                position=0,
                file=SourceFile(
                    hash="file-one",
                    path="C:/data/one.ndax",
                    filename="one.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                    max_discharge_capacity_mah=2.0,
                    total_charge_capacity_mah=2.0,
                    total_discharge_capacity_mah=2.0,
                    capacity_summary_status="ready",
                ),
            ),
            TestFile(
                position=1,
                file=SourceFile(
                    hash="file-two",
                    path="C:/data/two.ndax",
                    filename="two.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                    max_discharge_capacity_mah=3.5,
                    total_charge_capacity_mah=3.5,
                    total_discharge_capacity_mah=3.5,
                    capacity_summary_status="ready",
                ),
            ),
        ]
        db.add(cell)
        db.commit()

        payload = library.list_cells(db=db)[0]
        self.assertEqual(payload["max_specific_discharge_capacity_mah_g"], 700.0)

    def test_summary_error_returns_null(self):
        db = self.make_session()
        cell = Cell(name="Failed summary", cycling_status="active")
        cell.metadata_entries = [CellMetadata(key="active_material_mg", value="5")]
        test = Test(cell=cell, name="Imported file")
        test.file_links = [
            TestFile(
                position=0,
                file=SourceFile(
                    hash="failed-summary",
                    path="C:/data/failed.ndax",
                    filename="failed.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                    max_discharge_capacity_mah=3.0,
                    capacity_summary_status="error",
                ),
            )
        ]
        db.add(cell)
        db.commit()

        payload = library.list_cells(db=db)[0]
        self.assertIsNone(payload["max_specific_discharge_capacity_mah_g"])


if __name__ == "__main__":
    unittest.main()
