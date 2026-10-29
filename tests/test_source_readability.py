from __future__ import annotations

from pathlib import Path
import os
import subprocess
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

    def reject(self, error=None, *, path=None):
        path = path or self.path
        error = error or UnsupportedSourceFormatError("Unsupported repeated sequence")
        with patch.object(parsing, "_parse_source_timeseries", side_effect=error):
            with self.assertRaises(type(error)):
                parsing.parse_timeseries(path)
        return source_readability.known_rejection(path)

    def make_source_alias(self):
        target_dir = Path(self.temp.name) / "target"
        target_dir.mkdir()
        target = target_dir / "source.mpr"
        target.write_bytes(b"a source")
        alias_dir = Path(self.temp.name) / "alias"
        if os.name == "nt":
            command = f'cmd.exe /d /c mklink /J "{alias_dir}" "{target_dir}"'
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True, timeout=10
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        else:
            alias_dir.symlink_to(target_dir, target_is_directory=True)
        return alias_dir / target.name, target

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

    def test_resolved_aliases_share_rejection_and_success_clears_both_spellings(self):
        alias_path, target = self.make_source_alias()
        resolved_path = target.resolve()

        rejection = self.reject(path=alias_path)
        self.assertIsNotNone(rejection)
        self.assertEqual(rejection.identity.path, source_readability._key(resolved_path))
        self.assertIs(source_readability.known_rejection(alias_path), rejection)
        self.assertIs(source_readability.known_rejection(resolved_path), rejection)

        for successful_path in (alias_path, resolved_path):
            self.reject(path=alias_path)
            with patch.object(parsing, "_parse_source_timeseries", return_value=pd.DataFrame()):
                parsing.parse_timeseries(successful_path)
            self.assertIsNone(source_readability.known_rejection(alias_path))
            self.assertIsNone(source_readability.known_rejection(resolved_path))
            self.assertNotIn(source_readability._key(alias_path), source_readability._aliases)
            self.assertNotIn(source_readability._key(resolved_path), source_readability._aliases)

    def test_success_through_new_alias_clears_canonical_rejection(self):
        alias_path, target = self.make_source_alias()
        resolved_path = target.resolve()
        rejection = self.reject(path=resolved_path)
        alias_key = source_readability._key(alias_path)
        self.assertNotIn(alias_key, source_readability._aliases)

        with patch.object(parsing, "_parse_source_timeseries", return_value=pd.DataFrame()):
            parsing.parse_timeseries(alias_path)

        self.assertIsNone(source_readability.known_rejection(alias_path))
        self.assertIsNone(source_readability.known_rejection(resolved_path))
        self.assertNotIn(rejection.identity.path, source_readability._rejections)

    def test_replacement_through_either_alias_invalidates_all_rejection_spellings(self):
        alias_path, target = self.make_source_alias()
        resolved_path = target.resolve()

        for lookup_path in (alias_path, resolved_path):
            self.reject(path=alias_path)
            previous_identity = source_readability.file_identity(alias_path)
            previous_stat = target.stat()
            replacement = target.with_name("replacement.mpr")
            replacement.write_bytes(b"b source")
            os.utime(replacement, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns))
            os.replace(replacement, target)
            self.assertNotEqual(source_readability.file_identity(alias_path), previous_identity)
            self.assertIsNone(source_readability.known_rejection(lookup_path))
            other_path = resolved_path if lookup_path == alias_path else alias_path
            self.assertIsNone(source_readability.known_rejection(other_path))
            self.assertNotIn(source_readability._key(alias_path), source_readability._aliases)
            self.assertNotIn(source_readability._key(resolved_path), source_readability._aliases)

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

    def test_empty_registry_clean_search_page_does_not_stat(self):
        with patch.object(source_readability, "file_identity", side_effect=AssertionError("unexpected stat")):
            self.assertIsNone(source_readability.known_rejection(self.path))

    def test_clean_search_page_does_not_stat_unrelated_files_with_known_rejection(self):
        self.reject()
        unrelated = self.path.with_name("unrelated-clean-row.mpr")
        unrelated.write_bytes(b"a clean source")
        with patch.object(source_readability, "file_identity", side_effect=AssertionError("unexpected stat")):
            self.assertIsNone(source_readability.known_rejection(unrelated))

    def test_rejected_continuation_retains_hash_for_preview_selection_pruning(self):
        from app.routers import files

        alias_path, target = self.make_source_alias()
        resolved_path = target.resolve()
        self.reject(path=alias_path)
        fingerprint = parsing.compute_hash(resolved_path)
        draft = files.ContinuationInspectSourceRequest(staged_name=resolved_path.name, source_path=str(resolved_path))
        with patch.object(files.parsing, "read_header_metadata", return_value={}):
            result = files._continuation_staged_source(draft, MagicMock(), existing_test_id=None, input_order=0)
        self.assertEqual(result["hash"], fingerprint)
        self.assertEqual(result["source_error_kind"], "unsupported")
        self.assertEqual(result["inspection_status"], "error")

    def test_rejection_storage_is_bounded(self):
        alias_path, target = self.make_source_alias()
        resolved_path = target.resolve()
        alias_key = source_readability._key(alias_path)
        resolved_key = source_readability._key(resolved_path)
        self.assertNotEqual(alias_key, resolved_key)
        with patch.object(source_readability, "MAX_REJECTIONS", 2):
            rejection = self.reject(path=alias_path)
            self.assertIn(alias_key, source_readability._aliases)
            self.assertIn(resolved_key, source_readability._aliases)
            for index in range(2):
                path = self.path.with_name(f"source-{index}.mpr")
                path.write_bytes(b"bad")
                identity = source_readability.file_identity(path)
                source_readability.remember_rejection(path, identity, InvalidSourceFormatError("bad"))
            self.assertIsNone(source_readability.known_rejection(alias_path))
            self.assertIsNone(source_readability.known_rejection(resolved_path))
            self.assertNotIn(alias_key, source_readability._aliases)
            self.assertNotIn(resolved_key, source_readability._aliases)
            self.assertNotIn(rejection.identity.path, source_readability._rejections)
            self.assertEqual(len(source_readability._rejections), 2)
            self.assertLessEqual(len(source_readability._aliases), 2 * source_readability.MAX_REJECTIONS)


if __name__ == "__main__":
    unittest.main()
