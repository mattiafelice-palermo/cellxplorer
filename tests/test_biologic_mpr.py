from __future__ import annotations

from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np

from backend.app.services.biologic_mpr import (
    InvalidMprError,
    MPR_MAGIC,
    MPR_MAGIC_PREFIX,
    MPR_MODULE_HEADER_SIZE,
    MPR_RECORD_DTYPE,
    SUPPORTED_GCPL_COLUMN_IDS,
    UnsupportedMprColumn,
    UnsupportedMprError,
    UnsupportedMprModuleVersion,
    read_mpr,
)


_MAGIC_HEADER = MPR_MAGIC


def _module(
    long_name: bytes,
    payload: bytes,
    *,
    version: int,
    old_version: int = 0,
    date: bytes = b"07/10/26",
    short_name: bytes = b"MODULEVMP ",
) -> bytes:
    header = (
        short_name
        + long_name.ljust(31, b" ")[:31]
        + struct.pack("<IIII", 0xFFFFFFFF, len(payload), old_version, version)
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
    record_bytes: bytes | None = None,
) -> bytes:
    records = (
        record_bytes
        if record_bytes is not None
        else bytes((index % 251 for index in range(n_datapoints * record_itemsize)))
    )
    assert len(records) == n_datapoints * record_itemsize
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
    include_data: bool = True,
    unknown_modules: int = 0,
    data_old_version: int = 0,
    set_old_version: int = 0,
    log_old_version: int = 0,
) -> Path:
    payload = data_payload if data_payload is not None else _data_payload()
    modules = [
        _module(
            b"Set   VMP settings",
            b"settings",
            version=set_version,
            old_version=set_old_version,
        ),
    ]
    if include_data:
        modules.append(
            _module(
                b"data  VMP data",
                payload,
                version=data_version,
                old_version=data_old_version,
            )
        )
    if include_log:
        modules.append(
            _module(
                b"LOG   VMP LOG",
                b"log",
                version=log_version,
                old_version=log_old_version,
            )
        )
    for index in range(unknown_modules):
        modules.append(
            _module(
                f"optional {index}".encode("ascii"),
                b"optional",
                version=1,
                short_name=b"MODULEEXT ",
            )
        )
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
                self.assertEqual(
                    document.vmp_data.records.dtype.names,
                    MPR_RECORD_DTYPE.names,
                )
                self.assertIsInstance(document.vmp_data.records.base, memoryview)
                self.assertEqual(document.vmp_data.flags["mode"].shape, (2,))

    def test_log_module_is_optional_at_low_level(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), include_log=False)
            with read_mpr(path) as document:
                self.assertIsNone(document.vmp_log)

    def test_rejects_bad_magic(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.mpr"
            path.write_bytes(b"not an MPR")
            with self.assertRaises(UnsupportedMprError):
                read_mpr(path)

    def test_rejects_corrupt_full_magic_header(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            contents = bytearray(path.read_bytes())
            contents[len(MPR_MAGIC_PREFIX) + 3] = ord("X")
            path.write_bytes(contents)
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_recognized_truncated_header_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "truncated-header.mpr"
            path.write_bytes(MPR_MAGIC_PREFIX + b" " * 5)
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_unrelated_short_file_is_unsupported(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "short-not-mpr.mpr"
            path.write_bytes(b"not an MPR")
            with self.assertRaises(UnsupportedMprError):
                read_mpr(path)

    def test_truncated_module_header_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "truncated-module.mpr"
            path.write_bytes(_MAGIC_HEADER + b"MODULE")
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

    def test_rejects_nonzero_old_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), data_old_version=1)
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

    def test_skips_unknown_optional_module_by_declared_length(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), unknown_modules=1)
            with read_mpr(path) as document:
                self.assertEqual(len(document.modules), 4)
                self.assertEqual(document.modules[-1].module_type, "EXT")

    def test_missing_data_module_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), include_data=False)
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_decodes_known_typed_values_and_packed_flags_vectorially(self) -> None:
        expected = np.zeros(2, dtype=MPR_RECORD_DTYPE)
        expected["flags"] = [0xB5, 0x08]
        expected["ns"] = [17, 18]
        expected["time_s"] = [1.25, 2.5]
        expected["dq_mAh"] = [-0.125, 0.25]
        expected["q_minus_q0_mAh"] = [-1.5, -1.25]
        expected["control_v_or_mA"] = [-7.69, 0.5]
        expected["working_potential_v"] = [1.4368, 1.2]
        expected["counter_potential_v"] = [-0.00015, 0.0002]
        expected["current_range"] = [10, 11]
        expected["q_charge_discharge_mAh"] = [-0.125, 0.25]
        expected["half_cycle"] = [0, 4]

        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(
                Path(temp),
                data_payload=_data_payload(
                    n_datapoints=2,
                    record_itemsize=MPR_RECORD_DTYPE.itemsize,
                    record_bytes=expected.tobytes(),
                ),
            )
            with read_mpr(path) as document:
                actual = document.vmp_data.records.copy()
                actual_flags = {
                    name: values.copy() for name, values in document.vmp_data.flags.items()
                }
            for field_name in MPR_RECORD_DTYPE.names:
                np.testing.assert_allclose(actual[field_name], expected[field_name])
            self.assertEqual(actual_flags["mode"].tolist(), [1, 0])
            self.assertEqual(actual_flags["oxidation_reduction"].tolist(), [True, False])
            self.assertEqual(actual_flags["error"].tolist(), [False, True])
            self.assertEqual(actual_flags["control_changed"].tolist(), [True, False])
            self.assertEqual(actual_flags["ns_changed"].tolist(), [True, False])
            self.assertEqual(actual_flags["counter_incremented"].tolist(), [True, False])

    def test_large_fixture_uses_one_typed_bulk_array(self) -> None:
        n_datapoints = 50_000
        records = np.zeros(n_datapoints, dtype=MPR_RECORD_DTYPE)
        records["ns"] = np.arange(n_datapoints, dtype=np.uint16)
        records["time_s"] = np.arange(n_datapoints, dtype=np.float64)
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(
                Path(temp),
                data_payload=_data_payload(
                    n_datapoints=n_datapoints,
                    record_itemsize=MPR_RECORD_DTYPE.itemsize,
                    record_bytes=records.tobytes(),
                ),
            )
            with read_mpr(path) as document:
                self.assertEqual(document.vmp_data.records.shape, (n_datapoints,))
                self.assertEqual(document.vmp_data.records.dtype, MPR_RECORD_DTYPE)

    def test_production_reader_has_no_gpl_parser_dependency(self) -> None:
        source = Path("backend/app/services/biologic_mpr.py").read_text(encoding="utf-8").lower()
        for prohibited in ("galvani", "bio_logic.mprfile", "mprfile"):
            self.assertNotIn(prohibited, source)


if __name__ == "__main__":
    unittest.main()
