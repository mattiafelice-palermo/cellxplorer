from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import AppSetting
from ..services.process_priority import apply_background_thread_priority

logger = logging.getLogger(__name__)

CONFIG_KEY = "source_monitor_config"
NEXT_RUN_KEY = "source_monitor_next_run_at"
LAST_STARTED_KEY = "source_monitor_last_started_at"
LAST_FINISHED_KEY = "source_monitor_last_finished_at"
LAST_STATUS_KEY = "source_monitor_last_status"

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "schedule_mode": "interval",
    "interval_value": 6,
    "interval_unit": "hours",
    "daily_every_days": 1,
    "daily_time": "02:00",
    "auto_update": False,
    "scan_batch_size": 100,
    "stability_value": 5,
    "stability_unit": "seconds",
    "retry_count": 3,
    "retry_delay_minutes": 5,
}

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None
_thread_lock = threading.Lock()


def _get(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def _set(db: Session, key: str, value: str | None) -> None:
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value


def load_config(db: Session) -> dict[str, Any]:
    raw = _get(db, CONFIG_KEY)
    if not raw:
        return dict(DEFAULT_CONFIG)
    try:
        saved = json.loads(raw)
    except (TypeError, ValueError):
        return dict(DEFAULT_CONFIG)
    return {**DEFAULT_CONFIG, **saved}


def stability_seconds(config: dict[str, Any]) -> float:
    multiplier = 60 if config.get("stability_unit") == "minutes" else 1
    return float(config.get("stability_value", 5)) * multiplier


def _interval_delta(config: dict[str, Any]) -> timedelta:
    value = int(config.get("interval_value", 1))
    unit = config.get("interval_unit", "hours")
    if unit == "minutes":
        return timedelta(minutes=value)
    if unit == "days":
        return timedelta(days=value)
    return timedelta(hours=value)


def calculate_next_run(config: dict[str, Any], after: datetime | None = None) -> datetime:
    now = after or datetime.now(timezone.utc)
    if config.get("schedule_mode") == "daily":
        local_now = now.astimezone()
        hour, minute = (int(part) for part in str(config.get("daily_time", "02:00")).split(":"))
        candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= local_now:
            candidate += timedelta(days=max(1, int(config.get("daily_every_days", 1))))
        return candidate.astimezone(timezone.utc)
    return now + _interval_delta(config)


def following_scheduled_run(config: dict[str, Any], scheduled_for: datetime) -> datetime:
    """Return the next fixed schedule boundary after a due run."""
    if config.get("schedule_mode") != "daily":
        return scheduled_for + _interval_delta(config)
    local_due = scheduled_for.astimezone()
    next_local = local_due + timedelta(days=max(1, int(config.get("daily_every_days", 1))))
    hour, minute = (int(part) for part in str(config.get("daily_time", "02:00")).split(":"))
    return next_local.replace(hour=hour, minute=minute, second=0, microsecond=0).astimezone(
        timezone.utc
    )


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def monitoring_state(db: Session) -> dict[str, Any]:
    config = load_config(db)
    return {
        **config,
        "next_run_at": _get(db, NEXT_RUN_KEY),
        "last_started_at": _get(db, LAST_STARTED_KEY),
        "last_finished_at": _get(db, LAST_FINISHED_KEY),
        "last_status": _get(db, LAST_STATUS_KEY),
    }


def save_config(db: Session, config: dict[str, Any]) -> dict[str, Any]:
    clean = {key: config[key] for key in DEFAULT_CONFIG}
    _set(db, CONFIG_KEY, json.dumps(clean, separators=(",", ":")))
    if clean["enabled"]:
        _set(db, NEXT_RUN_KEY, calculate_next_run(clean).isoformat())
        _set(db, LAST_STATUS_KEY, "scheduled")
    else:
        _set(db, NEXT_RUN_KEY, None)
        _set(db, LAST_STATUS_KEY, "disabled")
    db.commit()
    _wake_event.set()
    return monitoring_state(db)


def _running_background_work() -> bool:
    from . import background_jobs

    return any(job.get("status") == "running" for job in background_jobs.list_jobs(limit=30))


def _run_scheduler() -> None:
    from ..routers import library
    from . import automation

    apply_background_thread_priority()
    while not _stop_event.is_set():
        db = SessionLocal()
        try:
            config = load_config(db)
            if automation.is_paused(db):
                # Pause prevents *starting* work; do not advance NEXT_RUN_KEY.
                _set(db, LAST_STATUS_KEY, "paused")
                db.commit()
                wait_seconds = 30
            elif not config["enabled"]:
                wait_seconds = 30
            else:
                now = datetime.now(timezone.utc)
                next_run = _parse_datetime(_get(db, NEXT_RUN_KEY))
                if next_run is None:
                    next_run = calculate_next_run(config, now)
                    _set(db, NEXT_RUN_KEY, next_run.isoformat())
                    db.commit()
                if next_run > now:
                    wait_seconds = min(30, max(1, int((next_run - now).total_seconds())))
                elif library.source_check_running() or _running_background_work():
                    _set(db, LAST_STATUS_KEY, "waiting_for_idle")
                    db.commit()
                    wait_seconds = 30
                else:
                    started_at = datetime.now(timezone.utc)
                    _set(db, LAST_STARTED_KEY, started_at.isoformat())
                    _set(db, LAST_STATUS_KEY, "running")
                    db.commit()
                    job = library.start_source_check_job(
                        db,
                        include_complete=False,
                        update_after_check=bool(config["auto_update"]),
                        scan_mode="metadata",
                        batch_size=int(config["scan_batch_size"]),
                        stability_seconds=stability_seconds(config),
                        trigger="scheduled",
                        low_impact=True,
                        retry_count=int(config["retry_count"]),
                        retry_delay_minutes=int(config["retry_delay_minutes"]),
                        retry_deadline_at=following_scheduled_run(config, next_run).isoformat(),
                    )
                    while not _stop_event.wait(1):
                        snapshot = library._source_check_job_snapshot(job["id"])
                        if not snapshot or snapshot.get("status") != "running":
                            break
                    snapshot = library._source_check_job_snapshot(job["id"])
                    finished_at = datetime.now(timezone.utc)
                    _set(db, LAST_FINISHED_KEY, finished_at.isoformat())
                    _set(db, LAST_STATUS_KEY, (snapshot or {}).get("status", "unknown"))
                    latest_config = load_config(db)
                    if latest_config["enabled"]:
                        _set(db, NEXT_RUN_KEY, calculate_next_run(latest_config, finished_at).isoformat())
                    else:
                        _set(db, NEXT_RUN_KEY, None)
                    db.commit()
                    wait_seconds = 1
        except Exception:
            logger.exception("automatic source monitor failed")
            try:
                _set(db, LAST_FINISHED_KEY, datetime.now(timezone.utc).isoformat())
                _set(db, LAST_STATUS_KEY, "failed")
                db.commit()
            except Exception:
                pass
            wait_seconds = 30
        finally:
            db.close()
        _wake_event.wait(wait_seconds)
        _wake_event.clear()


def start_source_monitor() -> None:
    global _thread
    with _thread_lock:
        if _thread and _thread.is_alive():
            return
        _stop_event.clear()
        _thread = threading.Thread(
            target=_run_scheduler,
            daemon=True,
            name="source-monitor",
        )
        _thread.start()


def stop_source_monitor() -> None:
    _stop_event.set()
    _wake_event.set()
    thread = _thread
    if thread and thread.is_alive():
        thread.join(timeout=3)
