"""THE one data tree: folders and projects, plus groups and project cells.

Folders organize; they never compute. A folder contains an analysis, it
never feeds one — nothing in this router links folders to cells or scope.
"""
from __future__ import annotations

import copy

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (
    Analysis,
    Cell,
    Folder,
    FolderCell,
    FolderReplicateGroup,
    Group,
    GroupCell,
    Project,
    ProjectCell,
    ReplicateGroup,
)

router = APIRouter(prefix="/api", tags=["tree"])


def group_dict(g: Group) -> dict:
    return {
        "id": g.id,
        "project_id": g.project_id,
        "name": g.name,
        "color": g.color,
        "position": g.position,
        "cell_ids": [l.cell_id for l in sorted(g.cell_links, key=lambda l: l.position)],
    }


def project_dict(p: Project, analyses: list[Analysis]) -> dict:
    return {
        "id": p.id,
        "type": "project",
        "folder_id": p.folder_id,
        "name": p.name,
        "description": p.description,
        "cell_ids": [l.cell_id for l in p.cell_links],
        "groups": [group_dict(g) for g in p.groups],
        "analyses": [{"id": a.id, "title": a.title} for a in analyses if a.project_id == p.id],
    }


def cell_ref_dict(c: Cell) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "description": c.description,
        "archived": c.archived,
    }


def replicate_group_ref_dict(group: ReplicateGroup) -> dict:
    return {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "cell_ids": [link.cell_id for link in sorted(group.cell_links, key=lambda link: link.position)],
    }


def folder_dict(
    folder: Folder,
    folders: list[Folder],
    folder_cells: list[FolderCell],
    folder_groups: list[FolderReplicateGroup],
    cells: list[Cell],
    replicate_groups: list[ReplicateGroup],
    analyses: list[Analysis],
    projects: list[Project],
) -> dict:
    cells_by_id = {c.id: c for c in cells}
    ordered_links = sorted(
        (link for link in folder_cells if link.folder_id == folder.id),
        key=lambda link: (link.position, link.id or 0),
    )
    folder_cell_ids = [link.cell_id for link in ordered_links]
    return {
        "id": folder.id,
        "type": "folder",
        "name": folder.name,
        "parent_id": folder.parent_id,
        "cell_ids": folder_cell_ids,
        "cells": [
            cell_ref_dict(cells_by_id[link.cell_id])
            for link in ordered_links
            if link.cell_id in cells_by_id
        ],
        "replicate_groups": [
            replicate_group_ref_dict(link.group)
            for link in sorted(
                (link for link in folder_groups if link.folder_id == folder.id),
                key=lambda link: (link.position, link.id or 0),
            )
            if link.group is not None
        ],
        "children": [
            folder_dict(child, folders, folder_cells, folder_groups, cells, replicate_groups, analyses, projects)
            for child in folders
            if child.parent_id == folder.id
        ],
        "projects": [project_dict(p, analyses) for p in projects if p.folder_id == folder.id],
        "analyses": [
            {"id": a.id, "title": a.title}
            for a in analyses
            if a.folder_id == folder.id and a.project_id is None
        ],
    }


def folder_contains(db: Session, folder_id: int, possible_child_id: int) -> bool:
    current = db.get(Folder, possible_child_id)
    while current is not None and current.parent_id is not None:
        if current.parent_id == folder_id:
            return True
        current = db.get(Folder, current.parent_id)
    return False


def next_folder_cell_position(db: Session, folder_id: int) -> int:
    current = [
        row[0]
        for row in db.query(FolderCell.position).filter(FolderCell.folder_id == folder_id).all()
    ]
    return max(current, default=-1) + 1


def next_folder_group_position(db: Session, folder_id: int) -> int:
    current = [
        row[0]
        for row in db.query(FolderReplicateGroup.position)
        .filter(FolderReplicateGroup.folder_id == folder_id)
        .all()
    ]
    return max(current, default=-1) + 1


def add_cell_refs(db: Session, folder_id: int, cell_ids: list[int]) -> None:
    if db.get(Folder, folder_id) is None:
        raise HTTPException(404, "No such folder")
    existing = {
        row[0] for row in db.query(FolderCell.cell_id).filter(FolderCell.folder_id == folder_id).all()
    }
    position = next_folder_cell_position(db, folder_id)
    for cid in cell_ids:
        if cid not in existing and db.get(Cell, cid) is not None:
            db.add(FolderCell(folder_id=folder_id, cell_id=cid, position=position))
            existing.add(cid)
            position += 1


