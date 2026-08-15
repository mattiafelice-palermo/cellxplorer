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
from datetime import datetime, timedelta
import math
from pathlib import Path
import struct
from typing import Any

import numpy as np
import pandas as pd

from . import canonical_cycling, protocol
from .biologic_mpr import (
    MprDataBlock,
    MprDocument,
    MprModule,
    read_mpr,
)
from .source_format_errors import (
    InvalidSourceFormatError,
    SourceFormatError,
    UnsupportedSourceFormatError,
)


BIOLOGIC_GCPL_ADAPTER_REVISION = "gcpl5"

# Spec 041.3's supported settings contract is deliberately narrow.  The
# supplied EC-Lab 11.60 sample identifies the modern GCPL parameter layout by
# its technique byte, module version, parameter-count discriminator, and
# fixed item size.  Other software generations fail closed instead of being
# decoded through positional guesses.
GCPL_SETTINGS_LAYOUT = "ec-lab-11.60-gcpl-v1"
GCPL_TECHNIQUE_ID = 0x77
GCPL_SETTINGS_PARAMETER_OFFSET = 0x1847
GCPL_SETTINGS_PARAMETER_COUNT = 33
GCPL_SETTINGS_PARAMETER_ITEMSIZE = 108
GCPL_SOURCE_SEQUENCE_BASE = 0
GCPL_CANONICAL_STEP_BASE = 1
GCPL_STEP_INDEX_BASE_ADJUSTMENT = (
    GCPL_CANONICAL_STEP_BASE - GCPL_SOURCE_SEQUENCE_BASE
)

_GCPL_SETTINGS_MINIMUM_SIZE = GCPL_SETTINGS_PARAMETER_OFFSET + 4
_GCPL_LOG_TIMESTAMP_OFFSET = 0x0249
_GCPL_LOG_TIMESTAMP_SIZE = 8
_GCPL_OLE_BASE = datetime(1899, 12, 30)
_GCPL_OLE_MIN = 20000.0
_GCPL_OLE_MAX = 100000.0
_GCPL_PASCAL_FIELDS = {
    "comments": 0x0007,
    "electrode_material": 0x011E,
    "electrolyte": 0x01C0,
    "reference_electrode": 0x0215,
}
_GCPL_LOG_PASCAL_FIELDS = {
    "filename": 0x0251,
    "host": 0x0351,
    "address": 0x0384,
    "ec_lab_version": 0x03B7,
    "server_version": 0x03BE,
    "interpreter_version": 0x03C5,
    "device_serial": 0x03CF,
}
_CURRENT_UNIT_FACTORS_MA = {
    0: 1000.0,
    1: 1.0,
    2: 0.001,
    3: 0.000001,
    4: 0.000000001,
}
_CAPACITY_UNIT_FACTORS_MAH = {
    0: 1000.0,
    1: 1.0,
    2: 0.001,
    3: 0.000001,
    4: 0.000000001,
}
_SUPPORTED_CURRENT_VS_CODES = frozenset({2})
# The supplied EC-Lab 11.60 layout establishes current-reference selector 2
# as the only independently verified value. Other selectors remain unresolved
# until their source meaning is established and therefore fail closed.
_SUPPORTED_CURRENT_SIGN_CODES = frozenset({0})

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
    "raw_q_charge_discharge_mAh",
    "raw_half_cycle_index",
)


class BiologicGcplError(SourceFormatError):
    """Base error for a rejected BioLogic GCPL semantic source."""


class InvalidBiologicGcplError(BiologicGcplError, InvalidSourceFormatError):
    """The source is a recognized MPR but cannot be mapped safely."""


class UnsupportedBiologicGcplError(BiologicGcplError, UnsupportedSourceFormatError):
    """The MPR is outside the supported GCPL semantic contract."""


def _finite_setting(value: float) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def _positive_setting(value: float) -> float | None:
    number = _finite_setting(value)
    return number if number is not None and number > 0 else None


def _pascal_text(payload: bytes, offset: int, field_name: str) -> str | None:
    if offset >= len(payload):
        return None
    length = payload[offset]
    end = offset + 1 + length
    if end > len(payload):
        raise UnsupportedBiologicGcplError(
            f"GCPL settings {field_name} Pascal string is truncated"
        )
    value = payload[offset + 1 : end].decode("cp1252", errors="strict")
    value = value.rstrip("\x00").strip()
    return value or None


def _source_text(value: str | None) -> str | None:
    if value is None:
        return None
    if value.casefold() in {"unspecified", "(unspecified)", "none", "n/a"}:
        return None
    return value


def _read_f32(payload: bytes, offset: int, field_name: str) -> float | None:
    if offset + 4 > len(payload):
        raise UnsupportedBiologicGcplError(
            f"GCPL settings field {field_name!r} is truncated"
        )
    return _finite_setting(struct.unpack_from("<f", payload, offset)[0])


def _read_u32(payload: bytes, offset: int, field_name: str) -> int:
    if offset + 4 > len(payload):
        raise UnsupportedBiologicGcplError(
            f"GCPL settings field {field_name!r} is truncated"
        )
    return int(struct.unpack_from("<I", payload, offset)[0])


def _read_u16(payload: bytes, offset: int, field_name: str) -> int:
    if offset + 2 > len(payload):
        raise UnsupportedBiologicGcplError(
            f"GCPL settings field {field_name!r} is truncated"
        )
    return int(struct.unpack_from("<H", payload, offset)[0])


def _read_u8(payload: bytes, offset: int, field_name: str) -> int:
    if offset >= len(payload):
        raise UnsupportedBiologicGcplError(
            f"GCPL settings field {field_name!r} is truncated"
        )
    return int(payload[offset])


