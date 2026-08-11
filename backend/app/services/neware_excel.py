"""Read structured Neware Excel exports into CellXplorer's raw model.

This module owns the Excel-specific source boundary for Spec 039: workbook metadata,
the programmed plan, the large ``record`` time series, and the small independent
cycle-summary validation.  Dispatch and normalized compatibility fields remain in
:mod:`parsing`; cache publication remains in :mod:`cache`.
"""
from __future__ import annotations

import math
import re
import zipfile
from contextlib import contextmanager
from numbers import Number
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree

import numpy as np
import pandas as pd
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException


EXCEL_PARSER_REVISION = 1

_TEST_METADATA_LABELS = {
    "start step id": "start_step_id",
    "volt. upper": "protection_voltage_upper_v",
    "volt. lower": "protection_voltage_lower_v",
    "builder": "builder",
    "remarks": "remarks",
    "start time": "start_time",
    "barcode": "barcode",
    "active material": "active_mass_mg",
    "nominal capacity": "nominal_capacity_mah",
    "record settings": "record_settings",
    "p/n": "part_number",
    "cycle count": "cycle_count",
    "voltage range": "voltage_range",
    "current range": "current_range",
}

_PLAN_REQUIRED_HEADERS = ("Step Index", "Step Name")
_PLAN_HEADERS = (
    "Step Index",
    "Step Name",
    "Step Time(min)",
    "Voltage(V)",
    "C-rate(C)",
    "Current(mA)",
    "Cut-off voltage (V)",
    "Cut-off C-rate(C)",
    "Cut-off curr.(mA)",
    "Energy(Wh)",
    "-ΔV(V)",
    "Power(W)",
    "Resistance(mΩ)",
    "Capacity(mAh)",
    "Record settings",
    "Aux.CH recording condition",
    "Max Vi(V)",
    "Min Vi(V)",
    "Max Ti(℃)",
    "Min Ti(℃)",
    "Segment record1",
    "Segment record2",
    "Current range (mA)",
)

_CYCLE_HEADERS = (
    "Cycle Index",
    "Chg. Cap.(mAh)",
    "DChg. Cap.(mAh)",
    "Chg.-DChg. Eff(%)",
    "Chg. Energy(Wh)",
    "DChg. Energy(Wh)",
    "Chg. Time(min)",
    "DChg. Time(min)",
)

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


def _normalize_label(value: object) -> str:
    return re.sub(r"[:：]\s*$", "", _normalize_text(value))


def _is_blank(value: object) -> bool:
    if value is None:
        return True
    return _normalize_text(value) in {"", "-", "–", "—", "n/a", "na"}


def _value_text(value: object) -> str | None:
    if _is_blank(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value).strip()


def _format_number(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return format(float(value), ".15g")


_QUANTITY_RE = re.compile(
    r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµμΩω℃]+)\s*$"
)
_PLAIN_NUMBER_RE = re.compile(
    r"^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$"
)


def _unit_name(value: str) -> str:
    normalized = value.strip().casefold().replace("μ", "µ")
    return {
        "milligram": "mg",
        "milligrams": "mg",
        "milliamphour": "mah",
        "milliamphours": "mah",
        "millivolt": "mv",
        "millivolts": "mv",
        "second": "s",
        "seconds": "s",
        "minute": "min",
        "minutes": "min",
    }.get(normalized, normalized)


def _quantity(
    value: object,
    *,
    label: str,
    expected_unit: str,
    required_unit: bool = False,
) -> float | None:
    """Parse a quantity using its declared unit, never a first-number guess."""

    if _is_blank(value):
        return None
    if isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number):
            return number
        raise InvalidNewareExcelError(f"Neware Excel {label} has a non-finite value.")

    text = str(value).strip()
    match = _QUANTITY_RE.fullmatch(text)
    if match is None:
        if not required_unit and _PLAIN_NUMBER_RE.fullmatch(text):
            number = float(text)
            if math.isfinite(number):
                return number
        raise InvalidNewareExcelError(
            f"Neware Excel {label} must include a valid {expected_unit} quantity."
        )
    actual_unit = _unit_name(match.group(2))
    wanted_unit = _unit_name(expected_unit)
    if actual_unit != wanted_unit:
        raise InvalidNewareExcelError(
            f"Neware Excel {label} has contradictory unit {match.group(2)}; expected {expected_unit}."
        )
    number = float(match.group(1))
    if not math.isfinite(number):
        raise InvalidNewareExcelError(f"Neware Excel {label} has a non-finite value.")
    return number


