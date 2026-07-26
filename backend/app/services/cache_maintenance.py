"""Cache budgets, inventory, cleanup, and idle saved-plot warmup coordination."""
from __future__ import annotations

import json
import shutil
import threading
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import CACHE_DIR
from ..db import SessionLocal
from ..models import (
    Analysis,
    AppSetting,
    Cell,
    ReplicateGroupCell,
    SourceFile,
    Test,
    TestFile,
)
from . import analysis_cache, background_jobs, cache
from .activity_log import record_activity

CACHE_SETTINGS_KEY = "cache_settings"


@dataclass(frozen=True)
class CachePolicy:
    warmup_enabled: bool = True
    only_when_hidden: bool = False
    idle_seconds: int = 15
    scientific_limit_bytes: int | None = 10 * 1024**3
    analysis_limit_bytes: int | None = 1024**3


def _setting_row(db: Session) -> AppSetting | None:
    return db.get(AppSetting, CACHE_SETTINGS_KEY)


def load_policy(db: Session) -> CachePolicy:
    row = _setting_row(db)
    if not row or not row.value:
        return CachePolicy()
    try:
        value = json.loads(row.value)
        return CachePolicy(
            warmup_enabled=bool(value.get("warmup_enabled", True)),
            only_when_hidden=bool(value.get("only_when_hidden", False)),
            idle_seconds=max(5, min(3600, int(value.get("idle_seconds", 15)))),
            scientific_limit_bytes=_optional_limit(value.get("scientific_limit_bytes"), 10 * 1024**3),
            analysis_limit_bytes=_optional_limit(value.get("analysis_limit_bytes"), 1024**3),
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return CachePolicy()


def _optional_limit(value: Any, default: int) -> int | None:
    if value is None:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def save_policy(db: Session, policy: CachePolicy) -> CachePolicy:
    row = _setting_row(db)
    value = json.dumps(asdict(policy), separators=(",", ":"))
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=CACHE_SETTINGS_KEY, value=value))
    db.commit()
    analysis_cache.configure_limit(policy.analysis_limit_bytes)
    return policy


def configure_from_database() -> None:
    db = SessionLocal()
    try:
        policy = load_policy(db)
        analysis_cache.configure_limit(policy.analysis_limit_bytes)
        enforce_scientific_limit(db, policy.scientific_limit_bytes)
    finally:
        db.close()


def _directory_stats(directory: Path) -> tuple[int, int, float | None]:
    if not directory.exists():
        return 0, 0, None
    files = [path for path in directory.rglob("*") if path.is_file()]
    if not files:
        return 0, 0, None
    stats = [(path, path.stat()) for path in files]
    return (
        len(stats),
        sum(stat.st_size for _, stat in stats),
        max(stat.st_mtime for _, stat in stats),
    )


def _iso_timestamp(value: float | None) -> str | None:
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value else None


def _scientific_directories() -> list[Path]:
    if not CACHE_DIR.exists():
        return []
    return [
        directory
        for prefix in CACHE_DIR.iterdir()
        if prefix.is_dir() and prefix.name != "analysis"
        for directory in prefix.iterdir()
        if directory.is_dir()
    ]


def _source_labels(db: Session) -> dict[str, dict[str, Any]]:
    rows = (
        db.query(SourceFile, Cell)
        .outerjoin(TestFile, TestFile.file_id == SourceFile.id)
        .outerjoin(Test, Test.id == TestFile.test_id)
        .outerjoin(Cell, Cell.id == Test.cell_id)
        .all()
    )
    return {
        source.hash: {
            "source_id": source.id,
            "cell_id": cell.id if cell else None,
            "label": cell.name if cell else source.filename,
            "source_path": source.path,
            "source_available": Path(source.path).is_file(),
        }
        for source, cell in rows
    }


