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
    VMP_DATA_RECORD_ITEMSIZE,
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


def encode_gcpl_records(rows: Sequence[Mapping[str, object]]) -> bytes:
    """Encode semantic rows into the verified 53-byte physical record area."""

    records = bytearray(len(rows) * VMP_DATA_RECORD_ITEMSIZE)
    for index, row in enumerate(rows):
        base = index * VMP_DATA_RECORD_ITEMSIZE
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

        field_specs = (
            (0, "<B", flags),
            (1, "<H", int(row.get("ns", 1))),
            (3, "<d", float(row["total_time_s"])),
            (11, "<d", float(row.get("raw_dq_mAh", 0.0))),
            (19, "<d", float(row.get("raw_q_minus_q0_mAh", row.get("q_mAh", 0.0)))),
            (27, "<f", float(row.get("control", 0.0))),
            (31, "<f", float(row.get("ewe_v", 3.5))),
            (35, "<f", float(row.get("ece_v", 0.0))),
            (39, "<H", int(row.get("current_range_code", 10))),
            (41, "<d", float(row.get("q_mAh", 0.0))),
            (49, "<I", int(row.get("half_cycle", 0))),
        )
        for offset, format_string, value in field_specs:
            struct.pack_into(format_string, records, base + offset, value)
    return bytes(records)


def write_gcpl_mpr(path: str | Path, rows: Sequence[Mapping[str, object]]) -> Path:
    """Write a minimal VMP Set + VMP data MPR fixture."""

    records = encode_gcpl_records(rows)
    data_payload = (
        struct.pack("<I", len(rows))
        + bytes([len(SUPPORTED_GCPL_COLUMN_IDS)])
        + struct.pack(f">{len(SUPPORTED_GCPL_COLUMN_IDS)}H", *SUPPORTED_GCPL_COLUMN_IDS)
    )
    data_payload = data_payload.ljust(VMP_DATA_RECORD_OFFSET, b"\x00") + records
    modules = (
        _module(
            short_name=b"VMP Set",
            long_name=b"VMP settings",
            payload=b"settings",
            version=10,
        ),
        _module(
            short_name=b"VMP data",
            long_name=b"VMP data",
            payload=data_payload,
            version=11,
        ),
    )
    output = Path(path)
    output.write_bytes(MPR_MAGIC + b"".join(modules))
    return output


__all__ = ["encode_gcpl_records", "write_gcpl_mpr"]
