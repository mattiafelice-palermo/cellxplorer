"""Read structured Neware Excel exports into CellXplorer's raw model.

This module owns the Excel-specific source boundary for Spec 039.  It deliberately
does not dispatch from :mod:`parsing`, write caches, or calculate cycle summaries:
those are later integration seams.  The ``record`` worksheet is the scientific
source of truth; the optional ``step`` worksheet only validates the reconstruction.
"""
from __future__ import annotations

import math
import re
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree

import numpy as np
import pandas as pd
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException


EXCEL_PARSER_REVISION = 1


class NewareExcelError(ValueError):
    """Base class for bounded Neware Excel parser errors."""


class UnsupportedNewareExcelError(NewareExcelError):
    """The workbook is not the supported structured Neware export."""


class InvalidNewareExcelError(NewareExcelError):
    """The workbook resembles the supported export but is unsafe to map."""


REQUIRED_RECORD_HEADERS = (
    "DataPoint",
    "Cycle Index",
    "Step Index",
    "Step Type",
    "Time(min)",
    "Total Time(min)",
    "Current(mA)",
    "Voltage(V)",
    "Chg. Cap.(mAh)",
    "DChg. Cap.(mAh)",
    "Date",
    "Power(W)",
)

OPTIONAL_RECORD_HEADERS = {
    "Capacity(mAh)": "capacity_mah",
    "Spec. Cap.(mAh/g)": "specific_capacity_mah_g",
    "Chg. Spec. Cap.(mAh/g)": "charge_specific_capacity_mah_g",
    "DChg. Spec. Cap.(mAh/g)": "discharge_specific_capacity_mah_g",
}

STEP_HEADERS = (
    "Cycle Index",
    "Step Index",
    "Step Number",
    "Step Type",
    "Step Time(min)",
    "Oneset Date",
    "End Date",
    "Capacity(mAh)",
    "Energy(Wh)",
    "Oneset Volt.(V)",
    "End Voltage(V)",
)

_RECORD_OUTPUT_COLUMNS = {
    "DataPoint": "record_index",
    "Cycle Index": "cycle",
    "Step Index": "step_index",
    "Time(min)": "time_s",
    "Total Time(min)": "total_time_s",
    "Current(mA)": "current_ma",
    "Voltage(V)": "voltage_v",
    "Chg. Cap.(mAh)": "charge_capacity_mah",
    "DChg. Cap.(mAh)": "discharge_capacity_mah",
    "Date": "timestamp",
    "Power(W)": "power_w",
}

_STATUS_ALIASES = {
    "rest": "Rest",
    "cc chg": "CC_Chg",
    "cc dchg": "CC_DChg",
    "cv chg": "CV_Chg",
    "cccv chg": "CCCV_Chg",
    "cccv dchg": "CCCV_DChg",
}

_INT_COLUMNS = ("record_index", "cycle", "step", "step_index")
_FLOAT_COLUMNS = (
    "time_s",
    "total_time_s",
    "voltage_v",
    "current_ma",
    "charge_capacity_mah",
    "discharge_capacity_mah",
    "charge_energy_mwh",
    "discharge_energy_mwh",
    "power_w",
    "capacity_mah",
    "specific_capacity_mah_g",
    "charge_specific_capacity_mah_g",
    "discharge_specific_capacity_mah_g",
)


def _normalize_text(value: object) -> str:
    """Normalize text for deterministic lookup, without fuzzy matching."""

    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).strip()).casefold()


def _path(path: str | Path) -> Path:
    return Path(path)


