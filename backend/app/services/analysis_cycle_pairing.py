"""Analysis-only discharge followed by charge, on the ordered Cell measurements."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import calc, stitch, time_capacity_derived


def enabled(computation: dict) -> bool:
    return computation.get("cycle_pairing") == "discharge_charge"


def measurements(refs):
    raw, segments, missing = stitch.stitch_raw(refs)
    if raw.empty or missing:
        return raw, segments, missing
    raw = label_pairs(raw)
    for descriptor in segments:
        labels = raw.loc[raw.segment.eq(descriptor["segment"]) & raw.cycle_complete, "cycle"]
        descriptor["cycle_start"] = int(labels.min()) if len(labels) else None
        descriptor["cycle_end"] = int(labels.max()) if len(labels) else None
    return raw, segments, missing


def label_pairs(raw: pd.DataFrame) -> pd.DataFrame:
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
    phase = phase.mask(unknown, "unverified")
    breaks = unknown.copy()
    if "mpr_acquisition_segment" in raw:
        acquisition = raw["mpr_acquisition_segment"]
        breaks |= raw.segment.eq(raw.segment.shift()) & acquisition.notna() & acquisition.ne(acquisition.shift())
    block = breaks.cumsum()
    direction = phase.where(phase.isin(["charge", "discharge"])).groupby(block).ffill()
    starts = direction.eq("discharge") & (~direction.shift().eq("discharge") | breaks)
    candidate = starts.cumsum().where(direction.notna() & ~unknown)
    # A candidate is complete only when its charge is observed in the same block.
    group = raw.groupby([block, candidate], sort=False).ngroup()
    complete = group.isin(group[starts]) & group.isin(group[direction.eq("charge")])
    labels = np.zeros(len(raw), dtype=np.int64)
    labels[complete] = pd.factorize(group[complete], sort=False)[0] + 1
    return raw.assign(cycle=labels, cycle_complete=complete, display_only_cycle=~complete,
                      _stitch_order=np.arange(len(raw)))


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
    origin = rows.groupby("cycle")[["segment", "source_cycle", "source_hash"]]
    owners = origin.first().where(origin.nunique().eq(1))
    owners.loc[owners.segment.isna(), "source_cycle"] = np.nan
    return result.join(owners, on="cycle")
