"""Per-Cell folder discovery for continued imports.

The watcher owns candidate discovery and durable failure state. Scientific source
registration remains in the continuation lifecycle endpoints; this service only
hands those endpoints a stable, inspected source batch.
"""
from __future__ import annotations

import fnmatch
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy.orm import Session

from ..models import CellFolderWatch, CellFolderWatchCandidate, SourceFile, Test, TestFile
from . import import_inspection, parsing

DEFAULT_PATTERN = "*"
DEFAULT_ORDERING = "timestamp_filename_hash"
WATCHABLE_ORDERINGS = {DEFAULT_ORDERING, "filename"}
PATTERN_KINDS = {"glob", "regex"}
CADENCE_UNITS = {"minutes": 60, "hours": 3600, "days": 86400}
TERMINAL_CANDIDATE_STATUSES = {
    "duplicate",
    "unsupported",
    "malformed",
    "ambiguous_order",
    "blocked_by_finding",
    "needs_confirmation",
    "attach_failed",
    "ignored",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def normalize_folder_path(value: str) -> str:
    path = str(value or "").strip()
    if not path:
        raise ValueError("A folder is required for folder tracking.")
    return str(Path(path).expanduser().resolve())


def normalize_extension(value: str) -> str:
    extension = str(value or "").strip().lower().lstrip(".")
    if not extension:
        raise ValueError("A supported source extension is required for folder tracking.")
    if not parsing.source_filename_allowed(f"source.{extension}"):
        raise ValueError(f"The source extension .{extension} is not supported by the importer.")
    return extension


def validate_pattern(pattern_kind: str, pattern: str) -> str:
    kind = str(pattern_kind or "glob").strip().lower()
    if kind not in PATTERN_KINDS:
        raise ValueError("Filename matching must be glob or regular expression.")
    value = str(pattern or "").strip()
    if not value:
        raise ValueError("A filename matching pattern is required.")
    if kind == "regex":
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"The filename regular expression is invalid: {exc}") from exc
    return value


def validate_watch_config(config: dict[str, Any]) -> dict[str, Any]:
    folder_path = normalize_folder_path(str(config.get("folder_path") or ""))
    pattern_kind = str(config.get("pattern_kind") or "glob").strip().lower()
    pattern = validate_pattern(pattern_kind, str(config.get("pattern") or DEFAULT_PATTERN))
    extension = normalize_extension(str(config.get("extension") or ""))
    ordering_rule = str(config.get("ordering_rule") or DEFAULT_ORDERING).strip().lower()
    if ordering_rule not in WATCHABLE_ORDERINGS:
        raise ValueError("Folder tracking has an unsupported ordering rule.")
    recursive = bool(config.get("recursive", False))
    recursion_depth = int(config.get("recursion_depth") or 0)
    if recursion_depth < 0 or recursion_depth > 32:
        raise ValueError("Recursive folder tracking depth must be between 0 and 32.")
    if recursive and recursion_depth == 0:
        recursion_depth = 1
    cadence_value = config.get("cadence_value")
    cadence_unit = config.get("cadence_unit")
    if cadence_value is not None:
        cadence_value = int(cadence_value)
        cadence_unit = str(cadence_unit or "hours").strip().lower()
        if cadence_value < 1 or cadence_value > 365:
            raise ValueError("A folder-tracking cadence must be between 1 and 365 units.")
        if cadence_unit not in CADENCE_UNITS:
            raise ValueError("Folder-tracking cadence must use minutes, hours, or days.")
    else:
        cadence_unit = None
    source_format = str(config.get("source_format") or "").strip() or None
    return {
        "folder_path": folder_path,
        "enabled": bool(config.get("enabled", True)),
        "pattern_kind": pattern_kind,
        "pattern": pattern,
        "extension": extension,
        "source_format": source_format,
        "ordering_rule": ordering_rule,
        "recursive": recursive,
        "recursion_depth": recursion_depth,
        "cadence_value": cadence_value,
        "cadence_unit": cadence_unit,
    }


