"""Vectorized NewareNDA fast paths and a bounded NDAX preview reader.

NewareNDA parses .ndax record-by-record in Python (millions of
struct.unpack calls) and regenerates cycle numbers with a per-row Python
state machine. Both dominate the runtime on large files. This module
provides numpy-vectorized implementations of exactly two leaf functions

  - NewareNDA.NewareNDAx._read_ndc_5_filetype_1   (the data.ndc record loop)
  - NewareNDA.utils._generate_cycle_number        (BTSDA software cycle numbers)

and installs them with install(). All surrounding logic (file orchestration,
aux channels, merges, dtype casts) remains NewareNDA's own code, so output
is identical by construction everywhere except these two functions — and
those are covered by tests/test_fast_neware.py comparing against the
originals. A separate preview reader selects a bounded cycle window from a
simple v5/type-1 NDAX without materializing every canonical raw row; it is
display-only and never replaces the full parser, validator, or cache builder.
Unfamiliar layouts fall back to the ordinary parser-backed preview.

Set CELLXPLORER_FAST_NDAX=0 to disable.
"""
from __future__ import annotations

import logging
import re
import zlib
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

import NewareNDA.NewareNDA as _nda_mod
import NewareNDA.NewareNDAx as _ndax_mod
import NewareNDA.utils as _utils_mod
from NewareNDA.dicts import multiplier_dict, state_dict

logger = logging.getLogger(__name__)

_ORIG_READ_5_1 = _ndax_mod._read_ndc_5_filetype_1
_ORIG_GEN_CYCLE = _utils_mod._generate_cycle_number

PAGE = 4096
REC = 87
# per-page payload: bytes[125:-56] of each 4096-byte page = 45 records
PAGE_LO, PAGE_HI = 125, PAGE - 56

# field layout of one 87-byte ndc v5 record (matches _bytes_to_list_ndc)
_REC_DTYPE = np.dtype(
    {
        "names": ["valid", "Index", "Cycle", "Step_Index", "Status", "Time",
                   "Voltage", "Current", "Charge_capacity", "Discharge_capacity",
                   "Charge_energy", "Discharge_energy", "Y", "M", "D", "h", "m",
                   "s", "Range"],
        "offsets": [7, 8, 12, 16, 17, 23, 31, 35, 43, 51, 59, 67, 75, 77, 78,
                     79, 80, 81, 82],
        "formats": ["u1", "<u4", "<u4", "u1", "u1", "<u8", "<i4", "<i4", "<i8",
                     "<i8", "<i8", "<i8", "<u2", "u1", "u1", "u1", "u1", "u1",
                     "<i4"],
        "itemsize": REC,
    }
)

_STATUS_LUT = np.array(
    [state_dict.get(code, "") for code in range(256)], dtype=object
)
_KNOWN_STATUS = np.array([code in state_dict for code in range(256)])
_KNOWN_RANGES = np.asarray([int(code) for code in multiplier_dict], dtype="int32")
_CHARGE_STATUS_CODES = np.asarray(
    [
        int(code)
        for code, label in state_dict.items()
        if label in {"CCCV_Chg", "CC_Chg", "CP_Chg"}
    ],
    dtype="uint8",
)
_CYCLE_FLAG_STATUS_CODES = np.asarray(
    [
        int(code)
        for code, label in state_dict.items()
        if label == "SIM"
        or (isinstance(label, str) and "_" in label and label.split("_", 1)[1] == "DChg")
    ],
    dtype="uint8",
)
_CHARGE_PHASE_STATUS_CODES = np.asarray(
    [
        int(code)
        for code, label in state_dict.items()
        if isinstance(label, str) and "Chg" in label and "DChg" not in label
    ],
    dtype="uint8",
)
_DISCHARGE_PHASE_STATUS_CODES = np.asarray(
    [
        int(code)
        for code, label in state_dict.items()
        if isinstance(label, str) and "DChg" in label
    ],
    dtype="uint8",
)
_CHARGE_STATUS_LUT = np.zeros(256, dtype=bool)
_CHARGE_STATUS_LUT[_CHARGE_STATUS_CODES] = True
_CYCLE_FLAG_STATUS_LUT = np.zeros(256, dtype=bool)
_CYCLE_FLAG_STATUS_LUT[_CYCLE_FLAG_STATUS_CODES] = True
_CHARGE_PHASE_STATUS_LUT = np.zeros(256, dtype=bool)
_CHARGE_PHASE_STATUS_LUT[_CHARGE_PHASE_STATUS_CODES] = True
_DISCHARGE_PHASE_STATUS_LUT = np.zeros(256, dtype=bool)
_DISCHARGE_PHASE_STATUS_LUT[_DISCHARGE_PHASE_STATUS_CODES] = True


