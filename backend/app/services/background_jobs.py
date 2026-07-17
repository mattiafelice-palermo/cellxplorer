from __future__ import annotations

import threading
from copy import deepcopy
from datetime import datetime, timezone

_lock = threading.Lock()
_jobs: dict[int, dict] = {}
_next_id = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_job(
    *,
    kind: str,
    title: str,
    description: str,
    total: int,
    items: list[dict] | None = None,
) -> int:
    global _next_id
    with _lock:
        job_id = _next_id
        _next_id += 1
        _jobs[job_id] = {
            "id": job_id,
            "kind": kind,
            "title": title,
            "description": description,
            "status": "running",
            "total": max(0, int(total)),
            "completed": 0,
            "counters": {},
            "items": [
                {
                    "id": str(item["id"]),
                    "label": str(item["label"]),
                    "status": item.get("status", "queued"),
                    "detail": item.get("detail"),
                    "error": item.get("error"),
                }
                for item in (items or [])
            ],
            "error": None,
            "started_at": _now(),
            "completed_at": None,
        }
        for old_id in sorted(_jobs)[:-30]:
            _jobs.pop(old_id, None)
        return job_id


def update_job(job_id: int, **values) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.update(values)
        if values.get("status") in {"completed", "failed"} and not job.get("completed_at"):
            job["completed_at"] = _now()


def update_item(job_id: int, item_id: str | int, **values) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        target = str(item_id)
        for item in job["items"]:
            if item["id"] == target:
                item.update(values)
                return


def record_result(
    job_id: int,
    item_id: str | int,
    *,
    status: str,
    detail: str | None = None,
    error: str | None = None,
    counter: str | None = None,
) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job["completed"] = min(job["total"], job["completed"] + 1)
        if counter:
            job["counters"][counter] = job["counters"].get(counter, 0) + 1
        target = str(item_id)
        for item in job["items"]:
            if item["id"] == target:
                item.update(status=status, detail=detail, error=error)
                break


def list_jobs(limit: int = 20) -> list[dict]:
    with _lock:
        rows = [deepcopy(job) for job in _jobs.values()]
    rows.sort(key=lambda job: (job["status"] != "running", -job["id"]))
    return rows[: max(1, min(int(limit), 30))]


def get_job(job_id: int) -> dict | None:
    with _lock:
        job = _jobs.get(int(job_id))
        return deepcopy(job) if job is not None else None


def clear_jobs() -> None:
    """Test helper: live jobs are intentionally session-only."""
    global _next_id
    with _lock:
        _jobs.clear()
        _next_id = 1
