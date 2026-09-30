"""Local indexed discovery; selected paths use the existing import pipeline."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import SourceFile
from ..models import AppSetting
from ..services.import_search_catalog import path_key
from ..services.import_search_filters import filtered_search, library_snapshot, validate_filters
import json
from ..services.import_search_index import get_indexer, load_config, save_config

router = APIRouter(prefix="/api/import-search", tags=["file search"])


@router.post("/query")
def query_sources(value: dict, db: Session = Depends(get_db)):
    query = value.get("q", "")
    offset, limit = value.get("offset", 0), value.get("limit", 100)
    if not isinstance(query, str) or len(query) > 512 or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise HTTPException(400, "Invalid search query or page")
    service = get_indexer()
    config = load_config(db)
    states = service.catalog.roots(counts=False)
    try:
        filters = validate_filters(value.get("filters"))
        library, options = library_snapshot(db, states)
        result = filtered_search(service.catalog, config, query, filters, offset, limit, library)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    result.update(roots=states, relationships=options, techniques=service.catalog.techniques(config, filters.get("root_id")))
    return result


@router.get("/presets")
def presets(db: Session = Depends(get_db)):
    row = db.get(AppSetting, "import_search_presets")
    try:
        value = json.loads(row.value) if row else []
        return value if isinstance(value, list) and all(isinstance(item, dict) for item in value) else []
    except (ValueError, TypeError):
        return []


@router.put("/presets")
def save_presets(value: list[dict], db: Session = Depends(get_db)):
    if len(value) > 30:
        raise HTTPException(400, "Save at most 30 searches")
    ids = set()
    for item in value:
        if not isinstance(item.get("id"), str) or not 1 <= len(item["id"]) <= 64 or item["id"] in ids or not isinstance(item.get("name"), str) or not 1 <= len(item["name"].strip()) <= 80:
            raise HTTPException(400, "Invalid saved search name or identity")
        if not isinstance(item.get("q", ""), str) or len(item.get("q", "")) > 512:
            raise HTTPException(400, "Invalid saved search query")
        try:
            item["filters"] = validate_filters(item.get("filters"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        ids.add(item["id"])
        item["name"] = item["name"].strip()
    row = db.get(AppSetting, "import_search_presets")
    if row:
        row.value = json.dumps(value)
    else:
        db.add(AppSetting(key="import_search_presets", value=json.dumps(value)))
    db.commit()
    return value


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