@dataclass(frozen=True)
class NewareNdaxPreviewRows:
    """Canonical-shaped rows for one display window from a simple NDAX."""

    raw: pd.DataFrame
    cycle_count: int
    time_origin_s: float


@dataclass(frozen=True)
class NewareNdaxCapacityPreview:
    """Full source-local per-cycle capacity and CE preview values."""

    cycles: pd.DataFrame
    cycle_count: int


@dataclass(frozen=True)
class _SimpleNdaxRecords:
    """A bounded view over the supported one-member NDAX record layout."""

    member: bytes
    records: np.ndarray
    valid: np.ndarray
    valid_count: int
    valid_prefix: bool

    def column(self, name: str) -> np.ndarray:
        if self.valid_prefix:
            return self.records[name].reshape(-1)[: self.valid_count]
        return self.records[name][self.valid]


def _read_simple_ndax_records(
    source_path: str | Path,
    *,
    max_member_bytes: int,
) -> _SimpleNdaxRecords | None:
    """Read the one-member layout supported by the selective preview paths."""
    path = Path(source_path)
    if path.suffix.casefold() != ".ndax":
        return None
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if names.count("data.ndc") != 1:
                return None
            if {"data_runInfo.ndc", "data_step.ndc"}.issubset(names):
                return None
            if any(re.search(r".*_(\d+)\.ndc$", name) for name in names):
                return None
            info = archive.getinfo("data.ndc")
            # This selective reader uses a raw DEFLATE stream so it can avoid
            # ZipExtFile's chunk bookkeeping. Keep the same strict layout and
            # decompressed-size bound as the normal reader; unsupported ZIP
            # variants fall back to the authoritative parser.
            if (
                info.file_size > max_member_bytes
                or info.compress_size > max_member_bytes
                or info.compress_type != zipfile.ZIP_DEFLATED
                or info.flag_bits & (0x1 | 0x40)
            ):
                return None
            with open(path, "rb") as handle:
                handle.seek(info.header_offset)
                local_header = handle.read(30)
                if (
                    len(local_header) != 30
                    or local_header[:4] != b"PK\x03\x04"
                    or int.from_bytes(local_header[6:8], "little") != info.flag_bits
                    or int.from_bytes(local_header[8:10], "little") != info.compress_type
                ):
                    return None
                name_length = int.from_bytes(local_header[26:28], "little")
                extra_length = int.from_bytes(local_header[28:30], "little")
                local_name = handle.read(name_length)
                if local_name != b"data.ndc":
                    return None
                if len(handle.read(extra_length)) != extra_length:
                    return None
                member_offset = handle.tell()
                member_end = member_offset + info.compress_size
                if member_end > archive.start_dir:
                    return None
                handle.seek(member_offset)
                compressed = handle.read(info.compress_size)
            if len(compressed) != info.compress_size:
                return None
            inflater = zlib.decompressobj(-15)
            try:
                # max_length is a hard output bound (unlike zlib.decompress's
                # bufsize hint). One extra byte detects an incorrect ZIP size
                # before a malformed stream can expand without limit.
                member = inflater.decompress(compressed, info.file_size + 1)
            except zlib.error:
                return None
            if (
                len(member) != info.file_size
                or not inflater.eof
                or inflater.unconsumed_tail
                or inflater.unused_data
                or zlib.crc32(member) != info.CRC
            ):
                return None
    except (
        OSError,
        RuntimeError,
        NotImplementedError,
        EOFError,
        zipfile.BadZipFile,
        KeyError,
    ):
        return None

    size = len(member)
    n_pages = (size - PAGE) // PAGE
    if (
        size > max_member_bytes
        or size <= PAGE
        or member[0] != 1
        or member[2] != 5
        or (size - PAGE) % PAGE != 0
        or n_pages <= 0
    ):
        return None

    pages = np.frombuffer(member, dtype=np.uint8, count=n_pages * PAGE, offset=PAGE)
    records = pages.reshape(n_pages, PAGE)[:, PAGE_LO:PAGE_HI].view(_REC_DTYPE)
    if records.shape[1] != (PAGE_HI - PAGE_LO) // REC:
        return None
    valid = records["valid"] == 0x55
    flat_valid = valid.reshape(-1)
    valid_count = int(np.count_nonzero(flat_valid))
    if valid_count == 0:
        return None
    valid_prefix = valid_count == flat_valid.size or bool(flat_valid[:valid_count].all())
    return _SimpleNdaxRecords(member, records, valid, valid_count, valid_prefix)


