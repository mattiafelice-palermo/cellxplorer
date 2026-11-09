"""Byte preservation, all-zone Tcl behavior and generated-tree guards."""
import importlib.util
import base64
from pathlib import Path
import runpy
import shutil
from types import SimpleNamespace
import tempfile
import tkinter
import unittest
from unittest.mock import patch, MagicMock
import zlib

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'packaging' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


archive = load('tcl_timezone_archive')
probe = load('tcl_timezone_probe')


class TclArchiveTests(unittest.TestCase):
    def bundle(self, root):
        root.mkdir()
        (root / 'cellxplorer-backend.exe').write_bytes(b'fixture')
        original = Path(tkinter.Tcl().eval('info library'))
        target = root / '_internal/_tcl_data'
        target.mkdir(parents=True)
        shutil.copy2(original / 'clock.tcl', target / 'clock.tcl')
        shutil.copytree(original / 'tzdata', target / 'tzdata')
        return target

    def test_deterministic_bytes_all_zone_alias_dst_errors_and_clock_operations(self):
        expected = probe.signature()
        self.assertGreater(expected['zones'], 500)
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / 'one'
            second = Path(directory) / 'two'
            target = self.bundle(first)
            self.bundle(second)
            result = archive.pack(first)
            self.assertEqual(result, archive.pack(second))
            self.assertFalse((target / 'tzdata').exists())
            tcl = tkinter.Tcl()
            tcl.call('clock', 'format', 0, '-timezone', ':UTC')
            tcl.call('source', str(target / 'clock.tcl'))
            tcl.call('set', '::tcl::clock::DataDir', str(target / 'tzdata'))
            tcl.eval('array unset ::tcl::clock::TZData; ::tcl::clock::InitTZData')
            names = sorted(p.relative_to(Path(tkinter.Tcl().eval('info library')) / 'tzdata').as_posix() for p in (Path(tkinter.Tcl().eval('info library')) / 'tzdata').rglob('*') if p.is_file())
            self.assertEqual(expected, probe.signature(tcl, names))
            with patch.object(probe.sys, 'frozen', True, create=True):
                self.assertEqual(expected, probe.signature(tcl))
            original = Path(tkinter.Tcl().eval('info library')) / 'tzdata'
            for name in names:
                encoded = tcl.call('dict', 'get', tcl.eval('set ::tcl::clock::CellXplorerZoneScripts'), name)
                self.assertEqual(zlib.decompress(base64.b64decode(encoded)), (original / name).read_bytes())
            self.assertFalse((target / 'tzdata').exists())
            self.assertEqual(len(tcl.splitlist(tcl.eval('dict keys $::tcl::clock::CellXplorerZoneScripts'))), result['files_replaced'])

    def test_unknown_loader_keeps_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'bundle'
            target = self.bundle(root)
            (target / 'clock.tcl').write_bytes(b'unknown version')
            with self.assertRaisesRegex(ValueError, 'Unrecognised'):
                archive.pack(root)
            self.assertTrue((target / 'tzdata/UTC').is_file())
            self.assertFalse((target / 'tzdata.tcl').exists())

    def test_links_refused_before_any_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'bundle'
            target = self.bundle(root)
            for method in ('is_junction', 'is_symlink'):
                with patch.object(Path, method, return_value=True):
                    with self.assertRaisesRegex(ValueError, 'links'):
                        archive.pack(root)
            self.assertTrue((target / 'tzdata/UTC').exists())

    def test_hook_retains_native_dependency_guard_and_explicit_optional_exclusions(self):
        hook = (ROOT / 'packaging/hooks/hook-pyarrow.py').read_text()
        for name in ('arrow_flight.dll', 'arrow_python_flight.dll', 'arrow_substrait.dll', 'DIRECTORY_ENTRY_DELAY_IMPORT', 'DIRECTORY_ENTRY_IMPORT'):
            self.assertIn(name, hook)

    def test_retained_eager_or_delayed_dependency_on_removed_dll_blocks_build(self):
        from PyInstaller.utils import hooks
        import pefile
        for directory in ('DIRECTORY_ENTRY_IMPORT', 'DIRECTORY_ENTRY_DELAY_IMPORT'):
            binary = MagicMock()
            binary.__enter__.return_value = SimpleNamespace(**{directory: [SimpleNamespace(dll=b'arrow_flight.dll')]})
            with patch.object(hooks, 'collect_submodules', return_value=[]), patch.object(hooks, 'collect_data_files', return_value=[]), patch.object(hooks, 'collect_dynamic_libs', return_value=[]), patch.object(pefile, 'PE', return_value=binary):
                with self.assertRaisesRegex(RuntimeError, 'needs'):
                    runpy.run_path(str(ROOT / 'packaging/hooks/hook-pyarrow.py'))
