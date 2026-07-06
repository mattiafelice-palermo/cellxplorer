"""Flat faceted layer: central tag registry and collections (no nesting)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AnalysisCollection, AnalysisTag, CellTag, Collection, Tag

router = APIRouter(prefix="/api", tags=["facets"])


@router.get("/tags")
def list_tags(db: Session = Depends(get_db)):
    tags = db.query(Tag).order_by(Tag.name).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "n_cells": db.query(CellTag).filter(CellTag.tag_id == t.id).count(),
            "n_analyses": db.query(AnalysisTag).filter(AnalysisTag.tag_id == t.id).count(),
        }
        for t in tags
    ]


class TagCreate(BaseModel):
    name: str


@router.post("/tags")
def create_tag(req: TagCreate, db: Session = Depends(get_db)):
    """Creating a tag is deliberate — the UI confirms before calling this."""
    name = req.name.strip()
    if not name:
        raise HTTPException(422, "Empty tag name")
    if db.query(Tag).filter(Tag.name == name).first():
        raise HTTPException(409, "Tag already exists")
    t = Tag(name=name)
    db.add(t)
    db.commit()
    return {"id": t.id, "name": t.name}


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, db: Session = Depends(get_db)):
    t = db.get(Tag, tag_id)
    if t is None:
        raise HTTPException(404, "No such tag")
    db.delete(t)
    db.commit()
    return {"ok": True}


@router.get("/collections")
def list_collections(db: Session = Depends(get_db)):
    cols = db.query(Collection).order_by(Collection.name).all()
    return [
        {
            "id": c.id,
            "name": c.name,
            "n_analyses": db.query(AnalysisCollection)
            .filter(AnalysisCollection.collection_id == c.id)
            .count(),
        }
        for c in cols
    ]


class CollectionCreate(BaseModel):
    name: str


@router.post("/collections")
def create_collection(req: CollectionCreate, db: Session = Depends(get_db)):
    name = req.name.strip()
    if db.query(Collection).filter(Collection.name == name).first():
        raise HTTPException(409, "Collection already exists")
    c = Collection(name=name)
    db.add(c)
    db.commit()
    return {"id": c.id, "name": c.name}


@router.delete("/collections/{collection_id}")
def delete_collection(collection_id: int, db: Session = Depends(get_db)):
    c = db.get(Collection, collection_id)
    if c is None:
        raise HTTPException(404, "No such collection")
    db.delete(c)
    db.commit()
    return {"ok": True}
