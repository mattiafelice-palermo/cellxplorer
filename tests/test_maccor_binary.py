"""Synthetic Maccor 4608 streams. No instrument files are required."""
from __future__ import annotations

import struct
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from backend.app.routers import files
from backend.app.services import (
    cache, canonical_cycling, cell_folder_watch, import_file_hints, import_inspection,
    import_search_worker, maccor_binary, parsing,
)
from backend.app.services.filesystem_cleanup import TemporaryDirectory
from backend.app.services.source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


def channel_file() -> bytes:
    steps = ("Rest", "Do 1", "Charge", "Charge", "Dischrge", "Loop 1", "End")
    xml = ('<?xml version="1.0"?><?maccor-application progid="Maccor Procedure File"?>'
           '<MaccorTestProcedure><header><FileFormatVersion><BTVersion>11</BTVersion>'
           '</FileFormatVersion></header><ProcSteps>' +
           ''.join(f'<TestStep><StepType>{kind}</StepType></TestStep>' for kind in steps) +
           '</ProcSteps></MaccorTestProcedure>').encode()
    program = 1500
    procedure = program + 816 * (len(steps) + 1)
    names = b'Synthetic.000Battery'
    tester = b'Maccor #0'
    xml_end = procedure + len(xml)
    record_start = xml_end + 20 + len(tester)
    header = bytearray(record_start)
    for at, offset in {2: 416, 6: 746, 16: 810, 20: 810 + len(names), 100: program,
                       150: xml_end, 166: xml_end + 20, 32: record_start}.items():
        struct.pack_into('<I', header, at, offset + 1)
    struct.pack_into('<H', header, 36, 264)
    struct.pack_into('<I', header, 104, len(steps) + 1)
    struct.pack_into('<H', header, 416, 2)
    for base in (416, 576):
        struct.pack_into('<f', header, base + 2, 5.0)
        struct.pack_into('<4d', header, base + 106, 100000 / 3, 1000, 100 / 3, 1)
    struct.pack_into('<ff', header, 738, -5, 5)
    header[764:769] = b'4608\0'
    header[810:810 + len(names)] = names
    header[procedure:xml_end] = xml
    header[-len(tester):] = tester
    setup = bytearray(264)
    struct.pack_into('<dB', setup, 0, 46000.5, 2)
    # Step numbers in these records are zero-based. Capacity and energy are
    # deliberately carried between the two consecutive charge steps.
    records = [
        # step, mode, status, range, current ADC, step ticks, Ah units, Wh units
        (0, 4, 0,   0x3333, 0, 0, 0, 0),
        (0, 4, 129, 0xBBBB, 0, 100, 0, 0),
        (2, 1, 0,   0xEEEE, 65535, 0, 0, 0),
        (2, 1, 133, 0xEEEE, 65535, 100, 2, 3),
        (3, 1, 0,   0xFFFF, 65535, 0, 2, 3),
        (3, 1, 132, 0xFFFF, 65535, 100, 3, 4),
        (4, 2, 0,   0xAAAA, 65535, 0, 0, 0),
        (4, 29, 195, 0x2222, 4321, 100, 1, 1),
        (4, 2, 0,   0xAAAA, 65535, 100, 1, 1),
        (4, 2, 129, 0xAAAA, 65535, 200, 2, 2),
        (2, 1, 0,   0xEEEE, 65535, 0, 0, 0),
    ]
    output = header + setup
    unit = 65535 * 100 * 3600
    for rec, (step, mode, end, scale, current, clock, cap, energy) in enumerate(records, 1):
        row = bytearray(264)
        struct.pack_into('<dBBB', row, 0, 46000.5 + rec / 86400, 2, mode, end)
        struct.pack_into('<BHH', row, 15, step, current, 0 if mode == 2 else 65535)
        struct.pack_into('<QQQQ', row, 21, rec * 100, clock, cap * unit, energy * unit * 65535)
        struct.pack_into('<IH', row, 230, rec, scale)
        output.extend(row)
    return bytes(output)


