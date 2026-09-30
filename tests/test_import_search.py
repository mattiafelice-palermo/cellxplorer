from __future__ import annotations

import json
import os
import queue
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
from backend.app.services.import_search_catalog import Catalog, path_key, recover_catalog
from backend.app.services.import_search_index import SearchIndexer, validate_config
from backend.app.services.import_search_transport import BatchSpool
from backend.app.services import import_search_worker as worker


def config(path: str = "C:\\cycling", **values):
    return dict(roots=[dict(id="root", path=path, enabled=True)], formats=[".ndax", ".mpr", ".xlsx"],
                metadata_enabled=True, refresh_hours=24, paused=False, **values)


def fact(path="C:\\cycling\\abc.ndax", **values):
    return dict(canonical=path_key(path), path=path, name=Path(path.replace("\\", "/")).name,
                extension=Path(path).suffix, size=1, mtime_ns=1, modified_at="2026-01-01T00:00:00Z",
                recognition="recognized", metadata_state="ready", metadata_version=1,
                supplier="Neware", metadata={"barcode": "CELL_2370", "remarks": "Äccent % literal"}, **values)


def blocked_worker(root, settings, catalog, directory):
    spool = BatchSpool(directory)
    spool.put(dict(kind="progress", discovered=1))
    while True:
        time.sleep(1)


def transfer_worker(root, settings, catalog, directory):
    spool = BatchSpool(directory)
    for index in range(1000):
        spool.put(dict(kind="batch", facts=[fact(f"C:\\cycling\\{index}.ndax") for _ in range(128)]))


def blocked_header_worker(root, settings, catalog, directory):
    spool = BatchSpool(directory)
    if "resume_after" not in root:
        facts = [fact(f"C:\\cycling\\{i:03d}.ndax") for i in range(150)]
        for item in facts:
            item["metadata_state"] = "pending"
        spool.put(dict(kind="batch", facts=facts, discovered=150))
        spool.put(dict(kind="traversed", complete=True, discovered=150))
        spool.put(dict(kind="header", fact=facts[0]))
        while True:
            time.sleep(1)
    else:
        spool.put(dict(kind="batch", facts=[fact(f"C:\\cycling\\{i:03d}.ndax") for i in range(1, 150)]))
        spool.put(dict(kind="done", warnings=0))


