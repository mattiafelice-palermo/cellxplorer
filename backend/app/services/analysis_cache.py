"""Disposable, versioned caches for analysis responses and plot artifacts.

The database and Parquet files remain canonical.  Everything here may be
deleted at any time and is keyed by the complete scientific input signature.
"""
from __future__ import annotations

from copy import deepcopy
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

ANALYSIS_CACHE_VERSION = 3
RESULT_SCHEMA_VERSIONS = {
    "steps": 2,
    "dcir": 1,
    "chargeability": 1,
    "rate_capability": 3,
}
PLOT_ARTIFACT_CACHE_VERSION = 2
THUMBNAIL_CACHE_VERSION = 5
DEFAULT_ANALYSIS_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024
ANALYSIS_CACHE_LIMIT_BYTES: int | None = DEFAULT_ANALYSIS_CACHE_LIMIT_BYTES
_ROOT = CACHE_DIR / "analysis"
_RESULTS = _ROOT / "results"
_ARTIFACTS = _ROOT / "artifacts"
_THUMBNAILS = _ROOT / "thumbnails"
_THUMBNAIL_INDEXES = _ROOT / "thumbnail-index"
_PREPARED = _ROOT / "prepared"
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


def _valid_thumbnail_data_url(value: object) -> bool:
    return isinstance(value, str) and value.startswith(
        ("data:image/webp;base64,", "data:image/png;base64,")
    )


# Running total of the budgeted tiers (results + artifacts; thumbnails are
# exempt). Stores adjust it incrementally so the per-write budget check is a
# comparison, not a full cache walk. None means "stale, rescan before use";
# bulk deletions and the periodic maintenance pass reset it to self-heal any
# drift from external file changes.
_budget_total: int | None = None


def invalidate_size_tracker() -> None:
    global _budget_total
    with _lock:
        _budget_total = None


def _budget_files() -> list[Path]:
    return [
        path
        for directory in (_RESULTS, _ARTIFACTS)
        if directory.exists()
        for path in directory.rglob("*.gz")
        if path.is_file()
    ]


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _store_budgeted(path: Path, data: bytes) -> None:
    """Write one results/artifacts file and keep the running total current."""
    global _budget_total
    previous = _file_size(path)
    _atomic_gzip(path, data)
    if _budget_total is not None:
        _budget_total += _file_size(path) - previous


def _forget_budgeted(path: Path) -> None:
    """Account for a results/artifacts file that is about to be unlinked."""
    global _budget_total
    with _lock:
        if _budget_total is not None:
            _budget_total -= _file_size(path)


def _scientific_spec(spec: dict) -> dict:
    presentation = spec.get("presentation") or {}
    return {
        "selection": spec.get("selection") or {},
        "computation": spec.get("computation") or {},
        "aggregation": spec.get("aggregation") or {},
        "protocol_segments": spec.get("protocol_segments") or [],
        "dcir_segments": spec.get("dcir_segments") or [],
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
    # Pure loading strategy — the fingerprints below are byte-identical either
    # way, this just avoids ~10 lazy-load queries per cell.
    selected = [unit["cell"] for unit in units]
    engine.preload_cell_sources(db, selected)
    scalar_metadata = engine.load_scalar_metadata(db, selected)
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
                # location_status is deliberately NOT part of the key: results
                # are computed from the cached Parquet, which transient
                # offline/changed flips do not touch. Availability badges are
                # refreshed at response time instead
                # (engine.refresh_availability_badges), so a drive reconnect
                # or an in-progress cycling file cannot invalidate every
                # cached result for the cell.
                "hashes": hashes,
                "active_mass_mg": engine.cell_active_mass_mg(cell, scalar_metadata.get(cell.id)),
                "nominal_capacity_mah": engine.cell_nominal_capacity_mah(cell, scalar_metadata.get(cell.id)),
                "electrode_area_cm2": engine.cell_electrode_area_cm2(cell, scalar_metadata.get(cell.id)),
                "archived": bool(cell.archived),
            }
        )
    return _digest(
        {
            "cache_version": ANALYSIS_CACHE_VERSION,
            "result_schema_version": RESULT_SCHEMA_VERSIONS.get(kind, 1),
            "kind": kind,
            "parser_version": parser_version,
            "calc_version": calc_version,
            "spec": _scientific_spec(spec),
            "units": unit_fingerprints,
            "missing": missing,
            "options": request_options or {},
        }
    )


