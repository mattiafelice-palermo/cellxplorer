"""Stoppable discovery process; no scientific parsing, checksums, or DB writes."""
from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
import stat as stat_module
import time

from .import_search_transport import BatchSpool
from .import_search_catalog import METADATA_FIELDS, METADATA_VERSION, path_key


def canonical_root(path: str) -> str:
    # Resolve mapped drives once here, never on the query/request thread.
    if os.name == "nt" and not path.startswith("\\\\"):
        import ctypes
        from ctypes import wintypes
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_string_buffer(size.value)
        if ctypes.windll.mpr.WNetGetUniversalNameW(path, 1, buffer, ctypes.byref(size)) == 0:
            return ctypes.cast(buffer, ctypes.POINTER(wintypes.LPWSTR))[0]
    return path


def inspect_fact(fact: dict, metadata_enabled: bool) -> dict:
    from . import neware_excel, parsing
    fact = dict(fact)
    fact["metadata"] = {}
    fact["metadata_version"] = 0
    try:
        if fact["extension"] == ".xlsx":
            try:
                neware_excel.validate_supported_workbook(fact["path"])
            except neware_excel.UnsupportedNewareExcelError:
                fact.update(recognition="unsupported", metadata_state="unavailable")
        if fact["recognition"] != "unsupported":
            fact["recognition"] = "recognized"
        if metadata_enabled and fact["recognition"] != "unsupported":
            header = parsing.read_header_metadata(fact["path"], fast_excel_hint=True)
            if header.get("error"):
                if header.get("error_kind") == "unsupported":
                    fact["recognition"] = "unsupported"
                fact["metadata_state"] = "unavailable"
            else:
                fact["metadata"] = {key: str(header[key])[:512] for key in METADATA_FIELDS
                                    if header.get(key) is not None and isinstance(header[key], (str, int, float))}
                fact["metadata_state"] = "ready"
                fact["metadata_version"] = METADATA_VERSION
        elif fact["recognition"] != "unsupported":
            fact["metadata_state"] = "disabled"
        after = os.stat(fact["path"])
        if (after.st_size, after.st_mtime_ns) != (fact["size"], fact["mtime_ns"]):
            # Live source changes must end in a visible retry state, not pending.
            fact.update(recognition="pending" if fact["extension"] == ".xlsx" else "recognized",
                        metadata_state="unavailable", metadata={}, metadata_version=0)
    except Exception:
        # A transient I/O error must not label a workbook unsupported.
        fact.update(recognition="pending" if fact["extension"] == ".xlsx" else "recognized",
                    metadata_state="unavailable", metadata={}, metadata_version=0)
    return fact


