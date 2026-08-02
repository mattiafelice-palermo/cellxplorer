"""Source files: inbox, scanning, preview, registration into Test→Cell."""
from __future__ import annotations

import os
import re
import threading
import uuid
import json
import hashlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

from ..services.process_priority import apply_background_thread_priority, process_pool_executor
from ..services import import_inspection

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
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
    ImportSubmission,
    SourceFile,
    AppSetting,
    Test,
    TestFile,
)
from ..services import background_jobs
from ..services.activity_log import record_activity
from ..services.lazy_module import LazyModule
from ..services.windows_known_folders import known_user_folders


def _load_numpy():
    import numpy

    return numpy


def _load_pandas():
    import pandas

    return pandas


def _load_cache():
    from ..services import cache as module

    return module


def _load_calc():
    from ..services import calc as module

    return module


def _load_parsing():
    from ..services import parsing as module

    return module


def _load_scanner():
    from ..services import scanner as module

    return module


def _load_continuations():
    from ..services import continuations as module

    return module


def _load_analysis_usage():
    from ..services import analysis_usage as module

    return module


def _load_cache_maintenance():
    from ..services import cache_maintenance as module

    return module


np = LazyModule(_load_numpy)
pd = LazyModule(_load_pandas)
cache = LazyModule(_load_cache)
calc = LazyModule(_load_calc)
parsing = LazyModule(_load_parsing)
scanner = LazyModule(_load_scanner)
continuations = LazyModule(_load_continuations)
analysis_usage = LazyModule(_load_analysis_usage)
cache_maintenance = LazyModule(_load_cache_maintenance)

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
    match_rows: list[SourceFile] | None = None,
    inspected: import_inspection.FileInspection | None = None,
    match_snapshot: import_inspection.ImportIdentitySnapshot | None = None,
) -> dict:
    if inspected is None:
        try:
            inspected = import_inspection.inspect_file(str(path))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    original = _clean_filename(inspected.filename)
    file_hash = inspected.hash
    meta = inspected.metadata
    preview_meta = _metadata_preview(meta)
    return {
        "staged_name": staged_name or f"path:{uuid.uuid4().hex}",
        "source_path": str(path) if expose_source_path else None,
        "filename": original,
        "size": inspected.size,
        "ext": inspected.ext,
        "hash": file_hash,
        "barcode": meta.get("barcode"),
        "remarks": meta.get("remarks"),
        "device_info": meta.get("device_info"),
        "channel": meta.get("channel"),
        "start_time": meta.get("start_time"),
        "active_mass_mg": meta.get("active_mass_mg"),
        "nominal_capacity_mah": meta.get("nominal_capacity_mah"),
        "nda_version": meta.get("nda_version"),
        "metadata": preview_meta,
        "raw_metadata": _raw_metadata_preview(meta.get("raw") or {}),
        "metadata_error": meta.get("error"),
        "import_match": (
            import_inspection.match_import(match_snapshot, file_hash, original, meta)
            if match_snapshot is not None
            else import_match_info(db, file_hash, original, meta, rows=match_rows)
        ),
        "inspection": {
            "hash": file_hash,
            "size": inspected.size,
            # JSON numbers cannot represent Windows nanosecond timestamps
            # exactly in JavaScript; keep this fingerprint lossless.
            "mtime_ns": str(inspected.mtime_ns),
        },
        "capacity_preview": None,
        "preview_error": None,
    }


def _metadata_preview(meta: dict) -> dict[str, str]:
    fields = {
        "start_step_id": meta.get("start_step_id"),
        "part_number": meta.get("part_number"),
        "builder": meta.get("builder"),
        "barcode": meta.get("barcode"),
        "channel": meta.get("channel"),
        "device_info": meta.get("device_info"),
        "start_time": meta.get("start_time"),
        "active_material_mg": meta.get("active_mass_mg"),
        "nominal_capacity_mah": meta.get("nominal_capacity_mah"),
        "charge_cutoff_v": meta.get("charge_cutoff_v"),
        "discharge_cutoff_v": meta.get("discharge_cutoff_v"),
        "protection_voltage_upper_v": meta.get("protection_voltage_upper_v"),
        "protection_voltage_lower_v": meta.get("protection_voltage_lower_v"),
        "record_interval_s": meta.get("record_interval_s"),
        "nda_version": meta.get("nda_version"),
        "remarks": meta.get("remarks"),
    }
    return {k: str(v) for k, v in fields.items() if v not in (None, "")}


def _raw_metadata_preview(raw: dict, limit: int = 80) -> dict[str, str]:
    return dict(list((raw or {}).items())[:limit])


def full_cell_metadata_from_header(meta: dict, draft_metadata: dict[str, str] | None = None) -> dict[str, str]:
    metadata: dict[str, str] = {}
    metadata.update(_metadata_preview(meta))
    for key, value in (meta.get("raw") or {}).items():
        k = f"raw.{key}".strip()
        v = str(value).strip()
        if k and v:
            metadata[k] = v
    for key, value in (draft_metadata or {}).items():
        k = key.strip()
        v = str(value).strip()
        if k and v:
            metadata[k] = v
    return metadata


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


def import_match_info(
    db: Session,
    file_hash: str,
    filename: str,
    meta: dict,
    rows: list[SourceFile] | None = None,
) -> dict | None:
    """Detect exact duplicate imports and likely updated/extended files.

    Exact identity is the SHA-256 content hash. Soft identity intentionally
    requires multiple weak signals so a shared channel or generic filename does
    not create a noisy warning on its own.
    """
    if rows is None:
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


