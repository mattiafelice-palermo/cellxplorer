from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import ActivityEvent
from ..services import background_jobs

router = APIRouter(prefix="/api", tags=["activity"])


def activity_dict(event: ActivityEvent) -> dict:
    return {
        "id": event.id,
        "category": event.category,
        "action": event.action,
        "message": event.message,
        "severity": event.severity,
        "entity_type": event.entity_type,
        "entity_id": event.entity_id,
        "details": event.details or {},
        "started_at": (event.started_at or event.created_at).isoformat(),
        "finished_at": (event.finished_at or event.created_at).isoformat(),
        "created_at": event.created_at.isoformat(),
    }


@router.get("/activity")
def list_activity(limit: int = 80, db: Session = Depends(get_db)):
    safe_limit = max(1, min(int(limit or 80), 300))
    rows = (
        db.query(ActivityEvent)
        .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
        .limit(safe_limit)
        .all()
    )
    return [activity_dict(row) for row in rows]


@router.get("/background-jobs")
def list_background_jobs(limit: int = 20):
    return background_jobs.list_jobs(limit=limit)
