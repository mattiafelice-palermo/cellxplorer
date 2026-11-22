"""Maccor content dispatch, clock/units and linked section regressions."""
from datetime import datetime
from pathlib import Path
import struct
import unittest

import numpy as np
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.db import Base
from backend.app.routers.files import _ensure_import_source_admitted
from backend.app.services import (
    calc, exploratory_plotting, import_file_hints, import_inspection, import_search_worker,
    maccor_records, parsing, scanner,
)
from backend.app.services.filesystem_cleanup import TemporaryDirectory
from tests.test_maccor_binary import channel_file, operation
from tests.test_maccor_text import export_text


def record_export(current=0.25):
    records = []
    for i, (mode, step, total, t, cap, es) in enumerate((
        ("C", 1, 0, 0, 0, 0), ("C", 1, 3600, 3600, .25, 133),
        ("D", 2, 3600, 0, 0, 0), ("D", 2, 7200, 3600, .25, 133),
        ("C", 1, 7200, 0, 0, 0),
    ), 1):
        clock = f"0d {total // 3600:02}:00:00.00"
        step_clock = f"0d {t // 3600:02}:00:00.00"
        records.append([i, 0, step, clock, step_clock, cap, cap * 3, current, 3, mode, es,
                        f"11/22/2026 {total // 3600:02}:00:00"])
    return records


def link_sections(first, second, *, restart):
    """Relocate the second fixture's one-based directory and setup snapshot."""
    first, second = bytearray(first), bytearray(second)
    start1 = struct.unpack_from("<I", first, 32)[0] - 1
    start2 = struct.unpack_from("<I", second, 32)[0] - 1
    last = len(first) - 264
    rec = struct.unpack_from("<I", first, last + 230)[0]
    elapsed = struct.unpack_from("<Q", first, last + 21)[0]
    struct.pack_into("<I", first, 46, len(first) + 1)
    for field in (2, 6, 16, 20, 32, 100, 150, 166):
        offset = struct.unpack_from("<I", second, field)[0]
        struct.pack_into("<I", second, field, len(first) + offset)
    assert start1 < last
    for pos in range(start2, len(second), 264):
        for fmt, field, increment in (("<I", 230, rec), ("<Q", 21, elapsed), ("<d", 0, 1)):
            value = struct.unpack_from(fmt, second, pos + field)[0]
            struct.pack_into(fmt, second, pos + field, value + increment)
    if restart:
        struct.pack_into("BB", second, start2 + 9, 30, 192)
    return first + second


class MaccorRecordFormatTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory()))

    def test_dot_channel_and_numbered_text_use_their_own_reader_identities(self):
        for name, content, kind in ((".042", channel_file(), parsing.FORMAT_MACCOR_BINARY),
                                    ("sample.150", export_text().replace("0.12", "0,12").encode("cp1252"), parsing.FORMAT_MACCOR_TEXT)):
            with self.subTest(name=name):
                p = self.root / name
                p.write_bytes(content)
                self.assertEqual(parsing.recognize_source(p), kind)
                inspection = import_inspection.inspect_file(str(p))
                self.assertEqual(inspection.ext, name[-3:])
                self.assertEqual(_ensure_import_source_admitted(p, name), inspection.ext)
                identity = parsing.current_parser_identity_for_extension(inspection.ext, header_meta=inspection.metadata)
                self.assertEqual(identity, parsing.parser_identity(p))
                self.assertTrue(parsing.discoverable_source_path(p))
                self.assertGreater(len(parsing.parse_timeseries(p)), 0)
        self.assertFalse(parsing.source_filename_allowed(".000"))
        self.assertFalse(parsing.source_filename_allowed(".gitignore"))

    def test_known_text_export_relinks_between_text_and_channel_names(self):
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        original = self.root / "trace.txt"
        original.write_bytes(export_text().encode("cp1252"))
        with Session(engine) as db:
            source = scanner.ingest_path(db, original)
            # Also exercise databases registered before the explicit dialect marker.
            source.header_meta = {k: v for k, v in source.header_meta.items() if k != "maccor_format"}
            db.commit()
            for name in (".042", "export.txt"):
                moved = original.rename(self.root / name)
                self.assertIs(scanner.ingest_path(db, moved), source)
                self.assertEqual(parsing.current_parser_identity_for_source(source), parsing.parser_identity(moved))
                original = moved
            wrong = original.rename(self.root / "other.xlsx")
            with self.assertRaisesRegex(ValueError, "across parser families"):
                scanner.ingest_path(db, wrong)
            self.assertEqual(source.path, str(original))

    def test_time_curve_preserves_clock_and_reported_current(self):
        p = self.root / "trace.txt"
        prefix = "Name:\tSample\nTester\tMaccor #1\nRec\tTime\tVoltage\tCurrent\t\n"
        content = prefix + "\t[h]\t[V]\t[A]\t\n1\t0,5\t-0,1\t0,003\t\n2\t1\t0,2\t-0,002\t\n"
        p.write_text(content)
        raw = parsing.parse_timeseries(p)
        np.testing.assert_allclose(raw.total_time_s, [1800, 3600])
        np.testing.assert_allclose(raw.current_ma, [3, -2])
        self.assertTrue(raw.status.eq("Unverified").all())
        self.assertTrue(raw.charge_capacity_mah.isna().all())
        self.assertFalse(raw.capacity_verified.any())
        self.assertTrue(calc.per_cycle(raw).empty)
        for invalid in (content.replace("[h]", "[s]"), content.replace("Time", "Capacity"),
                        content.replace("Rec\tTime\tVoltage\tCurrent", "Rec\tChg Cap\tDis Cap")):
            p.write_text(invalid)
            self.assertIsNone(parsing.recognize_source(p))

    def test_csv_and_tab_clocks_and_current_units_are_checked_per_export(self):
        for name, sep, current in (("data.csv", ",", .25), ("data.txt", "\t", 250)):
            with self.subTest(name=name):
                p = self.root / name
                data = [["Today''s Date","11/22/2026 04:00:00"], ["Date of Test:", "11/22/2026 00:00:00"],
                        maccor_records.COLUMNS, *record_export(current)]
                p.write_text("\n".join(sep.join(map(str, row)) for row in data))
                raw = parsing.parse_timeseries(p)
                self.assertEqual(raw.cycle.tolist(), [1, 1, 1, 1, 2])
                np.testing.assert_allclose(raw.current_ma, [250,250,-250,-250,250])
                np.testing.assert_allclose(raw.total_time_s, [0,3600,3600,7200,7200])
                self.assertEqual(calc.per_cycle(raw).cycle.tolist(), [1])
                self.assertEqual(import_file_hints.inspect_header_hint(str(p))["supplier"], "Maccor")
                # An inconsistent current unit across steps cannot be resolved.
                data[5][7] = data[6][7] = current * 1000
                p.write_text("\n".join(sep.join(map(str, row)) for row in data))
                with self.assertRaisesRegex(parsing.UnsupportedSourceFormatError, "scaling"):
                    parsing.parse_timeseries(p)

    def test_workbook_dispatch_uses_only_data_records_and_excludes_stop_control(self):
        p = self.root / "trace.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.title = "Data"
        sheet.append(["Today''s Date", datetime(2026, 11, 22), "Date of Test:", datetime(2026, 11, 22),
                      "Filename:", "record.001", "Procedure", "cycling.000"])
        sheet.append(maccor_records.COLUMNS)
        records = record_export()
        terminal = [*records[-1]]
        terminal[0], terminal[7], terminal[9], terminal[10] = 6, 0, "S", 192
        for row in [*records, terminal]:
            row[11] = datetime.strptime(row[11], "%m/%d/%Y %H:%M:%S")
            sheet.append(row)
        book.create_sheet("Statistics")
        book.create_sheet("Cycle 0 CHG").append(["StepTime", "Voltage", "Current", "Capacity"])
        book.save(p)
        self.assertEqual(parsing.recognize_source(p), parsing.FORMAT_MACCOR_EXCEL)
        self.assertEqual(import_file_hints.inspect_header_hint(str(p))["supplier"], "Maccor")
        st = p.stat()
        fact = dict(path=str(p), extension=".xlsx", recognition="pending", size=st.st_size, mtime_ns=st.st_mtime_ns)
        self.assertEqual(import_search_worker.inspect_fact(fact, False)["supplier"], "Maccor")
        self.assertEqual(parsing.current_parser_identity_for_extension("xlsx", header_meta=parsing.read_header_metadata(p)),
                         parsing.parser_identity(p))
        raw = parsing.parse_timeseries(p)
        self.assertEqual(raw.record_index.tolist(), [1, 2, 3, 4, 5])
        parsing.validate_parsed_output(p, raw, calc.per_cycle(raw))

    def test_linked_sections_keep_separate_steps_and_explicit_curve_break(self):
        p = self.root / "linked.003"
        steps = ("Charge", "Dischrge", "End")
        first = channel_file(steps, operation(0, 1, 0xFFFF) + [(0,30,192,0xFFFF,0,110,1,1)])
        second = channel_file(steps, operation(1, 2, 0xBBBB))
        data = link_sections(first, second, restart=True)
        p.write_bytes(data)
        raw = parsing.parse_timeseries(p)
        self.assertEqual(raw.record_index.tolist(), [1, 2, 4, 5])
        self.assertEqual(raw.step.tolist(), [1, 1, 2, 2])
        self.assertEqual(exploratory_plotting.break_before(raw), [2])
        self.assertTrue(calc.per_cycle(raw).empty)
        struct.pack_into("<I", data, 46, 10)
        p.write_bytes(data)
        self.assertIsNone(parsing.recognize_source(p))

    def test_snapshot_only_file_keeps_record_metadata_without_scientific_rows(self):
        p = self.root / "stopped.003"
        data = bytearray(channel_file(("Charge","End"), []))
        offset = len(data) - 264
        struct.pack_into("BB", data, offset + 9, 30, 192)
        struct.pack_into("<I", data, offset + 230, 45)
        p.write_bytes(data)
        meta = parsing.read_header_metadata(p)
        self.assertTrue(parsing.source_metadata_only(meta))
        self.assertEqual(meta["raw"]["Maccor"]["Stop snapshots"][0]["Record"], 45)
        self.assertTrue(parsing.parse_timeseries(p).empty)
