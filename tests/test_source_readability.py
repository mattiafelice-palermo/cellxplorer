from __future__ import annotations

from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import pandas as pd

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services import import_file_hints, parsing, source_readability
from app.services.source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


class SourceReadabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cellxplorer-source-readability-")
        self.path = Path(self.temp.name) / "source.mpr"
        self.path.write_bytes(b"a source")
        source_readability.clear()

    def tearDown(self):
        source_readability.clear()
        self.temp.cleanup()

    def reject(self, error=None):
        error = error or UnsupportedSourceFormatError("Unsupported repeated sequence")
        with patch.object(parsing, "_parse_source_timeseries", side_effect=error):
            with self.assertRaises(type(error)):
                parsing.parse_timeseries(self.path)
        return source_readability.known_rejection(self.path)

    def test_only_canonical_source_rejections_are_remembered(self):
        for error in (OSError("cache disk full"), RuntimeError("worker stopped"), ValueError("request failed")):
            self.assertIsNone(self.reject(error))
        rejection = self.reject(InvalidSourceFormatError("Unsafe raw data"))
        self.assertEqual(rejection.kind, "invalid")
        self.assertEqual(rejection.identity.size, self.path.stat().st_size)

    def test_supported_no_cycle_data_is_not_a_rejection(self):
        self.reject()
        with patch.object(parsing, "_parse_source_timeseries", return_value=pd.DataFrame()):
            self.assertTrue(parsing.parse_timeseries(self.path).empty)
        self.assertIsNone(source_readability.known_rejection(self.path))

    def test_replaced_or_modified_file_invalidates_rejection(self):
        self.reject()
        self.path.write_bytes(b"a repaired and larger source")
        self.assertIsNone(source_readability.known_rejection(self.path))
        self.reject()
        previous = self.path.stat()
        replacement = self.path.with_name("replacement.mpr")
        replacement.write_bytes(b"a repaired and larger source")
        os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        os.replace(replacement, self.path)
        self.assertIsNone(source_readability.known_rejection(self.path))

    def test_moving_source_does_not_acquire_a_stale_semantic_rejection(self):
        def changed(_path):
            self.path.write_bytes(b"changed during read")
            raise InvalidSourceFormatError("Could not interpret these bytes")
        with patch.object(parsing, "_parse_source_timeseries", side_effect=changed):
            with self.assertRaises(InvalidSourceFormatError):
                parsing.parse_timeseries(self.path)
        self.assertIsNone(source_readability.known_rejection(self.path))

    def test_header_hints_and_final_inspection_cannot_override_known_failure(self):
        self.reject()
        with patch.object(import_file_hints.parsing, "read_header_metadata", side_effect=AssertionError("header must not override canonical rejection")):
            hint = import_file_hints.inspect_header_hint(str(self.path))
        self.assertFalse(hint["compatible"])
        self.assertEqual(hint["source_error_kind"], "unsupported")
        with self.assertRaises(UnsupportedSourceFormatError):
            parsing.ensure_supported_source_metadata(self.path, {"technique": "GCPL"})

    def test_clean_search_page_does_not_stat_unrelated_files(self):
        with patch.object(source_readability, "file_identity", side_effect=AssertionError("unexpected stat")):
            self.assertIsNone(source_readability.known_rejection(self.path))

    def test_rejected_continuation_retains_hash_for_preview_selection_pruning(self):
        from app.routers import files

        self.reject()
        fingerprint = parsing.compute_hash(self.path)
        draft = files.ContinuationInspectSourceRequest(staged_name=self.path.name, source_path=str(self.path))
        with patch.object(files.parsing, "read_header_metadata", return_value={}):
            result = files._continuation_staged_source(draft, MagicMock(), existing_test_id=None, input_order=0)
        self.assertEqual(result["hash"], fingerprint)
        self.assertEqual(result["source_error_kind"], "unsupported")
        self.assertEqual(result["inspection_status"], "error")

    def test_rejection_storage_is_bounded(self):
        with patch.object(source_readability, "MAX_REJECTIONS", 2):
            for index in range(3):
                path = self.path.with_name(f"source-{index}.mpr")
                path.write_bytes(b"bad")
                identity = source_readability.file_identity(path)
                source_readability.remember_rejection(path, identity, InvalidSourceFormatError("bad"))
            self.assertIsNone(source_readability.known_rejection(self.path.with_name("source-0.mpr")))
            self.assertIsNotNone(source_readability.known_rejection(self.path.with_name("source-2.mpr")))


if __name__ == "__main__":
    unittest.main()
