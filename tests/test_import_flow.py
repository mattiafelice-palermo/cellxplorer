import sys
import unittest
import os
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.models import Cell, SourceFile, Test, TestFile
from app.routers import files
from app.routers import library
from app.services import parsing


class ImportFlowTests(unittest.TestCase):
    def test_import_filename_allows_only_neware_files(self):
        self.assertTrue(files.import_filename_allowed("formation.ndax"))
        self.assertTrue(files.import_filename_allowed("cycling.NDA"))
        self.assertFalse(files.import_filename_allowed("notes.csv"))
        self.assertFalse(files.import_filename_allowed(""))

    def test_staged_path_rejects_directory_escape(self):
        with self.assertRaises(ValueError):
            files.resolve_import_staged_path("../outside.ndax")

    def test_source_path_takes_precedence_over_staged_import_path(self):
        source = files.resolve_import_source_path(
            "missing-staged-file.ndax",
            str(ROOT / "AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax"),
        )

        self.assertEqual(source, (ROOT / "AI_NMC_B50D50_004_1_LP30_Crate_25C_1.ndax").resolve())

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
        original = parsing.NewareNDA.read_metadata
        parsing.NewareNDA.read_metadata = lambda _: {
            "Step": {
                "Head_Info": {"Remark": {"Value": "actual-cell-remark"}},
                "User_Info": {"VAR1": {"User_Remark": "Voltage"}},
            }
        }
        try:
            meta = parsing.read_header_metadata("fake.ndax")
        finally:
            parsing.NewareNDA.read_metadata = original

        self.assertEqual(meta["remarks"], "actual-cell-remark")

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

        results = files.build_import_caches_parallel(
            jobs,
            executor_cls=FakeExecutor,
            max_workers=8,
        )

        self.assertEqual(FakeExecutor.calls, [("init", 2), ("map", 2)])
        self.assertEqual(results["a.ndax"]["rows"], 10)
        self.assertEqual(results["b.ndax"]["parser_version"], "parser-test")


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
