"""Thread-safe filesystem inspection and immutable import identity matching."""
from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from stat import S_ISREG
from typing import Callable

from sqlalchemy.orm import Session, joinedload

from ..models import SourceFile, Test, TestFile
from .lazy_module import LazyModule


def _load_parsing():
    from . import parsing as module

    return module


parsing = LazyModule(_load_parsing)


def inspection_worker_count(path_count: int) -> int:
    """Return the deliberately small, deterministic filesystem worker bound."""
    return min(4, max(1, path_count))


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
    if path.suffix.lower() not in {".nda", ".ndax"}:
        raise ValueError(f"Only .nda and .ndax files can be imported: {filename}")
    file_hash = parsing.compute_hash(path)
    metadata = parsing.read_header_metadata(path)
    try:
        final = path.stat()
    except OSError as exc:
        raise ValueError(f"Source became unavailable during inspection: {filename}") from exc
    if initial.st_size != final.st_size or initial.st_mtime_ns != final.st_mtime_ns:
        raise ValueError(f"Source changed during inspection: {filename}")
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
) -> list[FileInspection]:
    """Inspect paths concurrently, restoring input order before returning."""
    if not paths:
        return []
    results: list[FileInspection | None] = [None] * len(paths)
    with ThreadPoolExecutor(max_workers=inspection_worker_count(len(paths))) as executor:
        futures: dict[Future[FileInspection], int] = {
            executor.submit(inspect_file, path): index for index, path in enumerate(paths)
        }
        try:
            for future in as_completed(futures):
                index = futures[future]
                results[index] = future.result()
                if on_completed is not None:
                    on_completed(paths[index])
        except Exception:
            for future in futures:
                future.cancel()
            raise
    return [result for result in results if result is not None]
