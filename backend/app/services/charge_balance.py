"""Recorded terminal charge since the first sample of an ordered Cell."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import calc, time_capacity_derived


def _number(value) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def calibration(settings: dict, cell_id: int) -> tuple[float | None, float | None]:
    """Resolve only this Cell's explicit reference, including a legitimate 0% start."""
    references = settings.get("references") or {}
    entry = references.get(str(cell_id), {}) if isinstance(references, dict) else {}
    if not isinstance(entry, dict):
        return None, None
    start = _number(entry.get("start_soc_pct"))
    if start is not None and not 0 <= start <= 100:
        start = None
    if entry.get("basis") == "mass":
        mass = _number(entry.get("mass_mg"))
        specific = _number(entry.get("specific_capacity_mah_g", 820))
        capacity = mass / 1000 * specific if mass and mass > 0 and specific and specific > 0 else None
    else:
        capacity = _number(entry.get("capacity_mah"))
    return start, capacity if capacity and math.isfinite(capacity) and capacity > 0 else None


def trajectory(raw: pd.DataFrame) -> pd.DataFrame:
    """Accumulate signed and absolute measured spans before any display selection.

    A canonical counter may continue or reset between executed steps. The
    first sample identifies its local origin, as in calc.per_cycle. Never
    difference across source/step boundaries or sum successive counter values.
    """
    def numeric(column):
        if column not in raw:
            return np.full(len(raw), np.nan)
        return pd.to_numeric(raw[column], errors="coerce").to_numpy(dtype=float)

    phases = np.asarray(time_capacity_derived.capacity_phases(raw, time_capacity_derived.phase_from_raw(raw)))
    charge, discharge = phases == "charge", phases == "discharge"
    active = charge | discharge
    current = numeric("current_ma")
    status = raw.get("status", pd.Series("", index=raw.index)).astype("string").fillna("")
    documented_rest = status.str.lower().isin(("rest", "ocv")).to_numpy(dtype=bool)
    neutral = (phases == "rest") & (documented_rest | (current == 0))
    counter = np.where(charge, numeric("charge_capacity_mah"), numeric("discharge_capacity_mah"))
    valid = neutral | (active & np.isfinite(counter) & (counter >= 0))
    discharge_status = calc.status_matches(status, "dchg", "discharge")
    charge_status = calc.status_matches(status, "chg", "charge") & ~discharge_status
    valid &= ~((charge_status & (current < 0)) | (discharge_status & (current > 0)))
    if "capacity_verified" in raw:
        rejected = raw["capacity_verified"].eq(False).fillna(False).to_numpy(dtype=bool)
        valid &= ~(rejected & ~neutral)

    # Only adjacent readings from the same executed counter share an origin.
    source = raw["segment"].to_numpy()
    step = numeric("step")
    same_source = source[1:] == source[:-1]
    same_step = same_source & (step[1:] == step[:-1]) & (phases[1:] == phases[:-1])
    valid &= ~active | np.isfinite(step)
    delta = np.zeros(len(raw))
    within = np.flatnonzero(same_step & active[1:]) + 1
    delta[within] = counter[within] - counter[within - 1]
    valid &= delta >= -1e-9
    delta = np.maximum(delta, 0.)

    # Across omitted acquisitions or MB operation changes the adapters do
    # not attribute the intervening transfer. A continuous execution counter
    # can cover skipped records within that same execution.
    record = numeric("record_index")
    gap = same_source & (np.diff(record) > 1)
    for column in ("acquisition_segment", "mpr_acquisition_segment"):
        if column in raw:
            acquisition = numeric(column)
            changed = np.isfinite(acquisition[1:]) & np.isfinite(acquisition[:-1]) & (np.diff(acquisition) != 0)
            # CP can mark recorded protocol loop boundaries with no omitted samples.
            cp = raw.get("measurement_type", pd.Series("", index=raw.index)).eq("biologic_cp").fillna(False).to_numpy(dtype=bool)
            gap |= same_source & changed & ~cp[1:]
    valid[1:] &= ~(gap & ~same_step)
    if "biologic_mb_time_s" in raw:
        mb_clock = numeric("biologic_mb_time_s")
        valid[1:] &= ~(same_source & ~same_step & (np.diff(mb_clock) > 0))
    delta[~valid] = np.nan
    return raw.assign(
        charge_balance_mah=np.cumsum(np.where(discharge, -delta, delta)),
        charge_throughput_mah=np.cumsum(delta),
        _balance_row=np.arange(len(raw)),
    )
