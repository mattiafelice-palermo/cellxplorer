"""The canonical Library: Cells, source-chain compatibility rows, metadata, and tags."""
from __future__ import annotations

import logging
import math
import os
import threading
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from time import sleep as _sleep
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import case, func
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
from ..services.process_priority import (
    apply_background_thread_priority,
    process_pool_executor,
    thread_pool_executor,
)
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

logger = logging.getLogger(__name__)

_source_check_job_lock = threading.Lock()
_source_check_jobs: dict[int, dict] = {}
_latest_source_check_job_id: int | None = None
_next_source_check_job_id = 1
_JobThread = threading.Thread


def source_file_needs_cache(sf: SourceFile) -> bool:
    if parsing.source_record_metadata_only(sf):
        return False
    if sf.parse_status != "parsed":
        return True
    expected = parsing.current_parser_identity_for_extension(sf.ext) or parsing.PARSER_VERSION
    if sf.parser_version != expected:
        return True
    if sf.cycle_count is None or sf.row_count is None:
        return True
    return not cache.has_cycles(sf.hash, sf.parser_version, CALC_VERSION)


def _ordered_cell_source_files(cell: Cell) -> list[SourceFile]:
    """Return one Cell's ordered sources through the canonical invariant."""
    return [link.file for link in analysis_svc.ordered_cell_source_links(cell)]


def delete_empty_replicate_groups(db: Session) -> list[int]:
    """Remove replicate groups that no longer reference any cell.

    One aggregate query, not a COUNT per group. Call this once after a batch of
    cell deletions rather than once per cell: at 20 groups the per-cell form
    issued ~21,000 reads to delete 1,000 cells.
    """
    empty_group_ids = [
        row[0]
        for row in db.query(ReplicateGroup.id)
        .outerjoin(ReplicateGroupCell, ReplicateGroupCell.group_id == ReplicateGroup.id)
        .group_by(ReplicateGroup.id)
        .having(func.count(ReplicateGroupCell.cell_id) == 0)
        .order_by(ReplicateGroup.id)
        .all()
    ]
    deleted: list[int] = []
    for chunk in _id_chunks(empty_group_ids):
        db.query(FolderReplicateGroup).filter(
            FolderReplicateGroup.group_id.in_(chunk)
        ).delete(synchronize_session=False)
    for group_id in empty_group_ids:
        group = db.get(ReplicateGroup, group_id)
        if group is not None:
            # ORM delete, not a bulk statement: callers still holding this group
            # must see it gone from the session, not just from the table.
            db.delete(group)
            deleted.append(group_id)
    return deleted


def _source_is_available(source: SourceFile) -> bool:
    """Return whether a source can safely regenerate its cache."""
    return source.location_status == "online" and Path(source.path).is_file()


def remove_deleted_source_caches(source_hashes: list[str]) -> dict:
    """Remove caches for source rows deleted after the DB transaction commits.

    The original source files are never touched. Cache removal is deliberately
    best-effort: a failed filesystem cleanup must not make a successful Cell
    deletion look like it failed. The remaining orphan is eligible for the
    normal cache cleanup action.
    """
    bytes_removed = 0
    errors: list[str] = []
    for source_hash in dict.fromkeys(source_hashes):
        try:
            bytes_removed += cache.remove_hash_cache(source_hash)
        except (OSError, ValueError) as exc:
            logger.warning(
                "could not remove cache for deleted source %s: %s",
                source_hash[:12],
                exc,
            )
            errors.append(source_hash)
    return {
        "cache_bytes_removed": bytes_removed,
        "cache_cleanup_failed": len(errors),
    }


# Removing one cache is a small rmtree, so a handful stay on the request and the
# response can report the bytes reclaimed. A large deletion is different in kind:
# 1,000 sources is roughly 11 GB of Parquet, which belongs in the background with
# the other long filesystem work rather than holding the UI.
CACHE_CLEANUP_BACKGROUND_THRESHOLD = 25


# Removing a cache directory is I/O bound — stat every file, then unlink the
# tree — so a small thread pool overlaps the syscalls. Measured on NTFS: 2.2x at
# four threads, with little beyond that. Threads, not processes: the work never
# holds the GIL, and the parent spec permits conservative filesystem thread pools.
CACHE_CLEANUP_WORKERS = 4


def _remove_one_source_cache(source_hash: str) -> tuple[str, int, str | None]:
    try:
        return source_hash, cache.remove_hash_cache(source_hash), None
    except (OSError, ValueError) as exc:
        # Best-effort, exactly as on the synchronous path: an orphaned cache is
        # reclaimable by the normal cleanup action and must never make a
        # committed Cell deletion look like it failed.
        logger.warning("could not remove cache for deleted source %s: %s", source_hash[:12], exc)
        return source_hash, 0, str(exc)