def _cycle_start_rows(status_codes: np.ndarray) -> np.ndarray:
    """Return row offsets where Neware's software-cycle counter increments."""
    if status_codes.size == 0:
        return np.empty(0, dtype="int64")
    charge = _CHARGE_STATUS_LUT[status_codes]
    rising_charge = charge.copy()
    rising_charge[1:] = charge[1:] & ~charge[:-1]
    rising_charge[0] = True
    cycle_events = np.flatnonzero(rising_charge)
    flag_events = np.flatnonzero(_CYCLE_FLAG_STATUS_LUT[status_codes])
    # The reference state machine consumes any discharge/SIM flags since the
    # previous charge edge. Flag counts make that same rule one vectorized
    # search instead of a Python iteration over every event/flag row.
    flags_before = np.searchsorted(flag_events, cycle_events, side="left")
    previous_flags = np.empty_like(flags_before)
    previous_flags[0] = 0
    previous_flags[1:] = flags_before[:-1]
    return cycle_events[flags_before > previous_flags]


def _read_recent_split_ndax_v11(
    source_path: str | Path,
    *,
    cycle_start: int | None,
    cycle_end: int | None,
    recent_cycle_count: int,
    max_member_bytes: int,
) -> NewareNdaxPreviewRows | None:
    """Select a voltage window from the verified split NDC-11 record layout.

    The auxiliary run-info records are sparse. Reconstruct their interpolation
    with the same arithmetic as NewareNDA before selecting the requested
    cycles; doing this on compact columns avoids its wide full-source merge.
    """
    path = Path(source_path)
    data_dtype = np.dtype([("voltage", "<f4"), ("current", "<f4")])
    run_dtype = np.dtype({
        "names": ["time", "charge", "discharge", "dt", "step", "index"],
        "offsets": [0, 5, 9, 29, 37, 41],
        "formats": ["<i4", "<f4", "<f4", "<i4", "<i4", "<i4"],
        "itemsize": 47,
    })
    step_dtype = np.dtype({
        "names": ["step_index", "status"],
        "offsets": [4, 24],
        "formats": ["<i4", "u1"],
        "itemsize": 37,
    })
    members: list[np.ndarray] = []
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            required = ("data.ndc", "data_runInfo.ndc", "data_step.ndc")
            if any(names.count(name) != 1 for name in required):
                return None
            if any(re.search(r".*_(\d+)\.ndc$", name) for name in names):
                return None
            layouts = (
                (required[0], 1, 132, -4, data_dtype),
                (required[1], 18, 132, -16, run_dtype),
                (required[2], 7, 132, -5, step_dtype),
            )
            if sum(archive.getinfo(name).file_size for name in required) > max_member_bytes:
                return None
            for name, kind, first, last, dtype in layouts:
                info = archive.getinfo(name)
                if (info.file_size <= PAGE or info.compress_type != zipfile.ZIP_DEFLATED
                        or info.flag_bits & (0x1 | 0x40)
                        or (info.file_size - PAGE) % PAGE):
                    return None
                with archive.open(info) as stream:
                    member = stream.read(info.file_size + 1)
                    if len(member) != info.file_size or stream.read(1):
                        return None
                if member[0] != kind or member[2] != 11:
                    return None
                pages = np.frombuffer(member, dtype="u1", offset=PAGE).reshape(-1, PAGE)
                payload = pages[:, first:last]
                if payload.shape[1] % dtype.itemsize:
                    return None
                # The fixed page padding is not part of a record. Copy to a
                # compact array so NumPy can view all records without loops.
                members.append(payload.copy().view(dtype).reshape(-1))
    except (OSError, RuntimeError, EOFError, zipfile.BadZipFile, KeyError, ValueError):
        return None

    data, run, steps = members
    valid_data = data["voltage"] != 0
    data_indices = np.flatnonzero(valid_data).astype("int64") + 1
    if not data_indices.size:
        return None
    run = run[run["index"] != 0]
    steps = steps[steps["step_index"] != 0]
    if not run.size or not steps.size:
        return None
    run_indices = run["index"].astype("int64")
    if np.any(np.diff(run_indices) <= 0) or run_indices[0] != data_indices[0]:
        return None
    step_ordinals = np.cumsum(np.r_[True, run["step"][1:] != run["step"][:-1]])
    if int(step_ordinals[-1]) != len(steps):
        return None
    if not _KNOWN_STATUS[steps["status"]].all():
        return None

    # NewareNDA left-joins on Index and forward-fills Step. A missing run-info
    # row inherits the previous step, but its time/capacity is interpolated.
    run_positions = np.searchsorted(run_indices, data_indices)
    exact = (run_positions < run_indices.size) & (run_indices[np.minimum(run_positions, run_indices.size - 1)] == data_indices)
    previous = np.searchsorted(run_indices, data_indices, side="right") - 1
    if np.any(previous < 0):
        return None
    row_steps = step_ordinals[previous].astype("uint32")
    status_codes = steps["status"][row_steps - 1]
    cycle_starts = _cycle_start_rows(status_codes)
    cycle_count = int(len(cycle_starts) + 1)
    if cycle_start is None and cycle_end is None:
        requested_start = max(1, cycle_count - max(1, int(recent_cycle_count)) + 1)
        requested_end = cycle_count
    else:
        requested_start = max(1, int(cycle_start or 1))
        requested_end = max(requested_start, int(cycle_end or requested_start))
    row_start = 0 if requested_start <= 1 else int(cycle_starts[min(requested_start - 2, len(cycle_starts) - 1)]) if requested_start <= cycle_count else len(data_indices)
    row_end = len(data_indices) if requested_end >= cycle_count else int(cycle_starts[requested_end - 1])
    if row_end < row_start:
        row_end = row_start

    # Match NewareNDA._data_interpolation on the necessary columns. Building
    # the compact numeric frame is much cheaper than decoding timestamps,
    # energies, metadata, and auxiliary channels for every source row.
    time_s = np.full(len(data_indices), np.nan, dtype="float64")
    dt_s = np.full(len(data_indices), np.nan, dtype="float64")
    charge = np.full(len(data_indices), np.nan, dtype="float64")
    discharge = np.full(len(data_indices), np.nan, dtype="float64")
    matched = run_positions[exact]
    time_s[exact] = run["time"][matched] / 1000.0
    dt_s[exact] = run["dt"][matched] / 1000.0
    charge[exact] = run["charge"][matched].astype("float64") / 3600.0
    discharge[exact] = run["discharge"][matched].astype("float64") / 3600.0
    frame = pd.DataFrame({
        "Time": time_s,
        "dt": dt_s,
        "Charge_Capacity(mAh)": charge,
        "Discharge_Capacity(mAh)": discharge,
        "Current(mA)": data["current"][valid_data].astype("float64"),
    })
    if not exact.all():
        valid_time = frame["Time"].notnull()
        groups = valid_time.cumsum().shift(fill_value=0)
        frame["dt"] = frame["dt"].ffill()
        time_inc = frame["dt"].groupby(groups).cumsum() * ~valid_time
        frame["Time"] = frame["Time"].ffill() + time_inc
        capacity_inc = (frame["dt"] * frame["Current(mA)"] / 3600).groupby(groups).cumsum() * ~valid_time
        frame["Charge_Capacity(mAh)"] = frame["Charge_Capacity(mAh)"].ffill().abs() + capacity_inc.clip(lower=0).abs()
        frame["Discharge_Capacity(mAh)"] = frame["Discharge_Capacity(mAh)"].ffill().abs() + capacity_inc.clip(upper=0).abs()
    selected_cycles = np.searchsorted(cycle_starts, np.arange(row_start, row_end), side="right") + 1
    selected = pd.DataFrame({
        "record_index": data_indices[row_start:row_end].astype("uint32"),
        "cycle": selected_cycles.astype("uint32"),
        "step": row_steps[row_start:row_end],
        "status": _STATUS_LUT[status_codes[row_start:row_end]],
        "time_s": frame["Time"].iloc[row_start:row_end].to_numpy(dtype="float32"),
        "voltage_v": (data["voltage"][valid_data][row_start:row_end].astype("float64") / 10000.0).astype("float32"),
        "current_ma": frame["Current(mA)"].iloc[row_start:row_end].to_numpy(dtype="float32"),
        "charge_capacity_mah": frame["Charge_Capacity(mAh)"].iloc[row_start:row_end].to_numpy(dtype="float32"),
        "discharge_capacity_mah": frame["Discharge_Capacity(mAh)"].iloc[row_start:row_end].to_numpy(dtype="float32"),
    })
    return NewareNdaxPreviewRows(selected, cycle_count, float(np.float32(frame["Time"].iloc[0])))