def validate_import_watch(
    config: dict[str, Any],
    source_names_and_paths: Iterable[tuple[str, str | None]],
) -> dict[str, Any]:
    """Validate the import-time watch against every staged source."""
    clean = validate_watch_config(config)
    folder = Path(clean["folder_path"]).resolve()
    sources = list(source_names_and_paths)
    if not sources:
        raise ValueError("Folder tracking requires at least one staged source.")
    for filename, source_path in sources:
        if not source_path:
            raise ValueError("Folder tracking requires source paths from one local folder.")
        path = Path(source_path).expanduser().resolve()
        if path.parent != folder:
            raise ValueError("All tracked sources must be in the same parent folder.")
        if path.suffix.lower().lstrip(".") != clean["extension"]:
            raise ValueError("All tracked sources must use the configured extension.")
        if not matches_filename(filename or path.name, clean["pattern_kind"], clean["pattern"]):
            raise ValueError(f"The selected source {filename or path.name} does not match the filename pattern.")
    return clean


def matches_filename(filename: str, pattern_kind: str, pattern: str) -> bool:
    if pattern_kind == "regex":
        return re.search(pattern, filename) is not None
    return fnmatch.fnmatchcase(filename.casefold(), pattern.casefold())


def _natural_filename_key(filename: str) -> tuple[tuple[int, object], ...]:
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", filename)
        if part
    )


def parse_source_timestamp(value: object) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                parsed = None
        if parsed is None:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def candidate_order_key(
    filename: str,
    source_timestamp: object,
    file_hash: str,
    ordering_rule: str = DEFAULT_ORDERING,
) -> tuple[Any, ...]:
    name_key = _natural_filename_key(filename)
    if ordering_rule == "filename":
        return name_key, file_hash.casefold()
    timestamp = parse_source_timestamp(source_timestamp)
    return (
        timestamp is None,
        timestamp if timestamp is not None else 0.0,
        name_key,
        file_hash.casefold(),
    )


def _iter_files(watch: CellFolderWatch) -> Iterable[Path]:
    root = Path(watch.folder_path)
    if not watch.recursive:
        try:
            yield from (entry for entry in root.iterdir() if entry.is_file())
        except OSError:
            return
        return
    max_depth = max(1, int(watch.recursion_depth or 1))
    try:
        for entry in root.rglob("*"):
            if entry.is_file() and len(entry.relative_to(root).parts) <= max_depth:
                yield entry
    except (OSError, ValueError):
        return


def preview_watch_files(config: dict[str, Any], *, limit: int = 200) -> dict[str, Any]:
    """Return a bounded display-only listing for the settings dialog."""
    clean = validate_watch_config(config)
    root = Path(clean["folder_path"])
    if not root.is_dir():
        return {
            "files": [],
            "truncated": False,
            "error": f"Folder is missing or unavailable: {clean['folder_path']}",
        }
    if clean["recursive"]:
        max_depth = max(1, int(clean["recursion_depth"] or 1))
        try:
            paths = [
                path
                for path in root.rglob("*")
                if path.is_file() and len(path.relative_to(root).parts) <= max_depth
            ]
        except (OSError, ValueError):
            paths = []
    else:
        try:
            paths = [path for path in root.iterdir() if path.is_file()]
        except OSError:
            paths = []
    matching = sorted(
        (
            path
            for path in paths
            if path.suffix.lower().lstrip(".") == clean["extension"]
            and matches_filename(path.name, clean["pattern_kind"], clean["pattern"])
        ),
        key=lambda path: str(path.relative_to(root)).casefold(),
    )
    bounded = matching[: max(1, int(limit))]
    return {
        "files": [
            {
                "path": str(path.resolve()),
                "filename": path.name,
                "relative_path": path.relative_to(root).as_posix(),
            }
            for path in bounded
        ],
        "truncated": len(matching) > len(bounded),
        "error": None,
    }


def _watch_due(watch: CellFolderWatch, now: datetime) -> bool:
    if watch.cadence_value is None:
        return True
    previous = _aware(watch.last_scan_at)
    if previous is None:
        return True
    seconds = int(watch.cadence_value) * CADENCE_UNITS.get(watch.cadence_unit or "hours", 3600)
    return (now - previous).total_seconds() >= seconds


def _candidate_payload(candidate: CellFolderWatchCandidate) -> dict[str, Any]:
    return {
        "id": candidate.id,
        "path": candidate.path,
        "filename": candidate.filename,
        "hash": candidate.hash,
        "first_seen_at": _aware(candidate.first_seen_at).isoformat() if candidate.first_seen_at else None,
        "last_seen_at": _aware(candidate.last_seen_at).isoformat() if candidate.last_seen_at else None,
        "stability_state": candidate.stability_state,
        "status": candidate.status,
        "message": candidate.message,
        "attempt_count": candidate.attempt_count,
    }


