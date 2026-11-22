"""Thread-safe filesystem inspection and immutable import identity matching."""
from __future__ import annotations

from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
import threading
import time
from time import perf_counter
from typing import Callable

from sqlalchemy.orm import Session

from ..models import Cell, SourceFile, Test, TestFile
from .lazy_module import LazyModule
from .process_priority import process_pool_executor
from .source_extensions import source_suffix


def _load_parsing():
    from . import parsing as module

    return module


parsing = LazyModule(_load_parsing)

_HEADER_CACHE_LIMIT = 1024
INSPECTION_PROCESS_THRESHOLD = 25
INSPECTION_READING_START_PERCENT = 10.0
INSPECTION_READING_END_PERCENT = 90.0
_header_cache: OrderedDict[tuple[str, int, int, str], dict] = OrderedDict()
_header_cache_lock = threading.Lock()


class SourceInspectionRejection(ValueError):
    """A selected source is invalid, unsupported, or moving during inspection."""

    def __init__(self, message: str, *, kind: str | None = None):
        super().__init__(message)
        self.kind = kind


class ImportInspectionCancelled(Exception):
    """Raised when an active import inspection batch is cancelled."""


def remember_header_metadata(file_hash: str, size: int, mtime_ns: int, metadata: dict) -> None:
    key = (file_hash, size, mtime_ns, parsing.source_read_mode(metadata))
    with _header_cache_lock:
        _header_cache[key] = metadata
        _header_cache.move_to_end(key)
        while len(_header_cache) > _HEADER_CACHE_LIMIT:
            _header_cache.popitem(last=False)


def cached_header_metadata(file_hash: str, size: int, mtime_ns: int, *, read_mode: str = "safe") -> dict | None:
    key = (file_hash, size, mtime_ns, read_mode)
    with _header_cache_lock:
        metadata = _header_cache.get(key)
        if metadata is not None:
            _header_cache.move_to_end(key)
        return metadata


def inspection_worker_count(path_count: int) -> int:
    """Return the deliberately small, deterministic filesystem worker bound."""
    return min(4, max(1, path_count))


def inspection_strategy(path_count: int) -> str:
    """Choose the low-overhead inspection strategy for one import batch."""
    return "multiprocessing" if path_count > INSPECTION_PROCESS_THRESHOLD else "serial"


def inspection_estimate_seconds(
    sample_seconds: float,
    path_count: int,
    strategy: str,
    worker_count: int,
) -> float:
    """Estimate the complete raw-read interval from the first inspected source."""
    if path_count <= 0:
        return 0.0
    sample = max(0.05, float(sample_seconds))
    if strategy in {"multiprocessing", "threaded"}:
        remaining = max(0, path_count - 1)
        return sample + (remaining * sample / max(1, worker_count))
    return sample * path_count


@dataclass(frozen=True)
class ImportMatchCandidate:
    source_file_id: int
    hash: str
    filename: str
    barcode: str | None
    channel: str | None
    start_time: str | None
    remarks: str | None
    registered: bool
    archived: bool
    cell_id: int | None
    cell_name: str | None
    test_id: int | None
    test_name: str | None
    path: str
    location_status: str
    parse_status: str


@dataclass(frozen=True)
class ImportIdentitySnapshot:
    exact_by_hash: dict[str, ImportMatchCandidate]
    soft_candidates: tuple[ImportMatchCandidate, ...]


@dataclass(frozen=True)
class FileInspection:
    path: str
    filename: str
    size: int
    mtime_ns: int
    ext: str
    hash: str
    metadata: dict


@dataclass(frozen=True)
class FileInspectionOutcome:
    """The terminal result for one selected source inspection."""

    path: str
    inspection: FileInspection | None
    error: str | None
    error_kind: str | None = None


