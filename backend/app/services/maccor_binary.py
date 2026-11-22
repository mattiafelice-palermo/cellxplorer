"""Native Maccor 4608 channel files, verified 264-byte record layout."""
from __future__ import annotations

import os
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from xml.etree import ElementTree

import numpy as np
import pandas as pd

from .canonical_cycling import voltage_capabilities
from .maccor_cycling import canonical_records
from .protocol import DECLARED_PROTOCOL_METADATA_KEY, build_declared_protocol
from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


ADAPTER_REVISION = 1
_PREFIX_BYTES = 416
_HEADER_LIMIT = 4 * 1024 * 1024
_ADC_MAX = 65535
_RECORD = np.dtype({
    "names": ["date", "channel", "mode", "end_status", "reserved", "step", "current", "voltage",
              "test_ticks", "step_ticks", "capacity", "energy", "record", "range_code"],
    "formats": ["<f8", "u1", "u1", "u1", "<u4", "u1", "<u2", "<u2",
                "<u8", "<u8", "<u8", "<u8", "<u4", "<u2"],
    "offsets": [0, 8, 9, 10, 11, 15, 16, 18, 21, 29, 37, 45, 230, 234],
    "itemsize": 264,
})
_MODE = {1: "C", 2: "D", 4: "R", 29: "SBw"}
_PROGRAM_MODE = {"Charge": "C", "Dischrge": "D", "Rest": "R"}


@dataclass(frozen=True)
class _Header:
    channel: int  # zero-based in both the channel descriptor and the records
    step_types: tuple[str, ...]
    current_ranges: tuple[float, float]
    voltage_min: float
    voltage_max: float
    metadata: dict


def _dates(serial_days: np.ndarray) -> np.ndarray:
    if not (np.isfinite(serial_days) & (serial_days >= 1) & (serial_days < 2958466)).all():
        raise InvalidSourceFormatError("Invalid Maccor local acquisition date.")
    ticks = np.rint(serial_days * 86_400_000).astype("timedelta64[ms]")
    return np.datetime64("1899-12-30", "ms") + ticks


def _program_steps(data: bytes, declared_count: int) -> tuple[str, ...]:
    if (not data.startswith(b"<?xml") or b'progid="Maccor Procedure File"' not in data[:160]
            or b"<!" in data or b"\x00" in data):
        raise UnsupportedSourceFormatError("Expected an embedded Maccor test procedure.")
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raise InvalidSourceFormatError("Invalid embedded Maccor test procedure.") from exc
    if root.tag != "MaccorTestProcedure" or root.findtext("header/FileFormatVersion/BTVersion") != "11":
        raise UnsupportedSourceFormatError("Unsupported Maccor procedure layout.")
    nodes = root.findall("ProcSteps/TestStep")
    steps = tuple((node.findtext("StepType") or "").strip() for node in nodes)
    if len(steps) != declared_count - 1 or not steps:
        raise InvalidSourceFormatError("Maccor binary and XML procedure step counts disagree.")
    for index, (node, kind) in enumerate(zip(nodes, steps)):
        if kind not in _PROGRAM_MODE and kind != "End" and not re.fullmatch(r"(?:Do|Loop) [1-4]", kind):
            raise UnsupportedSourceFormatError(f"Unsupported Maccor procedure step type: {kind[:32]}.")
        for target in node.findall("Ends/EndEntry/Step"):
            if (target.text or "").strip().lstrip("0") != str(index + 2):
                raise UnsupportedSourceFormatError("Maccor procedure uses an unverified step jump.")
    # Cycle C is computed by the export. Only infer it for observed program
    # shapes: each flat loop contains one charge phase followed by one discharge.
    # Rest steps do not change direction. Multiple charge steps can share a phase.
    symbols = "".join(_PROGRAM_MODE.get(kind, kind) for kind in steps if kind != "Rest")
    if not re.fullmatch(r"(?:Do ([1-4])C+D+Loop \1)+End", symbols):
        raise UnsupportedSourceFormatError("Unsupported Maccor cycle program; expected charge-first cycling loops.")
    return steps


