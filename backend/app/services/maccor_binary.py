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

from .canonical_cycling import REQUIRED_CYCLING_COLUMNS, voltage_capabilities
from .maccor_cycling import canonical_records
from .protocol import DECLARED_PROTOCOL_METADATA_KEY, build_declared_protocol
from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


ADAPTER_REVISION = 3
_PREFIX_BYTES = 416
_HEADER_LIMIT = 4 * 1024 * 1024
_ADC_MAX = 65535
_RECORD = np.dtype({
    "names": ["date", "channel", "mode", "end_status", "program_field", "step", "current", "voltage",
              "test_ticks", "step_ticks", "capacity", "energy", "record", "range_code"],
    "formats": ["<f8", "u1", "u1", "u1", "<u4", "u1", "<u2", "<u2",
                "<u8", "<u8", "<u8", "<u8", "<u4", "<u2"],
    "offsets": [0, 8, 9, 10, 11, 15, 16, 18, 21, 29, 37, 45, 230, 234],
    "itemsize": 264,
})
_MODE = {1: "C", 2: "D", 4: "R", 26: "SubRout", 29: "SBw", 30: "Stop", 31: "O"}
_PROGRAM_MODE = {"Charge": "C", "Dischrge": "D", "Rest": "R"}
_CHARGE_RANGES = (0xFFFF, 0xEEEE, 0xDDDD, 0xCCCC)
_DISCHARGE_RANGES = (0xBBBB, 0xAAAA, 0x9999, 0x8888)


@dataclass(frozen=True)
class _Program:
    steps: tuple[str, ...]
    first_direction: str | None
    # (previous, next) one-based recorded steps -> crossed AdvCycle instructions.
    # Step zero is the start of the procedure. Do/Loop/AdvCycle emit no rows.
    transitions: dict[tuple[int, int], int]
    subroutines: dict[int, str]

    @property
    def explicit(self) -> bool:
        return "AdvCycle" in self.steps

    @property
    def cycle_basis(self) -> str:
        if self.explicit:
            return "Recorded program cycle checked against executed AdvCycle transitions"
        if not {"Charge", "Dischrge"}.issubset(self.steps):
            return "Single recording group without a charge/discharge pair"
        first = "charge" if self.first_direction == "C" else "discharge"
        return f"Inferred from the return to {first} after the opposite direction"


@dataclass(frozen=True)
class _Header:
    channel: int  # zero-based in both the channel descriptor and the records
    program: _Program
    current_ranges: tuple[float, ...]
    voltage_min: float
    voltage_max: float
    metadata: dict
    data_start: int
    next_section: int | None
    seed: np.void


def _dates(serial_days: np.ndarray) -> np.ndarray:
    if not (np.isfinite(serial_days) & (serial_days >= 1) & (serial_days < 2958466)).all():
        raise InvalidSourceFormatError("Invalid Maccor local acquisition date.")
    ticks = np.rint(serial_days * 86_400_000).astype("timedelta64[ms]")
    return np.datetime64("1899-12-30", "ms") + ticks


def _cycle_program(steps: tuple[str, ...], subroutines: dict[int, str]) -> _Program:
    if steps[-1] != "End" or "End" in steps[:-1]:
        raise UnsupportedSourceFormatError("Maccor cycle program requires one final End step.")
    first = next((_PROGRAM_MODE[kind] for kind in steps if kind in ("Charge", "Dischrge")), None)
    loop_starts = {}
    opened = None
    for index, kind in enumerate(steps):
        if kind.startswith("Do "):
            if opened is not None:
                raise UnsupportedSourceFormatError("Nested Maccor cycle programs are unsupported.")
            opened = index
        elif kind.startswith("Loop "):
            if opened is None or steps[opened][-1] != kind[-1]:
                raise UnsupportedSourceFormatError("Mismatched loop in Maccor cycle program.")
            body = "".join(_PROGRAM_MODE[k] for k in steps[opened + 1:index] if k in ("Charge", "Dischrge"))
            pattern = "C+D+" if first == "C" else "D+C+"
            if not re.fullmatch(pattern, body) and not re.fullmatch(r"C+|D+", body):
                raise UnsupportedSourceFormatError("Unsupported phase order in Maccor cycle program.")
            loop_starts[index] = opened + 1
            opened = None
    if opened is not None:
        raise UnsupportedSourceFormatError("Unclosed loop in Maccor cycle program.")

    recorded = [i + 1 for i, kind in enumerate(steps) if kind in _PROGRAM_MODE or kind == "SubRout"]
    if not recorded:
        raise UnsupportedSourceFormatError("Maccor cycle program contains no measurement steps.")
    transitions = {}
    for previous in [0, *recorded]:
        pending = [(previous, 0)]
        while pending:
            index, advances = pending.pop()
            kind = steps[index]
            if kind in _PROGRAM_MODE or kind in {"End", "SubRout"}:
                edge = (previous, index + 1)
                if transitions.setdefault(edge, advances) != advances:
                    raise UnsupportedSourceFormatError("Ambiguous AdvCycle path in Maccor cycle program.")
            else:
                if index in loop_starts:
                    pending.append((loop_starts[index], advances))
                pending.append((index + 1, advances + (kind == "AdvCycle")))
    return _Program(steps, first, transitions, subroutines)


