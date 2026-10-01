from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from backend.app.db import Base
from backend.app.models import Analysis, AppSetting, Cell, CellMetadata, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
from backend.app.services.import_search_catalog import Catalog, path_key
from backend.app.services.import_search_filters import filtered_search, library_snapshot, validate_filters
from tests.test_import_search import config, fact


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.catalog = Catalog(Path(self.temp.name) / "catalog.sqlite")
        self.config = config()
        self.catalog.sync_roots(self.config["roots"])
        self.catalog.root_state("root", generation="one", status="ready")
        first, second, third = [fact(f"C:\\cycling\\{name}") for name in ("BQV_1.ndax", "ALAVA_2.xlsx", "z_unknown.mpr")]
        first.update(size=1048576, file_created_at="2025-01-01T00:00:00Z", metadata={"cycle_count": "200", "active_mass_mg": "10", "part_number": "Alava"})
        second.update(size=2097152, metadata={"cycle_count": "300", "active_mass_mg": "NaN", "start_time": "2026-01-02T00:00:00Z"})
        third.update(size=3145728, metadata={})
        self.catalog.apply_batch("root", "one", [first, second, third])

    def tearDown(self):
        self.temp.cleanup()

    def search(self, filters=None, q="", library=None, **page):
        return filtered_search(self.catalog, self.config, q, filters or {}, page.get("offset", 0), page.get("limit", 100), library or {})

    def test_ranges_unknown_and_stable_sort(self):
        result = self.search({"ranges": {"cycle_count": {"min": 250}}})
        self.assertEqual([r["name"] for r in result["items"]], ["ALAVA_2.xlsx"])
        self.assertEqual(self.search({"ranges": {"cycle_count": {"min": 250, "unknown": "include"}}})["total"], 2)
        self.assertEqual(self.search({"ranges": {"cycle_count": {"min": 250, "unknown": "only"}}})["total"], 1)
        self.assertEqual(self.search({"ranges": {"active_mass_mg": {"unknown": "only"}}})["total"], 2)
        self.assertEqual([r["size"] for r in self.search({"sort": "size_desc"})["items"]], [3145728, 2097152, 1048576])
        self.assertEqual(self.search({"sort": "created"})["items"][0]["name"], "BQV_1.ndax")
        self.assertEqual(self.search({"ranges": {"file_created_at": {"unknown": "only"}}})["total"], 2)

    def test_text_all_any_literal_case_and_negation(self):
        conditions = [{"field": "filename", "operator": "contains", "value": "bqv"}, {"field": "part_number", "operator": "equals", "value": "alava"}]
        self.assertEqual(self.search({"conditions": conditions})["total"], 1)
        self.assertEqual(self.search({"conditions": conditions})["items"][0]["condition_values"]["1"], "Alava")
        conditions[1]["field"] = "filename"
        self.assertEqual(self.search({"conditions": conditions})["total"], 0)
        self.assertEqual(self.search({"conditions": conditions, "match": "any"})["total"], 1)
        self.assertEqual(self.search({"conditions": [{"field": "filename", "operator": "contains", "value": "bqv", "case_sensitive": True}]})["total"], 0)
        for operation, text, expected in (("not_contains", "bqv", 2), ("starts", "BQV", 1), ("ends", ".xlsx", 1), ("contains", "%", 0), ("missing", "", 0)):
            self.assertEqual(self.search({"conditions": [{"field": "filename", "operator": operation, "value": text}]})["total"], expected)
        self.assertEqual(self.search(q="C:/cycling/BQV")["total"], 1)

    def test_chip_ordering_numeric_dates_text_and_unknown_last(self):
        for direction, expected in (("asc", ["BQV_1.ndax", "ALAVA_2.xlsx", "z_unknown.mpr"]),
                                    ("desc", ["ALAVA_2.xlsx", "BQV_1.ndax", "z_unknown.mpr"])):
            with self.subTest(direction=direction):
                self.assertEqual([row["name"] for row in self.search({"sort": f"cycle_count_{direction}"})["items"]], expected)
        self.assertEqual(self.search({"sort": "start_time_asc"})["items"][0]["name"], "ALAVA_2.xlsx")
        self.assertEqual(self.search({"sort": "file_created_at_desc"})["items"][0]["name"], "BQV_1.ndax")
        self.assertEqual(self.search({"sort": "filename_desc"})["items"][0]["name"], "z_unknown.mpr")
        self.assertEqual(self.search({"sort": "part_number_desc"})["items"][0]["name"], "BQV_1.ndax")
        self.assertEqual(self.search({"sort": "cycle_count_desc", "ranges": {"cycle_count": {"min": 190, "unknown": "include"}}}, limit=1)["items"][0]["name"], "ALAVA_2.xlsx")
        with self.assertRaises(ValueError):
            validate_filters({"sort": "size_desc;DROP TABLE entries"})

    def test_global_filter_before_pagination_and_folder_count_before_filters(self):
        for offset in (0, 1, 2):
            result = self.search({"ranges": {"size": {"min": 2 * 1048576}}}, offset=offset, limit=1)
            self.assertEqual(result["total"], 2)
            if result["items"]:
                self.assertEqual(result["items"][0]["folder_count"], 3)
        self.catalog.sync_roots([*self.config["roots"], dict(id="overlap", path="C:\\cycling", enabled=True)])
        self.catalog.root_state("overlap", generation="two", status="ready")
        self.catalog.apply_batch("overlap", "two", [fact("C:\\cycling\\BQV_1.ndax")])
        self.config["roots"].append(dict(id="overlap", path="C:\\cycling", enabled=True))
        self.assertEqual(self.search()["items"][0]["folder_count"], 3)

    def test_library_filters_versioned_cycles_and_no_source_access(self):
        key = path_key("C:\\cycling\\z_unknown.mpr")
        library = {key: dict(registered=True, size=3145728, mtime=1, cycle_count=500,
                            cells=[dict(id=1, name="Cell")], cell_name="Cell", cell_notes="notes", cell_metadata="chemistry: LFP",
                            analyses=[dict(id=4, name="Bump study")], replicates=[dict(id=2, name="Batch")])}
        with patch("os.stat", side_effect=AssertionError("Search must not stat sources")):
            self.assertEqual(self.search({"analysis_id": 4}, library=library)["total"], 1)
            self.assertEqual(self.search({"registered": "no"}, library=library)["total"], 2)
            self.assertEqual(self.search({"replicate_usage": "yes"}, library=library)["items"][0]["cells"][0]["id"], 1)
            self.assertEqual(self.search(q="LFP", library=library)["total"], 1)
            self.assertEqual(self.search({"ranges": {"cycle_count": {"min": 400}}}, library=library)["total"], 1)
            library[key]["mtime"] = 2
            self.assertEqual(self.search({"ranges": {"cycle_count": {"min": 400}}}, library=library)["total"], 0)
            library[key]["cell_notes"] = "project\\phase"
            self.assertEqual(self.search(q="project/phase", library=library)["total"], 1)
            self.assertEqual(self.search(q="project\\phase", library=library)["total"], 1)

    def test_validation_and_regex_worker(self):
        for bad in ({"ranges": {"bogus": {}}}, {"ranges": {"size": {"min": 3, "max": 1}}}, {"registered": "maybe"},
                    {"conditions": [{"field": "filename", "operator": "regex", "value": "["}]}):
            with self.assertRaises(ValueError):
                validate_filters(bad)
        result = self.search({"conditions": [{"field": "filename", "operator": "regex", "value": "BQV_[0-9]+"}]})
        self.assertEqual(result["total"], 1)
        # An exponential expression must be killed in its isolated child.
        self.catalog.apply_batch("root", "one", [fact("C:\\cycling\\" + "a" * 90 + "!.ndax")])
        import time
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "three seconds"):
            self.search({"conditions": [{"field": "filename", "operator": "regex", "value": "(a+)+$"}]})
        self.assertLess(time.monotonic() - started, 5)

    def test_upgrade_preserves_old_entries(self):
        with self.catalog.connect() as db:
            db.execute("DROP INDEX entry_folder")
            for field in ("file_created_at", "first_indexed_at", "folder_key"):
                db.execute(f"ALTER TABLE entries DROP COLUMN {field}")
            db.execute("PRAGMA user_version=1")
        replacement = Catalog(self.catalog.path)
        self.assertEqual(replacement.search(self.config)["total"], 3)
        self.assertEqual(self.search({"ranges": {"file_created_at": {"unknown": "only"}}})["total"], 3)

    def test_header_facts_and_creation_stay_bounded(self):
        from types import SimpleNamespace
        from backend.app.services.import_search_worker import inspect_fact, file_created_at
        value = fact("C:\\cycling\\export.xlsx")
        header = {"raw": {"Excel.Original.Test.CycleCount.Value": "200"}, "active_mass_mg": 10}
        with patch("backend.app.services.neware_excel.validate_supported_workbook"), patch("backend.app.services.parsing.read_header_metadata", return_value=header) as read, patch("os.stat", return_value=SimpleNamespace(st_size=1, st_mtime_ns=1)):
            result = inspect_fact(value, True)
            self.assertEqual(result["metadata"]["cycle_count"], "200")
            self.assertEqual(result["metadata"]["active_mass_mg"], "10")
            read.assert_called_once_with(value["path"], fast_excel_hint=True)
        self.assertEqual(file_created_at(SimpleNamespace(st_birthtime=0)), "1970-01-01T00:00:00+00:00")

    def test_presets_validate_persist_and_preserve_other_settings(self):
        from fastapi import HTTPException
        from backend.app.routers.import_search import presets, save_presets
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            db.add(AppSetting(key="unrelated", value="preserve")); db.commit()
            value = [{"id": "one", "name": " Search ", "q": "BQV", "filters": {"registered": "yes"}}]
            save_presets(value, db)
            self.assertEqual(presets(db)[0]["name"], "Search")
            self.assertEqual(db.get(AppSetting, "unrelated").value, "preserve")
            for bad in ([dict(id="", name="Search")], value * 2, [dict(id="two", name="Search", filters={"no": True})]):
                with self.assertRaises(HTTPException):
                    save_presets(bad, db)
            self.assertEqual(len(presets(db)), 1)
            db.get(AppSetting, "import_search_presets").value = "broken JSON"; db.commit()
            self.assertEqual(presets(db), [])
        engine.dispose()

    def test_current_relational_membership_and_aliases(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            cell = Cell(name="LFP cell", description="special note")
            group = ReplicateGroup(name="Replicates")
            db.add_all([cell, group]); db.flush()
            db.add_all([ReplicateGroupCell(group_id=group.id, cell_id=cell.id), CellMetadata(cell_id=cell.id, key="chemistry", value="LFP"), CellMetadata(cell_id=cell.id, key="raw.hidden", value="should not search")])
            test = Test(cell_id=cell.id, name="compatibility")
            db.add(test); db.flush()
            for index in range(2):
                source = SourceFile(hash=str(index), path=f"Z:\\data\\source{index}.ndax", filename=f"source{index}.ndax", size=10, ext="ndax")
                db.add(source); db.flush()
                db.add(TestFile(test_id=test.id, file_id=source.id, position=index))
            analysis = Analysis(title="Analysis", spec={"selection": {"entries": [{"kind": "replicate_group", "ref_id": group.id}]}})
            db.add(analysis); db.commit()
            library, options = library_snapshot(db, [dict(path="Z:\\data", canonical_root="\\\\server\\share\\data")])
            for index in range(2):
                info = library[path_key(f"\\\\server\\share\\data\\source{index}.ndax")]
                self.assertEqual(info["analyses"][0]["id"], analysis.id)
                self.assertEqual(info["replicates"][0]["id"], group.id)
                self.assertNotIn("hidden", info["cell_metadata"])
            db.delete(analysis); db.commit()
            library, _ = library_snapshot(db, [])
            self.assertFalse(library[path_key("Z:\\data\\source0.ndax")]["analyses"])
        engine.dispose()

    def test_changed_sources_and_mapped_drive_root(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            source = SourceFile(hash="old", path="Z:\\source.ndax", filename="source.ndax", size=10, ext="ndax", parse_status="parsed", cycle_count=200, active_mass_mg=10, observed_mtime_ns=2, location_status="changed")
            db.add(source); db.commit()
            facts, _ = library_snapshot(db, [dict(path="Z:\\", canonical_root="\\\\server\\share")])
            info = facts[path_key("\\\\server\\share\\source.ndax")]
            self.assertTrue(info["registered"])
            self.assertIsNone(info["cycle_count"])
            self.assertIsNone(info["active_mass_mg"])
            source.path = "\\\\server\\share\\source.ndax"; db.commit()
            facts, _ = library_snapshot(db, [dict(path="Z:\\", canonical_root="\\\\server\\share")])
            self.assertIn(path_key("Z:\\source.ndax"), facts)
        engine.dispose()

    def test_relational_snapshot_spans_concurrent_change_and_releases_read(self):
        from sqlalchemy import event
        engine = create_engine(f"sqlite:///{Path(self.temp.name) / 'library.sqlite'}")
        Base.metadata.create_all(engine)
        with engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        with Session(engine) as db:
            cell = Cell(name="Original", description="original note")
            db.add(cell); db.flush()
            db.add(CellMetadata(cell_id=cell.id, key="chemistry", value="LFP"))
            source = SourceFile(hash="one", path="C:\\cycling\\BQV_1.ndax", filename="BQV_1.ndax", size=1, ext="ndax")
            test = Test(cell_id=cell.id, name="compat")
            db.add_all([source, test]); db.flush()
            db.add(TestFile(test_id=test.id, file_id=source.id, position=0)); db.commit()
            changed = []
            def concurrent_writer(connection, cursor, statement, parameters, context, many):
                if not changed and "FROM cells" in statement:
                    changed.append(True)
                    with engine.begin() as writer:
                        writer.exec_driver_sql("UPDATE cell_metadata SET value='NMC'")
            event.listen(engine, "after_cursor_execute", concurrent_writer)
            try:
                facts, _ = library_snapshot(db, [])
            finally:
                event.remove(engine, "after_cursor_execute", concurrent_writer)
            self.assertTrue(changed)
            self.assertEqual(facts[path_key(source.path)]["cell_metadata"], "chemistry: LFP")
            self.assertFalse(db.connection().connection.driver_connection.in_transaction)
            self.assertEqual(library_snapshot(db, [])[0][path_key(source.path)]["cell_metadata"], "chemistry: NMC")
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
