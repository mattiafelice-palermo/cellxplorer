"""Parquet cache, keyed by (file hash, parser version, calc version).

Caches are regenerable artifacts, never user-facing entities. A successfully
updated source replaces its old content-addressed directory; derived analysis
results use their own checksum keys and expire through the analysis LRU.

Layout:  CACHE_DIR/<hash[:2]>/<hash>/raw__p<parser>.parquet
         CACHE_DIR/<hash[:2]>/<hash>/cycles__p<parser>__c<calc>.parquet
"""
from __future__ import annotations

import logging
import math
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from ..config import CACHE_DIR, CALC_VERSION
from . import calc, canonical_cycling, parsing

logger = logging.getLogger(__name__)


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
    if thread is not None:
        thread.join(timeout)
        if thread.is_alive():
            logger.warning(
                "timed out waiting %.0fs for the cache write of %s; continuing",
                timeout,
                file_hash[:12],
            )


def _wait_for_cleanup_safe(file_hash: str, timeout: float = CACHE_WAIT_TIMEOUT_SECONDS) -> None:
    """Wait until no in-process writer or protected build owns this hash."""
    deadline = time.monotonic() + timeout
    while True:
        _wait_for_pending(file_hash, timeout=max(0.0, deadline - time.monotonic()))
        with _pending_lock:
            protected = file_hash in _protected_hashes
        if not protected:
            return
        if time.monotonic() >= deadline:
            logger.warning(
                "timed out waiting %.0fs for the protected build of %s; continuing",
                timeout,
                file_hash[:12],
            )
            return
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


def remove_hash_cache(file_hash: str) -> int:
    """Remove one obsolete content-addressed cache after its replacement is durable."""
    if re.fullmatch(r"[0-9a-fA-F]{64}", file_hash) is None:
        raise ValueError("Invalid source checksum")
    _wait_for_cleanup_safe(file_hash)
    directory = _dir(file_hash)
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


def _write_atomic(df: pd.DataFrame, path: Path) -> None:
    """Write parquet via temp file + os.replace so concurrent readers never
    see a partially written cache."""
    tmp = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
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


def cycles_path(
    file_hash: str,
    parser_version: str = parsing.PARSER_VERSION,
    calc_version: str = CALC_VERSION,
) -> Path:
    return _dir(file_hash) / f"cycles__p{_safe(parser_version)}__c{_safe(calc_version)}.parquet"


def has_cycles(file_hash: str, parser_version: str, calc_version: str) -> bool:
    return cycles_path(file_hash, parser_version, calc_version).exists()


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
            _write_atomic(raw, rp)
        _write_atomic(cycles, cp)
        _require_source_fingerprint(source_path, expected_source_fingerprint)
    except Exception:
        if not raw_was_present:
            rp.unlink(missing_ok=True)
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
            _write_atomic(raw, raw_target)
            _write_atomic(cycles, cycles_target)
            _require_source_fingerprint(source_path, expected_source_fingerprint)
        except Exception:
            if not raw_was_present:
                raw_target.unlink(missing_ok=True)
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
