from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app.services import import_file_hints


class ImportFileHintTests(unittest.TestCase):
    def test_header_hints_are_optional_and_keep_supplier_format_and_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cell.mpr"
            path.write_bytes(b"mpr")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={"technique": "OCV"}):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["source_format"], "BioLogic EC-Lab")
        self.assertEqual(result["supplier"], "BioLogic")
        self.assertEqual(result["technique"], "OCV")
        self.assertIsNone(result["cycle_count"])
        self.assertIsNone(result["error"])

    def test_header_cycle_count_is_used_only_when_explicitly_available(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cell.ndax"
            path.write_bytes(b"neware")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={"cycle_count": 42}):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["cycle_count"], 42)
        self.assertEqual(result["supplier"], "Neware")

    def test_header_failure_is_a_row_hint_not_an_import_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cell.mpr"
            path.write_bytes(b"mpr")
            with patch.object(import_file_hints.parsing, "read_header_metadata", side_effect=ValueError("bad header")):
                result = import_file_hints.inspect_header_hint(str(path))
        self.assertEqual(result["error"], "bad header")
        self.assertIsNone(result["supplier"])

    def test_excel_hint_reports_parser_compatibility_without_blocking_other_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "neware.xlsx"
            workbook.write_bytes(b"workbook")
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={"technique": "GCPL"}):
                accepted = import_file_hints.inspect_header_hint(str(workbook))
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={
                "error": "unrecognized workbook", "error_kind": "unsupported",
                "error_message": "Not a supported Neware export."
            }):
                rejected = import_file_hints.inspect_header_hint(str(workbook))
            with patch.object(import_file_hints.parsing, "read_header_metadata", return_value={
                "error": "I/O error", "error_kind": None, "error_message": "Temporary read failure."
            }):
                transient = import_file_hints.inspect_header_hint(str(workbook))
            with patch.object(import_file_hints.parsing, "read_header_metadata", side_effect=OSError("sharing violation")):
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
        with tempfile.TemporaryDirectory() as directory:
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