def add_group_refs(db: Session, folder_id: int, group_ids: list[int]) -> None:
    if db.get(Folder, folder_id) is None:
        raise HTTPException(404, "No such folder")
    existing = {
        row[0]
        for row in db.query(FolderReplicateGroup.group_id)
        .filter(FolderReplicateGroup.folder_id == folder_id)
        .all()
    }
    position = next_folder_group_position(db, folder_id)
    for group_id in group_ids:
        if group_id not in existing and db.get(ReplicateGroup, group_id) is not None:
            db.add(FolderReplicateGroup(folder_id=folder_id, group_id=group_id, position=position))
            existing.add(group_id)
            position += 1


def move_folder_cells(
    db: Session, source_folder_id: int, target_folder_id: int, cell_ids: list[int]
) -> None:
    if db.get(Folder, source_folder_id) is None or db.get(Folder, target_folder_id) is None:
        raise HTTPException(404, "No such folder")
    add_cell_refs(db, target_folder_id, cell_ids)
    db.query(FolderCell).filter(
        FolderCell.folder_id == source_folder_id,
        FolderCell.cell_id.in_(cell_ids),
    ).delete(synchronize_session=False)


def move_folder_groups(
    db: Session, source_folder_id: int, target_folder_id: int, group_ids: list[int]
) -> None:
    if db.get(Folder, source_folder_id) is None or db.get(Folder, target_folder_id) is None:
        raise HTTPException(404, "No such folder")
    add_group_refs(db, target_folder_id, group_ids)
    db.query(FolderReplicateGroup).filter(
        FolderReplicateGroup.folder_id == source_folder_id,
        FolderReplicateGroup.group_id.in_(group_ids),
    ).delete(synchronize_session=False)


def copy_folder_tree(db: Session, folder_id: int, parent_id: int | None) -> Folder:
    source = db.get(Folder, folder_id)
    if source is None:
        raise HTTPException(404, "No such folder")
    if parent_id is not None and db.get(Folder, parent_id) is None:
        raise HTTPException(404, "No such parent folder")

    def clone_folder(src: Folder, dst_parent_id: int | None, top: bool) -> Folder:
        copied = Folder(
            name=f"{src.name} copy" if top else src.name,
            parent_id=dst_parent_id,
            position=src.position,
        )
        db.add(copied)
        db.flush()
        for link in db.query(FolderCell).filter(FolderCell.folder_id == src.id).order_by(FolderCell.position).all():
            db.add(FolderCell(folder_id=copied.id, cell_id=link.cell_id, position=link.position))
        for link in (
            db.query(FolderReplicateGroup)
            .filter(FolderReplicateGroup.folder_id == src.id)
            .order_by(FolderReplicateGroup.position)
            .all()
        ):
            db.add(
                FolderReplicateGroup(
                    folder_id=copied.id,
                    group_id=link.group_id,
                    position=link.position,
                )
            )
        for analysis in db.query(Analysis).filter(
            Analysis.folder_id == src.id, Analysis.project_id.is_(None)
        ).all():
            db.add(
                Analysis(
                    title=f"{analysis.title} copy",
                    folder_id=copied.id,
                    project_id=None,
                    spec=copy.deepcopy(analysis.spec),
                    provenance=copy.deepcopy(analysis.provenance),
                )
            )
        for child in db.query(Folder).filter(Folder.parent_id == src.id).order_by(Folder.position, Folder.name).all():
            clone_folder(child, copied.id, False)
        return copied

    return clone_folder(source, parent_id, True)


@router.get("/tree")
def get_tree(db: Session = Depends(get_db)):
    folders = db.query(Folder).order_by(Folder.position, Folder.name).all()
    projects = db.query(Project).order_by(Project.position, Project.name).all()
    cells = db.query(Cell).order_by(Cell.name).all()
    replicate_groups = db.query(ReplicateGroup).order_by(ReplicateGroup.name).all()
    analyses = db.query(Analysis).all()
    folder_cells = db.query(FolderCell).order_by(FolderCell.position, FolderCell.id).all()
    folder_groups = db.query(FolderReplicateGroup).order_by(
        FolderReplicateGroup.position, FolderReplicateGroup.id
    ).all()

    def children_of(parent_id: int | None) -> list[dict]:
        return [
            folder_dict(f, folders, folder_cells, folder_groups, cells, replicate_groups, analyses, projects)
            for f in folders
            if f.parent_id == parent_id
        ]

    return {
        "folders": children_of(None),
        "projects": [project_dict(p, analyses) for p in projects if p.folder_id is None],
    }


class FolderCreate(BaseModel):
    name: str
    parent_id: int | None = None


