"""Measured MB cycling rows, isolated from impedance operations.

The first interval of each recorded operation is deliberately unassigned:
its charge may have crossed a mode/sequence boundary or an omitted EIS run.
No absolute counter difference ever bridges that boundary.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import canonical_cycling
from .biologic_mpr import InvalidMprError, MB_CONTROL_ENERGY_BASES
from .biologic_quantities import record_limitations


NOTICE = (
    "BioLogic MB: EIS operations are excluded from curves and capacity. "
    "Capacity uses recorded increments within each operation; boundary intervals "
    "are omitted. Cycle summaries require adjacent opposite-current half-cycles."
)


class _QuantityUnavailable(ValueError):
    """The retained records do not establish this scientific quantity."""


def _step_capacity(
    time: np.ndarray, dq: np.ndarray, counter: np.ndarray,
    direction: np.ndarray, boundary: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    if not np.isfinite(dq).all() or not np.isfinite(counter).all():
        raise _QuantityUnavailable("Cycling charge counters contain unavailable values.")
    interior = ~boundary
    usable = interior & (direction != 0)
    if (direction[usable] * dq[usable] < -1e-7).any():
        raise _QuantityUnavailable("BioLogic MB incremental charge contradicts measured current")
    counter_delta = np.r_[0, np.diff(counter)]
    if not np.isclose(counter_delta[interior], dq[interior], rtol=1e-3, atol=1e-6).all():
        raise _QuantityUnavailable("BioLogic MB charge counter and recorded increments disagree within an operation")
    if (np.abs(dq[interior & (direction == 0)]) > 1e-7).any():
        raise _QuantityUnavailable("BioLogic MB neutral interior interval contains charge transfer")
    zero_duration = interior & np.r_[False, np.diff(time) == 0]
    if (np.abs(dq[zero_duration]) > 1e-7).any():
        raise _QuantityUnavailable("BioLogic MB zero-duration interior interval contains charge transfer")
    charge = np.zeros(len(time))
    discharge = np.zeros(len(time))
    for start, end in zip(np.flatnonzero(boundary), np.r_[np.flatnonzero(boundary)[1:], len(time)]):
        if direction[start] == 0:
            continue
        increments = np.maximum(direction[start] * dq[start:end], 0)
        increments[0] = 0
        transferred = np.cumsum(increments)
        (charge if direction[start] > 0 else discharge)[start:end] = transferred

    return charge, discharge


def _cycle_labels(half: np.ndarray, direction: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if (np.diff(half) < 0).any():
        raise _QuantityUnavailable("BioLogic MB half-cycle identity regresses")
    signs = {}
    half_starts = np.flatnonzero(np.r_[True, np.diff(half) != 0])
    for start, end in zip(half_starts, np.r_[half_starts[1:], len(half)]):
        h = half[start]
        active = set(direction[start:end].tolist()) - {0}
        if len(active) > 1:
            raise _QuantityUnavailable("BioLogic MB half-cycle contains contradictory current directions")
        signs[int(h)] = next(iter(active), 0)
    cycle = half // 2 + 1
    complete_ids = {h // 2 + 1 for h in signs if h % 2 == 0 and
                    signs[h] != 0 and signs.get(h + 1) == -signs[h]}
    return cycle, np.isin(cycle, list(complete_ids))


def _align_restart_counters(records, ns, mode, half, direction, time):
    """Use the independent Q-Q0 reset to align a one-record late half-cycle."""
    counter = records["raw_q_charge_discharge_mAh"].copy()
    dq = records["raw_dq_mAh"]
    relative = records["raw_q_minus_q0_mAh"]
    # i is the first sample after a rest. The sequence switches there,
    # whereas the half index and signed counter switch on the next sample.
    candidates = 1 + np.flatnonzero(
        (mode[:-2] == 3) & (mode[1:-1] == 1) & (mode[2:] == 1)
        & (ns[:-2] != ns[1:-1]) & (ns[1:-1] == ns[2:])
        & (half[:-2] == half[1:-1]) & (half[2:] == half[1:-1] + 1)
        & (direction[1:-1] != 0) & (direction[1:-1] == direction[2:])
        & (time[1:-1] < time[2:])
    )
    for i in candidates:
        if (dq[i] == 0 and relative[i] == 0 and counter[i] == counter[i - 1]
                and counter[i] * direction[i] < 0 and dq[i + 1] * direction[i] > 0
                and np.isclose(relative[i + 1], dq[i + 1], rtol=1e-6, atol=1e-9)
                and np.isclose(counter[i + 1], dq[i + 1], rtol=1e-6, atol=1e-9)):
            half[i] = half[i + 1]
            counter[i] = relative[i]
    return counter


def map_mb_to_canonical(document) -> pd.DataFrame:
    records = document.vmp_data.records
    if records is None or not len(records):
        raise InvalidMprError("BioLogic MB measurement records are unavailable")

    def values(name):
        a = np.asarray(records[name], dtype=float)
        if not np.isfinite(a).all():
            raise InvalidMprError(f"BioLogic MB {name} must be finite")
        return a

    time = values("elapsed_time_s")
    if (time < 0).any() or (np.diff(time) < 0).any():
        raise InvalidMprError("BioLogic MB acquisition clock must be non-negative and monotonic")
    ns = values("raw_sample_index").astype(np.int64)
    half = values("raw_half_cycle_index").astype(np.int64)
    flags = records["raw_flags"]
    mode = flags & 3
    freq = values("raw_frequency_hz") if "raw_frequency_hz" in records.dtype.names else np.zeros(len(records))
    if (freq < 0).any():
        raise InvalidMprError("BioLogic MB frequency must be non-negative")
    # Exclude the whole Ns execution, including zero-frequency boundary rows.
    executions = np.cumsum(np.r_[True, np.diff(ns) != 0])
    eis_executions = np.unique(executions[freq > 0])
    keep = ~np.isin(executions, eis_executions)
    if not keep.any():
        raise InvalidMprError("BioLogic MB contains only EIS operations")
    if ((flags[keep] & 8) != 0).any():
        raise InvalidMprError("BioLogic MB cycling records contain instrument error flags")
    # Validate scientific values only in the retained operations. Invalid EIS
    # voltage/current/charge must neither block nor contaminate cycling data.
    position = np.flatnonzero(keep)
    voltage = np.asarray(records["raw_ewe_v"][keep], dtype=float)
    current = np.asarray(records["raw_current_ma"][keep], dtype=float)
    if not np.isfinite(voltage).all():
        raise InvalidMprError("BioLogic MB cycling voltage must be finite")
    limitations = {}
    missing_current = ~np.isfinite(current)
    if missing_current.any():
        current[missing_current] = np.nan
        limitations["current"] = "Some measured current samples are unavailable."
        limitations["capacity"] = limitations["cycles"] = "Operation polarity is incomplete."

    mode, half, ns, time = mode[keep], half[keep], ns[keep], time[keep]
    direction = np.sign(np.where(np.abs(current) > 1e-6, current, 0)).astype(np.int8)
    if ((mode == 0) | ((mode == 3) & (direction != 0))).any():
        raise InvalidMprError("BioLogic MB current contradicts the recorded control mode")
    breaks = np.r_[False, np.diff(position) != 1]
    counter = None
    if set(document.vmp_data.resolved_base_ids) - {None} == MB_CONTROL_ENERGY_BASES:
        # This verified frequencyless layout retains every source record.
        counter = _align_restart_counters(records, ns, mode, half, direction, time)
    boundary = np.r_[True, (np.diff(ns) != 0) | (np.diff(mode) != 0) |
                     (np.diff(direction) != 0) | (np.diff(half) != 0)] | breaks
    starts = np.maximum.accumulate(np.where(boundary, np.arange(len(time)), 0))
    step = np.cumsum(boundary)
    if not {"raw_dq_mAh", "raw_q_charge_discharge_mAh"}.issubset(records.dtype.names):
        limitations["capacity"] = "The recording lacks the charge counters needed to verify step capacity."
    if "capacity" not in limitations:
        dq = np.asarray(records["raw_dq_mAh"][keep], dtype=float)
        if counter is None:
            counter = np.asarray(records["raw_q_charge_discharge_mAh"][keep], dtype=float)
        try:
            charge, discharge = _step_capacity(time, dq, counter, direction, boundary)
        except _QuantityUnavailable as exc:
            limitations["capacity"] = str(exc)
    if "capacity" in limitations:
        charge = discharge = np.full(len(time), np.nan)
    try:
        cycle, complete = _cycle_labels(half, direction)
    except _QuantityUnavailable as exc:
        limitations["cycles"] = str(exc)
        cycle = np.ones(len(time), dtype=np.int64)
        complete = np.zeros(len(time), dtype=bool)
    status = np.full(len(time), "Rest", dtype=object)
    status[(direction > 0) & (mode == 1)] = "CC_Chg"
    status[(direction < 0) & (mode == 1)] = "CC_DChg"
    status[(direction > 0) & (mode == 2)] = "CV_Chg"
    status[(direction < 0) & (mode == 2)] = "CV_DChg"
    status[missing_current] = "Unverified"
    frame = pd.DataFrame({
        "record_index": position + 1, "cycle": cycle, "step": step,
        "step_index": ns + 1, "status": pd.Series(status, dtype="string"),
        "time_s": time - time[starts], "total_time_s": time,
        "biologic_mb_time_s": time,
        "mpr_acquisition_segment": 1 + np.cumsum(breaks),
        "voltage_v": voltage, "current_ma": current,
        "charge_capacity_mah": charge, "discharge_capacity_mah": discharge,
        "cycle_complete": complete,
        "measurement_type": "biologic_mb",
    })
    frame.attrs["biologic_gcpl"] = {
        "cycle_source": "mb_half_cycle_pairs", "scientific_interpretation": "verified",
        "original_record_count": len(records), "excluded_eis_records": int((~keep).sum()),
        "parser_warnings": ([{"code": "biologic_mb_eis_exclusion", "severity": "info",
            "scope": "source", "message": NOTICE, "count": int((~keep).sum())}] if (~keep).any() else []),
    }
    record_limitations(frame, "MB", limitations)
    canonical_cycling.validate_raw_timeseries(frame)
    return frame
