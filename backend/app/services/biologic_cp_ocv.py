"""Canonical curve mapping for BioLogic constant-potential and OCV MPR files.

These techniques do not declare the GCPL charge/discharge cycle contract, but
their recorded voltage trajectories are valid analysis inputs. Rows retain a
storage cycle index so the existing raw cache can address them; the optional
``cycle_complete`` flag prevents OCV runs and unmatched CP half-cycles from
appearing as measured full cycles.
"""
from __future__ import annotations

from typing import Any, Mapping

import numpy as np
import pandas as pd

from . import biologic_mpr, canonical_cycling
from .biologic_gcpl import decode_gcpl_log, InvalidBiologicGcplError

BIOLOGIC_CP_OCV_ADAPTER_REVISION = 1
_CURRENT_TOLERANCE_MA = 1e-6


def _records_and_flags(source: Any) -> tuple[np.ndarray, Mapping[str, np.ndarray] | None]:
    data = getattr(source, "vmp_data", None)
    records = getattr(data, "records", None)
    if records is None or records.dtype.names is None:
        raise InvalidBiologicGcplError("BioLogic CP/OCV records are unavailable")
    flags = getattr(data, "flags", None)
    return records, flags if isinstance(flags, Mapping) else None


def _field(records: np.ndarray, name: str, *, required: bool = True) -> np.ndarray | None:
    if name not in (records.dtype.names or ()):
        if required:
            raise InvalidBiologicGcplError(f"BioLogic CP/OCV data is missing {name}")
        return None
    values = np.asarray(records[name], dtype=np.float64)
    if not np.isfinite(values).all():
        raise InvalidBiologicGcplError(f"BioLogic CP/OCV {name} contains non-finite values")
    return values


def _directional_state(current_ma: np.ndarray) -> np.ndarray:
    state = np.zeros(len(current_ma), dtype=np.int8)
    state[current_ma > _CURRENT_TOLERANCE_MA] = 1
    state[current_ma < -_CURRENT_TOLERANCE_MA] = -1
    return state


