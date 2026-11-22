"""Maccor Rec#/Cyc# exports in delimited files and the Data worksheet."""
from __future__ import annotations

import csv
from datetime import datetime
from io import BytesIO
from itertools import islice
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

import numpy as np
import pandas as pd
from openpyxl import load_workbook

from . import neware_excel
from .canonical_cycling import voltage_capabilities
from .maccor_cycling import canonical_records
from .protocol import DECLARED_PROTOCOL_METADATA_KEY, build_declared_protocol
from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


WORKBOOK_REVISION = 1
COLUMNS = ("Rec#", "Cyc#", "Step", "TestTime", "StepTime", "Amp-hr", "Watt-hr",
           "Amps", "Volts", "State", "ES", "DPt Time")
_DATE_FORMAT = "%m/%d/%Y %H:%M:%S"


def delimited_signature(path: Path) -> bool:
    with path.open("rb") as stream:
        prefix = stream.read(32).removeprefix(b"\xef\xbb\xbf")
    return prefix.startswith((b"Today''s Date\t", b"Today''s Date,"))


def _delimited_header(path: Path):
    with path.open("rb") as stream:
        lines = [stream.readline(16385) for _ in range(3)]
    if any(len(line) > 16384 for line in lines):
        raise UnsupportedSourceFormatError("Unsupported Maccor record export header.")
    delimiter = "\t" if b"\t" in lines[0] else ","
    rows = list(csv.reader((line.removeprefix(b"\xef\xbb\xbf").decode("cp1252").rstrip("\r\n")
                            for line in lines), delimiter=delimiter))
    if (rows[0][:1] != ["Today''s Date"] or rows[1][:1] != ["Date of Test:"] or len(rows[1]) < 2
            or tuple(rows[2][:len(COLUMNS)]) != COLUMNS or any(rows[2].count(k) != 1 for k in COLUMNS)):
        raise UnsupportedSourceFormatError("Unsupported Maccor Rec# record export header.")
    try:
        started = datetime.strptime(rows[1][1], _DATE_FORMAT).isoformat()
    except ValueError as exc:
        raise InvalidSourceFormatError("Invalid Maccor date of test.") from exc
    return delimiter, {"Date of Test": started}


def workbook_fields(path: Path) -> dict | None:
    """Recognize two header rows without opening the full Data or chart sheets."""
    try:
        with ZipFile(path) as archive:
            sheets = neware_excel._xlsx_sheet_paths(archive)
            if "data" not in sheets or "statistics" not in sheets or "record" in sheets:
                return None
            with archive.open(sheets["data"]) as stream:
                rows = list(islice(neware_excel._iter_xlsx_xml_rows(BytesIO(stream.read(128 * 1024))), 2))
            if len(rows) != 2:
                return None
            indices = neware_excel._xlsx_shared_string_indices(b"".join(rows))
            if indices and max(indices) > 4096:
                return None
            strings = neware_excel._xlsx_shared_strings(archive, max_index=max(indices, default=-1)) if indices else []
            first, columns = [neware_excel._xlsx_row_values(row, strings) for row in rows]
    except (BadZipFile, FileNotFoundError, KeyError, ValueError, ParseError):
        return None
    if (first[:1] != ("Today''s Date",) or first[2:3] != ("Date of Test:",)
            or first[4:5] != ("Filename:",) or first[6:7] != ("Procedure",)
            or tuple(columns[:len(COLUMNS)]) != COLUMNS):
        return None
    # The serial value alone does not identify the workbook's date epoch.
    return {"Procedure": str(first[7])} if len(first) > 7 else {}


def metadata(fields: dict, *, workbook: bool) -> dict:
    declared = build_declared_protocol([], warnings=["The Maccor export contains recorded steps only."])
    return {"raw": {"Maccor": fields, "maccor_format": "workbook" if workbook else "text",
                    "record_columns": list(COLUMNS), DECLARED_PROTOCOL_METADATA_KEY: declared},
            "source_format": "Maccor Excel" if workbook else "Maccor text",
            "start_time": fields.get("Date of Test"), "protocol_warnings": declared["warnings"],
            "voltage_capabilities": voltage_capabilities()}


def text_metadata(path: Path) -> dict:
    _, fields = _delimited_header(path)
    return metadata(fields, workbook=False)


def _duration_minutes(values: pd.Series) -> pd.Series:
    parts = values.astype(str).str.extract(r"^\s*(\d+)d (\d{2}):([0-5]\d):([0-5]\d(?:\.\d+)?)\s*$")
    if parts.isna().any().any() or parts[1].astype(int).ge(24).any():
        raise InvalidSourceFormatError("Invalid Maccor day and clock duration.")
    days, hours, minutes, seconds = (parts[i].astype(float) for i in range(4))
    return ((days * 24 + hours) * 60 + minutes) + seconds / 60


