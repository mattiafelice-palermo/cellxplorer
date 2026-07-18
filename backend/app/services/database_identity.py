from __future__ import annotations

from uuid import uuid4

from sqlalchemy.orm import Session

from ..models import AppSetting


DATABASE_INSTANCE_ID_KEY = "database.instance_id"


def ensure_database_instance_id(db: Session) -> str:
    """Return a durable identity that follows this database across app updates."""
    setting = db.get(AppSetting, DATABASE_INSTANCE_ID_KEY)
    if setting is not None and setting.value:
        return setting.value
    value = str(uuid4())
    if setting is None:
        db.add(AppSetting(key=DATABASE_INSTANCE_ID_KEY, value=value))
    else:
        setting.value = value
    db.commit()
    return value