def build_capacity_preview(
    path: Path,
    file_hash: str | None = None,
) -> tuple[dict | None, str | None]:
    """Preview via the versioned cache: one parse per file content, ever.
    The preview responds as soon as the parse finishes; the Parquet caches
    are written behind it on a background thread, so the import confirm
    (and any later work on this file) reuses them instead of re-parsing."""
    try:
        verified_hash = file_hash or parsing.compute_hash(path)
        cycles = cache.build_write_behind(verified_hash, path)
        if cycles is None:
            raise RuntimeError("cycle cache could not be built")
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
    if n_jobs <= 25:
        return 1
    logical_cpus = os.cpu_count() or 1
    cap = min(4, max(1, logical_cpus // 2), n_jobs)
    if max_workers is not None:
        cap = min(cap, max(1, int(max_workers)))
    return max(1, cap)


def build_import_caches_parallel(
    jobs: list[dict],
    executor_cls=ProcessPoolExecutor,
    max_workers: int | None = None,
    progress_callback=None,
) -> dict[str, dict]:
    if not jobs:
        return {}
    # worker processes can't see this process's write-behind threads, so
    # settle any in-flight cache writes before dispatching
    for job in jobs:
        cache.wait_for_pending(job["hash"])
    worker_count = import_cache_worker_count(len(jobs), max_workers=max_workers)
    if worker_count == 1:
        results = {}
        for job in jobs:
            result = _build_import_cache_worker(job)
            results[result["staged_name"]] = result
            if progress_callback:
                progress_callback(job, result)
        return results
    pool = process_pool_executor(worker_count) if executor_cls is ProcessPoolExecutor else executor_cls(max_workers=worker_count)
    with pool as executor:
        results = {}
        futures = {
            executor.submit(_build_import_cache_worker, job): job
            for job in jobs
        }
        for future in as_completed(futures):
            job = futures[future]
            result = future.result()
            normalized = {
                **result,
                "staged_name": result.get("staged_name", job["staged_name"]),
            }
            results[job["staged_name"]] = normalized
            if progress_callback:
                progress_callback(job, normalized)
        return results


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
            scanner.apply_capacity_summary(sf, result)
        else:
            sf.parse_status = "error"
            sf.parse_error = result.get("error") or "Cache build failed"
            sf.capacity_summary_status = "error"
    db.commit()


def run_import_cache_jobs(
    source_file_ids_by_staged_name: dict[str, int],
    cache_jobs: list[dict],
    background_job_id: int,
) -> None:
    db: Session | None = None
    try:
        apply_background_thread_priority()
        db = SessionLocal()
        for cache_job in cache_jobs:
            background_jobs.update_item(
                background_job_id,
                cache_job["staged_name"],
                status="processing",
            )

        def report_progress(cache_job: dict, result: dict) -> None:
            apply_import_cache_results(
                db,
                {cache_job["staged_name"]: source_file_ids_by_staged_name[cache_job["staged_name"]]},
                {cache_job["staged_name"]: result},
            )
            background_jobs.record_result(
                background_job_id,
                cache_job["staged_name"],
                status="ready" if result.get("ok") else "failed",
                detail="Cycling cache ready" if result.get("ok") else None,
                error=result.get("error"),
                counter="ready" if result.get("ok") else "failed",
            )

        cache_results = build_import_caches_parallel(
            cache_jobs,
            progress_callback=report_progress,
        )
        failed = sum(1 for result in cache_results.values() if not result.get("ok"))
        background_jobs.update_job(
            background_job_id,
            status="completed",
            description=(
                f"Prepared cycling caches for {len(cache_results) - failed} files"
                + (f"; {failed} failed" if failed else "")
            ),
        )
        record_activity(
            db,
            category="import",
            action="prepare_import_caches",
            message=(
                f"Prepared cycling caches for {len(cache_results) - failed} files"
                + (f"; {failed} failed" if failed else "")
            ),
            severity="warning" if failed else "info",
            details={
                "background_job_id": background_job_id,
                "source_file_ids": list(source_file_ids_by_staged_name.values()),
                "failed": failed,
            },
        )
        db.commit()
    except Exception as exc:
        error = f"Cell registration succeeded; cycling cache preparation failed: {exc}"
        if db is not None:
            for source_file_id in set(source_file_ids_by_staged_name.values()):
                sf = db.get(SourceFile, source_file_id)
                if sf is None:
                    continue
                sf.parse_status = "error"
                sf.parse_error = error
                sf.capacity_summary_status = "error"
            db.commit()
            record_activity(
                db,
                category="import",
                action="prepare_import_caches",
                message="Cell registration succeeded; cycling cache preparation failed",
                severity="error",
                details={
                    "background_job_id": background_job_id,
                    "source_file_ids": list(source_file_ids_by_staged_name.values()),
                    "error": error,
                },
            )
            db.commit()
        for cache_job in cache_jobs:
            background_jobs.update_item(
                background_job_id,
                cache_job["staged_name"],
                status="failed",
                error=error,
            )
        background_jobs.update_job(
            background_job_id,
            status="failed",
            description="Cell registration succeeded; cycling cache preparation failed",
            error=error,
        )
    finally:
        if db is not None:
            db.close()


def start_import_cache_jobs(
    source_file_ids_by_staged_name: dict[str, int],
    cache_jobs: list[dict],
) -> dict:
    if not cache_jobs:
        return {
            "queued": False,
            "count": 0,
            "job_id": None,
            "status": "ready",
        }
    background_job_id = background_jobs.create_job(
        kind="import_cache",
        title="Preparing imported cells",
        description=f"Building cycling caches for {len(cache_jobs)} files",
        total=len(cache_jobs),
        items=[
            {"id": job["staged_name"], "label": Path(job["path"]).name}
            for job in cache_jobs
        ],
    )
    thread = threading.Thread(
        target=run_import_cache_jobs,
        args=(dict(source_file_ids_by_staged_name), list(cache_jobs), background_job_id),
        daemon=True,
    )
    thread.start()
    return {
        "queued": True,
        "count": len(cache_jobs),
        "job_id": background_job_id,
        "status": "running",
    }


def _mtime_fingerprint_matches(value: object, actual: int | None) -> bool:
    if actual is None or value is None:
        return False
    try:
        return int(value) == actual
    except (TypeError, ValueError):
        return False


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
        "nominal_capacity_mah": sf.nominal_capacity_mah,
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


class ImportSourceDraft(BaseModel):
    staged_name: str
    source_path: str | None = None
    filename: str
    inspection: dict | None = None


class ImportCellDraft(BaseModel):
    staged_name: str | None = None
    source_path: str | None = None
    filename: str | None = None
    inspection: dict | None = None
    sources: list[ImportSourceDraft] = []
    cell_name: str
    description: str | None = None
    metadata: dict[str, str] = {}
    active_mass_mg_override: float | None = None
    nominal_capacity_mah_override: float | None = None
    electrode_area_cm2_override: float | None = None
    active_material_preset_id: str | None = None
    active_material_name: str | None = None
    active_material_specific_capacity_mah_g: float | None = None
    electrode_area_preset_id: str | None = None
    electrode_area_preset_name: str | None = None
    acknowledged_finding_ids: list[str] = []


class ImportReplicateGroupDraft(BaseModel):
    name: str
    description: str | None = None
    staged_names: list[str]


class ImportCellsRequest(BaseModel):
    cells: list[ImportCellDraft]
    job_token: str | None = Field(default=None, max_length=100)
    folder_id: int | None = None
    folder_ids: list[int] = []
    replicate_group_name: str | None = None
    replicate_group_description: str | None = None
    replicate_groups: list[ImportReplicateGroupDraft] = []


def normalize_import_cell_sources(draft: ImportCellDraft) -> list[ImportSourceDraft]:
    if draft.sources:
        return draft.sources
    if draft.staged_name and draft.filename:
        return [
            ImportSourceDraft(
                staged_name=draft.staged_name,
                source_path=draft.source_path,
                filename=draft.filename,
                inspection=draft.inspection,
            )
        ]
    raise HTTPException(400, "Each cell draft needs at least one source")


def _import_name_conflict_detail(
    code: str,
    message: str,
    conflicts: list[dict],
) -> dict:
    return {
        "code": code,
        "message": message,
        "conflicts": conflicts,
    }


def _import_name_sources(draft: ImportCellDraft) -> list[dict]:
    return [
        {
            "filename": source.filename,
            "staged_name": source.staged_name,
        }
        for source in normalize_import_cell_sources(draft)
    ]


def _validate_import_cell_names(req: ImportCellsRequest, db: Session) -> None:
    """Validate Cell names before any source identity or scientific work starts."""
    grouped: dict[str, list[dict]] = {}
    for draft in req.cells:
        name = draft.cell_name.strip()
        sources = _import_name_sources(draft)
        if not name:
            raise HTTPException(
                400,
                _import_name_conflict_detail(
                    "invalid_cell_name",
                    "Every imported Cell needs a name.",
                    [{"name": "", "filenames": [item["filename"] for item in sources],
                      "staged_names": [item["staged_name"] for item in sources]}],
                ),
            )
        grouped.setdefault(name, []).append({
            "name": name,
            "filenames": [item["filename"] for item in sources],
            "staged_names": [item["staged_name"] for item in sources],
        })

    duplicate_conflicts = [
        {
            "name": name,
            "cell_name": name,
            "filenames": [filename for item in entries for filename in item["filenames"]],
            "staged_names": [staged for item in entries for staged in item["staged_names"]],
        }
        for name, entries in grouped.items()
        if len(entries) > 1
    ]
    if duplicate_conflicts:
        raise HTTPException(
            409,
            _import_name_conflict_detail(
                "duplicate_submitted_cell_names",
                "Multiple submitted files use the same Cell name. Rename the conflicting Cells before importing.",
                duplicate_conflicts,
            ),
        )

    # Keep this as one query, limited to names in this request. Besides being
    # cheaper than one lookup per draft, this makes the validation boundary
    # obvious: no parsing, hashing, or continuation checks precede it.
    submitted_names = list(grouped)
    existing_names = {
        name
        for (name,) in db.query(Cell.name).filter(Cell.name.in_(submitted_names)).all()
    }
    existing_conflicts = [
        {
            "name": name,
            "cell_name": name,
            "filenames": grouped[name][0]["filenames"],
            "staged_names": grouped[name][0]["staged_names"],
        }
        for name in submitted_names
        if name in existing_names
    ]
    if existing_conflicts:
        raise HTTPException(
            409,
            _import_name_conflict_detail(
                "cell_name_already_exists",
                "A Cell with this name already exists. Rename the conflicting Cell before importing.",
                existing_conflicts,
            ),
        )


def _translate_import_integrity_error(
    req: ImportCellsRequest,
    db: Session,
    exc: IntegrityError,
) -> HTTPException:
    """Hide raw SQLite text and recover a structured name conflict when possible."""
    db.rollback()
    try:
        _validate_import_cell_names(req, db)
    except HTTPException as conflict:
        return conflict
    return HTTPException(
        409,
        {
            "code": "import_integrity_error",
            "message": "The import could not be committed because another change created a conflict.",
            "conflicts": [],
        },
    )


def import_cell_replicate_key(draft: ImportCellDraft) -> str:
    if draft.staged_name:
        return draft.staged_name
    sources = normalize_import_cell_sources(draft)
    return sources[0].staged_name


class ImportPlanError(ValueError):
    pass


def import_replicate_plan(
    cells: list[ImportCellDraft],
    groups: list[ImportReplicateGroupDraft],
) -> dict:
    staged_names = [import_cell_replicate_key(cell) for cell in cells]
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
    expected_hash: str | None = None
    expected_size: int | None = None
    expected_mtime_ns: int | str | None = None


class ImportRawDataRequest(BaseModel):
    staged_name: str
    source_path: str | None = None
    offset: int = 0
    limit: int = 100


class ImportPathInspectRequest(BaseModel):
    paths: list[str]
    job_token: str | None = Field(default=None, max_length=100)


class ContinuationInspectSourceRequest(BaseModel):
    staged_name: str
    source_path: str | None = None
    inspection: dict | None = None


class ContinuationInspectRequest(BaseModel):
    sources: list[ContinuationInspectSourceRequest]
    existing_test_id: int | None = None
    existing_cell_id: int | None = None
    proposed_order: list[str] | None = None


class ImportSourceListRequest(BaseModel):
    file_paths: list[str] = []
    folder_paths: list[str] = []
    job_token: str | None = Field(default=None, max_length=100)


class ImportBrowseRequest(BaseModel):
    path: str | None = None


class ImportPinnedFoldersRequest(BaseModel):
    paths: list[str]


IMPORT_PINNED_FOLDERS_KEY = "import_pinned_folders"
IMPORT_RECENT_FOLDERS_KEY = "import_recent_folders"


def _path_setting(db: Session, key: str) -> list[str]:
    row = db.get(AppSetting, key)
    if row is None or not row.value:
        return []
    try:
        values = json.loads(row.value)
    except (TypeError, ValueError):
        return []
    return [str(value) for value in values if str(value).strip()]


def _set_path_setting(db: Session, key: str, paths: list[str]) -> None:
    row = db.get(AppSetting, key)
    value = json.dumps(paths)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value


def _normalized_unique_paths(paths: list[str], require_existing: bool = False) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in paths:
        try:
            path = Path(raw).expanduser().resolve()
        except OSError:
            path = Path(raw).expanduser()
        if require_existing and not path.is_dir():
            continue
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        normalized.append(str(path))
    return normalized


def _quick_access_entry(
    path: Path,
    label: str,
    section: str,
    *,
    pinned: bool = False,
) -> dict:
    return {
        "path": str(path),
        "label": label,
        "section": section,
        "pinned": pinned,
        "available": path.is_dir() and os.access(path, os.R_OK),
    }


def _quick_access_path_key(path: Path) -> str:
    value = os.path.normcase(os.path.normpath(str(path)))
    return value.casefold() if os.name == "nt" else value


def import_quick_access(db: Session) -> list[dict]:
    folders = known_user_folders()
    entries: list[dict] = []
    standard = [
        (folders["home"], "Home"),
        (folders["desktop"], "Desktop"),
        (folders["documents"], "Documents"),
        (folders["downloads"], "Downloads"),
    ]
    seen: set[str] = set()
    for path, label in standard:
        key = _quick_access_path_key(path)
        if key in seen:
            continue
        seen.add(key)
        entries.append(_quick_access_entry(path, label, "quick"))
    for raw in _path_setting(db, IMPORT_PINNED_FOLDERS_KEY):
        path = Path(raw)
        key = _quick_access_path_key(path)
        if key in seen:
            for entry in entries:
                if _quick_access_path_key(Path(entry["path"])) == key:
                    entry["pinned"] = True
            continue
        seen.add(key)
        entries.append(_quick_access_entry(path, path.name or str(path), "pinned", pinned=True))
    for raw in _path_setting(db, IMPORT_RECENT_FOLDERS_KEY):
        path = Path(raw)
        key = _quick_access_path_key(path)
        if key in seen:
            continue
        seen.add(key)
        entries.append(_quick_access_entry(path, path.name or str(path), "recent"))
    return entries


def remember_import_folder(db: Session, path: Path) -> None:
    existing = _path_setting(db, IMPORT_RECENT_FOLDERS_KEY)
    key = os.path.normcase(str(path))
    recent = [str(path)] + [item for item in existing if os.path.normcase(item) != key]
    _set_path_setting(db, IMPORT_RECENT_FOLDERS_KEY, recent[:8])
    db.commit()


def import_browse_roots() -> list[dict[str, str]]:
    roots: list[dict[str, str]] = []
    seen: set[str] = set()

    def add_root(path: Path, name: str) -> None:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            return
        key = os.path.normcase(str(resolved))
        if key in seen or not resolved.is_dir():
            return
        seen.add(key)
        roots.append({"path": str(resolved), "name": name})

    add_root(Path.home(), "Home")
    if os.name == "nt":
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:\\")
            if drive.exists():
                add_root(drive, f"{letter}:")
    else:
        add_root(Path("/"), "/")
    return roots


def browse_import_directory(path: str | None = None, db: Session | None = None) -> dict:
    default_path = Path.home() / "Documents"
    requested = (
        Path(path).expanduser()
        if path
        else default_path if default_path.is_dir() else Path.home()
    )
    try:
        current = requested.resolve()
    except OSError as exc:
        raise HTTPException(400, f"Could not resolve directory: {exc}") from exc
    if not current.exists():
        raise HTTPException(404, f"Directory is missing: {current}")
    if not current.is_dir():
        raise HTTPException(400, f"Not a directory: {current}")

    entries: list[dict] = []
    try:
        with os.scandir(current) as scan:
            for entry in scan:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        kind = "folder"
                    elif entry.is_file(follow_symlinks=False) and import_filename_allowed(entry.name):
                        kind = "file"
                    else:
                        continue
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                entries.append(
                    {
                        "path": str(Path(entry.path).resolve()),
                        "name": entry.name,
                        "kind": kind,
                        "size": stat.st_size if kind == "file" else None,
                        "modified_at": datetime.fromtimestamp(
                            stat.st_mtime,
                            tz=timezone.utc,
                        ).isoformat(),
                    }
                )
    except PermissionError as exc:
        raise HTTPException(403, f"Directory cannot be opened: {current}") from exc
    except OSError as exc:
        raise HTTPException(422, f"Directory could not be read: {exc}") from exc

    entries.sort(key=lambda item: (item["kind"] != "folder", item["name"].casefold()))
    parent = current.parent
    if db is not None:
        remember_import_folder(db, current)
    return {
        "current_path": str(current),
        "parent_path": None if parent == current else str(parent),
        "roots": import_browse_roots(),
        "quick_access": import_quick_access(db) if db is not None else [],
        "entries": entries,
    }


def list_import_folder_files(root: Path) -> dict:
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    files: list[dict] = []

    root_path = str(root)
    root_name = root.name or str(root)

    def visit(directory: str, relative_directory: Path) -> None:
        directories: list[os.DirEntry[str]] = []
        filenames: list[os.DirEntry[str]] = []
        try:
            with os.scandir(directory) as scan:
                for entry in scan:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            directories.append(entry)
                        elif entry.is_file(follow_symlinks=False) and import_filename_allowed(entry.name):
                            filenames.append(entry)
                    except OSError:
                        continue
        except OSError:
            return

        for entry in sorted(filenames, key=lambda item: item.name.casefold()):
            try:
                stat = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            files.append(
                {
                    "path": entry.path,
                    "relative_path": (relative_directory / entry.name).as_posix(),
                    "filename": entry.name,
                    "size": stat.st_size,
                    "selection_root": {
                        "kind": "folder",
                        "path": root_path,
                        "label": root_name,
                    },
                }
            )

        for entry in sorted(directories, key=lambda item: item.name.casefold()):
            visit(entry.path, relative_directory / entry.name)

    visit(root_path, Path())
    return {
        "root_path": root_path,
        "root_name": root_name,
        "files": files,
    }


def _import_job_error(exc: Exception) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, str) and detail.strip():
        return detail
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        return detail["message"]
    return str(exc) or "Import operation failed"


def _create_import_scan_job(file_paths: list[str], folder_paths: list[str], token: str) -> int:
    root_items = []
    if file_paths:
        root_items.append({"id": "loose-files", "label": "Loose files"})
    root_items.extend(
        {"id": str(Path(path).expanduser()), "label": Path(path).name or str(path)}
        for path in folder_paths
    )
    return background_jobs.create_job(
        kind="import_scan",
        title="Discovering import sources",
        description="Scanning selected locations",
        total=len(root_items),
        token=token,
        items=root_items,
    )


def list_import_sources(
    file_paths: list[str],
    folder_paths: list[str],
    *,
    job_id: int | None = None,
) -> dict:
    files: list[dict] = []
    seen: set[str] = set()
    loose_paths = [Path(path).expanduser().resolve() for path in file_paths]
    discovered_files = 0
    total_bytes = 0
    for path in loose_paths:
        if job_id is not None:
            background_jobs.update_job(
                job_id,
                stage="scan",
                current_item_id="loose-files",
                current_item_label="Loose files",
            )
        if not path.is_file():
            raise HTTPException(404, f"File is missing: {path}")
        if not import_filename_allowed(path.name):
            raise HTTPException(400, f"Only .nda and .ndax files can be imported: {path.name}")
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        size = path.stat().st_size
        discovered_files += 1
        total_bytes += size
        files.append(
            {
                "path": str(path),
                "relative_path": path.name,
                "filename": path.name,
                "size": size,
                "selection_root": {
                    "kind": "file",
                    "path": str(path),
                    "label": "Loose files",
                },
            }
        )
    if job_id is not None and loose_paths:
        background_jobs.record_result(
            job_id,
            "loose-files",
            status="ready",
            detail=f"Discovered {discovered_files} file{'s' if discovered_files != 1 else ''}",
        )
        background_jobs.update_job(job_id, discovered_files=discovered_files, total_bytes=total_bytes)

    folder_results: list[tuple[Path, dict] | None] = [None] * len(folder_paths)
    folder_futures = {}
    with ThreadPoolExecutor(max_workers=min(2, max(1, len(folder_paths)))) as executor:
        for index, raw_folder in enumerate(folder_paths):
            folder = Path(raw_folder).expanduser().resolve()
            folder_futures[executor.submit(list_import_folder_files, folder)] = index
        for future in as_completed(folder_futures):
            index = folder_futures[future]
            folder = Path(folder_paths[index]).expanduser().resolve()
            listing = future.result()
            folder_results[index] = (folder, listing)
            if job_id is not None:
                root_count = len(listing["files"])
                background_jobs.record_result(
                    job_id,
                    str(folder),
                    status="ready",
                    detail=f"Discovered {root_count} file{'s' if root_count != 1 else ''}",
                )

    for result in folder_results:
        if result is None:
            continue
        folder, listing = result
        root_id = str(folder)
        root_discovered = 0
        root_bytes = 0
        for item in listing["files"]:
            path = Path(item["path"])
            key = os.path.normcase(str(path))
            if key in seen:
                continue
            seen.add(key)
            root_discovered += 1
            root_bytes += int(item["size"] or 0)
            files.append(
                {
                    **item,
                }
            )
        discovered_files += root_discovered
        total_bytes += root_bytes
        if job_id is not None:
            background_jobs.update_job(
                job_id,
                discovered_files=discovered_files,
                total_bytes=total_bytes,
            )
    return {
        "root_path": None,
        "root_name": "Selected sources",
        "files": files,
    }


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
    job_id = None
    if req.job_token:
        items = [
            {"id": path, "label": Path(path).name or path}
            for path in req.paths
        ]
        total_bytes = 0
        for path in req.paths:
            try:
                total_bytes += max(0, Path(path).stat().st_size)
            except OSError:
                pass
        job_id = background_jobs.create_job(
            kind="import_inspect",
            title="Inspecting import files",
            description="Checking identity and reading Neware metadata",
            total=len(req.paths),
            items=items,
            token=req.job_token,
        )
        background_jobs.update_job(
            job_id,
            stage="inspect",
            total_bytes=total_bytes,
            completed_bytes=0,
            phase="sampling",
            phase_current=0,
            phase_total=1,
            progress_percent=0.0,
            estimate_scope="total",
        )
    if not req.paths:
        if job_id is not None:
            background_jobs.update_job(
                job_id,
                status="completed",
                completed=0,
                phase="completed",
                progress_percent=100.0,
            )
        return {"files": []}
    previews = []
    completed_bytes = 0
    completion_lock = threading.Lock()
    completed_inspections = 0
    try:
        match_snapshot = import_inspection.build_identity_snapshot(db)

        def report_completed(path_string: str) -> None:
            nonlocal completed_inspections
            if job_id is not None:
                with completion_lock:
                    completed_inspections += 1
                    completed = completed_inspections
                background_jobs.update_job(
                    job_id,
                    stage="inspect",
                    current_item_id=path_string,
                    current_item_label=Path(path_string).name or path_string,
                    completed=completed,
                )

        def report_phase(event: dict) -> None:
            if job_id is None:
                return
            values = {
                key: value
                for key, value in event.items()
                if key in {
                    "phase",
                    "phase_current",
                    "phase_total",
                    "completed_count",
                    "current_item_id",
                    "current_item_label",
                    "phase_detail",
                    "progress_percent",
                    "strategy",
                    "worker_count",
                    "sample_duration_seconds",
                    "estimated_total_seconds",
                    "estimate_scope",
                }
            }
            if "completed_count" in values:
                values["completed"] = values.pop("completed_count")
            background_jobs.update_job(job_id, **values)

        inspections = import_inspection.inspect_files(
            req.paths,
            on_completed=report_completed,
            on_phase=report_phase,
        )
        if job_id is not None:
            background_jobs.update_job(
                job_id,
                phase="finalizing",
                phase_current=0,
                phase_total=len(inspections),
                phase_detail="Matching inspected identity and building the import review",
                current_item_id=None,
                current_item_label="Combining inspected identity and metadata",
                completed=len(inspections),
                progress_percent=90.0,
            )
        for index, inspected in enumerate(inspections):
            path_string = inspected.path
            path = Path(path_string)
            preview = _inspect_import_path(
                path,
                db,
                inspected=inspected,
                match_snapshot=match_snapshot,
            )
            previews.append(preview)
            completed_bytes += max(0, int(preview.get("size") or 0))
            if job_id is not None:
                background_jobs.update_item(
                    job_id,
                    path_string,
                    status="ready",
                    detail="Identity and Neware metadata ready",
                )
                background_jobs.update_job(
                    job_id,
                    completed_bytes=completed_bytes,
                    phase="finalizing",
                    phase_current=index + 1,
                    phase_total=len(inspections),
                    phase_detail="Matching inspected identity and building the import review",
                    current_item_id=path_string,
                    current_item_label=path.name or path_string,
                    progress_percent=90.0 + (9.0 * (index + 1) / max(1, len(inspections))),
                )
        if job_id is not None:
            background_jobs.update_job(
                job_id,
                status="completed",
                phase="completed",
                phase_current=len(inspections),
                phase_total=len(inspections),
                phase_detail="Import review ready",
                progress_percent=100.0,
            )
        return {"files": previews}
    except Exception as exc:
        if job_id is not None:
            background_jobs.update_job(job_id, status="failed", error=_import_job_error(exc))
        raise


def _continuation_existing_source(
    link: TestFile,
    *,
    existing_test_id: int,
    input_order: int | None = None,
) -> dict:
    sf = link.file
    header_meta = sf.header_meta or {}
    nominal = sf.nominal_capacity_mah
    source = {
        "key": f"existing-{sf.id}",
        "kind": "existing",
        "source_file_id": sf.id,
        "filename": sf.filename,
        "source_path": sf.path,
        "hash": sf.hash,
        "input_order": link.position if input_order is None else input_order,
        "existing_test_id": existing_test_id,
        "linked_test_id": link.test_id,
        "path_refresh_candidate": False,
        "unsupported_extension": False,
        "missing": sf.location_status == "offline",
        "unreadable": False,
        "changing": sf.location_status == "changing",
        "inspection_status": "pending",
        "start_time": sf.start_time,
        "device_info": sf.device_info,
        "channel": sf.channel,
        "barcode": sf.barcode,
        "remarks": sf.remarks,
        "nominal_capacity_mah": nominal,
        "active_mass_mg": sf.active_mass_mg,
        "protocol_signature": continuations.header_fields_from_metadata(
            {"raw": header_meta, "nominal_capacity_mah": nominal}
        ).get("protocol_signature"),
        "local_cycle_start": None,
        "local_cycle_end": None,
        "local_cycle_count": sf.cycle_count,
        "end_time": None,
        "location_status": sf.location_status,
        "parse_status": sf.parse_status,
        "row_count": sf.row_count,
    }
    return continuations.enrich_source_timing(source, source_path=Path(sf.path) if sf.path else None)


def _continuation_staged_source(
    draft: ContinuationInspectSourceRequest,
    db: Session,
    *,
    existing_test_id: int | None,
    input_order: int,
) -> dict:
    filename = _clean_filename(Path(draft.source_path or draft.staged_name).name)
    unsupported = not import_filename_allowed(filename)
    source = {
        "key": draft.staged_name,
        "kind": "staged",
        "source_file_id": None,
        "filename": filename,
        "hash": None,
        "input_order": input_order,
        "existing_test_id": existing_test_id,
        "linked_test_id": None,
        "path_refresh_candidate": False,
        "unsupported_extension": unsupported,
        "missing": False,
        "unreadable": False,
        "changing": False,
        "inspection_status": "pending",
        "start_time": None,
        "end_time": None,
        "local_cycle_start": None,
        "local_cycle_end": None,
        "local_cycle_count": None,
        "protocol_signature": None,
        "device_info": None,
        "channel": None,
        "nominal_capacity_mah": None,
        "active_mass_mg": None,
    }
    if unsupported:
        source["inspection_status"] = "error"
        return source

    try:
        source_path = resolve_import_source_path(draft.staged_name, draft.source_path)
    except ValueError as exc:
        source["inspection_status"] = "error"
        source["inspection_error"] = str(exc)
        source["unreadable"] = True
        source["unreadable_message"] = str(exc)
        return source

    integrity = continuations.inspect_path_integrity(source_path)
    source["missing"] = integrity["missing"]
    source["unreadable"] = integrity["unreadable"]
    source["changing"] = integrity["changing"]
    if integrity["message"]:
        source["unreadable_message"] = integrity["message"]
    if integrity["missing"] or integrity["unreadable"] or integrity["changing"]:
        source["inspection_status"] = "error" if integrity["unreadable"] else "pending"
        if integrity.get("hash"):
            source["hash"] = integrity["hash"]
        return source

    file_hash = integrity["hash"]
    if not file_hash:
        source["inspection_status"] = "error"
        source["inspection_error"] = "Could not establish source identity"
        source["unreadable"] = True
        return source

    try:
        source_stat = source_path.stat()
    except OSError:
        source_stat = None
    hint = draft.inspection
    hint_is_valid = (
        isinstance(hint, dict)
        and hint.get("hash") == file_hash
        and source_stat is not None
        and hint.get("size") == source_stat.st_size
        and _mtime_fingerprint_matches(hint.get("mtime_ns"), source_stat.st_mtime_ns)
    )
    meta = (
        import_inspection.cached_header_metadata(file_hash, source_stat.st_size, source_stat.st_mtime_ns)
        if hint_is_valid and source_stat is not None
        else None
    )
    if meta is None:
        meta = hint.get("header_metadata") if (
            hint_is_valid and isinstance(hint, dict) and isinstance(hint.get("header_metadata"), dict)
        ) else parsing.read_header_metadata(source_path)
    header_fields = continuations.header_fields_from_metadata(meta)
    source.update(header_fields)
    source["hash"] = file_hash

    existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing is not None:
        source["source_file_id"] = existing.id
        link = existing.test_link
        source["linked_test_id"] = link.test_id if link is not None else None
        if link is None and existing.path != str(source_path):
            source["path_refresh_candidate"] = True
        if existing.location_status == "changing":
            source["changing"] = True
            source["inspection_status"] = "error"
            return source

    if meta.get("error"):
        source["inspection_error"] = meta["error"]

    return continuations.enrich_source_timing(source, source_path=source_path)


def _ordered_continuation_sources(
    req: ContinuationInspectRequest,
    db: Session,
) -> tuple[list[dict], list[str]]:
    existing_sources: list[dict] = []
    if req.existing_test_id is not None:
        test = db.get(Test, req.existing_test_id)
        if test is None:
            raise HTTPException(404, "Existing test is missing")
        existing_sources = [
            _continuation_existing_source(link, existing_test_id=test.id)
            for link in sorted(test.file_links, key=lambda item: item.position)
        ]

    staged_sources: list[dict] = []
    staged_keys: list[str] = []
    for index, draft in enumerate(req.sources):
        staged_keys.append(draft.staged_name)
    try:
        continuations.validate_staged_keys(staged_keys)
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)

    for index, draft in enumerate(req.sources):
        staged_sources.append(
            _continuation_staged_source(
                draft,
                db,
                existing_test_id=req.existing_test_id,
                input_order=index,
            )
        )

    if req.proposed_order is not None:
        existing_by_key = {source["key"]: source for source in existing_sources}
        if existing_by_key and set(req.proposed_order) == set(existing_by_key):
            existing_sources = [existing_by_key[key] for key in req.proposed_order]

    staged_by_key = {source["key"]: source for source in staged_sources}
    if req.proposed_order is not None and set(req.proposed_order) == set(staged_keys):
        ordered_staged = [staged_by_key[key] for key in req.proposed_order]
    else:
        ordered_staged = staged_sources

    return existing_sources + ordered_staged, staged_keys


