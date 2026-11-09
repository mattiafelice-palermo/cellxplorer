"""Byte preservation, all-zone Tcl behavior and generated-tree guards."""
import importlib.util
import base64
import hashlib
import json
from pathlib import Path
import runpy
import shutil
from types import SimpleNamespace
import sys
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
        if str(original).replace('\\', '/').startswith('//zipfs:'):
            # The active Tcl 9 runtime already embeds its resources. Exercise the
            # custom packer's mechanics with an explicitly synthetic loader;
            # real Tcl 8 all-zone parity runs on hosts that ship that layout.
            fixture = b'proc ::tcl::clock::LoadTimeZoneFile { fileName } {\n    variable DataDir\n    variable TZData\n    source -encoding utf-8 [file join $DataDir $fileName]\n}\n'
            (target / 'clock.tcl').write_bytes(fixture)
            fingerprint = patch.object(archive, 'LOADER_SHA256', hashlib.sha256(fixture).hexdigest())
            fingerprint.start()
            self.addCleanup(fingerprint.stop)
            for name, script in {'UTC': 'set TZData(:UTC) fixture', 'Europe/Paris': 'set TZData(:Europe/Paris) fixture', 'US/Eastern': 'LoadTimeZoneFile Europe/Paris; set TZData(:US/Eastern) $TZData(:Europe/Paris)'}.items():
                path = target / 'tzdata' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(script, encoding='utf-8')
        else:
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
            original_resources = {p.relative_to(target / 'tzdata').as_posix(): p.read_bytes() for p in (target / 'tzdata').rglob('*') if p.is_file()}
            result = archive.pack(first)
            self.assertEqual(result, archive.pack(second))
            self.assertFalse((target / 'tzdata').exists())
            tcl = tkinter.Tcl()
            tcl.call('clock', 'format', 0, '-timezone', ':UTC')
            tcl.call('source', str(target / 'clock.tcl'))
            tcl.call('set', '::tcl::clock::DataDir', str(target / 'tzdata'))
            if tcl.eval('info library').startswith('//zipfs:/'):
                tcl.call('::tcl::clock::LoadTimeZoneFile', 'US/Eastern')
                self.assertEqual(tcl.eval('set ::tcl::clock::TZData(:US/Eastern)'), 'fixture')
                for name, data in original_resources.items():
                    encoded = tcl.call('dict', 'get', tcl.eval('set ::tcl::clock::CellXplorerZoneScripts'), name)
                    self.assertEqual(zlib.decompress(base64.b64decode(encoded)), data)
                return
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
        # Preflight installs runtime requirements, not PyInstaller or pefile.
        hooks = SimpleNamespace(collect_submodules=lambda *a, **k: [], collect_data_files=lambda *a, **k: [], collect_dynamic_libs=lambda *a, **k: [])
        with tempfile.TemporaryDirectory() as directory:
            native = Path(directory) / 'retained.pyd'
            native.write_bytes(b'synthetic PE stand-in')
            for imports in ('DIRECTORY_ENTRY_IMPORT', 'DIRECTORY_ENTRY_DELAY_IMPORT'):
                binary = MagicMock()
                binary.__enter__.return_value = SimpleNamespace(**{imports: [SimpleNamespace(dll=b'arrow_flight.dll')]})
                modules = {'PyInstaller.utils.hooks': hooks, 'pefile': SimpleNamespace(PE=lambda *a: binary), 'pyarrow': SimpleNamespace(__file__=str(Path(directory) / '__init__.py'))}
                with patch.dict(sys.modules, modules), self.assertRaisesRegex(RuntimeError, 'needs'):
                    runpy.run_path(str(ROOT / 'packaging/hooks/hook-pyarrow.py'))

    def test_embedded_layout_retains_identical_libraries_and_requires_proof(self):
        from scripts.audit_backend_bundle import inventory, validate
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / 'bundle'
            internal = bundle / '_internal'
            internal.mkdir(parents=True)
            (bundle / 'cellxplorer-backend.exe').write_bytes(b'fixture')
            sources = []
            for name in ('tcl90.dll', 'tcl9tk90.dll'):
                source = root / name
                source.write_bytes(b'embedded fixture ' + name.encode())
                shutil.copy2(source, internal / name)
                sources.append(source)
            info = SimpleNamespace(available=True, tcl_data_dir='//zipfs:/lib/tcl', tk_data_dir='//zipfs:/lib/tk/tk_library', tcl_shared_library=str(sources[0]), tk_shared_library=str(sources[1]))
            with patch.dict(sys.modules, {'PyInstaller.utils.hooks.tcl_tk': SimpleNamespace(tcltk_info=info)}):
                result = archive.pack(bundle)
                self.assertEqual(result['mode'], 'embedded-zipfs')
                self.assertEqual(json.loads((internal / 'tcl-resources.json').read_text()), result)
                for name in ('tzdata.zip', '_tkinter.pyd', 'pyarrow/lib.pyd', 'numpy/lib.pyd', 'pandas/lib.pyd', 'app/assets/plotly.min.js'):
                    path = internal / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b'required fixture')
                validate(inventory(bundle))
                (internal / 'tcl90.dll').write_bytes(b'different')
                with self.assertRaisesRegex(ValueError, 'does not match'):
                    validate(inventory(bundle))
