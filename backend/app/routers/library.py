"""The canonical Library: cells, tests, metadata, cell tags."""
from __future__ import annotations

import os
import threading
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session, selectinload

from ..config import CALC_VERSION
from ..db import SessionLocal, get_db
from ..models import (
    Cell,
    CellMetadata,
    CellTag,
    FolderCell,
    FolderReplicateGroup,
    GroupCell,
    ProjectCell,
    ReplicateGroup,
    ReplicateGroupCell,
    SourceFile,
    Tag,
    Test,
    TestFile,
)
from ..services import analysis_engine as analysis_svc
from ..services import background_jobs
from ..services.activity_log import record_activity
from ..services import cache, parsing, protocol, scanner, stitch
from .files import file_dict

router = APIRouter(prefix="/api", tags=["library"])

_source_check_job_lock = threading.Lock()
_source_check_jobs: dict[int, dict] = {}
_latest_source_check_job_id: int | None = None
_next_source_check_job_id = 1


def source_file_needs_cache(sf: SourceFile) -> bool:
    if sf.parse_status != "parsed":
        return True
    if sf.parser_version != parsing.PARSER_VERSION:
        return True
    if sf.cycle_count is None or sf.row_count is None:
        return True
    return not cache.has_cycles(sf.hash, sf.parser_version, CALC_VERSION)


def ensure_cell_caches(db: Session, cell: Cell) -> None:
    for test in cell.tests:
        for link in test.file_links:
            sf = link.file
            if sf.parse_status == "parsing":
                continue
            if source_file_needs_cache(sf) and Path(sf.path).exists():
                scanner.parse_file(db, sf)


def delete_empty_replicate_groups(db: Session) -> list[int]:
    group_ids = [row[0] for row in db.query(ReplicateGroup.id).all()]
    deleted: list[int] = []
    for group_id in group_ids:
        n_cells = (
            db.query(ReplicateGroupCell)
            .filter(ReplicateGroupCell.group_id == group_id)
            .count()
        )
        if n_cells == 0:
            db.query(FolderReplicateGroup).filter(
                FolderReplicateGroup.group_id == group_id
            ).delete(synchronize_session=False)
            group = db.get(ReplicateGroup, group_id)
            if group is not None:
                db.delete(group)
                deleted.append(group_id)
    return deleted


def delete_cell_from_library(db: Session, cell: Cell) -> dict:
    """Remove a cell and every active reference to it.

    SourceFile rows are deliberately kept. Deleting TestFile/Test records makes
    the original file unregistered again, so the same data can be imported as a
    new cell while preserving checksum/path history.
    """
    cell_id = cell.id
    db.query(FolderCell).filter(FolderCell.cell_id == cell_id).delete(synchronize_session=False)
    db.query(ProjectCell).filter(ProjectCell.cell_id == cell_id).delete(synchronize_session=False)
    db.query(GroupCell).filter(GroupCell.cell_id == cell_id).delete(synchronize_session=False)
    db.query(ReplicateGroupCell).filter(ReplicateGroupCell.cell_id == cell_id).delete(
        synchronize_session=False
    )
    db.query(CellTag).filter(CellTag.cell_id == cell_id).delete(synchronize_session=False)
    db.query(CellMetadata).filter(CellMetadata.cell_id == cell_id).delete(synchronize_session=False)

    test_ids = [row[0] for row in db.query(Test.id).filter(Test.cell_id == cell_id).all()]
    if test_ids:
        db.query(TestFile).filter(TestFile.test_id.in_(test_ids)).delete(synchronize_session=False)
        db.query(Test).filter(Test.id.in_(test_ids)).delete(synchronize_session=False)

    db.delete(cell)
    deleted_groups = delete_empty_replicate_groups(db)
    return {"deleted_cell_id": cell_id, "deleted_replicate_group_ids": deleted_groups}


