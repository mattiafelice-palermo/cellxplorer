"""Analysis engine.

Resolves a persisted analysis spec (a recipe) into rendered plot data:
per-cell cycle-level series first (always from versioned caches), then
aggregation computed on the fly at render time. Aggregation is a RENDERING,
never a stored dataset.

THE INVARIANT: an analysis never changes unless the user changes it.
Computation uses the parser/calc versions pinned in the analysis provenance;
anything newer/different is reported as a badge, never applied silently.
"""
from __future__ import annotations

import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..models import Cell, Group, GroupCell, SourceFile, Test
from . import cache, calc, parsing, stitch


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------- resolution


def cell_ordered_hashes(db: Session, cell: Cell) -> tuple[list[str], list[SourceFile]]:
    """All parsed source files of a cell: tests in order, files in order."""
    hashes: list[str] = []
    files: list[SourceFile] = []
    for test in sorted(cell.tests, key=lambda t: t.id):
        for link in sorted(test.file_links, key=lambda l: l.position):
            hashes.append(link.file.hash)
            files.append(link.file)
    return hashes, files


def resolve_selection(db: Session, spec: dict) -> tuple[list[dict], list[int]]:
    """Expand spec.selection.entries into ordered per-cell units.

    Group membership is resolved at compute time (groups are references);
    drift against provenance is reported as a badge by the caller.
    Returns (units, missing_ref_ids). Each unit:
      {cell, entry_kind, entry_ref_id, group_id, group_name, label, color}
    """
    units: list[dict] = []
    missing: list[int] = []
    seen: set[tuple[str, int, int]] = set()
    for entry in spec.get("selection", {}).get("entries", []):
        kind, ref_id = entry.get("kind"), entry.get("ref_id")
        label_override = entry.get("label_override")
        if kind == "cell":
            cell = db.get(Cell, ref_id)
            if cell is None:
                missing.append(ref_id)
                continue
            key = ("cell", ref_id, cell.id)
            if key in seen:
                continue
            seen.add(key)
            units.append(
                {
                    "cell": cell,
                    "entry_kind": "cell",
                    "entry_ref_id": ref_id,
                    "group_id": None,
                    "group_name": None,
                    "label": label_override or cell.name,
                    "color": entry.get("color"),
                }
            )
        elif kind == "group":
            group = db.get(Group, ref_id)
            if group is None:
                missing.append(ref_id)
                continue
            for link in sorted(group.cell_links, key=lambda l: l.position):
                cell = db.get(Cell, link.cell_id)
                if cell is None:
                    continue
                key = ("group", ref_id, cell.id)
                if key in seen:
                    continue
                seen.add(key)
                units.append(
                    {
                        "cell": cell,
                        "entry_kind": "group",
                        "entry_ref_id": ref_id,
                        "group_id": group.id,
                        "group_name": label_override or group.name,
                        "label": cell.name,
                        "color": group.color,
                    }
                )
    return units, missing


# ------------------------------------------------- series transformations


def apply_filters(df: pd.DataFrame, computation: dict) -> pd.DataFrame:
    rng = computation.get("cycle_range") or {}
    start, end = rng.get("start"), rng.get("end")
    if start is not None:
        df = df[df["cycle"] >= int(start)]
    if end is not None:
        df = df[df["cycle"] <= int(end)]
    for f in computation.get("filters", []):
        if f.get("kind") == "exclude_check_cycles":
            every_n = int(f.get("params", {}).get("every_n") or 0)
            if every_n > 1:
                df = df[df["cycle"] % every_n != 0]
    return df


def apply_normalization(y: pd.Series, x: pd.Series, computation: dict) -> tuple[pd.Series, bool]:
    """Returns (normalized series, normalized?)."""
    norm = computation.get("normalization") or {}
    kind = norm.get("kind") or "none"
    if kind == "none" or y.dropna().empty:
        return y, False
    if kind == "reference_cycle":
        ref_cycle = int(norm.get("params", {}).get("cycle") or 1)
        ref_vals = y[x == ref_cycle]
        ref = ref_vals.iloc[0] if len(ref_vals) else np.nan
        if not ref or np.isnan(ref):
            return y, False
        return y / ref * 100.0, True
    if kind == "first_cycle":
        first = y.dropna().iloc[0]
        return (y / first * 100.0, True) if first else (y, False)
    if kind == "max":
        m = y.max()
        return (y / m * 100.0, True) if m else (y, False)
    return y, False


DISPERSIONS = ("std", "sem", "minmax", "percentile")