def _load(path: Path):
    try:
        return load_workbook(
            filename=path,
            read_only=True,
            data_only=True,
            keep_links=False,
        )
    except (InvalidFileException, OSError, ValueError, KeyError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise InvalidNewareExcelError(
            "Could not read the Neware Excel workbook."
        ) from exc
    except Exception as exc:  # openpyxl can surface parser-specific XML exceptions.
        raise InvalidNewareExcelError(
            "Could not read the Neware Excel workbook."
        ) from exc


@contextmanager
def _open(path: Path) -> Iterator[Any]:
    workbook = _load(path)
    try:
        yield workbook
    finally:
        workbook.close()


def _sheet_by_name(workbook: Any, name: str, *, required: bool) -> Any | None:
    wanted = _normalize_text(name)
    matches = [sheet for sheet in workbook.worksheets if _normalize_text(sheet.title) == wanted]
    if len(matches) > 1:
        raise InvalidNewareExcelError(
            f"Neware Excel workbook has ambiguous worksheet name: {name}."
        )
    if matches:
        return matches[0]
    if required:
        raise UnsupportedNewareExcelError(
            f"Not a recognized Neware Excel export: required {name} sheet is missing."
        )
    return None


def _header_map(sheet: Any) -> dict[str, tuple[int, str]]:
    # Some Neware exports declare ``<dimension ref=\"A1\"/>`` even though the
    # worksheet contains a full rectangular table.  Read-only openpyxl trusts
    # that declaration and would otherwise expose only column A.  Resetting
    # dimensions makes it scan the actual worksheet cells while preserving the
    # bounded read-only iteration path.
    reset_dimensions = getattr(sheet, "reset_dimensions", None)
    if callable(reset_dimensions):
        reset_dimensions()
    rows = sheet.iter_rows(min_row=1, max_row=1, values_only=True)
    try:
        header_row = next(rows)
    except StopIteration as exc:
        raise UnsupportedNewareExcelError(
            f"Neware Excel {sheet.title} sheet is empty."
        ) from exc

    result: dict[str, tuple[int, str]] = {}
    for index, value in enumerate(header_row):
        original = "" if value is None else str(value).strip()
        normalized = _normalize_text(value)
        if not normalized:
            continue
        if normalized in result:
            raise InvalidNewareExcelError(
                f"Neware Excel {sheet.title} sheet has an ambiguous normalized header: {original}."
            )
        result[normalized] = (index, original)
    return result


def _require_columns(
    headers: dict[str, tuple[int, str]],
    required: tuple[str, ...],
    *,
    sheet_name: str,
) -> dict[str, tuple[int, str]]:
    missing = [name for name in required if _normalize_text(name) not in headers]
    if missing:
        if sheet_name == "record":
            raise UnsupportedNewareExcelError(
                "Neware Excel export is missing required record column: "
                f"{missing[0]}."
            )
        raise InvalidNewareExcelError(
            f"Neware Excel {sheet_name} sheet is missing required column: {missing[0]}."
        )
    return {_normalize_text(name): headers[_normalize_text(name)] for name in required}


def _record_number(row_number: int) -> int:
    # Worksheet row 2 is source record 1.  This fallback is used when DataPoint
    # itself is the invalid field and therefore cannot identify the record.
    return max(1, row_number - 1)


def _invalid_record(row_number: int, column: str) -> InvalidNewareExcelError:
    return InvalidNewareExcelError(
        f"Neware Excel record {_record_number(row_number)} has an invalid {column} value."
    )


def _number(value: object, *, row_number: int, column: str) -> float:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise _invalid_record(row_number, column)
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise _invalid_record(row_number, column) from exc
    if not math.isfinite(number):
        raise _invalid_record(row_number, column)
    return number


def _optional_number(value: object, *, row_number: int, column: str) -> float:
    if value is None or (isinstance(value, str) and not value.strip()):
        return math.nan
    return _number(value, row_number=row_number, column=column)


def _integer(value: object, *, row_number: int, column: str) -> int:
    number = _number(value, row_number=row_number, column=column)
    if not number.is_integer():
        raise _invalid_record(row_number, column)
    return int(number)


def _timestamp(value: object, *, row_number: int, column: str) -> pd.Timestamp:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise _invalid_record(row_number, column)
    try:
        timestamp = pd.Timestamp(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _invalid_record(row_number, column) from exc
    if pd.isna(timestamp) or timestamp.tz is not None:
        raise _invalid_record(row_number, column)
    return timestamp


def _normalize_status(value: object, *, row_number: int, column: str = "Step Type") -> str:
    normalized = _normalize_text(value)
    if not normalized or normalized not in _STATUS_ALIASES:
        raise _invalid_record(row_number, column)
    return _STATUS_ALIASES[normalized]


def _parse_records(sheet: Any, headers: dict[str, tuple[int, str]]) -> list[dict[str, object]]:
    required = _require_columns(headers, REQUIRED_RECORD_HEADERS, sheet_name="record")
    optional = {
        normalized: (headers[normalized][0], source, target)
        for source, target in OPTIONAL_RECORD_HEADERS.items()
        for normalized in [_normalize_text(source)]
        if normalized in headers
    }

    records: list[dict[str, object]] = []
    for row_number, values in enumerate(
        sheet.iter_rows(min_row=2, values_only=True), start=2
    ):
        if not any(value is not None and str(value).strip() for value in values):
            continue

        def value_for(source: str) -> object:
            return values[required[_normalize_text(source)][0]]

        record: dict[str, object] = {
            "record_index": _integer(
                value_for("DataPoint"), row_number=row_number, column="DataPoint"
            ),
            "cycle": _integer(
                value_for("Cycle Index"), row_number=row_number, column="Cycle Index"
            ),
            "step_index": _integer(
                value_for("Step Index"), row_number=row_number, column="Step Index"
            ),
            "status": _normalize_status(value_for("Step Type"), row_number=row_number),
            "time_s": _number(
                value_for("Time(min)"), row_number=row_number, column="Time(min)"
            )
            * 60.0,
            "total_time_s": _number(
                value_for("Total Time(min)"),
                row_number=row_number,
                column="Total Time(min)",
            )
            * 60.0,
            "current_ma": _number(
                value_for("Current(mA)"), row_number=row_number, column="Current(mA)"
            ),
            "voltage_v": _number(
                value_for("Voltage(V)"), row_number=row_number, column="Voltage(V)"
            ),
            "charge_capacity_mah": _number(
                value_for("Chg. Cap.(mAh)"),
                row_number=row_number,
                column="Chg. Cap.(mAh)",
            ),
            "discharge_capacity_mah": _number(
                value_for("DChg. Cap.(mAh)"),
                row_number=row_number,
                column="DChg. Cap.(mAh)",
            ),
            "timestamp": _timestamp(
                value_for("Date"), row_number=row_number, column="Date"
            ),
            "power_w": _number(
                value_for("Power(W)"), row_number=row_number, column="Power(W)"
            ),
        }
        for normalized, (_index, source, target) in optional.items():
            record[target] = _optional_number(
                values[_index], row_number=row_number, column=source
            )
        records.append(record)

    if not records:
        raise InvalidNewareExcelError("Neware Excel record sheet contains no data rows.")
    return records


def _ordered_records(records: list[dict[str, object]]) -> list[dict[str, object]]:
    order = sorted(range(len(records)), key=lambda index: int(records[index]["record_index"]))
    ordered = [records[index] for index in order]
    previous: int | None = None
    for record in ordered:
        current = int(record["record_index"])
        if previous is not None and current <= previous:
            if current == previous:
                raise InvalidNewareExcelError(
                    f"Neware Excel record DataPoint {current} is duplicated."
                )
            raise InvalidNewareExcelError(
                "Neware Excel DataPoint values must be strictly increasing."
            )
        previous = current
    return ordered


def _frame_from_records(records: list[dict[str, object]]) -> pd.DataFrame:
    ordered = _ordered_records(records)
    data: dict[str, list[object]] = {}
    for key in ordered[0]:
        data[key] = [record[key] for record in ordered]

    frame = pd.DataFrame(data)
    frame["record_index"] = pd.Series(data["record_index"], dtype="int64")
    frame["cycle"] = pd.Series(data["cycle"], dtype="int64")
    frame["step_index"] = pd.Series(data["step_index"], dtype="int64")
    for column in _FLOAT_COLUMNS:
        if column in frame:
            frame[column] = pd.Series(data[column], dtype="float64")
    frame["status"] = pd.Series(data["status"], dtype="string")
    frame["timestamp"] = pd.Series(data["timestamp"], dtype="datetime64[ns]")

    total_time = frame["total_time_s"].to_numpy(dtype="float64")
    if len(total_time) > 1 and np.any(np.diff(total_time) < -1e-9):
        raise InvalidNewareExcelError(
            "Neware Excel record Total Time(min) decreases in source order."
        )

    cycle = frame["cycle"].to_numpy(dtype="int64")
    step_index = frame["step_index"].to_numpy(dtype="int64")
    time_s = frame["time_s"].to_numpy(dtype="float64")
    status = frame["status"].astype(str).to_numpy()
    executed_steps = np.empty(len(frame), dtype="int64")
    step_number = 0
    for index in range(len(frame)):
        boundary = (
            index == 0
            or cycle[index] != cycle[index - 1]
            or step_index[index] != step_index[index - 1]
            or status[index] != status[index - 1]
            or time_s[index] < time_s[index - 1] - 1e-9
        )
        if boundary:
            step_number += 1
        executed_steps[index] = step_number
    frame["step"] = executed_steps

    charge_energy = np.zeros(len(frame), dtype="float64")
    discharge_energy = np.zeros(len(frame), dtype="float64")
    power = frame["power_w"].to_numpy(dtype="float64")
    for index in range(1, len(frame)):
        if executed_steps[index] != executed_steps[index - 1]:
            continue
        dt_h = max(0.0, total_time[index] - total_time[index - 1]) / 3600.0
        increment = abs((power[index - 1] + power[index]) / 2.0) * dt_h * 1000.0
        if "DChg" in status[index]:
            discharge_energy[index] = discharge_energy[index - 1] + increment
        elif "Chg" in status[index] and "DChg" not in status[index]:
            charge_energy[index] = charge_energy[index - 1] + increment

    frame["charge_energy_mwh"] = charge_energy
    frame["discharge_energy_mwh"] = discharge_energy
    columns = [
        "record_index",
        "cycle",
        "step",
        "step_index",
        "status",
        "time_s",
        "total_time_s",
        "voltage_v",
        "current_ma",
        "charge_capacity_mah",
        "discharge_capacity_mah",
        "charge_energy_mwh",
        "discharge_energy_mwh",
        "timestamp",
        "power_w",
    ]
    columns.extend(
        target for target in OPTIONAL_RECORD_HEADERS.values() if target in frame.columns
    )
    return frame[columns]


def _parse_step_summary(sheet: Any) -> list[dict[str, object]]:
    headers = _header_map(sheet)
    required = _require_columns(headers, STEP_HEADERS, sheet_name="step")
    rows: list[dict[str, object]] = []
    for row_number, values in enumerate(
        sheet.iter_rows(min_row=2, values_only=True), start=2
    ):
        if not any(value is not None and str(value).strip() for value in values):
            continue

        def value_for(source: str) -> object:
            return values[required[_normalize_text(source)][0]]

        def summary_number(source: str) -> float:
            value = value_for(source)
            if value is None or (isinstance(value, str) and not value.strip()):
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                )
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                ) from exc
            if not math.isfinite(number):
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                )
            return number

        def summary_integer(source: str) -> int:
            number = summary_number(source)
            if not number.is_integer():
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                )
            return int(number)

        def summary_timestamp(source: str) -> pd.Timestamp:
            try:
                timestamp = pd.Timestamp(value_for(source))
            except (TypeError, ValueError, OverflowError) as exc:
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                ) from exc
            if pd.isna(timestamp) or timestamp.tz is not None:
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                )
            return timestamp

        rows.append(
            {
                "cycle": summary_integer("Cycle Index"),
                "step_index": summary_integer("Step Index"),
                "step_number": summary_integer("Step Number"),
                "status": _normalize_status(
                    value_for("Step Type"), row_number=row_number, column="Step Type"
                ),
                "step_time_s": summary_number("Step Time(min)") * 60.0,
                "onset": summary_timestamp("Oneset Date"),
                "end": summary_timestamp("End Date"),
                "capacity_mah": summary_number("Capacity(mAh)"),
                "energy_mwh": summary_number("Energy(Wh)") * 1000.0,
                "onset_voltage_v": summary_number("Oneset Volt.(V)"),
                "end_voltage_v": summary_number("End Voltage(V)"),
            }
        )

    if not rows:
        raise InvalidNewareExcelError("Neware Excel step sheet contains no data rows.")
    rows.sort(key=lambda row: int(row["step_number"]))
    previous: int | None = None
    for row in rows:
        current = int(row["step_number"])
        if previous is not None and current <= previous:
            raise InvalidNewareExcelError(
                "Neware Excel step summary Step Number values must be unique and increasing."
            )
        previous = current
    return rows