def watch_payload(
    watch: CellFolderWatch | None,
    *,
    global_monitor_enabled: bool,
    automation_paused: bool = False,
) -> dict[str, Any] | None:
    if watch is None:
        return None
    if not watch.enabled:
        status = "disabled"
        status_message = "Folder tracking is disabled."
    elif not global_monitor_enabled:
        status = "paused"
        status_message = "Tracking paused — source monitoring is disabled."
    elif automation_paused:
        status = "paused"
        status_message = "Tracking paused — background automation is paused."
    else:
        status = "active"
        status_message = None
    return {
        "id": watch.id,
        "cell_id": watch.cell_id,
        "folder_path": watch.folder_path,
        "enabled": watch.enabled,
        "pattern_kind": watch.pattern_kind,
        "pattern": watch.pattern,
        "extension": watch.extension,
        "source_format": watch.source_format,
        "ordering_rule": watch.ordering_rule,
        "recursive": watch.recursive,
        "recursion_depth": watch.recursion_depth,
        "cadence_value": watch.cadence_value,
        "cadence_unit": watch.cadence_unit,
        "status": status,
        "status_message": status_message,
        "last_scan_at": _aware(watch.last_scan_at).isoformat() if watch.last_scan_at else None,
        "last_status": watch.last_status,
        "last_error": watch.last_error,
        "folder_last_seen_at": _aware(watch.folder_last_seen_at).isoformat()
        if watch.folder_last_seen_at
        else None,
        "consecutive_failures": watch.consecutive_failures,
        "candidates": [
            _candidate_payload(candidate)
            for candidate in watch.candidates
            if candidate.status != "ignored"
        ],
    }


def create_or_update_watch(
    db: Session,
    cell_id: int,
    config: dict[str, Any],
) -> CellFolderWatch:
    clean = validate_watch_config(config)
    watch = db.query(CellFolderWatch).filter(CellFolderWatch.cell_id == cell_id).one_or_none()
    if watch is None:
        watch = CellFolderWatch(cell_id=cell_id)
        db.add(watch)
    for key, value in clean.items():
        setattr(watch, key, value)
    watch.last_error = None
    watch.consecutive_failures = 0
    db.flush()
    return watch


def _candidate_for(db: Session, watch_id: int, path: str) -> CellFolderWatchCandidate:
    candidate = (
        db.query(CellFolderWatchCandidate)
        .filter(
            CellFolderWatchCandidate.watch_id == watch_id,
            CellFolderWatchCandidate.path == path,
        )
        .one_or_none()
    )
    if candidate is not None:
        return candidate
    now = utcnow()
    candidate = CellFolderWatchCandidate(
        watch_id=watch_id,
        path=path,
        filename=Path(path).name,
        first_seen_at=now,
        last_seen_at=now,
    )
    db.add(candidate)
    db.flush()
    return candidate


def _mark_candidate(
    candidate: CellFolderWatchCandidate,
    *,
    status: str,
    message: str | None = None,
    attempt: bool = False,
) -> None:
    candidate.status = status
    candidate.message = message
    candidate.stability_state = "stable" if status not in {"pending_stability"} else "pending"
    if attempt:
        candidate.attempt_count += 1


def _source_chain(db: Session, cell_id: int) -> tuple[Test, list[TestFile]]:
    test = db.query(Test).filter(Test.cell_id == cell_id).order_by(Test.id).one_or_none()
    if test is None:
        raise ValueError("The watched Cell no longer has its internal source chain.")
    links = (
        db.query(TestFile)
        .filter(TestFile.test_id == test.id)
        .order_by(TestFile.position)
        .all()
    )
    return test, links


def _candidate_request(candidate: CellFolderWatchCandidate, inspection: Any):
    from ..routers.files import ContinuationInspectSourceRequest, ImportIdentityReceipt

    return ContinuationInspectSourceRequest(
        staged_name=f"folder-watch-{candidate.watch_id}-{candidate.id}",
        source_path=candidate.path,
        inspection=ImportIdentityReceipt(
            hash=inspection.hash,
            size=inspection.size,
            mtime_ns=inspection.mtime_ns,
        ),
        allow_metadata_only=False,
    )


