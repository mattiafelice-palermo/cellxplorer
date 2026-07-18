"""The canonical Library: cells, tests, metadata, cell tags."""
from __future__ import annotations

import os
import threading
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, ThreadPoolExecutor, wait
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from time import sleep as _sleep
from typing import Literal

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
from ..services import background_jobs
from ..services.activity_log import record_activity
from ..services.lazy_module import LazyModule
from .files import file_dict


def _load_numpy():
    import numpy

    return numpy


def _load_analysis_engine():
    from ..services import analysis_engine

    return analysis_engine


def _load_cache():
    from ..services import cache as module

    return module


def _load_parsing():
    from ..services import parsing as module

    return module


def _load_protocol():
    from ..services import protocol as module

    return module


def _load_scanner():
    from ..services import scanner as module

    return module


def _load_stitch():
    from ..services import stitch as module

    return module


np = LazyModule(_load_numpy)
analysis_svc = LazyModule(_load_analysis_engine)
cache = LazyModule(_load_cache)
parsing = LazyModule(_load_parsing)
protocol = LazyModule(_load_protocol)
scanner = LazyModule(_load_scanner)
stitch = LazyModule(_load_stitch)

router = APIRouter(prefix="/api", tags=["library"])

_source_check_job_lock = threading.Lock()
_source_check_jobs: dict[int, dict] = {}
_latest_source_check_job_id: int | None = None
_next_source_check_job_id = 1
_JobThread = threading.Thread


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


SCIENTIFIC_OVERRIDE_KEYS = {
    "active_mass_mg": "override.active_mass_mg",
    "nominal_capacity_mah": "override.nominal_capacity_mah",
    "electrode_area_cm2": "override.electrode_area_cm2",
}

SCIENTIFIC_SUMMARY_METADATA_KEYS = {
    *SCIENTIFIC_OVERRIDE_KEYS.values(),
    "active_material_mg",
    "active_mass_mg",
    "nominal_capacity_mah",
    "nominal_capacity",
    "electrode_area_cm2",
    "override.active_material_preset_id",
    "override.active_material_name",
    "override.active_material_specific_capacity_mah_g",
    "override.electrode_area_preset_id",
    "override.electrode_area_preset_name",
}


def _positive_float(value) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def cell_scientific_metadata(
    cell: Cell,
    metadata: dict[str, str] | None = None,
) -> dict:
    if metadata is None:
        metadata = {entry.key: entry.value for entry in cell.metadata_entries}
    source_mass = next(
        (
            value
            for test in cell.tests
            for link in test.file_links
            if (value := _positive_float(link.file.active_mass_mg)) is not None
        ),
        None,
    )
    source_nominal = next(
        (
            value
            for test in cell.tests
            for link in test.file_links
            if (value := _positive_float(link.file.nominal_capacity_mah)) is not None
        ),
        None,
    )
    values = {
        "active_mass_mg": {
            "source_value": source_mass,
            "override_value": _positive_float(metadata.get("override.active_mass_mg")),
            "legacy_value": _positive_float(
                metadata.get("active_material_mg") or metadata.get("active_mass_mg")
            ),
        },
        "nominal_capacity_mah": {
            "source_value": source_nominal,
            "override_value": _positive_float(metadata.get("override.nominal_capacity_mah")),
            "legacy_value": _positive_float(
                metadata.get("nominal_capacity_mah") or metadata.get("nominal_capacity")
            ),
        },
        "electrode_area_cm2": {
            "source_value": None,
            "override_value": _positive_float(metadata.get("override.electrode_area_cm2")),
            "legacy_value": _positive_float(metadata.get("electrode_area_cm2")),
        },
    }
    for value in values.values():
        value["effective_value"] = (
            value["override_value"] or value["legacy_value"] or value["source_value"]
        )
    return values


def cell_scientific_presets(
    cell: Cell,
    metadata: dict[str, str] | None = None,
) -> dict:
    if metadata is None:
        metadata = {entry.key: entry.value for entry in cell.metadata_entries}
    return {
        "active_material": {
            "preset_id": metadata.get("override.active_material_preset_id"),
            "name": metadata.get("override.active_material_name"),
            "specific_capacity_mah_g": _positive_float(
                metadata.get("override.active_material_specific_capacity_mah_g")
            ),
        },
        "electrode_area_preset_id": metadata.get("override.electrode_area_preset_id"),
        "electrode_area_preset_name": metadata.get("override.electrode_area_preset_name"),
    }


