from __future__ import annotations

import os
from pathlib import Path
import struct
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import backend.app.services.biologic_mpr as biologic_mpr

from backend.app.services.biologic_mpr import (
    InvalidMprError,
    MPR_COLUMN_DEFINITIONS,
    MPR_MAGIC,
    MPR_MAGIC_PREFIX,
    MPR_MAX_COLUMNS,
    MPR_MAX_FILE_SIZE,
    MPR_MAX_MODULE_COUNT,
    MPR_MODULE_HEADER_SIZE,
    MPR_FLAG_ALIAS_IDS,
    MPR_PHYSICAL_COLUMN_IDS,
    MPR_FLAG_DEFINITIONS,
    MPR_RECORD_DTYPE,
    SUPPORTED_GCPL_COLUMN_IDS,
    UnsupportedMprColumn,
    UnsupportedMprError,
    UnsupportedMprModuleVersion,
    MprError,
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
    short_name: bytes = b"VMP data  ",
) -> bytes:
    header = (
        b"MODULE"
        + short_name.ljust(10, b" ")[:10]
        + long_name.ljust(25, b" ")[:25]
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


def _literal_record_bytes(
    *,
    flags: tuple[int, ...],
    raw_sample_index: tuple[int, ...],
    elapsed_time_s: tuple[float, ...],
    raw_dq_mAh: tuple[float, ...],
    raw_q_minus_q0_mAh: tuple[float, ...],
    raw_control_v_or_mA: tuple[float, ...],
    raw_ewe_v: tuple[float, ...],
    raw_ece_v: tuple[float, ...],
    raw_current_range_code: tuple[int, ...],
    raw_q_charge_discharge_mAh: tuple[float, ...],
    raw_half_cycle_index: tuple[int, ...],
) -> bytes:
    """Encode known records from literal offsets, independently of production dtype."""

    columns = (
        flags,
        raw_sample_index,
        elapsed_time_s,
        raw_dq_mAh,
        raw_q_minus_q0_mAh,
        raw_control_v_or_mA,
        raw_ewe_v,
        raw_ece_v,
        raw_current_range_code,
        raw_q_charge_discharge_mAh,
        raw_half_cycle_index,
    )
    assert len({len(column) for column in columns}) == 1
    records = bytearray(len(flags) * 53)
    field_specs = (
        (0, "<B", flags),
        (1, "<H", raw_sample_index),
        (3, "<d", elapsed_time_s),
        (11, "<d", raw_dq_mAh),
        (19, "<d", raw_q_minus_q0_mAh),
        (27, "<f", raw_control_v_or_mA),
        (31, "<f", raw_ewe_v),
        (35, "<f", raw_ece_v),
        (39, "<H", raw_current_range_code),
        (41, "<d", raw_q_charge_discharge_mAh),
        (49, "<I", raw_half_cycle_index),
    )
    for index in range(len(flags)):
        base = index * 53
        for offset, format_string, values in field_specs:
            struct.pack_into(format_string, records, base + offset, values[index])
    return bytes(records)


def _two_electrode_record_bytes() -> bytes:
    """Encode one verified Ewe-primary record with the Ece field omitted."""

    records = bytearray(49)
    struct.pack_into("<B", records, 0, 0x21)
    struct.pack_into("<H", records, 1, 1)
    struct.pack_into("<d", records, 3, 2.5)
    struct.pack_into("<d", records, 11, 0.0)
    struct.pack_into("<d", records, 19, 0.0)
    struct.pack_into("<f", records, 27, 1000.0)
    struct.pack_into("<f", records, 31, 3.7)
    struct.pack_into("<H", records, 35, 10)
    struct.pack_into("<d", records, 37, 0.0)
    struct.pack_into("<I", records, 45, 0)
    return bytes(records)


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
            b"VMP settings",
            b"settings",
            version=set_version,
            old_version=set_old_version,
            short_name=b"VMP Set   ",
        ),
    ]
    if include_data:
        modules.append(
            _module(
                b"VMP data",
                payload,
                version=data_version,
                old_version=data_old_version,
            )
        )
    if include_log:
        modules.append(
            _module(
                b"VMP LOG",
                b"log",
                version=log_version,
                old_version=log_old_version,
                short_name=b"VMP LOG   ",
            )
        )
    for index in range(unknown_modules):
        modules.append(
            _module(
                f"optional {index}".encode("ascii"),
                b"optional",
                version=1,
                short_name=b"EXT       ",
            )
        )
    path = directory / "fixture.mpr"
    path.write_bytes(_MAGIC_HEADER + b"".join(modules))
    return path


