import ctypes
import os
from pathlib import Path
import shutil
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend.app.services import filesystem_cleanup as cleanup


@unittest.skipUnless(os.name == "nt", "Windows cleanup behavior")
class WindowsCleanupTests(unittest.TestCase):
    def test_copied_readonly_directory_is_removed_without_changing_source(self):
        with cleanup.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            (source / "value.txt").write_text("retained")
            os.chmod(source, stat.S_IREAD)
            target = Path(directory) / "copy"
            shutil.copytree(source, target)
            self.assertFalse(target.stat().st_mode & stat.S_IWRITE)
            cleanup.remove_tree(target)
            self.assertFalse(target.exists())
            self.assertEqual((source / "value.txt").read_text(), "retained")
            self.assertFalse(source.stat().st_mode & stat.S_IWRITE)

    def test_transient_delete_error_retries_with_one_deadline(self):
        clock = [100.0]
        error = ctypes.WinError(145)
        def sleep(seconds): clock[0] += seconds
        with patch.object(cleanup.shutil, "rmtree", side_effect=[error, error, None]) as remove, patch.object(cleanup.time, "monotonic", side_effect=lambda: clock[0]), patch.object(cleanup.time, "sleep", side_effect=sleep):
            cleanup.remove_tree("disposable-test-tree", timeout=.1)
        self.assertEqual(remove.call_count, 3)
        self.assertLessEqual(clock[0], 100.1)

    def test_persistent_denial_still_raises(self):
        clock = [100.0]
        error = ctypes.WinError(5)
        def sleep(seconds): clock[0] += seconds
        with patch.object(cleanup.shutil, "rmtree", side_effect=error), patch.object(cleanup.time, "monotonic", side_effect=lambda: clock[0]), patch.object(cleanup.time, "sleep", side_effect=sleep):
            with self.assertRaises(PermissionError) as caught:
                cleanup.remove_tree("disposable-test-tree", timeout=.05)
        self.assertIs(caught.exception, error)
        self.assertAlmostEqual(clock[0], 100.05)

    def test_unrelated_io_error_is_not_retried(self):
        error = ctypes.WinError(1117)
        with patch.object(cleanup.shutil, "rmtree", side_effect=error) as remove:
            with self.assertRaises(OSError) as caught:
                cleanup.remove_tree("disposable-test-tree")
        self.assertIs(caught.exception, error)
        self.assertEqual(remove.call_count, 1)

    def test_readonly_reparse_point_is_never_chmodded(self):
        target = os.path.abspath("disposable-test-tree")
        error = ctypes.WinError(5)
        def remove(path, *, onexc): onexc(os.rmdir, path, error)
        info = SimpleNamespace(st_mode=stat.S_IFDIR | stat.S_IREAD, st_file_attributes=stat.FILE_ATTRIBUTE_READONLY | stat.FILE_ATTRIBUTE_REPARSE_POINT)
        with patch.object(cleanup.shutil, "rmtree", side_effect=remove), patch.object(cleanup.os, "lstat", return_value=info), patch.object(cleanup.os, "chmod") as chmod:
            with self.assertRaises(PermissionError): cleanup.remove_tree(target, timeout=0)
        chmod.assert_not_called()

    def test_missing_tree_is_already_clean(self):
        with cleanup.TemporaryDirectory() as directory:
            cleanup.remove_tree(Path(directory) / "absent")
            self.assertTrue(Path(directory).exists())

    def test_filesystem_root_is_refused(self):
        with patch.object(cleanup.shutil, "rmtree") as remove:
            with self.assertRaises(ValueError): cleanup.remove_tree(Path.cwd().anchor)
        remove.assert_not_called()
