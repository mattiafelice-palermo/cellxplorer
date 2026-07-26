"""Background-automation pause state (source monitor + cache warmup)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..models import AppSetting

PAUSE_KEY = "automation_paused_until"
MAX_PAUSE_MINUTES = 7 * 24 * 60


def _get(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def _set(db: Session, key: str, value: str | None) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def _parse_until(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        value = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def pause_state(db: Session) -> dict:
    """Return the current pause state. Expiry is implicit from the timestamp."""
    until = _parse_until(_get(db, PAUSE_KEY))
    now = datetime.now(timezone.utc)
    if until is None or until <= now:
        return {"paused": False, "paused_until": None, "seconds_remaining": None}
    remaining = max(0, int((until - now).total_seconds()))
    return {
        "paused": True,
        "paused_until": until.isoformat(),
        "seconds_remaining": remaining,
    }


def is_paused(db: Session) -> bool:
    return bool(pause_state(db)["paused"])


def set_pause(db: Session, minutes: int | None) -> dict:
    """Pause for `minutes` from now, or resume when minutes is None/0."""
    if minutes is None or int(minutes) <= 0:
        _set(db, PAUSE_KEY, None)
        db.commit()
        return pause_state(db)
    safe = max(1, min(int(minutes), MAX_PAUSE_MINUTES))
    until = datetime.now(timezone.utc) + timedelta(minutes=safe)
    _set(db, PAUSE_KEY, until.isoformat())
    db.commit()
    return pause_state(db)
