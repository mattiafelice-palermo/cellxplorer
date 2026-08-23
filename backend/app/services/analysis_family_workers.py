"""Compact cross-family worker boundary for Spec 050.23.

The controlled S1/P4/P8 matrix promoted the four families implemented here at
the P4 threshold.  Production uses the already-resident application pool owned
by :mod:`time_capacity_workers`; this module owns only the spawn-safe compact
job, worker computation, and deterministic owner-side merge.  Jobs carry only
an immutable request projection, lightweight source descriptors and cache
identities; they never carry a SQLAlchemy session, ORM instance, original path,
raw header, or Pandas frame.  Workers read canonical Parquet caches directly.
"""
from __future__ import annotations

from dataclasses import dataclass
from copy import deepcopy
from contextlib import ExitStack
from concurrent.futures import TimeoutError as FutureTimeoutError
from concurrent.futures.process import BrokenProcessPool
import json
import logging
import os
import pickle
from time import perf_counter, sleep
from typing import Any, Mapping
from unittest.mock import patch


logger = logging.getLogger(__name__)

PROMOTED_FAMILIES = frozenset({"cycles", "steps", "dcir", "rate_capability"})
PROMOTED_MIN_CELLS = 4
PROMOTED_WORKERS = 4


@dataclass(frozen=True)
class WorkerCell:
    """Small immutable Cell projection safe to send to a spawned process."""

    id: int
    name: str
    archived: bool = False


@dataclass(frozen=True)
class WorkerSource:
    """Small immutable SourceFile projection; no source rows are embedded."""

    id: int
    hash: str
    # Deliberately empty in benchmark jobs so workers cannot open originals.
    path: str
    filename: str
    ext: str
    size: int | None
    header_meta: dict[str, Any]
    nominal_capacity_mah: float | None
    row_count: int | None
    cycle_count: int | None
    parse_status: str | None
    parser_version: str | None
    location_status: str
    voltage_data_availability: dict[str, bool]


@dataclass(frozen=True)
class WorkerRequestContext:
    """Request facts resolved by the owner before a worker is submitted."""

    units: tuple[dict[str, Any], ...]
    missing_refs: tuple[dict[str, Any], ...]
    cells: tuple[WorkerCell, ...]
    files_by_cell: dict[int, tuple[WorkerSource, ...]]
    hashes_by_cell: dict[int, tuple[str, ...]]
    parser_versions_by_cell: dict[int, dict[str, str]]
    scalar_metadata: dict[int, dict[str, str]]
    labels_by_cell: dict[int, str]
    protocol_cache_entries: tuple[tuple[str, float | None, dict, dict], ...] = ()
    protocol_cache: tuple[tuple[tuple[str, float | None], dict], ...] = ()
    dcir_protocol_cache: tuple[tuple[tuple[str, float | None], dict], ...] = ()
    dcir_protocol_header_cache: tuple[tuple[dict, float | None, dict], ...] = ()
    protocol_by_source: tuple[tuple[str, dict], ...] = ()


@dataclass(frozen=True)
class FamilyWorkerJob:
    """One ordinal per-Cell job for a benchmark request."""

    family: str
    spec: dict[str, Any]
    provenance: dict[str, Any] | None
    request_context: WorkerRequestContext
    ordinal: int
    cell_id: int
    submitted_at: float
    use_current_versions: bool = True


def _rss_bytes() -> int | None:
    try:
        from .time_capacity_workers import process_rss_bytes

        return process_rss_bytes()
    except Exception:
        return None