def cell_dict(
    db: Session,
    cell: Cell,
    tag_names: list[str] | None = None,
    *,
    include_metadata: bool = True,
    metadata_values: dict[str, str] | None = None,
) -> dict:
    if tag_names is None:
        tags = (
            db.query(Tag.name)
            .join(CellTag, CellTag.tag_id == Tag.id)
            .filter(CellTag.cell_id == cell.id)
            .all()
        )
        tag_names = [row[0] for row in tags]
    meta = (
        metadata_values
        if metadata_values is not None
        else {m.key: m.value for m in cell.metadata_entries}
    )
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
    result = {
        "id": cell.id,
        "name": cell.name,
        "description": cell.description,
        "archived": cell.archived,
        "cycling_status": cell.cycling_status,
        "tags": sorted(tag_names),
        "scientific_metadata": cell_scientific_metadata(cell, meta),
        "scientific_presets": cell_scientific_presets(cell, meta),
        "n_tests": len(cell.tests),
        "n_files": n_files,
        "total_cycles": cycles,
        **totals,
        "has_offline": "offline" in statuses,
        "has_changed": "changed" in statuses,
        "has_changing": "changing" in statuses,
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
    if include_metadata:
        result["metadata"] = meta
    return result


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
            selectinload(Cell.tests)
            .selectinload(Test.file_links)
            .selectinload(TestFile.file),
        )
        .order_by(Cell.name)
        .all()
    )
    tags_by_cell: dict[int, list[str]] = {cell.id: [] for cell in cells}
    metadata_by_cell: dict[int, dict[str, str]] = {cell.id: {} for cell in cells}
    if cells:
        tag_rows = (
            db.query(CellTag.cell_id, Tag.name)
            .join(Tag, CellTag.tag_id == Tag.id)
            .filter(CellTag.cell_id.in_(tags_by_cell))
            .all()
        )
        for cell_id, tag_name in tag_rows:
            tags_by_cell[cell_id].append(tag_name)
        metadata_rows = (
            db.query(CellMetadata.cell_id, CellMetadata.key, CellMetadata.value)
            .filter(
                CellMetadata.cell_id.in_(metadata_by_cell),
                CellMetadata.key.in_(SCIENTIFIC_SUMMARY_METADATA_KEYS),
            )
            .all()
        )
        for cell_id, key, value in metadata_rows:
            metadata_by_cell[cell_id][key] = value
    return [
        cell_dict(
            db,
            cell,
            tags_by_cell[cell.id],
            include_metadata=False,
            metadata_values=metadata_by_cell[cell.id],
        )
        for cell in cells
    ]


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


def _observed_steps_for_source(source_file: SourceFile) -> list[dict]:
    parser_version = source_file.parser_version or parsing.PARSER_VERSION
    raw = cache.load_raw_columns(
        source_file.hash,
        parser_version,
        ["cycle", "step", "step_index"],
    )
    if raw is None:
        raw = cache.load_raw_columns(
            source_file.hash,
            parser_version,
            ["cycle", "step_index"],
        )
    return protocol.observed_step_coverage(raw)


@router.get("/cells/{cell_id}/protocol")
def get_cell_protocol(
    cell_id: int,
    db: Session = Depends(get_db),
    include_observed: bool = False,
):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    effective_nominal_capacity = cell_scientific_metadata(cell)["nominal_capacity_mah"][
        "effective_value"
    ]
    result = {
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
                        "hash": link.file.hash,
                        "observed_steps": (
                            _observed_steps_for_source(link.file) if include_observed else []
                        ),
                        "protocol": protocol.reconstruct_protocol(
                            link.file.header_meta,
                            effective_nominal_capacity,
                        ),
                    }
                    for link in sorted(test.file_links, key=lambda item: item.position)
                ],
            }
            for test in sorted(cell.tests, key=lambda item: item.id)
        ],
    }
    return result


class CellUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    archived: bool | None = None
    active_mass_mg_override: float | None = None
    nominal_capacity_mah_override: float | None = None
    electrode_area_cm2_override: float | None = None
    active_material_preset_id: str | None = None
    active_material_name: str | None = None
    active_material_specific_capacity_mah_g: float | None = None
    electrode_area_preset_id: str | None = None
    electrode_area_preset_name: str | None = None


def _set_cell_metadata_value(
    db: Session,
    cell_id: int,
    key: str,
    value: float | None,
) -> bool:
    row = (
        db.query(CellMetadata)
        .filter(CellMetadata.cell_id == cell_id, CellMetadata.key == key)
        .first()
    )
    if value is None:
        if row is None:
            return False
        db.delete(row)
        return True
    if value <= 0:
        raise HTTPException(422, f"{key} must be positive")
    text = str(float(value))
    if row is not None:
        if row.value == text:
            return False
        row.value = text
    else:
        db.add(CellMetadata(cell_id=cell_id, key=key, value=text))
    return True


