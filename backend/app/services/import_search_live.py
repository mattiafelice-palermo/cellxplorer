"""Bounded notification ownership, coalescing and fallback scheduling."""
from __future__ import annotations

import hashlib
import multiprocessing
import queue
import time
from datetime import datetime, timezone

from .import_search_watch import watch_root

MAX_WATCHERS = 8
MAX_EVENTS = 4096


def refresh_deadline(root: dict, config: dict, state: dict) -> float | None:
    hours = root.get("refresh_hours", config.get("refresh_hours", 24))
    if not hours:
        return None
    stamp = state.get("last_attempt") or state.get("last_success")
    if not stamp:
        return 0
    # Stable per-location jitter spreads multiple clients without shortening cadence.
    jitter = int(hashlib.sha256(root["id"].encode()).hexdigest()[:8], 16) % 1800
    return datetime.fromisoformat(stamp).timestamp() + hours * 3600 + jitter


class LiveRoots:
    """Called under SearchIndexer's lock. All source I/O runs in disposable children."""
    def __init__(self, owner, worker=watch_root):
        self.owner = owner
        self.worker = worker
        self.items = {}
        self.context = multiprocessing.get_context("spawn")

    def _close(self, item):
        process = item.pop("process", None)
        if process:
            item["stop"].set()
            # Never join on the API thread; a hung network handle is forcibly stopped.
            if process.is_alive():
                process.terminate()
            process.join(0)
            item["queue"].cancel_join_thread()
            item["queue"].close()

    def stop(self):
        for item in self.items.values():
            self._close(item)
        self.items.clear()

    def reconcile(self, paused: bool):
        roots = {r["id"]: r for r in self.owner.config["roots"] if r["enabled"]}
        for key in list(self.items):
            item = self.items[key]
            if key not in roots or roots[key]["path"] != item["path"]:
                self._close(item)
                del self.items[key]
        for index, root in enumerate(roots.values()):
            key = root["id"]
            item = self.items.setdefault(key, dict(path=root["path"], state="connecting", events={},
                changed=0, retry=0, failures=0, recovery=True, message=None))
            if paused:
                self._close(item)
                item.update(state="paused", recovery=True, force_scan=True)
                continue
            if index >= MAX_WATCHERS:
                if item["state"] == "reconnecting" and time.monotonic() < item["retry"]:
                    continue
                self._close(item)
                item.update(state="refresh_only", limit=True, message=f"Live monitoring is limited to {MAX_WATCHERS} locations. This location uses refresh-only mode.")
                if item["recovery"]:
                    self._recover(key, item)
                    item.update(recovery=False, force_scan=False)
                continue
            if item.pop("limit", False):
                item.update(state="connecting", retry=0, message=None)
            if item["state"] in ("paused",):
                item.update(state="connecting", retry=0)
            if not item.get("process") and item["state"] != "refresh_only" and time.monotonic() >= item["retry"]:
                messages = self.context.Queue(maxsize=128)
                stop, overflow = self.context.Event(), self.context.Event()
                process = self.context.Process(target=self.worker, args=(root["path"], messages, stop, overflow), daemon=True)
                process.start()
                item.update(process=process, queue=messages, stop=stop, overflow=overflow,
                            heartbeat=time.monotonic(), state="connecting", recovery=True)

    def _recover(self, key, item):
        item["events"].clear()
        item["recovery"] = True
        if key not in self.owner.pending:
            self.owner.pending.append(key)
        self.owner.wake.set()

    def require_recovery(self, key, message):
        item = self.items.get(key)
        if not item:
            return
        self._close(item)
        attempts = item.get("recovery_failures", 0) + 1
        item.update(state="reconnecting", recovery=True, recovery_failures=attempts,
                    force_scan=True,
                    retry=time.monotonic() + min(3600, 30 * 2 ** min(attempts - 1, 7)), message=message)

    def tick(self):
        paused = self.owner.config["paused"] or self.owner._background_paused()
        self.reconcile(paused)
        if paused:
            return
        for key, item in self.items.items():
            process = item.get("process")
            if not process:
                continue
            failed = False
            for _ in range(128):
                try:
                    message = item["queue"].get_nowait()
                except queue.Empty:
                    break
                item["heartbeat"] = time.monotonic()
                kind = message["kind"]
                if kind == "connected":
                    item.update(state="connected", failures=0, message=None)
                    if item["recovery"]:
                        self._recover(key, item)
                        item["recovery"] = False
                elif kind == "unsupported":
                    reason = message.get("message")
                    item.update(state="refresh_only", message=(reason + " " if reason else "") +
                        "Live monitoring is unavailable. This location uses refresh-only mode.")
                    if item["recovery"]:
                        self._recover(key, item)
                        item.update(recovery=False, force_scan=False)
                    failed = True
                elif kind == "failed":
                    failed = True
                elif kind == "changes":
                    if not item["events"]:
                        item["batch_started"] = time.monotonic()
                    for path in message["paths"]:
                        item["events"][path.casefold()] = path
                    item["changed"] = time.monotonic()
            if item["overflow"].is_set() or len(item["events"]) > MAX_EVENTS:
                item["overflow"].clear()
                self._recover(key, item)
                item["message"] = "Some change notifications were lost. Reconciling this location."
            if failed or not process.is_alive() or time.monotonic() - item["heartbeat"] > self.owner.timeout:
                self._close(item)
                if item["state"] != "refresh_only":
                    item["failures"] += 1
                    item.update(state="reconnecting", recovery=True,
                        retry=time.monotonic() + min(3600, 30 * 2 ** min(item["failures"] - 1, 7)),
                        message="Monitoring disconnected. Last known results are retained; reconnecting automatically.")
                    self.owner.catalog.root_state(key, status="offline", message=None)
        states = {s["id"]: s for s in self.owner.catalog.roots(counts=False)}
        for root in self.owner.config["roots"]:
            item = self.items.get(root["id"])
            if item and item["state"] == "refresh_only":
                deadline = refresh_deadline(root, self.owner.config, states.get(root["id"], {}))
                if deadline is not None and time.time() >= deadline:
                    self.owner.refresh(root["id"], due_only=True)

    def can_scan(self, key):
        item = self.items.get(key)
        return item and item["state"] in ("connected", "refresh_only")

    def take_changes(self, key):
        item = self.items.get(key)
        if not item or item["state"] != "connected":
            return []
        if time.monotonic() - item["changed"] < 0.4 and time.monotonic() - item.get("batch_started", 0) < 2:
            return []
        changes = list(item["events"].values())
        item["events"].clear()
        return changes

    def snapshots(self, states):
        roots = {r["id"]: r for r in self.owner.config["roots"]}
        for state in states:
            root = roots.get(state["id"], {})
            item = self.items.get(state["id"], {})
            state["monitor_state"] = item.get("state", "connecting") if root.get("enabled") else "disabled"
            state["monitor_message"] = item.get("message")
            deadline = refresh_deadline(root, self.owner.config, state) if state["monitor_state"] == "refresh_only" else None
            if state["monitor_state"] == "reconnecting":
                deadline = time.time() + max(0, item.get("retry", 0) - time.monotonic())
            state["next_refresh"] = datetime.fromtimestamp(deadline, timezone.utc).isoformat() if deadline else None
        return states
