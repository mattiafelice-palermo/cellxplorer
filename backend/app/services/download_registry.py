"""Persistent, disposable history of files the user has exported.

The registry is UX metadata, not scientific data: it only records where an
export was written so the download manager can offer open / reveal / delete.
It is a single JSON file under the app data directory with atomic writes, so
it survives restarts without needing a database migration. Entries whose file
has since moved or been deleted are reported as ``exists: false`` rather than
silently dropped.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from ..config import APP_DATA_DIR

_PATH = APP_DATA_DIR / "downloads-history.json"
_LIMIT = 200
_lock = threading.RLock()

_KIND_BY_SUFFIX = {
    ".png": "image",
    ".svg": "image",
    ".pdf": "document",
    ".csv": "data",
    ".xlsx": "data",
    ".xls": "data",
    ".html": "report",
    ".htm": "report",
}


def kind_for_filename(filename: str) -> str:
    return _KIND_BY_SUFFIX.get(Path(filename).suffix.lower(), "file")


def _read() -> list[dict]:
    if not _PATH.is_file():
        return []
    try:
        value = json.loads(_PATH.read_bytes())
        return value if isinstance(value, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _write(entries: list[dict]) -> None:
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = _PATH.with_name(f"{_PATH.name}.tmp-{uuid.uuid4().hex}")
    try:
        temporary.write_text(json.dumps(entries, ensure_ascii=True), encoding="utf-8")
        os.replace(temporary, _PATH)
    finally:
        temporary.unlink(missing_ok=True)


def _decorate(entry: dict) -> dict:
    path = entry.get("path")
    exists = bool(path) and Path(path).is_file()
    # Entries written before `seen` existed are treated as already seen so an
    # upgrade does not resurrect a large badge count.
    return {**entry, "exists": exists, "seen": bool(entry.get("seen", True))}


def record(*, filename: str, path: str, kind: str | None = None, bytes_: int | None = None) -> dict:
    entry = {
        "id": uuid.uuid4().hex,
        "filename": filename,
        "path": path,
        "kind": kind or kind_for_filename(filename),
        "bytes": int(bytes_) if bytes_ is not None else None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # New downloads count towards the header badge until the user acts on
        # them (opens, reveals, or copies the file).
        "seen": False,
    }
    with _lock:
        entries = _read()
        # Collapse repeat exports to the same path so re-saving a file moves
        # it to the top instead of stacking duplicates. Path-less browser
        # downloads share an empty path and must each keep their own row.
        if path:
            entries = [item for item in entries if item.get("path") != path]
        entries.insert(0, entry)
        del entries[_LIMIT:]
        _write(entries)
    return _decorate(entry)


def list_entries() -> list[dict]:
    with _lock:
        return [_decorate(entry) for entry in _read()]


def delete_entry(entry_id: str, *, delete_file: bool) -> dict:
    removed_file = False
    with _lock:
        entries = _read()
        target = next((item for item in entries if item.get("id") == entry_id), None)
        if target is None:
            return {"removed": False, "deleted_file": False}
        if delete_file and target.get("path"):
            path = Path(target["path"])
            try:
                if path.is_file():
                    path.unlink()
                    removed_file = True
            except OSError:
                removed_file = False
        _write([item for item in entries if item.get("id") != entry_id])
    return {"removed": True, "deleted_file": removed_file}


def mark_seen(entry_id: str) -> bool:
    """Acknowledge one download so it stops counting towards the badge."""
    with _lock:
        entries = _read()
        target = next((item for item in entries if item.get("id") == entry_id), None)
        if target is None:
            return False
        if target.get("seen"):
            return True
        target["seen"] = True
        _write(entries)
        return True


def clear() -> None:
    with _lock:
        _write([])
