"""Source files: inbox, scanning, preview, registration into Test→Cell."""
from __future__ import annotations

import os
import re
import threading
import uuid
from concurrent.futures import ProcessPoolExecutor
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import CALC_VERSION, IMPORT_DIR
from ..db import SessionLocal, get_db
from ..models import (
    Cell,
    CellMetadata,
    CellTag,
    Folder,
    FolderCell,
    FolderReplicateGroup,
    GroupCell,
    ProjectCell,
    ReplicateGroup,
    ReplicateGroupCell,
    SourceFile,
    Test,
    TestFile,
)
from ..services import cache, calc, parsing, scanner

router = APIRouter(prefix="/api", tags=["files"])


def import_filename_allowed(filename: str) -> bool:
    return Path(filename or "").suffix.lower() in {".nda", ".ndax"}


def _clean_filename(filename: str) -> str:
    name = Path(filename or "cell.ndax").name
    return re.sub(r"[^A-Za-z0-9_. -]", "_", name).strip() or "cell.ndax"


def resolve_import_staged_path(staged_name: str) -> Path:
    candidate = (IMPORT_DIR / staged_name).resolve()
    root = IMPORT_DIR.resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("Invalid staged file")
    return candidate


def resolve_import_source_path(staged_name: str, source_path: str | None = None) -> Path:
    if source_path:
        return Path(source_path).expanduser().resolve()
    return resolve_import_staged_path(staged_name)


def _inspect_import_path(
    path: Path,
    db: Session,
    staged_name: str | None = None,
    expose_source_path: bool = True,
) -> dict:
    if not path.exists() or not path.is_file():
        raise HTTPException(404, f"File is missing: {path}")
    original = _clean_filename(path.name)
    if not import_filename_allowed(original):
        raise HTTPException(400, f"Only .nda and .ndax files can be imported: {original}")

    file_hash = parsing.compute_hash(path)
    meta = parsing.read_header_metadata(path)
    preview_meta = _metadata_preview(meta)
    return {
        "staged_name": staged_name or f"path:{uuid.uuid4().hex}",
        "source_path": str(path) if expose_source_path else None,
        "filename": original,
        "size": path.stat().st_size,
        "ext": path.suffix.lower().lstrip("."),
        "hash": file_hash,
        "barcode": meta.get("barcode"),
        "remarks": meta.get("remarks"),
        "device_info": meta.get("device_info"),
        "channel": meta.get("channel"),
        "start_time": meta.get("start_time"),
        "active_mass_mg": meta.get("active_mass_mg"),
        "nda_version": meta.get("nda_version"),
        "metadata": preview_meta,
        "raw_metadata": _raw_metadata_preview(meta.get("raw") or {}),
        "metadata_error": meta.get("error"),
        "import_match": import_match_info(db, file_hash, original, meta),
        "capacity_preview": None,
        "preview_error": None,
    }


def _metadata_preview(meta: dict) -> dict[str, str]:
    fields = {
        "barcode": meta.get("barcode"),
        "channel": meta.get("channel"),
        "device_info": meta.get("device_info"),
        "start_time": meta.get("start_time"),
        "active_mass_mg": meta.get("active_mass_mg"),
        "nda_version": meta.get("nda_version"),
        "remarks": meta.get("remarks"),
    }
    return {k: str(v) for k, v in fields.items() if v not in (None, "")}


def _raw_metadata_preview(raw: dict, limit: int = 80) -> dict[str, str]:
    return dict(list((raw or {}).items())[:limit])


def _source_file_match_payload(sf: SourceFile, kind: str, matched_on: list[str]) -> dict:
    link = sf.test_link
    registered = link is not None and not link.test.cell.archived
    return {
        "kind": kind,
        "matched_on": matched_on,
        "source_file_id": sf.id,
        "filename": sf.filename,
        "path": sf.path,
        "hash": sf.hash,
        "cell_id": link.test.cell_id if link else None,
        "cell_name": link.test.cell.name if link else None,
        "test_id": link.test_id if link else None,
        "test_name": link.test.name if link else None,
        "registered": registered,
        "location_status": sf.location_status,
        "parse_status": sf.parse_status,
    }


