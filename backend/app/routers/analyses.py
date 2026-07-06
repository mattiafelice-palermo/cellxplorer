"""Analyses: persistent specifications + global flat index.

Filing is optional and has zero effect on reachable data. Compute renders
from versioned caches at provenance-pinned versions; recompute (explicit)
moves to current versions. Refresh-selection returns a diff and applies
nothing — the client applies it only on user confirmation.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (
    Analysis,
    AnalysisCollection,
    AnalysisTag,
    Cell,
    Collection,
    Folder,
    Group,
    Project,
    Tag,
)
from ..services import analysis as engine

router = APIRouter(prefix="/api", tags=["analyses"])

SPEC_VERSION = 3


def default_spec(title: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "spec_version": SPEC_VERSION,
        "title": title,
        "created_at": now,
        "modified_at": now,
        "selection": {"entries": [], "exclusions": [], "refresh_suggestion": None},
        "computation": {
            "quantity": "discharge_capacity",
            "x_axis": "cycle_index",
            "cycle_range": {"start": 1, "end": None},
            "cycle_alignment": "cycle_index",
            "filters": [],
            "normalization": {"kind": "none", "params": {}},
        },
        "aggregation": {
            "mode": "group_mean",
            "dispersion": "std",
            "min_n_for_band": 2,
            "fade_low_n": True,
        },
        "presentation": {
            "show_individual_cells": True,
            "series_style": {},
            "axis_labels": {"x": "Cycle", "y": None},
            "legend": True,
        },
    }


def analysis_dict(db: Session, a: Analysis, full: bool = False) -> dict:
    tags = (
        db.query(Tag.name)
        .join(AnalysisTag, AnalysisTag.tag_id == Tag.id)
        .filter(AnalysisTag.analysis_id == a.id)
        .all()
    )
    cols = (
        db.query(Collection)
        .join(AnalysisCollection, AnalysisCollection.collection_id == Collection.id)
        .filter(AnalysisCollection.analysis_id == a.id)
        .all()
    )
    filed_in = None
    if a.project_id is not None:
        p = db.get(Project, a.project_id)
        filed_in = {"node_type": "project", "node_id": a.project_id, "name": p.name if p else "?"}
    elif a.folder_id is not None:
        f = db.get(Folder, a.folder_id)
        filed_in = {"node_type": "folder", "node_id": a.folder_id, "name": f.name if f else "?"}
    d = {
        "id": a.id,
        "title": a.title,
        "filed_in": filed_in,  # None = homeless: lives only in the library
        "tags": sorted(t[0] for t in tags),
        "collections": [{"id": c.id, "name": c.name} for c in cols],
        "n_entries": len(a.spec.get("selection", {}).get("entries", [])),
        "n_exclusions": len(a.spec.get("selection", {}).get("exclusions", [])),
        "quantity": a.spec.get("computation", {}).get("quantity"),
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
def list_analyses(
    text: str | None = None,
    tag: str | None = None,
    collection_id: int | None = None,
    filing: str | None = None,  # 'homeless' | 'filed' | None
    db: Session = Depends(get_db),
):
    """The Global Analysis Index — flat, searchable, filterable, regardless
    of where (or whether) each analysis is filed."""
    q = db.query(Analysis)
    if text:
        q = q.filter(Analysis.title.ilike(f"%{text}%"))
    if tag:
        sub = (
            db.query(AnalysisTag.analysis_id).join(Tag, Tag.id == AnalysisTag.tag_id).filter(Tag.name == tag).scalar_subquery()
        )
        q = q.filter(Analysis.id.in_(sub))
    if collection_id is not None:
        sub = (
            db.query(AnalysisCollection.analysis_id)
            .filter(AnalysisCollection.collection_id == collection_id)
            .scalar_subquery()
        )
        q = q.filter(Analysis.id.in_(sub))
    if filing == "homeless":
        q = q.filter(Analysis.folder_id.is_(None), Analysis.project_id.is_(None))
    elif filing == "filed":
        q = q.filter((Analysis.folder_id.isnot(None)) | (Analysis.project_id.isnot(None)))
    return [analysis_dict(db, a) for a in q.order_by(Analysis.modified_at.desc()).all()]


class AnalysisCreate(BaseModel):
    title: str
    spec: dict | None = None
    folder_id: int | None = None
    project_id: int | None = None


@router.post("/analyses")
def create_analysis(req: AnalysisCreate, db: Session = Depends(get_db)):
    spec = req.spec or default_spec(req.title)
    spec["title"] = req.title
    a = Analysis(title=req.title, spec=spec, folder_id=req.folder_id, project_id=req.project_id)
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
    # filing — both None allowed (homeless). Use sentinel flags to unfil.
    folder_id: int | None = None
    project_id: int | None = None
    unfile: bool = False
    tags: list[str] | None = None
    collection_ids: list[int] | None = None


@router.put("/analyses/{analysis_id}")
def update_analysis(analysis_id: int, req: AnalysisUpdate, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    if req.title is not None:
        a.title = req.title.strip()
    if req.spec is not None:
        req.spec["title"] = a.title
        req.spec["modified_at"] = engine.now_iso()
        a.spec = req.spec
    if req.unfile:
        a.folder_id = None
        a.project_id = None
    else:
        if req.folder_id is not None:
            a.folder_id, a.project_id = req.folder_id, None
        if req.project_id is not None:
            a.project_id, a.folder_id = req.project_id, None
    if req.tags is not None:
        tags = db.query(Tag).filter(Tag.name.in_(req.tags)).all()
        if len(tags) != len(set(req.tags)):
            known = {t.name for t in tags}
            raise HTTPException(422, f"Unregistered tag(s): {sorted(set(req.tags) - known)}")
        db.query(AnalysisTag).filter(AnalysisTag.analysis_id == a.id).delete()
        for t in tags:
            db.add(AnalysisTag(analysis_id=a.id, tag_id=t.id))
    if req.collection_ids is not None:
        db.query(AnalysisCollection).filter(AnalysisCollection.analysis_id == a.id).delete()
        for cid in set(req.collection_ids):
            if db.get(Collection, cid) is not None:
                db.add(AnalysisCollection(analysis_id=a.id, collection_id=cid))
    a.modified_at = datetime.now(timezone.utc)
    db.commit()
    return analysis_dict(db, a, full=True)


@router.delete("/analyses/{analysis_id}")
def delete_analysis(analysis_id: int, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    db.delete(a)
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
    """Duplicate-and-recompute workflow: update the copy, leave the record
    intact."""
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = dict(a.spec)
    spec["created_at"] = engine.now_iso()
    copy = Analysis(
        title=f"{a.title} (copy)",
        spec=spec,
        provenance=a.provenance,
        folder_id=a.folder_id,
        project_id=a.project_id,
    )
    db.add(copy)
    db.commit()
    return analysis_dict(db, copy, full=True)


class RefreshRequest(BaseModel):
    query: dict | None = None  # defaults to the stored refresh_suggestion


@router.post("/analyses/{analysis_id}/refresh-selection")
def refresh_selection(analysis_id: int, req: RefreshRequest, db: Session = Depends(get_db)):
    """Re-run the recorded selection query, return a DIFF only. Nothing is
    applied here — the user confirms in the UI and saves the spec."""
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    query = req.query or (a.spec.get("selection", {}).get("refresh_suggestion") or {}).get("query")
    if not query:
        raise HTTPException(422, "No refresh query recorded for this analysis")
    matched = engine.run_refresh_query(db, query)
    units, _ = engine.resolve_selection(db, a.spec)
    current_ids = {u["cell"].id for u in units}
    matched_ids = {c.id for c in matched}
    added = [{"cell_id": c.id, "cell_name": c.name} for c in matched if c.id not in current_ids]
    removed_ids = current_ids - matched_ids
    removed = [
        {"cell_id": cid, "cell_name": db.get(Cell, cid).name if db.get(Cell, cid) else str(cid)}
        for cid in sorted(removed_ids)
    ]
    return {"query": query, "added": added, "removed": removed,
            "matched": [{"cell_id": c.id, "cell_name": c.name} for c in matched]}
