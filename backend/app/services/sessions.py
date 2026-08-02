from __future__ import annotations

import os
import threading
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import ActivityEvent, AppSession, ImportSubmission

_lock = threading.Lock()
_current_session_id: int | None = None
logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def begin_session(
    db: Session,
    *,
    startup_mode: str,
    app_version: str | None,
    backend_pid: int | None,
) -> AppSession:
    now = _now()
    stale = db.query(AppSession).filter(AppSession.status == "running").all()
    for row in stale:
        row.status = "interrupted"
        row.exit_reason = "process_ended_without_shutdown"
        row.finished_at = now

    stale_imports = (
        db.query(ImportSubmission)
        .filter(ImportSubmission.status.in_(["accepted", "running"]))
        .all()
    )
    for submission in stale_imports:
        submission.status = "interrupted"
        submission.error = "The previous backend session ended before registration completed."
        submission.finished_at = now
        db.add(
            ActivityEvent(
                category="import",
                action="import_registration_interrupted",
                message="Import registration was interrupted by backend shutdown",
                severity="error",
                details={
                    "submission_id": submission.id,
                    "job_id": submission.job_id,
                    "job_token": submission.token,
                },
                started_at=submission.started_at or submission.created_at,
                finished_at=now,
            )
        )

    session = AppSession(
        startup_mode=startup_mode,
        status="running",
        app_version=app_version,
        backend_pid=backend_pid,
        started_at=now,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def finish_session(
    db: Session,
    session_id: int,
    *,
    exit_reason: str = "quit",
) -> AppSession | None:
    row = db.get(AppSession, session_id)
    if row is None:
        return None
    if row.status == "running":
        row.status = "closed"
        row.exit_reason = exit_reason
        row.finished_at = _now()
        db.commit()
        db.refresh(row)
    return row


def start_runtime_session() -> None:
    global _current_session_id
    db = SessionLocal()
    try:
        row = begin_session(
            db,
            startup_mode=os.environ.get("CELLXPLORER_STARTUP_MODE", "development"),
            app_version=os.environ.get("CELLXPLORER_APP_VERSION"),
            backend_pid=os.getpid(),
        )
        with _lock:
            _current_session_id = row.id
    except Exception:
        db.rollback()
        logger.exception("Could not record the application session")
    finally:
        db.close()


def finish_runtime_session(exit_reason: str = "quit") -> AppSession | None:
    global _current_session_id
    with _lock:
        session_id = _current_session_id
    if session_id is None:
        return None
    db = SessionLocal()
    try:
        row = finish_session(db, session_id, exit_reason=exit_reason)
        with _lock:
            _current_session_id = None
        return row
    except Exception:
        db.rollback()
        logger.exception("Could not finish the application session")
        return None
    finally:
        db.close()


def current_session_id() -> int | None:
    with _lock:
        return _current_session_id