def inventory(db: Session, *, offender_limit: int = 20) -> dict[str, Any]:
    policy = load_policy(db)
    categories: dict[str, dict[str, Any]] = {}
    category_paths = {
        "analysis_results": CACHE_DIR / "analysis" / "results",
        "analysis_artifacts": CACHE_DIR / "analysis" / "artifacts",
        "thumbnails": CACHE_DIR / "analysis" / "thumbnails",
        "thumbnail_indexes": CACHE_DIR / "analysis" / "thumbnail-index",
    }
    for key, directory in category_paths.items():
        count, size, modified = _directory_stats(directory)
        categories[key] = {
            "files": count,
            "bytes": size,
            "last_used_at": _iso_timestamp(modified),
        }

    labels = _source_labels(db)
    scientific: list[dict[str, Any]] = []
    scientific_files = scientific_bytes = 0
    for directory in _scientific_directories():
        count, size, modified = _directory_stats(directory)
        scientific_files += count
        scientific_bytes += size
        metadata = labels.get(directory.name, {})
        scientific.append(
            {
                "kind": "scientific",
                "id": directory.name,
                "label": metadata.get("label", directory.name[:12]),
                "bytes": size,
                "files": count,
                "last_used_at": _iso_timestamp(modified),
                "source_available": bool(metadata.get("source_available", False)),
                "source_path": metadata.get("source_path"),
                "cell_id": metadata.get("cell_id"),
            }
        )
    categories["scientific"] = {
        "files": scientific_files,
        "bytes": scientific_bytes,
        "last_used_at": max((item["last_used_at"] for item in scientific if item["last_used_at"]), default=None),
    }

    analysis_titles = {row.id: row.title for row in db.query(Analysis).all()}
    visual: list[dict[str, Any]] = []
    artifacts_root = category_paths["analysis_artifacts"]
    if artifacts_root.exists():
        for directory in artifacts_root.iterdir():
            if not directory.is_dir() or not directory.name.isdigit():
                continue
            count, size, modified = _directory_stats(directory)
            visual.append(
                {
                    "kind": "analysis_artifacts",
                    "id": directory.name,
                    "label": analysis_titles.get(int(directory.name), f"Analysis {directory.name}"),
                    "bytes": size,
                    "files": count,
                    "last_used_at": _iso_timestamp(modified),
                    "source_available": True,
                    "analysis_id": int(directory.name),
                }
            )

    offenders = sorted(scientific + visual, key=lambda item: item["bytes"], reverse=True)
    total = sum(category["bytes"] for category in categories.values())
    return {
        "policy": asdict(policy),
        "categories": categories,
        "total_bytes": total,
        "free_bytes": shutil.disk_usage(CACHE_DIR.parent).free,
        "offenders": offenders[: max(1, min(offender_limit, 100))],
    }


def _remove_directory(directory: Path) -> int:
    _, size, _ = _directory_stats(directory)
    shutil.rmtree(directory, ignore_errors=True)
    return size


def cleanup_category(category: str) -> int:
    targets = {
        "analysis_results": CACHE_DIR / "analysis" / "results",
        "analysis_artifacts": CACHE_DIR / "analysis" / "artifacts",
        "thumbnails": CACHE_DIR / "analysis" / "thumbnails",
        "thumbnail_indexes": CACHE_DIR / "analysis" / "thumbnail-index",
    }
    if category not in targets:
        raise ValueError("Unknown cache category")
    removed = _remove_directory(targets[category])
    if category != "analysis_results":
        # Visual caches were removed: drop the prepared markers so idle
        # warmup rebuilds them instead of considering the plots done.
        analysis_cache.clear_prepared_markers()
    analysis_cache.invalidate_size_tracker()
    return removed


def cleanup_offender(db: Session, kind: str, identifier: str, *, force: bool = False) -> int:
    if kind == "scientific":
        source = db.query(SourceFile).filter(SourceFile.hash == identifier).one_or_none()
        if source and not Path(source.path).is_file() and not force:
            raise PermissionError(
                "The original source is unavailable. Confirm forced cleanup before removing its only local cache."
            )
        return _remove_directory(CACHE_DIR / identifier[:2] / identifier)
    if kind == "analysis_artifacts" and identifier.isdigit():
        removed = _remove_directory(CACHE_DIR / "analysis" / "artifacts" / identifier)
        analysis_cache.clear_prepared_markers(int(identifier))
        analysis_cache.invalidate_size_tracker()
        return removed
    raise ValueError("Unknown cache item")