@router.post("/folders")
def create_folder(req: FolderCreate, db: Session = Depends(get_db)):
    f = Folder(name=req.name.strip(), parent_id=req.parent_id)
    db.add(f)
    db.commit()
    return {"id": f.id, "name": f.name, "parent_id": f.parent_id}


class FolderUpdate(BaseModel):
    name: str | None = None
    parent_id: int | None = None
    move_to_root: bool = False


@router.patch("/folders/{folder_id}")
def update_folder(folder_id: int, req: FolderUpdate, db: Session = Depends(get_db)):
    f = db.get(Folder, folder_id)
    if f is None:
        raise HTTPException(404, "No such folder")
    if req.name is not None:
        f.name = req.name.strip()
    if req.move_to_root:
        f.parent_id = None
    elif req.parent_id is not None:
        if req.parent_id == folder_id:
            raise HTTPException(422, "A folder cannot contain itself")
        if db.get(Folder, req.parent_id) is None:
            raise HTTPException(404, "No such parent folder")
        if folder_contains(db, folder_id, req.parent_id):
            raise HTTPException(422, "A folder cannot be moved inside one of its children")
        f.parent_id = req.parent_id
    db.commit()
    return {"ok": True}


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db)):
    f = db.get(Folder, folder_id)
    if f is None:
        raise HTTPException(404, "No such folder")
    parent_id = f.parent_id
    # Deleting a folder never deletes scientific data. Child folders and
    # filed items move up one level; root-level folder cells become unfiled.
    db.query(Folder).filter(Folder.parent_id == folder_id).update({"parent_id": parent_id})
    db.query(Project).filter(Project.folder_id == folder_id).update({"folder_id": parent_id})
    db.query(Analysis).filter(Analysis.folder_id == folder_id).update({"folder_id": parent_id})
    if parent_id is None:
        db.query(FolderCell).filter(FolderCell.folder_id == folder_id).delete()
        db.query(FolderReplicateGroup).filter(FolderReplicateGroup.folder_id == folder_id).delete()
    else:
        existing = {
            row[0]
            for row in db.query(FolderCell.cell_id).filter(FolderCell.folder_id == parent_id).all()
        }
        for link in db.query(FolderCell).filter(FolderCell.folder_id == folder_id).all():
            if link.cell_id in existing:
                db.delete(link)
            else:
                link.folder_id = parent_id
        existing_groups = {
            row[0]
            for row in db.query(FolderReplicateGroup.group_id)
            .filter(FolderReplicateGroup.folder_id == parent_id)
            .all()
        }
        for link in db.query(FolderReplicateGroup).filter(FolderReplicateGroup.folder_id == folder_id).all():
            if link.group_id in existing_groups:
                db.delete(link)
            else:
                link.folder_id = parent_id
    db.delete(f)
    db.commit()
    return {"ok": True}


class CellIds(BaseModel):
    cell_ids: list[int]


class GroupIds(BaseModel):
    group_ids: list[int]


@router.post("/folders/{folder_id}/cells")
def add_folder_cells(folder_id: int, req: CellIds, db: Session = Depends(get_db)):
    add_cell_refs(db, folder_id, req.cell_ids)
    db.commit()
    return {"ok": True}


@router.post("/folders/{folder_id}/replicate-groups")
def add_folder_groups(folder_id: int, req: GroupIds, db: Session = Depends(get_db)):
    add_group_refs(db, folder_id, req.group_ids)
    db.commit()
    return {"ok": True}


class CellTransfer(BaseModel):
    source_folder_id: int
    cell_ids: list[int]


class GroupTransfer(BaseModel):
    source_folder_id: int
    group_ids: list[int]


@router.post("/folders/{folder_id}/cells/copy")
def copy_folder_cells(folder_id: int, req: CellTransfer, db: Session = Depends(get_db)):
    if db.get(Folder, req.source_folder_id) is None:
        raise HTTPException(404, "No such source folder")
    add_cell_refs(db, folder_id, req.cell_ids)
    db.commit()
    return {"ok": True}


@router.post("/folders/{folder_id}/replicate-groups/copy")
def copy_folder_groups(folder_id: int, req: GroupTransfer, db: Session = Depends(get_db)):
    if db.get(Folder, req.source_folder_id) is None:
        raise HTTPException(404, "No such source folder")
    add_group_refs(db, folder_id, req.group_ids)
    db.commit()
    return {"ok": True}


@router.post("/folders/{folder_id}/cells/move")
def move_folder_cells_endpoint(folder_id: int, req: CellTransfer, db: Session = Depends(get_db)):
    move_folder_cells(db, req.source_folder_id, folder_id, req.cell_ids)
    db.commit()
    return {"ok": True}


