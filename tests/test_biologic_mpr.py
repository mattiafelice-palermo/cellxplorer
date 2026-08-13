from __future__ import annotations

from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np

from backend.app.services.biologic_mpr import (
    InvalidMprError,
    MPR_MODULE_HEADER_SIZE,
    SUPPORTED_GCPL_COLUMN_IDS,
    UnsupportedMprColumn,
    UnsupportedMprModuleVersion,
    read_mpr,
)


_MAGIC_HEADER = b"BIO-LOGIC MODULAR FILE\x1a" + (b" " * 25) + (b"\x00" * 4)


def _module(
    long_name: bytes,
    payload: bytes,
    *,
    version: int,
    date: bytes = b"07/10/26",
) -> bytes:
    short_name = b"MODULEVMP "
    header = (
        short_name
        + long_name.ljust(31, b" ")[:31]
        + struct.pack("<IIII", 0xFFFFFFFF, len(payload), 0, version)
        + date
    )
    assert len(header) == MPR_MODULE_HEADER_SIZE
    return header + payload


def _data_payload(
    *,
    n_datapoints: int = 2,
    column_ids: tuple[int, ...] = SUPPORTED_GCPL_COLUMN_IDS,
    record_offset: int = 1007,
    record_itemsize: int = 53,
) -> bytes:
    records = bytes(
        (index % 251 for index in range(n_datapoints * record_itemsize))
    )
    prefix = (
        struct.pack("<I", n_datapoints)
        + bytes([len(column_ids)])
        + struct.pack(f">{len(column_ids)}H", *column_ids)
    )
    return prefix.ljust(record_offset, b"\x00") + records


def _write_fixture(
    directory: Path,
    *,
    data_payload: bytes | None = None,
    data_version: int = 11,
    set_version: int = 10,
    log_version: int = 10,
    include_log: bool = True,
) -> Path:
    payload = data_payload if data_payload is not None else _data_payload()
    modules = [
        _module(b"Set   VMP settings", b"settings", version=set_version),
        _module(b"data  VMP data", payload, version=data_version),
    ]
    if include_log:
        modules.append(_module(b"LOG   VMP LOG", b"log", version=log_version))
    path = directory / "fixture.mpr"
    path.write_bytes(_MAGIC_HEADER + b"".join(modules))
    return path


class BiologicMprReaderTests(unittest.TestCase):
    def test_reads_declared_modules_and_zero_copy_raw_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with read_mpr(path) as document:
                self.assertEqual(len(document.modules), 3)
                self.assertEqual(document.vmp_set.version, 10)
                self.assertIsNotNone(document.vmp_log)
                self.assertEqual(document.vmp_data.n_datapoints, 2)
                self.assertEqual(document.vmp_data.n_columns, 16)
                self.assertEqual(document.vmp_data.column_ids, SUPPORTED_GCPL_COLUMN_IDS)
                self.assertEqual(document.vmp_data.record_offset, 1007)
                self.assertEqual(document.vmp_data.record_itemsize, 53)
                self.assertEqual(document.vmp_data.records.shape, (2,))
                self.assertEqual(document.vmp_data.records.dtype.itemsize, 53)
                self.assertIsInstance(document.vmp_data.records.base, memoryview)

    def test_log_module_is_optional_at_low_level(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), include_log=False)
            with read_mpr(path) as document:
                self.assertIsNone(document.vmp_log)

    def test_rejects_bad_magic(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.mpr"
            path.write_bytes(b"not an MPR")
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_rejects_declared_module_overrun(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            contents = bytearray(path.read_bytes())
            struct.pack_into("<I", contents, 52 + 45, 0xFFFFFFFF)
            path.write_bytes(contents)
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_rejects_missing_boundary_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            contents = bytearray(path.read_bytes())
            first_end = 52 + MPR_MODULE_HEADER_SIZE + 8
            contents[first_end] = ord("X")
            path.write_bytes(contents)
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_rejects_unknown_data_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), data_version=12)
            with self.assertRaises(UnsupportedMprModuleVersion):
                read_mpr(path)

    def test_rejects_unknown_column_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            ids = list(SUPPORTED_GCPL_COLUMN_IDS)
            ids[-1] = 999
            path = _write_fixture(Path(temp), data_payload=_data_payload(column_ids=tuple(ids)))
            with self.assertRaises(UnsupportedMprColumn):
                read_mpr(path)

    def test_rejects_unverified_column_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            ids = (SUPPORTED_GCPL_COLUMN_IDS[1],) + SUPPORTED_GCPL_COLUMN_IDS[:1] + SUPPORTED_GCPL_COLUMN_IDS[2:]
            path = _write_fixture(Path(temp), data_payload=_data_payload(column_ids=ids))
            with self.assertRaises(UnsupportedMprColumn):
                read_mpr(path)

    def test_rejects_record_area_size_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), data_payload=_data_payload()[:-1])
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_rejects_duplicate_data_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            payload = _data_payload()
            path = Path(temp) / "duplicate.mpr"
            path.write_bytes(
                _MAGIC_HEADER
                + _module(b"Set   VMP settings", b"settings", version=10)
                + _module(b"data  VMP data", payload, version=11)
                + _module(b"data  VMP data", payload, version=11)
            )
            with self.assertRaises(InvalidMprError):
                read_mpr(path)


if __name__ == "__main__":
    unittest.main()
