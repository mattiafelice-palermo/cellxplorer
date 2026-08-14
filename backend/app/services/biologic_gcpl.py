"""GCPL semantic adapter for the independently decoded BioLogic MPR records.

The low-level container reader in :mod:`biologic_mpr` deliberately exposes
source-owned, typed fields and stops there.  This module owns the next
boundary: turning the supported GCPL record contract into the canonical
CellXplorer cycling frame consumed by ``calc.py``, ``step_blocks.py`` and the
cache layer.

Only the verified GCPL layout from Spec 041.1 is accepted.  A source with an
ambiguous control mode, direction, elapsed-time sequence, or capacity counter
is rejected rather than being made to look like a plausible battery test.
The adapter is direct-parser support for Spec 041.2; user-facing ``.mpr``
extension recognition remains intentionally owned by Spec 041.4.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import canonical_cycling
from .biologic_mpr import MprDataBlock, MprDocument, read_mpr
from .source_format_errors import (
    InvalidSourceFormatError,
    SourceFormatError,
    UnsupportedSourceFormatError,
)


BIOLOGIC_GCPL_ADAPTER_REVISION = "gcpl1"

# BioLogic's packed mode code is a source-level categorical value.  The
# values below are locked to the supported GCPL contract: current control,
# voltage control, and an open-circuit/rest block.  Other technique modes are
# deliberately not guessed.
MPR_MODE_GALVANOSTATIC = 1
MPR_MODE_POTENTIOSTATIC = 2
MPR_MODE_REST = 3
_SUPPORTED_MODES = frozenset(
    {MPR_MODE_GALVANOSTATIC, MPR_MODE_POTENTIOSTATIC, MPR_MODE_REST}
)

_TIME_TOLERANCE_S = 1e-6
_CAPACITY_TOLERANCE_MAH = 1e-9
_CURRENT_TOLERANCE_MA = 1e-9

_REQUIRED_RECORD_FIELDS = (
    "raw_sample_index",
    "elapsed_time_s",
    "raw_dq_mAh",
    "raw_control_v_or_mA",
    "raw_ewe_v",
    "raw_ece_v",
    "raw_q_charge_discharge_mAh",
    "raw_half_cycle_index",
)


class BiologicGcplError(SourceFormatError):
    """Base error for a rejected BioLogic GCPL semantic source."""


class InvalidBiologicGcplError(BiologicGcplError, InvalidSourceFormatError):
    """The source is a recognized MPR but cannot be mapped safely."""


class UnsupportedBiologicGcplError(BiologicGcplError, UnsupportedSourceFormatError):
    """The MPR is outside the supported GCPL semantic contract."""


def _records_from_source(source: Any) -> tuple[np.ndarray, Mapping[str, np.ndarray] | None]:
    if isinstance(source, MprDocument):
        block = source.vmp_data
        return _records_from_source(block)
    if isinstance(source, MprDataBlock):
        if source.records is None:
            raise InvalidBiologicGcplError("MPR data records were released before GCPL mapping")
        return source.records, source.flags
    if isinstance(source, np.ndarray):
        return source, None
    records = getattr(source, "records", None)
    if isinstance(records, np.ndarray):
        return records, getattr(source, "flags", None)
    raise TypeError("GCPL mapping expects an MPR document, data block, or structured record array")


def _field_names(records: np.ndarray) -> set[str]:
    names = records.dtype.names
    if names is None:
        raise InvalidBiologicGcplError("GCPL records must be a structured NumPy array")
    return set(names)


def _column(records: np.ndarray, name: str) -> np.ndarray:
    return np.asarray(records[name])


def _flag_column(
    records: np.ndarray,
    flags: Mapping[str, np.ndarray] | None,
    name: str,
    *,
    default: bool = False,
) -> np.ndarray:
    if flags is not None and name in flags:
        values = np.asarray(flags[name])
        if len(values) != len(records):
            raise InvalidBiologicGcplError(
                f"GCPL flag {name!r} has {len(values)} rows for {len(records)} records"
            )
        return values
    if "raw_flags" not in _field_names(records):
        return np.full(len(records), default, dtype=bool)
    masks = {
        "ns_changed": 0x20,
        "counter_incremented": 0x80,
    }
    mask = masks.get(name)
    if mask is None:
        return np.full(len(records), default, dtype=bool)
    return (_column(records, "raw_flags").astype(np.uint8, copy=False) & mask) != 0


def _mode_column(
    records: np.ndarray,
    flags: Mapping[str, np.ndarray] | None,
) -> np.ndarray:
    if flags is not None and "mode" in flags:
        mode = np.asarray(flags["mode"])
    elif "raw_flags" in _field_names(records):
        mode = _column(records, "raw_flags").astype(np.uint8, copy=False) & 0x03
    else:
        raise InvalidBiologicGcplError("GCPL records do not contain the packed mode value")
    if len(mode) != len(records):
        raise InvalidBiologicGcplError("GCPL mode column is not aligned with the records")
    return mode.astype(np.int64, copy=False)


def _require_float_column(records: np.ndarray, name: str) -> np.ndarray:
    values = _column(records, name).astype(np.float64, copy=False)
    if not np.isfinite(values).all():
        raise InvalidBiologicGcplError(f"GCPL field {name!r} contains non-finite values")
    return values


def _validate_integer_column(values: np.ndarray, name: str, *, positive: bool = False) -> np.ndarray:
    numeric = np.asarray(values, dtype=np.float64)
    if not np.isfinite(numeric).all() or np.any(numeric != np.floor(numeric)):
        raise InvalidBiologicGcplError(f"GCPL field {name!r} must contain finite integers")
    if positive and np.any(numeric < 1):
        raise UnsupportedBiologicGcplError(
            f"GCPL field {name!r} contains zero-based or negative sequence identities"
        )
    return numeric.astype(np.int64)


def _validate_total_time(total_time_s: np.ndarray) -> None:
    if len(total_time_s) == 0:
        raise InvalidBiologicGcplError("GCPL data block contains no records")
    if np.any(total_time_s < 0):
        raise InvalidBiologicGcplError("GCPL elapsed time cannot be negative")
    if len(total_time_s) > 1 and np.any(np.diff(total_time_s) < -_TIME_TOLERANCE_S):
        raise InvalidBiologicGcplError(
            "GCPL whole-test elapsed time decreases in acquisition order"
        )


def _optional_column(records: np.ndarray, *names: str) -> np.ndarray | None:
    fields = _field_names(records)
    for name in names:
        if name in fields:
            return _column(records, name).astype(np.float64, copy=False)
    return None


def _raw_current_ma(
    records: np.ndarray,
    mode: np.ndarray,
    total_time_s: np.ndarray,
    raw_dq_mAh: np.ndarray,
    control: np.ndarray,
) -> np.ndarray:
    """Resolve BioLogic current in mA without changing its source sign.

    The supported GCPL sample stores the measured/current-control value in
    the technique-dependent ID-5 field.  A future supported variant may carry
    a dedicated current field; it is preferred when present.  During a CV
    portion, ID-5 is a voltage control value, so the per-record incremental
    ``dq`` field supplies the only verified current estimate.  This is a
    current reconstruction, not a capacity fallback: the required vendor
    capacity counter is still mandatory below.
    """

    dedicated = _optional_column(records, "raw_current_ma", "current_ma")
    if dedicated is not None:
        raw_current = dedicated.copy()
    else:
        raw_current = np.full(len(records), np.nan, dtype=np.float64)

    current_mode = mode == MPR_MODE_GALVANOSTATIC
    raw_current[current_mode] = control[current_mode]

    if len(records) > 1:
        dt = np.diff(total_time_s)
        valid_dt = dt > _TIME_TOLERANCE_S
        derivative = np.full(len(records), np.nan, dtype=np.float64)
        derivative[1:][valid_dt] = raw_dq_mAh[1:][valid_dt] / dt[valid_dt] * 3600.0
        first_dt = total_time_s[1] - total_time_s[0]
        if first_dt > _TIME_TOLERANCE_S:
            derivative[0] = raw_dq_mAh[1] / first_dt * 3600.0
        needs_derived = ~np.isfinite(raw_current) | (mode == MPR_MODE_POTENTIOSTATIC)
        raw_current[needs_derived] = derivative[needs_derived]

    # A rest row has no current by definition, even if a stale control value
    # is retained in the binary record.
    raw_current[mode == MPR_MODE_REST] = 0.0
    if not np.isfinite(raw_current).all():
        raise UnsupportedBiologicGcplError(
            "supported GCPL records do not contain a usable current value for every row"
        )
    # BioLogic's GCPL sign in the verified contract already agrees with
    # CellXplorer: positive is charge and negative is discharge.  Keep the
    # explicit factor visible so a later adapter revision cannot silently
    # change the global convention.
    return raw_current


def _step_boundaries(
    *,
    ns: np.ndarray,
    half_cycle: np.ndarray,
    mode: np.ndarray,
    ns_changed: np.ndarray,
    total_time_s: np.ndarray,
    records: np.ndarray,
) -> np.ndarray:
    boundaries = np.zeros(len(ns), dtype=bool)
    boundaries[0] = True
    active = mode != MPR_MODE_REST
    if len(ns) == 1:
        return boundaries

    boundaries[1:] |= ns[1:] != ns[:-1]
    boundaries[1:] |= half_cycle[1:] != half_cycle[:-1]
    boundaries[1:] |= np.asarray(ns_changed[1:], dtype=bool)
    # A transition into or out of a true rest operation is an executed-step
    # boundary.  CC -> CV and CV -> CC stay in one occurrence, allowing the
    # block classifier to produce CCCV status without inventing a step.
    boundaries[1:] |= active[1:] != active[:-1]

    # 041.1 currently exposes whole-test time only.  Accept a future
    # independently decoded step-time field without making up one from a
    # cycle-relative counter.  A reset is a boundary only when that field is
    # explicitly present.
    step_time = _optional_column(records, "raw_step_time_s", "step_time_s")
    if step_time is not None:
        if not np.isfinite(step_time).all() or np.any(step_time < 0):
            raise InvalidBiologicGcplError("GCPL step time contains invalid values")
        boundaries[1:] |= np.diff(step_time) < -_TIME_TOLERANCE_S

    return boundaries


def _block_ranges(boundaries: np.ndarray) -> list[tuple[int, int]]:
    starts = np.flatnonzero(boundaries)
    ends = np.r_[starts[1:], len(boundaries)]
    return [(int(start), int(end)) for start, end in zip(starts, ends)]


def _direction_for_block(
    current_ma: np.ndarray,
    raw_capacity: np.ndarray,
    start: int,
    end: int,
    *,
    mode: np.ndarray,
) -> int:
    current = current_ma[start:end]
    positive = bool(np.any(current > _CURRENT_TOLERANCE_MA))
    negative = bool(np.any(current < -_CURRENT_TOLERANCE_MA))
    if positive and negative:
        raise UnsupportedBiologicGcplError(
            f"GCPL executed block {start + 1}:{end} mixes charge and discharge direction"
        )
    if positive:
        return 1
    if negative:
        return -1

    # If a source records a zero current at every point, use the required
    # signed vendor counter only to distinguish a non-rest block.  It is not a
    # replacement for current on an active block; the caller still rejects a
    # directionless non-rest operation below.
    capacity_delta = raw_capacity[end - 1] - raw_capacity[start]
    if abs(capacity_delta) > _CAPACITY_TOLERANCE_MAH:
        if mode[start:end].tolist() and np.all(mode[start:end] == MPR_MODE_REST):
            return 0
        return 1 if capacity_delta > 0 else -1
    return 0


def _classify_block(mode: np.ndarray, direction: int, start: int, end: int) -> str:
    block_modes = set(int(value) for value in mode[start:end])
    if block_modes <= {MPR_MODE_REST}:
        return "Rest"
    if direction == 0:
        raise UnsupportedBiologicGcplError(
            f"GCPL active block {start + 1}:{end} has no resolvable current direction"
        )
    has_cc = MPR_MODE_GALVANOSTATIC in block_modes
    has_cv = MPR_MODE_POTENTIOSTATIC in block_modes
    if not block_modes <= _SUPPORTED_MODES or not (has_cc or has_cv):
        raise UnsupportedBiologicGcplError(
            f"GCPL block {start + 1}:{end} uses unsupported control mode(s): "
            f"{sorted(block_modes)}"
        )
    if has_cc and has_cv:
        return "CCCV_Chg" if direction > 0 else "CCCV_DChg"
    if has_cc:
        return "CC_Chg" if direction > 0 else "CC_DChg"
    if direction < 0:
        # The canonical vocabulary has no standalone CV discharge status.
        # Do not invent a new status or mislabel it as CC discharge.
        raise UnsupportedBiologicGcplError(
            "standalone BioLogic CV discharge is not represented by the current "
            "CellXplorer canonical status vocabulary"
        )
    return "CV_Chg"


def _capacity_columns(
    raw_capacity: np.ndarray,
    directions: list[int],
    ranges: list[tuple[int, int]],
) -> tuple[np.ndarray, np.ndarray]:
    charge = np.zeros(len(raw_capacity), dtype=np.float64)
    discharge = np.zeros(len(raw_capacity), dtype=np.float64)
    for direction, (start, end) in zip(directions, ranges):
        if direction == 0:
            continue
        source = raw_capacity[start:end]
        baseline = source[0]
        transferred = direction * (source - baseline)
        if np.any(transferred < -_CAPACITY_TOLERANCE_MAH):
            raise UnsupportedBiologicGcplError(
                f"GCPL capacity counter reverses within executed block {start + 1}:{end}"
            )
        transferred = np.maximum(transferred, 0.0)
        if direction > 0:
            charge[start:end] = transferred
        else:
            discharge[start:end] = transferred
    return charge, discharge


def _primary_voltage(records: np.ndarray) -> tuple[np.ndarray, bool]:
    direct = _optional_column(records, "raw_voltage_v", "raw_ecell_v", "ecell_v")
    if direct is not None:
        if not np.isfinite(direct).all():
            raise InvalidBiologicGcplError("GCPL primary voltage contains non-finite values")
        return direct, False
    ewe = _require_float_column(records, "raw_ewe_v")
    ece = _require_float_column(records, "raw_ece_v")
    # The supported GCPL6 contract records Ewe and Ece against the same
    # reference.  Until 041.3 adds the first-class electrode columns and
    # metadata, this is an adapter-private derivation of the full-cell path.
    return ewe - ece, True


def integrate_capacity_by_step(frame: pd.DataFrame) -> dict[int, float]:
    """Independently integrate ``|current|`` over whole-test time per step.

    The result is a diagnostic cross-check against the vendor capacity
    counters.  It is intentionally never substituted into the canonical
    capacity columns.
    """

    if frame.empty or not {"step", "current_ma", "total_time_s"}.issubset(frame.columns):
        return {}
    out: dict[int, float] = {}
    for step, group in frame.groupby("step", sort=False):
        work = (
            group.sort_values("record_index")
            if "record_index" in group.columns
            else group
        )
        current = work["current_ma"].to_numpy(dtype=np.float64)
        total = work["total_time_s"].to_numpy(dtype=np.float64)
        if len(work) < 2:
            out[int(step)] = 0.0
            continue
        dt = np.diff(total)
        if np.any(dt < -_TIME_TOLERANCE_S):
            raise InvalidBiologicGcplError("cannot integrate capacity across decreasing total time")
        out[int(step)] = float(
            np.sum(np.abs((current[:-1] + current[1:]) * 0.5) * np.maximum(dt, 0.0))
            / 3600.0
        )
    return out


def map_gcpl_to_canonical(source: Any) -> pd.DataFrame:
    """Map one supported MPR data source into the canonical raw frame."""

    records, flags = _records_from_source(source)
    fields = _field_names(records)
    missing = [name for name in _REQUIRED_RECORD_FIELDS if name not in fields]
    if missing:
        raise UnsupportedBiologicGcplError(
            "supported GCPL layout is missing required field(s): " + ", ".join(missing)
        )
    if len(records) == 0:
        raise InvalidBiologicGcplError("GCPL data block contains no records")

    mode = _mode_column(records, flags)
    if np.any(~np.isin(mode, tuple(_SUPPORTED_MODES))):
        values = sorted(set(int(value) for value in mode if value not in _SUPPORTED_MODES))
        raise UnsupportedBiologicGcplError(f"unsupported BioLogic GCPL mode code(s): {values}")
    ns = _validate_integer_column(_column(records, "raw_sample_index"), "Ns", positive=True)
    half_cycle = _validate_integer_column(
        _column(records, "raw_half_cycle_index"), "half-cycle", positive=False
    )
    if np.any(half_cycle < 0):
        raise InvalidBiologicGcplError("GCPL half-cycle values cannot be negative")
    total_time_s = _require_float_column(records, "elapsed_time_s")
    _validate_total_time(total_time_s)
    raw_dq_mAh = _require_float_column(records, "raw_dq_mAh")
    raw_capacity = _require_float_column(records, "raw_q_charge_discharge_mAh")
    control = _require_float_column(records, "raw_control_v_or_mA")
    current_ma = _raw_current_ma(records, mode, total_time_s, raw_dq_mAh, control)
    voltage_v, voltage_v_derived = _primary_voltage(records)

    ns_changed = _flag_column(records, flags, "ns_changed")
    boundaries = _step_boundaries(
        ns=ns,
        half_cycle=half_cycle,
        mode=mode,
        ns_changed=ns_changed,
        total_time_s=total_time_s,
        records=records,
    )
    ranges = _block_ranges(boundaries)
    directions = [
        _direction_for_block(current_ma, raw_capacity, start, end, mode=mode)
        for start, end in ranges
    ]
    statuses = [
        _classify_block(mode, direction, start, end)
        for direction, (start, end) in zip(directions, ranges)
    ]
    charge_capacity, discharge_capacity = _capacity_columns(
        raw_capacity, directions, ranges
    )

    step = np.empty(len(records), dtype=np.int64)
    status = np.empty(len(records), dtype=object)
    time_s = np.empty(len(records), dtype=np.float64)
    for step_number, ((start, end), block_status) in enumerate(zip(ranges, statuses), start=1):
        step[start:end] = step_number
        status[start:end] = block_status
        time_s[start:end] = total_time_s[start:end] - total_time_s[start]
        # Avoid carrying a sub-microsecond negative caused by a source clock
        # representation at a boundary, while preserving real elapsed time.
        time_s[start:end] = np.maximum(time_s[start:end], 0.0)

    frame = pd.DataFrame(
        {
            "record_index": np.arange(1, len(records) + 1, dtype=np.int64),
            "cycle": (half_cycle // 2) + 1,
            "step": step,
            "step_index": ns,
            "status": pd.Series(status, dtype="string"),
            "time_s": time_s,
            "total_time_s": total_time_s,
            "voltage_v": voltage_v,
            "current_ma": current_ma,
            "charge_capacity_mah": charge_capacity,
            "discharge_capacity_mah": discharge_capacity,
        }
    )
    frame.attrs["biologic_gcpl"] = {
        "adapter_revision": BIOLOGIC_GCPL_ADAPTER_REVISION,
        "record_index_base": 1,
        "step_index_source": "Ns",
        "step_index_base_adjustment": 0,
        "cycle_source": "half-cycle",
        "cycle_formula": "floor(half_cycle / 2) + 1",
        "current_sign_factor": 1,
        "energy_policy": "C-unavailable",
        "absolute_timestamps": False,
        "voltage_v_derived": voltage_v_derived,
    }
    canonical_cycling.validate_raw_timeseries(frame)
    return frame


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    """Read and map a supported BioLogic MPR directly to canonical data."""

    with read_mpr(path) as document:
        return map_gcpl_to_canonical(document)


__all__ = [
    "BIOLOGIC_GCPL_ADAPTER_REVISION",
    "BiologicGcplError",
    "InvalidBiologicGcplError",
    "MPR_MODE_GALVANOSTATIC",
    "MPR_MODE_POTENTIOSTATIC",
    "MPR_MODE_REST",
    "UnsupportedBiologicGcplError",
    "integrate_capacity_by_step",
    "map_gcpl_to_canonical",
    "parse_timeseries",
]