def _current_to_ma(value: float | None, unit_code: int) -> float | None:
    factor = _CURRENT_UNIT_FACTORS_MA.get(unit_code)
    if factor is None:
        raise UnsupportedBiologicGcplError(
            f"unsupported GCPL current unit code {unit_code}"
        )
    if value is None:
        return None
    return value * factor


def _capacity_to_mah(value: float | None, unit_code: int) -> float | None:
    factor = _CAPACITY_UNIT_FACTORS_MAH.get(unit_code)
    if factor is None:
        raise UnsupportedBiologicGcplError(
            f"unsupported GCPL capacity unit code {unit_code}"
        )
    if value is None:
        return None
    return value * factor


def _decode_gcpl_sequence(payload: bytes, sequence_number: int) -> dict[str, Any]:
    base = GCPL_SETTINGS_PARAMETER_OFFSET + 4 + (
        (sequence_number - 1) * GCPL_SETTINGS_PARAMETER_ITEMSIZE
    )
    set_i_c = _read_u8(payload, base, "Set I/C")
    if set_i_c not in {0, 1, 2}:
        raise UnsupportedBiologicGcplError(
            f"GCPL sequence {sequence_number} uses unsupported Set I/C code {set_i_c}"
        )
    current_raw = _read_f32(payload, base + 1, "Is")
    current_unit_code = _read_u8(payload, base + 5, "unit Is")
    current_vs_code = _read_u32(payload, base + 6, "unit Is vs.")
    if current_vs_code not in _SUPPORTED_CURRENT_VS_CODES:
        raise UnsupportedBiologicGcplError(
            f"unsupported GCPL current-reference code {current_vs_code}"
        )
    rate_value = _read_f32(payload, base + 10, "N")
    sign_code = _read_u32(payload, base + 14, "I sign")
    if sign_code not in _SUPPORTED_CURRENT_SIGN_CODES:
        raise UnsupportedBiologicGcplError(
            f"unsupported GCPL current-sign code {sign_code}"
        )
    t1_s = _positive_setting(_read_f32(payload, base + 18, "t1"))
    current_range_code = _read_u8(payload, base + 22, "I Range")
    bandwidth_code = _read_u8(payload, base + 23, "Bandwidth")
    record_delta_v = _positive_setting(_read_f32(payload, base + 24, "dE1"))
    record_interval_s = _positive_setting(_read_f32(payload, base + 28, "dt1"))
    voltage_limit_raw_v = _read_f32(payload, base + 32, "EM")
    voltage_limit_v = voltage_limit_raw_v
    hold_duration_raw_s = _positive_setting(_read_f32(payload, base + 36, "tM"))
    hold_duration_s = hold_duration_raw_s
    current_cutoff_raw = _read_f32(payload, base + 40, "Im")
    current_cutoff_unit_code = _read_u8(payload, base + 44, "unit Im")
    current_cutoff_ma = _current_to_ma(
        _positive_setting(current_cutoff_raw), current_cutoff_unit_code
    )
    voltage_range_lower_v = _read_f32(payload, base + 50, "E range min")
    voltage_range_upper_v = _read_f32(payload, base + 54, "E range max")
    capacity_record_delta_raw = _read_f32(payload, base + 58, "dq")
    capacity_unit_code = _read_u8(payload, base + 62, "unit dq")
    capacity_record_delta_mah = _capacity_to_mah(
        _positive_setting(capacity_record_delta_raw), capacity_unit_code
    )
    capacity_record_interval_s = _positive_setting(
        _read_f32(payload, base + 63, "dtq")
    )
    capacity_limit_raw = _read_f32(payload, base + 67, "dQM")
    capacity_limit_unit_code = _read_u8(payload, base + 71, "unit dQM")
    capacity_limit_mah = _capacity_to_mah(
        _positive_setting(capacity_limit_raw), capacity_limit_unit_code
    )
    rest_duration_s = _positive_setting(_read_f32(payload, base + 80, "tR"))
    rest_slope_limit_mV_per_h = _positive_setting(
        _read_f32(payload, base + 84, "dER/dt")
    )
    rest_record_delta_mV = _positive_setting(_read_f32(payload, base + 88, "dER"))
    rest_record_interval_s = _positive_setting(_read_f32(payload, base + 92, "dtR"))
    final_voltage_test_v = _read_f32(payload, base + 96, "EL")
    goto_step = _read_u32(payload, base + 100, "goto Ns")
    repeat_count = _read_u32(payload, base + 104, "nc cycles")

    # EC-Lab stores the signed Is value even when the control selector is
    # C/C×N.  Preserve that measured/set current alongside the explicit C-rate
    # instead of fabricating one from active mass.
    current_ma = _current_to_ma(current_raw, current_unit_code)
    c_rate = _positive_setting(rate_value) if set_i_c in {1, 2} else None
    # A finite zero EM is meaningful for active current/C-rate control. In the
    # verified layout it is disabled only for a zero-current sequence with no
    # explicit rate; retain negative finite settings instead of erasing them.
    if (
        voltage_limit_v == 0.0
        and (current_ma is None or abs(current_ma) <= _CURRENT_TOLERANCE_MA)
        and c_rate is None
    ):
        voltage_limit_v = None
    rest_source = "tR" if rest_duration_s is not None else None
    if (
        rest_duration_s is None
        and hold_duration_raw_s is not None
        and voltage_limit_v is None
        and set_i_c == 0
        and current_ma is not None
        and abs(current_ma) <= _CURRENT_TOLERANCE_MA
    ):
        # In the verified GCPL6 layout a zero-current sequence with tM but no
        # EM target is an open-circuit/rest phase (the supplied sample's last
        # sequence is mode 3 for exactly this setting). Preserve tM in raw
        # settings while exposing the normalized operation as Rest.
        rest_duration_s = hold_duration_raw_s
        rest_source = "tM_zero_current"
        hold_duration_s = None
    if current_ma is not None and abs(current_ma) > _CURRENT_TOLERANCE_MA:
        direction = "charge" if current_ma > 0 else "discharge"
    elif c_rate is not None:
        direction = None
    elif rest_duration_s is not None:
        direction = "rest"
    else:
        direction = "control"

    if hold_duration_s is not None and voltage_limit_v is None:
        # A hold duration without its voltage target is not enough to claim a
        # CV operation. Preserve the raw value and let the protocol builder
        # expose an explicit unsupported warning.
        hold_supported = False
    else:
        hold_supported = hold_duration_s is not None

    raw = {
        "set_i_c_code": set_i_c,
        "current_raw": current_raw,
        "current_unit_code": current_unit_code,
        "current_vs_code": current_vs_code,
        "rate_value": rate_value,
        "current_sign_code": sign_code,
        "t1_s": t1_s,
        "current_range_code": current_range_code,
        "bandwidth_code": bandwidth_code,
        "record_delta_mV": record_delta_v,
        "record_interval_s": record_interval_s,
        "voltage_limit_v": voltage_limit_v,
        "voltage_limit_raw_v": voltage_limit_raw_v,
        "hold_duration_s": hold_duration_raw_s,
        "hold_duration_raw_s": hold_duration_raw_s,
        "current_cutoff_raw": current_cutoff_raw,
        "current_cutoff_unit_code": current_cutoff_unit_code,
        "voltage_range_lower_v": voltage_range_lower_v,
        "voltage_range_upper_v": voltage_range_upper_v,
        "capacity_record_delta_raw": capacity_record_delta_raw,
        "capacity_unit_code": capacity_unit_code,
        "capacity_record_interval_s": capacity_record_interval_s,
        "capacity_limit_raw": capacity_limit_raw,
        "capacity_limit_unit_code": capacity_limit_unit_code,
        "rest_duration_s": rest_duration_s,
        "rest_source": rest_source,
        "rest_slope_limit_mV_per_h": rest_slope_limit_mV_per_h,
        "rest_record_delta_mV": rest_record_delta_mV,
        "rest_record_interval_s": rest_record_interval_s,
        "final_voltage_test_v": final_voltage_test_v,
        "goto_step": goto_step,
        "repeat_count": repeat_count,
    }
    return {
        "sequence_number": sequence_number,
        "step_index": sequence_number,
        "control": "current" if set_i_c == 0 else "c_rate",
        "set_i_c_code": set_i_c,
        "current_ma": current_ma,
        "c_rate": c_rate,
        "c_rate_source": "explicit" if c_rate is not None else None,
        "direction": direction,
        "current_vs_code": current_vs_code,
        "current_sign_code": sign_code,
        "time_limit_s": t1_s,
        "voltage_cutoff_v": voltage_limit_v,
        "hold_duration_s": hold_duration_s,
        "hold_supported": hold_supported,
        "current_cutoff_ma": current_cutoff_ma,
        "capacity_limit_mah": capacity_limit_mah,
        "capacity_record_delta_mah": capacity_record_delta_mah,
        "capacity_record_interval_s": capacity_record_interval_s,
        "record_interval_s": record_interval_s,
        "record_delta_v": None if record_delta_v is None else record_delta_v / 1000.0,
        "rest_duration_s": rest_duration_s,
        "rest_slope_limit_mV_per_h": rest_slope_limit_mV_per_h,
        "rest_record_delta_v": (
            None if rest_record_delta_mV is None else rest_record_delta_mV / 1000.0
        ),
        "rest_record_interval_s": rest_record_interval_s,
        "final_voltage_test_v": final_voltage_test_v,
        # This is the raw zero-based goto target. It is converted to the
        # canonical one-based protocol step only after the sequence count is
        # known and a nonzero repeat count proves that zero is a real target.
        "loop_start_step": None,
        "loop_count": repeat_count or None,
        "raw": raw,
    }