def _cache_wrappers(counters: dict[str, Any]) -> ExitStack:
    """Install low-cost cache-read counters for one measured worker call."""

    from . import cache

    stack = ExitStack()
    for name in (
        "load_raw",
        "load_raw_columns",
        "load_raw_cycles",
        "load_cycles",
        "load_raw_step_rows",
    ):
        original = getattr(cache, name, None)
        if original is None:
            continue

        def wrapped(*args: Any, _original=original, _name=name, **kwargs: Any) -> Any:
            started = perf_counter()
            value = _original(*args, **kwargs)
            counters["calls"][_name] = counters["calls"].get(_name, 0) + 1
            counters["elapsed_ms"][_name] = counters["elapsed_ms"].get(_name, 0.0) + (
                perf_counter() - started
            ) * 1000.0
            if hasattr(value, "__len__"):
                try:
                    counters["rows"][_name] = counters["rows"].get(_name, 0) + int(len(value))
                except (TypeError, ValueError):
                    pass
            attrs = getattr(value, "attrs", {})
            counters["physical_rows"] += int(attrs.get("_raw_step_rows_read") or 0)
            counters["row_groups"] += len(attrs.get("_raw_step_row_groups") or ())
            return value

        stack.enter_context(patch.object(cache, name, wrapped))
    return stack


def _compute(job: FamilyWorkerJob) -> dict[str, Any]:
    from . import analysis_engine, chargeability, rate_capability

    if job.family == "cycles":
        return analysis_engine.compute(
            None,
            job.spec,
            job.provenance,
            use_current_versions=job.use_current_versions,
            request_context=job.request_context,
        )
    if job.family == "steps":
        return analysis_engine.compute_steps(
            None,
            job.spec,
            job.provenance,
            use_current_versions=job.use_current_versions,
            request_context=job.request_context,
        )
    if job.family == "dcir":
        return analysis_engine.compute_dcir(
            None,
            job.spec,
            job.provenance,
            use_current_versions=job.use_current_versions,
            request_context=job.request_context,
        )
    if job.family == "chargeability":
        return chargeability.compute(
            None,
            job.spec,
            job.provenance,
            use_current_versions=job.use_current_versions,
            request_context=job.request_context,
        )
    if job.family == "rate_capability":
        return rate_capability.compute(
            None,
            job.spec,
            job.provenance,
            use_current_versions=job.use_current_versions,
            request_context=job.request_context,
        )
    raise ValueError(f"Unsupported family worker: {job.family}")


def _assert_cache_only(job: FamilyWorkerJob) -> None:
    """Fail closed instead of allowing a worker to re-open an original file."""

    from . import analysis_engine, cache

    calc_version = analysis_engine.CALC_VERSION
    if job.provenance and not job.use_current_versions:
        calc_version = job.provenance.get("calc_version") or calc_version
    pending = cache.pending_hashes()

    for cell in job.request_context.cells:
        versions = job.request_context.parser_versions_by_cell[cell.id]
        for source in job.request_context.files_by_cell[cell.id]:
            parser_version = versions[source.hash]
            if source.hash in pending:
                raise RuntimeError(
                    "family worker cache-only boundary has a pending cache write for "
                    f"{source.hash[:12]}"
                )
            if not cache.raw_path(source.hash, parser_version).exists():
                raise RuntimeError(
                    "family worker cache-only boundary unavailable for "
                    f"{source.hash[:12]} at parser {parser_version}"
                )
            if job.family == "cycles" and not cache.has_cycles(
                source.hash,
                parser_version,
                calc_version,
            ):
                raise RuntimeError(
                    "family worker cycle cache-only boundary unavailable for "
                    f"{source.hash[:12]} at parser {parser_version}, calc {calc_version}"
                )


def _copy_source(source: Any) -> WorkerSource:
    """Project one owner-side SourceFile without its path or raw header."""

    return WorkerSource(
        id=int(source.id),
        hash=str(source.hash),
        path="",
        filename=str(source.filename),
        ext=str(source.ext),
        size=int(source.size) if source.size is not None else None,
        header_meta={},
        nominal_capacity_mah=(
            float(source.nominal_capacity_mah)
            if source.nominal_capacity_mah is not None
            else None
        ),
        row_count=int(source.row_count) if source.row_count is not None else None,
        cycle_count=int(source.cycle_count) if source.cycle_count is not None else None,
        parse_status=getattr(source, "parse_status", None),
        parser_version=getattr(source, "parser_version", None),
        location_status=str(getattr(source, "location_status", "online") or "online"),
        voltage_data_availability=deepcopy(
            getattr(source, "voltage_data_availability", {}) or {}
        ),
    )


