"""The canonical Library: cells, tests, metadata, cell tags."""
from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..db import get_db
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
from ..services import cache, parsing, scanner, stitch
from .files import file_dict

router = APIRouter(prefix="/api", tags=["library"])


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
    charge_values = []
    discharge_values = []
    for test in cell.tests:
        for link in test.file_links:
            sf = link.file
            parser_version = sf.parser_version or parsing.PARSER_VERSION
            cycles = cache.load_cycles(sf.hash, parser_version, CALC_VERSION)
            if cycles is None:
                continue
            if "charge_capacity_mah" in cycles:
                charge_values.extend(cycles["charge_capacity_mah"].dropna().tolist())
            if "discharge_capacity_mah" in cycles:
                discharge_values.extend(cycles["discharge_capacity_mah"].dropna().tolist())
    return {
        "total_charge_capacity_mah": _finite_sum(charge_values),
        "total_discharge_capacity_mah": _finite_sum(discharge_values),
    }


def cell_dict(db: Session, cell: Cell) -> dict:
    ensure_cell_caches(db, cell)
    tags = (
        db.query(Tag.name).join(CellTag, CellTag.tag_id == Tag.id).filter(CellTag.cell_id == cell.id).all()
    )
    meta = {m.key: m.value for m in cell.metadata_entries}
    n_files = sum(len(t.file_links) for t in cell.tests)
    cycles = 0
    statuses = set()
    for t in cell.tests:
        for l in t.file_links:
            if cell.cycling_status != "complete":
                scanner.check_location(db, l.file)
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
        "tags": sorted(t[0] for t in tags),
        "metadata": meta,
        "n_tests": len(cell.tests),
        "n_files": n_files,
        "total_cycles": cycles,
        **totals,
        "has_offline": "offline" in statuses,
        "has_changed": "changed" in statuses,
        "has_parsing": "parsing" in statuses,
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
    return [cell_dict(db, c) for c in q.order_by(Cell.name).all()]


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


class CellUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    archived: bool | None = None


@router.patch("/cells/{cell_id}")
def update_cell(cell_id: int, req: CellUpdate, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    if req.name is not None:
        cell.name = req.name.strip()
    if req.description is not None:
        cell.description = req.description
    if req.archived is not None:
        cell.archived = req.archived  # soft delete only — analyses keep working
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


def check_cell_sources(
    db: Session,
    cell_ids: list[int] | None = None,
    include_complete: bool = False,
    executor_cls=ProcessPoolExecutor,
    max_workers: int | None = None,
) -> dict:
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
    db.commit()
    return {"updated": updated, "cycling_status": req.cycling_status}


@router.post("/cells/check-sources")
def check_cells_sources(req: CellSourceCheckRequest, db: Session = Depends(get_db)):
    return check_cell_sources(
        db,
        cell_ids=req.cell_ids,
        include_complete=req.include_complete,
    )


@router.post("/cells/update-changed-sources")
def update_changed_cell_sources(req: CellSourceUpdateRequest, db: Session = Depends(get_db)):
    source_files, skipped_complete = _cell_source_files(
        db,
        cell_ids=req.cell_ids,
        include_complete=req.include_complete,
        changed_only=True,
    )
    updated = []
    errors = []
    for sf in source_files:
        try:
            updated_sf = scanner.update_source_from_path(db, sf)
            updated.append(updated_sf.id)
        except ValueError as exc:
            errors.append({"file_id": sf.id, "filename": sf.filename, "error": str(exc)})
    return {
        "updated": len(updated),
        "updated_file_ids": updated,
        "skipped_complete": skipped_complete,
        "errors": errors,
    }


@router.delete("/cells/{cell_id}")
def delete_cell(cell_id: int, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    result = delete_cell_from_library(db, cell)
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
