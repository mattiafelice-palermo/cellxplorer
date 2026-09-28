"""Read structured Neware Excel exports into CellXplorer's raw model.

This module owns the Excel-specific source boundary for Spec 039: workbook metadata,
the programmed plan, the large ``record`` time series, and the small independent
cycle-summary validation.  Dispatch and normalized compatibility fields remain in
:mod:`parsing`; cache publication remains in :mod:`cache`.
"""
from __future__ import annotations

import math
import posixpath
import re
import struct
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from html import unescape as _html_unescape
from contextlib import contextmanager
from datetime import time as datetime_time
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from itertools import chain, islice
from numbers import Number
from pathlib import Path
from typing import Any, Iterator
from xml.parsers import expat
from xml.etree import ElementTree

import numpy as np
import pandas as pd

try:
    import fastexcel as _fastexcel
except (ImportError, OSError):  # pragma: no cover - minimal source installs
    _fastexcel = None  # type: ignore[assignment]
if _fastexcel is not None and not callable(getattr(_fastexcel, "read_excel", None)):
    # A partially visible namespace package can occur in constrained source
    # environments.  Treat it as absent so the reference parser remains the
    # safe fallback instead of surfacing an import-shape AttributeError.
    _fastexcel = None  # type: ignore[assignment]
try:
    import python_calamine as _python_calamine
except (ImportError, OSError):  # pragma: no cover - minimal source installs
    _python_calamine = None  # type: ignore[assignment]
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


EXCEL_PARSER_REVISION = 8


class _FastExcelFallback(Exception):
    """The optional columnar reader cannot represent this workbook safely."""


class _CalamineFallback(Exception):
    """The optional pandas/calamine reader cannot represent this workbook safely."""


_FAST_EXCEL_ERRORS: tuple[type[BaseException], ...] = (
    ImportError,
    OSError,
)
if _fastexcel is not None:
    _fast_excel_error = getattr(_fastexcel, "FastExcelError", None)
    if isinstance(_fast_excel_error, type):
        _FAST_EXCEL_ERRORS += (_fast_excel_error,)
_CALAMINE_ERRORS: tuple[type[BaseException], ...] = (
    ImportError,
    OSError,
    ValueError,
    RuntimeError,
    zipfile.BadZipFile,
)
if _python_calamine is not None:
    _calamine_error = getattr(_python_calamine, "CalamineError", None)
    if isinstance(_calamine_error, type):
        _CALAMINE_ERRORS += (_calamine_error,)

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
_VALUE_GROUP_VALUE_OFFSET = 2

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

_CYCLE_REQUIRED_HEADERS = (
    "Cycle Index",
    "Chg. Cap.(mAh)",
    "DChg. Cap.(mAh)",
    "Chg. Time(min)",
    "DChg. Time(min)",
)
_CYCLE_OPTIONAL_HEADERS = (
    "Chg.-DChg. Eff(%)",
    "Chg. Energy(Wh)",
    "DChg. Energy(Wh)",
)
_CYCLE_HEADERS = _CYCLE_REQUIRED_HEADERS + _CYCLE_OPTIONAL_HEADERS

# Neware changes labels and displayed units between export surfaces and
# software versions.  These aliases are deliberately scoped to the worksheet
# that owns the field: ``record`` may use Cycle ID while ``step`` uses Cycle
# Index in the same workbook.  A resolver rejects a workbook that contains
# both aliases for one semantic field instead of silently picking one.
_HEADER_ALIASES: dict[str, dict[str, tuple[str, ...]]] = {
    "record": {
        "Cycle Index": ("Cycle Index", "Cycle ID"),
        "Step Index": ("Step Index", "Step ID"),
        "Time(min)": ("Time(min)", "Time"),
        "Total Time(min)": ("Total Time(min)", "Total Time"),
        "Power(W)": ("Power(W)", "Power(kW)"),
    },
    "step": {
        "Cycle Index": ("Cycle Index", "Cycle ID"),
        "Step Index": ("Step Index", "Step ID"),
        "Step Time(min)": ("Step Time(min)", "Step Time"),
        "Energy(Wh)": ("Energy(Wh)", "Energy(kWh)"),
    },
    "cycle": {
        "Cycle Index": ("Cycle Index", "Cycle ID"),
        "Chg. Time(min)": ("Chg. Time(min)", "Chg. Time"),
        "DChg. Time(min)": ("DChg. Time(min)", "DChg. Time"),
        "Chg. Energy(Wh)": ("Chg. Energy(Wh)", "Chg. Energy(kWh)"),
        "DChg. Energy(Wh)": ("DChg. Energy(Wh)", "DChg. Energy(kWh)"),
    },
}

_PLAN_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "Step Time(min)": ("Step Time(min)", "Step Time(hh:mm:ss.ms)", "Step Time"),
    "Energy(Wh)": ("Energy(Wh)", "Energy(kWh)"),
    "Power(W)": ("Power(W)", "Power(kW)"),
}

class NewareExcelError(ValueError):
    """Base class for bounded Neware Excel parser errors.

    Kept as the adapter-specific base so every existing `except
    NewareExcelError` call site keeps working unchanged. Each subclass below
    additionally inherits from the matching format-neutral type in
    `source_format_errors` so `except SourceFormatError` also catches it (see
    that module's docstring for the full taxonomy and MRO reasoning).
    """


class UnsupportedNewareExcelError(NewareExcelError, UnsupportedSourceFormatError):
    """The workbook is not the supported structured Neware export."""


class InvalidNewareExcelError(NewareExcelError, InvalidSourceFormatError):
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
_DURATION_RE = re.compile(
    r"^(?P<hours>\d+):(?P<minutes>[0-5]\d):(?P<seconds>[0-5]\d)"
    r"(?:\.(?P<fraction>\d{1,6}))?$"
)


def _clock_duration_seconds(value: object) -> float:
    """Parse Neware's unbounded ``H+:MM:SS[.ffffff]`` duration values.

    Neware sometimes writes elapsed durations as strings and sometimes lets
    openpyxl decode formatted Excel duration cells into ``timedelta`` or
    ``time`` objects.  The first component is intentionally unbounded: it is
    elapsed hours, not a clock hour that rolls over at 24.
    """

    if isinstance(value, timedelta):
        seconds = value.total_seconds()
        if math.isfinite(seconds) and seconds >= 0.0:
            return float(seconds)
        raise ValueError("negative or non-finite duration")
    if isinstance(value, datetime_time):
        return (
            value.hour * 3600.0
            + value.minute * 60.0
            + value.second
            + value.microsecond / 1_000_000.0
        )
    if isinstance(value, Number) and not isinstance(value, bool):
        raise ValueError("numeric values are ambiguous under a unitless duration header")

    text = str(value).strip() if value is not None else ""
    match = _DURATION_RE.fullmatch(text)
    if match is None:
        raise ValueError("duration must use H+:MM:SS")
    fraction = match.group("fraction") or ""
    fraction_seconds = int(fraction.ljust(6, "0")) / 1_000_000.0 if fraction else 0.0
    return (
        int(match.group("hours")) * 3600.0
        + int(match.group("minutes")) * 60.0
        + int(match.group("seconds"))
        + fraction_seconds
    )


def _unitless_or_minutes_seconds(
    value: object,
    *,
    source_header: str,
    canonical_header: str,
) -> float:
    """Convert a duration according to the exact resolved header alias."""

    if _duration_header_is_unitless_minutes(source_header, canonical_header):
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("duration is not numeric minutes") from exc
        if not math.isfinite(number):
            raise ValueError("duration is not finite")
        return number * 60.0
    return _clock_duration_seconds(value)


@lru_cache(maxsize=64)
def _duration_header_is_unitless_minutes(
    source_header: str,
    canonical_header: str,
) -> bool:
    """Reuse a stable alias comparison across large row-wise conversions."""
    return _normalize_text(source_header) == _normalize_text(canonical_header)


def _is_clock_duration_source(source_header: str, canonical_header: str) -> bool:
    """Return whether a resolved duration header contains an elapsed clock."""

    return not _duration_header_is_unitless_minutes(source_header, canonical_header)


def _power_to_watts_factor(source_header: str) -> float:
    return 1000.0 if _normalize_text(source_header) == "power(kw)" else 1.0


def _energy_to_mwh_factor(source_header: str) -> float:
    return 1_000_000.0 if "(kwh)" in _normalize_text(source_header) else 1_000.0