def build_identity_snapshot(db: Session) -> ImportIdentitySnapshot:
    """Load identity scalar columns once without deserializing header_meta JSON."""
    rows = (
        db.query(
            SourceFile.id,
            SourceFile.hash,
            SourceFile.filename,
            SourceFile.barcode,
            SourceFile.channel,
            SourceFile.start_time,
            SourceFile.remarks,
            SourceFile.path,
            SourceFile.location_status,
            SourceFile.parse_status,
            Test.id,
            Test.name,
            Cell.id,
            Cell.name,
            Cell.archived,
        )
        .outerjoin(TestFile, TestFile.file_id == SourceFile.id)
        .outerjoin(Test, Test.id == TestFile.test_id)
        .outerjoin(Cell, Cell.id == Test.cell_id)
        .all()
    )
    candidates: list[ImportMatchCandidate] = []
    for (
        source_file_id,
        file_hash,
        filename,
        barcode,
        channel,
        start_time,
        remarks,
        path,
        location_status,
        parse_status,
        test_id,
        test_name,
        cell_id,
        cell_name,
        cell_archived,
    ) in rows:
        has_test = test_id is not None
        has_cell = cell_id is not None
        archived = has_cell and bool(cell_archived)
        candidates.append(
            ImportMatchCandidate(
                source_file_id=int(source_file_id),
                hash=file_hash,
                filename=filename,
                barcode=barcode,
                channel=channel,
                start_time=start_time,
                remarks=remarks,
                registered=has_test and has_cell and not archived,
                archived=archived,
                cell_id=int(cell_id) if has_test and has_cell else None,
                cell_name=cell_name if has_cell else None,
                test_id=int(test_id) if has_test else None,
                test_name=test_name if has_test else None,
                path=path,
                location_status=location_status,
                parse_status=parse_status,
            )
        )
    return ImportIdentitySnapshot(
        exact_by_hash={candidate.hash: candidate for candidate in candidates},
        soft_candidates=tuple(candidates),
    )


def _norm(value: object) -> str:
    return str(value or "").strip().lower()


def _payload(candidate: ImportMatchCandidate, kind: str, matched_on: list[str]) -> dict:
    return {
        "kind": kind,
        "matched_on": matched_on,
        "source_file_id": candidate.source_file_id,
        "filename": candidate.filename,
        "path": candidate.path,
        "hash": candidate.hash,
        "cell_id": candidate.cell_id,
        "cell_name": candidate.cell_name,
        "test_id": candidate.test_id,
        "test_name": candidate.test_name,
        "registered": candidate.registered,
        "location_status": candidate.location_status,
        "parse_status": candidate.parse_status,
    }


def match_import(snapshot: ImportIdentitySnapshot, file_hash: str, filename: str, meta: dict) -> dict | None:
    candidate = snapshot.exact_by_hash.get(file_hash)
    if candidate is not None:
        if candidate.archived:
            return None
        return _payload(candidate, "exact_duplicate", ["hash"])

    filename_norm = _norm(Path(filename).name)
    meta_fields = {
        "barcode": _norm(meta.get("barcode")),
        "channel": _norm(meta.get("channel")),
        "start_time": _norm(meta.get("start_time")),
        "remarks": _norm(meta.get("remarks")),
    }
    best: tuple[int, ImportMatchCandidate, list[str]] | None = None
    for item in snapshot.soft_candidates:
        matched_on: list[str] = []
        if filename_norm and filename_norm == _norm(item.filename):
            matched_on.append("filename")
        for key, value in meta_fields.items():
            if value and value == _norm(getattr(item, key)):
                matched_on.append(key)
        if ("filename" in matched_on and len(matched_on) >= 2) or len(matched_on) >= 3:
            score = len(matched_on)
            if best is None or score > best[0]:
                best = (score, item, matched_on)
    if best is None:
        return None
    _, item, matched_on = best
    return _payload(item, "possible_update", matched_on)


def inspect_file(
    path_string: str,
    *,
    read_mode: str = "safe",
    is_cancelled: Callable[[], bool] | None = None,
) -> FileInspection:
    """Inspect one file using filesystem/parser work only; no DB/session."""
    if is_cancelled is not None and is_cancelled():
        raise ImportInspectionCancelled("Import inspection cancelled.")
    path = Path(path_string)
    filename = path.name
    if not parsing.source_filename_allowed(filename):
        raise SourceInspectionRejection(
            f"{parsing.SUPPORTED_SOURCE_DESCRIPTION}; unsupported file: {filename}"
        )
    try:
        fingerprint = (
            parsing.capture_source_fingerprint(path, cancel_check=is_cancelled)
            if is_cancelled is not None
            else parsing.capture_source_fingerprint(path)
        )
    except parsing.SourceReadCancelled as exc:
        raise ImportInspectionCancelled("Import inspection cancelled.") from exc
    except parsing.SourceIdentityError as exc:
        if "changed" in str(exc).casefold():
            raise SourceInspectionRejection(
                f"Source changed during inspection: {filename}"
            ) from exc
        raise SourceInspectionRejection(
            f"Could not establish a stable source identity: {filename}"
        ) from exc
    if is_cancelled is not None and is_cancelled():
        raise ImportInspectionCancelled("Import inspection cancelled.")
    metadata = parsing.metadata_for_read_mode(path, parsing.read_header_metadata(path), read_mode)
    if is_cancelled is not None and is_cancelled():
        raise ImportInspectionCancelled("Import inspection cancelled.")
    try:
        parsing.ensure_supported_source_metadata(path, metadata)
    except ValueError as exc:
        kind = "unsupported" if isinstance(exc, parsing.UnsupportedSourceFormatError) else "invalid" if isinstance(exc, parsing.InvalidSourceFormatError) else None
        raise SourceInspectionRejection(str(exc), kind=kind) from exc
    try:
        # capture_source_fingerprint already performed the single digest read
        # for this inspection; this boundary only needs a cheap stat guard.
        parsing.assert_source_fingerprint(path, fingerprint, verify_hash=False)
    except parsing.SourceIdentityError as exc:
        raise SourceInspectionRejection(
            f"Source changed during inspection: {filename}"
        ) from exc
    remember_header_metadata(fingerprint.hash, fingerprint.size, fingerprint.mtime_ns, metadata)
    return FileInspection(
        path=str(path),
        filename=filename,
        size=fingerprint.size,
        mtime_ns=fingerprint.mtime_ns,
        ext=source_suffix(path).lstrip("."),
        hash=fingerprint.hash,
        metadata=metadata,
    )


