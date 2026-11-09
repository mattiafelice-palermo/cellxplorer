"""Archive integrity, standard resource loading and generated-tree safety."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("timezone_archive", ROOT / "packaging/timezone_archive.py")
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class TimezoneArchiveTests(unittest.TestCase):
    def bundle(self, root):
        root.mkdir()
        (root / "cellxplorer-backend.exe").write_bytes(b"owned fixture")
        for name, data in {
            "__init__.py": b'__version__ = "test"\n',
            "zoneinfo/__init__.py": b"",
            "zoneinfo/UTC": b"timezone bytes",
            "zones": b"UTC\n",
        }.items():
            path = root / "_internal/tzdata" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return root

    def test_byte_exact_deterministic_archive_removes_only_owned_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            one = self.bundle(root / "one")
            other = self.bundle(root / "two")
            unrelated = one / "_internal/keep.dat"
            unrelated.write_bytes(b"not timezone data")
            first, second = archive.pack(one), archive.pack(other)
            self.assertEqual(first["sha256"], second["sha256"])
            self.assertEqual(first["files_replaced"], 4)
            self.assertFalse((one / "_internal/tzdata").exists())
            self.assertEqual(unrelated.read_bytes(), b"not timezone data")
            with zipfile.ZipFile(first["archive"]) as z:
                self.assertEqual(z.read("tzdata/zoneinfo/UTC"), b"timezone bytes")
                self.assertEqual(z.namelist(), sorted(z.namelist()))

    def test_missing_module_or_wrong_bundle_never_removes_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.bundle(Path(directory) / "bundle")
            (root / "_internal/tzdata/__init__.py").unlink()
            with patch.object(archive.shutil, "rmtree") as remove:
                with self.assertRaisesRegex(ValueError, "Incomplete"):
                    archive.pack(root)
                remove.assert_not_called()
            (root / "cellxplorer-backend.exe").unlink()
            with self.assertRaisesRegex(ValueError, "owned"):
                archive.pack(root)

    def test_links_and_junctions_are_rejected_before_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.bundle(Path(directory) / "bundle")
            for method in ("is_symlink", "is_junction"):
                with patch.object(Path, method, return_value=True), patch.object(archive.shutil, "rmtree") as remove:
                    with self.assertRaises(ValueError):
                        archive.pack(root)
                    remove.assert_not_called()

    def test_archive_failure_keeps_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.bundle(Path(directory) / "bundle")
            with patch.object(archive.zipfile.ZipFile, "read", return_value=b"corrupted"), patch.object(archive.shutil, "rmtree") as remove:
                with self.assertRaisesRegex(ValueError, "changed resource"):
                    archive.pack(root)
                remove.assert_not_called()
            self.assertTrue((root / "_internal/tzdata/zoneinfo/UTC").is_file())
            self.assertFalse((root / "_internal/tzdata.zip").exists())

    def test_standard_zipimport_reads_resources_without_extracting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.bundle(Path(directory) / "bundle")
            result = archive.pack(root)
            code = '''import sys,json,importlib.resources
sys.path.insert(0,sys.argv[1])
import tzdata
print(json.dumps([tzdata.__version__,importlib.resources.files('tzdata.zoneinfo').joinpath('UTC').read_bytes().decode()]))
'''
            child = subprocess.run([sys.executable, "-I", "-S", "-c", code, result["archive"]], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(child.stdout), ["test", "timezone bytes"])
            self.assertFalse((root / "_internal/tzdata").exists())

    def test_runtime_hook_leaves_source_mode_untouched_and_fails_missing_frozen_archive(self):
        hook = ROOT / "packaging/runtime_timezone.py"
        original = list(sys.path)
        with patch.object(sys, "frozen", False, create=True):
            exec(hook.read_text(), {})
        self.assertEqual(sys.path, original)
        with tempfile.TemporaryDirectory() as directory, patch.object(sys, "frozen", True, create=True), patch.object(sys, "_MEIPASS", directory, create=True):
            with self.assertRaisesRegex(RuntimeError, "missing"):
                exec(hook.read_text(), {})
        self.assertEqual(sys.path, original)

    def test_bundle_audit_rejects_loose_duplicate_or_missing_archive(self):
        from scripts.audit_backend_bundle import validate
        paths = ["cellxplorer-backend.exe", "_internal/app/assets/plotly.min.js", "_internal/_tkinter.pyd", "_internal/tzdata.zip"]
        report = dict(files=len(paths), components={p: {} for p in ["pyarrow", "numpy", "pandas", "tzdata.zip"]}, inventory=[dict(path=p) for p in paths])
        validate(report)
        report['inventory'].append(dict(path="_internal/tzdata/zoneinfo/UTC"))
        with self.assertRaisesRegex(ValueError, "Loose timezone"):
            validate(report)

    def test_build_hook_keeps_tzdata_outside_pyz_and_preserves_metadata(self):
        hook = (ROOT / "packaging/hooks/hook-tzdata.py").read_text()
        self.assertIn('module_collection_mode = "py"', hook)
        self.assertIn('copy_metadata("tzdata")', hook)
        self.assertIn('collect_submodules("tzdata")', hook)

    def test_source_timezone_signature_covers_all_zones_dst_and_fold(self):
        spec = importlib.util.spec_from_file_location("runtime_timezone_test", ROOT / "packaging/runtime_smoke.py")
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        signature = smoke.timezone_signature()
        self.assertGreaterEqual(signature["zones"], 500)
        self.assertEqual(signature["fold_offsets"], [7200, 3600])
        self.assertEqual(len(signature["sha256"]), 64)