def decode_gcpl_settings(module: MprModule) -> dict[str, Any]:
    """Decode the independently verified modern GCPL settings layout."""

    payload = bytes(module.payload)
    if module.version != 10 or module.old_version != 0:
        raise UnsupportedBiologicGcplError(
            "GCPL settings module version is outside the verified contract"
        )
    if len(payload) < _GCPL_SETTINGS_MINIMUM_SIZE:
        raise UnsupportedBiologicGcplError("GCPL settings payload is truncated")
    technique_id = payload[0]
    if technique_id != GCPL_TECHNIQUE_ID:
        raise UnsupportedBiologicGcplError(
            f"unsupported BioLogic technique discriminator 0x{technique_id:02x}"
        )
    n_sequences = struct.unpack_from("<H", payload, GCPL_SETTINGS_PARAMETER_OFFSET)[0]
    n_parameters = struct.unpack_from(
        "<H", payload, GCPL_SETTINGS_PARAMETER_OFFSET + 2
    )[0]
    if n_sequences == 0 or n_sequences > 100:
        raise UnsupportedBiologicGcplError(
            f"GCPL settings declares unsupported sequence count {n_sequences}"
        )
    if n_parameters != GCPL_SETTINGS_PARAMETER_COUNT:
        raise UnsupportedBiologicGcplError(
            "GCPL settings parameter-count discriminator is not the verified "
            f"{GCPL_SETTINGS_PARAMETER_COUNT}-field layout"
        )
    params_end = (
        GCPL_SETTINGS_PARAMETER_OFFSET
        + 4
        + n_sequences * GCPL_SETTINGS_PARAMETER_ITEMSIZE
    )
    if params_end > len(payload):
        raise UnsupportedBiologicGcplError("GCPL settings parameter block is truncated")

    raw_comments = _pascal_text(payload, _GCPL_PASCAL_FIELDS["comments"], "comments")
    raw_reference = _pascal_text(
        payload,
        _GCPL_PASCAL_FIELDS["reference_electrode"],
        "reference_electrode",
    )
    electrode_material = _pascal_text(
        payload,
        _GCPL_PASCAL_FIELDS["electrode_material"],
        "electrode_material",
    )
    electrolyte = _pascal_text(
        payload,
        _GCPL_PASCAL_FIELDS["electrolyte"],
        "electrolyte",
    )
    active_mass_g = _positive_setting(_read_f32(payload, 0x0107, "active material mass"))
    molecular_weight = _positive_setting(
        _read_f32(payload, 0x010F, "molecular weight")
    )
    atomic_weight = _positive_setting(
        _read_f32(payload, 0x0113, "atomic weight")
    )
    electrons_transferred = _read_u16(payload, 0x011B, "electrons transferred")
    electrode_area_cm2 = _positive_setting(_read_f32(payload, 0x0211, "electrode area"))
    battery_capacity_raw = _positive_setting(
        _read_f32(payload, 0x025C, "battery capacity")
    )
    battery_capacity_unit_code = _read_u8(payload, 0x0260, "battery capacity unit")
    battery_capacity_mah = _capacity_to_mah(
        battery_capacity_raw, battery_capacity_unit_code
    )
    characteristic_mass_g = _positive_setting(
        _read_f32(payload, 0x024C, "characteristic mass")
    )
    acquisition_start_raw = _read_f32(payload, 0x0117, "acquisition start")
    sequences = list(
        _decode_gcpl_sequence(payload, sequence_number)
        for sequence_number in range(1, n_sequences + 1)
    )
    for sequence in sequences:
        raw_goto = int(sequence["raw"]["goto_step"])
        repeat_count = sequence.get("loop_count")
        if repeat_count is None:
            sequence["loop_start_step"] = None
            continue
        if raw_goto >= n_sequences:
            raise UnsupportedBiologicGcplError(
                f"GCPL goto Ns target {raw_goto} is outside the zero-based sequence range"
            )
        sequence["loop_start_step"] = raw_goto + GCPL_STEP_INDEX_BASE_ADJUSTMENT
    return {
        "layout": GCPL_SETTINGS_LAYOUT,
        "technique_id": technique_id,
        "technique": "GCPL",
        "technique_family": "GCPL",
        "comments": raw_comments,
        "electrode_material": _source_text(electrode_material),
        "electrode_material_raw": electrode_material,
        "electrolyte": _source_text(electrolyte),
        "electrolyte_raw": electrolyte,
        "active_material_mass_g": active_mass_g,
        "active_material_mass_mg": (
            None if active_mass_g is None else active_mass_g * 1000.0
        ),
        "electrode_area_cm2": electrode_area_cm2,
        "molecular_weight": molecular_weight,
        "atomic_weight": atomic_weight,
        "electrons_transferred": electrons_transferred,
        "characteristic_mass_g": characteristic_mass_g,
        "reference_electrode": _source_text(raw_reference),
        "reference_electrode_raw": raw_reference,
        "battery_capacity_raw": battery_capacity_raw,
        "battery_capacity_unit_code": battery_capacity_unit_code,
        "battery_capacity_mah": battery_capacity_mah,
        "acquisition_start_raw": acquisition_start_raw,
        "parameter_offset": GCPL_SETTINGS_PARAMETER_OFFSET,
        "parameter_count": n_parameters,
        "parameter_itemsize": GCPL_SETTINGS_PARAMETER_ITEMSIZE,
        "n_sequences": int(n_sequences),
        "sequences": sequences,
    }