def _finding_message(analysis: dict[str, Any], severity: str) -> str | None:
    messages = [
        str(item.get("message") or item.get("title") or "Continuation validation failed.")
        for item in analysis.get("findings") or []
        if item.get("severity") == severity
    ]
    return "; ".join(messages) if messages else None


def _scan_one_watch(
    db: Session,
    watch: CellFolderWatch,
    *,
    now: datetime,
    stability_seconds: float,
    retry_count: int,
) -> dict[str, int | str]:
    root = Path(watch.folder_path)
    if not root.is_dir():
        watch.last_scan_at = now
        watch.last_status = "folder_missing"
        watch.last_error = f"Folder is missing or unavailable: {watch.folder_path}"
        watch.consecutive_failures += 1
        return {"status": "folder_missing", "attached": 0, "pending": 0}

    watch.folder_last_seen_at = now
    watch.last_error = None
    _test, links = _source_chain(db, watch.cell_id)
    existing_paths = {
        str(Path(link.file.path).expanduser().resolve())
        for link in links
        if link.file is not None
    }
    existing_hashes = {link.file.hash for link in links if link.file is not None}
    candidates: list[tuple[CellFolderWatchCandidate, Any]] = []
    pending = 0
    unresolved = 0

    for path in _iter_files(watch):
        normalized = str(path.resolve())
        if normalized in existing_paths:
            db.query(CellFolderWatchCandidate).filter(
                CellFolderWatchCandidate.watch_id == watch.id,
                CellFolderWatchCandidate.path == normalized,
            ).delete(synchronize_session=False)
            continue
        if path.suffix.lower().lstrip(".") != watch.extension:
            continue
        if not matches_filename(path.name, watch.pattern_kind, watch.pattern):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        candidate = _candidate_for(db, watch.id, normalized)
        candidate.filename = path.name
        signature_changed = (
            candidate.observed_size != stat.st_size
            or candidate.observed_mtime_ns != stat.st_mtime_ns
        )
        if signature_changed:
            candidate.observed_size = stat.st_size
            candidate.observed_mtime_ns = stat.st_mtime_ns
            candidate.first_seen_at = now
            candidate.last_seen_at = now
            candidate.hash = None
            candidate.attempt_count = 0
            _mark_candidate(candidate, status="pending_stability", message="Waiting for the file to stop changing.")
            pending += 1
            continue
        candidate.last_seen_at = now
        if candidate.status == "ignored":
            continue
        if candidate.status in TERMINAL_CANDIDATE_STATUSES and candidate.attempt_count >= retry_count:
            unresolved += 1
            continue
        first_seen = _aware(candidate.first_seen_at) or now
        if (now - first_seen).total_seconds() < max(0.0, stability_seconds):
            _mark_candidate(candidate, status="pending_stability", message="Waiting for the file to stop changing.")
            pending += 1
            continue
        try:
            inspection = import_inspection.inspect_file(normalized)
        except import_inspection.SourceInspectionRejection as exc:
            candidate.last_seen_at = now
            _mark_candidate(candidate, status="malformed", message=str(exc), attempt=True)
            unresolved += 1
            continue
        try:
            post_inspection_stat = path.stat()
        except OSError:
            post_inspection_stat = None
        if (
            post_inspection_stat is None
            or post_inspection_stat.st_size != inspection.size
            or post_inspection_stat.st_mtime_ns != inspection.mtime_ns
        ):
            candidate.observed_size = post_inspection_stat.st_size if post_inspection_stat else None
            candidate.observed_mtime_ns = post_inspection_stat.st_mtime_ns if post_inspection_stat else None
            candidate.first_seen_at = now
            candidate.hash = None
            _mark_candidate(
                candidate,
                status="pending_stability",
                message="The file changed during inspection; waiting for it to settle.",
            )
            pending += 1
            continue
        candidate.hash = inspection.hash
        candidate.last_seen_at = now
        metadata_format = str(inspection.metadata.get("source_format") or "").strip()
        if watch.source_format and metadata_format and metadata_format.casefold() != watch.source_format.casefold():
            _mark_candidate(
                candidate,
                status="unsupported",
                message=(
                    f"The file reports format {metadata_format}, but this watch expects "
                    f"{watch.source_format}."
                ),
                attempt=True,
            )
            unresolved += 1
            continue
        if inspection.hash in existing_hashes:
            db.delete(candidate)
            continue
        registered = db.query(SourceFile).filter(SourceFile.hash == inspection.hash).one_or_none()
        if registered is not None and registered.test_link is not None:
            if registered.test_link.test.cell_id == watch.cell_id:
                db.delete(candidate)
                continue
            other_cell = registered.test_link.test.cell
            _mark_candidate(
                candidate,
                status="duplicate",
                message=f"This content is already registered to Cell {other_cell.name}.",
                attempt=True,
            )
            unresolved += 1
            continue
        candidates.append((candidate, inspection))

    ordered = sorted(
        candidates,
        key=lambda item: candidate_order_key(
            item[0].filename,
            item[1].metadata.get("start_time"),
            item[1].hash,
            watch.ordering_rule,
        ),
    )
    if not ordered:
        watch.last_scan_at = now
        watch.last_status = (
            "candidates_pending"
            if unresolved
            else "ready" if pending == 0 else "waiting_for_stability"
        )
        watch.consecutive_failures = 0
        return {"status": watch.last_status, "attached": 0, "pending": pending}

    from ..routers import files

    requests = []
    inspected_candidates: list[tuple[CellFolderWatchCandidate, Any]] = []
    attachable: list[tuple[CellFolderWatchCandidate, Any]] = []
    stop_index: int | None = None
    ambiguous_index: int | None = None
    for index in range(len(ordered) - 1):
        first_candidate, first_inspection = ordered[index]
        second_candidate, second_inspection = ordered[index + 1]
        first_timestamp = parse_source_timestamp(first_inspection.metadata.get("start_time"))
        second_timestamp = parse_source_timestamp(second_inspection.metadata.get("start_time"))
        same_timestamp = (
            first_timestamp is None and second_timestamp is None
        ) or (
            first_timestamp is not None
            and second_timestamp is not None
            and first_timestamp == second_timestamp
        )
        same_name = first_candidate.filename.casefold() == second_candidate.filename.casefold()
        same_hash = first_inspection.hash.casefold() == second_inspection.hash.casefold()
        if same_name and same_hash and (watch.ordering_rule == "filename" or same_timestamp):
            message = (
                f"The ordering is ambiguous between {first_candidate.filename} and "
                f"{second_candidate.filename}; rename one file or choose another ordering rule."
            )
            _mark_candidate(first_candidate, status="ambiguous_order", message=message, attempt=True)
            _mark_candidate(second_candidate, status="ambiguous_order", message=message, attempt=True)
            ambiguous_index = index
            break
    for index, item in enumerate(ordered):
        candidate, inspection = item
        if index == ambiguous_index:
            inspected_candidates.append(item)
            stop_index = index
            break
        try:
            current_stat = Path(candidate.path).stat()
        except OSError:
            current_stat = None
        if (
            current_stat is None
            or current_stat.st_size != inspection.size
            or current_stat.st_mtime_ns != inspection.mtime_ns
        ):
            candidate.observed_size = current_stat.st_size if current_stat else None
            candidate.observed_mtime_ns = current_stat.st_mtime_ns if current_stat else None
            candidate.first_seen_at = now
            candidate.hash = None
            _mark_candidate(
                candidate,
                status="pending_stability",
                message="The file changed before attachment; waiting for it to settle.",
            )
            inspected_candidates.append(item)
            stop_index = index
            break
        request = _candidate_request(candidate, inspection)
        requests.append(request)
        inspected_candidates.append(item)
        try:
            analysis = files.inspect_cell_continuation_sources(
                watch.cell_id,
                files.ContinuationInspectRequest(sources=list(requests)),
                db,
            )
        except Exception as exc:
            _mark_candidate(candidate, status="attach_failed", message=str(exc), attempt=True)
            stop_index = index
            break
        if not analysis.get("inspection_complete"):
            _mark_candidate(
                candidate,
                status="attach_failed",
                message="Continuation inspection is still preparing; the watcher will retry.",
                attempt=True,
            )
            stop_index = index
            break
        blocking = _finding_message(analysis, "blocking")
        confirmation = _finding_message(analysis, "confirmation")
        if blocking:
            _mark_candidate(candidate, status="blocked_by_finding", message=blocking, attempt=True)
            stop_index = index
            break
        if confirmation:
            _mark_candidate(candidate, status="needs_confirmation", message=confirmation, attempt=True)
            stop_index = index
            break
        if not analysis.get("can_submit"):
            _mark_candidate(candidate, status="attach_failed", message="The continuation chain is not ready for automatic attachment.", attempt=True)
            stop_index = index
            break
        attachable.append(item)

    if stop_index is not None:
        for candidate, _inspection in ordered[stop_index + 1 :]:
            if candidate.status != "ambiguous_order":
                _mark_candidate(
                    candidate,
                    status="blocked_by_finding",
                    message="Attachment stopped at an earlier candidate; resolve it before continuing.",
                )
    if not attachable:
        watch.last_scan_at = now
        watch.last_status = "candidates_pending"
        watch.last_error = "One or more matching files need attention before attachment."
        watch.consecutive_failures += 1
        return {"status": watch.last_status, "attached": 0, "pending": len(ordered)}

    attach_requests = [_candidate_request(candidate, inspection) for candidate, inspection in attachable]
    try:
        files.attach_cell_continuations(
            watch.cell_id,
            files.AttachContinuationsRequest(sources=attach_requests),
            db,
        )
    except Exception as exc:
        db.rollback()
        for candidate, _inspection in attachable:
            _mark_candidate(candidate, status="attach_failed", message=str(exc), attempt=True)
        watch.last_scan_at = now
        watch.last_status = "attach_failed"
        watch.last_error = str(exc)
        watch.consecutive_failures += 1
        return {"status": watch.last_status, "attached": 0, "pending": len(ordered)}

    for candidate, _inspection in attachable:
        db.delete(candidate)
    watch.last_scan_at = now
    watch.last_status = "attached"
    watch.last_error = None
    watch.consecutive_failures = 0
    return {"status": watch.last_status, "attached": len(attachable), "pending": max(0, len(ordered) - len(attachable))}