class MaccorBinaryTests(unittest.TestCase):
    def setUp(self):
        folder = self.enterContext(TemporaryDirectory())
        self.path = Path(folder) / "synthetic.003"
        self.data = channel_file()
        self.path.write_bytes(self.data)

    def test_numbered_sources_are_screened_before_registration_and_indexing(self):
        other = self.path.with_name("unrelated.047")
        other.write_bytes(b"Unrelated numbered file")
        with patch.object(maccor_binary, "parse_timeseries", side_effect=AssertionError("full parse")):
            self.assertEqual(parsing.recognize_source(self.path), parsing.FORMAT_MACCOR_BINARY)
            self.assertIsNone(parsing.recognize_source(other))
            self.assertEqual(parsing.parser_identity(self.path), parsing.current_parser_identity_for_extension("003"))
            self.assertNotEqual(parsing.source_parser_family(self.path), parsing.source_parser_family("export.txt"))
            meta = import_inspection.inspect_file(str(self.path)).metadata
            self.assertEqual((meta["source_format"], meta["channel"], meta["remarks"]), ("Maccor binary", "3", "Battery"))
            self.assertEqual(meta["raw"]["Maccor"]["Procedure"], "Synthetic.000")
            self.assertEqual(import_file_hints.inspect_header_hint(str(self.path))["supplier"], "Maccor")
            self.assertIs(import_file_hints.inspect_header_hint(str(other))["compatible"], False)
            with self.assertRaises(import_inspection.SourceInspectionRejection):
                import_inspection.inspect_file(str(other))
            staged = files.list_import_sources([], [str(self.path.parent)], screen_sources=True)
            self.assertEqual([f["filename"] for f in staged["files"]], [self.path.name])
            self.assertEqual(staged["skipped"]["unsupported"], 1)
            for path, recognition in ((self.path, "recognized"), (other, "unsupported")):
                stat = path.stat()
                for enabled in (True, False):
                    fact = dict(path=str(path), extension=".NNN", recognition="pending",
                                size=stat.st_size, mtime_ns=stat.st_mtime_ns)
                    self.assertEqual(import_search_worker.inspect_fact(fact, enabled)["recognition"], recognition)
        watch = dict(folder_path=str(self.path.parent), pattern="*", extensions=["003"])
        self.assertEqual([f["filename"] for f in cell_folder_watch.preview_watch_files(watch)["files"]], [self.path.name])
        self.assertEqual(len(cell_folder_watch.preview_watch_files({**watch, "extensions": ["NNN"]})["files"]), 2)
        for suffix in (".000", ".01", ".1000", ".NNN", ".１２０"):
            self.assertFalse(parsing.source_filename_allowed("other" + suffix))

    def test_binary_adc_accumulators_steps_and_partial_tail_survive_cache(self):
        with patch.object(cache, "CACHE_DIR", self.path.parent / "cache"):
            key = parsing.compute_hash(self.path)
            info = cache.build(key, self.path)
            self.assertEqual((info["rows"], info["cycles"]), (11, 1))
            raw = cache.load_raw(key, info["parser_version"])
            cycles = cache.load_cycles(key, info["parser_version"], cache.CALC_VERSION)
        canonical_cycling.validate_raw_timeseries(raw)
        np.testing.assert_array_equal(raw.record_index, np.arange(1, 12))
        np.testing.assert_allclose(raw.total_time_s, np.arange(1, 12))
        np.testing.assert_allclose(raw.time_s, [0, 1, 0, 1, 0, 1, 0, 1, 1, 2, 0])
        np.testing.assert_allclose(raw.current_ma, [0, 0, 5, 5, .15, .15, -5, 0, -5, -5, 5])
        self.assertEqual((raw.voltage_v.min(), raw.voltage_v.max()), (-5.0, 5.0))
        self.assertEqual(raw.step.tolist(), [1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5])
        self.assertEqual(raw.cycle.tolist(), [1] * 10 + [2])
        self.assertEqual(raw.cycle_complete.tolist(), [True] * 10 + [False])
        self.assertEqual(raw.maccor_standby_phase[7], "discharge")
        np.testing.assert_allclose(raw.discharge_capacity_mah[6:10], [0, .15, .15, .30])
        row = cycles.iloc[0]
        np.testing.assert_allclose([row.charge_capacity_mah, row.discharge_capacity_mah,
                                    row.charge_energy_mwh, row.discharge_energy_mwh], [.45, .30, 6, 3])
        self.assertAlmostEqual(row.coulombic_efficiency_pct, 200 / 3)
        self.assertTrue(np.isnan(row.cv_reached))

    def test_unverified_and_corrupted_layouts_fail_explicitly(self):
        start = struct.unpack_from("<I", self.data, 32)[0] - 1
        first = start + 264
        charge = first + 264 * 2
        for offset, replacement, error, message in (
            (36, struct.pack('<H', 260), UnsupportedSourceFormatError, "264-byte"),
            (32, struct.pack('<I', 2**32 - 1), UnsupportedSourceFormatError, "section directory"),
            (418, struct.pack('<f', 10.0), UnsupportedSourceFormatError, "range table"),
            (self.data.index(b'Loop 1'), b'Loop 2', UnsupportedSourceFormatError, "cycle program"),
            (start + 8, b'\x0a', InvalidSourceFormatError, "setup record"),
            (charge + 9, b'\x02', InvalidSourceFormatError, "programmed step"),
            (charge + 234, b'\x00\x01', UnsupportedSourceFormatError, "range code"),
            (first + 230, struct.pack('<I', 2), InvalidSourceFormatError, "consecutive"),
            (first + 8, b'\x04', InvalidSourceFormatError, "channel or step"),
            (first, struct.pack('<d', float('nan')), InvalidSourceFormatError, "date"),
        ):
            with self.subTest(message=message):
                data = bytearray(self.data)
                data[offset:offset + len(replacement)] = replacement
                self.path.write_bytes(data)
                with self.assertRaisesRegex(error, message):
                    parsing.parse_timeseries(self.path)
        for contents in (self.data[:-1], self.data[:first]):
            self.path.write_bytes(contents)
            with self.assertRaisesRegex(InvalidSourceFormatError, "truncated"):
                parsing.parse_timeseries(self.path)
