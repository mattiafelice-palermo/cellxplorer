"""Cycling-comparison analysis engine (spec type "cycling").

An analysis is a persistent recipe: explicit references to cells and
replicate groups, per-analysis exclusions, computation choices and pinned
provenance. Compute renders everything from the versioned per-cycle caches
— per-cell series for ALL quantities plus replicate aggregation and a
metrics table, calculated at render time and never stored.

Analysis types beyond "cycling" (rate capability, chargeability, …) plug in
later with their own computation; selection/exclusion/provenance stay shared.

THE INVARIANT: an analysis never changes unless the user changes it.
Rendering uses the parser/calc versions pinned in provenance; anything
newer is a badge, never a silent recompute.
"""
from __future__ import annotations

import warnings
from datetime import datetime, timezone
from pathlib import Path
import re
from time import perf_counter
from typing import Any, Callable

import numpy as np
import pandas as pd
from sqlalchemy import func, inspect as sa_inspect, select
from sqlalchemy.orm import Session, defer, joinedload, object_session, selectinload

from ..config import CALC_VERSION
from ..models import Cell, CellMetadata, ReplicateGroup, SourceFile, Test, TestFile
from . import (
    cache,
    calc,
    canonical_cycling,
    parsing,
    protocol,
    stitch,
    time_capacity_derived,
    time_capacity_path,
)

SPEC_VERSION = 9
ProgressCallback = Callable[[int, int, str, str], None]

# quantities served to the client: every cached per-cycle column plus
# derived ones computed here at render time
DERIVED_QUANTITIES = {
    "voltaic_efficiency": ("voltaic_efficiency_pct", "Voltaic efficiency (%)"),
    "polarization": ("polarization_v", "Polarization ΔV (V)"),
    "polarization_pct": ("polarization_pct", "Polarization ΔV/V (%)"),
    "capacity_retention": ("capacity_retention_pct", "Capacity retention / SoH (%)"),
    "discharge_capacity_loss": ("discharge_capacity_loss_mah", "Discharge capacity loss (mAh/cycle)"),
    "charge_capacity_loss": ("charge_capacity_loss_mah", "Charge capacity loss (mAh/cycle)"),
}

SPECIFIC_QUANTITIES = {
    "discharge_capacity_specific": ("discharge_capacity_mah_g", "Discharge capacity (mAh/g)"),
    "charge_capacity_specific": ("charge_capacity_mah_g", "Charge capacity (mAh/g)"),
    "discharge_energy_specific": ("discharge_energy_mwh_g", "Discharge energy (mWh/g)"),
    "charge_energy_specific": ("charge_energy_mwh_g", "Charge energy (mWh/g)"),
    "discharge_capacity_loss_specific": (
        "discharge_capacity_loss_mah_g_cycle",
        "Discharge capacity loss (mAh/g/cycle)",
    ),
    "charge_capacity_loss_specific": (
        "charge_capacity_loss_mah_g_cycle",
        "Charge capacity loss (mAh/g/cycle)",
    ),
    "cv_charge_capacity_specific": ("cv_charge_capacity_mah_g", "CV charge capacity (mAh/g)"),
}