def _raise_continuation_validation(exc: continuations.ContinuationValidationError) -> None:
    raise HTTPException(exc.status_code, exc.payload) from exc


def _inspect_cell_draft_chain(
    draft: ImportCellDraft,
    db: Session,
    *,
    existing_test_id: int | None = None,
) -> dict:
    sources = normalize_import_cell_sources(draft)
    inspect_req = ContinuationInspectRequest(
        sources=[
            ContinuationInspectSourceRequest(
                staged_name=source.staged_name,
                source_path=source.source_path,
                inspection=source.inspection,
            )
            for source in sources
        ],
        existing_test_id=existing_test_id,
        proposed_order=None,
    )
    ordered_sources, staged_keys = _ordered_continuation_sources(inspect_req, db)
    return continuations.analyze_continuation_chain(
        ordered_sources,
        staged_keys=staged_keys,
    )


def _test_sources_payload(test: Test) -> list[dict]:
    return [
        {
            "file_id": link.file_id,
            "position": link.position,
            "filename": link.file.filename,
            "hash_prefix": continuations.hash_prefix(link.file.hash),
        }
        for link in sorted(test.file_links, key=lambda item: item.position)
    ]


def _lifecycle_mutation_response(
    test: Test,
    cell: Cell,
    *,
    invalidated: dict,
    cache_jobs: dict | None = None,
) -> dict:
    return {
        "cell": {"id": cell.id, "name": cell.name},
        "test": {
            "id": test.id,
            "name": test.name,
            "sources": _test_sources_payload(test),
        },
        "tracked_source_id": analysis_usage.tracked_source_file_id(cell),
        "invalidated_analysis_ids": invalidated.get("analysis_ids", []),
        "queued_warmup_plots": invalidated.get("queued_plots", 0),
        "cache_jobs": cache_jobs or {},
    }