def _set_cell_text_metadata_value(
    db: Session,
    cell_id: int,
    key: str,
    value: str | None,
) -> bool:
    row = (
        db.query(CellMetadata)
        .filter(CellMetadata.cell_id == cell_id, CellMetadata.key == key)
        .first()
    )
    text = (value or "").strip()
    if not text:
        if row is None:
            return False
        db.delete(row)
        return True
    if row is not None:
        if row.value == text:
            return False
        row.value = text
    else:
        db.add(CellMetadata(cell_id=cell_id, key=key, value=text))
    return True


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
    override_fields = {
        "active_mass_mg_override": "active_mass_mg",
        "nominal_capacity_mah_override": "nominal_capacity_mah",
        "electrode_area_cm2_override": "electrode_area_cm2",
        "active_material_specific_capacity_mah_g": "active_material_specific_capacity_mah_g",
    }
    for request_field, scientific_field in override_fields.items():
        if request_field not in req.model_fields_set:
            continue
        key = SCIENTIFIC_OVERRIDE_KEYS.get(
            scientific_field,
            f"override.{scientific_field}",
        )
        if _set_cell_metadata_value(
            db,
            cell.id,
            key,
            getattr(req, request_field),
        ):
            changed_fields.append(scientific_field)
    text_override_fields = {
        "active_material_preset_id": "override.active_material_preset_id",
        "active_material_name": "override.active_material_name",
        "electrode_area_preset_id": "override.electrode_area_preset_id",
        "electrode_area_preset_name": "override.electrode_area_preset_name",
    }
    for request_field, key in text_override_fields.items():
        if request_field not in req.model_fields_set:
            continue
        if _set_cell_text_metadata_value(db, cell.id, key, getattr(req, request_field)):
            changed_fields.append(request_field)
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
    if any(
        field in changed_fields
        for field in [
            *SCIENTIFIC_OVERRIDE_KEYS,
            "active_material_specific_capacity_mah_g",
            *text_override_fields,
        ]
    ):
        db.expire(cell, ["metadata_entries"])
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
        stat = path.stat()
    except OSError:
        return {"id": job["id"], "location_status": "offline", "hash": None}
    return {
        "id": job["id"],
        "location_status": "changed" if current_hash != job["hash"] else "online",
        "hash": current_hash,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "hashed": True,
    }


def _source_stat_worker(job: dict) -> dict:
    try:
        stat = Path(job["path"]).stat()
    except OSError:
        return {"id": job["id"], "location_status": "offline"}
    return {
        "id": job["id"],
        "location_status": "online",
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def _source_stat_batches(
    jobs: list[dict],
    *,
    batch_size: int,
    max_workers: int,
) -> list[dict]:
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="source-stat") as executor:
        for start in range(0, len(jobs), batch_size):
            results.extend(executor.map(_source_stat_worker, jobs[start : start + batch_size]))
    return results


def _set_current_thread_low_priority() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        thread_handle = ctypes.windll.kernel32.GetCurrentThread()
        ctypes.windll.kernel32.SetThreadPriority(thread_handle, -1)
    except Exception:
        pass


def cell_source_check_worker_count(n_jobs: int, max_workers: int | None = None) -> int:
    available = max_workers or os.cpu_count() or 1
    return max(1, min(n_jobs, available))


def _source_check_job_snapshot(job_id: int) -> dict | None:
    with _source_check_job_lock:
        job = _source_check_jobs.get(job_id)
        return deepcopy(job) if job else None


def source_check_running() -> bool:
    with _source_check_job_lock:
        if _latest_source_check_job_id is None:
            return False
        job = _source_check_jobs.get(_latest_source_check_job_id)
        return bool(job and job.get("status") == "running")


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
    if sf is not None and status in {"online", "changed", "offline", "deferred"}:
        sf.location_status = "changing" if status == "deferred" else status
        sf.last_source_check_at = datetime.now(timezone.utc)
        if result.get("size") is not None:
            sf.observed_size = result["size"]
            sf.observed_mtime_ns = result.get("mtime_ns")
        db.commit()

    background_job_id = None
    with _source_check_job_lock:
        job = _source_check_jobs[job_id]
        background_job_id = job.get("background_job_id")
        job["completed"] += 1
        if status in {"online", "changed", "offline", "deferred"}:
            job[status] += 1
        else:
            job["errors"] += 1
        if status == "changed":
            job["changed_file_ids"].append(source_job["id"])
            if result.get("size") is not None:
                job["changed_source_signatures"][source_job["id"]] = {
                    "size": result["size"],
                    "mtime_ns": result["mtime_ns"],
                }
        if status == "deferred":
            job["deferred_file_ids"].append(source_job["id"])
        if result.get("hashed"):
            job["hashed"] += 1
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
            detail=(
                "Source matches the registered checksum"
                if status == "online"
                else "Source was still changing and will be checked again"
                if status == "deferred"
                else None
            ),
            error=result.get("error"),
            counter="failed" if status == "error" else status,
        )


