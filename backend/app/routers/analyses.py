"""Analyses: persistent cycling-comparison specifications + flat index.

Filing to a folder is optional and has zero effect on reachable data —
an analysis selects cells and replicate groups by identity from anywhere
in the library. Compute renders from versioned caches at provenance-pinned
versions; recompute (explicit) moves to current versions.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Analysis, Folder
from ..services import analysis_engine as engine
from ..services.entity_ids import next_analysis_id

router = APIRouter(prefix="/api", tags=["analyses"])


def duplicate_title(db: Session, original: str) -> str:
    candidate = f"(copy) {original}"
    if db.query(Analysis.id).filter(Analysis.title == candidate).first() is None:
        return candidate
    number = 2
    while True:
        candidate = f"(copy {number}) {original}"
        if db.query(Analysis.id).filter(Analysis.title == candidate).first() is None:
            return candidate
        number += 1


def analysis_name_exists(
    db: Session,
    title: str,
    folder_id: int | None,
    exclude_id: int | None = None,
) -> bool:
    query = db.query(Analysis.id).filter(func.lower(Analysis.title) == title.casefold())
    query = query.filter(
        Analysis.folder_id == folder_id if folder_id is not None else Analysis.folder_id.is_(None)
    )
    if exclude_id is not None:
        query = query.filter(Analysis.id != exclude_id)
    return query.first() is not None


def analysis_dict(db: Session, a: Analysis, full: bool = False) -> dict:
    folder = db.get(Folder, a.folder_id) if a.folder_id is not None else None
    d = {
        "id": a.id,
        "title": a.title,
        "type": a.spec.get("type", "cycling"),
        "folder": {"id": folder.id, "name": folder.name} if folder else None,
        "n_entries": len(a.spec.get("selection", {}).get("entries", [])),
        "n_exclusions": (
            len(a.spec.get("selection", {}).get("exclusions", []))
            + len(a.spec.get("selection", {}).get("hidden_replicate_group_ids", []))
        ),
        "quantity": a.spec.get("presentation", {}).get("quantity"),
        "has_provenance": a.provenance is not None,
        "computed_at": (a.provenance or {}).get("computed_at"),
        "parser_version": (a.provenance or {}).get("parser_version"),
        "calc_version": (a.provenance or {}).get("calc_version"),
        "created_at": a.created_at.isoformat(),
        "modified_at": a.modified_at.isoformat(),
    }
    if full:
        d["spec"] = a.spec
        d["provenance"] = a.provenance
    return d


@router.get("/analyses")
def list_analyses(search: str | None = None, db: Session = Depends(get_db)):
    """The flat analysis index — every analysis, filed or not."""
    q = db.query(Analysis)
    if search:
        q = q.filter(Analysis.title.ilike(f"%{search}%"))
    return [analysis_dict(db, a) for a in q.order_by(Analysis.modified_at.desc()).all()]


class AnalysisCreate(BaseModel):
    title: str
    folder_id: int | None = None
    spec: dict | None = None


@router.post("/analyses")
def create_analysis(req: AnalysisCreate, db: Session = Depends(get_db)):
    title = req.title.strip() or "Untitled analysis"
    spec = req.spec or engine.default_spec(title)
    spec["title"] = title
    if req.folder_id is not None and db.get(Folder, req.folder_id) is None:
        raise HTTPException(404, "No such folder")
    if analysis_name_exists(db, title, req.folder_id):
        raise HTTPException(409, f'An analysis named "{title}" already exists in this folder')
    a = Analysis(id=next_analysis_id(db), title=title, spec=spec, folder_id=req.folder_id)
    db.add(a)
    db.commit()
    return analysis_dict(db, a, full=True)


@router.get("/analyses/{analysis_id}")
def get_analysis(analysis_id: int, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    return analysis_dict(db, a, full=True)


class AnalysisUpdate(BaseModel):
    title: str | None = None
    spec: dict | None = None
    folder_id: int | None = None
    unfile: bool = False


@router.put("/analyses/{analysis_id}")
def update_analysis(analysis_id: int, req: AnalysisUpdate, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    next_title = (req.title.strip() or a.title) if req.title is not None else a.title
    next_folder_id = None if req.unfile else req.folder_id if req.folder_id is not None else a.folder_id
    if next_folder_id is not None and db.get(Folder, next_folder_id) is None:
        raise HTTPException(404, "No such folder")
    if analysis_name_exists(db, next_title, next_folder_id, exclude_id=a.id):
        raise HTTPException(409, f'An analysis named "{next_title}" already exists in this folder')
    if req.title is not None:
        a.title = next_title
    if req.spec is not None:
        req.spec["title"] = a.title
        req.spec["modified_at"] = engine.now_iso()
        a.spec = req.spec
    if req.unfile:
        a.folder_id = None
    elif req.folder_id is not None:
        a.folder_id = req.folder_id
    a.modified_at = datetime.now(timezone.utc)
    db.commit()
    return analysis_dict(db, a, full=True)


@router.delete("/analyses/{analysis_id}")
def delete_analysis(analysis_id: int, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    db.delete(a)  # the spec/provenance go; data is untouched
    db.commit()
    return {"ok": True}


class ComputeRequest(BaseModel):
    spec: dict | None = None  # compute unsaved edits without persisting
    recompute: bool = False  # explicit: use current parser/calc versions
    save_provenance: bool = False


@router.post("/analyses/{analysis_id}/compute")
def compute_analysis(analysis_id: int, req: ComputeRequest, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or a.spec
    result = engine.compute(db, spec, a.provenance, use_current_versions=req.recompute)
    if req.save_provenance or req.recompute:
        a.provenance = engine.build_provenance(result)
        if req.spec is not None:
            req.spec["title"] = a.title
            a.spec = req.spec
        a.modified_at = datetime.now(timezone.utc)
        db.commit()
    return result


@router.post("/analyses/{analysis_id}/time-capacity")
def compute_time_capacity_analysis(analysis_id: int, req: ComputeRequest, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or a.spec
    return engine.compute_time_capacity(db, spec, a.provenance, use_current_versions=req.recompute)


@router.post("/analyses/{analysis_id}/duplicate")
def duplicate_analysis(analysis_id: int, db: Session = Depends(get_db)):
    """Duplicate-and-recompute workflow: change the copy, keep the record."""
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    title = duplicate_title(db, a.title)
    spec = deepcopy(a.spec)
    spec["created_at"] = engine.now_iso()
    spec["title"] = title
    copy = Analysis(
        id=next_analysis_id(db),
        title=title,
        spec=spec,
        provenance=deepcopy(a.provenance),
        folder_id=a.folder_id,
    )
    db.add(copy)
    db.commit()
    return analysis_dict(db, copy, full=True)


@router.get("/analyses-meta/quantities")
def list_quantities():
    return [
        {"key": key, "column": col, "label": label}
        for key, (col, label) in engine.ALL_QUANTITIES.items()
    ]
