"""Small deterministic MPR builders for semantic adapter tests.

The builders encode the byte offsets documented by Spec 041.1 directly with
``struct.pack_into``.  They intentionally do not construct records through
the production structured dtype, so the tests retain an independent byte
level boundary between the container reader and GCPL mapper.
"""

from __future__ import annotations

from pathlib import Path
import struct
from typing import Mapping, Sequence

from backend.app.services.biologic_mpr import (
    MPR_MAGIC,
    MPR_MODULE_HEADER_SIZE,
    SUPPORTED_GCPL_COLUMN_IDS,
    VMP_DATA_RECORD_OFFSET,
)


def _module(
    *,
    short_name: bytes,
    long_name: bytes,
    payload: bytes,
    version: int,
) -> bytes:
    header = (
        b"MODULE"
        + short_name.ljust(10, b" ")[:10]
        + long_name.ljust(25, b" ")[:25]
        + struct.pack("<IIII", 0xFFFFFFFF, len(payload), 0, version)
        + b"07/10/26"
    )
    assert len(header) == MPR_MODULE_HEADER_SIZE
    return header + payload


_FIXTURE_ORDINARY_FIELDS = {
    131: ("<H", 2, "ns", 1),
    4: ("<d", 8, "total_time_s", 0.0),
    7: ("<d", 8, "raw_dq_mAh", 0.0),
    13: ("<d", 8, "raw_q_minus_q0_mAh", 0.0),
    5: ("<f", 4, "control", 0.0),
    6: ("<f", 4, "ewe_v", 3.5),
    9: ("<f", 4, "ece_v", 0.0),
    39: ("<H", 2, "current_range_code", 10),
    211: ("<d", 8, "q_mAh", 0.0),
    212: ("<I", 4, "half_cycle", 0),
    123: ("<d", 8, "working_charge_energy", 0.0),
    124: ("<d", 8, "working_discharge_energy", 0.0),
    125: ("<d", 8, "charge_capacitance", 0.0),
    126: ("<d", 8, "discharge_capacitance", 0.0),
    182: ("<d", 8, "step_elapsed_time_s", 0.0),
}
_FIXTURE_FLAG_IDS = {1, 2, 3, 21, 31, 65}


def encode_gcpl_records(
    rows: Sequence[Mapping[str, object]],
    *,
    column_ids: Sequence[int] = SUPPORTED_GCPL_COLUMN_IDS,
) -> bytes:
    """Encode semantic rows into a declared column sequence independently."""

    cursor = 0
    for encoded_id in column_ids:
        if encoded_id in _FIXTURE_FLAG_IDS:
            if encoded_id == 1:
                cursor += 1
            continue
        field = _FIXTURE_ORDINARY_FIELDS.get(int(encoded_id) % 256)
        if field is None:
            raise ValueError(f"fixture has no byte definition for column {encoded_id}")
        cursor += field[1]
    record_itemsize = cursor
    records = bytearray(len(rows) * record_itemsize)
    for index, row in enumerate(rows):
        mode = int(row.get("mode", 1))
        flags = mode & 0x03
        if row.get("oxidation_reduction", False):
            flags |= 0x04
        if row.get("error", False):
            flags |= 0x08
        if row.get("control_changed", False):
            flags |= 0x10
        if row.get("ns_changed", index == 0):
            flags |= 0x20
        if row.get("counter_incremented", False):
            flags |= 0x80
        base = index * record_itemsize
        cursor = 0
        for encoded_id in column_ids:
            if encoded_id in _FIXTURE_FLAG_IDS:
                if encoded_id == 1:
                    struct.pack_into("<B", records, base + cursor, flags)
                    cursor += 1
                continue
            format_string, width, key, default = _FIXTURE_ORDINARY_FIELDS[int(encoded_id) % 256]
            value = row.get(key, default)
            if key == "raw_q_minus_q0_mAh":
                value = row.get(key, row.get("q_mAh", default))
            struct.pack_into(
                format_string,
                records,
                base + cursor,
                int(value) if format_string in {"<H", "<I"} else float(value),
            )
            cursor += width
    return bytes(records)


def _pascal_write(payload: bytearray, offset: int, value: str | None) -> None:
    encoded = (value or "").encode("cp1252")
    if len(encoded) > 255:
        raise ValueError("fixture Pascal strings must fit in one byte")
    payload[offset] = len(encoded)
    payload[offset + 1 : offset + 1 + len(encoded)] = encoded


