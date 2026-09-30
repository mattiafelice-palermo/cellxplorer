"""Durable, batched notices for source data adopted by existing analyses.

These are data-change notifications, not compute jobs. Reading them must never
open source files, inspect scientific caches, or start preparation work.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy.orm import Session

from ..models import ActivityEvent, Analysis, Cell, SourceFile, Test, TestFile
from .activity_log import record_activity

ACTION = "analyses_received_data"


def _utc_iso(value: datetime) -> str:
    # SQLite returns UTC timestamps without tzinfo; browsers otherwise treat
    # them as local time and display notices hours earlier than processing jobs.
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def record_analysis_update(
    db: Session,
    *,
    cell_id: int,
    source_id: int | None,
    source_ids: list[int] | None = None,
    analysis_titles: dict[int, str],
    batch_key: str | None = None,
    added_cycles: int | None = None,
) -> None:
    if not analysis_titles:
        return
    # The producer owns the batch identity; do not combine unrelated runs by
    # their timestamps. UUIDs also prevent collisions across backend restarts.
    key = batch_key or uuid4().hex
    event_id = db.info.get("analysis_update_events", {}).get(key)
    event = db.get(ActivityEvent, event_id) if event_id is not None else None
    details = dict(event.details or {}) if event else {"batch_key": key, "changes": []}
    changes = [dict(change) for change in details["changes"]]
    change = next((item for item in changes if (item["cell_id"], item["source_id"]) == (cell_id, source_id)), None)
    if change is None:
        change = {"cell_id": cell_id, "source_id": source_id, "added_cycles": added_cycles, "analysis_ids": []}
        changes.append(change)
    change["source_ids"] = sorted(set(change.get("source_ids", [])) | set(source_ids or ([source_id] if source_id is not None else [])))
    # A source appears only once within a batch; count its delta once.
    change["analysis_ids"] = sorted(set(change["analysis_ids"]) | set(analysis_titles))
    titles = {str(item["id"]): item["title"] for item in details.get("analyses", [])}
    titles.update({str(key): value for key, value in analysis_titles.items()})
    analyses = []
    for analysis_id, title in titles.items():
        relevant = [item for item in changes if int(analysis_id) in item["analysis_ids"]]
        deltas = [item["added_cycles"] for item in relevant]
        analyses.append({
            "id": int(analysis_id), "title": title,
            "cell_ids": sorted({item["cell_id"] for item in relevant}),
            # Unknown deltas are omitted rather than presenting a partial total.
            "added_cycles": sum(deltas) if all(delta is not None for delta in deltas) else None,
        })
    details.update(changes=changes, analyses=sorted(analyses, key=lambda item: item["id"]))
    if event:
        event.details = details
        event.finished_at = datetime.now(timezone.utc)
    else:
        event = record_activity(db, category="analysis", action=ACTION,
                                message="Analyses received new data", details=details)
        db.info.setdefault("analysis_update_events", {})[key] = event.id


def list_analysis_updates(db: Session, *, limit: int = 30) -> list[dict]:
    from .cache_maintenance import warmup

    events = (db.query(ActivityEvent).filter(ActivityEvent.action == ACTION)
              .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
              .limit(max(1, min(limit, 100))).all())
    analysis_ids = {item["id"] for event in events for item in (event.details or {}).get("analyses", [])}
    cell_ids = {change["cell_id"] for event in events for change in (event.details or {}).get("changes", [])}
    titles = dict(db.query(Analysis.id, Analysis.title).filter(Analysis.id.in_(analysis_ids)).all()) if analysis_ids else {}
    cells = dict(db.query(Cell.id, Cell.name).filter(Cell.id.in_(cell_ids)).all()) if cell_ids else {}
    source_states: dict[int, list[str]] = {}
    source_membership: dict[int, set[int]] = {}
    if cell_ids:
        for cell_id, source_id, state in (db.query(Test.cell_id, SourceFile.id, SourceFile.parse_status)
                               .join(TestFile, TestFile.test_id == Test.id)
                               .join(SourceFile, SourceFile.id == TestFile.file_id)
                               .filter(Test.cell_id.in_(cell_ids)).all()):
            source_states.setdefault(cell_id, []).append(state)
            source_membership.setdefault(cell_id, set()).add(source_id)
    refresh_states = warmup.analysis_activity_states(analysis_ids)
    result = []
    for event in events:
        details = event.details or {}
        analyses = []
        for item in details.get("analyses", []):
            states = [state for cell_id in item["cell_ids"] for state in source_states.get(cell_id, [])]
            status = refresh_states.get(item["id"], "ready")
            if item["id"] not in titles:
                status = "removed"
            elif any(cell_id not in cells or not source_states.get(cell_id) for cell_id in item["cell_ids"]) or any(
                not set(change.get("source_ids", [change["source_id"]] if change.get("source_id") is not None else []))
                    .issubset(source_membership.get(change["cell_id"], set()))
                for change in details.get("changes", []) if item["id"] in change["analysis_ids"]
            ):
                status = "changed_since_update"
            elif any(state in {"error", "metadata_only"} for state in states):
                status = "needs_attention"
            elif any(state != "parsed" for state in states):
                status = "preparing_data"
            analyses.append({**item, "title": titles.get(item["id"], item["title"]), "status": status,
                             "cells": [{"id": cell_id, "name": cells.get(cell_id, "Removed cell")} for cell_id in item["cell_ids"]]})
        result.append({"id": event.id, "message": event.message,
                       "created_at": _utc_iso(event.created_at),
                       "finished_at": _utc_iso(event.finished_at or event.created_at),
                       "cell_count": len({change["cell_id"] for change in details.get("changes", [])}),
                       "analyses": analyses})
    return result
