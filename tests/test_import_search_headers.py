from __future__ import annotations

import multiprocessing
import os
from pathlib import Path
import queue
import threading
import time
import unittest
from unittest.mock import patch, Mock

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
from backend.app.services.import_search_headers import read_headers
from backend.app.services import import_search_headers as headers
from backend.app.services.import_search_transport import BatchSpool
from backend.app.services.filesystem_cleanup import TemporaryDirectory
from backend.app.services.import_search_catalog import Catalog, METADATA_VERSION
from backend.app.services.import_search_index import SearchIndexer


def controlled_reader(incoming, outgoing, metadata_enabled):
    requests, results = BatchSpool(incoming), BatchSpool(outgoing)
    while True:
        try:
            fact = requests.get(timeout=0.1)["fact"]
        except queue.Empty:
            continue
        results.put(dict(kind="started", canonical=fact["canonical"]))
        if fact["canonical"] == "crash":
            os._exit(9)
        if fact["canonical"] == "stall":
            while True:
                time.sleep(1)
        time.sleep(0.025)
        results.put(dict(kind="result", fact=dict(fact, metadata_state="ready", metadata={"barcode": fact["canonical"]},
            metadata_version=METADATA_VERSION, reader_pid=os.getpid())))


def one_shot_reader(incoming, outgoing, metadata_enabled):
    requests, results = BatchSpool(incoming), BatchSpool(outgoing)
    while True:
        try:
            fact = requests.get(timeout=0.1)["fact"]
            break
        except queue.Empty:
            continue
    results.put(dict(kind="started", canonical=fact["canonical"]))
    results.put(dict(kind="result", fact=dict(fact, metadata_state="ready", metadata={})))
    os._exit(0)


