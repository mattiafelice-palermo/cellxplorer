"""Parquet cache, keyed by (file hash, parser version, calc version).

Caches are regenerable artifacts, never user-facing entities. A successfully
updated source replaces its old content-addressed directory; derived analysis
results use their own checksum keys and expire through the analysis LRU.

Layout:  CACHE_DIR/<hash[:2]>/<hash>/raw__p<parser>.parquet
         CACHE_DIR/<hash[:2]>/<hash>/raw_index__p<parser>__l<layout>.json
         CACHE_DIR/<hash[:2]>/<hash>/cycles__p<parser>__c<calc>.parquet
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import threading
import time
import uuid
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ..config import CACHE_DIR, CALC_VERSION
from . import calc, canonical_cycling, parsing, time_capacity_derived

logger = logging.getLogger(__name__)


# This is a physical access-layout generation, not a scientific meaning or
# calculation version.  A current raw file without this sidecar remains a
# valid legacy cache and uses the existing full-read API.
RAW_CACHE_LAYOUT_VERSION = 1

# Chosen from the Spec 050.2 profiling pass on the approved golden source
# `cycles_time_steps.ndax` (71,190 rows, 193 observed cycles) under the pinned
# pyarrow 24.0.0 runtime.  This is deliberately a bounded storage parameter,
# not a scientific constant and not part of any analysis cache key.
RAW_CACHE_ROW_GROUP_SIZE = 4096

# This is a regenerable prepared-derived representation generation, not a
# scientific calculation version.  Its identity is validated against the
# parser, CALC_VERSION, canonical raw contract and active raw physical layout.
TIME_CAPACITY_DERIVED_CACHE_VERSION = 1


class RawLayoutError(ValueError):
    """The raw Parquet/index pair cannot safely support selective access."""


@dataclass
class RawCycleReadDiagnostics:
    """Optional deterministic evidence for one selective raw read."""

    status: str = "uninitialized"
    requested_cycles: tuple[int, ...] = ()
    row_groups_read: tuple[int, ...] = ()
    row_groups_total: int = 0
    rows_read: int = 0
    rows_returned: int = 0
    columns_read: tuple[str, ...] = ()
    columns_returned: tuple[str, ...] = ()


@dataclass
class TimeCapacityDerivedReadDiagnostics:
    """Optional bounded evidence for one prepared-derived selective read."""

    status: str = "uninitialized"
    requested_cycles: tuple[int, ...] = ()
    row_groups_read: tuple[int, ...] = ()
    row_groups_total: int = 0
    rows_read: int = 0
    rows_returned: int = 0
    columns_read: tuple[str, ...] = ()


# Conversion publishes the raw file and its index as one in-process critical
# section.  Readers take the same lock between validating the sidecar and
# reading row groups so an index cannot be paired with a replacement raw file.
_raw_layout_io_lock = threading.RLock()


@contextmanager
def _raw_layout_access(*, wait: bool):
    """Acquire the raw/index consistency boundary, optionally without waiting."""
    acquired = _raw_layout_io_lock.acquire(blocking=wait)
    if not acquired:
        yield False
        return
    try:
        yield True
    finally:
        _raw_layout_io_lock.release()


class SourceChangedDuringBuild(parsing.SourceIdentityError):
    """The source changed while a scientific cache was being built."""


def _resolve_source_fingerprint(
    source_path: str | Path,
    file_hash: str,
    expected: parsing.SourceFingerprint | None,
) -> parsing.SourceFingerprint | None:
    """Resolve or validate the source identity used by one cache build."""
    if expected is not None:
        if expected.hash.casefold() != file_hash.casefold():
            raise SourceChangedDuringBuild(
                "Cache source identity does not match the supplied content hash."
            )
        try:
            current = parsing.capture_source_fingerprint(
                source_path,
                expected_hash=file_hash,
            )
        except parsing.SourceIdentityError as exc:
            raise SourceChangedDuringBuild(str(exc)) from exc
        if current != expected:
            raise SourceChangedDuringBuild(
                "Cache source identity changed before the build started."
            )
        return current
    try:
        Path(source_path).stat()
    except OSError:
        # Existing unit tests use synthetic paths with mocked parsers. Real
        # import/scan/preview paths always supply a regular file here.
        return None
    try:
        return parsing.capture_source_fingerprint(source_path, expected_hash=file_hash)
    except parsing.SourceIdentityError as exc:
        raise SourceChangedDuringBuild(str(exc)) from exc


def _require_source_fingerprint(
    source_path: str | Path,
    expected: parsing.SourceFingerprint | None,
) -> None:
    if expected is None:
        return
    try:
        parsing.assert_source_fingerprint(source_path, expected, verify_hash=False)
    except parsing.SourceIdentityError as exc:
        raise SourceChangedDuringBuild(
            f"{exc}; the cache was not published."
        ) from exc

# background (write-behind) cache writes, keyed by file hash — see
# build_write_behind(). Everything that reads or rebuilds a cache waits on
# any in-flight write for that hash first.
_pending_lock = threading.Lock()
_pending: dict[str, threading.Thread] = {}
_protected_hashes: set[str] = set()

# Continuation inspection can be repeated while a source cache is preparing. Keep
# those builds on one process-local, content/version keyed path so repeated reads
# do not parse and write the same source concurrently.
BACKGROUND_BUILD_RETRY_DELAY_SECONDS = 5.0
_background_build_lock = threading.Lock()
_background_builds: dict[tuple[str, str, str], threading.Thread] = {}
_background_build_failures: dict[tuple[str, str, str], tuple[float, str]] = {}


# A cache write is seconds of work, so anything approaching this bound means the
# owner is wedged. Waiting forever turns that into a background job that never
# finishes and a progress count frozen mid-import, which is far worse than
# proceeding: a reader that finds no cache rebuilds it, and `_write_atomic`
# publishes through `os.replace`, so a partial file is never observable.
CACHE_WAIT_TIMEOUT_SECONDS = 300.0


def _wait_for_pending(file_hash: str, timeout: float = CACHE_WAIT_TIMEOUT_SECONDS) -> None:
    with _pending_lock:
        thread = _pending.get(file_hash)
    # The write-behind owner may publish optional derived data from its own
    # in-memory frame before clearing the pending marker.  It must not join
    # itself, while external readers/builders still wait for the complete
    # raw/cycle/derived publication boundary.
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout)
        if thread.is_alive():
            logger.warning(
                "timed out waiting %.0fs for the cache write of %s; continuing",
                timeout,
                file_hash[:12],
            )


@contextmanager
def _cleanup_delete_boundary(
    file_hash: str,
    timeout: float = CACHE_WAIT_TIMEOUT_SECONDS,
):
    """Serialize one checksum-directory deletion with live cache protection.

    The pending/protected set is only a snapshot when read by maintenance
    callers.  Holding the same lock through the final directory deletion
    closes the gap between that snapshot and a converter acquiring
    ``protect_hash_from_cleanup``.
    """
    deadline = time.monotonic() + timeout
    while True:
        _wait_for_pending(file_hash, timeout=max(0.0, deadline - time.monotonic()))
        with _pending_lock:
            active = file_hash in _pending or file_hash in _protected_hashes
            if not active:
                # A converter that starts after this point waits for the lock
                # and therefore cannot observe a half-deleted directory.
                yield
                return
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"Timed out waiting for cache protection to release {file_hash[:12]}"
            )
        time.sleep(0.05)


def wait_for_pending(file_hash: str) -> None:
    """Block until any in-flight background cache write for this hash is
    done. Needed before handing work to OTHER processes (which cannot see
    this process's write threads); in-process readers wait automatically."""
    _wait_for_pending(file_hash)


def pending_hashes() -> set[str]:
    """Return hashes whose Parquet files are currently being written."""
    with _pending_lock:
        return set(_pending) | set(_protected_hashes)


def schedule_build(file_hash: str, source_path: str | Path) -> dict[str, str | None]:
    """Start at most one current-version cache build for ``file_hash``.

    The result status is ``ready``, ``building``, ``started``, or ``failed``.
    Failed builds are retryable after a short cooldown so a repeated inspection
    cannot create a tight retry loop.

    Deduplication (Spec 040.3) keys on this SOURCE's own effective parser
    identity, not the transitional global bundle: two different formats that
    happen to share a content hash (astronomically unlikely, but not
    forbidden) must not collide on one dedup slot merely because a single
    global version used to be assumed.
    """
    try:
        parser_identity = parsing.parser_identity(source_path)
    except Exception:
        # Unrecognized/unreadable source: fall back to the legacy bundle for
        # the dedup key so behavior degrades to "attempt exactly one build",
        # matching pre-040.3 behavior. `build()` below still raises the real
        # error for the caller.
        parser_identity = parsing.PARSER_VERSION
    key = (file_hash, parser_identity, CALC_VERSION)
    if raw_path(file_hash, parser_identity).is_file() and cycles_path(
        file_hash, parser_identity, CALC_VERSION
    ).is_file():
        return {"status": "ready", "error": None}

    now = time.monotonic()
    with _background_build_lock:
        existing = _background_builds.get(key)
        if existing is not None:
            if existing.is_alive():
                return {"status": "building", "error": None}
            _background_builds.pop(key, None)

        failure = _background_build_failures.get(key)
        if failure is not None:
            failed_at, error = failure
            if now - failed_at < BACKGROUND_BUILD_RETRY_DELAY_SECONDS:
                return {"status": "failed", "error": error}
            _background_build_failures.pop(key, None)

        def _worker() -> None:
            try:
                build(file_hash, source_path)
            except Exception as exc:
                error = str(exc) or exc.__class__.__name__
                with _background_build_lock:
                    _background_build_failures[key] = (time.monotonic(), error)
                logger.exception("background cache build failed for %s", file_hash[:8])
            else:
                with _background_build_lock:
                    _background_build_failures.pop(key, None)
            finally:
                with _background_build_lock:
                    _background_builds.pop(key, None)

        thread = threading.Thread(
            target=_worker,
            daemon=True,
            name=f"cache-build-{file_hash[:8]}",
        )
        _background_builds[key] = thread
        thread.start()
    return {"status": "started", "error": None}


@contextmanager
def protect_hash_from_cleanup(file_hash: str):
    """Keep category cleanup away from a synchronous cache build."""
    with _pending_lock:
        _protected_hashes.add(file_hash)
    try:
        yield
    finally:
        with _pending_lock:
            _protected_hashes.discard(file_hash)


def remove_hash_cache(file_hash: str, *, cache_dir: Path | None = None) -> int:
    """Remove one obsolete content-addressed cache after its replacement is durable."""
    if re.fullmatch(r"[0-9a-fA-F]{64}", file_hash) is None:
        raise ValueError("Invalid source checksum")
    root = CACHE_DIR if cache_dir is None else Path(cache_dir)
    directory = root / file_hash[:2] / file_hash
    with _cleanup_delete_boundary(file_hash):
        if not directory.exists():
            return 0
        removed = sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())
        shutil.rmtree(directory)
        if directory.exists():
            raise OSError(f"Cache directory could not be removed: {directory}")
        return removed