def run_source_cache_cleanup_job(source_hashes: list[str], background_job_id: int) -> None:
    apply_background_thread_priority()
    bytes_removed = 0
    failed = 0
    for source_hash in source_hashes:
        background_jobs.update_item(background_job_id, source_hash, status="processing")
    workers = min(CACHE_CLEANUP_WORKERS, len(source_hashes))
    with thread_pool_executor(max(1, workers)) as pool:
        for source_hash, removed, error in pool.map(_remove_one_source_cache, source_hashes):
            bytes_removed += removed
            if error is None:
                background_jobs.record_result(
                    background_job_id, source_hash, status="ready", counter="ready"
                )
            else:
                failed += 1
                background_jobs.record_result(
                    background_job_id,
                    source_hash,
                    status="failed",
                    error=error,
                    counter="failed",
                )
    description = f"Reclaimed {bytes_removed / 1e9:.1f} GB of cached cycling data"
    if failed:
        description += f"; {failed} could not be removed"
    background_jobs.update_job(
        background_job_id,
        status="completed",
        description=description,
        cache_bytes_removed=bytes_removed,
        cache_cleanup_failed=failed,
    )
    db = SessionLocal()
    try:
        record_activity(
            db,
            category="cell",
            action="cleanup_deleted_caches",
            message=description,
            severity="warning" if failed else "info",
            details={
                "background_job_id": background_job_id,
                "sources": len(source_hashes),
                "cache_bytes_removed": bytes_removed,
                "cache_cleanup_failed": failed,
            },
        )
        db.commit()
    finally:
        db.close()


def start_source_cache_cleanup(source_hashes: list[str]) -> dict:
    """Remove caches for deleted sources, in the background when there are many.

    The relational deletion has already committed when this runs, so the Cells
    are gone from the database either way; this only reclaims disk.
    """
    unique_hashes = list(dict.fromkeys(source_hashes))
    if len(unique_hashes) <= CACHE_CLEANUP_BACKGROUND_THRESHOLD:
        return {**remove_deleted_source_caches(unique_hashes), "cache_cleanup_job": None}
    background_job_id = background_jobs.create_job(
        kind="cache_cleanup",
        title="Removing cached cycling data",
        description=f"Reclaiming cache space for {len(unique_hashes)} deleted sources",
        total=len(unique_hashes),
        items=[{"id": source_hash, "label": source_hash[:12]} for source_hash in unique_hashes],
    )
    threading.Thread(
        target=run_source_cache_cleanup_job,
        args=(unique_hashes, background_job_id),
        daemon=True,
    ).start()
    return {
        "cache_bytes_removed": 0,
        "cache_cleanup_failed": 0,
        "cache_cleanup_job": {"job_id": background_job_id, "count": len(unique_hashes)},
    }


def delete_cell_from_library(db: Session, cell: Cell) -> dict:
    """Remove one cell and every active reference to it.

    Delegates to the batch path so the single-cell and multi-cell endpoints
    cannot drift apart in what they delete or preserve.
    """
    result = delete_cells_from_library(db, [cell.id])
    return {
        "deleted_cell_id": cell.id,
        "deleted_replicate_group_ids": result["deleted_replicate_group_ids"],
        "deleted_source_file_ids": result["deleted_source_file_ids"],
        "preserved_source_file_ids": result["preserved_source_file_ids"],
        "retained_source_file_ids": result["retained_source_file_ids"],
        "_cache_hashes_to_remove": result["_cache_hashes_to_remove"],
    }


def _id_chunks(ids: list[int], size: int = 500):
    """Yield id chunks small enough to stay well inside SQLite's variable limit."""
    for start in range(0, len(ids), size):
        yield ids[start : start + size]


def delete_cells_from_library(db: Session, cell_ids: list[int]) -> dict:
    """Remove many cells and every active reference to them, set at a time.

    Online SourceFile rows become unregistered data once their Cell is deleted,
    so they and their regenerable caches are removed after the transaction
    commits. Offline or changed sources are retained together with their cache:
    the cache may be the only locally readable copy of that data.

    Every dependent table is cleared with one statement per chunk rather than
    one per cell, and empty replicate groups are collected once at the end. The
    per-cell form issued ~55,000 statements to delete 1,000 cells. Cells,
    sources, and groups are still removed through the ORM so that callers
    holding those objects see them disappear from the session too.
    """
    unique_ids = list(dict.fromkeys(int(cell_id) for cell_id in cell_ids))
    if not unique_ids:
        return {
            "deleted_cell_ids": [],
            "deleted_replicate_group_ids": [],
            "missing_cell_ids": [],
            "deleted_source_file_ids": [],
            "preserved_source_file_ids": [],
            "retained_source_file_ids": [],
            "_cache_hashes_to_remove": [],
        }
    cells: dict[int, Cell] = {}
    for chunk in _id_chunks(unique_ids):
        for cell in db.query(Cell).filter(Cell.id.in_(chunk)).all():
            cells[cell.id] = cell
    deleted_cell_ids = [cell_id for cell_id in unique_ids if cell_id in cells]
    if not deleted_cell_ids:
        return {
            "deleted_cell_ids": [],
            "deleted_replicate_group_ids": [],
            "missing_cell_ids": list(unique_ids),
            "deleted_source_file_ids": [],
            "preserved_source_file_ids": [],
            "retained_source_file_ids": [],
            "_cache_hashes_to_remove": [],
        }

    # Sources in submitted-cell order, so the reported ids keep the order the
    # per-cell implementation produced.
    sources_by_cell: dict[int, list[SourceFile]] = {}
    for chunk in _id_chunks(deleted_cell_ids):
        rows = (
            db.query(Test.cell_id, SourceFile)
            .join(TestFile, TestFile.file_id == SourceFile.id)
            .join(Test, Test.id == TestFile.test_id)
            .filter(Test.cell_id.in_(chunk))
            .order_by(Test.cell_id, TestFile.position)
            .all()
        )
        for cell_id, source in rows:
            sources_by_cell.setdefault(int(cell_id), []).append(source)

    for chunk in _id_chunks(deleted_cell_ids):
        for model in (FolderCell, ProjectCell, GroupCell, ReplicateGroupCell, CellTag, CellMetadata):
            db.query(model).filter(model.cell_id.in_(chunk)).delete(synchronize_session=False)

    test_ids: list[int] = []
    for chunk in _id_chunks(deleted_cell_ids):
        test_ids.extend(row[0] for row in db.query(Test.id).filter(Test.cell_id.in_(chunk)).all())
    for chunk in _id_chunks(test_ids):
        db.query(TestFile).filter(TestFile.test_id.in_(chunk)).delete(synchronize_session=False)
        db.query(Test).filter(Test.id.in_(chunk)).delete(synchronize_session=False)

    all_source_ids = list(
        dict.fromkeys(
            source.id for sources in sources_by_cell.values() for source in sources
        )
    )
    remaining_source_file_ids: set[int] = set()
    for chunk in _id_chunks(all_source_ids):
        remaining_source_file_ids.update(
            source_id
            for (source_id,) in db.query(TestFile.file_id)
            .filter(TestFile.file_id.in_(chunk))
            .distinct()
            .all()
        )

    deleted_source_file_ids: list[int] = []
    preserved_source_file_ids: list[int] = []
    retained_source_file_ids: list[int] = []
    cache_hashes_to_remove: list[str] = []
    for cell_id in deleted_cell_ids:
        for source in sources_by_cell.get(cell_id, []):
            if source.id in remaining_source_file_ids:
                retained_source_file_ids.append(source.id)
            elif _source_is_available(source):
                db.delete(source)
                deleted_source_file_ids.append(source.id)
                cache_hashes_to_remove.append(source.hash)
            else:
                preserved_source_file_ids.append(source.id)
        db.delete(cells[cell_id])

    deleted_group_ids = delete_empty_replicate_groups(db)
    return {
        "deleted_cell_ids": deleted_cell_ids,
        "deleted_replicate_group_ids": list(dict.fromkeys(deleted_group_ids)),
        "missing_cell_ids": [cell_id for cell_id in unique_ids if cell_id not in cells],
        "deleted_source_file_ids": deleted_source_file_ids,
        "preserved_source_file_ids": preserved_source_file_ids,
        "retained_source_file_ids": list(dict.fromkeys(retained_source_file_ids)),
        "_cache_hashes_to_remove": list(dict.fromkeys(cache_hashes_to_remove)),
    }


