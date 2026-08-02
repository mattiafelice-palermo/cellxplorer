from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import ActivityEvent, ImportSubmission
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


def durable_import_job_dict(submission: ImportSubmission) -> dict:
    completed = submission.submitted_cells if submission.status == "completed" else 0
    return {
        "id": submission.job_id,
        "kind": "import_register",
        "token": submission.token,
        "title": "Registering imported cells",
        "description": (
            "Cell registration was interrupted by backend shutdown"
            if submission.status == "interrupted"
            else "Registering imported cells"
        ),
        "status": submission.status,
        "total": submission.submitted_cells,
        "completed": completed,
        "counters": {},
        "items": [],
        "error": submission.error,
        "started_at": (submission.started_at or submission.created_at).isoformat(),
        "completed_at": submission.finished_at.isoformat() if submission.finished_at else None,
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
def list_background_jobs(limit: int = 20, db: Session = Depends(get_db)):
    safe_limit = max(1, min(int(limit or 20), 30))
    live = background_jobs.list_jobs(limit=safe_limit)
    live_tokens = {job.get("token") for job in live if job.get("token")}
    durable = (
        db.query(ImportSubmission)
        .filter(ImportSubmission.token.isnot(None))
        .order_by(ImportSubmission.created_at.desc(), ImportSubmission.id.desc())
        .limit(safe_limit)
        .all()
    )
    rows = live[:]
    rows.extend(
        durable_import_job_dict(submission)
        for submission in durable
        if submission.token not in live_tokens
    )
    rows.sort(
        key=lambda job: (
            job.get("status") != "running",
            job.get("started_at") or job.get("completed_at") or "",
        ),
    )
    return rows[:safe_limit]


@router.get("/background-jobs/by-token/{token}")
def get_background_job_by_token(token: str, db: Session = Depends(get_db)):
    """Return the job a client's token refers to, or null if none exists yet.

    A cached compute never opens a job, so "no job" is the normal, successful
    outcome here rather than an error.
    """
    live = background_jobs.find_by_token(token)
    if live is not None:
        return live
    submission = db.query(ImportSubmission).filter(ImportSubmission.token == token).first()
    return durable_import_job_dict(submission) if submission is not None else None


@router.get("/background-jobs/{job_id}")
def get_background_job(job_id: int, db: Session = Depends(get_db)):
    job = background_jobs.get_job(job_id)
    if job is not None:
        return job
    submission = db.query(ImportSubmission).filter(ImportSubmission.job_id == job_id).first()
    if submission is None:
        raise HTTPException(404, "No such background job")
    return durable_import_job_dict(submission)
