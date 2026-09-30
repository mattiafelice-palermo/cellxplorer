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
from . import automation, background_jobs
from .import_search_catalog import Catalog, FORMATS, now, path_key, recover_catalog
from .import_search_worker import scan_root
from .import_search_worker import scan_changes
from .import_search_live import LiveRoots, refresh_deadline

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
        hours = int(root.get("refresh_hours", value.get("refresh_hours", 24)))
        acknowledged = root.get("network_load_acknowledged") is True
        if hours not in (0, 1, 4, 12, 24, 72, 168):
            raise ValueError("Choose a supported refresh interval.")
        if 0 < hours < 24 and not acknowledged:
            raise ValueError("Acknowledge the network-load warning before choosing refresh more often than daily.")
        roots.append(dict(id=str(root.get("id") or uuid.uuid4()), path=path,
            enabled=bool(root.get("enabled", True)), refresh_hours=hours, network_load_acknowledged=acknowledged))
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
    def __init__(self, catalog: Catalog, *, timeout=45.0, worker=scan_root, pause_provider=None, monitoring=True):
        self.catalog = catalog
        self.timeout = timeout
        self.worker = worker
        self.pause_provider = pause_provider
        self.lock = threading.RLock()
        self.config = dict(DEFAULT_CONFIG)
        self.pending: list[str] = []
        self.epoch = 0
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.process = None
        self.active_root = None
        self.pause_checked = 0.0
        self.automation_paused = False
        self.live = LiveRoots(self) if monitoring else None
        self.monitor_thread = None
        self.revision = 0
        self.last_delta_root = None

    def root_snapshots(self, *, counts=True):
        with self.lock:
            states = self.catalog.roots(counts=counts)
            return self.live.snapshots(states) if self.live else states

    def _monitor(self):
        while not self.stop_event.wait(0.5):
            try:
                with self.lock:
                    if self.stop_event.is_set():
                        return
                    self.live.tick()
            except Exception:
                # Keep search usable if a native subscription cannot start.
                # Recovery is retried on the next tick; no source data is touched.
                import logging
                logging.getLogger(__name__).warning("Search monitoring retry scheduled")

    def _background_paused(self):
        # Poll the existing local automation gate, never the source filesystem.
        if self.pause_provider is None:
            return False
        if time.monotonic() - self.pause_checked >= 0.5:
            self.automation_paused = self.pause_provider()
            self.pause_checked = time.monotonic()
        return self.automation_paused

    def configure(self, config: dict):
        with self.lock:
            previous = self.config
            old_roots = {r["id"]: r for r in previous["roots"]}
            new_roots = {r["id"]: r for r in config["roots"]}
            content_changed = (set(config["formats"]) - set(previous["formats"])) or (
                config["metadata_enabled"] and not previous["metadata_enabled"])
            scan_policy_changed = set(config["formats"]) != set(previous["formats"]) or config["metadata_enabled"] != previous["metadata_enabled"]
            affected = {key for key, root in new_roots.items() if root["enabled"] and (
                content_changed or key not in old_roots or not old_roots[key]["enabled"] or
                path_key(root["path"]) != path_key(old_roots[key]["path"]))}
            cancel_active = self.active_root and (config["paused"] or scan_policy_changed or self.active_root in affected or
                self.active_root not in new_roots or not new_roots[self.active_root]["enabled"])
            if cancel_active:
                # Unrelated roots/settings must not discard an in-flight scan.
                self.epoch += 1
                if self.process:
                    self.process.terminate()
            self.config = config
            if self.live:
                self.live.reconcile(config["paused"] or self._background_paused())
            self.catalog.sync_roots(config["roots"])
            enabled = {r["id"] for r in config["roots"] if r["enabled"]}
            self.pending = [r for r in self.pending if r in enabled]
            if cancel_active and self.active_root in enabled:
                affected.add(self.active_root)
            if previous["paused"] and not config["paused"]:
                affected.update(r["id"] for r in self.catalog.roots() if r["status"] == "paused" and r["id"] in enabled)
            for root in config["roots"]:
                if root["id"] in affected or root["id"] in self.pending:
                    self.catalog.root_state(root["id"], generation=str(uuid.uuid4()),
                                            status="paused" if config["paused"] else "queued")
                if root["id"] in affected and root["id"] not in self.pending:
                    self.pending.append(root["id"])
            self.wake.set()

    def start(self, config: dict):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.stop_event.clear()
            self.config = config
            self.catalog.sync_roots(config["roots"])
            enabled = {root["id"] for root in config["roots"] if root["enabled"]}
            self.pending = list(dict.fromkeys(root_id for root_id in self.pending if root_id in enabled))
            for state in self.catalog.roots():
                if (state["id"] in enabled and state["id"] not in self.pending
                        and state["status"] in ("queued", "scanning", "paused")):
                    self.pending.append(state["id"])
            if self.live:
                self.monitor_thread = threading.Thread(target=self._monitor, name="source-search-monitor", daemon=True)
                self.monitor_thread.start()
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
                    if self.live and self.live.items.get(root["id"], {}).get("state") != "refresh_only":
                        continue
                    deadline = refresh_deadline(root, self.config, state)
                    if deadline is None or time.time() < deadline:
                        continue
                self.pending.append(root["id"])
                self.catalog.root_state(root["id"], status="paused" if self.config["paused"] else "queued")
            self.wake.set()

    def rebuild(self):
        # Keep the schema/config, invalidate generation and clear derived rows only.
        with self.lock:
            self.epoch += 1
            if self.process:
                self.process.terminate()
            self.pending = [r["id"] for r in self.config["roots"] if r["enabled"]]
            self.revision += 1
            with self.catalog.connect() as db:
                db.execute("DELETE FROM memberships")
                db.execute("DELETE FROM entries")
                db.execute("UPDATE roots SET last_attempt=NULL,last_success=NULL,discovered=0")
            for root_id in self.pending:
                self.catalog.root_state(root_id, generation=str(uuid.uuid4()), status="paused" if self.config["paused"] else "queued", message=None)
            self.wake.set()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        with self.lock:
            self.epoch += 1
            if self.process:
                self.process.terminate()
            if self.live:
                self.live.stop()
        if self.thread:
            self.thread.join(2)
        if self.monitor_thread:
            self.monitor_thread.join(2)

    def _run(self):
        while not self.stop_event.is_set():
            if self._background_paused():
                with self.lock:
                    for root_id in self.pending:
                        self.catalog.root_state(root_id, status="paused", message="Background automation is paused. Resume it from the power menu.")
                self.wake.wait(0.5)
                self.wake.clear()
                continue
            with self.lock:
                if self.stop_event.is_set():
                    return
                root_id = next((key for key in self.pending if not self.live or self.live.can_scan(key)), None) if not self.config["paused"] else None
                if root_id:
                    self.pending.remove(root_id)
                changes = []
                if not root_id and not self.config["paused"] and self.live:
                    roots = self.config["roots"]
                    previous = next((i for i, r in enumerate(roots) if r["id"] == self.last_delta_root), -1)
                    for candidate in roots[previous + 1:] + roots[:previous + 1]:
                        changes = self.live.take_changes(candidate["id"])
                        if changes:
                            root_id = candidate["id"]
                            self.last_delta_root = root_id
                            break
                root = next((r for r in self.config["roots"] if r["id"] == root_id and r["enabled"]), None)
                config, epoch = self.config, self.epoch
                self.active_root = root_id if root else None
            if root:
                try:
                    if changes:
                        self._delta(root, config, epoch, changes)
                    else:
                        self._scan(root, config, epoch)
                except Exception:
                    with self.lock:
                        if epoch == self.epoch:
                            if self.live and self.live.items.get(root["id"], {}).get("state") != "reconnecting":
                                self.live.require_recovery(root["id"], "Indexing stopped unexpectedly. Previous results are retained; retrying.")
                            try:
                                self.catalog.root_state(root["id"], status="needs_attention", message="Indexing stopped. Previous results are retained; retrying.")
                            except Exception:
                                pass  # Catalog failure must not kill the recovery coordinator.
                finally:
                    with self.lock:
                        self.active_root = None
            else:
                self.wake.wait(0.5)
                self.wake.clear()

    def _delta(self, root, config, epoch, changes):
        generation = str(uuid.uuid4())
        with self.lock:
            if epoch != self.epoch or self.stop_event.is_set():
                return
            self.catalog.root_state(root["id"], generation=generation)
        finished = False
        recovery = True
        with tempfile.TemporaryDirectory(prefix="changes-", dir=self.catalog.path.parent) as directory:
            messages = BatchSpool(directory)
            process = multiprocessing.get_context("spawn").Process(target=scan_changes,
                args=({**root, "generation": generation, "changes": changes}, config, str(self.catalog.path), directory), daemon=True)
            with self.lock:
                if epoch != self.epoch or self.stop_event.is_set():
                    return
                self.process = process
                try:
                    process.start()
                except Exception:
                    self.process = None
                    raise
            last_message = time.monotonic()
            try:
                while not self.stop_event.is_set():
                    with self.lock:
                        if epoch != self.epoch or self.config["paused"] or self._background_paused():
                            break
                    try:
                        message = messages.get(timeout=0.1)
                    except queue.Empty:
                        if not process.is_alive() or time.monotonic() - last_message > self.timeout:
                            break
                        continue
                    last_message = time.monotonic()
                    with self.lock:
                        if epoch != self.epoch:
                            break
                        kind = message["kind"]
                        if kind == "batch":
                            self.catalog.apply_batch(root["id"], generation, message["facts"])
                            self.revision += 1
                        elif kind in ("remove", "subtree"):
                            self.catalog.remove_scope(root["id"], generation, message["canonical"], retain_current=kind == "subtree")
                            self.revision += 1
                        elif kind == "done":
                            finished, recovery = True, message["recovery"]
                            break
            finally:
                if process.is_alive():
                    process.terminate()
                process.join(1)
                with self.lock:
                    self.process = None
        with self.lock:
            if epoch == self.epoch and (not finished or recovery):
                # Bound retries for unstable/unreadable sources. A later successful
                # notification/reconnection or explicit rescan can retry sooner.
                self.live.require_recovery(root["id"], "A change could not be read. Previous results are retained; retrying.")
            elif epoch == self.epoch and self.live:
                self.live.items.get(root["id"], {}).update(recovery_failures=0)

    def _scan(self, root: dict, config: dict, epoch: int):
        context = multiprocessing.get_context("spawn")
        generation = str(uuid.uuid4())
        root = {**root, "generation": generation}
        job = background_jobs.create_job(kind="source_search_index", title="Indexing search location", description=root["path"], total=0)
        complete = False
        finished = False
        warnings = 0
        root_error = None
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
                        try:
                            process.start()
                        except Exception:
                            self.process = None
                            raise
                    last_message = time.monotonic()
                    try:
                        while not self.stop_event.is_set():
                            if self._background_paused():
                                with self.lock:
                                    if epoch == self.epoch:
                                        self.epoch += 1
                                        if root["id"] not in self.pending:
                                            self.pending.insert(0, root["id"])
                                        self.catalog.root_state(root["id"], status="paused", message="Background automation is paused. Resume it from the power menu.")
                                break
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
                                    self.revision += 1
                                    last_header = None
                                if "discovered" in message:
                                    count = message["discovered"]
                                    self.catalog.root_state(root["id"], discovered=count)
                                    background_jobs.update_job(job, completed=0, total=0, phase_detail=f"Discovered {count} files; scanning folders")
                                if kind == "root":
                                    resolved_root = message["canonical_root"]
                                if kind == "header":
                                    last_header = message["fact"]
                                if kind == "traversed":
                                    complete = message["complete"]
                                    root_error = message.get("root_error")
                                    if complete:
                                        self.catalog.reconcile(root["id"], generation)
                                        self.revision += 1
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
                    if root_error:
                        status = "offline"
                    message = root_error or (None if status == "ready" else
                        "Some source headers could not be read. File results remain searchable; refresh to retry." if complete and finished else
                        "Some folders could not be scanned. Results may be incomplete; check access and refresh.")
                    values = dict(status=status, message=message)
                    if complete and finished:
                        values["last_success"] = now()
                    self.catalog.root_state(root["id"], **values)
                    if self.live:
                        if not complete or not finished:
                            self.live.require_recovery(root["id"], "Reconciliation was incomplete. Last known results are retained; retrying.")
                        else:
                            self.live.items.get(root["id"], {}).update(recovery_failures=0)
                background_jobs.update_job(job, status="completed" if finished or not current else "failed",
                    description="Search index refreshed" if finished else "Indexing stopped; previous results retained")


_indexer: SearchIndexer | None = None
_service_lock = threading.Lock()


def _automation_pause():
    with SessionLocal() as db:
        return automation.is_paused(db)


def get_indexer() -> SearchIndexer:
    global _indexer
    with _service_lock:
        if _indexer is None:
            _indexer = SearchIndexer(recover_catalog(), pause_provider=_automation_pause)
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