def _protocol_by_source(owner_context: Any) -> dict[str, dict]:
    """Reconstruct protocol facts once in the owner and key them by source."""

    from . import analysis_engine, protocol

    result: dict[str, dict] = {}
    for cell in owner_context.cells:
        nominal = analysis_engine.cell_nominal_capacity_mah(
            cell,
            owner_context.scalar_metadata.get(cell.id),
        )
        for source in owner_context.files_by_cell[cell.id]:
            result[source.hash] = protocol.reconstruct_protocol(
                source.header_meta or {},
                nominal,
            )
    return result


def _worker_context(
    owner_context: Any,
    cell_id: int,
    protocols: Mapping[str, dict],
) -> WorkerRequestContext:
    owner_unit = next(
        unit for unit in owner_context.units if int(unit["cell"].id) == int(cell_id)
    )
    owner_cell = owner_unit["cell"]
    cell = WorkerCell(
        id=int(owner_cell.id),
        name=str(owner_cell.name),
        archived=bool(owner_cell.archived),
    )
    unit = dict(owner_unit)
    unit["cell"] = cell
    files = tuple(_copy_source(source) for source in owner_context.files_by_cell[cell_id])
    source_hashes = {source.hash for source in files}
    return WorkerRequestContext(
        units=(unit,),
        missing_refs=(),
        cells=(cell,),
        files_by_cell={cell_id: files},
        hashes_by_cell={cell_id: tuple(owner_context.hashes_by_cell[cell_id])},
        parser_versions_by_cell={
            cell_id: dict(owner_context.parser_versions_by_cell[cell_id])
        },
        scalar_metadata={
            cell_id: dict(owner_context.scalar_metadata.get(cell_id) or {})
        },
        labels_by_cell={cell_id: str(owner_context.labels_by_cell[cell_id])},
        # Raw headers and original paths stay in the owner.  Only the
        # reconstructed protocol needed by the scientific family crosses the
        # process boundary.
        protocol_by_source=tuple(
            (file_hash, protocol)
            for file_hash, protocol in protocols.items()
            if file_hash in source_hashes
        ),
    )


def _one_cell_spec(spec: Mapping[str, Any], family: str, cell_id: int) -> dict[str, Any]:
    result = deepcopy(dict(spec))
    result.setdefault("selection", {})["entries"] = [
        {"kind": "cell", "ref_id": int(cell_id)}
    ]
    computation = result.setdefault("computation", {})
    if family in {"steps", "dcir"}:
        config = computation.setdefault(family, {})
        config["series"] = [
            deepcopy(item)
            for item in (config.get("series") or [])
            if isinstance(item, Mapping) and int(item.get("cell_id", -1)) == int(cell_id)
        ]
    return result


def _worker_jobs(
    family: str,
    spec: Mapping[str, Any],
    owner_context: Any,
    provenance: dict[str, Any] | None,
    use_current_versions: bool,
) -> list[FamilyWorkerJob]:
    protocols = _protocol_by_source(owner_context)
    jobs: list[FamilyWorkerJob] = []
    for ordinal, unit in enumerate(owner_context.units):
        cell_id = int(unit["cell"].id)
        worker_provenance = None
        if provenance and not use_current_versions:
            worker_provenance = {
                "calc_version": provenance.get("calc_version"),
            }
        jobs.append(
            FamilyWorkerJob(
                family=family,
                spec=_one_cell_spec(spec, family, cell_id),
                provenance=worker_provenance,
                request_context=_worker_context(owner_context, cell_id, protocols),
                ordinal=ordinal,
                cell_id=cell_id,
                submitted_at=0.0,
                use_current_versions=use_current_versions,
            )
        )
    return jobs


