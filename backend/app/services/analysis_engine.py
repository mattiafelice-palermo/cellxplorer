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
from typing import Callable

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..models import Cell, ReplicateGroup, SourceFile
from . import cache, calc, parsing, protocol, stitch

SPEC_VERSION = 7
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
        },
        "aggregation": {"mode": "replicate_mean", "dispersion": "std", "min_n_for_band": 2},
        "presentation": {
            "quantity": "discharge_capacity",
            "ce_overlay": True,
            "show_individual_cells": True,
            "legend": True,
            "hidden_protocol_segment_ids": [],
        },
        "saved_plots": [],
    }


# ------------------------------------------------------------- resolution


def cell_ordered_hashes(db: Session, cell: Cell) -> tuple[list[str], list[SourceFile]]:
    """All source files of a cell: tests in order, files in order."""
    hashes: list[str] = []
    files: list[SourceFile] = []
    for test in sorted(cell.tests, key=lambda t: t.id):
        for link in sorted(test.file_links, key=lambda l: l.position):
            hashes.append(link.file.hash)
            files.append(link.file)
    return hashes, files


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
        signature = reconstructed["signature"]
        modes = {mode: set() for mode in PROTOCOL_SEGMENT_MODES}
        for mode, selected_segments in context["selected"].items():
            for segment in selected_segments:
                segment_matches = False
                targets = segment.get("targets") or []
                for target in targets if isinstance(targets, list) else []:
                    if not isinstance(target, dict) or target.get("protocol_signature") != signature:
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
    parser_version: str,
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


def cell_active_mass_mg(cell: Cell) -> float | None:
    metadata = {entry.key: entry.value for entry in cell.metadata_entries}
    for key in ("override.active_mass_mg", "active_material_mg", "active_mass_mg"):
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


def cell_nominal_capacity_mah(cell: Cell) -> float | None:
    metadata = {entry.key: entry.value for entry in cell.metadata_entries}
    for key in ("override.nominal_capacity_mah", "nominal_capacity_mah", "nominal_capacity"):
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


def cell_electrode_area_cm2(cell: Cell) -> float | None:
    metadata = {entry.key: entry.value for entry in cell.metadata_entries}
    for key in ("override.electrode_area_cm2", "electrode_area_cm2"):
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
    """Charge/discharge/rest per row, vectorized (runs on full raw frames)."""
    n = len(frame)
    if "status" in frame.columns:
        status = frame["status"].astype(str).str.lower()
        has_dchg = status.str.contains("dchg") | status.str.contains("discharge")
        has_chg = status.str.contains("chg") | status.str.contains("charge")
    else:
        has_dchg = pd.Series(False, index=frame.index)
        has_chg = pd.Series(False, index=frame.index)
    if "current_ma" in frame.columns:
        cur = frame["current_ma"].to_numpy(dtype="float64")
    else:
        cur = np.full(n, np.nan)
    with np.errstate(invalid="ignore"):
        is_dchg = has_dchg.to_numpy() | (cur < 0)
        is_chg = ~is_dchg & (has_chg.to_numpy() | (cur > 0))
    return np.select([is_dchg, is_chg], ["discharge", "charge"], default="rest").tolist()


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
    capacity: np.ndarray,
    capacity_g: np.ndarray,
    settings: dict,
) -> np.ndarray:
    if settings["x_axis"] == "capacity_mah_g":
        values = capacity_g.copy()
    elif settings["x_axis"] == "capacity_mah":
        values = capacity.copy()
    else:
        factor = 3600.0 if settings["time_unit"] == "h" else 60.0 if settings["time_unit"] == "min" else 1.0
        values = (
            raw["time_s"].to_numpy(dtype="float64") / factor
            if "time_s" in raw.columns
            else np.full(len(raw), np.nan)
        )
    if settings["display_mode"] == "consecutive":
        finite = np.flatnonzero(np.isfinite(values))
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