def _unit_name(value: str) -> str:
    normalized = value.strip().casefold().replace("μ", "µ")
    return {
        "milligram": "mg",
        "milligrams": "mg",
        "milliamphour": "mah",
        "milliamphours": "mah",
        "millivolt": "mv",
        "millivolts": "mv",
        "millisecond": "ms",
        "milliseconds": "ms",
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
        try:
            parsed_value = _quantity(
                part,
                label=label,
                expected_unit=expected,
                required_unit=True,
            )
        except InvalidNewareExcelError:
            if expected != "s":
                raise
            # Neware's export UI commonly writes the record interval as
            # ``60000ms`` even though CellXplorer's protocol model stores
            # seconds.  This is an explicit unit alias, not a first-number
            # guess.
            parsed_value = _quantity(
                part,
                label=label,
                expected_unit="ms",
                required_unit=True,
            )
            if parsed_value is not None:
                parsed_value /= 1000.0
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
    """Return the value in a verified Neware label/value group.

    The exported information layouts place labels and values two columns apart
    (A/C, D/F, G/I; and the same positional groups on the ``unit`` sheet).
    Reading that fixed value slot keeps a blank value bounded to its own group;
    scanning arbitrary later cells can accidentally consume the next group's
    unsupported label.
    """

    wanted = _normalize_label(label)
    for row in rows:
        for index, value in enumerate(row):
            if _normalize_label(value) != wanted:
                continue
            value_index = index + _VALUE_GROUP_VALUE_OFFSET
            if value_index >= len(row):
                return None
            candidate = row[value_index]
            return None if _is_blank(candidate) else candidate
    return None


def _find_step_plan(
    rows: list[tuple[object, ...]],
) -> tuple[int, dict[str, tuple[int, str]]]:
    marker_row: int | None = None
    for row_number, row in enumerate(rows):
        if any(_normalize_label(value) == "step plan" for value in row):
            marker_row = row_number
            break
    if marker_row is None:
        raise InvalidNewareExcelError("Neware Excel test sheet has no Step plan marker.")

    for row_number in range(marker_row + 1, len(rows)):
        row = rows[row_number]
        headers: dict[str, tuple[int, str]] = {}
        for index, value in enumerate(row):
            normalized = _normalize_text(value)
            if normalized:
                original = str(value).strip()
                if normalized in headers:
                    raise InvalidNewareExcelError(
                        "Neware Excel test sheet has an ambiguous normalized Step plan header: "
                        f"{original}."
                    )
                headers[normalized] = (index, original)
        if all(_normalize_text(header) in headers for header in _PLAN_REQUIRED_HEADERS):
            return row_number, headers
    raise InvalidNewareExcelError("Neware Excel test sheet has no Step plan header row.")


def _original_key(header: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", header)
    return "".join(word[:1].upper() + word[1:] for word in words) or "Value"


def _plan_header_aliases(header: str) -> tuple[str, ...]:
    return _PLAN_HEADER_ALIASES.get(header, (header,))


def _plan_binding(
    headers: dict[str, tuple[int, str]],
    header: str,
) -> tuple[int, str] | None:
    matches = [
        headers[_normalize_text(alias)]
        for alias in _plan_header_aliases(header)
        if _normalize_text(alias) in headers
    ]
    if len(matches) > 1:
        raise InvalidNewareExcelError(
            "Neware Excel test sheet has ambiguous Step plan aliases for "
            f"{header}."
        )
    return matches[0] if matches else None


def _plan_value(
    row: tuple[object, ...],
    headers: dict[str, tuple[int, str]],
    header: str,
) -> object:
    binding = _plan_binding(headers, header)
    if binding is None:
        return None
    index, _source = binding
    return row[index] if index < len(row) else None


def _plan_source_header(headers: dict[str, tuple[int, str]], header: str) -> str:
    binding = _plan_binding(headers, header)
    return binding[1] if binding is not None else header


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
) -> tuple[dict[str, object], int, dict[str, tuple[int, str]]]:
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
    headers: dict[str, tuple[int, str]],
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
                source_header = _plan_source_header(headers, header)
                source_values[_original_key(source_header)] = {"Value": _value_text(value)}

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
            step_time_value = _plan_value(row, headers, "Step Time(min)")
            step_time_source = _plan_source_header(headers, "Step Time(min)")
            if _normalize_text(step_time_source) == _normalize_text("Step Time(min)"):
                step_time_min = _plan_quantity(
                    step_time_value,
                    label=f"Step {step_index} Step Time(min)",
                    unit="min",
                )
            elif _is_blank(step_time_value):
                step_time_min = None
            else:
                try:
                    step_time_min = _clock_duration_seconds(step_time_value) / 60.0
                except (TypeError, ValueError, OverflowError) as exc:
                    raise InvalidNewareExcelError(
                        f"Neware Excel Step {step_index} Step Time must use H+:MM:SS."
                    ) from exc
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


def _header_aliases(sheet_name: str, header: str) -> tuple[str, ...]:
    return _HEADER_ALIASES.get(sheet_name, {}).get(header, (header,))


def _resolve_header(
    headers: dict[str, tuple[int, str]],
    header: str,
    *,
    sheet_name: str,
) -> tuple[int, str] | None:
    matches = [
        headers[_normalize_text(alias)]
        for alias in _header_aliases(sheet_name, header)
        if _normalize_text(alias) in headers
    ]
    if len(matches) > 1:
        names = ", ".join(match[1] for match in matches)
        raise InvalidNewareExcelError(
            f"Neware Excel {sheet_name} sheet has ambiguous aliases for {header}: {names}."
        )
    return matches[0] if matches else None


def _require_columns(
    headers: dict[str, tuple[int, str]],
    required: tuple[str, ...],
    *,
    sheet_name: str,
) -> dict[str, tuple[int, str]]:
    resolved: dict[str, tuple[int, str]] = {}
    missing: list[str] = []
    for name in required:
        binding = _resolve_header(headers, name, sheet_name=sheet_name)
        if binding is None:
            missing.append(name)
        else:
            resolved[_normalize_text(name)] = binding
    if missing:
        if sheet_name == "record":
            raise UnsupportedNewareExcelError(
                "Neware Excel export is missing required record column: "
                f"{missing[0]}."
            )
        raise InvalidNewareExcelError(
            f"Neware Excel {sheet_name} sheet is missing required column: {missing[0]}."
        )
    return resolved


def _optional_columns(
    headers: dict[str, tuple[int, str]],
    optional: tuple[str, ...],
    *,
    sheet_name: str,
) -> dict[str, tuple[int, str]]:
    resolved: dict[str, tuple[int, str]] = {}
    for name in optional:
        binding = _resolve_header(headers, name, sheet_name=sheet_name)
        if binding is not None:
            resolved[_normalize_text(name)] = binding
    return resolved


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
    int_info = np.iinfo(np.int64)
    if (
        not number.is_integer()
        or number < int_info.min
        or number >= 2**63
    ):
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
    optional_columns = _optional_columns(
        headers,
        tuple(OPTIONAL_RECORD_HEADERS),
        sheet_name="record",
    )
    optional = {
        normalized: (optional_columns[normalized][0], source, target)
        for source, target in OPTIONAL_RECORD_HEADERS.items()
        for normalized in [_normalize_text(source)]
        if normalized in optional_columns
    }

    data_point_index = required[_normalize_text("DataPoint")][0]
    cycle_index = required[_normalize_text("Cycle Index")][0]
    step_index = required[_normalize_text("Step Index")][0]
    status_index = required[_normalize_text("Step Type")][0]
    time_index, time_source = required[_normalize_text("Time(min)")]
    total_time_index, total_time_source = required[_normalize_text("Total Time(min)")]
    current_index = required[_normalize_text("Current(mA)")][0]
    voltage_index = required[_normalize_text("Voltage(V)")][0]
    charge_capacity_index = required[_normalize_text("Chg. Cap.(mAh)")][0]
    discharge_capacity_index = required[_normalize_text("DChg. Cap.(mAh)")][0]
    timestamp_index = required[_normalize_text("Date")][0]
    power_index, power_source = required[_normalize_text("Power(W)")]
    time_is_clock = _is_clock_duration_source(time_source, "Time(min)")
    total_time_is_clock = _is_clock_duration_source(total_time_source, "Total Time(min)")
    power_factor = _power_to_watts_factor(power_source)

    records: list[dict[str, object]] = []
    for row_number, values in enumerate(
        sheet.iter_rows(min_row=2, values_only=True), start=2
    ):
        if not any(value is not None and str(value).strip() for value in values):
            continue

        def elapsed_seconds(value: object, source_header: str, is_clock: bool) -> float:
            try:
                if is_clock:
                    return _clock_duration_seconds(value)
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError("duration is not finite")
                return number * 60.0
            except (TypeError, ValueError, OverflowError) as exc:
                raise _invalid_record(row_number, source_header) from exc

        record: dict[str, object] = {
            "record_index": _integer(
                values[data_point_index], row_number=row_number, column="DataPoint"
            ),
            "cycle": _integer(
                values[cycle_index], row_number=row_number, column="Cycle Index"
            ),
            "step_index": _integer(
                values[step_index], row_number=row_number, column="Step Index"
            ),
            "status": _normalize_status(values[status_index], row_number=row_number),
            "time_s": elapsed_seconds(values[time_index], time_source, time_is_clock),
            "total_time_s": elapsed_seconds(
                values[total_time_index], total_time_source, total_time_is_clock
            ),
            "current_ma": _number(
                values[current_index], row_number=row_number, column="Current(mA)"
            ),
            "voltage_v": _number(
                values[voltage_index], row_number=row_number, column="Voltage(V)"
            ),
            "charge_capacity_mah": _number(
                values[charge_capacity_index],
                row_number=row_number,
                column="Chg. Cap.(mAh)",
            ),
            "discharge_capacity_mah": _number(
                values[discharge_capacity_index],
                row_number=row_number,
                column="DChg. Cap.(mAh)",
            ),
            "timestamp": _timestamp(
                values[timestamp_index], row_number=row_number, column="Date"
            ),
            "power_w": _number(
                values[power_index], row_number=row_number, column=power_source
            )
            * power_factor,
        }
        for normalized, (_index, source, target) in optional.items():
            record[target] = _optional_number(
                values[_index], row_number=row_number, column=source
            )
        records.append(record)

    if not records:
        raise InvalidNewareExcelError("Neware Excel record sheet contains no data rows.")
    return records


def _fast_header_map(columns: Iterator[object]) -> dict[str, tuple[int, str]]:
    result: dict[str, tuple[int, str]] = {}
    for index, value in enumerate(columns):
        original = "" if value is None else str(value).strip()
        normalized = _normalize_text(value)
        if not normalized:
            continue
        if normalized in result:
            raise InvalidNewareExcelError(
                "Neware Excel record sheet has an ambiguous normalized header: "
                f"{original}."
            )
        result[normalized] = (index, original)
    return result


def _fast_column(frame: pd.DataFrame, binding: tuple[int, str]) -> pd.Series:
    return frame.iloc[:, binding[0]]


def _fast_blank(series: pd.Series) -> pd.Series:
    if pd.api.types.is_numeric_dtype(series):
        return series.isna()
    return series.isna() | series.astype("string").str.strip().eq("").fillna(True)


def _fast_raise_first_bad(
    bad: pd.Series,
    row_numbers: np.ndarray,
    column: str,
) -> None:
    mask = bad.fillna(True).to_numpy(dtype=bool)
    positions = np.flatnonzero(mask)
    if len(positions):
        raise _invalid_record(int(row_numbers[positions[0]]), column)


def _fast_number_series(
    series: pd.Series,
    *,
    row_numbers: np.ndarray,
    column: str,
    optional: bool = False,
) -> np.ndarray:
    blank = _fast_blank(series)
    numbers = pd.to_numeric(series, errors="coerce")
    finite = pd.Series(
        np.isfinite(numbers.to_numpy(dtype="float64", na_value=np.nan)),
        index=series.index,
    )
    bad = (~blank & numbers.isna()) | (~blank & ~finite)
    if not optional:
        bad = bad | blank
    _fast_raise_first_bad(bad, row_numbers, column)
    values = numbers.to_numpy(dtype="float64", na_value=np.nan).copy()
    if optional:
        values[blank.to_numpy(dtype=bool, na_value=True)] = np.nan
    return values


def _fast_integer_series(
    series: pd.Series,
    *,
    row_numbers: np.ndarray,
    column: str,
) -> np.ndarray:
    values = _fast_number_series(series, row_numbers=row_numbers, column=column)
    int_info = np.iinfo(np.int64)
    bad = pd.Series(
        (values != np.floor(values))
        | (values < int_info.min)
        | (values >= 2**63),
        index=series.index,
    )
    _fast_raise_first_bad(bad, row_numbers, column)
    return values.astype("int64")


def _fast_duration_series(
    series: pd.Series,
    *,
    row_numbers: np.ndarray,
    source_header: str,
    canonical_header: str,
) -> np.ndarray:
    if not _is_clock_duration_source(source_header, canonical_header):
        return _fast_number_series(
            series,
            row_numbers=row_numbers,
            column=source_header,
        ) * 60.0

    values = series.to_numpy(dtype=object, na_value=None)
    seconds = np.empty(len(values), dtype="float64")
    for position, value in enumerate(values):
        if value is None or bool(pd.isna(value)):
            raise _invalid_record(int(row_numbers[position]), source_header)
        if not isinstance(value, str):
            # fastexcel normally returns clock durations as strings.  Keep the
            # reference path for native timedelta/time cells instead of
            # changing their conversion semantics in the optimized path.
            raise _FastExcelFallback("clock duration representation is not textual")
        match = _DURATION_RE.fullmatch(value.strip())
        if match is None:
            raise _invalid_record(int(row_numbers[position]), source_header)
        fraction = match.group("fraction") or ""
        fraction_seconds = int(fraction.ljust(6, "0")) / 1_000_000.0 if fraction else 0.0
        seconds[position] = (
            int(match.group("hours")) * 3600.0
            + int(match.group("minutes")) * 60.0
            + int(match.group("seconds"))
            + fraction_seconds
        )
    return seconds


def _fast_timestamp_series(
    series: pd.Series,
    *,
    row_numbers: np.ndarray,
    column: str,
) -> pd.Series:
    blank = _fast_blank(series)
    if pd.api.types.is_numeric_dtype(series):
        _fast_raise_first_bad(~blank, row_numbers, column)

    values = series.tolist()
    numeric_mask = pd.Series(
        [
            not pd.isna(value)
            and isinstance(value, Number)
            and not isinstance(value, bool)
            for value in values
        ],
        index=series.index,
    )
    _fast_raise_first_bad(numeric_mask, row_numbers, column)

    text = series.astype("string").str.strip()
    numeric_text_mask = text.str.fullmatch(_PLAIN_NUMBER_RE.pattern, na=False)
    _fast_raise_first_bad(numeric_text_mask, row_numbers, column)
    timezone_mask = text.str.contains(
        r"(?:Z|[+-]\d{2}:?\d{2})\s*$",
        regex=True,
        na=False,
    )
    _fast_raise_first_bad(timezone_mask, row_numbers, column)
    try:
        timestamps = pd.to_datetime(text, errors="coerce", format="mixed")
    except (TypeError, ValueError) as exc:
        raise _FastExcelFallback("timestamp representation is not vectorizable") from exc
    if isinstance(timestamps.dtype, pd.DatetimeTZDtype):
        _fast_raise_first_bad(~blank, row_numbers, column)
    bad = blank | timestamps.isna()
    _fast_raise_first_bad(bad, row_numbers, column)
    return pd.Series(timestamps, index=series.index, dtype="datetime64[ns]")


def _fast_status_series(
    series: pd.Series,
    *,
    row_numbers: np.ndarray,
) -> pd.Series:
    normalized = (
        series.astype("string")
        .str.replace(r"\s+", " ", regex=True)
        .str.strip()
        .str.casefold()
    )
    canonical = normalized.map(_STATUS_ALIASES)
    _fast_raise_first_bad(canonical.isna(), row_numbers, "Step Type")
    return canonical.astype("string")


def _fast_nonempty_rows(frame: pd.DataFrame) -> pd.Series:
    nonempty = pd.Series(False, index=frame.index)
    for column in frame.columns:
        series = frame[column]
        if pd.api.types.is_numeric_dtype(series):
            nonempty = nonempty | series.notna()
        else:
            nonempty = nonempty | series.astype("string").str.strip().ne("").fillna(False)
    return nonempty


class _FastFrameSheetAdapter:
    """Expose a small fastexcel frame through the reference row interface."""

    def __init__(self, title: str, frame: pd.DataFrame, *, header_row: bool):
        self.title = title
        self._frame = frame
        self._header_row = header_row

    @property
    def frame(self) -> pd.DataFrame:
        return self._frame

    @staticmethod
    def _cell(value: object) -> object:
        if value is None:
            return None
        missing = pd.isna(value)
        if isinstance(missing, (bool, np.bool_)) and bool(missing):
            return None
        return value

    def reset_dimensions(self) -> None:
        return None

    def iter_rows(
        self,
        *,
        min_row: int = 1,
        max_row: int | None = None,
        values_only: bool = True,
    ) -> Iterator[tuple[object, ...]]:
        if not values_only:
            raise ValueError("The Neware Excel parser requires values_only rows.")
        rows: Iterator[tuple[object, ...]] = (
            tuple(self._cell(value) for value in row)
            for row in self._frame.itertuples(index=False, name=None)
        )
        if self._header_row:
            rows = chain(
                (tuple(str(column) for column in self._frame.columns),),
                rows,
            )
        if min_row > 1:
            rows = islice(rows, min_row - 1, None)
        if max_row is not None:
            rows = islice(rows, max(0, max_row - min_row + 1))
        yield from rows


class _CalamineSheetAdapter:
    """Expose a Calamine worksheet through the parser's small row-reader API."""

    def __init__(self, title: str, workbook: Any):
        self.title = title
        self._workbook = workbook
        self._sheet: Any | None = None

    def _get_sheet(self) -> Any:
        if self._sheet is None:
            self._sheet = self._workbook.get_sheet_by_name(self.title)
        return self._sheet

    def reset_dimensions(self) -> None:
        # Calamine reads the actual worksheet range and does not trust Excel's
        # sometimes-stale <dimension ref="A1"/> declaration.
        return None

    def iter_rows(
        self,
        *,
        min_row: int = 1,
        max_row: int | None = None,
        values_only: bool = True,
    ) -> Iterator[tuple[object, ...]]:
        if not values_only:
            raise ValueError("The Neware Excel parser requires values_only rows.")
        rows: Iterator[tuple[object, ...]] = (
            tuple(row) for row in self._get_sheet().iter_rows()
        )
        if min_row > 1:
            rows = islice(rows, min_row - 1, None)
        if max_row is not None:
            rows = islice(rows, max(0, max_row - min_row + 1))
        yield from rows


class _RowsSheetAdapter:
    """Expose a bounded in-memory worksheet fragment through the row-reader API."""

    def __init__(self, title: str, rows: list[tuple[object, ...]]):
        self.title = title
        self._rows = rows

    def reset_dimensions(self) -> None:
        return None

    def iter_rows(
        self,
        *,
        min_row: int = 1,
        max_row: int | None = None,
        values_only: bool = True,
    ) -> Iterator[tuple[object, ...]]:
        if not values_only:
            raise ValueError("The Neware Excel parser requires values_only rows.")
        rows: Iterator[tuple[object, ...]] = iter(self._rows)
        if min_row > 1:
            rows = islice(rows, min_row - 1, None)
        if max_row is not None:
            rows = islice(rows, max(0, max_row - min_row + 1))
        yield from rows


class _CalamineWorkbookAdapter:
    """Expose Calamine sheets lazily, allowing a ZIP-backed record-header override."""

    def __init__(self, workbook: Any, overrides: dict[str, Any] | None = None):
        self._workbook = workbook
        normalized_overrides = {
            _normalize_text(name): sheet
            for name, sheet in (overrides or {}).items()
        }
        self.worksheets = []
        for name in workbook.sheet_names:
            title = str(name)
            self.worksheets.append(
                normalized_overrides.get(_normalize_text(title))
                or _CalamineSheetAdapter(title, workbook)
            )

    def close(self) -> None:
        self._workbook.close()


_XML_CELL_BLOCK_RE = re.compile(rb"<c\b([^>]*)>(.*?)</c>", re.DOTALL)
_XML_CELL_REF_RE = re.compile(rb'\br="([A-Z]+)\d+"')
_XML_CELL_TYPE_RE = re.compile(rb'\bt="([^"]+)"')
_XML_CELL_VALUE_RE = re.compile(rb"<v>(.*?)</v>", re.DOTALL)
_XML_INLINE_TEXT_RE = re.compile(rb"<t(?:\s[^>]*)?>(.*?)</t>", re.DOTALL)
_XML_SHARED_ITEM_RE = re.compile(
    rb"<si\b[^>]*>(.*?)</si>|<si\b[^>]*/>", re.DOTALL
)
_XML_SHARED_TEXT_RE = re.compile(rb"<t(?:\s[^>]*)?>(.*?)</t>", re.DOTALL)
_XML_ROW_NUMBER_RE = re.compile(rb'\br="(\d+)"')

_XLSX_FAST_PREVIEW_CHUNK_BYTES = 256 << 10
_XLSX_FAST_PREVIEW_MAX_SHARED_STRINGS_BYTES = 128 << 20
_XLSX_FAST_PREVIEW_CELL_RE = re.compile(
    rb'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', re.DOTALL
)
_XLSX_SHARED_STRING_REF = object()


class _XlsxFastPreviewUnsupported(Exception):
    """The bounded XLSX preview path cannot safely handle this workbook."""


class _XlsxFastPreviewNeedsValidatedFallback(Exception):
    """The selected quick-preview rows require the canonical parser path."""


def _require_monotonic_preview_time(raw: pd.DataFrame) -> None:
    if "total_time_s" not in raw or len(raw) < 2:
        return
    total_time = pd.to_numeric(raw["total_time_s"], errors="coerce").to_numpy(dtype="float64")
    if np.any(np.diff(total_time) < -1e-9):
        raise _XlsxFastPreviewNeedsValidatedFallback


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xlsx_sheet_paths(archive: zipfile.ZipFile) -> dict[str, str]:
    """Map normalized worksheet names to ZIP member paths without loading sheets."""
    workbook_root = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    relationship_root = ElementTree.fromstring(
        archive.read("xl/_rels/workbook.xml.rels")
    )
    relationships = {
        relation.attrib.get("Id", ""): relation.attrib.get("Target", "")
        for relation in relationship_root
        if _xml_local_name(relation.tag) == "Relationship"
    }
    result: dict[str, str] = {}
    relationship_id_name = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    for item in workbook_root.iter():
        if _xml_local_name(item.tag) != "sheet":
            continue
        name = item.attrib.get("name", "")
        relationship_id = item.attrib.get(relationship_id_name, "")
        target = relationships.get(relationship_id)
        if not name or not target:
            continue
        member = target.lstrip("/") if target.startswith("/") else posixpath.normpath(
            posixpath.join("xl", target)
        )
        result[_normalize_text(name)] = member
    return result


def _xlsx_shared_strings(
    archive: zipfile.ZipFile,
    *,
    max_index: int | None = None,
) -> list[str]:
    """Read only the shared-string prefix needed by the requested cells."""
    try:
        source = archive.open("xl/sharedStrings.xml")
    except KeyError:
        return []
    values: list[str] = []
    current_parts: list[str] | None = None
    inside_text = False
    parser = expat.ParserCreate()

    class _ReachedRequestedIndex(Exception):
        pass

    def start_element(name: str, _attributes: dict[str, str]) -> None:
        nonlocal current_parts, inside_text
        if name == "si":
            current_parts = []
        elif name == "t" and current_parts is not None:
            inside_text = True

    def end_element(name: str) -> None:
        nonlocal current_parts, inside_text
        if name == "t":
            inside_text = False
        elif name == "si" and current_parts is not None:
            values.append("".join(current_parts))
            current_parts = None
            if max_index is not None and len(values) > max_index:
                raise _ReachedRequestedIndex

    def character_data(value: str) -> None:
        if inside_text and current_parts is not None:
            current_parts.append(value)

    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    parser.CharacterDataHandler = character_data
    with source:
        try:
            while chunk := source.read(16 << 10):
                parser.Parse(chunk, False)
            parser.Parse(b"", True)
        except _ReachedRequestedIndex:
            pass
    return values


def _xlsx_shared_strings_for_indices(
    archive: zipfile.ZipFile,
    indexes: set[int],
) -> list[str]:
    """Resolve sparse worksheet string references with a C-level XML scan.

    Neware can write unique time values into a very large shared-string table.
    Expat is ideal for early prefix reads, but Python callbacks for every
    string make a full pass expensive. The regex engine walks the XML in C and
    only decodes the entries actually referenced by the preview rows.
    """
    if not indexes:
        return []
    try:
        source = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    maximum = max(indexes)
    values = [""] * (maximum + 1)
    found: set[int] = set()
    for index, match in enumerate(_XML_SHARED_ITEM_RE.finditer(source)):
        if index not in indexes:
            continue
        item = match.group(1) or b""
        pieces = (
            _html_unescape(piece.decode("utf-8"))
            for piece in _XML_SHARED_TEXT_RE.findall(item)
        )
        values[index] = "".join(pieces)
        found.add(index)
        if len(found) == len(indexes):
            break
    if found != indexes:
        raise InvalidNewareExcelError(
            "Neware Excel workbook contains an invalid shared-string reference."
        )
    return values


def _iter_xlsx_xml_rows(source: Any, *, initial: bytes = b"") -> Iterator[bytes]:
    """Yield worksheet row XML fragments while streaming the ZIP member."""
    buffer = bytearray(initial)
    cursor = 0
    chunk_size = 1 << 20
    while True:
        chunk = source.read(chunk_size)
        if chunk:
            buffer.extend(chunk)
        eof = not chunk
        while True:
            start = buffer.find(b"<row", cursor)
            if start < 0:
                if eof:
                    return
                cursor = max(0, len(buffer) - 8)
                break
            boundary = start + 4
            if boundary >= len(buffer) and not eof:
                cursor = start
                break
            if boundary < len(buffer) and buffer[boundary] not in b" />\t\r\n":
                cursor = boundary
                continue
            open_end = buffer.find(b">", boundary)
            if open_end < 0:
                if eof:
                    return
                cursor = start
                break
            if buffer[open_end - 1] == ord("/"):
                cursor = open_end + 1
                continue
            close = buffer.find(b"</row>", open_end + 1)
            if close < 0:
                if eof:
                    return
                cursor = start
                break
            row_end = close + len(b"</row>")
            yield bytes(buffer[start:row_end])
            cursor = row_end
        if cursor >= chunk_size:
            del buffer[:cursor]
            cursor = 0


def _iter_xlsx_rows_from_cycle_start(
    source: Any,
    *,
    cycle_column: bytes,
    first_cycle_id: int,
) -> Iterator[bytes]:
    """Start row iteration at the first numeric record for a given cycle."""
    value = str(first_cycle_id).encode("ascii")
    pattern = re.compile(
        rb'<c r="'
        + cycle_column
        + rb'\d+"[^>]*><v>'
        + value
        + rb'(?:\.0+)?</v></c>'
    )
    buffer = bytearray()
    chunk_size = 4 << 20
    while True:
        chunk = source.read(chunk_size)
        if chunk:
            buffer.extend(chunk)
        match = pattern.search(buffer)
        if match is not None:
            row_start = buffer.rfind(b"<row", 0, match.start())
            if row_start < 0:
                raise InvalidNewareExcelError(
                    "Could not locate the Neware Excel preview cycle row."
                )
            while buffer.find(b"</row>", match.end()) < 0:
                more = source.read(chunk_size)
                if not more:
                    raise InvalidNewareExcelError(
                        "Neware Excel preview cycle row is incomplete."
                    )
                buffer.extend(more)
            yield from _iter_xlsx_xml_rows(source, initial=bytes(buffer[row_start:]))
            return
        if not chunk:
            return
        last_row_end = buffer.rfind(b"</row>")
        if last_row_end >= 0:
            del buffer[: last_row_end + len(b"</row>")]


def _iter_xlsx_rows_for_cycles(
    source: Any,
    *,
    cycle_column: bytes,
    target_cycle_ids: set[int],
) -> Iterator[tuple[int, int, bytes]]:
    """Yield only rows whose numeric cycle cell is in the requested set.

    The row worksheet is a single DEFLATE stream, so it must be inflated from
    the beginning. Searching its decompressed chunks for the selected cycle
    cells keeps the 460k-row scan in the C regex engine and avoids constructing
    a Python bytes object and parsing XML for every row.
    """
    if not target_cycle_ids:
        return
    cycle_values = b"|".join(
        str(cycle_id).encode("ascii") + rb"(?:\.0+)?"
        for cycle_id in sorted(target_cycle_ids, key=lambda value: len(str(value)), reverse=True)
    )
    pattern = re.compile(
        rb'<c r="'
        + cycle_column
        + rb'(\d+)"[^>]*><v>('
        + cycle_values
        + rb')</v></c>'
    )
    buffer = bytearray()
    chunk_size = 4 << 20
    while True:
        chunk = source.read(chunk_size)
        if chunk:
            buffer.extend(chunk)
        eof = not chunk
        cursor = 0
        pending_row_start: int | None = None
        while True:
            match = pattern.search(buffer, cursor)
            if match is None:
                break
            row_start = buffer.rfind(b"<row", 0, match.start())
            if row_start < 0:
                pending_row_start = 0
                break
            row_end = buffer.find(b"</row>", match.end())
            if row_end < 0:
                pending_row_start = row_start
                break
            row_number = int(match.group(1))
            cycle_id = int(float(match.group(2)))
            yield row_number, cycle_id, bytes(buffer[row_start : row_end + len(b"</row>")])
            cursor = row_end + len(b"</row>")
        if eof:
            return
        if pending_row_start is not None:
            del buffer[:pending_row_start]
        else:
            last_row_end = buffer.rfind(b"</row>")
            if last_row_end >= 0:
                del buffer[: last_row_end + len(b"</row>")]


def _xlsx_column_letters(column_index: int) -> bytes:
    value = column_index + 1
    letters = bytearray()
    while value:
        value, remainder = divmod(value - 1, 26)
        letters.append(ord("A") + remainder)
    letters.reverse()
    return bytes(letters)


def _xlsx_cell_value(
    attributes: bytes,
    content: bytes,
    shared_strings: list[str],
) -> object:
    value_match = _XML_CELL_VALUE_RE.search(content)
    type_match = _XML_CELL_TYPE_RE.search(attributes)
    cell_type = type_match.group(1).decode("ascii") if type_match else ""
    if cell_type == "inlineStr":
        return "".join(
            ElementTree.fromstring(b"<root>" + match.group(1) + b"</root>").text or ""
            for match in _XML_INLINE_TEXT_RE.finditer(content)
        )
    if value_match is None:
        return None
    raw_value = value_match.group(1).decode("utf-8")
    if cell_type == "s":
        try:
            return shared_strings[int(raw_value)]
        except (IndexError, ValueError) as exc:
            raise InvalidNewareExcelError(
                "Neware Excel workbook contains an invalid shared-string reference."
            ) from exc
    if cell_type == "b":
        return raw_value == "1"
    return raw_value


def _xlsx_row_values(
    row: bytes,
    shared_strings: list[str],
    *,
    selected_columns: set[int] | None = None,
) -> tuple[object, ...]:
    cells: dict[int, object] = {}
    for match in _XML_CELL_BLOCK_RE.finditer(row):
        attributes, content = match.groups()
        reference = _XML_CELL_REF_RE.search(attributes)
        if reference is None:
            continue
        column = 0
        for character in reference.group(1):
            column = column * 26 + character - ord("A") + 1
        column -= 1
        if selected_columns is not None and column not in selected_columns:
            continue
        cells[column] = _xlsx_cell_value(attributes, content, shared_strings)
    if not cells:
        return ()
    output = [None] * (max(cells) + 1)
    for column, value in cells.items():
        output[column] = value
    return tuple(output)


def _xlsx_shared_string_indices(
    row: bytes,
    *,
    selected_columns: set[int] | None = None,
) -> set[int]:
    indexes: set[int] = set()
    for match in _XML_CELL_BLOCK_RE.finditer(row):
        attributes, content = match.groups()
        reference = _XML_CELL_REF_RE.search(attributes)
        if reference is None:
            continue
        column = 0
        for character in reference.group(1):
            column = column * 26 + character - ord("A") + 1
        column -= 1
        if selected_columns is not None and column not in selected_columns:
            continue
        type_match = _XML_CELL_TYPE_RE.search(attributes)
        value_match = _XML_CELL_VALUE_RE.search(content)
        if type_match is None or type_match.group(1) != b"s" or value_match is None:
            continue
        try:
            indexes.add(int(value_match.group(1)))
        except ValueError as exc:
            raise InvalidNewareExcelError(
                "Neware Excel workbook contains an invalid shared-string reference."
            ) from exc
    return indexes


def _xlsx_max_shared_string_index(
    row: bytes,
    *,
    selected_columns: set[int] | None = None,
) -> int | None:
    indexes = _xlsx_shared_string_indices(row, selected_columns=selected_columns)
    return max(indexes) if indexes else None


def _xlsx_find_column_value(
    row: bytes,
    column_letters: bytes,
    shared_strings: list[str],
) -> object | None:
    reference_prefix = b'r="' + column_letters
    reference_position = row.find(reference_prefix)
    if reference_position < 0:
        return None
    number_start = reference_position + len(reference_prefix)
    number_end = row.find(b'"', number_start)
    if number_end < 0 or not row[number_start:number_end].isdigit():
        return None
    cell_start = row.rfind(b"<c", 0, reference_position)
    open_end = row.find(b">", number_end)
    if cell_start < 0 or open_end < 0:
        return None
    if row[open_end - 1] == ord("/"):
        return None
    close = row.find(b"</c>", open_end + 1)
    if close < 0:
        return None
    return _xlsx_cell_value(row[cell_start + 2 : open_end], row[open_end + 1 : close], shared_strings)


def _xlsx_row_number(row: bytes, fallback: int) -> int:
    match = _XML_ROW_NUMBER_RE.search(row.split(b">", 1)[0])
    if match is None:
        return fallback
    try:
        return int(match.group(1))
    except ValueError:
        return fallback


def _xlsx_local_member_data_offset(path: Path, info: zipfile.ZipInfo) -> int | None:
    """Return the raw DEFLATE payload offset for a conventional ZIP member."""
    if info.compress_type != zipfile.ZIP_DEFLATED or info.flag_bits & 0x41:
        return None
    try:
        with path.open("rb") as source:
            source.seek(info.header_offset)
            header = source.read(30)
            if len(header) != 30 or header[:4] != b"PK\x03\x04":
                return None
            flags, method = struct.unpack_from("<HH", header, 6)
            if flags & 0x41 or method != zipfile.ZIP_DEFLATED:
                return None
            filename_length, extra_length = struct.unpack_from("<HH", header, 26)
            local_filename = source.read(filename_length)
            encoding = "utf-8" if flags & 0x800 else "cp437"
            try:
                expected_filename = info.filename.encode(encoding)
            except UnicodeEncodeError:
                return None
            if local_filename != expected_filename:
                return None
            return info.header_offset + 30 + filename_length + extra_length
    except OSError:
        return None


def _inflate_xlsx_member(path: Path, info: zipfile.ZipInfo) -> bytes | None:
    """Inflate one bounded auxiliary member and verify its directory metadata."""
    if info.file_size > _XLSX_FAST_PREVIEW_MAX_SHARED_STRINGS_BYTES:
        return None
    data_offset = _xlsx_local_member_data_offset(path, info)
    if data_offset is None:
        return None
    try:
        with path.open("rb") as source:
            source.seek(data_offset)
            compressed = source.read(info.compress_size)
        if len(compressed) != info.compress_size:
            return None
        inflated = zlib.decompress(compressed, -15)
    except (OSError, zlib.error, ValueError):
        return None
    if len(inflated) != info.file_size or zlib.crc32(inflated) & 0xFFFFFFFF != info.CRC:
        return None
    return inflated


def _iter_xlsx_member_output_chunks(
    path: Path,
    info: zipfile.ZipInfo,
    *,
    chunk_size: int,
) -> Iterator[bytes] | None:
    """Stream a raw DEFLATE member, checking CRC only when its end is reached."""
    data_offset = _xlsx_local_member_data_offset(path, info)
    if data_offset is None or chunk_size <= 0:
        return None

    def output_chunks() -> Iterator[bytes]:
        decoder = zlib.decompressobj(-15)
        crc = 0
        inflated_size = 0
        compressed_remaining = info.compress_size
        with path.open("rb") as source:
            source.seek(data_offset)
            while compressed_remaining:
                compressed = source.read(min(chunk_size, compressed_remaining))
                if not compressed:
                    raise _XlsxFastPreviewUnsupported("Truncated XLSX member.")
                compressed_remaining -= len(compressed)
                try:
                    output = decoder.decompress(memoryview(compressed))
                except zlib.error as exc:
                    raise _XlsxFastPreviewUnsupported("Invalid XLSX DEFLATE stream.") from exc
                inflated_size += len(output)
                if inflated_size > info.file_size:
                    raise _XlsxFastPreviewUnsupported("XLSX member exceeds its declared size.")
                crc = zlib.crc32(output, crc)
                if output:
                    yield output
            try:
                tail = decoder.flush()
            except zlib.error as exc:
                raise _XlsxFastPreviewUnsupported("Invalid XLSX DEFLATE trailer.") from exc
            inflated_size += len(tail)
            crc = zlib.crc32(tail, crc)
            if tail:
                yield tail
            if (
                not decoder.eof
                or decoder.unused_data
                or inflated_size != info.file_size
                or crc & 0xFFFFFFFF != info.CRC
            ):
                raise _XlsxFastPreviewUnsupported("XLSX member CRC or size mismatch.")

    return output_chunks()


def _shared_string_text(item: bytes) -> str:
    return "".join(
        _html_unescape(piece.decode("utf-8"))
        for piece in _XML_SHARED_TEXT_RE.findall(item)
    )


def _xlsx_shared_strings_from_xml_for_indices(
    source: bytes,
    indexes: set[int],
) -> list[str] | None:
    """Resolve sparse strings by scanning from the closer end of the SST."""
    if not indexes:
        return []
    unique_match = re.search(rb'\buniqueCount="(\d+)"', source[:4096])
    if unique_match is None:
        return None
    unique_count = int(unique_match.group(1))
    if any(index < 0 or index >= unique_count for index in indexes):
        raise InvalidNewareExcelError(
            "Neware Excel workbook contains an invalid shared-string reference."
        )

    # In a shared-string part every start tag begins with <si. A single C-level
    # count avoids six full 46 MB scans; malformed lookalike tags simply fail
    # the declared-count check and use the reference reader.
    item_start_count = source.count(b"<si")
    self_closing_count = source.count(b"<si/>") + source.count(b"<si />")
    closing_count = source.count(b"</si>")
    if item_start_count != unique_count or closing_count + self_closing_count != unique_count:
        return None

    ordered = sorted(indexes)
    split_after = -1
    if len(ordered) == 1:
        only_index = ordered[0]
        if only_index <= unique_count - 1 - only_index:
            split_after = 0
    elif len(ordered) > 1:
        largest_gap = max(
            range(len(ordered) - 1),
            key=lambda position: ordered[position + 1] - ordered[position],
        )
        split_after = largest_gap
    low = set(ordered[: split_after + 1])
    high = set(ordered[split_after + 1 :])
    values = [""] * (max(indexes) + 1)

    if low:
        last_low = max(low)
        found_low: set[int] = set()
        for ordinal, match in enumerate(_XML_SHARED_ITEM_RE.finditer(source)):
            if ordinal > last_low:
                break
            if ordinal in low:
                values[ordinal] = _shared_string_text(match.group(1) or b"")
                found_low.add(ordinal)
        if found_low != low:
            return None

    if high:
        found_high: set[int] = set()
        cursor = len(source)
        ordinal = unique_count
        while cursor > 0 and found_high != high:
            start = source.rfind(b"<si", 0, cursor)
            if start < 0:
                break
            cursor = start
            delimiter_position = start + 3
            if delimiter_position >= len(source) or source[delimiter_position] not in b"> /\t\r\n":
                continue
            ordinal -= 1
            if ordinal not in high:
                continue
            open_end = source.find(b">", delimiter_position)
            if open_end < 0:
                return None
            if source[open_end - 1 : open_end] == b"/":
                item = b""
            else:
                close = source.find(b"</si>", open_end + 1)
                if close < 0:
                    return None
                item = source[open_end + 1 : close]
            values[ordinal] = _shared_string_text(item)
            found_high.add(ordinal)
        if found_high != high:
            return None
    return values


def _xlsx_first_complete_row_span(source: bytes | bytearray) -> tuple[int, int] | None:
    start = source.find(b"<row")
    if start < 0:
        return None
    close = source.find(b"</row>", start)
    if close < 0:
        return None
    return start, close + len(b"</row>")


def _xlsx_last_complete_row_span(source: bytes | bytearray) -> tuple[int, int] | None:
    close = source.rfind(b"</row>")
    if close < 0:
        return None
    start = source.rfind(b"<row", 0, close)
    if start < 0:
        return None
    return start, close + len(b"</row>")


def _xlsx_cycle_cell_pattern(column: bytes) -> re.Pattern[bytes]:
    return re.compile(
        rb'<c r="'
        + re.escape(column)
        + rb'(\d+)"([^>]*?)(?:/>|>(.*?)</c>)',
        re.DOTALL,
    )


def _xlsx_cycle_match_value(
    match: re.Match[bytes],
    shared_strings: list[str],
) -> tuple[int, int] | None:
    type_match = _XML_CELL_TYPE_RE.search(match.group(2))
    if type_match is not None and type_match.group(1) == b"inlineStr":
        raise _XlsxFastPreviewUnsupported("Inline-string cycle cells require the reference reader.")
    try:
        value = _xlsx_cell_value(match.group(2), match.group(3) or b"", shared_strings)
        numeric = float(value)
        if not math.isfinite(numeric) or not numeric.is_integer():
            return None
        return int(match.group(1)), int(numeric)
    except (TypeError, ValueError, OverflowError):
        return None


def _xlsx_rows_end(source: bytes | bytearray) -> int:
    close = source.rfind(b"</row>")
    return close + len(b"</row>") if close >= 0 else 0


def _xlsx_row_value_pairs(
    source: bytes | bytearray,
    *,
    start: int,
    end: int,
    cycle_pattern: re.Pattern[bytes],
    shared_strings: list[str],
) -> Iterator[tuple[int, int, int]]:
    """Yield (row start, worksheet row number, cycle id) for complete rows."""
    for match in cycle_pattern.finditer(source, start, end):
        parsed = _xlsx_cycle_match_value(match, shared_strings)
        if parsed is None:
            continue
        row_number, cycle_id = parsed
        row_start = source.rfind(b"<row", start, match.start())
        if row_start < 0:
            raise _XlsxFastPreviewUnsupported("Cycle cell is outside a worksheet row.")
        yield row_start, row_number, cycle_id


def _xlsx_rows_after(
    source: bytes | bytearray,
    *,
    start: int,
    end: int,
) -> Iterator[tuple[int, int]]:
    """Yield complete worksheet row spans from an unconsumed byte range."""
    cursor = start
    while cursor < end:
        row_start = source.find(b"<row", cursor, end)
        if row_start < 0:
            return
        close = source.find(b"</row>", row_start, end)
        if close < 0:
            return
        row_end = close + len(b"</row>")
        yield row_start, row_end
        cursor = row_end


def _xlsx_cycle_ordinal(
    cycle_id: int,
    cycle_ordinals: dict[int, int],
) -> int | None:
    return cycle_ordinals.get(cycle_id)


def _xlsx_decode_preview_window(
    source: bytes,
    *,
    header_row: bytes,
    header_shared_strings: list[str],
    used_shared_string_indices: set[int],
    required: dict[str, tuple[int, str]],
    cycle_ordinals: dict[int, int],
    requested_start: int,
    requested_end: int,
    cycle_count: int,
    time_origin_s: float | None,
) -> dict[str, object] | None:
    """Decode one retained record window in a single regex pass."""
    selected_columns = {
        required[_normalize_text(name)][0]
        for name in (
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
        )
    }
    cells_by_row: dict[int, dict[int, object]] = {}
    row_numbers: list[int] = []
    previous_row_number: int | None = None
    used_indices = set(used_shared_string_indices)

    for match in _XLSX_FAST_PREVIEW_CELL_RE.finditer(source):
        letters, row_text, attributes, content = match.groups()
        try:
            row_number = int(row_text)
        except ValueError:
            return None
        if previous_row_number is None or row_number != previous_row_number:
            if previous_row_number is not None and row_number <= previous_row_number:
                return None
            previous_row_number = row_number
            row_numbers.append(row_number)
            cells_by_row[row_number] = {}
        column = 0
        for character in letters:
            column = column * 26 + character - ord("A") + 1
        column -= 1
        if column not in selected_columns:
            continue
        type_match = _XML_CELL_TYPE_RE.search(attributes)
        if type_match is not None and type_match.group(1) == b"inlineStr":
            return None
        cell_content = content or b""
        value_match = _XML_CELL_VALUE_RE.search(cell_content)
        cell_value: object | None = None
        if type_match is not None and type_match.group(1) == b"s" and value_match is not None:
            try:
                string_index = int(value_match.group(1))
            except ValueError as exc:
                raise InvalidNewareExcelError(
                    "Neware Excel workbook contains an invalid shared-string reference."
                ) from exc
            used_indices.add(string_index)
            cell_value = (_XLSX_SHARED_STRING_REF, string_index)
        elif value_match is not None:
            raw_value = value_match.group(1).decode("utf-8")
            cell_value = (
                raw_value == "1"
                if type_match is not None and type_match.group(1) == b"b"
                else raw_value
            )
        cells_by_row[row_number][column] = cell_value

    if not cells_by_row:
        return None
    # The caller replaces these placeholders after the parallel shared-string
    # inflater completes. Keeping collection and materialization separate lets
    # the retained record window be scanned only once.
    return {
        "_deferred_shared_string_indices": used_indices,
        "_cells_by_row": cells_by_row,
        "_row_numbers": row_numbers,
        "cycle_count": cycle_count,
        "time_origin_s": time_origin_s,
        "cycle_start": requested_start,
        "cycle_end": requested_end,
    }


def _xlsx_build_preview_rows(
    cells_by_row: dict[int, dict[int, object]],
    row_numbers: list[int],
    shared_strings: list[str],
    *,
    cycle_ordinals: dict[int, int],
    requested_start: int,
    requested_end: int,
    cycle_count: int,
    time_origin_s: float | None,
    required: dict[str, tuple[int, str]],
) -> dict[str, object] | None:
    def value_for(row_cells: dict[int, object], index: int) -> object | None:
        value = row_cells.get(index)
        if (
            isinstance(value, tuple)
            and len(value) == 2
            and value[0] is _XLSX_SHARED_STRING_REF
        ):
            try:
                return shared_strings[int(value[1])]
            except (IndexError, ValueError) as exc:
                raise InvalidNewareExcelError(
                    "Neware Excel workbook contains an invalid shared-string reference."
                ) from exc
        return value

    data_point_index = required[_normalize_text("DataPoint")][0]
    cycle_index = required[_normalize_text("Cycle Index")][0]
    step_index = required[_normalize_text("Step Index")][0]
    status_index = required[_normalize_text("Step Type")][0]
    time_index, time_source = required[_normalize_text("Time(min)")]
    total_time_index, total_time_source = required[_normalize_text("Total Time(min)")]
    current_index = required[_normalize_text("Current(mA)")][0]
    voltage_index = required[_normalize_text("Voltage(V)")][0]
    charge_index = required[_normalize_text("Chg. Cap.(mAh)")][0]
    discharge_index = required[_normalize_text("DChg. Cap.(mAh)")][0]
    rows: list[dict[str, object]] = []
    previous_cycle_ordinal: int | None = None
    normalized_statuses: dict[str, str] = {}
    for row_number in row_numbers:
        row_cells = cells_by_row[row_number]
        values = {
            data_point_index: value_for(row_cells, data_point_index),
            cycle_index: value_for(row_cells, cycle_index),
            step_index: value_for(row_cells, step_index),
            status_index: value_for(row_cells, status_index),
            time_index: value_for(row_cells, time_index),
            total_time_index: value_for(row_cells, total_time_index),
            current_index: value_for(row_cells, current_index),
            voltage_index: value_for(row_cells, voltage_index),
            charge_index: value_for(row_cells, charge_index),
            discharge_index: value_for(row_cells, discharge_index),
        }
        cycle_value = values[cycle_index]
        if cycle_value is None or (isinstance(cycle_value, str) and not cycle_value.strip()):
            continue
        try:
            cycle_number = float(cycle_value)
        except (TypeError, ValueError, OverflowError):
            return None
        if not math.isfinite(cycle_number) or not cycle_number.is_integer():
            return None
        cycle_id = int(cycle_number)
        cycle_ordinal = cycle_ordinals.get(cycle_id)
        if cycle_ordinal is None:
            continue
        if previous_cycle_ordinal is not None and cycle_ordinal < previous_cycle_ordinal:
            return None
        previous_cycle_ordinal = cycle_ordinal
        if cycle_ordinal < requested_start or cycle_ordinal > requested_end:
            return None
        status_value = values[status_index]
        if isinstance(status_value, str) and status_value in normalized_statuses:
            normalized_status = normalized_statuses[status_value]
        else:
            normalized_status = _normalize_status(status_value, row_number=row_number)
            if isinstance(status_value, str):
                normalized_statuses[status_value] = normalized_status
        rows.append(
            {
                "record_index": _integer(
                    values[data_point_index], row_number=row_number, column="DataPoint"
                ),
                "cycle": cycle_ordinal,
                "time_s": _unitless_or_minutes_seconds(
                    values[time_index], source_header=time_source, canonical_header="Time(min)"
                ),
                "total_time_s": _unitless_or_minutes_seconds(
                    values[total_time_index],
                    source_header=total_time_source,
                    canonical_header="Total Time(min)",
                ),
                "current_ma": _number(
                    values[current_index], row_number=row_number, column="Current(mA)"
                ),
                "voltage_v": _number(
                    values[voltage_index], row_number=row_number, column="Voltage(V)"
                ),
                "step_index": _integer(
                    values[step_index], row_number=row_number, column="Step Index"
                ),
                "status": normalized_status,
                "charge_capacity_mah": _number(
                    values[charge_index], row_number=row_number, column="Chg. Cap.(mAh)"
                ),
                "discharge_capacity_mah": _number(
                    values[discharge_index], row_number=row_number, column="DChg. Cap.(mAh)"
                ),
            }
        )
    if not rows:
        return None
    raw = pd.DataFrame(rows).sort_values("record_index", kind="stable").reset_index(drop=True)
    # The import parser validates the full record timeline and can recover a
    # small set of verified future-dated duplicates. A window-local time reset
    # must not be shown by the faster display-only reader before that validation
    # has run; let the picker fall through to the canonical prepared preview.
    _require_monotonic_preview_time(raw)
    return {
        "cycle_count": cycle_count,
        "raw": raw,
        "time_origin_s": time_origin_s,
        "cycle_start": requested_start,
        "cycle_end": requested_end,
    }


def _try_read_voltage_preview_streaming(
    path: Path,
    *,
    cycle_start: int | None,
    cycle_end: int | None,
    chunk_size: int = _XLSX_FAST_PREVIEW_CHUNK_BYTES,
) -> dict[str, object] | None:
    """Prepare a bounded display preview from one raw-DEFLATE record pass.

    Neware writes the record sheet in non-decreasing cycle order. The scan
    samples that order at chunk boundaries until the requested window begins,
    then verifies every cycle row retained in and immediately after the window.
    This deliberately cannot detect an isolated earlier row with a requested
    cycle label that is followed by lower cycle labels before the sampled
    boundary; detecting that would require a full scan of the prefix.
    """
    try:
        stat = path.stat()
        cycles = _read_cycle_summary_fast_cached(str(path), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return None
    if cycles is None or not len(cycles):
        return None
    cycle_ids = [int(value) for value in cycles["cycle"].tolist()]
    cycle_count = len(cycle_ids)
    if cycle_start is None and cycle_end is None:
        requested_start = max(1, cycle_count - 19)
        requested_end = cycle_count
    else:
        requested_start = max(1, int(cycle_start or 1))
        requested_end = min(
            cycle_count,
            max(requested_start, int(cycle_end or requested_start)),
        )
    if requested_start > requested_end:
        return {
            "cycle_count": cycle_count,
            "cycles": cycles,
            "raw": pd.DataFrame(),
            "time_origin_s": None,
            "cycle_start": requested_start,
            "cycle_end": requested_end,
        }

    cycle_ordinals = {cycle_id: ordinal for ordinal, cycle_id in enumerate(cycle_ids, start=1)}
    selected_cycle_ids = cycle_ids[requested_start - 1 : requested_end]
    if not selected_cycle_ids:
        return None

    try:
        with zipfile.ZipFile(path) as archive:
            sheet_paths = _xlsx_sheet_paths(archive)
            record_path = sheet_paths.get(_normalize_text("record"))
            if record_path is None:
                return None
            try:
                record_info = archive.getinfo(record_path)
            except KeyError:
                return None
            try:
                shared_info = archive.getinfo("xl/sharedStrings.xml")
            except KeyError:
                shared_info = None

            inflated = _iter_xlsx_member_output_chunks(
                path, record_info, chunk_size=chunk_size
            )
            if inflated is None:
                return None
            prefix = bytearray()
            header_span: tuple[int, int] | None = None
            try:
                while header_span is None:
                    chunk = next(inflated)
                    prefix.extend(chunk)
                    header_span = _xlsx_first_complete_row_span(prefix)
            except StopIteration:
                return None
            except _XlsxFastPreviewUnsupported:
                return None

            header_start, header_end = header_span
            header_xml_row = bytes(prefix[header_start:header_end])
            header_indices = _xlsx_shared_string_indices(header_xml_row)
            header_shared_strings = _xlsx_shared_strings(
                archive,
                max_index=max(header_indices) if header_indices else None,
            )
            if header_indices and shared_info is None:
                return None
            header_values = _xlsx_row_values(header_xml_row, header_shared_strings)
            headers = _fast_header_map(iter(header_values))
            required = _require_columns(
                headers,
                (
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
                ),
                sheet_name="record",
            )
            cycle_index, _cycle_source = required[_normalize_text("Cycle Index")]
            cycle_column = _xlsx_column_letters(cycle_index)
            time_index, time_source = required[_normalize_text("Time(min)")]
            total_time_index, total_time_source = required[_normalize_text("Total Time(min)")]
            cycle_pattern = _xlsx_cycle_cell_pattern(cycle_column)

            scan_buffer = bytearray(prefix[header_end:])
            time_buffer = bytearray(scan_buffer)
            time_cursor = 0
            time_origin_s: float | None = None
            time_origin_row_number = 2
            used_shared_string_indices = set(header_indices)
            window_buffer: bytearray | None = None
            window_scan_offset = 0
            window_previous_ordinal: int | None = None
            previous_probe_ordinal: int | None = None
            early_stop = False

            shared_future = None
            with ThreadPoolExecutor(max_workers=1) as executor:
                if shared_info is not None:
                    shared_future = executor.submit(
                        _inflate_xlsx_member, path, shared_info
                    )

                def update_time_origin() -> None:
                    nonlocal time_cursor, time_origin_s, time_buffer
                    nonlocal time_origin_row_number
                    if time_origin_s is not None:
                        return
                    complete_end = _xlsx_rows_end(time_buffer)
                    consumed = time_cursor
                    for row_start, row_end in _xlsx_rows_after(
                        time_buffer, start=time_cursor, end=complete_end
                    ):
                        xml_row = bytes(time_buffer[row_start:row_end])
                        cycle_value = _xlsx_find_column_value(
                            xml_row, cycle_column, header_shared_strings
                        )
                        if cycle_value is None or (
                            isinstance(cycle_value, str) and not cycle_value.strip()
                        ):
                            consumed = row_end
                            continue
                        total_time_value = _xlsx_find_column_value(
                            xml_row, _xlsx_column_letters(total_time_index), header_shared_strings
                        )
                        if total_time_value is None or (
                            isinstance(total_time_value, str) and not total_time_value.strip()
                        ):
                            consumed = row_end
                            continue
                        time_origin_row_number = _xlsx_row_number(
                            xml_row, time_origin_row_number
                        )
                        try:
                            time_origin_s = _unitless_or_minutes_seconds(
                                total_time_value,
                                source_header=total_time_source,
                                canonical_header="Total Time(min)",
                            )
                        except (TypeError, ValueError, OverflowError) as exc:
                            raise _invalid_record(time_origin_row_number, total_time_source) from exc
                        consumed = row_end
                        break
                    if time_origin_s is None and consumed:
                        del time_buffer[:consumed]
                        time_cursor = 0
                    elif time_origin_s is not None:
                        time_buffer.clear()

                def process_before_window() -> bool:
                    nonlocal previous_probe_ordinal, window_buffer
                    nonlocal window_scan_offset, window_previous_ordinal
                    complete_end = _xlsx_rows_end(scan_buffer)
                    last_span = _xlsx_last_complete_row_span(scan_buffer)
                    if complete_end <= 0 or last_span is None:
                        return False
                    row_start, row_end = last_span
                    last_row = bytes(scan_buffer[row_start:row_end])
                    cycle_value = _xlsx_find_column_value(
                        last_row, cycle_column, header_shared_strings
                    )
                    if cycle_value is None or (
                        isinstance(cycle_value, str) and not cycle_value.strip()
                    ):
                        raise _XlsxFastPreviewUnsupported("Missing chunk-boundary cycle value.")
                    try:
                        numeric_cycle = float(cycle_value)
                    except (TypeError, ValueError, OverflowError) as exc:
                        raise _XlsxFastPreviewUnsupported("Invalid chunk-boundary cycle.") from exc
                    if not math.isfinite(numeric_cycle) or not numeric_cycle.is_integer():
                        raise _XlsxFastPreviewUnsupported("Invalid chunk-boundary cycle.")
                    boundary_ordinal = cycle_ordinals.get(int(numeric_cycle))
                    if boundary_ordinal is None:
                        raise _XlsxFastPreviewUnsupported("Unknown chunk-boundary cycle.")
                    if (
                        previous_probe_ordinal is not None
                        and boundary_ordinal < previous_probe_ordinal
                    ):
                        raise _XlsxFastPreviewUnsupported("Record cycles are not ordered.")

                    if boundary_ordinal < requested_start:
                        previous_probe_ordinal = boundary_ordinal
                        del scan_buffer[:complete_end]
                        return False

                    first_selected_start: int | None = None
                    stop_before: int | None = None
                    previous = previous_probe_ordinal
                    last_window_ordinal: int | None = None
                    for row_start, _row_number, cycle_id in _xlsx_row_value_pairs(
                        scan_buffer,
                        start=0,
                        end=complete_end,
                        cycle_pattern=cycle_pattern,
                        shared_strings=header_shared_strings,
                    ):
                        ordinal = cycle_ordinals.get(cycle_id)
                        if ordinal is None:
                            continue
                        if previous is not None and ordinal < previous:
                            raise _XlsxFastPreviewUnsupported("Record cycles are not ordered.")
                        previous = ordinal
                        if first_selected_start is None:
                            if ordinal > requested_end:
                                raise _XlsxFastPreviewUnsupported(
                                    "Requested cycle window was not found in order."
                                )
                            if ordinal < requested_start:
                                continue
                            first_selected_start = row_start
                        if ordinal > requested_end:
                            stop_before = row_start
                            break
                        last_window_ordinal = ordinal

                    if first_selected_start is None:
                        if boundary_ordinal > requested_end:
                            raise _XlsxFastPreviewUnsupported(
                                "Requested cycle window was not found."
                            )
                        previous_probe_ordinal = boundary_ordinal
                        del scan_buffer[:complete_end]
                        return False

                    selected_end = stop_before if stop_before is not None else len(scan_buffer)
                    window_buffer = bytearray(scan_buffer[first_selected_start:selected_end])
                    window_scan_offset = complete_end - first_selected_start
                    window_previous_ordinal = last_window_ordinal
                    previous_probe_ordinal = last_window_ordinal
                    if stop_before is not None:
                        del window_buffer[stop_before - first_selected_start :]
                        return True
                    return False

                def process_window_chunk() -> bool:
                    nonlocal window_scan_offset, window_previous_ordinal, window_buffer
                    if window_buffer is None:
                        raise _XlsxFastPreviewUnsupported("Preview window was not initialized.")
                    complete_end = _xlsx_rows_end(window_buffer)
                    if complete_end <= window_scan_offset:
                        return False
                    new_complete_rows = bytes(
                        window_buffer[window_scan_offset:complete_end]
                    )
                    for row_start, _row_number, cycle_id in _xlsx_row_value_pairs(
                        new_complete_rows,
                        start=0,
                        end=len(new_complete_rows),
                        cycle_pattern=cycle_pattern,
                        shared_strings=header_shared_strings,
                    ):
                        ordinal = cycle_ordinals.get(cycle_id)
                        if ordinal is None:
                            raise _XlsxFastPreviewUnsupported("Unknown cycle in preview window.")
                        if (
                            window_previous_ordinal is not None
                            and ordinal < window_previous_ordinal
                        ):
                            raise _XlsxFastPreviewUnsupported("Record cycles are not ordered.")
                        if ordinal < requested_start:
                            raise _XlsxFastPreviewUnsupported(
                                "Record cycle precedes the requested window."
                            )
                        if ordinal > requested_end:
                            del window_buffer[window_scan_offset + row_start :]
                            return True
                        window_previous_ordinal = ordinal
                    window_scan_offset = complete_end
                    return False

                update_time_origin()
                try:
                    if process_before_window():
                        early_stop = True
                    if not early_stop:
                        for chunk in inflated:
                            if not chunk:
                                continue
                            if time_origin_s is None:
                                time_buffer.extend(chunk)
                                update_time_origin()
                            if window_buffer is None:
                                scan_buffer.extend(chunk)
                                early_stop = process_before_window()
                            else:
                                window_buffer.extend(chunk)
                                early_stop = process_window_chunk()
                            if early_stop:
                                break
                except _XlsxFastPreviewUnsupported:
                    return None
                finally:
                    inflated.close()

                if window_buffer is None or not window_buffer:
                    return None
                if shared_future is not None:
                    shared_xml = shared_future.result()
                    if shared_xml is None:
                        return None
                else:
                    shared_xml = b""

                complete_end = _xlsx_rows_end(window_buffer)
                if complete_end <= 0:
                    return None
                retained = bytes(window_buffer[:complete_end])
                deferred = _xlsx_decode_preview_window(
                    retained,
                    header_row=header_xml_row,
                    header_shared_strings=header_shared_strings,
                    used_shared_string_indices=used_shared_string_indices,
                    required=required,
                    cycle_ordinals=cycle_ordinals,
                    requested_start=requested_start,
                    requested_end=requested_end,
                    cycle_count=cycle_count,
                    time_origin_s=time_origin_s,
                )
                if deferred is None:
                    return None
                needed_indices = set(deferred.pop("_deferred_shared_string_indices"))
                cells_by_row = deferred.pop("_cells_by_row")
                row_numbers = deferred.pop("_row_numbers")
                if needed_indices:
                    shared_strings = _xlsx_shared_strings_from_xml_for_indices(
                        shared_xml, needed_indices
                    )
                    if shared_strings is None:
                        return None
                else:
                    shared_strings = []
                result = _xlsx_build_preview_rows(
                    cells_by_row,
                    row_numbers,
                    shared_strings,
                    cycle_ordinals=cycle_ordinals,
                    requested_start=requested_start,
                    requested_end=requested_end,
                    cycle_count=cycle_count,
                    time_origin_s=time_origin_s,
                    required=required,
                )
                if result is None:
                    return None
                result["cycles"] = cycles
                return result
    except InvalidNewareExcelError:
        raise
    except (
        OSError,
        ValueError,
        KeyError,
        zipfile.BadZipFile,
        zlib.error,
        _XlsxFastPreviewUnsupported,
    ):
        return None
    return None


def _fast_load_sheet(
    reader: Any,
    name: str,
    *,
    required: bool,
    header_row: int | None,
) -> _FastFrameSheetAdapter | None:
    wanted = _normalize_text(name)
    names = [str(sheet_name) for sheet_name in reader.sheet_names]
    matches = [sheet_name for sheet_name in names if _normalize_text(sheet_name) == wanted]
    if len(matches) > 1:
        raise InvalidNewareExcelError(
            f"Neware Excel workbook has ambiguous worksheet name: {name}."
        )
    if not matches:
        if required:
            raise UnsupportedNewareExcelError(
                f"Not a recognized Neware Excel export: required {name} sheet is missing."
            )
        return None

    try:
        sheet = reader.load_sheet(
            matches[0],
            header_row=header_row,
            schema_sample_rows=1000,
            dtype_coercion="strict",
        )
        frame = sheet.to_pandas()
    except _FAST_EXCEL_ERRORS as exc:
        raise _FastExcelFallback(f"fastexcel could not represent the {name} sheet") from exc
    return _FastFrameSheetAdapter(name, frame, header_row=header_row is not None)


def _calamine_load_sheet(
    workbook: pd.ExcelFile,
    name: str,
    *,
    required: bool,
    header_row: int | None,
) -> _FastFrameSheetAdapter | None:
    """Load one sheet through pandas' native calamine adapter."""

    wanted = _normalize_text(name)
    names = [str(sheet_name) for sheet_name in workbook.sheet_names]
    matches = [sheet_name for sheet_name in names if _normalize_text(sheet_name) == wanted]
    if len(matches) > 1:
        raise InvalidNewareExcelError(
            f"Neware Excel workbook has ambiguous worksheet name: {name}."
        )
    if not matches:
        if required:
            raise UnsupportedNewareExcelError(
                f"Not a recognized Neware Excel export: required {name} sheet is missing."
            )
        return None

    try:
        frame = workbook.parse(
            matches[0],
            header=header_row,
            dtype=object,
            keep_default_na=False,
        )
    except _CALAMINE_ERRORS as exc:
        raise _CalamineFallback(
            f"pandas calamine could not represent the {name} sheet"
        ) from exc
    return _FastFrameSheetAdapter(name, frame, header_row=header_row is not None)


def _fast_declared_record_interval_seconds(reader: Any) -> float | None:
    test_sheet = _fast_load_sheet(
        reader,
        "test",
        required=False,
        header_row=None,
    )
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


def _parse_columnar_records(
    source: pd.DataFrame,
) -> tuple[pd.DataFrame, dict[str, tuple[int, str]], bool]:
    headers = _fast_header_map(iter(source.columns))
    required = _require_columns(headers, REQUIRED_RECORD_HEADERS, sheet_name="record")
    optional_columns = _optional_columns(
        headers,
        tuple(OPTIONAL_RECORD_HEADERS),
        sheet_name="record",
    )
    nonempty = _fast_nonempty_rows(source)
    if not bool(nonempty.any()):
        raise InvalidNewareExcelError("Neware Excel record sheet contains no data rows.")
    row_numbers = source.index[nonempty].to_numpy(dtype="int64") + 2
    source = source.loc[nonempty].reset_index(drop=True)

    record_index = _fast_integer_series(
        _fast_column(source, required[_normalize_text("DataPoint")]),
        row_numbers=row_numbers,
        column="DataPoint",
    )
    cycle = _fast_integer_series(
        _fast_column(source, required[_normalize_text("Cycle Index")]),
        row_numbers=row_numbers,
        column="Cycle Index",
    )
    step_index = _fast_integer_series(
        _fast_column(source, required[_normalize_text("Step Index")]),
        row_numbers=row_numbers,
        column="Step Index",
    )
    time_binding = required[_normalize_text("Time(min)")]
    total_time_binding = required[_normalize_text("Total Time(min)")]
    time_s = _fast_duration_series(
        _fast_column(source, time_binding),
        row_numbers=row_numbers,
        source_header=time_binding[1],
        canonical_header="Time(min)",
    )
    total_time_s = _fast_duration_series(
        _fast_column(source, total_time_binding),
        row_numbers=row_numbers,
        source_header=total_time_binding[1],
        canonical_header="Total Time(min)",
    )
    data: dict[str, Any] = {
        "record_index": record_index,
        "cycle": cycle,
        "step_index": step_index,
        "status": _fast_status_series(
            _fast_column(source, required[_normalize_text("Step Type")]),
            row_numbers=row_numbers,
        ),
        "time_s": time_s,
        "total_time_s": total_time_s,
        "current_ma": _fast_number_series(
            _fast_column(source, required[_normalize_text("Current(mA)")]),
            row_numbers=row_numbers,
            column="Current(mA)",
        ),
        "voltage_v": _fast_number_series(
            _fast_column(source, required[_normalize_text("Voltage(V)")]),
            row_numbers=row_numbers,
            column="Voltage(V)",
        ),
        "charge_capacity_mah": _fast_number_series(
            _fast_column(source, required[_normalize_text("Chg. Cap.(mAh)")]),
            row_numbers=row_numbers,
            column="Chg. Cap.(mAh)",
        ),
        "discharge_capacity_mah": _fast_number_series(
            _fast_column(source, required[_normalize_text("DChg. Cap.(mAh)")]),
            row_numbers=row_numbers,
            column="DChg. Cap.(mAh)",
        ),
        "timestamp": _fast_timestamp_series(
            _fast_column(source, required[_normalize_text("Date")]),
            row_numbers=row_numbers,
            column="Date",
        ),
    }
    power_binding = required[_normalize_text("Power(W)")]
    data["power_w"] = _fast_number_series(
        _fast_column(source, power_binding),
        row_numbers=row_numbers,
        column=power_binding[1],
    ) * _power_to_watts_factor(power_binding[1])
    for canonical, target in OPTIONAL_RECORD_HEADERS.items():
        binding = optional_columns.get(_normalize_text(canonical))
        if binding is None:
            continue
        data[target] = _fast_number_series(
            _fast_column(source, binding),
            row_numbers=row_numbers,
            column=binding[1],
            optional=True,
        )

    order = np.argsort(record_index, kind="stable")
    ordered_index = record_index[order]
    duplicate = np.zeros(len(ordered_index), dtype=bool)
    if len(ordered_index) > 1:
        duplicate[1:] = ordered_index[1:] == ordered_index[:-1]
    _fast_raise_first_bad(
        pd.Series(duplicate),
        row_numbers[order],
        "DataPoint",
    )
    for key, values in tuple(data.items()):
        if isinstance(values, pd.Series):
            data[key] = values.iloc[order].reset_index(drop=True)
        else:
            data[key] = np.asarray(values)[order]

    frame = _frame_from_data(data)
    record_clock_dialect = (
        _is_clock_duration_source(time_binding[1], "Time(min)")
        and _is_clock_duration_source(total_time_binding[1], "Total Time(min)")
    )
    return frame, headers, record_clock_dialect


def _parse_fast_records(
    path: Path,
) -> tuple[pd.DataFrame, dict[str, tuple[int, str]], bool, Any]:
    if _fastexcel is None:
        raise _FastExcelFallback("fastexcel is not installed")

    try:
        reader = _fastexcel.read_excel(path)
        record_sheet = _fast_load_sheet(
            reader,
            "record",
            required=True,
            header_row=0,
        )
        if record_sheet is None:  # pragma: no cover - required=True raises above
            raise _FastExcelFallback("fastexcel did not return the record sheet")
    except _FAST_EXCEL_ERRORS as exc:
        raise _FastExcelFallback("fastexcel could not represent the record sheet") from exc

    frame, headers, record_clock_dialect = _parse_columnar_records(record_sheet.frame)
    return frame, headers, record_clock_dialect, reader


def _parse_fast_timeseries(
    path: Path,
) -> tuple[pd.DataFrame, dict[str, tuple[int, str]], bool, bool] | None:
    try:
        frame, record_headers, record_clock_dialect, reader = _parse_fast_records(path)
        step_sheet = _fast_load_sheet(
            reader,
            "step",
            required=False,
            header_row=0,
        )
        step_duration_validated = False
        if step_sheet is not None:
            step_duration_validated = _validate_step_summary(
                frame,
                step_sheet,
                record_interval_s=_fast_declared_record_interval_seconds(reader),
                record_clock_dialect=record_clock_dialect,
            )
        return frame, record_headers, record_clock_dialect, step_duration_validated
    except _FastExcelFallback:
        return None


def _parse_calamine_timeseries(
    path: Path,
) -> tuple[pd.DataFrame, dict[str, tuple[int, str]], bool, bool] | None:
    """Parse through pandas' calamine engine before using openpyxl."""

    if _python_calamine is None:
        return None

    workbook: pd.ExcelFile | None = None
    try:
        try:
            workbook = pd.ExcelFile(path, engine="calamine")
        except _CALAMINE_ERRORS:
            return None

        record_sheet = _calamine_load_sheet(
            workbook,
            "record",
            required=True,
            header_row=0,
        )
        if record_sheet is None:  # pragma: no cover - required=True raises above
            raise _CalamineFallback("pandas calamine did not return the record sheet")
        frame, record_headers, record_clock_dialect = _parse_columnar_records(
            record_sheet.frame
        )
        step_sheet = _calamine_load_sheet(
            workbook,
            "step",
            required=False,
            header_row=0,
        )
        step_duration_validated = False
        if step_sheet is not None:
            test_sheet = _calamine_load_sheet(
                workbook,
                "test",
                required=False,
                header_row=None,
            )
            record_interval_s: float | None = None
            if test_sheet is not None:
                try:
                    info, _header_row, _headers = _parse_test_information(_rows(test_sheet))
                except NewareExcelError:
                    info = {}
                settings = info.get("record_settings")
                if isinstance(settings, dict) and settings.get("interval_s") is not None:
                    record_interval_s = float(settings["interval_s"])
            step_duration_validated = _validate_step_summary(
                frame,
                step_sheet,
                record_interval_s=record_interval_s,
                record_clock_dialect=record_clock_dialect,
            )
        return frame, record_headers, record_clock_dialect, step_duration_validated
    except (_CalamineFallback, _FastExcelFallback):
        return None
    finally:
        if workbook is not None:
            workbook.close()


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

    return _frame_from_data(data)


def _confirmed_future_duplicate_rows(frame: pd.DataFrame) -> list[tuple[int, int]] | None:
    """Find a small set of isolated future-time records duplicated later.

    Neware exports can contain isolated rows inserted early in the record
    sheet even though their absolute date/time and measurement values belong
    much later in the same file. Recover only when each such row is an obvious
    >24-hour timestamp spike, its neighbors remain ordered, and the complete
    measured record occurs again later. Real resets or unmatched disorders
    keep failing closed.
    """
    total_time = frame["total_time_s"].to_numpy(dtype="float64")
    decreases = np.flatnonzero(np.diff(total_time) < -1e-9) + 1
    if len(decreases) == 0:
        return []
    if len(decreases) > 32:
        return None

    timestamps = frame["timestamp"].to_numpy(dtype="datetime64[ns]")
    measurement_columns = tuple(
        column
        for column in (
            "voltage_v",
            "current_ma",
            "charge_capacity_mah",
            "discharge_capacity_mah",
            "power_w",
            "capacity_mah",
            "specific_capacity_mah_g",
            "charge_specific_capacity_mah_g",
            "discharge_specific_capacity_mah_g",
        )
        if column in frame.columns
    )
    if not measurement_columns:
        return None

    minimum_future_gap_s = 24.0 * 60.0 * 60.0
    recovery_pairs: list[tuple[int, int]] = []
    outlier_indices: set[int] = set()
    for decrease in decreases:
        candidate = int(decrease) - 1
        previous = candidate - 1
        following = candidate + 1
        if previous < 0 or following >= len(frame) or candidate in outlier_indices:
            return None
        if candidate - 1 in outlier_indices or candidate + 1 in outlier_indices:
            return None

        before_s = total_time[previous]
        outlier_s = total_time[candidate]
        after_s = total_time[following]
        if (
            outlier_s <= before_s + 1e-9
            or outlier_s <= after_s + 1e-9
            or after_s < before_s - 1e-9
            or outlier_s - after_s < minimum_future_gap_s
        ):
            return None

        before_time = timestamps[previous]
        outlier_time = timestamps[candidate]
        after_time = timestamps[following]
        if (
            np.isnat(before_time)
            or np.isnat(outlier_time)
            or np.isnat(after_time)
            or before_time > after_time
            or outlier_time <= after_time
            or outlier_time - after_time < np.timedelta64(24, "h")
        ):
            return None

        later = np.arange(following + 1, len(frame), dtype="int64")
        matches = (timestamps[later] == outlier_time) & (
            total_time[later] == outlier_s
        )
        # Identity is based on absolute elapsed time and physical measurements.
        # A verified Neware corruption repeats the measurement while carrying
        # stale cycle, step, status, and step-relative-time fields, so those
        # metadata columns cannot safely be required to match.
        for column in measurement_columns:
            values = frame[column].to_numpy(dtype="float64")
            candidate_value = values[candidate]
            later_values = values[later]
            equal_values = later_values == candidate_value
            if np.isnan(candidate_value):
                equal_values |= np.isnan(later_values)
            matches &= equal_values
        duplicate_indices = later[matches]
        if len(duplicate_indices) == 0:
            return None

        recovery_pairs.append((candidate, int(duplicate_indices[0])))
        outlier_indices.add(candidate)

    keep = np.ones(len(frame), dtype=bool)
    keep[list(outlier_indices)] = False
    if np.any(np.diff(total_time[keep]) < -1e-9):
        return None
    return recovery_pairs


def _frame_from_data(data: dict[str, Any]) -> pd.DataFrame:
    """Build the canonical frame and derived fields from ordered columns."""

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
        recovery_pairs = _confirmed_future_duplicate_rows(frame)
        if recovery_pairs is None:
            raise InvalidNewareExcelError(
                "Neware Excel record Total Time(min) decreases in source order."
            )
        if recovery_pairs:
            skipped_indices = [candidate for candidate, _duplicate in recovery_pairs]
            skipped_points = [int(frame["record_index"].iloc[index]) for index in skipped_indices]
            duplicate_points = [
                int(frame["record_index"].iloc[duplicate])
                for _candidate, duplicate in recovery_pairs
            ]
            keep = np.ones(len(frame), dtype=bool)
            keep[skipped_indices] = False
            frame = frame.iloc[keep].reset_index(drop=True)
            frame.attrs["neware_excel"] = {
                "parser_warnings": [
                    {
                        "code": "future_duplicate_records_skipped",
                        "scope": "source",
                        "count": len(recovery_pairs),
                        "message": (
                            "CellXplorer skipped isolated future-dated records that were "
                            "also present later in the workbook. The later recorded "
                            "measurements were kept; no values were synthesized."
                        ),
                        "examples": [
                            {
                                "data_point": point,
                                "duplicate_data_point": duplicate,
                            }
                            for point, duplicate in zip(skipped_points, duplicate_points)
                        ][:3],
                    }
                ]
            }
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
    step_time_source = required[_normalize_text("Step Time(min)")][1]
    energy_source = required[_normalize_text("Energy(Wh)")][1]
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

        def summary_elapsed(source: str, source_header: str) -> float:
            value = value_for(source)
            try:
                return _unitless_or_minutes_seconds(
                    value,
                    source_header=source_header,
                    canonical_header=source,
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise InvalidNewareExcelError(
                    f"Neware Excel step summary row {row_number} has an invalid {source_header} value."
                ) from exc

        energy_rounding_tolerance = 0.01

        def summary_energy(source: str, source_header: str) -> float:
            nonlocal energy_rounding_tolerance
            source_number = summary_number(source)
            factor = _energy_to_mwh_factor(source_header)
            energy_rounding_tolerance = _display_rounding_tolerance(
                source_number,
                scale=factor,
                minimum=0.01,
            )
            return source_number * factor

        rows.append(
            {
                "cycle": summary_integer("Cycle Index"),
                "step_index": summary_integer("Step Index"),
                "step_number": summary_integer("Step Number"),
                "status": _normalize_status(
                    value_for("Step Type"), row_number=row_number, column="Step Type"
                ),
                "step_time_s": summary_elapsed("Step Time(min)", step_time_source),
                "onset": summary_timestamp("Oneset Date"),
                "end": summary_timestamp("End Date"),
                "capacity_mah": summary_number("Capacity(mAh)"),
                "energy_mwh": summary_energy("Energy(Wh)", energy_source),
                "energy_rounding_tolerance_mwh": energy_rounding_tolerance,
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


def _record_summary_mismatches(
    frame: pd.DataFrame,
    *,
    scope: str,
    code: str,
    summary_label: str,
    measurement_label: str,
    mismatches: list[dict[str, object]],
) -> None:
    if not mismatches:
        return
    state = frame.attrs.setdefault("neware_excel", {})
    warnings = state.setdefault("parser_warnings", [])
    if not isinstance(warnings, list):
        warnings = []
        state["parser_warnings"] = warnings
    summary_name = "step" if scope == "step" else "cycle"
    unit_name = "step-summary value" if scope == "step" else "cycle-summary value"
    count = len(mismatches)
    examples = [
        {
            key: value.item() if isinstance(value, np.generic) else value
            for key, value in mismatch.items()
        }
        for mismatch in mismatches[:3]
    ]
    warnings.append(
        {
            "code": code,
            "scope": scope,
            "count": count,
            "message": (
                f"Neware's {summary_name} {summary_label} summary differs from "
                f"{measurement_label} in {count} {unit_name}"
                f"{'s' if count != 1 else ''}. CellXplorer will import the recorded "
                "measurements and use its own calculations; summary-derived values may differ."
            ),
            "examples": examples,
        }
    )


def _validate_step_summary(
    frame: pd.DataFrame,
    sheet: Any,
    *,
    record_interval_s: float | None,
    record_clock_dialect: bool,
) -> bool:
    summary = _parse_step_summary(sheet)
    step_time_source = _require_columns(
        _header_map(sheet),
        STEP_HEADERS,
        sheet_name="step",
    )[_normalize_text("Step Time(min)")][1]
    duration_is_clock = _is_clock_duration_source(
        step_time_source,
        "Step Time(min)",
    )
    relaxed_clock_dialect = duration_is_clock and record_clock_dialect
    segments = _segment_groups(frame)
    if len(summary) != len(segments):
        raise InvalidNewareExcelError(
            "Neware Excel execution-step mapping failed: "
            f"{len(segments)} raw segments but {len(summary)} step-summary rows."
        )

    energy_mismatches: list[dict[str, object]] = []
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
        if duration_is_clock:
            elapsed_values = segment["time_s"].to_numpy(dtype="float64")
            # The unitless clock dialect is an execution-relative duration.
            # Its timestamp span can include a paused/restored gap, so compare
            # the summary with the record's step-relative elapsed-time column.
            duration_s = float(np.max(elapsed_values) - np.min(elapsed_values))
        else:
            # Preserve the original numeric-dialect contract: Step Time(min)
            # is reconciled independently with the exported timestamps.
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
        if relaxed_clock_dialect:
            capacity_tolerance = max(
                capacity_tolerance,
                _display_rounding_tolerance(expected_capacity, scale=1.0, minimum=0.0) * 2.5,
            )
        if abs(_segment_capacity(segment) - expected_capacity) > capacity_tolerance:
            raise InvalidNewareExcelError(
                f"Neware Excel step summary capacity does not match raw step {expected_step}."
            )

        expected_energy = float(summary_row["energy_mwh"])
        energy_tolerance = max(0.01, abs(expected_energy) * 0.001)
        if relaxed_clock_dialect:
            energy_tolerance = max(
                energy_tolerance,
                float(summary_row.get("energy_rounding_tolerance_mwh", 0.01)) * 2.5,
                abs(expected_energy) * 0.005,
            )
        integrated_energy = _integrate_step_energy(segment)
        if abs(integrated_energy - expected_energy) > energy_tolerance:
            energy_mismatches.append(
                {
                    "step": expected_step,
                    "summary_mwh": expected_energy,
                    "measurement_integration_mwh": integrated_energy,
                }
            )
    _record_summary_mismatches(
        frame,
        scope="step",
        code="summary_reconciliation_mismatch",
        summary_label="energy",
        measurement_label="energy integrated from the exported measurement points",
        mismatches=energy_mismatches,
    )
    return True


def validate_supported_workbook(path: str | Path) -> None:
    """Validate Neware structural eligibility without loading workbook metadata.

    The import browser needs only the record sheet's header. Opening the full
    metadata reader here needlessly reads the workbook's other sheets and may
    expand a very large shared-string table.
    """
    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        raise UnsupportedNewareExcelError(
            "Not a recognized Neware Excel export: only .xlsx is supported."
        )
    try:
        with zipfile.ZipFile(candidate) as archive:
            sheet_paths = _xlsx_sheet_paths(archive)
            record_path = sheet_paths.get(_normalize_text("record"))
            if record_path is None:
                raise UnsupportedNewareExcelError(
                    "Not a recognized Neware Excel export: required record sheet is missing."
                )
            with archive.open(record_path) as record_xml:
                try:
                    header_xml_row = next(_iter_xlsx_xml_rows(record_xml))
                except StopIteration as exc:
                    raise UnsupportedNewareExcelError(
                        "Not a recognized Neware Excel export: record sheet is empty."
                    ) from exc
            shared_strings = _xlsx_shared_strings(
                archive,
                max_index=_xlsx_max_shared_string_index(header_xml_row),
            )
            headers = _fast_header_map(
                iter(_xlsx_row_values(header_xml_row, shared_strings))
            )
            _require_columns(headers, REQUIRED_RECORD_HEADERS, sheet_name="record")
    except NewareExcelError:
        raise
    except Exception as exc:
        raise InvalidNewareExcelError(
            "Could not read the Neware Excel record header."
        ) from exc


def is_supported_workbook(path: str | Path) -> bool:
    """Return whether ``path`` matches the supported Neware record contract."""
    try:
        validate_supported_workbook(path)
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
        fast_result = _parse_fast_timeseries(candidate)

        if fast_result is not None:
            frame, record_headers, record_clock_dialect, step_duration_validated = fast_result
            step_sheet = True if step_duration_validated else None
        else:
            calamine_result = _parse_calamine_timeseries(candidate)
            if calamine_result is not None:
                frame, record_headers, record_clock_dialect, step_duration_validated = (
                    calamine_result
                )
                step_sheet = True if step_duration_validated else None
            else:
                with _open(candidate) as workbook:
                    record_sheet = _sheet_by_name(workbook, "record", required=True)
                    record_headers = _header_map(record_sheet)
                    records = _parse_records(record_sheet, record_headers)
                    frame = _frame_from_records(records)
                    record_time_source = _require_columns(
                        record_headers,
                        REQUIRED_RECORD_HEADERS,
                        sheet_name="record",
                    )[_normalize_text("Time(min)")][1]
                    record_total_time_source = _require_columns(
                        record_headers,
                        REQUIRED_RECORD_HEADERS,
                        sheet_name="record",
                    )[_normalize_text("Total Time(min)")][1]
                    record_clock_dialect = (
                        _is_clock_duration_source(record_time_source, "Time(min)")
                        and _is_clock_duration_source(record_total_time_source, "Total Time(min)")
                    )
                    step_sheet = _sheet_by_name(workbook, "step", required=False)
                    step_duration_validated = False
                    if step_sheet is not None:
                        step_duration_validated = _validate_step_summary(
                            frame,
                            step_sheet,
                            record_interval_s=_declared_record_interval_seconds(workbook),
                            record_clock_dialect=record_clock_dialect,
                        )
    except NewareExcelError:
        raise
    except Exception as exc:
        raise InvalidNewareExcelError(
            "Could not parse the Neware Excel workbook."
        ) from exc

    state = frame.attrs.get("neware_excel")
    if not isinstance(state, dict):
        state = {}
    parser_warnings = list(state.get("parser_warnings") or [])
    step_energy_warning = any(
        isinstance(item, dict) and item.get("scope") == "step"
        for item in parser_warnings
    )
    frame.attrs["neware_excel"] = {
        **state,
        "record_sheet": "record",
        "step_summary_available": step_sheet is not None,
        "step_summary_validated": step_sheet is not None and not step_energy_warning,
        "step_summary_validation_status": (
            "warning" if step_energy_warning else "valid" if step_sheet is not None else "unavailable"
        ),
        "step_summary_duration_validated": step_duration_validated,
        "record_clock_dialect": record_clock_dialect,
        "record_count": int(len(frame)),
        "executed_step_count": int(frame["step"].nunique()),
        "parser_warnings": parser_warnings,
    }
    return frame


def _read_metadata_inputs(workbook: Any) -> tuple[
    dict[str, object],
    dict[str, dict[str, str]],
    dict[str, dict[str, object]],
    dict[str, object],
    str | None,
    bool,
    bool,
    bool,
]:
    record_sheet = _sheet_by_name(workbook, "record", required=True)
    _require_columns(
        _header_map(record_sheet),
        REQUIRED_RECORD_HEADERS,
        sheet_name="record",
    )
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
    return (
        info,
        step_info,
        original_steps,
        unit_original,
        unit_workbook_name,
        has_cycle_summary,
        has_step_summary,
        test_sheet is not None,
    )


def _read_calamine_metadata_inputs(
    candidate: Path,
    *,
    allow_fallback: bool,
) -> tuple | None:
    if _python_calamine is None:
        return None
    workbook = None
    try:
        workbook = _python_calamine.load_workbook(str(candidate))
        with zipfile.ZipFile(candidate) as archive:
            sheet_paths = _xlsx_sheet_paths(archive)
            record_path = sheet_paths.get(_normalize_text("record"))
            if record_path is None:
                raise UnsupportedNewareExcelError(
                    "Not a recognized Neware Excel export: required record sheet is missing."
                )
            with archive.open(record_path) as record_xml:
                rows = _iter_xlsx_xml_rows(record_xml)
                try:
                    header_xml_row = next(rows)
                except StopIteration as exc:
                    raise UnsupportedNewareExcelError(
                        "Not a recognized Neware Excel export: record sheet is empty."
                    ) from exc
            shared_strings = _xlsx_shared_strings(
                archive,
                max_index=_xlsx_max_shared_string_index(header_xml_row),
            )
            header_row = _xlsx_row_values(header_xml_row, shared_strings)
        adapter = _CalamineWorkbookAdapter(
            workbook,
            overrides={
                "record": _RowsSheetAdapter("record", [header_row]),
            },
        )
        return _read_metadata_inputs(adapter)
    except NewareExcelError:
        if allow_fallback:
            return None
        raise
    except Exception as exc:
        if allow_fallback:
            return None
        raise InvalidNewareExcelError(
            "Could not read the Neware Excel metadata with the fast reader."
        ) from exc
    finally:
        if workbook is not None:
            workbook.close()


def read_metadata(path: str | Path) -> dict[str, object]:
    return _read_metadata(path, fast_only=False)


def read_metadata_fast(path: str | Path) -> dict[str, object]:
    """Read eligibility metadata without falling back to openpyxl's shared-string load."""
    return _read_metadata(path, fast_only=True)


def _read_metadata(path: str | Path, *, fast_only: bool) -> dict[str, object]:
    """Read bounded workbook metadata and the programmed plan.

    The metadata path intentionally opens only the small ``test``, ``unit`` and
    sheet/header surfaces.  It never iterates the large ``record`` worksheet and
    does not derive metadata from :func:`parse_timeseries`.
    """

    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        raise UnsupportedNewareExcelError(
            "Not a recognized Neware Excel export: only .xlsx is supported."
        )

    try:
        inputs = _read_calamine_metadata_inputs(candidate, allow_fallback=not fast_only)
        if inputs is None:
            if fast_only:
                raise InvalidNewareExcelError(
                    "The fast Neware Excel metadata reader is unavailable."
                )
            with _open(candidate) as workbook:
                inputs = _read_metadata_inputs(workbook)
        (
            info,
            step_info,
            original_steps,
            unit_original,
            unit_workbook_name,
            has_cycle_summary,
            has_step_summary,
            has_test_sheet,
        ) = inputs
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
                "DeclaredProtocol": {"Value": has_test_sheet},
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


def _display_rounding_tolerance(value: float, *, scale: float, minimum: float) -> float:
    """Account for the precision displayed by a Neware summary cell."""

    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return minimum
    exponent = decimal_value.as_tuple().exponent
    if not isinstance(exponent, int) or exponent >= 0:
        return minimum
    return max(minimum, 0.5 * (10.0**exponent) * scale)


def _parse_cycle_summary(
    sheet: Any,
    *,
    ambiguous_time_values: list[dict[str, object]] | None = None,
) -> list[dict[str, float | int | None]]:
    headers = _header_map(sheet)
    required = _require_columns(headers, _CYCLE_REQUIRED_HEADERS, sheet_name="cycle")
    optional = _optional_columns(
        headers,
        _CYCLE_OPTIONAL_HEADERS,
        sheet_name="cycle",
    )
    charge_time_source = required[_normalize_text("Chg. Time(min)")][1]
    discharge_time_source = required[_normalize_text("DChg. Time(min)")][1]
    charge_time_is_clock = _is_clock_duration_source(
        charge_time_source,
        "Chg. Time(min)",
    )
    discharge_time_is_clock = _is_clock_duration_source(
        discharge_time_source,
        "DChg. Time(min)",
    )
    parsed: list[dict[str, float | int | None | bool]] = []
    for row_number, values in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        if not any(not _is_blank(value) for value in values):
            continue

        def value_for(header: str) -> object:
            binding = required.get(_normalize_text(header)) or optional.get(_normalize_text(header))
            return None if binding is None else values[binding[0]]

        energy_rounding_tolerances: dict[str, float] = {}

        def scaled_energy_value(header: str) -> float | None:
            binding = optional.get(_normalize_text(header))
            if binding is None:
                return None
            number = _summary_number(value_for(header), row_number=row_number, column=header)
            if number is None:
                return None
            factor = _energy_to_mwh_factor(binding[1])
            energy_rounding_tolerances[header] = _display_rounding_tolerance(
                number,
                scale=factor,
                minimum=0.0,
            )
            return number * factor

        def elapsed_value(header: str, source_header: str) -> float | None:
            value = value_for(header)
            if _is_blank(value):
                return None
            try:
                return _unitless_or_minutes_seconds(
                    value,
                    source_header=source_header,
                    canonical_header=header,
                )
            except (TypeError, ValueError, OverflowError) as exc:
                numeric_value: float | None = None
                if isinstance(value, Number) and not isinstance(value, bool):
                    try:
                        candidate = float(value)
                        if math.isfinite(candidate):
                            numeric_value = candidate
                    except (TypeError, ValueError, OverflowError):
                        pass
                elif isinstance(value, str) and _PLAIN_NUMBER_RE.fullmatch(value.strip()):
                    candidate = float(value)
                    if math.isfinite(candidate):
                        numeric_value = candidate
                if (
                    numeric_value is not None
                    and _is_clock_duration_source(source_header, header)
                ):
                    if ambiguous_time_values is not None:
                        ambiguous_time_values.append(
                            {
                                "cycle": int(cycle),
                                "field": header,
                            }
                        )
                    # Capacity, CE, and energy summaries remain usable. Do not
                    # guess the units of a unitless numeric duration.
                    return None
                raise InvalidNewareExcelError(
                    f"Neware Excel cycle summary row {row_number} has an invalid {source_header} value."
                ) from exc

        cycle = _integer_value(value_for("Cycle Index"), label="Cycle Index", required=True)
        if cycle is None or cycle <= 0:
            raise InvalidNewareExcelError(
                f"Neware Excel cycle summary row {row_number} has an invalid Cycle Index."
            )
        charge_capacity = _summary_number(
            value_for("Chg. Cap.(mAh)"),
            row_number=row_number,
            column="Chg. Cap.(mAh)",
        )
        discharge_capacity = _summary_number(
            value_for("DChg. Cap.(mAh)"),
            row_number=row_number,
            column="DChg. Cap.(mAh)",
        )
        efficiency = _summary_number(
            value_for("Chg.-DChg. Eff(%)"),
            row_number=row_number,
            column="Chg.-DChg. Eff(%)",
        )
        if (
            efficiency is None
            and charge_capacity is not None
            and discharge_capacity is not None
            and not math.isclose(charge_capacity, 0.0, abs_tol=1e-12)
        ):
            efficiency = discharge_capacity / charge_capacity * 100.0

        parsed.append(
            {
                "cycle": cycle,
                "charge_capacity_mah": charge_capacity,
                "discharge_capacity_mah": discharge_capacity,
                "coulombic_efficiency_pct": efficiency,
                "charge_energy_mwh": scaled_energy_value("Chg. Energy(Wh)"),
                "discharge_energy_mwh": scaled_energy_value("DChg. Energy(Wh)"),
                "charge_energy_rounding_tolerance_mwh": energy_rounding_tolerances.get(
                    "Chg. Energy(Wh)", 0.0
                ),
                "discharge_energy_rounding_tolerance_mwh": energy_rounding_tolerances.get(
                    "DChg. Energy(Wh)", 0.0
                ),
                "charge_time_is_clock": charge_time_is_clock,
                "discharge_time_is_clock": discharge_time_is_clock,
                "charge_time_s": elapsed_value("Chg. Time(min)", charge_time_source),
                "discharge_time_s": elapsed_value("DChg. Time(min)", discharge_time_source),
            }
        )

    if not parsed:
        raise InvalidNewareExcelError("Neware Excel cycle sheet contains no data rows.")
    parsed.sort(key=lambda row: int(row["cycle"]))
    cycle_ids = [int(row["cycle"]) for row in parsed]
    if len(set(cycle_ids)) != len(cycle_ids):
        raise InvalidNewareExcelError("Neware Excel cycle summary contains duplicate Cycle Index values.")
    return parsed


def _read_cycle_summary_fast(path: Path) -> pd.DataFrame | None:
    """Read the compact Neware cycle sheet without opening/materializing other sheets."""
    with zipfile.ZipFile(path) as archive:
        sheet_paths = _xlsx_sheet_paths(archive)
        cycle_path = sheet_paths.get(_normalize_text("cycle"))
        if cycle_path is None:
            return None
        raw_rows: list[bytes] = []
        max_shared_string_index: int | None = None
        with archive.open(cycle_path) as cycle_xml:
            for xml_row in _iter_xlsx_xml_rows(cycle_xml):
                raw_rows.append(xml_row)
                row_max = _xlsx_max_shared_string_index(xml_row)
                if row_max is not None:
                    max_shared_string_index = (
                        row_max
                        if max_shared_string_index is None
                        else max(max_shared_string_index, row_max)
                    )
        if not raw_rows:
            raise InvalidNewareExcelError("Neware Excel cycle sheet is empty.")
        shared_strings = _xlsx_shared_strings(
            archive,
            max_index=max_shared_string_index,
        )
        rows = [_xlsx_row_values(xml_row, shared_strings) for xml_row in raw_rows]
    adapter = _RowsSheetAdapter("cycle", rows)
    return pd.DataFrame(_parse_cycle_summary(adapter))


@lru_cache(maxsize=16)
def _read_cycle_summary_fast_cached(
    path_string: str,
    size_bytes: int,
    modified_ns: int,
) -> pd.DataFrame | None:
    """Reuse the compact cycle sheet while a source version remains unchanged."""
    del size_bytes, modified_ns  # Included in the key for automatic invalidation.
    return _read_cycle_summary_fast(Path(path_string))


def _read_preview_data_reference(
    path: str | Path,
    *,
    quantity: str,
    cycle_start: int | None = None,
    cycle_end: int | None = None,
    voltage_x_axis: str = "time",
) -> dict[str, object] | None:
    """Read cycle-summary data or a bounded raw-voltage preview from an XLSX."""
    candidate = _path(path)
    if candidate.suffix.casefold() != ".xlsx":
        return None
    if quantity not in {"voltage", "capacity_bundle"}:
        raise ValueError("Unsupported Neware Excel preview quantity.")
    if voltage_x_axis not in {"time", "capacity"}:
        raise ValueError("Unsupported Neware Excel voltage preview axis.")

    try:
        stat = candidate.stat()
        cycles = _read_cycle_summary_fast_cached(
            str(candidate), stat.st_size, stat.st_mtime_ns
        )
        if cycles is None:
            # Without the workbook's bounded cycle index we cannot safely map
            # preview navigation windows onto record rows.
            return None
        cycle_ids = [int(value) for value in cycles["cycle"].tolist()]
        cycle_count = len(cycle_ids)
        if quantity == "capacity_bundle":
            return {
                "cycle_count": cycle_count,
                "cycles": cycles,
                "raw": None,
                "time_origin_s": None,
                "cycle_start": 1,
                "cycle_end": cycle_count,
            }

        if cycle_start is None and cycle_end is None:
            requested_start = max(1, cycle_count - 19)
            requested_end = cycle_count
        else:
            requested_start = max(1, int(cycle_start or 1))
            requested_end = max(requested_start, int(cycle_end or requested_start))
        requested_end = min(requested_end, cycle_count)
        if requested_start > requested_end:
            return {
                "cycle_count": cycle_count,
                "cycles": cycles,
                "raw": pd.DataFrame(),
                "time_origin_s": None,
                "cycle_start": requested_start,
                "cycle_end": requested_end,
            }

        selected_cycle_ids = cycle_ids[requested_start - 1 : requested_end]
        cycle_ordinals = {cycle_id: ordinal for ordinal, cycle_id in enumerate(cycle_ids, start=1)}
        target_cycles = set(selected_cycle_ids)
        rows: list[dict[str, object]] = []
        time_origin_s: float | None = None
        with zipfile.ZipFile(candidate) as archive:
            sheet_paths = _xlsx_sheet_paths(archive)
            record_path = sheet_paths.get(_normalize_text("record"))
            if record_path is None:
                raise UnsupportedNewareExcelError(
                    "Not a recognized Neware Excel export: required record sheet is missing."
                )
            with archive.open(record_path) as record_xml:
                record_rows = _iter_xlsx_xml_rows(record_xml)
                try:
                    header_xml_row = next(record_rows)
                except StopIteration as exc:
                    raise UnsupportedNewareExcelError(
                        "Neware Excel record sheet is empty."
                    ) from exc
                header_shared_strings = _xlsx_shared_strings(
                    archive,
                    max_index=_xlsx_max_shared_string_index(header_xml_row),
                )
                header_row = _xlsx_row_values(header_xml_row, header_shared_strings)
                headers = _fast_header_map(iter(header_row))
                required = _require_columns(
                    headers,
                    (
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
                    ),
                    sheet_name="record",
                )
                data_point_index = required[_normalize_text("DataPoint")][0]
                cycle_index, _cycle_source = required[_normalize_text("Cycle Index")]
                step_index = required[_normalize_text("Step Index")][0]
                status_index = required[_normalize_text("Step Type")][0]
                time_index, time_source = required[_normalize_text("Time(min)")]
                total_time_index, total_time_source = required[_normalize_text("Total Time(min)")]
                current_index = required[_normalize_text("Current(mA)")][0]
                voltage_index = required[_normalize_text("Voltage(V)")][0]
                charge_index = required[_normalize_text("Chg. Cap.(mAh)")][0]
                discharge_index = required[_normalize_text("DChg. Cap.(mAh)")][0]
                cycle_column = _xlsx_column_letters(cycle_index)
                total_time_column = _xlsx_column_letters(total_time_index)
                # The same selected rows serve both voltage axes. Retaining the
                # cumulative capacity columns avoids a second full DEFLATE scan
                # when the user switches between Time and Capacity.
                include_capacity_data = True
                selected_columns = {
                    data_point_index,
                    cycle_index,
                    time_index,
                    total_time_index,
                    current_index,
                    voltage_index,
                }
                if include_capacity_data:
                    selected_columns.update(
                        {step_index, status_index, charge_index, discharge_index}
                    )

                selected_rows: list[tuple[int, bytes, int]] = []
                used_shared_string_indices = _xlsx_shared_string_indices(header_xml_row)
                for fallback_row_number, xml_row in enumerate(record_rows, start=2):
                    cycle_value = _xlsx_find_column_value(
                        xml_row, cycle_column, header_shared_strings
                    )
                    if cycle_value is None or (
                        isinstance(cycle_value, str) and not cycle_value.strip()
                    ):
                        continue
                    total_time_value = _xlsx_find_column_value(
                        xml_row, total_time_column, header_shared_strings
                    )
                    if total_time_value is None or (
                        isinstance(total_time_value, str) and not total_time_value.strip()
                    ):
                        continue
                    row_number = _xlsx_row_number(xml_row, fallback_row_number)
                    try:
                        time_origin_s = _unitless_or_minutes_seconds(
                            total_time_value,
                            source_header=total_time_source,
                            canonical_header="Total Time(min)",
                        )
                    except (TypeError, ValueError, OverflowError) as exc:
                        raise _invalid_record(row_number, total_time_source) from exc
                    break

                unordered_cycle_rows = False
                previous_cycle_ordinal: int | None = None
                with archive.open(record_path) as record_xml:
                    for fallback_row_number, xml_row in enumerate(
                        _iter_xlsx_rows_from_cycle_start(
                            record_xml,
                            cycle_column=cycle_column,
                            first_cycle_id=selected_cycle_ids[0],
                        ),
                        start=2,
                    ):
                        cycle_value = _xlsx_find_column_value(
                            xml_row, cycle_column, header_shared_strings
                        )
                        if cycle_value is None or (
                            isinstance(cycle_value, str) and not cycle_value.strip()
                        ):
                            continue
                        try:
                            cycle_number = float(cycle_value)
                        except (TypeError, ValueError, OverflowError):
                            continue
                        if not math.isfinite(cycle_number) or not cycle_number.is_integer():
                            continue
                        cycle_id = int(cycle_number)
                        cycle_ordinal = cycle_ordinals.get(cycle_id)
                        if cycle_ordinal is None:
                            continue
                        if (
                            previous_cycle_ordinal is not None
                            and cycle_ordinal < previous_cycle_ordinal
                        ):
                            unordered_cycle_rows = True
                            break
                        previous_cycle_ordinal = cycle_ordinal
                        if cycle_ordinal > requested_end:
                            break
                        if cycle_ordinal < requested_start:
                            unordered_cycle_rows = True
                            break
                        row_number = _xlsx_row_number(xml_row, fallback_row_number)
                        selected_rows.append((row_number, xml_row, cycle_id))
                        used_shared_string_indices.update(
                            _xlsx_shared_string_indices(
                                xml_row,
                                selected_columns=selected_columns,
                            )
                        )
                if unordered_cycle_rows or not selected_rows:
                    selected_rows.clear()
                    used_shared_string_indices = _xlsx_shared_string_indices(header_xml_row)
                    with archive.open(record_path) as record_xml:
                        for row_number, cycle_id, xml_row in _iter_xlsx_rows_for_cycles(
                            record_xml,
                            cycle_column=cycle_column,
                            target_cycle_ids=target_cycles,
                        ):
                            selected_rows.append((row_number, xml_row, cycle_id))
                            used_shared_string_indices.update(
                                _xlsx_shared_string_indices(
                                    xml_row,
                                    selected_columns=selected_columns,
                                )
                            )
                shared_strings = _xlsx_shared_strings_for_indices(
                    archive,
                    used_shared_string_indices,
                )
                for row_number, xml_row, cycle_id in selected_rows:
                    values = _xlsx_row_values(xml_row, shared_strings, selected_columns=selected_columns)
                    row = {
                        "record_index": _integer(
                            values[data_point_index], row_number=row_number, column="DataPoint"
                        ),
                        "cycle": cycle_ordinals[cycle_id],
                        "time_s": _unitless_or_minutes_seconds(
                            values[time_index],
                            source_header=time_source,
                            canonical_header="Time(min)",
                        ),
                        "total_time_s": _unitless_or_minutes_seconds(
                            values[total_time_index],
                            source_header=total_time_source,
                            canonical_header="Total Time(min)",
                        ),
                        "current_ma": _number(
                            values[current_index], row_number=row_number, column="Current(mA)"
                        ),
                        "voltage_v": _number(
                            values[voltage_index], row_number=row_number, column="Voltage(V)"
                        ),
                    }
                    if include_capacity_data:
                        row.update(
                            {
                                "step_index": _integer(
                                    values[step_index], row_number=row_number, column="Step Index"
                                ),
                                "status": _normalize_status(
                                    values[status_index], row_number=row_number
                                ),
                                "charge_capacity_mah": _number(
                                    values[charge_index], row_number=row_number, column="Chg. Cap.(mAh)"
                                ),
                                "discharge_capacity_mah": _number(
                                    values[discharge_index], row_number=row_number, column="DChg. Cap.(mAh)"
                                ),
                            }
                        )
                    rows.append(row)
        if not rows:
            raise InvalidNewareExcelError(
                "Neware Excel record sheet has no rows for the selected preview cycles."
            )
        raw = pd.DataFrame(rows).sort_values("record_index", kind="stable").reset_index(drop=True)
        # This preview path is display-only. If even the selected range contains a
        # clock reset, leave the plot to the validated parser/cache path rather
        # than presenting rows whose ordering semantics are not settled.
        _require_monotonic_preview_time(raw)
        return {
            "cycle_count": cycle_count,
            "cycles": cycles,
            "raw": raw,
            "time_origin_s": time_origin_s,
            "cycle_start": requested_start,
            "cycle_end": requested_end,
        }
    except NewareExcelError:
        raise
    except _XlsxFastPreviewNeedsValidatedFallback:
        raise
    except Exception as exc:
        raise InvalidNewareExcelError(
            "Could not read the Neware Excel preview."
        ) from exc


def read_preview_data(
    path: str | Path,
    *,
    quantity: str,
    cycle_start: int | None = None,
    cycle_end: int | None = None,
    voltage_x_axis: str = "time",
) -> dict[str, object] | None:
    """Use a bounded single-pass voltage preview, retaining the reference reader."""
    candidate = _path(path)
    if candidate.suffix.casefold() == ".xlsx" and quantity == "voltage":
        try:
            preview = _try_read_voltage_preview_streaming(
                candidate,
                cycle_start=cycle_start,
                cycle_end=cycle_end,
            )
        except _XlsxFastPreviewNeedsValidatedFallback:
            return None
        except InvalidNewareExcelError:
            raise
        except Exception:
            # The optimized path is intentionally opportunistic. Any workbook
            # layout it cannot prove safe goes through the established reader.
            preview = None
        if preview is not None:
            return preview
    try:
        return _read_preview_data_reference(
            path,
            quantity=quantity,
            cycle_start=cycle_start,
            cycle_end=cycle_end,
            voltage_x_axis=voltage_x_axis,
        )
    except _XlsxFastPreviewNeedsValidatedFallback:
        return None


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
            state["cycle_summary_validation_status"] = "unavailable"
            return
        ambiguous_cycle_times: list[dict[str, object]] = []
        summary = _parse_cycle_summary(
            cycle_sheet,
            ambiguous_time_values=ambiguous_cycle_times,
        )
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
    if ambiguous_cycle_times:
        ambiguous_fields_by_cycle: dict[int, set[str]] = {}
        for item in ambiguous_cycle_times:
            cycle = item.get("cycle")
            if not isinstance(cycle, int):
                continue
            normalized_field = _normalize_text(str(item.get("field", "")))
            if normalized_field.startswith("dchg") or "discharge" in normalized_field:
                label = "discharge duration"
            elif "chg" in normalized_field or "charge" in normalized_field:
                label = "charge duration"
            else:
                label = "cycle duration"
            ambiguous_fields_by_cycle.setdefault(cycle, set()).add(label)
        affected_cycles = sorted(ambiguous_fields_by_cycle)
        warnings = state.setdefault("parser_warnings", [])
        if not isinstance(warnings, list):
            warnings = []
            state["parser_warnings"] = warnings
        warnings.append(
            {
                "code": "ambiguous_cycle_summary_times_ignored",
                "scope": "cycle",
                "count": len(affected_cycles),
                "message": (
                    "Neware's cycle summary contains numeric time values under headers "
                    "with no units. CellXplorer ignored those time summaries instead of "
                    "guessing their units; cycle capacity, CE, and recorded measurements "
                    "remain available."
                ),
                "examples": [
                    {
                        "cycle": cycle,
                        "ambiguous_fields": (
                            "charge/discharge duration"
                            if ambiguous_fields_by_cycle[cycle]
                            == {"charge duration", "discharge duration"}
                            else "/".join(sorted(ambiguous_fields_by_cycle[cycle]))
                        ),
                    }
                    for cycle in affected_cycles[:3]
                ],
            }
        )
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
    record_clock_dialect = bool(state.get("record_clock_dialect", False))
    energy_mismatches: list[dict[str, object]] = []
    efficiency_mismatches: list[dict[str, object]] = []

    def compare(
        cycle_id: int,
        quantity: str,
        actual_value: object,
        expected_value: object,
        tolerance: float,
    ) -> None:
        if expected_value is None:
            return
        duration_quantity = quantity in {"charge time", "discharge time"}
        try:
            actual_number = float(actual_value)
            expected_number = float(expected_value)
        except (TypeError, ValueError) as exc:
            try:
                expected_number = float(expected_value)
            except (TypeError, ValueError):
                raise InvalidNewareExcelError(
                    f"Neware Excel cycle {cycle_id} {quantity} cannot be compared."
                ) from exc
            # Neware omits a derived duration when a cycle has no matching
            # phase, while its summary writes the corresponding value as 0.
            # Treat that representation as the same zero rather than turning
            # an otherwise valid final cycle into an import failure.
            if duration_quantity and abs(expected_number) <= tolerance and (
                actual_value is None or pd.isna(actual_value)
            ):
                return
            raise InvalidNewareExcelError(
                f"Neware Excel cycle {cycle_id} {quantity} cannot be compared."
            ) from exc
        if not math.isfinite(expected_number):
            raise InvalidNewareExcelError(
                f"Neware Excel cycle {cycle_id} {quantity} has a non-finite summary value."
            )
        if math.isnan(actual_number):
            if duration_quantity and abs(expected_number) <= tolerance:
                return
            raise InvalidNewareExcelError(
                f"Neware Excel cycle {cycle_id} {quantity} mismatch: calculated {actual_number:g}, "
                f"summary {expected_number:g}."
            )
        if not math.isfinite(actual_number):
            raise InvalidNewareExcelError(
                f"Neware Excel cycle {cycle_id} {quantity} mismatch: calculated {actual_number:g}, "
                f"summary {expected_number:g}."
            )
        comparison_slack = max(1e-12, abs(expected_number) * 1e-12)
        if abs(actual_number - expected_number) > tolerance + comparison_slack:
            if quantity in {"charge energy", "discharge energy"}:
                energy_mismatches.append(
                    {
                        "cycle": cycle_id,
                        "quantity": quantity,
                        "summary_mwh": expected_number,
                        "calculated_mwh": actual_number,
                    }
                )
                return
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
        relaxed_clock_dialect = bool(
            record_clock_dialect
            and row.get("charge_time_is_clock")
            and row.get("discharge_time_is_clock")
        )
        charge_capacity_rounding = (
            _display_rounding_tolerance(float(charge_capacity), scale=1.0, minimum=0.0)
            if charge_capacity is not None
            else 0.0
        )
        capacity_tolerance = max(
            0.002,
            0.001 * abs(float(charge_capacity)),
            charge_capacity_rounding,
        ) if charge_capacity is not None else 0.0
        if relaxed_clock_dialect:
            capacity_tolerance = max(
                capacity_tolerance,
                _display_rounding_tolerance(float(charge_capacity), scale=1.0, minimum=0.0) * 2.5
                if charge_capacity is not None else 0.0,
            )
        compare(
            cycle_id,
            "charge capacity",
            actual_row.get("charge_capacity_mah"),
            charge_capacity,
            capacity_tolerance,
        )
        discharge_capacity_rounding = (
            _display_rounding_tolerance(float(discharge_capacity), scale=1.0, minimum=0.0)
            if discharge_capacity is not None
            else 0.0
        )
        discharge_capacity_tolerance = max(
            0.002,
            0.001 * abs(float(discharge_capacity)),
            discharge_capacity_rounding,
        ) if discharge_capacity is not None else 0.0
        if relaxed_clock_dialect:
            discharge_capacity_tolerance = max(
                discharge_capacity_tolerance,
                _display_rounding_tolerance(float(discharge_capacity), scale=1.0, minimum=0.0) * 2.5
                if discharge_capacity is not None else 0.0,
            )
        compare(
            cycle_id,
            "discharge capacity",
            actual_row.get("discharge_capacity_mah"),
            discharge_capacity,
            discharge_capacity_tolerance,
        )
        charge_energy_tolerance = max(0.01, 0.001 * abs(float(charge_energy))) if charge_energy is not None else 0.0
        if relaxed_clock_dialect:
            charge_energy_tolerance = max(
                charge_energy_tolerance,
                float(row.get("charge_energy_rounding_tolerance_mwh", 0.0)) * 2.5,
                abs(float(charge_energy)) * 0.005 if charge_energy is not None else 0.0,
            )
        compare(
            cycle_id,
            "charge energy",
            actual_row.get("charge_energy_mwh"),
            charge_energy,
            charge_energy_tolerance,
        )
        discharge_energy_tolerance = max(0.01, 0.001 * abs(float(discharge_energy))) if discharge_energy is not None else 0.0
        if relaxed_clock_dialect:
            discharge_energy_tolerance = max(
                discharge_energy_tolerance,
                float(row.get("discharge_energy_rounding_tolerance_mwh", 0.0)) * 2.5,
                abs(float(discharge_energy)) * 0.005 if discharge_energy is not None else 0.0,
            )
        compare(
            cycle_id,
            "discharge energy",
            actual_row.get("discharge_energy_mwh"),
            discharge_energy,
            discharge_energy_tolerance,
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
            efficiency_tolerance = 0.05
            if relaxed_clock_dialect:
                efficiency_tolerance = 0.5
            actual_efficiency = float(actual_row["coulombic_efficiency_pct"])
            summary_efficiency = float(row["coulombic_efficiency_pct"])
            if abs(actual_efficiency - summary_efficiency) > efficiency_tolerance + max(
                1e-12, abs(summary_efficiency) * 1e-12
            ):
                charge_low = max(0.0, float(charge_capacity) - charge_capacity_rounding) if charge_capacity is not None else 0.0
                charge_high = float(charge_capacity) + charge_capacity_rounding if charge_capacity is not None else 0.0
                discharge_low = max(0.0, float(discharge_capacity) - discharge_capacity_rounding) if discharge_capacity is not None else 0.0
                discharge_high = float(discharge_capacity) + discharge_capacity_rounding if discharge_capacity is not None else 0.0
                if charge_high <= 0.0 or charge_low <= 1e-12:
                    rounding_consistent = False
                    efficiency_low = efficiency_high = 0.0
                else:
                    # Neware writes capacity and efficiency summaries at their
                    # displayed precision. A ratio from those rounded values
                    # can differ from the ratio computed from raw records,
                    # especially for low-capacity cycles.
                    efficiency_low = 100.0 * discharge_low / charge_high
                    efficiency_high = 100.0 * discharge_high / charge_low
                    efficiency_rounding = _display_rounding_tolerance(
                        summary_efficiency,
                        scale=1.0,
                        minimum=0.0,
                    )
                    rounding_consistent = all(
                        efficiency_low - efficiency_rounding - 1e-12
                        <= value
                        <= efficiency_high + efficiency_rounding + 1e-12
                        for value in (actual_efficiency, summary_efficiency)
                    )
                if not rounding_consistent:
                    compare(
                        cycle_id,
                        "coulombic efficiency",
                        actual_efficiency,
                        summary_efficiency,
                        efficiency_tolerance,
                    )
                efficiency_mismatches.append(
                    {
                        "cycle": cycle_id,
                        "quantity": "coulombic efficiency",
                        "summary_pct": summary_efficiency,
                        "measurement_pct": actual_efficiency,
                        "rounding_min_pct": efficiency_low,
                        "rounding_max_pct": efficiency_high,
                    }
                )
    cycle_summary_mismatches = energy_mismatches + efficiency_mismatches
    cycle_summary_quantities = list(dict.fromkeys(
        str(item["quantity"]) for item in cycle_summary_mismatches if item.get("quantity")
    ))
    _record_summary_mismatches(
        raw,
        scope="cycle",
        code="summary_reconciliation_mismatch",
        summary_label=" and ".join(cycle_summary_quantities) or "numeric values",
        measurement_label="values calculated from the exported measurements",
        mismatches=cycle_summary_mismatches,
    )
    if energy_mismatches or efficiency_mismatches or ambiguous_cycle_times:
        state["cycle_summary_validated"] = False
        state["cycle_summary_validation_status"] = "warning"
    else:
        state["cycle_summary_validated"] = True
        state["cycle_summary_validation_status"] = "valid"
