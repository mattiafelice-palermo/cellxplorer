"""Maccor tab-delimited record exports with Cycle C, unsigned A, Ah and Wh."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import BinaryIO

import numpy as np
import pandas as pd

from .canonical_cycling import voltage_capabilities
from .protocol import DECLARED_PROTOCOL_METADATA_KEY, build_declared_protocol
from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


ADAPTER_REVISION = 1
_HEADER_BYTES = 64 * 1024
_REQUIRED = (
    "Rec", "Cycle P", "Cycle C", "Step", "TestTime", "StepTime", "Cap. [Ah]",
    "Ener. [Wh]", "Current [A]", "Voltage [V]", "Md", "ES", "DPT Time",
)
_LOCAL_TIME = "%d/%m/%Y %H:%M:%S"
# End-of-step codes observed immediately before a new executed step in this dialect.
_STEP_END = (129, 132, 133)


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


def _validate_records(table: pd.DataFrame) -> None:
    if (table["Rec"].iloc[0] < 1 or table["Rec"].diff().iloc[1:].ne(1).any()
            or table["Cycle C"].lt(1).any() or table["Cycle C"].diff().lt(0).any()):
        raise InvalidSourceFormatError("Expected consecutive Maccor records and ordered Cycle C labels.")
    if table["Cycle P"].ne(0).any():
        raise UnsupportedSourceFormatError("Maccor exports with an active Cycle P counter are unsupported.")
    if (table[["TestTime", "StepTime", "Current [A]", "Cap. [Ah]", "Ener. [Wh]"]] < 0).any().any():
        raise InvalidSourceFormatError("Expected nonnegative Maccor times and unsigned current, Ah and Wh.")
    if table["TestTime"].diff().lt(0).any():
        raise InvalidSourceFormatError("Maccor TestTime decreases in acquisition order.")
    if not table["Md"].isin(("C", "D", "R", "SBw")).all():
        raise UnsupportedSourceFormatError("Unsupported Maccor operating mode.")
    if not table["ES"].isin((0, 1, 4, 5, *_STEP_END, 195)).all():
        raise UnsupportedSourceFormatError("Unsupported Maccor end status.")


def _check_clocks(table: pd.DataFrame, step: pd.Series) -> None:
    # These header labels omit units. Compare both numeric clocks to elapsed
    # wall time within steps. Suspension and adjustments can shift local dates.
    clocks = table[["TestTime", "StepTime", "DPT Time"]]
    elapsed = clocks - clocks.groupby(step, sort=False).transform("first")
    wall = elapsed["DPT Time"].dt.total_seconds()
    informative = wall.ge(4) & elapsed["TestTime"].gt(0)
    if not informative.any() and not table[["TestTime", "StepTime"]].any().any():
        return
    for name in ("TestTime", "StepTime"):
        seconds = elapsed.loc[informative, name] * 60
        observed = wall[informative]
        matches = (seconds - observed).abs().le(1.1 + observed * 0.01)
        if matches.empty or matches.mean() < 0.9:
            raise UnsupportedSourceFormatError(f"Maccor {name} in minutes could not be verified against DPT Time.")


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    table = _read_records(Path(path))
    _validate_records(table)
    cycle, program, mode, es = (table[name] for name in ("Cycle C", "Step", "Md", "ES"))
    standby = mode.eq("SBw")
    neutral = standby | mode.eq("R")
    if (neutral & table["Current [A]"].ne(0)).any() or (standby != es.eq(195)).any():
        raise InvalidSourceFormatError("Inconsistent Maccor rest or standby record.")
    if table.loc[mode.eq("R"), ["Cap. [Ah]", "Ener. [Wh]"]].ne(0).any().any():
        raise UnsupportedSourceFormatError("Unsupported Maccor rest counters.")

    # A witnessed SBw interruption retains the execution's elapsed time and
    # counters. Its own current stays zero. A different/resumed operation
    # cannot provide this evidence for an isolated standby record.
    same_program = cycle.eq(cycle.shift()) & program.eq(program.shift())
    if standby.any():
        before, after = mode.shift(), mode.shift(-1)
        witnessed = (same_program & same_program.shift(-1, fill_value=False)
                     & before.isin(("C", "D")) & before.eq(after)
                     & table["StepTime"].diff().ge(0) & table["StepTime"].diff().shift(-1).ge(0))
        if (standby & ~witnessed).any():
            raise UnsupportedSourceFormatError("Maccor standby is outside a verified continuing step.")
    direction = mode.where(~standby, mode.shift())
    boundary = (~same_program | direction.ne(direction.shift())
                | table["StepTime"].diff().lt(0) | es.shift().isin(_STEP_END))
    step = boundary.cumsum()
    _check_clocks(table, step)

    charge, discharge = direction.eq("C"), direction.eq("D")
    signed_current = table["Current [A]"] * np.where(discharge, -1000.0, 1000.0)
    raw = pd.DataFrame({
        "record_index": table["Rec"], "cycle": cycle, "step_index": program, "step": step,
        "status": mode.map({"C": "Chg", "D": "DChg", "R": "Rest", "SBw": "Standby"}),
        "time_s": table["StepTime"] * 60, "total_time_s": table["TestTime"] * 60,
        "timestamp": table["DPT Time"], "current_ma": signed_current, "voltage_v": table["Voltage [V]"],
        "maccor_mode": mode, "maccor_end_status": es, "cv_mode_known": False,
    })
    if standby.any():
        # Zero current at this record does not reset the measured step counter.
        raw["maccor_standby_phase"] = direction.where(standby).map({"C": "charge", "D": "discharge"})
    for native, quantity, original in (
        ("Cap. [Ah]", "capacity_mah", "maccor_capacity_ah"),
        ("Ener. [Wh]", "energy_mwh", "maccor_energy_wh"),
    ):
        counters = table[native].groupby(step, sort=False)
        if counters.diff().lt(0).any():
            raise InvalidSourceFormatError(f"Maccor {native} decreases within an executed step.")
        raw[original] = table[native]
        # Shared scientific consumers sum measured per-execution spans. A
        # continued counter on the next programmed step must not count twice.
        span = (table[native] - counters.transform("first")) * 1000
        raw[f"charge_{quantity}"] = span.where(charge, 0.0)
        raw[f"discharge_{quantity}"] = span.where(discharge, 0.0)

    ends = es.groupby(step, sort=False)
    closed = ends.first().eq(0) & ends.last().isin(_STEP_END)
    incomplete = (~neutral & ~step.map(closed)).groupby(cycle).any()
    measured = table["Current [A]"].gt(0)
    paired = (charge & measured).groupby(cycle).any() & (discharge & measured).groupby(cycle).any()
    complete = paired & ~incomplete
    if table["Rec"].iloc[0] != 1:
        complete.iloc[0] = False
    raw["cycle_complete"] = cycle.map(complete)
    # VAR channels are source-defined. Preserve values under their declared
    # names without assigning units, electrode roles, or protocol semantics.
    for name in table.columns:
        if name.startswith("VAR") and name[3:].isdigit():
            raw[f"maccor_{name}"] = table[name]
    return raw
