from __future__ import annotations
from backend.app.services.filesystem_cleanup import TemporaryDirectory

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app.services import import_file_hints


class ImportFileHintTests(unittest.TestCase):
    def test_header_hints_are_optional_and_keep_supplier_format_and_protocol(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "cell.mpr"
            path.write_bytes(b"mpr")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={"technique": "OCV"}):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["source_format"], "BioLogic EC-Lab")
        self.assertEqual(result["supplier"], "BioLogic")
        self.assertEqual(result["technique"], "OCV")
        self.assertIsNone(result["cycle_count"])
        self.assertIsNone(result["error"])
        self.assertIs(result["compatible"], True)

    def test_unsupported_biologic_technique_is_marked_incompatible(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "unsupported-geis.mpr"
            path.write_bytes(b"mpr")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={
                "error": "unsupported BioLogic technique",
                "error_kind": "unsupported",
                "error_message": "Unsupported BioLogic .mpr technique or file layout; CellXplorer does not support this source yet.",
            }):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertIs(result["compatible"], False)
        self.assertIn("does not support", result["error"])

    def test_header_cycle_count_is_used_only_when_explicitly_available(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "cell.ndax"
            path.write_bytes(b"neware")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={"cycle_count": 42}):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["cycle_count"], 42)
        self.assertEqual(result["supplier"], "Neware")

    def test_header_failure_is_a_row_hint_not_an_import_failure(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "cell.mpr"
            path.write_bytes(b"mpr")
            with patch.object(import_file_hints.parsing, "read_header_metadata", side_effect=ValueError("bad header")):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["error"], "bad header")
        self.assertIsNone(result["supplier"])

    def test_excel_hint_reports_parser_compatibility_without_blocking_other_formats(self):
        from backend.app.services import neware_excel

        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "neware.xlsx"
            workbook.write_bytes(b"workbook")
            with patch.object(neware_excel, "validate_supported_workbook") as validate, \
                 patch.object(import_file_hints.parsing, "read_header_metadata", side_effect=AssertionError("slow metadata reader called")):
                accepted = import_file_hints.inspect_header_hint(str(workbook))
                validate.assert_called_once_with(workbook)
            with patch.object(neware_excel, "validate_supported_workbook", side_effect=neware_excel.UnsupportedNewareExcelError("Not a supported Neware export.")):
                rejected = import_file_hints.inspect_header_hint(str(workbook))
            with patch.object(neware_excel, "validate_supported_workbook", side_effect=neware_excel.InvalidNewareExcelError("Temporary read failure.")):
                transient = import_file_hints.inspect_header_hint(str(workbook))
            with patch.object(neware_excel, "validate_supported_workbook", side_effect=OSError("sharing violation")):
                failed_read = import_file_hints.inspect_header_hint(str(workbook))
            binary = Path(directory) / "neware.ndax"
            binary.write_bytes(b"binary")
            with patch.object(import_file_hints.parsing, "read_header_metadata", side_effect=ValueError("hint unavailable")):
                unavailable_hint = import_file_hints.inspect_header_hint(str(binary))
        self.assertIs(accepted["compatible"], True)
        self.assertIs(rejected["compatible"], False)
        self.assertIsNone(transient["compatible"])
        self.assertIsNone(failed_read["compatible"])
        self.assertIsNone(unavailable_hint["compatible"])
        self.assertFalse(accepted["registered"])

    def test_normalized_header_error_is_not_reported_as_a_successful_scan(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "unsupported.mpr"
            path.write_bytes(b"mpr")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={
                "error": "unsupported technique",
                "error_message": "This BioLogic technique is not supported.",
            }):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["error"], "This BioLogic technique is not supported.")
        self.assertIsNone(result["technique"])

    def test_batch_hints_preserve_input_order_and_reject_oversized_batches(self):
        with patch.object(import_file_hints, "inspect_header_hint", side_effect=lambda path: {"path": path}):
            self.assertEqual(
                import_file_hints.inspect_header_hints(["b.mpr", "a.ndax"]),
                [{"path": "b.mpr"}, {"path": "a.ndax"}],
            )
        with self.assertRaises(ValueError):
            import_file_hints.inspect_header_hints([str(index) for index in range(import_file_hints.MAX_HINT_PATHS + 1)])


if __name__ == "__main__":
    unittest.main()


class ImportedCellOwnershipTests(unittest.TestCase):
    def test_current_names_continuations_hash_duplicates_and_detached_sources(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session
        from backend.app.db import Base
        from backend.app.models import Cell, Test, TestFile, SourceFile
        from backend.app.routers.files import inspect_import_header_hints, ImportHeaderHintsRequest
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        with TemporaryDirectory() as directory, Session(engine) as db:
            paths = [Path(directory) / name for name in ("original.ndax", "continued.ndax", "copy.ndax", "detached.ndax")]
            for path in paths: path.write_bytes(b"source")
            cell = Cell(name="Renamed Cell")
            test = Test(cell=cell, name="internal")
            first = SourceFile(hash="a" * 64, path=str(paths[0]), filename=paths[0].name, size=6, ext="ndax")
            tail = SourceFile(hash="b" * 64, path=str(paths[1]), filename=paths[1].name, size=6, ext="ndax")
            detached = SourceFile(hash="c" * 64, path=str(paths[3]), filename=paths[3].name, size=6, ext="ndax")
            db.add_all([test, first, tail, detached]); db.flush()
            db.add_all([TestFile(test_id=test.id, file_id=first.id, position=0), TestFile(test_id=test.id, file_id=tail.id, position=1)])
            db.commit()
            def hints(*args, **kwargs):
                return [dict(path=str(path), _hash="a" * 64 if i==2 else None) for i,path in enumerate(paths)]
            with patch.object(import_file_hints, "inspect_header_hints", side_effect=hints):
                result = inspect_import_header_hints(ImportHeaderHintsRequest(paths=list(map(str, paths))), db)["files"]
                for item in result[:3]:
                    self.assertTrue(item["registered"])
                    self.assertEqual(item["cells"], [dict(id=cell.id, name="Renamed Cell")])
                    self.assertNotIn("_hash", item)
                self.assertTrue(result[3]["registered"])
                self.assertEqual(result[3]["cells"], [])
                cell.name = "Renamed again"; db.commit()
                self.assertEqual(inspect_import_header_hints(ImportHeaderHintsRequest(paths=list(map(str, paths))), db)["files"][0]["cells"][0]["name"], "Renamed again")
        engine.dispose()
