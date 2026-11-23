"""Synthetic Maccor 4608 streams. No instrument files are required."""
from __future__ import annotations

import struct
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from backend.app.routers import files
from backend.app.services import (
    cache, calc, canonical_cycling, cell_folder_watch, exploratory_plotting, import_file_hints, import_inspection,
    import_search_worker, maccor_binary, parsing,
)
from backend.app.services.filesystem_cleanup import TemporaryDirectory
from backend.app.services.source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


CYCLING_STEPS = ("Rest", "Do 1", "Charge", "Charge", "Dischrge", "Loop 1", "End")
# Zero-based step, mode, status, range, current ADC, step ticks, Ah units, Wh units.
# The two consecutive charge steps deliberately share a counter.
CYCLING_RECORDS = [
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


def operation(step, mode, scale, end=133):
    current = 0 if mode == 4 else 65535
    increment = int(mode != 4)
    return [(step, mode, 0, scale, current, 0, 0, 0),
            (step, mode, end, scale, current, 100, increment, increment)]


def channel_file(steps=CYCLING_STEPS, records=CYCLING_RECORDS, fields=None) -> bytes:
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
    output = header + setup
    unit = 65535 * 100 * 3600
    for rec, (step, mode, end, scale, current, clock, cap, energy) in enumerate(records, 1):
        row = bytearray(264)
        struct.pack_into('<dBBB', row, 0, 46000.5 + rec / 86400, 2, mode, end)
        if fields is not None:
            struct.pack_into('<I', row, 11, fields[rec - 1])
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

    def test_witnessed_standby_and_resume_keep_measured_counters_and_plot_break(self):
        steps = ("Dischrge", "Charge", "End")
        records = [
            (0, 2, 0, 0xAAAA, 5000, 0, 0, 0),
            (0, 2, 5, 0xAAAA, 5000, 100, 1, 1),
            (0, 30, 192, 0x2222, 5000, 110, 2, 2),
            (0, 2, 0, 0xAAAA, 5000, 120, 3, 3),
            (0, 29, 254, 0x2222, 5000, 130, 4, 4),
            (0, 2, 129, 0xAAAA, 5000, 140, 5, 5),
            (1, 1, 0, 0xEEEE, 5000, 0, 0, 0),
            (1, 29, 195, 0x6666, 5000, 40, 1, 1),
            (1, 1, 0, 0xEEEE, 5000, 50, 2, 2),
            (1, 29, 253, 0x6666, 5000, 60, 3, 3),
            (1, 1, 0, 0xEEEE, 5000, 70, 4, 4),
            (1, 1, 133, 0xEEEE, 5000, 80, 5, 5),
        ]
        self.path.write_bytes(channel_file(steps, records))
        raw = parsing.parse_timeseries(self.path)
        canonical_cycling.validate_raw_timeseries(raw)
        self.assertEqual(raw.record_index.tolist(), [1, 2, *range(4, 13)])
        self.assertEqual(exploratory_plotting.break_before(raw), [2])
        self.assertEqual(raw.step.tolist(), [1] * 5 + [2] * 6)
        sb = raw[raw.status.eq("Standby")]
        self.assertEqual(sb.maccor_standby_phase.tolist(), ["discharge", "charge", "charge"])
        self.assertTrue(sb.current_ma.eq(0).all())
        np.testing.assert_allclose(raw.discharge_capacity_mah.iloc[:5], [0, .15, .45, .60, .75])
        summary, = calc.per_cycle(raw).itertuples()
        np.testing.assert_allclose([summary.charge_capacity_mah, summary.discharge_capacity_mah], [.75, .75])
        self.assertTrue(raw.cycle_complete.all())

        # A file can stop recording on a witnessed 253. This leaves the last cycle open.
        self.path.write_bytes(channel_file(steps, records[:-1] + [(1, 29, 253, 0x6666, 5000, 80, 5, 5)]))
        raw = parsing.parse_timeseries(self.path)
        self.assertEqual(raw.status.iat[-1], "Standby")
        self.assertEqual(raw.current_ma.iat[-1], 0)
        self.assertTrue(calc.per_cycle(raw).empty)

    def test_standby_codes_and_stop_resumes_require_matching_evidence(self):
        steps = ("Charge", "Dischrge", "End")
        before = (0, 1, 5, 0xEEEE, 5000, 10, 1, 1)
        stop = (0, 30, 192, 0x6666, 5000, 11, 2, 2)
        after = (0, 1, 0, 0xEEEE, 5000, 12, 3, 3)
        for records in (
            [before, stop, (1, 2, 0, 0xAAAA, 5000, 12, 3, 3)],
            [before, stop, (0, 1, 5, 0xEEEE, 5000, 12, 3, 3)],
            [before, stop, (0, 1, 0, 0xEEEE, 5000, 10, 3, 3)],
            [before, stop, (0, 1, 0, 0xEEEE, 5000, 12, 1, 3)],
            [before, stop, (0, 1, 0, 0xEEEE, 5000, 12, 3, 1)],
            [stop, after], [before, stop, stop, after],
            [before, (0, 29, 253, 0x2222, 5000, 11, 2, 2), after],
            [before, (0, 29, 252, 0x6666, 5000, 11, 2, 2), after],
            [(1, 2, 0, 0xAAAA, 5000, 10, 1, 1), (1, 29, 253, 0x6666, 5000, 11, 2, 2)],
            [before, (0, 1, 253, 0xEEEE, 5000, 11, 2, 2), after],
            [before, (0, 29, 253, 0x6666, 5000, 11, 2, 2), (1, 2, 0, 0xAAAA, 5000, 12, 3, 3)],
        ):
            with self.subTest(records=records):
                self.path.write_bytes(channel_file(steps, records))
                with self.assertRaises(parsing.SourceFormatError):
                    parsing.parse_timeseries(self.path)

        for fields in ([0, 0x03000000, 0], [0, 0, 0x03000000]):
            self.path.write_bytes(channel_file(steps, [before, stop, after], fields))
            with self.assertRaises(UnsupportedSourceFormatError):
                parsing.parse_timeseries(self.path)
        data = bytearray(channel_file(steps, [before, stop, after]))
        struct.pack_into("<d", data, len(data) - 264, 46000.5)
        self.path.write_bytes(data)
        with self.assertRaises(UnsupportedSourceFormatError):
            parsing.parse_timeseries(self.path)

    def test_new_standby_range_combinations_require_the_bipolar_5a_profile(self):
        active = (0, 1, 0, 0xFFFF, 100, 0, 0, 0)
        standby = (0, 29, 253, 0x6666, 100, 1, 1, 1)
        data = bytearray(channel_file(("Charge", "End"), [active, standby]))
        for base in (416, 576):
            struct.pack_into("<f", data, base + 2, 50)
            struct.pack_into("<4d", data, base + 106, 100, 10, 50000, 1)
        struct.pack_into("<ff", data, 738, 0, 5)
        self.path.write_bytes(data)
        with self.assertRaisesRegex(UnsupportedSourceFormatError, "current range code"):
            parsing.parse_timeseries(self.path)

    def test_cycle_window_import_preview_keeps_resume_break_and_standby_capacity(self):
        steps = ("Do 1", "Charge", "Dischrge", "Loop 1", "End")
        records = [
            (1, 1, 0, 0xEEEE, 5000, 0, 0, 0),
            (1, 1, 5, 0xEEEE, 5000, 100, 1, 1),
            (1, 30, 192, 0x6666, 5000, 110, 2, 2),
            (1, 1, 0, 0xEEEE, 5000, 120, 3, 3),
            (1, 29, 253, 0x6666, 5000, 130, 4, 4),
            (1, 1, 129, 0xEEEE, 5000, 140, 5, 5),
            *operation(2, 2, 0xAAAA, end=129),
        ]
        self.path.write_bytes(channel_file(steps, records * 2))
        with patch.object(cache, "CACHE_DIR", self.path.parent / "cache"):
            key = parsing.compute_hash(self.path)
            info = cache.build(key, self.path)
            source = {"hash": key, "parser_version": info["parser_version"],
                      "source_key": "maccor", "filename": self.path.name}
            with patch.object(cache, "load_raw", side_effect=AssertionError("full raw read")):
                for axis in ("time", "capacity"):
                    preview = files._build_continuation_preview(
                        [source], quantity="voltage", voltage_x_axis=axis, cycle_start=2, cycle_end=2)
                    segment, = preview["segments"]
                    self.assertEqual(segment["display_break_before"], [2])
                    if axis == "capacity":
                        np.testing.assert_allclose(segment["x"], [0, .15, .45, .60, .75, .75, .90])

    def test_linear_rest_and_single_direction_recordings_keep_only_measurements(self):
        rest = operation(0, 4, 0xBBBB, end=129)
        stop = (0, 30, 192, 0x3333, 0, 110, 0, 0)
        for steps, records, current in (
            (("Rest", "End"), [*rest, stop], [0, 0]),
            (("Rest", "Charge", "End"), rest + operation(1, 1, 0xCCCC), [0, 0, 5000, 5000]),
            (("Dischrge", "End"), operation(0, 2, 0x8888), [-5000, -5000]),
        ):
            with self.subTest(steps=steps):
                self.path.write_bytes(channel_file(steps, records, [0x03000000] * len(records)))
                raw = parsing.parse_timeseries(self.path)
                np.testing.assert_allclose(raw.current_ma, current)
                self.assertTrue(raw.cycle.eq(1).all())
                self.assertFalse(raw.cycle_complete.any())
                self.assertTrue(raw.maccor_program_field.eq(0x03000000).all())
        # A stop in the middle of the source must never trim the rest of the file.
        self.path.write_bytes(channel_file(("Rest", "End"), rest + [stop] + rest))
        with self.assertRaisesRegex(UnsupportedSourceFormatError, "only at the end"):
            parsing.parse_timeseries(self.path)

    def test_discharge_first_and_linear_preamble_pair_only_observed_phases(self):
        preamble = operation(0, 2, 0xBBBB) + operation(1, 1, 0xFFFF, end=136)
        rest = operation(3, 4, 0xBBBB, end=199)
        pair = operation(4, 2, 0x9999) + operation(5, 1, 0xDDDD)
        steps = ("Dischrge", "Charge", "Do 2", "Rest", "Dischrge", "Charge", "Loop 2", "End")
        self.path.write_bytes(channel_file(steps, preamble + rest + pair + rest + pair[:1]))
        raw = parsing.parse_timeseries(self.path)
        self.assertEqual(raw.cycle.tolist(), [1] * 6 + [2] * 6 + [3])
        self.assertEqual(raw.cycle_complete.tolist(), [True] * 12 + [False])
        np.testing.assert_allclose(raw.current_ma.iloc[[0, 2, 6, 8]], [-.15, .15, -150, 150])
        # Some steps may emit no samples. Earlier charge-first files retain their labels.
        self.path.write_bytes(channel_file(CYCLING_STEPS, CYCLING_RECORDS[2:4] + CYCLING_RECORDS[6:]))
        self.assertEqual(parsing.parse_timeseries(self.path).cycle.tolist(), [1] * 6 + [2])

    def test_advcycle_is_checked_at_the_executed_control_edge(self):
        steps = ("Rest", "Do 1", "AdvCycle", "Charge", "Dischrge", "Loop 1", "End")
        rest = operation(0, 4, 0xBBBB, end=129)
        pair = operation(3, 1, 0xDDDD) + operation(4, 2, 0x9999)
        end = (6, 31, 193, 0x1111, 65535, 100, 1, 1)
        rows = rest + pair + pair + [end]
        fields = [0, 0] + [1] * 4 + [2] * 5
        self.path.write_bytes(channel_file(steps, rows, fields))
        raw = parsing.parse_timeseries(self.path)
        self.assertEqual(raw.cycle.tolist(), [1] * 6 + [2] * 4)
        self.assertEqual(raw.maccor_program_cycle.tolist(), fields[:-1])
        self.assertTrue(raw.cycle_complete.all())
        self.assertIn("AdvCycle", parsing.read_header_metadata(self.path)["raw"]["Maccor"]["Cycle basis"])
        for bad in (fields[:6] + [1] * 5, fields[:6] + [3] * 5, [0, 0, 1, 2] + fields[4:]):
            self.path.write_bytes(channel_file(steps, rows, bad))
            with self.assertRaisesRegex(InvalidSourceFormatError, "program counter"):
                parsing.parse_timeseries(self.path)
        self.path.write_bytes(channel_file(steps, rest + pair[2:], [0, 0, 1, 1]))
        with self.assertRaisesRegex(InvalidSourceFormatError, "step transition"):
            parsing.parse_timeseries(self.path)

    def test_identical_short_pulse_endpoints_cannot_establish_delivered_capacity(self):
        steps = ("Charge", "Dischrge", "End")
        rows = [(i, mode, es, code, 1000, 3, 1, 1)
                for i, mode, code in [(0, 1, 0xDDDD), (1, 2, 0x9999)] for es in (0, 133)]
        self.path.write_bytes(channel_file(steps, rows))
        raw = parsing.parse_timeseries(self.path)
        self.assertEqual(len(raw), 4)
        self.assertFalse(raw.cycle_complete.any())
        self.assertTrue(raw[["charge_capacity_mah", "discharge_capacity_mah"]].eq(0).all().all())