def enforce_scientific_limit(db: Session, limit_bytes: int | None) -> int:
    if limit_bytes is None:
        return 0
    pending = cache.pending_hashes()
    labels = _source_labels(db)
    candidates: list[tuple[float, int, Path]] = []
    total = 0
    for directory in _scientific_directories():
        _, size, modified = _directory_stats(directory)
        total += size
        source = labels.get(directory.name)
        if directory.name in pending:
            continue
        # Orphaned checksum directories are always disposable. A currently
        # referenced cache is protected only when its original source is
        # unavailable and therefore cannot be rebuilt.
        if source and not source.get("source_available"):
            continue
        candidates.append((modified or 0, size, directory))
    if total <= limit_bytes:
        return 0
    target = int(limit_bytes * 0.9)
    removed = 0
    for _, size, directory in sorted(candidates):
        if total <= target:
            break
        shutil.rmtree(directory, ignore_errors=True)
        total -= size
        removed += size
    return removed


class WarmupCoordinator:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: list[dict[str, Any]] = []
        self._next_index = 0
        self._active: dict[str, Any] | None = None
        self._job_id: int | None = None
        self._fingerprint: str | None = None
        self._probe: str | None = None
        self._generation_lock = threading.Lock()
        self._generation = 0
        self._paused = False
        self._pause_requested = False

    def _tasks_for_analyses(
        self,
        db: Session,
        analyses: list[Analysis],
    ) -> list[dict[str, Any]]:
        with self._generation_lock:
            self._generation += 1
            generation = self._generation
        tasks: list[dict[str, Any]] = []
        for analysis in analyses:
            for plot in ((analysis.spec or {}).get("saved_plots") or []):
                if not plot.get("id"):
                    continue
                expected_signature = analysis_cache.saved_plot_data_signature(db, analysis, plot)
                # A plot whose prepared marker still matches its current data
                # signature and revision needs no work: keep it out of the
                # queue entirely so saving one new plot produces a one-item
                # job instead of a walk over every saved plot.
                marker = analysis_cache.load_prepared_marker(analysis.id, str(plot.get("id")))
                if (
                    marker
                    and marker.get("data_signature") == expected_signature
                    and marker.get("plot_modified_at") == plot.get("modified_at")
                    and marker.get("thumbnail_cache_version")
                    == analysis_cache.THUMBNAIL_CACHE_VERSION
                    and analysis_cache.load_latest_thumbnail(
                        analysis.id, str(plot.get("id")), "saved"
                    )
                    is not None
                    and analysis_cache.load_latest_thumbnail(
                        analysis.id, str(plot.get("id")), "preview"
                    )
                    is not None
                ):
                    continue
                tasks.append(
                    {
                        "id": f"{analysis.id}:{plot.get('id')}:{generation}",
                        "analysis_id": analysis.id,
                        "analysis_title": analysis.title,
                        "analysis_modified_at": (
                            analysis.modified_at.isoformat() if analysis.modified_at else None
                        ),
                        "expected_data_signature": expected_signature,
                        "plot_id": str(plot.get("id")),
                        "plot_title": str(plot.get("name") or "Saved plot"),
                        "plot_modified_at": plot.get("modified_at"),
                        "tab": str(plot.get("tab") or "cycles"),
                    }
                )
        return tasks

    @staticmethod
    def _job_items(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "id": task["id"],
                "label": f"{task['analysis_title']} — {task['plot_title']}",
                "status": "queued",
            }
            for task in tasks[:200]
        ]

    @staticmethod
    def _analysis_probe(db: Session) -> str:
        """Cheap change indicator: avoids re-fingerprinting every plot on
        every idle poll. Source/cell changes bypass this via direct
        enqueue_analyses calls, so analysis count + latest modification is a
        sufficient trigger for a full rescan. Include the thumbnail renderer
        version so an application upgrade cannot reuse an all-ready probe
        created for an obsolete preview format."""
        from sqlalchemy import func

        count, latest = db.query(func.count(Analysis.id), func.max(Analysis.modified_at)).one()
        return (
            f"thumbnail-v{analysis_cache.THUMBNAIL_CACHE_VERSION}:"
            f"{count}:{latest.isoformat() if latest else ''}"
        )

    def start(self, db: Session) -> dict[str, Any]:
        probe = self._analysis_probe(db)
        with self._lock:
            if self._job_id is not None:
                current = background_jobs.get_job(self._job_id)
                if current and current.get("status") in {"running", "paused"}:
                    return current
                if current and probe == self._probe:
                    return current

        analyses = db.query(Analysis).order_by(Analysis.id).all()
        tasks = self._tasks_for_analyses(db, analyses)
        # Plot-level identity: an analysis autosave that does not touch any
        # saved plot must not spawn a fresh warmup job over all plots.
        fingerprint = json.dumps(
            [
                (
                    task["analysis_id"],
                    task["plot_id"],
                    task["plot_title"],
                    task["plot_modified_at"],
                    task["expected_data_signature"],
                )
                for task in tasks
            ]
        )
        with self._lock:
            if self._job_id is not None:
                current = background_jobs.get_job(self._job_id)
                if current and current.get("status") in {"running", "paused"}:
                    return current
                if fingerprint == self._fingerprint:
                    self._probe = probe
                    return current or {"status": "completed", "total": len(tasks), "completed": len(tasks)}
                if not tasks and current:
                    # Everything is prepared: refresh the bookkeeping without
                    # spawning an empty job on each analysis edit.
                    self._fingerprint = fingerprint
                    self._probe = probe
                    return current
            self._tasks = tasks
            self._next_index = 0
            self._active = None
            self._paused = False
            self._pause_requested = False
            self._fingerprint = fingerprint
            self._probe = probe
            self._job_id = background_jobs.create_job(
                kind="cache_warmup",
                title="Preparing analysis cache",
                description="Checking saved plots",
                total=len(tasks),
                items=self._job_items(tasks),
            )
            if not tasks:
                background_jobs.update_job(self._job_id, status="completed", description="Analysis cache is ready")
            return background_jobs.get_job(self._job_id) or {}

    def enqueue_analyses(self, db: Session, analysis_ids: set[int]) -> dict[str, int]:
        if not analysis_ids:
            return {"analyses": 0, "plots": 0}
        analyses = (
            db.query(Analysis)
            .filter(Analysis.id.in_(sorted(analysis_ids)))
            .order_by(Analysis.id)
            .all()
        )
        fresh = self._tasks_for_analyses(db, analyses)
        if not fresh:
            return {"analyses": len(analyses), "plots": 0}
        with self._lock:
            pending_revisions = {
                (
                    task["analysis_id"],
                    task["plot_id"],
                    task["analysis_modified_at"],
                    task["expected_data_signature"],
                )
                for task in self._tasks[self._next_index :]
            }
            active_revision = (
                (
                    self._active["analysis_id"],
                    self._active["plot_id"],
                    self._active["analysis_modified_at"],
                    self._active["expected_data_signature"],
                )
                if self._active is not None
                else None
            )
            additions = [
                task
                for task in fresh
                if (
                    task["analysis_id"],
                    task["plot_id"],
                    task["analysis_modified_at"],
                    task["expected_data_signature"],
                )
                not in pending_revisions
                and (
                    task["analysis_id"],
                    task["plot_id"],
                    task["analysis_modified_at"],
                    task["expected_data_signature"],
                )
                != active_revision
            ]
            if not additions:
                return {"analyses": len(analyses), "plots": 0}

            current = background_jobs.get_job(self._job_id) if self._job_id is not None else None
            if current and current.get("status") in {"running", "paused"}:
                self._tasks.extend(additions)
                background_jobs.append_items(
                    self._job_id,
                    self._job_items(additions),
                    total_increment=len(additions),
                )
                background_jobs.update_job(
                    self._job_id,
                    description=f"Queued {len(additions)} refreshed plot{'s' if len(additions) != 1 else ''}",
                )
            else:
                pause_requested = self._pause_requested
                self._tasks = additions
                self._next_index = 0
                self._active = None
                self._paused = pause_requested
                self._job_id = background_jobs.create_job(
                    kind="cache_warmup",
                    title="Refreshing analysis cache",
                    description="Source data changed",
                    total=len(additions),
                    items=self._job_items(additions),
                )
                if pause_requested:
                    background_jobs.update_job(
                        self._job_id,
                        status="paused",
                        description="Paused until CellXplorer is idle",
                    )
            return {"analyses": len(analyses), "plots": len(additions)}

    def request_pause(self) -> dict[str, Any]:
        with self._lock:
            self._pause_requested = True
            if self._active is None:
                self._paused = True
                if self._job_id is not None:
                    current = background_jobs.get_job(self._job_id)
                    if current and current.get("status") == "running":
                        background_jobs.update_job(
                            self._job_id,
                            status="paused",
                            description="Paused until CellXplorer is idle",
                        )
            return {
                "paused": self._paused,
                "finishing_current": self._active is not None,
                "job_id": self._job_id,
            }

    def resume(self) -> dict[str, Any]:
        with self._lock:
            self._pause_requested = False
            was_paused = self._paused
            self._paused = False
            if was_paused and self._job_id is not None:
                current = background_jobs.get_job(self._job_id)
                if current and current.get("status") == "paused":
                    background_jobs.update_job(
                        self._job_id,
                        status="running",
                        description="Resuming analysis cache preparation",
                    )
            return {"paused": False, "job_id": self._job_id}

    @staticmethod
    def _is_current(task: dict[str, Any], db: Session | None = None) -> bool:
        owns_session = db is None
        session = db or SessionLocal()
        try:
            analysis = session.get(Analysis, task["analysis_id"])
            if analysis is None:
                return False
            modified_at = analysis.modified_at.isoformat() if analysis.modified_at else None
            if modified_at != task["analysis_modified_at"]:
                return False
            plot = next(
                (
                    candidate
                    for candidate in ((analysis.spec or {}).get("saved_plots") or [])
                    if str(candidate.get("id")) == task["plot_id"]
                ),
                None,
            )
            if plot is None:
                return False
            return (
                analysis_cache.saved_plot_data_signature(session, analysis, plot)
                == task["expected_data_signature"]
            )
        finally:
            if owns_session:
                session.close()

    def authorize_task(
        self,
        task_id: str,
        analysis_id: int,
        plot_id: str,
        expected_data_signature: str,
        expected_analysis_modified_at: str | None,
    ) -> bool:
        with self._lock:
            task = self._active
            return bool(
                task
                and task["id"] == task_id
                and task["analysis_id"] == analysis_id
                and task["plot_id"] == plot_id
                and task["expected_data_signature"] == expected_data_signature
                and task["analysis_modified_at"] == expected_analysis_modified_at
            )

    def foreground_ready(self, analysis_id: int, plot_id: str) -> int:
        """Retire matching idle work after the user has generated this plot."""
        retired = 0
        with self._lock:
            job_id = self._job_id
            if self._active is not None and (
                self._active["analysis_id"], self._active["plot_id"]
            ) == (analysis_id, plot_id):
                if job_id is not None:
                    background_jobs.record_result(
                        job_id,
                        self._active["id"],
                        status="skipped",
                        detail="Prepared while the plot was open",
                        error=None,
                        counter="skipped",
                    )
                self._active = None
                retired += 1
            for task in self._tasks[self._next_index :]:
                if task.get("cancelled") or (
                    task["analysis_id"], task["plot_id"]
                ) != (analysis_id, plot_id):
                    continue
                task["cancelled"] = True
                if job_id is not None:
                    background_jobs.record_result(
                        job_id,
                        task["id"],
                        status="skipped",
                        detail="Prepared while the plot was open",
                        error=None,
                        counter="skipped",
                    )
                retired += 1
            if (
                retired
                and job_id is not None
                and self._active is None
                and all(task.get("cancelled") for task in self._tasks[self._next_index :])
            ):
                background_jobs.update_job(
                    job_id,
                    status="completed",
                    description="Analysis cache preparation finished",
                )
        return retired

    def next_task(self, db: Session | None = None) -> dict[str, Any] | None:
        while True:
            with self._lock:
                if self._active is not None:
                    return dict(self._active)
                if self._pause_requested or self._paused:
                    return None
                if self._next_index >= len(self._tasks):
                    return None
                self._active = self._tasks[self._next_index]
                self._next_index += 1
                task = dict(self._active)
            if not task.get("cancelled") and self._is_current(task, db):
                with self._lock:
                    if self._active is None or self._active["id"] != task["id"]:
                        continue
                    if self._job_id is not None:
                        background_jobs.update_item(
                            self._job_id,
                            task["id"],
                            status="processing",
                            detail="Preparing cached plot",
                        )
                        background_jobs.update_job(
                            self._job_id,
                            description=f"Preparing {task['analysis_title']} — {task['plot_title']}",
                        )
                    return task
            with self._lock:
                if self._active is not None and self._active["id"] == task["id"]:
                    if not task.get("cancelled") and self._job_id is not None:
                        background_jobs.record_result(
                            self._job_id,
                            task["id"],
                            status="skipped",
                            detail="Superseded by newer source or analysis data",
                            error=None,
                            counter="skipped",
                        )
                    self._active = None
                    if self._job_id is not None and self._next_index >= len(self._tasks):
                        background_jobs.update_job(
                            self._job_id,
                            status="completed",
                            description="Analysis cache preparation finished",
                        )

    def complete(
        self,
        task_id: str,
        *,
        status: str,
        detail: str | None,
        error: str | None,
        db: Session | None = None,
    ) -> dict[str, Any]:
        finished = False
        job_id: int | None
        with self._lock:
            if self._active is None or self._active["id"] != task_id:
                return {"ok": False, "detail": "Task is no longer active"}
            job_id = self._job_id
            completed_task = self._active
            self._active = None
            if status == "ready" and not error:
                has_saved = analysis_cache.load_latest_thumbnail(
                    completed_task["analysis_id"], completed_task["plot_id"], "saved"
                )
                has_preview = analysis_cache.load_latest_thumbnail(
                    completed_task["analysis_id"], completed_task["plot_id"], "preview"
                )
                if has_saved is None or has_preview is None:
                    status = "failed"
                    detail = "Thumbnail pair was not persisted"
                    error = "Saved-row and hover thumbnails are both required"
            if error:
                # A completed scan is only reusable when every item actually
                # reached durable storage. Let the next idle pass rebuild the
                # missing item instead of returning this failed job forever.
                self._fingerprint = None
                self._probe = None
            if job_id is not None:
                background_jobs.record_result(
                    job_id,
                    task_id,
                    status=status,
                    detail=detail,
                    error=error,
                    counter="failed" if error else "ready",
                )
                if self._next_index >= len(self._tasks):
                    finished = True
                    background_jobs.update_job(
                        job_id,
                        status="completed",
                        description="Analysis cache preparation finished",
                    )
                elif self._pause_requested:
                    self._paused = True
                    background_jobs.update_job(
                        job_id,
                        status="paused",
                        description="Paused until CellXplorer is idle",
                    )
        if status == "ready" and not error:
            # Record what this plot was prepared for, so the next queue
            # build can skip it. Covers both fresh renders and tasks that
            # completed straight from an existing cache entry.
            analysis_cache.store_prepared_marker(
                completed_task["analysis_id"],
                completed_task["plot_id"],
                completed_task["expected_data_signature"],
                completed_task.get("plot_modified_at"),
            )
        if finished:
            activity_db = db if db is not None else SessionLocal()
            try:
                record_activity(
                    activity_db,
                    category="system",
                    action="cache_warmup_completed",
                    message="Background analysis cache preparation finished.",
                    details={"plots": len(self._tasks)},
                )
                activity_db.commit()
            finally:
                if db is None:
                    activity_db.close()
        return {"ok": True, "finished": finished, "job_id": job_id}