def _touch(path: Path) -> None:
    try:
        os.utime(path, None)
    except OSError:
        pass


def _write_raw_parquet(df: pd.DataFrame, path: Path) -> None:
    """Write the canonical raw frame with deliberate bounded row groups."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(
        table,
        path,
        compression="snappy",
        row_group_size=RAW_CACHE_ROW_GROUP_SIZE,
    )


def _write_atomic(df: pd.DataFrame, path: Path) -> None:
    """Write parquet via temp file + os.replace so concurrent readers never
    see a partially written cache."""
    # Callers normally create the checksum directory before starting a build,
    # but a cache cleanup can remove an empty/stale directory between that
    # check and this write.  Recreate it at the final write boundary so every
    # atomic cache artifact remains self-contained.
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the staging basename independent of the target name.  Optimized raw
    # publication already uses a candidate target, and repeating that long
    # name here can exceed Windows' legacy path limit in temporary worktrees.
    tmp = path.with_name(f".{uuid.uuid4().hex}.tmp")
    try:
        if path.name.startswith("raw__"):
            _write_raw_parquet(df, tmp)
        else:
            df.to_parquet(tmp, index=False)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _safe(v: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", v)


def _dir(file_hash: str) -> Path:
    return CACHE_DIR / file_hash[:2] / file_hash


def raw_path(file_hash: str, parser_version: str = parsing.PARSER_VERSION) -> Path:
    return _dir(file_hash) / f"raw__p{_safe(parser_version)}.parquet"


def raw_index_path(
    file_hash: str,
    parser_version: str = parsing.PARSER_VERSION,
    layout_version: int = RAW_CACHE_LAYOUT_VERSION,
) -> Path:
    return _dir(file_hash) / (
        f"raw_index__p{_safe(parser_version)}__l{int(layout_version)}.json"
    )


def time_capacity_derived_path(
    file_hash: str,
    parser_version: str = parsing.PARSER_VERSION,
    calc_version: str = CALC_VERSION,
    derived_version: int = TIME_CAPACITY_DERIVED_CACHE_VERSION,
    layout_version: int = RAW_CACHE_LAYOUT_VERSION,
) -> Path:
    return _dir(file_hash) / (
        "time_capacity_derived__"
        f"p{_safe(parser_version)}__c{_safe(calc_version)}__d{int(derived_version)}"
        f"__l{int(layout_version)}.parquet"
    )


def time_capacity_derived_index_path(
    file_hash: str,
    parser_version: str = parsing.PARSER_VERSION,
    calc_version: str = CALC_VERSION,
    derived_version: int = TIME_CAPACITY_DERIVED_CACHE_VERSION,
    layout_version: int = RAW_CACHE_LAYOUT_VERSION,
) -> Path:
    return _dir(file_hash) / (
        "time_capacity_derived_index__"
        f"p{_safe(parser_version)}__c{_safe(calc_version)}__d{int(derived_version)}"
        f"__l{int(layout_version)}.json"
    )


def cycles_path(
    file_hash: str,
    parser_version: str = parsing.PARSER_VERSION,
    calc_version: str = CALC_VERSION,
) -> Path:
    return _dir(file_hash) / f"cycles__p{_safe(parser_version)}__c{_safe(calc_version)}.parquet"


def has_cycles(file_hash: str, parser_version: str, calc_version: str) -> bool:
    return cycles_path(file_hash, parser_version, calc_version).exists()


def _raw_shape_fingerprint(
    *,
    raw_row_count: int,
    raw_column_names: list[str],
    row_group_counts: list[int],
    raw_file_size: int,
) -> str:
    value = {
        "raw_row_count": int(raw_row_count),
        "raw_column_names": list(raw_column_names),
        "row_group_counts": [int(count) for count in row_group_counts],
        "raw_file_size": int(raw_file_size),
    }
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _derived_shape_fingerprint(
    *,
    row_count: int,
    column_names: list[str],
    row_group_counts: list[int],
    file_size: int,
) -> str:
    value = {
        "row_count": int(row_count),
        "column_names": list(column_names),
        "row_group_counts": [int(count) for count in row_group_counts],
        "file_size": int(file_size),
    }
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _derived_paths_for_parser(file_hash: str, parser_version: str) -> list[Path]:
    directory = _dir(file_hash)
    prefix = f"time_capacity_derived__p{_safe(parser_version)}__"
    index_prefix = f"time_capacity_derived_index__p{_safe(parser_version)}__"
    if not directory.is_dir():
        return []
    return [
        path
        for path in directory.iterdir()
        if (path.name.startswith(prefix) or path.name.startswith(index_prefix))
        and ".candidate-" not in path.name
        and ".tmp-" not in path.name
    ]


def _invalidate_time_capacity_derived_unlocked(
    file_hash: str,
    parser_version: str,
) -> None:
    """Remove every prepared generation before replacing the raw bytes."""

    for path in _derived_paths_for_parser(file_hash, parser_version):
        path.unlink(missing_ok=True)


def _finite_column_available(frame: pd.DataFrame, column: str) -> bool:
    if column not in frame.columns:
        return False
    numeric = pd.to_numeric(frame[column], errors="coerce")
    try:
        values = numeric.to_numpy(dtype="float64")
    except (TypeError, ValueError):
        return False
    return bool(np.isfinite(values).any())


def _timestamp_bounds(frame: pd.DataFrame) -> tuple[str | None, str | None]:
    if "timestamp" not in frame.columns:
        return None, None
    try:
        values = pd.to_datetime(frame["timestamp"], errors="coerce")
    except (TypeError, ValueError) as exc:
        raise RawLayoutError("raw timestamp metadata could not be normalized") from exc
    values = values.dropna()
    if values.empty:
        return None, None
    start = values.min()
    end = values.max()
    return pd.Timestamp(start).isoformat(), pd.Timestamp(end).isoformat()


def _build_raw_layout_index(
    frame: pd.DataFrame,
    parquet_path: Path,
    parser_version: str,
) -> dict[str, Any]:
    """Build the logical index from the frame and actual Parquet footer."""
    import pyarrow.parquet as pq

    if not parquet_path.is_file():
        raise RawLayoutError("cannot index a raw cache that is not present")
    parquet = pq.ParquetFile(parquet_path)
    metadata = parquet.metadata
    column_names = list(parquet.schema_arrow.names)
    frame_columns = [str(column) for column in frame.columns]
    if column_names != frame_columns:
        raise RawLayoutError(
            "raw Parquet schema does not preserve the canonical column order"
        )
    row_group_counts = [
        int(metadata.row_group(group).num_rows)
        for group in range(metadata.num_row_groups)
    ]
    if int(metadata.num_rows) != len(frame):
        raise RawLayoutError("raw Parquet row count does not match the source frame")

    if "cycle" not in frame.columns:
        raise RawLayoutError("raw cache cannot be indexed without a cycle column")
    observed_cycles, errors = canonical_cycling.observed_cycle_labels(frame["cycle"])
    if errors:
        raise RawLayoutError("; ".join(errors))
    if len(frame) > 0 and not observed_cycles:
        raise RawLayoutError("non-empty raw cache has no valid observed cycles")

    row_groups: list[dict[str, Any]] = []
    cycle_to_row_groups: dict[str, list[int]] = {}
    cursor = 0
    for group, row_count in enumerate(row_group_counts):
        group_frame = frame.iloc[cursor : cursor + row_count]
        labels, group_errors = canonical_cycling.observed_cycle_labels(group_frame["cycle"])
        if group_errors:
            raise RawLayoutError("; ".join(group_errors))
        if len(group_frame) > 0 and not labels:
            raise RawLayoutError(
                f"raw row group {group} has no valid observed cycle labels"
            )
        row_groups.append(
            {
                "row_group": group,
                "row_count": row_count,
                "source_cycles": labels,
            }
        )
        for cycle in labels:
            cycle_to_row_groups.setdefault(str(cycle), []).append(group)
        cursor += row_count
    if cursor != len(frame):
        raise RawLayoutError("raw row-group metadata does not cover the source frame")

    raw_file_size = parquet_path.stat().st_size
    timestamp_start, timestamp_end = _timestamp_bounds(frame)
    voltage_availability = {
        column: _finite_column_available(frame, column)
        for column in canonical_cycling.VOLTAGE_QUANTITIES.values()
    }
    return {
        "layout_version": RAW_CACHE_LAYOUT_VERSION,
        "parser_version": parser_version,
        "canonical_raw_version": canonical_cycling.CANONICAL_RAW_VERSION,
        "raw_row_count": len(frame),
        "raw_column_names": column_names,
        "raw_row_group_count": len(row_groups),
        "observed_source_cycles": observed_cycles,
        "row_groups": row_groups,
        "cycle_to_row_groups": cycle_to_row_groups,
        "voltage_data_availability": voltage_availability,
        "timestamp_start": timestamp_start,
        "timestamp_end": timestamp_end,
        "raw_file_size": raw_file_size,
        "raw_shape_fingerprint": _raw_shape_fingerprint(
            raw_row_count=len(frame),
            raw_column_names=column_names,
            row_group_counts=row_group_counts,
            raw_file_size=raw_file_size,
        ),
    }


def _coerce_index_cycle(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise RawLayoutError(f"raw index {name} contains a boolean cycle label")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    raise RawLayoutError(f"raw index {name} contains a non-integer cycle label")


def _validate_raw_layout_index(
    index: object,
    parquet_path: Path,
    parser_version: str,
) -> dict[str, Any]:
    """Validate sidecar structure and its current raw Parquet footer."""
    import pyarrow.parquet as pq

    if not isinstance(index, dict):
        raise RawLayoutError("raw layout index is not a JSON object")
    if index.get("layout_version") != RAW_CACHE_LAYOUT_VERSION:
        raise RawLayoutError("raw layout index version is not current")
    if index.get("parser_version") != parser_version:
        raise RawLayoutError("raw layout index parser identity does not match")
    if index.get("canonical_raw_version") != canonical_cycling.CANONICAL_RAW_VERSION:
        raise RawLayoutError("raw layout index canonical version does not match")

    try:
        raw_row_count = int(index["raw_row_count"])
        raw_row_group_count = int(index["raw_row_group_count"])
        raw_file_size = int(index["raw_file_size"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RawLayoutError("raw layout index has invalid raw metadata") from exc
    if raw_row_count < 0 or raw_row_group_count < 0 or raw_file_size < 0:
        raise RawLayoutError("raw layout index has negative raw metadata")

    column_names = index.get("raw_column_names")
    if not isinstance(column_names, list) or not all(
        isinstance(column, str) for column in column_names
    ):
        raise RawLayoutError("raw layout index has invalid column metadata")

    row_groups_value = index.get("row_groups")
    if not isinstance(row_groups_value, list):
        raise RawLayoutError("raw layout index has invalid row-group metadata")
    if len(row_groups_value) != raw_row_group_count:
        raise RawLayoutError("raw layout index row-group count is inconsistent")

    row_groups: list[dict[str, Any]] = []
    row_group_counts: list[int] = []
    expected_cycle_to_groups: dict[int, list[int]] = {}
    for expected_group, raw_group in enumerate(row_groups_value):
        if not isinstance(raw_group, dict):
            raise RawLayoutError("raw layout index contains a malformed row group")
        if raw_group.get("row_group") != expected_group:
            raise RawLayoutError("raw layout index row groups are not contiguous")
        try:
            row_count = int(raw_group["row_count"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RawLayoutError("raw layout index row group has no valid row count") from exc
        if row_count <= 0:
            raise RawLayoutError("raw layout index contains an empty row group")
        source_cycles_value = raw_group.get("source_cycles")
        if not isinstance(source_cycles_value, list):
            raise RawLayoutError("raw layout index row group has invalid cycle metadata")
        source_cycles = [
            _coerce_index_cycle(value, f"row_groups[{expected_group}].source_cycles")
            for value in source_cycles_value
        ]
        if source_cycles != sorted(set(source_cycles)):
            raise RawLayoutError("raw layout index row-group cycles are not sorted")
        row_groups.append(
            {
                "row_group": expected_group,
                "row_count": row_count,
                "source_cycles": source_cycles,
            }
        )
        row_group_counts.append(row_count)
        for cycle in source_cycles:
            expected_cycle_to_groups.setdefault(cycle, []).append(expected_group)

    observed_value = index.get("observed_source_cycles")
    if not isinstance(observed_value, list):
        raise RawLayoutError("raw layout index has invalid observed-cycle metadata")
    observed_cycles = [
        _coerce_index_cycle(value, "observed_source_cycles") for value in observed_value
    ]
    if observed_cycles != sorted(set(observed_cycles)):
        raise RawLayoutError("raw layout index observed cycles are not sorted")
    if observed_cycles != sorted(expected_cycle_to_groups):
        raise RawLayoutError("raw layout index observed cycles disagree with row groups")

    cycle_mapping_value = index.get("cycle_to_row_groups")
    if not isinstance(cycle_mapping_value, dict):
        raise RawLayoutError("raw layout index has invalid cycle mapping")
    cycle_mapping: dict[int, list[int]] = {}
    for raw_cycle, raw_groups in cycle_mapping_value.items():
        if not isinstance(raw_cycle, str):
            raise RawLayoutError("raw layout index cycle mapping has a non-string key")
        try:
            cycle = int(raw_cycle)
        except (TypeError, ValueError) as exc:
            raise RawLayoutError("raw layout index cycle mapping has an invalid key") from exc
        if str(cycle) != raw_cycle or not isinstance(raw_groups, list):
            raise RawLayoutError("raw layout index cycle mapping is malformed")
        groups = [
            _coerce_index_cycle(group, f"cycle_to_row_groups[{raw_cycle}]")
            for group in raw_groups
        ]
        if groups != sorted(set(groups)):
            raise RawLayoutError("raw layout index cycle groups are not sorted")
        cycle_mapping[cycle] = groups
    if cycle_mapping != expected_cycle_to_groups:
        raise RawLayoutError("raw layout index cycle mapping disagrees with row groups")

    availability = index.get("voltage_data_availability")
    if not isinstance(availability, dict):
        raise RawLayoutError("raw layout index has invalid voltage availability")
    for column in canonical_cycling.VOLTAGE_QUANTITIES.values():
        if not isinstance(availability.get(column), bool):
            raise RawLayoutError(
                f"raw layout index voltage availability is missing {column}"
            )

    for key in ("timestamp_start", "timestamp_end"):
        if index.get(key) is not None and not isinstance(index.get(key), str):
            raise RawLayoutError(f"raw layout index {key} is not a timestamp string")

    if not parquet_path.is_file():
        raise RawLayoutError("raw cache disappeared while loading its index")
    parquet = pq.ParquetFile(parquet_path)
    metadata = parquet.metadata
    actual_columns = list(parquet.schema_arrow.names)
    actual_counts = [
        int(metadata.row_group(group).num_rows)
        for group in range(metadata.num_row_groups)
    ]
    actual_size = parquet_path.stat().st_size
    if (
        int(metadata.num_rows) != raw_row_count
        or metadata.num_row_groups != raw_row_group_count
        or actual_columns != column_names
        or actual_counts != row_group_counts
        or actual_size != raw_file_size
    ):
        raise RawLayoutError("raw layout index does not describe the active raw Parquet")
    expected_fingerprint = _raw_shape_fingerprint(
        raw_row_count=raw_row_count,
        raw_column_names=column_names,
        row_group_counts=row_group_counts,
        raw_file_size=actual_size,
    )
    if index.get("raw_shape_fingerprint") != expected_fingerprint:
        raise RawLayoutError("raw layout index physical fingerprint is stale")
    if sum(row_group_counts) != raw_row_count:
        raise RawLayoutError("raw layout index row groups do not cover the raw row count")
    if raw_row_count > 0 and raw_row_group_count == 0:
        raise RawLayoutError("non-empty raw cache has no row groups")

    normalized = dict(index)
    normalized["raw_row_count"] = raw_row_count
    normalized["raw_row_group_count"] = raw_row_group_count
    normalized["raw_file_size"] = raw_file_size
    normalized["raw_column_names"] = column_names
    normalized["row_groups"] = row_groups
    normalized["observed_source_cycles"] = observed_cycles
    normalized["cycle_to_row_groups"] = cycle_mapping
    return normalized


def _load_raw_layout_index_unlocked(
    file_hash: str,
    parser_version: str,
) -> dict[str, Any]:
    parquet_path = raw_path(file_hash, parser_version)
    index_path = raw_index_path(file_hash, parser_version)
    if not parquet_path.is_file():
        raise RawLayoutError("raw cache is missing")
    if not index_path.is_file():
        raise RawLayoutError("raw cache has no current access index")
    try:
        with index_path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RawLayoutError("raw layout index is not readable JSON") from exc
    return _validate_raw_layout_index(value, parquet_path, parser_version)


def raw_layout_status(file_hash: str, parser_version: str) -> str:
    """Return ``ready``, ``missing``, ``layout_unavailable`` or ``invalid``."""
    _wait_for_pending(file_hash)
    with _raw_layout_io_lock:
        if not raw_path(file_hash, parser_version).is_file():
            return "missing"
        if not raw_index_path(file_hash, parser_version).is_file():
            return "layout_unavailable"
        try:
            _load_raw_layout_index_unlocked(file_hash, parser_version)
        except RawLayoutError:
            return "invalid"
        return "ready"


def raw_layout_is_current(file_hash: str, parser_version: str) -> bool:
    return raw_layout_status(file_hash, parser_version) == "ready"


def load_raw_layout_index(
    file_hash: str,
    parser_version: str,
) -> dict[str, Any] | None:
    """Load and validate the current sidecar without reading raw records."""
    _wait_for_pending(file_hash)
    with _raw_layout_io_lock:
        try:
            return _load_raw_layout_index_unlocked(file_hash, parser_version)
        except RawLayoutError:
            return None


def try_load_raw_layout_index(
    file_hash: str,
    parser_version: str,
) -> dict[str, Any] | None:
    """Load a stable raw-layout pair without waiting for layout preparation.

    A ``None`` result means the pair is missing, invalid, or currently behind
    the raw-layout I/O boundary.  The last case is deliberately useful to
    request paths that can render the canonical raw cache through their
    compatibility reader while a background conversion is in progress.
    """
    _wait_for_pending(file_hash)
    with _raw_layout_access(wait=False) as acquired:
        if not acquired:
            return None
        try:
            return _load_raw_layout_index_unlocked(file_hash, parser_version)
        except RawLayoutError:
            return None


_TIME_CAPACITY_DERIVED_COLUMNS = [
    "record_index",
    "cycle",
    "phase_code",
    "phase_capacity_mah",
]


def _validate_time_capacity_derived_index(
    index: object,
    parquet_path: Path,
    parser_version: str,
    raw_index: dict[str, Any],
) -> dict[str, Any]:
    """Validate prepared bytes against the active raw layout and identity."""

    import pyarrow.parquet as pq

    if not isinstance(index, dict):
        raise RawLayoutError("prepared derived index is not a JSON object")
    if index.get("derived_cache_version") != TIME_CAPACITY_DERIVED_CACHE_VERSION:
        raise RawLayoutError("prepared derived cache version is not current")
    if index.get("parser_version") != parser_version:
        raise RawLayoutError("prepared derived parser identity does not match")
    if index.get("calc_version") != CALC_VERSION:
        raise RawLayoutError("prepared derived calculation version does not match")
    if index.get("canonical_raw_version") != canonical_cycling.CANONICAL_RAW_VERSION:
        raise RawLayoutError("prepared derived canonical version does not match")
    if index.get("raw_layout_version") != RAW_CACHE_LAYOUT_VERSION:
        raise RawLayoutError("prepared derived raw-layout version does not match")
    if index.get("raw_shape_fingerprint") != raw_index.get("raw_shape_fingerprint"):
        raise RawLayoutError("prepared derived raw fingerprint is stale")

    expected_columns = list(_TIME_CAPACITY_DERIVED_COLUMNS)
    if index.get("prepared_column_names") != expected_columns:
        raise RawLayoutError("prepared derived column schema does not match")
    try:
        row_count = int(index["row_count"])
        row_group_count = int(index["row_group_count"])
        derived_file_size = int(index["derived_file_size"])
        raw_row_count = int(index["raw_row_count"])
        raw_row_group_count = int(index["raw_row_group_count"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RawLayoutError("prepared derived index has invalid row metadata") from exc
    if (
        row_count != int(raw_index["raw_row_count"])
        or raw_row_count != int(raw_index["raw_row_count"])
        or row_group_count != int(raw_index["raw_row_group_count"])
        or raw_row_group_count != int(raw_index["raw_row_group_count"])
    ):
        raise RawLayoutError("prepared derived row metadata disagrees with raw layout")
    if derived_file_size < 0:
        raise RawLayoutError("prepared derived file size is invalid")

    row_groups = index.get("row_groups")
    raw_row_groups = raw_index.get("row_groups")
    if not isinstance(row_groups, list) or row_groups != raw_row_groups:
        raise RawLayoutError("prepared derived row groups disagree with raw layout")
    raw_cycle_mapping = raw_index.get("cycle_to_row_groups")
    derived_cycle_mapping_value = index.get("cycle_to_row_groups")
    if not isinstance(derived_cycle_mapping_value, dict):
        raise RawLayoutError("prepared derived cycle mapping is malformed")
    try:
        derived_cycle_mapping = {
            int(cycle): [int(group) for group in groups]
            for cycle, groups in derived_cycle_mapping_value.items()
        }
    except (TypeError, ValueError):
        raise RawLayoutError("prepared derived cycle mapping is malformed")
    if derived_cycle_mapping != raw_cycle_mapping:
        raise RawLayoutError("prepared derived cycle mapping disagrees with raw layout")

    if not parquet_path.is_file():
        raise RawLayoutError("prepared derived payload is missing")
    parquet = pq.ParquetFile(parquet_path)
    metadata = parquet.metadata
    actual_columns = list(parquet.schema_arrow.names)
    actual_counts = [
        int(metadata.row_group(group).num_rows)
        for group in range(metadata.num_row_groups)
    ]
    actual_size = parquet_path.stat().st_size
    expected_counts = [int(item["row_count"]) for item in raw_row_groups]
    if (
        int(metadata.num_rows) != row_count
        or metadata.num_row_groups != row_group_count
        or actual_columns != expected_columns
        or actual_counts != expected_counts
        or actual_size != derived_file_size
    ):
        raise RawLayoutError("prepared derived index does not describe active bytes")
    expected_fingerprint = _derived_shape_fingerprint(
        row_count=row_count,
        column_names=expected_columns,
        row_group_counts=actual_counts,
        file_size=actual_size,
    )
    if index.get("derived_shape_fingerprint") != expected_fingerprint:
        raise RawLayoutError("prepared derived physical fingerprint is stale")
    if sum(actual_counts) != row_count:
        raise RawLayoutError("prepared derived row groups do not cover the row count")

    normalized = dict(index)
    normalized["row_count"] = row_count
    normalized["row_group_count"] = row_group_count
    normalized["derived_file_size"] = derived_file_size
    normalized["prepared_column_names"] = expected_columns
    normalized["row_groups"] = raw_row_groups
    return normalized


def _load_time_capacity_derived_index_unlocked(
    file_hash: str,
    parser_version: str,
    *,
    calc_version: str = CALC_VERSION,
) -> dict[str, Any]:
    raw_index = _load_raw_layout_index_unlocked(file_hash, parser_version)
    parquet_path = time_capacity_derived_path(file_hash, parser_version, calc_version)
    index_path = time_capacity_derived_index_path(file_hash, parser_version, calc_version)
    if not parquet_path.is_file() or not index_path.is_file():
        raise RawLayoutError("prepared derived cache is missing")
    try:
        with index_path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RawLayoutError("prepared derived index is not readable JSON") from exc
    return _validate_time_capacity_derived_index(
        value,
        parquet_path,
        parser_version,
        raw_index,
    )


def time_capacity_derived_status(
    file_hash: str,
    parser_version: str,
) -> str:
    """Return the bounded lifecycle state of the current prepared artifact."""

    _wait_for_pending(file_hash)
    with _raw_layout_io_lock:
        if not raw_path(file_hash, parser_version).is_file():
            return "missing"
        try:
            _load_time_capacity_derived_index_unlocked(file_hash, parser_version)
        except RawLayoutError as exc:
            if "raw cache" in str(exc) or "raw layout" in str(exc):
                return "raw_layout_unavailable"
            return "invalid"
        return "ready"


def time_capacity_derived_is_current(file_hash: str, parser_version: str) -> bool:
    return time_capacity_derived_status(file_hash, parser_version) == "ready"


def try_load_time_capacity_derived_index(
    file_hash: str,
    parser_version: str,
) -> dict[str, Any] | None:
    """Read prepared metadata without waiting on raw/derived publication."""

    _wait_for_pending(file_hash)
    with _raw_layout_access(wait=False) as acquired:
        if not acquired:
            return None
        try:
            return _load_time_capacity_derived_index_unlocked(file_hash, parser_version)
        except RawLayoutError:
            return None


def prepare_time_capacity_derived(
    file_hash: str,
    parser_version: str,
    *,
    raw_frame: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """Publish exact source-local phase/capacity values from raw cache bytes.

    The caller may provide the complete in-memory frame from a current cache
    build.  Otherwise this function reads the already validated raw Parquet;
    it never opens or reparses the original source file.
    """

    _wait_for_pending(file_hash)
    with protect_hash_from_cleanup(file_hash):
        with _raw_layout_io_lock:
            try:
                raw_index = _load_raw_layout_index_unlocked(file_hash, parser_version)
            except RawLayoutError as exc:
                return {
                    "status": "raw_layout_unavailable",
                    "prepared": False,
                    "rows": 0,
                    "row_groups": 0,
                    "error": str(exc),
                }

            try:
                current = _load_time_capacity_derived_index_unlocked(
                    file_hash,
                    parser_version,
                )
            except RawLayoutError:
                current = None
            else:
                return {
                    "status": "ready",
                    "prepared": False,
                    "rows": int(current["row_count"]),
                    "row_groups": int(current["row_group_count"]),
                }

            raw_target = raw_path(file_hash, parser_version)
            raw = raw_frame.copy(deep=True) if raw_frame is not None else pd.read_parquet(raw_target)
            canonical_cycling.validate_raw_timeseries(raw)
            if len(raw) != int(raw_index["raw_row_count"]):
                raise RawLayoutError("prepared derived raw frame row count is stale")
            if not raw["record_index"].is_unique:
                raise RawLayoutError("prepared derived raw record indexes are not unique")

            ordered = raw.sort_values(["cycle", "record_index"], kind="stable").reset_index(drop=True)
            phases = time_capacity_derived.phase_from_raw(ordered)
            capacity = time_capacity_derived.phase_capacity(ordered, phases)
            by_record = pd.DataFrame(
                {
                    "record_index": ordered["record_index"].to_numpy(),
                    "cycle": ordered["cycle"].to_numpy(),
                    "phase_code": time_capacity_derived.encode_phases(phases),
                    "phase_capacity_mah": np.asarray(capacity, dtype="float64"),
                }
            ).set_index("record_index")
            prepared = pd.DataFrame(
                {
                    "record_index": raw["record_index"].to_numpy(),
                    "cycle": raw["cycle"].to_numpy(),
                }
            )
            aligned = by_record.reindex(prepared["record_index"])
            if aligned["phase_code"].isna().any():
                raise RawLayoutError("prepared derived values could not align to raw records")
            prepared["phase_code"] = aligned["phase_code"].to_numpy(dtype="int8")
            prepared["phase_capacity_mah"] = aligned["phase_capacity_mah"].to_numpy(dtype="float64")

            target = time_capacity_derived_path(file_hash, parser_version)
            index_target = time_capacity_derived_index_path(file_hash, parser_version)
            # Keep the staging basename independent of the long versioned
            # target name; repeating it can exceed Windows' legacy path limit
            # in temporary worktrees.
            candidate = target.with_name(f".{uuid.uuid4().hex}.tmp")
            index_tmp: Path | None = None
            published_payload = False
            published_index = False
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                import pyarrow as pa
                import pyarrow.parquet as pq

                table = pa.Table.from_pandas(prepared, preserve_index=False)
                pq.write_table(
                    table,
                    candidate,
                    compression="snappy",
                    row_group_size=RAW_CACHE_ROW_GROUP_SIZE,
                )
                parquet = pq.ParquetFile(candidate)
                row_group_counts = [
                    int(parquet.metadata.row_group(group).num_rows)
                    for group in range(parquet.metadata.num_row_groups)
                ]
                expected_counts = [int(item["row_count"]) for item in raw_index["row_groups"]]
                if row_group_counts != expected_counts:
                    raise RawLayoutError("prepared derived row groups do not align with raw layout")
                close_parquet = getattr(parquet, "close", None)
                if callable(close_parquet):
                    close_parquet()
                del parquet
                derived_file_size = candidate.stat().st_size
                index = {
                    "derived_cache_version": TIME_CAPACITY_DERIVED_CACHE_VERSION,
                    "parser_version": parser_version,
                    "calc_version": CALC_VERSION,
                    "canonical_raw_version": canonical_cycling.CANONICAL_RAW_VERSION,
                    "raw_layout_version": RAW_CACHE_LAYOUT_VERSION,
                    "raw_shape_fingerprint": raw_index["raw_shape_fingerprint"],
                    "raw_row_count": int(raw_index["raw_row_count"]),
                    "raw_row_group_count": int(raw_index["raw_row_group_count"]),
                    "row_count": len(prepared),
                    "row_group_count": len(row_group_counts),
                    "row_groups": raw_index["row_groups"],
                    "cycle_to_row_groups": raw_index["cycle_to_row_groups"],
                    "prepared_column_names": list(_TIME_CAPACITY_DERIVED_COLUMNS),
                    "derived_file_size": int(derived_file_size),
                    "derived_shape_fingerprint": _derived_shape_fingerprint(
                        row_count=len(prepared),
                        column_names=list(_TIME_CAPACITY_DERIVED_COLUMNS),
                        row_group_counts=row_group_counts,
                        file_size=derived_file_size,
                    ),
                }
                index_tmp = _write_index_temp(index, index_target)
                # The old sidecar is never allowed to remain paired with a
                # replacement raw layout.  The caller already holds the
                # shared consistency boundary.
                _invalidate_time_capacity_derived_unlocked(file_hash, parser_version)
                os.replace(candidate, target)
                published_payload = True
                os.replace(index_tmp, index_target)
                published_index = True
                index_tmp = None
                return {
                    "status": "ready",
                    "prepared": True,
                    "rows": len(prepared),
                    "row_groups": len(row_group_counts),
                }
            finally:
                candidate.unlink(missing_ok=True)
                if index_tmp is not None:
                    index_tmp.unlink(missing_ok=True)
                if published_payload and not published_index:
                    target.unlink(missing_ok=True)
                    index_target.unlink(missing_ok=True)


def load_time_capacity_derived(
    file_hash: str,
    parser_version: str,
    source_cycles: Iterable[object],
    columns: Iterable[str],
    *,
    diagnostics: TimeCapacityDerivedReadDiagnostics | None = None,
    wait_for_layout: bool = True,
) -> pd.DataFrame | None:
    """Read selected prepared rows without waiting on publication."""

    try:
        requested_cycles = _normalize_requested_cycles(source_cycles)
    except ValueError:
        if diagnostics is not None:
            diagnostics.status = "invalid_request"
        raise
    requested_columns = list(dict.fromkeys(columns))
    if any(column not in {"phase_code", "phase_capacity_mah"} for column in requested_columns):
        if diagnostics is not None:
            diagnostics.status = "invalid_request"
        raise ValueError("prepared derived columns are not supported")
    if diagnostics is not None:
        diagnostics.requested_cycles = requested_cycles

    _wait_for_pending(file_hash)
    with _raw_layout_access(wait=wait_for_layout) as acquired:
        if not acquired:
            if diagnostics is not None:
                diagnostics.status = "layout_preparing"
            return None
        try:
            raw_index = _load_raw_layout_index_unlocked(file_hash, parser_version)
            derived_index = _load_time_capacity_derived_index_unlocked(file_hash, parser_version)
        except RawLayoutError as exc:
            if diagnostics is not None:
                diagnostics.status = (
                    "raw_layout_unavailable"
                    if "raw layout" in str(exc) or "raw cache" in str(exc)
                    else "unavailable"
                )
            return None

        read_columns = ["record_index", "cycle", *requested_columns]
        if diagnostics is not None:
            diagnostics.status = "ready"
            diagnostics.row_groups_total = int(derived_index["row_group_count"])
            diagnostics.columns_read = tuple(read_columns)
        if not requested_cycles:
            result = pd.DataFrame(columns=read_columns)
            if diagnostics is not None:
                diagnostics.row_groups_read = ()
                diagnostics.rows_read = 0
                diagnostics.rows_returned = 0
            return result

        cycle_to_groups = raw_index["cycle_to_row_groups"]
        row_groups = sorted(
            {
                int(group)
                for cycle in requested_cycles
                for group in cycle_to_groups.get(cycle, [])
            }
        )
        if diagnostics is not None:
            diagnostics.row_groups_read = tuple(row_groups)
            row_group_counts = {
                int(item["row_group"]): int(item["row_count"])
                for item in derived_index["row_groups"]
            }
            diagnostics.rows_read = sum(row_group_counts[group] for group in row_groups)
        if not row_groups:
            result = pd.DataFrame(columns=read_columns)
            if diagnostics is not None:
                diagnostics.rows_returned = 0
            return result

        try:
            import pyarrow.parquet as pq

            loaded = pq.ParquetFile(
                time_capacity_derived_path(file_hash, parser_version)
            ).read_row_groups(row_groups, columns=read_columns).to_pandas()
        except Exception:
            logger.warning(
                "Could not read prepared derived row groups for %s",
                file_hash[:12],
                exc_info=True,
            )
            if diagnostics is not None:
                diagnostics.status = "invalid"
            return None

        numeric_cycles = pd.to_numeric(loaded["cycle"], errors="coerce")
        result = loaded.loc[numeric_cycles.isin(requested_cycles), read_columns].reset_index(drop=True)
        _touch(time_capacity_derived_path(file_hash, parser_version))
        _touch(time_capacity_derived_index_path(file_hash, parser_version))
        if diagnostics is not None:
            diagnostics.rows_returned = len(result)
        return result


def _normalize_requested_cycles(source_cycles: Iterable[object]) -> tuple[int, ...]:
    values: list[int] = []
    seen: set[int] = set()
    for value in source_cycles:
        if isinstance(value, bool):
            raise ValueError("source cycles must be finite integer-like values")
        try:
            numeric = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("source cycles must be finite integer-like values") from exc
        if not math.isfinite(numeric) or not numeric.is_integer():
            raise ValueError("source cycles must be finite integer-like values")
        cycle = int(numeric)
        if cycle not in seen:
            values.append(cycle)
            seen.add(cycle)
    return tuple(values)


def load_raw_cycles(
    file_hash: str,
    parser_version: str,
    source_cycles: Iterable[object],
    columns: Iterable[str],
    *,
    diagnostics: RawCycleReadDiagnostics | None = None,
    wait_for_layout: bool = True,
) -> pd.DataFrame | None:
    """Load exact source-local cycles from the indexed row groups.

    ``None`` means the raw cache is missing, legacy/unprepared, invalid, or
    lacks a requested column.  Pass ``diagnostics`` when the caller needs to
    distinguish those safe fallback states or record the physical groups and
    rows selected for a benchmark/test.  Request paths may set
    ``wait_for_layout=False`` to return ``None`` immediately when background
    raw-layout conversion owns the raw/index consistency boundary.
    """
    try:
        requested_cycles = _normalize_requested_cycles(source_cycles)
    except ValueError:
        if diagnostics is not None:
            diagnostics.status = "invalid_request"
        raise
    requested_columns = list(dict.fromkeys(columns))
    if not all(isinstance(column, str) for column in requested_columns):
        if diagnostics is not None:
            diagnostics.status = "invalid_request"
        raise ValueError("raw columns must be strings")
    if diagnostics is not None:
        diagnostics.requested_cycles = requested_cycles
        diagnostics.columns_returned = tuple(requested_columns)

    _wait_for_pending(file_hash)
    parquet_path = raw_path(file_hash, parser_version)
    index_path = raw_index_path(file_hash, parser_version)
    with _raw_layout_access(wait=wait_for_layout) as acquired:
        if not acquired:
            if diagnostics is not None:
                diagnostics.status = "layout_preparing"
            return None
        if not parquet_path.is_file():
            if diagnostics is not None:
                diagnostics.status = "missing"
            return None
        if not index_path.is_file():
            if diagnostics is not None:
                diagnostics.status = "layout_unavailable"
            return None
        try:
            index = _load_raw_layout_index_unlocked(file_hash, parser_version)
        except RawLayoutError:
            if diagnostics is not None:
                diagnostics.status = "invalid_index"
            return None

        available_columns = set(index["raw_column_names"])
        if any(column not in available_columns for column in requested_columns):
            if diagnostics is not None:
                diagnostics.status = "columns_unavailable"
            return None
        read_columns = list(requested_columns)
        if "cycle" not in read_columns:
            read_columns.append("cycle")
        cycle_to_groups: dict[int, list[int]] = index["cycle_to_row_groups"]
        row_groups = sorted(
            {group for cycle in requested_cycles for group in cycle_to_groups.get(cycle, [])}
        )
        row_group_counts = {
            item["row_group"]: item["row_count"] for item in index["row_groups"]
        }
        if diagnostics is not None:
            diagnostics.status = "ready"
            diagnostics.row_groups_total = index["raw_row_group_count"]
            diagnostics.row_groups_read = tuple(row_groups)
            diagnostics.rows_read = sum(row_group_counts[group] for group in row_groups)
            diagnostics.columns_read = tuple(read_columns)

        _touch(parquet_path)
        _touch(index_path)
        if not row_groups:
            result = pd.DataFrame(columns=requested_columns)
            if diagnostics is not None:
                diagnostics.rows_returned = 0
            return result

        try:
            import pyarrow.parquet as pq

            loaded = pq.ParquetFile(parquet_path).read_row_groups(
                row_groups,
                columns=read_columns,
            ).to_pandas()
        except Exception:
            logger.warning("Could not read indexed raw row groups for %s", file_hash[:12], exc_info=True)
            if diagnostics is not None:
                diagnostics.status = "invalid_raw"
            return None

        numeric_cycles = pd.to_numeric(loaded["cycle"], errors="coerce")
        mask = numeric_cycles.isin(requested_cycles)
        result = loaded.loc[mask, requested_columns].reset_index(drop=True)
        if diagnostics is not None:
            diagnostics.rows_returned = len(result)
        return result


def _write_index_temp(index: dict[str, Any], index_path: Path) -> Path:
    # Versioned index names are long enough that appending a UUID can cross
    # Windows' legacy path limit.  The directory is already the identity
    # boundary, so a short opaque staging basename is sufficient.
    tmp = index_path.with_name(f".{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(index, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
        return tmp
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _publish_optimized_raw(
    frame: pd.DataFrame,
    raw_target: Path,
    parser_version: str,
    *,
    compare_to: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """Stage an optimized raw file and publish its index only after raw bytes."""
    raw_target.parent.mkdir(parents=True, exist_ok=True)
    index_target = raw_index_path(
        raw_target.parent.name,
        parser_version,
    )
    # The cache directory is `<prefix>/<hash>`, so deriving the hash from the
    # target path is safe here and keeps callers from accidentally publishing
    # an index for a different checksum.
    if raw_target.parent != index_target.parent:
        raise RawLayoutError("raw/index targets do not share a cache directory")

    candidate = raw_target.with_name(
        f"{raw_target.name}.candidate-{uuid.uuid4().hex}"
    )
    index_tmp: Path | None = None
    raw_replaced = False
    index_published = False
    with _raw_layout_io_lock:
        try:
            _write_atomic(frame, candidate)
            if compare_to is not None:
                optimized = pd.read_parquet(candidate)
                pd.testing.assert_frame_equal(
                    compare_to.reset_index(drop=True),
                    optimized.reset_index(drop=True),
                    check_dtype=False,
                    check_exact=True,
                )
            index = _build_raw_layout_index(frame, candidate, parser_version)
            index_tmp = _write_index_temp(index, index_target)

            # An old sidecar must not survive while the new raw file is active:
            # if publication stops after os.replace, the safe state is raw with
            # no current index, never old index paired with new bytes.
            _invalidate_time_capacity_derived_unlocked(
                raw_target.parent.name,
                parser_version,
            )
            index_target.unlink(missing_ok=True)
            os.replace(candidate, raw_target)
            raw_replaced = True
            os.replace(index_tmp, index_target)
            index_published = True
            index_tmp = None
            return index
        finally:
            candidate.unlink(missing_ok=True)
            if index_tmp is not None:
                index_tmp.unlink(missing_ok=True)
            if raw_replaced and not index_published:
                index_target.unlink(missing_ok=True)


def prepare_raw_layout(file_hash: str, parser_version: str) -> dict[str, Any]:
    """Safely convert one existing raw cache using cache bytes only.

    The caller normally invokes this from the existing background scientific
    preparation path.  It never opens or reparses the original source and
    leaves a valid legacy raw file readable if candidate preparation fails.
    """
    _wait_for_pending(file_hash)
    with protect_hash_from_cleanup(file_hash):
        with _raw_layout_io_lock:
            current = raw_layout_status(file_hash, parser_version)
            if current == "ready":
                index = _load_raw_layout_index_unlocked(file_hash, parser_version)
                return {
                    "status": "ready",
                    "prepared": False,
                    "rows": index["raw_row_count"],
                    "cycles": len(index["observed_source_cycles"]),
                }
            raw_target = raw_path(file_hash, parser_version)
            if not raw_target.is_file():
                return {"status": "missing", "prepared": False, "rows": 0, "cycles": 0}
            legacy = pd.read_parquet(raw_target)
            canonical_cycling.validate_raw_timeseries(legacy)
            index = _publish_optimized_raw(
                legacy,
                raw_target,
                parser_version,
                compare_to=legacy,
            )
            return {
                "status": "ready",
                "prepared": True,
                "rows": index["raw_row_count"],
                "cycles": len(index["observed_source_cycles"]),
            }


def capacity_totals(cycles: pd.DataFrame | None) -> dict[str, float | None]:
    """Return the same aggregate capacities shown in the cell library."""

    def _sum(column: str) -> float | None:
        if cycles is None or column not in cycles.columns:
            return None
        values = pd.to_numeric(cycles[column], errors="coerce")
        total = 0.0
        found = False
        for raw in values:
            if pd.isna(raw):
                continue
            try:
                number = float(raw)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(number):
                continue
            total += number
            found = True
        return round(total, 6) if found else None

    def _max(column: str) -> float | None:
        if cycles is None or column not in cycles.columns:
            return None
        values = pd.to_numeric(cycles[column], errors="coerce")
        best = None
        for raw in values:
            if pd.isna(raw):
                continue
            try:
                number = float(raw)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(number):
                continue
            if best is None or number > best:
                best = number
        return round(best, 6) if best is not None else None

    return {
        "total_charge_capacity_mah": _sum("charge_capacity_mah"),
        "total_discharge_capacity_mah": _sum("discharge_capacity_mah"),
        "max_discharge_capacity_mah": _max("discharge_capacity_mah"),
    }


def build(
    file_hash: str,
    source_path: str | Path,
    force: bool = False,
    *,
    expected_fingerprint: parsing.SourceFingerprint | None = None,
) -> dict:
    """Parse source file and (re)build raw + cycles caches at that SOURCE's
    own current effective parser identity (Spec 040.3) and the current calc
    version. Returns {rows, cycles, parser_version, calc_version}.

    ``parser_version`` in the return value is this source's own identity
    (`parsing.parser_identity(source_path)`), not a process-global bundle —
    callers persist it verbatim into `SourceFile.parser_version`.

    Idempotent: identical content (hash) at identical versions yields
    identical caches, so if both files already exist the parse is skipped
    (row/cycle counts come from Parquet metadata). Pass force=True to
    rebuild regardless, e.g. if a cache file is suspected corrupt."""
    _wait_for_pending(file_hash)
    expected_source_fingerprint = _resolve_source_fingerprint(
        source_path, file_hash, expected_fingerprint
    )
    _require_source_fingerprint(source_path, expected_source_fingerprint)
    parser_identity = parsing.parser_identity(source_path)
    _require_source_fingerprint(source_path, expected_source_fingerprint)
    rp, cp = raw_path(file_hash, parser_identity), cycles_path(file_hash, parser_identity)
    if not force and rp.exists() and cp.exists():
        _require_source_fingerprint(source_path, expected_source_fingerprint)
        import pyarrow.parquet as pq

        cycle_columns = [
            column
            for column in ("charge_capacity_mah", "discharge_capacity_mah")
            if column in pq.read_schema(cp).names
        ]
        totals = capacity_totals(pd.read_parquet(cp, columns=cycle_columns))
        try:
            prepare_time_capacity_derived(file_hash, parser_identity)
        except Exception:
            # The prepared artifact is optional performance state.  A source
            # with valid raw/cycle caches must remain scientifically usable
            # when its sidecar cannot be published.
            logger.exception("prepared Time/Capacity cache build failed for %s", file_hash[:12])
        return {
            "rows": pq.read_metadata(rp).num_rows,
            "cycles": pq.read_metadata(cp).num_rows,
            "parser_version": parser_identity,
            "calc_version": CALC_VERSION,
            "cached": True,
            **totals,
        }

    # A calculation-version bump does not require rereading the source file:
    # reuse the parser-identity-versioned raw cache and derive only the new
    # cycle cache.
    parsed_from_source = not (rp.exists() and not force)
    if parsed_from_source:
        _require_source_fingerprint(source_path, expected_source_fingerprint)
        raw = parsing.parse_timeseries(source_path)
        # Full-parse / cache-build boundary (Spec 040.1): a frame already on
        # disk was validated when it was first written, so this only runs on
        # an actual new parse, never on every cache read.
        canonical_cycling.validate_raw_timeseries(raw)
        _require_source_fingerprint(source_path, expected_source_fingerprint)
    else:
        raw = pd.read_parquet(rp)
    cycles = calc.per_cycle(raw)
    if parsed_from_source:
        parsing.validate_parsed_output(source_path, raw, cycles)
    _require_source_fingerprint(source_path, expected_source_fingerprint)
    d = _dir(file_hash)
    d.mkdir(parents=True, exist_ok=True)
    raw_was_present = rp.exists()
    cycles_was_present = cp.exists()
    try:
        if parsed_from_source:
            _publish_optimized_raw(raw, rp, parser_identity)
        _write_atomic(cycles, cp)
        try:
            prepare_time_capacity_derived(
                file_hash,
                parser_identity,
                raw_frame=raw,
            )
        except Exception:
            logger.exception("prepared Time/Capacity cache build failed for %s", file_hash[:12])
        _require_source_fingerprint(source_path, expected_source_fingerprint)
    except Exception:
        if not raw_was_present:
            rp.unlink(missing_ok=True)
            raw_index_path(file_hash, parser_identity).unlink(missing_ok=True)
        if not cycles_was_present:
            cp.unlink(missing_ok=True)
        raise
    return {
        "rows": len(raw),
        "cycles": len(cycles),
        "parser_version": parser_identity,
        "calc_version": CALC_VERSION,
        "cached": False,
        **capacity_totals(cycles),
    }


def build_write_behind(
    file_hash: str,
    source_path: str | Path,
    *,
    expected_fingerprint: parsing.SourceFingerprint | None = None,
) -> pd.DataFrame:
    """Parse now, return the per-cycle frame immediately, and write the
    raw + cycles Parquet caches on a background thread.

    This is the preview path: the caller gets plottable data as soon as the
    parse finishes instead of also waiting ~0.5–1s for cache writes. Any
    later build()/load for the same hash joins the in-flight write first,
    so the caches are always complete before they are read."""
    _wait_for_pending(file_hash)
    expected_source_fingerprint = _resolve_source_fingerprint(
        source_path, file_hash, expected_fingerprint
    )
    _require_source_fingerprint(source_path, expected_source_fingerprint)
    parser_identity = parsing.parser_identity(source_path)
    _require_source_fingerprint(source_path, expected_source_fingerprint)
    if raw_path(file_hash, parser_identity).exists() and cycles_path(
        file_hash, parser_identity
    ).exists():
        _require_source_fingerprint(source_path, expected_source_fingerprint)
        try:
            prepare_time_capacity_derived(file_hash, parser_identity)
        except Exception:
            logger.exception("prepared Time/Capacity cache build failed for %s", file_hash[:12])
        return load_cycles(file_hash, parser_identity, CALC_VERSION)

    _require_source_fingerprint(source_path, expected_source_fingerprint)
    raw = parsing.parse_timeseries(source_path)
    canonical_cycling.validate_raw_timeseries(raw)
    cycles = calc.per_cycle(raw)
    parsing.validate_parsed_output(source_path, raw, cycles)
    _require_source_fingerprint(source_path, expected_source_fingerprint)
    raw_target = raw_path(file_hash, parser_identity)
    cycles_target = cycles_path(file_hash, parser_identity)
    raw_was_present = raw_target.exists()
    cycles_was_present = cycles_target.exists()

    def _write() -> None:
        from .process_priority import apply_background_thread_priority

        apply_background_thread_priority()
        try:
            _require_source_fingerprint(source_path, expected_source_fingerprint)
            _dir(file_hash).mkdir(parents=True, exist_ok=True)
            _publish_optimized_raw(raw, raw_target, parser_identity)
            _write_atomic(cycles, cycles_target)
            try:
                prepare_time_capacity_derived(
                    file_hash,
                    parser_identity,
                    raw_frame=raw,
                )
            except Exception:
                logger.exception("prepared Time/Capacity cache build failed for %s", file_hash[:12])
            _require_source_fingerprint(source_path, expected_source_fingerprint)
        except Exception:
            if not raw_was_present:
                raw_target.unlink(missing_ok=True)
                raw_index_path(file_hash, parser_identity).unlink(missing_ok=True)
            if not cycles_was_present:
                cycles_target.unlink(missing_ok=True)
            logger.exception("background cache write failed for %s", file_hash)
        finally:
            with _pending_lock:
                _pending.pop(file_hash, None)

    thread = threading.Thread(target=_write, daemon=True, name=f"cache-write-{file_hash[:8]}")
    with _pending_lock:
        _pending[file_hash] = thread
    thread.start()
    return cycles


def load_cycles(
    file_hash: str, parser_version: str, calc_version: str
) -> pd.DataFrame | None:
    """Load per-cycle cache at EXACT versions (reproducibility). If the
    cycles file is missing but a raw cache at that parser version exists and
    calc_version is current, derive and store it."""
    _wait_for_pending(file_hash)
    p = cycles_path(file_hash, parser_version, calc_version)
    if p.exists():
        value = pd.read_parquet(p)
        _touch(p)
        return value
    rp = raw_path(file_hash, parser_version)
    if rp.exists() and calc_version == CALC_VERSION:
        cycles = calc.per_cycle(pd.read_parquet(rp))
        _write_atomic(cycles, p)
        return cycles
    return None


def load_raw(file_hash: str, parser_version: str) -> pd.DataFrame | None:
    _wait_for_pending(file_hash)
    p = raw_path(file_hash, parser_version)
    if not p.exists():
        return None
    value = pd.read_parquet(p)
    _touch(p)
    return value


def load_raw_columns(
    file_hash: str, parser_version: str, columns: list[str]
) -> pd.DataFrame | None:
    """Load selected raw columns without materializing the full cache."""
    _wait_for_pending(file_hash)
    p = raw_path(file_hash, parser_version)
    if not p.exists():
        return None
    try:
        value = pd.read_parquet(p, columns=columns)
        _touch(p)
        return value
    except (KeyError, ValueError):
        logger.warning("raw cache %s lacks requested columns %s", p, columns)
        return None


def available_versions(file_hash: str) -> list[dict]:
    """List cached (parser, calc) version pairs for a file."""
    d = _dir(file_hash)
    out = []
    if d.exists():
        for f in d.glob("cycles__p*__c*.parquet"):
            m = re.match(r"cycles__p(.+)__c(.+)\.parquet", f.name)
            if m:
                out.append({"parser_version": m.group(1), "calc_version": m.group(2)})
    return out
