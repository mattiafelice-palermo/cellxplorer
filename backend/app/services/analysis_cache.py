"""Disposable, versioned caches for analysis responses and plot artifacts.

The database and Parquet files remain canonical.  Everything here may be
deleted at any time and is keyed by the complete scientific input signature.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import CACHE_DIR, CALC_VERSION
from . import parsing

ANALYSIS_CACHE_VERSION = 1
ANALYSIS_CACHE_LIMIT_BYTES = 512 * 1024 * 1024
_ROOT = CACHE_DIR / "analysis"
_RESULTS = _ROOT / "results"
_ARTIFACTS = _ROOT / "artifacts"
_lock = threading.RLock()


def _json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _digest(value: object) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _atomic_gzip(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        with gzip.open(temporary, "wb", compresslevel=3) as target:
            target.write(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _scientific_spec(spec: dict) -> dict:
    presentation = spec.get("presentation") or {}
    return {
        "selection": spec.get("selection") or {},
        "computation": spec.get("computation") or {},
        "aggregation": spec.get("aggregation") or {},
        "protocol_segments": spec.get("protocol_segments") or [],
        "hidden_protocol_segment_ids": presentation.get("hidden_protocol_segment_ids") or [],
    }


def result_key(
    db: Session,
    kind: str,
    spec: dict,
    provenance: dict | None,
    *,
    use_current_versions: bool,
    request_options: dict | None = None,
) -> str:
    # Local import avoids analysis_engine -> cache -> analysis_cache cycles.
    from . import analysis_engine as engine

    parser_version = parsing.PARSER_VERSION
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        parser_version = provenance.get("parser_version") or parser_version
        calc_version = provenance.get("calc_version") or calc_version

    units, missing = engine.resolve_selection(db, spec)
    unit_fingerprints: list[dict[str, Any]] = []
    for unit in units:
        cell = unit["cell"]
        hashes, files = engine.cell_ordered_hashes(db, cell)
        unit_fingerprints.append(
            {
                "entry_kind": unit["entry_kind"],
                "entry_ref_id": unit["entry_ref_id"],
                "cell_id": cell.id,
                "cell_name": cell.name,
                "label": unit["label"],
                "group_id": unit["group_id"],
                "group_name": unit["group_name"],
                "hashes": hashes,
                "locations": [file.location_status for file in files],
                "active_mass_mg": engine.cell_active_mass_mg(cell),
                "nominal_capacity_mah": engine.cell_nominal_capacity_mah(cell),
                "electrode_area_cm2": engine.cell_electrode_area_cm2(cell),
                "archived": bool(cell.archived),
            }
        )
    return _digest(
        {
            "cache_version": ANALYSIS_CACHE_VERSION,
            "kind": kind,
            "parser_version": parser_version,
            "calc_version": calc_version,
            "spec": _scientific_spec(spec),
            "units": unit_fingerprints,
            "missing": missing,
            "options": request_options or {},
        }
    )


def _result_path(kind: str, key: str) -> Path:
    safe_kind = "".join(character if character.isalnum() or character in "_-" else "_" for character in kind)
    return _RESULTS / safe_kind / key[:2] / f"{key}.json.gz"


def load_result(kind: str, key: str) -> dict | None:
    path = _result_path(kind, key)
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rb") as source:
            result = json.loads(source.read())
        try:
            os.utime(path, None)
        except OSError:
            pass
        result["cache_status"] = "hit"
        return result
    except (OSError, EOFError, json.JSONDecodeError):
        path.unlink(missing_ok=True)
        return None


def store_result(kind: str, key: str, result: dict) -> None:
    value = dict(result)
    value.pop("cache_status", None)
    with _lock:
        _atomic_gzip(_result_path(kind, key), _json_bytes(value))
        _prune_locked()


def artifact_signature(signature: str) -> str:
    return hashlib.sha256(signature.encode("utf-8")).hexdigest()


def _artifact_path(analysis_id: int, plot_id: str, signature: str) -> Path:
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    return _ARTIFACTS / str(analysis_id) / safe_plot / f"{artifact_signature(signature)}.svg.gz"


def load_artifact(analysis_id: int, plot_id: str, signature: str) -> str | None:
    path = _artifact_path(analysis_id, plot_id, signature)
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as source:
            value = source.read()
        try:
            os.utime(path, None)
        except OSError:
            pass
        return value
    except (OSError, EOFError, UnicodeDecodeError):
        path.unlink(missing_ok=True)
        return None


def store_artifact(analysis_id: int, plot_id: str, signature: str, svg: str) -> None:
    with _lock:
        _atomic_gzip(_artifact_path(analysis_id, plot_id, signature), svg.encode("utf-8"))
        _prune_locked()


def delete_analysis_artifacts(analysis_id: int) -> None:
    import shutil

    shutil.rmtree(_ARTIFACTS / str(analysis_id), ignore_errors=True)


def _prune_locked(limit_bytes: int = ANALYSIS_CACHE_LIMIT_BYTES) -> None:
    if not _ROOT.exists():
        return
    files = [path for path in _ROOT.rglob("*.gz") if path.is_file()]
    total = sum(path.stat().st_size for path in files)
    if total <= limit_bytes:
        return
    files.sort(key=lambda path: path.stat().st_mtime)
    target = int(limit_bytes * 0.9)
    for path in files:
        if total <= target:
            break
        try:
            size = path.stat().st_size
            path.unlink()
            total -= size
        except OSError:
            continue


def cache_stats() -> dict[str, int]:
    files = [path for path in _ROOT.rglob("*.gz") if path.is_file()] if _ROOT.exists() else []
    return {
        "files": len(files),
        "bytes": sum(path.stat().st_size for path in files),
        "limit_bytes": ANALYSIS_CACHE_LIMIT_BYTES,
        "version": ANALYSIS_CACHE_VERSION,
    }