def _program_steps(data: bytes, declared_count: int) -> _Program:
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
    subroutines = {}
    for index, (node, kind) in enumerate(zip(nodes, steps)):
        if kind == "SubRout":
            name = (node.findtext("StepValue") or "").strip()
            if not name:
                raise InvalidSourceFormatError("Missing Maccor subroutine name.")
            subroutines[index + 1] = name
        if kind not in _PROGRAM_MODE and kind not in ("End", "AdvCycle", "SubRout") and not re.fullmatch(r"(?:Do|Loop) [1-4]", kind):
            raise UnsupportedSourceFormatError(f"Unsupported Maccor procedure step type: {kind[:32]}.")
        for entry in node.findall("Ends/EndEntry"):
            target = (entry.findtext("Step") or "").strip().lstrip("0")
            if kind.startswith("Loop ") and (entry.findtext("EndType") or "").strip() == "Loop Cnt":
                opener = "Do " + kind[-1]
                if opener in steps[:index] and target == str(max(i for i in range(index) if steps[i] == opener) + 2):
                    continue
            if target != str(index + 2):
                raise UnsupportedSourceFormatError("Maccor procedure uses an unverified step jump.")
    return _cycle_program(steps, subroutines)


def _read_header(stream: BinaryIO) -> _Header:
    base = stream.tell()
    prefix = stream.read(_PREFIX_BYTES)
    if (len(prefix) != _PREFIX_BYTES or prefix[:2] != b"\x00\x00"
            or struct.unpack_from("<I", prefix, 2)[0] != base + _PREFIX_BYTES + 1
            or struct.unpack_from("<H", prefix, 36)[0] != _RECORD.itemsize):
        raise UnsupportedSourceFormatError("Expected a Maccor 4608 binary channel file with 264-byte records.")

    def offset(field: int) -> int:
        # The section directory uses one-based file positions.
        return struct.unpack_from("<I", prefix, field)[0] - 1 - base

    calibration, ranges = offset(2), offset(6)
    instrument = offset(38) if struct.unpack_from("<I", prefix, 38)[0] else ranges
    names, names_end = offset(16), offset(20)
    step_count = struct.unpack_from("<I", prefix, 104)[0]
    procedure = offset(100) + 816 * step_count
    procedure_end, tester, records = offset(150), offset(166), offset(32)
    if (ranges != calibration + 330 or instrument not in (ranges, ranges + 79) or not 2 <= step_count <= 257
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
    snapshot = np.frombuffer(seed, dtype=_RECORD, count=1)[0]
    setup = bytearray(seed)
    if base:
        setup[21:29] = bytes(8)  # continued elapsed time and record number
        setup[230:234] = bytes(4)
    stopped = snapshot["mode"] == 30 and snapshot["end_status"] == 192 and snapshot["record"] > 0
    if seed[8] != channel or (any(setup[9:]) and not stopped):
        raise InvalidSourceFormatError("Maccor setup record does not match its channel descriptor.")
    started = _dates(np.frombuffer(seed, dtype="<f8", count=1))[0]
    program = _program_steps(header[procedure:procedure_end], step_count)
    if stopped and (snapshot["step"] >= len(program.steps)
                    or program.steps[int(snapshot["step"])] not in _PROGRAM_MODE):
        raise InvalidSourceFormatError("Maccor stop snapshot contradicts the programmed step.")

    # The paired export establishes the bipolar voltage and unsigned current
    # conversion for this hardware profile. Other range tables need evidence.
    current_max = struct.unpack_from("<f", header, calibration + 2)[0]
    vmin, vmax = struct.unpack_from("<ff", header, calibration + 322)
    gains = struct.unpack_from("<4d", header, calibration + 106)
    discharge_gains = struct.unpack_from("<4d", header, calibration + 266)
    profiles = {(5.0, -5.0, 5.0, (100000 / 3, 1000.0, 100 / 3, 1.0)),
                (50.0, 0.0, 5.0, (100.0, 10.0, 50000.0, 1.0))}
    if (struct.unpack_from("<f", header, calibration + 162)[0] != current_max
            or gains != discharge_gains or (current_max, vmin, vmax, gains) not in profiles):
        raise UnsupportedSourceFormatError("Unsupported Maccor binary measurement range table.")

    device = header[tester:records].decode("cp1252", errors="replace").strip("\x00 ")
    name_fields = header[names:names_end].decode("cp1252", errors="replace")
    procedure_name, suffix, description = name_fields.partition(".000")
    fields = {"Tester": device, "Model": "4608", "Channel": channel + 1,
              "Procedure": procedure_name + suffix if suffix else None,
              "Description": description if suffix else None, "Step types": list(program.steps),
              "Cycle basis": program.cycle_basis,
              "Current full scale [A]": current_max, "Current range gains": list(gains),
              "Voltage range [V]": [vmin, vmax]}
    declared = build_declared_protocol([], warnings=["Full Maccor procedure settings are unavailable for protocol analysis."])
    metadata = {
        "raw": {"Maccor": fields, DECLARED_PROTOCOL_METADATA_KEY: declared}, "source_format": "Maccor binary",
        "channel": str(channel + 1), "device_info": device, "remarks": fields["Description"],
        "start_time": str(started), "voltage_capabilities": voltage_capabilities(),
        "protocol_warnings": declared["warnings"],
    }
    link = struct.unpack_from("<I", prefix, 46)[0]
    return _Header(channel, program, tuple(current_max / gain for gain in gains), vmin, vmax, metadata,
                   stream.tell(), link - 1 if link else None, snapshot)


def _sections(stream: BinaryIO, size: int):
    channel = None
    previous_snapshot = None
    for _ in range(64):
        header = _read_header(stream)
        if channel is not None and header.channel != channel:
            raise InvalidSourceFormatError("Linked Maccor sections refer to different channels.")
        channel = header.channel
        end = header.next_section if header.next_section is not None else size
        count, tail = divmod(end - header.data_start, _RECORD.itemsize)
        if count < 0 or tail or end > size or (count == 0 and header.seed["mode"] != 30):
            raise InvalidSourceFormatError("Empty or truncated Maccor binary measurement sequence.")
        if previous_snapshot is not None and any(header.seed[key] < previous_snapshot[key]
                                                 for key in ("record", "test_ticks", "date")):
            raise InvalidSourceFormatError("Maccor stop snapshots are out of acquisition order.")
        previous_snapshot = None if count else header.seed
        yield header, count
        if header.next_section is None:
            return
        stream.seek(end)
    raise UnsupportedSourceFormatError("Maccor section directory exceeds the supported chain length.")


def read_header_metadata(path: str | Path) -> dict:
    with Path(path).open("rb") as stream:
        sections = list(_sections(stream, os.fstat(stream.fileno()).st_size))
    meta = sections[0][0].metadata
    if len(sections) > 1:
        meta["raw"]["Maccor"]["Sections"] = [h.metadata["raw"]["Maccor"].copy() for h, _ in sections]
    if not any(count for _, count in sections):
        warning = "This Maccor file contains stop-state snapshots only. No sampled cycle data were recorded."
        meta["raw"]["Maccor"]["Stop snapshots"] = [
            {"Record": int(h.seed["record"]), "Step": int(h.seed["step"]) + 1,
             "Program field": int(h.seed["program_field"]), "Test time [s]": int(h.seed["test_ticks"]) / 100,
             "Step time [s]": int(h.seed["step_ticks"]) / 100, "Local date": h.metadata["start_time"]}
            for h, _ in sections
        ]
        # These timestamps identify stops. The original test start is unknown.
        meta.pop("start_time", None)
        meta["raw"]["capabilities"] = {"metadata_only": True, "canonical_cycling": False}
        meta["raw"]["protocol_warnings"] = meta["protocol_warnings"] = [warning]
    return meta


def _decode(rows: np.ndarray, header: _Header) -> pd.DataFrame:
    field = rows["program_field"]
    if not header.program.explicit and not np.isin(field, (0, 0x03000000)).all():
        raise UnsupportedSourceFormatError("Unsupported Maccor record layout before the step field.")
    mode = pd.Series(rows["mode"]).map(_MODE)
    if mode.isna().any():
        raise UnsupportedSourceFormatError("Unsupported Maccor binary operating mode.")
    step = rows["step"].astype("int64")
    if (rows["channel"] != header.channel).any() or (step >= len(header.program.steps)).any():
        raise InvalidSourceFormatError("Maccor record channel or step contradicts the header.")
    kinds = pd.Series(np.asarray(header.program.steps)[step])
    expected_mode = kinds.map(_PROGRAM_MODE)
    standby = mode.eq("SBw")
    valid_mode = (mode.eq(expected_mode) | (standby & expected_mode.isin(("C", "D")))
                  | (mode.eq("O") & kinds.eq("End")) | (mode.eq("SubRout") & kinds.eq("SubRout"))
                  | (mode.eq("Stop") & (expected_mode.notna() | kinds.eq("SubRout"))))
    if not valid_mode.all():
        raise InvalidSourceFormatError("Maccor record mode contradicts the programmed step.")

    charge, discharge = mode.eq("C"), mode.eq("D")
    flags = rows["range_code"]
    if header.voltage_min == 0 and ((charge & (flags != 0xFFFF)) | (discharge & (flags != 0xBBBB))).any():
        raise UnsupportedSourceFormatError("Unverified active range in the Maccor 50 A profile.")
    if ((charge & ~np.isin(flags, _CHARGE_RANGES)).any() or (discharge & ~np.isin(flags, _DISCHARGE_RANGES)).any()
            or (standby & ~(((flags == 0x2222) & (rows["end_status"] == 195))
                            | ((flags == 0x6666) & (rows["end_status"] == 254)))).any()):
        raise UnsupportedSourceFormatError("Unsupported active Maccor current range code.")
    if (mode.eq("R") & (rows["current"] != 0)).any():
        raise InvalidSourceFormatError("Maccor rest record has a nonzero current count.")
    scales = dict(zip(_CHARGE_RANGES, header.current_ranges))
    scales.update(zip(_DISCHARGE_RANGES, header.current_ranges))
    current = rows["current"] * pd.Series(flags).map(scales) / _ADC_MAX
    voltage_span = (header.voltage_max - header.voltage_min) / _ADC_MAX
    # Accumulators use the first current range and centisecond ticks,
    # even if the instantaneous ADC range changes during a step.
    ah_per_count = header.current_ranges[0] / (_ADC_MAX * 100 * 3600)
    return pd.DataFrame({
        "Rec": rows["record"].astype("int64"), "Step": step + 1, "Md": mode, "ES": rows["end_status"],
        "TestTime": rows["test_ticks"] / 6000.0, "StepTime": rows["step_ticks"] / 6000.0,
        "Current [A]": np.where(charge | discharge, current, 0.0),
        "Voltage [V]": header.voltage_min + rows["voltage"] * voltage_span,
        "Cap. [Ah]": rows["capacity"] * ah_per_count, "Ener. [Wh]": rows["energy"] * (ah_per_count * voltage_span),
        "DPT Time": _dates(rows["date"]), "Program field": field,
    })


def _assign_cycles(table: pd.DataFrame, program: _Program, *, resumed: bool = False) -> None:
    step = table["Step"]
    previous = step.shift(fill_value=0)
    changed = step.ne(previous)
    field = table["Program field"].astype("int64")
    if program.explicit and (field.diff().ne(0) & ~changed).any():
        raise InvalidSourceFormatError("Maccor program counter changed within a recorded step.")
    # Validate each distinct edge once, including transitions across read chunks.
    edges = pd.DataFrame({"previous": previous[changed], "step": step[changed]})
    if program.explicit:
        edges["advance"] = field.diff().fillna(field).loc[changed]
    loop_spans = [(lo, hi) for hi, lo in program.transitions if lo < hi]
    for edge in edges.drop_duplicates().itertuples(index=False):
        expected = program.transitions.get((edge.previous, edge.step))
        if expected is None:
            # A programmed measurement step may have no recorded samples.
            # Polarity inference only uses observed phases. A backward move
            # still requires both step numbers to belong to the same flat loop.
            if not program.explicit and (edge.step > edge.previous or any(
                    lo <= edge.step <= edge.previous <= hi for lo, hi in loop_spans)):
                continue
            raise InvalidSourceFormatError("Recorded Maccor step transition contradicts the procedure.")
        if program.explicit and edge.advance != expected:
            raise InvalidSourceFormatError("Maccor program counter contradicts the executed AdvCycle instructions.")
    active = table["Md"].where(table["Md"].isin(("C", "D")))
    if program.explicit:
        if (active.notna() & field.eq(0)).any():
            raise UnsupportedSourceFormatError("Unsupported active preamble before the first Maccor AdvCycle.")
        table["Cycle P"] = field
        # The neutral preamble belongs to the first plotted group. Keep its
        # original zero in Cycle P. Never add a second advance on polarity.
        table["Cycle C"] = field.clip(lower=1)
    else:
        measured = active.dropna()
        if not resumed and not measured.empty and measured.iloc[0] != program.first_direction:
            raise UnsupportedSourceFormatError("First recorded Maccor direction disagrees with the cycle program.")
        direction = active.ffill()
        opposite = "D" if program.first_direction == "C" else "C"
        table["Cycle C"] = 1 + (direction.eq(program.first_direction) & direction.shift().eq(opposite)).cumsum()


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    segments = []
    snapshots_only = True
    last_record = last_ticks = next_routine = last_date = None
    with Path(path).open("rb") as stream:
        before = os.fstat(stream.fileno())
        for number, (header, count) in enumerate(_sections(stream, before.st_size), 1):
            seed = header.seed
            initial = int(seed["record"])
            if last_record is not None:
                if (initial < last_record or (count and initial != last_record)
                        or int(seed["test_ticks"]) < last_ticks or float(seed["date"]) < last_date):
                    raise InvalidSourceFormatError("Maccor section does not continue the preceding recording.")
            if next_routine is not None:
                name = str(header.metadata["raw"]["Maccor"]["Procedure"] or "").removesuffix(".000")
                if next_routine.casefold() != name.casefold():
                    raise InvalidSourceFormatError("Linked Maccor procedure contradicts the subroutine call.")
                next_routine = None
            if not count:
                last_record, last_ticks, last_date = initial, int(seed["test_ticks"]), float(seed["date"])
                continue
            snapshots_only = False
            if number == 1 and seed["mode"] == 30:
                raise UnsupportedSourceFormatError("Maccor measurements start from an unverified stop snapshot.")
            chunks = []
            for first in range(0, count, 16384):
                length = min(count - first, 16384)
                rows = np.fromfile(stream, dtype=_RECORD, count=length)
                if len(rows) != length:
                    raise OSError("Maccor source changed while reading records.")
                if not np.array_equal(rows["record"], np.arange(initial + first + 1, initial + first + length + 1)):
                    raise InvalidSourceFormatError("Maccor binary record numbers are not consecutive.")
                chunks.append(_decode(rows, header))
                last_record = int(rows["record"][-1])
                last_ticks = int(rows["test_ticks"][-1])
                last_date = float(rows["date"][-1])
            table = pd.concat(chunks, ignore_index=True)
            if table["TestTime"].iloc[0] < int(seed["test_ticks"]) / 6000:
                raise InvalidSourceFormatError("Maccor test clock precedes the section's setup clock.")
            if header.next_section is not None and (table["Md"].iloc[-1], table["ES"].iloc[-1]) != ("Stop", 192):
                raise UnsupportedSourceFormatError("Maccor section link has no verified stop trailer.")
            call = table["Md"].eq("SubRout")
            if call.any():
                # The call and its stop trailer introduce the next embedded procedure.
                tail = table.iloc[-2:]
                if (call.sum() != 1 or list(tail["Md"]) != ["SubRout", "Stop"]
                        or list(tail["ES"]) != [17, 192] or tail["Step"].nunique() != 1
                        or header.next_section is None):
                    raise UnsupportedSourceFormatError("Unsupported Maccor subroutine handoff.")
                next_routine = header.program.subroutines[int(tail["Step"].iloc[0])]
                table = table.iloc[:-2].copy()
                if table.empty:
                    continue
            _assign_cycles(table, header.program, resumed=number > 1)
            raw = canonical_records(table, verify_minute_units=False)
            # Section-local procedures may reuse step numbers and counters. A
            # control record or a restart cannot prove an intervening phase.
            if segments:
                raw["step"] += segments[-1]["step"].iloc[-1]
                raw["cycle"] += segments[-1]["cycle"].iloc[-1]
            raw["acquisition_segment"] = number
            segments.append(raw)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise OSError("Maccor source changed while reading records.")
    if snapshots_only:
        return pd.DataFrame(columns=REQUIRED_CYCLING_COLUMNS)
    if not segments:
        raise UnsupportedSourceFormatError("Maccor file contains no sampled cycling records.")
    result = pd.concat(segments, ignore_index=True)
    if len(segments) == 1:
        result.drop(columns="acquisition_segment", inplace=True)
    return result
