"""Background folder scanning & file registration.

Scan a directory for .nda/.ndax files → hash → header parse → upsert
SourceFile rows. Relinking is automatic: if a hash is already known but the
path moved, the path attribute is updated (identity is the hash).

Single-user app: one background thread, simple in-memory job registry.
"""
from __future__ import annotations

import logging
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import SourceFile
from . import cache, parsing

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_jobs: dict[int, dict] = {}
_next_id = 1


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
    try:
        paths = sorted(
            p for p in Path(root).rglob("*") if p.suffix.lower() in (".nda", ".ndax") and p.is_file()
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
    """Hash + header-parse one file and upsert its SourceFile row."""
    file_hash = parsing.compute_hash(path)
    existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing:
        # same content seen again: relink path if it moved, mark online
        if existing.path != str(path) or existing.location_status != "online":
            existing.path = str(path)
            existing.filename = path.name
            existing.location_status = "online"
            db.commit()
            if job_id is not None:
                _bump(job_id, "relinked")
        return existing

    # new content. If another row points at this same path, its content
    # changed on disk → badge it, never touch its caches.
    at_path = db.query(SourceFile).filter(SourceFile.path == str(path)).first()
    if at_path is not None:
        at_path.location_status = "changed"
        if job_id is not None:
            _bump(job_id, "changed")

    meta = parsing.read_header_metadata(path)
    sf = SourceFile(
        hash=file_hash,
        path=str(path),
        filename=path.name,
        size=path.stat().st_size,
        ext=path.suffix.lower().lstrip("."),
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
    db.commit()
    try:
        info = cache.build(sf.hash, sf.path)
        sf.parse_status = "parsed"
        sf.parse_error = None
        sf.parser_version = info["parser_version"]
        sf.row_count = info["rows"]
        sf.cycle_count = info["cycles"]
    except Exception as exc:
        sf.parse_status = "error"
        sf.parse_error = str(exc)
        logger.error("parse failed for %s\n%s", sf.path, traceback.format_exc())
    db.commit()
    return sf


def update_source_from_path(db: Session, sf: SourceFile) -> SourceFile:
    """Replace a SourceFile identity/cache with the current bytes at its path."""
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
    sf.hash = new_hash
    sf.filename = p.name
    sf.size = p.stat().st_size
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
    db.commit()

    try:
        info = cache.build(sf.hash, p)
        sf.parse_status = "parsed"
        sf.parse_error = None
        sf.parser_version = info["parser_version"]
        sf.row_count = info["rows"]
        sf.cycle_count = info["cycles"]
    except Exception as exc:
        sf.parse_status = "error"
        sf.parse_error = str(exc)
        logger.error("update parse failed for %s\n%s", sf.path, traceback.format_exc())
    db.commit()
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
