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
        "error": 0x08,
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


def _validate_supported_half_cycle(half_cycle: np.ndarray) -> None:
    """Accept only the observed single-segment half-cycle contract.

    The supplied private file contains only zero-valued half-cycle records.
    Without the paired text export, starting value, direction, formation
    handling, and progression of a non-zero counter are not independently
    established.  It is safer to defer multi-half-cycle canonical numbering
    than to publish a plausible but wrong cycle grouping.
    """

    if np.any(np.diff(half_cycle) < 0):
        raise UnsupportedBiologicGcplError(
            "GCPL half-cycle counter regresses or resets; paired MPT evidence is required"
        )
    if np.any(half_cycle != 0):
        raise UnsupportedBiologicGcplError(
            "GCPL half-cycle progression is not independently validated; paired MPT evidence "
            "is required before canonical cycle numbering can be emitted"
        )


def _optional_column(records: np.ndarray, *names: str) -> np.ndarray | None:
    fields = _field_names(records)
    for name in names:
        if name in fields:
            return _column(records, name).astype(np.float64, copy=False)
    return None


def _cycle_column(records: np.ndarray) -> np.ndarray:
    """Return an explicitly decoded full-cycle field or fail closed.

    The exact 041.1 GCPL layout has no verified logical-cycle field, and its
    half-cycle counter has no paired MPT semantics yet. A semantic test record
    may provide ``raw_cycle_index`` to exercise the canonical adapter; the
    production MPR path must not invent a cycle label.
    """

    direct = _optional_column(records, "raw_cycle_index")
    if direct is None:
        raise UnsupportedBiologicGcplError(
            "GCPL logical cycle identity is not independently resolved; paired MPT evidence "
            "or an explicitly decoded full-cycle field is required"
        )
    cycle = _validate_integer_column(direct, "cycle", positive=True)
    if len(cycle) > 1 and np.any(np.diff(cycle) < 0):
        raise UnsupportedBiologicGcplError(
            "GCPL logical cycle identity regresses or resets in acquisition order"
        )
    return cycle


def _validate_ns_changed_flags(ns: np.ndarray, ns_changed: np.ndarray) -> None:
    """Reject an Ns-change flag that is not redundant with an Ns transition."""

    if len(ns) <= 1:
        return
    unexplained = np.asarray(ns_changed[1:], dtype=bool) & (ns[1:] == ns[:-1])
    if np.any(unexplained):
        raise UnsupportedBiologicGcplError(
            "GCPL Ns-change flag semantics are not independently validated for a repeated Ns; "
            "paired settings/MPT evidence is required"
        )


def _validate_capacity_boundaries(
    raw_capacity: np.ndarray,
    raw_dq_mAh: np.ndarray,
    boundaries: np.ndarray,
) -> None:
    """Reject ambiguous capacity ownership at an executed-step boundary.

    The source counters are cumulative, but the canonical columns reset at
    each executed step. Without paired evidence for whether a boundary row's
    interval belongs to the preceding or following operation, only a boundary
    with no incremental transfer and no cumulative counter jump is safe.
    """

    starts = np.flatnonzero(boundaries)[1:]
    if len(starts) == 0:
        return
    boundary_dq = raw_dq_mAh[starts]
    q_delta = raw_capacity[starts] - raw_capacity[starts - 1]
    if np.any(np.abs(boundary_dq) > _CAPACITY_TOLERANCE_MAH) or np.any(
        np.abs(q_delta) > _CAPACITY_TOLERANCE_MAH
    ):
        raise UnsupportedBiologicGcplError(
            "GCPL capacity transfer is ambiguous at an executed-step boundary; "
            "boundary rows must have zero incremental and cumulative transfer"
        )


def _step_time_column(records: np.ndarray) -> np.ndarray | None:
    """Return a decoded step-time field after validating every row."""

    step_time = _optional_column(records, "raw_step_time_s", "step_time_s")
    if step_time is not None and (
        not np.isfinite(step_time).all() or np.any(step_time < 0)
    ):
        raise InvalidBiologicGcplError("GCPL step time contains invalid values")
    return step_time