def read_recent_ndax_raw_for_preview(
    source_path: str | Path,
    *,
    cycle_start: int | None = None,
    cycle_end: int | None = None,
    recent_cycle_count: int = 20,
    max_member_bytes: int = 256 * 1024 * 1024,
) -> NewareNdaxPreviewRows | None:
    """Read only the requested rows needed for a simple v5/1 NDAX preview.

    ZIP still has to inflate the complete ``data.ndc`` member because it is a
    single DEFLATE stream. This avoids NewareNDA's wide DataFrame and the
    subsequent full-row preview preparation by viewing records in place and
    gathering only the requested cycles. Full parsing and cache preparation
    remain separate, authoritative work.

    Return ``None`` when NewareNDA merges auxiliary/split NDC members or when
    the record, status, or range layout is unfamiliar. The caller then uses
    the normal parser-backed preview once its cache is ready.
    """
    decoded = _read_simple_ndax_records(
        source_path,
        max_member_bytes=max_member_bytes,
    )
    if decoded is None:
        return _read_recent_split_ndax_v11(
            source_path,
            cycle_start=cycle_start,
            cycle_end=cycle_end,
            recent_cycle_count=recent_cycle_count,
            max_member_bytes=max_member_bytes,
        )
    records = decoded.records
    valid_flat = (
        np.arange(decoded.valid_count, dtype="int64")
        if decoded.valid_prefix
        else np.flatnonzero(decoded.valid.reshape(-1))
    )
    status_codes = decoded.column("Status")
    if not _KNOWN_STATUS[status_codes].all():
        return None
    range_codes = decoded.column("Range")
    range_changes = np.empty(range_codes.size, dtype=bool)
    range_changes[0] = True
    np.not_equal(range_codes[1:], range_codes[:-1], out=range_changes[1:])
    if not np.isin(np.unique(range_codes[range_changes]), _KNOWN_RANGES).all():
        return None

    # Match NewareNDA's default software-cycle mode, but walk only the
    # charge/discharge/SIM event rows rather than all ~500k records.
    cycle_starts = _cycle_start_rows(status_codes)

    row_count = decoded.valid_count
    cycle_count = int(len(cycle_starts) + 1)
    if cycle_start is None and cycle_end is None:
        requested_start = max(1, cycle_count - max(1, int(recent_cycle_count)) + 1)
        requested_end = cycle_count
    else:
        requested_start = max(1, int(cycle_start or 1))
        requested_end = max(requested_start, int(cycle_end or requested_start))

    if requested_start > cycle_count or requested_end < 1:
        row_start = row_end = row_count
    else:
        row_start = 0 if requested_start <= 1 else cycle_starts[requested_start - 2]
        row_end = (
            row_count
            if requested_end >= cycle_count
            else cycle_starts[requested_end - 1]
        )

    selected_flat = valid_flat[row_start:row_end]
    page_slots = records.shape[1]
    page_indices, slot_indices = np.divmod(selected_flat, page_slots)
    selected = records[page_indices, slot_indices]
    selected_cycles = (
        np.searchsorted(
            cycle_starts,
            np.arange(row_start, row_end, dtype="int64"),
            side="right",
        )
        + 1
    )

    all_record_indices = decoded.column("Index")
    origin_position = int(np.argmin(all_record_indices))
    origin_flat = int(valid_flat[origin_position])
    origin_page, origin_slot = divmod(origin_flat, page_slots)
    time_origin_s = float(
        np.float32(np.float64(records["Time"][origin_page, origin_slot]) / 1000.0)
    )

    order = np.argsort(selected["Index"], kind="stable")
    selected = selected[order]
    selected_cycles = selected_cycles[order]
    unique_ranges, range_inverse = np.unique(selected["Range"], return_inverse=True)
    multipliers = np.asarray(
        [multiplier_dict[int(code)] for code in unique_ranges], dtype="float64"
    )[range_inverse]
    status = selected["Status"]

    # NewareNDA applies dtype_dict after parsing; match its float32 rounding
    # before the shared preview formatter performs time/capacity math.
    raw = pd.DataFrame(
        {
            "record_index": selected["Index"].astype("uint32"),
            "cycle": selected_cycles.astype("uint32"),
            "status": _STATUS_LUT[status],
            "time_s": (selected["Time"].astype("float64") / 1000.0).astype("float32"),
            "voltage_v": (selected["Voltage"].astype("float64") / 10000.0).astype("float32"),
            "current_ma": (selected["Current"].astype("float64") * multipliers).astype("float32"),
            "charge_capacity_mah": (
                selected["Charge_capacity"].astype("float64") * multipliers / 3600.0
            ).astype("float32"),
            "discharge_capacity_mah": (
                selected["Discharge_capacity"].astype("float64") * multipliers / 3600.0
            ).astype("float32"),
        }
    )
    return NewareNdaxPreviewRows(raw, cycle_count, time_origin_s)