def _source_identity_snapshot_or_error(
    source_path: Path,
    *,
    expected_hash: str | None,
    previous_hash: str | None = None,
) -> str:
    integrity = continuations.inspect_path_integrity(source_path)
    if integrity.get("missing") or integrity.get("unreadable") or integrity.get("changing"):
        raise HTTPException(
            409,
            {
                "code": "source_identity_unstable",
                "message": "The source changed or became unavailable during submission; inspect again.",
                "filename": source_path.name,
            },
        )
    current_hash = integrity.get("hash")
    if not current_hash or (expected_hash and current_hash != expected_hash):
        raise HTTPException(
            409,
            {
                "code": "source_identity_changed",
                "message": "The source bytes differ from the inspected source; inspect again.",
                "filename": source_path.name,
                "expected_hash_prefix": continuations.hash_prefix(expected_hash),
                "actual_hash_prefix": continuations.hash_prefix(current_hash),
            },
        )
    if previous_hash and current_hash != previous_hash:
        raise HTTPException(
            409,
            {
                "code": "source_identity_changed",
                "message": "The source changed during final registration; inspect again.",
                "filename": source_path.name,
                "expected_hash_prefix": continuations.hash_prefix(previous_hash),
                "actual_hash_prefix": continuations.hash_prefix(current_hash),
            },
        )
    return current_hash


