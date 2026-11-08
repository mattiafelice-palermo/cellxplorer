from __future__ import annotations
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault('CELLXPLORER_DATA', str(Path(__file__).resolve().parents[1]/'.test-cellxplorer'))
from backend.app.services import header_io, biologic_mpr as mpr
from backend.app.services.filesystem_cleanup import TemporaryDirectory
from tests.test_biologic_mpr import _write_fixture


class HeaderIOTests(unittest.TestCase):
    def test_real_fingerprints_and_changed_size_time(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/'control.bin'
            path.write_bytes(b'header')
            with header_io.open_header(path) as source:
                self.assertEqual(source.read(6), b'header')
                source.seek(0)
                for size in (6,31,3):
                    with path.open('r+b') as writer:
                        writer.truncate(size)
                    stamp=path.stat().st_mtime_ns+2_000_000_000
                    os.utime(path,ns=(stamp,stamp))
                    expected=os.stat(path)
                    for value in (header_io.handle_fingerprint(source.fileno()),header_io.path_fingerprint(path)):
                        self.assertEqual((value.st_size,value.st_mtime_ns),(expected.st_size,expected.st_mtime_ns))

    def test_unavailable_or_unsupported_api_uses_standard_fallback(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/'control.bin'
            path.write_bytes(b'header')
            for api in (None,Mock(fstat=Mock(side_effect=OSError('unsupported')),stat=Mock(side_effect=OSError('unsupported')))):
                with patch.object(header_io,'_api',return_value=api):
                    with header_io.open_header(path) as source:
                        self.assertEqual(header_io.handle_fingerprint(source.fileno()).st_size,6)
                    self.assertEqual(header_io.path_fingerprint(path).st_size,6)
                    with self.assertRaises(OSError):
                        header_io.path_fingerprint(path.with_name('missing'))

    def test_reparse_rejection_never_falls_back_to_following_target(self):
        api=Mock(stat=Mock(side_effect=header_io.UnsafeSourceError('reparse')))
        with patch.object(header_io,'_api',return_value=api),patch.object(header_io.os,'stat') as fallback:
            with self.assertRaises(header_io.UnsafeSourceError):
                header_io.path_fingerprint('unsafe')
            fallback.assert_not_called()

    def test_buffer_setup_error_closes_owned_descriptor(self):
        if header_io._api() is None:
            self.skipTest('Native opener requires Windows API')
        with TemporaryDirectory() as directory:
            path=Path(directory)/'control.bin'
            path.write_bytes(b'x')
            original=os.close
            with patch.object(header_io.io,'BufferedReader',side_effect=OSError('setup')),patch.object(header_io.os,'close',wraps=original) as close:
                with self.assertRaises(OSError):
                    header_io.open_header(path)
                self.assertEqual(close.call_count,1)
            path.unlink()

    def test_header_checkpoints_still_detect_timestamp_changes(self):
        for point in ('map','data'):
            with self.subTest(point=point),TemporaryDirectory() as directory:
                path=_write_fixture(Path(directory))
                original_map,original_walk=mpr.mmap.mmap,mpr._walk_modules
                def mutate():
                    stamp=path.stat().st_mtime_ns+2_000_000_000
                    os.utime(path,ns=(stamp,stamp))
                def mapping(*args,**kwargs):
                    value=original_map(*args,**kwargs)
                    mutate()
                    return value
                def walking(*args,**kwargs):
                    value=original_walk(*args,**kwargs)
                    mutate()
                    return value
                obj,name,fn=(mpr.mmap,'mmap',mapping) if point=='map' else (mpr,'_walk_modules',walking)
                with patch.object(obj,name,fn),self.assertRaisesRegex(mpr.InvalidMprError,'changed'):
                    with mpr.read_mpr_header(path):
                        pass
                path.rename(path.with_name('released.mpr'))

    def test_full_record_reader_retains_original_io(self):
        with TemporaryDirectory() as directory:
            path=_write_fixture(Path(directory))
            with patch.object(header_io,'open_header',side_effect=AssertionError('header optimization used for records')):
                with mpr.read_mpr(path) as document:
                    self.assertIsNotNone(document.vmp_data.records)

    def test_final_path_checkpoint_clears_stale_metadata(self):
        from backend.app.services import parsing
        from backend.app.services.import_search_worker import inspect_fact
        with TemporaryDirectory() as directory:
            path=Path(directory)/'source.mpr'
            path.write_bytes(b'owned source')
            initial=path.stat()
            def changed(*args,**kwargs):
                stamp=initial.st_mtime_ns+2_000_000_000
                os.utime(path,ns=(stamp,stamp))
                return dict(barcode='stale')
            with patch.object(parsing,'read_header_metadata',changed):
                value=inspect_fact(dict(path=str(path),extension='.mpr',recognition='recognized',
                    size=initial.st_size,mtime_ns=initial.st_mtime_ns),True)
            self.assertEqual(value['metadata'],{})
            self.assertEqual(value['metadata_version'],0)
            self.assertEqual(value['metadata_state'],'unavailable')

    def test_fallback_rejects_directory(self):
        with TemporaryDirectory() as directory,patch.object(header_io,'_api',return_value=None):
            with self.assertRaises(header_io.UnsafeSourceError):
                header_io.path_fingerprint(directory)


if __name__=='__main__':
    unittest.main()
