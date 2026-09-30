"""Config and bounded coordinator for the disposable source search catalog."""
from __future__ import annotations

import json
import multiprocessing
import ntpath
import os
import queue
import threading
import time
import uuid
import tempfile
from pathlib import Path

from .import_search_transport import BatchSpool
from datetime import datetime, timezone

from ..db import SessionLocal
from ..models import AppSetting
from . import background_jobs
from .import_search_catalog import Catalog, FORMATS, now, path_key, recover_catalog
from .import_search_worker import scan_root

SETTING_KEY = "import_search"
DEFAULT_CONFIG = dict(roots=[], formats=list(FORMATS), metadata_enabled=True, refresh_hours=24, paused=False)


def load_config(db) -> dict:
    row = db.get(AppSetting, SETTING_KEY)
    try:
        value = json.loads(row.value) if row else {}
    except (ValueError, TypeError):
        value = {}
    return {**DEFAULT_CONFIG, **value}


def validate_config(value: dict) -> dict:
    roots = []
    keys = set()
    for root in value.get("roots", []):
        path = str(root.get("path", "")).strip()
        if not (ntpath.isabs(path) and (ntpath.splitdrive(path)[0] or os.name != "nt")):
            raise ValueError("Choose an absolute folder path, mapped drive, or UNC location.")
        key = path_key(path)
        if key in keys:
            raise ValueError("This search location is already configured.")
        keys.add(key)
        roots.append(dict(id=str(root.get("id") or uuid.uuid4()), path=path, enabled=bool(root.get("enabled", True))))
    if len(roots) > 32 or len({r["id"] for r in roots}) != len(roots):
        raise ValueError("Use at most 32 distinct search locations.")
    formats = [item for item in FORMATS if item in value.get("formats", FORMATS)]
    hours = int(value.get("refresh_hours", 24))
    if hours not in (0, 24, 72, 168):
        raise ValueError("Choose manual, daily, every three days, or weekly refresh.")
    return dict(roots=roots, formats=formats, metadata_enabled=bool(value.get("metadata_enabled", True)),
                refresh_hours=hours, paused=bool(value.get("paused", False)))


def save_config(db, value: dict) -> dict:
    config = validate_config(value)
    row = db.get(AppSetting, SETTING_KEY)
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=json.dumps(config)))
    else:
        row.value = json.dumps(config)
    db.commit()
    return config