def _read_log_string(payload: bytes, offset: int, field_name: str) -> str | None:
    if offset >= len(payload):
        return None
    length = payload[offset]
    end = offset + 1 + length
    if end > len(payload):
        raise UnsupportedBiologicGcplError(
            f"BioLogic LOG {field_name} Pascal string is truncated"
        )
    return payload[offset + 1 : end].decode("cp1252", errors="strict").strip() or None


def decode_gcpl_log(module: MprModule | None) -> dict[str, Any]:
    """Decode only the verified LOG identity/version/timestamp fields."""

    if module is None:
        return {
            "available": False,
            "absolute_timestamps": False,
            "timestamp_timezone": "local_wall_clock_naive",
            "warnings": ["The MPR has no VMP LOG module; absolute timestamps are unavailable."],
        }
    payload = bytes(module.payload)
    if module.version != 10 or module.old_version != 0:
        raise UnsupportedBiologicGcplError(
            "BioLogic LOG module version is outside the verified contract"
        )
    result: dict[str, Any] = {"available": True, "warnings": []}
    if len(payload) > 0x0009:
        result["channel_number"] = int(payload[0x0009])
    if len(payload) >= 0x00AB + 2:
        result["channel_serial"] = int(struct.unpack_from("<H", payload, 0x00AB)[0])
    for name, offset in _GCPL_LOG_PASCAL_FIELDS.items():
        result[name] = _read_log_string(payload, offset, name)

    ole_timestamp = None
    if len(payload) >= _GCPL_LOG_TIMESTAMP_OFFSET + _GCPL_LOG_TIMESTAMP_SIZE:
        ole_timestamp = _finite_setting(
            struct.unpack_from("<d", payload, _GCPL_LOG_TIMESTAMP_OFFSET)[0]
        )
    result["ole_timestamp"] = ole_timestamp
    timestamp = None
    if ole_timestamp is not None and _GCPL_OLE_MIN <= ole_timestamp <= _GCPL_OLE_MAX:
        try:
            timestamp = _GCPL_OLE_BASE + timedelta(days=ole_timestamp)
        except (OverflowError, ValueError):
            timestamp = None
    if timestamp is None:
        result["absolute_timestamps"] = False
        result["timestamp_timezone"] = "local_wall_clock_naive"
        result["start_time"] = None
        result["warnings"].append(
            "The VMP LOG has no reliable acquisition timestamp; absolute timestamps "
            "are unavailable and canonical timestamps remain NaT."
        )
    else:
        result["absolute_timestamps"] = True
        # EC-Lab stores this as a local wall-clock OLE date without an offset.
        # Keep it deliberately naive rather than claiming UTC or guessing the
        # workstation's historical DST rules.
        result["timestamp_timezone"] = "local_wall_clock_naive"
        result["start_time"] = timestamp.isoformat(timespec="microseconds")
    return result