ALL_QUANTITIES: dict[str, tuple[str, str]] = {
    **calc.QUANTITIES,
    **DERIVED_QUANTITIES,
    **SPECIFIC_QUANTITIES,
}
SELECTABLE_QUANTITIES: dict[str, tuple[str, str]] = {
    **calc.QUANTITIES,
    **DERIVED_QUANTITIES,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_spec(title: str) -> dict:
    now = now_iso()
    return {
        "spec_version": SPEC_VERSION,
        "type": "cycling",
        "title": title,
        "created_at": now,
        "modified_at": now,
        "selection": {"entries": [], "exclusions": [], "hidden_replicate_group_ids": []},
        "protocol_segments": [],
        "dcir_segments": [],
        "computation": {
            "cycle_range": {"start": 1, "end": None},
            "exclude_check_cycles_every_n": 0,
            # SoH reference: max discharge capacity within the first n cycles
            # (mode "cycle" pins an explicit reference cycle instead)
            "retention_reference": {"mode": "max_first_n", "n": 5, "cycle": None},
            # cycles treated as formation and excluded from steady-state means
            "formation_cycles": 3,
            "polarization": {
                "method": "mean",
                "direction": "charge_minus_discharge",
            },
            "protocol_filter": {"excluded_segment_ids": [], "only_segment_ids": []},
            "steps": {"series": [], "mode": "union"},
            "dcir": {"series": []},
            "chargeability": {
                "initial_soc_max_pct": 20.0,
                "final_soc_min_pct": 80.0,
                "min_current_ceiling_c": 7.0,
                "soc_tolerance_pct": 2.0,
            },
            "rate_capability": {
                "min_points": 3,
                "cutoff_tolerance_v": 0.03,
                "rate_tolerance_fraction": 0.03,
                "families": {
                    "charge": {
                        "enabled": True,
                        "charge_structure": "auto",
                        "fixed_rate_c": None,
                        "selected_rates_c": [],
                        "monotonic": "prefer",
                        "scaffold": "prefer",
                    },
                    "discharge": {
                        "enabled": True,
                        "charge_structure": "auto",
                        "fixed_rate_c": None,
                        "selected_rates_c": [],
                        "monotonic": "prefer",
                        "scaffold": "prefer",
                    },
                },
            },
        },
        "aggregation": {"mode": "replicate_mean", "dispersion": "std", "min_n_for_band": 2},
        "presentation": {
            "quantity": "discharge_capacity",
            "ce_overlay": True,
            "show_individual_cells": True,
            "legend": True,
            "hidden_protocol_segment_ids": [],
            "steps_view": {
                "quantity": "time",
                "direction": "charge",
                "include_rest": False,
                "x_axis": "occurrence",
            },
            "dcir_view": {
                "quantity": "absolute",
                "x_axis": "occurrence",
                "candidate_filter": {
                    "min_rest_s": 600,
                    "max_pulse_s": 120,
                    "min_ratio": 10,
                },
            },
            "chargeability_view": {
                "x_axis": "soc_pct",
                "y_axis": "c_rate",
                "time_unit": "min",
            },
            "rate_capability_view": {
                "x_axis": "c_rate",
                "y_axis": "capacity_mah",
                "show_charge": True,
                "show_discharge": True,
                "x_spacing": "equal",
                "visualization": "line",
            },
        },
        "saved_plots": [],
    }


# ------------------------------------------------------------- resolution


class CellSourceChainInvariantError(ValueError):
    """A Cell cannot participate in scientific work without one Test row."""

    def __init__(self, cell: Cell, test_count: int):
        self.detail = {
            "code": "single_internal_test_required",
            "message": "This Cell must have exactly one internal source-chain row.",
            "cell_id": cell.id,
            "cell_name": cell.name,
            "test_count": test_count,
        }
        super().__init__(self.detail["message"])


def require_single_internal_test(cell: Cell) -> Test:
    """Resolve the compatibility row that owns the Cell's ordered sources."""
    tests = sorted(cell.tests, key=lambda item: item.id)
    if len(tests) != 1:
        raise CellSourceChainInvariantError(cell, len(tests))
    return tests[0]


def ordered_cell_source_links(cell: Cell) -> list[TestFile]:
    """Return the one Cell source chain in canonical position order."""
    test = require_single_internal_test(cell)
    return sorted(test.file_links, key=lambda item: (item.position, item.id))


def preload_cell_sources(db: Session, cells: list[Cell]) -> None:
    """Load tests, file links and source files for many cells in one round trip.

    ``cell_ordered_hashes`` walks ``cell.tests -> test.file_links -> link.file``.
    Through lazy loading that is roughly seven queries per cell, so building a
    cache key for 25 cells issued 175 queries before a single cached byte was
    read, and refreshing availability badges issued 100 more. Warming the
    session's identity map first makes those walks free.

    This is purely a loading strategy: the walks still sort in Python exactly as
    before, so the resulting hash order — and therefore every cache key — is
    unchanged.

    ``header_meta`` is deferred. It holds the raw instrument header (~3 MB across
    this database) and is only read when reconstructing protocols during an
    actual compute, never on the cache-hit path; leaving it in meant decoding
    all of it as JSON on every request that touched a source file.
    """
    ids = {cell.id for cell in cells if cell.id is not None}
    if not ids:
        return
    db.execute(
        select(Cell)
        .where(Cell.id.in_(ids))
        .options(
            selectinload(Cell.tests)
            .selectinload(Test.file_links)
            .joinedload(TestFile.file)
            .defer(SourceFile.header_meta)
        )
    ).unique().all()


def current_cell_hashes(db: Session) -> dict[int, list[str]]:
    """Ordered source-file hashes for every cell, in one query.

    Same ordering as :func:`cell_ordered_hashes` (tests by id, files by
    position) so the lists can be compared directly against the ``file_hashes``
    an analysis recorded in its provenance. Built in bulk because the callers
    are list endpoints: resolving this per analysis would reintroduce the
    per-cell query walk that ``preload_cell_sources`` exists to avoid.
    """
    invalid = db.execute(
        select(Cell.id, func.count(Test.id))
        .outerjoin(Test, Test.cell_id == Cell.id)
        .group_by(Cell.id)
        .having(func.count(Test.id) != 1)
    ).all()
    if invalid:
        cells = {
            cell.id: cell
            for cell in db.query(Cell).filter(Cell.id.in_([row[0] for row in invalid])).all()
        }
        cell_id, count = invalid[0]
        cell = cells.get(cell_id) or Cell(id=cell_id, name="Unknown")
        raise CellSourceChainInvariantError(cell, int(count))

    rows = db.execute(
        select(Test.cell_id, SourceFile.hash)
        .select_from(Test)
        .join(TestFile, TestFile.test_id == Test.id)
        .join(SourceFile, SourceFile.id == TestFile.file_id)
        .order_by(Test.cell_id, TestFile.position, TestFile.id)
    ).all()
    hashes: dict[int, list[str]] = {}
    for cell_id, file_hash in rows:
        hashes.setdefault(cell_id, []).append(file_hash)
    return hashes


def sources_changed_since_compute(
    provenance: dict | None, current: dict[int, list[str]]
) -> bool:
    """Whether an analysis's sources differ from what it was computed against.

    Derived rather than stored: it clears itself when the analysis is
    recomputed, so there is no "seen" state to maintain and no way for the
    flag to drift from reality.
    """
    for source in (provenance or {}).get("sources") or []:
        cell_id = source.get("cell_id")
        if cell_id is None:
            continue
        if list(source.get("file_hashes") or []) != current.get(cell_id, []):
            return True
    return False


def cell_ordered_hashes(db: Session, cell: Cell) -> tuple[list[str], list[SourceFile]]:
    """All source files of a Cell's one ordered source chain."""
    hashes: list[str] = []
    files: list[SourceFile] = []
    for link in ordered_cell_source_links(cell):
        hashes.append(link.file.hash)
        files.append(link.file)
    return hashes, files


class CanonicalCyclingUnavailable(ValueError):
    """The selected sources cannot produce scientific cycling rows."""

    def __init__(self, detail: dict[str, object]):
        self.detail = detail
        super().__init__(str(detail.get("message") or "Canonical cycling data is unavailable."))


def canonical_cycling_capability(db: Session, spec: dict) -> dict[str, object] | None:
    """Return a stable capability response when selection contains metadata-only sources."""

    units, _missing = resolve_selection(db, spec)
    cells = list({unit["cell"].id: unit["cell"] for unit in units}.values())
    # Saved-artifact and warmup callers use this same capability boundary as
    # compute endpoints. Warm the relational source chain once so the guard
    # does not turn a multi-cell analysis into a per-cell relationship walk.
    preload_cell_sources(db, cells)
    sources: list[dict[str, object]] = []
    seen: set[int] = set()
    for unit in units:
        _hashes, files = cell_ordered_hashes(db, unit["cell"])
        for source in files:
            if source.id in seen or not parsing.source_record_metadata_only(
                source,
                include_header=False,
            ):
                continue
            seen.add(source.id)
            # Capability guards run on cache-hit, artifact, and warmup paths.
            # Use only persisted scalar state here; header_meta is intentionally
            # deferred and belongs to an actual protocol reconstruction.
            capability = parsing.source_record_capability(source, include_header=False)
            sources.append(
                {
                    "source_file_id": source.id,
                    "filename": source.filename,
                    "cell_id": unit["cell"].id,
                    "cell_name": unit["cell"].name,
                    "warning": capability["warning"],
                }
            )
    if not sources:
        return None
    return {
        "code": "canonical_cycling_unavailable",
        "status": "metadata_only",
        "metadata_only": True,
        "canonical_cycling": False,
        "message": (
            "This analysis includes metadata-only sources. Canonical cycling rows are not "
            "available for these sources, so cache-backed analysis and recompute are disabled."
        ),
        "sources": sources,
    }


def ensure_canonical_cycling_available(db: Session, spec: dict) -> None:
    detail = canonical_cycling_capability(db, spec)
    if detail is not None:
        raise CanonicalCyclingUnavailable(detail)


# --------------------------------------------------- per-source parser identity


def current_parser_identity(source_file: SourceFile) -> str:
    """Cheap current expected parser identity for one registered source.

    Resolved from the source's stored extension alone — no file I/O, no
    parser import (see `parsing.current_parser_identity_for_extension`).
    Falls back to the legacy transitional bundle only for an extension the
    format registry does not recognize, which should not happen for a
    successfully registered source.
    """
    return parsing.current_parser_identity_for_extension(source_file.ext) or parsing.PARSER_VERSION


def resolve_source_parser_versions(
    files: list[SourceFile],
    provenance: dict | None,
    cell_id: int,
    use_current_versions: bool,
) -> dict[str, str]:
    """Effective parser identity to render each of a cell's ordered sources at.

    New-shape provenance (Spec 040.3) pins an identity per contributing
    source: ``provenance["sources"]`` entries carry a ``files`` array of
    ``{"hash", "position", "parser_version"}``. Legacy provenance (pre-040.3)
    pinned a single scalar ``provenance["parser_version"]`` for the whole
    analysis; this is normalized here by applying that one historical value
    to every source the legacy entry's ``file_hashes`` covered — the only
    truthful historical information available; it is never invented, and it
    is never applied to a source the legacy provenance did not cover.

    A source with no pinned identity — a fresh compute
    (``use_current_versions=True``), an analysis with no provenance yet, or
    a source attached to the cell since the analysis was last computed —
    resolves to the CURRENT identity for its own extension/format, never
    another source's pinned identity. This is what makes a mixed-format
    Cell chain resolve correctly: each source's identity is independent.
    """
    pinned: dict[str, str] = {}
    if provenance and not use_current_versions:
        legacy_value = provenance.get("parser_version")
        for source_entry in provenance.get("sources") or []:
            if not isinstance(source_entry, dict) or source_entry.get("cell_id") != cell_id:
                continue
            entry_files = source_entry.get("files")
            if isinstance(entry_files, list) and entry_files:
                for file_entry in entry_files:
                    if not isinstance(file_entry, dict):
                        continue
                    file_hash = file_entry.get("hash")
                    identity = file_entry.get("parser_version")
                    if file_hash and identity:
                        pinned[file_hash] = identity
            elif legacy_value:
                for file_hash in source_entry.get("file_hashes") or []:
                    pinned.setdefault(file_hash, legacy_value)
    return {f.hash: pinned.get(f.hash) or current_parser_identity(f) for f in files}


def cell_source_refs(
    files: list[SourceFile],
    provenance: dict | None,
    cell_id: int,
    use_current_versions: bool,
) -> list["stitch.CachedSourceRef"]:
    """Ordered `stitch.CachedSourceRef`s for one cell, at their resolved identities."""
    versions = resolve_source_parser_versions(files, provenance, cell_id, use_current_versions)
    return [stitch.CachedSourceRef(f.hash, versions[f.hash]) for f in files]


def current_source_refs(files: list[SourceFile]) -> list["stitch.CachedSourceRef"]:
    """Ordered `stitch.CachedSourceRef`s at each source's CURRENT identity.

    For callers that always render "as of now" with no pinned provenance
    (e.g. the Cell Database's live cycle preview) rather than a saved
    analysis render.
    """
    return [stitch.CachedSourceRef(f.hash, current_parser_identity(f)) for f in files]


def source_file_entries(
    files: list[SourceFile], versions: dict[str, str]
) -> list[dict[str, str | int]]:
    """Per-source provenance entries: ``{hash, position, parser_version}``.

    ``position`` is 1-based to match the source-descriptor/UI convention
    used elsewhere in this module.
    """
    return [
        {"hash": f.hash, "position": index, "parser_version": versions[f.hash]}
        for index, f in enumerate(files, start=1)
    ]


def display_parser_version(identities: set[str] | list[str]) -> str:
    """One human-facing string summarizing a set of per-source identities.

    Different contributing sources may legitimately carry different parser
    identities (Spec 040.3), so a single scalar can misrepresent the render.
    When every source shares one identity, show it plainly (the common
    case today); otherwise show an explicit "mixed" sentinel rather than
    picking one source's value and implying it describes them all.
    """
    unique = {value for value in identities if value}
    if not unique:
        return parsing.PARSER_VERSION
    if len(unique) == 1:
        return next(iter(unique))
    return "mixed"


PROTOCOL_DERIVED_FAMILIES = frozenset(
    {"steps", "dcir", "chargeability", "rate_capability"}
)


def multi_source_cells_for_spec(db: Session, spec: dict) -> list[dict]:
    """Return selected Cells whose ordered source chain has more than one file.

    Protocol-derived analysis must not infer semantic step mappings across a
    continuation boundary. Keep this selection expansion in one helper so
    every guarded endpoint and background path applies the same rule.
    """
    units, _missing = resolve_selection(db, spec)
    cells = list({unit["cell"].id: unit["cell"] for unit in units}.values())
    if not cells:
        return []
    preload_cell_sources(db, cells)
    unsupported: list[dict] = []
    for cell in sorted(cells, key=lambda item: (item.name.casefold(), item.id)):
        _hashes, files = cell_ordered_hashes(db, cell)
        if len(files) > 1:
            unsupported.append(
                {
                    "id": cell.id,
                    "name": cell.name,
                    "source_count": len(files),
                }
            )
    return unsupported


def protocol_analysis_guard(
    db: Session,
    spec: dict,
    plot_family: str,
) -> dict | None:
    """Build the structured fail-closed response for protocol plot families."""
    if plot_family not in PROTOCOL_DERIVED_FAMILIES:
        return None
    unsupported = multi_source_cells_for_spec(db, spec)
    if not unsupported:
        return None
    return {
        "code": "multi_source_protocol_mapping_required",
        "plot_family": plot_family,
        "unsupported_cells": unsupported,
        "supported_alternatives": ["cycles", "time_capacity"],
        "message": (
            "This plot uses source-local protocol steps. Restarted source files can "
            "renumber steps, so CellXplorer refuses to guess how a continuation chain "
            "maps across files. Use Cycles or Time / capacity instead."
        ),
    }


def source_descriptors(
    files: list[SourceFile],
    segments: list[dict],
    missing: list[str],
    frame: pd.DataFrame | None = None,
    parser_versions: dict[str, str] | None = None,
    source_facts: dict[str, dict] | None = None,
) -> list[dict]:
    """Describe the one ordered Cell source chain without exposing paths.

    ``segments`` only contains sources that were successfully stitched.  The
    descriptor list deliberately covers every ordered source so a missing or
    invalid cache is visible to callers instead of silently disappearing.
    """
    by_segment = {int(segment.get("segment", -1)): segment for segment in segments}
    missing_hashes = set(missing)
    timestamp_column = None
    if frame is not None:
        timestamp_column = next(
            (column for column in ("start_timestamp", "timestamp") if column in frame.columns),
            None,
        )
    descriptors: list[dict] = []
    for position, source_file in enumerate(files, start=1):
        segment = by_segment.get(position - 1) or {}
        start_timestamp = None
        end_timestamp = None
        indexed_facts = source_facts.get(source_file.hash) if source_facts else None
        if indexed_facts is not None:
            start_timestamp = indexed_facts.get("timestamp_start")
            end_timestamp = indexed_facts.get("timestamp_end")
        elif timestamp_column and frame is not None and not frame.empty and "segment" in frame.columns:
            values = pd.to_datetime(
                frame.loc[frame["segment"] == position - 1, timestamp_column],
                errors="coerce",
            ).dropna()
            if not values.empty:
                start_timestamp = values.min().isoformat()
                end_timestamp = values.max().isoformat()
        descriptor = {
            "source_file_id": source_file.id,
            "source_position": position,
            "filename": source_file.filename,
            "source_hash": source_file.hash,
            **(
                {"parser_version": parser_versions[source_file.hash]}
                if parser_versions and source_file.hash in parser_versions
                else {}
            ),
            "status": "missing" if source_file.hash in missing_hashes else "ready",
            "tracked_tail": position == len(files),
            "local_cycle_start": segment.get("source_cycle_start"),
            "local_cycle_end": segment.get("source_cycle_end"),
            "local_cycle_count": segment.get("source_cycle_count", 0),
            "global_cycle_start": segment.get("cycle_start"),
            "global_cycle_end": segment.get("cycle_end"),
            "start_timestamp": start_timestamp,
            "end_timestamp": end_timestamp,
        }
        descriptors.append(descriptor)
    return descriptors


def source_columns(frame: pd.DataFrame, files: list[SourceFile]) -> dict[str, list]:
    """Return source provenance columns aligned to a stitched frame."""
    by_hash = {source_file.hash: source_file for source_file in files}
    positions = {source_file.hash: index for index, source_file in enumerate(files, start=1)}
    hashes = (
        frame["source_hash"].tolist()
        if "source_hash" in frame.columns
        else [None] * len(frame)
    )
    source_cycles = (
        frame["source_cycle"].tolist()
        if "source_cycle" in frame.columns
        else [None] * len(frame)
    )

    def safe_int(value):
        if value is None or pd.isna(value):
            return None
        return int(value)

    source_cycle: list[int | None] = []
    source_position: list[int | None] = []
    source_filename: list[str | None] = []
    source_hash: list[str | None] = []
    for value, cycle in zip(hashes, source_cycles):
        source_file = by_hash.get(value)
        source_cycle.append(safe_int(cycle))
        source_position.append(positions.get(value))
        source_filename.append(source_file.filename if source_file is not None else None)
        source_hash.append(value if source_file is not None else None)
    return {
        "source_cycle": source_cycle,
        "source_position": source_position,
        "source_filename": source_filename,
        "source_hash": source_hash,
    }


def compact_source_columns(
    frame: pd.DataFrame,
    files: list[SourceFile] | tuple[SourceFile, ...],
) -> dict[str, list]:
    """Return deduplicated provenance for compact ordinary Time/Capacity rows."""

    by_hash = {source_file.hash: source_file for source_file in files}
    hashes = (
        frame["source_hash"].tolist()
        if "source_hash" in frame.columns
        else [None] * len(frame)
    )
    contributing_hashes = {value for value in hashes if value in by_hash}
    ordered_sources = [
        {
            "position": position,
            "filename": source_file.filename,
            "hash": source_file.hash,
        }
        for position, source_file in enumerate(files, start=1)
        if source_file.hash in contributing_hashes
    ]
    source_indexes = {
        source["hash"]: index for index, source in enumerate(ordered_sources)
    }
    source_cycles = (
        frame["source_cycle"].tolist()
        if "source_cycle" in frame.columns
        else [None] * len(frame)
    )

    def safe_int(value):
        if value is None or pd.isna(value):
            return None
        return int(value)

    return {
        "source_cycle": [safe_int(value) for value in source_cycles],
        "sources": ordered_sources,
        "source_index": [
            source_indexes.get(value)
            for value in hashes
        ],
    }


def _persisted_voltage_capabilities(source_file: SourceFile) -> dict:
    header = source_file.header_meta
    if not isinstance(header, dict):
        return {}
    value = header.get(canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY)
    if not isinstance(value, dict):
        value = header.get("voltage_capabilities")
    return value if isinstance(value, dict) else {}


def _resolve_time_capacity_voltage_context(
    files: list[SourceFile],
    matched_files_by_quantity: dict[str, list[SourceFile]],
    *,
    unknown_sources_by_quantity: set[str] | None = None,
) -> tuple[dict[str, str], dict[str, str | None]]:
    """Resolve roles/references from source-level finite-data facts."""

    default_roles = {
        "voltage": "cell",
        "working_potential": "working_vs_reference",
        "counter_potential": "counter_vs_reference",
    }
    role_candidates: dict[str, set[str]] = {
        quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES
    }
    reference_candidates: dict[str, set[str | None]] = {
        quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES
    }
    unknown_sources_by_quantity = unknown_sources_by_quantity or set()
    for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
        matched_files = matched_files_by_quantity.get(quantity, [])
        if quantity in unknown_sources_by_quantity:
            reference_candidates[quantity].add(None)
        if not matched_files:
            continue
        for source_file in matched_files:
            capability = _persisted_voltage_capabilities(source_file)
            roles = capability.get("voltage_roles")
            role = roles.get(column) if isinstance(roles, dict) else None
            if isinstance(role, str) and role in {
                "cell",
                "working_vs_reference",
                "counter_vs_reference",
            }:
                role_candidates[quantity].add(role)
            else:
                role_candidates[quantity].add(default_roles[quantity])
            reference = canonical_cycling.normalized_voltage_reference(
                capability.get("reference_electrode")
            )
            reference_candidates[quantity].add(reference)

    resolved_roles: dict[str, str] = {}
    for quantity, candidates in role_candidates.items():
        if not candidates:
            resolved_roles[quantity] = default_roles[quantity]
        elif len(candidates) == 1:
            resolved_roles[quantity] = next(iter(candidates))
        else:
            resolved_roles[quantity] = canonical_cycling.MIXED_VOLTAGE_ROLE
    resolved_references: dict[str, str | None] = {}
    for quantity, candidates in reference_candidates.items():
        if len(candidates) == 1:
            resolved_references[quantity] = next(iter(candidates))
        else:
            resolved_references[quantity] = None
    return resolved_roles, resolved_references


def _time_capacity_voltage_context(
    raw: pd.DataFrame,
    files: list[SourceFile],
) -> tuple[dict[str, str], dict[str, str | None]]:
    """Resolve truthful role/reference context for the selected raw channels.

    Availability is still data-driven from the stitched frame. Reference text
    is appended only when every source contributing finite values for a given
    auxiliary channel declares the same short, explicit reference. Mixed or
    missing source metadata therefore falls back to the generic ``vs ref``
    label instead of guessing from the experiment or filename.
    """

    files_by_hash = {source_file.hash: source_file for source_file in files}
    matched_files_by_quantity: dict[str, list[SourceFile]] = {}
    unknown_sources_by_quantity: set[str] = set()

    for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
        if column not in raw.columns:
            continue
        values = pd.to_numeric(raw[column], errors="coerce").to_numpy(dtype="float64")
        finite = np.isfinite(values)
        if not finite.any():
            continue

        matched_files: list[SourceFile] = []
        if "source_hash" in raw.columns:
            hashes = raw.loc[finite, "source_hash"].dropna().unique().tolist()
            matched_files_by_quantity[quantity] = [
                files_by_hash[value]
                for value in hashes
                if value in files_by_hash
            ]
            if (
                not matched_files_by_quantity[quantity]
                or len(matched_files_by_quantity[quantity]) != len(hashes)
            ):
                unknown_sources_by_quantity.add(quantity)
        elif len(files) == 1:
            matched_files_by_quantity[quantity] = list(files)
        else:
            unknown_sources_by_quantity.add(quantity)

    return _resolve_time_capacity_voltage_context(
        files,
        matched_files_by_quantity,
        unknown_sources_by_quantity=unknown_sources_by_quantity,
    )


PROTOCOL_SEGMENT_MODES = ("excluded", "only", "hidden")


def _protocol_filter_context(spec: dict) -> tuple[dict, list[dict]]:
    """Resolve configured segment IDs while treating stale IDs as inactive."""
    segments: dict[str, dict] = {}
    configured_segments = spec.get("protocol_segments") or []
    for segment in configured_segments if isinstance(configured_segments, list) else []:
        if isinstance(segment, dict) and segment.get("id") is not None:
            segments.setdefault(str(segment["id"]), segment)

    computation_filter = spec.get("computation", {}).get("protocol_filter") or {}
    configured = {
        "excluded": computation_filter.get("excluded_segment_ids", []),
        "only": computation_filter.get("only_segment_ids", []),
        "hidden": spec.get("presentation", {}).get("hidden_protocol_segment_ids", []),
    }
    selected: dict[str, list[dict]] = {mode: [] for mode in PROTOCOL_SEGMENT_MODES}
    badges: list[dict] = []
    selected_ids: set[str] = set()
    for mode, ids in configured.items():
        seen: set[str] = set()
        for value in ids if isinstance(ids, list) else []:
            segment_id = str(value)
            if segment_id in seen:
                continue
            seen.add(segment_id)
            segment = segments.get(segment_id)
            if segment is None:
                badges.append(
                    {
                        "kind": "protocol_segment_missing",
                        "segment_id": value,
                        "detail": f"Protocol segment {value!r} no longer exists and was ignored.",
                    }
                )
                continue
            selected[mode].append(segment)
            selected_ids.add(segment_id)
    return (
        {
            "selected": selected,
            "selected_ids": selected_ids,
            "matched_ids": set(),
            "badge_keys": set(),
            "active": any(selected.values()),
            "only_active": bool(selected["only"]),
        },
        badges,
    )


def _add_protocol_badge(
    context: dict,
    badges: list[dict],
    kind: str,
    detail: str,
    *,
    cell: Cell | None = None,
    source_file: SourceFile | None = None,
) -> None:
    key = (kind, cell.id if cell else None, source_file.hash if source_file else None, detail)
    if key in context["badge_keys"]:
        return
    context["badge_keys"].add(key)
    badge = {"kind": kind, "detail": detail}
    if cell is not None:
        badge.update({"cell_id": cell.id, "cell_name": cell.name})
    if source_file is not None:
        badge.update({"file": source_file.filename, "source_hash": source_file.hash})
    badges.append(badge)


def _target_step_indices(target: object) -> set[int]:
    if not isinstance(target, dict):
        return set()
    result: set[int] = set()
    values = target.get("step_indices") or []
    for value in values if isinstance(values, list) else []:
        if isinstance(value, bool):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if np.isfinite(number) and number.is_integer():
            result.add(int(number))
    return result


def _protocol_step_targets(
    files: list[SourceFile], context: dict, badges: list[dict], cell: Cell
) -> dict[int, dict[str, set[int]]]:
    by_segment: dict[int, dict[str, set[int]]] = {}
    if not context["active"]:
        return by_segment
    for segment_index, source_file in enumerate(files):
        reconstructed = protocol.reconstruct_protocol(
            source_file.header_meta,
            source_file.nominal_capacity_mah,
        )
        if not reconstructed.get("n_steps"):
            _add_protocol_badge(
                context,
                badges,
                "protocol_missing",
                "Protocol metadata is unavailable; active protocol-segment filters cannot be mapped for this file.",
                cell=cell,
                source_file=source_file,
            )
            continue
        modes = {mode: set() for mode in PROTOCOL_SEGMENT_MODES}
        for mode, selected_segments in context["selected"].items():
            for segment in selected_segments:
                segment_matches = False
                targets = segment.get("targets") or []
                for target in targets if isinstance(targets, list) else []:
                    if not isinstance(target, dict) or not protocol.protocol_signature_matches(
                        reconstructed, target.get("protocol_signature")
                    ):
                        continue
                    segment_matches = True
                    modes[mode].update(_target_step_indices(target))
                if segment_matches:
                    context["matched_ids"].add(str(segment["id"]))
        by_segment[segment_index] = modes
    return by_segment


def _append_unmatched_protocol_badges(context: dict, badges: list[dict]) -> None:
    for segment_id in sorted(context["selected_ids"] - context["matched_ids"]):
        _add_protocol_badge(
            context,
            badges,
            "protocol_segment_unmatched",
            "No selected source file has the protocol signature targeted by "
            f"segment {segment_id!r}.",
        )


def _protocol_cycle_sets(
    files: list[SourceFile],
    stitched_segments: list[dict],
    source_versions: dict[str, str],
    targets: dict[int, dict[str, set[int]]],
    context: dict,
    badges: list[dict],
    cell: Cell,
) -> dict[str, set[int]]:
    matched = {mode: set() for mode in PROTOCOL_SEGMENT_MODES}
    segment_by_index = {segment["segment"]: segment for segment in stitched_segments}
    for segment_index, source_file in enumerate(files):
        modes = targets.get(segment_index)
        if not modes or not any(modes.values()):
            continue
        parser_version = source_versions[source_file.hash]
        raw = cache.load_raw_columns(source_file.hash, parser_version, ["cycle", "step_index"])
        step_column = "step_index"
        if raw is None and cache.raw_path(source_file.hash, parser_version).exists():
            raw = cache.load_raw_columns(source_file.hash, parser_version, ["cycle", "Step_Index"])
            step_column = "Step_Index"
        if raw is None:
            cache_exists = cache.raw_path(source_file.hash, parser_version).exists()
            _add_protocol_badge(
                context,
                badges,
                "protocol_mapping_unavailable" if cache_exists else "protocol_mapping_cache_missing",
                (
                    "Raw cycle or step-index data is unavailable; protocol-segment cycle mapping could not be applied."
                    if cache_exists
                    else f"Raw cache at parser {parser_version} is unavailable; protocol-segment cycle mapping could not be applied."
                ),
                cell=cell,
                source_file=source_file,
            )
            continue
        stitched_segment = segment_by_index.get(segment_index)
        if stitched_segment is None:
            _add_protocol_badge(
                context,
                badges,
                "protocol_mapping_unavailable",
                "Raw cycle or step-index data is unavailable; protocol-segment cycle mapping could not be applied.",
                cell=cell,
                source_file=source_file,
            )
            continue
        cycles = pd.to_numeric(raw["cycle"], errors="coerce")
        steps = pd.to_numeric(raw[step_column], errors="coerce")
        if not cycles.notna().any():
            continue
        first_cycle = int(cycles.min())
        offset = int(stitched_segment["cycle_start"]) - first_cycle
        for mode, step_indices in modes.items():
            if not step_indices:
                continue
            local_cycles = cycles.loc[steps.isin(step_indices)].dropna().astype("int64").unique()
            matched[mode].update(int(cycle) + offset for cycle in local_cycles)
    return matched


def _protocol_row_mask(
    frame: pd.DataFrame, targets: dict[int, dict[str, set[int]]], mode: str
) -> np.ndarray:
    mask = np.zeros(len(frame), dtype=bool)
    step_column = "step_index" if "step_index" in frame.columns else "Step_Index" if "Step_Index" in frame.columns else None
    if step_column is None or "segment" not in frame.columns:
        return mask
    steps = pd.to_numeric(frame[step_column], errors="coerce")
    segments = pd.to_numeric(frame["segment"], errors="coerce")
    for segment_index, modes in targets.items():
        step_indices = modes.get(mode, set())
        if step_indices:
            mask |= (segments.eq(segment_index) & steps.isin(step_indices)).to_numpy()
    return mask


def _downsample_indices(
    length: int,
    max_points: int,
    visible: np.ndarray,
    series: list[np.ndarray] | None = None,
) -> np.ndarray:
    """Pixel-friendly min/max envelope sampling.

    Uniform strides erase narrow voltage/current excursions.  For every
    bucket we retain extrema from each supplied series, then fill any spare
    budget uniformly. Visibility transitions are always kept so filtered
    protocol regions remain disconnected.
    """
    if length <= max_points:
        return np.arange(length, dtype="int64")
    transitions = np.flatnonzero(visible[1:] != visible[:-1]) + 1
    mandatory = np.array([0, length - 1], dtype="int64")
    if len(transitions):
        mandatory = np.unique(
            np.concatenate((mandatory, np.maximum(0, transitions - 1), transitions))
        )
    usable_series = [
        np.asarray(values, dtype="float64")
        for values in (series or [])
        if len(values) == length and np.isfinite(values).any()
    ]
    if not usable_series:
        usable_series = [np.arange(length, dtype="float64")]

    remaining = max(1, max_points - len(mandatory))
    # Keep one neighbour on either side of an extremum. A lone retained
    # extremum is scientifically useful but renders as an isolated marker
    # when an adjacent source row is masked; the three-point micro-segment
    # preserves the local line shape without materially increasing the
    # display budget.
    points_per_bucket = max(2, len(usable_series) * 2) * 3
    bucket_count = max(1, remaining // points_per_bucket)
    edges = np.linspace(0, length, bucket_count + 1).astype("int64")
    selected: set[int] = set(int(value) for value in mandatory)
    for start, end in zip(edges[:-1], edges[1:]):
        if end <= start:
            continue
        for values in usable_series:
            local = values[start:end]
            finite = np.flatnonzero(np.isfinite(local))
            if len(finite) == 0:
                continue
            finite_values = local[finite]
            extrema = (
                int(start + finite[int(np.argmin(finite_values))]),
                int(start + finite[int(np.argmax(finite_values))]),
            )
            for point in extrema:
                selected.update(
                    range(max(0, point - 1), min(length, point + 2))
                )

    if len(selected) < max_points:
        fill = np.linspace(0, length - 1, max_points - len(selected) + 2).astype("int64")
        selected.update(int(value) for value in fill)
    return np.asarray(sorted(selected), dtype="int64")


def resolve_selection(db: Session, spec: dict) -> tuple[list[dict], list[dict]]:
    """Expand selection entries into per-cell units.

    Group membership resolves at compute time (groups are references);
    drift against provenance is reported as a badge by compute().
    Returns (units, missing_refs)."""
    units: list[dict] = []
    missing: list[dict] = []
    seen: set[tuple[str, int, int]] = set()
    for entry in spec.get("selection", {}).get("entries", []):
        kind, ref_id = entry.get("kind"), entry.get("ref_id")
        label_override = entry.get("label_override")
        if kind == "cell":
            cell = db.get(Cell, ref_id)
            if cell is None:
                missing.append({"kind": kind, "ref_id": ref_id})
                continue
            key = ("cell", ref_id, cell.id)
            if key in seen:
                continue
            seen.add(key)
            units.append(
                {"cell": cell, "group_id": None, "group_name": None,
                 "label": label_override or cell.name,
                 "entry_kind": kind, "entry_ref_id": ref_id}
            )
        elif kind == "replicate_group":
            group = db.get(ReplicateGroup, ref_id)
            if group is None:
                missing.append({"kind": kind, "ref_id": ref_id})
                continue
            for link in sorted(group.cell_links, key=lambda l: l.position):
                cell = db.get(Cell, link.cell_id)
                if cell is None:
                    continue
                key = ("replicate_group", ref_id, cell.id)
                if key in seen:
                    continue
                seen.add(key)
                units.append(
                    {"cell": cell, "group_id": group.id,
                     "group_name": label_override or group.name, "label": cell.name,
                     "entry_kind": kind, "entry_ref_id": ref_id}
                )
    return units, missing


def exclusion_for_unit(exclusions: list[dict], unit: dict) -> dict | None:
    """Return a matching visibility exclusion, including legacy cell-wide entries."""
    for exclusion in exclusions:
        if exclusion.get("cell_id") != unit["cell"].id:
            continue
        entry_kind = exclusion.get("entry_kind")
        entry_ref_id = exclusion.get("entry_ref_id")
        if entry_kind is not None and entry_kind != unit["entry_kind"]:
            continue
        if entry_ref_id is not None and entry_ref_id != unit["entry_ref_id"]:
            continue
        return exclusion
    return None


# ------------------------------------------------------ per-cell quantities


def _retention_reference(frame: pd.DataFrame, computation: dict) -> float:
    """Reference capacity for retention/SoH, from the UNfiltered record
    (cycle-range filters must not move the reference)."""
    ref_cfg = computation.get("retention_reference") or {}
    dchg = frame.get("discharge_capacity_mah")
    if dchg is None or frame.empty:
        return float("nan")
    if ref_cfg.get("mode") == "cycle" and ref_cfg.get("cycle"):
        at = frame.loc[frame["cycle"] == int(ref_cfg["cycle"]), "discharge_capacity_mah"]
        return float(at.iloc[0]) if len(at) else float("nan")
    n = int(ref_cfg.get("n") or 5)
    first_n = frame.nsmallest(n, "cycle")["discharge_capacity_mah"]
    return float(first_n.max()) if len(first_n) else float("nan")


POLARIZATION_METHOD_COLUMNS = {
    "mean": ("mean_charge_voltage_v", "mean_discharge_voltage_v"),
    "first_first": ("first_charge_voltage_v", "first_discharge_voltage_v"),
    "last_last": ("last_charge_voltage_v", "last_discharge_voltage_v"),
    "last_charge_first_discharge": ("last_charge_voltage_v", "first_discharge_voltage_v"),
    "first_charge_last_discharge": ("first_charge_voltage_v", "last_discharge_voltage_v"),
}


def _metadata_float(value: object) -> float | None:
    if value is None:
        return None
    match = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", str(value))
    if not match:
        return None
    try:
        number = float(match.group(0))
    except ValueError:
        return None
    return number if number > 0 else None


#: Every key the three scalar helpers below can read, so they can be fetched
#: for a whole selection in one query.
SCALAR_METADATA_KEYS = (
    "override.active_mass_mg", "active_material_mg", "active_mass_mg",
    "override.nominal_capacity_mah", "nominal_capacity_mah", "nominal_capacity",
    "override.electrode_area_cm2", "electrode_area_cm2",
)


def load_scalar_metadata(db: Session, cells: list[Cell]) -> dict[int, dict[str, str]]:
    """Fetch the scalar metadata keys for many cells in a single query.

    Pass the result to the ``cell_*`` helpers to avoid three small queries per
    cell. Returned explicitly rather than cached on the session so there is no
    chance of serving a stale value after an edit.
    """
    ids = {cell.id for cell in cells if cell.id is not None}
    if not ids:
        return {}
    rows = db.execute(
        select(CellMetadata.cell_id, CellMetadata.key, CellMetadata.value).where(
            CellMetadata.cell_id.in_(ids), CellMetadata.key.in_(SCALAR_METADATA_KEYS)
        )
    ).all()
    found: dict[int, dict[str, str]] = {cell_id: {} for cell_id in ids}
    for cell_id, key, value in rows:
        found[cell_id][key] = value
    return found


def _cell_metadata_values(cell: Cell, keys: tuple[str, ...]) -> dict[str, str]:
    """Read a few metadata values without materializing the whole collection.

    Cells accumulate thousands of metadata rows (one per source-file field;
    ~3,900 for the busiest cell here), but these lookups need at most three
    keys. Touching ``cell.metadata_entries`` instantiated every row as an ORM
    object on each analysis request — including pure cache hits, where it
    dominated the response time. ``(cell_id, key)`` is unique, so selecting the
    wanted keys is equivalent to building the full dict and indexing into it.
    """
    if "metadata_entries" not in sa_inspect(cell).unloaded:
        # Already in memory (another code path loaded it) — no query needed.
        return {e.key: e.value for e in cell.metadata_entries if e.key in keys}
    session = object_session(cell)
    if session is None:
        return {e.key: e.value for e in cell.metadata_entries if e.key in keys}
    rows = session.execute(
        select(CellMetadata.key, CellMetadata.value).where(
            CellMetadata.cell_id == cell.id, CellMetadata.key.in_(keys)
        )
    ).all()
    return dict(rows)


def cell_active_mass_mg(cell: Cell, metadata: dict[str, str] | None = None) -> float | None:
    keys = ("override.active_mass_mg", "active_material_mg", "active_mass_mg")
    if metadata is None:
        metadata = _cell_metadata_values(cell, keys)
    for key in keys:
        value = _metadata_float(metadata.get(key))
        if value is not None:
            return value
    source_values: list[float] = []
    for test in cell.tests:
        for link in test.file_links:
            value = _metadata_float(link.file.active_mass_mg)
            if value is not None:
                source_values.append(value)
    return source_values[0] if source_values else None


def cell_nominal_capacity_mah(cell: Cell, metadata: dict[str, str] | None = None) -> float | None:
    keys = ("override.nominal_capacity_mah", "nominal_capacity_mah", "nominal_capacity")
    if metadata is None:
        metadata = _cell_metadata_values(cell, keys)
    for key in keys:
        value = _metadata_float(metadata.get(key))
        if value is not None:
            return value
    source_values: list[float] = []
    for test in cell.tests:
        for link in test.file_links:
            value = _metadata_float(link.file.nominal_capacity_mah)
            if value is not None:
                source_values.append(value)
    return source_values[0] if source_values else None


def cell_electrode_area_cm2(cell: Cell, metadata: dict[str, str] | None = None) -> float | None:
    keys = ("override.electrode_area_cm2", "electrode_area_cm2")
    if metadata is None:
        metadata = _cell_metadata_values(cell, keys)
    for key in keys:
        value = _metadata_float(metadata.get(key))
        if value is not None:
            return value
    return None


def _polarization_values(frame: pd.DataFrame, computation: dict) -> tuple[np.ndarray, np.ndarray]:
    cfg = computation.get("polarization") or {}
    method = cfg.get("method") or "mean"
    charge_col, discharge_col = POLARIZATION_METHOD_COLUMNS.get(
        method, POLARIZATION_METHOD_COLUMNS["mean"]
    )
    charge = frame.get(charge_col)
    discharge = frame.get(discharge_col)
    if charge is None or discharge is None:
        empty = np.full(len(frame), np.nan)
        return empty, empty.copy()
    charge_v = charge.to_numpy(dtype="float64")
    discharge_v = discharge.to_numpy(dtype="float64")
    delta = charge_v - discharge_v
    denominator = discharge_v
    if cfg.get("direction") == "discharge_minus_charge":
        delta = -delta
        denominator = charge_v
    with np.errstate(divide="ignore", invalid="ignore"):
        pct = np.where(denominator != 0, delta / denominator * 100.0, np.nan)
    return delta, pct


def add_derived_columns(
    frame: pd.DataFrame, computation: dict, active_mass_mg: float | None = None
) -> tuple[pd.DataFrame, float]:
    """Add render-time derived columns; returns (frame, retention_ref)."""
    frame = frame.copy()
    ref = _retention_reference(frame, computation)

    mcv = frame.get("mean_charge_voltage_v")
    mdv = frame.get("mean_discharge_voltage_v")
    if mcv is not None and mdv is not None:
        with np.errstate(divide="ignore", invalid="ignore"):
            ve = np.where(mcv.to_numpy(dtype="float64") != 0,
                          mdv.to_numpy(dtype="float64") / mcv.to_numpy(dtype="float64") * 100.0,
                          np.nan)
    else:
        ve = np.full(len(frame), np.nan)
    frame["voltaic_efficiency_pct"] = ve
    polarization_v, polarization_pct = _polarization_values(frame, computation)
    frame["polarization_v"] = polarization_v
    frame["polarization_pct"] = polarization_pct

    dchg = frame.get("discharge_capacity_mah")
    if dchg is not None and ref and not np.isnan(ref):
        frame["capacity_retention_pct"] = dchg.to_numpy(dtype="float64") / ref * 100.0
    else:
        frame["capacity_retention_pct"] = np.nan

    for src, dst in (
        ("discharge_capacity_mah", "discharge_capacity_loss_mah"),
        ("charge_capacity_mah", "charge_capacity_loss_mah"),
    ):
        col = frame.get(src)
        # positive value = capacity lost versus the previous cycle
        frame[dst] = -col.diff().to_numpy(dtype="float64") if col is not None else np.nan
    active_mass_g = active_mass_mg / 1000.0 if active_mass_mg and active_mass_mg > 0 else None
    for src, dst in (
        ("discharge_capacity_mah", "discharge_capacity_mah_g"),
        ("charge_capacity_mah", "charge_capacity_mah_g"),
        ("discharge_energy_mwh", "discharge_energy_mwh_g"),
        ("charge_energy_mwh", "charge_energy_mwh_g"),
        ("discharge_capacity_loss_mah", "discharge_capacity_loss_mah_g_cycle"),
        ("charge_capacity_loss_mah", "charge_capacity_loss_mah_g_cycle"),
        ("cv_charge_capacity_mah", "cv_charge_capacity_mah_g"),
    ):
        col = frame.get(src)
        if active_mass_g and col is not None:
            frame[dst] = col.to_numpy(dtype="float64") / active_mass_g
        else:
            frame[dst] = np.nan
    return frame, ref


def apply_filters(frame: pd.DataFrame, computation: dict) -> pd.DataFrame:
    rng = computation.get("cycle_range") or {}
    if rng.get("start") is not None:
        frame = frame[frame["cycle"] >= int(rng["start"])]
    if rng.get("end") is not None:
        frame = frame[frame["cycle"] <= int(rng["end"])]
    every_n = int(computation.get("exclude_check_cycles_every_n") or 0)
    if every_n > 1:
        frame = frame[frame["cycle"] % every_n != 0]
    return frame


def time_capacity_settings(computation: dict) -> dict:
    cfg = computation.get("time_capacity") or {}
    current_options = {"current_ma", "current_density", "c_rate"}
    current_left = cfg.get("current_left") if cfg.get("current_left") in current_options else "current_ma"
    current_right = cfg.get("current_right") if cfg.get("current_right") in current_options | {"none"} else "none"
    voltage_channel = (
        cfg.get("voltage_channel")
        if cfg.get("voltage_channel") in canonical_cycling.VOLTAGE_QUANTITIES
        else canonical_cycling.DEFAULT_VOLTAGE_QUANTITY
    )
    return {
        "cycle_start": cfg.get("cycle_start", computation.get("cycle_range", {}).get("start", 1)),
        "cycle_end": cfg.get("cycle_end", computation.get("cycle_range", {}).get("end")),
        "cycles": [int(c) for c in cfg.get("cycles", []) if c is not None],
        "x_axis": cfg.get("x_axis") or "time",
        "time_unit": cfg.get("time_unit") or "min",
        "display_mode": cfg.get("display_mode") or "consecutive",
        "stacked": bool(cfg.get("stacked", False)),
        "current_left": current_left,
        "current_right": current_right,
        "electrode_area_cm2": _metadata_float(cfg.get("electrode_area_cm2")),
        "view": cfg.get("view") if cfg.get("view") in {"voltage_current", "dqdv", "dvdq"} else "voltage_current",
        "derivative_phase": cfg.get("derivative_phase") if cfg.get("derivative_phase") in {"both", "charge", "discharge"} else "both",
        "derivative_specific": bool(cfg.get("derivative_specific", False)),
        "derivative_absolute_discharge": bool(cfg.get("derivative_absolute_discharge", True)),
        "smoothing_window": max(1, min(101, int(cfg.get("smoothing_window") or 7))),
        "max_points_per_cell": int(cfg.get("max_points_per_cell") or 4000),
        # Spec 040.4: stable internal quantity ID selecting which canonical
        # voltage column populates the trace's "voltage_v" array — see
        # `canonical_cycling.VOLTAGE_QUANTITIES`. Derivative views (dQ/dV,
        # dV/dQ) intentionally ignore this and always read `voltage_v`
        # (`_derivative_curve` below); this setting only changes the
        # voltage/current plot.
        "voltage_channel": voltage_channel,
    }


def _jsonsafe(arr) -> list:
    out = []
    for v in np.asarray(arr, dtype="float64"):
        out.append(None if np.isnan(v) else float(v))
    return out


def _jsonsafe_plot(arr, digits: int | None) -> list:
    values = np.asarray(arr, dtype="float64")
    if digits is not None:
        values = np.round(values, digits)
    return [None if np.isnan(value) else float(value) for value in values]


def _jsonsafe_int(arr) -> list:
    out = []
    for v in np.asarray(arr, dtype="float64"):
        out.append(None if np.isnan(v) else int(v))
    return out


def _textsafe(series: pd.Series) -> list[str | None]:
    out: list[str | None] = []
    for v in series:
        out.append(None if pd.isna(v) else str(v))
    return out


def _phase_from_raw(frame: pd.DataFrame) -> list[str]:
    """Compatibility wrapper for the shared exact phase transform."""

    return time_capacity_derived.phase_from_raw(frame)


def _continuous_time(frame: pd.DataFrame) -> pd.DataFrame:
    """Make time_s monotonic across Neware step resets (vectorized).

    The raw Time column restarts at 0 at every step boundary (CC→CV, new
    cycle, file boundary). Plotted directly — especially in overlap mode,
    which offsets x per half-cycle — a CV hold re-drew from x=0 as a flat
    line at the cutoff voltage. Each drop adds the pre-drop value as a
    running offset, turning per-step time into cumulative elapsed time."""
    if "time_s" not in frame.columns or len(frame) < 2:
        return frame
    t = frame["time_s"].to_numpy(dtype="float64")
    d = np.diff(t)
    resets = np.flatnonzero(~np.isnan(d) & (d < 0))
    if len(resets) == 0:
        return frame
    offsets = np.zeros(len(t))
    offsets[resets + 1] = t[resets]
    return frame.assign(time_s=t + np.cumsum(offsets))


def _time_capacity_display_x(
    raw: pd.DataFrame,
    phases: list[str],
    capacity: np.ndarray | None,
    capacity_g: np.ndarray | None,
    capacity_area: np.ndarray | None,
    settings: dict,
    *,
    origin_cycle_start: int | None = None,
    origin_time_s: float | None = None,
) -> np.ndarray:
    if settings["x_axis"] == "capacity_mah_g":
        values = capacity_g.copy() if capacity_g is not None else np.full(len(raw), np.nan)
    elif settings["x_axis"] == "capacity_mah_cm2":
        values = capacity_area.copy() if capacity_area is not None else np.full(len(raw), np.nan)
    elif settings["x_axis"] == "capacity_mah":
        values = capacity.copy() if capacity is not None else np.full(len(raw), np.nan)
    else:
        factor = 3600.0 if settings["time_unit"] == "h" else 60.0 if settings["time_unit"] == "min" else 1.0
        values = (
            raw["time_s"].to_numpy(dtype="float64") / factor
            if "time_s" in raw.columns
            else np.full(len(raw), np.nan)
        )
    if settings["display_mode"] == "consecutive":
        if origin_time_s is not None:
            time_factor = (
                3600.0
                if settings["time_unit"] == "h"
                else 60.0
                if settings["time_unit"] == "min"
                else 1.0
            )
            return values - float(origin_time_s) / time_factor
        finite_mask = np.isfinite(values)
        if origin_cycle_start is not None and "cycle" in raw.columns:
            finite_mask &= raw["cycle"].to_numpy() >= int(origin_cycle_start)
        finite = np.flatnonzero(finite_mask)
        return values - values[finite[0]] if len(finite) else values

    cycles = raw["cycle"].to_numpy() if "cycle" in raw.columns else np.zeros(len(raw))
    phase_values = np.asarray(phases)
    output = np.full(len(values), np.nan)
    for cycle in np.unique(cycles):
        for phase in ("charge", "discharge"):
            indices = np.flatnonzero((cycles == cycle) & (phase_values == phase) & np.isfinite(values))
            if len(indices) == 0:
                continue
            reset = values[indices] - values[indices[0]]
            if settings["display_mode"] == "overlap_mirror" and phase == "discharge":
                reset = np.nanmax(reset) - reset
            output[indices] = reset
    return output


def time_capacity_display_budget(
    configured_max: int,
    viewport_width: int,
    visible_cell_count: int,
) -> int:
    """Return the deterministic interactive point budget for one Cell.

    The budget is display-only. Full-resolution and non-compact responses
    bypass it entirely. Keeping the rule here gives the serial and process
    implementations one shared production contract.
    """

    ceiling = max(100, int(configured_max))
    width = max(320, min(6000, int(viewport_width or 1200)))
    visible = max(1, int(visible_cell_count))
    candidate = int((2 * width * 6) // visible)
    return min(ceiling, max(800, candidate))


def _phase_capacity(frame: pd.DataFrame, phases: list[str]) -> np.ndarray:
    """Compatibility wrapper for the shared exact capacity transform."""

    return time_capacity_derived.phase_capacity(frame, phases)


def _record_transform_profile(
    diagnostics: dict[str, Any] | None,
    name: str,
    *,
    input_rows: int,
    output_rows: int,
    consumed_by: tuple[str, ...],
) -> None:
    """Record safe row/dependency facts for the opt-in 050.5 profiler."""

    if diagnostics is None:
        return
    diagnostics.setdefault("transform_profile", {})[name] = {
        "input_rows": int(input_rows),
        "output_rows": int(output_rows),
        "consumed_by": list(consumed_by),
    }


def _aligned_prepared_transform_values(
    raw: pd.DataFrame,
    prepared: pd.DataFrame,
    *,
    need_capacity: bool,
) -> tuple[list[str], np.ndarray | None] | None:
    """Validate prepared identity/order and return exact phase/capacity values."""

    identity_columns = (
        "source_hash",
        "segment",
        "source_cycle",
        "record_index",
        "cycle",
    )
    if len(raw) != len(prepared) or any(
        column not in raw.columns or column not in prepared.columns
        for column in identity_columns
    ):
        return None
    sort_columns = [
        column
        for column in ("cycle", "segment", "record_index")
        if column in raw.columns and column in prepared.columns
    ]
    if not sort_columns:
        return None
    left = raw.sort_values(sort_columns, kind="stable").reset_index(drop=True)
    right = prepared.sort_values(sort_columns, kind="stable").reset_index(drop=True)
    for column in identity_columns:
        left_values = left[column]
        right_values = right[column]
        if column in {"source_hash"}:
            if left_values.astype(str).tolist() != right_values.astype(str).tolist():
                return None
            continue
        left_numeric = pd.to_numeric(left_values, errors="coerce").to_numpy(dtype="float64")
        right_numeric = pd.to_numeric(right_values, errors="coerce").to_numpy(dtype="float64")
        if not np.array_equal(left_numeric, right_numeric, equal_nan=True):
            return None

    phases = time_capacity_derived.decode_phases(right["phase_code"].to_numpy())
    if phases is None:
        return None
    capacity: np.ndarray | None = None
    if need_capacity:
        if "phase_capacity_mah" not in right.columns:
            return None
        try:
            capacity = right["phase_capacity_mah"].to_numpy(dtype="float64")
        except (TypeError, ValueError):
            return None
    return phases, capacity


def _derivative_curve(
    frame: pd.DataFrame,
    phases: list[str],
    capacity_mah: np.ndarray,
    capacity_mah_g: np.ndarray,
    settings: dict,
    diagnostics: dict[str, Any] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Return x/y arrays for ICA (dQ/dV) or DVA (dV/dQ)."""
    n = len(frame)
    x_out = np.full(n, np.nan)
    y_out = np.full(n, np.nan)
    mode = settings.get("view")
    if mode not in {"dqdv", "dvdq"} or "voltage_v" not in frame.columns:
        return x_out, y_out
    capacity = capacity_mah_g if settings.get("derivative_specific") else capacity_mah
    voltage = frame["voltage_v"].to_numpy(dtype="float64")
    cycles = frame["cycle"].to_numpy() if "cycle" in frame.columns else np.zeros(n)
    segments = frame["segment"].to_numpy() if "segment" in frame.columns else np.zeros(n)
    phase_arr = np.asarray(phases)
    window = int(settings.get("smoothing_window") or 1)
    if window % 2 == 0:
        window += 1
    selected_phase = settings.get("derivative_phase") or "both"
    derivative_profile: dict[str, Any] | None = None
    if diagnostics is not None:
        derivative_profile = {
            "input_rows": n,
            "segments_processed": 0,
            "eligible_segments": 0,
            "finite_input_rows": 0,
            "output_finite_rows": 0,
            "output_segments": 0,
            "phase_rows": {"charge": 0, "discharge": 0, "rest": 0},
        }
        diagnostics["derivative_profile"] = derivative_profile

    if "status" in frame.columns:
        with time_capacity_path.timed_stage(diagnostics, "derivative_status_classification"):
            explicit_cv_only = calc.status_matches(frame["status"], "cv") & ~calc.status_matches(
                frame["status"], "cccv"
            )
    else:
        explicit_cv_only = np.zeros(n, dtype=bool)

    with time_capacity_path.timed_stage(diagnostics, "derivative_segment_scan"):
        if n:
            changed = (
                (cycles[1:] != cycles[:-1])
                | (segments[1:] != segments[:-1])
                | (phase_arr[1:] != phase_arr[:-1])
            )
            starts = np.concatenate((np.array([0], dtype=int), np.flatnonzero(changed) + 1))
            ends = np.concatenate((starts[1:], np.array([n], dtype=int)))
        else:
            starts = np.empty(0, dtype=int)
            ends = np.empty(0, dtype=int)

    for start, end in zip(starts.tolist(), ends.tolist()):
        phase = phase_arr[start]
        if derivative_profile is not None:
            derivative_profile["segments_processed"] += 1
            phase_rows = derivative_profile["phase_rows"]
            phase_rows[phase] = phase_rows.get(phase, 0) + end - start
        eligible = phase in {"charge", "discharge"} and (
            selected_phase == "both" or selected_phase == phase
        )
        if eligible:
            if derivative_profile is not None:
                derivative_profile["eligible_segments"] += 1
            with time_capacity_path.timed_stage(diagnostics, "derivative_segment_prepare"):
                q = capacity[start:end]
                v = voltage[start:end]
                finite = np.isfinite(q) & np.isfinite(v)
                finite_count = int(finite.sum())
            if finite_count >= 2:
                if derivative_profile is not None:
                    derivative_profile["finite_input_rows"] += finite_count
                min_periods = min(window, 3, finite_count)
                with time_capacity_path.timed_stage(diagnostics, "derivative_rolling"):
                    q_s = pd.Series(q).rolling(window, center=True, min_periods=min_periods).mean().to_numpy()
                    v_s = pd.Series(v).rolling(window, center=True, min_periods=min_periods).mean().to_numpy()
                with time_capacity_path.timed_stage(diagnostics, "derivative_gradient"):
                    dq = np.gradient(q_s)
                    dv = np.gradient(v_s)
                with time_capacity_path.timed_stage(diagnostics, "derivative_ratio_filter"):
                    with np.errstate(divide="ignore", invalid="ignore"):
                        derivative = np.divide(dq, dv) if mode == "dqdv" else np.divide(dv, dq)
                    denominator = dv if mode == "dqdv" else dq
                    derivative[np.abs(denominator) < 1e-10] = np.nan
                    derivative[~np.isfinite(derivative)] = np.nan
                with time_capacity_path.timed_stage(diagnostics, "derivative_postprocess"):
                    # Explicit CV-only steps have dV ~= 0 by design and therefore
                    # no finite ICA/DVA interpretation. Combined CCCV steps cannot
                    # be split from status alone, so reject values far beyond the
                    # local Q/V scale rather than allowing a near-zero denominator
                    # to dominate the plot axis.
                    derivative[explicit_cv_only[start:end]] = np.nan
                    q_finite = q_s[np.isfinite(q_s)]
                    v_finite = v_s[np.isfinite(v_s)]
                    if len(q_finite) >= 2 and len(v_finite) >= 2:
                        q_span = float(np.nanpercentile(q_finite, 95) - np.nanpercentile(q_finite, 5))
                        v_span = float(np.nanpercentile(v_finite, 95) - np.nanpercentile(v_finite, 5))
                        scale = q_span / max(v_span, 1e-9) if mode == "dqdv" else v_span / max(q_span, 1e-9)
                        if scale > 0 and np.isfinite(scale):
                            derivative[np.abs(derivative) > scale * 50.0] = np.nan
                    if phase == "discharge" and settings.get("derivative_absolute_discharge", True):
                        derivative = np.abs(derivative)
                    x_values = v_s if mode == "dqdv" else q_s
                    x_out[start:end] = x_values
                    y_out[start:end] = derivative
                    if derivative_profile is not None:
                        output_finite = int(np.isfinite(derivative).sum())
                        derivative_profile["output_finite_rows"] += output_finite
                        if output_finite:
                            derivative_profile["output_segments"] += 1
    return x_out, y_out


def _linfit_slope(x: np.ndarray, y: np.ndarray) -> float | None:
    ok = ~np.isnan(y)
    if ok.sum() < 3:
        return None
    slope = np.polyfit(x[ok], y[ok], 1)[0]
    return float(slope)


def cell_metrics(
    unfiltered: pd.DataFrame, filtered: pd.DataFrame, computation: dict, retention_ref: float
) -> dict:
    """Summary metrics for one cell.

    Windows: first-cycle CE and the retention reference come from the full
    record; means and fade fits use the filtered cycle range; steady-state
    means additionally skip the configured formation cycles."""
    m: dict[str, float | int | None] = {}
    if filtered.empty:
        return {"n_cycles": 0}

    x = filtered["cycle"].to_numpy(dtype="float64")
    formation = int(computation.get("formation_cycles") or 0)
    steady = filtered[filtered["cycle"] > formation]

    def fmean(frame: pd.DataFrame, col: str) -> float | None:
        vals = frame.get(col)
        if vals is None:
            return None
        v = float(vals.mean())
        return None if np.isnan(v) else v

    def fval(v) -> float | None:
        v = float(v)
        return None if np.isnan(v) else v

    m["n_cycles"] = int(len(filtered))
    m["max_discharge_capacity_mah"] = fval(filtered["discharge_capacity_mah"].max())
    m["mean_discharge_capacity_mah"] = fmean(filtered, "discharge_capacity_mah")

    first = unfiltered.nsmallest(1, "cycle")
    m["first_cycle_ce_pct"] = fval(first["coulombic_efficiency_pct"].iloc[0]) if len(first) else None
    m["mean_ce_pct"] = fmean(steady, "coulombic_efficiency_pct")
    m["mean_ee_pct"] = fmean(steady, "energy_efficiency_pct")
    m["mean_ve_pct"] = fmean(steady, "voltaic_efficiency_pct")

    last = filtered.nlargest(1, "cycle")
    m["last_cycle"] = int(last["cycle"].iloc[0])
    m["retention_last_pct"] = fval(last["capacity_retention_pct"].iloc[0])

    # fade rates: linear fit over the filtered range (loss reported positive)
    for col, key in (
        ("discharge_capacity_mah", "discharge_loss_mah_per_cycle"),
        ("charge_capacity_mah", "charge_loss_mah_per_cycle"),
    ):
        slope = _linfit_slope(x, filtered[col].to_numpy(dtype="float64"))
        m[key] = None if slope is None else -slope
    if m["discharge_loss_mah_per_cycle"] is not None and retention_ref and not np.isnan(retention_ref):
        m["discharge_loss_pct_per_cycle"] = m["discharge_loss_mah_per_cycle"] / retention_ref * 100.0
    else:
        m["discharge_loss_pct_per_cycle"] = None

    # cycles to 80% SoH — sustained: the first cycle after which retention
    # never recovers above 80% (transient dips from rate/check cycles don't
    # count). Only if actually reached, never extrapolated.
    ret = filtered["capacity_retention_pct"].to_numpy(dtype="float64")
    above = np.flatnonzero(~np.isnan(ret) & (ret >= 80.0))
    if len(above) == 0:
        valid = np.flatnonzero(~np.isnan(ret))
        m["cycles_to_80_pct"] = int(filtered["cycle"].iloc[valid[0]]) if len(valid) else None
    else:
        tail = ret[above[-1] + 1 :]
        crossing = np.flatnonzero(~np.isnan(tail) & (tail < 80.0))
        m["cycles_to_80_pct"] = (
            int(filtered["cycle"].iloc[above[-1] + 1 + crossing[0]]) if len(crossing) else None
        )

    # time metrics (NaN-safe: columns are all-NaN on pre-1.2.0 caches)
    dur = unfiltered.get("cycle_duration_h")
    m["total_duration_h"] = fval(dur.sum()) if dur is not None and dur.notna().any() else None
    m["mean_cycle_duration_h"] = fmean(steady, "cycle_duration_h")
    m["mean_charge_time_h"] = fmean(steady, "charge_time_h")
    m["mean_discharge_time_h"] = fmean(steady, "discharge_time_h")
    cv_reached = filtered.get("cv_reached")
    if cv_reached is not None:
        reached = cv_reached.fillna(0) > 0
        reached_frame = filtered.loc[reached]
        m["cv_reached_cycles"] = int(reached.sum())
        m["cv_reached_pct"] = float(reached.mean() * 100.0) if len(reached) else None
        events = filtered.get("cv_charge_event_count")
        m["cv_charge_event_count"] = int(events.fillna(0).sum()) if events is not None else int(reached.sum())
        m["mean_cv_charge_time_h"] = fmean(reached_frame, "cv_charge_time_h")
        m["median_cv_charge_time_h"] = (
            fval(reached_frame["cv_charge_time_h"].median()) if len(reached_frame) else None
        )
        m["mean_cv_charge_capacity_mah"] = fmean(reached_frame, "cv_charge_capacity_mah")
        m["median_cv_charge_capacity_mah"] = (
            fval(reached_frame["cv_charge_capacity_mah"].median()) if len(reached_frame) else None
        )
        m["mean_cv_charge_fraction_pct"] = fmean(reached_frame, "cv_charge_fraction_pct")
    return m


def aggregate_metrics(rows: list[dict]) -> dict:
    """mean ± SD across member cells for every numeric metric."""
    out: dict[str, dict | int] = {"n_members": len(rows)}
    keys = {k for r in rows for k in r if isinstance(r.get(k), (int, float))}
    for k in sorted(keys):
        vals = np.array([r[k] for r in rows if isinstance(r.get(k), (int, float))], dtype="float64")
        if len(vals) == 0:
            continue
        out[k] = {
            "mean": float(np.mean(vals)),
            "sd": float(np.std(vals, ddof=1)) if len(vals) > 1 else None,
            "n": int(len(vals)),
        }
    return out


# ------------------------------------------------------------ aggregation


DISPERSIONS = ("std", "sem", "minmax", "percentile")


def aggregate_series(members: list[dict], quantity_cols: list[str], aggregation: dict) -> dict:
    """Replicate mean ± band per cycle index for every quantity, over member
    cells minus exclusions. n(cycle) is tracked per quantity; the band is
    only emitted where n >= min_n_for_band. A rendering — never stored."""
    dispersion = aggregation.get("dispersion") or "std"
    min_n = int(aggregation.get("min_n_for_band") or 2)

    frames = [
        pd.DataFrame({"cycle": m["x"], **{f"{c}__{i}": m["quantities"][c] for c in quantity_cols}})
        .set_index("cycle")
        for i, m in enumerate(members)
    ]
    wide = pd.concat(frames, axis=1).sort_index()
    x = [int(c) for c in wide.index]

    result: dict[str, dict] = {}
    n_overall = np.zeros(len(wide), dtype="int64")
    for col in quantity_cols:
        vals = wide[[f"{col}__{i}" for i in range(len(members))]].to_numpy(dtype="float64")
        n = (~np.isnan(vals)).sum(axis=1)
        n_overall = np.maximum(n_overall, n)
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(vals, axis=1)
            if dispersion == "sem":
                sd = np.nanstd(vals, axis=1, ddof=1)
                half = sd / np.sqrt(np.maximum(n, 1))
                lo, hi = mean - half, mean + half
            elif dispersion == "minmax":
                lo, hi = np.nanmin(vals, axis=1), np.nanmax(vals, axis=1)
            elif dispersion == "percentile":
                lo, hi = np.nanpercentile(vals, 10, axis=1), np.nanpercentile(vals, 90, axis=1)
            else:
                sd = np.nanstd(vals, axis=1, ddof=1)
                lo, hi = mean - sd, mean + sd
        band_ok = n >= min_n
        result[col] = {
            "mean": _jsonsafe(mean),
            "band_low": _jsonsafe(np.where(band_ok, lo, np.nan)),
            "band_high": _jsonsafe(np.where(band_ok, hi, np.nan)),
            "n": [int(v) for v in n],
        }
    return {"x": x, "quantities": result, "max_n": int(n_overall.max()) if len(n_overall) else 0,
            "dispersion": dispersion, "min_n_for_band": min_n}


# ------------------------------------------------------------- computation


def refresh_availability_badges(db: Session, spec: dict, result: dict) -> None:
    """Replace source-availability badges on a cached result with fresh ones.

    Availability is deliberately not part of the cache key (transient
    offline/changed flips do not change the Parquet the numbers came from),
    so a cached result may carry badges from another availability state.
    This rebuilds the two availability badge kinds from the database status
    fields only — no disk probing on the hot path; the source-check jobs and
    fresh computes keep ``location_status`` current.
    """
    availability_kinds = {"source_offline", "source_changed"}
    kept = [
        badge
        for badge in (result.get("badges") or [])
        if badge.get("kind") not in availability_kinds
    ]
    result["badges"] = kept + availability_badges(db, spec)


AVAILABILITY_BADGE_KINDS = {"source_offline", "source_changed"}


def availability_badges(db: Session, spec: dict) -> list[dict]:
    """Build source-availability badges from current database status.

    Split out from :func:`refresh_availability_badges` so a cached response can
    be served without parsing its payload: the badges are the only part of a
    cached result that must not be reused as stored.
    """
    fresh: list[dict] = []
    units, _missing = resolve_selection(db, spec)
    preload_cell_sources(db, [unit["cell"] for unit in units])
    for unit in units:
        cell = unit["cell"]
        _hashes, files = cell_ordered_hashes(db, cell)
        for f in files:
            if f.location_status == "offline":
                fresh.append(
                    {"kind": "source_offline", "cell_id": cell.id, "cell_name": cell.name,
                     "file": f.filename,
                     "detail": "Source file not found at its last known location. Rendering "
                     "from cache; re-import or update from source to relink."})
            elif f.location_status == "changed":
                fresh.append(
                    {"kind": "source_changed", "cell_id": cell.id, "cell_name": cell.name,
                     "file": f.filename,
                     "detail": "Source data changed since computed. Showing cached result — "
                     "recompute explicitly to update."})
    return fresh


def compute(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    progress: ProgressCallback | None = None,
) -> dict:
    ensure_canonical_cycling_available(db, spec)
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        calc_version = provenance.get("calc_version") or calc_version

    computation = spec.get("computation", {})
    aggregation = spec.get("aggregation", {})
    selection = spec.get("selection", {})
    exclusions = selection.get("exclusions", [])
    hidden_group_ids = set(selection.get("hidden_replicate_group_ids", []))
    units, missing_refs = resolve_selection(db, spec)
    protocol_context, protocol_badges = _protocol_filter_context(spec)

    quantity_cols = [col for col, _ in ALL_QUANTITIES.values()]
    cell_series: list[dict] = []
    sources: list[dict] = []
    badges: list[dict] = list(protocol_badges)
    all_pinned_versions: list[str] = []
    all_current_versions: list[str] = []

    from . import scanner  # local import to avoid a module cycle

    calc_at_current = calc_version == CALC_VERSION

    total_units = len(units)
    for unit_index, unit in enumerate(units, start=1):
        cell: Cell = unit["cell"]
        if progress:
            progress(unit_index - 1, total_units, cell.name, "Reading cached cycle data")
        hashes, files = cell_ordered_hashes(db, cell)
        source_versions = resolve_source_parser_versions(
            files, provenance, cell.id, use_current_versions
        )
        refs = [stitch.CachedSourceRef(f.hash, source_versions[f.hash]) for f in files]
        all_pinned_versions.extend(source_versions[f.hash] for f in files)
        all_current_versions.extend(current_parser_identity(f) for f in files)
        # stale/newer-parser detection compares source-by-source (Spec
        # 040.3): a newer adapter revision for ONE format must not report as
        # "newer available" for a cell whose sources are a different format
        # already at their own current identity.
        for f in files:
            current_identity = current_parser_identity(f)
            if source_versions[f.hash] != current_identity:
                badges.append(
                    {
                        "kind": "newer_parser",
                        "cell_id": cell.id,
                        "cell_name": cell.name,
                        "file": f.filename,
                        "detail": (
                            f"{f.filename} computed with parser {source_versions[f.hash]}; "
                            f"{current_identity} available — recompute?"
                        ),
                    }
                )
        # caches are regenerable from source at any time — but only for a
        # source whose pinned identity IS its current identity; a render
        # pinned to an older identity uses whatever cache exists at that
        # identity and never reparses the current source under it (Spec
        # 040.3: pinned historical caches must not be silently relabeled).
        reparsed = False
        if calc_at_current:
            for f, ref in zip(files, refs):
                if (
                    ref.parser_version == current_parser_identity(f)
                    and not cache.has_cycles(f.hash, ref.parser_version, calc_version)
                    and not cache.raw_path(f.hash, ref.parser_version).exists()
                    and Path(f.path).exists()
                ):
                    scanner.parse_file(db, f)
                    reparsed = True

        stitched, segments, missing = stitch.stitch_cycles(refs, calc_version)
        descriptors = source_descriptors(files, segments, missing, stitched)
        complete = stitch.stitch_metadata(stitched)["complete"]
        if complete:
            step_targets = _protocol_step_targets(files, protocol_context, badges, cell)
            protocol_cycles = _protocol_cycle_sets(
                files,
                segments,
                source_versions,
                step_targets,
                protocol_context,
                badges,
                cell,
            )
        else:
            protocol_cycles = {"only": set(), "excluded": set(), "hidden": set()}
            badges.append(
                {
                    "kind": "continuation_source_missing",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "missing_source_hashes": missing,
                    "missing_source_positions": stitch.stitch_metadata(stitched)[
                        "missing_positions"
                    ],
                    "detail": (
                        "The ordered Cell source chain is incomplete; the scientific series "
                        "was withheld until every source cache is available."
                    ),
                }
            )

        for f in files:
            if not Path(f.path).exists():
                if f.location_status != "offline":
                    f.location_status = "offline"
                    db.commit()
                badges.append(
                    {"kind": "source_offline", "cell_id": cell.id, "cell_name": cell.name,
                     "file": f.filename,
                     "detail": "Source file not found at its last known location. Rendering "
                     "from cache; re-import or update from source to relink."})
            elif f.location_status == "changed":
                badges.append(
                    {"kind": "source_changed", "cell_id": cell.id, "cell_name": cell.name,
                     "file": f.filename,
                     "detail": "Source data changed since computed. Showing cached result — "
                     "recompute explicitly to update."})
        for h in missing:
            missing_identity = source_versions.get(h, "unknown")
            badges.append(
                {"kind": "cache_missing", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": f"No cache at parser {missing_identity} / calc {calc_version} for "
                 f"file {h[:12]}…; recompute to regenerate."})
        if cell.archived:
            badges.append(
                {"kind": "cell_archived", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": "Cell is archived (soft-deleted); still rendering from cache."})

        exclusion = exclusion_for_unit(exclusions, unit)
        group_hidden = unit["group_id"] in hidden_group_ids
        excluded = exclusion is not None or group_hidden
        active_mass_mg = cell_active_mass_mg(cell)
        if stitched.empty or not complete:
            x: list[int] = []
            quantities = {c: [] for c in quantity_cols}
            metrics = {"n_cycles": 0}
            ref = None
            source_values = {key: [] for key in ("source_cycle", "source_position", "source_filename", "source_hash")}
        else:
            metric_frame = stitched
            if protocol_context["only_active"]:
                metric_frame = metric_frame[metric_frame["cycle"].isin(protocol_cycles["only"])]
            if protocol_cycles["excluded"]:
                metric_frame = metric_frame[~metric_frame["cycle"].isin(protocol_cycles["excluded"])]
            derived, ref_val = add_derived_columns(metric_frame, computation, active_mass_mg)
            metric_filtered = apply_filters(derived, computation).sort_values("cycle")
            plot_filtered = metric_filtered
            if protocol_cycles["hidden"]:
                plot_filtered = plot_filtered[
                    ~plot_filtered["cycle"].isin(protocol_cycles["hidden"])
                ]
            x = [int(v) for v in plot_filtered["cycle"]]
            quantities = {
                c: _jsonsafe(plot_filtered[c].to_numpy(dtype="float64")) if c in plot_filtered.columns
                else [None] * len(x)
                for c in quantity_cols
            }
            metrics = cell_metrics(derived, metric_filtered, computation, ref_val)
            ref = None if np.isnan(ref_val) else float(ref_val)
            source_values = source_columns(plot_filtered, files)

        cell_series.append(
            {"cell_id": cell.id, "cell_name": cell.name, "label": unit["label"],
             "group_id": unit["group_id"], "group_name": unit["group_name"],
             "excluded": excluded,
             "exclusion_reason": "Replicate hidden" if group_hidden else (exclusion or {}).get("reason"),
             "archived": cell.archived, "x": x, "quantities": quantities,
             "metrics": metrics, "retention_reference_mah": ref,
             "active_mass_mg": active_mass_mg,
             "segments": segments, "source_descriptors": descriptors,
             **source_values})
        sources.append(
            {
                "cell_id": cell.id,
                "file_hashes": hashes,
                "source_descriptors": descriptors,
                "files": source_file_entries(files, source_versions),
            }
        )
        if progress:
            progress(
                unit_index,
                total_units,
                cell.name,
                "Re-parsed from source" if reparsed else "Read from cache",
            )

    _append_unmatched_protocol_badges(protocol_context, badges)

    for miss in missing_refs:
        badges.append({"kind": "missing_reference",
                       "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists."})

    # version badges — reactive information, never silent mutation. Per-source
    # newer_parser badges are appended inside the per-unit loop above; only
    # calc_version stays a single scalar (it applies uniformly to the whole
    # scientific computation, not per contributing source).
    if calc_version != CALC_VERSION:
        badges.append({"kind": "newer_calc",
                       "detail": f"Computed with calc {calc_version}; {CALC_VERSION} available — recompute?"})

    # membership drift vs provenance (badge only)
    if provenance and provenance.get("sources") is not None:
        prev = {s["cell_id"] for s in provenance["sources"]}
        cur = {s["cell_id"] for s in sources}
        added, removed = sorted(cur - prev), sorted(prev - cur)
        prev_hashes = {h for s in provenance["sources"] for h in s.get("file_hashes", [])}
        cur_hashes = {h for s in sources for h in s.get("file_hashes", [])}
        if added or removed:
            badges.append({"kind": "selection_drift",
                           "detail": f"Referenced groups resolve differently than when last saved "
                           f"(+{len(added)} cell(s), −{len(removed)}). Save to accept.",
                           "added_cell_ids": added, "removed_cell_ids": removed})
        elif prev_hashes != cur_hashes:
            badges.append({"kind": "new_data",
                           "detail": "New source files are attached to selected cells since last computed."})

    # replicate aggregation (rendering only)
    aggregates: list[dict] = []
    if (aggregation.get("mode") or "replicate_mean") == "replicate_mean":
        by_group: dict[int, list[dict]] = {}
        group_names: dict[int, str] = {}
        for s in cell_series:
            if s["group_id"] is not None and not s["excluded"] and len(s["x"]):
                by_group.setdefault(s["group_id"], []).append(s)
                group_names[s["group_id"]] = s["group_name"]
        for gid, members in by_group.items():
            agg = aggregate_series(members, quantity_cols, aggregation)
            agg["group_id"] = gid
            agg["group_name"] = group_names[gid]
            aggregates.append(agg)

    # group metric rows
    group_metrics: list[dict] = []
    seen_groups: list[int] = []
    for s in cell_series:
        if s["group_id"] is not None and s["group_id"] not in seen_groups:
            seen_groups.append(s["group_id"])
    for gid in seen_groups:
        members = [s for s in cell_series if s["group_id"] == gid and not s["excluded"] and s["metrics"].get("n_cycles")]
        if members:
            group_metrics.append(
                {"group_id": gid, "group_name": members[0]["group_name"],
                 "metrics": aggregate_metrics([m["metrics"] for m in members])})

    return {
        "computed_at": now_iso(),
        "type": spec.get("type", "cycling"),
        "parser_version": display_parser_version(all_pinned_versions),
        "calc_version": calc_version,
        "current_parser_version": display_parser_version(all_current_versions),
        "current_calc_version": CALC_VERSION,
        "quantities": [
            {"key": key, "column": col, "label": label}
            for key, (col, label) in SELECTABLE_QUANTITIES.items()
        ],
        "cell_series": cell_series,
        "aggregates": aggregates,
        "group_metrics": group_metrics,
        "badges": badges,
        "sources": sources,
    }


def _step_segments(spec: dict) -> dict[str, dict]:
    return {
        str(segment["id"]): segment
        for segment in (spec.get("protocol_segments") or [])
        if isinstance(segment, dict) and segment.get("id") is not None
    }


def _step_series_config(spec: dict, cells: dict[int, Cell]) -> list[dict]:
    """Normalize explicit step series, including the legacy single-segment form."""
    steps_cfg = (spec.get("computation", {}) or {}).get("steps", {}) or {}
    configured = steps_cfg.get("series")
    legacy_segment_id = steps_cfg.get("segment_id")
    if isinstance(configured, list) and (configured or not legacy_segment_id):
        series: list[dict] = []
        seen_ids: set[str] = set()
        for index, item in enumerate(configured):
            if not isinstance(item, dict):
                continue
            try:
                cell_id = int(item.get("cell_id"))
            except (TypeError, ValueError):
                continue
            segment_id = str(item.get("segment_id") or "")
            series_id = str(item.get("id") or f"steps-{cell_id}-{segment_id}-{index}")
            if cell_id not in cells or not segment_id or series_id in seen_ids:
                continue
            seen_ids.add(series_id)
            series.append(
                {"id": series_id, "cell_id": cell_id, "segment_id": segment_id}
            )
        return series

    # Analyses saved before the series-builder redesign selected one segment
    # globally. Preserve that view by expanding it to every unique selected cell.
    if not legacy_segment_id:
        return []
    return [
        {
            "id": f"legacy-{cell_id}-{legacy_segment_id}",
            "cell_id": cell_id,
            "segment_id": str(legacy_segment_id),
        }
        for cell_id in sorted(cells)
    ]


def compute_steps(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    progress: ProgressCallback | None = None,
) -> dict:
    """One point per execution of a chosen step block, rather than per cycle.

    A protocol segment defines the steps; each occurrence of that block becomes
    a point, so a sub-cycle quantity — CV time inside fast charge — can be
    plotted in isolation, which the cycle path cannot do. See
    ``services/step_blocks.py`` for the block definitions.
    """
    ensure_canonical_cycling_available(db, spec)
    from . import protocol as protocol_service
    from . import step_blocks

    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        calc_version = provenance.get("calc_version") or calc_version
    all_pinned_versions: list[str] = []
    all_current_versions: list[str] = []

    steps_cfg = (spec.get("computation", {}) or {}).get("steps", {}) or {}
    mode = (
        steps_cfg.get("mode")
        if steps_cfg.get("mode") in step_blocks.BLOCK_MODES
        else "union"
    )
    units, missing_refs = resolve_selection(db, spec)
    cell_by_id = {unit["cell"].id: unit["cell"] for unit in units}
    preload_cell_sources(db, list(cell_by_id.values()))
    configured_series = _step_series_config(spec, cell_by_id)
    segments = _step_segments(spec)
    quantity_cols = [
        column
        for column in step_blocks.BLOCK_COLUMNS
        if column
        not in {
            "block",
            "occurrence",
            "cycle_start",
            "cycle_end",
            "step_start",
            "step_end",
            "n_steps",
        }
    ]

    cell_series: list[dict] = []
    sources_by_cell: dict[int, dict] = {}
    badges: list[dict] = []
    if not configured_series:
        badges.append(
            {
                "kind": "steps_no_series",
                "detail": "Add a cell and protocol segment to define a step series.",
            }
        )

    total_units = len(configured_series)
    for unit_index, series_cfg in enumerate(configured_series, start=1):
        cell = cell_by_id[series_cfg["cell_id"]]
        segment_id = series_cfg["segment_id"]
        segment = segments.get(segment_id)
        segment_name = (
            str(segment.get("name") or segment_id) if segment else segment_id
        )
        if progress:
            progress(unit_index - 1, total_units, cell.name, "Reading step data")
        hashes, files = cell_ordered_hashes(db, cell)
        source_versions = resolve_source_parser_versions(
            files, provenance, cell.id, use_current_versions
        )
        refs = [stitch.CachedSourceRef(f.hash, source_versions[f.hash]) for f in files]
        all_pinned_versions.extend(source_versions[f.hash] for f in files)
        all_current_versions.extend(current_parser_identity(f) for f in files)
        nominal = cell_nominal_capacity_mah(cell)
        targets = {
            str(target.get("protocol_signature")): {
                int(step) for step in (target.get("step_indices") or [])
            }
            for target in ((segment or {}).get("targets") or [])
            if target.get("protocol_signature")
        }

        x_occurrence: list[int] = []
        x_cycle: list[int | None] = []
        x_time: list[float | None] = []
        quantities: dict[str, list] = {c: [] for c in quantity_cols}
        block_meta: list[dict] = []
        raw, _raw_segments, _missing = stitch.stitch_raw(refs)
        block_frames: list[pd.DataFrame] = []
        if segment and not raw.empty:
            raw_timestamps = (
                pd.to_datetime(raw["timestamp"], errors="coerce").dropna()
                if "timestamp" in raw.columns
                else pd.Series(dtype="datetime64[ns]")
            )
            raw_start = raw_timestamps.min() if len(raw_timestamps) else None
            for source_index, source_file in enumerate(files):
                reconstructed = protocol_service.reconstruct_protocol(
                    source_file.header_meta, nominal
                )
                selected = protocol_service.protocol_steps_for_protocol(
                    targets, reconstructed
                )
                if not selected:
                    continue
                source_raw = raw.loc[raw["segment"] == source_index].copy()
                if source_raw.empty:
                    continue
                source_raw = source_raw.reset_index(drop=True)
                source_raw["record_index"] = np.arange(len(source_raw))
                source_blocks = step_blocks.per_block(
                    source_raw,
                    selected,
                    mode,
                    origin_timestamp=raw_start,
                )
                if not source_blocks.empty:
                    block_frames.append(source_blocks)

        if block_frames:
            blocks_df = pd.concat(block_frames, ignore_index=True)
            blocks_df["block"] = np.arange(1, len(blocks_df) + 1)
            blocks_df["occurrence"] = np.arange(1, len(blocks_df) + 1)
            x_occurrence = list(range(1, len(blocks_df) + 1))
            x_cycle = [
                int(value) if pd.notna(value) else None
                for value in blocks_df["cycle_start"]
            ]
            x_time = _jsonsafe(blocks_df["start_time_h"].to_numpy(dtype="float64"))
            quantities = {
                column: _jsonsafe(blocks_df[column].to_numpy(dtype="float64"))
                if column in blocks_df.columns
                else [None] * len(blocks_df)
                for column in quantity_cols
            }
            block_meta = blocks_df[
                [
                    "block",
                    "occurrence",
                    "cycle_start",
                    "cycle_end",
                    "step_start",
                    "step_end",
                ]
            ].to_dict("records")
        else:
            badges.append(
                {
                    "kind": "steps_no_match",
                    "series_id": series_cfg["id"],
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "segment_id": segment_id,
                    "segment_name": segment_name,
                    "detail": (
                        f"{cell.name} has no source matching the protocol targets "
                        f"for {segment_name}."
                    ),
                }
            )

        cell_series.append(
            {
                "series_id": series_cfg["id"],
                "cell_id": cell.id,
                "cell_name": cell.name,
                "segment_id": segment_id,
                "segment_name": segment_name,
                "label": f"{cell.name} \u2014 {segment_name}",
                "x_occurrence": x_occurrence,
                "x_cycle": x_cycle,
                "x_time": x_time,
                "quantities": quantities,
                "n_blocks": len(x_occurrence),
                "block_meta": block_meta,
            }
        )
        sources_by_cell.setdefault(
            cell.id,
            {
                "cell_id": cell.id,
                "file_hashes": hashes,
                "files": source_file_entries(files, source_versions),
            },
        )
        if progress:
            progress(unit_index, total_units, cell.name, "Grouped step blocks")

    for miss in missing_refs:
        badges.append(
            {
                "kind": "missing_reference",
                "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists.",
            }
        )

    return {
        "computed_at": now_iso(),
        "type": "steps",
        "parser_version": display_parser_version(all_pinned_versions),
        "calc_version": calc_version,
        "current_parser_version": display_parser_version(all_current_versions),
        "current_calc_version": CALC_VERSION,
        "steps": {"series": configured_series, "mode": mode},
        "cell_series": cell_series,
        "badges": badges,
        "sources": list(sources_by_cell.values()),
    }


def _dcir_segments(spec: dict) -> dict[str, dict]:
    return {
        str(segment["id"]): segment
        for segment in (spec.get("dcir_segments") or [])
        if isinstance(segment, dict) and segment.get("id") is not None
    }


def _dcir_series_config(spec: dict, cells: dict[int, Cell]) -> list[dict]:
    configured = (
        ((spec.get("computation") or {}).get("dcir") or {}).get("series") or []
    )
    series: list[dict] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(configured if isinstance(configured, list) else []):
        if not isinstance(item, dict):
            continue
        try:
            cell_id = int(item.get("cell_id"))
        except (TypeError, ValueError):
            continue
        segment_id = str(item.get("segment_id") or "")
        series_id = str(item.get("id") or f"dcir-{cell_id}-{segment_id}-{index}")
        if cell_id not in cells or not segment_id or series_id in seen_ids:
            continue
        seen_ids.add(series_id)
        series.append({"id": series_id, "cell_id": cell_id, "segment_id": segment_id})
    return series


def compute_dcir(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    progress: ProgressCallback | None = None,
) -> dict:
    """Compute one DCIR line for every explicit (cell, DCIR segment) pair."""
    ensure_canonical_cycling_available(db, spec)
    from . import dcir
    from . import protocol as protocol_service

    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        calc_version = provenance.get("calc_version") or calc_version
    all_pinned_versions: list[str] = []
    all_current_versions: list[str] = []

    units, missing_refs = resolve_selection(db, spec)
    cell_by_id = {unit["cell"].id: unit["cell"] for unit in units}
    preload_cell_sources(db, list(cell_by_id.values()))
    configured_series = _dcir_series_config(spec, cell_by_id)
    segments = _dcir_segments(spec)
    badges: list[dict] = []
    cell_series: list[dict] = []
    sources_by_cell: dict[int, dict] = {}
    if not configured_series:
        badges.append(
            {
                "kind": "dcir_no_series",
                "detail": "Add a cell and DCIR segment to define a resistance series.",
            }
        )

    for series_index, series_cfg in enumerate(configured_series, start=1):
        cell = cell_by_id[series_cfg["cell_id"]]
        segment = segments.get(series_cfg["segment_id"])
        segment_name = str(
            (segment or {}).get("name") or series_cfg["segment_id"]
        )
        if progress:
            progress(
                series_index - 1,
                len(configured_series),
                cell.name,
                "Reading DCIR pulse data",
            )
        hashes, files = cell_ordered_hashes(db, cell)
        source_versions = resolve_source_parser_versions(
            files, provenance, cell.id, use_current_versions
        )
        refs = [stitch.CachedSourceRef(f.hash, source_versions[f.hash]) for f in files]
        all_pinned_versions.extend(source_versions[f.hash] for f in files)
        all_current_versions.extend(current_parser_identity(f) for f in files)
        nominal = cell_nominal_capacity_mah(cell)
        targets = {
            str(target.get("protocol_signature")): target
            for target in ((segment or {}).get("targets") or [])
            if isinstance(target, dict) and target.get("protocol_signature")
        }
        raw, _raw_segments, _missing = stitch.stitch_raw(refs)
        raw_timestamps = (
            pd.to_datetime(raw["timestamp"], errors="coerce").dropna()
            if not raw.empty and "timestamp" in raw.columns
            else pd.Series(dtype="datetime64[ns]")
        )
        raw_start = raw_timestamps.min() if len(raw_timestamps) else None
        occurrence_frames: list[pd.DataFrame] = []
        matched_target: dict | None = None
        for source_index, source_file in enumerate(files):
            reconstructed = protocol_service.reconstruct_protocol(
                source_file.header_meta, nominal
            )
            target = protocol_service.protocol_target_for_protocol(targets, reconstructed)
            if not target or raw.empty:
                continue
            try:
                rest_step = int(target.get("rest_step_index"))
                pulse_step = int(target.get("pulse_step_index"))
            except (TypeError, ValueError):
                continue
            direction = str(target.get("direction") or "")
            if direction not in {"charge", "discharge"}:
                continue
            source_raw = raw.loc[raw["segment"] == source_index].copy()
            occurrences = dcir.per_occurrence(
                source_raw,
                rest_step_index=rest_step,
                pulse_step_index=pulse_step,
                direction=direction,
                nominal_capacity_mah=nominal,
                origin_timestamp=raw_start,
            )
            if not occurrences.empty:
                occurrence_frames.append(occurrences)
                matched_target = target

        if occurrence_frames:
            occurrences = pd.concat(occurrence_frames, ignore_index=True)
            occurrences["occurrence"] = np.arange(1, len(occurrences) + 1)
            absolute = occurrences["dcir_mohm"].to_numpy(dtype="float64")
            relative = np.full(len(absolute), np.nan, dtype="float64")
            finite = np.flatnonzero(np.isfinite(absolute))
            if len(finite) and abs(absolute[finite[0]]) > 1e-12:
                reference = absolute[finite[0]]
                relative = 100.0 * (absolute - reference) / reference
            x_occurrence = list(range(1, len(occurrences) + 1))
            x_cycle = _jsonsafe_int(occurrences["cycle"])
            x_time = _jsonsafe(occurrences["start_time_h"])
            dcir_mohm = _jsonsafe(absolute)
            dcir_change_pct = _jsonsafe(relative)
            measurement_meta = occurrences[
                [
                    "occurrence",
                    "cycle",
                    "start_time_h",
                    "v_rest_v",
                    "v_pulse_v",
                    "current_ma",
                    "c_rate",
                    "rest_duration_s",
                    "pulse_duration_s",
                ]
            ].to_dict("records")
        else:
            x_occurrence = []
            x_cycle = []
            x_time = []
            dcir_mohm = []
            dcir_change_pct = []
            measurement_meta = []
            badges.append(
                {
                    "kind": "dcir_no_match",
                    "series_id": series_cfg["id"],
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "segment_id": series_cfg["segment_id"],
                    "segment_name": segment_name,
                    "detail": (
                        f"{cell.name} has no valid adjacent rest/pulse occurrences "
                        f"for {segment_name}."
                    ),
                }
            )

        direction = str((matched_target or {}).get("direction") or "")
        c_rate = (matched_target or {}).get("c_rate")
        current_ma = (matched_target or {}).get("current_ma")
        cell_series.append(
            {
                "series_id": series_cfg["id"],
                "cell_id": cell.id,
                "cell_name": cell.name,
                "segment_id": series_cfg["segment_id"],
                "segment_name": segment_name,
                "label": f"{cell.name} \u2014 {segment_name}",
                "direction": direction or None,
                "c_rate": c_rate,
                "current_ma": current_ma,
                "x_occurrence": x_occurrence,
                "x_cycle": x_cycle,
                "x_time": x_time,
                "quantities": {
                    "dcir_mohm": dcir_mohm,
                    "dcir_change_pct": dcir_change_pct,
                },
                "n_measurements": len(x_occurrence),
                "measurement_meta": measurement_meta,
            }
        )
        sources_by_cell.setdefault(
            cell.id,
            {
                "cell_id": cell.id,
                "file_hashes": hashes,
                "files": source_file_entries(files, source_versions),
            },
        )
        if progress:
            progress(
                series_index,
                len(configured_series),
                cell.name,
                "Calculated DCIR measurements",
            )

    for miss in missing_refs:
        badges.append(
            {
                "kind": "missing_reference",
                "detail": (
                    f"Selection references {miss['kind']} #{miss['ref_id']}, "
                    "which no longer exists."
                ),
            }
        )
    return {
        "computed_at": now_iso(),
        "type": "dcir",
        "parser_version": display_parser_version(all_pinned_versions),
        "calc_version": calc_version,
        "current_parser_version": display_parser_version(all_current_versions),
        "current_calc_version": CALC_VERSION,
        "dcir": {"series": configured_series},
        "cell_series": cell_series,
        "badges": badges,
        "sources": list(sources_by_cell.values()),
    }


_TIME_CAPACITY_EXCLUSIVE_CELL_STAGES = (
    "relational_selection_source_resolution",
    "protocol_target_resolution",
    "index_stitch_plan",
    "indexed_raw_access",
    "legacy_full_raw_read",
    "voltage_capability_context",
    "source_descriptors",
    "prepared_derived_read",
    "exact_cycle_filter_and_sort",
    "continuous_time_phase_capacity",
    "derivative",
    "protocol_masking",
    "display_coordinate",
    "display_downsampling",
    "display_post_downsample_materialization",
    "transform_source_provenance",
    "compact_trace_object_projection",
)


def _finish_time_capacity_cell_profile(
    diagnostics: dict[str, Any] | None,
    started: float | None,
) -> None:
    """Close one cell's exclusive partition without summing nested timers."""

    if diagnostics is None or started is None:
        return
    wall_ms = (perf_counter() - started) * 1000.0
    diagnostics["cell_job_wall_ms"] = wall_ms
    stages = diagnostics.get("stages") or {}
    exclusive: dict[str, float] = {}
    for name in _TIME_CAPACITY_EXCLUSIVE_CELL_STAGES:
        value = stages.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            exclusive[name] = max(0.0, float(value) * 1000.0)
    residual = max(0.0, wall_ms - sum(exclusive.values()))
    exclusive["cell_residual"] = residual
    diagnostics["exclusive_stages_ms"] = exclusive

    def stage_ms(name: str) -> float:
        value = stages.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return max(0.0, float(value) * 1000.0)
        return 0.0

    detailed: dict[str, float] = {}
    for name in (
        "relational_selection_source_resolution",
        "protocol_target_resolution",
        "voltage_capability_context",
        "source_descriptors",
        "prepared_derived_read",
        "exact_cycle_filter_and_sort",
        "derivative",
        "protocol_masking",
        "display_coordinate",
        "display_downsampling",
        "display_post_downsample_materialization",
        "transform_source_provenance",
        "transform_plot_array_materialization",
        "compact_trace_object_projection",
        "legacy_full_raw_read",
    ):
        value = stage_ms(name)
        if value:
            detailed[name] = value

    plan_validation = stage_ms("raw_index_plan_validation")
    if plan_validation:
        detailed["raw_index_plan_validation"] = plan_validation
    detailed["index_stitch_plan_residual"] = max(
        0.0,
        stage_ms("index_stitch_plan") - plan_validation,
    )

    raw_children: dict[str, float] = {}
    raw_read_stages = diagnostics.get("raw_read_stages_ms")
    if isinstance(raw_read_stages, dict):
        for name, value in raw_read_stages.items():
            if isinstance(name, str) and isinstance(value, (int, float)):
                raw_children[name] = max(0.0, float(value))
    for name in ("raw_record_index_sort", "raw_cycle_mapping", "raw_frame_concat"):
        value = stage_ms(name)
        if value:
            raw_children[name] = value
    detailed.update(raw_children)
    detailed["indexed_raw_access_residual"] = max(
        0.0,
        stage_ms("indexed_raw_access") - sum(raw_children.values()),
    )

    transform_children = {
        name: stage_ms(name)
        for name in (
            "transform_continuous_time",
            "transform_source_boundaries",
            "transform_phase_classification",
            "transform_phase_capacity",
            "transform_capacity_metadata",
            "transform_specific_capacity",
            "transform_areal_capacity",
        )
        if stage_ms(name)
    }
    detailed.update(transform_children)
    detailed["continuous_time_phase_capacity_residual"] = max(
        0.0,
        stage_ms("continuous_time_phase_capacity") - sum(transform_children.values()),
    )
    detailed["cell_residual"] = max(0.0, wall_ms - sum(detailed.values()))
    diagnostics["exclusive_partition_ms"] = detailed


def compute_time_capacity(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    *,
    viewport_width: int | None = None,
    precision: str = "standard",
    compact: bool = False,
    progress: ProgressCallback | None = None,
    access_diagnostics: dict[str, Any] | None = None,
    display_origin_cycle_start: int | None = None,
    refinement: bool = False,
    refinement_viewport_x_min: float | None = None,
    refinement_viewport_x_max: float | None = None,
) -> dict:
    # Spec 050.14: ordinary compact requests may use the owner-resolved
    # indexed path and bounded persistent process pool. The service returns
    # ``None`` for every unsupported or unsafe case, leaving this established
    # implementation as the exact serial/legacy fallback.
    if precision == "standard" and compact:
        from . import time_capacity_workers

        optimized = time_capacity_workers.try_compute_time_capacity(
            db,
            spec,
            provenance,
            use_current_versions=use_current_versions,
            viewport_width=viewport_width,
            precision=precision,
            compact=compact,
            progress=progress,
            access_diagnostics=access_diagnostics,
            display_origin_cycle_start=display_origin_cycle_start,
            refinement=refinement,
            refinement_viewport_x_min=refinement_viewport_x_min,
            refinement_viewport_x_max=refinement_viewport_x_max,
        )
        if optimized is not None:
            return optimized
        if refinement:
            raise time_capacity_workers.RefinementUnavailable(
                "refinement is unavailable for this request"
            )

    engine_started = perf_counter()
    ensure_canonical_cycling_available(db, spec)
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        calc_version = provenance.get("calc_version") or calc_version
    all_pinned_versions: list[str] = []
    all_current_versions: list[str] = []

    computation = spec.get("computation", {})
    settings = time_capacity_settings(computation)
    compact_ordinary_time = (
        compact
        and precision == "standard"
        and settings["view"] == "voltage_current"
        and settings["x_axis"] == "time"
        and settings["display_mode"] == "consecutive"
    )
    selection = spec.get("selection", {})
    exclusions = selection.get("exclusions", [])
    hidden_group_ids = set(selection.get("hidden_replicate_group_ids", []))
    units, missing_refs = resolve_selection(db, spec)
    protocol_context, protocol_badges = _protocol_filter_context(spec)

    from . import scanner

    traces: list[dict] = []
    badges: list[dict] = list(protocol_badges)

    configured_max = max(100, settings["max_points_per_cell"])
    width = max(320, min(6000, int(viewport_width or 1200)))
    total_units = len(units)
    visible_cell_count = sum(
        1
        for unit in units
        if exclusion_for_unit(exclusions, unit) is None
        and unit["group_id"] not in hidden_group_ids
    )
    display_max = (
        configured_max
        if precision == "full" or not compact or refinement
        else time_capacity_display_budget(
            configured_max,
            width,
            visible_cell_count,
        )
    )
    total_returned_points = 0
    if access_diagnostics is not None:
        access_diagnostics.setdefault("cells", [])
    previous_cell_diagnostics: dict[str, Any] | None = None
    previous_cell_started: float | None = None
    # Spec 040.4: which voltage quantities have real (non-fabricated) data
    # anywhere in the current selection, independent of the currently chosen
    # `voltage_channel` — this is what lets the frontend offer working/counter
    # potential as options at all without advertising a channel no selected
    # source actually has. True two-electrode sources never populate the
    # aux columns, while the BioLogic GCPL adapter populates them only for its
    # verified Ewe/Ece layout. Indexed caches use their full-source facts;
    # legacy caches retain the full stitched-frame check before cycle-range
    # filtering so the offered options do not flicker as filters change.
    channel_availability = {quantity: False for quantity in canonical_cycling.VOLTAGE_QUANTITIES}
    channel_role_candidates: dict[str, set[str]] = {
        quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES
    }
    channel_reference_candidates: dict[str, set[str | None]] = {
        quantity: set() for quantity in canonical_cycling.VOLTAGE_QUANTITIES
    }

    owner_setup_ms = (perf_counter() - engine_started) * 1000.0

    for unit_index, unit in enumerate(units, start=1):
        if previous_cell_diagnostics is not None and previous_cell_started is not None:
            _finish_time_capacity_cell_profile(
                previous_cell_diagnostics,
                previous_cell_started,
            )
        cell: Cell = unit["cell"]
        cell_started = perf_counter() if access_diagnostics is not None else None
        cell_diagnostics: dict[str, Any] = {
            "cell_id": cell.id,
            "cell_name": cell.name,
        }
        profile_diagnostics = cell_diagnostics if access_diagnostics is not None else None
        if access_diagnostics is not None:
            access_diagnostics["cells"].append(cell_diagnostics)
            previous_cell_diagnostics = cell_diagnostics
            previous_cell_started = cell_started
        if progress:
            progress(unit_index - 1, total_units, cell.name, "Reading raw cache")
        with time_capacity_path.timed_stage(
            cell_diagnostics, "relational_selection_source_resolution"
        ):
            hashes, files = cell_ordered_hashes(db, cell)
            source_versions = resolve_source_parser_versions(
                files, provenance, cell.id, use_current_versions
            )
            refs = [stitch.CachedSourceRef(f.hash, source_versions[f.hash]) for f in files]
        all_pinned_versions.extend(source_versions[f.hash] for f in files)
        all_current_versions.extend(current_parser_identity(f) for f in files)
        reparsed = False
        for f, ref in zip(files, refs):
            if (
                ref.parser_version == current_parser_identity(f)
                and not cache.raw_path(f.hash, ref.parser_version).exists()
                and Path(f.path).exists()
            ):
                scanner.parse_file(db, f)
                reparsed = True

        with time_capacity_path.timed_stage(
            cell_diagnostics, "protocol_target_resolution"
        ):
            step_targets = _protocol_step_targets(files, protocol_context, badges, cell)

        with time_capacity_path.timed_stage(cell_diagnostics, "index_stitch_plan"):
            plan = time_capacity_path.build_time_capacity_stitch_plan(
                refs,
                diagnostics=cell_diagnostics,
            )

        source_facts: dict[str, dict] | None = None
        indexed_path = plan.path in {"indexed", "missing"}
        requested_cycles: tuple[int, ...] = ()
        if indexed_path:
            requested_cycles = time_capacity_path.requested_global_cycles(
                plan,
                explicit_cycles=settings["cycles"],
                cycle_start=settings["cycle_start"],
                cycle_end=settings["cycle_end"],
            )
            indexed_available_columns = {
                column
                for source in plan.sources
                for column in source.index.get("raw_column_names", ())
            }
            requested_raw_columns = time_capacity_path.time_capacity_request_columns(
                indexed_available_columns,
                settings,
                precision=precision,
                compact=compact,
                protocol_active=protocol_context["active"],
            )
            with time_capacity_path.timed_stage(cell_diagnostics, "indexed_raw_access"):
                raw = time_capacity_path.load_indexed_time_capacity_raw(
                    plan,
                    requested_cycles,
                    requested_columns=requested_raw_columns,
                    diagnostics=cell_diagnostics,
                )
            if raw is None:
                indexed_path = False
                cell_diagnostics["path"] = "legacy"
                cell_diagnostics["fallback_reason"] = "indexed_read_unavailable"
                with time_capacity_path.timed_stage(cell_diagnostics, "legacy_full_raw_read"):
                    raw, segments, missing = stitch.stitch_raw(refs)
            else:
                segments = plan.segments
                missing = plan.missing
                source_facts = plan.source_facts
        else:
            with time_capacity_path.timed_stage(cell_diagnostics, "legacy_full_raw_read"):
                raw, segments, missing = stitch.stitch_raw(refs)

        cell_diagnostics["raw_rows_loaded_before_filter"] = len(raw)
        if not indexed_path:
            # The compatibility reader has no row-group selection boundary;
            # record its full-frame materialization explicitly for the profiler.
            cell_diagnostics["raw_rows_materialized"] = len(raw)
            cell_diagnostics["row_groups_read"] = "full"
            cell_diagnostics["row_groups_total"] = "full"
        if indexed_path:
            matched_files_by_quantity = {
                quantity: [] for quantity in canonical_cycling.VOLTAGE_QUANTITIES
            }
            source_by_hash = {source_file.hash: source_file for source_file in files}
            for source in plan.sources:
                availability = source.voltage_data_availability
                for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
                    if availability.get(column) is True:
                        channel_availability[quantity] = True
                        source_file = source_by_hash.get(source.ref.file_hash)
                        if source_file is not None:
                            matched_files_by_quantity[quantity].append(source_file)
            local_roles, local_references = time_capacity_path.timed_call(
                cell_diagnostics,
                "voltage_capability_context",
                _resolve_time_capacity_voltage_context,
                files,
                matched_files_by_quantity,
            )
        else:
            for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
                if channel_availability[quantity] or column not in raw.columns:
                    continue
                if np.isfinite(
                    pd.to_numeric(raw[column], errors="coerce").to_numpy(dtype="float64")
                ).any():
                    channel_availability[quantity] = True
            local_roles, local_references = time_capacity_path.timed_call(
                cell_diagnostics,
                "voltage_capability_context",
                _time_capacity_voltage_context,
                raw,
                files,
            )
        for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
            has_data = (
                any(
                    source.voltage_data_availability.get(column) is True
                    for source in plan.sources
                )
                if indexed_path
                else column in raw.columns
                and np.isfinite(
                    pd.to_numeric(raw[column], errors="coerce").to_numpy(dtype="float64")
                ).any()
            )
            if has_data:
                channel_role_candidates[quantity].add(local_roles[quantity])
                channel_reference_candidates[quantity].add(local_references[quantity])
        descriptors = time_capacity_path.timed_call(
            cell_diagnostics,
            "source_descriptors",
            source_descriptors,
            files,
            segments,
            missing,
            raw,
            parser_versions=source_versions,
            source_facts=source_facts,
        )
        for h in missing:
            missing_identity = source_versions.get(h, "unknown")
            badges.append(
                {
                    "kind": "cache_missing",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "detail": f"No raw cache at parser {missing_identity} for file {h[:12]}...",
                }
            )
        complete = stitch.stitch_metadata(raw)["complete"]
        if not complete:
            badges.append(
                {
                    "kind": "continuation_source_missing",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "missing_source_hashes": missing,
                    "missing_source_positions": stitch.stitch_metadata(raw)[
                        "missing_positions"
                    ],
                    "detail": (
                        "The ordered Cell source chain is incomplete; the scientific "
                        "time/capacity trace was withheld until every source cache is available."
                    ),
                }
            )
        if raw.empty or "cycle" not in raw.columns or not complete:
            traces.append(
                {
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "label": unit["label"],
                    "group_id": unit["group_id"],
                    "group_name": unit["group_name"],
                    "excluded": exclusion_for_unit(exclusions, unit) is not None
                    or unit["group_id"] in hidden_group_ids,
                    "active_mass_mg": cell_active_mass_mg(cell),
                    "nominal_capacity_mah": cell_nominal_capacity_mah(cell),
                    "electrode_area_cm2": cell_electrode_area_cm2(cell),
                    "cycle": [],
                    "display_x": [],
                    "time_s": [],
                    "capacity_mah": [],
                    "capacity_mah_g": [],
                    "capacity_mah_cm2": [],
                    "voltage_v": [],
                    "current_ma": [],
                    "phase": [],
                    "status": [],
                    "derivative_x": [],
                    "derivative_y": [],
                    "segments": segments,
                    "source_descriptors": descriptors,
                    "source_cycle": [],
                    "source_boundary_indices": [],
                }
            )
            if compact_ordinary_time:
                traces[-1].update({"sources": [], "source_index": []})
            else:
                traces[-1].update(
                    {
                        "source_position": [],
                        "source_filename": [],
                        "source_hash": [],
                    }
                )
            continue

        transform_needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
            settings,
            precision=precision,
            compact=compact,
        )
        prepared_derived: pd.DataFrame | None = None
        if (
            indexed_path
            and plan.path == "indexed"
            and requested_cycles
            and calc_version == CALC_VERSION
            and transform_needs.phase_capacity
        ):
            with time_capacity_path.timed_stage(
                profile_diagnostics,
                "prepared_derived_read",
            ):
                prepared_derived = time_capacity_path.load_indexed_time_capacity_derived(
                    plan,
                    requested_cycles,
                    [
                        "phase_code",
                        *(["phase_capacity_mah"] if transform_needs.phase_capacity else []),
                    ],
                    diagnostics=cell_diagnostics,
                )

        with time_capacity_path.timed_stage(
            cell_diagnostics, "exact_cycle_filter_and_sort"
        ):
            if settings["cycles"]:
                raw = raw[raw["cycle"].isin(settings["cycles"])]
            else:
                if settings["cycle_start"] is not None:
                    raw = raw[raw["cycle"] >= int(settings["cycle_start"])]
                if settings["cycle_end"] is not None:
                    raw = raw[raw["cycle"] <= int(settings["cycle_end"])]

            raw = raw.sort_values(
                ["cycle", "segment", "record_index"]
                if "record_index" in raw.columns
                else ["cycle", "segment"]
            )
            cell_diagnostics["selected_rows_before_transforms"] = len(raw)

        with time_capacity_path.timed_stage(
            cell_diagnostics, "continuous_time_phase_capacity"
        ):
            transform_rows = len(raw)
            if transform_needs.continuous_time:
                with time_capacity_path.timed_stage(
                    profile_diagnostics, "transform_continuous_time"
                ):
                    raw = _continuous_time(raw)
            _record_transform_profile(
                profile_diagnostics,
                "continuous_time",
                input_rows=transform_rows,
                output_rows=len(raw) if transform_needs.continuous_time else 0,
                consumed_by=tuple(
                    [
                        *(
                            ["time_axis"]
                            if settings["view"] == "voltage_current"
                            and settings["x_axis"] == "time"
                            else []
                        ),
                        *(["full_export"] if precision == "full" or not compact else []),
                    ]
                ),
            )

            with time_capacity_path.timed_stage(
                profile_diagnostics, "transform_source_boundaries"
            ):
                source_boundary_indices = (
                    np.flatnonzero(
                        raw["segment"].to_numpy()[1:]
                        != raw["segment"].to_numpy()[:-1]
                    )
                    + 1
                    if "segment" in raw.columns and len(raw) > 1
                    else np.array([], dtype="int64")
                )
            _record_transform_profile(
                profile_diagnostics,
                "source_boundaries",
                input_rows=len(raw),
                output_rows=len(source_boundary_indices),
                consumed_by=("provenance_output", "display_downsampling"),
            )

            if transform_needs.phase:
                aligned_prepared = (
                    _aligned_prepared_transform_values(
                        raw,
                        prepared_derived,
                        need_capacity=transform_needs.phase_capacity,
                    )
                    if prepared_derived is not None
                    else None
                )
                if aligned_prepared is not None:
                    phases, prepared_capacity = aligned_prepared
                    phase_source = "prepared"
                    capacity_source = "prepared" if transform_needs.phase_capacity else "not_needed"
                    cell_diagnostics["derived_access"] = "prepared"
                else:
                    cell_diagnostics["derived_access"] = (
                        "fallback" if transform_needs.phase_capacity else "not_needed"
                    )
                    with time_capacity_path.timed_stage(
                        profile_diagnostics, "transform_phase_classification"
                    ):
                        phases = _phase_from_raw(raw)
                    phase_source = "computed"
                    prepared_capacity = None
                    capacity_source = "computed" if transform_needs.phase_capacity else "not_needed"
            else:
                phases = []
                prepared_capacity = None
                phase_source = "not_needed"
                capacity_source = "not_needed"
                cell_diagnostics["derived_access"] = "not_needed"
            _record_transform_profile(
                profile_diagnostics,
                "phase_classification",
                input_rows=len(raw),
                output_rows=len(phases),
                consumed_by=("phase_output", "display_coordinate", "derivative")
                if transform_needs.phase
                else (),
            )

            if transform_needs.phase_capacity:
                if prepared_capacity is not None:
                    capacity = prepared_capacity
                else:
                    with time_capacity_path.timed_stage(
                        profile_diagnostics, "transform_phase_capacity"
                    ):
                        capacity = _phase_capacity(raw, phases)
            else:
                capacity = None
            capacity_consumers: list[str] = []
            if transform_needs.phase_capacity:
                if settings["view"] != "voltage_current":
                    capacity_consumers.append("derivative")
                elif settings["x_axis"] in {
                    "capacity_mah",
                    "capacity_mah_g",
                    "capacity_mah_cm2",
                }:
                    capacity_consumers.append("capacity_axis")
                if precision == "full" or not compact:
                    capacity_consumers.append("full_export")
            _record_transform_profile(
                profile_diagnostics,
                "phase_capacity",
                input_rows=len(raw),
                output_rows=len(capacity) if capacity is not None else 0,
                consumed_by=tuple(capacity_consumers),
            )
            if profile_diagnostics is not None:
                profile_diagnostics["phase_source"] = phase_source
                profile_diagnostics["phase_capacity_source"] = capacity_source

            with time_capacity_path.timed_stage(
                profile_diagnostics, "transform_capacity_metadata"
            ):
                active_mass_mg = cell_active_mass_mg(cell)
                nominal_capacity_mah = cell_nominal_capacity_mah(cell)
                electrode_area_cm2 = cell_electrode_area_cm2(cell)
            _record_transform_profile(
                profile_diagnostics,
                "capacity_metadata",
                input_rows=len(raw),
                output_rows=1,
                consumed_by=("capacity_normalization", "trace_metadata"),
            )

            active_mass_g = active_mass_mg / 1000.0 if active_mass_mg else None
            if transform_needs.specific_capacity:
                with time_capacity_path.timed_stage(
                    profile_diagnostics, "transform_specific_capacity"
                ):
                    capacity_g = (
                        capacity / active_mass_g
                        if capacity is not None and active_mass_g and active_mass_g > 0
                        else np.full(len(raw), np.nan)
                    )
            else:
                capacity_g = None
            _record_transform_profile(
                profile_diagnostics,
                "specific_capacity",
                input_rows=len(raw),
                output_rows=len(capacity_g) if capacity_g is not None else 0,
                consumed_by=tuple(
                    [
                        *(["derivative"] if settings["view"] != "voltage_current" and settings["derivative_specific"] else []),
                        *(
                            ["capacity_axis"]
                            if settings["view"] == "voltage_current" and settings["x_axis"] == "capacity_mah_g"
                            else []
                        ),
                        *(["full_export"] if precision == "full" or not compact else []),
                    ]
                ),
            )

            # A user-supplied area overrides the metadata; areal capacity is
            # area-normalised here so switching to it needs no client-side area.
            area_cm2 = settings["electrode_area_cm2"] or electrode_area_cm2
            if transform_needs.areal_capacity:
                with time_capacity_path.timed_stage(
                    profile_diagnostics, "transform_areal_capacity"
                ):
                    capacity_area = (
                        capacity / area_cm2
                        if capacity is not None and area_cm2 and area_cm2 > 0
                        else np.full(len(raw), np.nan)
                    )
            else:
                capacity_area = None
            _record_transform_profile(
                profile_diagnostics,
                "areal_capacity",
                input_rows=len(raw),
                output_rows=len(capacity_area) if capacity_area is not None else 0,
                consumed_by=tuple(
                    [
                        *(
                            ["capacity_axis"]
                            if settings["view"] == "voltage_current" and settings["x_axis"] == "capacity_mah_cm2"
                            else []
                        ),
                        *(["full_export"] if precision == "full" or not compact else []),
                    ]
                ),
            )

        with time_capacity_path.timed_stage(cell_diagnostics, "derivative"):
            derivative_x, derivative_y = _derivative_curve(
                raw, phases, capacity, capacity_g, settings, profile_diagnostics
            )

        with time_capacity_path.timed_stage(cell_diagnostics, "protocol_masking"):
            if protocol_context["active"]:
                has_step_column = "step_index" in raw.columns or "Step_Index" in raw.columns
                if not has_step_column and any(
                    step_indices
                    for modes in step_targets.values()
                    for step_indices in modes.values()
                ):
                    _add_protocol_badge(
                        protocol_context,
                        badges,
                        "protocol_mapping_unavailable",
                        "Raw step-index data is unavailable; protocol-segment row masking could not be applied.",
                        cell=cell,
                    )
                only_match = _protocol_row_mask(raw, step_targets, "only")
                plot_mask = _protocol_row_mask(raw, step_targets, "excluded")
                plot_mask |= _protocol_row_mask(raw, step_targets, "hidden")
                if protocol_context["only_active"]:
                    plot_mask |= ~only_match
            else:
                plot_mask = np.zeros(len(raw), dtype=bool)

        voltage_column = canonical_cycling.VOLTAGE_QUANTITIES[settings["voltage_channel"]]
        voltage = (
            raw[voltage_column].to_numpy(dtype="float64").copy()
            if voltage_column in raw.columns
            else np.full(len(raw), np.nan)
        )
        current = (
            raw["current_ma"].to_numpy(dtype="float64").copy()
            if "current_ma" in raw.columns
            else np.full(len(raw), np.nan)
        )
        with time_capacity_path.timed_stage(
            profile_diagnostics, "transform_plot_array_materialization"
        ):
            capacity = capacity.copy() if capacity is not None else None
            capacity_g = capacity_g.copy() if capacity_g is not None else None
            capacity_area = capacity_area.copy() if capacity_area is not None else None
            derivative_x = derivative_x.copy()
            derivative_y = derivative_y.copy()
            for values in (
                voltage,
                current,
                capacity,
                capacity_g,
                capacity_area,
                derivative_x,
                derivative_y,
            ):
                if values is None:
                    continue
                values[plot_mask] = np.nan
        _record_transform_profile(
            profile_diagnostics,
            "plot_array_materialization",
            input_rows=len(raw),
            output_rows=len(raw),
            consumed_by=("response_projection",),
        )
        with time_capacity_path.timed_stage(cell_diagnostics, "display_coordinate"):
            display_x = _time_capacity_display_x(
                raw,
                phases,
                capacity,
                capacity_g,
                capacity_area,
                settings,
                origin_cycle_start=display_origin_cycle_start,
            )
        if (
            refinement
            and refinement_viewport_x_min is not None
            and refinement_viewport_x_max is not None
        ):
            window = np.isfinite(display_x)
            window &= display_x >= float(refinement_viewport_x_min)
            window &= display_x <= float(refinement_viewport_x_max)
            take = np.flatnonzero(window)
            raw = raw.iloc[take].reset_index(drop=True)
            display_x = display_x[take]
            phases = np.asarray(phases)[take].tolist() if phases else []
            plot_mask = plot_mask[take]
            voltage = voltage[take]
            current = current[take]
            capacity = capacity[take] if capacity is not None else None
            capacity_g = capacity_g[take] if capacity_g is not None else None
            capacity_area = capacity_area[take] if capacity_area is not None else None
            derivative_x = derivative_x[take]
            derivative_y = derivative_y[take]
            source_boundary_indices = (
                np.flatnonzero(
                    raw["segment"].to_numpy()[1:]
                    != raw["segment"].to_numpy()[:-1]
                )
                + 1
                if "segment" in raw.columns and len(raw) > 1
                else np.array([], dtype="int64")
            )
        # A full, non-compact request is used by scientific data export. It
        # must retain every selected-channel row even when the interactive
        # setting intentionally limits the on-screen point count.
        if len(raw) > display_max and not (precision == "full" or not compact):
            envelope_series = (
                [derivative_x, derivative_y]
                if settings["view"] != "voltage_current"
                else [voltage]
            )
            primary_values = derivative_y if settings["view"] != "voltage_current" else voltage
            visible_values = ~plot_mask & np.isfinite(primary_values)
            with time_capacity_path.timed_stage(cell_diagnostics, "display_downsampling"):
                take = _downsample_indices(
                    len(raw), display_max, visible_values, envelope_series
                )
            with time_capacity_path.timed_stage(
                profile_diagnostics, "display_post_downsample_materialization"
            ):
                take = np.unique(np.concatenate((take, source_boundary_indices)))
                raw = raw.iloc[take]
                display_x = display_x[take]
                phases = np.asarray(phases)[take].tolist()
                voltage = voltage[take]
                current = current[take]
                capacity = capacity[take] if capacity is not None else None
                capacity_g = capacity_g[take] if capacity_g is not None else None
                capacity_area = capacity_area[take] if capacity_area is not None else None
                derivative_x = derivative_x[take]
                derivative_y = derivative_y[take]
                source_boundary_indices = np.flatnonzero(
                    raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]
                ) + 1
        else:
            source_boundary_indices = np.flatnonzero(
                raw["segment"].to_numpy()[1:] != raw["segment"].to_numpy()[:-1]
            ) + 1 if "segment" in raw.columns and len(raw) > 1 else np.array([], dtype="int64")

        # Compact interactive responses only return the bounded display frame.
        # Build row-aligned provenance after downsampling so discarded raw rows
        # do not pay for list construction that cannot reach the client.
        with time_capacity_path.timed_stage(
            profile_diagnostics, "transform_source_provenance"
        ):
            source_values = (
                compact_source_columns(raw, files)
                if compact_ordinary_time
                else source_columns(raw, files)
            )
        _record_transform_profile(
            profile_diagnostics,
            "source_provenance",
            input_rows=len(raw),
            output_rows=len(raw),
            consumed_by=("provenance_output",),
        )

        full_precision = precision == "full" or not compact
        is_derivative = settings["view"] != "voltage_current"
        x_axis = settings["x_axis"]
        include_time = (
            not compact
            or not is_derivative
            and x_axis == "time"
            and settings["display_mode"] != "consecutive"
        )
        total_returned_points += len(raw)

        trace_projection_started = perf_counter() if profile_diagnostics is not None else None
        exclusion = exclusion_for_unit(exclusions, unit)
        group_hidden = unit["group_id"] in hidden_group_ids
        traces.append(
            {
                "cell_id": cell.id,
                "cell_name": cell.name,
                "label": unit["label"],
                "group_id": unit["group_id"],
                "group_name": unit["group_name"],
                "excluded": exclusion is not None or group_hidden,
                "active_mass_mg": active_mass_mg,
                "nominal_capacity_mah": nominal_capacity_mah,
                "electrode_area_cm2": electrode_area_cm2,
                "cycle": _jsonsafe_int(raw["cycle"].to_numpy()),
                "display_x": _jsonsafe_plot(display_x, None if full_precision else 6),
                "time_s": (
                    _jsonsafe_plot(raw["time_s"].to_numpy(), None if full_precision else 3)
                    if include_time and "time_s" in raw.columns
                    else []
                ),
                "capacity_mah": (
                    _jsonsafe_plot(capacity, None if full_precision else 6)
                    if not compact or (not is_derivative and x_axis == "capacity_mah")
                    else []
                ),
                "capacity_mah_g": (
                    _jsonsafe_plot(capacity_g, None if full_precision else 5)
                    if not compact or (not is_derivative and x_axis == "capacity_mah_g")
                    else []
                ),
                "capacity_mah_cm2": (
                    _jsonsafe_plot(capacity_area, None if full_precision else 5)
                    if not compact or (not is_derivative and x_axis == "capacity_mah_cm2")
                    else []
                ),
                "voltage_v": _jsonsafe_plot(voltage, None if full_precision else 5) if not compact or not is_derivative else [],
                "current_ma": _jsonsafe_plot(current, None if full_precision else 5) if not compact or not is_derivative else [],
                "phase": phases,
                "status": _textsafe(raw["status"]) if not compact and "status" in raw.columns else [],
                "derivative_x": _jsonsafe_plot(derivative_x, None if full_precision else 7) if not compact or is_derivative else [],
                "derivative_y": _jsonsafe_plot(derivative_y, None if full_precision else 7) if not compact or is_derivative else [],
                "segments": segments,
                "source_descriptors": descriptors,
                **source_values,
                "source_boundary_indices": [int(index) for index in source_boundary_indices],
            }
        )
        if trace_projection_started is not None:
            profile_diagnostics.setdefault("stages", {})["compact_trace_object_projection"] = (
                profile_diagnostics.setdefault("stages", {}).get(
                    "compact_trace_object_projection", 0.0
                )
                + perf_counter() - trace_projection_started
            )
        if progress:
            progress(
                unit_index,
                total_units,
                cell.name,
                "Re-parsed from source" if reparsed else "Read from cache",
            )

    if previous_cell_diagnostics is not None and previous_cell_started is not None:
        _finish_time_capacity_cell_profile(
            previous_cell_diagnostics,
            previous_cell_started,
        )

    finalization_started = perf_counter()
    _append_unmatched_protocol_badges(protocol_context, badges)

    for miss in missing_refs:
        badges.append(
            {
                "kind": "missing_reference",
                "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists.",
            }
        )

    default_roles = {
        "voltage": "cell",
        "working_potential": "working_vs_reference",
        "counter_potential": "counter_vs_reference",
    }
    voltage_channels = {}
    for quantity in canonical_cycling.VOLTAGE_QUANTITIES:
        role_candidates = channel_role_candidates[quantity]
        if not role_candidates:
            role = default_roles[quantity]
        elif len(role_candidates) == 1:
            role = next(iter(role_candidates))
        else:
            role = canonical_cycling.MIXED_VOLTAGE_ROLE
        references = channel_reference_candidates[quantity]
        reference = (
            next(iter(references))
            if len(references) == 1 and next(iter(references)) is not None
            else None
        )
        item = {
            "available": channel_availability[quantity],
            "label": canonical_cycling.voltage_quantity_label(
                quantity,
                role=role,
                reference_electrode=reference,
            ),
            "role": role,
        }
        if reference is not None and role != canonical_cycling.MIXED_VOLTAGE_ROLE:
            item["reference_electrode"] = reference
        voltage_channels[quantity] = item

    result = {
        "computed_at": now_iso(),
        "type": spec.get("type", "cycling"),
        "parser_version": display_parser_version(all_pinned_versions),
        "calc_version": calc_version,
        "current_parser_version": display_parser_version(all_current_versions),
        "current_calc_version": CALC_VERSION,
        "settings": settings,
        "cell_traces": traces,
        "badges": badges,
        # Spec 040.4: data-driven, per-selection availability — never a
        # static per-format declaration — so the frontend can offer exactly
        # the electrode potentials that actually have data for the samples
        # currently selected, and nothing else.
        "voltage_channels": voltage_channels,
        "rendering": {
            "viewport_width": width,
            "configured_max_points_per_cell": configured_max,
            "max_points_per_cell": display_max,
            "total_points": total_returned_points,
            "precision": precision,
            "compact": compact,
        },
    }
    global_finalization_ms = (perf_counter() - finalization_started) * 1000.0
    if access_diagnostics is not None:
        cell_jobs_ms = sum(
            float(cell.get("cell_job_wall_ms", 0.0))
            for cell in access_diagnostics.get("cells", [])
            if isinstance(cell, dict)
            and isinstance(cell.get("cell_job_wall_ms"), (int, float))
            and not isinstance(cell.get("cell_job_wall_ms"), bool)
        )
        engine_total_ms = (perf_counter() - engine_started) * 1000.0
        residual_ms = max(
            0.0,
            engine_total_ms - owner_setup_ms - cell_jobs_ms - global_finalization_ms,
        )
        access_diagnostics["engine"] = {
            "total_ms": engine_total_ms,
            "owner_setup_ms": owner_setup_ms,
            "cell_jobs_ms": cell_jobs_ms,
            "global_finalization_ms": global_finalization_ms,
            "residual_ms": residual_ms,
        }
    return result


def build_provenance(result: dict) -> dict:
    return {
        "computed_at": result["computed_at"],
        "parser_version": result["parser_version"],
        "calc_version": result["calc_version"],
        "sources": result["sources"],
    }
