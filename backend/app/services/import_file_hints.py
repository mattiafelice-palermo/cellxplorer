"""Optional, header-only hints for files shown in the import browser.

These hints are deliberately separate from import inspection. They never
register or fully parse a file. Neware `.xlsx` eligibility uses the structural
record-sheet contract; optional workbook metadata is left to inspection.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import stat as stat_module
from typing import Any

from .lazy_module import LazyModule
from .source_format_errors import SourceFormatError, source_rejection_kind


def _load_parsing():
    from . import parsing as module

    return module


parsing = LazyModule(_load_parsing)

MAX_HINT_PATHS = 512
MAX_HINT_WORKERS = 4
SCREEN_PROCESS_POOL_THRESHOLD = 24
MAX_SCREEN_WORKERS = 8


def screening_worker_count(total_files: int, *, multiprocessing: bool) -> int:
    """Choose a bounded worker count for folder compatibility screening."""
    if total_files <= 1:
        return 1
    cpus = os.cpu_count() or (2 if multiprocessing else 4)
    limit = max(2, cpus - 1) if multiprocessing else max(2, cpus)
    return min(MAX_SCREEN_WORKERS, limit, total_files)


def screen_source_candidate(path_string: str) -> dict[str, object]:
    """Top-level picklable header-only compatibility check for worker pools."""
    return inspect_header_hint(path_string)


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


def _check_permissive_header(path: Path, result: dict[str, object]) -> None:
    """A Safe rejection alone cannot establish whether exploratory voltage is readable."""
    from .biologic_mpr import UnsupportedMprTechnique
    from .source_error_messages import source_error_message

    try:
        before = path.stat()
        try:
            parsing.metadata_for_read_mode(path, {}, "permissive")
        except SourceFormatError as exc:
            if source_rejection_kind(exc) is None:
                return
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                return
            result["permissive_error"] = source_error_message(path, exc)
            if isinstance(exc, UnsupportedMprTechnique):
                result["technique"] = exc.technique_name
    except OSError:
        return


def inspect_header_hint(
    path_string: str,
    *,
    hash_if_size_matches: set[int] | None = None,
) -> dict[str, object]:
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
        from . import source_readability

        rejection = source_readability.known_rejection(path)
        if rejection is not None:
            result.update(compatible=False, error=rejection.error,
                          source_error_kind=rejection.kind, size=rejection.identity.size,
                          mtime_ns=rejection.identity.mtime_ns)
            if path.suffix.casefold() == ".mpr":
                _check_permissive_header(path, result)
            return result
        before = path.stat()
        if not stat_module.S_ISREG(before.st_mode) or not parsing.source_filename_allowed(path.name):
            raise ValueError("File is no longer a supported source.")
        ext = path.suffix.casefold()
        if ext == ".xlsx":
            # Picker eligibility is structural. Do not open Calamine or read
            # workbook metadata here: on large Neware exports those optional
            # sheets can take hundreds of milliseconds while the user is
            # waiting for the row to become selectable.
            from . import neware_excel

            try:
                neware_excel.validate_supported_workbook(path)
            except neware_excel.UnsupportedNewareExcelError:
                result["compatible"] = False
                raise
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError("File changed while its header was being read.")
            if hash_if_size_matches and before.st_size in hash_if_size_matches:
                result["_hash"] = parsing.compute_hash(path).lower()
            result.update(
                source_format="Neware Excel",
                supplier="Neware",
                compatible=True,
            )
            return result
        metadata = parsing.read_header_metadata(
            path,
        )
        if metadata.get("error"):
            message = metadata.get("error_message") or metadata.get("error")
            raise ValueError(str(message))
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("File changed while its header was being read.")
        if hash_if_size_matches and before.st_size in hash_if_size_matches:
            result["_hash"] = parsing.compute_hash(path).lower()
        if ext in {".xlsx", ".mpr"}:
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
        if path.suffix.casefold() in {".xlsx", ".mpr"} and metadata.get("error_kind") in {"unsupported", "invalid"}:
            result["compatible"] = False
            result["source_error_kind"] = metadata["error_kind"]
            if metadata.get("permissive_error"):
                result.update(permissive_error=metadata["permissive_error"], technique=metadata.get("technique"))
            elif path.suffix.casefold() == ".mpr":
                _check_permissive_header(path, result)
        result["error"] = str(exc)[:300] or "Header metadata is unavailable."
    return result


def inspect_header_hints(
    paths: list[str],
    *,
    hash_sizes: set[int] | None = None,
) -> list[dict[str, object]]:
    """Inspect a bounded set of paths concurrently while preserving input order."""
    unique_paths = list(dict.fromkeys(paths))
    if len(unique_paths) > MAX_HINT_PATHS:
        raise ValueError(f"Select at most {MAX_HINT_PATHS} files for header hints.")
    if not unique_paths:
        return []
    with ThreadPoolExecutor(max_workers=min(MAX_HINT_WORKERS, len(unique_paths))) as pool:
        if not hash_sizes:
            return list(pool.map(inspect_header_hint, unique_paths))
        return list(pool.map(
            lambda path: inspect_header_hint(path, hash_if_size_matches=hash_sizes),
            unique_paths,
        ))