def _format_gcpl_duration(seconds: float) -> str:
    if seconds >= 3600 and seconds % 3600 == 0:
        return f"{seconds / 3600:g} h"
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds / 60:g} min"
    return f"{seconds:g} s"


def build_gcpl_protocol(settings: Mapping[str, Any]) -> dict[str, Any]:
    """Map verified GCPL sequence settings into the shared protocol schema."""

    steps: list[dict[str, Any]] = []
    warnings: list[str] = []
    operational_cutoffs: list[dict[str, Any]] = []
    rest_durations: list[dict[str, Any]] = []
    loops: list[dict[str, Any]] = []
    rest_record_intervals: list[float] = []
    capacity_record_intervals: list[float] = []
    explicit_rate_available = False

    for sequence in settings.get("sequences") or []:
        number = int(sequence["step_index"])
        current_ma = sequence.get("current_ma")
        c_rate = sequence.get("c_rate")
        direction = sequence.get("direction")
        hold_supported = bool(sequence.get("hold_supported"))
        voltage_cutoff = sequence.get("voltage_cutoff_v")
        if c_rate is not None:
            explicit_rate_available = True

        if direction in {"charge", "discharge"}:
            if hold_supported:
                type_id = 7 if direction == "charge" else 20
            else:
                type_id = 1 if direction == "charge" else 2
        elif direction == "rest":
            type_id = 4
        else:
            type_id = 21
            warnings.append(
                f"GCPL sequence {number} has no independently resolvable current direction; "
                "it remains a control step."
            )
        label, schema_direction = protocol.STEP_TYPES[type_id]

        loop_start = sequence.get("loop_start_step")
        loop_count = sequence.get("loop_count")
        if loop_start is not None or loop_count is not None:
            valid_loop = (
                isinstance(loop_start, int)
                and isinstance(loop_count, int)
                and 0 < loop_start < number
                and loop_count > 0
            )
            if not valid_loop:
                warnings.append(
                    f"GCPL sequence {number} has an invalid goto/repeat declaration; "
                    "the raw loop fields are preserved but not used structurally."
                )
                loop_start = None
                loop_count = None
            else:
                loops.append(
                    {
                        "start_step": loop_start,
                        "control_step": number,
                        "repeat_count": loop_count,
                    }
                )

        direction_resolved = direction in {"charge", "discharge"}
        stop_current = (
            sequence.get("current_cutoff_ma")
            if hold_supported and direction_resolved
            else None
        )
        target_voltage = (
            voltage_cutoff if hold_supported and direction_resolved else None
        )
        stop_voltage = voltage_cutoff if direction_resolved else None
        time_limit = sequence.get("time_limit_s")
        if voltage_cutoff is not None and direction_resolved:
            operational_cutoffs.append(
                {
                    "step_index": number,
                    "direction": schema_direction,
                    "kind": "voltage",
                    "voltage_v": voltage_cutoff,
                    "operation": "hold" if hold_supported else "cutoff",
                }
            )
        if stop_current is not None:
            operational_cutoffs.append(
                {
                    "step_index": number,
                    "direction": schema_direction,
                    "kind": "current",
                    "current_ma": stop_current,
                    "operation": "hold_cutoff",
                }
            )
        if sequence.get("capacity_limit_mah") is not None and direction_resolved:
            operational_cutoffs.append(
                {
                    "step_index": number,
                    "direction": schema_direction,
                    "kind": "capacity",
                    "capacity_mah": sequence["capacity_limit_mah"],
                    "operation": "cutoff",
                }
            )
        if sequence.get("time_limit_s") is not None:
            operational_cutoffs.append(
                {
                    "step_index": number,
                    "direction": schema_direction,
                    "kind": "time",
                    "duration_s": sequence["time_limit_s"],
                    "operation": "cutoff",
                }
            )
        if sequence.get("capacity_record_interval_s") is not None:
            capacity_record_intervals.append(sequence["capacity_record_interval_s"])

        rest_duration = sequence.get("rest_duration_s")
        if rest_duration is not None:
            rest_durations.append(
                {"step_index": number, "duration_s": rest_duration}
            )
            if sequence.get("rest_record_interval_s") is not None:
                rest_record_intervals.append(sequence["rest_record_interval_s"])

        step: dict[str, Any] = {
            "number": number,
            "type_id": type_id,
            "type": label,
            "direction": schema_direction,
            "current_ma": None if schema_direction == "rest" else current_ma,
            "c_rate": c_rate,
            "c_rate_source": sequence.get("c_rate_source"),
            "target_voltage_v": target_voltage,
            "stop_voltage_v": stop_voltage,
            "stop_current_ma": stop_current,
            "stop_c_rate": None,
            "stop_c_rate_source": None,
            "time_limit_s": rest_duration if schema_direction == "rest" else time_limit,
            "record_interval_s": sequence.get("record_interval_s"),
            "record_voltage_delta_v": sequence.get("record_delta_v"),
            "protection_upper_v": None,
            "protection_lower_v": None,
            "loop_start_step": loop_start,
            "loop_count": loop_count,
            "loop_body_inclusive": bool(loop_start is not None),
            "conditions": [],
            "capacity_limit_mah": sequence.get("capacity_limit_mah"),
            "hold_duration_s": sequence.get("hold_duration_s"),
            "rest_duration_s": rest_duration,
            "final_voltage_test_v": sequence.get("final_voltage_test_v"),
            "raw_sequence": sequence.get("raw"),
        }
        steps.append(step)

    if any(step.get("final_voltage_test_v") is not None for step in steps):
        warnings.append(
            "GCPL final-potential tests are preserved as source metadata; the "
            "Neware condition grammar is not fabricated."
        )
    if any(
        step.get("hold_duration_s") is not None
        and step.get("target_voltage_v") is None
        for step in steps
    ):
        warnings.append(
            "A GCPL hold duration lacked a verified voltage target and was not mapped as CV."
        )
    warnings.append(
        "BioLogic GCPL conditions are not expressed in CellXplorer's Neware formula grammar; "
        "Chargeability condition matching is unavailable for this source."
    )
    capabilities = {
        "declared_protocol_available": bool(steps),
        "explicit_rate_available": explicit_rate_available,
        "operational_cutoffs_available": bool(operational_cutoffs),
        "loop_structure_available": bool(settings.get("layout")),
        "semantic_conditions_available": False,
    }
    result = protocol.build_declared_protocol(
        steps,
        nominal_capacity_mah=settings.get("battery_capacity_mah"),
        warnings=warnings,
        capabilities=capabilities,
        summary_extra={
            "operational_cutoffs": operational_cutoffs,
            "rest_durations_s": rest_durations,
            "rest_record_intervals_s": sorted(set(rest_record_intervals)),
            "capacity_record_intervals_s": sorted(set(capacity_record_intervals)),
            "loops": loops,
            "semantic_conditions_available": False,
        },
        signature_extra_fields=(
            "capacity_limit_mah",
            "hold_duration_s",
            "rest_duration_s",
            "final_voltage_test_v",
            "loop_body_inclusive",
        ),
    )
    for step in result["steps"]:
        rest_duration = step.get("rest_duration_s")
        if rest_duration is not None and step.get("direction") != "rest":
            step["facts"].append(
                {
                    "key": "rest",
                    "label": "Then rest",
                    "value": _format_gcpl_duration(rest_duration),
                    "note": "source-declared GCPL open-circuit period",
                }
            )
            step["summary"] += f" | then Rest {_format_gcpl_duration(rest_duration)}"
    return result