def _current_scale(table: pd.DataFrame) -> float:
    # The same "Amps" heading is emitted for A and mA. Compare integrated
    # current with the measured Ah span over near-constant active intervals.
    current, capacity = table["Current [A]"], table["Cap. [Ah]"]
    if current.eq(0).all():
        return 1.0
    elapsed = table["StepTime"].diff()
    stable = (table["Md"].isin(("C", "D")) & table["Md"].eq(table["Md"].shift())
              & table["Step"].eq(table["Step"].shift()) & table["Cycle C"].eq(table["Cycle C"].shift())
              & elapsed.gt(0) & current.gt(0) & current.diff().abs().le(current * .03)
              & capacity.diff().ge(0))
    block = (~stable).cumsum()
    nominal = ((current + current.shift()) / 2 * elapsed / 60)[stable].groupby(block[stable]).sum()
    measured = capacity.diff()[stable].groupby(block[stable]).sum()
    informative = measured.gt(0)
    ratios = (measured[informative] / nominal[informative]).to_numpy()
    candidates = [factor for factor in (1., .001) if len(ratios)
                  and np.isclose(np.median(ratios), factor, rtol=.15)
                  and not np.isclose(ratios, .001 if factor == 1. else 1., rtol=.15).any()
                  and np.isclose(measured.sum(), nominal.sum() * factor, rtol=.15, atol=1e-10)]
    if len(candidates) != 1:
        raise UnsupportedSourceFormatError("Maccor Amps scaling could not be verified against elapsed time and Amp-hr.")
    return candidates[0]


def _workbook_records(path: Path) -> pd.DataFrame:
    # The plot sheets duplicate selected data. Read just the first twelve
    # columns of Data, even when the source has many auxiliary variables.
    if neware_excel._fastexcel is not None:
        try:
            reader = neware_excel._fastexcel.read_excel(path)
            name = next(n for n in reader.sheet_names if n.casefold() == "data")
            table = reader.load_sheet(name, header_row=1, use_columns=list(range(len(COLUMNS)))).to_pandas()
            if tuple(table.columns) == COLUMNS:
                return table.dropna(how="all")
        except neware_excel._FAST_EXCEL_ERRORS:
            pass
    book = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = next(s for s in book if s.title.casefold() == "data")
        rows = sheet.iter_rows(min_row=3, max_col=len(COLUMNS), values_only=True)
        return pd.DataFrame(rows, columns=COLUMNS).dropna(how="all")
    finally:
        book.close()


def parse(path: Path, *, workbook: bool) -> pd.DataFrame:
    if workbook:
        table = _workbook_records(path)
    else:
        delimiter, _ = _delimited_header(path)
        try:
            table = pd.read_csv(path, sep=delimiter, skiprows=2, encoding="cp1252", usecols=list(COLUMNS))
        except (UnicodeError, pd.errors.ParserError) as exc:
            raise InvalidSourceFormatError("Invalid delimited Maccor record table.") from exc
    if table.empty:
        raise InvalidSourceFormatError("The Maccor export contains no measurement records.")
    table = table.rename(columns={"Rec#": "Rec", "Cyc#": "Cycle P", "Amp-hr": "Cap. [Ah]",
                                  "Watt-hr": "Ener. [Wh]", "Amps": "Current [A]", "Volts": "Voltage [V]",
                                  "State": "Md", "DPt Time": "DPT Time"})
    try:
        for key in ("Rec", "Cycle P", "Step", "ES", "Cap. [Ah]", "Ener. [Wh]", "Current [A]", "Voltage [V]"):
            series = pd.to_numeric(table[key], errors="raise")
            if not np.isfinite(series).all():
                raise ValueError(key)
            if key in ("Rec", "Cycle P", "Step", "ES"):
                if series.lt(0).any() or series.mod(1).ne(0).any():
                    raise ValueError(key)
                series = series.astype("int64")
            table[key] = series
        for key in ("TestTime", "StepTime"):
            table[key] = _duration_minutes(table[key])
        table["DPT Time"] = pd.to_datetime(table["DPT Time"], format=None if workbook else _DATE_FORMAT, errors="raise")
        if table["DPT Time"].isna().any():
            raise ValueError("missing DPt Time")
    except (ValueError, TypeError, OverflowError) as exc:
        raise InvalidSourceFormatError("Invalid measurement in Maccor record export.") from exc
    table["Md"] = table["Md"].replace({"S": "Stop"})
    if table["Cycle P"].eq(0).all():
        active = table["Md"].where(table["Md"].isin(("C", "D"))).ffill()
        directions = active.dropna()
        first = None if directions.empty else directions.iloc[0]
        returned = active.eq(first) & active.ne(active.shift()) & active.shift().notna()
        table["Cycle C"] = 1 + returned.cumsum()
    elif (table["Cycle P"].eq(0) & table["Md"].isin(("C", "D"))).any():
        # Preserve a measured native cycle zero as its own storage group.
        table["Cycle C"] = table["Cycle P"] + 1
    else:
        table["Cycle C"] = table["Cycle P"].clip(lower=1)
    table["Current [A]"] *= _current_scale(table)
    return canonical_records(table, verify_minute_units=False)