def _owner_cache_ready(
    owner_context: Any,
    *,
    family: str | None = None,
    calc_version: str | None = None,
) -> bool:
    """Return whether every source has the exact cache needed by a worker.

    In particular, raw Parquet alone is not enough for a Cycles worker:
    ``cache.load_cycles`` is allowed to derive and write a missing cycle cache,
    which would violate the worker's read-only boundary and make readiness
    depend on a hidden write.
    """

    from . import analysis_engine, cache

    pending = cache.pending_hashes()
    expected_calc_version = calc_version or analysis_engine.CALC_VERSION

    for cell in owner_context.cells:
        versions = owner_context.parser_versions_by_cell[cell.id]
        for source in owner_context.files_by_cell[cell.id]:
            parser_version = versions[source.hash]
            if source.hash in pending or not cache.raw_path(source.hash, parser_version).exists():
                return False
            if family == "cycles" and not cache.has_cycles(
                source.hash,
                parser_version,
                expected_calc_version,
            ):
                return False
    return True


def _merge_common(first: Mapping[str, Any], family: str, spec: Mapping[str, Any]) -> dict[str, Any]:
    from . import analysis_engine

    result = deepcopy(dict(first))
    result.pop("cache_status", None)
    result.pop("data_signature", None)
    result.pop("computed_at", None)
    result["computed_at"] = analysis_engine.now_iso()
    result["type"] = spec.get("type", "cycling") if family == "cycles" else family
    return result


def _dedupe_badges(badges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for badge in badges:
        key = json.dumps(badge, sort_keys=True, separators=(",", ":"), default=str)
        if key in seen:
            continue
        seen.add(key)
        result.append(badge)
    return result


def _merge_cycles(
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
) -> dict[str, Any]:
    from . import analysis_engine

    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "cycles", spec)
    series = [item["result"]["cell_series"][0] for item in ordered]
    sources = [item["result"]["sources"][0] for item in ordered]
    quantity_cols = [column for column, _label in analysis_engine.ALL_QUANTITIES.values()]
    aggregation = dict(spec.get("aggregation") or {})
    by_group: dict[int, list[dict]] = {}
    group_names: dict[int, str] = {}
    if (aggregation.get("mode") or "replicate_mean") == "replicate_mean":
        for item in series:
            if item.get("group_id") is not None and not item.get("excluded") and item.get("x"):
                group_id = int(item["group_id"])
                by_group.setdefault(group_id, []).append(item)
                group_names[group_id] = str(item.get("group_name") or "")
    aggregates = []
    for group_id, members in by_group.items():
        aggregate = analysis_engine.aggregate_series(members, quantity_cols, aggregation)
        aggregate["group_id"] = group_id
        aggregate["group_name"] = group_names[group_id]
        aggregates.append(aggregate)
    group_metrics = []
    seen_groups: list[int] = []
    for item in series:
        group_id = item.get("group_id")
        if group_id is not None and int(group_id) not in seen_groups:
            seen_groups.append(int(group_id))
    for group_id in seen_groups:
        members = [
            item
            for item in series
            if item.get("group_id") == group_id
            and not item.get("excluded")
            and item.get("metrics", {}).get("n_cycles")
        ]
        if members:
            group_metrics.append(
                {
                    "group_id": group_id,
                    "group_name": members[0].get("group_name"),
                    "metrics": analysis_engine.aggregate_metrics(
                        [item["metrics"] for item in members]
                    ),
                }
            )
    merged.update(
        {
            "cell_series": series,
            "aggregates": aggregates,
            "group_metrics": group_metrics,
            "badges": _dedupe_badges(
                [badge for item in ordered for badge in item["result"].get("badges", [])]
            ),
            "sources": sources,
        }
    )
    return merged


