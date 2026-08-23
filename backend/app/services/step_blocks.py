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

    # Selective raw reads retain the canonical record index even though rows
    # outside the requested steps are omitted.  Use it for gap detection so a
    # filtered frame has the same occurrence/contiguous boundaries as the
    # complete raw frame.
    if "record_index" in work.columns:
        record_positions = pd.to_numeric(
            work["record_index"], errors="coerce"
        ).to_numpy()
    else:
        record_positions = np.arange(len(work), dtype="int64")

    prev_step = np.empty_like(sel_steps)
    prev_step[0] = -1
    prev_step[1:] = sel_steps[:-1]
    selected_records = record_positions[positions]
    prev_pos = np.empty_like(selected_records)
    prev_pos[0] = selected_records[0] - 10
    prev_pos[1:] = selected_records[:-1]
    gap = (selected_records - prev_pos) > 1

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


def _aggregate_block_rows(
    assigned: pd.DataFrame,
    step_col: str,
    is_chg: np.ndarray,
    is_dchg: np.ndarray,
    is_rest: np.ndarray,
    *,
    origin_timestamp: pd.Timestamp | None,
    cv_by_block: dict[int, float],
    cvcap_by_block: dict[int, float],
) -> list[dict]:
    """Aggregate blocks from one normalized frame using compact ranges.

    ``assign_blocks`` returns rows in record order, so each block is a compact
    range. Keeping that representation avoids rebuilding a pandas group frame
    for every phase and capacity quantity while preserving the block-local
    step-reset semantics.
    """

    length = len(assigned)

    def numeric_column(column: str) -> np.ndarray:
        if column not in assigned.columns:
            return np.full(length, np.nan, dtype="float64")
        return pd.to_numeric(assigned[column], errors="coerce").to_numpy(
            dtype="float64"
        )

    block_values = pd.to_numeric(assigned["block"], errors="coerce").to_numpy(
        dtype="int64"
    )
    step_values = pd.to_numeric(assigned[step_col], errors="coerce").to_numpy(
        dtype="float64"
    )
    occurrence_values = numeric_column("occurrence")
    cycle_values = numeric_column("cycle")
    time_values = numeric_column("time_s")
    voltage_values = numeric_column("voltage_v")
    charge_capacity_values = numeric_column("charge_capacity_mah")
    discharge_capacity_values = numeric_column("discharge_capacity_mah")
    timestamp_values = (
        pd.to_datetime(assigned["timestamp"], errors="coerce").to_numpy()
        if "timestamp" in assigned.columns
        else None
    )

    block_starts = np.flatnonzero(
        np.r_[True, block_values[1:] != block_values[:-1]]
    )
    block_ends = np.r_[block_starts[1:], length]

    def sum_step_time(start: int, end: int, mask: np.ndarray) -> float:
        selected = mask[start:end]
        steps = step_values[start:end][selected]
        times = time_values[start:end][selected]
        valid_step = ~np.isnan(steps)
        if not valid_step.any():
            return 0.0
        steps = steps[valid_step]
        times = times[valid_step]
        unique_steps, inverse = np.unique(steps, return_inverse=True)
        maxima = np.full(len(unique_steps), -np.inf, dtype="float64")
        valid_time = ~np.isnan(times)
        np.maximum.at(maxima, inverse[valid_time], times[valid_time])
        seen = np.zeros(len(unique_steps), dtype=bool)
        seen[inverse[valid_time]] = True
        return float(maxima[seen].sum()) / 3600.0

    def sum_step_capacity(
        start: int,
        end: int,
        mask: np.ndarray,
        values: np.ndarray,
    ) -> float:
        selected = mask[start:end]
        steps = step_values[start:end][selected]
        capacities = values[start:end][selected]
        valid = ~np.isnan(steps) & np.isfinite(capacities)
        if not valid.any():
            return 0.0
        steps = steps[valid]
        capacities = capacities[valid]
        unique_steps, inverse = np.unique(steps, return_inverse=True)
        minima = np.full(len(unique_steps), np.inf, dtype="float64")
        maxima = np.full(len(unique_steps), -np.inf, dtype="float64")
        np.minimum.at(minima, inverse, capacities)
        np.maximum.at(maxima, inverse, capacities)
        return float(np.maximum(0.0, maxima - minima).sum())

    def mean_value(values: np.ndarray, mask: np.ndarray | None = None) -> float:
        selected = values if mask is None else values[mask]
        selected = selected[~np.isnan(selected)]
        return float(selected.mean()) if len(selected) else np.nan

    def int_value(value: float) -> int:
        return int(value) if not np.isnan(value) else 0

    origin = pd.Timestamp(origin_timestamp) if origin_timestamp is not None else None
    rows: list[dict] = []
    for start, end in zip(block_starts, block_ends):
        start = int(start)
        end = int(end)
        block_id = int(block_values[start])
        block_steps = step_values[start:end]
        valid_steps = block_steps[~np.isnan(block_steps)]
        cycle_slice = cycle_values[start:end]
        valid_cycles = cycle_slice[~np.isnan(cycle_slice)]
        duration_h = np.nan
        start_time_h = np.nan
        if timestamp_values is not None:
            stamps = timestamp_values[start:end]
            valid_stamps = stamps[~pd.isna(stamps)]
            if len(valid_stamps):
                timestamp_min = pd.Timestamp(valid_stamps.min())
                timestamp_max = pd.Timestamp(valid_stamps.max())
                duration_h = (
                    timestamp_max - timestamp_min
                ).total_seconds() / 3600.0
                if origin is not None:
                    start_time_h = (
                        timestamp_min - origin
                    ).total_seconds() / 3600.0
        charge_time_h = sum_step_time(start, end, is_chg)
        discharge_time_h = sum_step_time(start, end, is_dchg)
        rest_time_h = sum_step_time(start, end, is_rest)
        rows.append(
            {
                "block": block_id,
                "occurrence": int_value(occurrence_values[start]),
                "cycle_start": int(valid_cycles.min()) if len(valid_cycles) else 0,
                "cycle_end": int(valid_cycles.max()) if len(valid_cycles) else 0,
                "step_start": int(valid_steps.min()) if len(valid_steps) else 0,
                "step_end": int(valid_steps.max()) if len(valid_steps) else 0,
                "start_time_h": start_time_h,
                "block_duration_h": duration_h,
                "total_time_h": charge_time_h + discharge_time_h,
                "charge_time_h": charge_time_h,
                "discharge_time_h": discharge_time_h,
                "rest_time_h": rest_time_h,
                "cv_charge_time_h": float(cv_by_block.get(block_id, 0.0)),
                "cv_charge_capacity_mah": float(cvcap_by_block.get(block_id, 0.0)),
                "charge_capacity_mah": sum_step_capacity(
                    start, end, is_chg, charge_capacity_values
                ),
                "discharge_capacity_mah": sum_step_capacity(
                    start, end, is_dchg, discharge_capacity_values
                ),
                "mean_voltage_v": mean_value(voltage_values[start:end]),
                "mean_charge_voltage_v": mean_value(
                    voltage_values[start:end], is_chg[start:end]
                ),
                "mean_discharge_voltage_v": mean_value(
                    voltage_values[start:end], is_dchg[start:end]
                ),
                "n_steps": int(len(np.unique(valid_steps))),
            }
        )
    return rows


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
    cv_columns = [
        column
        for column in (
            "cycle",
            "status",
            "step",
            "step_index",
            "record_index",
            "time_s",
            "voltage_v",
            "current_ma",
            "charge_capacity_mah",
        )
        if column in assigned.columns
    ]
    cv_frame = assigned.loc[:, cv_columns].copy()
    cv_frame["cycle"] = assigned["block"].to_numpy()
    block_index = pd.Index(sorted(assigned["block"].unique()), name="block")
    cv_time, cv_capacity, _events = calc._cv_charge_by_cycle(cv_frame, block_index)
    cv_by_block = dict(zip(block_index.to_numpy(), cv_time))
    cvcap_by_block = dict(zip(block_index.to_numpy(), cv_capacity))
    rows = _aggregate_block_rows(
        assigned,
        step_col,
        is_chg.to_numpy(dtype=bool),
        is_dchg.to_numpy(dtype=bool),
        is_rest.to_numpy(dtype=bool),
        origin_timestamp=origin_timestamp,
        cv_by_block={int(key): float(value) for key, value in cv_by_block.items()},
        cvcap_by_block={int(key): float(value) for key, value in cvcap_by_block.items()},
    )
    return pd.DataFrame(rows, columns=BLOCK_COLUMNS)
