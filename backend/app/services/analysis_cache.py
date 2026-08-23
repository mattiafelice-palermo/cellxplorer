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

ANALYSIS_CACHE_VERSION = 7
# ^ Spec 049: protocol targets now resolve current, version-3, and version-1 /
# legacy protocol-signature aliases. Existing result files are therefore
# deterministically invalidated so a warm cache cannot disagree with a
# cache-cleared recompute.
# Spec 040.3: result_key() now fingerprints each contributing source's OWN
# resolved parser identity per cell (`source_parser_versions`) instead of one
# process-global `parser_version` scalar shared by the whole key. This is a
# key-COMPUTATION change that applies uniformly to every analysis kind, so it
# bumps the shared version rather than one entry in RESULT_SCHEMA_VERSIONS
# below (which is reserved for per-kind RESPONSE payload shape changes). The
# digest would already differ without this bump — the JSON structure fed to
# the digest changed — but bumping documents the generation change explicitly
# per this module's own guidance ("changes that genuinely affect every
# analysis result family").
# Spec 050.1: result keys now use explicit per-family dependency projections
# instead of hashing unrelated computation-family settings. This is a cache
# identity generation change; scientific meaning and response schemas are
# unchanged.
RESULT_SCHEMA_VERSIONS = {
    # Spec 040.3: each kind's persisted "sources" entries gained a "files"
    # array (per-source {hash, position, parser_version}), so a legacy
    # cached payload missing that array must not be served as if it had it.
    "cycles": 3,
    # Specs 040.4/041.5: the payload gained a top-level "voltage_channels"
    # availability map, "settings" gained "voltage_channel", and the channel
    # entries now carry resolved role/reference presentation context. Legacy
    # payloads must not be served as if those semantics existed.
    # Spec 050.15: compact ordinary Time/Capacity provenance is now a
    # deduplicated source table plus row-aligned source indexes.
    "time_capacity": 5,
    "steps": 3,
    "dcir": 2,
    "chargeability": 2,
    "rate_capability": 4,
}
PLOT_ARTIFACT_CACHE_VERSION = 2
# Spec 041.5: thumbnail records now carry the scientific data signature that
# produced them.  A client plot signature alone is not enough to prevent an
# old auxiliary-channel image from surviving a source/capability change.
THUMBNAIL_CACHE_VERSION = 7
DEFAULT_ANALYSIS_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024
ANALYSIS_CACHE_LIMIT_BYTES: int | None = DEFAULT_ANALYSIS_CACHE_LIMIT_BYTES
_ROOT = CACHE_DIR / "analysis"
_RESULTS = _ROOT / "results"
_ARTIFACTS = _ROOT / "artifacts"
_THUMBNAILS = _ROOT / "thumbnails"
_THUMBNAIL_INDEXES = _ROOT / "thumbnail-index"
_PREPARED = _ROOT / "prepared"
_lock = threading.RLock()

_SCIENTIFIC_RESULT_KINDS = frozenset(
    {"cycles", "time_capacity", "steps", "dcir", "chargeability", "rate_capability"}
)


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


def _profile_ms(profile: dict[str, Any] | None, name: str, elapsed_ms: float) -> None:
    if profile is None:
        return
    stages = profile.setdefault("cache_store_stages_ms", {})
    stages[name] = stages.get(name, 0.0) + elapsed_ms