def _read_header(stream: BinaryIO) -> _Header:
    prefix = stream.read(_PREFIX_BYTES)
    if (len(prefix) != _PREFIX_BYTES or prefix[:2] != b"\x00\x00"
            or struct.unpack_from("<I", prefix, 2)[0] != _PREFIX_BYTES + 1
            or struct.unpack_from("<H", prefix, 36)[0] != _RECORD.itemsize):
        raise UnsupportedSourceFormatError("Expected a Maccor 4608 binary channel file with 264-byte records.")

    def offset(field: int) -> int:
        # The section directory uses one-based file positions.
        return struct.unpack_from("<I", prefix, field)[0] - 1

    calibration, instrument = offset(2), offset(6)
    names, names_end = offset(16), offset(20)
    step_count = struct.unpack_from("<I", prefix, 104)[0]
    procedure = offset(100) + 816 * step_count
    procedure_end, tester, records = offset(150), offset(166), offset(32)
    if (instrument != calibration + 330 or not 2 <= step_count <= 257
            or not (instrument + 64 <= names < names_end <= offset(100) < procedure
                    < procedure_end <= tester < records <= _HEADER_LIMIT)):
        raise UnsupportedSourceFormatError("Unsupported Maccor binary section directory.")
    header = prefix + stream.read(records - len(prefix))
    seed = stream.read(_RECORD.itemsize)
    if len(header) != records or len(seed) != _RECORD.itemsize:
        raise InvalidSourceFormatError("Truncated Maccor binary header or setup record.")
    if header[instrument + 18:instrument + 23] != b"4608\x00":
        raise UnsupportedSourceFormatError("Unsupported Maccor instrument layout.")
    channel = struct.unpack_from("<H", header, calibration)[0]
    if seed[8] != channel or any(seed[9:]):
        raise InvalidSourceFormatError("Maccor setup record does not match its channel descriptor.")
    started = _dates(np.frombuffer(seed, dtype="<f8", count=1))[0]
    steps = _program_steps(header[procedure:procedure_end], step_count)

    # The paired export establishes the bipolar voltage and unsigned current
    # conversion for this hardware profile. Other range tables need evidence.
    current_max = struct.unpack_from("<f", header, calibration + 2)[0]
    vmin, vmax = struct.unpack_from("<ff", header, calibration + 322)
    gains = struct.unpack_from("<4d", header, calibration + 106)
    discharge_gains = struct.unpack_from("<4d", header, calibration + 266)
    if (current_max != 5.0 or struct.unpack_from("<f", header, calibration + 162)[0] != current_max
            or (vmin, vmax) != (-5.0, 5.0) or gains != discharge_gains
            or gains != (100000 / 3, 1000.0, 100 / 3, 1.0)):
        raise UnsupportedSourceFormatError("Unsupported Maccor binary measurement range table.")

    device = header[tester:records].decode("cp1252", errors="replace").strip("\x00 ")
    name_fields = header[names:names_end].decode("cp1252", errors="replace")
    procedure_name, suffix, description = name_fields.partition(".000")
    fields = {"Tester": device, "Model": "4608", "Channel": channel + 1,
              "Procedure": procedure_name + suffix if suffix else None,
              "Description": description if suffix else None, "Step types": list(steps),
              "Cycle basis": "Inferred from charge following discharge in charge-first cycling loops",
              "Current full scale [A]": current_max, "Current range gains": list(gains),
              "Voltage range [V]": [vmin, vmax]}
    declared = build_declared_protocol([], warnings=["Full Maccor procedure settings are unavailable for protocol analysis."])
    metadata = {
        "raw": {"Maccor": fields, DECLARED_PROTOCOL_METADATA_KEY: declared}, "source_format": "Maccor binary",
        "channel": str(channel + 1), "device_info": device, "remarks": fields["Description"],
        "start_time": str(started), "voltage_capabilities": voltage_capabilities(),
        "protocol_warnings": declared["warnings"],
    }
    return _Header(channel, steps, (current_max / gains[0], current_max / gains[1]), vmin, vmax, metadata)


