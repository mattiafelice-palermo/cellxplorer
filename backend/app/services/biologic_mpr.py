"""Independent low-level reader for the supported BioLogic MPR container.

This module deliberately stops at the binary container and VMP data-block
boundary.  GCPL semantics, protocol reconstruction, and user-facing source
recognition belong to later Spec 041 children.

The supported layout is the one independently observed in the supplied
GCPL6 sample and recorded in ``docs/biologic-mpr-format.md``.  Unknown data
layouts fail closed instead of being decoded by positional guesswork.
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


MPR_READER_REVISION = 1
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

VMP_SET_VERSION = 10
VMP_DATA_VERSION = 11
VMP_LOG_VERSION = 10
VMP_DATA_HEADER_SIZE = 37
VMP_DATA_RECORD_OFFSET = 1007
VMP_DATA_RECORD_ITEMSIZE = 53

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
class MprColumnDefinition:
    """Independent description of one accepted encoded data-column ID."""

    encoded_id: int
    raw_name: str
    unit: str | None
    field_name: str | None
    record_offset: int | None
    dtype: str | None
    note: str
    storage_kind: str
    physical_id: int
    flag_names: tuple[str, ...] = ()


MPR_COLUMN_DEFINITIONS = {
    1: MprColumnDefinition(1, "packed record flags / mode", None, "raw_flags", 0, "u1", "one physical byte and the mode logical ID", "packed_flags", 1, ("mode",)),
    2: MprColumnDefinition(2, "oxidation-reduction/flag logical ID", None, "raw_flags", 0, "u1", "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("oxidation_reduction",)),
    3: MprColumnDefinition(3, "error/flag logical ID", None, "raw_flags", 0, "u1", "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("error",)),
    21: MprColumnDefinition(21, "control-change/flag logical ID", None, "raw_flags", 0, "u1", "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("control_changed",)),
    31: MprColumnDefinition(31, "Ns-change/flag logical ID", None, "raw_flags", 0, "u1", "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("ns_changed",)),
    65: MprColumnDefinition(65, "counter-increment/flag logical ID", None, "raw_flags", 0, "u1", "logical flag sharing the ID 1 packed byte", "packed_flag_alias", 1, ("counter_incremented",)),
    131: MprColumnDefinition(131, "sample sequence number", None, "raw_sample_index", 1, "<u2", "raw integer", "record_field", 131),
    4: MprColumnDefinition(4, "elapsed time", "s", "elapsed_time_s", 3, "<f8", "raw elapsed time; not canonical step time", "record_field", 4),
    7: MprColumnDefinition(7, "incremental charge", "mA.h", "raw_dq_mAh", 11, "<f8", "raw charge", "record_field", 7),
    13: MprColumnDefinition(13, "charge relative to origin", "mA.h", "raw_q_minus_q0_mAh", 19, "<f8", "raw charge", "record_field", 13),
    5: MprColumnDefinition(5, "control value", "V or mA", "raw_control_v_or_mA", 27, "<f4", "technique-dependent raw control", "record_field", 5),
    6: MprColumnDefinition(6, "working-electrode potential bytes", "V", "raw_ewe_v", 31, "<f4", "raw Ewe-labeled value; role mapping is deferred", "record_field", 6),
    9: MprColumnDefinition(9, "counter-electrode potential bytes", "V", "raw_ece_v", 35, "<f4", "raw Ece-labeled value; role mapping is deferred", "record_field", 9),
    39: MprColumnDefinition(39, "current range", None, "raw_current_range_code", 39, "<u2", "raw integer code", "record_field", 39),
    211: MprColumnDefinition(211, "charge/discharge quantity", "mA.h", "raw_q_charge_discharge_mAh", 41, "<f8", "raw charge", "record_field", 211),
    468: MprColumnDefinition(468, "half-cycle index bytes", None, "raw_half_cycle_index", 49, "<u4", "full encoded ID; do not truncate to 212", "record_field", 468),
}

if set(MPR_COLUMN_DEFINITIONS) != set(SUPPORTED_GCPL_COLUMN_IDS):
    raise RuntimeError("MPR column definitions and supported-ID allowlist diverge")
MPR_RECORD_DTYPE = np.dtype(
    [
        (MPR_COLUMN_DEFINITIONS[column_id].field_name, MPR_COLUMN_DEFINITIONS[column_id].dtype)
        for column_id in MPR_PHYSICAL_COLUMN_IDS
    ],
    align=False,
)

for _column_id in MPR_PHYSICAL_COLUMN_IDS:
    _definition = MPR_COLUMN_DEFINITIONS[_column_id]
    assert _definition.field_name is not None
    assert _definition.dtype is not None
    assert MPR_RECORD_DTYPE.fields[_definition.field_name][1] == _definition.record_offset

for _column_id in SUPPORTED_GCPL_COLUMN_IDS:
    _definition = MPR_COLUMN_DEFINITIONS[_column_id]
    _physical = MPR_COLUMN_DEFINITIONS[_definition.physical_id]
    assert _definition.field_name == _physical.field_name
    assert _definition.record_offset == _physical.record_offset
    assert _definition.dtype == _physical.dtype

MPR_FLAG_ALIAS_IDS = (2, 3, 21, 31, 65)
if tuple(
    column_id
    for column_id in SUPPORTED_GCPL_COLUMN_IDS
    if MPR_COLUMN_DEFINITIONS[column_id].storage_kind == "packed_flag_alias"
) != MPR_FLAG_ALIAS_IDS:
    raise RuntimeError("MPR packed-flag definitions and supported-ID order diverge")
for _flag_definition in MPR_FLAG_DEFINITIONS:
    if _flag_definition.name not in MPR_COLUMN_DEFINITIONS[_flag_definition.encoded_id].flag_names:
        raise RuntimeError("MPR flag and column-definition metadata diverge")


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
    record_itemsize: int
    records: np.ndarray | None
    flags: dict[str, np.ndarray]
    _payload_view: memoryview = field(repr=False)
    _closed: bool = field(default=False, init=False, repr=False)

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


def _decode_vmp_data(module: MprModule, path: Path) -> MprDataBlock:
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
        unknown_ids = sorted(set(column_ids) - set(SUPPORTED_GCPL_COLUMN_IDS))
        if unknown_ids:
            raise UnsupportedMprColumn(
                f"{_source_label(path)} uses unsupported VMP column IDs: {unknown_ids}"
            )
        if len(set(column_ids)) != len(column_ids):
            raise UnsupportedMprColumn(f"{_source_label(path)} repeats a VMP column ID")
        if column_ids != SUPPORTED_GCPL_COLUMN_IDS:
            raise UnsupportedMprColumn(
                f"{_source_label(path)} uses an unsupported VMP column ordering/layout"
            )

        if len(payload) < VMP_DATA_RECORD_OFFSET:
            raise InvalidMprError(f"{_source_label(path)} has a truncated VMP data prefix")

        data_bytes = len(payload) - VMP_DATA_RECORD_OFFSET
        if n_datapoints > data_bytes // VMP_DATA_RECORD_ITEMSIZE:
            raise InvalidMprError(
                f"{_source_label(path)} declares more VMP datapoints than its record area can hold"
            )
        expected_bytes = n_datapoints * MPR_RECORD_DTYPE.itemsize
        if data_bytes != expected_bytes:
            raise InvalidMprError(
                f"{_source_label(path)} VMP record area is {data_bytes} bytes; "
                f"expected {expected_bytes} for {n_datapoints} typed records"
            )
        if MPR_RECORD_DTYPE.itemsize != VMP_DATA_RECORD_ITEMSIZE:
            raise InvalidMprError("internal MPR record dtype does not match the verified record size")

        record_view = None
        try:
            record_view = np.frombuffer(
                payload,
                dtype=MPR_RECORD_DTYPE,
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
            record_itemsize=MPR_RECORD_DTYPE.itemsize,
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


def read_mpr(path: str | Path) -> MprDocument:
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

        data_block = _decode_vmp_data(data_module, source_path)
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
    "MPR_RECORD_DTYPE",
    "MprDataBlock",
    "MprDocument",
    "MprError",
    "MprColumnDefinition",
    "MprFlagDefinition",
    "MprModule",
    "MPR_READER_REVISION",
    "SUPPORTED_GCPL_COLUMN_IDS",
    "UnsupportedMprColumn",
    "UnsupportedMprError",
    "UnsupportedMprModuleVersion",
    "read_mpr",
]