def _device_info(log: Mapping[str, Any]) -> str | None:
    parts = []
    if log.get("host"):
        parts.append(f"host {log['host']}")
    if log.get("address"):
        parts.append(f"address {log['address']}")
    if log.get("device_serial"):
        parts.append(f"device {log['device_serial']}")
    if log.get("channel_serial") is not None:
        parts.append(f"channel serial {log['channel_serial']}")
    return "; ".join(parts) or None


def _voltage_capabilities_for_document(
    document: MprDocument,
    reference_electrode: str | None,
) -> dict[str, Any]:
    column_ids = set(document.vmp_data.column_ids)
    working = 6 in column_ids
    counter = 9 in column_ids
    if working and counter:
        # The verified three-electrode layout contains Ewe/Ece and no
        # separately decoded Ecell field, so the canonical cell voltage is
        # derived by the adapter from the synchronized pair.
        return canonical_cycling.voltage_capabilities(
            working_potential_available=True,
            counter_potential_available=True,
            voltage_role="cell",
            reference_electrode=reference_electrode,
            voltage_derived=True,
            voltage_origin="derived_working_minus_counter",
        )
    # If a future independently verified two-electrode reader layout supplies
    # only Ewe, it will be the primary voltage channel. It must not be
    # advertised a second time as an auxiliary Working potential because no
    # counter-vs-reference channel establishes that role.
    return canonical_cycling.voltage_capabilities(
        working_potential_available=False,
        counter_potential_available=False,
        voltage_role="cell",
        reference_electrode=reference_electrode,
        voltage_derived=False,
        voltage_origin="measured",
    )


def read_gcpl_header_metadata(source: str | Path | MprDocument) -> dict[str, Any]:
    """Return normalized GCPL metadata without decoding data records."""

    if isinstance(source, MprDocument):
        return _gcpl_metadata_from_document(source)
    with read_mpr(source, decode_records=False) as document:
        return _gcpl_metadata_from_document(document)