def read_header_metadata(path: str | Path) -> dict:
    with Path(path).open("rb") as stream:
        return _read_header(stream).metadata


def _decode(rows: np.ndarray, header: _Header) -> pd.DataFrame:
    if rows["reserved"].any():
        raise UnsupportedSourceFormatError("Unsupported Maccor record layout before the step field.")
    mode = pd.Series(rows["mode"]).map(_MODE)
    if mode.isna().any():
        raise UnsupportedSourceFormatError("Unsupported Maccor binary operating mode.")
    step = rows["step"].astype("int64")
    if (rows["channel"] != header.channel).any() or (step >= len(header.step_types)).any():
        raise InvalidSourceFormatError("Maccor record channel or step contradicts the header.")
    expected_mode = pd.Series(np.asarray(header.step_types)[step]).map(_PROGRAM_MODE)
    standby = mode.eq("SBw")
    if (mode.ne(expected_mode) & ~standby).any() or (standby & ~expected_mode.isin(("C", "D"))).any():
        raise InvalidSourceFormatError("Maccor record mode contradicts the programmed step.")

    charge, discharge = mode.eq("C"), mode.eq("D")
    flags = rows["range_code"]
    if ((charge & ~np.isin(flags, (0xEEEE, 0xFFFF))).any() or (discharge & (flags != 0xAAAA)).any()
            or (standby & (flags != 0x2222)).any()):
        raise UnsupportedSourceFormatError("Unsupported active Maccor current range code.")
    if (mode.eq("R") & (rows["current"] != 0)).any():
        raise InvalidSourceFormatError("Maccor rest record has a nonzero current count.")
    finest, middle = header.current_ranges
    current = rows["current"] * np.where(flags == 0xFFFF, finest, middle) / _ADC_MAX
    voltage_span = (header.voltage_max - header.voltage_min) / _ADC_MAX
    # Accumulators always use the finest current range and centisecond ticks,
    # even if the instantaneous ADC range changes during a step.
    ah_per_count = finest / (_ADC_MAX * 100 * 3600)
    return pd.DataFrame({
        "Rec": rows["record"].astype("int64"), "Step": step + 1, "Md": mode, "ES": rows["end_status"],
        "TestTime": rows["test_ticks"] / 6000.0, "StepTime": rows["step_ticks"] / 6000.0,
        "Current [A]": np.where(charge | discharge, current, 0.0),
        "Voltage [V]": header.voltage_min + rows["voltage"] * voltage_span,
        "Cap. [Ah]": rows["capacity"] * ah_per_count, "Ener. [Wh]": rows["energy"] * (ah_per_count * voltage_span),
        "DPT Time": _dates(rows["date"]),
    })


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    with Path(path).open("rb") as stream:
        before = os.fstat(stream.fileno())
        header = _read_header(stream)
        count, tail = divmod(before.st_size - stream.tell(), _RECORD.itemsize)
        if count <= 0 or tail:
            raise InvalidSourceFormatError("Empty or truncated Maccor binary measurement sequence.")
        chunks = []
        for first in range(0, count, 16384):
            size = min(count - first, 16384)
            rows = np.fromfile(stream, dtype=_RECORD, count=size)
            if len(rows) != size:
                raise OSError("Maccor source changed while reading records.")
            if not np.array_equal(rows["record"], np.arange(first + 1, first + size + 1)):
                raise InvalidSourceFormatError("Maccor binary record numbers are not consecutive from one.")
            chunks.append(_decode(rows, header))
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise OSError("Maccor source changed while reading records.")
    table = pd.concat(chunks, ignore_index=True)
    active = table["Md"].where(table["Md"].isin(("C", "D"))).ffill()
    measured_modes = active.dropna()
    if not measured_modes.empty and measured_modes.iloc[0] != "C":
        raise UnsupportedSourceFormatError("Maccor binary cycle interpretation requires a charge-first recording.")
    table["Cycle C"] = 1 + (active.eq("C") & active.shift().eq("D")).cumsum()
    return canonical_records(table, verify_minute_units=False)