def read_ndax_capacity_ce_for_preview(
    source_path: str | Path,
    *,
    max_member_bytes: int = 256 * 1024 * 1024,
) -> NewareNdaxCapacityPreview | None:
    """Calculate exact full-range Neware capacity and CE points for display.

    The NDAX stores cumulative per-record capacity counters, not the final
    per-cycle capacity/CE summary. This reduces only those stored counters
    directly from a simple v5/type-1 record stream. The canonical full parser
    and scientific cache builder remain authoritative and run independently.
    """
    decoded = _read_simple_ndax_records(
        source_path,
        max_member_bytes=max_member_bytes,
    )
    if decoded is None:
        return None
    status_codes = decoded.column("Status")
    ranges = decoded.column("Range")
    if not _KNOWN_STATUS[status_codes].all():
        return None
    row_count = decoded.valid_count
    range_changes = np.empty(row_count, dtype=bool)
    range_changes[0] = True
    np.not_equal(ranges[1:], ranges[:-1], out=range_changes[1:])
    range_run_starts = np.flatnonzero(range_changes)
    unique_ranges = np.unique(ranges[range_run_starts])
    if not np.isin(unique_ranges, _KNOWN_RANGES).all():
        return None

    # NewareNDA's public raw stream is in record order. The direct preview
    # requires that to agree with increasing Index so the same run boundaries
    # and stable group accumulation are used.
    record_indices = decoded.column("Index")
    if len(record_indices) > 1 and not np.all(record_indices[1:] > record_indices[:-1]):
        return None

    cycle_starts = _cycle_start_rows(status_codes)
    cycle_count = len(cycle_starts) + 1
    step_index = decoded.column("Step_Index")
    group_breaks = np.empty(row_count, dtype=bool)
    group_breaks[0] = True
    np.not_equal(step_index[1:], step_index[:-1], out=group_breaks[1:])
    group_breaks[cycle_starts] = True
    group_starts = np.flatnonzero(group_breaks)
    group_cycles = np.searchsorted(cycle_starts, group_starts, side="right") + 1
    cycle_group_starts = np.flatnonzero(
        np.r_[True, group_cycles[1:] != group_cycles[:-1]]
    )
    if not np.array_equal(group_cycles[cycle_group_starts], np.arange(1, cycle_count + 1)):
        return None

    if np.any(unique_ranges == 0):
        # A zero multiplier can create signed-zero edge cases, so retain the
        # established per-row float32 reduction for this uncommon layout.
        unique_value_ranges, range_inverse = np.unique(ranges, return_inverse=True)
        multipliers = np.asarray(
            [multiplier_dict[int(code)] for code in unique_value_ranges],
            dtype="float64",
        )[range_inverse]

        def phase_capacity_sum(field: str, phase_lut: np.ndarray) -> np.ndarray:
            values = (
                decoded.column(field).astype("float64") * multipliers / 3600.0
            ).astype("float32")
            phase = phase_lut[status_codes]
            group_min = np.minimum.reduceat(
                np.where(phase, values, np.float32(np.inf)), group_starts
            )
            group_max = np.maximum.reduceat(
                np.where(phase, values, np.float32(-np.inf)), group_starts
            )
            deltas = (group_max - group_min).astype("float32")
            deltas = np.where(
                np.isfinite(deltas),
                np.maximum(deltas, np.float32(0.0)),
                np.float32(0.0),
            ).astype("float32")
            per_cycle = np.add.reduceat(
                deltas.astype("float64"), cycle_group_starts
            ).astype("float32")
            return per_cycle.astype("float64")

    else:
        # Capacity counters are monotonic within each constant (cycle, step,
        # range) run. Convert only each run's extrema, preserving the exact
        # float32 rounding while avoiding a full-frame float conversion.
        if unique_ranges.size == 1:
            sub_starts = group_starts
            sub_multipliers = np.full(
                len(sub_starts),
                float(multiplier_dict[int(unique_ranges[0])]),
                dtype="float64",
            )
        else:
            sub_starts = np.flatnonzero(group_breaks | range_changes)
            range_values = np.asarray(unique_ranges, dtype="int64")
            range_multipliers = np.asarray(
                [multiplier_dict[int(code)] for code in range_values],
                dtype="float64",
            )
            sub_multipliers = range_multipliers[
                np.searchsorted(range_values, ranges[sub_starts])
            ]
        group_in_subrun = np.searchsorted(sub_starts, group_starts)
        minimum_counter = np.iinfo(np.int64).max
        maximum_counter = np.iinfo(np.int64).min
        positive_infinity = np.float32(np.inf)

        def phase_capacity_sum(field: str, phase_lut: np.ndarray) -> np.ndarray:
            counters = decoded.column(field)
            phase = phase_lut[status_codes]
            sub_min = np.minimum.reduceat(
                np.where(phase, counters, minimum_counter), sub_starts
            )
            sub_max = np.maximum.reduceat(
                np.where(phase, counters, maximum_counter), sub_starts
            )
            has_phase = np.logical_or.reduceat(phase, sub_starts)
            sub_min_float = np.where(
                has_phase,
                (sub_min.astype("float64") * sub_multipliers / 3600.0).astype("float32"),
                positive_infinity,
            )
            sub_max_float = np.where(
                has_phase,
                (sub_max.astype("float64") * sub_multipliers / 3600.0).astype("float32"),
                -positive_infinity,
            )
            group_min = np.minimum.reduceat(sub_min_float, group_in_subrun)
            group_max = np.maximum.reduceat(sub_max_float, group_in_subrun)
            deltas = (group_max - group_min).astype("float32")
            deltas = np.where(
                np.isfinite(deltas),
                np.maximum(deltas, np.float32(0.0)),
                np.float32(0.0),
            ).astype("float32")
            per_cycle = np.add.reduceat(
                deltas.astype("float64"), cycle_group_starts
            ).astype("float32")
            return per_cycle.astype("float64")

    charge_capacity = phase_capacity_sum("Charge_capacity", _CHARGE_PHASE_STATUS_LUT)
    discharge_capacity = phase_capacity_sum(
        "Discharge_capacity", _DISCHARGE_PHASE_STATUS_LUT
    )
    efficiency = np.divide(
        discharge_capacity,
        charge_capacity,
        out=np.full(cycle_count, np.nan, dtype="float64"),
        where=charge_capacity != 0,
    ) * 100.0
    cycles_frame = pd.DataFrame(
        {
            "cycle": np.arange(1, cycle_count + 1, dtype="int64"),
            "charge_capacity_mah": charge_capacity,
            "discharge_capacity_mah": discharge_capacity,
            "coulombic_efficiency_pct": efficiency,
        }
    )
    return NewareNdaxCapacityPreview(cycles_frame, cycle_count)


