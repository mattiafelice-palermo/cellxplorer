"""Derived per-cycle quantities, versioned by CALC_VERSION (config.py).

Given a raw time-series DataFrame (parsing.RAW_COLUMNS names), produce one
row per cycle with capacities, energies, coulombic/energy efficiency and
simple voltage statistics.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

CYCLE_COLUMNS = [
    "cycle",
    "charge_capacity_mah",
    "discharge_capacity_mah",
    "coulombic_efficiency_pct",
    "charge_energy_mwh",
    "discharge_energy_mwh",
    "energy_efficiency_pct",
    "mean_charge_voltage_v",
    "mean_discharge_voltage_v",
    "first_charge_voltage_v",
    "last_charge_voltage_v",
    "first_discharge_voltage_v",
    "last_discharge_voltage_v",
    "cycle_duration_h",
    "charge_time_h",
    "discharge_time_h",
    "cv_charge_time_h",
    "cv_charge_capacity_mah",
    "cv_charge_fraction_pct",
    "cv_charge_event_count",
    "cv_reached",
    "start_timestamp",
]

# user-selectable quantities for analyses (cached per-cycle columns)
QUANTITIES = {
    "discharge_capacity": ("discharge_capacity_mah", "Discharge capacity (mAh)"),
    "charge_capacity": ("charge_capacity_mah", "Charge capacity (mAh)"),
    "coulombic_efficiency": ("coulombic_efficiency_pct", "Coulombic efficiency (%)"),
    "discharge_energy": ("discharge_energy_mwh", "Discharge energy (mWh)"),
    "charge_energy": ("charge_energy_mwh", "Charge energy (mWh)"),
    "energy_efficiency": ("energy_efficiency_pct", "Energy efficiency (%)"),
    "mean_charge_voltage": ("mean_charge_voltage_v", "Mean charge voltage (V)"),
    "mean_discharge_voltage": ("mean_discharge_voltage_v", "Mean discharge voltage (V)"),
    "cycle_duration": ("cycle_duration_h", "Cycle duration (h)"),
    "charge_time": ("charge_time_h", "Charge time (h)"),
    "discharge_time": ("discharge_time_h", "Discharge time (h)"),
    "cv_charge_time": ("cv_charge_time_h", "CV charge time (h)"),
    "cv_charge_capacity": ("cv_charge_capacity_mah", "CV charge capacity (mAh)"),
    "cv_charge_fraction": ("cv_charge_fraction_pct", "CV charge fraction (%)"),
    "cv_charge_events": ("cv_charge_event_count", "CV charge events"),
    "cv_reached": ("cv_reached", "CV reached"),
}


def status_matches(status: pd.Series, *needles: str) -> np.ndarray:
    """True where the lower-cased status contains any of `needles`.

    Status is a categorical quantity stored as text: a 523 000-row file carries
    four distinct values. Testing each row costs ~60 ms; testing the distinct
    values and mapping back costs ~8 ms for the same answer.

    `Series.str.contains` defaults to `regex=True`, but every needle used in this
    codebase is regex-inert, so plain substring matching is equivalent. A needle
    containing a regex metacharacter would NOT behave the same here — use a
    literal substring, or restore `str.contains` for that call.

    A missing status becomes the string "nan" and matches nothing, which is what
    the previous `.astype(str)` produced.
    """
    codes, uniques = pd.factorize(status, sort=False)
    lowered = [str(value).lower() for value in uniques]
    flags = np.array(
        [any(needle in value for needle in needles) for value in lowered], dtype=bool
    )
    if len(flags) == 0:
        return np.zeros(len(status), dtype=bool)
    # factorize marks unknown/NA as -1; those must not wrap around to flags[-1].
    matched = np.zeros(len(codes), dtype=bool)
    known = codes >= 0
    matched[known] = flags[codes[known]]
    return matched


def _cv_charge_by_cycle(df: pd.DataFrame, cycle_index: pd.Index) -> tuple[np.ndarray, ...]:
    """Measure charge transferred and time spent in CV per cycle.

    Explicit CV_Chg steps are direct. A combined CCCV_Chg step is considered
    to have reached CV only when at least two records sit at the terminal
    voltage plateau and the absolute current measurably tapers.

    The per-(cycle, step) walk below indexes numpy arrays rather than pandas
    sub-frames: the decisions are unchanged, but building a sub-frame per group
    cost ~0.75 ms × 200 groups and made this function 77 % of `per_cycle`.
    """
    zeros = np.zeros(len(cycle_index), dtype="float64")
    if not {"cycle", "status"}.issubset(df.columns):
        return zeros.copy(), zeros.copy(), zeros.copy()

    status = df["status"]
    charge_cv = status_matches(status, "cv_chg", "cv charge")
    if not charge_cv.any():
        return zeros.copy(), zeros.copy(), zeros.copy()

    step_key = "step" if "step" in df.columns else "step_index" if "step_index" in df.columns else None
    work = df
    if step_key is None:
        work = df.copy()
        work["__step"] = 0
        step_key = "__step"

    # `cccv` is a property of the status text, so decide it once for the column.
    is_cccv = status_matches(status, "cccv")

    order_cols = [col for col in ("record_index", "time_s") if col in work.columns]
    if order_cols:
        # Reproduces `sort_values(["cycle", step, *order_cols])` on the full frame
        # before the CV rows are selected. lexsort takes keys last-significant
        # first, hence the reversal.
        keys = tuple(
            work[col].to_numpy() for col in reversed(["cycle", step_key, *order_cols])
        )
        order = np.lexsort(keys)
        work = work.take(order)
        charge_cv = charge_cv[order]
        is_cccv = is_cccv[order]

    cycle_arr = work["cycle"].to_numpy()[charge_cv]
    step_arr = work[step_key].to_numpy()[charge_cv]
    cccv_arr = is_cccv[charge_cv]

    def _column(name: str) -> np.ndarray | None:
        if name not in work.columns:
            return None
        return work[name].to_numpy(dtype="float64")[charge_cv]

    voltage_arr = _column("voltage_v")
    current_arr = _column("current_ma")
    time_arr = _column("time_s")
    capacity_arr = _column("charge_capacity_mah")

    # Contiguous blocks per (cycle, step), preserving order within each block.
    cycle_codes, _ = pd.factorize(cycle_arr, sort=False)
    step_codes, step_uniques = pd.factorize(step_arr, sort=False)
    pair = cycle_codes.astype("int64") * (len(step_uniques) or 1) + step_codes.astype("int64")
    block_order = np.argsort(pair, kind="stable")
    pair_sorted = pair[block_order]
    starts = np.flatnonzero(np.r_[True, pair_sorted[1:] != pair_sorted[:-1]])
    ends = np.r_[starts[1:], len(pair_sorted)]

    cycle_position = {int(cycle): index for index, cycle in enumerate(cycle_index)}
    times = np.zeros(len(cycle_index), dtype="float64")
    capacities = np.zeros(len(cycle_index), dtype="float64")
    events = np.zeros(len(cycle_index), dtype="float64")

    for lo, hi in zip(starts, ends):
        rows = block_order[lo:hi]
        region = rows
        if cccv_arr[rows].any():
            if voltage_arr is None or current_arr is None:
                continue
            voltage = voltage_arr[rows]
            current = np.abs(current_arr[rows])
            finite_voltage = np.isfinite(voltage)
            finite_current = np.isfinite(current)
            if finite_voltage.sum() < 2 or finite_current.sum() < 2:
                continue
            target = float(voltage[finite_voltage].max())
            tolerance = max(0.002, abs(target) * 0.0005)
            positions = np.flatnonzero(finite_voltage & (voltage >= target - tolerance))
            if len(positions) < 2:
                continue
            head = current[finite_current][: min(5, int(finite_current.sum()))]
            initial_current = float(np.median(head))
            plateau_current = current[positions]
            taper = initial_current > 0 and np.nanmin(plateau_current) <= initial_current * 0.98
            if not taper:
                continue
            region = rows[positions[0] : positions[-1] + 1]

        duration_h = 0.0
        if time_arr is not None:
            finite = time_arr[region]
            finite = finite[np.isfinite(finite)]
            if len(finite):
                duration_h = max(0.0, float(finite.max() - finite.min())) / 3600.0
        capacity_mah = 0.0
        if capacity_arr is not None:
            finite = capacity_arr[region]
            finite = finite[np.isfinite(finite)]
            if len(finite):
                # The step's own delta. A dedicated CV step restarts the counter
                # at 0, so this equals its max; taking the delta also stays
                # correct if a file ever carries the count over from the CC step.
                capacity_mah = max(0.0, float(finite.max() - finite.min()))

        position = cycle_position.get(int(cycle_arr[rows[0]]))
        if position is None:
            continue
        times[position] += duration_h
        capacities[position] += capacity_mah
        events[position] += 1

    return times, capacities, events


def per_cycle(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse a raw time-series into one row per cycle.

    Fully vectorized: whole-frame groupby aggregations, no per-cycle Python
    loop. Efficiency ratios follow the original semantics: NaN when the
    charge-side value is 0 (or NaN, which propagates).
    """
    if df.empty or "cycle" not in df.columns:
        return pd.DataFrame(columns=CYCLE_COLUMNS)

    grouped = df.groupby("cycle", sort=True)
    index = grouped.size().index

    def group_max(col: str) -> np.ndarray:
        if col in df.columns:
            return grouped[col].max().to_numpy(dtype="float64")
        return np.full(len(index), np.nan)

    def masked_voltage_mean(mask: pd.Series) -> np.ndarray:
        if "voltage_v" not in df.columns:
            return np.full(len(index), np.nan)
        means = df.loc[mask].groupby("cycle")["voltage_v"].mean()
        return means.reindex(index).to_numpy(dtype="float64")

    def masked_voltage_endpoint(mask: pd.Series, which: str) -> np.ndarray:
        if "voltage_v" not in df.columns:
            return np.full(len(index), np.nan)
        sub = df.loc[mask, ["cycle", "voltage_v"]].dropna(subset=["voltage_v"])
        if sub.empty:
            return np.full(len(index), np.nan)
        grouped_voltage = sub.groupby("cycle", sort=True)["voltage_v"]
        values = grouped_voltage.first() if which == "first" else grouped_voltage.last()
        return values.reindex(index).to_numpy(dtype="float64")

    if "status" in df.columns:
        has_chg = df["status"].str.contains("Chg", case=False)
        has_dchg = df["status"].str.contains("DChg", case=False)
        is_chg, is_dchg = has_chg & ~has_dchg, has_dchg
        chg_rows, dchg_rows = is_chg, is_dchg
    else:
        is_chg = is_dchg = pd.Series(False, index=df.index)
        # Without a status column the phase cannot be identified, but each
        # capacity/energy column is phase-specific and reads 0 outside its own
        # phase, so summing every step is safe.
        chg_rows = dchg_rows = pd.Series(True, index=df.index)

    def phase_total(col: str, mask: pd.Series) -> np.ndarray:
        """Charge/energy delivered in one phase per cycle.

        Neware's capacity and energy counters accumulate within a step and
        reset to zero at each step boundary: a CCCV charge written as separate
        CC and CV steps restarts the counter at the CV hold. A per-cycle
        maximum therefore reports only the largest single step, dropping the
        rest of the phase — which understates capacity and, because the
        discharge is usually a single step while the charge is not, inflates
        coulombic efficiency above 100%.

        Summing each step's (max - min) delta is correct whether or not the
        counter resets: on reset the min is 0, and without one the delta is
        still that step's own contribution.
        """
        if col not in df.columns:
            return np.full(len(index), np.nan)
        if "step" not in df.columns:
            # No step boundaries available; the per-cycle max is the best guess.
            return grouped[col].max().to_numpy(dtype="float64")
        sub = df.loc[mask, ["cycle", "step", col]]
        if sub.empty:
            return np.zeros(len(index), dtype="float64")
        per_step = sub.groupby(["cycle", "step"], sort=False)[col].agg(["min", "max"])
        delta = (per_step["max"] - per_step["min"]).clip(lower=0.0)
        totals = delta.groupby(level="cycle").sum()
        return totals.reindex(index).fillna(0.0).to_numpy(dtype="float64")

    chg_cap = phase_total("charge_capacity_mah", chg_rows)
    dchg_cap = phase_total("discharge_capacity_mah", dchg_rows)
    chg_e = phase_total("charge_energy_mwh", chg_rows)
    dchg_e = phase_total("discharge_energy_mwh", dchg_rows)
    cv_time, cv_capacity, cv_events = _cv_charge_by_cycle(df, index)
    with np.errstate(divide="ignore", invalid="ignore"):
        ce = np.where(chg_cap != 0, dchg_cap / chg_cap * 100.0, np.nan)
        ee = np.where(chg_e != 0, dchg_e / chg_e * 100.0, np.nan)
        cv_fraction = np.where(chg_cap != 0, cv_capacity / chg_cap * 100.0, np.nan)

    if "timestamp" in df.columns:
        start_ts = grouped["timestamp"].min().to_numpy()
        cycle_duration = (
            (grouped["timestamp"].max() - grouped["timestamp"].min())
            .dt.total_seconds()
            .to_numpy(dtype="float64")
            / 3600.0
        )
    else:
        start_ts = np.full(len(index), np.datetime64("NaT", "s"))
        cycle_duration = np.full(len(index), np.nan)

    def masked_step_time(mask: pd.Series) -> np.ndarray:
        """Duration spent in the masked steps per cycle, in hours.

        Neware's Time column resets at each step start, so max(time_s) per
        (cycle, step) is that step's duration; summing over the cycle's
        masked steps excludes rests/pauses between phases."""
        if "time_s" not in df.columns or "step" not in df.columns:
            return np.full(len(index), np.nan)
        sub = df.loc[mask, ["cycle", "step", "time_s"]]
        if sub.empty:
            return np.full(len(index), np.nan)
        per_step = sub.groupby(["cycle", "step"], sort=False)["time_s"].max()
        per_cycle = per_step.groupby(level="cycle").sum() / 3600.0
        return per_cycle.reindex(index).to_numpy(dtype="float64")

    out = pd.DataFrame(
        {
            "cycle": index.to_numpy().astype("int64"),
            "charge_capacity_mah": chg_cap,
            "discharge_capacity_mah": dchg_cap,
            "coulombic_efficiency_pct": ce,
            "charge_energy_mwh": chg_e,
            "discharge_energy_mwh": dchg_e,
            "energy_efficiency_pct": ee,
            "mean_charge_voltage_v": masked_voltage_mean(is_chg),
            "mean_discharge_voltage_v": masked_voltage_mean(is_dchg),
            "first_charge_voltage_v": masked_voltage_endpoint(is_chg, "first"),
            "last_charge_voltage_v": masked_voltage_endpoint(is_chg, "last"),
            "first_discharge_voltage_v": masked_voltage_endpoint(is_dchg, "first"),
            "last_discharge_voltage_v": masked_voltage_endpoint(is_dchg, "last"),
            "cycle_duration_h": cycle_duration,
            "charge_time_h": masked_step_time(is_chg),
            "discharge_time_h": masked_step_time(is_dchg),
            "cv_charge_time_h": cv_time,
            "cv_charge_capacity_mah": cv_capacity,
            "cv_charge_fraction_pct": cv_fraction,
            "cv_charge_event_count": cv_events,
            "cv_reached": (cv_events > 0).astype("float64"),
            "start_timestamp": start_ts,
        }
    )
    return out[CYCLE_COLUMNS]