def _phase_capacity(frame: pd.DataFrame, phases: list[str]) -> np.ndarray:
    """Half-cycle capacity per row, continuous across Neware step resets.

    Neware's capacity counters restart at each step boundary — e.g. at the
    CC→CV transition the charge capacity drops from ~2.6 mAh back to 0 and
    re-accumulates during the CV hold. Plotted against capacity that drew a
    flat line at the cutoff voltage starting from x=0. Within each
    contiguous (cycle, phase) run we therefore accumulate an offset at every
    reset so capacity is cumulative for the whole half-cycle."""
    n = len(frame)
    charge = (
        frame["charge_capacity_mah"].to_numpy(dtype="float64")
        if "charge_capacity_mah" in frame.columns
        else np.full(n, np.nan)
    )
    discharge = (
        frame["discharge_capacity_mah"].to_numpy(dtype="float64")
        if "discharge_capacity_mah" in frame.columns
        else np.full(n, np.nan)
    )
    phase_arr = np.asarray(phases)
    with np.errstate(invalid="ignore"):
        best = np.where(
            np.isnan(charge), discharge, np.where(np.isnan(discharge), charge, np.maximum(charge, discharge))
        )
    raw_cap = np.where(
        (phase_arr == "discharge") & ~np.isnan(discharge),
        discharge,
        np.where((phase_arr == "charge") & ~np.isnan(charge), charge, best),
    )

    cycles = (
        frame["cycle"].to_numpy() if "cycle" in frame.columns else np.zeros(n, dtype="int64")
    )
    out = raw_cap.copy()
    carry = 0.0
    prev_val = np.nan
    prev_key: tuple | None = None
    for i in range(n):
        key = (cycles[i], phase_arr[i])
        val = raw_cap[i]
        if key != prev_key:
            carry = 0.0
            prev_val = np.nan
            prev_key = key
        if not np.isnan(val):
            # a step reset drops the counter to (near) zero; small noisy
            # decreases are left alone
            if not np.isnan(prev_val) and val < prev_val and val < prev_val * 0.5:
                carry += prev_val
            prev_val = val
            out[i] = val + carry
    return out