def _plan_quantity(value: object, *, label: str, unit: str) -> float | None:
    return _quantity(value, label=label, expected_unit=unit, required_unit=False)


def _integer_value(value: object, *, label: str, required: bool = False) -> int | None:
    if _is_blank(value):
        if required:
            raise InvalidNewareExcelError(f"Neware Excel {label} is required.")
        return None
    number = _plan_quantity(value, label=label, unit="number")
    if number is None or not float(number).is_integer():
        raise InvalidNewareExcelError(f"Neware Excel {label} must be an integer.")
    return int(number)


def _metadata_quantity(value: object, *, label: str, unit: str) -> float | None:
    return _quantity(value, label=label, expected_unit=unit, required_unit=True)


def _metadata_timestamp(value: object, *, label: str) -> str | None:
    if _is_blank(value):
        return None
    try:
        timestamp = _coerce_timestamp(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise InvalidNewareExcelError(f"Neware Excel {label} has an invalid timestamp.") from exc
    return timestamp.strftime("%Y-%m-%d %H:%M:%S")


def _coerce_timestamp(value: object) -> pd.Timestamp:
    """Accept verified date-like values, but never bare Excel serial numbers."""

    if isinstance(value, Number) or (
        isinstance(value, str) and _PLAIN_NUMBER_RE.fullmatch(value.strip())
    ):
        raise ValueError("bare numeric timestamp")
    timestamp = pd.Timestamp(value)
    if pd.isna(timestamp) or timestamp.tz is not None:
        raise ValueError("invalid timestamp")
    return timestamp


def _record_settings(value: object, *, label: str = "Record settings") -> dict[str, float | str] | None:
    if _is_blank(value):
        return None
    text = str(value).strip()
    parts = text.split("/")
    if len(parts) != 3:
        raise InvalidNewareExcelError(
            f"Neware Excel {label} must use interval/voltage-delta/current-delta settings."
        )
    parsed: list[float] = []
    expected_units = ("s", "V", "mA")
    for part, expected in zip(parts, expected_units):
        parsed_value = _quantity(
            part,
            label=label,
            expected_unit=expected,
            required_unit=True,
        )
        if parsed_value is None:
            raise InvalidNewareExcelError(f"Neware Excel {label} contains an empty setting.")
        parsed.append(parsed_value)
    return {
        "raw": text,
        "interval_s": parsed[0],
        "voltage_delta_v": parsed[1],
        "current_delta_ma": parsed[2],
    }


def _rows(sheet: Any) -> list[tuple[object, ...]]:
    reset_dimensions = getattr(sheet, "reset_dimensions", None)
    if callable(reset_dimensions):
        reset_dimensions()
    return [tuple(row) for row in sheet.iter_rows(values_only=True)]


def _find_labeled_value(rows: list[tuple[object, ...]], label: str) -> object | None:
    wanted = _normalize_label(label)
    for row in rows:
        for index, value in enumerate(row):
            if _normalize_label(value) != wanted:
                continue
            for candidate in row[index + 1 :]:
                if not _is_blank(candidate):
                    return candidate
            return None
    return None


def _find_step_plan(rows: list[tuple[object, ...]]) -> tuple[int, dict[str, int]]:
    marker_row: int | None = None
    for row_number, row in enumerate(rows):
        if any(_normalize_label(value) == "step plan" for value in row):
            marker_row = row_number
            break
    if marker_row is None:
        raise InvalidNewareExcelError("Neware Excel test sheet has no Step plan marker.")

    for row_number in range(marker_row + 1, len(rows)):
        row = rows[row_number]
        headers: dict[str, int] = {}
        for index, value in enumerate(row):
            normalized = _normalize_text(value)
            if normalized:
                headers[normalized] = index
        if all(_normalize_text(header) in headers for header in _PLAN_REQUIRED_HEADERS):
            return row_number, headers
    raise InvalidNewareExcelError("Neware Excel test sheet has no Step plan header row.")


def _original_key(header: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", header)
    return "".join(word[:1].upper() + word[1:] for word in words) or "Value"


def _plan_value(row: tuple[object, ...], headers: dict[str, int], header: str) -> object:
    index = headers.get(_normalize_text(header))
    if index is None or index >= len(row):
        return None
    return row[index]


def _step_type_id(step_name: object) -> int:
    from .protocol import STEP_TYPES

    aliases = {
        "cc chg": "cc charge",
        "cc dchg": "cc discharge",
        "cv chg": "cv charge",
        "cccv chg": "cccv charge",
        "cccv dchg": "cccv discharge",
    }
    normalized = _normalize_text(step_name)
    canonical = aliases.get(normalized, normalized)
    matches = [
        type_id
        for type_id, (label, _direction) in STEP_TYPES.items()
        if _normalize_text(label) == canonical
    ]
    if len(matches) != 1:
        raise InvalidNewareExcelError(
            f"Neware Excel has an unsupported programmed Step Name: {step_name}."
        )
    return matches[0]


def _parse_loop_label(value: object, *, prefix: str, label: str) -> int:
    text = _value_text(value) or ""
    match = re.fullmatch(rf"{re.escape(prefix)}\s*:\s*(\d+)", text, flags=re.IGNORECASE)
    if match is None:
        raise InvalidNewareExcelError(
            f"Neware Excel {label} must use the labelled {prefix} form."
        )
    return int(match.group(1))


def _parse_test_information(
    rows: list[tuple[object, ...]],
) -> tuple[dict[str, object], int, dict[str, int]]:
    marker_row, headers = _find_step_plan(rows)

    raw: dict[str, object] = {}
    for label, key in _TEST_METADATA_LABELS.items():
        value = _find_labeled_value(rows[:marker_row], label)
        raw[key] = value

    info: dict[str, object] = {
        "raw": raw,
        "start_step_id": _integer_value(raw["start_step_id"], label="Start step ID"),
        "protection_voltage_upper_v": _metadata_quantity(
            raw["protection_voltage_upper_v"], label="Volt. upper", unit="V"
        ),
        "protection_voltage_lower_v": _metadata_quantity(
            raw["protection_voltage_lower_v"], label="Volt. lower", unit="V"
        ),
        "builder": _value_text(raw["builder"]),
        "remarks": _value_text(raw["remarks"]),
        "start_time": _metadata_timestamp(raw["start_time"], label="Start time"),
        "barcode": _value_text(raw["barcode"]),
        "active_mass_mg": _metadata_quantity(
            raw["active_mass_mg"], label="Active material", unit="mg"
        ),
        "nominal_capacity_mah": _metadata_quantity(
            raw["nominal_capacity_mah"], label="Nominal capacity", unit="mAh"
        ),
        "record_settings": _record_settings(raw["record_settings"]),
        "part_number": _value_text(raw["part_number"]),
        "cycle_count": _value_text(raw["cycle_count"]),
        "voltage_range": _value_text(raw["voltage_range"]),
        "current_range": _value_text(raw["current_range"]),
        "marker_row": marker_row,
        "plan_headers": headers,
    }
    return info, marker_row, headers


def _declared_record_interval_seconds(workbook: Any) -> float | None:
    """Read the optional declared record cadence without making it required."""

    test_sheet = _sheet_by_name(workbook, "test", required=False)
    if test_sheet is None:
        return None
    try:
        info, _header_row, _headers = _parse_test_information(_rows(test_sheet))
    except NewareExcelError:
        return None
    settings = info.get("record_settings")
    if not isinstance(settings, dict):
        return None
    interval_s = settings.get("interval_s")
    return float(interval_s) if interval_s is not None else None


def _parse_unit_original(sheet: Any | None) -> tuple[dict[str, object], str | None]:
    if sheet is None:
        return {}, None
    rows = _rows(sheet)
    original: dict[str, object] = {}
    workbook_name = _value_text(rows[0][0]) if rows and rows[0] else None
    if workbook_name:
        original["WorkbookName"] = {"Value": workbook_name}

    for label, key in (("Start time", "StartTime"), ("End time", "EndTime")):
        value = _find_labeled_value(rows, label)
        if not _is_blank(value):
            original[key] = {"Value": _metadata_timestamp(value, label=label)}

    for row_index, row in enumerate(rows):
        if _normalize_label(row[0] if row else None) != "time":
            continue
        if row_index + 1 >= len(rows):
            break
        units = rows[row_index + 1]
        column_units: dict[str, str] = {}
        for index, header in enumerate(row):
            if _is_blank(header) or index >= len(units) or _is_blank(units[index]):
                continue
            column_units[str(header).strip()] = str(units[index]).strip()
        if column_units:
            original["ColumnUnits"] = {key: {"Value": value} for key, value in column_units.items()}
        break
    return original, (workbook_name if workbook_name else None)


def _parse_programmed_plan(
    rows: list[tuple[object, ...]],
    header_row: int,
    headers: dict[str, int],
    info: dict[str, object],
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, object]]]:
    rows_by_index: dict[int, tuple[object, ...]] = {}
    for row in rows[header_row + 1 :]:
        if not any(not _is_blank(value) for value in row):
            continue
        step_index = _integer_value(
            _plan_value(row, headers, "Step Index"),
            label="Step Index",
            required=True,
        )
        if step_index is None or step_index <= 0:
            raise InvalidNewareExcelError("Neware Excel Step Index must be positive.")
        if step_index in rows_by_index:
            raise InvalidNewareExcelError(
                f"Neware Excel Step Index {step_index} is duplicated."
            )
        rows_by_index[step_index] = row

    expected = list(range(1, len(rows_by_index) + 1))
    if sorted(rows_by_index) != expected:
        raise InvalidNewareExcelError(
            "Neware Excel Step Index values must form a contiguous plan starting at 1."
        )

    protection_upper = info.get("protection_voltage_upper_v")
    protection_lower = info.get("protection_voltage_lower_v")
    global_settings = info.get("record_settings")
    steps: dict[str, dict[str, str]] = {}
    original: dict[str, dict[str, object]] = {}

    for step_index in expected:
        row = rows_by_index[step_index]
        step_name = _plan_value(row, headers, "Step Name")
        type_id = _step_type_id(step_name)
        step: dict[str, str] = {"Step_Type": str(type_id)}

        source_values: dict[str, object] = {}
        for header in _PLAN_HEADERS:
            value = _plan_value(row, headers, header)
            if not _is_blank(value):
                source_values[_original_key(header)] = {"Value": _value_text(value)}

        if type_id == 5:
            step["Limit.Other.Start_Step.Value"] = str(
                _parse_loop_label(
                    _plan_value(row, headers, "Step Time(min)"),
                    prefix="Start step ID",
                    label=f"Step {step_index} Step Time(min)",
                )
            )
            step["Limit.Other.Cycle_Count.Value"] = str(
                _parse_loop_label(
                    _plan_value(row, headers, "Voltage(V)"),
                    prefix="Cycle count",
                    label=f"Step {step_index} Voltage(V)",
                )
            )
        elif type_id != 6:
            current = _plan_quantity(
                _plan_value(row, headers, "Current(mA)"),
                label=f"Step {step_index} Current(mA)",
                unit="mA",
            )
            rate = _plan_quantity(
                _plan_value(row, headers, "C-rate(C)"),
                label=f"Step {step_index} C-rate(C)",
                unit="C",
            )
            target_voltage = _plan_quantity(
                _plan_value(row, headers, "Voltage(V)"),
                label=f"Step {step_index} Voltage(V)",
                unit="V",
            )
            stop_voltage = _plan_quantity(
                _plan_value(row, headers, "Cut-off voltage (V)"),
                label=f"Step {step_index} Cut-off voltage (V)",
                unit="V",
            )
            stop_current = _plan_quantity(
                _plan_value(row, headers, "Cut-off curr.(mA)"),
                label=f"Step {step_index} Cut-off curr.(mA)",
                unit="mA",
            )
            stop_rate = _plan_quantity(
                _plan_value(row, headers, "Cut-off C-rate(C)"),
                label=f"Step {step_index} Cut-off C-rate(C)",
                unit="C",
            )
            nominal_capacity = info.get("nominal_capacity_mah")
            if stop_current is None and stop_rate is not None and nominal_capacity is not None:
                stop_current = abs(stop_rate * float(nominal_capacity))
            step_time_min = _plan_quantity(
                _plan_value(row, headers, "Step Time(min)"),
                label=f"Step {step_index} Step Time(min)",
                unit="min",
            )
            if current is not None:
                step["Limit.Main.Curr.Value"] = _format_number(current)
            if rate is not None:
                step["Limit.Main.Rate.Value"] = _format_number(rate)
            if target_voltage is not None:
                step["Limit.Main.Volt.Value"] = _format_number(target_voltage * 10000.0)
            if stop_voltage is not None:
                step["Limit.Main.Stop_Volt.Value"] = _format_number(stop_voltage * 10000.0)
            if stop_current is not None:
                step["Limit.Main.Stop_Curr.Value"] = _format_number(stop_current)
            if step_time_min is not None:
                step["Limit.Main.Time.Value"] = _format_number(step_time_min * 60.0 * 1000.0)

            settings_value = _plan_value(row, headers, "Record settings")
            settings = _record_settings(settings_value) if not _is_blank(settings_value) else global_settings
            if settings is not None:
                step["Record.Main.Time.Value"] = _format_number(float(settings["interval_s"]) * 1000.0)
                step["Record.Main.Volt.Value"] = _format_number(float(settings["voltage_delta_v"]) * 10000.0)
                source_values["RecordCurrentDelta"] = {
                    "Value": _format_number(float(settings["current_delta_ma"]))
                }
            if protection_upper is not None:
                step["Protect.Main.Volt.Upper.Value"] = _format_number(float(protection_upper) * 10000.0)
            if protection_lower is not None:
                step["Protect.Main.Volt.Lower.Value"] = _format_number(float(protection_lower) * 10000.0)

        steps[f"Step{step_index}"] = step
        original[f"Step{step_index}"] = source_values

    return steps, original


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
        timestamp = _coerce_timestamp(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _invalid_record(row_number, column) from exc
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
                timestamp = _coerce_timestamp(value_for(source))
            except (TypeError, ValueError, OverflowError) as exc:
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source} value."
                ) from exc
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