def _record_source_retry_result(
    job_id: int,
    db: Session,
    source_job: dict,
    result: dict,
) -> None:
    """Replace one deferred result without counting the source twice."""
    status = result.get("location_status", "error")
    sf = db.get(SourceFile, source_job["id"])
    if sf is not None:
        if status in {"online", "changed", "offline"}:
            sf.location_status = status
            sf.last_source_check_at = datetime.now(timezone.utc)
            if result.get("size") is not None:
                sf.observed_size = result["size"]
                sf.observed_mtime_ns = result.get("mtime_ns")
        elif status == "deferred":
            sf.location_status = "changing"
            sf.last_source_check_at = datetime.now(timezone.utc)
        db.commit()

    with _source_check_job_lock:
        job = _source_check_jobs[job_id]
        background_job_id = job.get("background_job_id")
        job["retry_completed"] += 1
        if status != "deferred":
            job["deferred"] = max(0, job["deferred"] - 1)
            job["deferred_file_ids"] = [
                file_id for file_id in job["deferred_file_ids"] if file_id != source_job["id"]
            ]
            if status in {"online", "changed", "offline"}:
                job[status] += 1
            else:
                job["errors"] += 1
        if status == "changed" and source_job["id"] not in job["changed_file_ids"]:
            job["changed_file_ids"].append(source_job["id"])
            if result.get("size") is not None:
                job["changed_source_signatures"][source_job["id"]] = {
                    "size": result["size"],
                    "mtime_ns": result["mtime_ns"],
                }
        if result.get("hashed"):
            job["hashed"] += 1
        for row in job["files"]:
            if row["file_id"] == source_job["id"]:
                row["status"] = status
                row["error"] = result.get("error")
                break

    if background_job_id is not None:
        background_jobs.record_result(
            background_job_id,
            source_job["id"],
            status=("ready" if status == "online" else "failed" if status == "error" else status),
            detail=(
                "Source is stable and matches the registered checksum"
                if status == "online"
                else "Source is still changing"
                if status == "deferred"
                else None
            ),
            error=result.get("error"),
            counter=f"retry_{'failed' if status == 'error' else status}",
        )


def _run_metadata_source_checks(
    job_id: int,
    db: Session,
    jobs: list[dict],
    *,
    batch_size: int,
    worker_count: int,
    stability_seconds: float,
) -> None:
    """Stat everything concurrently, then hash only stable metadata changes."""
    for source_job in jobs:
        _update_source_check_file(job_id, source_job["id"], status="checking")

    first_results = _source_stat_batches(
        jobs,
        batch_size=batch_size,
        max_workers=worker_count,
    )
    first_by_id = {result["id"]: result for result in first_results}
    candidates: list[dict] = []
    for source_job in jobs:
        result = first_by_id[source_job["id"]]
        if result["location_status"] == "offline":
            _record_source_check_result(job_id, db, source_job, result)
            continue
        unchanged_metadata = (
            source_job.get("observed_size") == result["size"]
            and source_job.get("observed_mtime_ns") == result["mtime_ns"]
            and source_job.get("location_status") not in {"changed", "offline", "changing"}
        )
        if unchanged_metadata:
            _record_source_check_result(job_id, db, source_job, result)
        else:
            candidates.append(source_job)

    if not candidates:
        return

    background_job_id = (_source_check_job_snapshot(job_id) or {}).get("background_job_id")
    if background_job_id is not None:
        background_jobs.update_job(
            background_job_id,
            description=(
                f"Waiting {stability_seconds:g} s to confirm "
                f"{len(candidates)} possible source change"
                f"{'s' if len(candidates) != 1 else ''}"
            ),
        )
    _sleep(stability_seconds)

    second_results = _source_stat_batches(
        candidates,
        batch_size=batch_size,
        max_workers=worker_count,
    )
    second_by_id = {result["id"]: result for result in second_results}
    if background_job_id is not None:
        background_jobs.update_job(
            background_job_id,
            description=f"Verifying {len(candidates)} stable source files",
        )

    for source_job in candidates:
        first = first_by_id[source_job["id"]]
        second = second_by_id[source_job["id"]]
        if second["location_status"] == "offline":
            _record_source_check_result(job_id, db, source_job, second)
            continue
        if (first["size"], first["mtime_ns"]) != (second["size"], second["mtime_ns"]):
            _record_source_check_result(
                job_id,
                db,
                source_job,
                {
                    "id": source_job["id"],
                    "location_status": "deferred",
                },
            )
            continue
        try:
            current_hash = parsing.compute_hash(Path(source_job["path"]))
            final = _source_stat_worker(source_job)
            if final.get("location_status") != "online" or (
                final.get("size"), final.get("mtime_ns")
            ) != (second["size"], second["mtime_ns"]):
                result = {"id": source_job["id"], "location_status": "deferred"}
            else:
                result = {
                    **final,
                    "location_status": (
                        "changed" if current_hash != source_job["hash"] else "online"
                    ),
                    "hash": current_hash,
                    "hashed": True,
                }
        except OSError:
            result = {"id": source_job["id"], "location_status": "offline"}
        except Exception as exc:
            result = {
                "id": source_job["id"],
                "location_status": "error",
                "error": str(exc),
            }
        _record_source_check_result(job_id, db, source_job, result)