class SearchIndexer:
    def __init__(self, catalog: Catalog, *, timeout=45.0, worker=scan_root):
        self.catalog = catalog
        self.timeout = timeout
        self.worker = worker
        self.lock = threading.RLock()
        self.config = dict(DEFAULT_CONFIG)
        self.pending: list[str] = []
        self.epoch = 0
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.process = None

    def configure(self, config: dict):
        with self.lock:
            # Every configuration edit invalidates in-flight batches before writes.
            self.epoch += 1
            self.config = config
            self.catalog.sync_roots(config["roots"])
            enabled = {r["id"] for r in config["roots"] if r["enabled"]}
            self.pending = [r for r in self.pending if r in enabled]
            for root in config["roots"]:
                self.catalog.root_state(root["id"], generation=str(uuid.uuid4()),
                                        status="paused" if config["paused"] or not root["enabled"] else "queued")
                if root["id"] in enabled and root["id"] not in self.pending:
                    self.pending.append(root["id"])
            if self.process:
                self.process.terminate()
            self.wake.set()

    def start(self, config: dict):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.stop_event.clear()
            self.config = config
            self.catalog.sync_roots(config["roots"])
            for state in self.catalog.roots():
                if state["status"] in ("queued", "scanning", "paused"):
                    self.pending.append(state["id"])
            self.thread = threading.Thread(target=self._run, name="source-search-index", daemon=True)
            self.thread.start()
            self.wake.set()

    def refresh(self, root_id=None, *, due_only=False):
        with self.lock:
            states = {r["id"]: r for r in self.catalog.roots()}
            for root in self.config["roots"]:
                if not root["enabled"] or root_id and root["id"] != root_id:
                    continue
                state = states.get(root["id"], {})
                if state.get("status") == "scanning" or root["id"] in self.pending:
                    continue
                if due_only:
                    hours = self.config["refresh_hours"]
                    if not hours:
                        continue
                    stamp = state.get("last_attempt") or state.get("last_success")
                    if stamp and (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds() < hours * 3600:
                        continue
                self.pending.append(root["id"])
                self.catalog.root_state(root["id"], status="paused" if self.config["paused"] else "queued")
            self.wake.set()

    def rebuild(self):
        # Keep the schema/config, invalidate generation and clear derived rows only.
        with self.lock:
            self.configure(self.config)
            with self.catalog.connect() as db:
                db.execute("DELETE FROM memberships")
                db.execute("DELETE FROM entries")
                db.execute("UPDATE roots SET last_attempt=NULL,last_success=NULL,discovered=0")

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        with self.lock:
            self.epoch += 1
            if self.process:
                self.process.terminate()
        if self.thread:
            self.thread.join(2)

    def _run(self):
        while not self.stop_event.is_set():
            with self.lock:
                root_id = self.pending.pop(0) if self.pending and not self.config["paused"] else None
                root = next((r for r in self.config["roots"] if r["id"] == root_id and r["enabled"]), None)
                config, epoch = self.config, self.epoch
            if root:
                try:
                    self._scan(root, config, epoch)
                except Exception:
                    with self.lock:
                        if epoch == self.epoch:
                            self.catalog.root_state(root["id"], status="needs_attention", message="Indexing stopped. Refresh this location to try again.")
            else:
                self.wake.wait(0.5)
                self.wake.clear()

    def _scan(self, root: dict, config: dict, epoch: int):
        context = multiprocessing.get_context("spawn")
        generation = str(uuid.uuid4())
        root = {**root, "generation": generation}
        job = background_jobs.create_job(kind="source_search_index", title="Indexing search location", description=root["path"], total=0)
        complete = False
        finished = False
        warnings = 0
        with self.lock:
            if epoch != self.epoch or self.stop_event.is_set():
                background_jobs.update_job(job, status="completed", description="Indexing superseded")
                return
            self.catalog.root_state(root["id"], generation=generation, status="scanning", last_attempt=now(), message=None)
        try:
            while not finished:
                last_header = None
                resolved_root = None
                restart = False
                with tempfile.TemporaryDirectory(prefix="scan-", dir=self.catalog.path.parent) as directory:
                    messages = BatchSpool(directory)
                    process = context.Process(target=self.worker, args=(root, config, str(self.catalog.path), directory), daemon=True)
                    with self.lock:
                        if epoch != self.epoch or self.stop_event.is_set():
                            break
                        self.process = process
                        process.start()
                    last_message = time.monotonic()
                    try:
                        while not self.stop_event.is_set():
                            with self.lock:
                                if epoch != self.epoch:
                                    break
                            try:
                                message = messages.get(timeout=0.1)
                            except queue.Empty:
                                if not process.is_alive() or time.monotonic() - last_message > self.timeout:
                                    if last_header and process.is_alive():
                                        # Skip a stalled header, not the rest of the root.
                                        last_header.update(metadata_state="unavailable")
                                        with self.lock:
                                            if epoch == self.epoch:
                                                self.catalog.apply_batch(root["id"], generation, [last_header])
                                        root["resume_after"] = last_header["canonical"]
                                        warnings += 1
                                        restart = True
                                    break
                                continue
                            last_message = time.monotonic()
                            with self.lock:
                                if epoch != self.epoch:
                                    break
                                kind = message["kind"]
                                if kind == "batch":
                                    self.catalog.apply_batch(root["id"], generation, message["facts"])
                                    last_header = None
                                if "discovered" in message:
                                    count = message["discovered"]
                                    self.catalog.root_state(root["id"], discovered=count)
                                    background_jobs.update_job(job, completed=count, total=count, phase_detail="Discovering files and reading source headers")
                                if kind == "root":
                                    resolved_root = message["canonical_root"]
                                if kind == "header":
                                    last_header = message["fact"]
                                if kind == "traversed":
                                    complete = message["complete"]
                                    if complete:
                                        self.catalog.reconcile(root["id"], generation)
                                        if resolved_root:
                                            self.catalog.root_state(root["id"], canonical_root=resolved_root)
                                    (Path(directory) / "traversal.ack").touch()
                                if kind == "done":
                                    warnings += message["warnings"]
                                    finished = True
                                    break
                    finally:
                        if process.is_alive():
                            process.terminate()
                        process.join(1)
                        with self.lock:
                            self.process = None
                if not restart:
                    break
        finally:
            with self.lock:
                current = epoch == self.epoch and not self.stop_event.is_set()
                if current:
                    status = "ready" if complete and finished and not warnings else "needs_attention" if finished else "offline"
                    values = dict(status=status, message=None if status == "ready" else "Some files or folders could not be read. Last known results are retained; refresh to retry.")
                    if complete and finished:
                        values["last_success"] = now()
                    self.catalog.root_state(root["id"], **values)
                background_jobs.update_job(job, status="completed" if finished or not current else "failed",
                    description="Search index refreshed" if finished else "Indexing stopped; previous results retained")


_indexer: SearchIndexer | None = None
_service_lock = threading.Lock()


def get_indexer() -> SearchIndexer:
    global _indexer
    with _service_lock:
        if _indexer is None:
            _indexer = SearchIndexer(recover_catalog())
            with SessionLocal() as db:
                _indexer.start(load_config(db))
        return _indexer


def start_search_index():
    # Initialization is local and small; scans happen in an independent process.
    try:
        get_indexer()
    except Exception:
        import logging
        logging.getLogger(__name__).warning("File search unavailable; other application features remain available")


def stop_search_index():
    global _indexer
    if _indexer:
        _indexer.stop()
        _indexer = None
