from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import cache_maintenance
from ..services.activity_log import record_activity

router = APIRouter(prefix="/api/cache", tags=["cache"])


class CacheSettings(BaseModel):
    warmup_enabled: bool = True
    only_when_hidden: bool = False
    idle_seconds: int = Field(default=15, ge=5, le=3600)
    scientific_limit_bytes: int | None = Field(default=10 * 1024**3, ge=0)
    analysis_limit_bytes: int | None = Field(default=1024**3, ge=0)


class CacheCleanupRequest(BaseModel):
    category: str | None = None
    kind: str | None = None
    identifier: str | None = None
    force: bool = False


class WarmupCompletion(BaseModel):
    task_id: str
    status: str = "ready"
    detail: str | None = None
    error: str | None = None


@router.get("/settings", response_model=CacheSettings)
def get_cache_settings(db: Session = Depends(get_db)):
    return cache_maintenance.load_policy(db)


@router.put("/settings", response_model=CacheSettings)
def update_cache_settings(payload: CacheSettings, db: Session = Depends(get_db)):
    policy = cache_maintenance.CachePolicy(**payload.model_dump())
    saved = cache_maintenance.save_policy(db, policy)
    cache_maintenance.enforce_scientific_limit(db, saved.scientific_limit_bytes)
    record_activity(
        db,
        category="settings",
        action="cache_policy_updated",
        message="Cache policy updated.",
    )
    db.commit()
    return saved


@router.get("/inventory")
def get_cache_inventory(limit: int = 20, db: Session = Depends(get_db)):
    return cache_maintenance.inventory(db, offender_limit=limit)


@router.post("/cleanup")
def cleanup_cache(payload: CacheCleanupRequest, db: Session = Depends(get_db)):
    try:
        if payload.category:
            removed = cache_maintenance.cleanup_category(payload.category)
            target = payload.category
        elif payload.kind and payload.identifier:
            removed = cache_maintenance.cleanup_offender(
                db, payload.kind, payload.identifier, force=payload.force
            )
            target = f"{payload.kind}:{payload.identifier}"
        else:
            raise ValueError("Choose a cache category or item to clean")
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    record_activity(
        db,
        category="cache",
        action="cache_cleaned",
        message="Disposable cache data was removed.",
        details={"target": target, "bytes_removed": removed},
    )
    db.commit()
    return {"ok": True, "bytes_removed": removed}


@router.post("/warmup/start")
def start_cache_warmup(db: Session = Depends(get_db)):
    policy = cache_maintenance.load_policy(db)
    if not policy.warmup_enabled:
        raise HTTPException(status_code=409, detail="Background cache preparation is disabled")
    return cache_maintenance.warmup.start(db)


@router.get("/warmup/next")
def next_cache_warmup_task(db: Session = Depends(get_db)):
    return {"task": cache_maintenance.warmup.next_task(db)}


@router.post("/warmup/pause")
def pause_cache_warmup():
    return cache_maintenance.warmup.request_pause()


@router.post("/warmup/resume")
def resume_cache_warmup():
    return cache_maintenance.warmup.resume()


@router.post("/warmup/complete")
def complete_cache_warmup(payload: WarmupCompletion):
    return cache_maintenance.warmup.complete(
        payload.task_id,
        status=payload.status,
        detail=payload.detail,
        error=payload.error,
    )
