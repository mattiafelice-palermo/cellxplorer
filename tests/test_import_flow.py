import sys
import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Cell, CellMetadata, SourceFile, Test, TestFile
from app.routers import files
from app.routers import library
from app.services import parsing
from app.services import background_jobs
from app.services import import_inspection


class ImportFlowTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_import_filename_allows_only_neware_files(self):
        self.assertTrue(files.import_filename_allowed("formation.ndax"))
        self.assertTrue(files.import_filename_allowed("cycling.NDA"))
        self.assertFalse(files.import_filename_allowed("notes.csv"))
        self.assertFalse(files.import_filename_allowed(""))

    def test_folder_listing_is_recursive_and_filters_non_neware_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / "batch" / "nested"
            nested.mkdir(parents=True)
            (root / "root.nda").write_bytes(b"root")
            (nested / "cell.ndax").write_bytes(b"nested")
            (nested / "notes.csv").write_text("ignore", encoding="ascii")

            result = files.list_import_folder_files(root)

        self.assertEqual(
            [item["relative_path"] for item in result["files"]],
            ["root.nda", "batch/nested/cell.ndax"],
        )
        self.assertTrue(all(item["selection_root"]["kind"] == "folder" for item in result["files"]))
        self.assertEqual(result["files"][0]["selection_root"]["path"], str(root.resolve()))

    def test_source_listing_combines_multiple_folders_and_loose_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            loose = root / "loose.nda"
            loose.write_bytes(b"loose")
            (first / "one.ndax").write_bytes(b"one")
            (second / "two.nda").write_bytes(b"two")

            result = files.list_import_sources(
                [str(loose)],
                [str(first), str(second)],
            )

        self.assertEqual(
            [item["relative_path"] for item in result["files"]],
            ["loose.nda", "one.ndax", "two.nda"],
        )
        self.assertEqual(result["files"][0]["selection_root"]["label"], "Loose files")
        self.assertEqual(result["files"][1]["selection_root"]["path"], str(first.resolve()))
        self.assertEqual(result["files"][2]["selection_root"]["path"], str(second.resolve()))

    def test_source_listing_job_reports_roots_without_inspection(self):
        background_jobs.clear_jobs()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "batch"
            root.mkdir()
            loose = Path(tmp) / "loose.ndax"
            loose.write_bytes(b"loose")
            (root / "one.nda").write_bytes(b"one")
            with patch.object(parsing, "compute_hash", side_effect=AssertionError("hash called")):
                result = files.list_import_source_paths(
                    files.ImportSourceListRequest(
                        file_paths=[str(loose)],
                        folder_paths=[str(root)],
                        job_token="scan-test",
                    )
                )
        job = background_jobs.find_by_token("scan-test")
        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(job["kind"], "import_scan")
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["completed"], 2)
        self.assertEqual(job["discovered_files"], 2)
        self.assertIsNone(job["current_item_id"])
        background_jobs.clear_jobs()

    def test_inspection_job_reports_file_and_byte_progress(self):
        background_jobs.clear_jobs()
        preview = {"staged_name": "x", "size": 12, "filename": "x.ndax"}
        inspected = import_inspection.FileInspection(
            path="C:/data/x.ndax",
            filename="x.ndax",
            size=12,
            mtime_ns=1,
            ext="ndax",
            hash="hash",
            metadata={},
        )
        with patch.object(files.import_inspection, "build_identity_snapshot", return_value=Mock()), \
            patch.object(files.import_inspection, "inspect_files", return_value=[inspected]), \
            patch.object(files, "_inspect_import_path", return_value=preview):
            result = files.inspect_import_paths(
                files.ImportPathInspectRequest(
                    paths=["C:/data/x.ndax"],
                    job_token="inspect-test",
                ),
                db=Mock(),
            )
        job = background_jobs.find_by_token("inspect-test")
        self.assertEqual(result["files"], [preview])
        self.assertEqual(job["kind"], "import_inspect")
        self.assertEqual(job["completed"], 1)
        self.assertEqual(job["completed_bytes"], 12)
        self.assertIsNone(job["current_item_label"])
        background_jobs.clear_jobs()

    def test_registration_job_failure_is_failed_and_rolls_back(self):
        background_jobs.clear_jobs()
        db = Mock()
        with patch.object(files, "_create_imported_cells_impl", side_effect=RuntimeError("injected failure")):
            with self.assertRaises(RuntimeError):
                files.create_imported_cells(
                    files.ImportCellsRequest(
                        cells=[],
                        job_token="register-test",
                    ),
                    db=db,
                )
        job = background_jobs.find_by_token("register-test")
        self.assertEqual(job["kind"], "import_register")
        self.assertEqual(job["status"], "failed")
        self.assertIn("injected failure", job["error"])
        db.rollback.assert_called_once()
        background_jobs.clear_jobs()

    def test_source_listing_keeps_same_named_roots_distinguishable(self):
        with tempfile.TemporaryDirectory() as tmp:
            outer = Path(tmp)
            first = outer / "one" / "batch"
            second = outer / "two" / "batch"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            (first / "a.ndax").write_bytes(b"a")
            (second / "b.ndax").write_bytes(b"b")

            result = files.list_import_sources([], [str(first), str(second)])

        roots = [item["selection_root"] for item in result["files"]]
        self.assertEqual([root["label"] for root in roots], ["batch", "batch"])
        self.assertNotEqual(roots[0]["path"], roots[1]["path"])

    def test_import_directory_browser_lists_folders_and_neware_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "nested").mkdir()
            (root / "cell.ndax").write_bytes(b"cell")
            (root / "older.nda").write_bytes(b"older")
            (root / "notes.csv").write_text("ignore", encoding="ascii")

            result = files.browse_import_directory(str(root))

        self.assertEqual(result["current_path"], str(root.resolve()))
        self.assertEqual(
            [(entry["name"], entry["kind"]) for entry in result["entries"]],
            [("nested", "folder"), ("cell.ndax", "file"), ("older.nda", "file")],
        )
        self.assertEqual(result["parent_path"], str(root.resolve().parent))

    def test_quick_access_pins_and_recent_folders_are_persistent(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp).resolve()
            files.remember_import_folder(db, folder)
            files.update_import_pinned_folders(
                files.ImportPinnedFoldersRequest(paths=[str(folder)]),
                db=db,
            )
            items = files.import_quick_access(db)

        match = next(item for item in items if item["path"] == str(folder))
        self.assertTrue(match["pinned"])

    def test_staged_path_rejects_directory_escape(self):
        with self.assertRaises(ValueError):
            files.resolve_import_staged_path("../outside.ndax")

    def test_source_path_takes_precedence_over_staged_import_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "example.ndax"
            source.write_bytes(b"example")
            resolved = files.resolve_import_source_path(
                "missing-staged-file.ndax",
                str(source),
            )

            self.assertEqual(resolved, source.resolve())

    def test_capacity_preview_uses_cycle_capacity_points(self):
        cycles = pd.DataFrame(
            {
                "cycle": [1, 2, 3],
                "discharge_capacity_mah": [1.2, None, 1.4],
                "charge_capacity_mah": [1.3, 1.35, 1.45],
            }
        )

        preview = files.capacity_preview_from_cycles(cycles)

        self.assertEqual(
            preview,
            {
                "x": [1, 3],
                "y": [1.2, 1.4],
                "quantity": "discharge_capacity_mah",
                "label": "Discharge capacity (mAh)",
            },
        )

    def test_header_metadata_prefers_neware_head_remark(self):
        with patch.object(
            parsing,
            "_read_ndax_metadata_flat",
            side_effect=parsing._NdaxXmlFallback,
        ), patch.object(
            parsing.NewareNDA,
            "read_metadata",
            return_value={
                "Step": {
                    "Head_Info": {"Remark": {"Value": "actual-cell-remark"}},
                    "User_Info": {"VAR1": {"User_Remark": "Voltage"}},
                }
            },
        ):
            meta = parsing.read_header_metadata("fake.ndax")

        self.assertEqual(meta["remarks"], "actual-cell-remark")

    def test_header_metadata_extracts_neware_test_information_units(self):
        with patch.object(
            parsing,
            "_read_ndax_metadata_flat",
            side_effect=parsing._NdaxXmlFallback,
        ), patch.object(
            parsing.NewareNDA,
            "read_metadata",
            return_value={
                "Step": {
                    "Head_Info": {
                        "Start_Step": {"Value": "1"},
                        "PN": {"Value": "2026-03-17 14-04-28"},
                        "Creator": {"Value": "CY"},
                        "Remark": {"Value": "NG_20260317_LFP_LP_MoL_530_FM+CY"},
                        "SCQ": {"Value": "333770"},
                        "MultCap": {"Value": "185040"},
                    },
                    "Step_Info": {
                        "Step1": {
                            "Record": {"Main": {"Time": {"Value": "1000"}}},
                            "Protect": {
                                "Main": {
                                    "Volt": {
                                        "Upper": {"Value": "38500"},
                                        "Lower": {"Value": "27500"},
                                    }
                                }
                            },
                        }
                    },
                }
            },
        ):
            meta = parsing.read_header_metadata("fake.ndax")

        self.assertEqual(meta["start_step_id"], "1")
        self.assertEqual(meta["part_number"], "2026-03-17 14-04-28")
        self.assertEqual(meta["builder"], "CY")
        self.assertAlmostEqual(meta["active_mass_mg"], 333.77, places=6)
        self.assertAlmostEqual(meta["active_material_mg"], 333.77, places=6)
        self.assertAlmostEqual(meta["nominal_capacity_mah"], 51.4, places=6)
        self.assertAlmostEqual(meta["voltage_upper_v"], 3.85, places=6)
        self.assertAlmostEqual(meta["voltage_lower_v"], 2.75, places=6)
        self.assertAlmostEqual(meta["record_interval_s"], 1.0, places=6)

    def test_metadata_preview_includes_normalized_capacity_fields(self):
        preview = files._metadata_preview(
            {
                "active_mass_mg": 333.77,
                "nominal_capacity_mah": 51.4,
                "builder": "CY",
                "part_number": "P-1",
                "voltage_upper_v": 3.85,
                "voltage_lower_v": 2.75,
            }
        )

        self.assertEqual(preview["active_material_mg"], "333.77")
        self.assertEqual(preview["nominal_capacity_mah"], "51.4")
        self.assertEqual(preview["builder"], "CY")
        self.assertEqual(preview["part_number"], "P-1")

    def test_imported_cell_metadata_keeps_full_flattened_header(self):
        meta = {
            "active_mass_mg": 333.77,
            "builder": "CY",
            "raw": {
                "Step.Head_Info.Creator.Value": "CY",
                "Step.User_Info.Custom.Field": "all metadata survives",
            },
        }
        metadata = files.full_cell_metadata_from_header(meta, {"operator_note": "checked"})

        self.assertEqual(metadata["active_material_mg"], "333.77")
        self.assertEqual(metadata["builder"], "CY")
        self.assertEqual(metadata["raw.Step.Head_Info.Creator.Value"], "CY")
        self.assertEqual(metadata["raw.Step.User_Info.Custom.Field"], "all metadata survives")
        self.assertEqual(metadata["operator_note"], "checked")

    def test_raw_table_from_frame_returns_json_safe_page(self):
        raw = pd.DataFrame(
            {
                "record_index": [1, 2, 3],
                "voltage_v": [3.1, None, 3.3],
                "timestamp": pd.to_datetime(
                    ["2026-01-01 00:00:00", "2026-01-01 00:00:01", "2026-01-01 00:00:02"]
                ),
            }
        )

        table = files.raw_table_from_frame(raw, offset=1, limit=2)

        self.assertEqual(table["columns"], ["record_index", "voltage_v", "timestamp"])
        self.assertEqual(table["total_rows"], 3)
        self.assertEqual(table["offset"], 1)
        self.assertEqual(table["limit"], 2)
        self.assertEqual(
            table["rows"],
            [
                {"record_index": 2, "voltage_v": None, "timestamp": "2026-01-01T00:00:01"},
                {"record_index": 3, "voltage_v": 3.3, "timestamp": "2026-01-01T00:00:02"},
            ],
        )

    def test_import_match_finds_exact_hash_duplicate(self):
        class FakeDb:
            def __init__(self):
                cell = Cell(id=10, name="Cell A")
                test = Test(id=20, name="Imported file", cell=cell)
                sf = SourceFile(
                    id=30,
                    hash="abc123",
                    path="C:/data/cell_a.ndax",
                    filename="cell_a.ndax",
                    size=100,
                    ext="ndax",
                    location_status="online",
                    parse_status="parsed",
                )
                sf.test_link = TestFile(test=test, file=sf)
                self.rows = [sf]

            def query(self, model):
                return FakeQuery(self.rows)

        duplicate = files.import_match_info(
            FakeDb(),
            file_hash="abc123",
            filename="cell_a_copy.ndax",
            meta={},
        )

        self.assertEqual(duplicate["kind"], "exact_duplicate")
        self.assertEqual(duplicate["cell_name"], "Cell A")
        self.assertEqual(duplicate["source_file_id"], 30)

    def test_import_match_finds_possible_update_from_soft_identity(self):
        class FakeDb:
            def __init__(self):
                sf = SourceFile(
                    id=31,
                    hash="oldhash",
                    path="C:/data/cycling.ndax",
                    filename="cycling.ndax",
                    size=100,
                    ext="ndax",
                    barcode="B-7",
                    channel="1-2",
                    start_time="2026-01-01 10:00:00",
                    location_status="online",
                    parse_status="parsed",
                )
                self.rows = [sf]

            def query(self, model):
                return FakeQuery(self.rows)

        match = files.import_match_info(
            FakeDb(),
            file_hash="newhash",
            filename="cycling.ndax",
            meta={"barcode": "B-7", "channel": "1-2", "start_time": "2026-01-01 10:00:00"},
        )

        self.assertEqual(match["kind"], "possible_update")
        self.assertEqual(match["source_file_id"], 31)
        self.assertIn("filename", match["matched_on"])
        self.assertIn("barcode", match["matched_on"])

    def test_source_file_needs_cache_when_unparsed_or_counts_missing(self):
        unparsed = SourceFile(parse_status="unparsed", parser_version=None, cycle_count=None)
        parsed_missing_counts = SourceFile(
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            cycle_count=None,
        )
        parsed_ready = SourceFile(
            hash="hash-with-cache",
            parse_status="parsed",
            parser_version=parsing.PARSER_VERSION,
            row_count=100,
            cycle_count=10,
        )

        original = library.cache.has_cycles
        library.cache.has_cycles = lambda *args: True
        try:
            self.assertTrue(library.source_file_needs_cache(unparsed))
            self.assertTrue(library.source_file_needs_cache(parsed_missing_counts))
            self.assertFalse(library.source_file_needs_cache(parsed_ready))
        finally:
            library.cache.has_cycles = original

    def test_import_replicate_plan_files_groups_and_unassigned_cells(self):
        cells = [
            files.ImportCellDraft(staged_name="a.ndax", filename="a.ndax", cell_name="A"),
            files.ImportCellDraft(staged_name="b.ndax", filename="b.ndax", cell_name="B"),
            files.ImportCellDraft(staged_name="c.ndax", filename="c.ndax", cell_name="C"),
        ]
        groups = [
            files.ImportReplicateGroupDraft(
                name="Replicate A",
                staged_names=["a.ndax", "b.ndax"],
            )
        ]

        plan = files.import_replicate_plan(cells, groups)

        self.assertEqual(plan["groups"][0]["name"], "Replicate A")
        self.assertEqual(plan["groups"][0]["staged_names"], ["a.ndax", "b.ndax"])
        self.assertEqual(plan["unassigned_staged_names"], ["c.ndax"])

    def test_import_replicate_plan_rejects_single_cell_group(self):
        cells = [files.ImportCellDraft(staged_name="a.ndax", filename="a.ndax", cell_name="A")]
        groups = [files.ImportReplicateGroupDraft(name="Too small", staged_names=["a.ndax"])]

        with self.assertRaises(files.ImportPlanError):
            files.import_replicate_plan(cells, groups)

    def test_parallel_cache_builder_uses_multiple_workers_for_multiple_files(self):
        class FakeExecutor:
            calls = []

            def __init__(self, max_workers=None):
                self.max_workers = max_workers
                FakeExecutor.calls.append(("init", max_workers))

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def map(self, fn, jobs):
                job_list = list(jobs)
                FakeExecutor.calls.append(("map", len(job_list)))
                return [
                    {
                        "hash": job["hash"],
                        "rows": 10,
                        "cycles": 2,
                        "parser_version": "parser-test",
                        "calc_version": "calc-test",
                    }
                    for job in job_list
                ]

        jobs = [
            {"staged_name": "a.ndax", "hash": "hash-a", "path": "C:/data/a.ndax"},
            {"staged_name": "b.ndax", "hash": "hash-b", "path": "C:/data/b.ndax"},
        ]

        reported = []
        results = files.build_import_caches_parallel(
            jobs,
            executor_cls=FakeExecutor,
            max_workers=8,
            progress_callback=lambda job, result: reported.append(
                (job["staged_name"], result["staged_name"])
            ),
        )

        self.assertEqual(FakeExecutor.calls, [("init", 2), ("map", 2)])
        self.assertEqual(results["a.ndax"]["rows"], 10)
        self.assertEqual(results["b.ndax"]["parser_version"], "parser-test")
        self.assertEqual(reported, [("a.ndax", "a.ndax"), ("b.ndax", "b.ndax")])

    def test_create_imported_cells_starts_cache_jobs_after_committing_import(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "large.ndax"
            path.write_bytes(b"fake-import-test-content")
            started = []
            original_start = files.start_import_cache_jobs
            original_hash = parsing.compute_hash
            original_meta = parsing.read_header_metadata
            original_inspect = files._inspect_cell_draft_chain
            files.start_import_cache_jobs = lambda file_ids, jobs: started.append((file_ids, jobs))
            files._inspect_cell_draft_chain = lambda draft, db, **kwargs: {
                "can_submit": True,
                "inspection_complete": True,
                "findings": [],
                "sources": [
                    {
                        "key": source.staged_name,
                        "kind": "staged",
                        "hash": "import-test-hash",
                        "inspection_status": "ready",
                    }
                    for source in files.normalize_import_cell_sources(draft)
                ],
            }
            parsing.compute_hash = lambda _path: "import-test-hash"
            parsing.read_header_metadata = lambda _path: {"builder": "test"}
            try:
                result = files.create_imported_cells(
                    files.ImportCellsRequest(
                        cells=[
                            files.ImportCellDraft(
                                staged_name="large.ndax",
                                source_path=str(path),
                                filename=path.name,
                                cell_name="Async import cell",
                                test_name="Imported file",
                                active_mass_mg_override=25,
                                nominal_capacity_mah_override=4.25,
                                electrode_area_cm2_override=1.539,
                                active_material_preset_id="lfp-reference",
                                active_material_name="LFP",
                                active_material_specific_capacity_mah_g=170,
                                electrode_area_preset_id="coin-14mm",
                                electrode_area_preset_name="14 mm circular electrode",
                            )
                        ]
                    ),
                    db=db,
                )
            finally:
                files.start_import_cache_jobs = original_start
                files._inspect_cell_draft_chain = original_inspect
                parsing.compute_hash = original_hash
                parsing.read_header_metadata = original_meta

        self.assertEqual(result["created"][0]["cell_name"], "Async import cell")
        self.assertTrue(result["parsing_started"])
        self.assertEqual(len(started), 1)
        imported_cell = db.get(Cell, result["created"][0]["cell_id"])
        self.assertIsNotNone(imported_cell)
        self.assertEqual(len(imported_cell.tests), 1)
        self.assertEqual(imported_cell.tests[0].name, "Imported file")
        source_file = db.query(SourceFile).filter(SourceFile.filename == path.name).one()
        self.assertEqual(source_file.parse_status, "parsing")
        self.assertEqual(started[0][0], {"large.ndax": source_file.id})
        metadata = {
            row.key: row.value
            for row in db.query(CellMetadata)
            .filter(CellMetadata.cell_id == result["created"][0]["cell_id"])
            .all()
        }
        self.assertEqual(metadata["override.active_material_name"], "LFP")
        self.assertEqual(
            metadata["override.active_material_specific_capacity_mah_g"],
            "170.0",
        )
        self.assertEqual(
            metadata["override.electrode_area_preset_name"],
            "14 mm circular electrode",
        )

    def test_ensure_cell_caches_does_not_parse_files_already_parsing(self):
        db = self.make_session()
        cell = Cell(name="Parsing cell")
        source = SourceFile(
            hash="hash-parsing",
            path=str(ROOT / "AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax"),
            filename="AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsing",
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.flush()

        calls = []
        original_parse = library.scanner.parse_file
        library.scanner.parse_file = lambda *_: calls.append("parse")
        try:
            library.ensure_cell_caches(db, cell)
        finally:
            library.scanner.parse_file = original_parse

        self.assertEqual(calls, [])

    def test_cell_dict_reports_parsing_sources(self):
        db = self.make_session()
        cell = Cell(name="Parsing cell")
        source = SourceFile(
            hash="hash-parsing",
            path="C:/data/parsing.ndax",
            filename="parsing.ndax",
            size=10,
            ext="ndax",
            location_status="online",
            parse_status="parsing",
        )
        test = Test(cell=cell, name="Imported file")
        test.file_links = [TestFile(file=source, position=0)]
        db.add(cell)
        db.flush()

        payload = library.cell_dict(db, cell)

        self.assertTrue(payload["has_parsing"])


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.predicates = []

    def filter(self, predicate):
        self.predicates.append(predicate)
        return self

    def first(self):
        if not self.predicates:
            return self.rows[0] if self.rows else None
        for row in self.rows:
            if all(predicate(row) for predicate in self.predicates):
                return row
        return None

    def all(self):
        return list(self.rows)


if __name__ == "__main__":
    unittest.main()