def _segment_groups(frame: pd.DataFrame) -> list[pd.DataFrame]:
    step_values = frame["step"].to_numpy(dtype="int64")
    starts = np.flatnonzero(
        np.r_[True, step_values[1:] != step_values[:-1]]
    )
    ends = np.r_[starts[1:], len(frame)]
    return [frame.iloc[start:end] for start, end in zip(starts, ends)]


def _segment_capacity(group: pd.DataFrame) -> float:
    status = str(group["status"].iloc[0])
    column = "discharge_capacity_mah" if "DChg" in status else "charge_capacity_mah" if "Chg" in status else None
    if column is None:
        return 0.0
    values = group[column].to_numpy(dtype="float64")
    return float(np.max(values) - np.min(values))


def _integrate_step_energy(group: pd.DataFrame) -> float:
    total_time = group["total_time_s"].to_numpy(dtype="float64")
    power = group["power_w"].to_numpy(dtype="float64")
    if len(group) < 2:
        return 0.0
    energy = 0.0
    for index in range(1, len(group)):
        dt_h = max(0.0, total_time[index] - total_time[index - 1]) / 3600.0
        energy += abs((power[index - 1] + power[index]) / 2.0) * dt_h * 1000.0
    return energy


def _step_time_tolerance_seconds(frame: pd.DataFrame) -> float:
    """Return the bounded timing tolerance available from the raw record cadence.

    Neware's step summary rounds ``Step Time(min)`` independently from the raw
    timestamps.  The export does not expose the declared record interval on the
    ``record`` sheet, so use the median positive timestamp interval as the
    record-cadence fallback.  This implements the spec's ``max(2 seconds,
    known record interval)`` rule without hard-coding the common 60-second
    setting, while still keeping a two-second floor for sparse/single-row
    synthetic data.
    """
    intervals = frame["timestamp"].diff().dt.total_seconds().to_numpy(dtype="float64")
    positive = intervals[np.isfinite(intervals) & (intervals > 0.0)]
    if len(positive) == 0:
        return 2.0
    return max(2.0, float(np.median(positive)))