def _inspect_file_outcome(
    path_string: str,
    read_mode: str = "safe",
    is_cancelled: Callable[[], bool] | None = None,
) -> FileInspectionOutcome:
    """Convert source-level inspection errors into a picklable batch outcome."""

    try:
        kwargs: dict = {}
        if read_mode != "safe":
            kwargs["read_mode"] = read_mode
        if is_cancelled is not None:
            kwargs["is_cancelled"] = is_cancelled
        inspection = inspect_file(path_string, **kwargs)
        return FileInspectionOutcome(
            path=path_string,
            inspection=inspection,
            error=None,
        )
    except SourceInspectionRejection as exc:
        message = str(exc).strip() or f"Could not inspect {Path(path_string).name or path_string}."
        return FileInspectionOutcome(
            path=path_string,
            inspection=None,
            error=message,
            error_kind=exc.kind,
        )


def _shutdown_executor_cancelled(executor: object) -> None:
    if isinstance(executor, ProcessPoolExecutor):
        for process in list((getattr(executor, "_processes", None) or {}).values()):
            try:
                process.terminate()
            except Exception:
                pass
    try:
        executor.shutdown(wait=False, cancel_futures=True)  # type: ignore[attr-defined]
    except TypeError:
        executor.shutdown(wait=False)  # type: ignore[attr-defined]