warmup = WarmupCoordinator()


def _analysis_references_cell(
    analysis: Analysis,
    cell_id: int,
    replicate_group_ids: set[int],
) -> bool:
    spec = analysis.spec or {}
    selections = [spec.get("selection") or {}]
    selections.extend(
        (plot.get("selection") or {})
        for plot in (spec.get("saved_plots") or [])
    )
    for selection in selections:
        for entry in selection.get("entries") or []:
            kind = entry.get("kind")
            ref_id = entry.get("ref_id")
            if kind == "cell" and ref_id == cell_id:
                return True
            if kind == "replicate_group" and ref_id in replicate_group_ids:
                return True
    return False


def _analysis_title_summary(titles: list[str], limit: int = 3) -> str:
    quoted = [f"'{title}'" for title in titles[:limit]]
    if len(titles) > limit:
        quoted.append(f"{len(titles) - limit} more")
    return ", ".join(quoted)


def dependent_analysis_ids(db: Session, cell_ids: Iterable[int]) -> list[int]:
    """Return every analysis whose live or saved selection references the cells."""
    requested = {int(cell_id) for cell_id in cell_ids}
    if not requested:
        return []
    analyses = db.query(Analysis).all()
    affected: set[int] = set()
    for cell_id in requested:
        replicate_group_ids = {
            row[0]
            for row in db.query(ReplicateGroupCell.group_id)
            .filter(ReplicateGroupCell.cell_id == cell_id)
            .all()
        }
        affected.update(
            analysis.id
            for analysis in analyses
            if _analysis_references_cell(analysis, cell_id, replicate_group_ids)
        )
    return sorted(affected)