def _merge_steps(
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
) -> dict[str, Any]:
    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "steps", spec)
    merged.update(
        {
            "steps": {
                "series": deepcopy(
                    ((spec.get("computation") or {}).get("steps") or {}).get("series") or []
                ),
                "mode": (first.get("steps") or {}).get("mode", "union"),
            },
            "cell_series": [
                series
                for item in ordered
                for series in item["result"].get("cell_series", [])
            ],
            "badges": _dedupe_badges(
                [badge for item in ordered for badge in item["result"].get("badges", [])]
            ),
            "sources": [
                source
                for item in ordered
                for source in item["result"].get("sources", [])
            ],
        }
    )
    return merged


def _merge_dcir(
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
) -> dict[str, Any]:
    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "dcir", spec)
    merged.update(
        {
            "dcir": {
                "series": deepcopy(
                    ((spec.get("computation") or {}).get("dcir") or {}).get("series") or []
                )
            },
            "cell_series": [
                series
                for item in ordered
                for series in item["result"].get("cell_series", [])
            ],
            "badges": _dedupe_badges(
                [badge for item in ordered for badge in item["result"].get("badges", [])]
            ),
            "sources": [
                source
                for item in ordered
                for source in item["result"].get("sources", [])
            ],
        }
    )
    return merged


def _merge_rate_capability(
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
    cell_ids: list[int],
) -> dict[str, Any]:
    from . import rate_capability

    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "rate_capability", spec)
    cells = [
        cell
        for item in ordered
        for cell in item["result"].get("cells", [])
    ]
    blocks = [
        block
        for item in ordered
        for block in item["result"].get("blocks", [])
    ]
    detected = [
        block
        for item in ordered
        for block in item["result"].get("detected_blocks", [])
    ]
    worker_cells = [
        WorkerCell(
            id=int(cell_id),
            name=str(
                next(
                    item["cell_name"]
                    for result in ordered
                    for item in result["result"].get("cells", [])
                    if int(item["cell_id"]) == int(cell_id)
                )
            ),
        )
        for cell_id in cell_ids
    ]
    config = deepcopy(first.get("config") or {})
    blocks, comparison = rate_capability.build_common_rate_comparison(
        blocks,
        worker_cells,
        float(config.get("rate_tolerance_fraction", 0.03)),
    )
    fingerprints_by_family: dict[str, set[str]] = {"charge": set(), "discharge": set()}
    for block in blocks:
        fingerprints_by_family.setdefault(str(block["family"]), set()).add(
            str(block["fingerprint"])
        )
    compatibility = {
        family: {
            "compatible": bool(
                [block for block in blocks if block["family"] == family]
            )
            and len(fingerprints_by_family.get(family, set())) == 1,
            "complete": {
                int(block["cell_id"])
                for block in blocks
                if block["family"] == family
            }
            == set(cell_ids),
            "fingerprints": sorted(fingerprints_by_family.get(family, set())),
        }
        for family in ("charge", "discharge")
    }
    merged.update(
        {
            "config": config,
            "blocks": blocks,
            "detected_blocks": detected,
            "points": [point for block in blocks for point in block.get("points", [])],
            "comparison": comparison,
            "available": {
                "charge_rates_c": sorted(
                    {
                        round(float(rate), 6)
                        for block in detected
                        if block["family"] == "charge"
                        for rate in block["rates_c"]
                    }
                ),
                "discharge_rates_c": sorted(
                    {
                        round(float(rate), 6)
                        for block in detected
                        if block["family"] == "discharge"
                        for rate in block["rates_c"]
                    }
                ),
                "charge_fixed_rates_c": sorted(
                    {
                        round(float(block["fixed_rate_c"]), 6)
                        for block in detected
                        if block["family"] == "charge"
                    }
                ),
                "discharge_fixed_rates_c": sorted(
                    {
                        round(float(block["fixed_rate_c"]), 6)
                        for block in detected
                        if block["family"] == "discharge"
                    }
                ),
                "charge_structures": sorted(
                    {
                        block["charge_structure"]
                        for block in detected
                    }
                ),
            },
            "invalid_execution_count": sum(
                int(item["result"].get("invalid_execution_count") or 0)
                for item in ordered
            ),
            "cells": cells,
            "selection_contexts": [
                deepcopy(context)
                for item in ordered
                for context in item["result"].get("selection_contexts", [])
            ]
            or [
                {
                    "cell_id": int(cell_id),
                    "entry_kind": "cell",
                    "entry_ref_id": int(cell_id),
                }
                for cell_id in cell_ids
            ],
            "compatibility": compatibility,
            "badges": _dedupe_badges(
                [badge for item in ordered for badge in item["result"].get("badges", [])]
            ),
            "sources": [
                source
                for item in ordered
                for source in item["result"].get("sources", [])
            ],
        }
    )
    return merged


