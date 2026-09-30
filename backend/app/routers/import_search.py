"""Local indexed discovery; selected paths use the existing import pipeline."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import SourceFile
from ..services.import_search_catalog import path_key
from ..services.import_search_index import get_indexer, load_config, save_config

router = APIRouter(prefix="/api/import-search", tags=["file search"])


@router.get("/settings")
def settings(db: Session = Depends(get_db)):
    service = get_indexer()
    return {"config": load_config(db), "roots": service.root_snapshots(), "revision": service.revision}


@router.put("/settings")
def update_settings(value: dict, db: Session = Depends(get_db)):
    service = get_indexer()
    with service.lock:
        try:
            config = save_config(db, value)
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        service.configure(config)
    return {"config": config, "roots": service.root_snapshots(), "revision": service.revision}


@router.post("/refresh")
def refresh(value: dict):
    get_indexer().refresh(value.get("root_id"), due_only=bool(value.get("due_only", False)))
    return {"queued": True}


@router.post("/rebuild")
def rebuild():
    get_indexer().rebuild()
    return {"queued": True}


@router.get("/results")
def results(q: str = Query("", max_length=512), root_id: str | None = None,
            extension: str | None = None, supplier: str | None = None, technique: str | None = None,
            offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200), db: Session = Depends(get_db)):
    service = get_indexer()
    config = load_config(db)
    result = service.catalog.search(config, query=q, root_id=root_id, extension=extension,
                                    supplier=supplier, technique=technique, offset=offset, limit=limit)
    # Pure strings from local storage; no stat/header/hash per search request.
    states = {row["id"]: row for row in service.catalog.roots(counts=False)}
    aliases_by_item = []
    for item in result["items"]:
        aliases = {path_key(item["path"]), item["canonical"]}
        for root in config["roots"]:
            canonical = states.get(root["id"], {}).get("canonical_root")
            if canonical and item["canonical"].startswith(canonical + "\\"):
                aliases.add(path_key(root["path"]) + item["canonical"][len(canonical):])
        aliases_by_item.append(aliases)
    candidates = set().union(*aliases_by_item) if aliases_by_item else set()
    registered = set()
    if candidates:
        # SQLite filters paths without transferring/materializing the entire library.
        # Keep Unicode casefold and Windows alias semantics; SQLite lower() is ASCII-only.
        connection = db.connection().connection.driver_connection
        connection.create_function("search_path_key", 1, path_key, deterministic=True)
        registered = {path_key(path) for path, in db.query(SourceFile.path).filter(func.search_path_key(SourceFile.path).in_(candidates))}
    for item, aliases in zip(result["items"], aliases_by_item):
        item["registered"] = bool(aliases & registered)
    result["roots"] = list(states.values())
    result["techniques"] = service.catalog.techniques(config, root_id)
    return result
