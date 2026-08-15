"""Background folder scanning & file registration.

Scan a directory for supported cycler files (.nda/.ndax/.xlsx/.mpr) → hash → header parse → upsert
SourceFile rows. Relinking is automatic: if a hash is already known but the
path moved, the path attribute is updated (identity is the hash).

Single-user app: one background thread, simple in-memory job registry.
"""
from __future__ import annotations

import logging
import os
import threading
import traceback
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import SourceFile
from . import background_jobs, cache, parsing
from . import scientific_preparation

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_jobs: dict[int, dict] = {}
_next_id = 1
_capacity_backfill_lock = threading.Lock()
_capacity_backfill_running = False
_capacity_backfill_job_id: int | None = None
_capacity_backfill_adaptive = False
_capacity_backfill_foreground_active = False
_capacity_backfill_background_requested = threading.Event()


class SourceChangedDuringRead(RuntimeError):
    """Raised when a source keeps growing while an automatic update reads it."""


def source_signature(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def _require_signature(path: Path, expected: tuple[int, int]) -> None:
    try:
        current = source_signature(path)
    except OSError as exc:
        raise SourceChangedDuringRead("Source became unavailable while it was being read") from exc
    if current != expected:
        raise SourceChangedDuringRead("Source is still changing; update deferred")


def _assert_stable_fingerprint(
    path: Path,
    fingerprint: parsing.SourceFingerprint,
) -> None:
    try:
        parsing.assert_source_fingerprint(path, fingerprint, verify_hash=False)
    except parsing.SourceIdentityError as exc:
        raise SourceChangedDuringRead("Source is still changing; update deferred") from exc


def apply_capacity_summary(sf: SourceFile, info: dict) -> None:
    sf.total_charge_capacity_mah = info.get("total_charge_capacity_mah")
    sf.total_discharge_capacity_mah = info.get("total_discharge_capacity_mah")
    sf.max_discharge_capacity_mah = info.get("max_discharge_capacity_mah")
    sf.capacity_summary_status = "ready"


def _has_current_scientific_cache(sf: SourceFile) -> bool:
    """Cheap "is this source's cache at its current expected identity" check.

    Resolves the expected parser identity from the source's stored extension
    alone (Spec 040.3) — no file I/O, no parser import — so this stays safe
    to call from list/backfill paths for many sources at once.
    """
    expected = parsing.current_parser_identity_for_extension(sf.ext) or parsing.PARSER_VERSION
    return cache.raw_path(sf.hash, expected).is_file() and cache.has_cycles(
        sf.hash,
        expected,
        cache.CALC_VERSION,
    )


def _needs_identity_bring_forward(sf: SourceFile) -> bool:
    """True when an upgrade — not a deliberate cache clean — left this
    source's own registration behind its format's current parser identity.

    Spec 042. `cache_maintenance.py` never writes `SourceFile.parser_version`
    (verified: no reference to it anywhere in that module), so the two
    situations Spec 040.3's on-demand gate deliberately leaves unresolved are
    separable relationally, with no file I/O and no cache-existence check:

    - the user deliberately cleaned this source's cache: `parser_version`
      still equals the current expected identity, cache files are simply
      absent — this function returns False, and the startup backfill's
      other criteria (which key on `capacity_summary_status`, not on cache
      presence for an already-current source) correctly leave it alone;
    - an application upgrade changed the expected identity for this source's
      format: `parser_version` no longer matches — this function returns
      True, and the source belongs in the startup preparation work set so
      the library recovers without the user discovering Settings > Cache.

    This only brings the SourceFile's OWN registration forward to a fresh
    build at the current identity. It has nothing to do with — and must
    never be confused with — 040.3's `analysis_engine` reparse gate, which
    protects a saved analysis pinned to an older identity from ever being
    silently recomputed under a newer one. Both caches (old pinned, new
    current) coexist on disk under different identity-keyed filenames
    (`cache.raw_path`/`cache.cycles_path`); rebuilding the source's own
    current-identity cache here neither deletes nor relabels the pinned one.

    `location_status` excludes sources already proven unreachable or changed
    (by this backfill's own failed attempts, by `analysis_engine`, or by
    scan/monitor activity) so a permanently offline source is retried once —
    the failed attempt sets `location_status`, per `_apply_capacity_source_result`
    — and then skipped on every later startup without repeated retry churn.
    """
    if sf.location_status != "online":
        return False
    if sf.parser_version is None:
        return False
    expected = parsing.current_parser_identity_for_extension(sf.ext) or parsing.PARSER_VERSION
    return sf.parser_version != expected


def reconcile_retired_biologic_sources(db: Session) -> int:
    """Reconcile persisted BioLogic MPR identities without source I/O.

    The query is deliberately bounded by extension and the explicit
    pre-current identity list. It does not inspect source paths or cache
    files, and it includes offline rows so a disconnected library receives
    the same truthful capability state as an online one. The gcpl3 retirement
    and the post-R8 gcpl4 layout reconciliation have separate state rules in
    ``parsing``.
    """

    reconciliation_identities = parsing.BIOLOGIC_MPR_RECONCILIATION_IDENTITIES
    if not reconciliation_identities:
        return 0
    sources = (
        db.query(SourceFile)
        .filter(
            SourceFile.ext == "mpr",
            SourceFile.parser_version.in_(reconciliation_identities),
        )
        .all()
    )
    changed = 0
    for source in sources:
        if parsing.source_uses_retired_biologic_parser(source):
            changed += int(parsing.reclassify_retired_biologic_source(source))
        elif parsing.source_uses_pre_r8_biologic_parser(source):
            changed += int(parsing.reclassify_pre_r8_biologic_source(source))
    if changed:
        db.commit()
    return changed


def scientific_preparation_worker_count(
    n_jobs: int,
    *,
    logical_cpus: int | None = None,
) -> int:
    """Conservative foreground worker count for copied-library preparation."""
    available = logical_cpus if logical_cpus is not None else (os.cpu_count() or 1)
    half_cpus = max(1, int(available) // 2)
    return max(1, min(max(1, int(n_jobs)), 4, half_cpus))


def request_capacity_backfill_background() -> dict[str, Any] | None:
    """Make the active copied-library preparation drain into serial background work."""
    with _capacity_backfill_lock:
        if (
            not _capacity_backfill_running
            or not _capacity_backfill_adaptive
            or _capacity_backfill_job_id is None
        ):
            return None
        _capacity_backfill_background_requested.set()
        job_id = _capacity_backfill_job_id
        transition_pending = _capacity_backfill_foreground_active
    background_jobs.update_job(
        job_id,
        resource_mode="background",
        workers=1,
        transition_pending=transition_pending,
        description=(
            "Finishing active files, then continuing serially in the background"
            if transition_pending
            else "Continuing scientific preparation serially in the background"
        ),
    )
    return {
        "jobId": job_id,
        "resourceMode": "background",
        "workers": 1,
        "transitionPending": transition_pending,
    }


def start_capacity_summary_backfill(
    *,
    prepare_missing: bool = False,
) -> dict:
    """Populate missing summaries and optionally prepare every missing cache.

    A Stable-to-Beta copy carries a durable preparation marker, so its first
    post-activation pass prepares all current-version scientific caches. Normal
    startups only repair incomplete summaries and therefore do not recreate
    caches that the user deliberately cleaned.
    """
    global _capacity_backfill_adaptive
    global _capacity_backfill_job_id
    global _capacity_backfill_foreground_active
    global _capacity_backfill_running
    with _capacity_backfill_lock:
        if _capacity_backfill_running:
            return (
                background_jobs.get_job(_capacity_backfill_job_id)
                if _capacity_backfill_job_id is not None
                else {"id": None, "status": "running", "total": 0}
            ) or {"id": _capacity_backfill_job_id, "status": "running", "total": 0}
        _capacity_backfill_running = True

    db = SessionLocal()
    try:
        # Do this before selecting parsed sources. A withdrawn or pre-R8 row
        # can otherwise enter the normal identity path with stale capability
        # state when the current gcpl5 build fails closed.
        reconcile_retired_biologic_sources(db)
        preparation_state = scientific_preparation.get_state(db)
        copied_library_preparation = scientific_preparation.is_pending(preparation_state)
        prepare_all_missing = prepare_missing or copied_library_preparation
        parsed_sources = (
            db.query(SourceFile)
            .filter(SourceFile.parse_status == "parsed")
            .all()
        )
        parsed_sources = [
            source
            for source in parsed_sources
            if not parsing.source_record_metadata_only(source)
        ]
        # Spec 042: bring an identity-mismatched source's own registration
        # forward unconditionally — independent of `prepare_missing` — so an
        # upgrade that changes the expected parser identity self-heals on the
        # next normal startup rather than requiring the user to find
        # Settings > Cache > Prepare missing. This never widens to sources
        # that are merely missing a cache at their still-current identity
        # (a deliberate clean); see `_needs_identity_bring_forward`.
        identity_bring_forward_ids = {
            sf.id for sf in parsed_sources if _needs_identity_bring_forward(sf)
        }
        sources = [
            sf
            for sf in parsed_sources
            if sf.capacity_summary_status != "ready"
            or (prepare_all_missing and not _has_current_scientific_cache(sf))
            or sf.id in identity_bring_forward_ids
        ]

        if not sources:
            if scientific_preparation.is_pending(preparation_state):
                scientific_preparation.set_state(
                    db,
                    "complete",
                    total=0,
                    completed=0,
                    failed=0,
                )
                db.commit()
            with _capacity_backfill_lock:
                _capacity_backfill_running = False
                _capacity_backfill_job_id = None
                _capacity_backfill_adaptive = False
                _capacity_backfill_foreground_active = False
                _capacity_backfill_background_requested.clear()
            return {"id": None, "status": "completed", "total": 0, "completed": 0}

        # A source pulled in only because it needs its identity brought
        # forward keeps its "ready" summary untouched here rather than being
        # flipped to "pending" and possibly back to "error" on a permanently
        # unreachable source: `cell_capacity_totals` withholds ALL of a
        # cell's totals while any one source is not "ready", and this
        # source's already-computed numbers remain truthful throughout the
        # rebuild (only its per-cycle preview cache is being refreshed at
        # the new identity, not its capacity totals). Downgrading a working
        # "ready" summary to "error" purely because a permanently offline
        # source cannot be reparsed would blank a cell's totals that were
        # correctly showing a moment before the upgrade. `location_status`
        # already carries the truthful "source unreachable" signal for that
        # source; `capacity_summary_status` is deliberately left alone.
        prepare_effective = prepare_all_missing or bool(identity_bring_forward_ids)
        for sf in sources:
            if sf.capacity_summary_status != "ready":
                sf.capacity_summary_status = "pending"
        title = (
            "Preparing copied library"
            if scientific_preparation.is_pending(preparation_state)
            else "Preparing scientific data"
            if prepare_effective
            else "Capacity totals"
        )
        description = (
            f"Preparing scientific data for {len(sources)} source files"
            if prepare_effective
            else f"Calculating cached capacity totals for {len(sources)} cells"
        )
        job_id = background_jobs.create_job(
            kind="scientific_preparation" if prepare_effective else "capacity_summary",
            title=title,
            description=description,
            total=len(sources),
            items=[{"id": sf.id, "label": sf.filename} for sf in sources],
        )
        with _capacity_backfill_lock:
            _capacity_backfill_job_id = job_id
            _capacity_backfill_adaptive = copied_library_preparation
            _capacity_backfill_foreground_active = False
            _capacity_backfill_background_requested.clear()
        initial_workers = (
            scientific_preparation_worker_count(len(sources))
            if copied_library_preparation
            else 1
        )
        background_jobs.update_job(
            job_id,
            resource_mode="foreground" if copied_library_preparation else "background",
            workers=initial_workers,
            transition_pending=False,
        )
        if scientific_preparation.is_pending(preparation_state):
            scientific_preparation.set_state(
                db,
                "running",
                jobId=job_id,
                total=len(sources),
                completed=0,
                failed=0,
            )
        db.commit()
        source_ids = [sf.id for sf in sources]
    except Exception:
        with _capacity_backfill_lock:
            _capacity_backfill_running = False
            _capacity_backfill_job_id = None
            _capacity_backfill_adaptive = False
            _capacity_backfill_foreground_active = False
            _capacity_backfill_background_requested.clear()
        raise
    finally:
        db.close()

    threading.Thread(
        target=_run_capacity_summary_backfill,
        args=(
            source_ids,
            job_id,
            prepare_all_missing,
            copied_library_preparation,
        ),
        daemon=True,
        name="capacity-summary-backfill",
    ).start()
    return background_jobs.get_job(job_id) or {
        "id": job_id,
        "status": "running",
        "total": len(source_ids),
        "completed": 0,
    }


def _capacity_source_job(
    sf: SourceFile,
    *,
    prepare_all_missing: bool,
) -> dict[str, Any]:
    observed_size = sf.observed_size if sf.observed_size is not None else sf.size
    observed_mtime_ns = sf.observed_mtime_ns
    # Very old SourceFile rows predate the stored stat snapshot. Establish the
    # cheap stat half of the identity before dispatching the worker; the worker
    # still hashes once and rejects bytes that do not match sf.hash.
    if observed_mtime_ns is None:
        try:
            source_stat = Path(sf.path).stat()
        except OSError:
            source_stat = None
        if source_stat is not None:
            observed_size = source_stat.st_size
            observed_mtime_ns = source_stat.st_mtime_ns
            sf.observed_size = observed_size
            sf.observed_mtime_ns = observed_mtime_ns
    return {
        "id": sf.id,
        "hash": sf.hash,
        "path": sf.path,
        "size": observed_size,
        "filename": sf.filename,
        "ext": sf.ext,
        "source_fingerprint": {
            "hash": sf.hash,
            "size": observed_size,
            "mtime_ns": observed_mtime_ns,
        },
        "summary_was_ready": sf.capacity_summary_status == "ready",
        "prepare_all_missing": prepare_all_missing,
    }


def _prepare_capacity_source_worker(job: dict[str, Any]) -> dict[str, Any]:
    """Build one source cache without touching SQLite or process-local job state."""
    location_status: str | None = None
    source_fingerprint = job.get("source_fingerprint")
    try:
        if not isinstance(source_fingerprint, dict):
            source_fingerprint = {
                "hash": job["hash"],
                "size": job["size"],
                "mtime_ns": job.get("mtime_ns"),
            }
        expected_hash = str(source_fingerprint["hash"])
        expected_size = int(source_fingerprint["size"])
        expected_mtime_ns = source_fingerprint.get("mtime_ns")
        expected_fingerprint = (
            parsing.SourceFingerprint(
                expected_hash,
                expected_size,
                int(expected_mtime_ns),
            )
            if expected_mtime_ns is not None
            else None
        )
        expected = (
            parsing.current_parser_identity_for_extension(job.get("ext"))
            or parsing.PARSER_VERSION
        )
        cycles = cache.load_cycles(
            job["hash"],
            expected,
            cache.CALC_VERSION,
        )
        raw_ready = cache.raw_path(job["hash"], expected).is_file()
        if cycles is None or (job["prepare_all_missing"] and not raw_ready):
            source_path = Path(job["path"])
            try:
                source_stat = source_path.stat()
            except OSError as exc:
                location_status = "offline"
                raise FileNotFoundError("Original source file is unavailable") from exc
            if expected_fingerprint is None:
                expected_fingerprint = parsing.SourceFingerprint(
                    expected_hash,
                    source_stat.st_size,
                    source_stat.st_mtime_ns,
                )
                source_fingerprint = {
                    "hash": expected_fingerprint.hash,
                    "size": expected_fingerprint.size,
                    "mtime_ns": expected_fingerprint.mtime_ns,
                }
            try:
                _assert_stable_fingerprint(source_path, expected_fingerprint)
            except SourceChangedDuringRead:
                location_status = "changed"
                raise
            location_status = "online"
            try:
                info = cache.build(
                    job["hash"],
                    source_path,
                    expected_fingerprint=expected_fingerprint,
                )
            except cache.SourceChangedDuringBuild as exc:
                location_status = "changed"
                raise SourceChangedDuringRead(str(exc)) from exc
            _assert_stable_fingerprint(source_path, expected_fingerprint)
            return {
                "ok": True,
                "built": True,
                "info": info,
                "location_status": location_status,
                "source_fingerprint": source_fingerprint,
            }
        return {
            "ok": True,
            "built": False,
            "info": cache.capacity_totals(cycles),
            "location_status": location_status,
            "source_fingerprint": source_fingerprint,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "location_status": location_status,
            "source_fingerprint": source_fingerprint,
        }


def _capacity_source_job_matches(sf: SourceFile, source_job: dict[str, Any]) -> bool:
    fingerprint = source_job.get("source_fingerprint") or {}
    expected_mtime = fingerprint.get("mtime_ns")
    current_mtime = sf.observed_mtime_ns
    try:
        expected_size = int(fingerprint.get("size", source_job.get("size", -1)))
        expected_mtime_value = int(expected_mtime) if expected_mtime is not None else None
    except (TypeError, ValueError):
        return False
    mtime_matches = (
        current_mtime is None
        if expected_mtime_value is None
        else current_mtime is not None and int(current_mtime) == expected_mtime_value
    )
    return (
        sf.path == source_job.get("path")
        and sf.hash.casefold() == str(source_job.get("hash") or "").casefold()
        and int(sf.observed_size if sf.observed_size is not None else sf.size) == expected_size
        and mtime_matches
    )


def _load_capacity_source_job(
    db: Session,
    source_id: int,
    job_id: int,
    prepare_all_missing: bool,
) -> dict[str, Any] | None:
    sf = db.get(SourceFile, source_id)
    if sf is None:
        background_jobs.record_result(
            job_id,
            source_id,
            status="missing",
            detail="Scientific preparation skipped because the source record is gone",
            counter="missing",
        )
        return None
    background_jobs.update_item(job_id, sf.id, status="processing")
    source_job = _capacity_source_job(sf, prepare_all_missing=prepare_all_missing)
    # Persist a legacy row's newly established stat half before the worker is
    # dispatched. Otherwise the publication session quite correctly sees the
    # old NULL snapshot and classifies every result as stale.
    db.commit()
    return source_job


def _apply_capacity_source_result(
    db: Session,
    job_id: int,
    source_job: dict[str, Any],
    result: dict[str, Any],
) -> tuple[int, int]:
    # Do not trust the session identity map: a source can be relinked or
    # replaced by another request while the worker is reading bytes.
    sf = (
        db.query(SourceFile)
        .populate_existing()
        .filter(SourceFile.id == source_job["id"])
        .one_or_none()
    )
    if sf is None:
        background_jobs.record_result(
            job_id,
            source_job["id"],
            status="missing",
            detail="Scientific preparation result discarded because the source record is gone",
            counter="missing",
        )
        return 0, 1
    if not _capacity_source_job_matches(sf, source_job):
        background_jobs.record_result(
            job_id,
            source_job["id"],
            status="stale",
            detail="Scientific preparation result discarded because the source identity changed",
            counter="stale",
        )
        db.commit()
        return 0, 0
    if result.get("location_status"):
        sf.location_status = result["location_status"]
    if parsing.source_uses_retired_biologic_parser(sf):
        parsing.reclassify_retired_biologic_source(sf)
        warning = parsing.RETIRED_BIOLOGIC_MPR_WARNING
        logger.warning(
            "scientific preparation skipped for retired parser %s: %s",
            sf.filename,
            warning,
        )
        background_jobs.record_result(
            job_id,
            sf.id,
            status="failed",
            detail=warning,
            error=warning,
            counter="failed",
        )
        db.commit()
        return 0, 1
    if parsing.source_uses_pre_r8_biologic_parser(sf):
        parsing.reclassify_pre_r8_biologic_source(sf)
        warning = parsing.source_record_metadata_only_message(sf)
        logger.warning(
            "scientific preparation skipped for pre-R8 parser %s: %s",
            sf.filename,
            warning,
        )
        background_jobs.record_result(
            job_id,
            sf.id,
            status="failed",
            detail=warning,
            error=warning,
            counter="failed",
        )
        db.commit()
        return 0, 1
    if result.get("ok"):
        info = result["info"]
        if result.get("built"):
            sf.parser_version = info["parser_version"]
            sf.row_count = info["rows"]
            sf.cycle_count = info["cycles"]
            sf.parse_error = None
        apply_capacity_summary(sf, info)
        background_jobs.record_result(
            job_id,
            sf.id,
            status="ready",
            detail="Scientific cache and capacity totals ready",
            counter="ready",
        )
        db.commit()
        return 1, 0

    error = str(result.get("error") or "Scientific cache preparation failed")
    if result.get("location_status") == "offline":
        background_jobs.record_result(
            job_id,
            sf.id,
            status="missing",
            detail="The original source file is unavailable; no cache was published",
            counter="missing",
        )
        db.commit()
        return 0, 1
    if not source_job["summary_was_ready"]:
        sf.capacity_summary_status = "error"
    sf.parse_error = error
    logger.error("capacity summary backfill failed for %s: %s", sf.filename, error)
    background_jobs.record_result(
        job_id,
        sf.id,
        status="failed",
        error=error,
        counter="failed",
    )
    db.commit()
    return 0, 1


def _prepare_capacity_source_serial(
    db: Session,
    source_id: int,
    job_id: int,
    prepare_all_missing: bool,
    *,
    low_priority: bool,
) -> tuple[int, int]:
    from .process_priority import background_thread_priority

    global _capacity_backfill_foreground_active

    source_job = _load_capacity_source_job(
        db,
        source_id,
        job_id,
        prepare_all_missing,
    )
    if source_job is None:
        return 0, 1
    cache.wait_for_pending(source_job["hash"])
    if not low_priority:
        with _capacity_backfill_lock:
            _capacity_backfill_foreground_active = True
    try:
        with (
            cache.protect_hash_from_cleanup(source_job["hash"]),
            background_thread_priority(low_priority),
        ):
            result = _prepare_capacity_source_worker(source_job)
    finally:
        if not low_priority:
            with _capacity_backfill_lock:
                _capacity_backfill_foreground_active = False
    return _apply_capacity_source_result(db, job_id, source_job, result)


class _ForegroundPreparationPoolUnavailable(RuntimeError):
    pass


def _run_adaptive_capacity_preparation(
    db: Session,
    source_ids: list[int],
    job_id: int,
    prepare_all_missing: bool,
) -> tuple[int, int]:
    """Run foreground workers until requested to drain into serial background work."""
    global _capacity_backfill_foreground_active

    remaining = deque(source_ids)
    ready = 0
    failed = 0
    worker_count = scientific_preparation_worker_count(len(source_ids))

    if worker_count > 1 and not _capacity_backfill_background_requested.is_set():
        futures: dict[Any, tuple[dict[str, Any], Any]] = {}
        retry_ids: list[int] = []
        executor: ProcessPoolExecutor | None = None
        try:
            try:
                executor = ProcessPoolExecutor(max_workers=worker_count)
            except Exception as exc:
                raise _ForegroundPreparationPoolUnavailable from exc
            with _capacity_backfill_lock:
                _capacity_backfill_foreground_active = True
            background_jobs.update_job(
                job_id,
                resource_mode="foreground",
                workers=worker_count,
                transition_pending=False,
                description=f"Preparing scientific data with up to {worker_count} foreground workers",
            )
            while remaining or futures:
                while (
                    remaining
                    and len(futures) < worker_count
                    and not _capacity_backfill_background_requested.is_set()
                ):
                    source_id = remaining.popleft()
                    source_job = _load_capacity_source_job(
                        db,
                        source_id,
                        job_id,
                        prepare_all_missing,
                    )
                    if source_job is None:
                        failed += 1
                        continue
                    cache.wait_for_pending(source_job["hash"])
                    protection = cache.protect_hash_from_cleanup(source_job["hash"])
                    protection.__enter__()
                    try:
                        future = executor.submit(_prepare_capacity_source_worker, source_job)
                    except Exception as exc:
                        protection.__exit__(None, None, None)
                        remaining.appendleft(source_id)
                        raise _ForegroundPreparationPoolUnavailable from exc
                    futures[future] = (source_job, protection)

                if not futures:
                    break
                done, _ = wait(tuple(futures), return_when=FIRST_COMPLETED)
                for future in done:
                    source_job, protection = futures.pop(future)
                    try:
                        try:
                            result = future.result()
                        except Exception as exc:
                            remaining.appendleft(source_job["id"])
                            raise _ForegroundPreparationPoolUnavailable from exc
                    finally:
                        protection.__exit__(None, None, None)
                    ready_delta, failed_delta = _apply_capacity_source_result(
                        db,
                        job_id,
                        source_job,
                        result,
                    )
                    ready += ready_delta
                    failed += failed_delta
        except _ForegroundPreparationPoolUnavailable:
            logger.exception(
                "foreground scientific preparation pool failed; continuing serially"
            )
            retry_ids.extend(source_job["id"] for source_job, _ in futures.values())
            retry_ids.extend(remaining)
            remaining = deque(dict.fromkeys(retry_ids))
        finally:
            if executor is not None:
                for future in futures:
                    future.cancel()
                executor.shutdown(wait=True, cancel_futures=True)
            for _, protection in futures.values():
                protection.__exit__(None, None, None)
            with _capacity_backfill_lock:
                _capacity_backfill_foreground_active = False

    if remaining:
        background_mode = _capacity_backfill_background_requested.is_set()
        background_jobs.update_job(
            job_id,
            resource_mode="background" if background_mode else "foreground",
            workers=1,
            transition_pending=False,
            description=(
                "Continuing scientific preparation serially in the background"
                if background_mode
                else "Preparing scientific data one file at a time"
            ),
        )
        while remaining:
            source_id = remaining.popleft()
            ready_delta, failed_delta = _prepare_capacity_source_serial(
                db,
                source_id,
                job_id,
                prepare_all_missing,
                low_priority=background_mode,
            )
            ready += ready_delta
            failed += failed_delta
            background_mode = (
                background_mode or _capacity_backfill_background_requested.is_set()
            )
            if background_mode:
                background_jobs.update_job(
                    job_id,
                    resource_mode="background",
                    workers=1,
                    transition_pending=False,
                )
    return ready, failed


def _run_capacity_summary_backfill(
    source_ids: list[int],
    job_id: int,
    prepare_all_missing: bool,
    adaptive_foreground: bool = False,
) -> None:
    global _capacity_backfill_adaptive
    global _capacity_backfill_job_id
    global _capacity_backfill_foreground_active
    global _capacity_backfill_running

    db = SessionLocal()
    ready = 0
    failed = 0
    try:
        if adaptive_foreground:
            ready, failed = _run_adaptive_capacity_preparation(
                db,
                source_ids,
                job_id,
                prepare_all_missing,
            )
        else:
            for source_id in source_ids:
                ready_delta, failed_delta = _prepare_capacity_source_serial(
                    db,
                    source_id,
                    job_id,
                    prepare_all_missing,
                    low_priority=True,
                )
                ready += ready_delta
                failed += failed_delta
        background_jobs.update_job(
            job_id,
            status="completed",
            workers=0,
            transition_pending=False,
            description=(
                f"Prepared {ready} source files; {failed} could not be prepared"
                if prepare_all_missing
                else f"Calculated {ready} capacity summaries; {failed} failed"
            ),
        )
        preparation_state = scientific_preparation.get_state(db)
        if scientific_preparation.is_pending(preparation_state):
            scientific_preparation.set_state(
                db,
                "complete",
                jobId=job_id,
                total=len(source_ids),
                completed=ready + failed,
                failed=failed,
            )
            db.commit()
    except Exception as exc:
        background_jobs.update_job(
            job_id,
            status="failed",
            workers=0,
            transition_pending=False,
            error=str(exc),
        )
        preparation_state = scientific_preparation.get_state(db)
        if scientific_preparation.is_pending(preparation_state):
            scientific_preparation.set_state(
                db,
                "failed",
                jobId=job_id,
                total=len(source_ids),
                completed=ready + failed,
                failed=failed,
                error=str(exc),
            )
            db.commit()
        logger.exception("capacity summary backfill failed")
    finally:
        db.close()
        with _capacity_backfill_lock:
            _capacity_backfill_running = False
            _capacity_backfill_job_id = None
            _capacity_backfill_adaptive = False
            _capacity_backfill_foreground_active = False
            _capacity_backfill_background_requested.clear()


def get_job(job_id: int) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def list_jobs() -> list[dict]:
    with _lock:
        return [dict(j) for j in _jobs.values()]


def start_scan(root: str, parse_now: bool = False) -> dict:
    """Kick off a background scan of `root`. Returns the job record."""
    global _next_id
    with _lock:
        job_id = _next_id
        _next_id += 1
        job = {
            "id": job_id,
            "kind": "scan",
            "root": root,
            "status": "running",
            "found": 0,
            "done": 0,
            "new": 0,
            "relinked": 0,
            "changed": 0,
            "errors": [],
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        _jobs[job_id] = job
    threading.Thread(target=_run_scan, args=(job_id, root, parse_now), daemon=True).start()
    return dict(job)


def _update(job_id: int, **kw) -> None:
    with _lock:
        _jobs[job_id].update(kw)


def _bump(job_id: int, key: str, n: int = 1) -> None:
    with _lock:
        _jobs[job_id][key] += n


def _run_scan(job_id: int, root: str, parse_now: bool) -> None:
    from .process_priority import apply_background_thread_priority

    apply_background_thread_priority()
    try:
        paths = sorted(
            p for p in Path(root).rglob("*") if parsing.source_filename_allowed(p.name) and p.is_file()
        )
        _update(job_id, found=len(paths))
        db = SessionLocal()
        try:
            for p in paths:
                try:
                    ingest_path(db, p, parse_now=parse_now, job_id=job_id)
                except Exception as exc:
                    logger.error("scan error for %s\n%s", p, traceback.format_exc())
                    with _lock:
                        _jobs[job_id]["errors"].append(f"{p}: {exc}")
                _bump(job_id, "done")
            _update(job_id, status="completed")
        finally:
            db.close()
    except Exception as exc:
        _update(job_id, status="failed")
        with _lock:
            _jobs[job_id]["errors"].append(str(exc))


def ingest_path(db: Session, path: Path, parse_now: bool = False, job_id: int | None = None) -> SourceFile:
    """Hash + header-parse one supported source and upsert its SourceFile row."""
    if not parsing.source_filename_allowed(path.name):
        raise ValueError(
            f"{parsing.SUPPORTED_SOURCE_DESCRIPTION}; unsupported file: {path.name}"
        )
    fingerprint = parsing.capture_source_fingerprint(path)
    file_hash = fingerprint.hash
    existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing:
        parsing.assert_source_fingerprint(path, fingerprint, verify_hash=False)
        target_ext = path.suffix.casefold().lstrip(".")
        target_family = parsing.source_parser_family(path)
        registered_family = parsing.source_parser_family(existing.path or existing.ext or "")
        persisted_family = parsing.source_parser_family(existing.ext or existing.path or "")
        if (
            target_family is None
            or registered_family is None
            or persisted_family is None
            or registered_family != persisted_family
            or target_family != registered_family
        ):
            raise ValueError(
                "A known source cannot be relinked across parser families: "
                f"{existing.filename} -> {path.name}"
            )
        # same content seen again: relink path if it moved, mark online
        if (
            existing.path != str(path)
            or existing.location_status != "online"
            or existing.ext != target_ext
        ):
            existing.path = str(path)
            existing.filename = path.name
            existing.ext = target_ext
            existing.location_status = "online"
            existing.observed_size = fingerprint.size
            existing.observed_mtime_ns = fingerprint.mtime_ns
            db.commit()
            if job_id is not None:
                _bump(job_id, "relinked")
        return existing

    # Mark an already-registered path as changed before validating the new
    # header. Invalid replacement bytes must not leave the old identity falsely
    # online, but the old SourceFile row and its cache remain recoverable.
    at_path = db.query(SourceFile).filter(SourceFile.path == str(path)).first()
    if at_path is not None:
        at_path.location_status = "changed"
        if job_id is not None:
            _bump(job_id, "changed")
        db.commit()

    meta = parsing.read_header_metadata(path)
    parsing.ensure_supported_source_metadata(path, meta)
    parsing.assert_source_fingerprint(path, fingerprint, verify_hash=False)
    metadata_only = parsing.source_metadata_only(meta)

    # New content is now safe to adopt; the prior same-path identity is kept
    # in place (and already marked changed) so its caches remain untouched.
    sf = SourceFile(
        hash=file_hash,
        path=str(path),
        filename=path.name,
        size=fingerprint.size,
        ext=path.suffix.lower().lstrip("."),
        observed_size=fingerprint.size,
        observed_mtime_ns=fingerprint.mtime_ns,
        last_source_check_at=datetime.now(timezone.utc),
        nda_version=meta.get("nda_version"),
        device_info=meta.get("device_info"),
        channel=meta.get("channel"),
        barcode=meta.get("barcode"),
        remarks=meta.get("remarks"),
        start_time=meta.get("start_time"),
        active_mass_mg=meta.get("active_mass_mg"),
        nominal_capacity_mah=meta.get("nominal_capacity_mah"),
        header_meta=meta.get("raw") or None,
        location_status="online",
        parser_version=(
            parsing.current_parser_identity_for_extension(path.suffix)
            if metadata_only
            else None
        ),
        parse_status="metadata_only" if metadata_only else "unparsed",
        parse_error=(parsing.source_metadata_only_message(meta) if metadata_only else None),
        capacity_summary_status="unavailable" if metadata_only else "pending",
    )
    db.add(sf)
    db.commit()
    if job_id is not None:
        _bump(job_id, "new")
    if parse_now and not metadata_only:
        parse_file(db, sf)
    return sf


def parse_file(db: Session, sf: SourceFile) -> SourceFile:
    """Full parse → build Parquet caches at current versions."""
    if parsing.source_record_metadata_only(sf):
        if parsing.source_uses_retired_biologic_parser(sf):
            parsing.reclassify_retired_biologic_source(sf)
        elif parsing.source_uses_pre_r8_biologic_parser(sf):
            parsing.reclassify_pre_r8_biologic_source(sf)
        metadata_only_message = parsing.source_record_metadata_only_message(sf)
        if (
            not parsing.source_uses_retired_biologic_parser(sf)
            and not parsing.source_requires_biologic_mpr_reinspection(sf)
        ):
            sf.parser_version = parsing.current_parser_identity_for_extension(sf.ext)
        sf.parse_status = "metadata_only"
        sf.parse_error = metadata_only_message
        sf.capacity_summary_status = "unavailable"
        db.commit()
        return sf
    sf.parse_status = "parsing"
    sf.capacity_summary_status = "pending"
    db.commit()
    try:
        expected = (
            parsing.SourceFingerprint(
                sf.hash,
                int(sf.observed_size if sf.observed_size is not None else sf.size),
                int(sf.observed_mtime_ns),
            )
            if sf.observed_mtime_ns is not None
            else None
        )
        info = cache.build(sf.hash, sf.path, expected_fingerprint=expected)
        sf.parse_status = "parsed"
        sf.parse_error = None
        sf.parser_version = info["parser_version"]
        sf.row_count = info["rows"]
        sf.cycle_count = info["cycles"]
        apply_capacity_summary(sf, info)
    except Exception as exc:
        sf.parse_status = "error"
        sf.parse_error = str(exc)
        sf.capacity_summary_status = "error"
        logger.error("parse failed for %s\n%s", sf.path, traceback.format_exc())
    db.commit()
    return sf


def _remove_replaced_cache(db: Session, previous_hash: str, current_hash: str) -> int:
    """Discard an old scientific cache only when no source still references it."""
    if previous_hash == current_hash:
        return 0
    referenced = db.query(SourceFile.id).filter(SourceFile.hash == previous_hash).first()
    if referenced is not None:
        return 0
    try:
        return cache.remove_hash_cache(previous_hash)
    except (OSError, ValueError):
        logger.warning("could not remove replaced cache %s", previous_hash, exc_info=True)
        return 0


def update_source_from_path(db: Session, sf: SourceFile) -> SourceFile:
    """Replace a SourceFile identity/cache with the current bytes at its path."""
    previous_hash = sf.hash
    p = Path(sf.path)
    if not p.exists():
        sf.location_status = "offline"
        db.commit()
        return sf

    if not parsing.source_filename_allowed(p.name):
        raise ValueError(
            f"{parsing.SUPPORTED_SOURCE_DESCRIPTION}; unsupported file: {p.name}"
        )
    try:
        fingerprint = parsing.capture_source_fingerprint(p)
    except parsing.SourceIdentityError as exc:
        raise ValueError(str(exc)) from exc
    new_hash = fingerprint.hash
    duplicate = db.query(SourceFile).filter(SourceFile.hash == new_hash, SourceFile.id != sf.id).first()
    if duplicate is not None:
        raise ValueError("Another source file already has this content hash")

    meta = parsing.read_header_metadata(p)
    parsing.ensure_supported_source_metadata(p, meta)
    metadata_only = parsing.source_metadata_only(meta)
    try:
        parsing.assert_source_fingerprint(p, fingerprint, verify_hash=False)
        info = (
            None
            if metadata_only
            else cache.build(new_hash, p, expected_fingerprint=fingerprint)
        )
    except Exception as exc:
        # Do not replace a usable SourceFile identity until its replacement
        # cache was built against the same stable fingerprint.
        logger.error("update parse failed for %s\n%s", sf.path, traceback.format_exc())
        raise ValueError(str(exc)) from exc

    sf.hash = new_hash
    sf.filename = p.name
    sf.size = fingerprint.size
    sf.observed_mtime_ns = fingerprint.mtime_ns
    sf.observed_size = fingerprint.size
    sf.last_source_check_at = datetime.now(timezone.utc)
    sf.ext = p.suffix.lower().lstrip(".")
    sf.nda_version = meta.get("nda_version")
    sf.device_info = meta.get("device_info")
    sf.channel = meta.get("channel")
    sf.barcode = meta.get("barcode")
    sf.remarks = meta.get("remarks")
    sf.start_time = meta.get("start_time")
    sf.active_mass_mg = meta.get("active_mass_mg")
    sf.nominal_capacity_mah = meta.get("nominal_capacity_mah")
    sf.header_meta = meta.get("raw") or None
    sf.location_status = "online"
    sf.parse_status = "metadata_only" if metadata_only else "parsed"
    sf.parse_error = (
        parsing.source_metadata_only_message(meta) if metadata_only else None
    )
    sf.parser_version = (
        parsing.current_parser_identity_for_extension(sf.ext) if metadata_only else info["parser_version"]
    )
    sf.row_count = None if metadata_only else info["rows"]
    sf.cycle_count = None if metadata_only else info["cycles"]
    if metadata_only:
        sf.capacity_summary_status = "unavailable"
        sf.total_charge_capacity_mah = None
        sf.total_discharge_capacity_mah = None
        sf.max_discharge_capacity_mah = None
    else:
        apply_capacity_summary(sf, info)
    db.commit()
    if sf.hash != previous_hash:
        from . import cache_maintenance

        cell_id = sf.test_link.test.cell_id if sf.test_link and sf.test_link.test else None
        if cell_id is not None:
            cache_maintenance.invalidate_cell_dependents(
                db,
                cell_id,
                source_id=sf.id,
                queue_warmup=sf.parse_status == "parsed",
            )
            db.commit()
        _remove_replaced_cache(db, previous_hash, sf.hash)
    return sf


def update_source_from_path_if_stable(
    db: Session,
    sf: SourceFile,
    *,
    expected_size: int,
    expected_mtime_ns: int,
) -> SourceFile:
    """Adopt a source only if it remains unchanged throughout the full read."""
    previous_hash = sf.hash
    p = Path(sf.path)
    expected = (expected_size, expected_mtime_ns)
    if not parsing.source_filename_allowed(p.name):
        raise ValueError(
            f"{parsing.SUPPORTED_SOURCE_DESCRIPTION}; unsupported file: {p.name}"
        )
    _require_signature(p, expected)
    new_hash = parsing.compute_hash(p)
    expected_fingerprint = parsing.SourceFingerprint(
        new_hash,
        int(expected_size),
        int(expected_mtime_ns),
    )
    _assert_stable_fingerprint(p, expected_fingerprint)

    duplicate = db.query(SourceFile).filter(
        SourceFile.hash == new_hash,
        SourceFile.id != sf.id,
    ).first()
    if duplicate is not None:
        raise ValueError("Another source file already has this content hash")

    meta = parsing.read_header_metadata(p)
    parsing.ensure_supported_source_metadata(p, meta)
    metadata_only = parsing.source_metadata_only(meta)
    _assert_stable_fingerprint(p, expected_fingerprint)
    try:
        info = (
            None
            if metadata_only
            else cache.build(new_hash, p, expected_fingerprint=expected_fingerprint)
        )
    except cache.SourceChangedDuringBuild as exc:
        raise SourceChangedDuringRead(str(exc)) from exc
    _assert_stable_fingerprint(p, expected_fingerprint)

    sf.hash = new_hash
    sf.filename = p.name
    sf.size = expected_size
    sf.ext = p.suffix.lower().lstrip(".")
    sf.observed_size = expected_size
    sf.observed_mtime_ns = expected_mtime_ns
    sf.last_source_check_at = datetime.now(timezone.utc)
    sf.nda_version = meta.get("nda_version")
    sf.device_info = meta.get("device_info")
    sf.channel = meta.get("channel")
    sf.barcode = meta.get("barcode")
    sf.remarks = meta.get("remarks")
    sf.start_time = meta.get("start_time")
    sf.active_mass_mg = meta.get("active_mass_mg")
    sf.nominal_capacity_mah = meta.get("nominal_capacity_mah")
    sf.header_meta = meta.get("raw") or None
    sf.location_status = "online"
    sf.parse_status = "metadata_only" if metadata_only else "parsed"
    sf.parse_error = (
        parsing.source_metadata_only_message(meta) if metadata_only else None
    )
    sf.parser_version = (
        parsing.current_parser_identity_for_extension(sf.ext) if metadata_only else info["parser_version"]
    )
    sf.row_count = None if metadata_only else info["rows"]
    sf.cycle_count = None if metadata_only else info["cycles"]
    if metadata_only:
        sf.capacity_summary_status = "unavailable"
        sf.total_charge_capacity_mah = None
        sf.total_discharge_capacity_mah = None
        sf.max_discharge_capacity_mah = None
    else:
        apply_capacity_summary(sf, info)
    db.commit()
    if sf.hash != previous_hash:
        from . import cache_maintenance

        cell_id = sf.test_link.test.cell_id if sf.test_link and sf.test_link.test else None
        if cell_id is not None:
            cache_maintenance.invalidate_cell_dependents(
                db,
                cell_id,
                source_id=sf.id,
            )
            db.commit()
        _remove_replaced_cache(db, previous_hash, sf.hash)
    return sf


def check_location(db: Session, sf: SourceFile) -> SourceFile:
    """On-demand location/change check for one file (cheap: stat, then hash
    only if size or mtime suggests change is possible)."""
    p = Path(sf.path)
    if not p.exists():
        sf.location_status = "offline"
    else:
        try:
            if p.stat().st_size != sf.size or parsing.compute_hash(p) != sf.hash:
                sf.location_status = "changed"
            else:
                sf.location_status = "online"
        except OSError:
            sf.location_status = "offline"
    db.commit()
    return sf