class BiologicMprReaderTests(unittest.TestCase):
    def test_reads_declared_modules_and_owns_typed_records(self) -> None:
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
                self.assertIsNone(document.vmp_data.records.base)
                self.assertEqual(document.vmp_data.flags["mode"].shape, (2,))
                self.assertEqual(document.vmp_set.short_name, "VMP Set")
                self.assertEqual(document.vmp_set.long_name, "VMP settings")
                self.assertEqual(document.vmp_data.module.short_name, "VMP data")
                self.assertEqual(document.vmp_data.module.long_name, "VMP data")

    def test_log_module_is_optional_at_low_level(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), include_log=False)
            with read_mpr(path) as document:
                self.assertIsNone(document.vmp_log)

    def test_bounded_two_electrode_subset_omits_ece_without_guessing_widths(self) -> None:
        column_ids = tuple(column_id for column_id in SUPPORTED_GCPL_COLUMN_IDS if column_id != 9)
        with tempfile.TemporaryDirectory() as temp:
            payload = _data_payload(
                n_datapoints=1,
                column_ids=column_ids,
                record_itemsize=49,
                record_bytes=_two_electrode_record_bytes(),
            )
            path = _write_fixture(Path(temp), data_payload=payload)
            with read_mpr(path) as document:
                self.assertEqual(document.vmp_data.column_ids, column_ids)
                self.assertEqual(document.vmp_data.record_itemsize, 49)
                self.assertNotIn("raw_ece_v", document.vmp_data.records.dtype.names)
                self.assertAlmostEqual(float(document.vmp_data.records["raw_ewe_v"][0]), 3.7)

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

    def test_column_definitions_cover_exact_layout_and_storage_roles(self) -> None:
        self.assertEqual(
            tuple(MPR_COLUMN_DEFINITIONS[column_id].encoded_id for column_id in SUPPORTED_GCPL_COLUMN_IDS),
            SUPPORTED_GCPL_COLUMN_IDS,
        )
        self.assertEqual(
            tuple(
                column_id
                for column_id in SUPPORTED_GCPL_COLUMN_IDS
                if MPR_COLUMN_DEFINITIONS[column_id].storage_kind == "packed_flag_alias"
            ),
            MPR_FLAG_ALIAS_IDS,
        )
        self.assertEqual(
            MPR_COLUMN_DEFINITIONS[1].flag_names,
            ("mode",),
        )
        for column_id in SUPPORTED_GCPL_COLUMN_IDS:
            definition = MPR_COLUMN_DEFINITIONS[column_id]
            physical = MPR_COLUMN_DEFINITIONS[definition.physical_id]
            self.assertEqual(definition.field_name, physical.field_name)
            self.assertEqual(definition.record_offset, physical.record_offset)
            self.assertEqual(definition.dtype, physical.dtype)
        for column_id in MPR_PHYSICAL_COLUMN_IDS:
            definition = MPR_COLUMN_DEFINITIONS[column_id]
            self.assertEqual(
                biologic_mpr.MPR_RECORD_DTYPE.fields[definition.field_name][1],
                definition.record_offset,
            )
        self.assertEqual(
            [(definition.name, definition.mask, definition.shift, definition.boolean) for definition in MPR_FLAG_DEFINITIONS],
            [
                ("mode", 0x03, 0, False),
                ("oxidation_reduction", 0x04, 2, True),
                ("error", 0x08, 3, True),
                ("control_changed", 0x10, 4, True),
                ("ns_changed", 0x20, 5, True),
                ("counter_incremented", 0x80, 7, True),
            ],
        )
        self.assertEqual(
            tuple(definition.encoded_id for definition in MPR_FLAG_DEFINITIONS),
            (1, 2, 3, 21, 31, 65),
        )
        expected_flag_by_id = {
            1: ("mode", 0x03, 0, False),
            2: ("oxidation_reduction", 0x04, 2, True),
            3: ("error", 0x08, 3, True),
            21: ("control_changed", 0x10, 4, True),
            31: ("ns_changed", 0x20, 5, True),
            65: ("counter_incremented", 0x80, 7, True),
        }
        for definition in MPR_FLAG_DEFINITIONS:
            self.assertEqual(
                (definition.name, definition.mask, definition.shift, definition.boolean),
                expected_flag_by_id[definition.encoded_id],
            )
            self.assertEqual(
                MPR_COLUMN_DEFINITIONS[definition.encoded_id].flag_names,
                (definition.name,),
            )
            self.assertEqual(MPR_COLUMN_DEFINITIONS[definition.encoded_id].physical_id, 1)
        self.assertEqual(
            MPR_PHYSICAL_COLUMN_IDS,
            (1, 131, 4, 7, 13, 5, 6, 9, 39, 211, 468),
        )

    def test_public_exports_are_defined_and_star_importable(self) -> None:
        self.assertTrue(all(hasattr(biologic_mpr, name) for name in biologic_mpr.__all__))
        namespace: dict[str, object] = {}
        exec("from backend.app.services.biologic_mpr import *", namespace)
        self.assertIn("MPR_RECORD_DTYPE", namespace)

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

    def test_rejects_unverified_column_omission(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            ids = tuple(
                column_id
                for column_id in SUPPORTED_GCPL_COLUMN_IDS
                if column_id not in {9, 39}
            )
            path = _write_fixture(Path(temp), data_payload=_data_payload(column_ids=ids))
            with self.assertRaises(UnsupportedMprColumn):
                read_mpr(path)

    def test_required_module_names_use_exact_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            contents = bytearray(path.read_bytes())
            contents[52 + 16 : 52 + 16 + 25] = b"settings extension".ljust(25, b" ")
            path.write_bytes(contents)
            with self.assertRaises(UnsupportedMprError):
                read_mpr(path)

    def test_data_module_name_collision_is_not_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            contents = bytearray(path.read_bytes())
            data_offset = 52 + MPR_MODULE_HEADER_SIZE + 8
            contents[data_offset + 16 : data_offset + 16 + 25] = b"database extension".ljust(25, b" ")
            path.write_bytes(contents)
            with self.assertRaises(InvalidMprError):
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
                + _module(b"VMP settings", b"settings", version=10, short_name=b"VMP Set   ")
                + _module(b"VMP data", payload, version=11)
                + _module(b"VMP data", payload, version=11)
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

    def test_module_count_bound_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp), unknown_modules=MPR_MAX_MODULE_COUNT)
            with self.assertRaises(UnsupportedMprError):
                read_mpr(path)

    def test_file_size_bound_fails_before_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with patch(
                "backend.app.services.biologic_mpr.os.fstat",
                return_value=SimpleNamespace(st_size=MPR_MAX_FILE_SIZE + 1),
            ):
                with self.assertRaises(UnsupportedMprError):
                    read_mpr(path)

    def test_growth_between_stat_and_mapping_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            real_mmap = biologic_mpr.mmap.mmap

            def grow_before_mapping(*args, **kwargs):
                with path.open("ab") as handle:
                    handle.write(b"growth")
                return real_mmap(*args, **kwargs)

            with patch(
                "backend.app.services.biologic_mpr.mmap.mmap",
                side_effect=grow_before_mapping,
            ):
                with self.assertRaises(InvalidMprError):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-growth.mpr")
            path.rename(renamed)

    def test_shrink_between_stat_and_mapping_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            original_size = path.stat().st_size
            real_mmap = biologic_mpr.mmap.mmap

            def shrink_before_mapping(*args, **kwargs):
                with path.open("r+b") as handle:
                    handle.truncate(original_size - 1)
                return real_mmap(*args, **kwargs)

            with patch(
                "backend.app.services.biologic_mpr.mmap.mmap",
                side_effect=shrink_before_mapping,
            ):
                with self.assertRaises(InvalidMprError):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-shrink.mpr")
            path.rename(renamed)

    def test_same_size_rewrite_between_stat_and_mapping_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            original_mtime = path.stat().st_mtime_ns
            real_mmap = biologic_mpr.mmap.mmap

            def rewrite_before_mapping(*args, **kwargs):
                with path.open("r+b") as handle:
                    handle.seek(290)
                    first = handle.read(1)
                    handle.seek(290)
                    handle.write(bytes([first[0] ^ 1]))
                os.utime(path, ns=(path.stat().st_atime_ns, original_mtime + 1_000_000))
                return real_mmap(*args, **kwargs)

            with patch(
                "backend.app.services.biologic_mpr.mmap.mmap",
                side_effect=rewrite_before_mapping,
            ):
                with self.assertRaisesRegex(InvalidMprError, "changed between stat and memory mapping"):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-same-size-before-map.mpr")
            path.rename(renamed)

    def test_mapped_actual_size_above_limit_fails_even_with_stale_small_stat(self) -> None:
        class OversizedMapping:
            def __len__(self):
                return MPR_MAX_FILE_SIZE + 1

            def close(self):
                return None

        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with patch(
                "backend.app.services.biologic_mpr.mmap.mmap",
                return_value=OversizedMapping(),
            ):
                with self.assertRaises(UnsupportedMprError):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-oversize.mpr")
            path.rename(renamed)

    def test_growth_after_mapping_fails_before_return(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            real_fstat = biologic_mpr.os.fstat
            calls = 0

            def report_growth(fd):
                nonlocal calls
                result = real_fstat(fd)
                calls += 1
                if calls == 3:
                    values = list(result)
                    values[6] += 1
                    return os.stat_result(values)
                return result

            with patch("backend.app.services.biologic_mpr.os.fstat", side_effect=report_growth):
                with self.assertRaises(InvalidMprError):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-final-growth.mpr")
            path.rename(renamed)

    def test_same_size_rewrite_after_mapping_fails_before_return(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            original_mtime = path.stat().st_mtime_ns
            real_decode_flags = biologic_mpr._decode_flags

            def rewrite_after_mapping(records):
                with path.open("r+b") as handle:
                    handle.seek(1197)
                    current = handle.read(1)
                    handle.seek(1197)
                    handle.write(bytes([current[0] ^ 1]))
                os.utime(path, ns=(path.stat().st_atime_ns, original_mtime + 2_000_000))
                return real_decode_flags(records)

            with patch(
                "backend.app.services.biologic_mpr._decode_flags",
                side_effect=rewrite_after_mapping,
            ):
                with self.assertRaises(InvalidMprError):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-same-size-after-map.mpr")
            path.rename(renamed)

    def test_column_count_bound_fails_before_layout_guessing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            ids = tuple(range(MPR_MAX_COLUMNS + 1))
            path = _write_fixture(Path(temp), data_payload=_data_payload(column_ids=ids))
            with self.assertRaises(InvalidMprError):
                read_mpr(path)

    def test_decodes_known_typed_values_and_packed_flags_vectorially(self) -> None:
        record_bytes = _literal_record_bytes(
            flags=(0xB5, 0x08),
            raw_sample_index=(17, 18),
            elapsed_time_s=(1.25, 2.5),
            raw_dq_mAh=(-0.125, 0.25),
            raw_q_minus_q0_mAh=(-1.5, -1.25),
            raw_control_v_or_mA=(-7.69, 0.5),
            raw_ewe_v=(1.4368, 1.2),
            raw_ece_v=(-0.00015, 0.0002),
            raw_current_range_code=(10, 11),
            raw_q_charge_discharge_mAh=(-0.125, 0.25),
            raw_half_cycle_index=(0, 4),
        )
        expected = {
            "raw_flags": (0xB5, 0x08),
            "raw_sample_index": (17, 18),
            "elapsed_time_s": (1.25, 2.5),
            "raw_dq_mAh": (-0.125, 0.25),
            "raw_q_minus_q0_mAh": (-1.5, -1.25),
            "raw_control_v_or_mA": (-7.69, 0.5),
            "raw_ewe_v": (1.4368, 1.2),
            "raw_ece_v": (-0.00015, 0.0002),
            "raw_current_range_code": (10, 11),
            "raw_q_charge_discharge_mAh": (-0.125, 0.25),
            "raw_half_cycle_index": (0, 4),
        }

        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(
                Path(temp),
                data_payload=_data_payload(
                    n_datapoints=2,
                    record_itemsize=MPR_RECORD_DTYPE.itemsize,
                    record_bytes=record_bytes,
                ),
            )
            with read_mpr(path) as document:
                actual = document.vmp_data.records.copy()
                actual_flags = {
                    name: values.copy() for name, values in document.vmp_data.flags.items()
                }
            for field_name, expected_values in expected.items():
                np.testing.assert_allclose(actual[field_name], expected_values)
            expected_flags = {
                "mode": [1, 0],
                "oxidation_reduction": [True, False],
                "error": [False, True],
                "control_changed": [True, False],
                "ns_changed": [True, False],
                "counter_incremented": [True, False],
            }
            self.assertEqual(actual_flags.keys(), expected_flags.keys())
            for name, expected_values in expected_flags.items():
                self.assertEqual(actual_flags[name].tolist(), expected_values)

    def test_large_fixture_uses_one_typed_bulk_array(self) -> None:
        n_datapoints = 500_000
        records = bytearray(n_datapoints * MPR_RECORD_DTYPE.itemsize)
        for index in range(n_datapoints):
            struct.pack_into("<H", records, index * MPR_RECORD_DTYPE.itemsize + 1, index % 65536)
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(
                Path(temp),
                include_log=False,
                data_payload=_data_payload(
                    n_datapoints=n_datapoints,
                    record_itemsize=MPR_RECORD_DTYPE.itemsize,
                    record_bytes=bytes(records),
                ),
            )
            started = time.perf_counter()
            with read_mpr(path) as document:
                self.assertEqual(document.vmp_data.records.shape, (n_datapoints,))
                self.assertEqual(document.vmp_data.records.dtype, MPR_RECORD_DTYPE)
                self.assertEqual(document.vmp_data.records.nbytes, n_datapoints * 53)
            self.assertLess(time.perf_counter() - started, 10.0)

    def test_owned_records_survive_document_close(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with read_mpr(path) as document:
                records = document.vmp_data.records
            self.assertEqual(records.shape, (2,))
            self.assertEqual(int(records["raw_sample_index"][0]), 513)

    def test_retained_payload_requires_release_then_close_is_retryable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            document = read_mpr(path)
            payload = document.vmp_set.payload
            with self.assertRaises(MprError):
                document.close()
            self.assertFalse(document._closed)
            payload.release()
            document.close()
            document.close()
            self.assertTrue(document._closed)

    def test_body_exception_is_not_masked_by_retained_payload_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            document = None
            payload = None
            with self.assertRaisesRegex(ValueError, "body failure"):
                with read_mpr(path) as document:
                    payload = document.vmp_set.payload
                    raise ValueError("body failure")
            payload.release()
            document.close()

    def test_decode_flags_failure_preserves_original_error_and_closes_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with patch(
                "backend.app.services.biologic_mpr._decode_flags",
                side_effect=RuntimeError("flag sentinel"),
            ):
                with self.assertRaisesRegex(RuntimeError, "flag sentinel"):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-flag-failure.mpr")
            path.rename(renamed)

    def test_frombuffer_failure_preserves_original_error_and_closes_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with patch(
                "backend.app.services.biologic_mpr.np.frombuffer",
                side_effect=RuntimeError("frombuffer sentinel"),
            ):
                with self.assertRaisesRegex(RuntimeError, "frombuffer sentinel"):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-frombuffer-failure.mpr")
            path.rename(renamed)

    def test_record_copy_failure_preserves_original_error_and_closes_file(self) -> None:
        class CopyBomb:
            def copy(self):
                raise RuntimeError("copy sentinel")

        with tempfile.TemporaryDirectory() as temp:
            path = _write_fixture(Path(temp))
            with patch(
                "backend.app.services.biologic_mpr.np.frombuffer",
                return_value=CopyBomb(),
            ):
                with self.assertRaisesRegex(RuntimeError, "copy sentinel"):
                    read_mpr(path)
            renamed = path.with_name("renamed-after-copy-failure.mpr")
            path.rename(renamed)

    def test_production_reader_has_no_gpl_parser_dependency(self) -> None:
        production_sources = (
            Path("backend/app/services/biologic_mpr.py"),
            Path("backend/app/services/biologic_gcpl.py"),
        )
        for source_path in production_sources:
            source = source_path.read_text(encoding="utf-8").lower()
            for prohibited in ("galvani", "bio_logic.mprfile", "mprfile", "pyec-lab", "pympr"):
                self.assertNotIn(prohibited, source, str(source_path))
        for relative in (
            "backend/requirements.txt",
            "requirements.txt",
            "pyproject.toml",
            "setup.py",
            "backend/app/main.py",
        ):
            candidate = Path(relative)
            if candidate.exists():
                dependency_text = candidate.read_text(encoding="utf-8").lower()
                for prohibited in ("galvani", "bio_logic.mprfile", "mprfile", "pyec-lab", "pympr"):
                    self.assertNotIn(prohibited, dependency_text, str(candidate))


if __name__ == "__main__":
    unittest.main()