def _finite_sum(values) -> float | None:
    total = 0.0
    found = False
    for value in values:
        if value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isnan(number) or not math.isfinite(number):
            continue
        total += number
        found = True
    return round(total, 6) if found else None


def _finite_max(values) -> float | None:
    best = None
    for value in values:
        if value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isnan(number) or not math.isfinite(number):
            continue
        if best is None or number > best:
            best = number
    return round(best, 6) if best is not None else None


def max_specific_discharge_capacity(
    max_discharge_capacity_mah: float | None,
    active_mass_mg: float | None,
) -> float | None:
    mass = _positive_float(active_mass_mg)
    if max_discharge_capacity_mah is None or mass is None:
        return None
    try:
        max_mah = float(max_discharge_capacity_mah)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(max_mah):
        return None
    return round(max_mah * 1000 / mass, 6)


def cell_capacity_totals(cell: Cell) -> dict:
    source_files = _ordered_cell_source_files(cell)
    if any(sf.capacity_summary_status != "ready" for sf in source_files):
        return {
            "total_charge_capacity_mah": None,
            "total_discharge_capacity_mah": None,
            "max_discharge_capacity_mah": None,
        }
    return {
        "total_charge_capacity_mah": _finite_sum(
            sf.total_charge_capacity_mah for sf in source_files
        ),
        "total_discharge_capacity_mah": _finite_sum(
            sf.total_discharge_capacity_mah for sf in source_files
        ),
        "max_discharge_capacity_mah": _finite_max(
            sf.max_discharge_capacity_mah for sf in source_files
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
    return number if number > 0 and math.isfinite(number) else None


def cell_scientific_metadata(
    cell: Cell,
    metadata: dict[str, str] | None = None,
) -> dict:
    if metadata is None:
        metadata = {entry.key: entry.value for entry in cell.metadata_entries}
    source_files = _ordered_cell_source_files(cell)
    source_mass = next(
        (value for file in source_files if (value := _positive_float(file.active_mass_mg)) is not None),
        None,
    )
    source_nominal = next(
        (value for file in source_files if (value := _positive_float(file.nominal_capacity_mah)) is not None),
        None,
    )
    return _scientific_metadata_values(metadata, source_mass, source_nominal)


def _scientific_metadata_values(
    metadata: dict[str, str],
    source_mass: float | None,
    source_nominal: float | None,
) -> dict:
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


def effective_active_mass_mg(db: Session, cell_ids: list[int]) -> dict[int, float | None]:
    """Active mass per cell, resolved exactly as the Cell Database resolves it.

    Public because the project explorer needs the same number: override beats the
    legacy metadata key, which beats the value read out of the source file. If the
    two views resolved mass differently they would report different specific
    capacities for the same cell.
    """
    if not cell_ids:
        return {}
    source = _cell_source_scientific_values(db, cell_ids)
    by_cell: dict[int, dict[str, str]] = {}
    for cell_id, key, value in (
        db.query(CellMetadata.cell_id, CellMetadata.key, CellMetadata.value)
        .filter(CellMetadata.cell_id.in_(cell_ids))
        .all()
    ):
        by_cell.setdefault(int(cell_id), {})[key] = value
    masses: dict[int, float | None] = {}
    for cell_id in cell_ids:
        source_mass, source_nominal = source.get(cell_id, (None, None))
        values = _scientific_metadata_values(
            by_cell.get(cell_id, {}), source_mass, source_nominal
        )
        masses[cell_id] = values["active_mass_mg"]["effective_value"]
    return masses


def _max_specific_from_summary(
    summary: dict,
    metadata: dict[str, str],
    source_mass: float | None,
    source_nominal: float | None,
) -> float | None:
    if summary.get("has_summary_pending") or summary.get("has_summary_error"):
        return None
    scientific = _scientific_metadata_values(metadata, source_mass, source_nominal)
    return max_specific_discharge_capacity(
        summary.get("max_discharge_capacity_mah"),
        scientific["active_mass_mg"]["effective_value"],
    )


def _empty_cell_file_summary() -> dict:
    return {
        "n_files": 0,
        "total_cycles": 0,
        "total_charge_capacity_mah": None,
        "total_discharge_capacity_mah": None,
        "has_offline": False,
        "has_changed": False,
        "has_changing": False,
        "has_parsing": False,
        "has_summary_pending": False,
        "has_summary_error": False,
    }


def _require_valid_cell_test_rows(db: Session, cell_ids: list[int]) -> None:
    """Reject every selected Cell that does not have exactly one Test row."""
    invalid = (
        db.query(Cell.id, func.count(Test.id))
        .outerjoin(Test, Test.cell_id == Cell.id)
        .filter(Cell.id.in_(cell_ids))
        .group_by(Cell.id)
        .having(func.count(Test.id) != 1)
        .all()
    )
    if invalid:
        cell_id, count = invalid[0]
        cell = db.get(Cell, int(cell_id)) or Cell(id=int(cell_id), name="Unknown")
        raise analysis_svc.CellSourceChainInvariantError(cell, int(count))


def _cell_file_summaries(db: Session, cell_ids: list[int]) -> dict[int, dict]:
    """Build library-row file summaries without materializing ORM graphs."""
    if not cell_ids:
        return {}
    _require_valid_cell_test_rows(db, cell_ids)
    rows = (
        db.query(
            Test.cell_id.label("cell_id"),
            func.count(SourceFile.id).label("n_files"),
            func.coalesce(
                func.sum(
                    case(
                        (
                            SourceFile.capacity_summary_status == "ready",
                            func.coalesce(SourceFile.cycle_count, 0),
                        ),
                        else_=0,
                    )
                ),
                0,
            ).label("total_cycles"),
            func.sum(SourceFile.total_charge_capacity_mah).label("total_charge"),
            func.sum(SourceFile.total_discharge_capacity_mah).label("total_discharge"),
            func.max(SourceFile.max_discharge_capacity_mah).label("max_discharge"),
            func.sum(
                case(
                    (
                        SourceFile.id.is_not(None)
                        & (func.coalesce(SourceFile.capacity_summary_status, "") != "ready"),
                        1,
                    ),
                    else_=0,
                )
            ).label("not_ready"),
            func.max(case((SourceFile.location_status == "offline", 1), else_=0)).label(
                "has_offline"
            ),
            func.max(case((SourceFile.location_status == "changed", 1), else_=0)).label(
                "has_changed"
            ),
            func.max(case((SourceFile.location_status == "changing", 1), else_=0)).label(
                "has_changing"
            ),
            func.max(case((SourceFile.parse_status == "parsing", 1), else_=0)).label(
                "has_parsing"
            ),
            func.max(
                case(
                    (
                        (SourceFile.parse_status == "parsed")
                        & (SourceFile.capacity_summary_status == "pending"),
                        1,
                    ),
                    else_=0,
                )
            ).label("has_summary_pending"),
            func.max(
                case(
                    (
                        (SourceFile.parse_status == "parsed")
                        & (SourceFile.capacity_summary_status == "error"),
                        1,
                    ),
                    else_=0,
                )
            ).label("has_summary_error"),
        )
        .outerjoin(TestFile, TestFile.test_id == Test.id)
        .outerjoin(SourceFile, SourceFile.id == TestFile.file_id)
        .filter(Test.cell_id.in_(cell_ids))
        .group_by(Test.cell_id)
        .all()
    )
    summaries: dict[int, dict] = {}
    for row in rows:
        all_ready = int(row.n_files or 0) > 0 and int(row.not_ready or 0) == 0
        summaries[int(row.cell_id)] = {
            "n_files": int(row.n_files or 0),
            "total_cycles": int(row.total_cycles or 0),
            "total_charge_capacity_mah": (
                round(float(row.total_charge), 6)
                if all_ready and row.total_charge is not None
                else None
            ),
            "total_discharge_capacity_mah": (
                round(float(row.total_discharge), 6)
                if all_ready and row.total_discharge is not None
                else None
            ),
            "max_discharge_capacity_mah": (
                round(float(row.max_discharge), 6)
                if all_ready and row.max_discharge is not None
                else None
            ),
            "has_offline": bool(row.has_offline),
            "has_changed": bool(row.has_changed),
            "has_changing": bool(row.has_changing),
            "has_parsing": bool(row.has_parsing),
            "has_summary_pending": bool(row.has_summary_pending),
            "has_summary_error": bool(row.has_summary_error),
        }
    return summaries


def _cell_source_scientific_values(
    db: Session, cell_ids: list[int]
) -> dict[int, tuple[float | None, float | None]]:
    if not cell_ids:
        return {}
    _require_valid_cell_test_rows(db, cell_ids)
    rows = (
        db.query(
            Test.cell_id,
            SourceFile.active_mass_mg,
            SourceFile.nominal_capacity_mah,
        )
        .join(TestFile, TestFile.test_id == Test.id)
        .join(SourceFile, SourceFile.id == TestFile.file_id)
        .filter(Test.cell_id.in_(cell_ids))
        .order_by(Test.id, TestFile.position)
        .all()
    )
    values: dict[int, list[float | None]] = {}
    for cell_id, mass, nominal in rows:
        current = values.setdefault(int(cell_id), [None, None])
        if current[0] is None:
            current[0] = _positive_float(mass)
        if current[1] is None:
            current[1] = _positive_float(nominal)
    return {cell_id: (value[0], value[1]) for cell_id, value in values.items()}


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
    source_files = _ordered_cell_source_files(cell)
    n_files = len(source_files)
    cycles = 0
    statuses = set()
    for source_file in source_files:
        if source_file.capacity_summary_status == "ready":
            cycles += source_file.cycle_count or 0
        statuses.add(source_file.location_status)
        statuses.add(source_file.parse_status)
    totals = cell_capacity_totals(cell)
    cell.total_charge_capacity_mah = totals["total_charge_capacity_mah"]
    cell.total_discharge_capacity_mah = totals["total_discharge_capacity_mah"]
    scientific_metadata = cell_scientific_metadata(cell, meta)
    has_summary_pending = any(
        source_file.parse_status == "parsed"
        and source_file.capacity_summary_status == "pending"
        for source_file in source_files
    )
    has_summary_error = any(
        source_file.parse_status == "parsed"
        and source_file.capacity_summary_status == "error"
        for source_file in source_files
    )
    result = {
        "id": cell.id,
        "name": cell.name,
        "description": cell.description,
        "archived": cell.archived,
        "cycling_status": cell.cycling_status,
        "tags": sorted(tag_names),
        "scientific_metadata": scientific_metadata,
        "scientific_presets": cell_scientific_presets(cell, meta),
        "n_files": n_files,
        "total_cycles": cycles,
        "total_charge_capacity_mah": totals["total_charge_capacity_mah"],
        "total_discharge_capacity_mah": totals["total_discharge_capacity_mah"],
        "max_specific_discharge_capacity_mah_g": (
            None
            if has_summary_pending or has_summary_error
            else max_specific_discharge_capacity(
                totals["max_discharge_capacity_mah"],
                scientific_metadata["active_mass_mg"]["effective_value"],
            )
        ),
        "has_offline": "offline" in statuses,
        "has_changed": "changed" in statuses,
        "has_changing": "changing" in statuses,
        "has_parsing": "parsing" in statuses,
        "has_metadata_only": any(
            parsing.source_record_metadata_only(source_file)
            for source_file in source_files
        ),
        "has_summary_pending": has_summary_pending,
        "has_summary_error": has_summary_error,
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
    cells = q.order_by(Cell.name).all()
    cell_ids = [cell.id for cell in cells]
    tags_by_cell: dict[int, list[str]] = {cell.id: [] for cell in cells}
    metadata_by_cell: dict[int, dict[str, str]] = {cell.id: {} for cell in cells}
    file_summaries = _cell_file_summaries(db, cell_ids)
    source_values = _cell_source_scientific_values(db, cell_ids)
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
    result = []
    for cell in cells:
        metadata = metadata_by_cell[cell.id]
        source_mass, source_nominal = source_values.get(cell.id, (None, None))
        summary = file_summaries.get(cell.id, _empty_cell_file_summary())
        max_specific = _max_specific_from_summary(
            summary, metadata, source_mass, source_nominal
        )
        public_summary = {
            key: value
            for key, value in summary.items()
            if key != "max_discharge_capacity_mah"
        }
        result.append(
            {
                "id": cell.id,
                "name": cell.name,
                "description": cell.description,
                "archived": cell.archived,
                "cycling_status": cell.cycling_status,
                "tags": sorted(tags_by_cell[cell.id]),
                "scientific_metadata": _scientific_metadata_values(
                    metadata, source_mass, source_nominal
                ),
                "scientific_presets": cell_scientific_presets(cell, metadata),
                **public_summary,
                "max_specific_discharge_capacity_mah_g": max_specific,
                "created_at": cell.created_at.isoformat(),
            }
        )
    return result


class CellCreate(BaseModel):
    name: str
    description: str | None = None


@router.post("/cells")
def create_cell(req: CellCreate, db: Session = Depends(get_db)):
    if db.query(Cell).filter(Cell.name == req.name.strip()).first():
        raise HTTPException(409, "A cell with that name already exists")
    cell = Cell(name=req.name.strip(), description=req.description)
    db.add(cell)
    db.flush()
    db.add(Test(cell_id=cell.id, name="Imported file"))
    db.commit()
    return cell_dict(db, cell)


@router.get("/cells/{cell_id}")
def get_cell(cell_id: int, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    d = cell_dict(db, cell)
    links = _ordered_cell_file_links(cell)
    d["sources"] = []
    for position, link in enumerate(links, start=1):
        source = file_dict(link.file)
        source.pop("test_id", None)
        source.pop("test_name", None)
        source["position"] = position
        source["tracked_tail"] = position == len(links)
        d["sources"].append(source)
    return d


@router.get("/cells/{cell_id}/sources/{source_file_id}/header")
def get_cell_source_header(cell_id: int, source_file_id: int, db: Session = Depends(get_db)):
    """The complete parsed header of one source, fetched on demand.

    Deliberately not folded into `GET /cells/{cell_id}`: a header is ~57 KB, so
    a continued Cell would pay several hundred kilobytes on every detail open
    for a panel the user usually leaves collapsed.
    """
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    link = next(
        (link for link in _ordered_cell_file_links(cell) if link.file_id == source_file_id),
        None,
    )
    if link is None:
        raise HTTPException(404, "No such source for this cell")
    # Sources registered before header capture, and headers that failed to
    # parse, are an empty document rather than an error: the panel says "no
    # stored header" instead of showing a failure the user cannot act on.
    return {
        "source_file_id": link.file_id,
        "filename": link.file.filename,
        "header": link.file.header_meta or {},
    }


def _observed_steps_for_source(source_file: SourceFile) -> list[dict]:
    parser_version = source_file.parser_version or (
        parsing.current_parser_identity_for_extension(source_file.ext) or parsing.PARSER_VERSION
    )
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
    # These fields enter the analysis cache key (labels, archived flag, and
    # the normalization inputs), so cached plots of dependent analyses are
    # stale from this moment. Notes and display-only preset names are not.
    cache_key_fields = {
        "name",
        "archived",
        "active_mass_mg",
        "nominal_capacity_mah",
        "electrode_area_cm2",
    }
    if cache_key_fields.intersection(changed_fields):
        from ..services import cache_maintenance

        cache_maintenance.invalidate_cell_dependents(
            db,
            cell.id,
            reason="cell_edit",
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


SourceScope = Literal["all_ordered_sources", "tracked_tails"]


class CellDeleteRequest(BaseModel):
    cell_ids: list[int]


def _ordered_cell_file_links(cell: Cell) -> list[TestFile]:
    """Return one ordered Cell source chain for monitoring."""
    return analysis_svc.ordered_cell_source_links(cell)


def _cell_source_files(
    db: Session,
    cell_ids: list[int] | None = None,
    include_complete: bool = False,
    changed_only: bool = False,
    source_scope: SourceScope = "all_ordered_sources",
) -> tuple[list[SourceFile], int]:
    if source_scope not in {"all_ordered_sources", "tracked_tails"}:
        raise ValueError(f"Unsupported source scope: {source_scope}")
    q = db.query(Cell).filter(Cell.archived == False)  # noqa: E712
    q = q.options(selectinload(Cell.tests).selectinload(Test.file_links).selectinload(TestFile.file))
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
        links_in_cell = _ordered_cell_file_links(cell)
        if source_scope == "tracked_tails":
            links = links_in_cell[-1:] if links_in_cell else []
        else:
            links = links_in_cell
        for link in links:
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
    with thread_pool_executor(max_workers=max_workers, thread_name_prefix="source-stat") as executor:
        for start in range(0, len(jobs), batch_size):
            results.extend(executor.map(_source_stat_worker, jobs[start : start + batch_size]))
    return results


def _make_process_executor(executor_cls, max_workers: int):
    if executor_cls is ProcessPoolExecutor:
        return process_pool_executor(max_workers)
    return executor_cls(max_workers=max_workers)


def cell_source_check_worker_count(n_jobs: int, max_workers: int | None = None) -> int:
    available = max_workers or os.cpu_count() or 1
    return max(1, min(n_jobs, available))


def _source_check_job_snapshot(job_id: int) -> dict | None:
    with _source_check_job_lock:
        job = _source_check_jobs.get(job_id)
        return deepcopy(job) if job else None


def source_check_running() -> bool:
    with _source_check_job_lock:
        return any(job.get("status") == "running" for job in _source_check_jobs.values())


def _normalised_source_check_cell_ids(cell_ids: list[int] | None) -> list[int]:
    return sorted({int(cell_id) for cell_id in (cell_ids or [])})


def _source_check_contract(
    *,
    cell_ids: list[int] | None,
    source_scope: SourceScope,
    include_complete: bool,
    update_after_check: bool,
    scan_mode: str,
    batch_size: int,
    stability_seconds: float,
    low_impact: bool,
    retry_count: int,
    retry_delay_seconds: int,
    retry_deadline_at: str | None,
) -> dict:
    metadata_scan = scan_mode == "metadata"
    return {
        "source_scope": source_scope,
        "requested_cell_ids": _normalised_source_check_cell_ids(cell_ids),
        "include_complete": bool(include_complete),
        "update_after_check": bool(update_after_check),
        "scan_mode": scan_mode,
        "batch_size": max(1, min(int(batch_size), 5000)) if metadata_scan else None,
        "stability_seconds": float(stability_seconds) if metadata_scan else None,
        "low_impact": bool(low_impact),
        "retry_count": int(retry_count) if metadata_scan else 0,
        "retry_delay_seconds": int(retry_delay_seconds) if metadata_scan else 0,
        "retry_deadline_at": retry_deadline_at if metadata_scan else None,
    }


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


def _humanised_delay(seconds: float) -> str:
    """Short human label for a retry gap, for the background-jobs description.

    Retry spacing is configurable in seconds, so the old fixed "N min" wording
    reported a 30-second gap as "in 0 min".
    """
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds} s"
    if seconds < 3_600:
        minutes = seconds / 60
        return f"{minutes:.0f} min" if minutes.is_integer() else f"{minutes:.1f} min"
    hours = seconds / 3_600
    return f"{hours:.0f} h" if hours.is_integer() else f"{hours:.1f} h"


def _run_deferred_source_retries(
    job_id: int,
    db: Session,
    jobs: list[dict],
    *,
    batch_size: int,
    worker_count: int,
    stability_seconds: float,
    retry_count: int,
    retry_delay_seconds: int,
    retry_deadline_at: str | None,
) -> None:
    jobs_by_id = {source_job["id"]: source_job for source_job in jobs}
    try:
        deadline = datetime.fromisoformat(retry_deadline_at) if retry_deadline_at else None
        if deadline and deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
    except ValueError:
        deadline = None
    delay_seconds = retry_delay_seconds

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
                    f"{'s' if len(retry_jobs) != 1 else ''} in {_humanised_delay(delay_seconds)}"
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
    retry_delay_seconds: int = 300,
    retry_deadline_at: str | None = None,
) -> None:
    apply_background_thread_priority()
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
                    retry_delay_seconds=retry_delay_seconds,
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
            with _make_process_executor(ProcessPoolExecutor, worker_count) as executor:
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
                source_job = next((item for item in jobs if item["id"] == file_id), None)
                signature = snapshot.get("changed_source_signatures", {}).get(file_id)
                if sf is None or source_job is None:
                    _record_source_adoption_skip(
                        job_id,
                        file_id,
                        reason_code="detached",
                        message="Source was detached from the Cell before update adoption",
                    )
                    continue
                adoption_skip = _source_adoption_skip_reason(db, source_job, sf, signature)
                if adoption_skip is not None:
                    reason_code, reason = adoption_skip
                    _record_source_adoption_skip(
                        job_id,
                        file_id,
                        reason_code=reason_code,
                        message=reason,
                    )
                    continue
                _update_source_check_file(job_id, file_id, status="updating")
                error = None
                try:
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
                        if source_job.get("cell_id") is not None:
                            ready_cell_ids.add(source_job["cell_id"])
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
                    f"Checked {_source_scope_subject(snapshot)} and updated "
                    f"{snapshot.get('updated', 0)} source files"
                    if snapshot.get("update_after_check")
                    else (
                        f"Checked {_source_scope_subject(snapshot)}: "
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
                    f"Checked {_source_scope_subject(snapshot)} and updated "
                    f"{snapshot.get('updated', 0)} changed sources"
                    if snapshot.get("update_after_check")
                    else (
                        f"Checked {_source_scope_subject(snapshot)}: "
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
                    "retry_delay_seconds": snapshot.get("retry_delay_seconds"),
                    "retry_completed": snapshot.get("retry_completed", 0),
                    "retries_stopped": snapshot.get("retries_stopped"),
                    "updated": snapshot.get("updated", 0),
                    "updated_file_ids": snapshot.get("updated_file_ids", []),
                    "ready_cell_ids": snapshot.get("ready_cell_ids", []),
                    "update_errors": snapshot.get("update_errors", []),
                    "source_scope": snapshot.get("source_scope", "all_ordered_sources"),
                    "source_cell_ids": snapshot.get("source_cell_ids", []),
                    "skipped_detached_source_ids": snapshot.get("skipped_detached_source_ids", []),
                    "skipped_adoption_sources": snapshot.get("skipped_adoption_sources", []),
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


def _source_scope_subject(snapshot: dict) -> str:
    if snapshot.get("source_scope") == "tracked_tails":
        count = len(snapshot.get("source_cell_ids") or [])
        return f"current source for {count} cell{'s' if count != 1 else ''}"
    return f"all {snapshot.get('total', 0)} source file{'s' if snapshot.get('total', 0) != 1 else ''}"


def _current_cell_source_chain(db: Session, cell_id: int) -> list[TestFile]:
    cell = (
        db.query(Cell)
        .options(selectinload(Cell.tests).selectinload(Test.file_links))
        .filter(Cell.id == cell_id)
        .one_or_none()
    )
    return _ordered_cell_file_links(cell) if cell is not None else []


def _source_adoption_skip_reason(
    db: Session,
    source_job: dict,
    source_file: SourceFile,
    checked_signature: dict | None,
) -> tuple[str, str] | None:
    """Validate a monitored source before allowing a background update to adopt it."""
    cell_id = source_job.get("cell_id")
    chain = _current_cell_source_chain(db, cell_id) if cell_id is not None else []
    chain_file_ids = [link.file_id for link in chain]
    if source_file.id not in chain_file_ids:
        return "detached", "Source was detached from the Cell before update adoption"
    if not chain_file_ids or chain_file_ids[-1] != source_file.id:
        return "became_historical", "Source became historical before update adoption"
    if source_file.hash != source_job.get("captured_registered_hash", source_job.get("hash")):
        return "registered_identity_changed", "Registered source identity changed before update adoption"
    if source_file.path != source_job.get("path"):
        return "source_changed_again", "Source path changed after the monitored source state"
    if checked_signature is None:
        return "source_changed_again", "The monitored source has no stable physical signature"
    try:
        current_stat = Path(source_file.path).stat()
    except OSError:
        return "source_changed_again", "Source changed again or is no longer readable"
    if (current_stat.st_size, current_stat.st_mtime_ns) != (
        checked_signature.get("size"),
        checked_signature.get("mtime_ns"),
    ):
        return "source_changed_again", "Source changed again after the monitored stable state"
    return None


def _record_source_adoption_skip(
    job_id: int,
    file_id: int,
    *,
    reason_code: str,
    message: str,
) -> None:
    _update_source_check_file(job_id, file_id, status="skipped", error=message)
    background_job_id = None
    with _source_check_job_lock:
        live = _source_check_jobs.get(job_id)
        if live is None:
            return
        background_job_id = live.get("background_job_id")
        live["update_completed"] += 1
        if reason_code == "detached" and file_id not in live["skipped_detached_source_ids"]:
            live["skipped_detached_source_ids"].append(file_id)
        live["skipped_adoption_sources"].append(
            {"file_id": file_id, "reason": reason_code, "message": message}
        )
    if background_job_id is not None:
        background_jobs.record_result(
            background_job_id,
            file_id,
            status="deferred",
            detail=message,
            error=message,
            counter=f"skipped_{reason_code}",
        )


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
    source_scope: SourceScope = "all_ordered_sources",
    low_impact: bool = True,
    retry_count: int = 0,
    retry_delay_seconds: int = 300,
    retry_deadline_at: str | None = None,
) -> dict:
    global _latest_source_check_job_id, _next_source_check_job_id
    contract = _source_check_contract(
        cell_ids=cell_ids,
        source_scope=source_scope,
        include_complete=include_complete,
        update_after_check=update_after_check,
        scan_mode=scan_mode,
        batch_size=batch_size,
        stability_seconds=stability_seconds,
        low_impact=low_impact,
        retry_count=retry_count,
        retry_delay_seconds=retry_delay_seconds,
        retry_deadline_at=retry_deadline_at,
    )
    with _source_check_job_lock:
        if _latest_source_check_job_id is not None:
            current = _source_check_jobs.get(_latest_source_check_job_id)
            if current and current["status"] == "running":
                if current.get("contract") == contract:
                    return deepcopy(current)

    source_files, skipped_complete = _cell_source_files(
        db,
        cell_ids=cell_ids,
        include_complete=include_complete,
        source_scope=source_scope,
    )
    source_cell_ids = sorted(
        {
            source_file.test_link.test.cell_id
            for source_file in source_files
            if source_file.test_link is not None and source_file.test_link.test is not None
        }
    )
    jobs = [
        {
            "id": sf.id,
            "path": sf.path,
            "hash": sf.hash,
            "captured_registered_hash": sf.hash,
            "filename": sf.filename,
            "observed_size": sf.observed_size,
            "observed_mtime_ns": sf.observed_mtime_ns,
            "location_status": sf.location_status,
            "cell_id": sf.test_link.test.cell_id if sf.test_link is not None else None,
        }
        for sf in source_files
    ]
    if scan_mode == "metadata":
        batch_size = max(1, min(int(batch_size), 5000))
        worker_count = max(1, min(len(jobs) or 1, batch_size, 16))
    else:
        worker_count = cell_source_check_worker_count(len(jobs))
    now = datetime.now(timezone.utc).isoformat()
    scope_subject = (
        f"current source for {len(source_cell_ids)} cell{'s' if len(source_cell_ids) != 1 else ''}"
        if source_scope == "tracked_tails"
        else f"all {len(jobs)} source file{'s' if len(jobs) != 1 else ''}"
    )
    background_job_id = background_jobs.create_job(
        kind="source_check_update" if update_after_check else "source_check",
        title="Checking and updating sources" if update_after_check else "Checking sources",
        description=(
            f"Checking {scope_subject}"
            if scan_mode == "metadata"
            else f"Checking {scope_subject}"
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
            "requested_cell_ids": _normalised_source_check_cell_ids(cell_ids),
            "source_scope": source_scope,
            "source_cell_ids": source_cell_ids,
            "skipped_detached_source_ids": [],
            "skipped_adoption_sources": [],
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
            "retry_delay_seconds": retry_delay_seconds,
            "retry_deadline_at": retry_deadline_at,
            "contract": contract,
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
            retry_delay_seconds,
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
        with _make_process_executor(executor_cls, worker_count) as executor:
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
def create_source_check_update_job(
    db: Session = Depends(get_db),
    req: CellSourceCheckRequest | None = Body(default=None),
):
    request = req if isinstance(req, CellSourceCheckRequest) else None
    return start_source_check_job(
        db,
        cell_ids=request.cell_ids if request else None,
        include_complete=request.include_complete if request else False,
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
    cache_hashes_to_remove = result.pop("_cache_hashes_to_remove", [])
    record_activity(
        db,
        category="cell",
        action="delete_cells",
        message=f"Removed {len(result['deleted_cell_ids'])} cells from the database",
        severity="warning",
        details=result,
    )
    db.commit()
    cache_cleanup = start_source_cache_cleanup(cache_hashes_to_remove)
    return {"ok": True, **result, **cache_cleanup}


@router.delete("/cells/{cell_id}")
def delete_cell(cell_id: int, db: Session = Depends(get_db)):
    cell = db.get(Cell, cell_id)
    if cell is None:
        raise HTTPException(404, "No such cell")
    result = delete_cell_from_library(db, cell)
    cache_hashes_to_remove = result.pop("_cache_hashes_to_remove", [])
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
    cache_cleanup = remove_deleted_source_caches(cache_hashes_to_remove)
    return {"ok": True, **result, **cache_cleanup}


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

    metadata_only_sources = [
        {
            "source_file_id": source.id,
            "filename": source.filename,
            "warning": parsing.source_record_capability(source)["warning"],
        }
        for source in files
        if parsing.source_record_metadata_only(source)
    ]
    if metadata_only_sources:
        return {
            "columns": [],
            "rows": [],
            "segments": [],
            "missing": [],
            "capability": {
                "status": "metadata_only",
                "metadata_only": True,
                "canonical_cycling": False,
                "message": (
                    "Cycle data is unavailable because one or more selected sources are metadata-only."
                ),
                "sources": metadata_only_sources,
            },
        }

    from ..services import scanner

    for f in files:
        if f.parse_status in ("unparsed", "error") and Path(f.path).exists():
            scanner.parse_file(db, f)
    refs = analysis_svc.current_source_refs(files)
    stitched, segments, missing = stitch.stitch_cycles(refs, CALC_VERSION)
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
