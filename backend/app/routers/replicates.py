"""Replicate groups: named references to independent cells plus aggregate preview."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..db import get_db
from ..models import (
    Cell,
    Folder,
    FolderReplicateGroup,
    ReplicateGroup,
    ReplicateGroupCell,
)
from ..services.lazy_module import LazyModule
from .library import cell_capacity_totals


def _load_numpy():
    import numpy

    return numpy


def _load_pandas():
    import pandas

    return pandas


def _load_analysis_engine():
    from ..services import analysis_engine

    return analysis_engine


def _load_cache():
    from ..services import cache as module

    return module


def _load_parsing():
    from ..services import parsing as module

    return module


def _load_scanner():
    from ..services import scanner as module

    return module


def _load_stitch():
    from ..services import stitch as module

    return module


np = LazyModule(_load_numpy)
pd = LazyModule(_load_pandas)
analysis_svc = LazyModule(_load_analysis_engine)
cache = LazyModule(_load_cache)
parsing = LazyModule(_load_parsing)
scanner = LazyModule(_load_scanner)
stitch = LazyModule(_load_stitch)

router = APIRouter(prefix="/api", tags=["replicates"])


class ReplicateGroupCreate(BaseModel):
    name: str
    description: str | None = None
    cell_ids: list[int]
    folder_ids: list[int] = []


class ReplicateGroupUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    cell_ids: list[int] | None = None
    folder_ids: list[int] | None = None


class ReplicateUngroupRequest(BaseModel):
    cell_ids: list[int] | None = None
    group_ids: list[int] | None = None


class ReplicateGroupCellsAdd(BaseModel):
    cell_ids: list[int]


def _avg(values: list[float | None]) -> float | None:
    finite = [float(value) for value in values if value is not None]
    return round(sum(finite) / len(finite), 6) if finite else None


def group_dict(group: ReplicateGroup) -> dict:
    cells = [link.cell for link in sorted(group.cell_links, key=lambda link: link.position)]
    charge_totals = []
    discharge_totals = []
    for cell in cells:
        if not hasattr(cell, "total_charge_capacity_mah") or not hasattr(
            cell, "total_discharge_capacity_mah"
        ):
            totals = cell_capacity_totals(cell)
            cell.total_charge_capacity_mah = totals["total_charge_capacity_mah"]
            cell.total_discharge_capacity_mah = totals["total_discharge_capacity_mah"]
        charge_totals.append(cell.total_charge_capacity_mah)
        discharge_totals.append(cell.total_discharge_capacity_mah)
    return {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "cell_ids": [cell.id for cell in cells],
        "cells": [
            {
                "id": cell.id,
                "name": cell.name,
                "description": cell.description,
                "archived": cell.archived,
                "total_charge_capacity_mah": cell.total_charge_capacity_mah,
                "total_discharge_capacity_mah": cell.total_discharge_capacity_mah,
            }
            for cell in cells
        ],
        "average_total_charge_capacity_mah": _avg(charge_totals),
        "average_total_discharge_capacity_mah": _avg(discharge_totals),
        "folder_ids": [link.folder_id for link in group.folder_links],
        "created_at": group.created_at.isoformat() if group.created_at else "",
    }


def add_group_to_folders(db: Session, group_id: int, folder_ids: list[int]) -> None:
    existing = {
        row[0]
        for row in db.query(FolderReplicateGroup.folder_id)
        .filter(FolderReplicateGroup.group_id == group_id)
        .all()
    }
    for folder_id in folder_ids:
        if folder_id in existing:
            continue
        if db.get(Folder, folder_id) is None:
            raise HTTPException(404, "No such folder")
        position = max(
            (
                row[0]
                for row in db.query(FolderReplicateGroup.position)
                .filter(FolderReplicateGroup.folder_id == folder_id)
                .all()
            ),
            default=-1,
        )
        db.add(FolderReplicateGroup(folder_id=folder_id, group_id=group_id, position=position + 1))


def replace_group_cells(db: Session, group_id: int, cell_ids: list[int]) -> None:
    db.query(ReplicateGroupCell).filter(ReplicateGroupCell.group_id == group_id).delete()
    for position, cell_id in enumerate(dict.fromkeys(cell_ids)):
        if db.get(Cell, cell_id) is None:
            raise HTTPException(404, "No such cell")
        db.add(ReplicateGroupCell(group_id=group_id, cell_id=cell_id, position=position))


def replace_group_folders(db: Session, group_id: int, folder_ids: list[int]) -> None:
    db.query(FolderReplicateGroup).filter(FolderReplicateGroup.group_id == group_id).delete()
    add_group_to_folders(db, group_id, folder_ids)


@router.get("/replicate-groups")
def list_replicate_groups(search: str | None = None, db: Session = Depends(get_db)):
    q = db.query(ReplicateGroup)
    if search:
        needle = f"%{search.strip()}%"
        q = (
            q.outerjoin(ReplicateGroupCell, ReplicateGroupCell.group_id == ReplicateGroup.id)
            .outerjoin(Cell, Cell.id == ReplicateGroupCell.cell_id)
            .filter(
                or_(
                    ReplicateGroup.name.ilike(needle),
                    ReplicateGroup.description.ilike(needle),
                    Cell.name.ilike(needle),
                )
            )
            .distinct()
        )
    return [group_dict(group) for group in q.order_by(ReplicateGroup.name).all()]


@router.post("/replicate-groups")
def create_replicate_group(req: ReplicateGroupCreate, db: Session = Depends(get_db)):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Replicate group needs a name")
    if len(set(req.cell_ids)) < 2:
        raise HTTPException(400, "A replicate group needs at least two cells")
    if db.query(ReplicateGroup).filter(ReplicateGroup.name == name).first() is not None:
        raise HTTPException(409, "Replicate group already exists")
    group = ReplicateGroup(name=name, description=(req.description or "").strip() or None)
    db.add(group)
    db.flush()
    replace_group_cells(db, group.id, req.cell_ids)
    add_group_to_folders(db, group.id, req.folder_ids)
    db.commit()
    db.refresh(group)
    return group_dict(group)


@router.get("/replicate-groups/{group_id}")
def get_replicate_group(group_id: int, db: Session = Depends(get_db)):
    group = db.get(ReplicateGroup, group_id)
    if group is None:
        raise HTTPException(404, "No such replicate group")
    return group_dict(group)


@router.patch("/replicate-groups/{group_id}")
def update_replicate_group(group_id: int, req: ReplicateGroupUpdate, db: Session = Depends(get_db)):
    group = db.get(ReplicateGroup, group_id)
    if group is None:
        raise HTTPException(404, "No such replicate group")
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(400, "Replicate group needs a name")
        duplicate = (
            db.query(ReplicateGroup)
            .filter(ReplicateGroup.name == name, ReplicateGroup.id != group_id)
            .first()
        )
        if duplicate is not None:
            raise HTTPException(409, "Replicate group already exists")
        group.name = name
    if req.description is not None:
        group.description = req.description.strip() or None
    if req.cell_ids is not None:
        if len(set(req.cell_ids)) < 1:
            raise HTTPException(400, "An empty replicate group must be deleted")
        replace_group_cells(db, group.id, req.cell_ids)
    if req.folder_ids is not None:
        replace_group_folders(db, group.id, req.folder_ids)
    db.commit()
    db.refresh(group)
    return group_dict(group)


@router.post("/replicate-groups/{group_id}/cells")
def add_cells_to_replicate_group(
    group_id: int,
    req: ReplicateGroupCellsAdd,
    db: Session = Depends(get_db),
):
    group = db.get(ReplicateGroup, group_id)
    if group is None:
        raise HTTPException(404, "No such replicate group")
    requested_ids = list(dict.fromkeys(req.cell_ids))
    if not requested_ids:
        raise HTTPException(400, "No cells selected")
    for cell_id in requested_ids:
        cell = db.get(Cell, cell_id)
        if cell is None or cell.archived:
            raise HTTPException(404, "No such active cell")

    existing_ids = [
        row[0]
        for row in db.query(ReplicateGroupCell.cell_id)
        .filter(ReplicateGroupCell.group_id == group_id)
        .order_by(ReplicateGroupCell.position, ReplicateGroupCell.id)
        .all()
    ]
    existing = set(existing_ids)
    next_position = max(
        (
            row[0]
            for row in db.query(ReplicateGroupCell.position)
            .filter(ReplicateGroupCell.group_id == group_id)
            .all()
        ),
        default=-1,
    ) + 1
    added_ids = []
    skipped_ids = []
    for cell_id in requested_ids:
        if cell_id in existing:
            skipped_ids.append(cell_id)
            continue
        db.add(ReplicateGroupCell(group_id=group_id, cell_id=cell_id, position=next_position))
        next_position += 1
        added_ids.append(cell_id)
        existing.add(cell_id)
    db.commit()
    db.refresh(group)
    payload = group_dict(group)
    payload["added_cell_ids"] = added_ids
    payload["skipped_cell_ids"] = skipped_ids
    return payload


@router.delete("/replicate-groups/{group_id}")
def delete_replicate_group(group_id: int, db: Session = Depends(get_db)):
    group = db.get(ReplicateGroup, group_id)
    if group is None:
        raise HTTPException(404, "No such replicate group")
    db.delete(group)
    db.commit()
    return {"ok": True}


@router.post("/replicate-groups/ungroup")
def ungroup_replicates(req: ReplicateUngroupRequest, db: Session = Depends(get_db)):
    q = db.query(ReplicateGroupCell)
    if req.group_ids:
        q = q.filter(ReplicateGroupCell.group_id.in_(req.group_ids))
    if req.cell_ids:
        q = q.filter(ReplicateGroupCell.cell_id.in_(req.cell_ids))
    removed = q.delete(synchronize_session=False)
    empty_ids = [
        row[0]
        for row in db.query(ReplicateGroup.id)
        .outerjoin(ReplicateGroupCell, ReplicateGroupCell.group_id == ReplicateGroup.id)
        .filter(ReplicateGroupCell.id.is_(None))
        .all()
    ]
    if empty_ids:
        db.query(ReplicateGroup).filter(ReplicateGroup.id.in_(empty_ids)).delete(
            synchronize_session=False
        )
    db.commit()
    return {"removed": removed, "deleted_empty_groups": empty_ids}


def cell_cycle_frame(db: Session, cell: Cell) -> pd.DataFrame:
    hashes, files = analysis_svc.cell_ordered_hashes(db, cell)
    for sf in files:
        if sf.parse_status in ("unparsed", "error") and Path(sf.path).exists():
            scanner.parse_file(db, sf)
    stitched, _segments, _missing = stitch.stitch_cycles(
        hashes, parsing.PARSER_VERSION, CALC_VERSION
    )
    return stitched.replace({np.nan: None}).drop(columns=["start_timestamp"], errors="ignore")


def preview_from_cycle_frames(frames: list[dict], quantity: str) -> dict:
    series = []
    long_rows = []
    cycle_counts = []
    initial_values = []
    max_values = []
    final_values = []
    total_charge_values = []
    total_discharge_values = []
    for item in frames:
        df = item["rows"]
        if df.empty or "cycle" not in df.columns or quantity not in df.columns:
            continue
        if "charge_capacity_mah" in df.columns:
            charge = df["charge_capacity_mah"].dropna()
            if not charge.empty:
                total_charge_values.append(float(charge.sum()))
        if "discharge_capacity_mah" in df.columns:
            discharge = df["discharge_capacity_mah"].dropna()
            if not discharge.empty:
                total_discharge_values.append(float(discharge.sum()))
        values = df[["cycle", quantity]].dropna()
        if values.empty:
            continue
        x = [int(v) for v in values["cycle"]]
        y = [float(v) for v in values[quantity]]
        series.append({"cell_id": item["cell_id"], "cell_name": item["cell_name"], "x": x, "y": y})
        cycle_counts.append(len(values))
        initial_values.append(y[0])
        max_values.append(max(y))
        final_values.append(y[-1])
        for cycle, value in zip(x, y):
            long_rows.append({"cycle": cycle, "value": value})

    if long_rows:
        long = pd.DataFrame(long_rows)
        grouped = long.groupby("cycle")["value"]
        aggregate = {
            "cycle": [int(v) for v in grouped.mean().index],
            "mean": [float(v) for v in grouped.mean().values],
            "median": [float(v) for v in grouped.median().values],
            "q1": [float(v) for v in grouped.quantile(0.25).values],
            "q3": [float(v) for v in grouped.quantile(0.75).values],
            "min": [float(v) for v in grouped.min().values],
            "max": [float(v) for v in grouped.max().values],
            "std": [None if pd.isna(v) else float(v) for v in grouped.std().values],
            "count": [int(v) for v in grouped.count().values],
        }
    else:
        aggregate = {
            "cycle": [],
            "mean": [],
            "median": [],
            "q1": [],
            "q3": [],
            "min": [],
            "max": [],
            "std": [],
            "count": [],
        }

    def avg(values: list[float]) -> float | None:
        return round(float(sum(values) / len(values)), 6) if values else None

    return {
        "quantity": quantity,
        "series": series,
        "aggregate": aggregate,
        "stats": {
            "n_cells": len(frames),
            "n_plotted_cells": len(series),
            "average_cycle_count": avg(cycle_counts),
            "average_initial_capacity": avg(initial_values),
            "average_max_capacity": avg(max_values),
            "average_final_capacity": avg(final_values),
            "average_total_charge_capacity": avg(total_charge_values),
            "average_total_discharge_capacity": avg(total_discharge_values),
        },
    }


@router.get("/replicate-groups/{group_id}/preview")
def replicate_group_preview(
    group_id: int,
    quantity: str = "discharge_capacity_mah",
    db: Session = Depends(get_db),
):
    group = db.get(ReplicateGroup, group_id)
    if group is None:
        raise HTTPException(404, "No such replicate group")
    frames = [
        {"cell_id": link.cell.id, "cell_name": link.cell.name, "rows": cell_cycle_frame(db, link.cell)}
        for link in sorted(group.cell_links, key=lambda row: row.position)
    ]
    return preview_from_cycle_frames(frames, quantity)