def completed_worker(root, settings, catalog, directory):
    spool = BatchSpool(directory)
    spool.put(dict(kind="batch", facts=[fact(f"C:\\cycling\\{i:03d}.ndax") for i in range(150)], discovered=150))
    spool.put(dict(kind="traversed", complete=True, discovered=150))
    spool.put(dict(kind="done", warnings=0))


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.catalog = Catalog(Path(self.temporary.name) / "catalog.sqlite")
        self.config = config()
        self.catalog.sync_roots(self.config["roots"])
        self.catalog.root_state("root", generation="one")

    def tearDown(self):
        self.temporary.cleanup()

    def test_literal_unicode_metadata_and_filters(self):
        self.catalog.apply_batch("root", "one", [fact(), fact("C:\\cycling\\ÄCCENT%.mpr")])
        for query in ("cell_2370", "2370", "äccent", "%", "a", "bc", '"', "never_matches"):
            result = self.catalog.search(self.config, query=query)
            expected = 0 if query in ('"', "never_matches") else 1 if query == "bc" else 2
            self.assertEqual(result["total"], expected, query)
        self.assertEqual(self.catalog.search(self.config, query="abc", extension=".mpr")["total"], 0)
        self.config["metadata_enabled"] = False
        self.assertEqual(self.catalog.search(self.config, query="2370")["total"], 0)
        result = self.catalog.search(self.config, query="äccent")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["metadata"], {})

    def test_overlap_remove_and_normalize(self):
        roots = [*self.config["roots"], dict(id="nested", path="C:\\cycling\\nested", enabled=True)]
        self.config["roots"] = roots
        self.catalog.sync_roots(roots)
        self.catalog.root_state("nested", generation="two")
        item = fact("C:\\cycling\\nested\\a.ndax")
        self.catalog.apply_batch("root", "one", [item])
        self.catalog.apply_batch("nested", "two", [item])
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        self.assertEqual(self.catalog.search(self.config)["items"][0]["root_id"], "nested")
        self.catalog.sync_roots(roots[1:])
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        self.assertEqual(path_key("C:/Cycling/a.ndax"), path_key("c:\\cycling\\a.ndax"))

    def test_generation_reconcile_and_redirect(self):
        self.catalog.apply_batch("root", "one", [fact(), fact("C:\\cycling\\gone.ndax")])
        self.catalog.root_state("root", generation="two")
        self.assertFalse(self.catalog.apply_batch("root", "one", [fact("C:\\cycling\\late.ndax")]))
        self.catalog.apply_batch("root", "two", [fact()])
        self.assertEqual(self.catalog.search(self.config)["total"], 2)  # Partial scan retains unseen files.
        self.catalog.reconcile("root", "two")
        self.assertEqual(self.catalog.search(self.config)["total"], 1)
        self.catalog.sync_roots([dict(id="root", path="C:\\different", enabled=True)])
        self.assertEqual(self.catalog.search(self.config)["total"], 0)

    def test_search_never_reads_source_files_and_handles_concurrent_removal(self):
        self.catalog.apply_batch("root", "one", [fact()])
        with patch.object(os, "stat", side_effect=AssertionError("source IO")), patch.object(worker, "inspect_fact", side_effect=AssertionError("header")):
            self.assertEqual(self.catalog.search(self.config)["total"], 1)
        def mutate():
            for _ in range(30):
                self.catalog.sync_roots([])
                self.catalog.sync_roots(self.config["roots"])
                self.catalog.root_state("root", generation="one")
                self.catalog.apply_batch("root", "one", [fact()])
        thread = threading.Thread(target=mutate)
        thread.start()
        for _ in range(40):
            self.assertIn(self.catalog.search(self.config)["total"], (0, 1))
        thread.join()

    def test_portable_fallback(self):
        self.catalog.apply_batch("root", "one", [fact()])
        self.catalog.fts = False
        self.assertEqual(self.catalog.search(self.config, query="2370")["total"], 1)

    def test_xlsx_recognition_does_not_depend_on_optional_metadata(self):
        from backend.app.services import neware_excel, parsing
        item = fact("C:\\cycling\\a.xlsx")
        with patch.object(neware_excel, "validate_supported_workbook", side_effect=neware_excel.UnsupportedNewareExcelError("Unsupported")), patch.object(parsing, "read_header_metadata", side_effect=AssertionError("optional")), patch.object(os, "stat", return_value=type("Stat", (), dict(st_size=1, st_mtime_ns=1))()):
            self.assertEqual(worker.inspect_fact(item, False)["recognition"], "unsupported")
        with patch.object(neware_excel, "validate_supported_workbook"), patch.object(parsing, "read_header_metadata", return_value={"error": "conversion failure"}), patch.object(os, "stat", return_value=type("Stat", (), dict(st_size=1, st_mtime_ns=1))()):
            result = worker.inspect_fact(item, True)
            self.assertEqual(result["recognition"], "recognized")
            self.assertEqual(result["metadata_state"], "unavailable")

    def test_changed_or_missing_source_cannot_publish_unvalidated_metadata(self):
        from backend.app.services import parsing
        for final_stat in (OSError("offline"), type("Stat", (), dict(st_size=2, st_mtime_ns=2))()):
            with patch.object(parsing, "read_header_metadata", return_value={"barcode": "UNVALIDATED"}), patch.object(os, "stat", **({"side_effect": final_stat} if isinstance(final_stat, Exception) else {"return_value": final_stat})):
                result = worker.inspect_fact(fact(), True)
            self.assertEqual(result["metadata"], {})
            self.assertEqual(result["metadata_version"], 0)
            self.assertEqual(result["metadata_state"], "unavailable")
            self.assertEqual(result["recognition"], "recognized")

    def test_spool_ignores_partial_frame(self):
        directory = Path(self.temporary.name) / "spool"
        directory.mkdir()
        (directory / "000000000000.tmp").write_text('{"unfinished":', encoding="utf-8")
        spool = BatchSpool(str(directory))
        with self.assertRaises(queue.Empty):
            spool.get(0.01)
        spool.put({"kind": "done"})
        self.assertEqual(spool.get(0.1), {"kind": "done"})

    def test_blocked_worker_cancel_and_subsequent_scan(self):
        indexer = SearchIndexer(self.catalog, timeout=2, worker=blocked_worker)
        indexer.start(self.config)
        indexer.refresh()
        deadline = time.monotonic() + 5
        while not indexer.process and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertIsNotNone(indexer.process)
        start = time.monotonic()
        indexer.configure({**self.config, "paused": True})
        self.assertLess(time.monotonic() - start, 2.5)
        indexer.worker = completed_worker
        indexer.timeout = 45
        indexer.configure(self.config)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and self.catalog.roots()[0]["status"] != "ready":
            time.sleep(0.05)
        indexer.stop()
        self.assertEqual(self.catalog.search(self.config)["total"], 150)
        self.assertEqual(self.catalog.roots()[0]["status"], "ready")
        self.assertFalse(indexer.thread.is_alive())

    def test_cancel_during_large_transfer_is_bounded(self):
        indexer = SearchIndexer(self.catalog, timeout=3, worker=transfer_worker)
        indexer.start(self.config)
        indexer.refresh()
        deadline = time.monotonic() + 5
        while not indexer.process and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.7)
        start = time.monotonic()
        indexer.configure({**self.config, "paused": True})
        indexer.stop()
        self.assertLess(time.monotonic() - start, 2.5)
        self.assertFalse(indexer.thread.is_alive())

    def test_configuration_only_accepts_explicit_absolute_roots_and_formats(self):
        with self.assertRaises(ValueError):
            validate_config(config("relative"))
        value = validate_config({**self.config, "formats": [".nda", ".xlsx", ".pdf"]})
        self.assertEqual(value["formats"], [".xlsx"])

    def test_corrupt_and_unknown_version_recover_derived_catalog_only(self):
        unrelated = Path(self.temporary.name) / "cellxplorer.db"
        unrelated.write_bytes(b"scientific database sentinel")
        self.catalog.path.write_bytes(b"broken search catalog")
        recovered = recover_catalog(self.catalog.path)
        self.assertEqual(recovered.roots(), [])
        with recovered.connect() as db:
            db.execute("PRAGMA user_version=999")
        self.assertEqual(recover_catalog(self.catalog.path).roots(), [])
        self.assertEqual(unrelated.read_bytes(), b"scientific database sentinel")

    def test_header_timeout_skips_one_file_and_reaches_later_files(self):
        indexer = SearchIndexer(self.catalog, timeout=10, worker=blocked_header_worker)
        indexer.start(self.config)
        indexer.refresh()
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            states = self.catalog.roots()
            if states[0]["status"] == "needs_attention":
                break
            time.sleep(0.05)
        indexer.stop()
        self.assertEqual(states[0]["status"], "needs_attention")
        self.assertEqual(self.catalog.search(self.config)["total"], 150)
        self.assertEqual(states[0]["pending"], 0)
        self.assertFalse(indexer.thread.is_alive())

    def test_actual_spawn_scan_refresh_change_delete_offline_and_restart(self):
        source = Path(__file__).parent / "fixtures/golden_analysis/sources/cycles_time_steps.ndax"
        root = Path(self.temporary.name) / "sources"
        root.mkdir()
        target = root / "cell.ndax"
        shutil.copyfile(source, target)
        from openpyxl import Workbook
        Workbook().save(root / "unrelated.xlsx")
        settings = config(str(root))
        indexer = SearchIndexer(self.catalog, timeout=45)
        def wait_terminal():
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                state = self.catalog.roots()[0]
                if state["status"] not in ("queued", "scanning"):
                    return state
                time.sleep(0.05)
            self.fail("scan did not terminate")
        try:
            indexer.start(settings)
            indexer.configure(settings)
            state = wait_terminal()
            self.assertEqual(state["status"], "ready")
            self.assertEqual(self.catalog.search(settings)["total"], 1)
            old = self.catalog.search(settings)["items"][0]
            indexer.refresh()
            self.assertEqual(wait_terminal()["status"], "ready")
            self.assertEqual(self.catalog.search(settings)["items"][0]["metadata"], old["metadata"])
            target.rename(root / "renamed.ndax")
            indexer.refresh()
            self.assertEqual(wait_terminal()["status"], "ready")
            self.assertEqual(self.catalog.search(settings)["items"][0]["name"], "renamed.ndax")
            root.rename(root.with_name("offline"))
            indexer.refresh()
            self.assertEqual(wait_terminal()["status"], "offline")
            self.assertEqual(self.catalog.search(settings)["total"], 1)
            indexer.configure({**settings, "paused": True})
            self.assertEqual(self.catalog.roots()[0]["status"], "offline")
            root.with_name("offline").rename(root)
            indexer.stop()
            indexer.start(settings)
            indexer.refresh()
            deadline = time.monotonic() + 20
            while self.catalog.roots()[0]["status"] == "paused" and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(wait_terminal()["status"], "ready")
        finally:
            indexer.stop()


    def test_normalized_path_queries_and_canonical_relative_location(self):
        item = fact("Z:\\cycling\\sub\\a.ndax")
        item["canonical"] = path_key("\\\\server\\share\\cycling\\sub\\a.ndax")
        self.catalog.root_state("root", canonical_root=path_key("\\\\server\\share\\cycling"))
        self.catalog.apply_batch("root", "one", [item])
        for query in ("Z:/cycling/sub", "z:\\cycling\\sub", "\\\\server\\share\\cycling\\sub", "Z:/cycling/sub/../sub"):
            response = self.catalog.search(self.config, query=query)
            self.assertEqual(response["total"], 1, query)
            self.assertEqual(response["items"][0]["relative_path"], "sub\\a.ndax")

    def test_offline_or_remapped_alias_retains_searchable_location(self):
        settings = config("Z:\\cycling")
        self.catalog.sync_roots(settings["roots"])
        self.catalog.root_state("root", generation="one", canonical_root="z:\\cycling")
        item = fact("Z:\\cycling\\sub\\a.ndax")
        item["canonical"] = path_key("\\\\old-server\\share\\cycling\\sub\\a.ndax")
        self.catalog.apply_batch("root", "one", [item])
        result = self.catalog.search(settings)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["relative_path"], "sub\\a.ndax")


if __name__ == "__main__":
    unittest.main()
