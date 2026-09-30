"""Stoppable discovery process; no scientific parsing, checksums, or DB writes."""
from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

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