def _retry_deferred_sources_once(
    job_id: int,
    db: Session,
    jobs: list[dict],
    *,
    batch_size: int,
    worker_count: int,
    stability_seconds: float,
) -> None:
    for source_job in jobs:
        _update_source_check_file(job_id, source_job["id"], status="checking")
    first_results = _source_stat_batches(
        jobs,
        batch_size=batch_size,
        max_workers=worker_count,
    )
    first_by_id = {result["id"]: result for result in first_results}
    stable_candidates = [
        source_job
        for source_job in jobs
        if first_by_id[source_job["id"]].get("location_status") == "online"
    ]
    if stable_candidates:
        _sleep(stability_seconds)
        second_results = _source_stat_batches(
            stable_candidates,
            batch_size=batch_size,
            max_workers=worker_count,
        )
        second_by_id = {result["id"]: result for result in second_results}
    else:
        second_by_id = {}

    for source_job in jobs:
        first = first_by_id[source_job["id"]]
        if first.get("location_status") != "online":
            _record_source_retry_result(job_id, db, source_job, first)
            continue
        second = second_by_id[source_job["id"]]
        if second.get("location_status") != "online":
            _record_source_retry_result(job_id, db, source_job, second)
            continue
        if (first["size"], first["mtime_ns"]) != (second["size"], second["mtime_ns"]):
            _record_source_retry_result(
                job_id,
                db,
                source_job,
                {"id": source_job["id"], "location_status": "deferred"},
            )
            continue
        try:
            current_hash = parsing.compute_hash(Path(source_job["path"]))
            final = _source_stat_worker(source_job)
            if final.get("location_status") != "online" or (
                final.get("size"), final.get("mtime_ns")
            ) != (second["size"], second["mtime_ns"]):
                result = {"id": source_job["id"], "location_status": "deferred"}
            else:
                result = {
                    **final,
                    "location_status": (
                        "changed" if current_hash != source_job["hash"] else "online"
                    ),
                    "hash": current_hash,
                    "hashed": True,
                }
        except OSError:
            result = {"id": source_job["id"], "location_status": "offline"}
        except Exception as exc:
            result = {
                "id": source_job["id"],
                "location_status": "error",
                "error": str(exc),
            }
        _record_source_retry_result(job_id, db, source_job, result)