def _merge_results(
    family: str,
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
    cell_ids: list[int],
) -> dict[str, Any]:
    if not results:
        raise RuntimeError("family worker returned no results")
    if family == "cycles":
        return _merge_cycles(results, spec)
    if family == "steps":
        return _merge_steps(results, spec)
    if family == "dcir":
        return _merge_dcir(results, spec)
    if family == "rate_capability":
        return _merge_rate_capability(results, spec, cell_ids)
    raise ValueError(f"unsupported production family merge: {family}")


def _finalize_merged_result(
    result: dict[str, Any],
    family: str,
    ordered_results: list[dict[str, Any]],
    owner_context: Any,
    provenance: dict[str, Any] | None,
) -> dict[str, Any]:
    """Restore owner-wide version and provenance badges after cell merging."""

    from . import analysis_engine

    selected_cell_ids = {
        int(source["cell_id"])
        for source in result.get("sources", [])
        if source.get("cell_id") is not None
    }
    pinned: list[str] = []
    current: list[str] = []
    for cell_id in selected_cell_ids:
        versions = owner_context.parser_versions_by_cell.get(cell_id, {})
        pinned.extend(str(value) for value in versions.values())
        for source in owner_context.files_by_cell.get(cell_id, ()):
            current.append(str(analysis_engine.current_parser_identity(source)))
    if pinned:
        result["parser_version"] = analysis_engine.display_parser_version(pinned)
    if current:
        result["current_parser_version"] = analysis_engine.display_parser_version(current)
    first = ordered_results[0]["result"]
    result["calc_version"] = first.get("calc_version", analysis_engine.CALC_VERSION)
    result["current_calc_version"] = first.get(
        "current_calc_version", analysis_engine.CALC_VERSION
    )
    result["computed_at"] = analysis_engine.now_iso()

    badges = list(result.get("badges") or [])
    for miss in owner_context.missing_refs:
        badges.append(
            {
                "kind": "missing_reference",
                "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists.",
            }
        )
    if result["calc_version"] != analysis_engine.CALC_VERSION:
        badges.append(
            {
                "kind": "newer_calc",
                "detail": (
                    f"Computed with calc {result['calc_version']}; "
                    f"{analysis_engine.CALC_VERSION} available — recompute?"
                ),
            }
        )
    if provenance and provenance.get("sources") is not None:
        previous = {int(item["cell_id"]) for item in provenance["sources"]}
        current_cells = {
            int(item["cell_id"])
            for item in result.get("sources", [])
            if item.get("cell_id") is not None
        }
        added = sorted(current_cells - previous)
        removed = sorted(previous - current_cells)
        previous_hashes = {
            value
            for item in provenance["sources"]
            for value in item.get("file_hashes", [])
        }
        current_hashes = {
            value
            for item in result.get("sources", [])
            for value in item.get("file_hashes", [])
        }
        if added or removed:
            badges.append(
                {
                    "kind": "selection_drift",
                    "detail": (
                        "Referenced groups resolve differently than when last saved "
                        f"(+{len(added)} cell(s), −{len(removed)}). Save to accept."
                    ),
                    "added_cell_ids": added,
                    "removed_cell_ids": removed,
                }
            )
        elif previous_hashes != current_hashes:
            badges.append(
                {
                    "kind": "new_data",
                    "detail": "New source files are attached to selected cells since last computed.",
                }
            )
    result["badges"] = _dedupe_badges(badges)
    return result