def _fast_read_ndc_5_filetype_1(mm):
    """Vectorized replacement for the per-record struct.unpack loop."""
    size = mm.size() if hasattr(mm, "size") else len(mm)
    n_pages = (size - PAGE) // PAGE
    if n_pages <= 0 or (size - PAGE) % PAGE != 0:
        # partial trailing page — original semantics are subtle, delegate
        return _ORIG_READ_5_1(mm)

    pages = np.frombuffer(mm, dtype=np.uint8, count=n_pages * PAGE, offset=PAGE)
    payload = pages.reshape(n_pages, PAGE)[:, PAGE_LO:PAGE_HI]  # (pages, 45*87)
    # The page payload is strided by the page size, but its last dimension is
    # already a whole number of records.  Viewing it directly avoids copying
    # every record into a second ~40-50 MB allocation before filtering.
    recs = payload.view(_REC_DTYPE).reshape(-1)
    recs = recs[recs["valid"] == 0x55]

    status_codes = recs["Status"]
    ranges = recs["Range"]
    if not _KNOWN_STATUS[status_codes].all() or not np.isin(
        np.unique(ranges), np.array(list(multiplier_dict))
    ).all():
        # Release every view backed by the mmap before the original decoder
        # runs.  This keeps the fallback byte-identical while allowing a
        # caller that owns the mmap to close it even when the original raises
        # for an unknown status or range.
        del pages, payload, recs, status_codes, ranges
        return _ORIG_READ_5_1(mm)  # unknown code → original raises its KeyError

    uniq_ranges, inverse = np.unique(ranges, return_inverse=True)
    multiplier = np.array([multiplier_dict[r] for r in uniq_ranges])[inverse]

    # timestamps: numpy datetime arithmetic instead of datetime() per row
    ts = (
        (recs["Y"].astype("int64") - 1970).astype("M8[Y]")
        + (recs["M"].astype("int64") - 1).astype("m8[M]")
        + (recs["D"].astype("int64") - 1).astype("m8[D]")
        + recs["h"].astype("m8[h]")
        + recs["m"].astype("m8[m]")
        + recs["s"].astype("m8[s]")
    ).astype("M8[us]")

    # dtypes chosen to match what pandas infers from the original's Python
    # lists (ints → int64, floats → float64, str objects, datetime64[us])
    df = pd.DataFrame(
        {
            "Index": recs["Index"].astype("int64"),
            "Cycle": recs["Cycle"].astype("int64") + 1,
            "Step_Index": recs["Step_Index"].astype("int64"),
            "Status": pd.Series(_STATUS_LUT[status_codes]),
            "Time": recs["Time"].astype("float64") / 1000,
            "Voltage": recs["Voltage"].astype("float64") / 10000,
            "Current(mA)": recs["Current"].astype("float64") * multiplier,
            "Charge_Capacity(mAh)": recs["Charge_capacity"].astype("float64") * multiplier / 3600,
            "Discharge_Capacity(mAh)": recs["Discharge_capacity"].astype("float64") * multiplier / 3600,
            "Charge_Energy(mWh)": recs["Charge_energy"].astype("float64") * multiplier / 3600,
            "Discharge_Energy(mWh)": recs["Discharge_energy"].astype("float64") * multiplier / 3600,
            "Timestamp": pd.Series(ts),
        }
    )
    df["Step"] = _utils_mod._count_changes(df["Step_Index"])
    return df