def aggregate(
    cell_series: list[dict], aggregation: dict
) -> list[dict]:
    """Compute per-group mean ± dispersion band per cycle index at render
    time, over member cells minus exclusions. Tracks n(cycle); band only
    where n >= min_n_for_band; low-n points flagged for fading."""
    mode = aggregation.get("mode") or "none"
    if mode != "group_mean":
        return []
    dispersion = aggregation.get("dispersion") or "std"
    min_n = int(aggregation.get("min_n_for_band") or 2)

    by_group: dict[int, list[dict]] = {}
    for s in cell_series:
        if s["group_id"] is not None and not s["excluded"]:
            by_group.setdefault(s["group_id"], []).append(s)

    out = []
    for group_id, members in by_group.items():
        frames = [
            pd.DataFrame({"cycle": m["x"], f"y{i}": m["y"]}).set_index("cycle")
            for i, m in enumerate(members)
        ]
        wide = pd.concat(frames, axis=1).sort_index()
        vals = wide.to_numpy(dtype=float)
        n = np.sum(~np.isnan(vals), axis=1)
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            # single-replicate slices legitimately produce NaN dispersion
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(np.where(np.isnan(vals), np.nan, vals), axis=1)
            if dispersion == "sem":
                sd = np.nanstd(vals, axis=1, ddof=1)
                lo, hi = mean - sd / np.sqrt(np.maximum(n, 1)), mean + sd / np.sqrt(np.maximum(n, 1))
            elif dispersion == "minmax":
                lo, hi = np.nanmin(vals, axis=1), np.nanmax(vals, axis=1)
            elif dispersion == "percentile":
                lo = np.nanpercentile(vals, 10, axis=1)
                hi = np.nanpercentile(vals, 90, axis=1)
            else:  # std
                sd = np.nanstd(vals, axis=1, ddof=1)
                lo, hi = mean - sd, mean + sd

        max_n = int(n.max()) if len(n) else 0
        band_ok = n >= min_n
        out.append(
            {
                "group_id": group_id,
                "group_name": members[0]["group_name"],
                "color": members[0].get("color"),
                "x": [int(c) for c in wide.index],
                "mean": _jsonsafe(mean),
                "band_low": _jsonsafe(np.where(band_ok, lo, np.nan)),
                "band_high": _jsonsafe(np.where(band_ok, hi, np.nan)),
                "n": [int(v) for v in n],
                "max_n": max_n,
                "dispersion": dispersion,
                "min_n_for_band": min_n,
            }
        )
    return out


def _jsonsafe(arr) -> list:
    return [None if (v is None or (isinstance(v, float) and np.isnan(v))) else float(v) for v in arr]


# ----------------------------------------------------------- computation