def run_folder_watch_pass(
    db: Session,
    *,
    monitor_enabled: bool,
    automation_paused: bool,
    stability_seconds: float,
    retry_count: int,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Run one pass from the existing source-monitor scheduler thread."""
    if not monitor_enabled or automation_paused:
        return []
    current = now or utcnow()
    watches = db.query(CellFolderWatch).filter(CellFolderWatch.enabled == True).all()  # noqa: E712
    results: list[dict[str, Any]] = []
    for watch in watches:
        if not _watch_due(watch, current):
            continue
        try:
            result = _scan_one_watch(
                db,
                watch,
                now=current,
                stability_seconds=stability_seconds,
                retry_count=max(1, int(retry_count)),
            )
        except Exception as exc:
            db.rollback()
            watch = db.query(CellFolderWatch).filter(CellFolderWatch.id == watch.id).one_or_none()
            if watch is not None:
                watch.last_scan_at = current
                watch.last_status = "failed"
                watch.last_error = str(exc)
                watch.consecutive_failures += 1
                result = {"status": "failed", "attached": 0, "pending": 0}
            else:
                result = {"status": "failed", "attached": 0, "pending": 0}
        db.commit()
        results.append({"watch_id": watch.id, **result})
    return results


def reset_candidate(db: Session, cell_id: int, candidate_id: int) -> CellFolderWatchCandidate:
    candidate = (
        db.query(CellFolderWatchCandidate)
        .join(CellFolderWatch)
        .filter(
            CellFolderWatch.cell_id == cell_id,
            CellFolderWatchCandidate.id == candidate_id,
        )
        .one_or_none()
    )
    if candidate is None:
        raise ValueError("Folder-tracking candidate was not found.")
    now = utcnow()
    candidate.status = "pending_stability"
    candidate.stability_state = "pending"
    candidate.message = None
    candidate.attempt_count = 0
    candidate.first_seen_at = now
    candidate.last_seen_at = now
    return candidate


def delete_candidate(db: Session, cell_id: int, candidate_id: int) -> bool:
    candidate = (
        db.query(CellFolderWatchCandidate)
        .join(CellFolderWatch)
        .filter(
            CellFolderWatch.cell_id == cell_id,
            CellFolderWatchCandidate.id == candidate_id,
        )
        .one_or_none()
    )
    if candidate is None:
        return False
    candidate.status = "ignored"
    candidate.stability_state = "stable"
    candidate.message = "Ignored by the user. Retry to inspect it again."
    return True
