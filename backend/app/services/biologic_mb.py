"""Measured MB cycling rows, isolated from impedance operations.

The first interval of each recorded operation is deliberately unassigned:
its charge may have crossed a mode/sequence boundary or an omitted EIS run.
No absolute counter difference ever bridges that boundary.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import canonical_cycling
from .biologic_mpr import InvalidMprError


NOTICE = (
    "BioLogic MB: EIS operations are excluded from curves and capacity. "
    "Capacity uses recorded increments within each operation; boundary intervals "
    "are omitted. Cycle summaries require adjacent opposite-current half-cycles."
)


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
    if (np.diff(half) < 0).any():
        raise InvalidMprError("BioLogic MB half-cycle identity regresses")
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
    dq = np.asarray(records["raw_dq_mAh"][keep], dtype=float)
    counter = np.asarray(records["raw_q_charge_discharge_mAh"][keep], dtype=float)
    if not all(np.isfinite(a).all() for a in (voltage, current, dq, counter)):
        raise InvalidMprError("BioLogic MB cycling voltage, current and charge must be finite")
    mode, half, ns, time = mode[keep], half[keep], ns[keep], time[keep]
    direction = np.sign(np.where(np.abs(current) > 1e-6, current, 0)).astype(np.int8)
    if ((mode == 0) | ((mode == 3) & (direction != 0))).any():
        raise InvalidMprError("BioLogic MB current contradicts the recorded control mode")
    breaks = np.r_[False, np.diff(position) != 1]
    boundary = np.r_[True, (np.diff(ns) != 0) | (np.diff(mode) != 0) |
                     (np.diff(direction) != 0) | (np.diff(half) != 0)] | breaks
    starts = np.maximum.accumulate(np.where(boundary, np.arange(len(time)), 0))
    step = np.cumsum(boundary)
    interior = ~boundary
    usable = interior & (direction != 0)
    if (direction[usable] * dq[usable] < -1e-7).any():
        raise InvalidMprError("BioLogic MB incremental charge contradicts measured current")
    counter_delta = np.r_[0, np.diff(counter)]
    if not np.isclose(counter_delta[interior], dq[interior], rtol=1e-3, atol=1e-6).all():
        raise InvalidMprError("BioLogic MB charge counter and recorded increments disagree within an operation")
    if (np.abs(dq[interior & (direction == 0)]) > 1e-7).any():
        raise InvalidMprError("BioLogic MB neutral interior interval contains charge transfer")
    zero_duration = interior & np.r_[False, np.diff(time) == 0]
    if (np.abs(dq[zero_duration]) > 1e-7).any():
        raise InvalidMprError("BioLogic MB zero-duration interior interval contains charge transfer")
    charge = np.zeros(len(time))
    discharge = np.zeros(len(time))
    for start, end in zip(np.flatnonzero(boundary), np.r_[np.flatnonzero(boundary)[1:], len(time)]):
        if direction[start] == 0:
            continue
        increments = np.maximum(direction[start] * dq[start:end], 0)
        increments[0] = 0
        transferred = np.cumsum(increments)
        (charge if direction[start] > 0 else discharge)[start:end] = transferred

    # Source half-cycle labels, rather than Ns order, own the pairing. Gaps or
    # a contradictory polarity never create an inferred complete cycle.
    signs = {}
    half_starts = np.flatnonzero(np.r_[True, np.diff(half) != 0])
    for start, end in zip(half_starts, np.r_[half_starts[1:], len(half)]):
        h = half[start]
        active = set(direction[start:end].tolist()) - {0}
        if len(active) > 1:
            raise InvalidMprError("BioLogic MB half-cycle contains contradictory current directions")
        signs[int(h)] = next(iter(active), 0)
    cycle = half // 2 + 1
    complete_ids = {h // 2 + 1 for h in signs if h % 2 == 0 and
                    signs[h] != 0 and signs.get(h + 1) == -signs[h]}
    status = np.full(len(time), "Rest", dtype=object)
    status[(direction > 0) & (mode == 1)] = "CC_Chg"
    status[(direction < 0) & (mode == 1)] = "CC_DChg"
    status[(direction > 0) & (mode == 2)] = "CV_Chg"
    status[(direction < 0) & (mode == 2)] = "CV_DChg"
    frame = pd.DataFrame({
        "record_index": position + 1, "cycle": cycle, "step": step,
        "step_index": ns + 1, "status": pd.Series(status, dtype="string"),
        "time_s": time - time[starts], "total_time_s": time,
        "biologic_mb_time_s": time,
        "mpr_acquisition_segment": 1 + np.cumsum(breaks),
        "voltage_v": voltage, "current_ma": current,
        "charge_capacity_mah": charge, "discharge_capacity_mah": discharge,
        "cycle_complete": np.isin(cycle, list(complete_ids)),
        "measurement_type": "biologic_mb",
    })
    frame.attrs["biologic_gcpl"] = {
        "cycle_source": "mb_half_cycle_pairs", "scientific_interpretation": "verified",
        "original_record_count": len(records), "excluded_eis_records": int((~keep).sum()),
        "parser_warnings": ([{"code": "biologic_mb_eis_exclusion", "severity": "info",
            "scope": "source", "message": NOTICE, "count": int((~keep).sum())}] if (~keep).any() else []),
    }
    canonical_cycling.validate_raw_timeseries(frame)
    return frame
