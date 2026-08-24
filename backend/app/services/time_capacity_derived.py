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
            # The shared transform contract retains phase for the established
            # engine and all alternate display modes. The narrow production
            # worker path applies its stricter consecutive-only omission after
            # resolving this common request shape.
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


def consecutive_capacity_display(
    values: np.ndarray,
    phases: list[str] | np.ndarray,
    *,
    reset_ids: list[object] | np.ndarray | None = None,
    initial_offset: float = 0.0,
) -> np.ndarray:
    """Concatenate capacity progress in acquisition order.

    ``phase_capacity`` is intentionally cycle/phase-local scientific data:
    counters can restart at every active phase.  A consecutive plot needs a
    separate display coordinate, so each contiguous active run is translated
    to the end of the preceding run while preserving its internal shape.
    Neutral rows hold the current coordinate.  Same-direction rows remain in
    one run even when the source step/segment changes; when ``reset_ids`` is
    supplied, a change in the scientific reset identity (normally the global
    cycle) starts a new local-origin segment without resetting the running
    display offset.  Source boundaries that retain the same identity remain
    one segment.

    ``initial_offset`` carries an owner-resolved prefix for bounded
    refinement requests whose selected rows begin after the overview origin.
    It is display-only and never changes the scientific capacity vector.
    """

    source = np.asarray(values, dtype="float64")
    phase_values = np.asarray(phases, dtype=object)
    if source.ndim != 1 or len(source) != len(phase_values):
        raise ValueError("capacity values and phases must be one-dimensional and aligned")
    reset_values = None if reset_ids is None else np.asarray(reset_ids, dtype=object)
    if reset_values is not None and (reset_values.ndim != 1 or len(reset_values) != len(source)):
        raise ValueError("capacity reset identities must be one-dimensional and aligned")
    try:
        offset = float(initial_offset)
    except (TypeError, ValueError):
        offset = 0.0
    if not np.isfinite(offset):
        offset = 0.0

    output = np.full(len(source), np.nan, dtype="float64")
    active_phase: str | None = None
    active_reset_id: object = None
    segment_origin = np.nan
    segment_has_value = False
    segment_base = offset
    segment_last = offset
    for index, (value, phase) in enumerate(zip(source, phase_values, strict=True)):
        phase_name = str(phase)
        if phase_name not in {"charge", "discharge"}:
            # A neutral row does not consume capacity and therefore preserves
            # the last active endpoint, including the initial zero origin.
            if active_phase is not None:
                offset = segment_last
            output[index] = offset
            active_phase = None
            active_reset_id = None
            segment_origin = np.nan
            segment_has_value = False
            continue

        reset_id = None
        if reset_values is not None:
            candidate = reset_values[index]
            try:
                numeric = float(candidate)
            except (TypeError, ValueError):
                numeric = np.nan
            if np.isfinite(numeric) and numeric.is_integer():
                reset_id = int(numeric)
            elif candidate is not None and not (isinstance(candidate, float) and np.isnan(candidate)):
                reset_id = str(candidate)

        reset_boundary = reset_values is not None and active_reset_id != reset_id
        if active_phase != phase_name or reset_boundary:
            if active_phase is not None:
                offset = segment_last
            active_phase = phase_name
            active_reset_id = reset_id
            segment_origin = np.nan
            segment_has_value = False
            segment_base = offset
            segment_last = offset

        if not np.isfinite(value):
            # Preserve the established NaN behavior for an active row with no
            # capacity sample; the next finite sample still starts this same
            # active segment.
            continue
        if not segment_has_value:
            segment_origin = float(value)
            segment_has_value = True
        coordinate = segment_base + float(value) - segment_origin
        output[index] = coordinate
        # Keep the last finite point, rather than a maximum, so small genuine
        # within-segment decreases are not smoothed away at a boundary.
        segment_last = coordinate

    if active_phase is not None:
        offset = segment_last

    return output


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
