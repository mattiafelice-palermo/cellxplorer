"""Group a raw time-series into occurrences of a user-chosen set of steps.

The cycle tabs aggregate at cycle granularity, so a protocol segment there can
only *filter which cycles are shown* — it cannot isolate a sub-cycle quantity
like "time spent in CV during fast charge". This module aggregates at the
granularity of a *block*: one execution of the selected steps. Plotting a
quantity per block is what makes that isolation possible.

Two block definitions, both offered because both are needed:

- ``union``: everything the selected steps run in one occurrence is one block,
  gaps included. This is what gives cumulative CV time across two CCCV steps
  separated by a rest.
- ``contiguous``: an occurrence is split further at every gap, so each maximal
  run of consecutive selected records is its own block — each CV step alone.

Occurrence boundaries key on re-entry to the lowest selected step rather than on
any decrease in step number, so a nested repeat inside the block (which makes
the step index non-monotonic within one occurrence) does not split it.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import calc

BLOCK_MODES = ("union", "contiguous")

BLOCK_COLUMNS = [
    "block",
    "occurrence",
    "cycle_start",
    "cycle_end",
    "step_start",
    "step_end",
    "start_time_h",
    "block_duration_h",
    "total_time_h",
    "charge_time_h",
    "discharge_time_h",
    "rest_time_h",
    "cv_charge_time_h",
    "cv_charge_capacity_mah",
    "charge_capacity_mah",
    "discharge_capacity_mah",
    "mean_voltage_v",
    "mean_charge_voltage_v",
    "mean_discharge_voltage_v",
    "n_steps",
]


def _step_column(df: pd.DataFrame) -> str | None:
    if "step_index" in df.columns:
        return "step_index"
    if "step" in df.columns:
        return "step"
    return None


def assign_blocks(
    df: pd.DataFrame, selected_steps: set[int], mode: str
) -> pd.DataFrame:
    """Return the selected records with an integer ``block`` and ``occurrence``.

    Records outside ``selected_steps`` are dropped. ``occurrence`` counts passes
    through the block; ``block`` equals ``occurrence`` in union mode and splits
    it at gaps in contiguous mode. Both are 1-based and gap-free.
    """
    step_col = _step_column(df)
    if step_col is None or not selected_steps or df.empty:
        return df.iloc[0:0].assign(block=pd.Series(dtype="int64"),
                                   occurrence=pd.Series(dtype="int64"))

    order = "record_index" if "record_index" in df.columns else None
    work = df.sort_values(order) if order else df
    work = work.reset_index(drop=True)

    steps = pd.to_numeric(work[step_col], errors="coerce")
    selected = steps.isin(selected_steps).to_numpy()
    if not selected.any():
        return work.iloc[0:0].assign(block=pd.Series(dtype="int64"),
                                     occurrence=pd.Series(dtype="int64"))

    positions = np.flatnonzero(selected)
    sel_steps = steps.to_numpy()[positions].astype("int64")
    min_step = int(min(selected_steps))

    prev_step = np.empty_like(sel_steps)
    prev_step[0] = -1
    prev_step[1:] = sel_steps[:-1]
    prev_pos = np.empty_like(positions)
    prev_pos[0] = positions[0] - 10
    prev_pos[1:] = positions[:-1]
    gap = (positions - prev_pos) > 1

    # A new occurrence begins when the lowest selected step is re-entered. Using
    # the minimum rather than any decrease is what survives nested repeats: an
    # inner "repeat 77-80" makes the step index fall back to 77 mid-occurrence,
    # but never to the block's first step, so it does not open a new occurrence.
    # The gap term handles a single-step selection, where consecutive
    # occurrences of that one step are told apart only by the unselected records
    # that run between them.
    occ_boundary = (sel_steps == min_step) & ((prev_step != min_step) | gap)
    occ_boundary[0] = True
    occurrence = np.cumsum(occ_boundary)

    if mode == "contiguous":
        block_boundary = occ_boundary | gap
        block_boundary[0] = True
        block = np.cumsum(block_boundary)
    else:
        block = occurrence

    result = work.iloc[positions].copy()
    result["block"] = block
    result["occurrence"] = occurrence
    return result


def _sum_step_time(frame: pd.DataFrame, step_col: str) -> float:
    """Hours across the frame's steps, using Neware's per-step Time reset.

    ``time_s`` restarts at each step, so ``max`` per (block, step) is that step's
    duration; summing excludes any gaps between steps.
    """
    if "time_s" not in frame.columns or frame.empty:
        return 0.0
    per_step = frame.groupby(step_col, sort=False)["time_s"].max()
    return float(per_step.sum()) / 3600.0


def _sum_step_capacity(frame: pd.DataFrame, column: str, step_col: str) -> float:
    """Capacity delivered across the frame's steps.

    Neware's capacity columns accumulate within a step and reset between them,
    so the per-step delta (max - min) summed over steps is the block total —
    robust whether the column resets per step or per cycle.
    """
    if column not in frame.columns or frame.empty:
        return 0.0
    total = 0.0
    for _, group in frame.groupby(step_col, sort=False):
        values = group[column].to_numpy(dtype="float64")
        finite = values[np.isfinite(values)]
        if len(finite):
            total += max(0.0, float(finite.max() - finite.min()))
    return total


def per_block(
    df: pd.DataFrame,
    selected_steps: set[int],
    mode: str,
    *,
    origin_timestamp: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """One row per block: durations, phase times, capacities and voltages."""
    if origin_timestamp is None and "timestamp" in df.columns:
        timestamps = pd.to_datetime(df["timestamp"], errors="coerce").dropna()
        if len(timestamps):
            origin_timestamp = timestamps.min()
    assigned = assign_blocks(df, selected_steps, mode)
    if assigned.empty:
        return pd.DataFrame(columns=BLOCK_COLUMNS)

    step_col = _step_column(assigned) or "step_index"
    status = assigned["status"].astype(str).str.lower() if "status" in assigned else pd.Series("", index=assigned.index)
    is_chg = status.str.contains("chg") & ~status.str.contains("dchg")
    is_dchg = status.str.contains("dchg")
    is_rest = status.str.contains("rest")

    # CV time and capacity are computed by the same routine the cycle path uses;
    # relabelling ``cycle`` to the block id makes its per-(cycle, step) grouping
    # act per block instead.
    cv_frame = assigned.copy()
    cv_frame["cycle"] = assigned["block"].to_numpy()
    block_index = pd.Index(sorted(assigned["block"].unique()), name="block")
    cv_time, cv_capacity, _events = calc._cv_charge_by_cycle(cv_frame, block_index)
    cv_by_block = dict(zip(block_index.to_numpy(), cv_time))
    cvcap_by_block = dict(zip(block_index.to_numpy(), cv_capacity))

    rows: list[dict] = []
    for block_id, group in assigned.groupby("block", sort=True):
        mask_chg = is_chg.loc[group.index]
        mask_dchg = is_dchg.loc[group.index]
        mask_rest = is_rest.loc[group.index]
        duration_h = np.nan
        start_time_h = np.nan
        if "timestamp" in group.columns:
            stamps = pd.to_datetime(group["timestamp"], errors="coerce").dropna()
            if len(stamps):
                duration_h = (stamps.max() - stamps.min()).total_seconds() / 3600.0
                if origin_timestamp is not None:
                    start_time_h = (
                        stamps.min() - origin_timestamp
                    ).total_seconds() / 3600.0

        def mean_voltage(mask: pd.Series) -> float:
            if "voltage_v" not in group.columns:
                return np.nan
            values = group.loc[mask, "voltage_v"].dropna()
            return float(values.mean()) if len(values) else np.nan

        charge_time_h = _sum_step_time(group[mask_chg.to_numpy()], step_col)
        discharge_time_h = _sum_step_time(group[mask_dchg.to_numpy()], step_col)
        rows.append(
            {
                "block": int(block_id),
                "occurrence": int(group["occurrence"].iloc[0]),
                "cycle_start": int(group["cycle"].min()) if "cycle" in group else 0,
                "cycle_end": int(group["cycle"].max()) if "cycle" in group else 0,
                "step_start": int(group[step_col].min()),
                "step_end": int(group[step_col].max()),
                "start_time_h": start_time_h,
                "block_duration_h": duration_h,
                "total_time_h": charge_time_h + discharge_time_h,
                "charge_time_h": charge_time_h,
                "discharge_time_h": discharge_time_h,
                "rest_time_h": _sum_step_time(group[mask_rest.to_numpy()], step_col),
                "cv_charge_time_h": float(cv_by_block.get(block_id, 0.0)),
                "cv_charge_capacity_mah": float(cvcap_by_block.get(block_id, 0.0)),
                "charge_capacity_mah": _sum_step_capacity(group[mask_chg.to_numpy()], "charge_capacity_mah", step_col),
                "discharge_capacity_mah": _sum_step_capacity(group[mask_dchg.to_numpy()], "discharge_capacity_mah", step_col),
                "mean_voltage_v": mean_voltage(pd.Series(True, index=group.index)),
                "mean_charge_voltage_v": mean_voltage(mask_chg),
                "mean_discharge_voltage_v": mean_voltage(mask_dchg),
                "n_steps": int(group[step_col].nunique()),
            }
        )
    return pd.DataFrame(rows, columns=BLOCK_COLUMNS)