class ParallelHeaderTests(unittest.TestCase):
    def test_healthy_lane_takes_pending_fact_when_retired_slot_is_unavailable(self):
        capacity = threading.BoundedSemaphore(2)
        original_stop = headers._stop_lane
        held = []
        # Exercise scheduler fairness with virtual time. OS spawn/import latency
        # must not consume this fixture's deliberately short two-second budget.
        class Clock:
            now = 0.0
            def monotonic(self):
                return self.now
            def sleep(self, delay):
                self.now += delay
        clock = Clock()
        channels = {}
        class Process:
            pid = 42
            alive = False
            exitcode = None
            def start(self):
                self.alive = True
            def is_alive(self):
                return self.alive
            def terminate(self):
                self.alive = False
            kill = terminate
            def join(self, timeout):
                pass
            def close(self):
                pass
        class Requests:
            def __init__(self, channel):
                self.channel = channel
            def put(self, message, **kwargs):
                self.channel.update(fact=message['fact'], announced=False, due=clock.now + .05)
        class Results:
            def __init__(self, channel):
                self.channel = channel
            def get(self, timeout):
                fact = self.channel.get('fact')
                if fact is None:
                    raise queue.Empty
                if not self.channel['announced']:
                    self.channel['announced'] = True
                    return dict(kind='started', canonical=fact['canonical'])
                if fact['canonical'] == 'stall' or clock.now < self.channel['due']:
                    raise queue.Empty
                self.channel.pop('fact')
                return dict(kind='result', fact=dict(fact, metadata_state='ready', metadata={}))
        def spool(directory):
            channel = channels.setdefault(str(Path(directory).parent), {})
            return Requests(channel) if Path(directory).name == 'in' else Results(channel)
        context = Mock()
        context.Process.side_effect = lambda **kwargs: Process()
        def stop(lane):
            original_stop(lane)
            if lane["fact"]["canonical"] == "stall" and not held:
                self.assertTrue(capacity.acquire(blocking=False))
                held.append(True)  # Simulate capacity retained by delayed OS exit.
        try:
            with patch.object(headers, "_slots", capacity), patch.object(headers, "_stop_lane", stop), \
                 patch.object(headers, 'time', clock), \
                 patch.object(headers.multiprocessing, 'get_context', return_value=context), \
                 patch.object(headers, 'BatchSpool', side_effect=spool):
                results = list(self.outcomes(["stall", *map(str, range(180))], timeout=2))
        finally:
            if held:
                capacity.release()
        self.assertEqual(len(results), 181)
        self.assertEqual(sum(r["metadata_state"] == "unavailable" for r in results), 1)
        self.assertEqual(len({r["canonical"] for r in results}), 181)

    def test_delayed_windows_exit_retains_capacity_and_does_not_abandon_siblings(self):
        exited = threading.Event()
        class DelayedProcess:
            def __init__(self):
                self.close_count = 0
            def is_alive(self):
                return not exited.is_set()
            def terminate(self):
                pass
            def kill(self):
                pass
            def join(self, timeout):
                exited.wait(timeout)
            def close(self):
                if self.is_alive():
                    raise ValueError("Cannot close a process while it is still running")
                self.close_count += 1
        process = DelayedProcess()
        slow = dict(process=process, resources=Mock())
        sibling = dict(process=Mock(), resources=Mock())
        sibling["process"].is_alive.return_value = False
        capacity = threading.BoundedSemaphore(4)
        capacity.acquire()
        capacity.acquire()
        with patch.object(headers, "_slots", capacity):
            try:
                headers._stop_lane(slow)
                headers._stop_lane(sibling)
                sibling["resources"].close.assert_called_once()
                slow["resources"].close.assert_not_called()
                self.assertIn(id(slow), headers._retiring)
                self.assertEqual(process.close_count, 0)
                # Exactly one live delayed process still owns a slot.
                acquired = sum(capacity.acquire(blocking=False) for _ in range(4))
                self.assertEqual(acquired, 3)
                for _ in range(acquired):
                    capacity.release()
            finally:
                exited.set()
                deadline = time.monotonic() + 3
                while id(slow) in headers._retiring and time.monotonic() < deadline:
                    time.sleep(.01)
            self.assertNotIn(id(slow), headers._retiring)
            slow["resources"].close.assert_called_once()
            self.assertEqual(process.close_count, 1)
            self.assertEqual(sum(capacity.acquire(blocking=False) for _ in range(5)), 4)

    def test_reader_exit_after_success_never_blames_the_next_unstarted_file(self):
        results = list(read_headers((dict(canonical=str(n)) for n in range(7)), readers=2,
            metadata_enabled=True, timeout=10, cancelled=lambda: False, reader=one_shot_reader))
        self.assertEqual(sorted(r["canonical"] for r in results), list(map(str, range(7))))
        self.assertTrue(all(r["metadata_state"] == "ready" for r in results))

    def test_input_spool_lock_does_not_block_cancellation(self):
        original = BatchSpool.put
        def put(spool, message, **kwargs):
            if spool.directory.name == "in":
                raise PermissionError("temporary input lock")
            return original(spool, message, **kwargs)
        cancel = threading.Event()
        timer = threading.Timer(0.5, cancel.set)
        timer.start()
        began = time.monotonic()
        try:
            with patch.object(BatchSpool, "put", put):
                self.assertEqual(list(self.outcomes(["a", "b"], cancelled=cancel.is_set)), [])
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - began, 2)

    def test_exited_reader_drains_final_frame_and_retries_temporary_access_lock(self):
        for locked in (False, True):
            with self.subTest(locked=locked):
                fact = dict(canonical="a", metadata_state="ready", metadata={})
                message = dict(kind="result", fact=fact)
                requests, results = Mock(), Mock()
                results.get.side_effect = ([PermissionError(), PermissionError()] if locked else []) + [queue.Empty(), message]
                process = Mock()
                process.is_alive.return_value = False
                context = Mock()
                context.Process.return_value = process
                with patch("backend.app.services.import_search_headers.multiprocessing.get_context", return_value=context), \
                     patch("backend.app.services.import_search_headers.BatchSpool", side_effect=[requests, results]):
                    actual = list(read_headers([fact], readers=1, metadata_enabled=True, timeout=1, cancelled=lambda: False))
                self.assertEqual(actual, [fact])
                self.assertEqual(results.get.call_count, 4 if locked else 2)

    def outcomes(self, names, **kwargs):
        return read_headers((dict(canonical=n, metadata_state="pending", metadata={"old": "stale"}) for n in names),
            readers=kwargs.pop("readers", 2), metadata_enabled=True, timeout=kwargs.pop("timeout", 5),
            cancelled=kwargs.pop("cancelled", lambda: False), reader=controlled_reader, **kwargs)

    def test_out_of_order_results_exactly_once_and_persistent_bounded_readers(self):
        results = list(self.outcomes([str(n) for n in range(24)]))
        self.assertEqual(sorted(r["canonical"] for r in results), sorted(str(n) for n in range(24)))
        self.assertEqual(len({r["reader_pid"] for r in results}), 2)
        self.assertTrue(all(r["metadata"] == {"barcode": r["canonical"]} for r in results))

    def test_crash_marks_only_its_fact_and_later_files_finish(self):
        results = list(self.outcomes(["crash", "a", "b", "c", "d"]))
        states = {r["canonical"]: r["metadata_state"] for r in results}
        self.assertEqual(states, dict(crash="unavailable", a="ready", b="ready", c="ready", d="ready"))
        failed = next(r for r in results if r["canonical"] == "crash")
        self.assertEqual(failed["metadata"], {})
        self.assertEqual(failed["metadata_version"], 0)

    def test_sibling_completions_do_not_renew_stalled_lane_deadline(self):
        began = time.monotonic()
        results = list(self.outcomes(["stall", *map(str, range(35))], timeout=2))
        elapsed = time.monotonic() - began
        self.assertEqual(len(results), 36)
        self.assertEqual(sum(r["metadata_state"] == "unavailable" for r in results), 1)
        self.assertLess(elapsed, 4.5)

    def test_cancellation_kills_all_owned_readers_and_limits_prefetch(self):
        previous = {p.pid for p in multiprocessing.active_children()}
        consumed = []
        cancel = threading.Event()
        def facts():
            for n in range(10000):
                consumed.append(n)
                yield dict(canonical="stall", metadata_state="pending", metadata={})
        timer = threading.Timer(0.7, cancel.set)
        timer.start()
        began = time.monotonic()
        try:
            results = list(read_headers(facts(), readers=4, metadata_enabled=True, timeout=45,
                cancelled=cancel.is_set, reader=controlled_reader))
        finally:
            timer.cancel()
        self.assertEqual(results, [])
        self.assertLessEqual(len(consumed), 4)
        self.assertLess(time.monotonic() - began, 2.5)
        self.assertFalse({p.pid for p in multiprocessing.active_children()} - previous)

    def test_generation_change_rejects_late_result(self):
        self.check_superseded_result(paused=False)

    def test_global_pause_rejects_late_result_and_requeues_root(self):
        self.check_superseded_result(paused=True)

    def check_superseded_result(self, *, paused):
        with TemporaryDirectory() as directory:
            catalog = Catalog(Path(directory) / "catalog.sqlite")
            indexer = SearchIndexer(catalog, monitoring=False)
            root = dict(id="root", path="C:\\fixture", enabled=True, generation="one")
            catalog.sync_roots([root])
            catalog.root_state("root", generation="one")
            source = dict(canonical="c:\\fixture\\a.mpr", path="C:\\fixture\\a.mpr", name="a.mpr", extension=".mpr",
                size=1, mtime_ns=1, modified_at="2026-01-01", recognition="recognized", metadata_state="pending",
                metadata={}, metadata_version=0, supplier="BioLogic")
            catalog.apply_batch("root", "one", [source])
            def superseded(*args, **kwargs):
                if paused:
                    indexer.pause_provider = lambda: True
                    indexer.pause_checked = 0
                else:
                    indexer.epoch += 1
                    catalog.root_state("root", generation="two")
                yield dict(source, metadata_state="ready", metadata={"barcode": "stale"})
            from backend.app.services import background_jobs
            job = background_jobs.create_job(kind="source_search_index", title="test", description="test", total=0)
            try:
                with patch("backend.app.services.import_search_index.read_headers", superseded):
                    finished, warnings = indexer._enrich_headers(root, dict(metadata_enabled=True), 0, job, {})
                self.assertFalse(finished)
                with catalog.connect() as db:
                    self.assertEqual(db.execute("SELECT metadata_state FROM entries").fetchone()[0], "pending")
                self.assertEqual(indexer.revision, 0)
                if paused:
                    self.assertEqual(indexer.pending, ["root"])
                    self.assertEqual(catalog.roots()[0]["status"], "paused")
            finally:
                background_jobs.update_job(job, status="completed")


if __name__ == "__main__":
    unittest.main()