def invalidate_cell_dependents(
    db: Session,
    cell_id: int,
    *,
    source_id: int | None = None,
    queue_warmup: bool = True,
    reason: str = "source_update",
) -> dict[str, Any]:
    """Invalidate visual caches after the cell's data-affecting inputs changed.

    Covers both newly adopted source bytes and edits to cell properties that
    enter the cache key (name, archived flag, mass/capacity/area overrides).
    """
    replicate_group_ids = {
        row[0]
        for row in db.query(ReplicateGroupCell.group_id)
        .filter(ReplicateGroupCell.cell_id == cell_id)
        .all()
    }
    affected_titles: dict[int, str] = {
        analysis.id: analysis.title
        for analysis in db.query(Analysis).all()
        if _analysis_references_cell(analysis, cell_id, replicate_group_ids)
    }
    affected = set(affected_titles)
    for analysis_id in affected:
        analysis_cache.delete_analysis_artifacts(analysis_id)

    queued = {"analyses": len(affected), "plots": 0}
    if affected and queue_warmup and load_policy(db).warmup_enabled:
        queued = warmup.enqueue_analyses(db, affected)
    if affected:
        cause = "Source update" if reason == "source_update" else "Cell property change"
        titles = _analysis_title_summary(
            [affected_titles[analysis_id] for analysis_id in sorted(affected)]
        )
        message = (
            f"{cause} invalidated cached plots of {titles}; "
            f"queued {queued['plots']} saved plot"
            f"{'s' if queued['plots'] != 1 else ''} for refresh."
            if queued["plots"]
            else f"{cause} invalidated cached plots of {titles}; their refresh is already queued."
        )
        record_activity(
            db,
            category="cache",
            action="analysis_cache_invalidated",
            message=message,
            entity_type="cell",
            entity_id=cell_id,
            details={
                "source_id": source_id,
                "reason": reason,
                "analysis_ids": sorted(affected),
                "analysis_titles": [affected_titles[a] for a in sorted(affected)],
                "queued_plots": queued["plots"],
            },
        )
    return {
        "cell_id": cell_id,
        "analysis_ids": sorted(affected),
        "queued_plots": queued["plots"],
    }

_maintenance_stop = threading.Event()
_maintenance_thread: threading.Thread | None = None


def _maintenance_loop() -> None:
    from .process_priority import apply_background_thread_priority

    apply_background_thread_priority()
    configure_from_database()
    while not _maintenance_stop.wait(300):
        db = SessionLocal()
        try:
            policy = load_policy(db)
            analysis_cache.configure_limit(policy.analysis_limit_bytes)
            enforce_scientific_limit(db, policy.scientific_limit_bytes)
        finally:
            db.close()


def start_cache_maintenance() -> None:
    global _maintenance_thread
    if _maintenance_thread is not None and _maintenance_thread.is_alive():
        return
    _maintenance_stop.clear()
    _maintenance_thread = threading.Thread(
        target=_maintenance_loop,
        name="cache-maintenance",
        daemon=True,
    )
    _maintenance_thread.start()


def stop_cache_maintenance() -> None:
    _maintenance_stop.set()