def _validate_step_time_boundaries(
    step_time: np.ndarray | None,
    boundaries: np.ndarray,
) -> None:
    """Require explicit step time to reset at every executed-step boundary."""

    if step_time is None:
        return
    starts = np.flatnonzero(boundaries)[1:]
    if len(starts) and np.any(np.abs(step_time[starts]) > _TIME_TOLERANCE_S):
        raise InvalidBiologicGcplError(
            "decoded GCPL step time does not reset at every executed-step boundary"
        )


def _raw_current_ma(
    records: np.ndarray,
    mode: np.ndarray,
    control: np.ndarray,
) -> np.ndarray:
    """Resolve BioLogic current in mA without changing its source sign.

    The supported GCPL sample stores the measured/current-control value in
    the technique-dependent ID-5 field.  A future supported variant may carry
    a dedicated measured-current field; it is preferred and preserved when
    present.  During a CV portion, ID-5 is a voltage control value, so a
    dedicated measured-current field is required.  The unverified interval
    ``dq/time`` reconstruction is intentionally rejected.
    """

    dedicated = _optional_column(records, "raw_current_ma", "current_ma")
    if dedicated is not None:
        raw_current = dedicated.copy()
        if np.any(
            (mode == MPR_MODE_REST)
            & (np.abs(raw_current) > _CURRENT_TOLERANCE_MA)
        ):
            raise InvalidBiologicGcplError(
                "dedicated GCPL current is non-zero during a rest block"
            )
    else:
        if np.any(mode == MPR_MODE_POTENTIOSTATIC):
            raise UnsupportedBiologicGcplError(
                "potentiostatic GCPL rows require an independently decoded measured-current field; "
                "interval dq/time reconstruction is not part of the supported contract"
            )
        raw_current = np.full(len(records), np.nan, dtype=np.float64)
        raw_current[mode == MPR_MODE_GALVANOSTATIC] = control[
            mode == MPR_MODE_GALVANOSTATIC
        ]
        raw_current[mode == MPR_MODE_REST] = 0.0

    if not np.isfinite(raw_current).all():
        if dedicated is not None:
            raise InvalidBiologicGcplError(
                "dedicated GCPL measured-current field contains non-finite values"
            )
        raise UnsupportedBiologicGcplError(
            "supported GCPL records do not contain a usable current value for every row"
        )
    # The accepted BioLogic GCPL sign convention agrees with
    # CellXplorer: positive is charge and negative is discharge.  Keep the
    # explicit factor visible so a later adapter revision cannot silently
    # change the global convention.
    return raw_current


def _step_boundaries(
    *,
    ns: np.ndarray,
    half_cycle: np.ndarray,
    cycle: np.ndarray,
    mode: np.ndarray,
    step_time: np.ndarray | None,
) -> np.ndarray:
    boundaries = np.zeros(len(ns), dtype=bool)
    boundaries[0] = True
    active = mode != MPR_MODE_REST
    if len(ns) == 1:
        return boundaries

    boundaries[1:] |= ns[1:] != ns[:-1]
    boundaries[1:] |= half_cycle[1:] != half_cycle[:-1]
    boundaries[1:] |= cycle[1:] != cycle[:-1]
    # A transition into or out of a true rest operation is an executed-step
    # boundary. CC -> CV stays in one occurrence, allowing the block classifier
    # to produce CCCV status; unsupported reverse chronology fails in the
    # classifier without inventing a step.
    boundaries[1:] |= active[1:] != active[:-1]

    if step_time is not None:
        boundaries[1:] |= np.diff(step_time) < -_TIME_TOLERANCE_S

    return boundaries


def _block_ranges(boundaries: np.ndarray) -> list[tuple[int, int]]:
    starts = np.flatnonzero(boundaries)
    ends = np.r_[starts[1:], len(boundaries)]
    return [(int(start), int(end)) for start, end in zip(starts, ends)]


