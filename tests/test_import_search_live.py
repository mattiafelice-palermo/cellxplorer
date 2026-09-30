from __future__ import annotations

import multiprocessing
import os
import queue
import shutil
import struct
import tempfile
import threading
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
from backend.app.services.import_search_catalog import Catalog, path_key
from backend.app.services.import_search_index import SearchIndexer, validate_config
from backend.app.services.import_search_live import MAX_EVENTS, refresh_deadline
from backend.app.services.import_search_transport import BatchSpool
from backend.app.services.import_search_watch import decode_notifications, watch_root
from backend.app.services.import_search_worker import scan_changes


def settings(path):
    return dict(roots=[dict(id="root", path=str(path), enabled=True)], formats=[".ndax"],
                metadata_enabled=False, refresh_hours=24, paused=False)


def fact(path):
    return dict(canonical=path_key(str(path)), path=str(path), name=Path(path).name, extension=".ndax",
        size=1, mtime_ns=1, modified_at="2026-01-01T00:00:00Z", recognition="recognized",
        metadata_state="disabled", metadata={}, metadata_version=0, supplier="Neware")


def unsupported_watch(path, messages, stop, overflow):
    messages.put(dict(kind="unsupported"))
    stop.wait(10)


def blocked_watch(path, messages, stop, overflow):
    stop.wait(10)


def fast_identity_watch(path, messages, stop, overflow):
    watch_root(path, messages, stop, overflow, root_check_seconds=0.25)


def slow_initial_scan(root, config, catalog, directory):
    spool = BatchSpool(directory)
    spool.put(dict(kind="traversed", complete=True, discovered=0))
    time.sleep(2)
    spool.put(dict(kind="done", warnings=0))


