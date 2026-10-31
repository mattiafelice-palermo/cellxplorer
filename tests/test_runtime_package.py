"""Packaging inventory and explicit scientific verification safety contracts."""
from __future__ import annotations

import hashlib
import json
import shlex
import tomllib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import sys

from scripts.audit_backend_bundle import inventory, validate

ROOT = Path(__file__).resolve().parents[1]


class RuntimePackageTests(unittest.TestCase):
    def test_rust_release_changes_only_local_lto_not_safety_or_optimization_policy(self):
        manifest=tomllib.loads((ROOT/'src-tauri/Cargo.toml').read_text())
        release=manifest['profile']['release']
        self.assertEqual(release['lto'],'off')
        self.assertTrue(release['incremental'])
        self.assertEqual(release.get('opt-level',3),3)
        for key in ('panic','debug-assertions','overflow-checks','codegen-units'):
            self.assertNotIn(key,release)

    def test_build_tool_exclusions_preserve_runtime_and_existing_build_flags(self):
        command = json.loads((ROOT / "package.json").read_text())["scripts"]["build:backend"]
        argv = shlex.split(command)
        excluded = {argv[i+1] for i,value in enumerate(argv) if value == "--exclude-module"}
        self.assertTrue({"setuptools","distutils","_distutils_hack"}.issubset(excluded))
        self.assertTrue(excluded.isdisjoint({"app","numpy","pandas","pyarrow","NewareNDA","alembic","sqlalchemy","tkinter","tzdata"}))
        self.assertIn("--onedir",argv)
        self.assertNotIn("--optimize",argv)
        self.assertEqual(argv[-1],"packaging/backend_entry.py")

    def _bundle(self, root: Path) -> None:
        for name in ["cellxplorer-backend.exe", "_internal/app/assets/plotly.min.js", "_internal/_tkinter.pyd",
                     "_internal/pyarrow/lib.pyd", "_internal/pyarrow/arrow.dll", "_internal/numpy/native.pyd",
                     "_internal/pandas/native.pyd", "_internal/tzdata/zoneinfo/Atlantic/Canary"]:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"test fixture")

    def test_inventory_is_complete_deterministic_and_runtime_libraries_are_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._bundle(root)
            report = inventory(root)
            validate(report)
            self.assertEqual(report, inventory(root))
            self.assertEqual(report["files"], 8)
            self.assertEqual(report["bytes"], 8 * len(b"test fixture"))
            self.assertEqual(report["inventory"][0]["sha256"], hashlib.sha256(b"test fixture").hexdigest())

    def test_sdk_and_accidental_optional_dependencies_are_rejected(self):
        for unwanted in ["_internal/pyarrow/libarrow.lib", "_internal/pyarrow/include/arrow.h", "_internal/pyarrow/tests/data/sample.parquet", "_internal/scipy/native.pyd",
                         "_internal/setuptools/build.py", "_internal/distutils/compiler.py", "_internal/_distutils_hack/__init__.py"]:
            with self.subTest(unwanted=unwanted), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self._bundle(root)
                path = root / unwanted
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"unexpected payload")
                with self.assertRaises(ValueError):
                    validate(inventory(root))

    def test_missing_picker_or_portable_asset_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._bundle(root)
            (root / "_internal/_tkinter.pyd").unlink()
            with self.assertRaisesRegex(ValueError, "_tkinter"):
                validate(inventory(root))

    def test_runtime_verification_refuses_a_non_disposable_data_root_before_import(self):
        spec = importlib.util.spec_from_file_location("runtime_smoke_guard", ROOT / "packaging/runtime_smoke.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with mock.patch.dict(os.environ, {"CELLXPLORER_DATA": str(ROOT / "not-a-disposable-smoke-root")}):
            with self.assertRaisesRegex(ValueError, "disposable"):
                module.verify()

    def test_entry_point_rejects_missing_or_invalid_smoke_root_without_logging(self):
        spec = importlib.util.spec_from_file_location("runtime_smoke", ROOT / "packaging/runtime_smoke.py")
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        entry_spec = importlib.util.spec_from_file_location("backend_entry_guard", ROOT / "packaging/backend_entry.py")
        entry = importlib.util.module_from_spec(entry_spec)
        entry_spec.loader.exec_module(entry)
        for root in [None, str(ROOT / "not-a-smoke-root")]:
            with self.subTest(root=root), mock.patch.dict(sys.modules, {"runtime_smoke": smoke}), mock.patch.dict(os.environ, {"CELLXPLORER_BACKEND_SMOKE": "scientific"}):
                if root is None:
                    os.environ.pop("CELLXPLORER_DATA", None)
                else:
                    os.environ["CELLXPLORER_DATA"] = root
                with mock.patch.object(entry, "_configure_logging") as logging, mock.patch.object(entry, "_write_crash_log") as crash:
                    self.assertEqual(entry.main(), 2)
                    logging.assert_not_called()
                    crash.assert_not_called()

    def test_lossless_runtime_signature_detects_dtype_tiny_float_and_nonfinite_changes(self):
        import pandas as pd
        import numpy as np
        spec = importlib.util.spec_from_file_location("runtime_smoke_signature", ROOT / "packaging/runtime_smoke.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        integer32 = pd.DataFrame({"x": pd.Series([1, 2], dtype="int32")})
        integer64 = integer32.astype("int64")
        self.assertNotEqual(module.frame_signature(integer32), module.frame_signature(integer64))
        one = pd.DataFrame({"x": [1.0]})
        tiny = pd.DataFrame({"x": [np.nextafter(1.0, 2.0)]})
        self.assertNotEqual(module.frame_signature(one), module.frame_signature(tiny))
        self.assertNotEqual(module.frame_signature(pd.DataFrame({"x": [np.nan]})), module.frame_signature(pd.DataFrame({"x": [np.inf]})))

    def test_pyarrow_hook_drops_only_development_data_and_keeps_all_dynamic_libraries(self):
        source = (ROOT / "packaging/hooks/hook-pyarrow.py").read_text(encoding="utf-8")
        self.assertIn('binaries = collect_dynamic_libs("pyarrow")', source)
        self.assertIn('collect_submodules("pyarrow"', source)
        for pattern in ['"include/**"', '"tests/**"', '"**/*.lib"', '"**/*.pyx"']:
            self.assertIn(pattern, source)
        self.assertNotIn('"**/*.dll"', source)
        self.assertNotIn('"**/*.pyd"', source)


if __name__ == "__main__":
    unittest.main()
