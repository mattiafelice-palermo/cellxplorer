"""Analyses: persistent cycling-comparison specifications + flat index.

Filing to a folder is optional and has zero effect on reachable data —
an analysis selects cells and replicate groups by identity from anywhere
in the library. Compute renders from versioned caches at provenance-pinned
versions; recompute (explicit) moves to current versions.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import math
from pathlib import Path
import re
import tempfile
from time import perf_counter
from typing import Literal
from urllib.parse import unquote, urlparse
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload
from starlette.background import BackgroundTask

from ..db import get_db
from ..models import Analysis, Cell, Folder, ReplicateGroup, ReplicateGroupCell
from ..responses import fast_json
from ..services import background_jobs
from ..services.entity_ids import next_analysis_id
from ..services.lazy_module import LazyModule
from ..services import time_capacity_profiling


def _load_analysis_engine():
    from ..services import analysis_engine

    return analysis_engine


def _load_analysis_usage():
    # Kept lazy so importing this router does not pull analysis_engine -> pandas
    # before uvicorn can bind (spec 031). Only endpoints that report usage need it.
    from ..services import analysis_usage

    return analysis_usage


def _load_analysis_cache():
    from ..services import analysis_cache as module

    return module


def _load_time_capacity_workers():
    from ..services import time_capacity_workers as module

    return module


def _load_portable_analysis():
    from ..services import portable_analysis as module

    return module


engine = LazyModule(_load_analysis_engine)
analysis_usage = LazyModule(_load_analysis_usage)
analysis_cache = LazyModule(_load_analysis_cache)
time_capacity_workers = LazyModule(_load_time_capacity_workers)
portable_analysis = LazyModule(_load_portable_analysis)

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


def analysis_dict(
    db: Session,
    a: Analysis,
    full: bool = False,
    current_hashes: dict[int, list[str]] | None = None,
    folder_by_id: dict[int, Folder] | None = None,
    group_cell_ids: dict[int, set[int]] | None = None,
) -> dict:
    folder = (
        folder_by_id.get(a.folder_id)
        if folder_by_id is not None and a.folder_id is not None
        else db.get(Folder, a.folder_id) if a.folder_id is not None else None
    )
    if current_hashes is None:
        current_hashes = engine.current_cell_hashes(db)
    entries = a.spec.get("selection", {}).get("entries", [])
    direct_cell_ids = {
        int(entry["ref_id"])
        for entry in entries
        if entry.get("kind") == "cell" and entry.get("ref_id") is not None
    }
    group_ids = {
        int(entry["ref_id"])
        for entry in entries
        if entry.get("kind") == "replicate_group" and entry.get("ref_id") is not None
    }
    if group_cell_ids is None:
        group_cell_ids = {}
        if group_ids:
            for group_id, cell_id in (
                db.query(ReplicateGroupCell.group_id, ReplicateGroupCell.cell_id)
                .filter(ReplicateGroupCell.group_id.in_(group_ids))
                .all()
            ):
                group_cell_ids.setdefault(group_id, set()).add(cell_id)
    selected_cell_ids = set(direct_cell_ids)
    for group_id in group_ids:
        selected_cell_ids.update(group_cell_ids.get(group_id, set()))
    d = {
        "id": a.id,
        "title": a.title,
        "type": a.spec.get("type", "cycling"),
        "folder": {"id": folder.id, "name": folder.name} if folder else None,
        "n_entries": len(entries),
        "n_cells": len(selected_cell_ids),
        "n_replicate_groups": len(group_ids),
        "n_exclusions": (
            len(a.spec.get("selection", {}).get("exclusions", []))
            + len(a.spec.get("selection", {}).get("hidden_replicate_group_ids", []))
        ),
        "quantity": a.spec.get("presentation", {}).get("quantity"),
        # Compact saved-plot index so the command palette can offer plots as
        # results and open the analysis on the matching tab without loading
        # every full spec.
        "saved_plots": [
            {
                "id": str(plot.get("id")),
                "name": str(plot.get("name") or "Saved plot"),
                "tab": str(plot.get("tab") or "cycles"),
                "subtitle": str(plot.get("subtitle") or ""),
                "quantity": str(
                    (plot.get("presentation") or {}).get("quantity") or ""
                ),
            }
            for plot in (a.spec.get("saved_plots") or [])
            if plot.get("id")
        ],
        # Raw selection references (no joins): the palette expands these
        # client-side against its cached cell and replicate-group lists so an
        # analysis can be found by the name of a cell it contains.
        "entry_refs": [
            {"kind": str(entry.get("kind")), "ref_id": entry.get("ref_id")}
            for entry in (a.spec.get("selection", {}).get("entries") or [])
            if entry.get("kind") and entry.get("ref_id") is not None
        ],
        "has_provenance": a.provenance is not None,
        # True when a source file changed after this analysis was computed, so
        # the list can mark it as out of date. Derived from provenance, so
        # recomputing clears it without any stored flag.
        "sources_changed": engine.sources_changed_since_compute(a.provenance, current_hashes),
        "computed_at": (a.provenance or {}).get("computed_at"),
        "parser_version": (a.provenance or {}).get("parser_version"),
        "calc_version": (a.provenance or {}).get("calc_version"),
        "created_at": a.created_at.isoformat(),
        "modified_at": a.modified_at.isoformat(),
    }
    if full:
        d["spec"] = a.spec
        d["provenance"] = a.provenance
        cell_ids = direct_cell_ids
        cells = (
            db.query(Cell).filter(Cell.id.in_(cell_ids)).order_by(Cell.name).all()
            if cell_ids
            else []
        )
        groups = (
            db.query(ReplicateGroup)
            .options(
                selectinload(ReplicateGroup.cell_links).selectinload(ReplicateGroupCell.cell)
            )
            .filter(ReplicateGroup.id.in_(group_ids))
            .order_by(ReplicateGroup.name)
            .all()
            if group_ids
            else []
        )
        d["selection_cells"] = [
            {
                "id": cell.id,
                "name": cell.name,
                "description": cell.description,
                "archived": cell.archived,
                "source_count": len(current_hashes.get(cell.id, [])),
                "metadata_only": any(
                    engine.parsing.source_record_metadata_only(source)
                    for source in engine.cell_ordered_hashes(db, cell)[1]
                ),
            }
            for cell in cells
        ]
        d["selection_groups"] = [
            {
                "id": group.id,
                "name": group.name,
                "description": group.description,
                "cell_ids": [membership.cell_id for membership in group.cell_links],
                "cells": [
                    {
                        "id": membership.cell.id,
                        "name": membership.cell.name,
                        "description": membership.cell.description,
                        "archived": membership.cell.archived,
                        "source_count": len(current_hashes.get(membership.cell.id, [])),
                        "metadata_only": any(
                            engine.parsing.source_record_metadata_only(source)
                            for source in engine.cell_ordered_hashes(db, membership.cell)[1]
                        ),
                    }
                    for membership in group.cell_links
                ],
            }
            for group in groups
        ]
    return d


@router.get("/analyses")
def list_analyses(search: str | None = None, db: Session = Depends(get_db)):
    """The flat analysis index — every analysis, filed or not."""
    q = db.query(Analysis)
    if search:
        q = q.filter(Analysis.title.ilike(f"%{search}%"))
    # Resolved once for the whole list; per-analysis resolution here would be a
    # per-cell query walk on a startup-path endpoint.
    current_hashes = engine.current_cell_hashes(db)
    analyses = q.order_by(Analysis.modified_at.desc()).all()
    folder_ids = {analysis.folder_id for analysis in analyses if analysis.folder_id is not None}
    folder_by_id = {
        folder.id: folder
        for folder in (
            db.query(Folder).filter(Folder.id.in_(folder_ids)).all() if folder_ids else []
        )
    }
    referenced_group_ids = {
        int(entry["ref_id"])
        for analysis in analyses
        for entry in (analysis.spec.get("selection", {}).get("entries") or [])
        if entry.get("kind") == "replicate_group" and entry.get("ref_id") is not None
    }
    group_cell_ids: dict[int, set[int]] = {}
    if referenced_group_ids:
        for group_id, cell_id in (
            db.query(ReplicateGroupCell.group_id, ReplicateGroupCell.cell_id)
            .filter(ReplicateGroupCell.group_id.in_(referenced_group_ids))
            .all()
        ):
            group_cell_ids.setdefault(group_id, set()).add(cell_id)
    return [
        analysis_dict(
            db,
            analysis,
            current_hashes=current_hashes,
            folder_by_id=folder_by_id,
            group_cell_ids=group_cell_ids,
        )
        for analysis in analyses
    ]


class AnalysisSelectionEntryCreate(BaseModel):
    kind: Literal["cell", "replicate_group"]
    ref_id: int
    label_override: str | None = None


class AnalysisCreate(BaseModel):
    title: str
    folder_id: int | None = None
    spec: dict | None = None
    entries: list[AnalysisSelectionEntryCreate] | None = None


@router.post("/analyses")
def create_analysis(req: AnalysisCreate, db: Session = Depends(get_db)):
    title = req.title.strip() or "Untitled analysis"
    spec = deepcopy(req.spec) if req.spec is not None else engine.default_spec(title)
    spec["title"] = title
    if req.entries is not None:
        entries: list[dict] = []
        seen: set[tuple[str, int]] = set()
        for entry in req.entries:
            key = (entry.kind, entry.ref_id)
            if key in seen:
                continue
            seen.add(key)
            if entry.kind == "cell":
                if db.get(Cell, entry.ref_id) is None:
                    raise HTTPException(404, f"No such cell: {entry.ref_id}")
            elif db.get(ReplicateGroup, entry.ref_id) is None:
                raise HTTPException(404, f"No such replicate group: {entry.ref_id}")
            payload = {"kind": entry.kind, "ref_id": entry.ref_id}
            if entry.label_override is not None:
                payload["label_override"] = entry.label_override
            entries.append(payload)
        selection = spec.get("selection")
        if not isinstance(selection, dict):
            selection = {}
            spec["selection"] = selection
        selection["entries"] = entries
    if req.folder_id is not None and db.get(Folder, req.folder_id) is None:
        raise HTTPException(404, "No such folder")
    if analysis_name_exists(db, title, req.folder_id):
        raise HTTPException(409, f'An analysis named "{title}" already exists in this folder')
    a = Analysis(id=next_analysis_id(db), title=title, spec=spec, folder_id=req.folder_id)
    db.add(a)
    db.commit()
    return analysis_dict(db, a, full=True)


class AnalysisUsageRequest(BaseModel):
    cell_ids: list[int] = Field(default_factory=list)
    group_ids: list[int] = Field(default_factory=list)


@router.post("/analyses/usage")
def analyses_usage(req: AnalysisUsageRequest, db: Session = Depends(get_db)):
    """Read-only preview of analyses/plots affected by removing cells or groups."""
    return analysis_usage.preview_removal_usage(
        db,
        cell_ids=req.cell_ids,
        group_ids=req.group_ids,
    )


class AnalysisPurgeEmptyRequest(BaseModel):
    analysis_ids: list[int] = Field(default_factory=list)


@router.post("/analyses/purge-empty-candidates")
def purge_empty_analysis_candidates(
    req: AnalysisPurgeEmptyRequest,
    db: Session = Depends(get_db),
):
    """After a destructive mutation, delete preflight candidates that are empty now."""
    return analysis_usage.purge_empty_candidates(db, req.analysis_ids)


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
    cache_only: bool = False  # bounded speculative UI preparation; never compute on a miss
    save_provenance: bool = False
    job_id: int | None = None
    # Client-generated id used to open a job only if the cache misses, so a
    # cached load costs no extra round-trip and leaves no activity entry.
    job_token: str | None = Field(default=None, max_length=100)
    viewport_width: int | None = Field(default=None, ge=240, le=10000)
    precision: Literal["standard", "full"] = "standard"
    compact: bool = False
    background: bool = False
    # Time/Capacity profiling is explicitly opt-in and is not part of the
    # scientific result/cache identity. Ordinary responses remain unchanged.
    profile: bool = False
    profile_request_id: str | None = Field(default=None, max_length=200)
    # Spec 052.3 Stage 3: a moving slider preview is a transient view that the
    # user is dragging past. Writing each one to the analysis result cache cost
    # a gzip + disk write under the global cache lock and evicted genuinely
    # reusable entries through the LRU budget. Transient requests still *read*
    # the cache; they only decline to populate it.
    persist: bool = True
    # Spec 052.7: place ordinary time-axis results on one continuous timeline
    # anchored at this cycle instead of re-zeroing each response at its own
    # first point. This is what lets consecutive cycle windows be panned
    # through as views onto a single axis. It changes the returned coordinates,
    # so it is part of the render cache identity below.
    absolute_time_origin_cycle: int | None = Field(default=None, ge=1)


class TimeCapacityExportVoltageSeries(BaseModel):
    channel: Literal["voltage", "working_potential", "counter_potential"]
    name: str = Field(min_length=1, max_length=500)
    y_title: str = Field(min_length=1, max_length=500)


class TimeCapacityExportSeriesPlan(BaseModel):
    cell_id: int
    group_id: int | None = None
    current_name: str = Field(min_length=1, max_length=500)
    voltage_series: list[TimeCapacityExportVoltageSeries] = Field(max_length=3)


class TimeCapacityExportPlan(BaseModel):
    x_title: str = Field(min_length=1, max_length=500)
    traces: list[TimeCapacityExportSeriesPlan] = Field(max_length=500)


class TimeCapacityDataExportRequest(BaseModel):
    spec: dict
    viewport_width: int | None = Field(default=None, ge=240, le=10000)
    format: Literal["csv", "parquet"]
    data_precision: Literal["standard", "full"] = "standard"
    decimal_separator: Literal["point", "comma"] = "point"
    delimiter: Literal["comma", "semicolon", "tab"] = "comma"
    x_range: tuple[float, float] | None = None
    plan: TimeCapacityExportPlan


class TimeCapacityRefinementRequest(BaseModel):
    """Ephemeral viewport refinement; never enters the result cache."""

    spec: dict
    viewport_x_min: float
    viewport_x_max: float
    viewport_width: int = Field(default=1200, ge=240, le=10000)
    cycle_start: int = Field(ge=1, le=10_000_000)
    cycle_end: int = Field(ge=1, le=10_000_000)
    request_generation: str = Field(min_length=1, max_length=200)


def _capacity_refinement_origins(
    overview: dict,
    cycle_start: int,
    cycle_end: int,
) -> dict[int, float] | None:
    """Resolve each visible Cell's first available requested-cycle origin.

    The overview origin map is computed from exact transformed rows before
    downsampling.  A Cell may legitimately have no rows in the requested
    window, or may begin at a later cycle when the requested range is sparse;
    neither case should block refinement for the other Cells.
    """

    traces = overview.get("cell_traces") if isinstance(overview, dict) else None
    if not isinstance(traces, list):
        return None
    origins_by_cell: dict[int, float] = {}
    lower = int(cycle_start)
    upper = int(cycle_end)
    for trace in traces:
        if not isinstance(trace, dict) or trace.get("excluded"):
            continue
        try:
            cell_id = int(trace["cell_id"])
        except (KeyError, TypeError, ValueError):
            continue
        origins = trace.get("display_x_cycle_origins")
        if not isinstance(origins, dict):
            return None
        candidate_cycle: int | None = None
        candidate_value: float | None = None
        for raw_cycle, raw_value in origins.items():
            try:
                cycle = int(raw_cycle)
                value = float(raw_value)
            except (TypeError, ValueError):
                continue
            if cycle < lower or cycle > upper or not math.isfinite(value):
                continue
            if candidate_cycle is None or cycle < candidate_cycle:
                candidate_cycle = cycle
                candidate_value = value
        if candidate_value is not None:
            origins_by_cell[cell_id] = candidate_value
    return origins_by_cell


class DcirProtocolRequest(BaseModel):
    spec: dict | None = None
    min_rest_s: float = Field(default=600, ge=1, le=86400)
    max_pulse_s: float = Field(default=120, ge=0.1, le=3600)
    min_ratio: float = Field(default=10, ge=1, le=10000)


def _profile_request_id(req: ComputeRequest) -> str:
    return req.profile_request_id or f"server-{uuid4().hex}"


def _append_json_object_field(body: bytes, name: str, value: object) -> bytes:
    """Append one small JSON field without re-encoding the scientific body."""

    rest = body.rstrip()
    if not rest.startswith(b"{") or not rest.endswith(b"}"):
        raise ValueError("result body is not a JSON object")
    field = fast_json({name: value}).body.strip()
    if not field.startswith(b"{") or not field.endswith(b"}"):
        raise ValueError("profiling field is not a JSON object")
    prefix = rest[:-1]
    separator = b"" if prefix.rstrip().endswith(b"{") else b","
    return prefix + separator + field[1:-1] + b"}"


def _replace_json_number(body: bytes, field: str, value: int | float) -> bytes:
    """Patch a numeric profiling field in-place without another JSON render."""

    profile_start = body.find(b'"profiling":')
    marker = b'"' + field.encode("utf-8") + b'":'
    start = body.find(marker, profile_start)
    if profile_start < 0 or start < 0:
        raise ValueError(f"profiling field {field!r} is missing")
    value_start = start + len(marker)
    comma = body.find(b",", value_start)
    closing = body.find(b"}", value_start)
    ends = [position for position in (comma, closing) if position >= 0]
    if not ends:
        raise ValueError(f"profiling field {field!r} has no JSON terminator")
    value_end = min(ends)
    if isinstance(value, int):
        replacement = str(max(0, value)).encode("ascii")
    else:
        replacement = format(max(0.0, float(value)), ".6f").rstrip("0").rstrip(".").encode("ascii")
        if replacement == b"":
            replacement = b"0"
    return body[:value_start] + replacement + body[value_end:]


def _settle_profile_response_bytes(content: bytes) -> bytes:
    """Converge the self-reported byte count using byte patches only."""

    for _ in range(4):
        next_content = _replace_json_number(content, "response_bytes", len(content))
        if next_content == content:
            return content
        content = next_content
    return content


def _profiled_time_capacity_response(
    *,
    request_started: float,
    request_id: str,
    result_cache: str,
    diagnostics: dict | None,
    result: dict | None = None,
    stored_body: bytes | None = None,
    badges: list[dict] | None = None,
    cache_extra_fields: dict[str, object] | None = None,
    backend_compute_ms: float | None = None,
    request_profile: dict[str, object] | None = None,
) -> Response:
    """Return a normal result plus a profiling-only diagnostic namespace.

    A miss serializes the scientific result once through the normal fast JSON
    path, then appends and patches only the small profiling object. A persisted
    hit uses the existing body-splice path. The scientific payload is never
    parsed or re-encoded to converge self-referential timing/byte fields.
    """

    if request_profile is not None:
        request_profile.setdefault("stages_ms", {}).setdefault(
            "response_preparation_serialization", 0.0
        )
        request_profile.setdefault("stages_ms", {}).setdefault(
            "response_object_construction", 0.0
        )
        request_profile.setdefault("stages_ms", {}).setdefault(
            "response_profile_patch_and_body_assignment", 0.0
        )
        request_profile.setdefault("response_serialization_ms", 0.0)
    response_started = perf_counter()
    profile = time_capacity_profiling.build_time_capacity_profile(
        request_id=request_id,
        result_cache=result_cache,
        diagnostics=diagnostics,
        backend_compute_ms=backend_compute_ms,
        result=result,
        request_profile=request_profile,
    )

    # These placeholders are patched in the final bytes after the one normal
    # body preparation. This avoids serializing the large scientific payload a
    # second time merely because the profile contains self-referential values.
    profile["backend_serialize_ms"] = 0.0
    profile["backend_total_ms"] = 0.0
    profile["response_bytes"] = 0
    serialize_started = perf_counter()
    if stored_body is not None:
        content = analysis_cache.splice_result_body(
            stored_body,
            badges or [],
            "hit",
            {
                **(cache_extra_fields or {}),
                "profiling": profile,
            },
        )
    else:
        if result is None:
            raise ValueError("A profiled Time/Capacity response needs a result or stored body")
        scientific_body = fast_json(result).body
        content = _append_json_object_field(scientific_body, "profiling", profile)
    serialize_ms = (perf_counter() - serialize_started) * 1000.0
    if not isinstance(serialize_ms, (int, float)):
        serialize_ms = 0.0
    if request_profile is not None:
        request_profile["response_serialization_ms"] = float(serialize_ms)
    content = _replace_json_number(content, "backend_serialize_ms", serialize_ms)
    if request_profile is not None:
        content = _replace_json_number(content, "response_serialization_ms", serialize_ms)
    content = _settle_profile_response_bytes(content)
    # Include the final small byte-patch preparation in the total boundary;
    # this is still byte surgery, not another scientific JSON serialization.
    request_total_ms = (perf_counter() - request_started) * 1000.0
    if request_profile is not None:
        response_full_ms = (perf_counter() - response_started) * 1000.0
        request_profile["stages_ms"]["response_preparation_serialization"] = response_full_ms
        content = _replace_json_number(
            content,
            "response_preparation_serialization",
            response_full_ms,
        )
    response_construct_started = perf_counter()
    response = Response(content=content, media_type="application/json")
    response_construct_ms = (perf_counter() - response_construct_started) * 1000.0
    if request_profile is not None:
        request_profile["stages_ms"]["response_object_construction"] = response_construct_ms
        final_started = perf_counter()
        content = _replace_json_number(
            content,
            "response_object_construction",
            response_construct_ms,
        )

        def patch_final_totals() -> None:
            total_ms = (perf_counter() - request_started) * 1000.0
            request_stages = request_profile.get("stages_ms", {})
            stage_total = sum(
                float(value)
                for value in request_stages.values()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            )
            nonlocal content
            content = _replace_json_number(content, "request_total_ms", total_ms)
            content = _replace_json_number(
                content,
                "request_residual_ms",
                max(0.0, total_ms - stage_total),
            )
            content = _replace_json_number(content, "backend_total_ms", total_ms)
            content = _settle_profile_response_bytes(content)

        # The large-body byte patches below are part of the complete route
        # boundary. Keep them visible as one final exclusive stage rather than
        # silently leaving them in residual time.
        patch_final_totals()
        response.body = content
        if "content-length" in response.headers:
            response.headers["content-length"] = str(len(content))
        final_ms = (perf_counter() - final_started) * 1000.0
        request_profile["stages_ms"]["response_profile_patch_and_body_assignment"] = final_ms
        content = _replace_json_number(
            content,
            "response_profile_patch_and_body_assignment",
            final_ms,
        )
        patch_final_totals()
        response.body = content
        if "content-length" in response.headers:
            response.headers["content-length"] = str(len(content))
    return response


def _progress_callback(job_id: int | None):
    if job_id is None:
        return None
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such background job")
    recorded: set[int] = set()

    def report(completed: int, total: int, label: str, detail: str) -> None:
        # A call with completed=k reports that cell k just finished; `detail`
        # is its outcome ("Read from cache" / "Re-parsed from source"). The
        # counter separates the cells that only needed a cache read from the
        # one(s) that actually re-parsed a source file, so the Activity entry
        # reads "24 cached, 1 re-parsed" instead of "25 cells".
        if completed > 0 and completed not in recorded:
            reparsed = detail.startswith("Re-parsed")
            background_jobs.record_result(
                job_id,
                completed,
                status="ready",
                detail=detail,
                counter="reparsed" if reparsed else "cached",
            )
            recorded.add(completed)
        if completed < total:
            background_jobs.update_item(
                job_id,
                completed + 1,
                status="processing",
                detail="Preparing cell data",
            )
        background_jobs.update_job(
            job_id,
            description=f"Preparing plot data ({min(completed + 1, total)}/{total} cells)",
        )

    return report


def _recognition_progress_callback(job_id: int | None):
    """Progress reporter for recognition tabs (C-rate / chargeability / DCIR).

    Unlike the cycle-plot callback, these paths report fine-grained stage units
    (``completed``/``total`` may exceed the cell count) and do not classify
    outcomes as cached vs re-parsed.
    """
    if job_id is None:
        return None
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such background job")

    def report(completed: int, total: int, label: str, detail: str) -> None:
        safe_total = max(1, int(total))
        safe_completed = max(0, min(int(completed), safe_total))
        background_jobs.update_job(
            job_id,
            completed=safe_completed,
            total=safe_total,
            description=f"{detail} — {label} ({safe_completed}/{safe_total})",
        )

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
    # Clear any leftover "queued" rows so Activity never shows a completed
    # header above still-queued per-cell badges. Cached cycle loads use
    # record_result (and the cached counter); recognition paths must not.
    for item in job.get("items", []):
        if item.get("status") != "queued":
            continue
        if cached:
            background_jobs.record_result(
                job_id,
                item["id"],
                status="ready",
                detail="Loaded from persistent cache",
                counter="cached",
            )
        else:
            background_jobs.update_item(
                job_id,
                item["id"],
                status="ready",
                detail="Recognition complete",
            )
    if cached:
        description = "Loaded cached plot data"
    else:
        # Summarize how much real work happened: the re-parse count is the
        # part that mattered; the rest were fast cache reads. Recognition jobs
        # skip those counters and finish with a generic label.
        counters = background_jobs.get_job(job_id).get("counters", {}) if background_jobs.get_job(job_id) else {}
        reparsed = counters.get("reparsed", 0)
        cached_reads = counters.get("cached", 0)
        if reparsed:
            description = (
                f"Re-parsed {reparsed} source file{'s' if reparsed != 1 else ''}, "
                f"read {cached_reads} from cache"
            )
        elif cached_reads:
            description = f"Read {cached_reads} cell{'s' if cached_reads != 1 else ''} from cache"
        else:
            description = "Recognition complete"
    # Re-read so recognition's enlarged total (stages × cells) is respected.
    latest = background_jobs.get_job(job_id) or job
    background_jobs.update_job(
        job_id,
        completed=latest.get("total", 0),
        status="completed",
        description=description,
    )


class AnalysisComputeJobCreate(BaseModel):
    kind: Literal[
        "cycles",
        "time_capacity",
        "steps",
        "dcir",
        "chargeability",
        "rate_capability",
    ]
    spec: dict | None = None


def _guard_protocol_analysis(
    db: Session,
    spec: dict,
    plot_family: str,
    *,
    request_context=None,
) -> None:
    detail = engine.protocol_analysis_guard(
        db,
        spec,
        plot_family,
        request_context=request_context,
    )
    if detail is not None:
        raise HTTPException(status_code=422, detail=detail)


def _guard_canonical_cycling(db: Session, spec: dict, *, request_context=None) -> None:
    detail = engine.canonical_cycling_capability(
        db,
        spec,
        request_context=request_context,
    )
    if detail is not None:
        raise HTTPException(status_code=422, detail=detail)


def _open_compute_job(
    db: Session,
    analysis: Analysis,
    spec: dict,
    kind: str,
    token: str | None,
    *,
    request_context=None,
) -> int:
    """Open an activity entry for a compute that is about to do real work.

    Called only after the cache has been consulted and missed. Resolving the
    selection to build the per-cell item list is itself a handful of queries,
    so a cached load should never reach here.
    """
    units = (
        list(request_context.units)
        if request_context is not None
        else engine.resolve_selection(db, spec)[0]
    )
    kind_label = {
        "time_capacity": "time/capacity",
        "steps": "steps",
        "dcir": "DCIR",
        "chargeability": "chargeability",
        "rate_capability": "rate capability",
    }.get(kind, "cycle")
    return background_jobs.create_job(
        kind="analysis_compute",
        title=f"Preparing {analysis.title} ({kind_label} plot)",
        description="Reading cell data",
        total=len(units),
        token=token,
        items=[
            {"id": index, "label": unit["label"], "status": "queued"}
            for index, unit in enumerate(units, start=1)
        ],
    )


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
    _guard_canonical_cycling(db, spec)
    if req.kind in engine.PROTOCOL_DERIVED_FAMILIES:
        _guard_protocol_analysis(db, spec, req.kind)
    job_id = _open_compute_job(db, analysis, spec, req.kind, None)
    return background_jobs.get_job(job_id)


# Speculative live-view preparation may read a small ready result, but must not
# trigger scientific work or admit an arbitrarily large hidden figure.
MAX_PRELOAD_RESULT_BYTES = 2 * 1024 * 1024


def _load_analysis_result_body(kind: str, key: str, *, cache_only: bool):
    stored = analysis_cache.load_result_body(kind, key)
    if cache_only and stored is not None and len(stored[0]) > MAX_PRELOAD_RESULT_BYTES:
        raise HTTPException(409, "Saved result is too large for automatic view preparation")
    return stored


def _reject_uncached_preload(req: ComputeRequest) -> None:
    if req.cache_only:
        raise HTTPException(409, "Saved result is not ready for automatic view preparation")


@router.post("/analyses/{analysis_id}/compute")
def compute_analysis(analysis_id: int, req: ComputeRequest, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or a.spec
    _guard_canonical_cycling(db, spec)
    key = analysis_cache.result_key(
        db, "cycles", spec, a.provenance, use_current_versions=req.recompute
    )
    if not req.recompute:
        # Fast path: serve the stored bytes verbatim, splicing in only the
        # badges, so a cache hit never parses the payload.
        stored = _load_analysis_result_body("cycles", key, cache_only=req.cache_only)
        if stored is not None:
            body, kept = stored
            _finish_job(req.job_id, cached=True)
            return Response(
                content=analysis_cache.splice_result_body(
                    body,
                    kept + engine.availability_badges(db, spec),
                    "hit",
                    {"data_signature": key},
                ),
                media_type="application/json",
            )
    _reject_uncached_preload(req)
    result = None if req.recompute else analysis_cache.load_result("cycles", key)
    cached = result is not None
    if cached:
        # Availability is not part of the cache key; badges must reflect the
        # current source status rather than the state at compute time.
        engine.refresh_availability_badges(db, spec, result)
        # Entry predates the body/header split; rewrite it so the next read
        # takes the fast path.
        analysis_cache.upgrade_result_format("cycles", key, result)
    job_id = req.job_id
    try:
        if result is None:
            from ..services.process_priority import background_thread_priority

            if job_id is None and req.job_token:
                job_id = _open_compute_job(db, a, spec, "cycles", req.job_token)
            with background_thread_priority(req.background):
                from ..services import analysis_family_workers

                progress = _progress_callback(job_id)
                # Exact hits return above without building request context.
                # Once a miss is known, resolve the owner context once and
                # reuse it for the promoted threshold decision, the worker
                # helper, and the serial fallback.
                request_context = engine.build_analysis_request_context(
                    db,
                    spec,
                    a.provenance,
                    use_current_versions=req.recompute,
                )
                result = analysis_family_workers.try_compute_family(
                    db,
                    spec,
                    a.provenance,
                    family="cycles",
                    use_current_versions=req.recompute,
                    request_context=request_context,
                    progress=progress,
                )
                if result is None:
                    result = engine.compute(
                        db,
                        spec,
                        a.provenance,
                        use_current_versions=req.recompute,
                        request_context=request_context,
                        progress=progress,
                    )
            result["cache_status"] = "miss"
            result["data_signature"] = key
            analysis_cache.store_result("cycles", key, result)
        result["data_signature"] = key
        _finish_job(job_id, cached=cached)
    except Exception as exc:
        _finish_job(job_id, error=str(exc))
        raise
    if req.save_provenance or req.recompute:
        a.provenance = engine.build_provenance(result)
        if req.spec is not None:
            req.spec["title"] = a.title
            a.spec = req.spec
        a.modified_at = datetime.now(timezone.utc)
        db.commit()
    # Results are plain JSON types and can reach tens of megabytes; bypass
    # FastAPI's encoder rather than walking the whole payload twice.
    return fast_json(result)


@router.post("/analyses/{analysis_id}/steps")
def compute_steps_analysis(analysis_id: int, req: ComputeRequest, db: Session = Depends(get_db)):
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or a.spec
    request_context = engine.build_analysis_request_context(
        db,
        spec,
        a.provenance,
        use_current_versions=req.recompute,
    )
    _guard_canonical_cycling(db, spec, request_context=request_context)
    _guard_protocol_analysis(
        db,
        spec,
        "steps",
        request_context=request_context,
    )
    key = analysis_cache.result_key(
        db,
        "steps",
        spec,
        a.provenance,
        use_current_versions=req.recompute,
        request_context=request_context,
    )
    if not req.recompute:
        stored = _load_analysis_result_body("steps", key, cache_only=req.cache_only)
        if stored is not None:
            body, kept = stored
            _finish_job(req.job_id, cached=True)
            return Response(
                content=analysis_cache.splice_result_body(
                    body,
                    kept + engine.availability_badges(
                        db,
                        spec,
                        request_context=request_context,
                    ),
                    "hit",
                    {"data_signature": key},
                ),
                media_type="application/json",
            )
    _reject_uncached_preload(req)
    result = None if req.recompute else analysis_cache.load_result("steps", key)
    cached = result is not None
    if cached:
        engine.refresh_availability_badges(
            db,
            spec,
            result,
            request_context=request_context,
        )
        analysis_cache.upgrade_result_format("steps", key, result)
    job_id = req.job_id
    try:
        if result is None:
            from ..services.process_priority import background_thread_priority

            if job_id is None and req.job_token:
                job_id = _open_compute_job(
                    db,
                    a,
                    spec,
                    "steps",
                    req.job_token,
                    request_context=request_context,
                )
            with background_thread_priority(req.background):
                from ..services import analysis_family_workers

                progress = _progress_callback(job_id)
                result = analysis_family_workers.try_compute_family(
                    db,
                    spec,
                    a.provenance,
                    family="steps",
                    use_current_versions=req.recompute,
                    request_context=request_context,
                    progress=progress,
                )
                if result is None:
                    result = engine.compute_steps(
                        db,
                        spec,
                        a.provenance,
                        use_current_versions=req.recompute,
                        progress=progress,
                        request_context=request_context,
                    )
            result["cache_status"] = "miss"
            result["data_signature"] = key
            analysis_cache.store_result("steps", key, result)
        result["data_signature"] = key
        _finish_job(job_id, cached=cached)
        return fast_json(result)
    except Exception as exc:
        _finish_job(job_id, error=str(exc))
        raise


@router.post("/analyses/{analysis_id}/dcir-protocols")
def get_dcir_protocols(
    analysis_id: int,
    req: DcirProtocolRequest,
    db: Session = Depends(get_db),
):
    """Return selected protocol families and assisted DCIR candidates."""
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or analysis.spec
    _guard_canonical_cycling(db, spec)
    _guard_protocol_analysis(db, spec, "dcir")
    from ..services import dcir
    from ..services import protocol as protocol_service

    units, _missing = engine.resolve_selection(db, spec)
    cells = list({unit["cell"].id: unit["cell"] for unit in units}.values())
    engine.preload_cell_sources(db, cells)
    scalar_metadata = engine.load_scalar_metadata(db, cells)
    families: dict[str, dict] = {}
    for cell in cells:
        nominal = engine.cell_nominal_capacity_mah(
            cell, scalar_metadata.get(cell.id)
        )
        _hashes, files = engine.cell_ordered_hashes(db, cell)
        for source_file in files:
            protocol = protocol_service.reconstruct_protocol(
                source_file.header_meta, nominal
            )
            signature = str(protocol.get("signature") or "")
            if not signature:
                continue
            family = families.setdefault(
                signature,
                {
                    "signature": signature,
                    "protocol": protocol,
                    "cell_ids": [],
                    "cell_names": [],
                    "files": [],
                },
            )
            if cell.id not in family["cell_ids"]:
                family["cell_ids"].append(cell.id)
                family["cell_names"].append(cell.name)
            family["files"].append(
                {
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "filename": source_file.filename,
                }
            )
    candidates: list[dict] = []
    for family in families.values():
        for candidate in dcir.detect_candidates(
            family["protocol"],
            min_rest_s=req.min_rest_s,
            max_pulse_s=req.max_pulse_s,
            min_ratio=req.min_ratio,
        ):
            candidates.append(
                {
                    **candidate,
                    "compatible_cell_ids": family["cell_ids"],
                    "compatible_cell_names": family["cell_names"],
                }
            )
    return fast_json(
        {
            "protocols": list(families.values()),
            "candidates": candidates,
        }
    )


@router.post("/analyses/{analysis_id}/dcir")
def compute_dcir_analysis(
    analysis_id: int,
    req: ComputeRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or analysis.spec
    request_context = engine.build_analysis_request_context(
        db,
        spec,
        analysis.provenance,
        use_current_versions=req.recompute,
    )
    _guard_canonical_cycling(db, spec, request_context=request_context)
    _guard_protocol_analysis(
        db,
        spec,
        "dcir",
        request_context=request_context,
    )
    key = analysis_cache.result_key(
        db,
        "dcir",
        spec,
        analysis.provenance,
        use_current_versions=req.recompute,
        request_context=request_context,
    )
    if not req.recompute:
        stored = _load_analysis_result_body("dcir", key, cache_only=req.cache_only)
        if stored is not None:
            body, kept = stored
            _finish_job(req.job_id, cached=True)
            return Response(
                content=analysis_cache.splice_result_body(
                    body,
                    kept + engine.availability_badges(
                        db,
                        spec,
                        request_context=request_context,
                    ),
                    "hit",
                    {"data_signature": key},
                ),
                media_type="application/json",
            )
    _reject_uncached_preload(req)
    result = None if req.recompute else analysis_cache.load_result("dcir", key)
    cached = result is not None
    if cached:
        engine.refresh_availability_badges(
            db,
            spec,
            result,
            request_context=request_context,
        )
        analysis_cache.upgrade_result_format("dcir", key, result)
    job_id = req.job_id
    try:
        if result is None:
            from ..services.process_priority import background_thread_priority

            if job_id is None and req.job_token:
                job_id = _open_compute_job(
                    db,
                    analysis,
                    spec,
                    "dcir",
                    req.job_token,
                    request_context=request_context,
                )
            with background_thread_priority(req.background):
                from ..services import analysis_family_workers

                progress = _recognition_progress_callback(job_id)
                result = analysis_family_workers.try_compute_family(
                    db,
                    spec,
                    analysis.provenance,
                    family="dcir",
                    use_current_versions=req.recompute,
                    request_context=request_context,
                    progress=progress,
                )
                if result is None:
                    result = engine.compute_dcir(
                        db,
                        spec,
                        analysis.provenance,
                        use_current_versions=req.recompute,
                        progress=progress,
                        request_context=request_context,
                    )
            result["cache_status"] = "miss"
            result["data_signature"] = key
            analysis_cache.store_result("dcir", key, result)
        result["data_signature"] = key
        _finish_job(job_id, cached=cached)
        return fast_json(result)
    except Exception as exc:
        _finish_job(job_id, error=str(exc))
        raise


@router.post("/analyses/{analysis_id}/chargeability")
def compute_chargeability_analysis(
    analysis_id: int,
    req: ComputeRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or analysis.spec
    request_context = engine.build_analysis_request_context(
        db,
        spec,
        analysis.provenance,
        use_current_versions=req.recompute,
    )
    _guard_canonical_cycling(db, spec, request_context=request_context)
    _guard_protocol_analysis(
        db,
        spec,
        "chargeability",
        request_context=request_context,
    )
    from ..services import chargeability
    key = analysis_cache.result_key(
        db,
        "chargeability",
        spec,
        analysis.provenance,
        use_current_versions=req.recompute,
        request_context=request_context,
    )
    if not req.recompute:
        stored = _load_analysis_result_body("chargeability", key, cache_only=req.cache_only)
        if stored is not None:
            body, kept = stored
            _finish_job(req.job_id, cached=True)
            return Response(
                content=analysis_cache.splice_result_body(
                    body,
                    kept + engine.availability_badges(
                        db,
                        spec,
                        request_context=request_context,
                    ),
                    "hit",
                    {"data_signature": key},
                ),
                media_type="application/json",
            )
    _reject_uncached_preload(req)
    result = (
        None
        if req.recompute
        else analysis_cache.load_result("chargeability", key)
    )
    cached = result is not None
    if cached:
        engine.refresh_availability_badges(
            db,
            spec,
            result,
            request_context=request_context,
        )
        analysis_cache.upgrade_result_format("chargeability", key, result)
    job_id = req.job_id
    try:
        if result is None:
            from ..services.process_priority import background_thread_priority

            if job_id is None and req.job_token:
                job_id = _open_compute_job(
                    db,
                    analysis,
                    spec,
                    "chargeability",
                    req.job_token,
                    request_context=request_context,
                )
            with background_thread_priority(req.background):
                result = chargeability.compute(
                    db,
                    spec,
                    analysis.provenance,
                    use_current_versions=req.recompute,
                    progress=_recognition_progress_callback(job_id),
                    request_context=request_context,
                )
            result["cache_status"] = "miss"
            result["data_signature"] = key
            analysis_cache.store_result("chargeability", key, result)
        result["data_signature"] = key
        _finish_job(job_id, cached=cached)
        return fast_json(result)
    except Exception as exc:
        _finish_job(job_id, error=str(exc))
        raise


@router.post("/analyses/{analysis_id}/rate-capability")
def compute_rate_capability_analysis(
    analysis_id: int,
    req: ComputeRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec or analysis.spec
    request_context = engine.build_analysis_request_context(
        db,
        spec,
        analysis.provenance,
        use_current_versions=req.recompute,
    )
    _guard_canonical_cycling(db, spec, request_context=request_context)
    _guard_protocol_analysis(
        db,
        spec,
        "rate_capability",
        request_context=request_context,
    )
    from ..services import rate_capability
    key = analysis_cache.result_key(
        db,
        "rate_capability",
        spec,
        analysis.provenance,
        use_current_versions=req.recompute,
        request_context=request_context,
    )
    if not req.recompute:
        stored = _load_analysis_result_body("rate_capability", key, cache_only=req.cache_only)
        if stored is not None:
            body, kept = stored
            _finish_job(req.job_id, cached=True)
            return Response(
                content=analysis_cache.splice_result_body(
                    body,
                    kept + engine.availability_badges(
                        db,
                        spec,
                        request_context=request_context,
                    ),
                    "hit",
                    {"data_signature": key},
                ),
                media_type="application/json",
            )
    _reject_uncached_preload(req)
    result = (
        None
        if req.recompute
        else analysis_cache.load_result("rate_capability", key)
    )
    cached = result is not None
    if cached:
        engine.refresh_availability_badges(
            db,
            spec,
            result,
            request_context=request_context,
        )
        analysis_cache.upgrade_result_format("rate_capability", key, result)
    job_id = req.job_id
    try:
        if result is None:
            from ..services.process_priority import background_thread_priority

            if job_id is None and req.job_token:
                job_id = _open_compute_job(
                    db,
                    analysis,
                    spec,
                    "rate_capability",
                    req.job_token,
                    request_context=request_context,
                )
            with background_thread_priority(req.background):
                from ..services import analysis_family_workers

                progress = _recognition_progress_callback(job_id)
                result = analysis_family_workers.try_compute_family(
                    db,
                    spec,
                    analysis.provenance,
                    family="rate_capability",
                    use_current_versions=req.recompute,
                    request_context=request_context,
                    progress=progress,
                )
                if result is None:
                    result = rate_capability.compute(
                        db,
                        spec,
                        analysis.provenance,
                        use_current_versions=req.recompute,
                        progress=progress,
                        request_context=request_context,
                    )
            result["cache_status"] = "miss"
            result["data_signature"] = key
            analysis_cache.store_result("rate_capability", key, result)
        result["data_signature"] = key
        _finish_job(job_id, cached=cached)
        return fast_json(result)
    except Exception as exc:
        _finish_job(job_id, error=str(exc))
        raise


@router.post("/analyses/{analysis_id}/time-capacity")
def compute_time_capacity_analysis(analysis_id: int, req: ComputeRequest, db: Session = Depends(get_db)):
    request_started = perf_counter()
    request_profile = time_capacity_profiling.new_request_profile() if req.profile else None
    sql_profile = time_capacity_profiling.SQLProfile(db) if req.profile else None
    job_id = req.job_id

    def finish_request_profile() -> None:
        if sql_profile is not None:
            sql_profile.finish(request_profile)

    try:
        with time_capacity_profiling.profiled_stage(request_profile, "analysis_lookup"):
            a = db.get(Analysis, analysis_id)
        if a is None:
            finish_request_profile()
            raise HTTPException(404, "No such analysis")
        with time_capacity_profiling.profiled_stage(request_profile, "request_spec_setup"):
            spec = req.spec or a.spec
            options = {
                "viewport_width": req.viewport_width or 1200,
                "precision": req.precision,
                "compact": req.compact,
            }
            if req.absolute_time_origin_cycle is not None:
                # Part of the render key: two responses for the same cycles
                # differ in their x coordinates when anchored differently.
                options["absolute_time_origin_cycle"] = req.absolute_time_origin_cycle
        # Spec 052.5: resolve the owner-side request state once and share it.
        # The selection walk, source preload and scalar-metadata load are
        # needed to compute the cache key at all, and the guard and the
        # compute path both need exactly the same resolution. Without this the
        # Time/Capacity route repeated `resolve_selection` four times and
        # `preload_cell_sources` four times per request. The context is
        # request-local and never reaches a worker process.
        with time_capacity_profiling.profiled_stage(request_profile, "owner_request_context"):
            request_context = engine.build_analysis_request_context(
                db,
                spec,
                a.provenance,
                use_current_versions=req.recompute,
            )
        with time_capacity_profiling.profiled_stage(request_profile, "canonical_capability_guard"):
            _guard_canonical_cycling(db, spec, request_context=request_context)
        with time_capacity_profiling.profiled_stage(request_profile, "source_data_signature"):
            source_data_signature, key = analysis_cache.time_capacity_keys(
                db,
                spec,
                a.provenance,
                use_current_versions=req.recompute,
                request_options=options,
                request_context=request_context,
            )
        # ``time_capacity_keys`` intentionally derives both values from one
        # owner-side fingerprint pass. Retain the historic profiling stage
        # name so existing profile consumers remain compatible; its work is
        # now accounted with the shared signature stage above.
        with time_capacity_profiling.profiled_stage(request_profile, "render_result_key"):
            pass
        if not req.recompute:
            with time_capacity_profiling.profiled_stage(request_profile, "result_cache_body_lookup"):
                stored = _load_analysis_result_body("time_capacity", key, cache_only=req.cache_only)
            if stored is not None:
                body, kept = stored
                with time_capacity_profiling.profiled_stage(request_profile, "activity_finalize"):
                    _finish_job(req.job_id, cached=True)
                with time_capacity_profiling.profiled_stage(request_profile, "availability_badges"):
                    badges = kept + engine.availability_badges(db, spec)
                if req.profile:
                    with time_capacity_profiling.profiled_stage(
                        request_profile, "request_profile_finalization"
                    ):
                        finish_request_profile()
                    return _profiled_time_capacity_response(
                        request_started=request_started,
                        request_id=_profile_request_id(req),
                        result_cache="hit",
                        diagnostics=None,
                        stored_body=body,
                        badges=badges,
                        cache_extra_fields={
                            "data_signature": key,
                            "source_data_signature": source_data_signature,
                        },
                        request_profile=request_profile,
                    )
                return Response(
                    content=analysis_cache.splice_result_body(
                        body,
                        badges,
                        "hit",
                        {
                            "data_signature": key,
                            "source_data_signature": source_data_signature,
                        },
                    ),
                    media_type="application/json",
                )
        _reject_uncached_preload(req)
        if req.recompute:
            result = None
        else:
            with time_capacity_profiling.profiled_stage(request_profile, "result_cache_legacy_lookup"):
                result = analysis_cache.load_result("time_capacity", key)
        cached = result is not None
        if cached:
            with time_capacity_profiling.profiled_stage(request_profile, "result_cache_legacy_upgrade"):
                analysis_cache.upgrade_result_format("time_capacity", key, result)
        access_diagnostics = {} if req.profile else None
        backend_compute_ms: float | None = None
        if result is None:
            with time_capacity_profiling.profiled_stage(request_profile, "compute_request_setup"):
                from ..services.process_priority import background_thread_priority

            # Spec 052.6: a transient request is a range the user is dragging
            # past. It is never persisted, so it always misses the result cache
            # and would otherwise open and close one activity entry per drag
            # step -- roughly thirty per second of sustained dragging, each
            # costing an INSERT plus an UPDATE and flooding the activity feed
            # with work the user never asked to see. Transient previews stay
            # out of the activity log entirely.
            if job_id is None and req.job_token and req.persist:
                with time_capacity_profiling.profiled_stage(request_profile, "activity_setup"):
                    job_id = _open_compute_job(
                        db,
                        a,
                        spec,
                        "time_capacity",
                        req.job_token,
                        request_context=request_context,
                    )
            with time_capacity_profiling.profiled_stage(request_profile, "compute_request_setup"):
                compute_options = {
                    "use_current_versions": req.recompute,
                    "viewport_width": req.viewport_width,
                    "precision": req.precision,
                    "compact": req.compact,
                    "progress": _progress_callback(job_id),
                    "request_context": request_context,
                    "display_origin_cycle_start": req.absolute_time_origin_cycle,
                }
                if req.profile:
                    compute_options["access_diagnostics"] = access_diagnostics
            compute_started = perf_counter()
            with time_capacity_profiling.profiled_stage(request_profile, "engine_compute"):
                with background_thread_priority(req.background):
                    result = engine.compute_time_capacity(
                        db,
                        spec,
                        a.provenance,
                        **compute_options,
                    )
            backend_compute_ms = (perf_counter() - compute_started) * 1000.0
            result["cache_status"] = "miss"
            result["data_signature"] = key
            result["source_data_signature"] = source_data_signature
            with time_capacity_profiling.profiled_stage(request_profile, "result_cache_persistence"):
                if req.persist:
                    store_result = analysis_cache.store_result
                    if request_profile is not None and getattr(store_result, "__name__", None) == "store_result":
                        store_result("time_capacity", key, result, profile=request_profile)
                    else:
                        # Keep the route compatible with focused tests that
                        # replace persistence with a three-argument spy.
                        store_result("time_capacity", key, result)
        with time_capacity_profiling.profiled_stage(request_profile, "owner_finalization"):
            result["data_signature"] = key
            result["source_data_signature"] = source_data_signature
            _finish_job(job_id, cached=cached)
        if req.profile:
            with time_capacity_profiling.profiled_stage(
                request_profile, "request_profile_finalization"
            ):
                finish_request_profile()
            return _profiled_time_capacity_response(
                request_started=request_started,
                request_id=_profile_request_id(req),
                result_cache="hit" if cached else "miss",
                diagnostics=access_diagnostics,
                result=result,
                backend_compute_ms=backend_compute_ms,
                request_profile=request_profile,
            )
        return fast_json(result)
    except Exception as exc:
        finish_request_profile()
        _finish_job(job_id, error=str(exc))
        raise


@router.post("/analyses/{analysis_id}/time-capacity/export")
def export_time_capacity_data(
    analysis_id: int,
    req: TimeCapacityDataExportRequest,
    db: Session = Depends(get_db),
):
    """Build CSV/Parquet natively so full rows never make a JSON round trip."""

    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    spec = req.spec
    settings = engine.time_capacity_settings(spec.get("computation", {}))
    if settings.get("view") != "voltage_current" or settings.get("display_mode") != "consecutive":
        raise HTTPException(422, "Native export requires a consecutive voltage/current view")
    if not req.plan.traces:
        raise HTTPException(422, "No visible Time/Capacity series are available to export")
    x_range = req.x_range
    if x_range is not None and not all(math.isfinite(value) for value in x_range):
        raise HTTPException(422, "The current plot range is not finite")

    request_context = engine.build_analysis_request_context(
        db,
        spec,
        analysis.provenance,
        use_current_versions=False,
    )
    _guard_canonical_cycling(db, spec, request_context=request_context)
    result = engine.compute_time_capacity(
        db,
        spec,
        analysis.provenance,
        viewport_width=req.viewport_width,
        precision="full",
        compact=True,
        request_context=request_context,
    )
    suffix = f".{req.format}"
    with tempfile.NamedTemporaryFile(
        prefix="cellxplorer-time-capacity-",
        suffix=suffix,
        delete=False,
    ) as temporary:
        export_path = Path(temporary.name)
    try:
        time_capacity_workers.write_time_capacity_data_export(
            result,
            req.plan.model_dump(),
            settings,
            export_path,
            export_format=req.format,
            data_precision=req.data_precision,
            decimal_separator=req.decimal_separator,
            delimiter=req.delimiter,
            x_range=x_range,
        )
    except ValueError as exc:
        export_path.unlink(missing_ok=True)
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        export_path.unlink(missing_ok=True)
        raise

    media_type = "text/csv; charset=utf-8" if req.format == "csv" else "application/vnd.apache.parquet"
    return FileResponse(
        export_path,
        media_type=media_type,
        filename=f"time-capacity.{req.format}",
        background=BackgroundTask(export_path.unlink, missing_ok=True),
    )


@router.post("/analyses/{analysis_id}/time-capacity/refine")
def refine_time_capacity_analysis(
    analysis_id: int,
    req: TimeCapacityRefinementRequest,
    db: Session = Depends(get_db),
):
    """Return a non-persistent viewport refinement for consecutive Time/Capacity."""

    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    if req.viewport_x_max < req.viewport_x_min:
        raise HTTPException(422, "viewport_x_max must be greater than viewport_x_min")
    if req.cycle_end < req.cycle_start:
        raise HTTPException(422, "cycle_end must be greater than or equal to cycle_start")

    spec = deepcopy(req.spec)
    settings = engine.time_capacity_settings(spec.get("computation", {}))
    if not (
        settings["view"] == "voltage_current"
        and settings["x_axis"]
        in {"time", "capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}
        and settings["display_mode"] == "consecutive"
    ):
        raise HTTPException(422, "viewport refinement is only available for consecutive Time/Capacity")
    if settings["cycles"]:
        raise HTTPException(
            422,
            "viewport refinement is unavailable for explicit sparse cycle selections",
        )
    _guard_canonical_cycling(db, spec)

    source_data_signature, overview_key = analysis_cache.time_capacity_keys(
        db,
        spec,
        analysis.provenance,
        use_current_versions=False,
        request_options={
            "viewport_width": req.viewport_width,
            "precision": "standard",
            "compact": True,
        },
    )
    display_origin_capacity_by_cell: dict[int, float] | None = None
    if settings["x_axis"] in {"capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}:
        overview = analysis_cache.load_result("time_capacity", overview_key)
        if overview is not None:
            # The refined indexed read begins at the requested cycle window.
            # Use each Cell's first exact origin in that window, rather than
            # requiring the window's lower bound to exist for every Cell.
            # This preserves sparse/unequal Cell coverage without shifting a
            # later Cell to zero or blocking refinement for other Cells.
            display_origin_capacity_by_cell = _capacity_refinement_origins(
                overview,
                req.cycle_start,
                req.cycle_end,
            )
        if display_origin_capacity_by_cell is None and overview is not None:
            raise HTTPException(
                409,
                "exact capacity refinement origins are unavailable; recompute the overview",
            )
    origin_cycle_start = (
        int(settings["cycle_start"])
        if settings["cycle_start"] is not None
        else None
    )
    candidate_time_capacity = dict(settings)
    candidate_time_capacity["cycles"] = []
    candidate_time_capacity["cycle_start"] = req.cycle_start
    candidate_time_capacity["cycle_end"] = req.cycle_end
    spec.setdefault("computation", {})["time_capacity"] = candidate_time_capacity
    from ..services import time_capacity_workers

    try:
        result = engine.compute_time_capacity(
            db,
            spec,
            analysis.provenance,
            use_current_versions=False,
            viewport_width=req.viewport_width,
            precision="standard",
            compact=True,
            display_origin_cycle_start=origin_cycle_start,
            display_origin_capacity_by_cell=display_origin_capacity_by_cell,
            refinement=True,
            refinement_viewport_x_min=req.viewport_x_min,
            refinement_viewport_x_max=req.viewport_x_max,
        )
    except time_capacity_workers.RefinementUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    # Deliberately do not call analysis_cache.store_result and do not mutate
    # Analysis.spec/provenance: this response is an ephemeral viewport view.
    result["data_signature"] = overview_key
    result["source_data_signature"] = source_data_signature
    result["overview_data_signature"] = overview_key
    result["request_generation"] = req.request_generation
    return fast_json(result)


class PlotArtifactRequest(BaseModel):
    signature: str = Field(min_length=1, max_length=20_000)
    svg: str = Field(min_length=10, max_length=100_000_000)
    thumbnail: str | None = Field(default=None, max_length=2_500_000)
    preview_thumbnail: str | None = Field(default=None, max_length=2_500_000)
    figure: dict
    summary: list[dict] = Field(default_factory=list)
    warmup_task_id: str | None = Field(default=None, max_length=500)
    expected_data_signature: str = Field(min_length=1, max_length=128)
    expected_analysis_modified_at: str | None = Field(default=None, max_length=100)


class PlotArtifactLookup(BaseModel):
    signature: str = Field(min_length=1, max_length=20_000)


def _guard_saved_plot_protocol_analysis(
    db: Session,
    analysis: Analysis,
    plot_id: str,
) -> dict:
    saved_plot = next(
        (
            plot
            for plot in analysis.spec.get("saved_plots", [])
            if str(plot.get("id")) == plot_id
        ),
        None,
    )
    if saved_plot is None:
        raise HTTPException(404, "No such saved plot")
    # Saved artifacts are scientific outputs too. Persisted source capability
    # must be authoritative before a historical artifact, thumbnail, or stale
    # client write can reach any cache boundary.
    _guard_canonical_cycling(db, analysis.spec)
    plot_family = "rate_capability" if saved_plot.get("tab") == "crate" else str(
        saved_plot.get("tab") or "cycles"
    )
    _guard_protocol_analysis(db, analysis.spec, plot_family)
    return saved_plot


@router.get("/analyses/{analysis_id}/plot-artifacts/{plot_id}")
def get_plot_artifact(
    analysis_id: int,
    plot_id: str,
    signature: str,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    saved_plot = _guard_saved_plot_protocol_analysis(db, analysis, plot_id)
    current_data_signature = analysis_cache.saved_plot_data_signature(
        db, analysis, saved_plot
    )
    cache_signature = f"{signature}:{current_data_signature}"
    artifact = analysis_cache.load_artifact(analysis_id, plot_id, cache_signature)
    if artifact is None:
        raise HTTPException(404, "No cached plot artifact")
    # An artifact carries the full SVG plus the portable figure — megabytes.
    return fast_json(
        {
            "signature": signature,
            "data_signature": current_data_signature,
            **artifact,
        }
    )


@router.post("/analyses/{analysis_id}/plot-artifacts/{plot_id}/lookup")
def lookup_plot_artifact(
    analysis_id: int,
    plot_id: str,
    req: PlotArtifactLookup,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    saved_plot = _guard_saved_plot_protocol_analysis(db, analysis, plot_id)
    current_data_signature = analysis_cache.saved_plot_data_signature(
        db, analysis, saved_plot
    )
    cache_signature = f"{req.signature}:{current_data_signature}"
    artifact = analysis_cache.load_artifact(analysis_id, plot_id, cache_signature)
    if artifact is None:
        raise HTTPException(404, "No cached plot artifact")
    return fast_json(
        {
            "signature": req.signature,
            "data_signature": current_data_signature,
            **artifact,
        }
    )


@router.post("/analyses/{analysis_id}/plot-artifacts/{plot_id}/thumbnail/lookup")
def lookup_plot_thumbnail(
    analysis_id: int,
    plot_id: str,
    req: PlotArtifactLookup,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    saved_plot = _guard_saved_plot_protocol_analysis(db, analysis, plot_id)
    current_data_signature = analysis_cache.saved_plot_data_signature(
        db, analysis, saved_plot
    )
    thumbnail = analysis_cache.load_indexed_thumbnail(
        analysis_id,
        plot_id,
        req.signature,
        current_data_signature,
    )
    if thumbnail is not None:
        return {
            "signature": req.signature,
            "thumbnail": thumbnail,
            "preview_thumbnail": analysis_cache.load_indexed_preview_thumbnail(
                analysis_id, plot_id, req.signature, current_data_signature
            ),
        }

    # Once a plot has signature-indexed thumbnails, an unknown client
    # signature means the plot changed. Do not relabel an older scientific
    # artifact as the new preview while the analysis autosave is catching up.
    if analysis_cache.has_indexed_thumbnails(analysis_id, plot_id):
        raise HTTPException(404, "No cached plot thumbnail")

    # Adopt caches written before the direct index existed. Plot ids are
    # stable and a refreshed saved plot always writes a newer thumbnail, so
    # this is a constant-time disk lookup rather than a 25-cell fingerprint.
    thumbnail = analysis_cache.load_latest_thumbnail(
        analysis_id,
        plot_id,
        expected_data_signature=current_data_signature,
    )
    if thumbnail is not None:
        preview_thumbnail = analysis_cache.load_latest_thumbnail(
            analysis_id,
            plot_id,
            "preview",
            expected_data_signature=current_data_signature,
        )
        analysis_cache.store_indexed_thumbnail(
            analysis_id,
            plot_id,
            req.signature,
            thumbnail,
            preview_thumbnail,
            current_data_signature,
        )
        return {
            "signature": req.signature,
            "thumbnail": thumbnail,
            "preview_thumbnail": preview_thumbnail,
        }

    cache_signature = f"{req.signature}:{current_data_signature}"
    thumbnail = analysis_cache.load_thumbnail(analysis_id, plot_id, cache_signature)
    preview_thumbnail = analysis_cache.load_preview_thumbnail(
        analysis_id, plot_id, cache_signature
    )
    if thumbnail is None:
        # One-time migration for artifacts created before thumbnails were
        # split into lightweight files.
        artifact = analysis_cache.load_artifact(analysis_id, plot_id, cache_signature)
        thumbnail = artifact.get("thumbnail") if artifact is not None else None
        preview_thumbnail = (
            artifact.get("preview_thumbnail") if artifact is not None else None
        )
    if thumbnail is None:
        raise HTTPException(404, "No cached plot thumbnail")
    analysis_cache.store_indexed_thumbnail(
        analysis_id,
        plot_id,
        req.signature,
        thumbnail,
        preview_thumbnail,
        current_data_signature,
    )
    return {
        "signature": req.signature,
        "thumbnail": thumbnail,
        "preview_thumbnail": preview_thumbnail,
    }


@router.get("/analyses/{analysis_id}/plot-artifacts/{plot_id}/thumbnail/latest")
def latest_plot_thumbnail(
    analysis_id: int,
    plot_id: str,
    variant: Literal["saved", "preview"] = "saved",
    db: Session = Depends(get_db),
):
    """Return an already-rendered saved-plot thumbnail without computing data."""
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    saved_plot = _guard_saved_plot_protocol_analysis(db, analysis, plot_id)
    current_data_signature = analysis_cache.saved_plot_data_signature(
        db, analysis, saved_plot
    )
    thumbnail = analysis_cache.load_latest_thumbnail(
        analysis_id,
        plot_id,
        variant,
        expected_data_signature=current_data_signature,
    )
    if thumbnail is None:
        raise HTTPException(404, "No cached plot thumbnail")
    return {
        "thumbnail": thumbnail,
        "data_signature": current_data_signature,
        "plot_modified_at": saved_plot.get("modified_at"),
    }


@router.post("/analyses/{analysis_id}/plot-artifacts/{plot_id}")
def store_plot_artifact(
    analysis_id: int,
    plot_id: str,
    req: PlotArtifactRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    normalized = req.svg.lstrip()
    if not normalized.startswith("<svg") or re.search(
        r"<(?:script|iframe|object|embed|foreignObject)\b", normalized, re.IGNORECASE
    ):
        raise HTTPException(422, "Only self-contained SVG plot artifacts are accepted")
    if req.thumbnail is not None and not req.thumbnail.startswith(
        ("data:image/webp;base64,", "data:image/png;base64,")
    ):
        raise HTTPException(422, "Only WebP or PNG plot thumbnails are accepted")
    if req.preview_thumbnail is not None and not req.preview_thumbnail.startswith(
        ("data:image/webp;base64,", "data:image/png;base64,")
    ):
        raise HTTPException(422, "Only WebP or PNG plot previews are accepted")
    saved_plot = _guard_saved_plot_protocol_analysis(db, analysis, plot_id)
    current_data_signature = analysis_cache.saved_plot_data_signature(db, analysis, saved_plot)
    if req.expected_data_signature != current_data_signature:
        raise HTTPException(409, "This cache task was superseded by newer source data")
    if req.expected_analysis_modified_at is not None:
        current_modified_at = analysis.modified_at.isoformat() if analysis.modified_at else None
        if req.expected_analysis_modified_at != current_modified_at:
            raise HTTPException(409, "This cache task was superseded by newer analysis settings")
    if req.warmup_task_id is not None:
        from ..services import cache_maintenance

        if not cache_maintenance.warmup.authorize_task(
            req.warmup_task_id,
            analysis_id,
            plot_id,
            req.expected_data_signature,
            req.expected_analysis_modified_at,
        ):
            raise HTTPException(409, "This cache task is no longer active")
    # The validated request identity is the cache key. Do not recompute a
    # second signature after the check: if source data changes immediately
    # afterward, this artifact remains safely under the older identity and can
    # never be served for the newer one.
    validated_data_signature = req.expected_data_signature
    cache_signature = f"{req.signature}:{validated_data_signature}"
    artifact = {
        "svg": req.svg,
        "thumbnail": req.thumbnail,
        "preview_thumbnail": req.preview_thumbnail,
        "figure": req.figure,
        "summary": req.summary,
    }
    analysis_cache.store_artifact(
        analysis_id,
        plot_id,
        cache_signature,
        artifact,
        client_signature=req.signature,
        data_signature=validated_data_signature,
    )
    # This plot is now prepared for its current data signature and revision;
    # idle warmup can leave it out of future queues.
    if req.thumbnail is not None and req.preview_thumbnail is not None:
        analysis_cache.store_prepared_marker(
            analysis_id,
            plot_id,
            validated_data_signature,
            saved_plot.get("modified_at"),
        )
    if req.warmup_task_id is None:
        from ..services import cache_maintenance

        cache_maintenance.warmup.foreground_ready(analysis_id, plot_id)
    return {
        "signature": req.signature,
        "data_signature": validated_data_signature,
        **artifact,
    }


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


class PortableSourceUpdateItem(BaseModel):
    source_id: int
    expected_size: int
    expected_mtime_ns: int


class PortableSourceUpdateRequest(BaseModel):
    sources: list[PortableSourceUpdateItem] = Field(default_factory=list)


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


class PortablePathInspectRequest(BaseModel):
    source: str


def _portable_filename(title: str) -> str:
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", title).strip(" .-")
    return f"{clean or 'CellXplorer analysis'}.html"


def _portable_local_path(source: str) -> Path:
    """Resolve a local report path supplied by the desktop deep link."""
    value = source.strip()
    if not value:
        raise HTTPException(400, "The portable report path is missing.")
    raw_windows_path = bool(re.match(r"^[A-Za-z]:[\\/]", value))
    parsed = urlparse(value) if not raw_windows_path else urlparse("")
    if parsed.scheme and parsed.scheme.lower() != "file":
        raise HTTPException(400, "Only local portable report files can be opened automatically.")
    if parsed.scheme.lower() == "file":
        decoded = unquote(parsed.path)
        if parsed.netloc:
            decoded = f"//{parsed.netloc}{decoded}"
        elif re.match(r"^/[A-Za-z]:/", decoded):
            decoded = decoded[1:]
        value = decoded
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise HTTPException(400, "The portable report path must be absolute.")
    if path.suffix.lower() not in {".html", ".htm"}:
        raise HTTPException(400, "Select a CellXplorer portable HTML analysis.")
    if not path.is_file():
        raise HTTPException(404, "The portable report is no longer available at this location.")
    return path.resolve()


@router.get("/analyses/{analysis_id}/portable-estimate")
def portable_analysis_estimate(analysis_id: int, db: Session = Depends(get_db)):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    return portable_analysis.estimate_export(db, analysis)


@router.post("/analyses/{analysis_id}/portable-source-preflight")
def portable_source_preflight(analysis_id: int, db: Session = Depends(get_db)):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    return portable_analysis.preflight_original_sources(db, analysis)


@router.post("/analyses/{analysis_id}/portable-source-update")
def portable_source_update(
    analysis_id: int,
    req: PortableSourceUpdateRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    return portable_analysis.update_original_sources(
        db,
        analysis,
        [item.model_dump() for item in req.sources],
    )


@router.post("/analyses/{analysis_id}/portable-export")
def export_portable_analysis(
    analysis_id: int,
    req: PortableExportRequest,
    db: Session = Depends(get_db),
):
    analysis = db.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(404, "No such analysis")
    _guard_canonical_cycling(db, analysis.spec or {})
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
            strict_original_files=req.include_original_files,
            views=req.views or None,
        )
    except portable_analysis.PortableOriginalSourceError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
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


@router.post("/analyses/portable-inspect-path")
def inspect_portable_analysis_path(
    req: PortablePathInspectRequest,
    db: Session = Depends(get_db),
):
    """Stage a local report handed to the desktop app by its custom protocol."""
    source_path = _portable_local_path(req.source)
    token = portable_analysis.stage_import(source_path, preserve_source=True)
    staged_path = portable_analysis.pending_import_path(token)
    try:
        review = portable_analysis.inspect_analysis_html(db, staged_path)
        return {"token": token, "filename": source_path.name, **review}
    except Exception:
        portable_analysis.discard_pending_import(token)
        raise


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
