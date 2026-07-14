from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import ActivityEvent


def record_activity(
    db: Session,
    *,
    category: str,
    action: str,
    message: str,
    severity: str = "info",
    entity_type: str | None = None,
    entity_id: int | None = None,
    details: dict | None = None,
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
) -> ActivityEvent:
    now = datetime.now(timezone.utc)
    event = ActivityEvent(
        category=category,
        action=action,
        message=message,
        severity=severity,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details or None,
        started_at=started_at or now,
        finished_at=finished_at or now,
    )
    db.add(event)
    db.flush()
    return event
