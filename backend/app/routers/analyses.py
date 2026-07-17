"""Analyses: persistent cycling-comparison specifications + flat index.

Filing to a folder is optional and has zero effect on reachable data —
an analysis selects cells and replicate groups by identity from anywhere
in the library. Compute renders from versioned caches at provenance-pinned
versions; recompute (explicit) moves to current versions.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import re
import tempfile
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from ..db import get_db
from ..models import Analysis, Folder
from ..services import analysis_engine as engine
from ..services import analysis_cache, background_jobs, portable_analysis
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
        if req.spec is None:
            updated_spec = deepcopy(a.spec)
            updated_spec["title"] = next_title
            updated_spec["modified_at"] = engine.now_iso()
            a.spec = updated_spec
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
    analysis_cache.delete_analysis_artifacts(analysis_id)
    return {"ok": True}


class ComputeRequest(BaseModel):
    spec: dict | None = None  # compute unsaved edits without persisting
    recompute: bool = False  # explicit: use current parser/calc versions
    save_provenance: bool = False
    job_id: int | None = None
    viewport_width: int | None = Field(default=None, ge=240, le=10000)
    x_range: list[float] | None = None
    precision: Literal["standard", "full"] = "standard"
    compact: bool = False


def _progress_callback(job_id: int | None):
    if job_id is None:
        return None
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such background job")
    recorded: set[int] = set()

    def report(completed: int, total: int, label: str, detail: str) -> None:
        if completed > 0 and completed not in recorded:
            background_jobs.record_result(
                job_id,
                completed,
                status="ready",
                detail="Plot data ready",
                counter="ready",
            )
            recorded.add(completed)
        if completed < total:
            background_jobs.update_item(
                job_id,
                completed + 1,
                status="processing",
                detail=detail,
            )
        background_jobs.update_job(job_id, description=f"{detail}: {label}")

    return report


def _finish_job(job_id: int | None, *, cached: bool = False, error: str | None = None) -> None:
    if job_id is None:
        return
    job = background_jobs.get_job(job_id)
    if job is None:
        return
    if error is not None:
        background_jobs.update_job(job_id, status="failed", error=error, description="Plot preparation failed")
        return
    if cached:
        for item in job.get("items", []):
            if item.get("status") == "queued":
                background_jobs.record_result(
                    job_id,
                    item["id"],
                    status="ready",
                    detail="Loaded from persistent cache",
                    counter="cached",
                )
    background_jobs.update_job(
        job_id,
        completed=job.get("total", 0),
        status="completed",
        description="Loaded cached plot" if cached else "Plot ready",
    )


class AnalysisComputeJobCreate(BaseModel):
    kind: Literal["cycles", "time_capacity"]
    spec: dict | None = None


@router.post("/analyses/{analysis_id}/compute-jobs")
def create_analysis_compute_job(
    analysis_id: int,
    req: AnalysisComputeJobCreate,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or analysis.spec
    units, _ = engine.resolve_selection(db, spec)
    label = "time/capacity plot" if req.kind == "time_capacity" else "cycle plot"
    job_id = background_jobs.create_job(
        kind="analysis_compute",
        title=f"Preparing {label}",
        description="Waiting to read cached cell data",
        total=len(units),
        items=[
            {"id": index, "label": unit["label"], "status": "queued"}
            for index, unit in enumerate(units, start=1)
        ],
    )
    return background_jobs.get_job(job_id)


@router.post("/analyses/{analysis_id}/compute")
def compute_analysis(analysis_id: int, req: ComputeRequest, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or a.spec
    key = analysis_cache.result_key(
        db, "cycles", spec, a.provenance, use_current_versions=req.recompute
    )
    result = None if req.recompute else analysis_cache.load_result("cycles", key)
    cached = result is not None
    try:
        if result is None:
            result = engine.compute(
                db,
                spec,
                a.provenance,
                use_current_versions=req.recompute,
                progress=_progress_callback(req.job_id),
            )
            result["cache_status"] = "miss"
            analysis_cache.store_result("cycles", key, result)
        _finish_job(req.job_id, cached=cached)
    except Exception as exc:
        _finish_job(req.job_id, error=str(exc))
        raise
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
    if req.x_range is not None and len(req.x_range) != 2:
        raise HTTPException(422, "x_range must contain a minimum and maximum")
    x_range = tuple(req.x_range) if req.x_range is not None else None
    options = {
        "viewport_width": req.viewport_width or 1200,
        "x_range": req.x_range,
        "precision": req.precision,
        "compact": req.compact,
    }
    key = analysis_cache.result_key(
        db,
        "time_capacity",
        spec,
        a.provenance,
        use_current_versions=req.recompute,
        request_options=options,
    )
    result = None if req.recompute else analysis_cache.load_result("time_capacity", key)
    cached = result is not None
    try:
        if result is None:
            result = engine.compute_time_capacity(
                db,
                spec,
                a.provenance,
                use_current_versions=req.recompute,
                viewport_width=req.viewport_width,
                x_range=x_range,
                precision=req.precision,
                compact=req.compact,
                progress=_progress_callback(req.job_id),
            )
            result["cache_status"] = "miss"
            analysis_cache.store_result("time_capacity", key, result)
        _finish_job(req.job_id, cached=cached)
        return result
    except Exception as exc:
        _finish_job(req.job_id, error=str(exc))
        raise


class PlotArtifactRequest(BaseModel):
    signature: str = Field(min_length=1, max_length=20_000)
    svg: str = Field(min_length=10, max_length=12_000_000)


class PlotArtifactLookup(BaseModel):
    signature: str = Field(min_length=1, max_length=20_000)


@router.get("/analyses/{analysis_id}/plot-artifacts/{plot_id}")
def get_plot_artifact(
    analysis_id: int,
    plot_id: str,
    signature: str,
    db: Session = Depends(get_db),
):
    if db.get(Analysis, analysis_id) is None:
        raise HTTPException(404, "No such analysis")
    svg = analysis_cache.load_artifact(analysis_id, plot_id, signature)
    if svg is None:
        raise HTTPException(404, "No cached plot artifact")
    return {"signature": signature, "svg": svg}


@router.post("/analyses/{analysis_id}/plot-artifacts/{plot_id}/lookup")
def lookup_plot_artifact(
    analysis_id: int,
    plot_id: str,
    req: PlotArtifactLookup,
    db: Session = Depends(get_db),
):
    if db.get(Analysis, analysis_id) is None:
        raise HTTPException(404, "No such analysis")
    svg = analysis_cache.load_artifact(analysis_id, plot_id, req.signature)
    if svg is None:
        raise HTTPException(404, "No cached plot artifact")
    return {"signature": req.signature, "svg": svg}


@router.post("/analyses/{analysis_id}/plot-artifacts/{plot_id}")
def store_plot_artifact(
    analysis_id: int,
    plot_id: str,
    req: PlotArtifactRequest,
    db: Session = Depends(get_db),
):
    if db.get(Analysis, analysis_id) is None:
        raise HTTPException(404, "No such analysis")
    normalized = req.svg.lstrip()
    if not normalized.startswith("<svg") or re.search(
        r"<(?:script|iframe|object|embed|foreignObject)\b", normalized, re.IGNORECASE
    ):
        raise HTTPException(422, "Only self-contained SVG plot artifacts are accepted")
    analysis_cache.store_artifact(analysis_id, plot_id, req.signature, req.svg)
    return {"signature": req.signature, "svg": req.svg}


class AnalysisDuplicateRequest(BaseModel):
    folder_id: int | None = None
    unfile: bool = False


@router.post("/analyses/{analysis_id}/duplicate")
def duplicate_analysis(
    analysis_id: int,
    req: AnalysisDuplicateRequest | None = None,
    db: Session = Depends(get_db),
):
    """Duplicate-and-recompute workflow: change the copy, keep the record."""
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    target_folder_id = (
        None
        if req is not None and req.unfile
        else req.folder_id
        if req is not None and req.folder_id is not None
        else a.folder_id
    )
    if target_folder_id is not None and db.get(Folder, target_folder_id) is None:
        raise HTTPException(404, "No such folder")
    title = duplicate_title(db, a.title)
    spec = deepcopy(a.spec)
    spec["created_at"] = engine.now_iso()
    spec["title"] = title
    copy = Analysis(
        id=next_analysis_id(db),
        title=title,
        spec=spec,
        provenance=deepcopy(a.provenance),
        folder_id=target_folder_id,
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


class PortableExportRequest(BaseModel):
    include_original_files: bool = False
    views: list[dict] = Field(default_factory=list)


class PortableSourceResolution(BaseModel):
    action: str
    library_source_file_id: int | None = None


class PortableStagedImportRequest(BaseModel):
    token: str
    title: str
    folder_id: int | None = None
    add_cells_to_folder: bool = False
    source_resolutions: dict[str, PortableSourceResolution] = Field(default_factory=dict)
    cell_names: dict[str, str] = Field(default_factory=dict)


def _portable_filename(title: str) -> str:
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", title).strip(" .-")
    return f"{clean or 'CellXplorer analysis'}.html"


@router.get("/analyses/{analysis_id}/portable-estimate")
def portable_analysis_estimate(analysis_id: int, db: Session = Depends(get_db)):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    return portable_analysis.estimate_export(db, analysis)


@router.post("/analyses/{analysis_id}/portable-export")
def export_portable_analysis(
    analysis_id: int,
    req: PortableExportRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    temporary = tempfile.NamedTemporaryFile(
        prefix="cellxplorer-analysis-",
        suffix=".html",
        delete=False,
    )
    destination = Path(temporary.name)
    temporary.close()
    try:
        portable_analysis.export_analysis_html(
            db,
            analysis,
            destination,
            include_original_files=req.include_original_files,
            views=req.views or None,
        )
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return FileResponse(
        destination,
        media_type="text/html; charset=utf-8",
        filename=_portable_filename(analysis.title),
        background=BackgroundTask(destination.unlink, missing_ok=True),
    )


@router.post("/analyses/portable-import")
async def import_portable_analysis(
    file: UploadFile = File(...),
    folder_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
):
    if folder_id is not None and db.get(Folder, folder_id) is None:
        raise HTTPException(404, "No such folder")
    if not (file.filename or "").lower().endswith((".html", ".htm")):
        raise HTTPException(400, "Select a CellXplorer portable HTML analysis.")
    temporary = tempfile.NamedTemporaryFile(
        prefix="cellxplorer-portable-import-",
        suffix=".html",
        delete=False,
    )
    path = Path(temporary.name)
    try:
        while chunk := await file.read(1024 * 1024):
            temporary.write(chunk)
        temporary.close()
        analysis, warnings = portable_analysis.import_analysis_html(
            db,
            path,
            folder_id=folder_id,
        )
        return {
            "analysis": analysis_dict(db, analysis, full=True),
            "warnings": warnings,
        }
    finally:
        temporary.close()
        path.unlink(missing_ok=True)


@router.post("/analyses/portable-inspect")
async def inspect_portable_analysis(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    if not (file.filename or "").lower().endswith((".html", ".htm")):
        raise HTTPException(400, "Select a CellXplorer portable HTML analysis.")
    temporary = tempfile.NamedTemporaryFile(
        prefix="cellxplorer-portable-inspect-",
        suffix=".html",
        delete=False,
    )
    temporary_path = Path(temporary.name)
    staged_path: Path | None = None
    try:
        while chunk := await file.read(1024 * 1024):
            temporary.write(chunk)
        temporary.close()
        token = portable_analysis.stage_import(temporary_path)
        staged_path = portable_analysis.pending_import_path(token)
        review = portable_analysis.inspect_analysis_html(db, staged_path)
        return {"token": token, **review}
    except Exception:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)
        raise
    finally:
        temporary.close()
        temporary_path.unlink(missing_ok=True)


@router.post("/analyses/portable-import-staged")
def import_staged_portable_analysis(
    req: PortableStagedImportRequest,
    db: Session = Depends(get_db),
):
    if req.folder_id is not None and db.get(Folder, req.folder_id) is None:
        raise HTTPException(404, "No such folder")
    path = portable_analysis.pending_import_path(req.token)
    try:
        analysis, warnings = portable_analysis.import_analysis_html(
            db,
            path,
            folder_id=req.folder_id,
            title=req.title,
            add_cells_to_folder=req.add_cells_to_folder,
            source_resolutions={
                source_id: resolution.model_dump()
                for source_id, resolution in req.source_resolutions.items()
            },
            cell_names=req.cell_names,
        )
        return {
            "analysis": analysis_dict(db, analysis, full=True),
            "warnings": warnings,
        }
    finally:
        path.unlink(missing_ok=True)


@router.delete("/analyses/portable-import-staged/{token}")
def discard_staged_portable_analysis(token: str):
    portable_analysis.discard_pending_import(token)
    return {"ok": True}