def _validate_step_summary(frame: pd.DataFrame, sheet: Any) -> None:
    summary = _parse_step_summary(sheet)
    segments = _segment_groups(frame)
    if len(summary) != len(segments):
        raise InvalidNewareExcelError(
            "Neware Excel execution-step mapping failed: "
            f"{len(segments)} raw segments but {len(summary)} step-summary rows."
        )

    for expected_step, (summary_row, segment) in enumerate(
        zip(summary, segments), start=1
    ):
        actual_step = int(segment["step"].iloc[0])
        if int(summary_row["step_number"]) != actual_step:
            raise InvalidNewareExcelError(
                "Neware Excel execution-step mapping failed: Step Number does not match raw order."
            )
        identity = (
            int(segment["cycle"].iloc[0]) == int(summary_row["cycle"])
            and int(segment["step_index"].iloc[0]) == int(summary_row["step_index"])
            and str(segment["status"].iloc[0]) == str(summary_row["status"])
        )
        if not identity:
            raise InvalidNewareExcelError(
                f"Neware Excel execution-step mapping failed at step {expected_step}."
            )

        onset = pd.Timestamp(segment["timestamp"].iloc[0])
        end = pd.Timestamp(segment["timestamp"].iloc[-1])
        tolerance_s = _step_time_tolerance_seconds(frame)
        if abs((onset - summary_row["onset"]).total_seconds()) > tolerance_s:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary onset does not match raw step {expected_step}."
            )
        if abs((end - summary_row["end"]).total_seconds()) > tolerance_s:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary end does not match raw step {expected_step}."
            )
        duration_s = (end - onset).total_seconds()
        if abs(duration_s - float(summary_row["step_time_s"])) > tolerance_s:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary duration does not match raw step {expected_step}."
            )

        start_voltage = float(segment["voltage_v"].iloc[0])
        end_voltage = float(segment["voltage_v"].iloc[-1])
        if abs(start_voltage - float(summary_row["onset_voltage_v"])) > 0.002:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary onset voltage does not match raw step {expected_step}."
            )
        if abs(end_voltage - float(summary_row["end_voltage_v"])) > 0.002:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary end voltage does not match raw step {expected_step}."
            )

        expected_capacity = float(summary_row["capacity_mah"])
        capacity_tolerance = max(0.002, abs(expected_capacity) * 0.001)
        if abs(_segment_capacity(segment) - expected_capacity) > capacity_tolerance:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary capacity does not match raw step {expected_step}."
            )

        expected_energy = float(summary_row["energy_mwh"])
        energy_tolerance = max(0.01, abs(expected_energy) * 0.001)
        if abs(_integrate_step_energy(segment) - expected_energy) > energy_tolerance:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary energy does not match raw step {expected_step}."
            )


