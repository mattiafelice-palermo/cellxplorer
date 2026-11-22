"""Maccor tab-delimited record exports with Cycle C, unsigned A, Ah and Wh."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import BinaryIO

import numpy as np
import pandas as pd

from . import maccor_records
from .canonical_cycling import voltage_capabilities
from .maccor_cycling import canonical_records
from .maccor_metadata import with_normalization
from .protocol import DECLARED_PROTOCOL_METADATA_KEY, build_declared_protocol
from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


ADAPTER_REVISION = 4
_HEADER_BYTES = 64 * 1024
_REQUIRED = (
    "Rec", "Cycle P", "Cycle C", "Step", "TestTime", "StepTime", "Cap. [Ah]",
    "Ener. [Wh]", "Current [A]", "Voltage [V]", "Md", "ES", "DPT Time",
)
_LOCAL_TIME = "%d/%m/%Y %H:%M:%S"
_TIME_CURVE = ["Rec", "Time", "Voltage", "Current"]


def _header(stream: BinaryIO) -> tuple[dict[str, str], list[str]]:
    remaining = _HEADER_BYTES
    fields: dict[str, str] = {}
    while remaining > 0:
        line = stream.readline(remaining + 1)
        if not line or len(line) > remaining:
            break
        remaining -= len(line)
        line = line.removeprefix(b"\xef\xbb\xbf").strip(b"\r\n")
        if not line.strip():
            continue
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            text = line.decode("cp1252", errors="replace")
        parts = text.split("\t")
        if not fields and parts[0] != "Name:":
            break
        if parts[0] == "Rec":
            while parts and not parts[-1]:
                parts.pop()
            if not fields.get("Tester", "").casefold().startswith("maccor"):
                break
            if parts == _TIME_CURVE:
                units = stream.readline(remaining + 1)
                if len(units) <= remaining and units.rstrip(b"\r\n\t").split(b"\t") == [b"", b"[h]", b"[V]", b"[A]"]:
                    return fields, parts
                break
            if not set(_REQUIRED).issubset(parts):
                break
            if len(parts) != len(set(parts)) or "" in parts:
                raise InvalidSourceFormatError("Maccor record header has duplicate or empty columns.")
            return fields, parts
        if len(parts) < 2 or any(parts[2:]):
            break
        key = parts[0].rstrip(":")
        if key in fields:
            raise UnsupportedSourceFormatError("Ambiguous Maccor text header.")
        fields[key] = parts[1]
    raise UnsupportedSourceFormatError(
        "Expected a Maccor tab-separated record export with Cycle C, numeric times, "
        "Ah, Wh, A, V, mode, end status and DPT Time."
    )


def read_header_metadata(path: str | Path) -> dict:
    if maccor_records.delimited_signature(Path(path)):
        return maccor_records.text_metadata(Path(path))
    with Path(path).open("rb") as stream:
        fields, columns = _header(stream)
    started = fields.get("Started")
    start_time = None
    if started:
        for fmt in (_LOCAL_TIME, "%d-%b-%y %I:%M:%S %p"):
            try:
                start_time = datetime.strptime(started, fmt).isoformat()
                break
            except ValueError:
                continue
        if start_time is None:
            raise InvalidSourceFormatError("Invalid Maccor Started date.")
    declared = build_declared_protocol(
        [], warnings=["This Maccor export records the procedure name and executed steps only."]
    )
    return with_normalization({
        "raw": {"Maccor": fields, "record_columns": columns, "maccor_format": "text", DECLARED_PROTOCOL_METADATA_KEY: declared},
        "source_format": "Maccor text",
        "device_info": fields["Tester"],
        "channel": fields.get("Channel"),
        "remarks": fields.get("Description"),
        "start_time": start_time,
        "protocol_warnings": declared["warnings"],
        "voltage_capabilities": voltage_capabilities(),
    })


def _read_records(path: Path) -> pd.DataFrame:
    with path.open("rb") as stream:
        _, columns = _header(stream)
        chunks = []
        records = []
        for row_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            values = line.rstrip(b"\r\n").split(b"\t")
            if len(values) < len(columns) or any(values[len(columns):]):
                raise InvalidSourceFormatError(f"Maccor data line {row_number} has the wrong field count.")
            records.append(values[:len(columns)])
            if len(records) == 16_384:
                chunks.append(_decode_columns(records, columns))
                records.clear()
        if records:
            chunks.append(_decode_columns(records, columns))
    if not chunks:
        raise InvalidSourceFormatError("The Maccor export contains no measurement records.")
    return pd.concat(chunks, ignore_index=True)


def _decode_columns(records: list[list[bytes]], columns: list[str]) -> pd.DataFrame:
    table = pd.DataFrame(records, columns=columns)
    variables = [key for key in columns if key.startswith("VAR") and key[3:].isdigit()]
    if columns != _TIME_CURVE:
        table = table.loc[:, [*_REQUIRED, *variables]]
    for key in table.columns:
        try:
            if key == "DPT Time":
                table[key] = pd.to_datetime(table[key].str.decode("ascii"), format=_LOCAL_TIME)
            elif key == "Md":
                table[key] = table[key].str.decode("ascii")
            else:
                table[key] = pd.to_numeric(table[key].str.decode("ascii").str.replace(",", ".", regex=False), errors="raise")
                if not np.isfinite(table[key]).all():
                    raise ValueError("non-finite")
        except (UnicodeError, TypeError, ValueError, OverflowError) as exc:
            raise InvalidSourceFormatError(f"Invalid Maccor {key} value.") from exc
        if table[key].isna().any():
            raise InvalidSourceFormatError(f"Missing Maccor {key} value.")
    for key in (k for k in ("Rec", "Cycle P", "Cycle C", "Step", "ES") if k in table):
        if not pd.api.types.is_integer_dtype(table[key]) or (table[key] < 0).any():
            raise InvalidSourceFormatError(f"Maccor {key} must contain nonnegative integers.")
    return table


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    if maccor_records.delimited_signature(Path(path)):
        return maccor_records.parse(Path(path), workbook=False)
    table = _read_records(Path(path))
    if list(table.columns) != _TIME_CURVE:
        return canonical_records(table, verify_minute_units=True)
    if (table.Rec.iloc[0] < 1 or table.Rec.diff().iloc[1:].ne(1).any()
            or table.Time.lt(0).any() or not table.Time.is_monotonic_increasing):
        raise InvalidSourceFormatError("Maccor time curve requires consecutive records and an ordered elapsed clock.")
    seconds = table.Time * 3600
    # This export has no operating mode or counters. Keep the current exactly
    # as reported, including its sign, without assigning charge or discharge.
    return pd.DataFrame({
        "record_index": table.Rec, "cycle": 1, "step_index": 1, "step": 1,
        "time_s": seconds, "total_time_s": seconds, "voltage_v": table.Voltage,
        "current_ma": table.Current * 1000, "status": "Unverified", "maccor_mode": "Recorded",
        "charge_capacity_mah": np.nan, "discharge_capacity_mah": np.nan,
        "cycle_complete": False, "capacity_verified": False, "cv_mode_known": False,
    })
