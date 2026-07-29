from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import cache_maintenance, scanner
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
        cleanup_details: dict = {}
        if payload.category == "scientific":
            cleanup_details = cache_maintenance.cleanup_eligible_scientific(db)
            removed = cleanup_details["bytes_removed"]
            target = payload.category
        elif payload.category:
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
    return {"ok": True, "bytes_removed": removed, **cleanup_details}


@router.post("/scientific/prepare")
def prepare_scientific_cache():
    return scanner.start_capacity_summary_backfill(
        prepare_missing=True,
    )


def _require_warmup_enabled(db: Session) -> None:
    if not cache_maintenance.load_policy(db).warmup_enabled:
        raise HTTPException(
            status_code=409,
            detail="Background cache preparation is disabled",
        )


def _begin_saved_plot_rebuild() -> None:
    if not cache_maintenance.warmup.cancel_pending_for_rebuild():
        raise HTTPException(
            status_code=409,
            detail=(
                "A saved plot is still being prepared. Wait for that plot to finish, "
                "then start the rebuild again."
            ),
        )


@router.post("/thumbnails/rebuild")
def rebuild_thumbnails(db: Session = Depends(get_db)):
    _require_warmup_enabled(db)
    _begin_saved_plot_rebuild()
    removed = cache_maintenance.cleanup_category("thumbnails")
    job = cache_maintenance.warmup.start(db, force=True)
    return {"bytes_removed": removed, "job": job}


@router.post("/saved-plots/rebuild")
def rebuild_saved_plots(db: Session = Depends(get_db)):
    _require_warmup_enabled(db)
    _begin_saved_plot_rebuild()
    removed = cache_maintenance.cleanup_category("analysis_results")
    removed += cache_maintenance.cleanup_category("analysis_artifacts")
    removed += cache_maintenance.cleanup_category("thumbnails")
    job = cache_maintenance.warmup.start(db, force=True)
    return {"bytes_removed": removed, "job": job}


@router.post("/warmup/start")
def start_cache_warmup(force: bool = False, db: Session = Depends(get_db)):
    _require_warmup_enabled(db)
    return cache_maintenance.warmup.start(db, force=force)


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
def complete_cache_warmup(payload: WarmupCompletion, db: Session = Depends(get_db)):
    return cache_maintenance.warmup.complete(
        payload.task_id,
        status=payload.status,
        detail=payload.detail,
        error=payload.error,
        db=db,
    )
