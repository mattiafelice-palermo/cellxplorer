"""Windows long-path support for source files, independent of machine policy."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


def source_io_path(value: str | Path) -> Path:
    """Use the extended Win32 spelling only where legacy path limits apply."""
    path = Path(value)
    if os.name != "nt":
        return path
    raw = str(path)
    if raw.startswith(("\\\\?\\", "\\\\.\\")):
        return path
    absolute = raw if path.is_absolute() else os.path.abspath(raw)
    # Leave room for the search pattern added to directory enumeration.
    # Windows counts UTF-16 code units, including surrogate pairs.
    if len(absolute.encode("utf-16-le", errors="surrogatepass")) < 2 * (260 - 12):
        return path
    absolute = os.path.normpath(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def display_source_path(value: str | Path) -> str:
    """Return the ordinary drive/share spelling for picker rows and comparisons."""
    raw = str(value)
    if os.name == "nt":
        if raw[:8].upper() == "\\\\?\\UNC\\":
            return "\\\\" + raw[8:]
        if raw.startswith("\\\\?\\") and raw[5:7] == ":\\":
            return raw[4:]
    return raw


def resolved_source_io_path(value: str | Path, *, strict: bool = False) -> Path:
    # Resolving a mapped drive may produce a longer UNC name.
    return source_io_path(source_io_path(Path(value).expanduser()).resolve(strict=strict))


@lru_cache(maxsize=256)
def _resolved_preview_parent(parent: Path) -> Path:
    return resolved_source_io_path(parent)


def preview_source_io_path(value: str | Path) -> Path:
    """Reuse a resolved name only while the selected path and target still identify the same file."""
    path = source_io_path(Path(value).expanduser())
    if path.is_absolute() and ".." not in path.parts:
        try:
            if not path.is_symlink():
                resolved = source_io_path(_resolved_preview_parent(path.parent) / path.name)
                if path == resolved:
                    return path
                identity = path.stat()
                if identity.st_ino:
                    if os.path.samestat(identity, resolved.stat()):
                        return resolved
                    _resolved_preview_parent.cache_clear()
        except OSError:
            _resolved_preview_parent.cache_clear()
    return resolved_source_io_path(path)