def _run_deferred_source_retries(
    job_id: int,
    db: Session,
    jobs: list[dict],
    *,
    batch_size: int,
    worker_count: int,
    stability_seconds: float,
    retry_count: int,
    retry_delay_minutes: int,
    retry_deadline_at: str | None,
) -> None:
    jobs_by_id = {source_job["id"]: source_job for source_job in jobs}
    try:
        deadline = datetime.fromisoformat(retry_deadline_at) if retry_deadline_at else None
        if deadline and deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
    except ValueError:
        deadline = None
    delay_seconds = retry_delay_minutes * 60

    for attempt in range(1, retry_count + 1):
        snapshot = _source_check_job_snapshot(job_id)
        if not snapshot or not snapshot.get("deferred_file_ids"):
            break
        retry_at = datetime.now(timezone.utc).timestamp() + delay_seconds + stability_seconds
        if deadline and retry_at >= deadline.timestamp():
            _update_source_check_job(job_id, retries_stopped="next_scheduled_check")
            if snapshot.get("background_job_id") is not None:
                background_jobs.update_job(
                    snapshot["background_job_id"],
                    description=(
                        f"Leaving {snapshot['deferred']} changing source file"
                        f"{'s' if snapshot['deferred'] != 1 else ''} for the next scheduled check"
                    ),
                )
            break

        retry_jobs = [
            jobs_by_id[file_id]
            for file_id in snapshot["deferred_file_ids"]
            if file_id in jobs_by_id
        ]
        if not retry_jobs:
            break
        retry_start_at = datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() + delay_seconds,
            timezone.utc,
        ).isoformat()
        with _source_check_job_lock:
            live = _source_check_jobs[job_id]
            live["phase"] = "retry_wait"
            live["retry_attempt"] = attempt
            live["retry_next_at"] = retry_start_at
            live["retry_total"] += len(retry_jobs)
            live["background_total"] += len(retry_jobs)
            background_total = live["background_total"]
            background_job_id = live.get("background_job_id")
            for row in live["files"]:
                if row["file_id"] in live["deferred_file_ids"]:
                    row["status"] = "waiting_retry"
        if background_job_id is not None:
            background_jobs.update_job(
                background_job_id,
                total=background_total,
                description=(
                    f"Retry {attempt} of {retry_count} for {len(retry_jobs)} changing source file"
                    f"{'s' if len(retry_jobs) != 1 else ''} in {retry_delay_minutes} min"
                ),
            )
        _sleep(delay_seconds)
        _update_source_check_job(job_id, phase="retrying", retry_next_at=None)
        if background_job_id is not None:
            background_jobs.update_job(
                background_job_id,
                description=(
                    f"Retrying {len(retry_jobs)} changing source file"
                    f"{'s' if len(retry_jobs) != 1 else ''}"
                ),
            )
        _retry_deferred_sources_once(
            job_id,
            db,
            retry_jobs,
            batch_size=batch_size,
            worker_count=worker_count,
            stability_seconds=stability_seconds,
        )
    _update_source_check_job(job_id, phase="checking", retry_next_at=None)