def encode_gcpl_settings(
    sequences: Sequence[Mapping[str, object]],
    *,
    technique_id: int = 0x77,
    comments: str | None = "fixture GCPL",
    active_mass_g: float = 0.001,
    electrode_area_cm2: float = 1.5,
    reference_electrode: str | None = None,
    battery_capacity: float = 0.0,
    battery_capacity_unit: int = 0,
) -> bytes:
    """Encode a fixture for one registered GCPL settings profile."""

    if not sequences or len(sequences) > 100:
        raise ValueError("fixture sequence count must be in 1..100")
    payload = bytearray(0x1847 + 4 + len(sequences) * 108)
    payload[0] = technique_id
    _pascal_write(payload, 0x0007, comments)
    struct.pack_into("<f", payload, 0x0107, active_mass_g)
    struct.pack_into("<f", payload, 0x0211, electrode_area_cm2)
    _pascal_write(payload, 0x0215, reference_electrode)
    struct.pack_into("<f", payload, 0x025C, battery_capacity)
    payload[0x0260] = battery_capacity_unit
    struct.pack_into("<HH", payload, 0x1847, len(sequences), 33)
    for index, sequence in enumerate(sequences):
        base = 0x1847 + 4 + index * 108
        struct.pack_into("<B", payload, base, int(sequence.get("set_i_c", 0)))
        struct.pack_into("<f", payload, base + 1, float(sequence.get("current", 0.0)))
        payload[base + 5] = int(sequence.get("current_unit", 1))
        struct.pack_into("<I", payload, base + 6, int(sequence.get("current_vs", 2)))
        struct.pack_into("<f", payload, base + 10, float(sequence.get("c_rate", 1.0)))
        struct.pack_into("<I", payload, base + 14, int(sequence.get("sign_code", 0)))
        struct.pack_into("<f", payload, base + 18, float(sequence.get("t1_s", 0.0)))
        payload[base + 22] = int(sequence.get("current_range", 9))
        payload[base + 23] = int(sequence.get("bandwidth", 5))
        struct.pack_into("<f", payload, base + 24, float(sequence.get("record_delta_mV", 0.0)))
        struct.pack_into("<f", payload, base + 28, float(sequence.get("record_interval_s", 0.0)))
        struct.pack_into("<f", payload, base + 32, float(sequence.get("voltage_limit_v", 0.0)))
        struct.pack_into("<f", payload, base + 36, float(sequence.get("hold_duration_s", 0.0)))
        struct.pack_into("<f", payload, base + 40, float(sequence.get("current_cutoff", 0.0)))
        payload[base + 44] = int(sequence.get("current_cutoff_unit", 1))
        struct.pack_into("<f", payload, base + 50, float(sequence.get("range_lower_v", 0.0)))
        struct.pack_into("<f", payload, base + 54, float(sequence.get("range_upper_v", 5.0)))
        struct.pack_into("<f", payload, base + 58, float(sequence.get("capacity_delta", 0.0)))
        payload[base + 62] = int(sequence.get("capacity_unit", 1))
        struct.pack_into("<f", payload, base + 67, float(sequence.get("capacity_limit", 0.0)))
        payload[base + 71] = int(sequence.get("capacity_limit_unit", 1))
        struct.pack_into("<f", payload, base + 80, float(sequence.get("rest_duration_s", 0.0)))
        struct.pack_into("<f", payload, base + 84, float(sequence.get("rest_slope_mV_per_h", 0.0)))
        struct.pack_into("<f", payload, base + 88, float(sequence.get("rest_delta_mV", 0.0)))
        struct.pack_into("<f", payload, base + 92, float(sequence.get("rest_interval_s", 0.0)))
        struct.pack_into("<f", payload, base + 96, float(sequence.get("final_voltage_v", float("nan"))))
        struct.pack_into("<I", payload, base + 100, int(sequence.get("goto_step", 0)))
        struct.pack_into("<I", payload, base + 104, int(sequence.get("repeat_count", 0)))
    return bytes(payload)


def encode_gcpl_log(
    *,
    ole_timestamp: float | None = 45000.0,
    channel_number: int = 2,
    channel_serial: int = 1234,
    filename: str = "fixture.mpr",
    host: str = "127.0.0.1",
    address: str = "127.0.0.2",
    ec_lab_version: str = "11.60",
    server_version: str = "11.60",
    interpreter_version: str = "11.60",
    device_serial: str = "fixture-device",
) -> bytes:
    """Encode the bounded LOG fields used by Spec 041.3 tests."""

    payload = bytearray(0x03CF + 1 + len(device_serial.encode("cp1252")))
    payload[0x0009] = channel_number
    struct.pack_into("<H", payload, 0x00AB, channel_serial)
    if ole_timestamp is not None:
        struct.pack_into("<d", payload, 0x0249, ole_timestamp)
    for offset, value in (
        (0x0251, filename),
        (0x0351, host),
        (0x0384, address),
        (0x03B7, ec_lab_version),
        (0x03BE, server_version),
        (0x03C5, interpreter_version),
        (0x03CF, device_serial),
    ):
        _pascal_write(payload, offset, value)
    return bytes(payload)


def write_gcpl_mpr(
    path: str | Path,
    rows: Sequence[Mapping[str, object]],
    *,
    settings_payload: bytes = b"settings",
    log_payload: bytes = b"log",
    include_log: bool = False,
    column_ids: Sequence[int] = SUPPORTED_GCPL_COLUMN_IDS,
) -> Path:
    """Write a minimal VMP Set + VMP data MPR fixture."""

    records = encode_gcpl_records(rows, column_ids=column_ids)
    data_payload = (
        struct.pack("<I", len(rows))
        + bytes([len(column_ids)])
        + struct.pack(f">{len(column_ids)}H", *column_ids)
    )
    data_payload = data_payload.ljust(VMP_DATA_RECORD_OFFSET, b"\x00") + records
    modules = (
        _module(
            short_name=b"VMP Set",
            long_name=b"VMP settings",
            payload=settings_payload,
            version=10,
        ),
        _module(
            short_name=b"VMP data",
            long_name=b"VMP data",
            payload=data_payload,
            version=11,
        ),
    )
    if include_log:
        modules = modules + (
            _module(
                short_name=b"VMP LOG",
                long_name=b"VMP LOG",
                payload=log_payload,
                version=10,
            ),
        )
    output = Path(path)
    output.write_bytes(MPR_MAGIC + b"".join(modules))
    return output


__all__ = [
    "encode_gcpl_log",
    "encode_gcpl_records",
    "encode_gcpl_settings",
    "write_gcpl_mpr",
]