def _atomic_gzip(
    path: Path,
    data: bytes,
    profile: dict[str, Any] | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        compress_started = time.perf_counter()
        with gzip.open(temporary, "wb", compresslevel=3) as target:
            target.write(data)
        _profile_ms(
            profile,
            "cache_store_gzip_compress",
            (time.perf_counter() - compress_started) * 1000.0,
        )
        replace_started = time.perf_counter()
        os.replace(temporary, path)
        _profile_ms(
            profile,
            "cache_store_atomic_write_replace",
            (time.perf_counter() - replace_started) * 1000.0,
        )
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


def _store_budgeted(
    path: Path,
    data: bytes,
    profile: dict[str, Any] | None = None,
) -> None:
    """Write one results/artifacts file and keep the running total current."""
    global _budget_total
    previous = _file_size(path)
    _atomic_gzip(path, data, profile)
    if _budget_total is not None:
        _budget_total += _file_size(path) - previous


def _forget_budgeted(path: Path) -> None:
    """Account for a results/artifacts file that is about to be unlinked."""
    global _budget_total
    with _lock:
        if _budget_total is not None:
            _budget_total -= _file_size(path)


def _scientific_spec(spec: dict, kind: str) -> dict:
    """Project only the scientific settings consumed by one result family.

    Analysis specs are shared by all tabs, but the compute services do not
    consume every family block. Keeping this projection explicit prevents a
    presentation edit or an unrelated family's configuration from evicting a
    valid result while retaining the exact legacy/current values each family
    reads. Unknown kinds fail closed so a new endpoint cannot accidentally use
    an incomplete cache identity.
    """
    if kind not in _SCIENTIFIC_RESULT_KINDS:
        raise ValueError(f"No scientific cache projection configured for result kind: {kind}")

    computation = spec.get("computation") or {}
    presentation = spec.get("presentation") or {}
    selection = spec.get("selection") or {}
    aggregation = spec.get("aggregation") or {}

    def scientific_segments(value: object) -> list[object]:
        """Exclude editor-only provenance while retaining scientific fields."""
        if not isinstance(value, list):
            return []
        result: list[object] = []
        for segment in value:
            if not isinstance(segment, dict):
                result.append(segment)
                continue
            normalized = dict(segment)
            # Protocol-group attribution is analysis-editor metadata. The
            # engine consumes exact targets, not the group that produced them.
            normalized.pop("protocol_group_id", None)
            result.append(normalized)
        return result

    protocol_segments = scientific_segments(spec.get("protocol_segments"))
    hidden_protocol_segment_ids = presentation.get("hidden_protocol_segment_ids") or []

    if kind == "cycles":
        return {
            "selection": selection,
            "computation": {
                "cycle_range": computation.get("cycle_range") or {},
                "exclude_check_cycles_every_n": computation.get(
                    "exclude_check_cycles_every_n"
                )
                or 0,
                "retention_reference": computation.get("retention_reference") or {},
                "formation_cycles": computation.get("formation_cycles") or 0,
                "polarization": computation.get("polarization") or {},
                "protocol_filter": computation.get("protocol_filter") or {},
            },
            "aggregation": aggregation,
            "protocol_segments": protocol_segments,
            "hidden_protocol_segment_ids": hidden_protocol_segment_ids,
        }

    if kind == "time_capacity":
        return {
            "selection": selection,
            "computation": {
                "time_capacity": computation.get("time_capacity") or {},
                # Time/Capacity retains the generic cycle-range fallback used
                # by time_capacity_settings() for legacy specs without a
                # dedicated time_capacity range.
                "cycle_range": computation.get("cycle_range") or {},
                "protocol_filter": computation.get("protocol_filter") or {},
            },
            "protocol_segments": protocol_segments,
            "hidden_protocol_segment_ids": hidden_protocol_segment_ids,
        }

    if kind == "steps":
        return {
            "selection": selection,
            "computation": {"steps": computation.get("steps") or {}},
            "protocol_segments": protocol_segments,
        }

    if kind == "dcir":
        return {
            "selection": selection,
            "computation": {"dcir": computation.get("dcir") or {}},
            "dcir_segments": scientific_segments(spec.get("dcir_segments")),
        }

    if kind == "chargeability":
        return {
            "selection": selection,
            "computation": {"chargeability": computation.get("chargeability") or {}},
        }

    return {
        "selection": selection,
        "computation": {"rate_capability": computation.get("rate_capability") or {}},
    }


def _result_fingerprint_payload(
    db: Session,
    kind: str,
    spec: dict,
    provenance: dict | None,
    *,
    use_current_versions: bool,
) -> dict[str, Any]:
    """Resolve the authoritative scientific/source identity once.

    The request-specific rendering options are deliberately not included here.
    Time/Capacity callers derive both the scientific identity and the concrete
    render key from this one owner-side payload, so the expensive relational
    and source walk cannot be repeated merely because two related keys are
    needed.
    """
    if kind not in _SCIENTIFIC_RESULT_KINDS:
        raise ValueError(f"No scientific cache projection configured for result kind: {kind}")

    # Local import avoids analysis_engine -> cache -> analysis_cache cycles.
    from . import analysis_engine as engine

    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
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
        # Spec 040.3: per-source parser identity, resolved with the EXACT
        # same function `compute()` uses so the cache key always matches
        # what would actually be rendered. A pinned identity for one source
        # changes only the units whose cells contain that source; an
        # unrelated format's adapter revision changing does not touch this
        # cell's fingerprint at all (case 13/14).
        source_versions = engine.resolve_source_parser_versions(
            files, provenance, cell.id, use_current_versions
        )
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
                "source_parser_versions": [source_versions[h] for h in hashes],
                "active_mass_mg": engine.cell_active_mass_mg(cell, scalar_metadata.get(cell.id)),
                "nominal_capacity_mah": engine.cell_nominal_capacity_mah(cell, scalar_metadata.get(cell.id)),
                "electrode_area_cm2": engine.cell_electrode_area_cm2(cell, scalar_metadata.get(cell.id)),
                "archived": bool(cell.archived),
            }
        )
    return {
        "cache_version": ANALYSIS_CACHE_VERSION,
        "result_schema_version": RESULT_SCHEMA_VERSIONS[kind],
        "kind": kind,
        "calc_version": calc_version,
        "spec": _scientific_spec(spec, kind),
        "units": unit_fingerprints,
        "missing": missing,
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
    payload = _result_fingerprint_payload(
        db,
        kind,
        spec,
        provenance,
        use_current_versions=use_current_versions,
    )
    payload["options"] = request_options or {}
    return _digest(payload)


def time_capacity_keys(
    db: Session,
    spec: dict,
    provenance: dict | None,
    *,
    use_current_versions: bool,
    request_options: dict | None = None,
) -> tuple[str, str]:
    """Return ``(scientific_signature, render_key)`` from one owner pass."""

    payload = _result_fingerprint_payload(
        db,
        "time_capacity",
        spec,
        provenance,
        use_current_versions=use_current_versions,
    )
    scientific = dict(payload)
    scientific["options"] = {}
    render = dict(payload)
    render["options"] = request_options or {}
    return _digest(scientific), _digest(render)


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
        else "chargeability"
        if tab == "chargeability"
        else "rate_capability"
        if tab == "crate"
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


def time_capacity_data_signature(
    db: Session,
    spec: dict,
    provenance: dict | None,
    *,
    use_current_versions: bool,
) -> str:
    """Return Time/Capacity identity with rendering options deliberately removed.

    This is the same scientific result-key payload used by the normal
    Time/Capacity cache, including unit metadata and labels. Only viewport,
    precision, and compact/downsampling options are omitted so standard and
    full-resolution renders share one scientific identity.
    """
    payload = _result_fingerprint_payload(
        db,
        "time_capacity",
        spec,
        provenance,
        use_current_versions=use_current_versions,
    )
    payload["options"] = {}
    return _digest(payload)


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


def _write_sidecar(path: Path, value: dict, profile: dict[str, Any] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        started = time.perf_counter()
        temporary.write_bytes(_json_bytes(value))
        os.replace(temporary, path)
        _profile_ms(profile, "cache_store_sidecar_write", (time.perf_counter() - started) * 1000.0)
    finally:
        temporary.unlink(missing_ok=True)


def store_result(
    kind: str,
    key: str,
    result: dict,
    *,
    profile: dict[str, Any] | None = None,
) -> None:
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
        encode_started = time.perf_counter()
        body = _json_bytes(value)
        _profile_ms(profile, "cache_store_json_encode", (time.perf_counter() - encode_started) * 1000.0)
        _store_budgeted(_result_path(kind, key), body, profile)
        _write_sidecar(_sidecar_path(kind, key), {"badges": kept}, profile)
        prune_started = time.perf_counter()
        _prune_locked()
        _profile_ms(profile, "cache_store_sidecar_prune", (time.perf_counter() - prune_started) * 1000.0)


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


def splice_result_body(
    body: bytes,
    badges: list[dict],
    cache_status: str,
    extra_fields: dict[str, object] | None = None,
) -> bytes:
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
    head = b'{"cache_status":' + _json_bytes(cache_status)
    for name, value in (extra_fields or {}).items():
        # Existing modern bodies already contain these immutable fields. Do
        # not emit duplicate JSON keys when the fast path serves them.
        if (b'"' + name.encode("utf-8") + b'":') in rest:
            continue
        head += b',' + _json_bytes(name) + b':' + _json_bytes(value)
    head += b',"badges":' + _json_bytes(badges)
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


def _load_thumbnail_value(
    path: Path,
    field: str,
    *,
    expected_data_signature: str | None = None,
) -> str | None:
    """Read one derivative from a versioned thumbnail cache record."""
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rb") as source:
            value = json.loads(source.read())
        if value.get("cache_version") != THUMBNAIL_CACHE_VERSION:
            path.unlink(missing_ok=True)
            return None
        if (
            expected_data_signature is not None
            and value.get("data_signature") != expected_data_signature
        ):
            # Keep the old record: it may still be useful for the exact
            # scientific cache signature that produced it, but it is not safe
            # to serve for the current source data.
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
    data_signature: str | None = None,
) -> None:
    with _lock:
        _atomic_gzip(
            _thumbnail_path(analysis_id, plot_id, signature),
            _json_bytes(
                {
                    "cache_version": THUMBNAIL_CACHE_VERSION,
                    "thumbnail": thumbnail,
                    "preview_thumbnail": preview_thumbnail,
                    **(
                        {"data_signature": data_signature}
                        if data_signature is not None
                        else {}
                    ),
                }
            ),
        )
        _prune_locked()


def load_indexed_thumbnail(
    analysis_id: int,
    plot_id: str,
    client_signature: str,
    expected_data_signature: str | None = None,
) -> str | None:
    """Load a saved-plot thumbnail without rebuilding its scientific key."""
    path = _thumbnail_index_path(analysis_id, plot_id, client_signature)
    thumbnail = _load_thumbnail_value(
        path,
        "thumbnail",
        expected_data_signature=expected_data_signature,
    )
    if (
        thumbnail is None
        or _load_thumbnail_value(
            path,
            "preview_thumbnail",
            expected_data_signature=expected_data_signature,
        )
        is None
    ):
        return None
    return thumbnail


def load_indexed_preview_thumbnail(
    analysis_id: int,
    plot_id: str,
    client_signature: str,
    expected_data_signature: str | None = None,
) -> str | None:
    return _load_thumbnail_value(
        _thumbnail_index_path(analysis_id, plot_id, client_signature),
        "preview_thumbnail",
        expected_data_signature=expected_data_signature,
    )


def store_indexed_thumbnail(
    analysis_id: int,
    plot_id: str,
    client_signature: str,
    thumbnail: str,
    preview_thumbnail: str | None = None,
    data_signature: str | None = None,
) -> None:
    with _lock:
        _atomic_gzip(
            _thumbnail_index_path(analysis_id, plot_id, client_signature),
            _json_bytes(
                {
                    "cache_version": THUMBNAIL_CACHE_VERSION,
                    "thumbnail": thumbnail,
                    "preview_thumbnail": preview_thumbnail,
                    **(
                        {"data_signature": data_signature}
                        if data_signature is not None
                        else {}
                    ),
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
    *,
    disposition: str = "ready",
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
                    "disposition": disposition,
                    "thumbnail_cache_version": THUMBNAIL_CACHE_VERSION,
                }
            )
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def clear_prepared_marker(analysis_id: int, plot_id: str) -> None:
    """Forget one plot's prepared state without deleting its forensic bytes."""
    _prepared_marker_path(analysis_id, plot_id).unlink(missing_ok=True)


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
    *,
    expected_data_signature: str | None = None,
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
                and (
                    expected_data_signature is None
                    or value.get("data_signature") == expected_data_signature
                )
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
    data_signature: str | None = None,
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
                data_signature,
            )
            if client_signature is not None:
                store_indexed_thumbnail(
                    analysis_id,
                    plot_id,
                    client_signature,
                    thumbnail,
                    preview_thumbnail if isinstance(preview_thumbnail, str) else None,
                    data_signature,
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