@router.post("/folders/{folder_id}/replicate-groups/move")
def move_folder_groups_endpoint(folder_id: int, req: GroupTransfer, db: Session = Depends(get_db)):
    move_folder_groups(db, req.source_folder_id, folder_id, req.group_ids)
    db.commit()
    return {"ok": True}


@router.delete("/folders/{folder_id}/cells/{cell_id}")
def remove_folder_cell(folder_id: int, cell_id: int, db: Session = Depends(get_db)):
    db.query(FolderCell).filter(
        FolderCell.folder_id == folder_id, FolderCell.cell_id == cell_id
    ).delete()
    db.commit()
    return {"ok": True}


@router.delete("/folders/{folder_id}/replicate-groups/{group_id}")
def remove_folder_group(folder_id: int, group_id: int, db: Session = Depends(get_db)):
    db.query(FolderReplicateGroup).filter(
        FolderReplicateGroup.folder_id == folder_id,
        FolderReplicateGroup.group_id == group_id,
    ).delete()
    db.commit()
    return {"ok": True}


class FolderCopyRequest(BaseModel):
    parent_id: int | None = None


@router.post("/folders/{folder_id}/copy")
def copy_folder(folder_id: int, req: FolderCopyRequest, db: Session = Depends(get_db)):
    copied = copy_folder_tree(db, folder_id, req.parent_id)
    db.commit()
    return {"id": copied.id, "name": copied.name, "parent_id": copied.parent_id}


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    folder_id: int | None = None


@router.post("/projects")
def create_project(req: ProjectCreate, db: Session = Depends(get_db)):
    p = Project(name=req.name.strip(), description=req.description, folder_id=req.folder_id)
    db.add(p)
    db.commit()
    return {"id": p.id, "name": p.name}


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    folder_id: int | None = None
    move_to_root: bool = False


@router.patch("/projects/{project_id}")
def update_project(project_id: int, req: ProjectUpdate, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "No such project")
    if req.name is not None:
        p.name = req.name.strip()
    if req.description is not None:
        p.description = req.description
    if req.move_to_root:
        p.folder_id = None
    elif req.folder_id is not None:
        p.folder_id = req.folder_id
    db.commit()
    return {"ok": True}


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "No such project")
    # membership rows go; cells themselves are untouched (references only),
    # filed analyses become homeless
    db.query(Analysis).filter(Analysis.project_id == project_id).update({"project_id": None})
    db.delete(p)
    db.commit()
    return {"ok": True}


@router.post("/projects/{project_id}/cells")
def add_project_cells(project_id: int, req: CellIds, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "No such project")
    existing = {l.cell_id for l in p.cell_links}
    for cid in req.cell_ids:
        if cid not in existing and db.get(Cell, cid) is not None:
            db.add(ProjectCell(project_id=project_id, cell_id=cid))
    db.commit()
    return {"ok": True}


@router.delete("/projects/{project_id}/cells/{cell_id}")
def remove_project_cell(project_id: int, cell_id: int, db: Session = Depends(get_db)):
    # removing a cell from a project is irrelevant to analyses — they
    # reference cells directly, not membership
    db.query(ProjectCell).filter(
        ProjectCell.project_id == project_id, ProjectCell.cell_id == cell_id
    ).delete()
    db.commit()
    return {"ok": True}


class GroupCreate(BaseModel):
    name: str
    color: str | None = None
    cell_ids: list[int] = []


@router.post("/projects/{project_id}/groups")
def create_group(project_id: int, req: GroupCreate, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "No such project")
    g = Group(project_id=project_id, name=req.name.strip(), color=req.color,
              position=max((x.position for x in p.groups), default=-1) + 1)
    db.add(g)
    db.flush()
    for i, cid in enumerate(req.cell_ids):
        db.add(GroupCell(group_id=g.id, cell_id=cid, position=i))
    db.commit()
    return group_dict(g)


class GroupUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    cell_ids: list[int] | None = None  # full ordered replacement


@router.patch("/groups/{group_id}")
def update_group(group_id: int, req: GroupUpdate, db: Session = Depends(get_db)):
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(404, "No such group")
    if req.name is not None:
        g.name = req.name.strip()
    if req.color is not None:
        g.color = req.color
    if req.cell_ids is not None:
        db.query(GroupCell).filter(GroupCell.group_id == group_id).delete()
        for i, cid in enumerate(req.cell_ids):
            db.add(GroupCell(group_id=group_id, cell_id=cid, position=i))
    db.commit()
    db.refresh(g)
    return group_dict(g)


@router.delete("/groups/{group_id}")
def delete_group(group_id: int, db: Session = Depends(get_db)):
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(404, "No such group")
    db.delete(g)
    db.commit()
    return {"ok": True}
