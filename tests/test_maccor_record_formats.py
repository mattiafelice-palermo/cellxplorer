"""Maccor content dispatch, clock/units and linked section regressions."""
from datetime import datetime
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

import numpy as np
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.db import Base
from backend.app.models import Cell, Test, TestFile
from backend.app.routers import files, library
from backend.app.routers.files import _ensure_import_source_admitted, _inspect_import_path
from backend.app.services import (
    analysis_engine, cache, calc, exploratory_plotting, import_file_hints, import_inspection, import_search_worker,
    maccor_metadata, maccor_records, parsing, scanner,
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

    def test_maccor_startup_mass_requires_positive_consistent_values_and_units(self):
        for fields, expected in (
            ({"Active material mass [mg]": "15,2"}, 15.2),
            ({"Active mass (g)": ".012", "Comment": "batch 2; Active mass: 12 mg"}, 12),
            ({"Description": "Active material mass = 750 µg"}, .75),
            ({"Description": "Active mass: 12 mg/cm2"}, None),
            ({"Comment": "Previous active mass: 12 mg"}, None),
            ({"Electrode weight": "9 mg", "C Rate": 3, "SCap": ".012"}, 12),
            ({"SCap": "0,0149768", "Active mass [mg]": ""}, 14.9768),
            ({"SCap": "1e308"}, None),
            ({"SCap": ".012", "Comment": "Active mass: 7 mg"}, 7),
            ({"SCap": ".012", "Active mass": "7 mg", "Description": "Active weight: 2 mg"}, None),
            ({"SCap": ".012", "Active mass": "7 mg/cm2"}, None),
            ({"Sections": [{"SCap": ".012"}, {"SCap": ".012"}]}, 12),
            ({"Sections": [{"SCap": ".012"}, {}]}, None),
            ({"Sections": [{"Active mass": "8 mg"}, {"SCap": ".012"}]}, 8),
            ({"Active mass": "12", "Comment": "Cell mass: 12 mg"}, None),
            ({"Active mass [mg]": "12 g"}, None),
            ({"Active mass": "2 g", "Active material mass": "12 mg"}, None),
            ({"Active mass": "1e500 g"}, None),
        ):
            with self.subTest(fields=fields):
                mass = maccor_metadata.normalization(fields)["active_mass_mg"]
                if expected is None:
                    self.assertIsNone(mass)
                else:
                    self.assertAlmostEqual(mass, expected)
        for invalid in (0, -1, float("nan"), "1e501", "12 mAh/g", None):
            self.assertEqual(maccor_metadata.normalization({"SCap": invalid}),
                             {"maccor_scap": None, "active_mass_mg": None, "maccor_mass_from_scap": False})

    def test_mass_flows_through_staging_existing_source_upgrade_and_cycle_normalization(self):
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        p = self.root / "mass.150"
        content = export_text().replace("Tester\t", "SCap\t0,014977\r\nActive material mass [g]\t0,0125\r\nTester\t")
        p.write_bytes(content.encode("cp1252"))
        with Session(engine) as db:
            preview = _inspect_import_path(p, db)
            self.assertEqual((preview["active_mass_mg"], preview["maccor_scap"]), (12.5, .014977))
            self.assertFalse(preview["maccor_mass_from_scap"])
            source = scanner.ingest_path(db, p, parse_now=True)
            cell = Cell(name="Mass normalization")
            db.add(TestFile(test=Test(cell=cell, name="internal"), file=source, position=0))
            db.commit()
            self.assertEqual(library.get_cell(cell.id, db)["sources"][0]["maccor_scap"], .014977)
            self.assertEqual(analysis_engine.cell_active_mass_mg(cell), 12.5)
            cycles = cache.load_cycles(source.hash, source.parser_version, cache.CALC_VERSION)
            derived, _ = analysis_engine.add_derived_columns(cycles, {}, analysis_engine.cell_active_mass_mg(cell))
            self.assertAlmostEqual(derived.discharge_capacity_mah_g.iloc[0], 2 / .0125)
            library.update_cell(cell.id, library.CellUpdate(active_mass_mg_override=14.977), db)
            source.active_mass_mg = None
            source.parser_version = "mt:3:r1"
            source.header_meta = {k: v for k, v in source.header_meta.items() if k != "maccor_normalization"}
            db.commit()
            scanner.parse_file(db, source)
            self.assertEqual((source.parse_status, source.active_mass_mg), ("parsed", 12.5))
            self.assertEqual(analysis_engine.cell_active_mass_mg(cell), 14.977)
            library.update_cell(cell.id, library.CellUpdate(active_mass_mg_override=None), db)
            self.assertEqual(analysis_engine.cell_active_mass_mg(cell), 12.5)

    def test_scap_default_and_import_override_flow_into_cell_editing_and_calculations(self):
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        with Session(engine) as db, patch.object(files, "start_import_cache_jobs", return_value={}):
            for index, override in enumerate((None, 16.0)):
                path = self.root / f"cell{index}.txt"
                content = export_text().replace("Tester\t", f"SCap\t0.0125\r\nComment\tCell {index}\r\nTester\t")
                path.write_bytes(content.encode("cp1252"))
                preview = _inspect_import_path(path, db)
                self.assertTrue(preview["maccor_mass_from_scap"])
                self.assertEqual(preview["active_mass_mg"], 12.5)
                draft = files.ImportCellDraft(cell_name=path.stem, filename=path.name, source_path=str(path),
                                              staged_name=preview["staged_name"], inspection=preview["inspection"],
                                              metadata=preview["metadata"], active_mass_mg_override=override)
                result = files._create_imported_cells_impl(files.ImportCellsRequest(cells=[draft]), db=db)
                cell = db.get(Cell, result["created"][0]["cell_id"])
                detail = library.get_cell(cell.id, db)
                self.assertTrue(detail["sources"][0]["maccor_mass_from_scap"])
                self.assertEqual(detail["scientific_metadata"]["active_mass_mg"]["override_value"], override)
                self.assertNotIn("active_material_mg", detail["metadata"])
                self.assertEqual(analysis_engine.cell_active_mass_mg(cell), override or 12.5)
                cycles = calc.per_cycle(parsing.parse_timeseries(path))
                for edit, effective in ((10, 10), (None, 12.5)):
                    library.update_cell(cell.id, library.CellUpdate(active_mass_mg_override=edit), db)
                    resolved_mass = analysis_engine.cell_active_mass_mg(cell)
                    self.assertEqual(resolved_mass, effective)
                    derived, _ = analysis_engine.add_derived_columns(cycles, {}, resolved_mass)
                    self.assertAlmostEqual(derived.discharge_capacity_mah_g.iloc[0], 2 / (effective / 1000))
                source = cell.tests[0].file_links[0].file
                self.assertEqual(source.active_mass_mg, 12.5)
                if override is not None:
                    library.update_cell(cell.id, library.CellUpdate(active_mass_mg_override=override), db)
                    path.write_bytes(content.replace("SCap\t0.0125", "SCap\t0.0145").encode("cp1252"))
                    scanner.update_source_from_path(db, source)
                    self.assertEqual(analysis_engine.cell_active_mass_mg(cell), override)
                    library.update_cell(cell.id, library.CellUpdate(active_mass_mg_override=None), db)
                    self.assertEqual(analysis_engine.cell_active_mass_mg(cell), 14.5)

    def test_native_startup_scap_defaults_to_grams_independently_of_c_rate(self):
        p = self.root / "cell.003"
        data = bytearray(channel_file())
        struct.pack_into("<ff", data, 50, .0149768, 14.9768)
        p.write_bytes(data)
        meta = parsing.read_header_metadata(p)
        self.assertAlmostEqual(meta["maccor_scap"], .0149768)
        self.assertTrue(meta["maccor_mass_from_scap"])
        self.assertAlmostEqual(meta["active_mass_mg"], 14.9768, places=5)
        self.assertAlmostEqual(meta["raw"]["Maccor"]["C Rate"], 14.9768, places=5)

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
                data = [["Today''s Date","11/22/2026 04:00:00", "SCap", ".014"],
                        ["Date of Test:", "11/22/2026 00:00:00", "Active mass [mg]", "12"],
                        maccor_records.COLUMNS, *record_export(current)]
                p.write_text("\n".join(sep.join(map(str, row)) for row in data))
                meta = parsing.read_header_metadata(p)
                self.assertEqual((meta["active_mass_mg"], meta["maccor_scap"]), (12, .014))
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
                      "Filename:", "record.001", "Procedure", "cycling.000", "LFP", "SCap", .0123, "C Rate", 12.3])
        sheet.append(maccor_records.COLUMNS)
        records = record_export()
        terminal = [*records[-1]]
        terminal[0], terminal[7], terminal[9], terminal[10] = 6, 0, "S", 192
        for row in [*records, terminal]:
            row[11] = datetime.strptime(row[11], "%m/%d/%Y %H:%M:%S")
            sheet.append(row)
        stats = book.create_sheet("Statistics")
        stats.append(["TesterID:", "Maccor #1"])
        stats.append(["Channel Number:", 7])
        stats.append(["Active material mass (mg):", 10])
        book.create_sheet("Cycle 0 CHG").append(["StepTime", "Voltage", "Current", "Capacity"])
        book.save(p)
        self.assertEqual(parsing.recognize_source(p), parsing.FORMAT_MACCOR_EXCEL)
        meta = parsing.read_header_metadata(p)
        self.assertEqual((meta["active_mass_mg"], meta["maccor_scap"]), (10, .0123))
        self.assertEqual((meta["device_info"], meta["channel"], meta["remarks"]), ("Maccor #1", "7", "LFP"))
        self.assertEqual(meta["start_time"], "2026-11-22T00:00:00")
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
        struct.pack_into("<f", data, 50, .012)
        struct.pack_into("<f", data, len(first) + 50, .017)
        p.write_bytes(data)
        meta = parsing.read_header_metadata(p)
        self.assertIsNone(meta["maccor_scap"])
        self.assertIsNone(meta["active_mass_mg"])
        np.testing.assert_allclose([s["SCap"] for s in meta["raw"]["Maccor"]["Sections"]], [.012, .017])
        raw = parsing.parse_timeseries(p)
        self.assertEqual(raw.record_index.tolist(), [1, 2, 4, 5])
        self.assertEqual(raw.step.tolist(), [1, 1, 2, 2])
        self.assertEqual(exploratory_plotting.break_before(raw), [2])
        self.assertTrue(calc.per_cycle(raw).empty)
        struct.pack_into("<I", data, 46, 10)
        p.write_bytes(data)
        self.assertIsNone(parsing.recognize_source(p))

    def test_link_after_a_resumed_stop_creates_its_own_acquisition_break(self):
        p = self.root / "resumed-then-linked.003"
        steps = ("Charge", "Dischrge", "End")
        first = channel_file(steps, [
            (0, 1, 0, 0xEEEE, 1000, 0, 0, 0),
            (0, 1, 5, 0xEEEE, 1000, 10, 1, 1),
            (0, 30, 192, 0x6666, 1000, 11, 2, 2),
            (0, 1, 0, 0xEEEE, 1000, 12, 3, 3),
            (0, 30, 192, 0x6666, 1000, 13, 4, 4),
        ])
        second = channel_file(steps, operation(1, 2, 0xAAAA))
        p.write_bytes(link_sections(first, second, restart=True))
        raw = parsing.parse_timeseries(p)
        self.assertEqual(raw.record_index.tolist(), [1, 2, 4, 6, 7])
        self.assertEqual(raw.acquisition_segment.tolist(), [1, 1, 2, 3, 3])
        self.assertEqual(exploratory_plotting.break_before(raw), [2, 3])
        self.assertTrue(calc.per_cycle(raw).empty)

    def test_snapshot_only_file_is_excluded_from_discovery_and_import(self):
        p = self.root / "stopped.003"
        data = bytearray(channel_file(("Charge","End"), []))
        offset = len(data) - 264
        struct.pack_into("BB", data, offset + 9, 30, 192)
        struct.pack_into("<I", data, offset + 230, 45)
        p.write_bytes(data)
        self.assertIsNone(parsing.recognize_source(p))
        self.assertFalse(parsing.discoverable_source_path(p))
        self.assertEqual(parsing.read_header_metadata(p)["error_kind"], "unsupported")
        with self.assertRaises(import_inspection.SourceInspectionRejection):
            import_inspection.inspect_file(str(p))
        with self.assertRaisesRegex(parsing.UnsupportedSourceFormatError, "stop snapshots"):
            parsing.parse_timeseries(p)