def is_supported_workbook(path: str | Path) -> bool:
    """Return whether ``path`` matches the supported Neware record contract."""

    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        return False
    try:
        with _open(candidate) as workbook:
            sheet = _sheet_by_name(workbook, "record", required=True)
            headers = _header_map(sheet)
            _require_columns(headers, REQUIRED_RECORD_HEADERS, sheet_name="record")
        return True
    except NewareExcelError:
        return False


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    """Parse a supported Neware Excel export into canonical raw data."""

    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        raise UnsupportedNewareExcelError(
            "Not a recognized Neware Excel export: only .xlsx is supported."
        )

    try:
        with _open(candidate) as workbook:
            record_sheet = _sheet_by_name(workbook, "record", required=True)
            records = _parse_records(record_sheet, _header_map(record_sheet))
            frame = _frame_from_records(records)
            step_sheet = _sheet_by_name(workbook, "step", required=False)
            if step_sheet is not None:
                _validate_step_summary(frame, step_sheet)
    except NewareExcelError:
        raise
    except Exception as exc:
        raise InvalidNewareExcelError(
            "Could not parse the Neware Excel workbook."
        ) from exc

    frame.attrs["neware_excel"] = {
        "record_sheet": "record",
        "step_summary_available": step_sheet is not None,
        "step_summary_validated": step_sheet is not None,
        "record_count": int(len(frame)),
        "executed_step_count": int(frame["step"].nunique()),
    }
    return frame