def _norm(value) -> str:
    return str(value or "").strip().lower()


def import_match_info(db: Session, file_hash: str, filename: str, meta: dict) -> dict | None:
    """Detect exact duplicate imports and likely updated/extended files.

    Exact identity is the SHA-256 content hash. Soft identity intentionally
    requires multiple weak signals so a shared channel or generic filename does
    not create a noisy warning on its own.
    """
    rows = db.query(SourceFile).all()
    for sf in rows:
        if sf.hash == file_hash:
            if sf.test_link is not None and sf.test_link.test.cell.archived:
                return None
            return _source_file_match_payload(sf, "exact_duplicate", ["hash"])

    filename_norm = _norm(Path(filename).name)
    meta_fields = {
        "barcode": _norm(meta.get("barcode")),
        "channel": _norm(meta.get("channel")),
        "start_time": _norm(meta.get("start_time")),
        "remarks": _norm(meta.get("remarks")),
    }
    best: tuple[int, SourceFile, list[str]] | None = None
    for sf in rows:
        matched_on = []
        if filename_norm and filename_norm == _norm(sf.filename):
            matched_on.append("filename")
        for key, value in meta_fields.items():
            if value and value == _norm(getattr(sf, key, None)):
                matched_on.append(key)

        # Strong enough to be useful without being chatty: either a filename
        # plus one metadata match, or at least three metadata-only matches.
        if ("filename" in matched_on and len(matched_on) >= 2) or len(matched_on) >= 3:
            score = len(matched_on)
            if best is None or score > best[0]:
                best = (score, sf, matched_on)
    if best is None:
        return None
    _, sf, matched_on = best
    return _source_file_match_payload(sf, "possible_update", matched_on)


def remove_archived_cell_blocking_source(db: Session, sf: SourceFile) -> None:
    link = sf.test_link
    if link is None or not link.test.cell.archived:
        return
    cell = link.test.cell
    cell_id = cell.id
    group_ids = [
        row[0]
        for row in db.query(ReplicateGroupCell.group_id)
        .filter(ReplicateGroupCell.cell_id == cell_id)
        .all()
    ]
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
    for group_id in set(group_ids):
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
    db.flush()


def capacity_preview_from_cycles(cycles) -> dict:
    if cycles.empty or "cycle" not in cycles.columns:
        return {"x": [], "y": [], "quantity": "discharge_capacity_mah", "label": "Discharge capacity (mAh)"}
    quantity = "discharge_capacity_mah"
    if quantity not in cycles.columns:
        quantity = "charge_capacity_mah"
    if quantity not in cycles.columns:
        return {"x": [], "y": [], "quantity": quantity, "label": "Capacity (mAh)"}
    rows = cycles[["cycle", quantity]].dropna()
    label = "Discharge capacity (mAh)" if quantity == "discharge_capacity_mah" else "Charge capacity (mAh)"
    return {
        "x": [int(v) for v in rows["cycle"]],
        "y": [float(v) for v in rows[quantity]],
        "quantity": quantity,
        "label": label,
    }


def build_capacity_preview(path: Path) -> tuple[dict | None, str | None]:
    try:
        raw = parsing.parse_timeseries(path)
        cycles = calc.per_cycle(raw)
        return capacity_preview_from_cycles(cycles), None
    except Exception as exc:
        return None, str(exc)


def _build_import_cache_worker(job: dict) -> dict:
    try:
        info = cache.build(job["hash"], job["path"])
        return {"staged_name": job["staged_name"], "ok": True, **info}
    except Exception as exc:
        return {"staged_name": job["staged_name"], "ok": False, "error": str(exc)}


def import_cache_worker_count(n_jobs: int, max_workers: int | None = None) -> int:
    available = max_workers or os.cpu_count() or 1
    return max(1, min(n_jobs, available))