def _gcpl_metadata_from_document(document: MprDocument) -> dict[str, Any]:
    settings = decode_gcpl_settings(document.vmp_set)
    log = decode_gcpl_log(document.vmp_log)
    declared_protocol = build_gcpl_protocol(settings)
    voltage_capabilities = _voltage_capabilities_for_document(
        document,
        settings.get("reference_electrode"),
    )
    log_warnings = list(log.get("warnings") or [])
    protocol_warnings = list(declared_protocol.get("warnings") or []) + log_warnings
    protocol_warnings.append(
        "BioLogic MPR metadata is readable, but canonical cycling rows remain unavailable "
        "until an independently verified logical cycle identity (full-cycle field) is "
        "available; this source is metadata-only."
    )
    capability_flags = dict(declared_protocol.get("capabilities") or {})
    capability_flags.update(
        {
            "cycling_rows": False,
            "canonical_cycling": False,
            "metadata_only": True,
            "absolute_timestamps": bool(log.get("absolute_timestamps")),
            "primary_voltage": bool(
                voltage_capabilities["capabilities"].get("primary_voltage")
            ),
            "working_potential": bool(
                voltage_capabilities["capabilities"].get("working_potential")
            ),
            "counter_potential": bool(
                voltage_capabilities["capabilities"].get("counter_potential")
            ),
        }
    )
    data_header = {
        "n_datapoints": document.vmp_data.n_datapoints,
        "n_columns": document.vmp_data.n_columns,
        "column_ids": list(document.vmp_data.column_ids),
        "record_offset": document.vmp_data.record_offset,
        "record_itemsize": document.vmp_data.record_itemsize,
    }
    module_headers = [
        {
            "short_name": module.short_name,
            "long_name": module.long_name,
            "version": module.version,
            "old_version": module.old_version,
            "length": module.length,
            "date": module.date_text,
        }
        for module in document.modules
    ]
    charge_cutoffs = declared_protocol["summary"]["charge_cutoffs"]
    discharge_cutoffs = declared_protocol["summary"]["discharge_cutoffs"]
    channel_number = log.get("channel_number")
    return {
        "source_format": "biologic_mpr",
        "technique": settings.get("technique"),
        "raw": {
            "modules": module_headers,
            "settings": settings,
            "log": log,
            "data": data_header,
            "capabilities": capability_flags,
            canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY: voltage_capabilities,
            protocol.DECLARED_PROTOCOL_METADATA_KEY: declared_protocol,
        },
        "remarks": settings.get("comments"),
        "start_time": log.get("start_time"),
        "absolute_timestamps": bool(log.get("absolute_timestamps")),
        "timestamp_timezone": log.get("timestamp_timezone"),
        # The LOG payload stores a zero-based channel index. Keep that raw
        # index in channel_number while exposing the one-based EC-Lab display
        # number through the normalized channel field.
        "channel": None if channel_number is None else str(channel_number + 1),
        "channel_number": channel_number,
        "device_info": _device_info(log),
        "software_version": log.get("ec_lab_version"),
        "software": {
            key: log.get(key)
            for key in (
                "ec_lab_version",
                "server_version",
                "interpreter_version",
            )
            if log.get(key) is not None
        },
        "active_mass_mg": settings.get("active_material_mass_mg"),
        "active_material_mg": settings.get("active_material_mass_mg"),
        "nominal_capacity_mah": settings.get("battery_capacity_mah"),
        "electrode_area_cm2": settings.get("electrode_area_cm2"),
        "electrode_material": settings.get("electrode_material"),
        "electrolyte": settings.get("electrolyte"),
        "reference_electrode": settings.get("reference_electrode"),
        "charge_cutoff_v": (
            charge_cutoffs[0]["voltage_v"] if charge_cutoffs else None
        ),
        "discharge_cutoff_v": (
            discharge_cutoffs[0]["voltage_v"] if discharge_cutoffs else None
        ),
        "protection_voltage_upper_v": None,
        "protection_voltage_lower_v": None,
        "voltage_upper_v": None,
        "voltage_lower_v": None,
        "record_interval_s": (
            declared_protocol["summary"]["record_intervals_s"][0]
            if declared_protocol["summary"]["record_intervals_s"]
            else None
        ),
        "protocol": declared_protocol,
        "protocol_warnings": protocol_warnings,
        "capabilities": capability_flags,
        "voltage_capabilities": voltage_capabilities,
        "voltage_roles": voltage_capabilities["voltage_roles"],
    }


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


def _validate_document_settings(document: MprDocument) -> dict[str, Any]:
    """Validate the full-file settings/data identity before canonical mapping."""

    settings = decode_gcpl_settings(document.vmp_set)
    records = document.vmp_data.records
    if records is None:
        raise InvalidBiologicGcplError(
            "GCPL canonical mapping requires decoded MPR data records"
        )
    fields = _field_names(records)
    if "raw_sample_index" not in fields:
        raise UnsupportedBiologicGcplError(
            "GCPL data records do not contain the declared Ns sequence identity"
        )
    observed_values = np.asarray(records["raw_sample_index"], dtype=np.float64)
    if (
        not np.isfinite(observed_values).all()
        or np.any(observed_values != np.floor(observed_values))
        or np.any(observed_values < GCPL_SOURCE_SEQUENCE_BASE)
    ):
        raise UnsupportedBiologicGcplError(
            "GCPL observed Ns values are not finite non-negative integers"
        )
    observed = {
        int(value) + GCPL_STEP_INDEX_BASE_ADJUSTMENT
        for value in np.unique(observed_values)
    }
    declared = {
        int(sequence["step_index"])
        for sequence in settings.get("sequences") or ()
    }
    unknown = sorted(observed - declared)
    if unknown:
        raise UnsupportedBiologicGcplError(
            "GCPL data observes Ns value(s) not declared by the settings: "
            + ", ".join(str(value) for value in unknown)
        )
    return settings


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

    The verified private layout contains only zero-valued half-cycle records.
    Without paired text-export evidence, the starting value, direction,
    formation handling, and progression of a non-zero counter are not
    independently established. It is safer to defer multi-half-cycle
    canonical numbering than to publish a plausible but wrong cycle grouping.
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

    The verified MPR layout has no independently decoded logical-cycle field,
    and its half-cycle counter has no paired MPT semantics yet. Semantic test
    records may provide ``raw_cycle_index`` to exercise the canonical adapter;
    the production MPR path must not invent a cycle label.
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
            "GCPL Ns-change flag is ambiguous for a repeated Ns under the verified adapter "
            "contract"
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
    cycle: np.ndarray | None,
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
    if cycle is not None:
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