def delete_cells_from_library(db: Session, cell_ids: list[int]) -> dict:
    unique_ids = list(dict.fromkeys(int(cell_id) for cell_id in cell_ids))
    if not unique_ids:
        return {
            "deleted_cell_ids": [],
            "deleted_replicate_group_ids": [],
            "missing_cell_ids": [],
        }
    cells = {
        cell.id: cell
        for cell in db.query(Cell).filter(Cell.id.in_(unique_ids)).all()
    }
    deleted_cell_ids: list[int] = []
    deleted_group_ids: list[int] = []
    for cell_id in unique_ids:
        cell = cells.get(cell_id)
        if cell is None:
            continue
        result = delete_cell_from_library(db, cell)
        deleted_cell_ids.append(result["deleted_cell_id"])
        deleted_group_ids.extend(result["deleted_replicate_group_ids"])
    return {
        "deleted_cell_ids": deleted_cell_ids,
        "deleted_replicate_group_ids": list(dict.fromkeys(deleted_group_ids)),
        "missing_cell_ids": [cell_id for cell_id in unique_ids if cell_id not in cells],
    }


def _finite_sum(values) -> float | None:
    total = 0.0
    found = False
    for value in values:
        if value is None:
            continue
        try:
            if np.isnan(value):
                continue
        except TypeError:
            pass
        total += float(value)
        found = True
    return round(total, 6) if found else None


def cell_capacity_totals(cell: Cell) -> dict:
    source_files = []
    for test in cell.tests:
        for link in test.file_links:
            source_files.append(link.file)
    if any(sf.capacity_summary_status != "ready" for sf in source_files):
        return {
            "total_charge_capacity_mah": None,
            "total_discharge_capacity_mah": None,
        }
    return {
        "total_charge_capacity_mah": _finite_sum(
            sf.total_charge_capacity_mah for sf in source_files
        ),
        "total_discharge_capacity_mah": _finite_sum(
            sf.total_discharge_capacity_mah for sf in source_files
        ),
    }


def cell_dict(db: Session, cell: Cell, tag_names: list[str] | None = None) -> dict:
    if tag_names is None:
        tags = (
            db.query(Tag.name)
            .join(CellTag, CellTag.tag_id == Tag.id)
            .filter(CellTag.cell_id == cell.id)
            .all()
        )
        tag_names = [row[0] for row in tags]
    meta = {m.key: m.value for m in cell.metadata_entries}
    n_files = sum(len(t.file_links) for t in cell.tests)
    cycles = 0
    statuses = set()
    for t in cell.tests:
        for l in t.file_links:
            cycles += l.file.cycle_count or 0
            statuses.add(l.file.location_status)
            statuses.add(l.file.parse_status)
    totals = cell_capacity_totals(cell)
    cell.total_charge_capacity_mah = totals["total_charge_capacity_mah"]
    cell.total_discharge_capacity_mah = totals["total_discharge_capacity_mah"]
    return {
        "id": cell.id,
        "name": cell.name,
        "description": cell.description,
        "archived": cell.archived,
        "cycling_status": cell.cycling_status,
        "tags": sorted(tag_names),
        "metadata": meta,
        "n_tests": len(cell.tests),
        "n_files": n_files,
        "total_cycles": cycles,
        **totals,
        "has_offline": "offline" in statuses,
        "has_changed": "changed" in statuses,
        "has_parsing": "parsing" in statuses,
        "has_summary_pending": any(
            link.file.parse_status == "parsed"
            and link.file.capacity_summary_status == "pending"
            for test in cell.tests
            for link in test.file_links
        ),
        "has_summary_error": any(
            link.file.parse_status == "parsed"
            and link.file.capacity_summary_status == "error"
            for test in cell.tests
            for link in test.file_links
        ),
        "created_at": cell.created_at.isoformat(),
    }


