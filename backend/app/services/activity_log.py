from __future__ import annotations

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
) -> ActivityEvent:
    event = ActivityEvent(
        category=category,
        action=action,
        message=message,
        severity=severity,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details or None,
    )
    db.add(event)
    db.flush()
    return event