def _primary_voltage(
    records: np.ndarray,
) -> tuple[
    np.ndarray,
    bool,
    np.ndarray | None,
    np.ndarray | None,
    str,
]:
    direct = _optional_column(records, "raw_voltage_v", "raw_ecell_v", "ecell_v")
    working = _optional_column(records, "raw_ewe_v", "working_potential_v", "ewe_v")
    counter = _optional_column(records, "raw_ece_v", "counter_potential_v", "ece_v")
    for name, values in (("working potential", working), ("counter potential", counter)):
        if values is not None and not np.isfinite(values).all():
            raise InvalidBiologicGcplError(
                f"GCPL {name} contains non-finite values"
            )
    if direct is not None:
        if not np.isfinite(direct).all():
            raise InvalidBiologicGcplError("GCPL primary voltage contains non-finite values")
        return direct, False, working, counter, "measured"
    if working is not None and counter is not None:
        # Official GCPL6 semantics are Ecell = Ewe - Ece.  Preserve the sign;
        # taking an absolute value would erase electrode polarity information.
        return working - counter, True, working, counter, "derived_working_minus_counter"
    if working is not None:
        # In a future verified two-electrode layout the Ewe-labelled channel
        # is the measured primary cell voltage. It is not published again as
        # a three-electrode auxiliary column because no counter-vs-reference
        # channel is present to establish that role.
        return working, False, None, None, "measured"
    raise UnsupportedBiologicGcplError(
        "GCPL primary full-cell voltage is not independently resolved: a verified Ecell "
        "field or synchronized Ewe/Ece pair is required"
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


def map_gcpl_to_canonical(
    source: Any,
    *,
    acquisition_start: str | datetime | pd.Timestamp | None = None,
) -> pd.DataFrame:
    """Map one supported MPR data source into the canonical raw frame."""

    if isinstance(source, MprDocument):
        _validate_document_settings(source)
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
    raw_ns = _validate_integer_column(
        _column(records, "raw_sample_index"), "Ns", positive=False
    )
    if np.any(raw_ns < GCPL_SOURCE_SEQUENCE_BASE):
        raise UnsupportedBiologicGcplError(
            "GCPL Ns contains a negative source sequence identity"
        )
    ns = raw_ns + GCPL_STEP_INDEX_BASE_ADJUSTMENT
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
            "GCPL counter-increment flag semantics are outside the verified adapter contract"
        )
    current_ma = _raw_current_ma(records, mode, control)
    voltage_v, voltage_v_derived, working, counter, voltage_origin = _primary_voltage(
        records
    )

    if acquisition_start is None and isinstance(source, MprDocument):
        acquisition_start = decode_gcpl_log(source.vmp_log).get("start_time")
    start_timestamp: pd.Timestamp | None = None
    if acquisition_start is not None:
        try:
            parsed_start = pd.Timestamp(acquisition_start)
            if parsed_start is not pd.NaT and not pd.isna(parsed_start):
                start_timestamp = parsed_start
        except (TypeError, ValueError):
            raise InvalidBiologicGcplError(
                "GCPL acquisition start timestamp is not datetime-compatible"
            ) from None

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

    frame_values: dict[str, Any] = {
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
    if working is not None:
        frame_values["working_potential_v"] = working
    if counter is not None:
        frame_values["counter_potential_v"] = counter
    if start_timestamp is None:
        frame_values["timestamp"] = pd.Series(
            pd.NaT, index=range(len(records)), dtype="datetime64[ns]"
        )
    else:
        frame_values["timestamp"] = start_timestamp + pd.to_timedelta(
            total_time_s, unit="s"
        )
    frame = pd.DataFrame(frame_values)
    frame.attrs["biologic_gcpl"] = {
        "adapter_revision": BIOLOGIC_GCPL_ADAPTER_REVISION,
        "record_index_base": 1,
        "step_index_source": "Ns",
        "step_index_base_adjustment": GCPL_STEP_INDEX_BASE_ADJUSTMENT,
        "cycle_source": "explicit full-cycle field",
        "cycle_formula": "copied from independently decoded raw_cycle_index",
        "current_sign_factor": 1,
        "energy_policy": "C-unavailable",
        "absolute_timestamps": start_timestamp is not None,
        "voltage_v_derived": voltage_v_derived,
        "voltage_v_origin": voltage_origin,
        "voltage_roles": {
            "voltage_v": "cell",
            **({"working_potential_v": "working_vs_reference"} if working is not None else {}),
            **({"counter_potential_v": "counter_vs_reference"} if counter is not None else {}),
        },
        "timestamp_timezone": "local_wall_clock_naive" if start_timestamp is not None else None,
    }
    canonical_cycling.validate_raw_timeseries(frame)
    return frame


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    """Read and map a supported BioLogic MPR directly to canonical data."""

    with read_mpr(path) as document:
        _validate_document_settings(document)
        start_time = decode_gcpl_log(document.vmp_log).get("start_time")
        return map_gcpl_to_canonical(document, acquisition_start=start_time)


__all__ = [
    "BIOLOGIC_GCPL_ADAPTER_REVISION",
    "GCPL_SETTINGS_LAYOUT",
    "GCPL_SETTINGS_PARAMETER_COUNT",
    "GCPL_SETTINGS_PARAMETER_ITEMSIZE",
    "GCPL_SETTINGS_PARAMETER_OFFSET",
    "GCPL_SOURCE_SEQUENCE_BASE",
    "GCPL_CANONICAL_STEP_BASE",
    "GCPL_STEP_INDEX_BASE_ADJUSTMENT",
    "GCPL_TECHNIQUE_ID",
    "BiologicGcplError",
    "build_gcpl_protocol",
    "decode_gcpl_log",
    "decode_gcpl_settings",
    "InvalidBiologicGcplError",
    "MPR_MODE_GALVANOSTATIC",
    "MPR_MODE_POTENTIOSTATIC",
    "MPR_MODE_REST",
    "UnsupportedBiologicGcplError",
    "integrate_capacity_by_step",
    "map_gcpl_to_canonical",
    "parse_timeseries",
    "read_gcpl_header_metadata",
]