def try_compute_family(
    db: Any,
    spec: dict[str, Any],
    provenance: dict[str, Any] | None,
    *,
    family: str,
    use_current_versions: bool = False,
    request_context: Any = None,
    progress: Any = None,
    diagnostics: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Run one promoted family through the shared application pool.

    ``None`` is the deliberate serial fallback signal.  The route remains the
    owner of cache lookup, persistence, JSON response construction and any
    request-scoped database work.
    """

    if family not in PROMOTED_FAMILIES:
        return None
    from . import analysis_engine, time_capacity_workers

    try:
        if request_context is None:
            analysis_engine.ensure_canonical_cycling_available(db, spec)
            request_context = analysis_engine.build_analysis_request_context(
                db,
                spec,
                provenance,
                use_current_versions=use_current_versions,
            )
        else:
            analysis_engine.ensure_canonical_cycling_available(
                db,
                spec,
                request_context=request_context,
            )
        units = list(request_context.units)
        cells = list(request_context.cells)
        # A duplicate Cell can legitimately appear through different selection
        # references.  The compact one-cell merge cannot represent that
        # multiplicity, so retain the serial route for those requests.
        if len(cells) < PROMOTED_MIN_CELLS or len(units) != len(cells):
            return None
        calc_version = analysis_engine.CALC_VERSION
        if provenance and not use_current_versions:
            calc_version = provenance.get("calc_version") or calc_version
        if not _owner_cache_ready(
            request_context,
            family=family,
            calc_version=calc_version,
        ):
            return None
        cell_ids = [int(unit["cell"].id) for unit in units]
        jobs_started = perf_counter()
        jobs = _worker_jobs(
            family,
            spec,
            request_context,
            provenance,
            use_current_versions,
        )
        if diagnostics is not None:
            diagnostics["job_construction_ms"] = (perf_counter() - jobs_started) * 1000.0
            diagnostics["job_count"] = len(jobs)
        pool = time_capacity_workers._ready_pool(PROMOTED_WORKERS)
        submitted: list[FamilyWorkerJob] = []
        serialized_job_bytes = 0
        serialization_started = perf_counter()
        for job in jobs:
            next_job = FamilyWorkerJob(
                family=job.family,
                spec=job.spec,
                provenance=job.provenance,
                request_context=job.request_context,
                ordinal=job.ordinal,
                cell_id=job.cell_id,
                submitted_at=perf_counter(),
                use_current_versions=job.use_current_versions,
            )
            if worker_job_has_forbidden_state(next_job):
                raise RuntimeError("forbidden owner state crossed family worker boundary")
            submitted.append(next_job)
            if diagnostics is not None:
                serialized_job_bytes += len(
                    pickle.dumps(next_job, protocol=pickle.HIGHEST_PROTOCOL)
                )
        if diagnostics is not None:
            diagnostics["serialized_job_bytes"] = serialized_job_bytes
            diagnostics["job_serialization_ms"] = (
                perf_counter() - serialization_started
            ) * 1000.0
        try:
            submit_started = perf_counter()
            futures = [pool.submit(run_family_job, job) for job in submitted]
            if diagnostics is not None:
                diagnostics["submit_ms"] = (perf_counter() - submit_started) * 1000.0
            results: list[dict[str, Any]] = []
            transfer_started = perf_counter()
            for index, future in enumerate(futures):
                results.append(future.result(timeout=180))
                if progress:
                    label = str(units[index].get("label") or units[index]["cell"].name)
                    progress(index + 1, len(units), label, "Read from cache")
            if diagnostics is not None:
                diagnostics["result_transfer_ms"] = (
                    perf_counter() - transfer_started
                ) * 1000.0
                diagnostics["worker_results"] = results
        except (BrokenProcessPool, FutureTimeoutError):
            time_capacity_workers._mark_pool_failed(pool)
            logger.exception("Shared family worker infrastructure failed; using serial fallback")
            return None
        merge_started = perf_counter()
        result = _merge_results(family, results, spec, cell_ids)
        if diagnostics is not None:
            diagnostics["owner_merge_ms"] = (perf_counter() - merge_started) * 1000.0
        finalize_started = perf_counter()
        result = _finalize_merged_result(
            result,
            family,
            sorted(results, key=lambda item: item["ordinal"]),
            request_context,
            provenance,
        )
        if diagnostics is not None:
            diagnostics["finalization_ms"] = (perf_counter() - finalize_started) * 1000.0
        return result
    except time_capacity_workers.PoolNotReadyError:
        return None


def worker_ping() -> tuple[int, int | None]:
    """Warmup acknowledgement used to prove distinct resident worker PIDs."""

    # A tiny bounded pause prevents ProcessPoolExecutor from satisfying every
    # warmup acknowledgement on its first process before the remaining spawn
    # slots are created.  Warmup is outside the measured request boundary.
    sleep(0.01)
    return os.getpid(), _rss_bytes()


def run_family_job(job: FamilyWorkerJob) -> dict[str, Any]:
    """Run one compact family job and return diagnostics plus its fragment."""

    started = perf_counter()
    rss_before = _rss_bytes()
    counters: dict[str, Any] = {
        "calls": {},
        "elapsed_ms": {},
        "rows": {},
        "physical_rows": 0,
        "row_groups": 0,
    }
    _assert_cache_only(job)
    with _cache_wrappers(counters):
        result = _compute(job)
    scientific_ms = (perf_counter() - started) * 1000.0
    serialization_started = perf_counter()
    result_bytes = pickle.dumps(result, protocol=pickle.HIGHEST_PROTOCOL)
    result_serialization_ms = (perf_counter() - serialization_started) * 1000.0
    rss_after = _rss_bytes()
    return {
        "ordinal": job.ordinal,
        "cell_id": job.cell_id,
        "result": result,
        "worker_pid": os.getpid(),
        "queue_ms": max(0.0, (started - job.submitted_at) * 1000.0),
        "worker_wall_ms": scientific_ms,
        "worker_scientific_ms": scientific_ms,
        "result_bytes": len(result_bytes),
        "result_serialization_ms": result_serialization_ms,
        "rss_before_bytes": rss_before,
        "rss_after_bytes": rss_after,
        "cache_reads": counters,
    }


def worker_job_has_forbidden_state(job: FamilyWorkerJob) -> bool:
    """Test helper: reject accidental ORM/session/frame payloads early."""

    from dataclasses import fields, is_dataclass
    from sqlalchemy.orm import Session

    try:
        from pandas import DataFrame
    except ImportError:  # pragma: no cover - pandas is a production dependency
        DataFrame = ()  # type: ignore[assignment]

    seen: set[int] = set()

    def contains(value: Any) -> bool:
        identity = id(value)
        if identity in seen:
            return False
        seen.add(identity)
        if isinstance(value, (Session, DataFrame)):
            return True
        if is_dataclass(value) and not isinstance(value, type):
            return any(contains(getattr(value, field.name)) for field in fields(value))
        if isinstance(value, dict):
            return any(contains(key) or contains(item) for key, item in value.items())
        if isinstance(value, (list, tuple, set, frozenset)):
            return any(contains(item) for item in value)
        return False

    return contains(job)


__all__ = [
    "FamilyWorkerJob",
    "PROMOTED_FAMILIES",
    "PROMOTED_MIN_CELLS",
    "PROMOTED_WORKERS",
    "WorkerCell",
    "WorkerRequestContext",
    "WorkerSource",
    "run_family_job",
    "try_compute_family",
    "worker_job_has_forbidden_state",
    "worker_ping",
]
