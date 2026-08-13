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

_RAW_RECORD_DTYPE = np.dtype([("raw", f"V{VMP_DATA_RECORD_ITEMSIZE}")])


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
        """Return the logical type after the fixed ``MODULE`` marker."""

        return self.short_name[6:] if self.short_name.startswith("MODULE") else self.short_name

    @property
    def is_vmp_set(self) -> bool:
        return self.module_type.upper() == "VMP" and self.long_name.lower().startswith("set")

    @property
    def is_vmp_data(self) -> bool:
        return self.module_type.upper() == "VMP" and self.long_name.lower().startswith("data")

    @property
    def is_vmp_log(self) -> bool:
        return self.module_type.upper() == "VMP" and self.long_name.lower().startswith("log")


@dataclass
class MprDataBlock:
    """Decoded structural information and raw records for one VMP data module."""

    module: MprModule
    n_datapoints: int
    n_columns: int
    column_ids: tuple[int, ...]
    record_offset: int
    record_itemsize: int
    records: np.ndarray | None
    _payload_view: memoryview = field(repr=False)

    @property
    def payload(self) -> memoryview:
        """Return the complete VMP data payload without copying it."""

        return self._payload_view

    def close(self) -> None:
        """Release the reader-owned references to the mapped data."""

        self.records = None
        self._payload_view.release()


@dataclass
class MprDocument:
    """An open MPR mapping and its verified module/data-block descriptors.

    Use this object as a context manager.  Arrays or memoryviews obtained from
    it must be released before leaving the context.
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
        self.close()


def _source_label(path: Path) -> str:
    return path.name or "<unnamed MPR>"


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
    short_name = _decode_ascii(header[0:10], "short-name", path)
    long_name = _decode_ascii(header[10:41], "long-name", path)
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
    if len(payload) < VMP_DATA_HEADER_SIZE:
        payload.release()
        raise InvalidMprError(f"{_source_label(path)} has a truncated VMP data header")

    n_datapoints = struct.unpack_from("<I", payload, 0)[0]
    n_columns = payload[4]
    if n_datapoints == 0 or n_columns == 0:
        payload.release()
        raise InvalidMprError(f"{_source_label(path)} has an empty VMP data block")
    column_header_end = 5 + (n_columns * 2)
    if column_header_end > len(payload):
        payload.release()
        raise InvalidMprError(f"{_source_label(path)} has a truncated VMP column header")

    column_ids = tuple(struct.unpack_from(f">{n_columns}H", payload, 5))
    unknown_ids = sorted(set(column_ids) - set(SUPPORTED_GCPL_COLUMN_IDS))
    if unknown_ids:
        payload.release()
        raise UnsupportedMprColumn(
            f"{_source_label(path)} uses unsupported VMP column IDs: {unknown_ids}"
        )
    if len(set(column_ids)) != len(column_ids):
        payload.release()
        raise UnsupportedMprColumn(f"{_source_label(path)} repeats a VMP column ID")
    if column_ids != SUPPORTED_GCPL_COLUMN_IDS:
        payload.release()
        raise UnsupportedMprColumn(
            f"{_source_label(path)} uses an unsupported VMP column ordering/layout"
        )

    data_bytes = len(payload) - VMP_DATA_RECORD_OFFSET
    expected_bytes = n_datapoints * VMP_DATA_RECORD_ITEMSIZE
    if data_bytes != expected_bytes:
        payload.release()
        raise InvalidMprError(
            f"{_source_label(path)} VMP record area is {data_bytes} bytes; "
            f"expected {expected_bytes} for {n_datapoints} records"
        )

    try:
        records = np.frombuffer(
            payload,
            dtype=_RAW_RECORD_DTYPE,
            count=n_datapoints,
            offset=VMP_DATA_RECORD_OFFSET,
        )
    except (TypeError, ValueError) as exc:
        payload.release()
        raise InvalidMprError(f"{_source_label(path)} VMP records cannot be bulk-decoded") from exc

    return MprDataBlock(
        module=module,
        n_datapoints=n_datapoints,
        n_columns=n_columns,
        column_ids=column_ids,
        record_offset=VMP_DATA_RECORD_OFFSET,
        record_itemsize=VMP_DATA_RECORD_ITEMSIZE,
        records=records,
        _payload_view=payload,
    )


def read_mpr(path: str | Path) -> MprDocument:
    """Open and structurally decode a supported MPR container.

    The returned document owns a read-only memory map.  Callers must close it
    (preferably with ``with read_mpr(path) as document``) after consuming the
    raw record view.
    """

    source_path = Path(path)
    try:
        file_handle = source_path.open("rb")
    except OSError as exc:
        raise MprError(f"Cannot open MPR source {_source_label(source_path)}") from exc

    mapping: mmap.mmap | None = None
    try:
        file_size = os.fstat(file_handle.fileno()).st_size
        if file_size < MPR_INITIAL_HEADER_SIZE:
            raise InvalidMprError(f"{_source_label(source_path)} is shorter than the MPR header")
        mapping = mmap.mmap(file_handle.fileno(), length=0, access=mmap.ACCESS_READ)
        if mapping[: len(MPR_MAGIC_PREFIX)] != MPR_MAGIC_PREFIX:
            raise UnsupportedMprError(f"{_source_label(source_path)} is not a BioLogic MPR file")

        modules = _walk_modules(mapping, file_size, source_path)
        data_modules = [module for module in modules if module.is_vmp_data]
        if len(data_modules) != 1:
            raise InvalidMprError(
                f"{_source_label(source_path)} must contain exactly one supported VMP data module"
            )
        data_module = data_modules[0]
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
        if set_module.version != VMP_SET_VERSION:
            raise UnsupportedMprModuleVersion(
                f"{_source_label(source_path)} uses unsupported VMP Set version "
                f"{set_module.version}; expected {VMP_SET_VERSION}"
            )

        log_modules = [module for module in modules if module.is_vmp_log]
        if len(log_modules) > 1:
            raise UnsupportedMprError(f"{_source_label(source_path)} contains multiple VMP LOG modules")
        log_module = log_modules[0] if log_modules else None
        if log_module is not None and log_module.version != VMP_LOG_VERSION:
            raise UnsupportedMprModuleVersion(
                f"{_source_label(source_path)} uses unsupported VMP LOG version "
                f"{log_module.version}; expected {VMP_LOG_VERSION}"
            )

        data_block = _decode_vmp_data(data_module, source_path)
        return MprDocument(
            path=source_path,
            modules=modules,
            vmp_set=set_module,
            vmp_data=data_block,
            vmp_log=log_module,
            _file=file_handle,
            _mapping=mapping,
        )
    except Exception:
        if mapping is not None:
            mapping.close()
        file_handle.close()
        raise


__all__ = [
    "InvalidMprError",
    "MprDataBlock",
    "MprDocument",
    "MprError",
    "MprModule",
    "MPR_READER_REVISION",
    "SUPPORTED_GCPL_COLUMN_IDS",
    "UnsupportedMprColumn",
    "UnsupportedMprError",
    "UnsupportedMprModuleVersion",
    "read_mpr",
]