def build_import_caches_parallel(
    jobs: list[dict],
    executor_cls=ProcessPoolExecutor,
    max_workers: int | None = None,
) -> dict[str, dict]:
    if not jobs:
        return {}
    worker_count = import_cache_worker_count(len(jobs), max_workers=max_workers)
    if worker_count == 1:
        return {
            result["staged_name"]: result
            for result in (_build_import_cache_worker(job) for job in jobs)
        }
    with executor_cls(max_workers=worker_count) as executor:
        return {
            job["staged_name"]: {**result, "staged_name": result.get("staged_name", job["staged_name"])}
            for job, result in zip(jobs, executor.map(_build_import_cache_worker, jobs))
        }


def apply_import_cache_results(
    db: Session,
    source_file_ids_by_staged_name: dict[str, int],
    cache_results: dict[str, dict],
) -> None:
    for staged_name, result in cache_results.items():
        source_file_id = source_file_ids_by_staged_name.get(staged_name)
        if source_file_id is None:
            continue
        sf = db.get(SourceFile, source_file_id)
        if sf is None:
            continue
        if result.get("ok"):
            sf.parse_status = "parsed"
            sf.parse_error = None
            sf.parser_version = result["parser_version"]
            sf.row_count = result["rows"]
            sf.cycle_count = result["cycles"]
        else:
            sf.parse_status = "error"
            sf.parse_error = result.get("error") or "Cache build failed"
    db.commit()


def run_import_cache_jobs(
    source_file_ids_by_staged_name: dict[str, int],
    cache_jobs: list[dict],
) -> None:
    db = SessionLocal()
    try:
        cache_results = build_import_caches_parallel(cache_jobs)
        apply_import_cache_results(db, source_file_ids_by_staged_name, cache_results)
    finally:
        db.close()


def start_import_cache_jobs(
    source_file_ids_by_staged_name: dict[str, int],
    cache_jobs: list[dict],
) -> None:
    if not cache_jobs:
        return
    thread = threading.Thread(
        target=run_import_cache_jobs,
        args=(dict(source_file_ids_by_staged_name), list(cache_jobs)),
        daemon=True,
    )
    thread.start()