def scan_root(root: dict, config: dict, catalog_path: str, spool_path: str) -> None:
    """Only this process can block on a network path. Parent can terminate it."""
    # Bulk failures must not flood logs with private paths. This process is isolated.
    logging.disable(logging.CRITICAL)
    messages = BatchSpool(spool_path)
    resolved = canonical_root(root["path"])
    messages.put({"kind": "root", "canonical_root": path_key(resolved)})
    previous = sqlite3.connect(f"file:{Path(catalog_path).as_posix()}?mode=ro", uri=True)
    previous.row_factory = sqlite3.Row
    stack = [] if "resume_after" in root else [root["path"]]
    complete = True
    discovered = 0
    warnings = 0
    root_error = None
    batch: list[dict] = []

    def publish():
        nonlocal batch, warnings
        if not batch:
            return
        messages.put({"kind": "batch", "facts": batch, "discovered": discovered})
        batch = []

    try:
        try:
            root_info = os.lstat(root["path"])
            if stat_module.S_ISLNK(root_info.st_mode) or getattr(root_info, "st_file_attributes", 0) & 0x400:
                stack = []
                complete = False
                root_error = "This location is a link or junction. Choose the original folder instead."
        except OSError:
            pass  # Traversal below produces the existing friendly outage message.
        while stack:
            directory = stack.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            stat = entry.stat(follow_symlinks=False)
                            if entry.is_symlink() or getattr(stat, "st_file_attributes", 0) & 0x400:
                                continue  # Do not follow Windows junctions/reparse points.
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                                continue
                            extension = Path(entry.name).suffix.casefold()
                            if extension not in config["formats"] or not entry.is_file(follow_symlinks=False):
                                continue
                            relative = os.path.relpath(entry.path, root["path"])
                            key = path_key(os.path.join(resolved, relative))
                            fact = dict(canonical=key, path=entry.path, name=entry.name, extension=extension,
                                        size=stat.st_size, mtime_ns=stat.st_mtime_ns,
                                        modified_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                                        recognition="pending" if extension == ".xlsx" else "recognized",
                                        metadata_state="pending" if config["metadata_enabled"] else "disabled",
                                        metadata_version=0, metadata={}, supplier="BioLogic" if extension == ".mpr" else "Neware")
                            old = previous.execute("SELECT * FROM entries WHERE canonical=?", (key,)).fetchone()
                            if old and old["size"] == stat.st_size and old["mtime_ns"] == stat.st_mtime_ns and old["recognition"] != "pending" and (
                                not config["metadata_enabled"] or old["metadata_version"] == METADATA_VERSION and old["metadata_state"] == "ready"
                            ):
                                fact.update(recognition=old["recognition"], metadata_state=old["metadata_state"],
                                            metadata=json.loads(old["metadata_json"]), metadata_version=old["metadata_version"])
                            batch.append(fact)
                            discovered += 1
                            if len(batch) >= 128:
                                publish()
                        except OSError:
                            complete = False
                messages.put({"kind": "progress", "discovered": discovered})
            except OSError as exc:
                complete = False
                if directory == root["path"]:
                    root_error = ("This folder is missing or disconnected. Reconnect the drive or choose another location, then refresh."
                        if isinstance(exc, FileNotFoundError) else
                        "Access to this folder was denied. Check your permissions, then refresh." if isinstance(exc, PermissionError) else
                        "This location could not be reached. Check the drive or network connection, then refresh.")
        publish()
        if "resume_after" not in root:
            messages.put({"kind": "traversed", "complete": complete, "discovered": discovered, "root_error": root_error})
            # Parent acknowledges publishing before the enrichment query. This
            # is local IPC; all filenames are visible before any slow header.
            acknowledgement = Path(spool_path) / "traversal.ack"
            import time
            while not acknowledgement.exists():
                time.sleep(0.02)
        rows = previous.execute("""SELECT e.* FROM entries e JOIN memberships m ON m.canonical=e.canonical
            WHERE m.root_id=? AND m.generation=? AND e.canonical>? AND e.recognition!='unsupported'
            AND (e.recognition='pending' OR (? AND (e.metadata_state!='ready' OR e.metadata_version!=?)))
            ORDER BY e.canonical""", (root["id"], root["generation"], root.get("resume_after", ""), config["metadata_enabled"], METADATA_VERSION))
        for row in rows:
            fact = dict(row)
            fact["metadata"] = json.loads(fact.pop("metadata_json"))
            messages.put({"kind": "header", "fact": fact})
            fact = inspect_fact(fact, config["metadata_enabled"])
            warnings += fact["metadata_state"] == "unavailable" and fact["recognition"] != "unsupported"
            messages.put({"kind": "batch", "facts": [fact]})
        messages.put({"kind": "done", "warnings": warnings})
    finally:
        previous.close()