def _cycle_labels(direction: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Group charge/discharge pairs, ignoring any number of zero-current rows."""
    labels = np.ones(len(direction), dtype=np.int64)
    seen_directions: dict[int, set[int]] = {1: set()}
    first_direction = 0
    previous_direction = 0
    cycle = 1
    for index, value in enumerate(direction.tolist()):
        if value == 0:
            labels[index] = cycle
            continue
        value = int(value)
        if first_direction == 0:
            first_direction = value
        elif previous_direction != 0 and value != previous_direction and value == first_direction:
            cycle += 1
            seen_directions[cycle] = set()
        labels[index] = cycle
        seen_directions.setdefault(cycle, set()).add(value)
        previous_direction = value
    complete = np.asarray(
        [len(seen_directions.get(int(label), set())) == 2 for label in labels],
        dtype=bool,
    )
    return labels, complete


def map_curve_to_canonical(
    source: Any,
    *,
    technique_id: int,
    acquisition_start: object | None = None,
) -> pd.DataFrame:
    """Map CP or OCV records to voltage/time rows and infer only CP alternations."""
    if technique_id not in {
        biologic_mpr.MPR_CP_TECHNIQUE_ID,
        biologic_mpr.MPR_OCV_TECHNIQUE_ID,
    }:
        raise InvalidBiologicGcplError("BioLogic curve mapper requires CP or OCV technique")

    records, flags = _records_and_flags(source)
    if len(records) == 0:
        raise InvalidBiologicGcplError("BioLogic CP/OCV data block contains no records")
    if flags is not None:
        errors = np.asarray(flags.get("error", np.zeros(len(records), dtype=bool)), dtype=bool)
        if len(errors) != len(records):
            raise InvalidBiologicGcplError("BioLogic CP/OCV error flags do not match the data rows")
        if errors.any():
            raise InvalidBiologicGcplError("BioLogic CP/OCV data contains rows marked as errors")
    total_time_s = _field(records, "elapsed_time_s")
    voltage = _field(records, "raw_context_dependent_working_potential")
    if bool((total_time_s < 0).any()):
        raise InvalidBiologicGcplError("BioLogic CP/OCV elapsed time cannot be negative")

    is_cp = technique_id == biologic_mpr.MPR_CP_TECHNIQUE_ID
    current = _field(records, "raw_current_ma") if is_cp else np.zeros(len(records), dtype=np.float64)
    direction = _directional_state(current)
    cycle, complete = _cycle_labels(direction) if is_cp else (
        np.ones(len(records), dtype=np.int64),
        np.zeros(len(records), dtype=bool),
    )

    q_mAh = _field(records, "raw_q_charge_discharge_mAh", required=False)
    charge_capacity = np.zeros(len(records), dtype=np.float64)
    discharge_capacity = np.zeros(len(records), dtype=np.float64)
    step = np.zeros(len(records), dtype=np.int64)
    time_s = np.zeros(len(records), dtype=np.float64)
    step_starts: list[int] = []
    if len(records):
        step_starts.append(0)
    for index in range(1, len(records)):
        if direction[index] != direction[index - 1]:
            step_starts.append(index)
    step_starts.append(len(records))

    for step_number, (start, end) in enumerate(zip(step_starts[:-1], step_starts[1:], strict=True), start=1):
        step[start:end] = step_number
        time_s[start:end] = np.maximum(total_time_s[start:end] - total_time_s[start], 0.0)
        if not is_cp or direction[start] == 0 or q_mAh is None:
            continue
        segment = direction[start]
        transferred = np.maximum(segment * (q_mAh[start:end] - q_mAh[start]), 0.0)
        if segment > 0:
            charge_capacity[start:end] = transferred
        else:
            discharge_capacity[start:end] = transferred

    if np.any(step < 1):
        raise InvalidBiologicGcplError("BioLogic CP/OCV step assignment failed")

    status = np.full(len(records), "Rest", dtype=object)
    if is_cp:
        status[direction > 0] = "CC_Chg"
        status[direction < 0] = "CC_DChg"
    else:
        status[:] = "OCV"

    frame_values: dict[str, Any] = {
        "record_index": np.arange(1, len(records) + 1, dtype=np.int64),
        "cycle": cycle,
        "step": step,
        "step_index": step,
        "status": pd.Series(status, dtype="string"),
        "time_s": time_s,
        "total_time_s": total_time_s,
        "voltage_v": voltage,
        "current_ma": current,
        "charge_capacity_mah": charge_capacity,
        "discharge_capacity_mah": discharge_capacity,
        "cycle_complete": complete,
        "measurement_type": "biologic_cp" if is_cp else "biologic_ocv",
    }

    if acquisition_start is None and isinstance(source, biologic_mpr.MprDocument):
        acquisition_start = decode_gcpl_log(source.vmp_log).get("start_time")
    if acquisition_start is not None:
        try:
            start_timestamp = pd.Timestamp(acquisition_start)
            if pd.isna(start_timestamp):
                raise ValueError("timestamp is null")
            frame_values["timestamp"] = start_timestamp + pd.to_timedelta(total_time_s, unit="s")
        except (TypeError, ValueError, OverflowError) as exc:
            raise InvalidBiologicGcplError(
                "BioLogic CP/OCV acquisition start timestamp is invalid"
            ) from exc

    frame = pd.DataFrame(frame_values)
    canonical_cycling.validate_raw_timeseries(frame)
    return frame


def parse_timeseries(path: str, *, technique_id: int) -> pd.DataFrame:
    with biologic_mpr.read_mpr(path) as document:
        start_time = decode_gcpl_log(document.vmp_log).get("start_time")
        return map_curve_to_canonical(
            document,
            technique_id=technique_id,
            acquisition_start=start_time,
        )
