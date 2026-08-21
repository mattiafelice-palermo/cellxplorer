"""Shared exact phase/capacity transforms for Time/Capacity requests.

The request path and the optional prepared-derived cache must use the same
scientific implementation.  This module intentionally has no cache or ORM
dependencies so it can be used while a canonical raw frame is being
published and while an interactive request is using the exact fallback.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import calc


PHASE_CODE_REST = 0
PHASE_CODE_CHARGE = 1
PHASE_CODE_DISCHARGE = 2
PHASE_TO_CODE = {
    "rest": PHASE_CODE_REST,
    "charge": PHASE_CODE_CHARGE,
    "discharge": PHASE_CODE_DISCHARGE,
}
CODE_TO_PHASE = {
    PHASE_CODE_REST: "rest",
    PHASE_CODE_CHARGE: "charge",
    PHASE_CODE_DISCHARGE: "discharge",
}


@dataclass(frozen=True)
class TimeCapacityTransformNeeds:
    """Minimum exact transforms consumed by one Time/Capacity projection."""

    continuous_time: bool
    phase: bool
    phase_capacity: bool
    specific_capacity: bool
    areal_capacity: bool

    @classmethod
    def for_request(
        cls,
        settings: dict,
        *,
        precision: str,
        compact: bool,
    ) -> "TimeCapacityTransformNeeds":
        full_response = precision == "full" or not compact
        normal_view = settings.get("view") == "voltage_current"
        x_axis = settings.get("x_axis")
        derivative = not normal_view
        capacity_axis = normal_view and x_axis in {
            "capacity_mah",
            "capacity_mah_g",
            "capacity_mah_cm2",
        }
        return cls(
            continuous_time=full_response or (normal_view and x_axis == "time"),
            # The response always emits phase for compact requests and the
            # derivative/protocol paths also consume it.
            phase=True,
            phase_capacity=full_response or derivative or capacity_axis,
            specific_capacity=(
                full_response
                or (derivative and bool(settings.get("derivative_specific")))
                or (normal_view and x_axis == "capacity_mah_g")
            ),
            areal_capacity=full_response or (normal_view and x_axis == "capacity_mah_cm2"),
        )


def phase_from_raw(frame: pd.DataFrame) -> list[str]:
    """Return charge/discharge/rest per row using the canonical phase rule."""

    n = len(frame)
    if "status" in frame.columns:
        status = frame["status"]
        has_dchg = pd.Series(calc.status_matches(status, "dchg", "discharge"), index=frame.index)
        has_chg = pd.Series(calc.status_matches(status, "chg", "charge"), index=frame.index)
    else:
        has_dchg = pd.Series(False, index=frame.index)
        has_chg = pd.Series(False, index=frame.index)
    if "current_ma" in frame.columns:
        cur = frame["current_ma"].to_numpy(dtype="float64")
    else:
        cur = np.full(n, np.nan)
    with np.errstate(invalid="ignore"):
        is_dchg = has_dchg.to_numpy() | (cur < 0)
        is_chg = ~is_dchg & (has_chg.to_numpy() | (cur > 0))
    return np.select([is_dchg, is_chg], ["discharge", "charge"], default="rest").tolist()


def phase_capacity(frame: pd.DataFrame, phases: list[str]) -> np.ndarray:
    """Return exact cumulative phase capacity across counter resets."""

    n = len(frame)
    charge = (
        frame["charge_capacity_mah"].to_numpy(dtype="float64")
        if "charge_capacity_mah" in frame.columns
        else np.full(n, np.nan)
    )
    discharge = (
        frame["discharge_capacity_mah"].to_numpy(dtype="float64")
        if "discharge_capacity_mah" in frame.columns
        else np.full(n, np.nan)
    )
    phase_arr = np.asarray(phases)
    with np.errstate(invalid="ignore"):
        best = np.where(
            np.isnan(charge),
            discharge,
            np.where(np.isnan(discharge), charge, np.maximum(charge, discharge)),
        )
    raw_cap = np.where(
        (phase_arr == "discharge") & ~np.isnan(discharge),
        discharge,
        np.where((phase_arr == "charge") & ~np.isnan(charge), charge, best),
    )

    cycles = (
        frame["cycle"].to_numpy() if "cycle" in frame.columns else np.zeros(n, dtype="int64")
    )
    out = raw_cap.copy()
    carry = 0.0
    prev_val = np.nan
    prev_key: tuple | None = None
    for i in range(n):
        key = (cycles[i], phase_arr[i])
        val = raw_cap[i]
        if key != prev_key:
            carry = 0.0
            prev_val = np.nan
            prev_key = key
        if not np.isnan(val):
            # A large decrease is a step-counter reset; small noisy decreases
            # remain part of the original counter semantics.
            if not np.isnan(prev_val) and val < prev_val and val < prev_val * 0.5:
                carry += prev_val
            prev_val = val
            out[i] = val + carry
    return out


def encode_phases(phases: list[str]) -> np.ndarray:
    """Encode canonical phase strings into the stable sidecar code mapping."""

    return np.asarray([PHASE_TO_CODE.get(str(value), PHASE_CODE_REST) for value in phases], dtype="int8")


def decode_phases(values: object) -> list[str] | None:
    """Decode and validate prepared phase codes, failing closed on bad data."""

    try:
        numeric = np.asarray(values)
    except (TypeError, ValueError):
        return None
    decoded: list[str] = []
    for value in numeric:
        try:
            integer = int(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if integer not in CODE_TO_PHASE:
            return None
        decoded.append(CODE_TO_PHASE[integer])
    return decoded