def _json_safe_scalar(value):
    if value is None:
        return None
    if isinstance(value, np.generic):
        value = value.item()
    if pd.isna(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def raw_table_from_frame(df: pd.DataFrame, offset: int = 0, limit: int = 100) -> dict:
    page_limit = min(max(int(limit), 1), 500)
    page_offset = max(int(offset), 0)
    page = df.iloc[page_offset : page_offset + page_limit]
    columns = [str(column) for column in df.columns]
    rows = [
        {str(key): _json_safe_scalar(value) for key, value in record.items()}
        for record in page.to_dict("records")
    ]
    return {
        "columns": columns,
        "rows": rows,
        "total_rows": int(len(df)),
        "offset": page_offset,
        "limit": page_limit,
    }


def file_dict(sf: SourceFile) -> dict:
    link = sf.test_link
    return {
        "id": sf.id,
        "hash": sf.hash,
        "path": sf.path,
        "filename": sf.filename,
        "size": sf.size,
        "ext": sf.ext,
        "nda_version": sf.nda_version,
        "device_info": sf.device_info,
        "channel": sf.channel,
        "barcode": sf.barcode,
        "remarks": sf.remarks,
        "start_time": sf.start_time,
        "active_mass_mg": sf.active_mass_mg,
        "location_status": sf.location_status,
        "parse_status": sf.parse_status,
        "parse_error": sf.parse_error,
        "parser_version": sf.parser_version,
        "row_count": sf.row_count,
        "cycle_count": sf.cycle_count,
        "registered": link is not None,
        "test_id": link.test_id if link else None,
        "test_name": link.test.name if link else None,
        "cell_id": link.test.cell_id if link else None,
        "cell_name": link.test.cell.name if link else None,
        "created_at": sf.created_at.isoformat(),
    }


class ScanRequest(BaseModel):
    path: str
    parse_now: bool = False


class ImportCellDraft(BaseModel):
    staged_name: str
    source_path: str | None = None
    filename: str
    cell_name: str
    description: str | None = None
    test_name: str | None = None
    metadata: dict[str, str] = {}


class ImportReplicateGroupDraft(BaseModel):
    name: str
    description: str | None = None
    staged_names: list[str]


class ImportCellsRequest(BaseModel):
    cells: list[ImportCellDraft]
    folder_id: int | None = None
    folder_ids: list[int] = []
    replicate_group_name: str | None = None
    replicate_group_description: str | None = None
    replicate_groups: list[ImportReplicateGroupDraft] = []


class ImportPlanError(ValueError):
    pass


def import_replicate_plan(
    cells: list[ImportCellDraft],
    groups: list[ImportReplicateGroupDraft],
) -> dict:
    staged_names = [cell.staged_name for cell in cells]
    known = set(staged_names)
    assigned: set[str] = set()
    planned_groups = []
    group_names: set[str] = set()
    for group in groups:
        name = group.name.strip()
        if not name:
            raise ImportPlanError("Every replicate group needs a name")
        if name in group_names:
            raise ImportPlanError(f"Duplicate replicate group name: {name}")
        group_names.add(name)
        unique_staged = list(dict.fromkeys(group.staged_names))
        if len(unique_staged) < 2:
            raise ImportPlanError("A replicate group needs at least two cells")
        missing = [staged for staged in unique_staged if staged not in known]
        if missing:
            raise ImportPlanError(f"Replicate group references unknown staged files: {missing}")
        planned_groups.append(
            {
                "name": name,
                "description": (group.description or "").strip() or None,
                "staged_names": unique_staged,
            }
        )
        assigned.update(unique_staged)
    return {
        "groups": planned_groups,
        "unassigned_staged_names": [staged for staged in staged_names if staged not in assigned],
    }


class ImportPreviewRequest(BaseModel):
    staged_name: str
    source_path: str | None = None


class ImportRawDataRequest(BaseModel):
    staged_name: str
    source_path: str | None = None
    offset: int = 0
    limit: int = 100


class ImportPathInspectRequest(BaseModel):
    paths: list[str]


@router.post("/imports/inspect")
async def inspect_import_files(files: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    previews = []
    for upload in files:
        original = _clean_filename(upload.filename or "")
        if not import_filename_allowed(original):
            raise HTTPException(400, f"Only .nda and .ndax files can be imported: {original}")

        staged_name = f"{uuid.uuid4().hex}_{original}"
        staged_path = resolve_import_staged_path(staged_name)
        size = 0
        with staged_path.open("wb") as out:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                out.write(chunk)

        previews.append(
            _inspect_import_path(staged_path, db, staged_name=staged_name, expose_source_path=False)
        )
    return {"files": previews}


@router.post("/imports/inspect-paths")
def inspect_import_paths(req: ImportPathInspectRequest, db: Session = Depends(get_db)):
    if not req.paths:
        return {"files": []}
    return {"files": [_inspect_import_path(Path(path), db) for path in req.paths]}


@router.post("/imports/pick-files")
def pick_import_files(db: Session = Depends(get_db)):
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise HTTPException(500, f"Native file picker is not available: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askopenfilenames(
            title="Select Neware cell files",
            filetypes=[
                ("Neware files", "*.ndax *.nda"),
                ("NDAX files", "*.ndax"),
                ("NDA files", "*.nda"),
                ("All files", "*.*"),
            ],
        )
    finally:
        root.destroy()
    return {"files": [_inspect_import_path(Path(path), db) for path in selected]}


@router.post("/imports/preview")
def preview_import_file(req: ImportPreviewRequest):
    try:
        source_path = resolve_import_source_path(req.staged_name, req.source_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, "Source file is missing")
    capacity_preview, preview_error = build_capacity_preview(source_path)
    return {"capacity_preview": capacity_preview, "preview_error": preview_error}


@router.post("/imports/raw-data")
def raw_import_file_data(req: ImportRawDataRequest):
    try:
        source_path = resolve_import_source_path(req.staged_name, req.source_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, "Source file is missing")
    try:
        raw = parsing.parse_timeseries(source_path)
    except Exception as exc:
        raise HTTPException(422, f"Raw data could not be loaded: {exc}") from exc
    return raw_table_from_frame(raw, offset=req.offset, limit=req.limit)


@router.post("/imports/cells")
def create_imported_cells(req: ImportCellsRequest, db: Session = Depends(get_db)):
    if not req.cells:
        raise HTTPException(400, "No files selected")
    target_folder_ids = list(dict.fromkeys(
        ([req.folder_id] if req.folder_id is not None else []) + req.folder_ids
    ))
    for folder_id in target_folder_ids:
        if db.get(Folder, folder_id) is None:
            raise HTTPException(404, "Import target folder is missing")
    requested_groups = list(req.replicate_groups)
    if (req.replicate_group_name or "").strip():
        requested_groups.append(
            ImportReplicateGroupDraft(
                name=(req.replicate_group_name or "").strip(),
                description=req.replicate_group_description,
                staged_names=[cell.staged_name for cell in req.cells],
            )
        )
    try:
        replicate_plan = import_replicate_plan(req.cells, requested_groups)
    except ImportPlanError as exc:
        raise HTTPException(400, str(exc)) from exc
    grouped_staged_names = {
        staged_name
        for group in replicate_plan["groups"]
        for staged_name in group["staged_names"]
    }

    created = []
    created_cell_ids = []
    cell_ids_by_staged_name: dict[str, int] = {}
    source_file_ids_by_staged_name: dict[str, int] = {}
    cache_jobs: list[dict] = []
    for draft in req.cells:
        name = draft.cell_name.strip()
        if not name:
            raise HTTPException(400, "Every imported file needs a cell name")
        if db.query(Cell).filter(Cell.name == name).first() is not None:
            raise HTTPException(409, f"Cell already exists: {name}")

        try:
            source_path = resolve_import_source_path(draft.staged_name, draft.source_path)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not source_path.exists():
            raise HTTPException(404, f"Source file is missing: {draft.filename}")

        file_hash = parsing.compute_hash(source_path)
        existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
        if existing is not None:
            remove_archived_cell_blocking_source(db, existing)
            db.flush()
            existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
        if existing is not None and existing.test_link is not None:
            raise HTTPException(409, f"{draft.filename} is already registered")

        meta = parsing.read_header_metadata(source_path)
        if existing is None:
            sf = SourceFile(
                hash=file_hash,
                path=str(source_path),
                filename=draft.filename,
                size=source_path.stat().st_size,
                ext=Path(draft.filename).suffix.lower().lstrip("."),
                nda_version=meta.get("nda_version"),
                device_info=meta.get("device_info"),
                channel=meta.get("channel"),
                barcode=meta.get("barcode"),
                remarks=meta.get("remarks"),
                start_time=meta.get("start_time"),
                active_mass_mg=meta.get("active_mass_mg"),
                header_meta=meta.get("raw") or None,
                location_status="online",
                parse_status="unparsed",
            )
            db.add(sf)
            db.flush()
        else:
            sf = existing
            sf.path = str(source_path)
            sf.filename = draft.filename
            sf.location_status = "online"

        cell = Cell(name=name, description=(draft.description or "").strip() or None)
        db.add(cell)
        db.flush()

        for key, value in draft.metadata.items():
            k = key.strip()
            v = str(value).strip()
            if k and v:
                db.add(CellMetadata(cell_id=cell.id, key=k, value=v))

        test = Test(cell_id=cell.id, name=(draft.test_name or "").strip() or "Imported file")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=sf.id, position=0))
        if draft.staged_name not in grouped_staged_names:
            for folder_id in target_folder_ids:
                exists = (
                    db.query(FolderCell)
                    .filter(FolderCell.folder_id == folder_id, FolderCell.cell_id == cell.id)
                    .first()
                )
                if exists is None:
                    position = max(
                        (
                            row[0]
                            for row in db.query(FolderCell.position)
                            .filter(FolderCell.folder_id == folder_id)
                            .all()
                        ),
                        default=-1,
                    )
                    db.add(FolderCell(folder_id=folder_id, cell_id=cell.id, position=position + 1))

        sf.parse_status = "parsing"
        db.flush()
        source_file_ids_by_staged_name[draft.staged_name] = sf.id
        cache_jobs.append(
            {
                "staged_name": draft.staged_name,
                "hash": sf.hash,
                "path": str(source_path),
            }
        )
        created.append(
            {
                "cell_id": cell.id,
                "cell_name": cell.name,
                "test_id": test.id,
                "test_name": test.name,
                "file_id": sf.id,
                "filename": sf.filename,
            }
        )
        created_cell_ids.append(cell.id)
        cell_ids_by_staged_name[draft.staged_name] = cell.id

    replicate_groups = []
    for planned_group in replicate_plan["groups"]:
        group_name = planned_group["name"]
        group_cell_ids = [cell_ids_by_staged_name[name] for name in planned_group["staged_names"]]
        if db.query(ReplicateGroup).filter(ReplicateGroup.name == group_name).first() is not None:
            raise HTTPException(409, f"Replicate group already exists: {group_name}")
        group = ReplicateGroup(
            name=group_name,
            description=planned_group["description"],
        )
        db.add(group)
        db.flush()
        for position, cell_id in enumerate(group_cell_ids):
            db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell_id, position=position))
        for folder_id in target_folder_ids:
            position = max(
                (
                    row[0]
                    for row in db.query(FolderReplicateGroup.position)
                    .filter(FolderReplicateGroup.folder_id == folder_id)
                    .all()
                ),
                default=-1,
            )
            db.add(FolderReplicateGroup(folder_id=folder_id, group_id=group.id, position=position + 1))
        replicate_groups.append({"id": group.id, "name": group.name, "cell_ids": group_cell_ids})
    db.commit()
    start_import_cache_jobs(source_file_ids_by_staged_name, cache_jobs)
    return {
        "created": created,
        "replicate_group": replicate_groups[0] if len(replicate_groups) == 1 else None,
        "replicate_groups": replicate_groups,
        "parsing_started": bool(cache_jobs),
    }


