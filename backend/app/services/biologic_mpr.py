"""Independent low-level reader for the supported BioLogic MPR container.

This module deliberately stops at the binary container and VMP data-block
boundary.  GCPL semantics, protocol reconstruction, and user-facing source
recognition belong to later Spec 041 children.

The supported layout is the one independently observed in the supplied
GCPL6 sample and recorded in ``docs/biologic-mpr-format.md`` plus compatible
layouts whose ordinary columns can be located from the project-owned storage
registry. Full source encoded IDs remain evidence; ordinary storage resolves
through ``encoded_id % 256``. Unknown widths fail closed unless they form a
strict trailing opaque suffix after every required GCPL field has been found.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import mmap
import os
from pathlib import Path
import struct
from typing import BinaryIO

import numpy as np

from .source_format_errors import (
    InvalidSourceFormatError,
    SourceFormatError,
    UnsupportedSourceFormatError,
)


MPR_READER_REVISION = 2
MPR_INITIAL_HEADER_SIZE = 52
MPR_MODULE_HEADER_SIZE = 65
MPR_MODULE_MARKER = b"MODULE"
MPR_MAGIC_PREFIX = b"BIO-LOGIC MODULAR FILE\x1a"
MPR_MAGIC = MPR_MAGIC_PREFIX + (b" " * 25) + (b"\x00" * 4)

# These bounds protect the low-level reader from turning declarations in an
# untrusted local file into an unbounded object graph.  The file-size limit is
# deliberately generous for desktop scientific data while remaining finite;
# larger files are an unsupported input for this reader revision.
MPR_MAX_FILE_SIZE = 8 * 1024**3
MPR_MAX_MODULE_COUNT = 32
MPR_MAX_COLUMNS = 64
MPR_MAX_RECORD_STRIDE = 1024 * 1024

VMP_SET_VERSION = 10
VMP_DATA_VERSION = 11
VMP_LOG_VERSION = 10
VMP_DATA_HEADER_SIZE = 37
VMP_DATA_RECORD_OFFSET = 1007
VMP_DATA_RECORD_ITEMSIZE = 53  # independently verified baseline, not a global decoder stride

# These are the encoded column identifiers observed in the supported GCPL6
# layout.  The byte order is independently established as big-endian uint16.
SUPPORTED_GCPL_COLUMN_IDS = (
    1,
    2,
    3,
    21,
    31,
    65,
    131,
    4,
    7,
    13,
    5,
    6,
    9,
    39,
    211,
    468,
)
SUPPORTED_GCPL_COLUMN_ID_SET = frozenset(SUPPORTED_GCPL_COLUMN_IDS)
# These fields are needed by the canonical GCPL adapter for the independently
# observed three-electrode record.  The reader does not infer a compact
# two-electrode record by removing an unverified field.
REQUIRED_GCPL_COLUMN_IDS = (
    1,
    131,
    4,
    7,
    5,
    6,
    211,
    468,
)
REQUIRED_GCPL_BASE_IDS = (131, 4, 7, 5, 6, 211, 212)
MPR_PHYSICAL_COLUMN_IDS = (1, 131, 4, 7, 13, 5, 6, 9, 39, 211, 468)


@dataclass(frozen=True)
class MprFlagDefinition:
    """One logical flag extracted from the packed raw flags byte."""

    name: str
    mask: int
    shift: int
    boolean: bool
    encoded_id: int = 1


MPR_FLAG_DEFINITIONS = (
    MprFlagDefinition("mode", 0x03, 0, False, 1),
    MprFlagDefinition("oxidation_reduction", 0x04, 2, True, 2),
    MprFlagDefinition("error", 0x08, 3, True, 3),
    MprFlagDefinition("control_changed", 0x10, 4, True, 21),
    MprFlagDefinition("ns_changed", 0x20, 5, True, 31),
    MprFlagDefinition("counter_incremented", 0x80, 7, True, 65),
)


@dataclass(frozen=True)
class MprStorageDefinition:
    """Project-owned binary storage facts for one ordinary base column."""

    base_id: int
    dtype: str
    byte_width: int
    label: str
    unit: str | None = None
    field_name: str | None = None
    note: str = ""


MPR_RECORD_FIELD_NAMES = {
    4: "elapsed_time_s",
    5: "raw_control_v_or_mA",
    6: "raw_ewe_v",
    7: "raw_dq_mAh",
    9: "raw_ece_v",
    13: "raw_q_minus_q0_mAh",
    39: "raw_current_range_code",
    131: "raw_sample_index",
    211: "raw_q_charge_discharge_mAh",
    212: "raw_half_cycle_index",
}


def _storage(
    base_id: int,
    dtype: str,
    label: str,
    unit: str | None = None,
    *,
    note: str = "",
) -> MprStorageDefinition:
    normalized = np.dtype(dtype)
    return MprStorageDefinition(
        base_id=base_id,
        dtype=dtype,
        byte_width=normalized.itemsize,
        label=label,
        unit=unit,
        field_name=MPR_RECORD_FIELD_NAMES.get(base_id),
        note=note,
    )


# This is the production copy of the 100 ordinary storage definitions in
# docs/specs/assets/051-biologic-mpr-column-registry.md.  It intentionally
# contains storage facts only; labels and units never promote a field into
# canonical cycling output.
MPR_STORAGE_REGISTRY = {
    definition.base_id: definition
    for definition in (
        _storage(4, "<f8", "Elapsed time", "s"),
        _storage(5, "<f4", "Control value", "V or mA"),
        _storage(6, "<f4", "Working-electrode potential / technique-dependent potential", "V"),
        _storage(7, "<f8", "Incremental charge", "mA·h"),
        _storage(8, "<f4", "Current", "mA"),
        _storage(9, "<f4", "Counter-electrode potential", "V"),
        _storage(11, "<f8", "Mean current", "mA"),
        _storage(13, "<f8", "Charge relative to origin", "mA·h"),
        _storage(15, "<f4", "Phase of Z1", "deg"),
        _storage(16, "<f4", "Analog input 1", "V"),
        _storage(17, "<f4", "Analog input 2", "V"),
        _storage(19, "<f4", "Voltage control value", "V"),
        _storage(20, "<f4", "Current control value", "mA"),
        _storage(23, "<f8", "Charge increment", "mA·h"),
        _storage(24, "<f8", "Cycle number"),
        _storage(32, "<f4", "Frequency", "Hz"),
        _storage(33, "<f4", "Working-electrode voltage magnitude", "V"),
        _storage(34, "<f4", "Current magnitude", "A"),
        _storage(35, "<f4", "Impedance phase", "deg"),
        _storage(36, "<f4", "Impedance magnitude", "Ω"),
        _storage(37, "<f4", "Real impedance", "Ω"),
        _storage(38, "<f4", "Negative imaginary impedance", "Ω"),
        _storage(39, "<u2", "Current-range code"),
        _storage(45, "<f4", "Z1 magnitude", "Ω"),
        _storage(46, "<f4", "Z2 magnitude", "Ω"),
        _storage(69, "<f4", "Working-electrode resistance", "Ω"),
        _storage(70, "<f4", "Working-electrode power", "W"),
        _storage(74, "<f8", "Energy magnitude", "W·h"),
        _storage(75, "<f4", "Analog output", "V"),
        _storage(76, "<f4", "Mean current", "mA"),
        _storage(77, "<f4", "Mean working-electrode potential", "V"),
        _storage(78, "<f4", "Inverse-square series capacitance", "µF⁻²"),
        _storage(96, "<f4", "Counter-electrode voltage magnitude", "V"),
        _storage(98, "<f4", "Counter-electrode impedance phase", "deg"),
        _storage(99, "<f4", "Counter-electrode impedance magnitude", "Ω"),
        _storage(100, "<f4", "Counter-electrode real impedance", "Ω"),
        _storage(101, "<f4", "Counter-electrode negative imaginary impedance", "Ω"),
        _storage(105, "<f4", "Negative imaginary Z1", "Ω"),
        _storage(106, "<f4", "Negative imaginary Z2", "Ω"),
        _storage(110, "<f8", "Counter-electrode energy", "W·h"),
        _storage(112, "<f8", "Working-electrode energy", "W·h"),
        _storage(115, "<f8", "Counter-electrode charge energy", "W·h"),
        _storage(116, "<f8", "Counter-electrode discharge energy", "W·h"),
        _storage(123, "<f8", "Working-electrode charge energy", "W·h"),
        _storage(124, "<f8", "Working-electrode discharge energy", "W·h"),
        _storage(125, "<f8", "Charge capacitance", "µF"),
        _storage(126, "<f8", "Discharge capacitance", "µF"),
        _storage(131, "<u2", "Sequence / Ns index"),
        _storage(135, "<f4", "Mean E1 potential", "V"),
        _storage(136, "<f4", "Mean E2 potential", "V"),
        _storage(163, "<f4", "Stack-voltage magnitude", "V"),
        _storage(166, "<f4", "Stack-impedance phase", "deg"),
        _storage(167, "<f4", "Stack-impedance magnitude", "Ω"),
        _storage(168, "<f4", "Compensation resistance", "Ω"),
        _storage(169, "<f4", "Series capacitance", "µF"),
        _storage(172, "<f4", "Parallel capacitance", "µF"),
        _storage(173, "<f4", "Inverse-square parallel capacitance", "µF⁻²"),
        _storage(174, "<f4", "Context-dependent mean working potential / impedance phase", "V or deg"),
        _storage(175, "<f4", "Working-to-counter impedance magnitude", "Ω"),
        _storage(176, "<f4", "Working-to-counter real impedance", "Ω"),
        _storage(177, "<f4", "Working-to-counter negative imaginary impedance", "Ω"),
        _storage(178, "<f4", "Charge relative to origin", "C"),
        _storage(179, "<f4", "Charge increment", "C"),
        _storage(182, "<f8", "Step elapsed time", "s"),
        _storage(185, "<f4", "Mean counter-electrode potential", "V"),
        _storage(206, "<f4", "Temperature", "°C"),
        _storage(211, "<f8", "Charge/discharge quantity", "source/technique dependent"),
        _storage(212, "<u4", "Half-cycle index"),
        _storage(213, "<u4", "Z-cycle index"),
        _storage(215, "<f4", "Mean counter-electrode potential", "V"),
        _storage(217, "<f4", "Working-potential total harmonic distortion", "%"),
        _storage(218, "<f4", "Current total harmonic distortion", "%"),
        _storage(219, "<f4", "Counter-potential total harmonic distortion", "%"),
        _storage(220, "<f4", "Working-potential noise spectral density", "%"),
        _storage(221, "<f4", "Current noise spectral density", "%"),
        _storage(222, "<f4", "Counter-potential noise spectral density", "%"),
        _storage(223, "<f4", "Working-potential noise-to-response ratio", "%"),
        _storage(224, "<f4", "Current noise-to-response ratio", "%"),
        _storage(225, "<f4", "Counter-potential noise-to-response ratio", "%"),
        _storage(230, "<f4", "Working-potential harmonic 2 magnitude", "V"),
        _storage(231, "<f4", "Working-potential harmonic 3 magnitude", "V"),
        _storage(232, "<f4", "Working-potential harmonic 4 magnitude", "V"),
        _storage(233, "<f4", "Working-potential harmonic 5 magnitude", "V"),
        _storage(234, "<f4", "Working-potential harmonic 6 magnitude", "V"),
        _storage(235, "<f4", "Working-potential harmonic 7 magnitude", "V"),
        _storage(236, "<f4", "Current harmonic 2 magnitude", "A"),
        _storage(237, "<f4", "Current harmonic 3 magnitude", "A"),
        _storage(238, "<f4", "Current harmonic 4 magnitude", "A"),
        _storage(239, "<f4", "Current harmonic 5 magnitude", "A"),
        _storage(240, "<f4", "Current harmonic 6 magnitude", "A"),
        _storage(241, "<f4", "Current harmonic 7 magnitude", "A"),
        _storage(242, "<f4", "Counter-potential harmonic 2 magnitude", "V"),
        _storage(243, "<f4", "Counter-potential harmonic 3 magnitude", "V"),
        _storage(244, "<f4", "Counter-potential harmonic 4 magnitude", "V"),
        _storage(245, "<f4", "Counter-potential harmonic 5 magnitude", "V"),
        _storage(246, "<f4", "Counter-potential harmonic 6 magnitude", "V"),
        _storage(247, "<f4", "Counter-potential harmonic 7 magnitude", "V"),
        _storage(248, "<f4", "AC resistance", "Ω"),
        _storage(249, "<f4", "DC resistance", "Ω"),
        _storage(253, "<u1", "ACIR/DCIR control code"),
    )
}

if len(MPR_STORAGE_REGISTRY) != 100:
    raise RuntimeError("Spec 051 storage registry must contain exactly 100 unique base IDs")
for _storage_definition in MPR_STORAGE_REGISTRY.values():
    if np.dtype(_storage_definition.dtype).itemsize != _storage_definition.byte_width:
        raise RuntimeError("MPR storage registry dtype/width mismatch")


@dataclass(frozen=True)
class MprColumnDefinition:
    """Description of one encoded ID resolved to a storage definition."""

    encoded_id: int
    base_id: int | None
    raw_name: str
    unit: str | None
    field_name: str | None
    record_offset: int | None
    dtype: str | None
    byte_width: int
    note: str
    storage_kind: str
    physical_id: int
    flag_names: tuple[str, ...] = ()


def _column_from_storage(
    encoded_id: int,
    storage: MprStorageDefinition,
    *,
    note: str | None = None,
) -> MprColumnDefinition:
    return MprColumnDefinition(
        encoded_id=encoded_id,
        base_id=storage.base_id,
        raw_name=storage.label,
        unit=storage.unit,
        field_name=storage.field_name,
        record_offset=None,
        dtype=storage.dtype,
        byte_width=storage.byte_width,
        note=note or storage.note,
        storage_kind="record_field" if storage.field_name else "known_optional",
        physical_id=storage.base_id,
    )


MPR_COLUMN_DEFINITIONS: dict[int, MprColumnDefinition] = {
    base_id: _column_from_storage(base_id, storage)
    for base_id, storage in MPR_STORAGE_REGISTRY.items()
}
MPR_COLUMN_DEFINITIONS.update(
    {
        1: MprColumnDefinition(
            1, None, "packed record flags / mode", None, "raw_flags", None,
            "<u1", 1, "one physical byte and the mode logical ID", "packed_flags", 1, ("mode",)
        ),
        2: MprColumnDefinition(
            2, None, "oxidation-reduction/flag logical ID", None, "raw_flags", None,
            "<u1", 1, "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("oxidation_reduction",)
        ),
        3: MprColumnDefinition(
            3, None, "error/flag logical ID", None, "raw_flags", None,
            "<u1", 1, "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("error",)
        ),
        21: MprColumnDefinition(
            21, None, "control-change/flag logical ID", None, "raw_flags", None,
            "<u1", 1, "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("control_changed",)
        ),
        31: MprColumnDefinition(
            31, None, "Ns-change/flag logical ID", None, "raw_flags", None,
            "<u1", 1, "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("ns_changed",)
        ),
        65: MprColumnDefinition(
            65, None, "counter-increment/flag logical ID", None, "raw_flags", None,
            "<u1", 1, "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("counter_incremented",)
        ),
    }
)
for _alias_id, _base_id in ((379, 123), (468, 212)):
    MPR_COLUMN_DEFINITIONS[_alias_id] = _column_from_storage(
        _alias_id,
        MPR_STORAGE_REGISTRY[_base_id],
        note=f"full encoded ID resolves through base ID {_base_id}",
    )

MPR_FLAG_ALIAS_IDS = (2, 3, 21, 31, 65)
if tuple(definition.encoded_id for definition in MPR_FLAG_DEFINITIONS) != (1, 2, 3, 21, 31, 65):
    raise RuntimeError("MPR packed-flag definitions and encoded IDs diverge")
for _flag_definition in MPR_FLAG_DEFINITIONS:
    if _flag_definition.name not in MPR_COLUMN_DEFINITIONS[_flag_definition.encoded_id].flag_names:
        raise RuntimeError("MPR flag and column-definition metadata diverge")

_MPR_BASELINE_OFFSETS = {
    1: 0,
    131: 1,
    4: 3,
    7: 11,
    13: 19,
    5: 27,
    6: 31,
    9: 35,
    39: 39,
    211: 41,
    212: 49,
}
MPR_RECORD_DTYPE = np.dtype(
    {
        "names": [MPR_COLUMN_DEFINITIONS[base_id].field_name for base_id in MPR_PHYSICAL_COLUMN_IDS],
        "formats": [MPR_COLUMN_DEFINITIONS[base_id].dtype for base_id in MPR_PHYSICAL_COLUMN_IDS],
        "offsets": [
            _MPR_BASELINE_OFFSETS[MPR_COLUMN_DEFINITIONS[base_id].base_id or base_id]
            for base_id in MPR_PHYSICAL_COLUMN_IDS
        ],
        "itemsize": VMP_DATA_RECORD_ITEMSIZE,
    }
)
if MPR_RECORD_DTYPE.itemsize != VMP_DATA_RECORD_ITEMSIZE:
    raise RuntimeError("MPR baseline dtype itemsize changed")
for _base_id, _offset in _MPR_BASELINE_OFFSETS.items():
    _field_name = MPR_COLUMN_DEFINITIONS[_base_id].field_name
    if _field_name is None or MPR_RECORD_DTYPE.fields[_field_name][1] != _offset:
        raise RuntimeError("MPR baseline field offsets diverge from verified layout")


def _decode_flags(records: np.ndarray) -> dict[str, np.ndarray]:
    packed = records["raw_flags"]
    return {
        definition.name: (
            ((packed & definition.mask) >> definition.shift).astype(np.uint8, copy=False)
            if not definition.boolean
            else (packed & definition.mask) != 0
        )
        for definition in MPR_FLAG_DEFINITIONS
    }


@dataclass(frozen=True)
class _ResolvedMprLayout:
    record_dtype: np.dtype
    resolved_base_ids: tuple[int | None, ...]
    field_offsets: dict[str, int]
    ignored_known_column_ids: tuple[int, ...]
    opaque_trailing_column_ids: tuple[int, ...]
    opaque_trailing_base_ids: tuple[int, ...]


_PACKED_FLAG_IDS = frozenset(definition.encoded_id for definition in MPR_FLAG_DEFINITIONS)
_REQUIRED_FLAG_IDS = _PACKED_FLAG_IDS
_REQUIRED_BASE_ID_SET = frozenset(REQUIRED_GCPL_BASE_IDS)


def _record_dtype_for_columns(
    column_ids: tuple[int, ...],
    *,
    record_stride: int | None = None,
) -> np.dtype:
    """Build an explicit-offset dtype for a resolved source layout.

    ``record_stride`` is required for production decoding.  The optional
    default keeps this helper useful to focused tests that only need to
    inspect the baseline field set; it does not permit the reader to infer a
    stride from selected fields.
    """

    if record_stride is None:
        record_stride = VMP_DATA_RECORD_ITEMSIZE
    return _resolve_column_layout(column_ids, record_stride=record_stride).record_dtype


def _resolve_column_layout(
    column_ids: tuple[int, ...],
    *,
    record_stride: int,
) -> _ResolvedMprLayout:
    """Resolve one declared column sequence without guessing unknown widths."""

    if record_stride <= 0 or record_stride > MPR_MAX_RECORD_STRIDE:
        raise InvalidMprError(
            f"VMP record stride {record_stride} is outside the safe range"
        )

    cursor = 0
    seen_flags: set[int] = set()
    seen_bases: set[int] = set()
    resolved_base_ids: list[int | None] = []
    field_offsets: dict[str, int] = {}
    field_formats: dict[str, str] = {}
    ignored_known_column_ids: list[int] = []
    opaque_trailing_column_ids: list[int] = []
    opaque_trailing_base_ids: list[int] = []
    opaque_started = False

    def required_fields_located() -> bool:
        return seen_flags == _REQUIRED_FLAG_IDS and _REQUIRED_BASE_ID_SET.issubset(seen_bases)

    for encoded_id in column_ids:
        if encoded_id in _PACKED_FLAG_IDS:
            resolved_base_ids.append(None)
            if opaque_started:
                raise UnsupportedMprColumn(
                    f"VMP packed flag ID {encoded_id} appears after an opaque unknown suffix"
                )
            if encoded_id in seen_flags:
                raise UnsupportedMprColumn(
                    f"VMP column ID {encoded_id} repeats a packed logical flag"
                )
            if encoded_id != 1 and 1 not in seen_flags:
                raise UnsupportedMprColumn(
                    f"VMP packed flag alias {encoded_id} appears before physical flag ID 1"
                )
            seen_flags.add(encoded_id)
            if encoded_id == 1:
                field_offsets["raw_flags"] = cursor
                field_formats["raw_flags"] = "<u1"
                cursor += 1
            continue

        base_id = int(encoded_id) % 256
        resolved_base_ids.append(base_id)
        if opaque_started:
            if base_id in _REQUIRED_BASE_ID_SET:
                raise UnsupportedMprColumn(
                    f"required VMP base ID {base_id} appears after an opaque unknown suffix"
                )
            opaque_trailing_column_ids.append(encoded_id)
            opaque_trailing_base_ids.append(base_id)
            continue

        storage = MPR_STORAGE_REGISTRY.get(base_id)
        if storage is None:
            if not required_fields_located():
                raise UnsupportedMprColumn(
                    f"VMP column ID {encoded_id} resolves to unknown base ID {base_id} "
                    "before all required GCPL fields are located"
                )
            opaque_started = True
            opaque_trailing_column_ids.append(encoded_id)
            opaque_trailing_base_ids.append(base_id)
            continue

        if base_id in seen_bases:
            raise UnsupportedMprColumn(
                f"VMP encoded column ID {encoded_id} resolves to duplicate base ID {base_id}"
            )
        seen_bases.add(base_id)
        if storage.field_name is None:
            ignored_known_column_ids.append(encoded_id)
        else:
            if storage.field_name in field_offsets:
                raise UnsupportedMprColumn(
                    f"VMP base ID {base_id} would overlap field {storage.field_name!r}"
                )
            field_offsets[storage.field_name] = cursor
            field_formats[storage.field_name] = storage.dtype
        cursor += storage.byte_width

    missing_flags = sorted(_REQUIRED_FLAG_IDS - seen_flags)
    if missing_flags:
        raise UnsupportedMprColumn(
            f"VMP data is missing required packed GCPL flag IDs: {missing_flags}"
        )
    missing_bases = sorted(_REQUIRED_BASE_ID_SET - seen_bases)
    if missing_bases:
        raise UnsupportedMprColumn(
            f"VMP data is missing required GCPL base IDs: {missing_bases}"
        )

    if opaque_started:
        if cursor > record_stride:
            raise InvalidMprError(
                f"VMP known column prefix is {cursor} bytes but record stride is {record_stride}"
            )
        if cursor == record_stride:
            raise InvalidMprError(
                "VMP declares an opaque trailing column suffix without any remaining record bytes"
            )
    elif cursor != record_stride:
        raise InvalidMprError(
            f"VMP registry-derived record width is {cursor} bytes; observed stride is {record_stride}"
        )

    names = list(field_offsets)
    formats = [field_formats[name] for name in names]
    offsets = [field_offsets[name] for name in names]
    for name, offset, dtype in zip(names, offsets, formats):
        width = np.dtype(dtype).itemsize
        if offset < 0 or offset + width > record_stride:
            raise InvalidMprError(
                f"VMP field {name!r} at offset {offset} extends beyond record stride {record_stride}"
            )
    record_dtype = np.dtype(
        {
            "names": names,
            "formats": formats,
            "offsets": offsets,
            "itemsize": record_stride,
        }
    )
    return _ResolvedMprLayout(
        record_dtype=record_dtype,
        resolved_base_ids=tuple(resolved_base_ids),
        field_offsets=dict(field_offsets),
        ignored_known_column_ids=tuple(ignored_known_column_ids),
        opaque_trailing_column_ids=tuple(opaque_trailing_column_ids),
        opaque_trailing_base_ids=tuple(opaque_trailing_base_ids),
    )


class MprError(SourceFormatError):
    """Base error for an unreadable or unsupported MPR source."""


class InvalidMprError(MprError, InvalidSourceFormatError):
    """The source has an MPR signature but is structurally unsafe."""


class UnsupportedMprError(MprError, UnsupportedSourceFormatError):
    """The source is an MPR container outside the supported layout."""


class UnsupportedMprModuleVersion(UnsupportedMprError):
    """A required VMP module uses an unverified version."""


class UnsupportedMprColumn(UnsupportedMprError):
    """A VMP data block uses an unverified encoded column layout."""


@dataclass(frozen=True)
class MprModule:
    """One length-delimited MPR module.

    ``payload`` is a zero-copy view into the owning :class:`MprDocument`.
    Keep the document open while using the view.
    """

    offset: int
    short_name: str
    long_name: str
    max_size: int
    length: int
    old_version: int
    version: int
    date_text: str
    payload_offset: int
    payload_end: int
    _mapping: mmap.mmap = field(repr=False, compare=False)

    @property
    def payload(self) -> memoryview:
        """Return the module payload without copying it."""

        return memoryview(self._mapping)[self.payload_offset : self.payload_end]

    @property
    def module_type(self) -> str:
        """Return the normalized ten-byte module short name."""

        return self.short_name

    @property
    def is_vmp_set(self) -> bool:
        return (
            self.short_name.casefold() == "vmp set"
            and self.long_name.casefold() == "vmp settings"
        )

    @property
    def is_vmp_data(self) -> bool:
        return (
            self.short_name.casefold() == "vmp data"
            and self.long_name.casefold() == "vmp data"
        )

    @property
    def is_vmp_log(self) -> bool:
        return (
            self.short_name.casefold() == "vmp log"
            and self.long_name.casefold() == "vmp log"
        )


@dataclass
class MprDataBlock:
    """Decoded structural information and typed records for one VMP data module."""

    module: MprModule
    n_datapoints: int
    n_columns: int
    column_ids: tuple[int, ...]
    record_offset: int
    record_stride: int
    resolved_base_ids: tuple[int | None, ...]
    field_offsets: dict[str, int]
    ignored_known_column_ids: tuple[int, ...]
    opaque_trailing_column_ids: tuple[int, ...]
    opaque_trailing_base_ids: tuple[int, ...]
    records: np.ndarray | None
    flags: dict[str, np.ndarray]
    _payload_view: memoryview = field(repr=False)
    _closed: bool = field(default=False, init=False, repr=False)

    @property
    def record_itemsize(self) -> int:
        """Compatibility name for the validated per-source record stride."""

        return self.record_stride

    @property
    def resolved_base_id_set(self) -> frozenset[int]:
        """Return ordinary base IDs resolved from the declared sequence."""

        return frozenset(base_id for base_id in self.resolved_base_ids if base_id is not None)

    @property
    def payload(self) -> memoryview:
        """Return the complete VMP data payload without copying it."""

        if self._closed:
            raise MprError("MPR data block is closed")
        return self._payload_view

    def close(self) -> None:
        """Release the reader-owned references to the mapped data."""

        if self._closed:
            return
        self.flags.clear()
        self.records = None
        self._payload_view.release()
        self._closed = True

    def __enter__(self) -> "MprDataBlock":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            self.close()
        except Exception:
            if exc_type is None:
                raise


@dataclass
class MprDocument:
    """An open MPR mapping and its verified module/data-block descriptors.

    Use this object as a context manager. Typed records are owning arrays;
    module payloads remain zero-copy memoryviews and must be released before
    closing the document.
    """

    path: Path
    modules: tuple[MprModule, ...]
    vmp_set: MprModule
    vmp_data: MprDataBlock
    vmp_log: MprModule | None
    _file: BinaryIO = field(repr=False)
    _mapping: mmap.mmap = field(repr=False)
    _closed: bool = field(default=False, init=False, repr=False)

    def close(self) -> None:
        if self._closed:
            return
        self.vmp_data.close()
        try:
            self._mapping.close()
        except BufferError as exc:
            raise MprError(
                "MPR mapped data is still referenced; release records/views before closing"
            ) from exc
        finally:
            self._file.close()
        self._closed = True

    def __enter__(self) -> "MprDocument":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            self.close()
        except Exception:
            # A retained zero-copy module view must not replace an exception
            # raised by the caller. The caller can release that view and retry
            # close() explicitly; successful ordinary record consumption is
            # lifetime-safe because records are owning arrays.
            if exc_type is None:
                raise


def _source_label(path: Path) -> str:
    return path.name or "<unnamed MPR>"


def _stat_fingerprint(stat_result: object) -> tuple[int, int | None]:
    return (
        int(getattr(stat_result, "st_size")),
        getattr(stat_result, "st_mtime_ns", None),
    )


def _decode_ascii(raw: bytes, field_name: str, path: Path) -> str:
    try:
        return raw.rstrip(b" \x00").decode("ascii")
    except UnicodeDecodeError as exc:
        raise InvalidMprError(
            f"{_source_label(path)} has non-ASCII bytes in the MPR {field_name} field"
        ) from exc


def _parse_module(mapping: mmap.mmap, offset: int, file_size: int, path: Path) -> MprModule:
    if file_size - offset < MPR_MODULE_HEADER_SIZE:
        raise InvalidMprError(f"{_source_label(path)} ends inside an MPR module header")
    if mapping[offset : offset + len(MPR_MODULE_MARKER)] != MPR_MODULE_MARKER:
        raise InvalidMprError(f"{_source_label(path)} has an invalid MPR module marker")

    header = mapping[offset : offset + MPR_MODULE_HEADER_SIZE]
    if header[0:6] != MPR_MODULE_MARKER:
        raise InvalidMprError(f"{_source_label(path)} has an invalid MPR module marker")
    short_name = _decode_ascii(header[6:16], "short-name", path)
    long_name = _decode_ascii(header[16:41], "long-name", path)
    max_size, length, old_version, version = struct.unpack_from("<IIII", header, 41)
    date_text = _decode_ascii(header[57:65], "date", path)

    payload_offset = offset + MPR_MODULE_HEADER_SIZE
    payload_end = payload_offset + length
    if max_size != 0xFFFFFFFF and length > max_size:
        raise InvalidMprError(
            f"{_source_label(path)} declares module length {length} above max size {max_size}"
        )
    if payload_end > file_size:
        raise InvalidMprError(f"{_source_label(path)} declares a truncated MPR module")

    return MprModule(
        offset=offset,
        short_name=short_name,
        long_name=long_name,
        max_size=max_size,
        length=length,
        old_version=old_version,
        version=version,
        date_text=date_text,
        payload_offset=payload_offset,
        payload_end=payload_end,
        _mapping=mapping,
    )


def _walk_modules(mapping: mmap.mmap, file_size: int, path: Path) -> tuple[MprModule, ...]:
    modules: list[MprModule] = []
    offset = MPR_INITIAL_HEADER_SIZE
    while offset < file_size:
        if len(modules) >= MPR_MAX_MODULE_COUNT:
            raise UnsupportedMprError(
                f"{_source_label(path)} exceeds the {MPR_MAX_MODULE_COUNT}-module safety bound"
            )
        module = _parse_module(mapping, offset, file_size, path)
        modules.append(module)
        offset = module.payload_end
        if offset == file_size:
            break
        if file_size - offset < len(MPR_MODULE_MARKER):
            raise InvalidMprError(f"{_source_label(path)} has trailing bytes after an MPR module")
        if mapping[offset : offset + len(MPR_MODULE_MARKER)] != MPR_MODULE_MARKER:
            raise InvalidMprError(
                f"{_source_label(path)} has bytes between declared MPR module boundaries"
            )
    if not modules:
        raise InvalidMprError(f"{_source_label(path)} contains no MPR modules")
    return tuple(modules)


def _decode_vmp_data(
    module: MprModule,
    path: Path,
    *,
    decode_records: bool = True,
) -> MprDataBlock:
    payload = module.payload
    try:
        if len(payload) < VMP_DATA_HEADER_SIZE:
            raise InvalidMprError(f"{_source_label(path)} has a truncated VMP data header")

        n_datapoints = struct.unpack_from("<I", payload, 0)[0]
        n_columns = payload[4]
        if n_datapoints == 0 or n_columns == 0:
            raise InvalidMprError(f"{_source_label(path)} has an empty VMP data block")
        if n_columns > MPR_MAX_COLUMNS:
            raise InvalidMprError(
                f"{_source_label(path)} declares {n_columns} VMP columns above the safety bound"
            )
        column_header_end = 5 + (n_columns * 2)
        if column_header_end > len(payload) or column_header_end > VMP_DATA_RECORD_OFFSET:
            raise InvalidMprError(f"{_source_label(path)} has a truncated VMP column header")

        column_ids = tuple(struct.unpack_from(f">{n_columns}H", payload, 5))
        if len(set(column_ids)) != len(column_ids):
            raise UnsupportedMprColumn(f"{_source_label(path)} repeats a VMP column ID")

        if len(payload) < VMP_DATA_RECORD_OFFSET:
            raise InvalidMprError(f"{_source_label(path)} has a truncated VMP data prefix")

        data_bytes = len(payload) - VMP_DATA_RECORD_OFFSET
        if data_bytes % n_datapoints != 0:
            raise InvalidMprError(
                f"{_source_label(path)} VMP record area of {data_bytes} bytes is not divisible "
                f"by {n_datapoints} datapoints"
            )
        record_stride = data_bytes // n_datapoints
        if record_stride <= 0 or record_stride > MPR_MAX_RECORD_STRIDE:
            raise InvalidMprError(
                f"{_source_label(path)} has unsafe VMP record stride {record_stride}"
            )
        layout = _resolve_column_layout(column_ids, record_stride=record_stride)
        record_dtype = layout.record_dtype

        records: np.ndarray | None = None
        flags: dict[str, np.ndarray] = {}
        if decode_records:
            record_view = None
            try:
                record_view = np.frombuffer(
                    payload,
                    dtype=record_dtype,
                    count=n_datapoints,
                    offset=VMP_DATA_RECORD_OFFSET,
                )
                records = record_view.copy()
            finally:
                record_view = None
            flags = _decode_flags(records)

        return MprDataBlock(
            module=module,
            n_datapoints=n_datapoints,
            n_columns=n_columns,
            column_ids=column_ids,
            record_offset=VMP_DATA_RECORD_OFFSET,
            record_stride=record_stride,
            resolved_base_ids=layout.resolved_base_ids,
            field_offsets=layout.field_offsets,
            ignored_known_column_ids=layout.ignored_known_column_ids,
            opaque_trailing_column_ids=layout.opaque_trailing_column_ids,
            opaque_trailing_base_ids=layout.opaque_trailing_base_ids,
            records=records,
            flags=flags,
            _payload_view=payload,
        )
    except BaseException:
        try:
            payload.release()
        except Exception:
            pass
        raise


def read_mpr(path: str | Path, *, decode_records: bool = True) -> MprDocument:
    """Open and structurally decode a supported MPR container.

    The returned document owns a read-only memory map.  Callers must close it
    (preferably with ``with read_mpr(path) as document``) after consuming the
    typed records and any module payload views.
    """

    source_path = Path(path)
    try:
        file_handle = source_path.open("rb")
    except OSError as exc:
        raise MprError(f"Cannot open MPR source {_source_label(source_path)}") from exc

    mapping: mmap.mmap | None = None
    data_block: MprDataBlock | None = None
    try:
        initial_stat = os.fstat(file_handle.fileno())
        file_size = initial_stat.st_size
        initial_fingerprint = _stat_fingerprint(initial_stat)
        if file_size > MPR_MAX_FILE_SIZE:
            raise UnsupportedMprError(
                f"{_source_label(source_path)} exceeds the {MPR_MAX_FILE_SIZE} byte MPR safety bound"
            )
        file_handle.seek(0)
        initial_bytes = file_handle.read(min(file_size, len(MPR_MAGIC)))
        if len(initial_bytes) < len(MPR_MAGIC_PREFIX) or initial_bytes[: len(MPR_MAGIC_PREFIX)] != MPR_MAGIC_PREFIX:
            raise UnsupportedMprError(f"{_source_label(source_path)} is not a BioLogic MPR file")
        if file_size < MPR_INITIAL_HEADER_SIZE:
            raise InvalidMprError(f"{_source_label(source_path)} is shorter than the MPR header")
        mapping = mmap.mmap(file_handle.fileno(), length=0, access=mmap.ACCESS_READ)
        mapped_size = len(mapping)
        if mapped_size > MPR_MAX_FILE_SIZE:
            raise UnsupportedMprError(
                f"{_source_label(source_path)} exceeds the {MPR_MAX_FILE_SIZE} byte MPR safety bound"
            )
        if mapped_size != file_size:
            raise InvalidMprError(
                f"{_source_label(source_path)} changed size between stat and memory mapping"
            )
        mapped_stat = os.fstat(file_handle.fileno())
        if _stat_fingerprint(mapped_stat) != initial_fingerprint:
            raise InvalidMprError(
                f"{_source_label(source_path)} changed between stat and memory mapping"
            )
        if mapping[:MPR_INITIAL_HEADER_SIZE] != MPR_MAGIC:
            raise InvalidMprError(f"{_source_label(source_path)} has an invalid MPR file header")

        modules = _walk_modules(mapping, file_size, source_path)
        data_modules = [module for module in modules if module.is_vmp_data]
        if len(data_modules) != 1:
            raise InvalidMprError(
                f"{_source_label(source_path)} must contain exactly one supported VMP data module"
            )
        data_module = data_modules[0]
        if data_module.old_version != 0:
            raise UnsupportedMprModuleVersion(
                f"{_source_label(source_path)} uses unsupported VMP data old version "
                f"{data_module.old_version}; expected 0"
            )
        if data_module.version != VMP_DATA_VERSION:
            raise UnsupportedMprModuleVersion(
                f"{_source_label(source_path)} uses unsupported VMP data version "
                f"{data_module.version}; expected {VMP_DATA_VERSION}"
            )

        set_modules = [module for module in modules if module.is_vmp_set]
        if len(set_modules) != 1:
            raise UnsupportedMprError(
                f"{_source_label(source_path)} must contain exactly one VMP Set module"
            )
        set_module = set_modules[0]
        if set_module.old_version != 0:
            raise UnsupportedMprModuleVersion(
                f"{_source_label(source_path)} uses unsupported VMP Set old version "
                f"{set_module.old_version}; expected 0"
            )
        if set_module.version != VMP_SET_VERSION:
            raise UnsupportedMprModuleVersion(
                f"{_source_label(source_path)} uses unsupported VMP Set version "
                f"{set_module.version}; expected {VMP_SET_VERSION}"
            )

        log_modules = [module for module in modules if module.is_vmp_log]
        if len(log_modules) > 1:
            raise UnsupportedMprError(f"{_source_label(source_path)} contains multiple VMP LOG modules")
        log_module = log_modules[0] if log_modules else None
        if log_module is not None:
            if log_module.old_version != 0:
                raise UnsupportedMprModuleVersion(
                    f"{_source_label(source_path)} uses unsupported VMP LOG old version "
                    f"{log_module.old_version}; expected 0"
                )
            if log_module.version != VMP_LOG_VERSION:
                raise UnsupportedMprModuleVersion(
                    f"{_source_label(source_path)} uses unsupported VMP LOG version "
                    f"{log_module.version}; expected {VMP_LOG_VERSION}"
                )

        data_block = _decode_vmp_data(
            data_module,
            source_path,
            decode_records=decode_records,
        )
        final_stat = os.fstat(file_handle.fileno())
        if _stat_fingerprint(final_stat) != initial_fingerprint or len(mapping) != file_size:
            raise InvalidMprError(
                f"{_source_label(source_path)} changed while it was being read"
            )
        return MprDocument(
            path=source_path,
            modules=modules,
            vmp_set=set_module,
            vmp_data=data_block,
            vmp_log=log_module,
            _file=file_handle,
            _mapping=mapping,
        )
    except BaseException:
        if data_block is not None:
            try:
                data_block.close()
            except Exception:
                pass
        try:
            if mapping is not None:
                mapping.close()
        except Exception:
            pass
        finally:
            try:
                file_handle.close()
            except Exception:
                pass
        raise


def read_mpr_header(path: str | Path) -> MprDocument:
    """Open an MPR while decoding only module and data-column headers.

    The returned :class:`MprDocument` has the same structural ownership rules
    as :func:`read_mpr`, but ``document.vmp_data.records`` is ``None`` and no
    record-sized NumPy array is constructed.  This is the only path metadata
    readers should use; displaying header/settings information must not scale
    with the number of cycling rows.
    """

    return read_mpr(path, decode_records=False)


__all__ = [
    "InvalidMprError",
    "MPR_COLUMN_DEFINITIONS",
    "MPR_FLAG_DEFINITIONS",
    "MPR_FLAG_ALIAS_IDS",
    "MPR_PHYSICAL_COLUMN_IDS",
    "MPR_MAGIC",
    "MPR_MAGIC_PREFIX",
    "MPR_MAX_FILE_SIZE",
    "MPR_MAX_MODULE_COUNT",
    "MPR_MAX_RECORD_STRIDE",
    "MPR_RECORD_DTYPE",
    "MPR_STORAGE_REGISTRY",
    "REQUIRED_GCPL_COLUMN_IDS",
    "REQUIRED_GCPL_BASE_IDS",
    "MprDataBlock",
    "MprDocument",
    "MprError",
    "MprColumnDefinition",
    "MprFlagDefinition",
    "MprStorageDefinition",
    "MprModule",
    "MPR_READER_REVISION",
    "SUPPORTED_GCPL_COLUMN_IDS",
    "SUPPORTED_GCPL_COLUMN_ID_SET",
    "UnsupportedMprColumn",
    "UnsupportedMprError",
    "UnsupportedMprModuleVersion",
    "read_mpr",
    "read_mpr_header",
]