def inspect_files(
    paths: list[str],
    *,
    read_mode: str = "safe",
    on_completed: Callable[[str], None] | None = None,
    on_outcome: Callable[[FileInspectionOutcome], None] | None = None,
    on_phase: Callable[[dict], None] | None = None,
    executor_cls: type | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    network_io: bool = False,
) -> list[FileInspectionOutcome]:
    """Inspect paths with an adaptive strategy, restoring input order before returning.

    One source is inspected in the caller's worker first. Its result is retained, so the sample
    both calibrates the user-facing estimate and becomes the first batch result. Small batches then
    continue serially; larger batches pay the process-pool startup cost only when there is enough
    remaining work to amortize it. Every path receives an outcome, so one unreadable source does
    not prevent the remaining files from reaching the import review.
    """
    if not paths:
        return []

    def check_cancelled() -> None:
        if is_cancelled is not None and is_cancelled():
            raise ImportInspectionCancelled("Import inspection cancelled.")

    check_cancelled()

    total = len(paths)
    results: list[FileInspectionOutcome | None] = [None] * len(paths)
    use_network_threads = network_io and executor_cls is None and total > 1
    if use_network_threads:
        strategy = "threaded"
        worker_count = min(8, total)
    else:
        strategy = inspection_strategy(total)
        worker_count = inspection_worker_count(total) if strategy == "multiprocessing" else 1

    def emit_phase(**values: object) -> None:
        if on_phase is not None:
            on_phase(values)

    def reading_percent(completed: int) -> float:
        return min(
            INSPECTION_READING_END_PERCENT,
            INSPECTION_READING_START_PERCENT
            + (INSPECTION_READING_END_PERCENT - INSPECTION_READING_START_PERCENT)
            * completed / max(1, total),
        )

    emit_phase(
        phase="sampling",
        phase_current=0,
        phase_total=1,
        completed_count=0,
        current_item_id=paths[0],
        current_item_label=Path(paths[0]).name or paths[0],
        progress_percent=0.0,
    )
    sample_started = perf_counter()
    sampled = _inspect_file_outcome(paths[0], read_mode, is_cancelled)
    sample_seconds = perf_counter() - sample_started
    results[0] = sampled
    if on_outcome is not None:
        on_outcome(sampled)
    if on_completed is not None:
        on_completed(paths[0])
    check_cancelled()
    estimate_seconds = inspection_estimate_seconds(
        sample_seconds,
        total,
        strategy,
        worker_count,
    )
    emit_phase(
        phase="sampling",
        phase_current=1,
        phase_total=1,
        completed_count=1,
        current_item_id=paths[0],
        current_item_label=Path(paths[0]).name or paths[0],
        progress_percent=5.0,
        strategy=strategy,
        worker_count=worker_count,
        sample_duration_seconds=sample_seconds,
        estimated_total_seconds=estimate_seconds,
        estimate_scope="total",
    )

    remaining = paths[1:]
    if not remaining:
        emit_phase(
            phase="reading",
            phase_current=1,
            phase_total=total,
            completed_count=1,
            current_item_id=paths[0],
            current_item_label=Path(paths[0]).name or paths[0],
            progress_percent=INSPECTION_READING_END_PERCENT,
            strategy=strategy,
            worker_count=worker_count,
            sample_duration_seconds=sample_seconds,
            estimated_total_seconds=estimate_seconds,
            estimate_scope="total",
        )
        return [result for result in results if result is not None]

    if strategy == "multiprocessing":
        # This short, truthful phase gives the client a visible state while Windows starts the
        # bounded worker pool. It is deliberately skipped for serial batches.
        for core in range(1, worker_count + 1):
            check_cancelled()
            emit_phase(
                phase="starting_workers",
                phase_current=core,
                phase_total=worker_count,
                completed_count=1,
                current_item_id=None,
                current_item_label=None,
                phase_detail=f"Preparing multiprocessing worker {core} of {worker_count}",
                progress_percent=5.0 + (5.0 * core / max(1, worker_count)),
                strategy=strategy,
                worker_count=worker_count,
                sample_duration_seconds=sample_seconds,
                estimated_total_seconds=estimate_seconds,
                estimate_scope="total",
            )
            if on_phase is not None:
                time.sleep(0.12)

    emit_phase(
        phase="reading",
        phase_current=1,
        phase_total=total,
        completed_count=1,
        current_item_id=paths[0],
        current_item_label=Path(paths[0]).name or paths[0],
        progress_percent=reading_percent(1),
        strategy=strategy,
        worker_count=worker_count,
        sample_duration_seconds=sample_seconds,
        estimated_total_seconds=estimate_seconds,
        estimate_scope="total",
    )

    def store_result(index: int, outcome: FileInspectionOutcome) -> None:
        # Process workers have independent in-memory caches. Keep the parent cache authoritative
        # for the registration step and for subsequent requests in this backend process.
        if outcome.inspection is not None:
            inspected = outcome.inspection
            remember_header_metadata(
                inspected.hash,
                inspected.size,
                inspected.mtime_ns,
                inspected.metadata,
            )
        results[index] = outcome
        if on_outcome is not None:
            on_outcome(outcome)
        if on_completed is not None:
            on_completed(paths[index])
        completed = sum(result is not None for result in results)
        emit_phase(
            phase="reading",
            phase_current=completed,
            phase_total=total,
            completed_count=completed,
            current_item_id=paths[index],
            current_item_label=Path(paths[index]).name or paths[index],
            progress_percent=reading_percent(completed),
            strategy=strategy,
            worker_count=worker_count,
            sample_duration_seconds=sample_seconds,
            estimated_total_seconds=estimate_seconds,
            estimate_scope="total",
        )

    if strategy == "serial" and executor_cls is None:
        for index, path in enumerate(remaining, start=1):
            check_cancelled()
            store_result(index, _inspect_file_outcome(path, read_mode, is_cancelled))
    else:
        if use_network_threads:
            executor = ThreadPoolExecutor(max_workers=worker_count)
            pass_cancel = is_cancelled
        elif executor_cls is None or executor_cls is ProcessPoolExecutor:
            executor = process_pool_executor(worker_count)
            pass_cancel = None
        else:
            executor = executor_cls(max_workers=worker_count)
            pass_cancel = is_cancelled if not isinstance(executor, ProcessPoolExecutor) else None
        futures: dict[Future[FileInspectionOutcome], int] = {
            executor.submit(_inspect_file_outcome, path, read_mode, pass_cancel): index
            for index, path in enumerate(remaining, start=1)
        }
        shut_down = False
        try:
            for future in as_completed(futures):
                check_cancelled()
                index = futures[future]
                # Source-level errors are converted by the top-level
                # wrapper. Exceptions from the executor itself (for
                # example a broken process pool) must propagate so the
                # job is not falsely reported as a successful inspection.
                store_result(index, future.result())
        except Exception as exc:
            for future in futures:
                future.cancel()
            if isinstance(exc, ImportInspectionCancelled):
                _shutdown_executor_cancelled(executor)
                shut_down = True
            else:
                executor.shutdown(wait=True)
                shut_down = True
            raise
        finally:
            if not shut_down:
                executor.shutdown(wait=True)
    return [result for result in results if result is not None]