@router.post("/scan")
def start_scan(req: ScanRequest):
    if not Path(req.path).is_dir():
        raise HTTPException(400, f"Not a directory: {req.path}")
    return scanner.start_scan(req.path, parse_now=req.parse_now)


@router.get("/scan/jobs")
def scan_jobs():
    return scanner.list_jobs()


@router.get("/scan/jobs/{job_id}")
def scan_job(job_id: int):
    job = scanner.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    return job


@router.get("/files")
def list_files(registered: bool | None = None, db: Session = Depends(get_db)):
    files = db.query(SourceFile).order_by(SourceFile.created_at.desc()).all()
    out = [file_dict(f) for f in files]
    if registered is not None:
        out = [f for f in out if f["registered"] == registered]
    return out


@router.get("/files/{file_id}")
def get_file(file_id: int, db: Session = Depends(get_db)):
    sf = db.get(SourceFile, file_id)
    if sf is None:
        raise HTTPException(404, "No such file")
    return file_dict(sf)


@router.post("/files/{file_id}/parse")
def parse_file(file_id: int, db: Session = Depends(get_db)):
    sf = db.get(SourceFile, file_id)
    if sf is None:
        raise HTTPException(404, "No such file")
    if not Path(sf.path).exists():
        sf.location_status = "offline"
        db.commit()
        raise HTTPException(409, "Source file is offline; cannot parse")
    return file_dict(scanner.parse_file(db, sf))