def _derivative_curve(
    frame: pd.DataFrame,
    phases: list[str],
    capacity_mah: np.ndarray,
    capacity_mah_g: np.ndarray,
    settings: dict,
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

    start = 0
    while start < n:
        key = (cycles[start], segments[start], phase_arr[start])
        end = start + 1
        while end < n and (cycles[end], segments[end], phase_arr[end]) == key:
            end += 1
        phase = phase_arr[start]
        if phase in {"charge", "discharge"} and (selected_phase == "both" or selected_phase == phase):
            q = capacity[start:end]
            v = voltage[start:end]
            finite = np.isfinite(q) & np.isfinite(v)
            if finite.sum() >= 2:
                min_periods = min(window, 3, int(finite.sum()))
                q_s = pd.Series(q).rolling(window, center=True, min_periods=min_periods).mean().to_numpy()
                v_s = pd.Series(v).rolling(window, center=True, min_periods=min_periods).mean().to_numpy()
                dq = np.gradient(q_s)
                dv = np.gradient(v_s)
                with np.errstate(divide="ignore", invalid="ignore"):
                    derivative = np.divide(dq, dv) if mode == "dqdv" else np.divide(dv, dq)
                denominator = dv if mode == "dqdv" else dq
                derivative[np.abs(denominator) < 1e-10] = np.nan
                derivative[~np.isfinite(derivative)] = np.nan
                # Explicit CV-only steps have dV ~= 0 by design and therefore
                # no finite ICA/DVA interpretation. Combined CCCV steps cannot
                # be split from status alone, so reject values far beyond the
                # local Q/V scale rather than allowing a near-zero denominator
                # to dominate the plot axis.
                if "status" in frame.columns:
                    step_status = frame["status"].iloc[start:end].astype(str).str.lower()
                    explicit_cv = step_status.str.contains("cv") & ~step_status.str.contains("cccv")
                    derivative[explicit_cv.to_numpy()] = np.nan
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
        start = end
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


def compute(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    progress: ProgressCallback | None = None,
) -> dict:
    parser_version = parsing.PARSER_VERSION
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        parser_version = provenance.get("parser_version") or parser_version
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

    from . import scanner  # local import to avoid a module cycle

    at_current = (parser_version == parsing.PARSER_VERSION and calc_version == CALC_VERSION)

    total_units = len(units)
    for unit_index, unit in enumerate(units, start=1):
        cell: Cell = unit["cell"]
        if progress:
            progress(unit_index - 1, total_units, cell.name, "Reading cached cycle data")
        hashes, files = cell_ordered_hashes(db, cell)
        # caches are regenerable from source at any time — but only at the
        # CURRENT versions; renders pinned to old versions use what exists
        if at_current:
            for f in files:
                if (
                    not cache.has_cycles(f.hash, parser_version, calc_version)
                    and not cache.raw_path(f.hash, parser_version).exists()
                    and Path(f.path).exists()
                ):
                    scanner.parse_file(db, f)

        stitched, segments, missing = stitch.stitch_cycles(hashes, parser_version, calc_version)
        step_targets = _protocol_step_targets(files, protocol_context, badges, cell)
        protocol_cycles = _protocol_cycle_sets(
            files,
            segments,
            parser_version,
            step_targets,
            protocol_context,
            badges,
            cell,
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
            badges.append(
                {"kind": "cache_missing", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": f"No cache at parser {parser_version} / calc {calc_version} for "
                 f"file {h[:12]}…; recompute to regenerate."})
        if cell.archived:
            badges.append(
                {"kind": "cell_archived", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": "Cell is archived (soft-deleted); still rendering from cache."})

        exclusion = exclusion_for_unit(exclusions, unit)
        group_hidden = unit["group_id"] in hidden_group_ids
        excluded = exclusion is not None or group_hidden
        active_mass_mg = cell_active_mass_mg(cell)
        if stitched.empty:
            x: list[int] = []
            quantities = {c: [] for c in quantity_cols}
            metrics = {"n_cycles": 0}
            ref = None
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

        cell_series.append(
            {"cell_id": cell.id, "cell_name": cell.name, "label": unit["label"],
             "group_id": unit["group_id"], "group_name": unit["group_name"],
             "excluded": excluded,
             "exclusion_reason": "Replicate hidden" if group_hidden else (exclusion or {}).get("reason"),
             "archived": cell.archived, "x": x, "quantities": quantities,
             "metrics": metrics, "retention_reference_mah": ref,
             "active_mass_mg": active_mass_mg,
             "segments": segments})
        sources.append(
            {"cell_id": cell.id, "test_ids": [t.id for t in sorted(cell.tests, key=lambda t: t.id)],
             "file_hashes": hashes})
        if progress:
            progress(unit_index, total_units, cell.name, "Cycle data ready")

    _append_unmatched_protocol_badges(protocol_context, badges)

    for miss in missing_refs:
        badges.append({"kind": "missing_reference",
                       "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists."})

    # version badges — reactive information, never silent mutation
    if parser_version != parsing.PARSER_VERSION:
        badges.append({"kind": "newer_parser",
                       "detail": f"Computed with parser {parser_version}; {parsing.PARSER_VERSION} available — recompute?"})
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
        "parser_version": parser_version,
        "calc_version": calc_version,
        "current_parser_version": parsing.PARSER_VERSION,
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


def _stitch_raw(
    ordered_hashes: list[str], parser_version: str
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    frames: list[pd.DataFrame] = []
    segments: list[dict] = []
    missing: list[str] = []
    offset = 0
    for i, h in enumerate(ordered_hashes):
        df = cache.load_raw(h, parser_version)
        if df is None:
            missing.append(h)
            continue
        df = df.copy()
        if len(df) and "cycle" in df.columns:
            first, last = int(df["cycle"].min()), int(df["cycle"].max())
            df["cycle"] = df["cycle"] - first + 1 + offset
            segments.append(
                {
                    "file_hash": h,
                    "segment": i,
                    "cycle_start": offset + 1,
                    "cycle_end": offset + (last - first + 1),
                }
            )
            offset += last - first + 1
        df["segment"] = i
        df["source_hash"] = h
        frames.append(df)
    if not frames:
        return pd.DataFrame(), segments, missing
    return pd.concat(frames, ignore_index=True), segments, missing


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
) -> dict:
    parser_version = parsing.PARSER_VERSION
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        parser_version = provenance.get("parser_version") or parser_version
        calc_version = provenance.get("calc_version") or calc_version

    computation = spec.get("computation", {})
    settings = time_capacity_settings(computation)
    selection = spec.get("selection", {})
    exclusions = selection.get("exclusions", [])
    hidden_group_ids = set(selection.get("hidden_replicate_group_ids", []))
    units, missing_refs = resolve_selection(db, spec)
    protocol_context, protocol_badges = _protocol_filter_context(spec)

    from . import scanner

    at_current = parser_version == parsing.PARSER_VERSION
    traces: list[dict] = []
    badges: list[dict] = list(protocol_badges)

    configured_max = max(100, settings["max_points_per_cell"])
    width = max(320, min(6000, int(viewport_width or 1200)))
    total_units = len(units)
    total_returned_points = 0

    for unit_index, unit in enumerate(units, start=1):
        cell: Cell = unit["cell"]
        if progress:
            progress(unit_index - 1, total_units, cell.name, "Reading raw cache")
        hashes, files = cell_ordered_hashes(db, cell)
        if at_current:
            for f in files:
                if not cache.raw_path(f.hash, parser_version).exists() and Path(f.path).exists():
                    scanner.parse_file(db, f)

        step_targets = _protocol_step_targets(files, protocol_context, badges, cell)
        raw, segments, missing = _stitch_raw(hashes, parser_version)
        for h in missing:
            badges.append(
                {
                    "kind": "cache_missing",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "detail": f"No raw cache at parser {parser_version} for file {h[:12]}...",
                }
            )
        if raw.empty or "cycle" not in raw.columns:
            continue

        if settings["cycles"]:
            raw = raw[raw["cycle"].isin(settings["cycles"])]
        else:
            if settings["cycle_start"] is not None:
                raw = raw[raw["cycle"] >= int(settings["cycle_start"])]
            if settings["cycle_end"] is not None:
                raw = raw[raw["cycle"] <= int(settings["cycle_end"])]

        raw = raw.sort_values(["cycle", "segment", "record_index"] if "record_index" in raw.columns else ["cycle", "segment"])
        raw = _continuous_time(raw)
        phases = _phase_from_raw(raw)
        capacity = _phase_capacity(raw, phases)
        active_mass_mg = cell_active_mass_mg(cell)
        nominal_capacity_mah = cell_nominal_capacity_mah(cell)
        electrode_area_cm2 = cell_electrode_area_cm2(cell)
        active_mass_g = active_mass_mg / 1000.0 if active_mass_mg else None
        capacity_g = capacity / active_mass_g if active_mass_g and active_mass_g > 0 else np.full(len(raw), np.nan)
        derivative_x, derivative_y = _derivative_curve(
            raw, phases, capacity, capacity_g, settings
        )

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

        voltage = (
            raw["voltage_v"].to_numpy(dtype="float64").copy()
            if "voltage_v" in raw.columns
            else np.full(len(raw), np.nan)
        )
        current = (
            raw["current_ma"].to_numpy(dtype="float64").copy()
            if "current_ma" in raw.columns
            else np.full(len(raw), np.nan)
        )
        capacity = capacity.copy()
        capacity_g = capacity_g.copy()
        derivative_x = derivative_x.copy()
        derivative_y = derivative_y.copy()
        for values in (voltage, current, capacity, capacity_g, derivative_x, derivative_y):
            values[plot_mask] = np.nan

        display_x = _time_capacity_display_x(raw, phases, capacity, capacity_g, settings)
        if len(raw) > configured_max:
            envelope_series = (
                [derivative_x, derivative_y]
                if settings["view"] != "voltage_current"
                else [voltage]
            )
            primary_values = derivative_y if settings["view"] != "voltage_current" else voltage
            visible_values = ~plot_mask & np.isfinite(primary_values)
            take = _downsample_indices(
                len(raw), configured_max, visible_values, envelope_series
            )
            raw = raw.iloc[take]
            display_x = display_x[take]
            phases = np.asarray(phases)[take].tolist()
            voltage = voltage[take]
            current = current[take]
            capacity = capacity[take]
            capacity_g = capacity_g[take]
            derivative_x = derivative_x[take]
            derivative_y = derivative_y[take]

        full_precision = precision == "full" or not compact
        is_derivative = settings["view"] != "voltage_current"
        x_axis = settings["x_axis"]
        total_returned_points += len(raw)

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
                    if (not compact or (not is_derivative and x_axis == "time")) and "time_s" in raw.columns
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
                "voltage_v": _jsonsafe_plot(voltage, None if full_precision else 5) if not compact or not is_derivative else [],
                "current_ma": _jsonsafe_plot(current, None if full_precision else 5) if not compact or not is_derivative else [],
                "phase": phases,
                "status": _textsafe(raw["status"]) if not compact and "status" in raw.columns else [],
                "derivative_x": _jsonsafe_plot(derivative_x, None if full_precision else 7) if not compact or is_derivative else [],
                "derivative_y": _jsonsafe_plot(derivative_y, None if full_precision else 7) if not compact or is_derivative else [],
                "segments": segments,
            }
        )
        if progress:
            progress(unit_index, total_units, cell.name, "Plot data ready")

    _append_unmatched_protocol_badges(protocol_context, badges)

    for miss in missing_refs:
        badges.append(
            {
                "kind": "missing_reference",
                "detail": f"Selection references {miss['kind']} #{miss['ref_id']}, which no longer exists.",
            }
        )

    return {
        "computed_at": now_iso(),
        "type": spec.get("type", "cycling"),
        "parser_version": parser_version,
        "calc_version": calc_version,
        "current_parser_version": parsing.PARSER_VERSION,
        "current_calc_version": CALC_VERSION,
        "settings": settings,
        "cell_traces": traces,
        "badges": badges,
        "rendering": {
            "viewport_width": width,
            "configured_max_points_per_cell": configured_max,
            "max_points_per_cell": configured_max,
            "total_points": total_returned_points,
            "precision": precision,
            "compact": compact,
        },
    }


def build_provenance(result: dict) -> dict:
    return {
        "computed_at": result["computed_at"],
        "parser_version": result["parser_version"],
        "calc_version": result["calc_version"],
        "sources": result["sources"],
    }
