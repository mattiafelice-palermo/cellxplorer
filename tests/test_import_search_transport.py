from backend.app.services.filesystem_cleanup import TemporaryDirectory
import json
import queue
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app.services import import_search_transport as transport


class Clock:
    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class BatchSpoolAccessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.spool = transport.BatchSpool(str(self.directory))
        self.first = self.directory / '000000000000.json'
        self.clock = Clock()
        monotonic = patch.object(transport.time, 'monotonic', self.clock.monotonic)
        sleep = patch.object(transport.time, 'sleep', self.clock.sleep)
        monotonic.start()
        sleep.start()
        self.addCleanup(monotonic.stop)
        self.addCleanup(sleep.stop)

    def test_directory_enumeration_denial_is_not_an_empty_spool(self):
        self.spool.put({"kind": "final"})
        original = Path.iterdir
        calls = []
        def enumerate_directory(path):
            calls.append(path)
            if len(calls) == 1:
                raise PermissionError("directory enumeration temporarily denied")
            return original(path)
        with patch.object(Path, "iterdir", enumerate_directory):
            self.assertEqual(self.spool.get(0.1), {"kind": "final"})
        self.assertEqual(len(calls), 2)
        self.spool.put({"kind": "next"})
        with patch.object(Path, "iterdir", side_effect=PermissionError("directory denied")):
            with self.assertRaises(PermissionError):
                self.spool.get(0.05)
        self.assertEqual(self.spool.get(0), {"kind": "next"})

    def test_producer_retries_directory_enumeration_within_publish_budget(self):
        original = Path.iterdir
        attempts = []
        def enumerate_directory(path):
            attempts.append(path)
            if len(attempts) == 1:
                raise PermissionError("temporary directory denial")
            return original(path)
        with patch.object(Path, "iterdir", enumerate_directory):
            self.spool.put({"kind": "complete"})
        self.assertEqual(attempts, [self.directory, self.directory])
        self.assertEqual(self.spool.sequence, 1)
        self.assertEqual(self.spool.get(0), {"kind": "complete"})

    def test_transient_read_lock_preserves_fifo_and_delivers_once(self):
        self.spool.put({'kind': 'first'})
        self.spool.put({'kind': 'second'})
        original = Path.read_text
        calls = []

        def read(path, *args, **kwargs):
            calls.append(path)
            if len(calls) == 1:
                raise PermissionError('temporary read lock')
            return original(path, *args, **kwargs)

        with patch.object(Path, 'read_text', autospec=True, side_effect=read):
            self.assertEqual(self.spool.get(0.1), {'kind': 'first'})
        self.assertEqual(calls, [self.first, self.first])
        self.assertFalse(self.first.exists())
        self.assertEqual(self.spool.get(0.1), {'kind': 'second'})
        with self.assertRaises(queue.Empty):
            self.spool.get(0)
        self.assertEqual(self.clock.sleeps, [0.01])

    def test_transient_publish_lock_retries_same_complete_frame_once_without_rewrite(self):
        original = transport.os.replace
        calls = []
        def replace(source, destination):
            calls.append((source, destination))
            self.assertEqual(json.loads(source.read_text()), {"kind": "first"})
            self.assertFalse(destination.exists())
            if len(calls) == 1:
                raise PermissionError("temporary sharing lock")
            return original(source, destination)
        # Capture the real writer outside the mock, then check exactly one write.
        original_write = Path.write_text
        with patch.object(transport.os, "replace", side_effect=replace), \
             patch.object(Path, "write_text", autospec=True, side_effect=original_write) as write:
            self.spool.put({"kind": "first"})
            self.assertEqual(write.call_count, 1)
        self.assertEqual(calls, [(self.first.with_suffix('.tmp'), self.first)] * 2)
        self.assertEqual(self.spool.sequence, 1)
        self.assertEqual(self.spool.get(0), {"kind": "first"})
        self.spool.put({"kind": "second"})
        self.assertEqual(self.spool.get(0), {"kind": "second"})
        with self.assertRaises(queue.Empty):
            self.spool.get(0)

    def test_persistent_publish_lock_preserves_error_frame_and_fixed_budget(self):
        failure = PermissionError("still locked")
        start = self.clock.now
        with patch.object(transport.os, "replace", side_effect=failure):
            with self.assertRaises(PermissionError) as caught:
                self.spool.put({"kind": "retained"})
        self.assertIs(caught.exception, failure)
        self.assertAlmostEqual(self.clock.now - start, transport.PUBLISH_RETRY_SECONDS)
        self.assertEqual(self.spool.sequence, 0)
        self.assertFalse(self.first.exists())
        self.assertEqual(json.loads(self.first.with_suffix('.tmp').read_text()), {"kind": "retained"})

    def test_non_permission_publish_error_is_not_retried(self):
        failure = OSError("not a sharing lock")
        with patch.object(transport.os, "replace", side_effect=failure) as replace:
            with self.assertRaises(OSError) as caught:
                self.spool.put({"kind": "retained"})
        self.assertIs(caught.exception, failure)
        self.assertEqual(replace.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_transient_unlink_lock_retries_ack_without_rereading_message(self):
        self.spool.put({'kind': 'done'})
        original_read, original_unlink = Path.read_text, Path.unlink
        attempts = []

        def unlink(path, *args, **kwargs):
            attempts.append(path)
            if len(attempts) < 3:
                raise PermissionError('temporary acknowledgement lock')
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, 'read_text', autospec=True, side_effect=original_read) as read, patch.object(Path, 'unlink', autospec=True, side_effect=unlink):
            self.assertEqual(self.spool.get(0.1), {'kind': 'done'})
            self.assertEqual(read.call_count, 1)
        self.assertEqual(attempts, [self.first] * 3)
        self.assertFalse(self.first.exists())

    def test_persistent_read_or_unlink_error_is_preserved_and_batch_remains(self):
        for method in ('read_text', 'unlink'):
            with self.subTest(method=method):
                self.first.write_text('{"kind":"retained"}', encoding='utf-8')
                failure = PermissionError('persistent access denied')
                start = self.clock.now
                with patch.object(Path, method, side_effect=failure) as operation:
                    with self.assertRaises(PermissionError) as caught:
                        self.spool.get(0.025)
                self.assertIs(caught.exception, failure)
                self.assertEqual(operation.call_count, 3)
                self.assertAlmostEqual(self.clock.now - start, 0.025)
                self.assertTrue(self.first.exists())
                self.assertEqual(self.spool.get(0), {'kind': 'retained'})

    def test_read_and_ack_share_one_deadline_including_initial_empty_poll(self):
        original_read = Path.read_text
        reads = []
        error = PermissionError('ack still locked')
        original_sleep = self.clock.sleep

        def sleep(seconds):
            original_sleep(seconds)
            if not self.first.exists():
                self.spool.put({'kind': 'delayed'})

        def read(path, *args, **kwargs):
            reads.append(path)
            if len(reads) == 1:
                raise PermissionError('read briefly locked')
            return original_read(path, *args, **kwargs)

        with patch.object(transport.time, 'sleep', sleep), patch.object(Path, 'read_text', autospec=True, side_effect=read), patch.object(Path, 'unlink', side_effect=error):
            with self.assertRaises(PermissionError) as caught:
                self.spool.get(0.025)
        self.assertIs(caught.exception, error)
        self.assertAlmostEqual(self.clock.now, 100.025)
        self.assertEqual(reads, [self.first, self.first])
        self.assertTrue(self.first.exists())

    def test_zero_timeout_attempts_once_without_sleep_or_consumption(self):
        self.spool.put({'kind': 'retained'})
        for method in ('read_text', 'unlink'):
            with self.subTest(method=method), patch.object(Path, method, side_effect=PermissionError('locked')) as operation:
                with self.assertRaises(PermissionError):
                    self.spool.get(0)
                self.assertEqual(operation.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])
        self.assertTrue(self.first.exists())

    def test_access_lock_across_polls_does_not_reset_watchdog_or_skip_fifo(self):
        self.spool.put({"kind": "first"})
        self.spool.put({"kind": "second"})
        original = Path.read_text
        start = self.clock.now
        def read(path, *args, **kwargs):
            if self.clock.now - start < 0.25:
                raise PermissionError("longer than one poll")
            return original(path, *args, **kwargs)
        with patch.object(Path, "read_text", autospec=True, side_effect=read):
            for _ in range(2):
                with self.assertRaises(queue.Empty) as caught:
                    transport.receive(self.spool, last_message=start, silence_timeout=1)
                self.assertIsInstance(caught.exception.__cause__, PermissionError)
            self.assertEqual(transport.receive(self.spool, last_message=start, silence_timeout=1), {"kind": "first"})
        self.assertEqual(self.spool.get(0), {"kind": "second"})
        self.assertLess(self.clock.now - start, 1)

    def test_access_lock_exhausts_original_silence_budget(self):
        self.spool.put({"kind": "first"})
        start = self.clock.now
        with patch.object(Path, "read_text", side_effect=PermissionError("locked")):
            with self.assertRaises(queue.Empty):
                transport.receive(self.spool, last_message=start, silence_timeout=0.15)
            with self.assertRaises(PermissionError):
                transport.receive(self.spool, last_message=start, silence_timeout=0.15)
        self.assertTrue(self.first.exists())
        self.assertLessEqual(self.clock.now - start, 0.21)

    def test_publish_lock_longer_than_original_poll_budget(self):
        start = self.clock.now
        original = transport.os.replace
        def replace(source, destination):
            if self.clock.now - start < 0.3:
                raise PermissionError("locked")
            return original(source, destination)
        with patch.object(transport.os, "replace", side_effect=replace):
            self.spool.put({"kind": "done"})
        self.assertEqual(self.spool.get(0), {"kind": "done"})

    def test_cleanup_failure_does_not_invalidate_published_scan(self):
        temporary = TemporaryDirectory()
        real_cleanup = temporary.cleanup
        try:
            with patch.object(transport.tempfile, "TemporaryDirectory", return_value=temporary), patch.object(temporary, "cleanup", side_effect=OSError("busy")):
                with transport.scan_spool("test-") as directory:
                    self.assertEqual(directory, temporary.name)
        finally:
            real_cleanup()

    def test_unlink_lock_across_polls_does_not_reparse_or_deliver_twice(self):
        self.spool.put({"kind": "done"})
        original_read = Path.read_text
        with patch.object(Path, "read_text", autospec=True, side_effect=original_read) as read:
            with patch.object(Path, "unlink", side_effect=PermissionError("locked")):
                with self.assertRaises(queue.Empty):
                    transport.receive(self.spool, last_message=self.clock.now, silence_timeout=1)
            self.assertEqual(self.spool.get(0), {"kind": "done"})
            self.assertEqual(read.call_count, 1)
        with self.assertRaises(queue.Empty):
            self.spool.get(0)

    def test_corrupt_json_and_other_io_errors_are_not_retried(self):
        self.first.write_text('invalid JSON', encoding='utf-8')
        with self.assertRaises(json.JSONDecodeError):
            self.spool.get(0.1)
        self.assertTrue(self.first.exists())
        failure = OSError('not a permission/sharing failure')
        with patch.object(Path, 'read_text', side_effect=failure) as read:
            with self.assertRaises(OSError) as caught:
                self.spool.get(0.1)
            self.assertIs(caught.exception, failure)
            self.assertEqual(read.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])


if __name__ == '__main__':
    unittest.main()