@router.post("/files/{file_id}/check")
def check_file(file_id: int, db: Session = Depends(get_db)):
    sf = db.get(SourceFile, file_id)
    if sf is None:
        raise HTTPException(404, "No such file")
    return file_dict(scanner.check_location(db, sf))


@router.post("/files/{file_id}/update-from-source")
def update_file_from_source(file_id: int, db: Session = Depends(get_db)):
    sf = db.get(SourceFile, file_id)
    if sf is None:
        raise HTTPException(404, "No such file")
    try:
        return file_dict(scanner.update_source_from_path(db, sf))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.delete("/files/{file_id}")
def delete_file(file_id: int, db: Session = Depends(get_db)):
    sf = db.get(SourceFile, file_id)
    if sf is None:
        raise HTTPException(404, "No such file")
    if sf.test_link is not None:
        raise HTTPException(409, "File is registered to a test; detach it first")
    db.delete(sf)
    db.commit()
    return {"ok": True}


@router.get("/files/{file_id}/preview")
def preview_file(file_id: int, kind: str = "cycles", db: Session = Depends(get_db)):
    """Quick plot data straight from a file — no registration required
    ('plot a cell seconds after import')."""
    sf = db.get(SourceFile, file_id)
    if sf is None:
        raise HTTPException(404, "No such file")
    if sf.parse_status != "parsed":
        if not Path(sf.path).exists():
            raise HTTPException(409, "File is offline and has no cache yet")
        scanner.parse_file(db, sf)
        if sf.parse_status == "error":
            raise HTTPException(422, f"Parse failed: {sf.parse_error}")

    pv = sf.parser_version or parsing.PARSER_VERSION
    if kind == "raw":
        df = cache.load_raw(sf.hash, pv)
        if df is None:
            raise HTTPException(409, "No raw cache available")
        step = max(1, len(df) // 5000)
        df = df.iloc[::step]
        return {
            "kind": "raw",
            "time_s": [float(v) for v in df["time_s"]],
            "voltage_v": [float(v) for v in df["voltage_v"]],
            "current_ma": [float(v) for v in df["current_ma"]],
        }
    df = cache.load_cycles(sf.hash, pv, CALC_VERSION)
    if df is None:
        raise HTTPException(409, "No cycle cache available")
    df = df.replace({np.nan: None})
    return {"kind": "cycles", "columns": list(df.columns), "rows": df.drop(columns=["start_timestamp"], errors="ignore").to_dict("records")}


class RegisterRequest(BaseModel):
    """Register files into the identity layer with minimal input.
    Either pick an existing cell/test or name new ones."""

    file_ids: list[int]
    cell_id: int | None = None
    cell_name: str | None = None
    test_id: int | None = None
    test_name: str | None = None


@router.post("/register")
def register_files(req: RegisterRequest, db: Session = Depends(get_db)):
    files = [db.get(SourceFile, fid) for fid in req.file_ids]
    if any(f is None for f in files):
        raise HTTPException(404, "One or more files not found")
    for f in files:
        if f.test_link is not None:
            raise HTTPException(409, f"{f.filename} is already registered")

    if req.cell_id is not None:
        cell = db.get(Cell, req.cell_id)
        if cell is None:
            raise HTTPException(404, "No such cell")
    else:
        name = (req.cell_name or "").strip()
        if not name:
            # sensible default from file metadata — but never forced
            name = files[0].barcode or files[0].remarks or Path(files[0].filename).stem
        cell = db.query(Cell).filter(Cell.name == name).first()
        if cell is None:
            cell = Cell(name=name)
            db.add(cell)
            db.flush()

    if req.test_id is not None:
        test = db.get(Test, req.test_id)
        if test is None or test.cell_id != cell.id:
            raise HTTPException(404, "No such test on that cell")
    else:
        test = Test(cell_id=cell.id, name=(req.test_name or "").strip() or f"Test {len(cell.tests) + 1}")
        db.add(test)
        db.flush()

    base = max((l.position for l in test.file_links), default=-1) + 1
    for i, f in enumerate(files):
        db.add(TestFile(test_id=test.id, file_id=f.id, position=base + i))
    db.commit()
    return {"cell_id": cell.id, "cell_name": cell.name, "test_id": test.id, "test_name": test.name}


@router.post("/tests/{test_id}/detach/{file_id}")
def detach_file(test_id: int, file_id: int, db: Session = Depends(get_db)):
    link = (
        db.query(TestFile).filter(TestFile.test_id == test_id, TestFile.file_id == file_id).first()
    )
    if link is None:
        raise HTTPException(404, "File is not attached to that test")
    db.delete(link)
    db.commit()
    return {"ok": True}


class ReorderRequest(BaseModel):
    file_ids: list[int]  # new order


@router.post("/tests/{test_id}/reorder")
def reorder_files(test_id: int, req: ReorderRequest, db: Session = Depends(get_db)):
    test = db.get(Test, test_id)
    if test is None:
        raise HTTPException(404, "No such test")
    pos = {fid: i for i, fid in enumerate(req.file_ids)}
    for link in test.file_links:
        if link.file_id in pos:
            link.position = pos[link.file_id]
    db.commit()
    return {"ok": True}