def _step_time_tolerance_seconds(record_interval_s: float | None) -> float:
    """Return the locked declared-cadence timing tolerance."""

    return max(2.0, float(record_interval_s)) if record_interval_s is not None else 2.0


def _validate_step_summary(
    frame: pd.DataFrame,
    sheet: Any,
    *,
    record_interval_s: float | None,
) -> None:
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
        tolerance_s = _step_time_tolerance_seconds(record_interval_s)
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
                _validate_step_summary(
                    frame,
                    step_sheet,
                    record_interval_s=_declared_record_interval_seconds(workbook),
                )
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


def read_metadata(path: str | Path) -> dict[str, object]:
    """Read bounded workbook metadata and the programmed plan.

    The metadata path intentionally opens only the small ``test``, ``unit`` and
    sheet-name surfaces.  It never iterates the large ``record`` worksheet and
    does not derive metadata from :func:`parse_timeseries`.
    """

    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        raise UnsupportedNewareExcelError(
            "Not a recognized Neware Excel export: only .xlsx is supported."
        )

    try:
        with _open(candidate) as workbook:
            test_sheet = _sheet_by_name(workbook, "test", required=False)
            info: dict[str, object] = {"raw": {}}
            step_info: dict[str, dict[str, str]] = {}
            original_steps: dict[str, dict[str, object]] = {}
            if test_sheet is not None:
                test_rows = _rows(test_sheet)
                info, header_row, headers = _parse_test_information(test_rows)
                step_info, original_steps = _parse_programmed_plan(
                    test_rows, header_row, headers, info
                )
            unit_original, unit_workbook_name = _parse_unit_original(
                _sheet_by_name(workbook, "unit", required=False)
            )
            has_cycle_summary = _sheet_by_name(workbook, "cycle", required=False) is not None
            has_step_summary = _sheet_by_name(workbook, "step", required=False) is not None
    except NewareExcelError:
        raise
    except Exception as exc:
        raise InvalidNewareExcelError(
            "Could not read Neware Excel metadata."
        ) from exc

    if info.get("start_time") is None:
        start_time = unit_original.get("StartTime", {}).get("Value")
        if start_time:
            info["start_time"] = start_time

    head_info: dict[str, object] = {}

    def head_value(key: str, value: object) -> None:
        if value is not None and not _is_blank(value):
            head_info[key] = {"Value": str(value)}

    head_value("Start_Step", info.get("start_step_id"))
    head_value("PN", info.get("part_number"))
    head_value("Creator", info.get("builder"))
    head_value("Remark", info.get("remarks"))
    if info.get("active_mass_mg") is not None:
        head_value("SCQ", float(info["active_mass_mg"]) * 1000.0)
    if info.get("nominal_capacity_mah") is not None:
        head_value("MultCap", float(info["nominal_capacity_mah"]) * 3600.0)

    protection: dict[str, object] = {}
    if info.get("protection_voltage_upper_v") is not None:
        protection["Upper"] = {
            "Value": _format_number(float(info["protection_voltage_upper_v"]) * 10000.0)
        }
    if info.get("protection_voltage_lower_v") is not None:
        protection["Lower"] = {
            "Value": _format_number(float(info["protection_voltage_lower_v"]) * 10000.0)
        }
    if protection:
        head_info["Protect"] = {"Main": {"Volt": protection}}

    original_test: dict[str, object] = {}
    original_names = {
        "start_step_id": "StartStepID",
        "protection_voltage_upper_v": "VoltUpper",
        "protection_voltage_lower_v": "VoltLower",
        "builder": "Builder",
        "remarks": "Remarks",
        "start_time": "StartTime",
        "barcode": "Barcode",
        "active_mass_mg": "ActiveMaterial",
        "nominal_capacity_mah": "NominalCapacity",
        "part_number": "PartNumber",
        "cycle_count": "CycleCount",
        "voltage_range": "VoltageRange",
        "current_range": "CurrentRange",
    }
    raw_info = info["raw"]
    for source_key, output_key in original_names.items():
        raw_value = raw_info.get(source_key)
        if not _is_blank(raw_value):
            original_test[output_key] = {"Value": _value_text(raw_value)}
    record_settings = info.get("record_settings")
    if record_settings is not None:
        original_test["RecordSettings"] = {
            "Value": str(record_settings["raw"]),
            "IntervalS": {"Value": _format_number(float(record_settings["interval_s"]))},
            "VoltageDeltaV": {"Value": _format_number(float(record_settings["voltage_delta_v"]))},
            "CurrentDeltaMA": {"Value": _format_number(float(record_settings["current_delta_ma"]))},
        }
    if info.get("start_time") is not None and "StartTime" not in original_test:
        original_test["StartTime"] = {"Value": str(info["start_time"])}

    original: dict[str, object] = {"Test": original_test, "StepPlan": original_steps}
    if unit_original:
        original["Unit"] = unit_original
    if unit_workbook_name and "WorkbookName" not in unit_original:
        original.setdefault("Unit", {})["WorkbookName"] = {"Value": unit_workbook_name}

    return {
        "Step": {
            "Head_Info": head_info,
            "Step_Info": step_info,
        },
        "Excel": {
            "SourceFormat": {"Value": "neware_excel"},
            "ParserRevision": {"Value": str(EXCEL_PARSER_REVISION)},
            "Capabilities": {
                "ExecutedStepSummary": {"Value": has_step_summary},
                "CycleSummary": {"Value": has_cycle_summary},
                "DeclaredProtocol": {"Value": test_sheet is not None},
                "ProtocolConditions": {"Value": False},
            },
            "Original": original,
        },
    }


