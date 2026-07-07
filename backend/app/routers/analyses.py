"""Analyses: persistent cycling-comparison specifications + flat index.

Filing to a folder is optional and has zero effect on reachable data —
an analysis selects cells and replicate groups by identity from anywhere
in the library. Compute renders from versioned caches at provenance-pinned
versions; recompute (explicit) moves to current versions.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Analysis, Folder
from ..services import analysis_engine as engine

router = APIRouter(prefix="/api", tags=["analyses"])


def analysis_dict(db: Session, a: Analysis, full: bool = False) -> dict:
    folder = db.get(Folder, a.folder_id) if a.folder_id is not None else None
    d = {
        "id": a.id,
        "title": a.title,
        "type": a.spec.get("type", "cycling"),
        "folder": {"id": folder.id, "name": folder.name} if folder else None,
        "n_entries": len(a.spec.get("selection", {}).get("entries", [])),
        "n_exclusions": len(a.spec.get("selection", {}).get("exclusions", [])),
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
    a = Analysis(title=title, spec=spec, folder_id=req.folder_id)
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
    if req.title is not None:
        a.title = req.title.strip() or a.title
    if req.spec is not None:
        req.spec["title"] = a.title
        req.spec["modified_at"] = engine.now_iso()
        a.spec = req.spec
    if req.unfile:
        a.folder_id = None
    elif req.folder_id is not None:
        if db.get(Folder, req.folder_id) is None:
            raise HTTPException(404, "No such folder")
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


@router.post("/analyses/{analysis_id}/duplicate")
def duplicate_analysis(analysis_id: int, db: Session = Depends(get_db)):
    """Duplicate-and-recompute workflow: change the copy, keep the record."""
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = dict(a.spec)
    spec["created_at"] = engine.now_iso()
    copy = Analysis(title=f"{a.title} (copy)", spec=spec, provenance=a.provenance,
                    folder_id=a.folder_id)
    db.add(copy)
    db.commit()
    return analysis_dict(db, copy, full=True)


@router.get("/analyses-meta/quantities")
def list_quantities():
    return [
        {"key": key, "column": col, "label": label}
        for key, (col, label) in engine.ALL_QUANTITIES.items()
    ]
