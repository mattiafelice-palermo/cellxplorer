"""Readable import explanations keep scientific and access failures distinct."""
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))

from app.services import biologic_mpr, import_file_hints, parsing, source_readability
from app.services.source_error_messages import source_error_message
from app.services.source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError, SourceFormatError


class SourceErrorMessagesTests(unittest.TestCase):
    def tearDown(self):
        source_readability.clear()

    def test_explanations_report_specific_structure_or_semantic_evidence(self):
        cases = [
            (InvalidSourceFormatError("sample.mpr ends inside an MPR module header"), "complete block header"),
            (InvalidSourceFormatError("sample.mpr declares a truncated MPR module"), "more data than the file contains"),
            (InvalidSourceFormatError("sample.mpr VMP record area of 107 bytes is not divisible by 2 datapoints"), "2 measurements"),
            (UnsupportedSourceFormatError("sample.mpr uses unsupported BioLogic technique discriminator 0x42"), "technique code 0x42"),
            (UnsupportedSourceFormatError("VMP data is missing required GCPL base IDs: [211]"), "required measurement fields"),
            (InvalidSourceFormatError("VMP registry-derived record width is 53 bytes; observed stride is 54"), "measurement size"),
            (UnsupportedSourceFormatError("Repeated GCPL acquisitions are missing unambiguous execution markers; their charge/discharge phases cannot be assigned safely."), "restart markers"),
            (UnsupportedSourceFormatError("GCPL capacity transfer is ambiguous at an executed-step boundary; boundary rows must have zero incremental and cumulative transfer"), "capacity change"),
            (InvalidSourceFormatError("GCPL data contains a row with the BioLogic error flag set"), "instrument marked"),
            (InvalidSourceFormatError("GCPL whole-test elapsed time decreases in acquisition order"), "time moves backwards"),
        ]
        for error, expected in cases:
            with self.subTest(diagnostic=str(error)):
                message = source_error_message("sample.mpr", error)
                self.assertIn(expected, message)
                self.assertNotIn("corrupt", message.casefold())
                self.assertNotIn("base IDs", message)

    def test_filename_does_not_change_reason_and_other_adapters_keep_messages(self):
        error = UnsupportedSourceFormatError("truncated.mpr uses unsupported BioLogic technique discriminator 0x42")
        self.assertIn("technique code", source_error_message("truncated.mpr", error))
        self.assertEqual(source_error_message("sample.xlsx", error), str(error))

    def test_header_retains_raw_diagnostic_and_emits_readable_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "incomplete.mpr"
            path.write_bytes(biologic_mpr.MPR_MAGIC + b"partial")
            result = parsing.read_header_metadata(path)
            self.assertIn("ends inside an MPR module header", result["error"])
            self.assertIn("complete block header", result["error_message"])
            self.assertEqual(result["error_kind"], "invalid")
            with self.assertRaisesRegex(InvalidSourceFormatError, "complete block header"):
                parsing.ensure_supported_source_metadata(path, result)

    def test_stat_success_but_open_failure_remains_retryable_in_every_import_layer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "temporarily-locked.mpr"
            path.write_bytes(biologic_mpr.MPR_MAGIC + b"partial")
            with patch.object(Path, "open", side_effect=PermissionError("sharing or access denied")):
                self.assertIsNotNone(source_readability.file_identity(path))
                with self.assertRaises(biologic_mpr.MprError):
                    parsing.parse_timeseries(path)
                self.assertIsNone(source_readability.known_rejection(path))
                metadata = parsing.read_header_metadata(path)
                self.assertIsNone(metadata["error_kind"])
                self.assertIn("read access", metadata["error_message"])
                self.assertIn("Cannot open MPR source", metadata["error"])
                with self.assertRaises(SourceFormatError) as caught:
                    parsing.ensure_supported_source_metadata(path, metadata)
                self.assertIs(type(caught.exception), SourceFormatError)
                hint = import_file_hints.inspect_header_hint(str(path))
                self.assertIsNone(hint["compatible"])
                self.assertNotIn("source_error_kind", hint)

    def test_remembered_rejection_preserves_diagnostic_but_presents_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.mpr"
            path.write_bytes(b"bad")
            error = InvalidSourceFormatError("source.mpr declares a truncated MPR module")
            source_readability.remember_rejection(path, source_readability.file_identity(path), error)
            rejection = source_readability.known_rejection(path)
            self.assertEqual(rejection.diagnostic, str(error))
            self.assertIn("more data than the file contains", rejection.error)


if __name__ == "__main__":
    unittest.main()
