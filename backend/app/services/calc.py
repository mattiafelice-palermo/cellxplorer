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
}


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
    else:
        is_chg = is_dchg = pd.Series(False, index=df.index)

    chg_cap = group_max("charge_capacity_mah")
    dchg_cap = group_max("discharge_capacity_mah")
    chg_e = group_max("charge_energy_mwh")
    dchg_e = group_max("discharge_energy_mwh")
    with np.errstate(divide="ignore", invalid="ignore"):
        ce = np.where(chg_cap != 0, dchg_cap / chg_cap * 100.0, np.nan)
        ee = np.where(chg_e != 0, dchg_e / chg_e * 100.0, np.nan)

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
            "start_timestamp": start_ts,
        }
    )
    return out[CYCLE_COLUMNS]