def _validate_staged_source_snapshots(
    source_drafts: list[ImportSourceDraft | ContinuationInspectSourceRequest],
    inspected_hashes_by_staged_name: dict[str, str],
) -> None:
    for source_draft in source_drafts:
        try:
            source_path = resolve_import_source_path(
                source_draft.staged_name,
                source_draft.source_path,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        expected_hash = inspected_hashes_by_staged_name.get(source_draft.staged_name)
        if not expected_hash:
            raise HTTPException(
                409,
                {
                    "code": "source_identity_unavailable",
                    "message": "The source has no stable inspected identity; inspect again.",
                    "filename": source_path.name,
                },
            )
        _source_identity_snapshot_or_error(source_path, expected_hash=expected_hash)


def _prepare_import_source_file(
    db: Session,
    *,
    source_path: Path,
    filename: str,
    expected_hash: str | None = None,
    inspection: dict | None = None,
) -> dict:
    """Prepare immutable source facts before the relational write transaction."""
    if not source_path.exists():
        raise HTTPException(404, f"Source file is missing: {filename}")
    try:
        source_stat = source_path.stat()
    except OSError as exc:
        raise HTTPException(409, f"Source became unavailable: {filename}") from exc

    inspection = inspection if isinstance(inspection, dict) else {}
    expected_hash = (expected_hash or inspection.get("hash") or "").strip().lower() or None
    fingerprint_matches = bool(
        expected_hash
        and inspection.get("size") == source_stat.st_size
        and _mtime_fingerprint_matches(inspection.get("mtime_ns"), source_stat.st_mtime_ns)
    )
    if fingerprint_matches:
        file_hash = expected_hash
    else:
        file_hash = parsing.compute_hash(source_path).lower()
        if expected_hash and file_hash != expected_hash:
            raise HTTPException(
                409,
                {
                    "code": "source_identity_changed",
                    "message": "The source bytes differ from the inspected source; inspect again.",
                    "filename": source_path.name,
                    "expected_hash_prefix": continuations.hash_prefix(expected_hash),
                    "actual_hash_prefix": continuations.hash_prefix(file_hash),
                },
            )
        try:
            after_hash_stat = source_path.stat()
        except OSError as exc:
            raise HTTPException(409, f"Source became unavailable: {filename}") from exc
        if (
            after_hash_stat.st_size != source_stat.st_size
            or after_hash_stat.st_mtime_ns != source_stat.st_mtime_ns
        ):
            raise HTTPException(
                409,
                {
                    "code": "source_identity_unstable",
                    "message": "The source changed during submission; inspect again.",
                    "filename": source_path.name,
                },
            )

    meta = (
        inspection.get("header_metadata")
        if fingerprint_matches and isinstance(inspection.get("header_metadata"), dict)
        else import_inspection.cached_header_metadata(
            file_hash,
            source_stat.st_size,
            source_stat.st_mtime_ns,
        )
    )
    if not isinstance(meta, dict):
        meta = parsing.read_header_metadata(source_path)

    existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing is not None and existing.test_link is not None:
        if not existing.test_link.test.cell.archived:
            raise HTTPException(409, f"{filename} is already registered")

    cache_ready = bool(
        existing is not None
        and existing.parse_status == "parsed"
        and existing.parser_version == parsing.PARSER_VERSION
        and existing.row_count is not None
        and existing.cycle_count is not None
        and existing.capacity_summary_status == "ready"
        and cache.has_cycles(existing.hash, existing.parser_version, CALC_VERSION)
    )
    return {
        "source_path": source_path,
        "filename": filename,
        "hash": file_hash,
        "size": source_stat.st_size,
        "observed_mtime_ns": source_stat.st_mtime_ns,
        "ext": Path(filename).suffix.lower().lstrip("."),
        "meta": meta,
        "existing_source_file_id": existing.id if existing is not None else None,
        "cache_ready": cache_ready,
    }


def _persist_prepared_import_source_file(db: Session, prepared: dict) -> SourceFile:
    """Persist Stage-A source facts without opening or parsing the source."""
    existing = (
        db.get(SourceFile, prepared["existing_source_file_id"])
        if prepared.get("existing_source_file_id") is not None
        else None
    )
    if existing is not None and existing.test_link is not None:
        remove_archived_cell_blocking_source(db, existing)
        db.flush()
        existing = db.query(SourceFile).filter(SourceFile.hash == prepared["hash"]).first()
    if existing is not None and existing.test_link is not None:
        raise HTTPException(409, f"{prepared['filename']} is already registered")

    meta = prepared["meta"]
    values = {
        "hash": prepared["hash"],
        "path": str(prepared["source_path"]),
        "filename": prepared["filename"],
        "size": prepared["size"],
        "ext": prepared["ext"],
        "observed_size": prepared["size"],
        "observed_mtime_ns": prepared["observed_mtime_ns"],
        "last_source_check_at": datetime.now(timezone.utc),
        "nda_version": meta.get("nda_version"),
        "device_info": meta.get("device_info"),
        "channel": meta.get("channel"),
        "barcode": meta.get("barcode"),
        "remarks": meta.get("remarks"),
        "start_time": meta.get("start_time"),
        "active_mass_mg": meta.get("active_mass_mg"),
        "nominal_capacity_mah": meta.get("nominal_capacity_mah"),
        "header_meta": meta.get("raw") or None,
        "location_status": "online",
    }
    if existing is None:
        sf = SourceFile(
            **values,
            parse_status="parsed" if prepared["cache_ready"] else "parsing",
            capacity_summary_status="ready" if prepared["cache_ready"] else "pending",
        )
        db.add(sf)
        db.flush()
        return sf

    for key, value in values.items():
        setattr(existing, key, value)
    if not prepared["cache_ready"]:
        existing.parse_status = "parsing"
        existing.parse_error = None
        existing.capacity_summary_status = "pending"
    return existing


def _register_or_refresh_source_file(
    db: Session,
    *,
    source_path: Path,
    filename: str,
    expected_hash: str | None = None,
    inspection: dict | None = None,
) -> SourceFile:
    if not source_path.exists():
        raise HTTPException(404, f"Source file is missing: {filename}")

    file_hash = _source_identity_snapshot_or_error(
        source_path,
        expected_hash=expected_hash,
    )
    existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing is not None:
        remove_archived_cell_blocking_source(db, existing)
        db.flush()
        existing = db.query(SourceFile).filter(SourceFile.hash == file_hash).first()
    if existing is not None and existing.test_link is not None:
        raise HTTPException(409, f"{filename} is already registered")

    try:
        source_stat = source_path.stat()
    except OSError as exc:
        raise HTTPException(409, f"Source became unavailable: {filename}") from exc
    hint_fingerprint_matches = (
        isinstance(inspection, dict)
        and inspection.get("hash") == file_hash
        and inspection.get("size") == source_stat.st_size
        and _mtime_fingerprint_matches(inspection.get("mtime_ns"), source_stat.st_mtime_ns)
    )
    meta = (
        import_inspection.cached_header_metadata(file_hash, source_stat.st_size, source_stat.st_mtime_ns)
        if hint_fingerprint_matches
        else None
    )
    if meta is None:
        meta = inspection.get("header_metadata") if (
            hint_fingerprint_matches
            and isinstance(inspection, dict)
            and isinstance(inspection.get("header_metadata"), dict)
        ) else parsing.read_header_metadata(source_path)
    file_hash = _source_identity_snapshot_or_error(source_path, expected_hash=expected_hash, previous_hash=file_hash)
    if existing is None:
        sf = SourceFile(
            hash=file_hash,
            path=str(source_path),
            filename=filename,
            size=source_stat.st_size,
            ext=Path(filename).suffix.lower().lstrip("."),
            observed_size=source_stat.st_size,
            observed_mtime_ns=source_stat.st_mtime_ns,
            last_source_check_at=datetime.now(timezone.utc),
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
        db.flush()
        return sf

    sf = existing
    sf.path = str(source_path)
    sf.filename = filename
    sf.size = source_stat.st_size
    sf.ext = Path(filename).suffix.lower().lstrip(".")
    sf.observed_size = source_stat.st_size
    sf.observed_mtime_ns = source_stat.st_mtime_ns
    sf.last_source_check_at = datetime.now(timezone.utc)
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
    return sf


def _record_source_lifecycle_activity(
    db: Session,
    *,
    action: str,
    message: str,
    cell: Cell,
    test: Test,
    details: dict,
) -> None:
    record_activity(
        db,
        category="source",
        action=action,
        message=message,
        entity_type="cell",
        entity_id=cell.id,
        details={
            **details,
            "cell_id": cell.id,
            "test_id": test.id,
            "source_order": _test_sources_payload(test),
        },
    )


def _post_commit_source_invalidation(
    db: Session,
    cell: Cell,
    *,
    reason: str,
    source_id: int | None = None,
    queue_warmup: bool = True,
) -> dict:
    invalidated = cache_maintenance.invalidate_cell_dependents(
        db,
        cell.id,
        source_id=source_id,
        reason=reason,
        queue_warmup=queue_warmup,
    )
    db.commit()
    return invalidated


@router.post("/imports/continuations/inspect")
def inspect_continuation_sources(req: ContinuationInspectRequest, db: Session = Depends(get_db)):
    if not req.sources and req.existing_test_id is None:
        raise HTTPException(400, "At least one source is required")
    ordered_sources, staged_keys = _ordered_continuation_sources(req, db)
    return continuations.analyze_continuation_chain(
        ordered_sources,
        staged_keys=staged_keys,
        proposed_staged_order=req.proposed_order,
    )


@router.post("/cells/{cell_id}/continuations/inspect")
def inspect_cell_continuation_sources(
    cell_id: int,
    req: ContinuationInspectRequest,
    db: Session = Depends(get_db),
):
    """Inspect the one Cell-level source chain used by lifecycle mutations."""
    _cell, test = _load_cell_single_test_or_404(db, cell_id)
    current_file_ids = analysis_usage.ordered_test_file_ids(test)
    if req.sources:
        return _inspect_test_chain(db, test, req.sources, proposed_file_ids=current_file_ids)

    proposed_file_ids = current_file_ids
    if req.proposed_order is not None:
        expected_keys = {f"existing-{file_id}" for file_id in current_file_ids}
        if set(req.proposed_order) != expected_keys or len(req.proposed_order) != len(expected_keys):
            raise HTTPException(409, "The Cell source order must contain every source exactly once.")
        try:
            proposed_file_ids = [int(key.removeprefix("existing-")) for key in req.proposed_order]
        except ValueError as exc:
            raise HTTPException(409, "The Cell source order contains an invalid source key.") from exc
    return _inspect_existing_order(db, test, proposed_file_ids)


@router.post("/imports/list-sources")
def list_import_source_paths(req: ImportSourceListRequest):
    job_id = (
        _create_import_scan_job(req.file_paths, req.folder_paths, req.job_token)
        if req.job_token
        else None
    )
    try:
        result = list_import_sources(req.file_paths, req.folder_paths, job_id=job_id)
        if job_id is not None:
            background_jobs.update_job(job_id, status="completed", completed=background_jobs.get_job(job_id)["total"])
        return result
    except Exception as exc:
        if job_id is not None:
            background_jobs.update_job(job_id, status="failed", error=_import_job_error(exc))
        raise


@router.post("/imports/browse")
def browse_import_source_paths(req: ImportBrowseRequest, db: Session = Depends(get_db)):
    return browse_import_directory(req.path, db)


@router.get("/imports/quick-access")
def get_import_quick_access(db: Session = Depends(get_db)):
    return {"items": import_quick_access(db)}


@router.put("/imports/quick-access/pinned")
def update_import_pinned_folders(
    req: ImportPinnedFoldersRequest,
    db: Session = Depends(get_db),
):
    paths = _normalized_unique_paths(req.paths)
    _set_path_setting(db, IMPORT_PINNED_FOLDERS_KEY, paths)
    db.commit()
    return {"items": import_quick_access(db)}


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


@router.post("/imports/pick-folder")
def pick_import_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise HTTPException(500, f"Native folder picker is not available: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(title="Select a folder containing Neware cell files")
    finally:
        root.destroy()
    if not selected:
        return {"root_path": None, "root_name": None, "files": []}
    return list_import_folder_files(Path(selected))


@router.post("/imports/preview")
def preview_import_file(req: ImportPreviewRequest):
    try:
        source_path = resolve_import_source_path(req.staged_name, req.source_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(404, "Source file is missing")
    try:
        source_stat = source_path.stat()
    except OSError as exc:
        raise HTTPException(404, "Source file is unavailable") from exc

    expected_hash = (req.expected_hash or "").strip().lower() or None
    fingerprint_matches = (
        expected_hash is not None
        and req.expected_size is not None
        and req.expected_mtime_ns is not None
        and req.expected_size == source_stat.st_size
        and _mtime_fingerprint_matches(req.expected_mtime_ns, source_stat.st_mtime_ns)
    )
    if fingerprint_matches:
        verified_hash = expected_hash
    else:
        verified_hash = parsing.compute_hash(source_path).lower()
        if expected_hash is not None and verified_hash != expected_hash:
            raise HTTPException(
                409,
                {
                    "code": "source_changed",
                    "message": "The source changed after inspection; inspect it again before previewing.",
                    "filename": source_path.name,
                    "expected_hash_prefix": expected_hash[:12],
                    "actual_hash_prefix": verified_hash[:12],
                },
            )

    capacity_preview, preview_error = build_capacity_preview(
        source_path,
        file_hash=verified_hash,
    )
    return {
        "capacity_preview": capacity_preview,
        "preview_error": preview_error,
        "verified_hash": verified_hash,
    }


@router.post("/imports/raw-data")
def raw_import_file_data(req: ImportRawDataRequest):
    try:
        source_path = resolve_import_source_path(req.staged_name, req.source_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, "Source file is missing")
    try:
        # served from the hash-keyed raw cache; the parse happens at most
        # once per file content, not once per page view
        file_hash = parsing.compute_hash(source_path)
        cache.build(file_hash, source_path)
        raw = cache.load_raw(file_hash, parsing.PARSER_VERSION)
        if raw is None:
            raise RuntimeError("raw cache could not be built")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, f"Raw data could not be loaded: {exc}") from exc
    return raw_table_from_frame(raw, offset=req.offset, limit=req.limit)


def _create_imported_cells_impl(
    req: ImportCellsRequest,
    db: Session,
    *,
    job_id: int | None = None,
):
    try:
        return _create_imported_cells_impl_raw(req, db, job_id=job_id)
    except IntegrityError as exc:
        raise _translate_import_integrity_error(req, db, exc) from exc


def _create_imported_cells_impl_raw(
    req: ImportCellsRequest,
    db: Session,
    *,
    job_id: int | None = None,
):
    if not req.cells:
        raise HTTPException(400, "No files selected")
    _validate_import_cell_names(req, db)
    all_staged_keys = [
        source.staged_name
        for draft in req.cells
        for source in normalize_import_cell_sources(draft)
    ]
    try:
        continuations.validate_staged_keys(all_staged_keys)
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)
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
                staged_names=[import_cell_replicate_key(cell) for cell in req.cells],
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
    inspected_hashes_by_staged_name: dict[str, str] = {}
    continuation_drafts = [
        draft
        for draft in req.cells
        if len(normalize_import_cell_sources(draft)) > 1
        or bool(draft.acknowledged_finding_ids)
    ]
    continuation_draft_ids = {id(draft) for draft in continuation_drafts}

    for draft_index, draft in enumerate(req.cells):
        if id(draft) not in continuation_draft_ids:
            # Separate-cell registration needs only source identity, header
            # metadata and relational validation.  Continuation analysis is
            # the path that may schedule timing/cache work, so keep it out of
            # the pre-commit separate-cell path.
            continue
        if job_id is not None:
            sources = normalize_import_cell_sources(draft)
            background_jobs.update_job(
                job_id,
                stage="register",
                phase="validation",
                phase_current=draft_index + 1,
                phase_total=len(req.cells),
                phase_detail="Checking continuation compatibility",
                current_item_id=str(draft_index),
                current_item_label=draft.cell_name.strip() or sources[0].filename,
            )
        normalize_import_cell_sources(draft)
        analysis = _inspect_cell_draft_chain(draft, db)
        for source in analysis.get("sources") or []:
            if source.get("kind") == "staged" and source.get("hash"):
                inspected_hashes_by_staged_name[source["key"]] = source["hash"]
        try:
            continuations.ensure_submittable_chain(
                analysis,
                draft.acknowledged_finding_ids,
            )
        except continuations.ContinuationValidationError as exc:
            _raise_continuation_validation(exc)

    # Stage A: resolve and verify every source while the session is still
    # read-only. Hashing and header extraction belong here, never between the
    # first relational INSERT and the final commit.
    prepared_sources_by_staged_name: dict[str, dict] = {}
    for draft_index, draft in enumerate(req.cells):
        if job_id is not None:
            sources = normalize_import_cell_sources(draft)
            background_jobs.update_job(
                job_id,
                stage="register",
                phase="validation",
                phase_current=draft_index + 1,
                phase_total=len(req.cells),
                phase_detail="Checking source identity and import constraints",
                current_item_id=str(draft_index),
                current_item_label=draft.cell_name.strip() or sources[0].filename,
            )
        for source_draft in normalize_import_cell_sources(draft):
            try:
                source_path = resolve_import_source_path(
                    source_draft.staged_name,
                    source_draft.source_path,
                )
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            inspection = source_draft.inspection if isinstance(source_draft.inspection, dict) else {}
            prepared_sources_by_staged_name[source_draft.staged_name] = _prepare_import_source_file(
                db,
                source_path=source_path,
                filename=source_draft.filename,
                expected_hash=inspected_hashes_by_staged_name.get(source_draft.staged_name),
                inspection=inspection,
            )

    # End the read transaction before Stage B starts. The prepared dictionaries
    # contain only immutable source facts and database ids, so no ORM object
    # from the validation phase is carried into the write transaction.
    db.rollback()

    for draft_index, draft in enumerate(req.cells):
        if job_id is not None:
            sources = normalize_import_cell_sources(draft)
            background_jobs.update_job(
                job_id,
                stage="register",
                phase="registration",
                phase_current=draft_index + 1,
                phase_total=len(req.cells),
                phase_detail="Preparing relational Cell registration",
                current_item_id=str(draft_index),
                current_item_label=draft.cell_name.strip() or sources[0].filename,
            )
        sources = normalize_import_cell_sources(draft)
        replicate_key = import_cell_replicate_key(draft)

        cell = Cell(name=draft.cell_name.strip(), description=(draft.description or "").strip() or None)
        db.add(cell)
        db.flush()

        # Test is an internal compatibility container.  Continued import never
        # accepts or derives a user-facing Test name and always creates exactly
        # one row for the newly created Cell.
        test = Test(cell_id=cell.id, name="Imported file")
        db.add(test)
        db.flush()

        created_source_ids: list[int] = []
        for position, source_draft in enumerate(sources):
            prepared_source = prepared_sources_by_staged_name[source_draft.staged_name]
            sf = _persist_prepared_import_source_file(db, prepared_source)
            if position == 0:
                imported_metadata = full_cell_metadata_from_header(
                    prepared_source["meta"],
                    draft.metadata,
                )
                override_values = {
                    "override.active_mass_mg": draft.active_mass_mg_override,
                    "override.nominal_capacity_mah": draft.nominal_capacity_mah_override,
                    "override.electrode_area_cm2": draft.electrode_area_cm2_override,
                    "override.active_material_specific_capacity_mah_g":
                        draft.active_material_specific_capacity_mah_g,
                }
                for key, value in override_values.items():
                    if value is not None:
                        if value <= 0:
                            raise HTTPException(422, f"{key} must be positive")
                        imported_metadata[key] = str(float(value))
                text_overrides = {
                    "override.active_material_preset_id": draft.active_material_preset_id,
                    "override.active_material_name": draft.active_material_name,
                    "override.electrode_area_preset_id": draft.electrode_area_preset_id,
                    "override.electrode_area_preset_name": draft.electrode_area_preset_name,
                }
                for key, value in text_overrides.items():
                    text = (value or "").strip()
                    if text:
                        imported_metadata[key] = text
                for key, value in imported_metadata.items():
                    k = key.strip()
                    v = str(value).strip()
                    if k and v:
                        db.add(CellMetadata(cell_id=cell.id, key=k, value=v))

            db.add(TestFile(test_id=test.id, file_id=sf.id, position=position))
            db.flush()
            source_file_ids_by_staged_name[source_draft.staged_name] = sf.id
            if not prepared_source["cache_ready"]:
                cache_jobs.append(
                    {
                        "staged_name": source_draft.staged_name,
                        "hash": prepared_source["hash"],
                        "path": str(prepared_source["source_path"]),
                    }
                )
            created_source_ids.append(sf.id)

        if replicate_key not in grouped_staged_names:
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

        created.append(
            {
                "cell_id": cell.id,
                "cell_name": cell.name,
                "source_file_ids": created_source_ids,
                "file_id": created_source_ids[0] if created_source_ids else None,
                "filename": sources[0].filename,
                "sources": _test_sources_payload(test),
            }
        )
        created_cell_ids.append(cell.id)
        cell_ids_by_staged_name[replicate_key] = cell.id

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
    record_activity(
        db,
        category="import",
        action="import_cells",
        message=(
            f"Imported {len(created_cell_ids)} cells"
            + (f" and {len(replicate_groups)} replicate groups" if replicate_groups else "")
        ),
        details={
            "cell_ids": created_cell_ids,
            "source_file_ids": list(source_file_ids_by_staged_name.values()),
            "replicate_group_ids": [group["id"] for group in replicate_groups],
            "folder_ids": target_folder_ids,
            "parsing_started": bool(cache_jobs),
        },
    )
    db.commit()
    if job_id is not None:
        for draft_index in range(len(req.cells)):
            background_jobs.record_result(
                job_id,
                str(draft_index),
                status="ready",
                detail="Cell registration committed",
            )
        background_jobs.update_job(
            job_id,
            phase="completed",
            phase_current=len(req.cells),
            phase_total=len(req.cells),
            phase_detail="Relational registration committed; scientific preparation continues separately",
            stage="register",
            status="completed",
            description="Cell registration committed",
        )
    cache_handoff = start_import_cache_jobs(source_file_ids_by_staged_name, cache_jobs)
    return {
        "created": created,
        "replicate_group": replicate_groups[0] if len(replicate_groups) == 1 else None,
        "replicate_groups": replicate_groups,
        "parsing_started": bool(cache_jobs),
        "cache_jobs": cache_handoff,
    }


def _import_submission_response(
    submission: ImportSubmission,
    *,
    fallback_status: str | None = None,
) -> dict:
    live_job = background_jobs.get_job(submission.job_id) if submission.job_id is not None else None
    return {
        "accepted": True,
        "job_id": submission.job_id,
        "job_token": submission.token,
        "submitted_cells": submission.submitted_cells,
        "submitted_sources": submission.submitted_sources,
        "status": (live_job or {}).get("status") or submission.status or fallback_status or "accepted",
    }


def run_import_registration_job(
    req: ImportCellsRequest,
    background_job_id: int,
    submission_id: int | None = None,
) -> None:
    """Register an accepted import outside the request thread.

    The request payload is already copied before this worker is started. The
    worker owns its SQLAlchemy session and rolls it back on every pre-commit
    failure, while the cache handoff remains post-commit work.
    """
    db: Session | None = None
    try:
        apply_background_thread_priority()
        db = SessionLocal()
        record_activity(
            db,
            category="import",
            action="import_registration_started",
            message=f"Registering {len(req.cells)} imported cells",
            details={
                "background_job_id": background_job_id,
                "submitted_cells": len(req.cells),
            },
        )
        if submission_id is not None:
            submission = db.get(ImportSubmission, submission_id)
            if submission is not None:
                submission.status = "running"
                submission.started_at = datetime.now(timezone.utc)
        db.commit()
        result = _create_imported_cells_impl(req, db, job_id=background_job_id)
        record_activity(
            db,
            category="import",
            action="import_registration_completed",
            message=f"Registered {len(result.get('created', []))} imported cells",
            details={
                "background_job_id": background_job_id,
                "cell_ids": [item["cell_id"] for item in result.get("created", [])],
            },
        )
        if submission_id is not None:
            submission = db.get(ImportSubmission, submission_id)
            if submission is not None:
                submission.status = "completed"
                submission.error = None
                submission.finished_at = datetime.now(timezone.utc)
        db.commit()
        background_jobs.update_job(
            background_job_id,
            status="completed",
            description=(
                f"Imported {len(result.get('created', []))} cells; "
                "scientific preparation continues separately"
                if result.get("parsing_started")
                else f"Imported {len(result.get('created', []))} cells"
            ),
        )
    except Exception as exc:
        if isinstance(exc, IntegrityError) and db is not None:
            failure = _translate_import_integrity_error(req, db, exc)
        else:
            failure = exc
        failure_detail = getattr(failure, "detail", None)
        if db is not None and failure is exc:
            db.rollback()
        try:
            if submission_id is not None and db is not None:
                submission = db.get(ImportSubmission, submission_id)
                if submission is not None:
                    submission.status = "failed"
                    submission.error = _import_job_error(failure)
                    submission.finished_at = datetime.now(timezone.utc)
            if db is not None:
                record_activity(
                    db,
                    category="import",
                    action="import_registration_failed",
                    message="Imported Cell registration failed",
                    severity="error",
                    details={
                        "background_job_id": background_job_id,
                        "error": _import_job_error(failure),
                        "error_code": failure_detail.get("code")
                        if isinstance(failure_detail, dict)
                        else None,
                        "conflicts": failure_detail.get("conflicts", [])
                        if isinstance(failure_detail, dict)
                        else [],
                    },
                )
                db.commit()
        except Exception:
            if db is not None:
                db.rollback()
        background_jobs.update_job(
            background_job_id,
            status="failed",
            error=_import_job_error(failure),
            error_code=failure_detail.get("code") if isinstance(failure_detail, dict) else None,
            error_details=failure_detail if isinstance(failure_detail, dict) else None,
            description="Cell registration failed",
        )
    finally:
        if db is not None:
            db.close()


def _accept_imported_cells(req: ImportCellsRequest, *, db: Session | None = None):
    if not req.cells:
        raise HTTPException(400, "No files selected")
    frozen_request = req.model_copy(deep=True)
    submitted_sources = sum(
        len(normalize_import_cell_sources(draft))
        for draft in frozen_request.cells
    )
    submission_fingerprint = hashlib.sha256(
        json.dumps(
            frozen_request.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    items = []
    for index, draft in enumerate(frozen_request.cells):
        sources = normalize_import_cell_sources(draft)
        items.append({
            "id": str(index),
            "label": draft.cell_name.strip() or sources[0].filename,
        })
    job_id, created = background_jobs.create_or_get_job(
        kind="import_register",
        title="Registering imported cells",
        description="Validating and registering Cells",
        total=len(frozen_request.cells),
        items=items,
        token=frozen_request.job_token,
        fingerprint=submission_fingerprint,
    )
    submission = None
    if frozen_request.job_token and db is not None:
        submission = db.query(ImportSubmission).filter(
            ImportSubmission.token == frozen_request.job_token
        ).first()
        if submission is not None:
            if submission.fingerprint != submission_fingerprint:
                if created:
                    background_jobs.discard_job(job_id)
                raise HTTPException(409, "This import submission token was already used for another payload")
            if created:
                background_jobs.discard_job(job_id)
            return _import_submission_response(submission)
        if created:
            try:
                # Reject name conflicts before claiming the durable
                # submission or starting the registration worker.
                _validate_import_cell_names(frozen_request, db)
            except HTTPException:
                background_jobs.discard_job(job_id)
                raise
        submission = ImportSubmission(
            token=frozen_request.job_token,
            fingerprint=submission_fingerprint,
            job_id=job_id,
            submitted_cells=len(frozen_request.cells),
            submitted_sources=submitted_sources,
            status="accepted",
        )
        db.add(submission)
        try:
            db.commit()
            db.refresh(submission)
        except IntegrityError:
            db.rollback()
            if created:
                background_jobs.discard_job(job_id)
            submission = db.query(ImportSubmission).filter(
                ImportSubmission.token == frozen_request.job_token
            ).first()
            if submission is None:
                raise HTTPException(
                    409,
                    {
                        "code": "import_submission_conflict",
                        "message": "This import submission could not be claimed safely. Please retry the import.",
                        "conflicts": [],
                    },
                )
            if submission.fingerprint != submission_fingerprint:
                if created:
                    background_jobs.discard_job(job_id)
                raise HTTPException(409, "This import submission token was already used for another payload")
            return _import_submission_response(submission)
    if created and db is not None and submission is None:
        try:
            # Reject name conflicts synchronously, before claiming a durable
            # submission or starting the registration worker.
            _validate_import_cell_names(frozen_request, db)
        except HTTPException:
            background_jobs.discard_job(job_id)
            raise
    existing = background_jobs.get_job(job_id)
    if not created:
        if existing and existing.get("payload_fingerprint") != submission_fingerprint:
            raise HTTPException(409, "This import submission token was already used for another payload")
        return {
            "accepted": True,
            "job_id": job_id,
            "job_token": frozen_request.job_token,
            "submitted_cells": len(frozen_request.cells),
            "submitted_sources": submitted_sources,
            "status": existing["status"] if existing else "running",
        }
    background_jobs.update_job(job_id, stage="register", total_bytes=0)
    thread = threading.Thread(
        target=run_import_registration_job,
        args=(frozen_request, job_id, submission.id if submission is not None else None),
        daemon=True,
    )
    thread.start()
    return {
        "accepted": True,
        "job_id": job_id,
        "job_token": frozen_request.job_token,
        "submitted_cells": len(frozen_request.cells),
        "submitted_sources": submitted_sources,
        "status": "running",
    }


@router.post("/imports/cells", status_code=202)
def create_imported_cells_endpoint(req: ImportCellsRequest, db: Session = Depends(get_db)):
    return _accept_imported_cells(req, db=db)


def create_imported_cells(req: ImportCellsRequest, db: Session | None = None):
    """Compatibility wrapper for direct callers of the former synchronous helper.

    HTTP callers use ``create_imported_cells_endpoint`` and receive the queued
    202 response. Focused internal callers that explicitly provide a session
    retain the old synchronous helper semantics for migration/test coverage.
    """
    if db is not None:
        return _create_imported_cells_impl(req, db, job_id=None)
    return _accept_imported_cells(req)


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

    existing_cell = db.get(Cell, req.cell_id) if req.cell_id is not None else None
    if req.test_id is not None or (existing_cell is not None and existing_cell.tests):
        raise HTTPException(
            409,
            {
                "code": "continuation_lifecycle_required",
                "message": (
                    "Adding a source to an existing Cell/Test must use the continuation "
                    "inspection and lifecycle API."
                ),
            },
        )

    if req.cell_id is not None:
        cell = existing_cell
        if cell is None:
            raise HTTPException(404, "No such cell")
    else:
        name = (req.cell_name or "").strip()
        if not name:
            # sensible default from file metadata — but never forced
            name = files[0].barcode or files[0].remarks or Path(files[0].filename).stem
        cell = db.query(Cell).filter(Cell.name == name).first()
        if cell is not None and cell.tests:
            raise HTTPException(
                409,
                {
                    "code": "continuation_lifecycle_required",
                    "message": (
                        "Adding a source to an existing Cell/Test must use the continuation "
                        "inspection and lifecycle API."
                    ),
                },
            )
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


class AttachContinuationsRequest(BaseModel):
    sources: list[ContinuationInspectSourceRequest]
    acknowledged_finding_ids: list[str] = []


class SourceChangeImpactRequest(BaseModel):
    operation: str
    sources: list[ContinuationInspectSourceRequest] = []
    file_ids: list[int] = []
    detach_file_id: int | None = None


class DetachSourceRequest(BaseModel):
    confirm: bool = False
    confirmation_token: str | None = None
    acknowledged_finding_ids: list[str] = []


class ReorderRequest(BaseModel):
    file_ids: list[int]
    acknowledged_finding_ids: list[str] = []


def _load_test_or_404(db: Session, test_id: int) -> Test:
    test = db.get(Test, test_id)
    if test is None:
        raise HTTPException(404, "No such test")
    tests = db.query(Test.id).filter(Test.cell_id == test.cell_id).all()
    if len(tests) != 1:
        raise HTTPException(
            409,
            {
                "code": "single_internal_test_required",
                "message": "This Cell must have exactly one internal source-chain row.",
                "cell_id": test.cell_id,
                "test_count": len(tests),
            },
        )
    return test


def _load_cell_single_test_or_404(db: Session, cell_id: int) -> tuple[Cell, Test]:
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    tests = db.query(Test).filter(Test.cell_id == cell.id).order_by(Test.id).all()
    if len(tests) != 1:
        raise HTTPException(
            409,
            {
                "code": "single_internal_test_required",
                "message": "This Cell must have exactly one internal source-chain row.",
                "cell_id": cell.id,
                "test_count": len(tests),
            },
        )
    return cell, tests[0]


def _inspect_test_chain(
    db: Session,
    test: Test,
    staged_sources: list[ContinuationInspectSourceRequest],
    *,
    proposed_file_ids: list[int] | None = None,
) -> dict:
    proposed_ids = (
        analysis_usage.ordered_test_file_ids(test)
        if proposed_file_ids is None
        else list(proposed_file_ids)
    )
    ordered_sources, staged_keys = _proposed_cell_continuation_sources(
        db,
        test,
        proposed_file_ids=proposed_ids,
        staged_sources=staged_sources,
    )
    if staged_keys:
        return continuations.analyze_continuation_chain(
            ordered_sources,
            staged_keys=staged_keys,
            proposed_staged_order=staged_keys,
        )
    return continuations.analyze_existing_order_chain(ordered_sources)


def _proposed_cell_continuation_sources(
    db: Session,
    test: Test,
    *,
    proposed_file_ids: list[int],
    staged_sources: list[ContinuationInspectSourceRequest],
) -> tuple[list[dict], list[str]]:
    staged_keys = [source.staged_name for source in staged_sources]
    try:
        continuations.validate_staged_keys(staged_keys)
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)

    staged_by_key = {source.staged_name: source for source in staged_sources}
    proposed_chain = analysis_usage.proposed_cell_source_chain(
        test.cell,
        test,
        proposed_file_ids=proposed_file_ids,
        staged_names=staged_keys,
        staged_filenames=[
            _clean_filename(Path(source.source_path or source.staged_name).name)
            for source in staged_sources
        ],
    )
    links_by_key = {
        (candidate_test.id, link.file_id): link
        for candidate_test in test.cell.tests
        for link in candidate_test.file_links
    }
    ordered_sources: list[dict] = []
    for input_order, entry in enumerate(proposed_chain):
        staged_name = entry.get("staged_name")
        if staged_name is not None:
            ordered_sources.append(
                _continuation_staged_source(
                    staged_by_key[staged_name],
                    db,
                    existing_test_id=test.id,
                    input_order=input_order,
                )
            )
            continue
        link = links_by_key.get((entry["test_id"], entry["file_id"]))
        if link is None:
            raise HTTPException(409, "Proposed continuation order references an unknown source")
        ordered_sources.append(
            _continuation_existing_source(
                link,
                existing_test_id=entry["test_id"],
                input_order=input_order,
            )
        )
    return ordered_sources, staged_keys


def _inspect_existing_order(
    db: Session,
    test: Test,
    proposed_file_ids: list[int],
) -> dict:
    return _inspect_test_chain(
        db,
        test,
        [],
        proposed_file_ids=proposed_file_ids,
    )


@router.post("/tests/{test_id}/source-change/impact")
def preview_test_source_change(
    test_id: int,
    req: SourceChangeImpactRequest,
    db: Session = Depends(get_db),
):
    test = _load_test_or_404(db, test_id)
    operation = req.operation.strip().lower()
    if operation not in {"attach", "reorder", "detach"}:
        raise HTTPException(400, "operation must be attach, reorder, or detach")

    current_file_ids = analysis_usage.ordered_test_file_ids(test)
    if operation == "attach":
        if not req.sources:
            raise HTTPException(400, "Attach impact preview requires staged sources")
        try:
            continuations.validate_staged_keys([source.staged_name for source in req.sources])
        except continuations.ContinuationValidationError as exc:
            _raise_continuation_validation(exc)
        staged_filenames = [
            _clean_filename(Path(source.source_path or source.staged_name).name)
            for source in req.sources
        ]
        return analysis_usage.preview_source_change_impact(
            db,
            test=test,
            operation="attach",
            proposed_file_ids=current_file_ids,
            staged_filenames=staged_filenames,
            staged_names=[source.staged_name for source in req.sources],
        )

    if operation == "reorder":
        try:
            continuations.validate_exact_file_id_permutation(current_file_ids, req.file_ids)
        except continuations.ContinuationValidationError as exc:
            _raise_continuation_validation(exc)
        return analysis_usage.preview_source_change_impact(
            db,
            test=test,
            operation="reorder",
            proposed_file_ids=req.file_ids,
        )

    if req.detach_file_id is None:
        raise HTTPException(400, "Detach impact preview requires detach_file_id")
    if req.detach_file_id not in current_file_ids:
        raise HTTPException(404, "File is not attached to that test")
    if len(current_file_ids) <= 1:
        raise HTTPException(409, "Cannot detach the last source from a test")
    proposed = [file_id for file_id in current_file_ids if file_id != req.detach_file_id]
    return analysis_usage.preview_source_change_impact(
        db,
        test=test,
        operation="detach",
        proposed_file_ids=proposed,
        detach_file_id=req.detach_file_id,
    )


@router.post("/tests/{test_id}/continuations")
def attach_continuations(
    test_id: int,
    req: AttachContinuationsRequest,
    db: Session = Depends(get_db),
):
    if not req.sources:
        raise HTTPException(400, "At least one staged source is required")
    test = _load_test_or_404(db, test_id)
    cell = test.cell
    old_order = _test_sources_payload(test)
    old_tracked = analysis_usage.tracked_source_file_id(cell)

    analysis = _inspect_test_chain(db, test, req.sources)
    inspected_hashes_by_staged_name = {
        source["key"]: source["hash"]
        for source in analysis.get("sources") or []
        if source.get("kind") == "staged" and source.get("hash")
    }
    try:
        continuations.ensure_submittable_chain(analysis, req.acknowledged_finding_ids)
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)
    _validate_staged_source_snapshots(req.sources, inspected_hashes_by_staged_name)

    base_position = max((link.position for link in test.file_links), default=-1) + 1
    attached_ids: list[int] = []
    cache_jobs: list[dict] = []
    source_file_ids_by_staged_name: dict[str, int] = {}
    try:
        for offset, source_draft in enumerate(req.sources):
            filename = _clean_filename(Path(source_draft.source_path or source_draft.staged_name).name)
            try:
                source_path = resolve_import_source_path(
                    source_draft.staged_name,
                    source_draft.source_path,
                )
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            sf = _register_or_refresh_source_file(
                db,
                source_path=source_path,
                filename=filename,
                expected_hash=inspected_hashes_by_staged_name.get(source_draft.staged_name),
                inspection=source_draft.inspection,
            )
            db.add(TestFile(test_id=test.id, file_id=sf.id, position=base_position + offset))
            sf.parse_status = "parsing"
            sf.capacity_summary_status = "pending"
            db.flush()
            attached_ids.append(sf.id)
            source_file_ids_by_staged_name[source_draft.staged_name] = sf.id
            cache_jobs.append(
                {
                    "staged_name": source_draft.staged_name,
                    "hash": sf.hash,
                    "path": str(source_path),
                }
            )
        _record_source_lifecycle_activity(
            db,
            action="continuation_attached",
            message=(
                f"Attached {len(attached_ids)} continuation"
                f"{'s' if len(attached_ids) != 1 else ''} to {cell.name}"
            ),
            cell=cell,
            test=test,
            details={
                "attached_source_ids": attached_ids,
                "attached_hash_prefixes": [
                    continuations.hash_prefix(db.get(SourceFile, source_id).hash)
                    for source_id in attached_ids
                ],
                "old_tracked_source_id": old_tracked,
                "previous_source_order": old_order,
            },
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise

    start_import_cache_jobs(source_file_ids_by_staged_name, cache_jobs)
    invalidated = _post_commit_source_invalidation(
        db,
        cell,
        reason="continuation_attached",
        source_id=attached_ids[-1] if attached_ids else None,
        queue_warmup=False,
    )
    db.refresh(test)
    return _lifecycle_mutation_response(
        test,
        cell,
        invalidated=invalidated,
        cache_jobs={"parsing_started": bool(cache_jobs), "attached_source_ids": attached_ids},
    )


@router.post("/tests/{test_id}/detach/{file_id}")
def detach_file(
    test_id: int,
    file_id: int,
    req: DetachSourceRequest | None = None,
    db: Session = Depends(get_db),
):
    test = _load_test_or_404(db, test_id)
    cell = test.cell
    current_file_ids = analysis_usage.ordered_test_file_ids(test)
    link = (
        db.query(TestFile).filter(TestFile.test_id == test_id, TestFile.file_id == file_id).first()
    )
    if link is None:
        raise HTTPException(404, "File is not attached to that test")
    if len(current_file_ids) <= 1:
        raise HTTPException(409, "Cannot detach the last source from a test")

    proposed = [current_id for current_id in current_file_ids if current_id != file_id]
    body = req or DetachSourceRequest()
    analysis = _inspect_test_chain(
        db,
        test,
        [],
        proposed_file_ids=proposed,
    )
    try:
        continuations.ensure_submittable_chain(
            analysis,
            body.acknowledged_finding_ids,
        )
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)

    impact = analysis_usage.preview_source_change_impact(
        db,
        test=test,
        operation="detach",
        proposed_file_ids=proposed,
        detach_file_id=file_id,
    )
    if not body.confirm or body.confirmation_token != impact["confirmation_token"]:
        raise HTTPException(
            422,
            {
                "message": "Impact confirmation is required before detaching a source.",
                "impact": impact,
            },
        )

    detached = db.get(SourceFile, file_id)
    old_order = _test_sources_payload(test)
    old_tracked = analysis_usage.tracked_source_file_id(cell)
    detached_filename = detached.filename if detached is not None else f"Source {file_id}"
    detached_hash_prefix = continuations.hash_prefix(detached.hash if detached else None)
    try:
        db.delete(link)
        db.flush()
        _record_source_lifecycle_activity(
            db,
            action="continuation_detached",
            message=f"Detached {detached_filename} from {cell.name}",
            cell=cell,
            test=test,
            details={
                "detached_source_id": file_id,
                "detached_hash_prefix": detached_hash_prefix,
                "old_tracked_source_id": old_tracked,
                "previous_source_order": old_order,
            },
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    invalidated = _post_commit_source_invalidation(
        db,
        cell,
        reason="continuation_detached",
        source_id=file_id,
    )
    db.refresh(test)
    response = _lifecycle_mutation_response(test, cell, invalidated=invalidated)
    response["detached_source_id"] = file_id
    return response


@router.post("/tests/{test_id}/reorder")
def reorder_files(test_id: int, req: ReorderRequest, db: Session = Depends(get_db)):
    test = _load_test_or_404(db, test_id)
    cell = test.cell
    current_file_ids = analysis_usage.ordered_test_file_ids(test)
    try:
        continuations.validate_exact_file_id_permutation(current_file_ids, req.file_ids)
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)

    if req.file_ids == current_file_ids:
        invalidated = {"analysis_ids": [], "queued_plots": 0}
        return _lifecycle_mutation_response(test, cell, invalidated=invalidated)

    analysis = _inspect_existing_order(db, test, req.file_ids)
    try:
        continuations.ensure_submittable_chain(analysis, req.acknowledged_finding_ids)
    except continuations.ContinuationValidationError as exc:
        _raise_continuation_validation(exc)

    old_order = _test_sources_payload(test)
    old_tracked = analysis_usage.tracked_source_file_id(cell)
    pos = {fid: index for index, fid in enumerate(req.file_ids)}
    try:
        for link in test.file_links:
            link.position = pos[link.file_id]
        db.flush()
        _record_source_lifecycle_activity(
            db,
            action="source_order_changed",
            message=f"Reordered sources for {cell.name}",
            cell=cell,
            test=test,
            details={
                "old_tracked_source_id": old_tracked,
                "previous_source_order": old_order,
                "proposed_source_order": _test_sources_payload(test),
            },
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    invalidated = _post_commit_source_invalidation(
        db,
        cell,
        reason="source_order_changed",
    )
    db.refresh(test)
    return _lifecycle_mutation_response(test, cell, invalidated=invalidated)


def _cell_level_mutation_response(result: dict) -> dict:
    """Remove the internal Test envelope from the Cell-level API contract."""
    internal = result.pop("test", None) or {}
    result["sources"] = internal.get("sources", [])
    return result


def _cell_proposal_analysis(
    db: Session,
    test: Test,
    req: SourceChangeImpactRequest,
) -> dict:
    operation = req.operation.strip().lower()
    current_file_ids = analysis_usage.ordered_test_file_ids(test)
    if operation == "attach":
        if not req.sources:
            raise HTTPException(400, "Attach impact preview requires staged sources")
        return _inspect_test_chain(db, test, req.sources, proposed_file_ids=current_file_ids)
    if operation == "reorder":
        try:
            continuations.validate_exact_file_id_permutation(current_file_ids, req.file_ids)
        except continuations.ContinuationValidationError as exc:
            _raise_continuation_validation(exc)
        return _inspect_existing_order(db, test, req.file_ids)
    if req.detach_file_id is None or req.detach_file_id not in current_file_ids:
        raise HTTPException(404, "File is not attached to this Cell")
    if len(current_file_ids) <= 1:
        raise HTTPException(409, "Cannot detach the last source from a Cell")
    proposed = [file_id for file_id in current_file_ids if file_id != req.detach_file_id]
    return _inspect_existing_order(db, test, proposed)


@router.post("/cells/{cell_id}/source-change/impact")
def preview_cell_source_change(
    cell_id: int,
    req: SourceChangeImpactRequest,
    db: Session = Depends(get_db),
):
    _cell, test = _load_cell_single_test_or_404(db, cell_id)
    impact = preview_test_source_change(test.id, req, db)
    impact["inspection"] = _cell_proposal_analysis(db, test, req)
    impact.pop("test_id", None)
    impact.pop("test_name", None)
    return impact


@router.post("/cells/{cell_id}/continuations")
def attach_cell_continuations(
    cell_id: int,
    req: AttachContinuationsRequest,
    db: Session = Depends(get_db),
):
    _cell, test = _load_cell_single_test_or_404(db, cell_id)
    return _cell_level_mutation_response(attach_continuations(test.id, req, db))


@router.post("/cells/{cell_id}/reorder")
def reorder_cell_sources(
    cell_id: int,
    req: ReorderRequest,
    db: Session = Depends(get_db),
):
    _cell, test = _load_cell_single_test_or_404(db, cell_id)
    return _cell_level_mutation_response(reorder_files(test.id, req, db))


@router.post("/cells/{cell_id}/detach/{file_id}")
def detach_cell_source(
    cell_id: int,
    file_id: int,
    req: DetachSourceRequest | None = None,
    db: Session = Depends(get_db),
):
    _cell, test = _load_cell_single_test_or_404(db, cell_id)
    return _cell_level_mutation_response(detach_file(test.id, file_id, req, db))
