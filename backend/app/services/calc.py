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
    "start_timestamp",
]

# user-selectable quantities for analyses
QUANTITIES = {
    "discharge_capacity": ("discharge_capacity_mah", "Discharge capacity (mAh)"),
    "charge_capacity": ("charge_capacity_mah", "Charge capacity (mAh)"),
    "coulombic_efficiency": ("coulombic_efficiency_pct", "Coulombic efficiency (%)"),
    "discharge_energy": ("discharge_energy_mwh", "Discharge energy (mWh)"),
    "charge_energy": ("charge_energy_mwh", "Charge energy (mWh)"),
    "energy_efficiency": ("energy_efficiency_pct", "Energy efficiency (%)"),
    "mean_charge_voltage": ("mean_charge_voltage_v", "Mean charge voltage (V)"),
    "mean_discharge_voltage": ("mean_discharge_voltage_v", "Mean discharge voltage (V)"),
}


def per_cycle(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse a raw time-series into one row per cycle."""
    if df.empty or "cycle" not in df.columns:
        return pd.DataFrame(columns=CYCLE_COLUMNS)

    is_chg = df["status"].str.contains("Chg", case=False) & ~df["status"].str.contains(
        "DChg", case=False
    ) if "status" in df.columns else pd.Series(False, index=df.index)
    is_dchg = df["status"].str.contains("DChg", case=False) if "status" in df.columns else pd.Series(
        False, index=df.index
    )

    rows = []
    for cyc, g in df.groupby("cycle", sort=True):
        chg_cap = float(g["charge_capacity_mah"].max()) if "charge_capacity_mah" in g else np.nan
        dchg_cap = float(g["discharge_capacity_mah"].max()) if "discharge_capacity_mah" in g else np.nan
        chg_e = float(g["charge_energy_mwh"].max()) if "charge_energy_mwh" in g else np.nan
        dchg_e = float(g["discharge_energy_mwh"].max()) if "discharge_energy_mwh" in g else np.nan

        gc = g[is_chg.reindex(g.index, fill_value=False)]
        gd = g[is_dchg.reindex(g.index, fill_value=False)]
        rows.append(
            {
                "cycle": int(cyc),
                "charge_capacity_mah": chg_cap,
                "discharge_capacity_mah": dchg_cap,
                "coulombic_efficiency_pct": (dchg_cap / chg_cap * 100.0) if chg_cap else np.nan,
                "charge_energy_mwh": chg_e,
                "discharge_energy_mwh": dchg_e,
                "energy_efficiency_pct": (dchg_e / chg_e * 100.0) if chg_e else np.nan,
                "mean_charge_voltage_v": float(gc["voltage_v"].mean()) if len(gc) else np.nan,
                "mean_discharge_voltage_v": float(gd["voltage_v"].mean()) if len(gd) else np.nan,
                "start_timestamp": g["timestamp"].min() if "timestamp" in g else pd.NaT,
            }
        )
    return pd.DataFrame(rows, columns=CYCLE_COLUMNS)
