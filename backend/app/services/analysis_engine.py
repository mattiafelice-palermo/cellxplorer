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

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..models import Cell, ReplicateGroup, SourceFile
from . import cache, calc, parsing, stitch

SPEC_VERSION = 5

# quantities served to the client: every cached per-cycle column plus
# derived ones computed here at render time
DERIVED_QUANTITIES = {
    "voltaic_efficiency": ("voltaic_efficiency_pct", "Voltaic efficiency (%)"),
    "capacity_retention": ("capacity_retention_pct", "Capacity retention / SoH (%)"),
    "discharge_capacity_loss": ("discharge_capacity_loss_mah", "Discharge capacity loss (mAh/cycle)"),
    "charge_capacity_loss": ("charge_capacity_loss_mah", "Charge capacity loss (mAh/cycle)"),
}

ALL_QUANTITIES: dict[str, tuple[str, str]] = {**calc.QUANTITIES, **DERIVED_QUANTITIES}


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
        "selection": {"entries": [], "exclusions": []},
        "computation": {
            "cycle_range": {"start": 1, "end": None},
            "exclude_check_cycles_every_n": 0,
            # SoH reference: max discharge capacity within the first n cycles
            # (mode "cycle" pins an explicit reference cycle instead)
            "retention_reference": {"mode": "max_first_n", "n": 5, "cycle": None},
            # cycles treated as formation and excluded from steady-state means
            "formation_cycles": 3,
        },
        "aggregation": {"mode": "replicate_mean", "dispersion": "std", "min_n_for_band": 2},
        "presentation": {
            "quantity": "discharge_capacity",
            "ce_overlay": True,
            "show_individual_cells": True,
            "legend": True,
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
                 "label": label_override or cell.name}
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
                     "group_name": label_override or group.name, "label": cell.name}
                )
    return units, missing


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


def add_derived_columns(frame: pd.DataFrame, computation: dict) -> tuple[pd.DataFrame, float]:
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


def _jsonsafe(arr) -> list:
    out = []
    for v in np.asarray(arr, dtype="float64"):
        out.append(None if np.isnan(v) else float(v))
    return out


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


def compute(db: Session, spec: dict, provenance: dict | None, use_current_versions: bool = False) -> dict:
    parser_version = parsing.PARSER_VERSION
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        parser_version = provenance.get("parser_version") or parser_version
        calc_version = provenance.get("calc_version") or calc_version

    computation = spec.get("computation", {})
    aggregation = spec.get("aggregation", {})
    excl = {e["cell_id"]: e for e in spec.get("selection", {}).get("exclusions", [])}
    units, missing_refs = resolve_selection(db, spec)

    quantity_cols = [col for col, _ in ALL_QUANTITIES.values()]
    cell_series: list[dict] = []
    sources: list[dict] = []
    badges: list[dict] = []

    from . import scanner  # local import to avoid a module cycle

    at_current = (parser_version == parsing.PARSER_VERSION and calc_version == CALC_VERSION)

    for unit in units:
        cell: Cell = unit["cell"]
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

        excluded = cell.id in excl
        if stitched.empty:
            x: list[int] = []
            quantities = {c: [] for c in quantity_cols}
            metrics = {"n_cycles": 0}
            ref = None
        else:
            derived, ref_val = add_derived_columns(stitched, computation)
            filtered = apply_filters(derived, computation).sort_values("cycle")
            x = [int(v) for v in filtered["cycle"]]
            quantities = {
                c: _jsonsafe(filtered[c].to_numpy(dtype="float64")) if c in filtered.columns
                else [None] * len(x)
                for c in quantity_cols
            }
            metrics = cell_metrics(derived, filtered, computation, ref_val)
            ref = None if np.isnan(ref_val) else float(ref_val)

        cell_series.append(
            {"cell_id": cell.id, "cell_name": cell.name, "label": unit["label"],
             "group_id": unit["group_id"], "group_name": unit["group_name"],
             "excluded": excluded, "exclusion_reason": excl.get(cell.id, {}).get("reason"),
             "archived": cell.archived, "x": x, "quantities": quantities,
             "metrics": metrics, "retention_reference_mah": ref,
             "segments": segments})
        sources.append(
            {"cell_id": cell.id, "test_ids": [t.id for t in sorted(cell.tests, key=lambda t: t.id)],
             "file_hashes": hashes})

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
            for key, (col, label) in ALL_QUANTITIES.items()
        ],
        "cell_series": cell_series,
        "aggregates": aggregates,
        "group_metrics": group_metrics,
        "badges": badges,
        "sources": sources,
    }


def build_provenance(result: dict) -> dict:
    return {
        "computed_at": result["computed_at"],
        "parser_version": result["parser_version"],
        "calc_version": result["calc_version"],
        "sources": result["sources"],
    }