def compute(db: Session, spec: dict, provenance: dict | None, use_current_versions: bool = False) -> dict:
    """Render an analysis. Uses provenance-pinned versions unless
    use_current_versions (explicit user recompute)."""
    parser_version = parsing.PARSER_VERSION
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        parser_version = provenance.get("parser_version") or parser_version
        calc_version = provenance.get("calc_version") or calc_version

    computation = spec.get("computation", {})
    quantity = computation.get("quantity") or "discharge_capacity"
    qty_col, qty_label = calc.QUANTITIES.get(quantity, calc.QUANTITIES["discharge_capacity"])

    excl = {e["cell_id"]: e for e in spec.get("selection", {}).get("exclusions", [])}
    units, missing_refs = resolve_selection(db, spec)

    cell_series: list[dict] = []
    sources: list[dict] = []
    badges: list[dict] = []
    normalized_any = False

    for unit in units:
        cell: Cell = unit["cell"]
        hashes, files = cell_ordered_hashes(db, cell)
        # ensure caches exist for files never parsed (parse on demand, at
        # current versions — only valid when versions requested are current)
        for f in files:
            if f.parse_status in ("unparsed", "error") and Path(f.path).exists():
                from . import scanner  # local import to avoid cycle

                scanner.parse_file(db, f)

        stitched, segments, missing = stitch.stitch_cycles(hashes, parser_version, calc_version)

        for f in files:
            if not Path(f.path).exists():
                if f.location_status != "offline":
                    f.location_status = "offline"
                    db.commit()
                badges.append(
                    {"kind": "source_offline", "cell_id": cell.id, "cell_name": cell.name,
                     "file": f.filename, "detail": "Source file not found at its last known "
                     "location. Rendering from cache; run a scan to relink by hash."}
                )
            elif f.location_status == "changed":
                badges.append(
                    {"kind": "source_changed", "cell_id": cell.id, "cell_name": cell.name,
                     "file": f.filename, "detail": "Source data changed since computed. Showing "
                     "cached result — use Recompute to update."}
                )
        for h in missing:
            badges.append(
                {"kind": "cache_missing", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": f"No cache at parser {parser_version} / calc {calc_version} for file "
                 f"{h[:12]}…; recompute to regenerate."}
            )
        if cell.archived:
            badges.append(
                {"kind": "cell_archived", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": "Cell is archived (soft-deleted); still rendering from cache."}
            )

        excluded = cell.id in excl
        if stitched.empty or qty_col not in stitched.columns:
            x: list = []
            y: list = []
        else:
            df = apply_filters(stitched[["cycle", qty_col]].dropna(subset=["cycle"]), computation)
            df = df.sort_values("cycle")
            ys, did_norm = apply_normalization(df[qty_col], df["cycle"], computation)
            normalized_any = normalized_any or did_norm
            x = [int(v) for v in df["cycle"]]
            y = _jsonsafe(ys.to_numpy(dtype=float))

        cell_series.append(
            {
                "cell_id": cell.id,
                "cell_name": cell.name,
                "label": unit["label"],
                "group_id": unit["group_id"],
                "group_name": unit["group_name"],
                "color": unit["color"],
                "excluded": excluded,
                "exclusion_reason": excl.get(cell.id, {}).get("reason"),
                "archived": cell.archived,
                "x": x,
                "y": y,
                "segments": segments,
            }
        )
        sources.append(
            {"cell_id": cell.id, "test_ids": [t.id for t in sorted(cell.tests, key=lambda t: t.id)],
             "file_hashes": hashes}
        )

    for ref in missing_refs:
        badges.append({"kind": "missing_reference", "detail": f"Selection references id {ref}, which no longer exists."})

    # version badges — reactive information, never silent mutation
    if parser_version != parsing.PARSER_VERSION:
        badges.append(
            {"kind": "newer_parser",
             "detail": f"Computed with parser {parser_version}; {parsing.PARSER_VERSION} available — recompute?"}
        )
    if calc_version != CALC_VERSION:
        badges.append(
            {"kind": "newer_calc",
             "detail": f"Computed with calc {calc_version}; {CALC_VERSION} available — recompute?"}
        )

    # membership drift vs provenance (badge only)
    if provenance and provenance.get("sources") is not None:
        prev = {s["cell_id"] for s in provenance["sources"]}
        cur = {s["cell_id"] for s in sources}
        added, removed = sorted(cur - prev), sorted(prev - cur)
        prev_hashes = {h for s in provenance["sources"] for h in s.get("file_hashes", [])}
        cur_hashes = {h for s in sources for h in s.get("file_hashes", [])}
        if added or removed:
            badges.append(
                {"kind": "selection_drift",
                 "detail": f"Referenced groups resolve differently than when last saved "
                 f"(+{len(added)} cell(s), −{len(removed)}). Save to accept.",
                 "added_cell_ids": added, "removed_cell_ids": removed}
            )
        elif prev_hashes != cur_hashes:
            badges.append(
                {"kind": "new_data",
                 "detail": "New source files are attached to selected cells since last computed."}
            )

    aggregation = spec.get("aggregation", {})
    aggregates = aggregate(cell_series, aggregation)

    y_label = spec.get("presentation", {}).get("axis_labels", {}).get("y") or (
        f"{qty_label}{' (normalized %)' if normalized_any else ''}"
    )

    return {
        "computed_at": now_iso(),
        "parser_version": parser_version,
        "calc_version": CALC_VERSION if use_current_versions else calc_version,
        "current_parser_version": parsing.PARSER_VERSION,
        "current_calc_version": CALC_VERSION,
        "quantity": quantity,
        "quantity_label": qty_label,
        "y_label": y_label,
        "normalized": normalized_any,
        "cell_series": cell_series,
        "aggregates": aggregates,
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


# --------------------------------------------------- refresh suggestions


def run_refresh_query(db: Session, query: dict) -> list[Cell]:
    """Re-run a recorded selection query. Selection gestures, not live
    queries: results only ever apply after explicit user confirmation."""
    from ..models import CellMetadata, CellTag, Tag

    q = db.query(Cell).filter(Cell.archived == False)  # noqa: E712
    text = (query.get("name_contains") or "").strip()
    if text:
        q = q.filter(Cell.name.ilike(f"%{text}%"))
    for tag_name in query.get("tags_all") or []:
        sub = (
            db.query(CellTag.cell_id)
            .join(Tag, Tag.id == CellTag.tag_id)
            .filter(Tag.name == tag_name)
            .scalar_subquery()
        )
        q = q.filter(Cell.id.in_(sub))
    for key, value in (query.get("metadata") or {}).items():
        sub = (
            db.query(CellMetadata.cell_id)
            .filter(CellMetadata.key == key, CellMetadata.value == str(value))
            .scalar_subquery()
        )
        q = q.filter(Cell.id.in_(sub))
    return q.order_by(Cell.name).all()