@router.get("/cells")
def list_cells(
    search: str | None = None,
    tag: str | None = None,
    folder_id: int | None = None,
    project_id: int | None = None,
    include_archived: bool = False,
    db: Session = Depends(get_db),
):
    q = db.query(Cell)
    if not include_archived:
        q = q.filter(Cell.archived == False)  # noqa: E712
    if search:
        q = q.filter(Cell.name.ilike(f"%{search}%"))
    if tag:
        sub = db.query(CellTag.cell_id).join(Tag, Tag.id == CellTag.tag_id).filter(Tag.name == tag).scalar_subquery()
        q = q.filter(Cell.id.in_(sub))
    if folder_id is not None:
        sub = db.query(FolderCell.cell_id).filter(FolderCell.folder_id == folder_id).scalar_subquery()
        q = q.filter(Cell.id.in_(sub))
    if project_id is not None:
        sub = db.query(ProjectCell.cell_id).filter(ProjectCell.project_id == project_id).scalar_subquery()
        q = q.filter(Cell.id.in_(sub))
    cells = (
        q.options(
            selectinload(Cell.metadata_entries),
            selectinload(Cell.tests)
            .selectinload(Test.file_links)
            .selectinload(TestFile.file),
        )
        .order_by(Cell.name)
        .all()
    )
    tags_by_cell: dict[int, list[str]] = {cell.id: [] for cell in cells}
    if cells:
        tag_rows = (
            db.query(CellTag.cell_id, Tag.name)
            .join(Tag, CellTag.tag_id == Tag.id)
            .filter(CellTag.cell_id.in_(tags_by_cell))
            .all()
        )
        for cell_id, tag_name in tag_rows:
            tags_by_cell[cell_id].append(tag_name)
    return [cell_dict(db, cell, tags_by_cell[cell.id]) for cell in cells]


class CellCreate(BaseModel):
    name: str
    description: str | None = None


@router.post("/cells")
def create_cell(req: CellCreate, db: Session = Depends(get_db)):
    if db.query(Cell).filter(Cell.name == req.name.strip()).first():
        raise HTTPException(409, "A cell with that name already exists")
    cell = Cell(name=req.name.strip(), description=req.description)
    db.add(cell)
    db.commit()
    return cell_dict(db, cell)


