"""Durable state for one-time scientific-cache preparation after library copy."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..models import AppSetting

SCIENTIFIC_PREPARATION_KEY = "beta.scientific_preparation"
SCIENTIFIC_PREPARATION_SCHEMA_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def pending_value() -> str:
    """Return the value written into a staged database before activation."""
    return json.dumps(
        {
            "schemaVersion": SCIENTIFIC_PREPARATION_SCHEMA_VERSION,
            "status": "pending",
            "reason": "stable-copy",
            "createdAt": _now(),
        },
        separators=(",", ":"),
    )


def get_state(db: Session) -> dict[str, Any] | None:
    row = db.get(AppSetting, SCIENTIFIC_PREPARATION_KEY)
    if not row or not row.value:
        return None
    try:
        value = json.loads(row.value)
    except (TypeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != SCIENTIFIC_PREPARATION_SCHEMA_VERSION
    ):
        return None
    return value


def is_pending(state: dict[str, Any] | None) -> bool:
    return bool(state and state.get("status") in {"pending", "running"})


def set_state(db: Session, status: str, **values: Any) -> dict[str, Any]:
    current = get_state(db) or {
        "schemaVersion": SCIENTIFIC_PREPARATION_SCHEMA_VERSION,
        "reason": "stable-copy",
        "createdAt": _now(),
    }
    payload = {
        **current,
        **values,
        "schemaVersion": SCIENTIFIC_PREPARATION_SCHEMA_VERSION,
        "status": status,
        "updatedAt": _now(),
    }
    row = db.get(AppSetting, SCIENTIFIC_PREPARATION_KEY)
    encoded = json.dumps(payload, separators=(",", ":"))
    if row:
        row.value = encoded
    else:
        db.add(AppSetting(key=SCIENTIFIC_PREPARATION_KEY, value=encoded))
    return payload