def wait_until(predicate, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for search catalog state")


class PolicyTests(unittest.TestCase):
    def test_short_refresh_requires_boolean_acknowledgement(self):
        for hours in (1, 4, 12):
            config = settings("C:\\data")
            config["roots"][0]["refresh_hours"] = hours
            with self.assertRaisesRegex(ValueError, "Acknowledge"):
                validate_config(config)
            config["roots"][0]["network_load_acknowledged"] = "yes"
            with self.assertRaises(ValueError):
                validate_config(config)
            config["roots"][0]["network_load_acknowledged"] = True
            self.assertEqual(validate_config(config)["roots"][0]["refresh_hours"], hours)

    def test_default_and_staggered_deadline(self):
        config = settings("C:\\data")
        normalized = validate_config(config)
        self.assertEqual(normalized["roots"][0]["refresh_hours"], 24)
        self.assertFalse(normalized["roots"][0]["network_load_acknowledged"])
        stamp = "2026-01-01T00:00:00+00:00"
        base = datetime.fromisoformat(stamp).timestamp() + 86400
        deadline = refresh_deadline(config["roots"][0], config, dict(last_attempt=stamp))
        self.assertGreaterEqual(deadline, base)
        self.assertLess(deadline, base + 1800)
        self.assertEqual(deadline, refresh_deadline(config["roots"][0], config, dict(last_attempt=stamp)))
        self.assertIsNone(refresh_deadline(dict(id="root", refresh_hours=0), config, {}))

    def test_native_packet_validation(self):
        name = "deep\\source.ndax".encode("utf-16-le")
        self.assertEqual(decode_notifications(struct.pack("<III", 0, 1, len(name)) + name), ["deep\\source.ndax"])
        for name in ("..\\escape.ndax", "C:\\escape.ndax", "\\escape", ""):
            encoded = name.encode("utf-16-le")
            with self.assertRaises(ValueError):
                decode_notifications(struct.pack("<III", 0, 2, len(encoded)) + encoded)
        with self.assertRaises(ValueError):
            decode_notifications(b"short")


class DeltaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "files"
        self.root.mkdir()
        self.config = settings(self.root)
        self.catalog = Catalog(self.base / "catalog.sqlite")
        self.catalog.sync_roots(self.config["roots"])
        self.catalog.root_state("root", generation="before")

    def tearDown(self):
        self.temporary.cleanup()

    def run_changes(self, names):
        # Producer is bounded by eight batches; consume concurrently.
        directory = self.base / "spool"
        directory.mkdir(exist_ok=True)
        messages = BatchSpool(str(directory))
        generation = str(uuid.uuid4())
        self.catalog.root_state("root", generation=generation)
        root = {**self.config["roots"][0], "changes": names, "generation": generation}
        thread = threading.Thread(target=scan_changes, args=(root, self.config, str(self.catalog.path), str(directory)))
        thread.start()
        try:
            while True:
                message = messages.get(10)
                if message["kind"] == "batch":
                    self.catalog.apply_batch("root", generation, message["facts"])
                elif message["kind"] in ("remove", "subtree"):
                    self.catalog.remove_scope("root", generation, message["canonical"], retain_current=message["kind"] == "subtree")
                elif message["kind"] == "done":
                    return message["recovery"]
        finally:
            thread.join(2)

    def test_deep_subtree_add_delete_and_other_roots_retained(self):
        folder = self.root / "nested"
        folder.mkdir()
        (folder / "one.ndax").write_bytes(b"one")
        (folder / "ignore.txt").write_text("ignored")
        self.assertFalse(self.run_changes(["nested", os.path.join("nested", "one.ndax")]))
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        roots = [*self.config["roots"], dict(id="overlap", path=str(folder), enabled=True)]
        self.catalog.sync_roots(roots)
        self.catalog.root_state("overlap", generation="other")
        self.catalog.apply_batch("overlap", "other", [fact(folder / "one.ndax")])
        shutil.rmtree(folder)
        self.assertFalse(self.run_changes(["nested"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 0)
        with self.catalog.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM entries").fetchone()[0], 1)

    def test_outage_never_deletes_and_stale_generation_rejected(self):
        file = self.root / "retained.ndax"
        self.catalog.apply_batch("root", "before", [fact(file)])
        self.root.rmdir()
        self.assertTrue(self.run_changes(["retained.ndax"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        self.assertFalse(self.catalog.remove_scope("root", "stale", path_key(str(file))))

    def test_scope_prefix_is_literal_and_bounded(self):
        paths = [self.root / "a%" / "one.ndax", self.root / "another" / "two.ndax"]
        self.catalog.apply_batch("root", "before", [fact(p) for p in paths])
        self.catalog.remove_scope("root", "before", path_key(str(self.root / "a%")))
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        self.assertEqual(self.catalog.search(self.config)["items"][0]["name"], "two.ndax")

    def test_folder_replaced_by_file_prunes_descendants(self):
        folder = self.root / "group"
        self.catalog.apply_batch("root", "before", [fact(folder / "old.ndax")])
        folder.write_bytes(b"unsupported replacement")
        self.assertFalse(self.run_changes(["group"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 0)
        folder = self.root / "group.ndax"
        generation = self.catalog.roots()[0]["generation"]
        self.catalog.apply_batch("root", generation, [fact(folder / "old.ndax")])
        folder.write_bytes(b"supported replacement")
        self.assertFalse(self.run_changes(["group.ndax"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        self.assertEqual(self.catalog.search(self.config)["items"][0]["name"], "group.ndax")

    def test_subtree_stability_checks_share_settling_interval(self):
        folder = self.root / "bulk"
        folder.mkdir()
        for i in range(12):
            (folder / f"{i}.ndax").write_bytes(b"source")
        pauses = []
        actual_sleep = time.sleep
        def sleep(seconds):
            if seconds > 0.05:
                pauses.append(seconds)
            actual_sleep(seconds)
        with patch("backend.app.services.import_search_worker.time.sleep", side_effect=sleep):
            self.assertFalse(self.run_changes(["bulk"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 12)
        self.assertLess(len(pauses), 4, "Bulk stability must not sleep once per file")

    def test_rename_during_header_read_does_not_disconnect_monitor(self):
        from backend.app.services.import_search_worker import inspect_fact
        source = self.root / "old.ndax"
        source.write_bytes(b"source")
        self.config["metadata_enabled"] = True
        def rename(fact, metadata):
            source.rename(source.with_name("new.ndax"))
            return inspect_fact(fact, metadata)
        with patch("backend.app.services.import_search_worker.inspect_fact", side_effect=rename):
            self.assertFalse(self.run_changes(["old.ndax"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 0)
        self.config["metadata_enabled"] = False
        self.assertFalse(self.run_changes(["new.ndax"]))
        self.assertEqual(self.catalog.search(self.config)["total"], 1)

    def test_productive_bulk_headers_renew_watchdog_and_publish_partial_results(self):
        folder = self.root / "bulk"
        folder.mkdir()
        for i in range(20):
            (folder / f"{i}.ndax").write_bytes(b"source")
        self.config["metadata_enabled"] = True
        # Simulate 200 seconds of aggregate work, with each header taking ten
        # seconds: below the production 45-second individual-operation timeout.
        elapsed = [0]
        published = []
        class Recorder:
            def __init__(self, _directory):
                pass
            def put(self, message):
                published.append((elapsed[0], message))
        def inspect(value, metadata):
            self.assertEqual(published[-1][1]["kind"], "header")
            elapsed[0] += 10
            return {**value, "metadata_state": "ready"}
        with patch("backend.app.services.import_search_worker.BatchSpool", Recorder), patch(
            "backend.app.services.import_search_worker.inspect_fact", side_effect=inspect
        ):
            scan_changes({**self.config["roots"][0], "changes": ["bulk"]}, self.config,
                         str(self.catalog.path), str(self.base / "spool"))
        self.assertEqual(elapsed[0], 200)
        self.assertLessEqual(max(b[0] - a[0] for a, b in zip(published, published[1:])), 10)
        ready_batches = [(stamp, message) for stamp, message in published if message["kind"] == "batch"
                         and message["facts"][0]["metadata_state"] == "ready"]
        self.assertTrue(any(stamp < 200 for stamp, _message in ready_batches))
        self.assertEqual(sum(len(message["facts"]) for _stamp, message in ready_batches), 20)
        self.assertFalse(published[-1][1]["recovery"])


class LifecycleTests(DeltaTests):
    def test_failed_delta_catalog_write_requires_recovery(self):
        source = self.root / "changed.ndax"
        source.write_bytes(b"source")
        self.catalog.apply_batch("root", "before", [fact(self.root / "retained.ndax")])
        indexer = SearchIndexer(self.catalog)
        indexer.config = self.config
        indexer.live.items["root"] = dict(path=str(self.root), state="connected",
            events={"changed.ndax": "changed.ndax"}, changed=0, retry=0, recovery=False)
        with patch.object(self.catalog, "apply_batch", side_effect=OSError("injected write failure")):
            indexer.thread = threading.Thread(target=indexer._run, daemon=True)
            indexer.thread.start()
            try:
                wait_until(lambda: indexer.root_snapshots()[0]["monitor_state"] == "reconnecting")
                self.assertTrue(indexer.live.items["root"]["recovery"])
                self.assertEqual(self.catalog.search(self.config)["total"], 1)
            finally:
                indexer.stop()

    def test_delta_selection_is_fair_between_busy_roots(self):
        indexer = SearchIndexer(self.catalog)
        indexer.config = {**self.config, "roots": [*self.config["roots"], dict(id="second", path=str(self.root), enabled=True)]}
        for key in ("root", "second"):
            indexer.live.items[key] = dict(state="connected", events={"one": "one.ndax"}, changed=0)
        served = []
        def delta(root, config, epoch, changes):
            served.append(root["id"])
            indexer.live.items["root"]["events"] = {"busy": "busy.ndax"}
            if len(served) == 4:
                indexer.stop_event.set()
        with patch.object(indexer, "_delta", side_effect=delta):
            indexer._run()
        self.assertEqual(served[:2], ["root", "second"])

    def test_manual_fallback_resume_reconciles_gap(self):
        config = {**self.config, "refresh_hours": 0}
        indexer = SearchIndexer(self.catalog)
        indexer.live.worker = unsupported_watch
        indexer.start(config)
        try:
            wait_until(lambda: indexer.root_snapshots()[0]["last_success"] is not None)
            indexer.configure({**config, "paused": True})
            (self.root / "missed.ndax").write_bytes(b"gap")
            indexer.configure(config)
            wait_until(lambda: self.catalog.search(config, query="missed")["total"] == 1)
        finally:
            indexer.stop()

    def test_subscription_limit_recovery_obeys_backoff(self):
        indexer = SearchIndexer(self.catalog)
        roots = [dict(id=str(n), path=str(self.root / str(n)), enabled=True) for n in range(9)]
        indexer.config = {**self.config, "roots": roots, "refresh_hours": 0}
        self.catalog.sync_roots(roots)
        for root in roots:
            indexer.live.items[root["id"]] = dict(path=root["path"], state="refresh_only",
                events={}, retry=0, failures=0, recovery=False, message=None)
        indexer.live.require_recovery("8", "retry")
        indexer.live.reconcile(False)
        self.assertEqual(indexer.live.items["8"]["state"], "reconnecting")
        self.assertNotIn("8", indexer.pending)
        indexer.live.items["8"]["retry"] = 0
        indexer.live.reconcile(False)
        self.assertEqual(indexer.live.items["8"]["state"], "refresh_only")
        self.assertIn("8", indexer.pending)

    def test_overflow_queues_reconciliation_and_preserves_results(self):
        from unittest.mock import Mock
        self.catalog.apply_batch("root", "before", [fact(self.root / "keep.ndax")])
        indexer = SearchIndexer(self.catalog)
        indexer.config = self.config
        messages = queue.Queue()
        overflow = threading.Event()
        overflow.set()
        process = Mock()
        process.is_alive.return_value = True
        item = dict(path=str(self.root), process=process, queue=messages, overflow=overflow,
            state="connected", events={"old": "old.ndax"}, changed=0, heartbeat=time.monotonic(),
            failures=0, retry=0, recovery=False, message=None)
        indexer.live.items["root"] = item
        with indexer.lock:
            indexer.live.tick()
        self.assertEqual(indexer.pending, ["root"])
        self.assertEqual(item["events"], {})
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        # Periodic refresh cannot queue healthy roots even if their scan is ancient.
        indexer.pending.clear()
        self.catalog.root_state("root", last_success="2020-01-01T00:00:00Z")
        indexer.refresh(due_only=True)
        self.assertEqual(indexer.pending, [])

    def test_events_retained_during_scan_and_bursts_have_bounded_delay(self):
        indexer = SearchIndexer(self.catalog)
        item = dict(state="connected", events={"new": "new.ndax"}, changed=time.monotonic(),
                    batch_started=time.monotonic() - 3)
        indexer.live.items["root"] = item
        # Scanner never takes events while it is executing _scan. They stay in
        # the monitor's dictionary and are replayed on its next _run iteration.
        indexer.active_root = "root"
        self.assertEqual(item["events"], {"new": "new.ndax"})
        indexer.active_root = None
        self.assertEqual(indexer.live.take_changes("root"), ["new.ndax"])
        self.assertFalse(item["events"])

    def test_unsupported_and_scheduler_without_search_open(self):
        indexer = SearchIndexer(self.catalog)
        indexer.live.worker = unsupported_watch
        indexer.start(self.config)
        try:
            wait_until(lambda: indexer.root_snapshots()[0].get("monitor_state") == "refresh_only")
            wait_until(lambda: indexer.root_snapshots()[0]["last_success"] is not None)
            state = indexer.root_snapshots()[0]
            self.assertIsNotNone(state["next_refresh"])
            # Advance only the scheduler's wall clock; no search request is made.
            stamp = state["last_success"]
            with patch("backend.app.services.import_search_live.time.time", return_value=time.time() + 90000):
                wait_until(lambda: indexer.root_snapshots()[0]["last_success"] != stamp)
        finally:
            indexer.stop()

    def test_watch_timeout_retains_catalog_and_stop_is_bounded(self):
        self.catalog.apply_batch("root", "before", [fact(self.root / "keep.ndax")])
        indexer = SearchIndexer(self.catalog, timeout=0.3)
        indexer.live.worker = blocked_watch
        indexer.start(self.config)
        try:
            wait_until(lambda: indexer.root_snapshots()[0].get("monitor_state") == "reconnecting")
            self.assertEqual(self.catalog.search(self.config)["total"], 1)
        finally:
            start = time.monotonic()
            indexer.stop()
            self.assertLess(time.monotonic() - start, 3)

    @unittest.skipUnless(os.name == "nt", "Native Windows acceptance")
    def test_native_events_during_scan_are_replayed(self):
        indexer = SearchIndexer(self.catalog, worker=slow_initial_scan)
        indexer.start(self.config)
        try:
            wait_until(lambda: indexer.root_snapshots()[0]["status"] == "scanning")
            (self.root / "during-scan.ndax").write_bytes(b"arrived")
            wait_until(lambda: self.catalog.search(self.config, query="during-scan")["total"] == 1)
            self.assertIsNotNone(indexer.root_snapshots()[0]["last_success"])
        finally:
            indexer.stop()

    @unittest.skipUnless(os.name == "nt", "Native Windows acceptance")
    def test_native_root_rename_replacement_detected_and_reconciled(self):
        indexer = SearchIndexer(self.catalog)
        indexer.live.worker = fast_identity_watch
        indexer.start(self.config)
        try:
            wait_until(lambda: indexer.root_snapshots()[0]["last_success"] is not None)
            initial = indexer.root_snapshots()[0]["last_success"]
            self.root.rename(self.base / "moved")
            self.root.mkdir()
            (self.root / "replacement.ndax").write_bytes(b"replacement")
            wait_until(lambda: indexer.root_snapshots()[0]["monitor_state"] == "reconnecting")
            # Production retry is >=30s; advance the native test's retry deadline only.
            with indexer.lock:
                indexer.live.items["root"]["retry"] = 0
            wait_until(lambda: self.catalog.search(self.config, query="replacement")["total"] == 1)
            wait_until(lambda: indexer.root_snapshots()[0]["last_success"] != initial)
            self.assertNotEqual(indexer.root_snapshots()[0]["last_success"], initial)
        finally:
            indexer.stop()

    @unittest.skipUnless(os.name == "nt", "Native Windows acceptance")
    def test_native_notifications_deep_rename_delete_pause_resume(self):
        indexer = SearchIndexer(self.catalog)
        indexer.start(self.config)
        try:
            wait_until(lambda: indexer.root_snapshots()[0].get("monitor_state") == "connected")
            wait_until(lambda: indexer.root_snapshots()[0]["last_success"] is not None)
            initial_scan = indexer.root_snapshots()[0]["last_success"]
            folder = self.root / "deep" / "nested"
            folder.mkdir(parents=True)
            source = folder / "new.ndax"
            source.write_bytes(b"source")
            wait_until(lambda: self.catalog.search(self.config, query="new.ndax")["total"] == 1)
            renamed = source.with_name("renamed.ndax")
            source.rename(renamed)
            wait_until(lambda: self.catalog.search(self.config, query="renamed.ndax")["total"] == 1
                       and self.catalog.search(self.config, query="new.ndax")["total"] == 0)
            renamed.unlink()
            wait_until(lambda: self.catalog.search(self.config)["total"] == 0)
            # Healthy changes never require a full-root scan.
            self.assertEqual(indexer.root_snapshots()[0]["last_success"], initial_scan)
            indexer.configure({**self.config, "paused": True})
            self.assertEqual(indexer.root_snapshots()[0]["monitor_state"], "paused")
            (folder / "during-pause.ndax").write_bytes(b"pause")
            indexer.configure(self.config)
            wait_until(lambda: self.catalog.search(self.config, query="during-pause")["total"] == 1)
        finally:
            indexer.stop()


if __name__ == "__main__":
    unittest.main()
