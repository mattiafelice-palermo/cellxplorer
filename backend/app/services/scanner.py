"""Background folder scanning & file registration.

Scan a directory for Neware .nda/.ndax/.xlsx files → hash → header parse → upsert
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
        preparation_state = scientific_preparation.get_state(db)
        copied_library_preparation = scientific_preparation.is_pending(preparation_state)
        prepare_all_missing = prepare_missing or copied_library_preparation
        parsed_sources = (
            db.query(SourceFile)
            .filter(SourceFile.parse_status == "parsed")
            .all()
        )
        sources = [
            sf
            for sf in parsed_sources
            if sf.capacity_summary_status != "ready"
            or (prepare_all_missing and not _has_current_scientific_cache(sf))
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

        for sf in sources:
            if sf.capacity_summary_status != "ready":
                sf.capacity_summary_status = "pending"
        title = (
            "Preparing copied library"
            if scientific_preparation.is_pending(preparation_state)
            else "Preparing scientific data"
            if prepare_all_missing
            else "Capacity totals"
        )
        description = (
            f"Preparing scientific data for {len(sources)} source files"
            if prepare_all_missing
            else f"Calculating cached capacity totals for {len(sources)} cells"
        )
        job_id = background_jobs.create_job(
            kind="scientific_preparation" if prepare_all_missing else "capacity_summary",
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
    return {
        "id": sf.id,
        "hash": sf.hash,
        "path": sf.path,
        "size": sf.size,
        "filename": sf.filename,
        "ext": sf.ext,
        "summary_was_ready": sf.capacity_summary_status == "ready",
        "prepare_all_missing": prepare_all_missing,
    }


def _prepare_capacity_source_worker(job: dict[str, Any]) -> dict[str, Any]:
    """Build one source cache without touching SQLite or process-local job state."""
    location_status: str | None = None
    try:
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
            if not source_path.exists():
                location_status = "offline"
                raise FileNotFoundError("Original source file is unavailable")
            try:
                if (
                    source_path.stat().st_size != job["size"]
                    or parsing.compute_hash(source_path) != job["hash"]
                ):
                    location_status = "changed"
                    raise SourceChangedDuringRead(
                        "Original source has changed; update it before rebuilding the cache"
                    )
            except OSError as exc:
                location_status = "offline"
                raise FileNotFoundError("Original source file is unavailable") from exc
            location_status = "online"
            expected = source_signature(source_path)
            info = cache.build(job["hash"], source_path)
            _require_signature(source_path, expected)
            return {
                "ok": True,
                "built": True,
                "info": info,
                "location_status": location_status,
            }
        return {
            "ok": True,
            "built": False,
            "info": cache.capacity_totals(cycles),
            "location_status": location_status,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "location_status": location_status,
        }


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
            status="failed",
            error="Source record no longer exists",
            counter="failed",
        )
        return None
    background_jobs.update_item(job_id, sf.id, status="processing")
    return _capacity_source_job(sf, prepare_all_missing=prepare_all_missing)


def _apply_capacity_source_result(
    db: Session,
    job_id: int,
    source_job: dict[str, Any],
    result: dict[str, Any],
) -> tuple[int, int]:
    sf = db.get(SourceFile, source_job["id"])
    if sf is None:
        background_jobs.record_result(
            job_id,
            source_job["id"],
            status="failed",
            error="Source record no longer exists",
            counter="failed",
        )
        return 0, 1
    if result.get("location_status"):
        sf.location_status = result["location_status"]
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
    """Hash + header-parse one supported Neware source and upsert its SourceFile row."""
    file_hash = parsing.compute_hash(path)
    existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing:
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
                "A known Neware source cannot be relinked across parser families: "
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
            try:
                existing.observed_size, existing.observed_mtime_ns = source_signature(path)
            except OSError:
                pass
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

    # New content is now safe to adopt; the prior same-path identity is kept
    # in place (and already marked changed) so its caches remain untouched.
    observed_size, observed_mtime_ns = source_signature(path)
    sf = SourceFile(
        hash=file_hash,
        path=str(path),
        filename=path.name,
        size=observed_size,
        ext=path.suffix.lower().lstrip("."),
        observed_size=observed_size,
        observed_mtime_ns=observed_mtime_ns,
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
        parse_status="unparsed",
    )
    db.add(sf)
    db.commit()
    if job_id is not None:
        _bump(job_id, "new")
    if parse_now:
        parse_file(db, sf)
    return sf


def parse_file(db: Session, sf: SourceFile) -> SourceFile:
    """Full parse → build Parquet caches at current versions."""
    sf.parse_status = "parsing"
    sf.capacity_summary_status = "pending"
    db.commit()
    try:
        info = cache.build(sf.hash, sf.path)
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

    new_hash = parsing.compute_hash(p)
    duplicate = db.query(SourceFile).filter(SourceFile.hash == new_hash, SourceFile.id != sf.id).first()
    if duplicate is not None:
        raise ValueError("Another source file already has this content hash")

    meta = parsing.read_header_metadata(p)
    parsing.ensure_supported_source_metadata(p, meta)
    sf.hash = new_hash
    sf.filename = p.name
    sf.size, sf.observed_mtime_ns = source_signature(p)
    sf.observed_size = sf.size
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
    sf.parse_status = "parsing"
    sf.parse_error = None
    sf.capacity_summary_status = "pending"
    db.commit()

    try:
        info = cache.build(sf.hash, p)
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
        logger.error("update parse failed for %s\n%s", sf.path, traceback.format_exc())
    # The current bytes have been adopted even if rebuilding their cache
    # failed; another source check must not be needed to clear "changed".
    sf.location_status = "online"
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
        if sf.parse_status == "parsed":
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
    _require_signature(p, expected)
    new_hash = parsing.compute_hash(p)
    _require_signature(p, expected)

    duplicate = db.query(SourceFile).filter(
        SourceFile.hash == new_hash,
        SourceFile.id != sf.id,
    ).first()
    if duplicate is not None:
        raise ValueError("Another source file already has this content hash")

    meta = parsing.read_header_metadata(p)
    parsing.ensure_supported_source_metadata(p, meta)
    _require_signature(p, expected)
    info = cache.build(new_hash, p)
    _require_signature(p, expected)

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
    sf.parse_status = "parsed"
    sf.parse_error = None
    sf.parser_version = info["parser_version"]
    sf.row_count = info["rows"]
    sf.cycle_count = info["cycles"]
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