def saved_plot_data_signature(db: Session, analysis: Any, saved_plot: dict) -> str:
    """Fingerprint the exact scientific inputs expected by one saved plot."""
    spec = deepcopy(analysis.spec)
    selection = deepcopy(spec.get("selection") or {})
    saved_selection = saved_plot.get("selection") or {}
    selection["exclusions"] = deepcopy(saved_selection.get("exclusions") or [])
    selection["hidden_replicate_group_ids"] = deepcopy(
        saved_selection.get("hidden_replicate_group_ids") or []
    )
    spec["selection"] = selection
    spec["computation"] = deepcopy(saved_plot.get("computation") or {})
    spec["aggregation"] = deepcopy(saved_plot.get("aggregation") or {})
    spec["presentation"] = deepcopy(saved_plot.get("presentation") or {})
    tab = saved_plot.get("tab")
    kind = (
        "time_capacity"
        if tab == "time_capacity"
        else "steps"
        if tab == "steps"
        else "dcir"
        if tab == "dcir"
        else "cycles"
    )
    request_options = (
        {"viewport_width": 1200, "precision": "standard", "compact": True}
        if kind == "time_capacity"
        else None
    )
    return result_key(
        db,
        kind,
        spec,
        analysis.provenance,
        use_current_versions=False,
        request_options=request_options,
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
        # Entries written since the body/header split keep their badges in a
        # sidecar; older ones still carry them inline. Either way callers get
        # the whole result back.
        sidecar = _sidecar_path(kind, key)
        if sidecar.is_file():
            try:
                result["badges"] = json.loads(sidecar.read_bytes()).get("badges") or []
            except (OSError, json.JSONDecodeError, AttributeError):
                result.setdefault("badges", [])
        result["cache_status"] = "hit"
        return result
    except (OSError, EOFError, json.JSONDecodeError):
        _forget_budgeted(path)
        path.unlink(missing_ok=True)
        return None


def _sidecar_path(kind: str, key: str) -> Path:
    path = _result_path(kind, key)
    return path.with_name(path.name[: -len(".json.gz")] + ".meta.json")


def _write_sidecar(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        temporary.write_bytes(_json_bytes(value))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def store_result(kind: str, key: str, result: dict) -> None:
    """Persist a result split into a big immutable body and a tiny header.

    ``badges`` and ``cache_status`` are the only parts of a cached result that
    must not be replayed as stored: availability badges are rebuilt from current
    database status on every response. Keeping them out of the compressed body
    lets a cache hit be served by splicing bytes instead of parsing megabytes
    of JSON (see :func:`load_result_body`).
    """
    value = dict(result)
    value.pop("cache_status", None)
    badges = value.pop("badges", None) or []
    kept = [
        badge
        for badge in badges
        if badge.get("kind") not in engine_availability_kinds()
    ]
    with _lock:
        _store_budgeted(_result_path(kind, key), _json_bytes(value))
        _write_sidecar(_sidecar_path(kind, key), {"badges": kept})
        _prune_locked()


def engine_availability_kinds() -> set[str]:
    # Local import keeps the engine -> cache -> engine cycle broken.
    from . import analysis_engine as engine

    return engine.AVAILABILITY_BADGE_KINDS


def load_result_body(kind: str, key: str) -> tuple[bytes, list[dict]] | None:
    """Return a cached result's raw JSON bytes plus its stored badges.

    The bytes are the object *without* ``badges``/``cache_status`` — the caller
    splices those back in. Returns ``None`` when the entry predates this split
    (no sidecar), so the caller can fall back to the parsing path.
    """
    path = _result_path(kind, key)
    sidecar = _sidecar_path(kind, key)
    if not path.is_file() or not sidecar.is_file():
        return None
    try:
        badges = json.loads(sidecar.read_bytes()).get("badges") or []
        with gzip.open(path, "rb") as source:
            body = source.read()
        try:
            os.utime(path, None)
        except OSError:
            pass
        return body, badges
    except (OSError, EOFError, json.JSONDecodeError, AttributeError):
        return None


def upgrade_result_format(kind: str, key: str, result: dict) -> None:
    """Rewrite an entry stored before the body/header split.

    Without this the fast path would only ever apply to results computed after
    the upgrade — and a warm cache never recomputes, so an existing install
    would see no benefit at all. Re-storing costs one write per entry, once.
    """
    if _sidecar_path(kind, key).is_file():
        return
    try:
        store_result(kind, key, result)
    except OSError:
        pass  # The slow path already produced a correct response.


def splice_result_body(body: bytes, badges: list[dict], cache_status: str) -> bytes:
    """Prepend the volatile keys to a stored body without parsing it.

    The stored body is a JSON object that deliberately lacks ``badges`` and
    ``cache_status``, so the response is built by replacing its opening brace.
    This is what makes a cache hit cost a file read rather than a parse and a
    re-encode of several megabytes.
    """
    rest = body.lstrip()
    if not rest.startswith(b"{"):
        raise ValueError("cached result body is not a JSON object")
    rest = rest[1:].lstrip()
    head = b'{"cache_status":' + _json_bytes(cache_status) + b',"badges":' + _json_bytes(badges)
    if rest.startswith(b"}"):
        # The stored object held nothing but the keys we just re-added.
        return head + b"}"
    return head + b"," + rest


def artifact_signature(signature: str) -> str:
    return hashlib.sha256(signature.encode("utf-8")).hexdigest()


def _artifact_path(analysis_id: int, plot_id: str, signature: str) -> Path:
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    return _ARTIFACTS / str(analysis_id) / safe_plot / f"{artifact_signature(signature)}.json.gz"


def _thumbnail_path(analysis_id: int, plot_id: str, signature: str) -> Path:
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    return _THUMBNAILS / str(analysis_id) / safe_plot / f"{artifact_signature(signature)}.json.gz"


def _thumbnail_index_path(analysis_id: int, plot_id: str, client_signature: str) -> Path:
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    return (
        _THUMBNAIL_INDEXES
        / str(analysis_id)
        / safe_plot
        / f"{artifact_signature(client_signature)}.json.gz"
    )


def _load_thumbnail_value(path: Path, field: str) -> str | None:
    """Read one derivative from a versioned thumbnail cache record."""
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rb") as source:
            value = json.loads(source.read())
        if value.get("cache_version") != THUMBNAIL_CACHE_VERSION:
            path.unlink(missing_ok=True)
            return None
        thumbnail = value.get(field)
        if not _valid_thumbnail_data_url(thumbnail):
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return thumbnail
    except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        path.unlink(missing_ok=True)
        return None


def load_thumbnail(analysis_id: int, plot_id: str, signature: str) -> str | None:
    path = _thumbnail_path(analysis_id, plot_id, signature)
    thumbnail = _load_thumbnail_value(path, "thumbnail")
    if thumbnail is None or _load_thumbnail_value(path, "preview_thumbnail") is None:
        return None
    return thumbnail


def load_preview_thumbnail(analysis_id: int, plot_id: str, signature: str) -> str | None:
    return _load_thumbnail_value(
        _thumbnail_path(analysis_id, plot_id, signature),
        "preview_thumbnail",
    )


def store_thumbnail(
    analysis_id: int,
    plot_id: str,
    signature: str,
    thumbnail: str,
    preview_thumbnail: str | None = None,
) -> None:
    with _lock:
        _atomic_gzip(
            _thumbnail_path(analysis_id, plot_id, signature),
            _json_bytes(
                {
                    "cache_version": THUMBNAIL_CACHE_VERSION,
                    "thumbnail": thumbnail,
                    "preview_thumbnail": preview_thumbnail,
                }
            ),
        )
        _prune_locked()


def load_indexed_thumbnail(
    analysis_id: int,
    plot_id: str,
    client_signature: str,
) -> str | None:
    """Load a saved-plot thumbnail without rebuilding its scientific key."""
    path = _thumbnail_index_path(analysis_id, plot_id, client_signature)
    thumbnail = _load_thumbnail_value(path, "thumbnail")
    if thumbnail is None or _load_thumbnail_value(path, "preview_thumbnail") is None:
        return None
    return thumbnail


def load_indexed_preview_thumbnail(
    analysis_id: int,
    plot_id: str,
    client_signature: str,
) -> str | None:
    return _load_thumbnail_value(
        _thumbnail_index_path(analysis_id, plot_id, client_signature),
        "preview_thumbnail",
    )


def store_indexed_thumbnail(
    analysis_id: int,
    plot_id: str,
    client_signature: str,
    thumbnail: str,
    preview_thumbnail: str | None = None,
) -> None:
    with _lock:
        _atomic_gzip(
            _thumbnail_index_path(analysis_id, plot_id, client_signature),
            _json_bytes(
                {
                    "cache_version": THUMBNAIL_CACHE_VERSION,
                    "thumbnail": thumbnail,
                    "preview_thumbnail": preview_thumbnail,
                }
            ),
        )
        _prune_locked()


def _prepared_marker_path(analysis_id: int, plot_id: str) -> Path:
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    return _PREPARED / str(analysis_id) / f"{safe_plot}.json"


def load_prepared_marker(analysis_id: int, plot_id: str) -> dict | None:
    """Read the (data signature, plot revision) this plot was last prepared for.

    The marker lets the warmup coordinator build its queue server-side from
    exactly the plots that need work, instead of walking every saved plot
    through a frontend cache lookup on each pass.
    """
    path = _prepared_marker_path(analysis_id, plot_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_bytes())
    except (OSError, json.JSONDecodeError):
        path.unlink(missing_ok=True)
        return None


def store_prepared_marker(
    analysis_id: int,
    plot_id: str,
    data_signature: str,
    plot_modified_at: str | None,
) -> None:
    path = _prepared_marker_path(analysis_id, plot_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        temporary.write_bytes(
            _json_bytes(
                {
                    "data_signature": data_signature,
                    "plot_modified_at": plot_modified_at,
                    "thumbnail_cache_version": THUMBNAIL_CACHE_VERSION,
                }
            )
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def clear_prepared_markers(analysis_id: int | None = None) -> None:
    import shutil

    target = _PREPARED if analysis_id is None else _PREPARED / str(analysis_id)
    shutil.rmtree(target, ignore_errors=True)


def has_indexed_thumbnails(analysis_id: int, plot_id: str) -> bool:
    """Return whether this saved plot has entered the signature-indexed cache era."""
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    directory = _THUMBNAIL_INDEXES / str(analysis_id) / safe_plot
    return directory.is_dir() and any(directory.glob("*.json.gz"))


def load_latest_thumbnail(
    analysis_id: int,
    plot_id: str,
    variant: str = "saved",
) -> str | None:
    """Adopt the newest legacy thumbnail when its direct index is absent."""
    safe_plot = "".join(character if character.isalnum() or character in "_-" else "_" for character in plot_id)
    directory = _THUMBNAILS / str(analysis_id) / safe_plot
    if not directory.is_dir():
        return None
    candidates = sorted(
        (path for path in directory.glob("*.json.gz") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in candidates:
        try:
            with gzip.open(path, "rb") as source:
                value = json.loads(source.read())
            thumbnail = value.get(
                "preview_thumbnail" if variant == "preview" else "thumbnail"
            )
            counterpart = value.get(
                "thumbnail" if variant == "preview" else "preview_thumbnail"
            )
            if (
                value.get("cache_version") == THUMBNAIL_CACHE_VERSION
                and _valid_thumbnail_data_url(thumbnail)
                and _valid_thumbnail_data_url(counterpart)
            ):
                return thumbnail
        except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            continue
    return None


def load_artifact(analysis_id: int, plot_id: str, signature: str) -> dict | None:
    path = _artifact_path(analysis_id, plot_id, signature)
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rb") as source:
            value = json.loads(source.read())
        if value.get("cache_version") != PLOT_ARTIFACT_CACHE_VERSION:
            _forget_budgeted(path)
            path.unlink(missing_ok=True)
            return None
        artifact = value.get("artifact")
        if not isinstance(artifact, dict) or not isinstance(artifact.get("svg"), str):
            _forget_budgeted(path)
            path.unlink(missing_ok=True)
            return None
        thumbnail = load_thumbnail(analysis_id, plot_id, signature)
        preview_thumbnail = load_preview_thumbnail(analysis_id, plot_id, signature)
        # Embedded thumbnails predate the compact, legend-free thumbnail
        # renderer. Do not migrate them; the frontend can cheaply rebuild the
        # small image from this already-cached SVG once.
        artifact["thumbnail"] = thumbnail
        artifact["preview_thumbnail"] = preview_thumbnail
        try:
            os.utime(path, None)
        except OSError:
            pass
        return artifact
    except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        _forget_budgeted(path)
        path.unlink(missing_ok=True)
        return None


def store_artifact(
    analysis_id: int,
    plot_id: str,
    signature: str,
    artifact: dict,
    *,
    client_signature: str | None = None,
) -> None:
    with _lock:
        # Some callers refresh the serialized figure/SVG without rendering a
        # new PNG. Treat those writes as partial updates so they cannot erase
        # a thumbnail that was already persisted for the saved-plot row.
        existing = load_artifact(analysis_id, plot_id, signature)
        value = dict(artifact)
        if value.get("thumbnail") is None and existing is not None:
            value["thumbnail"] = existing.get("thumbnail")
        if value.get("preview_thumbnail") is None and existing is not None:
            value["preview_thumbnail"] = existing.get("preview_thumbnail")
        thumbnail = value.get("thumbnail")
        preview_thumbnail = value.get("preview_thumbnail")
        if isinstance(thumbnail, str):
            store_thumbnail(
                analysis_id,
                plot_id,
                signature,
                thumbnail,
                preview_thumbnail if isinstance(preview_thumbnail, str) else None,
            )
            if client_signature is not None:
                store_indexed_thumbnail(
                    analysis_id,
                    plot_id,
                    client_signature,
                    thumbnail,
                    preview_thumbnail if isinstance(preview_thumbnail, str) else None,
                )
        # The saved-plot rows only need the small thumbnail. Keep it in its
        # own file so page reloads never decompress the full Plotly figure.
        value["thumbnail"] = None
        value["preview_thumbnail"] = None
        _store_budgeted(
            _artifact_path(analysis_id, plot_id, signature),
            _json_bytes(
                {
                    "cache_version": PLOT_ARTIFACT_CACHE_VERSION,
                    "artifact": value,
                }
            ),
        )
        _prune_locked()


def delete_analysis_artifacts(analysis_id: int) -> None:
    import shutil

    shutil.rmtree(_ARTIFACTS / str(analysis_id), ignore_errors=True)
    shutil.rmtree(_THUMBNAILS / str(analysis_id), ignore_errors=True)
    shutil.rmtree(_THUMBNAIL_INDEXES / str(analysis_id), ignore_errors=True)
    shutil.rmtree(_PREPARED / str(analysis_id), ignore_errors=True)
    invalidate_size_tracker()


def configure_limit(limit_bytes: int | None) -> None:
    """Set the disposable analysis-cache budget for this backend session.

    Also refreshes the running size total from disk: the periodic
    maintenance loop calls this, which self-heals any drift caused by
    external deletions.
    """
    global ANALYSIS_CACHE_LIMIT_BYTES
    ANALYSIS_CACHE_LIMIT_BYTES = None if limit_bytes is None else max(0, int(limit_bytes))
    invalidate_size_tracker()
    with _lock:
        _prune_locked()


def _prune_locked(limit_bytes: int | None = None) -> None:
    global _budget_total
    limit = ANALYSIS_CACHE_LIMIT_BYTES if limit_bytes is None else limit_bytes
    if limit is None or not _ROOT.exists():
        return
    # Saved-plot thumbnails are deliberately excluded. They are tiny, make
    # analysis reopening feel immediate, and can only be recreated by
    # rendering the plot. Numerical results and full Plotly artifacts are the
    # appropriate LRU eviction candidates.
    if _budget_total is None:
        _budget_total = sum(_file_size(path) for path in _budget_files())
    if _budget_total <= limit:
        # The common case: the incremental total says we are under budget,
        # so no directory walk happens at all.
        return
    files = _budget_files()
    total = sum(_file_size(path) for path in files)
    _budget_total = total
    if total <= limit:
        return
    files.sort(key=lambda path: path.stat().st_mtime)
    target = int(limit * 0.9)
    for path in files:
        if total <= target:
            break
        try:
            size = path.stat().st_size
            path.unlink()
            # Drop the badge sidecar with its body so it cannot outlive it.
            if path.name.endswith(".json.gz"):
                path.with_name(path.name[: -len(".json.gz")] + ".meta.json").unlink(missing_ok=True)
            total -= size
        except OSError:
            continue
    _budget_total = total


def cache_stats() -> dict[str, int | None]:
    files = [path for path in _ROOT.rglob("*.gz") if path.is_file()] if _ROOT.exists() else []
    return {
        "files": len(files),
        "bytes": sum(path.stat().st_size for path in files),
        "limit_bytes": ANALYSIS_CACHE_LIMIT_BYTES,
        "version": ANALYSIS_CACHE_VERSION,
    }