def scan_changes(root: dict, config: dict, catalog_path: str, spool_path: str) -> None:
    """Inspect changed scopes only. Ambiguous access/unstable writes request recovery.

    Notifications are hints: confirm current filesystem state, never assume an event
    proves deletion. All I/O remains inside the parent's bounded, stoppable worker.
    """
    logging.disable(logging.CRITICAL)
    messages = BatchSpool(spool_path)
    resolved = canonical_root(root["path"])
    base = os.path.abspath(root["path"])
    recovered = False

    def key(path):
        return path_key(os.path.join(resolved, os.path.relpath(path, base)))

    def safe_path(path):
        if os.path.commonpath((base, path)) != base:
            raise OSError("Changed path is outside the location")
        # A notification can include descendants of a newly introduced junction.
        relative = os.path.relpath(path, base)
        current = base
        for part in relative.split(os.sep):
            current = os.path.join(current, part)
            try:
                value = os.lstat(current)
            except FileNotFoundError:
                return False
            if stat_module.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400:
                if current != path:
                    raise OSError("Changed path crosses a reparse point")
                return False
        return True

    def stable_fact(path, value, observed=None):
        extension = Path(path).suffix.casefold()
        if extension not in config["formats"]:
            return None
        # Wait for two equal size/mtime samples; recheck after header extraction too.
        observed = time.monotonic() if observed is None else observed
        for _ in range(12):
            # Subtree discovery takes first samples for <=128 files together.
            # One shared settling interval replaces a 250ms-per-file floor.
            time.sleep(max(0, 0.25 - (time.monotonic() - observed)))
            after = os.stat(path, follow_symlinks=False)
            if not stat_module.S_ISREG(after.st_mode) or getattr(after, "st_file_attributes", 0) & 0x400:
                raise OSError("Source type changed during inspection")
            if (value.st_size, value.st_mtime_ns) == (after.st_size, after.st_mtime_ns):
                break
            value = after
            observed = time.monotonic()
        else:
            raise OSError("Source is still being written")
        fact = dict(canonical=key(path), path=path, name=Path(path).name, extension=extension,
            size=value.st_size, mtime_ns=value.st_mtime_ns,
            modified_at=datetime.fromtimestamp(value.st_mtime, timezone.utc).isoformat(),
            recognition="pending" if extension == ".xlsx" else "recognized", metadata={}, metadata_version=0,
            metadata_state="pending" if config["metadata_enabled"] else "disabled",
            supplier="BioLogic" if extension == ".mpr" else "Neware")
        return fact

    def enrich(fact):
        nonlocal recovered
        if fact["extension"] != ".xlsx" and not config["metadata_enabled"]:
            return None  # No header work or duplicate publication.
        path = fact["path"]
        try:
            info = os.stat(path, follow_symlinks=False)
            if not stat_module.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise OSError("Source type changed before header read")
        except FileNotFoundError:
            pass  # The normal post-read absence check confirms accessible deletion.
        # Renew the coordinator's watchdog for each header. A large batch of
        # productive reads must not look like one stalled network operation.
        messages.put(dict(kind="header", canonical=fact["canonical"]))
        result = inspect_fact(fact, config["metadata_enabled"])
        if result["metadata_state"] == "unavailable" and result["recognition"] != "unsupported":
            try:
                after = os.stat(path, follow_symlinks=False)
                # Failed parsing of an unchanged known source is a visible metadata
                # warning, not evidence that notifications for the root were lost.
                recovered |= (after.st_size, after.st_mtime_ns) != (fact["size"], fact["mtime_ns"])
            except FileNotFoundError:
                with os.scandir(os.path.dirname(path)) as entries:
                    present = any(entry.name.casefold() == Path(path).name.casefold() for entry in entries)
                if not present:
                    messages.put(dict(kind="remove", canonical=key(path)))
                    return None  # File renamed after filename publication; retain the subscription.
                recovered = True
            except OSError:
                recovered = True
        return result

    scopes = sorted({os.path.abspath(os.path.join(base, name)) for name in root["changes"]}, key=len)
    completed = []
    for scope in scopes:
        if any(scope == parent or scope.startswith(parent + os.sep) for parent in completed):
            continue
        try:
            if not safe_path(scope):
                # Missing target is only a deletion if its parent can be enumerated.
                with os.scandir(os.path.dirname(scope)) as entries:
                    present = any(entry.name.casefold() == Path(scope).name.casefold() for entry in entries)
                if present:
                    # Reparse point: remove any older indexed subtree without following it.
                    value = os.lstat(scope)
                    if not (stat_module.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400):
                        raise OSError("Source changed during inspection")
                messages.put(dict(kind="remove", canonical=key(scope)))
                completed.append(scope)
                continue
            value = os.stat(scope, follow_symlinks=False)
            if not stat_module.S_ISDIR(value.st_mode):
                fact = stable_fact(scope, value)
                if fact:
                    messages.put(dict(kind="batch", facts=[fact]))
                    result = enrich(fact)
                    if result:
                        messages.put(dict(kind="batch", facts=[result]))
                messages.put(dict(kind="subtree", canonical=key(scope)))
                continue
            stack = [scope]
            pending_files = []
            def flush_files():
                facts = [stable_fact(path, value, observed) for path, value, observed in pending_files]
                pending_files.clear()
                if facts:
                    # Publish a bounded filename batch before reading any headers.
                    # Batch catalog transactions as well as the settling interval.
                    messages.put(dict(kind="batch", facts=facts))
                    results = []
                    published = time.monotonic()
                    for fact in facts:
                        result = enrich(fact)
                        if result:
                            results.append(result)
                        if results and (len(results) >= 16 or time.monotonic() - published >= 0.5):
                            messages.put(dict(kind="batch", facts=results))
                            results = []
                            published = time.monotonic()
                    if results:
                        messages.put(dict(kind="batch", facts=results))
            while stack:
                with os.scandir(stack.pop()) as entries:
                    for entry in entries:
                        value = entry.stat(follow_symlinks=False)
                        if entry.is_symlink() or getattr(value, "st_file_attributes", 0) & 0x400:
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.casefold() in config["formats"]:
                            pending_files.append((entry.path, value, time.monotonic()))
                            if len(pending_files) >= 128:
                                flush_files()
            flush_files()
            # Avoid an unbounded IPC message for large directory additions.
            # Facts already have this generation; subtree completion is handled by
            # parent comparison against streamed canonical keys.
            messages.put(dict(kind="subtree", canonical=key(scope)))
            completed.append(scope)
        except (OSError, ValueError):
            recovered = True
    messages.put(dict(kind="done", recovery=recovered))