def _direction_for_block(
    current_ma: np.ndarray,
    raw_capacity: np.ndarray,
    raw_dq_mAh: np.ndarray,
    start: int,
    end: int,
    *,
    mode: np.ndarray,
) -> int:
    current = current_ma[start:end]
    positive = bool(np.any(current > _CURRENT_TOLERANCE_MA))
    negative = bool(np.any(current < -_CURRENT_TOLERANCE_MA))
    if positive and negative:
        raise InvalidBiologicGcplError(
            f"GCPL executed block {start + 1}:{end} mixes charge and discharge direction"
        )
    if positive:
        direction = 1
    elif negative:
        direction = -1
    else:
        direction = 0

    if direction:
        capacity_delta = raw_capacity[end - 1] - raw_capacity[start]
        if end - start > 1 and abs(capacity_delta) <= _CAPACITY_TOLERANCE_MAH:
            raise InvalidBiologicGcplError(
                f"GCPL active block {start + 1}:{end} has no capacity transfer"
            )
        if direction * capacity_delta < -_CAPACITY_TOLERANCE_MAH:
            raise InvalidBiologicGcplError(
                f"GCPL current and capacity directions disagree in block {start + 1}:{end}"
            )
        increments = raw_dq_mAh[start:end]
        nonzero = np.abs(increments) > _CAPACITY_TOLERANCE_MAH
        if np.any(direction * increments[nonzero] < -_CAPACITY_TOLERANCE_MAH):
            raise InvalidBiologicGcplError(
                f"GCPL current and incremental-capacity directions disagree in block "
                f"{start + 1}:{end}"
            )
        return direction

    if np.all(mode[start:end] == MPR_MODE_REST):
        if np.ptp(raw_capacity[start:end]) > _CAPACITY_TOLERANCE_MAH or np.any(
            np.abs(raw_dq_mAh[start:end]) > _CAPACITY_TOLERANCE_MAH
        ):
            raise InvalidBiologicGcplError(
                f"GCPL rest block {start + 1}:{end} transfers capacity"
            )
        return 0
    raise InvalidBiologicGcplError(
        f"GCPL active block {start + 1}:{end} has no independently resolvable current direction"
    )


def _classify_block(mode: np.ndarray, direction: int, start: int, end: int) -> str:
    block_mode = mode[start:end]
    mode_changes = np.r_[True, block_mode[1:] != block_mode[:-1]]
    history = block_mode[mode_changes]
    unsupported = history[~np.isin(history, tuple(_SUPPORTED_MODES))]
    if len(unsupported):
        values = np.unique(unsupported).astype(np.int64).tolist()
        raise UnsupportedBiologicGcplError(
            f"GCPL block {start + 1}:{end} uses unsupported control mode(s): {values}"
        )
    if np.all(history == MPR_MODE_REST):
        return "Rest"
    if direction == 0:
        raise InvalidBiologicGcplError(
            f"GCPL active block {start + 1}:{end} has no resolvable current direction"
        )
    if np.any(history == MPR_MODE_REST):
        raise UnsupportedBiologicGcplError(
            f"GCPL block {start + 1}:{end} mixes rest and active control modes"
        )
    if len(history) == 1 and history[0] == MPR_MODE_GALVANOSTATIC:
        return "CC_Chg" if direction > 0 else "CC_DChg"
    if len(history) == 1 and history[0] == MPR_MODE_POTENTIOSTATIC:
        if direction < 0:
            # The canonical vocabulary has no standalone CV discharge status.
            # Do not invent a new status or mislabel it as CC discharge.
            raise UnsupportedBiologicGcplError(
                "standalone BioLogic CV discharge is not represented by the current "
                "CellXplorer canonical status vocabulary"
            )
        return "CV_Chg"
    if len(history) == 2 and np.array_equal(
        history, np.array([MPR_MODE_GALVANOSTATIC, MPR_MODE_POTENTIOSTATIC])
    ):
        return "CCCV_Chg" if direction > 0 else "CCCV_DChg"
    raise UnsupportedBiologicGcplError(
        f"GCPL block {start + 1}:{end} has unsupported control-mode chronology "
        f"{history.astype(np.int64).tolist()}"
    )


