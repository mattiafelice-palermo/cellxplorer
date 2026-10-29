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
_aliases: dict[str, str] = {}
_rejection_aliases: dict[str, set[str]] = {}
_lock = threading.Lock()


def _key(path: str | Path) -> str:
    return os.path.normcase(os.path.abspath(path))


def file_identity(path: str | Path) -> FileIdentity | None:
    try:
        resolved = Path(path).expanduser().resolve(strict=True)
        stat = resolved.stat()
        return FileIdentity(_key(resolved), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino)
    except (OSError, RuntimeError, ValueError):
        return None


def _drop_rejection_locked(path_key: str) -> None:
    _rejections.pop(path_key, None)
    for alias in _rejection_aliases.pop(path_key, set()):
        if _aliases.get(alias) == path_key:
            _aliases.pop(alias, None)


def _forget_alias_locked(alias: str) -> None:
    path_key = _aliases.pop(alias, None)
    if path_key is None:
        return
    aliases = _rejection_aliases.get(path_key)
    if aliases is None:
        return
    aliases.discard(alias)
    if not aliases:
        _drop_rejection_locked(path_key)


def _remember_alias_locked(alias: str, path_key: str) -> None:
    previous = _aliases.get(alias)
    if previous is not None and previous != path_key:
        _forget_alias_locked(alias)
    _aliases[alias] = path_key
    _rejection_aliases.setdefault(path_key, set()).add(alias)


def remember_rejection(path: str | Path, before: FileIdentity | None, error: SourceFormatError) -> None:
    if not isinstance(error, SourceFormatError) or before is None or file_identity(path) != before:
        return
    value = SourceRejection(before, str(error).strip()[:1000] or "This source cannot be read.",
                            "unsupported" if isinstance(error, UnsupportedSourceFormatError) else "invalid")
    with _lock:
        _drop_rejection_locked(before.path)
        _rejections[before.path] = value
        _rejections.move_to_end(before.path)
        _rejection_aliases[before.path] = set()
        # Keep the caller's cheap lexical lookup and the resolved identity key
        # together. No alias resolution is needed for an unrelated lookup miss.
        _remember_alias_locked(before.path, before.path)
        _remember_alias_locked(_key(path), before.path)
        while len(_rejections) > MAX_REJECTIONS:
            oldest, _ = next(iter(_rejections.items()))
            _drop_rejection_locked(oldest)


def known_rejection(path: str | Path) -> SourceRejection | None:
    key = _key(path)
    with _lock:
        path_key = _aliases.get(key)
        value = _rejections.get(path_key) if path_key is not None else None
    # Most calls take no extra stat, including large indexed search pages.
    if value is None:
        return None
    current = file_identity(path)
    with _lock:
        # Another parse may have replaced this entry or rebound the lexical
        # alias while identity was checked outside the lock.
        if _aliases.get(key) != path_key or _rejections.get(path_key) is not value:
            return None
        if current != value.identity:
            _drop_rejection_locked(path_key)
            return None
        _rejections.move_to_end(path_key)
    return value


def clear_success(path: str | Path, identity: FileIdentity | None) -> None:
    if identity is None:
        return
    with _lock:
        # The resolved identity is authoritative even when this successful
        # parse used a new lexical alias that was never recorded as a rejection.
        path_key = identity.path
        value = _rejections.get(path_key)
        if value is None or value.identity != identity:
            path_key = _aliases.get(_key(path))
            value = _rejections.get(path_key) if path_key is not None else None
        if value is not None and value.identity == identity:
            _drop_rejection_locked(path_key)


def clear() -> None:
    with _lock:
        _rejections.clear()
        _aliases.clear()
        _rejection_aliases.clear()
