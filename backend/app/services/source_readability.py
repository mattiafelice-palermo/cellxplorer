"""Bounded process-local knowledge of confirmed canonical source rejection.

Only adapter SourceFormatError outcomes belong here. A failed cache write,
network request, cancelled preview or absence of complete cycles is not a source
rejection. Cheap header inspection remains header-only, but cannot contradict a
semantic rejection already established for this exact on-disk identity.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import os
from pathlib import Path
import threading

from .source_format_errors import SourceFormatError, UnsupportedSourceFormatError

MAX_REJECTIONS = 1024


@dataclass(frozen=True)
class FileIdentity:
    path: str
    size: int
    mtime_ns: int
    ctime_ns: int
    inode: int


@dataclass(frozen=True)
class SourceRejection:
    identity: FileIdentity
    error: str
    kind: str


_rejections: OrderedDict[str, SourceRejection] = OrderedDict()
_lock = threading.Lock()


def _key(path: str | Path) -> str:
    return os.path.normcase(os.path.abspath(path))


def file_identity(path: str | Path) -> FileIdentity | None:
    try:
        stat = Path(path).stat()
        return FileIdentity(_key(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino)
    except (OSError, ValueError):
        return None


def remember_rejection(path: str | Path, before: FileIdentity | None, error: SourceFormatError) -> None:
    if not isinstance(error, SourceFormatError) or before is None or file_identity(path) != before:
        return
    value = SourceRejection(before, str(error).strip()[:1000] or "This source cannot be read.",
                            "unsupported" if isinstance(error, UnsupportedSourceFormatError) else "invalid")
    with _lock:
        _rejections[before.path] = value
        _rejections.move_to_end(before.path)
        while len(_rejections) > MAX_REJECTIONS:
            _rejections.popitem(last=False)


def known_rejection(path: str | Path) -> SourceRejection | None:
    key = _key(path)
    with _lock:
        value = _rejections.get(key)
    # Most calls take no extra stat, including large indexed search pages.
    if value is None:
        return None
    if file_identity(path) != value.identity:
        with _lock:
            if _rejections.get(key) is value:
                _rejections.pop(key, None)
        return None
    return value


def clear_success(path: str | Path, identity: FileIdentity | None) -> None:
    with _lock:
        value = _rejections.get(_key(path))
        if value is not None and value.identity == identity:
            _rejections.pop(value.identity.path, None)


def clear() -> None:
    with _lock:
        _rejections.clear()