@router.get("/cells/{cell_id}")
def get_cell(cell_id: int, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    d = cell_dict(db, cell)
    d["tests"] = [
        {
            "id": t.id,
            "name": t.name,
            "description": t.description,
            "files": [file_dict(l.file) for l in sorted(t.file_links, key=lambda l: l.position)],
        }
        for t in sorted(cell.tests, key=lambda t: t.id)
    ]
    return d


@router.get("/cells/{cell_id}/protocol")
def get_cell_protocol(cell_id: int, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    return {
        "cell_id": cell.id,
        "cell_name": cell.name,
        "tests": [
            {
                "id": test.id,
                "name": test.name,
                "files": [
                    {
                        "id": link.file.id,
                        "filename": link.file.filename,
                        "path": link.file.path,
                        "protocol": protocol.reconstruct_protocol(
                            link.file.header_meta,
                            link.file.nominal_capacity_mah,
                        ),
                    }
                    for link in sorted(test.file_links, key=lambda item: item.position)
                ],
            }
            for test in sorted(cell.tests, key=lambda item: item.id)
        ],
    }


class CellUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    archived: bool | None = None


@router.patch("/cells/{cell_id}")
def update_cell(cell_id: int, req: CellUpdate, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    changed_fields: list[str] = []
    previous_name = cell.name
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(400, "Cell name is required")
        duplicate = (
            db.query(Cell)
            .filter(Cell.name == name, Cell.id != cell.id)
            .first()
        )
        if duplicate is not None:
            raise HTTPException(409, "A cell with that name already exists")
        if name != cell.name:
            cell.name = name
            changed_fields.append("name")
    if req.description is not None:
        description = req.description.strip() or None
        if description != cell.description:
            cell.description = description
            changed_fields.append("notes")
    if req.archived is not None:
        if req.archived != cell.archived:
            cell.archived = req.archived  # soft delete only — analyses keep working
            changed_fields.append("archived")
    if changed_fields:
        record_activity(
            db,
            category="cell",
            action="edit_cell",
            message=f"Edited cell {cell.name}",
            entity_type="cell",
            entity_id=cell.id,
            details={
                "changed_fields": changed_fields,
                "previous_name": previous_name if "name" in changed_fields else None,
                "name": cell.name,
            },
        )
    db.commit()
    return cell_dict(db, cell)


class CellStatusRequest(BaseModel):
    cell_ids: list[int]
    cycling_status: Literal["active", "complete"]


class CellSourceCheckRequest(BaseModel):
    cell_ids: list[int] | None = None
    include_complete: bool = False


class CellSourceUpdateRequest(BaseModel):
    cell_ids: list[int] | None = None
    include_complete: bool = False


class CellDeleteRequest(BaseModel):
    cell_ids: list[int]


def _cell_source_files(
    db: Session,
    cell_ids: list[int] | None = None,
    include_complete: bool = False,
    changed_only: bool = False,
) -> tuple[list[SourceFile], int]:
    q = db.query(Cell).filter(Cell.archived == False)  # noqa: E712
    if cell_ids is not None:
        unique_ids = list(dict.fromkeys(cell_ids))
        if not unique_ids:
            return [], 0
        q = q.filter(Cell.id.in_(unique_ids))
    if not include_complete:
        q = q.filter(Cell.cycling_status != "complete")
    cells = q.all()
    skipped_complete = 0
    if cell_ids is not None and not include_complete:
        skipped_complete = (
            db.query(Cell)
            .filter(Cell.id.in_(list(dict.fromkeys(cell_ids))), Cell.cycling_status == "complete")
            .count()
        )
    files_by_id: dict[int, SourceFile] = {}
    for cell in cells:
        for test in cell.tests:
            for link in test.file_links:
                sf = link.file
                if changed_only and sf.location_status != "changed":
                    continue
                files_by_id[sf.id] = sf
    return list(files_by_id.values()), skipped_complete


def _source_check_worker(job: dict) -> dict:
    path = Path(job["path"])
    if not path.exists():
        return {"id": job["id"], "location_status": "offline", "hash": None}
    try:
        current_hash = parsing.compute_hash(path)
    except OSError:
        return {"id": job["id"], "location_status": "offline", "hash": None}
    return {
        "id": job["id"],
        "location_status": "changed" if current_hash != job["hash"] else "online",
        "hash": current_hash,
    }


def cell_source_check_worker_count(n_jobs: int, max_workers: int | None = None) -> int:
    available = max_workers or os.cpu_count() or 1
    return max(1, min(n_jobs, available))


def _source_check_job_snapshot(job_id: int) -> dict | None:
    with _source_check_job_lock:
        job = _source_check_jobs.get(job_id)
        return deepcopy(job) if job else None


def _update_source_check_job(job_id: int, **values) -> None:
    with _source_check_job_lock:
        if job_id in _source_check_jobs:
            _source_check_jobs[job_id].update(values)


def _update_source_check_file(job_id: int, file_id: int, **values) -> None:
    background_job_id = None
    with _source_check_job_lock:
        job = _source_check_jobs.get(job_id)
        if not job:
            return
        background_job_id = job.get("background_job_id")
        for row in job["files"]:
            if row["file_id"] == file_id:
                row.update(values)
                break
    if background_job_id is not None:
        status = values.get("status")
        background_jobs.update_item(
            background_job_id,
            file_id,
            status="processing" if status == "checking" else status,
        )


def _record_source_check_result(job_id: int, db: Session, source_job: dict, result: dict) -> None:
    status = result.get("location_status", "error")
    sf = db.get(SourceFile, source_job["id"])
    if sf is not None and status in {"online", "changed", "offline"}:
        sf.location_status = status
        db.commit()

    background_job_id = None
    with _source_check_job_lock:
        job = _source_check_jobs[job_id]
        background_job_id = job.get("background_job_id")
        job["completed"] += 1
        if status in {"online", "changed", "offline"}:
            job[status] += 1
        else:
            job["errors"] += 1
        if status == "changed":
            job["changed_file_ids"].append(source_job["id"])
        for row in job["files"]:
            if row["file_id"] == source_job["id"]:
                row["status"] = status
                if result.get("error"):
                    row["error"] = result["error"]
                break
    if background_job_id is not None:
        display_status = "ready" if status == "online" else "failed" if status == "error" else status
        background_jobs.record_result(
            background_job_id,
            source_job["id"],
            status=display_status,
            detail="Source matches the registered checksum" if status == "online" else None,
            error=result.get("error"),
            counter="failed" if status == "error" else status,
        )


def _run_source_check_job(job_id: int, jobs: list[dict], worker_count: int) -> None:
    db = SessionLocal()
    try:
        if not jobs:
            _update_source_check_job(
                job_id,
                status="completed",
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
            snapshot = _source_check_job_snapshot(job_id)
            if snapshot and snapshot.get("background_job_id") is not None:
                background_jobs.update_job(
                    snapshot["background_job_id"],
                    status="completed",
                    description="No active source files needed checking",
                )
        elif worker_count == 1:
            for source_job in jobs:
                _update_source_check_file(job_id, source_job["id"], status="checking")
                try:
                    result = _source_check_worker(source_job)
                except Exception as exc:  # keep the remaining files moving
                    result = {
                        "id": source_job["id"],
                        "location_status": "error",
                        "error": str(exc),
                    }
                _record_source_check_result(job_id, db, source_job, result)
        else:
            pending = iter(jobs)
            with ProcessPoolExecutor(max_workers=worker_count) as executor:
                futures: dict = {}

                def submit_next() -> bool:
                    try:
                        source_job = next(pending)
                    except StopIteration:
                        return False
                    _update_source_check_file(job_id, source_job["id"], status="checking")
                    futures[executor.submit(_source_check_worker, source_job)] = source_job
                    return True

                for _ in range(worker_count):
                    if not submit_next():
                        break
                while futures:
                    done, _ = wait(tuple(futures), return_when=FIRST_COMPLETED)
                    for future in done:
                        source_job = futures.pop(future)
                        try:
                            result = future.result()
                        except Exception as exc:  # one broken file must not stop the batch
                            result = {
                                "id": source_job["id"],
                                "location_status": "error",
                                "error": str(exc),
                            }
                        _record_source_check_result(job_id, db, source_job, result)
                        submit_next()

        snapshot = _source_check_job_snapshot(job_id)
        if snapshot and snapshot["status"] == "running":
            _update_source_check_job(
                job_id,
                status="completed",
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
            snapshot = _source_check_job_snapshot(job_id)
        if snapshot and snapshot.get("background_job_id") is not None:
            background_jobs.update_job(
                snapshot["background_job_id"],
                status="completed",
                description=(
                    f"Checked {snapshot['completed']} source files: "
                    f"{snapshot['changed']} changed, {snapshot['offline']} offline"
                ),
            )
        if snapshot:
            severity = "warning" if snapshot["changed"] or snapshot["offline"] or snapshot["errors"] else "info"
            record_activity(
                db,
                category="source",
                action="check_sources",
                message=(
                    f"Checked {snapshot['completed']} source files: "
                    f"{snapshot['changed']} changed, {snapshot['offline']} offline"
                ),
                severity=severity,
                details={
                    "checked": snapshot["completed"],
                    "skipped_complete": snapshot["skipped_complete"],
                    "changed": snapshot["changed"],
                    "offline": snapshot["offline"],
                    "online": snapshot["online"],
                    "errors": snapshot["errors"],
                    "changed_file_ids": snapshot["changed_file_ids"],
                    "workers": snapshot["workers"],
                },
                started_at=datetime.fromisoformat(snapshot["started_at"]),
                finished_at=datetime.fromisoformat(
                    snapshot["completed_at"] or datetime.now(timezone.utc).isoformat()
                ),
            )
            db.commit()
    except Exception as exc:
        _update_source_check_job(
            job_id,
            status="failed",
            error=str(exc),
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
        snapshot = _source_check_job_snapshot(job_id)
        if snapshot and snapshot.get("background_job_id") is not None:
            background_jobs.update_job(
                snapshot["background_job_id"],
                status="failed",
                error=str(exc),
            )
    finally:
        db.close()


def start_source_check_job(
    db: Session,
    cell_ids: list[int] | None = None,
    include_complete: bool = False,
) -> dict:
    global _latest_source_check_job_id, _next_source_check_job_id
    with _source_check_job_lock:
        if _latest_source_check_job_id is not None:
            current = _source_check_jobs.get(_latest_source_check_job_id)
            if current and current["status"] == "running":
                return deepcopy(current)

    source_files, skipped_complete = _cell_source_files(
        db,
        cell_ids=cell_ids,
        include_complete=include_complete,
    )
    jobs = [
        {
            "id": sf.id,
            "path": sf.path,
            "hash": sf.hash,
            "filename": sf.filename,
        }
        for sf in source_files
    ]
    worker_count = cell_source_check_worker_count(len(jobs))
    now = datetime.now(timezone.utc).isoformat()
    background_job_id = background_jobs.create_job(
        kind="source_check",
        title="Checking sources",
        description=f"Checking checksums for {len(jobs)} source files",
        total=len(jobs),
        items=[{"id": source_job["id"], "label": source_job["filename"]} for source_job in jobs],
    )
    with _source_check_job_lock:
        job_id = _next_source_check_job_id
        _next_source_check_job_id += 1
        job = {
            "id": job_id,
            "status": "running",
            "total": len(jobs),
            "completed": 0,
            "online": 0,
            "changed": 0,
            "offline": 0,
            "errors": 0,
            "skipped_complete": skipped_complete,
            "changed_file_ids": [],
            "requested_cell_ids": list(dict.fromkeys(cell_ids or [])),
            "workers": worker_count,
            "files": [
                {
                    "file_id": source_job["id"],
                    "filename": source_job["filename"],
                    "status": "queued",
                    "error": None,
                }
                for source_job in jobs
            ],
            "started_at": now,
            "completed_at": None,
            "error": None,
            "background_job_id": background_job_id,
        }
        _source_check_jobs[job_id] = job
        _latest_source_check_job_id = job_id
        old_ids = sorted(_source_check_jobs)[:-20]
        for old_id in old_ids:
            _source_check_jobs.pop(old_id, None)

    threading.Thread(
        target=_run_source_check_job,
        args=(job_id, jobs, worker_count),
        daemon=True,
        name=f"source-check-{job_id}",
    ).start()
    return _source_check_job_snapshot(job_id) or job


def check_cell_sources(
    db: Session,
    cell_ids: list[int] | None = None,
    include_complete: bool = False,
    executor_cls=ProcessPoolExecutor,
    max_workers: int | None = None,
) -> dict:
    started_at = datetime.now(timezone.utc)
    source_files, skipped_complete = _cell_source_files(
        db,
        cell_ids=cell_ids,
        include_complete=include_complete,
    )
    jobs = [{"id": sf.id, "path": sf.path, "hash": sf.hash} for sf in source_files]
    worker_count = cell_source_check_worker_count(len(jobs), max_workers=max_workers)
    if worker_count == 1:
        results = [_source_check_worker(job) for job in jobs]
    else:
        with executor_cls(max_workers=worker_count) as executor:
            results = list(executor.map(_source_check_worker, jobs))

    by_id = {sf.id: sf for sf in source_files}
    counts = {"online": 0, "changed": 0, "offline": 0}
    changed_file_ids: list[int] = []
    for result in results:
        sf = by_id.get(result["id"])
        if sf is None:
            continue
        status = result["location_status"]
        sf.location_status = status
        if status in counts:
            counts[status] += 1
        if status == "changed":
            changed_file_ids.append(sf.id)
    severity = "warning" if counts["changed"] or counts["offline"] else "info"
    record_activity(
        db,
        category="source",
        action="check_sources",
        message=(
            f"Checked {len(results)} source files: "
            f"{counts['changed']} changed, {counts['offline']} offline"
        ),
        severity=severity,
        details={
            "checked": len(results),
            "skipped_complete": skipped_complete,
            "changed": counts["changed"],
            "offline": counts["offline"],
            "online": counts["online"],
            "changed_file_ids": changed_file_ids,
        },
        started_at=started_at,
        finished_at=datetime.now(timezone.utc),
    )
    db.commit()
    return {
        "checked": len(results),
        "skipped_complete": skipped_complete,
        "changed": counts["changed"],
        "offline": counts["offline"],
        "online": counts["online"],
        "changed_file_ids": changed_file_ids,
    }


@router.post("/cells/status")
def set_cells_status(req: CellStatusRequest, db: Session = Depends(get_db)):
    unique_ids = list(dict.fromkeys(req.cell_ids))
    if not unique_ids:
        raise HTTPException(400, "No cells selected")
    updated = (
        db.query(Cell)
        .filter(Cell.id.in_(unique_ids), Cell.archived == False)  # noqa: E712
        .update({Cell.cycling_status: req.cycling_status}, synchronize_session="fetch")
    )
    record_activity(
        db,
        category="cell",
        action="set_status",
        message=f"Marked {updated} cells as {req.cycling_status}",
        details={"cell_ids": unique_ids, "cycling_status": req.cycling_status, "updated": updated},
    )
    db.commit()
    return {"updated": updated, "cycling_status": req.cycling_status}


@router.post("/cells/check-sources")
def check_cells_sources(req: CellSourceCheckRequest, db: Session = Depends(get_db)):
    return check_cell_sources(
        db,
        cell_ids=req.cell_ids,
        include_complete=req.include_complete,
    )


@router.post("/cells/check-sources/jobs")
def create_source_check_job(req: CellSourceCheckRequest, db: Session = Depends(get_db)):
    return start_source_check_job(
        db,
        cell_ids=req.cell_ids,
        include_complete=req.include_complete,
    )


@router.get("/source-check-jobs/latest")
def latest_source_check_job():
    with _source_check_job_lock:
        job_id = _latest_source_check_job_id
    return _source_check_job_snapshot(job_id) if job_id is not None else None


@router.get("/source-check-jobs/{job_id}")
def source_check_job(job_id: int):
    job = _source_check_job_snapshot(job_id)
    if job is None:
        raise HTTPException(404, "No such source-check job")
    return job


@router.post("/cells/update-changed-sources")
def update_changed_cell_sources(req: CellSourceUpdateRequest, db: Session = Depends(get_db)):
    source_files, skipped_complete = _cell_source_files(
        db,
        cell_ids=req.cell_ids,
        include_complete=req.include_complete,
        changed_only=True,
    )
    updated = []
    ready_cell_ids: set[int] = set()
    errors = []
    for sf in source_files:
        try:
            updated_sf = scanner.update_source_from_path(db, sf)
            updated.append(updated_sf.id)
            if updated_sf.test_link and updated_sf.test_link.test:
                ready_cell_ids.add(updated_sf.test_link.test.cell_id)
        except ValueError as exc:
            errors.append({"file_id": sf.id, "filename": sf.filename, "error": str(exc)})
    record_activity(
        db,
        category="source",
        action="update_changed_sources",
        message=f"Updated {len(updated)} changed source files",
        severity="warning" if errors else "info",
        details={
            "updated_file_ids": updated,
            "ready_cell_ids": sorted(ready_cell_ids),
            "updated": len(updated),
            "skipped_complete": skipped_complete,
            "errors": errors,
        },
    )
    db.commit()
    return {
        "updated": len(updated),
        "updated_file_ids": updated,
        "ready_cell_ids": sorted(ready_cell_ids),
        "skipped_complete": skipped_complete,
        "errors": errors,
    }


@router.post("/cells/delete")
def delete_cells(req: CellDeleteRequest, db: Session = Depends(get_db)):
    result = delete_cells_from_library(db, req.cell_ids)
    if not result["deleted_cell_ids"] and result["missing_cell_ids"]:
        raise HTTPException(404, "No selected cells were found")
    record_activity(
        db,
        category="cell",
        action="delete_cells",
        message=f"Removed {len(result['deleted_cell_ids'])} cells from the database",
        severity="warning",
        details=result,
    )
    db.commit()
    return {"ok": True, **result}


@router.delete("/cells/{cell_id}")
def delete_cell(cell_id: int, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    result = delete_cell_from_library(db, cell)
    record_activity(
        db,
        category="cell",
        action="delete_cells",
        message="Removed 1 cell from the database",
        severity="warning",
        entity_type="cell",
        entity_id=cell_id,
        details=result,
    )
    db.commit()
    return {"ok": True, **result}


class MetadataSet(BaseModel):
    """Bulk metadata set — supports table paste: rows of {cell (name or id), key: value...}."""

    updates: list[dict]  # [{cell_id | cell_name, values: {key: value}}]


@router.post("/cells/metadata")
def set_metadata(req: MetadataSet, db: Session = Depends(get_db)):
    applied, unknown = 0, []
    for upd in req.updates:
        cell = None
        if upd.get("cell_id") is not None:
            cell = db.get(Cell, upd["cell_id"])
        elif upd.get("cell_name"):
            cell = db.query(Cell).filter(Cell.name == str(upd["cell_name"]).strip()).first()
        if cell is None:
            unknown.append(upd.get("cell_name") or upd.get("cell_id"))
            continue
        for key, value in (upd.get("values") or {}).items():
            key = str(key).strip()
            if not key:
                continue
            row = (
                db.query(CellMetadata)
                .filter(CellMetadata.cell_id == cell.id, CellMetadata.key == key)
                .first()
            )
            if value is None or str(value).strip() == "":
                if row:
                    db.delete(row)
            elif row:
                row.value = str(value)
            else:
                db.add(CellMetadata(cell_id=cell.id, key=key, value=str(value)))
            applied += 1
    db.commit()
    return {"applied": applied, "unknown_cells": unknown}


@router.get("/metadata/keys")
def metadata_keys(db: Session = Depends(get_db)):
    rows = db.query(CellMetadata.key).distinct().all()
    return sorted(r[0] for r in rows)


class CellTagsSet(BaseModel):
    tags: list[str]


@router.put("/cells/{cell_id}/tags")
def set_cell_tags(cell_id: int, req: CellTagsSet, db: Session = Depends(get_db)):
    """Assign tags. Tags must already exist in the central registry
    (creating a tag is a deliberate act via POST /api/tags)."""
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    tags = db.query(Tag).filter(Tag.name.in_(req.tags)).all()
    if len(tags) != len(set(req.tags)):
        known = {t.name for t in tags}
        raise HTTPException(422, f"Unregistered tag(s): {sorted(set(req.tags) - known)}")
    db.query(CellTag).filter(CellTag.cell_id == cell_id).delete()
    for t in tags:
        db.add(CellTag(cell_id=cell_id, tag_id=t.id))
    db.commit()
    return cell_dict(db, cell)


@router.get("/cells/{cell_id}/cycles")
def cell_cycles(cell_id: int, db: Session = Depends(get_db)):
    """Stitched per-cycle record for one cell at CURRENT versions
    (parse-on-demand so a cell is plottable seconds after registration)."""
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    hashes, files = analysis_svc.cell_ordered_hashes(db, cell)
    from pathlib import Path

    from ..services import scanner

    for f in files:
        if f.parse_status in ("unparsed", "error") and Path(f.path).exists():
            scanner.parse_file(db, f)
    stitched, segments, missing = stitch.stitch_cycles(hashes, parsing.PARSER_VERSION, CALC_VERSION)
    if stitched.empty:
        return {"columns": [], "rows": [], "segments": segments, "missing": missing}
    stitched = stitched.replace({np.nan: None}).drop(columns=["start_timestamp"], errors="ignore")
    return {
        "columns": list(stitched.columns),
        "rows": stitched.to_dict("records"),
        "segments": segments,
        "missing": missing,
    }


class TestUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


@router.patch("/tests/{test_id}")
def update_test(test_id: int, req: TestUpdate, db: Session = Depends(get_db)):
    test = db.get(Test, test_id)
    if test is None:
        raise HTTPException(404, "No such test")
    if req.name is not None:
        test.name = req.name.strip()
    if req.description is not None:
        test.description = req.description
    db.commit()
    return {"ok": True}


@router.delete("/tests/{test_id}")
def delete_test(test_id: int, db: Session = Depends(get_db)):
    test = db.get(Test, test_id)
    if test is None:
        raise HTTPException(404, "No such test")
    db.delete(test)  # files become unregistered again (links cascade)
    db.commit()
    return {"ok": True}
