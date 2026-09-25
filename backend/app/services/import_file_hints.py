"""Optional, header-only hints for files shown in the import browser.

These hints are deliberately separate from import inspection. They never hash,
register, or fully parse a file. For `.xlsx`, the bounded metadata read also
reports whether the workbook matches the supported Neware parser; other hint
failures remain non-blocking.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .lazy_module import LazyModule


def _load_parsing():
    from . import parsing as module

    return module


parsing = LazyModule(_load_parsing)

MAX_HINT_PATHS = 512
MAX_HINT_WORKERS = 4


def _cycle_count_hint(metadata: dict[str, Any]) -> int | None:
    for key in ("cycle_count", "cycles", "n_cycles", "num_cycles"):
        value = metadata.get(key)
        if isinstance(value, bool):
            continue
        try:
            number = int(value)
        except (TypeError, ValueError, OverflowError):
            continue
        if number >= 0:
            return number
    return None


def inspect_header_hint(path_string: str) -> dict[str, object]:
    """Read normalized header metadata only; return a safe per-file outcome."""
    path = Path(path_string).expanduser()
    result: dict[str, object] = {
        "path": str(path),
        "source_format": None,
        "supplier": None,
        "technique": None,
        "cycle_count": None,
        "compatible": None,
        "registered": False,
        "error": None,
    }
    metadata: dict[str, Any] = {}
    try:
        before = path.stat()
        if not path.is_file() or not parsing.source_filename_allowed(path.name):
            raise ValueError("File is no longer a supported source.")
        metadata = parsing.read_header_metadata(path)
        if metadata.get("error"):
            message = metadata.get("error_message") or metadata.get("error")
            raise ValueError(str(message))
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("File changed while its header was being read.")
        ext = path.suffix.casefold()
        if ext == ".xlsx":
            result["compatible"] = True
        biologic = ext == ".mpr"
        result.update(
            source_format=(
                "BioLogic EC-Lab" if biologic
                else "Neware Excel" if ext == ".xlsx"
                else f"Neware {ext.lstrip('.').upper()}"
            ),
            supplier="BioLogic" if biologic else "Neware",
            technique=(str(metadata.get("technique")).strip() or None)
            if metadata.get("technique") is not None else None,
            cycle_count=_cycle_count_hint(metadata),
        )
    except Exception as exc:
        # A negative compatibility result is only justified when the parser
        # explicitly classifies the workbook as unsupported. I/O races,
        # permissions, and malformed-but-recognized exports leave the hint
        # unknown so an optional scan failure cannot hide a selectable file.
        if path.suffix.casefold() == ".xlsx" and metadata.get("error_kind") == "unsupported":
            result["compatible"] = False
        result["error"] = str(exc)[:300] or "Header metadata is unavailable."
    return result


def inspect_header_hints(paths: list[str]) -> list[dict[str, object]]:
    """Inspect a bounded set of paths concurrently while preserving input order."""
    unique_paths = list(dict.fromkeys(paths))
    if len(unique_paths) > MAX_HINT_PATHS:
        raise ValueError(f"Select at most {MAX_HINT_PATHS} files for header hints.")
    if not unique_paths:
        return []
    with ThreadPoolExecutor(max_workers=min(MAX_HINT_WORKERS, len(unique_paths))) as pool:
        return list(pool.map(inspect_header_hint, unique_paths))
