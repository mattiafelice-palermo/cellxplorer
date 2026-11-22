"""Maccor tab-delimited record exports with Cycle C, unsigned A, Ah and Wh."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import BinaryIO

import numpy as np
import pandas as pd

from .canonical_cycling import voltage_capabilities
from .maccor_cycling import canonical_records
from .protocol import DECLARED_PROTOCOL_METADATA_KEY, build_declared_protocol
from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


ADAPTER_REVISION = 1
_HEADER_BYTES = 64 * 1024
_REQUIRED = (
    "Rec", "Cycle P", "Cycle C", "Step", "TestTime", "StepTime", "Cap. [Ah]",
    "Ener. [Wh]", "Current [A]", "Voltage [V]", "Md", "ES", "DPT Time",
)
_LOCAL_TIME = "%d/%m/%Y %H:%M:%S"


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
            if (not fields.get("Tester", "").casefold().startswith("maccor")
                    or not set(_REQUIRED).issubset(parts)):
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
    with Path(path).open("rb") as stream:
        fields, columns = _header(stream)
    started = fields.get("Started")
    try:
        start_time = datetime.strptime(started, _LOCAL_TIME).isoformat() if started else None
    except ValueError as exc:
        raise InvalidSourceFormatError("Invalid Maccor Started date, expected day/month/year.") from exc
    declared = build_declared_protocol(
        [], warnings=["This Maccor export records the procedure name and executed steps only."]
    )
    return {
        "raw": {"Maccor": fields, "record_columns": columns, DECLARED_PROTOCOL_METADATA_KEY: declared},
        "source_format": "Maccor text",
        "device_info": fields["Tester"],
        "channel": fields.get("Channel"),
        "remarks": fields.get("Description"),
        "start_time": start_time,
        "protocol_warnings": declared["warnings"],
        "voltage_capabilities": voltage_capabilities(),
    }


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
    table = table.loc[:, [*_REQUIRED, *variables]]
    for key in table.columns:
        try:
            if key == "DPT Time":
                table[key] = pd.to_datetime(table[key].str.decode("ascii"), format=_LOCAL_TIME)
            elif key == "Md":
                table[key] = table[key].str.decode("ascii")
            else:
                table[key] = pd.to_numeric(table[key], errors="raise")
                if not np.isfinite(table[key]).all():
                    raise ValueError("non-finite")
        except (UnicodeError, TypeError, ValueError, OverflowError) as exc:
            raise InvalidSourceFormatError(f"Invalid Maccor {key} value.") from exc
        if table[key].isna().any():
            raise InvalidSourceFormatError(f"Missing Maccor {key} value.")
    for key in ("Rec", "Cycle P", "Cycle C", "Step", "ES"):
        if not pd.api.types.is_integer_dtype(table[key]) or (table[key] < 0).any():
            raise InvalidSourceFormatError(f"Maccor {key} must contain nonnegative integers.")
    return table


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    return canonical_records(_read_records(Path(path)), verify_minute_units=True)