def _capacity_columns(
    raw_capacity: np.ndarray,
    directions: list[int],
    ranges: list[tuple[int, int]],
) -> tuple[np.ndarray, np.ndarray]:
    charge = np.zeros(len(raw_capacity), dtype=np.float64)
    discharge = np.zeros(len(raw_capacity), dtype=np.float64)
    for direction, (start, end) in zip(directions, ranges):
        if direction == 0:
            if np.ptp(raw_capacity[start:end]) > _CAPACITY_TOLERANCE_MAH:
                raise InvalidBiologicGcplError(
                    f"GCPL rest block {start + 1}:{end} has a changing capacity counter"
                )
            continue
        source = raw_capacity[start:end]
        baseline = source[0]
        transferred = direction * (source - baseline)
        if np.any(transferred < -_CAPACITY_TOLERANCE_MAH):
            raise InvalidBiologicGcplError(
                f"GCPL capacity counter reverses within executed block {start + 1}:{end}"
            )
        if len(transferred) > 1 and np.any(
            np.diff(transferred) < -_CAPACITY_TOLERANCE_MAH
        ):
            raise InvalidBiologicGcplError(
                f"GCPL capacity counter decreases within executed block {start + 1}:{end}"
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
    raise UnsupportedBiologicGcplError(
        "GCPL primary full-cell voltage is not independently resolved; defer Ewe/Ece role "
        "mapping and signed subtraction to Spec 041.3"
    )


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
    supported_mode = np.isin(mode, tuple(_SUPPORTED_MODES))
    if np.any(~supported_mode):
        values = np.unique(mode[~supported_mode]).astype(np.int64).tolist()
        raise UnsupportedBiologicGcplError(f"unsupported BioLogic GCPL mode code(s): {values}")
    ns = _validate_integer_column(_column(records, "raw_sample_index"), "Ns", positive=True)
    half_cycle = _validate_integer_column(
        _column(records, "raw_half_cycle_index"), "half-cycle", positive=False
    )
    if np.any(half_cycle < 0):
        raise InvalidBiologicGcplError("GCPL half-cycle values cannot be negative")
    _validate_supported_half_cycle(half_cycle)
    cycle = _cycle_column(records)
    total_time_s = _require_float_column(records, "elapsed_time_s")
    _validate_total_time(total_time_s)
    step_time = _step_time_column(records)
    raw_dq_mAh = _require_float_column(records, "raw_dq_mAh")
    raw_capacity = _require_float_column(records, "raw_q_charge_discharge_mAh")
    control = _require_float_column(records, "raw_control_v_or_mA")
    if np.any(_flag_column(records, flags, "error")):
        raise InvalidBiologicGcplError(
            "GCPL data contains a row with the BioLogic error flag set"
        )
    if np.any(_flag_column(records, flags, "counter_incremented")):
        raise UnsupportedBiologicGcplError(
            "GCPL counter-increment flag semantics are not independently validated; "
            "paired MPT evidence is required before cycle mapping can proceed"
        )
    current_ma = _raw_current_ma(records, mode, control)
    voltage_v, voltage_v_derived = _primary_voltage(records)

    ns_changed = _flag_column(records, flags, "ns_changed")
    _validate_ns_changed_flags(ns, ns_changed)
    boundaries = _step_boundaries(
        ns=ns,
        half_cycle=half_cycle,
        cycle=cycle,
        mode=mode,
        step_time=step_time,
    )
    _validate_step_time_boundaries(step_time, boundaries)
    _validate_capacity_boundaries(raw_capacity, raw_dq_mAh, boundaries)
    ranges = _block_ranges(boundaries)
    directions = [
        _direction_for_block(
            current_ma,
            raw_capacity,
            raw_dq_mAh,
            start,
            end,
            mode=mode,
        )
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
    time_s = (
        step_time.copy()
        if step_time is not None
        else np.empty(len(records), dtype=np.float64)
    )
    for step_number, ((start, end), block_status) in enumerate(zip(ranges, statuses), start=1):
        step[start:end] = step_number
        status[start:end] = block_status
        if step_time is None:
            time_s[start:end] = total_time_s[start:end] - total_time_s[start]
            # Avoid carrying a sub-microsecond negative caused by a source clock
            # representation at a boundary, while preserving real elapsed time.
            time_s[start:end] = np.maximum(time_s[start:end], 0.0)

    frame = pd.DataFrame(
        {
            "record_index": np.arange(1, len(records) + 1, dtype=np.int64),
            "cycle": cycle,
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
        "cycle_source": "explicit full-cycle field",
        "cycle_formula": "copied from independently decoded raw_cycle_index",
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