def _run_source_check_job(
    job_id: int,
    jobs: list[dict],
    worker_count: int,
    scan_mode: str = "checksum",
    batch_size: int = 100,
    stability_seconds: float = 5.0,
    low_impact: bool = False,
    retry_count: int = 0,
    retry_delay_minutes: int = 5,
    retry_deadline_at: str | None = None,
) -> None:
    if low_impact:
        _set_current_thread_low_priority()
    db = SessionLocal()
    try:
        if not jobs:
            _update_source_check_job(
                job_id,
                status="completed",
                phase="completed",
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
            snapshot = _source_check_job_snapshot(job_id)
            if snapshot and snapshot.get("background_job_id") is not None:
                background_jobs.update_job(
                    snapshot["background_job_id"],
                    status="completed",
                    description="No active source files needed checking",
                )
        elif scan_mode == "metadata":
            _run_metadata_source_checks(
                job_id,
                db,
                jobs,
                batch_size=batch_size,
                worker_count=worker_count,
                stability_seconds=stability_seconds,
            )
            if retry_count > 0:
                _run_deferred_source_retries(
                    job_id,
                    db,
                    jobs,
                    batch_size=batch_size,
                    worker_count=worker_count,
                    stability_seconds=stability_seconds,
                    retry_count=retry_count,
                    retry_delay_minutes=retry_delay_minutes,
                    retry_deadline_at=retry_deadline_at,
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
        if snapshot and snapshot["status"] == "running" and snapshot.get("update_after_check"):
            changed_ids = list(dict.fromkeys(snapshot["changed_file_ids"]))
            background_job_id = snapshot.get("background_job_id")
            _update_source_check_job(
                job_id,
                phase="updating",
                update_total=len(changed_ids),
                update_completed=0,
            )
            if background_job_id is not None:
                background_jobs.update_job(
                    background_job_id,
                    total=snapshot["total"] + len(changed_ids),
                    description=(
                        f"Updating {len(changed_ids)} changed source file"
                        f"{'s' if len(changed_ids) != 1 else ''}"
                        if changed_ids
                        else "All active sources are already current"
                    ),
                )

            ready_cell_ids: set[int] = set()
            updated_file_ids: list[int] = []
            update_errors: list[dict] = []
            for file_id in changed_ids:
                sf = db.get(SourceFile, file_id)
                if sf is None:
                    continue
                _update_source_check_file(job_id, file_id, status="updating")
                error = None
                try:
                    signature = snapshot.get("changed_source_signatures", {}).get(file_id)
                    if scan_mode == "metadata" and signature:
                        updated_sf = scanner.update_source_from_path_if_stable(
                            db,
                            sf,
                            expected_size=signature["size"],
                            expected_mtime_ns=signature["mtime_ns"],
                        )
                    else:
                        updated_sf = scanner.update_source_from_path(db, sf)
                    if updated_sf.parse_status == "error":
                        error = updated_sf.parse_error or "Cache rebuild failed"
                    else:
                        updated_file_ids.append(updated_sf.id)
                        if updated_sf.test_link and updated_sf.test_link.test:
                            ready_cell_ids.add(updated_sf.test_link.test.cell_id)
                except scanner.SourceChangedDuringRead as exc:
                    error = None
                    sf.location_status = "changing"
                    sf.last_source_check_at = datetime.now(timezone.utc)
                    db.commit()
                    with _source_check_job_lock:
                        live = _source_check_jobs.get(job_id)
                        if live is not None:
                            live["deferred"] += 1
                            live["update_completed"] += 1
                            if file_id not in live["deferred_file_ids"]:
                                live["deferred_file_ids"].append(file_id)
                            for row in live["files"]:
                                if row["file_id"] == file_id:
                                    row["status"] = "deferred"
                                    row["error"] = None
                                    break
                    if background_job_id is not None:
                        background_jobs.record_result(
                            background_job_id,
                            file_id,
                            status="deferred",
                            detail=str(exc),
                            counter="deferred",
                        )
                    continue
                except Exception as exc:  # preserve the remaining updates
                    error = str(exc)

                with _source_check_job_lock:
                    live = _source_check_jobs.get(job_id)
                    if live is not None:
                        live["update_completed"] += 1
                        if error:
                            update_errors.append(
                                {"file_id": file_id, "filename": sf.filename, "error": error}
                            )
                        for row in live["files"]:
                            if row["file_id"] == file_id:
                                row["status"] = "failed" if error else "ready"
                                row["error"] = error
                                break
                if background_job_id is not None:
                    background_jobs.record_result(
                        background_job_id,
                        file_id,
                        status="failed" if error else "ready",
                        detail=None if error else "Updated source and rebuilt cache",
                        error=error,
                        counter="update_failed" if error else "updated",
                    )

            _update_source_check_job(
                job_id,
                updated=len(updated_file_ids),
                updated_file_ids=updated_file_ids,
                ready_cell_ids=sorted(ready_cell_ids),
                update_errors=update_errors,
            )
            snapshot = _source_check_job_snapshot(job_id)
        if snapshot and snapshot["status"] == "running":
            _update_source_check_job(
                job_id,
                status="completed",
                phase="completed",
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
            snapshot = _source_check_job_snapshot(job_id)
        if snapshot and snapshot.get("background_job_id") is not None:
            background_jobs.update_job(
                snapshot["background_job_id"],
                status="completed",
                description=(
                    f"Checked {snapshot['completed']} source files and updated "
                    f"{snapshot.get('updated', 0)}"
                    if snapshot.get("update_after_check")
                    else (
                        f"Checked {snapshot['completed']} source files: "
                        f"{snapshot['changed']} changed, {snapshot['offline']} offline"
                    )
                ),
            )
        if snapshot:
            severity = (
                "warning"
                if snapshot["offline"] or snapshot["errors"] or snapshot.get("deferred") or snapshot.get("update_errors")
                else "info"
            )
            record_activity(
                db,
                category="source",
                action="check_update_sources" if snapshot.get("update_after_check") else "check_sources",
                message=(
                    f"Checked {snapshot['completed']} source files and updated "
                    f"{snapshot.get('updated', 0)} changed sources"
                    if snapshot.get("update_after_check")
                    else (
                        f"Checked {snapshot['completed']} source files: "
                        f"{snapshot['changed']} changed, {snapshot['offline']} offline"
                    )
                ),
                severity=severity,
                details={
                    "checked": snapshot["completed"],
                    "skipped_complete": snapshot["skipped_complete"],
                    "changed": snapshot["changed"],
                    "offline": snapshot["offline"],
                    "online": snapshot["online"],
                    "errors": snapshot["errors"],
                    "deferred": snapshot.get("deferred", 0),
                    "hashed": snapshot.get("hashed", 0),
                    "changed_file_ids": snapshot["changed_file_ids"],
                    "workers": snapshot["workers"],
                    "scan_mode": snapshot.get("scan_mode", "checksum"),
                    "trigger": snapshot.get("trigger", "manual"),
                    "batch_size": snapshot.get("batch_size"),
                    "stability_seconds": snapshot.get("stability_seconds"),
                    "retry_count": snapshot.get("retry_count", 0),
                    "retry_attempts_used": snapshot.get("retry_attempt", 0),
                    "retry_delay_minutes": snapshot.get("retry_delay_minutes"),
                    "retry_completed": snapshot.get("retry_completed", 0),
                    "retries_stopped": snapshot.get("retries_stopped"),
                    "updated": snapshot.get("updated", 0),
                    "updated_file_ids": snapshot.get("updated_file_ids", []),
                    "ready_cell_ids": snapshot.get("ready_cell_ids", []),
                    "update_errors": snapshot.get("update_errors", []),
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
    update_after_check: bool = False,
    *,
    scan_mode: Literal["checksum", "metadata"] = "checksum",
    batch_size: int = 100,
    stability_seconds: float = 5.0,
    trigger: Literal["manual", "tray", "scheduled"] = "manual",
    low_impact: bool = False,
    retry_count: int = 0,
    retry_delay_minutes: int = 5,
    retry_deadline_at: str | None = None,
) -> dict:
    global _latest_source_check_job_id, _next_source_check_job_id
    with _source_check_job_lock:
        if _latest_source_check_job_id is not None:
            current = _source_check_jobs.get(_latest_source_check_job_id)
            if current and current["status"] == "running":
                if trigger == "scheduled":
                    return deepcopy(current)
                if update_after_check and not current.get("update_after_check"):
                    current["update_after_check"] = True
                    background_job_id = current.get("background_job_id")
                    if background_job_id is not None:
                        background_jobs.update_job(
                            background_job_id,
                            kind="source_check_update",
                            title="Checking and updating sources",
                        )
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
            "observed_size": sf.observed_size,
            "observed_mtime_ns": sf.observed_mtime_ns,
            "location_status": sf.location_status,
        }
        for sf in source_files
    ]
    if scan_mode == "metadata":
        batch_size = max(1, min(int(batch_size), 5000))
        worker_count = max(1, min(len(jobs) or 1, batch_size, 16))
    else:
        worker_count = cell_source_check_worker_count(len(jobs))
    now = datetime.now(timezone.utc).isoformat()
    background_job_id = background_jobs.create_job(
        kind="source_check_update" if update_after_check else "source_check",
        title="Checking and updating sources" if update_after_check else "Checking sources",
        description=(
            f"Scanning metadata for {len(jobs)} source files"
            if scan_mode == "metadata"
            else f"Checking checksums for {len(jobs)} source files"
        ),
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
            "deferred": 0,
            "errors": 0,
            "hashed": 0,
            "skipped_complete": skipped_complete,
            "changed_file_ids": [],
            "changed_source_signatures": {},
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
            "phase": "checking",
            "update_after_check": update_after_check,
            "update_total": 0,
            "update_completed": 0,
            "updated": 0,
            "updated_file_ids": [],
            "ready_cell_ids": [],
            "update_errors": [],
            "scan_mode": scan_mode,
            "trigger": trigger,
            "batch_size": batch_size if scan_mode == "metadata" else None,
            "stability_seconds": stability_seconds if scan_mode == "metadata" else None,
            "low_impact": low_impact,
            "deferred_file_ids": [],
            "retry_count": retry_count,
            "retry_delay_minutes": retry_delay_minutes,
            "retry_deadline_at": retry_deadline_at,
            "retry_attempt": 0,
            "retry_total": 0,
            "retry_completed": 0,
            "retry_next_at": None,
            "retries_stopped": None,
            "background_total": len(jobs),
        }
        _source_check_jobs[job_id] = job
        _latest_source_check_job_id = job_id
        old_ids = sorted(_source_check_jobs)[:-20]
        for old_id in old_ids:
            _source_check_jobs.pop(old_id, None)

    _JobThread(
        target=_run_source_check_job,
        args=(
            job_id,
            jobs,
            worker_count,
            scan_mode,
            batch_size,
            stability_seconds,
            low_impact,
            retry_count,
            retry_delay_minutes,
            retry_deadline_at,
        ),
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


@router.post("/cells/check-update-sources/jobs")
def create_source_check_update_job(db: Session = Depends(get_db)):
    return start_source_check_job(
        db,
        cell_ids=None,
        include_complete=False,
        update_after_check=True,
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
