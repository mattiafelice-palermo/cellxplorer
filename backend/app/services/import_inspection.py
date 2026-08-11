"""Thread-safe filesystem inspection and immutable import identity matching."""
from __future__ import annotations

from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from stat import S_ISREG
import threading
import time
from time import perf_counter
from typing import Callable

from sqlalchemy.orm import Session, joinedload

from ..models import SourceFile, Test, TestFile
from .lazy_module import LazyModule
from .process_priority import process_pool_executor


def _load_parsing():
    from . import parsing as module

    return module


parsing = LazyModule(_load_parsing)

_HEADER_CACHE_LIMIT = 1024
INSPECTION_PROCESS_THRESHOLD = 25
INSPECTION_READING_START_PERCENT = 10.0
INSPECTION_READING_END_PERCENT = 90.0
_header_cache: OrderedDict[tuple[str, int, int], dict] = OrderedDict()
_header_cache_lock = threading.Lock()


def remember_header_metadata(file_hash: str, size: int, mtime_ns: int, metadata: dict) -> None:
    key = (file_hash, size, mtime_ns)
    with _header_cache_lock:
        _header_cache[key] = metadata
        _header_cache.move_to_end(key)
        while len(_header_cache) > _HEADER_CACHE_LIMIT:
            _header_cache.popitem(last=False)


def cached_header_metadata(file_hash: str, size: int, mtime_ns: int) -> dict | None:
    key = (file_hash, size, mtime_ns)
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
    if strategy == "multiprocessing":
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


def build_identity_snapshot(db: Session) -> ImportIdentitySnapshot:
    """Load all identity data once, with relationships eager-loaded."""
    rows = (
        db.query(SourceFile)
        .options(joinedload(SourceFile.test_link).joinedload(TestFile.test).joinedload(Test.cell))
        .all()
    )
    candidates: list[ImportMatchCandidate] = []
    for sf in rows:
        link = sf.test_link
        test = link.test if link is not None else None
        cell = test.cell if test is not None else None
        candidates.append(
            ImportMatchCandidate(
                source_file_id=sf.id,
                hash=sf.hash,
                filename=sf.filename,
                barcode=sf.barcode,
                channel=sf.channel,
                start_time=sf.start_time,
                remarks=sf.remarks,
                registered=link is not None and cell is not None and not cell.archived,
                archived=cell is not None and cell.archived,
                cell_id=test.cell_id if test is not None else None,
                cell_name=cell.name if cell is not None else None,
                test_id=test.id if test is not None else None,
                test_name=test.name if test is not None else None,
                path=sf.path,
                location_status=sf.location_status,
                parse_status=sf.parse_status,
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


def inspect_file(path_string: str) -> FileInspection:
    """Inspect one file using filesystem/parser work only; no DB/session."""
    path = Path(path_string)
    try:
        initial = path.stat()
    except OSError as exc:
        raise ValueError(f"File is missing or unreadable: {path}") from exc
    if not S_ISREG(initial.st_mode):
        raise ValueError(f"File is missing: {path}")
    filename = path.name
    if not parsing.source_filename_allowed(filename):
        raise ValueError(
            f"Only Neware .nda, .ndax, and structured .xlsx exports can be imported: {filename}"
        )
    file_hash = parsing.compute_hash(path)
    metadata = parsing.read_header_metadata(path)
    parsing.ensure_supported_source_metadata(path, metadata)
    try:
        final = path.stat()
    except OSError as exc:
        raise ValueError(f"Source became unavailable during inspection: {filename}") from exc
    if initial.st_size != final.st_size or initial.st_mtime_ns != final.st_mtime_ns:
        raise ValueError(f"Source changed during inspection: {filename}")
    remember_header_metadata(file_hash, final.st_size, final.st_mtime_ns, metadata)
    return FileInspection(
        path=str(path),
        filename=filename,
        size=final.st_size,
        mtime_ns=final.st_mtime_ns,
        ext=path.suffix.lower().lstrip("."),
        hash=file_hash,
        metadata=metadata,
    )


def inspect_files(
    paths: list[str],
    *,
    on_completed: Callable[[str], None] | None = None,
    on_phase: Callable[[dict], None] | None = None,
    executor_cls: type | None = None,
) -> list[FileInspection]:
    """Inspect paths with an adaptive strategy, restoring input order before returning.

    One source is inspected in the caller's worker first. Its result is retained, so the sample
    both calibrates the user-facing estimate and becomes the first batch result. Small batches then
    continue serially; larger batches pay the process-pool startup cost only when there is enough
    remaining work to amortize it.
    """
    if not paths:
        return []

    total = len(paths)
    results: list[FileInspection | None] = [None] * len(paths)
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
    sampled = inspect_file(paths[0])
    sample_seconds = perf_counter() - sample_started
    results[0] = sampled
    if on_completed is not None:
        on_completed(paths[0])
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

    def store_result(index: int, inspected: FileInspection) -> None:
        # Process workers have independent in-memory caches. Keep the parent cache authoritative
        # for the registration step and for subsequent requests in this backend process.
        remember_header_metadata(
            inspected.hash,
            inspected.size,
            inspected.mtime_ns,
            inspected.metadata,
        )
        results[index] = inspected
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
            store_result(index, inspect_file(path))
    else:
        executor = (
            process_pool_executor(worker_count)
            if executor_cls is None or executor_cls is ProcessPoolExecutor
            else executor_cls(max_workers=worker_count)
        )
        with executor:
            futures: dict[Future[FileInspection], int] = {
                executor.submit(inspect_file, path): index
                for index, path in enumerate(remaining, start=1)
            }
            try:
                for future in as_completed(futures):
                    store_result(futures[future], future.result())
            except Exception:
                for future in futures:
                    future.cancel()
                raise
    return [result for result in results if result is not None]