def _summary_number(value: object, *, row_number: int, column: str) -> float | None:
    if _is_blank(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InvalidNewareExcelError(
            f"Neware Excel cycle summary row {row_number} has an invalid {column} value."
        ) from exc
    if not math.isfinite(number):
        raise InvalidNewareExcelError(
            f"Neware Excel cycle summary row {row_number} has an invalid {column} value."
        )
    return number


def _parse_cycle_summary(sheet: Any) -> list[dict[str, float | int | None]]:
    headers = _header_map(sheet)
    required = _require_columns(headers, _CYCLE_HEADERS, sheet_name="cycle")
    parsed: list[dict[str, float | int | None]] = []
    for row_number, values in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        if not any(not _is_blank(value) for value in values):
            continue

        def value_for(header: str) -> object:
            return values[required[_normalize_text(header)][0]]

        def scaled_value(header: str, factor: float) -> float | None:
            number = _summary_number(value_for(header), row_number=row_number, column=header)
            return None if number is None else number * factor

        cycle = _integer_value(value_for("Cycle Index"), label="Cycle Index", required=True)
        if cycle is None or cycle <= 0:
            raise InvalidNewareExcelError(
                f"Neware Excel cycle summary row {row_number} has an invalid Cycle Index."
            )
        parsed.append(
            {
                "cycle": cycle,
                "charge_capacity_mah": _summary_number(
                    value_for("Chg. Cap.(mAh)"),
                    row_number=row_number,
                    column="Chg. Cap.(mAh)",
                ),
                "discharge_capacity_mah": _summary_number(
                    value_for("DChg. Cap.(mAh)"),
                    row_number=row_number,
                    column="DChg. Cap.(mAh)",
                ),
                "coulombic_efficiency_pct": _summary_number(
                    value_for("Chg.-DChg. Eff(%)"),
                    row_number=row_number,
                    column="Chg.-DChg. Eff(%)",
                ),
                "charge_energy_mwh": scaled_value("Chg. Energy(Wh)", 1000.0),
                "discharge_energy_mwh": scaled_value("DChg. Energy(Wh)", 1000.0),
                "charge_time_s": scaled_value("Chg. Time(min)", 60.0),
                "discharge_time_s": scaled_value("DChg. Time(min)", 60.0),
            }
        )

    if not parsed:
        raise InvalidNewareExcelError("Neware Excel cycle sheet contains no data rows.")
    parsed.sort(key=lambda row: int(row["cycle"]))
    cycle_ids = [int(row["cycle"]) for row in parsed]
    if len(set(cycle_ids)) != len(cycle_ids):
        raise InvalidNewareExcelError("Neware Excel cycle summary contains duplicate Cycle Index values.")
    return parsed


def validate_cycles(path: str | Path, raw: pd.DataFrame, cycles: pd.DataFrame) -> None:
    """Cross-check calculated cycles against the workbook's small cycle sheet."""

    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        return

    state = raw.attrs.setdefault("neware_excel", {})
    with _open(candidate) as workbook:
        cycle_sheet = _sheet_by_name(workbook, "cycle", required=False)
        if cycle_sheet is None:
            state["cycle_summary_available"] = False
            state["cycle_summary_validated"] = False
            return
        summary = _parse_cycle_summary(cycle_sheet)
        interval_s: float | None = None
        test_sheet = _sheet_by_name(workbook, "test", required=False)
        if test_sheet is not None:
            try:
                info, _header_row, _headers = _parse_test_information(_rows(test_sheet))
                settings = info.get("record_settings")
                if settings is not None:
                    interval_s = float(settings["interval_s"])
            except NewareExcelError:
                # Cycle validation remains useful when optional metadata is
                # absent or malformed; the documented two-second floor applies.
                interval_s = None

    state["cycle_summary_available"] = True
    state["cycle_summary_validated"] = False
    if cycles is None or cycles.empty or "cycle" not in cycles.columns:
        raise InvalidNewareExcelError("Neware Excel cycle summary cannot be compared with empty calculated cycles.")

    actual = cycles.sort_values("cycle", kind="stable").reset_index(drop=True)
    actual_ids = [int(value) for value in actual["cycle"].tolist()]
    summary_ids = [int(row["cycle"]) for row in summary]
    if actual_ids != summary_ids:
        raise InvalidNewareExcelError(
            "Neware Excel cycle summary identity mismatch: cycle count or order differs."
        )

    time_tolerance_s = max(2.0, interval_s if interval_s is not None else 2.0)

    def compare(
        cycle_id: int,
        quantity: str,
        actual_value: object,
        expected_value: object,
        tolerance: float,
    ) -> None:
        if expected_value is None:
            return
        try:
            actual_number = float(actual_value)
            expected_number = float(expected_value)
        except (TypeError, ValueError) as exc:
            raise InvalidNewareExcelError(
                f"Neware Excel cycle {cycle_id} {quantity} cannot be compared."
            ) from exc
        if not math.isfinite(actual_number) or abs(actual_number - expected_number) > tolerance:
            raise InvalidNewareExcelError(
                f"Neware Excel cycle {cycle_id} {quantity} mismatch: "
                f"calculated {actual_number:g}, summary {expected_number:g}."
            )

    for index, row in enumerate(summary):
        cycle_id = int(row["cycle"])
        actual_row = actual.iloc[index]
        charge_capacity = row["charge_capacity_mah"]
        discharge_capacity = row["discharge_capacity_mah"]
        charge_energy = row["charge_energy_mwh"]
        discharge_energy = row["discharge_energy_mwh"]
        charge_time = row["charge_time_s"]
        discharge_time = row["discharge_time_s"]
        actual_charge_time = actual_row.get("charge_time_h")
        actual_discharge_time = actual_row.get("discharge_time_h")
        compare(
            cycle_id,
            "charge capacity",
            actual_row.get("charge_capacity_mah"),
            charge_capacity,
            max(0.002, 0.001 * abs(float(charge_capacity))) if charge_capacity is not None else 0.0,
        )
        compare(
            cycle_id,
            "discharge capacity",
            actual_row.get("discharge_capacity_mah"),
            discharge_capacity,
            max(0.002, 0.001 * abs(float(discharge_capacity))) if discharge_capacity is not None else 0.0,
        )
        compare(
            cycle_id,
            "charge energy",
            actual_row.get("charge_energy_mwh"),
            charge_energy,
            max(0.01, 0.001 * abs(float(charge_energy))) if charge_energy is not None else 0.0,
        )
        compare(
            cycle_id,
            "discharge energy",
            actual_row.get("discharge_energy_mwh"),
            discharge_energy,
            max(0.01, 0.001 * abs(float(discharge_energy))) if discharge_energy is not None else 0.0,
        )
        if charge_time is not None:
            compare(
                cycle_id,
                "charge time",
                float(actual_charge_time) * 3600.0,
                charge_time,
                time_tolerance_s,
            )
        if discharge_time is not None:
            compare(
                cycle_id,
                "discharge time",
                float(actual_discharge_time) * 3600.0,
                discharge_time,
                time_tolerance_s,
            )
        if (
            row["coulombic_efficiency_pct"] is not None
            and pd.notna(actual_row.get("coulombic_efficiency_pct"))
        ):
            compare(
                cycle_id,
                "coulombic efficiency",
                actual_row.get("coulombic_efficiency_pct"),
                row["coulombic_efficiency_pct"],
                0.05,
            )
    state["cycle_summary_validated"] = True