def _fast_generate_cycle_number(df, cycle_mode="chg"):
    """Vectorized replacement for the per-row cycle-count state machine.

    Original semantics: walking rows in order, the cycle number increments
    at the START of an incremental (charge, by default) step, but only if a
    'flag' was raised since the previous increment; the flag is raised by
    any opposite-direction (discharge) row or any SIM row. We reproduce
    this exactly by extracting the event rows vectorized and walking only
    the events (hundreds) instead of the rows (millions).
    """
    if cycle_mode.lower() == "auto":
        cycle_mode = _utils_mod._id_first_state(df)

    if cycle_mode.lower() == "chg":
        inkey, offkey = "Chg", "DChg"
    elif cycle_mode.lower() == "dchg":
        inkey, offkey = "DChg", "Chg"
    else:
        logger.error(
            f"Cycle_Mode '{cycle_mode}' not recognized. Supported options are 'chg', 'dchg', and 'auto'."
        )
        raise KeyError(
            f"Cycle_Mode '{cycle_mode}' not recognized. Supported options are 'chg', 'dchg', and 'auto'."
        )

    status = df["Status"]
    n = len(status)
    if n == 0:
        return np.array([], dtype="int64")

    # rising edges of incremental steps ((inc - inc.shift()).clip(0), [0]=1)
    inc_bool = status.isin([f"CCCV_{inkey}", f"CC_{inkey}", f"CP_{inkey}"]).to_numpy()
    rising = inc_bool.copy()
    rising[1:] = inc_bool[1:] & ~inc_bool[:-1]
    rising[0] = True

    # flag-raising rows: split-state == offkey, or SIM
    uniq = pd.unique(status)
    off_statuses = [
        u for u in uniq if isinstance(u, str) and "_" in u and u.split("_", 1)[1] == offkey
    ]
    flag_bool = status.isin(off_statuses).to_numpy() | (status == "SIM").to_numpy()

    inc_idx = np.flatnonzero(rising)
    flag_idx = np.flatnonzero(flag_bool)

    # walk events only: increment at a rising edge iff a flag was raised
    # since the last increment (flag events never share a row with a rising
    # edge — those rows carry the inkey status)
    bumps = []
    fptr = 0
    has_flag = False
    n_flags = len(flag_idx)
    for i in inc_idx:
        while fptr < n_flags and flag_idx[fptr] < i:
            has_flag = True
            fptr += 1
        if has_flag:
            bumps.append(i)
            has_flag = False

    cyc = np.zeros(n, dtype="int64")
    cyc[np.asarray(bumps, dtype="int64")] = 1
    return np.cumsum(cyc) + 1


def install() -> None:
    """Install the fast paths into NewareNDA (idempotent)."""
    if _ndax_mod._read_ndc_5_filetype_1 is _fast_read_ndc_5_filetype_1:
        return
    _ndax_mod._read_ndc_5_filetype_1 = _fast_read_ndc_5_filetype_1
    # _generate_cycle_number was imported by value into both entry modules
    _utils_mod._generate_cycle_number = _fast_generate_cycle_number
    _ndax_mod._generate_cycle_number = _fast_generate_cycle_number
    _nda_mod._generate_cycle_number = _fast_generate_cycle_number
    logger.info("NewareNDA fast paths installed")


def uninstall() -> None:
    _ndax_mod._read_ndc_5_filetype_1 = _ORIG_READ_5_1
    _utils_mod._generate_cycle_number = _ORIG_GEN_CYCLE
    _ndax_mod._generate_cycle_number = _ORIG_GEN_CYCLE
    _nda_mod._generate_cycle_number = _ORIG_GEN_CYCLE
