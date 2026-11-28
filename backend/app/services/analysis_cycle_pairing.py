"""Pair measured phases for analysis and preview without changing recorded cycle identities."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import cache, calc, stitch, time_capacity_derived


def enabled(computation: dict) -> bool:
    return computation.get("cycle_pairing") in ("discharge_charge", "charge_discharge")


def missing_programmed_phases(refs, segments, cross_source_cycles=()):
    """Check uncounted BioLogic sources only; a rest-only source needs no prompt."""
    from .biologic_quantities import measured_phase_facts

    first_seen = initial_discharge = missing_active = has_charge = has_discharge = False
    for ref, segment in zip(refs, segments):
        if not ref.parser_version.startswith("bm:"):
            first_seen = True
            continue
        index = cache.try_load_raw_layout_index(ref.file_hash, ref.parser_version) or {}
        facts = index.get("biologic_measured_phases")
        if facts is None:
            cols = ["status", "current_ma", "cycle_complete"]
            if index and "cycle_complete" not in index.get("raw_column_names", ()):
                cols.pop()
            rows = cache.load_raw_columns(ref.file_hash, ref.parser_version, cols)
            facts = measured_phase_facts(rows) if rows is not None else {}
        if facts:
            has_charge |= facts["charge"]
            has_discharge |= facts["discharge"]
            if not first_seen:
                initial_discharge = (facts["first"] == "discharge" and not facts["first_complete"]
                                     and segment.get("cycle_start") not in cross_source_cycles)
                first_seen = True
            missing_active |= not segment.get("source_cycle_count")
    return missing_active and has_charge and has_discharge, initial_discharge


def run_boundaries(raw, biologic_segments):
    """EC-Lab linked files share an acquisition origin, even across technique changes."""
    if not biologic_segments or not {"timestamp", "total_time_s"}.issubset(raw.columns):
        return ()
    first = raw.drop_duplicates("segment").set_index("segment").sort_index()
    origin = (pd.to_datetime(first.timestamp, utc=True, errors="coerce")
              - pd.to_timedelta(first.total_time_s, unit="s")).dt.round("ms")
    origin = origin.where(origin.index.isin(biologic_segments))
    return origin.index[origin.notna() & origin.shift().notna() & origin.ne(origin.shift())]


def measurements(refs, *, charge_first=False):
    raw, segments, missing = stitch.stitch_raw(refs)
    if raw.empty or missing:
        return raw, segments, missing
    biologic = [i for i, ref in enumerate(refs) if ref.parser_version.startswith("bm:")]
    raw = label_pairs(raw, charge_first=charge_first, boundaries=run_boundaries(raw, biologic),
                      measured_only=len(biologic) == len(refs))
    for descriptor in segments:
        labels = raw.loc[raw.segment.eq(descriptor["segment"]) & raw.cycle_complete, "cycle"]
        descriptor["cycle_start"] = int(labels.min()) if len(labels) else None
        descriptor["cycle_end"] = int(labels.max()) if len(labels) else None
    return raw, segments, missing


def label_pairs(raw: pd.DataFrame, *, charge_first=False, boundaries=(), measured_only=False) -> pd.DataFrame:
    # Stitch supplies acquisition order, including interleaved GCPL executions.
    # Keep it when filtering; all unpaired rows carry the display-only label 0.
    phase = pd.Series(time_capacity_derived.phase_from_raw(raw), index=raw.index)
    status = raw.get("status", pd.Series("", index=raw.index)).astype("string").fillna("")
    neutral = status.str.lower().isin(["rest", "ocv"])
    phase = phase.mask(neutral, "rest")
    current = pd.to_numeric(raw.get("current_ma", pd.Series(np.nan, index=raw.index)), errors="coerce")
    discharge_status = calc.status_matches(status, "dchg", "discharge")
    charge_status = calc.status_matches(status, "chg", "charge") & ~discharge_status
    contradictory = (discharge_status & current.gt(0)) | (charge_status & current.lt(0))
    unknown = contradictory | phase.eq("unverified") | (phase.eq("rest") & ~neutral & current.isna())
    if charge_first or measured_only:
        # An inferred half needs measured current in its declared direction.
        active = phase.isin(["charge", "discharge"])
        unknown |= active & ~np.isfinite(current)
        phase = phase.mask(active & current.eq(0), "rest")
    phase = phase.mask(unknown, "unverified")
    breaks = unknown | (raw.segment.ne(raw.segment.shift()) & raw.segment.isin(boundaries))
    for column in ("mpr_acquisition_segment", "acquisition_segment"):
        if column in raw:
            acquisition = raw[column]
            breaks |= raw.segment.eq(raw.segment.shift()) & acquisition.notna() & acquisition.ne(acquisition.shift())
    block = breaks.cumsum()
    direction = phase.where(phase.isin(["charge", "discharge"])).groupby(block).ffill()
    first, second = ("charge", "discharge") if charge_first else ("discharge", "charge")
    starts = direction.eq(first) & (~direction.shift().eq(first) | breaks)
    candidate = starts.cumsum().where(direction.notna() & ~unknown)
    # Both polarities must occur in order within one uninterrupted block.
    group = raw.groupby([block, candidate], sort=False).ngroup()
    complete = group.isin(group[starts]) & group.isin(group[direction.eq(second)])
    labels = np.zeros(len(raw), dtype=np.int64)
    labels[complete] = pd.factorize(group[complete], sort=False)[0] + 1
    result = raw.assign(cycle=labels, cycle_complete=complete, display_only_cycle=~complete,
                      _stitch_order=np.arange(len(raw)))
    if charge_first:
        active = phase[phase.isin(["charge", "discharge"])]
        result.attrs["initial_discharge_omitted"] = bool(len(active) and active.iloc[0] == "discharge")
    return result


def detection_note(raw, *, charge_first=True):
    if not raw.cycle_complete.any():
        return "No complete pair was found in this order."
    if not charge_first:
        return "Cycles detected from current, pairing each discharge with the following charge."
    note = "Cycles detected from current, pairing each charge with the following discharge."
    if raw.attrs.get("initial_discharge_omitted"):
        note += " The initial discharge is excluded from cycle totals and remains in the time plot."
    return note


def summary(raw: pd.DataFrame) -> pd.DataFrame:
    if raw.empty:
        return calc.per_cycle(raw)
    rows = raw.loc[raw.cycle_complete].copy()
    if "step" in rows:
        # Independent files can reuse the same executed step number.
        rows["step"] = rows.groupby(["segment", "source_cycle", "step"], sort=False).ngroup()
    result = calc.per_cycle(rows)
    if result.empty:
        return result
    phases = np.asarray(time_capacity_derived.phase_from_raw(rows))
    for direction in ("charge", "discharge"):
        active = phases == direction
        for suffix in ("capacity_mah", "energy_mwh"):
            column = f"{direction}_{suffix}"
            if column in rows:
                invalid = active & ~np.isfinite(pd.to_numeric(rows[column], errors="coerce"))
                result.loc[result.cycle.isin(rows.loc[invalid, "cycle"]), column] = np.nan
    for metric, efficiency in (("capacity_mah", "coulombic_efficiency_pct"),
                               ("energy_mwh", "energy_efficiency_pct")):
        charge = result[f"charge_{metric}"]
        result[efficiency] = 100 * result[f"discharge_{metric}"] / charge.where(charge > 0)
    # A cross-file pair has no single original file or programmed cycle.
    origin = rows.groupby("cycle")[[key for key in ("segment", "source_cycle", "source_hash") if key in rows]]
    owners = origin.first().where(origin.nunique().eq(1))
    owners.loc[owners.segment.isna(), "source_cycle"] = np.nan
    return result.join(owners, on="cycle")
