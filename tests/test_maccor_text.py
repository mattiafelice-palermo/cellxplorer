"""Maccor text admission and scientific regression cases. All values are synthetic."""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.db import Base
from backend.app.models import Cell, Test, TestFile
from backend.app.routers import files
from backend.app.services import (
    analysis_engine, cache, calc, canonical_cycling, import_file_hints, import_inspection,
    import_search_worker, maccor_text, parsing, protocol, scanner,
)
from backend.app.services.filesystem_cleanup import TemporaryDirectory


COLUMNS = "Rec\tCycle P\tCycle C\tStep\tTestTime\tStepTime\tCap. [Ah]\tEner. [Wh]\tCurrent [A]\tVoltage [V]\tMd\tES\tDPT Time\tVAR1"
# Cycle, program, test/step minutes, Ah, Wh, unsigned A, V, mode, end status.
RECORDS = [
    (1, 1, 0, 0, 0, 0, 0, 0, "R", 0),
    (1, 1, 1, 1, 0, 0, 0, 0, "R", 129),
    (1, 3, 1, 0, 0, 0, .12, 3, "C", 0),
    (1, 3, 2, 1, .002, .006, .12, 3, "C", 133),
    (1, 4, 2, 0, .002, .006, .06, 3, "C", 0),
    (1, 4, 3, 1, .003, .009, .06, 3, "C", 132),
    (1, 5, 3, 0, 0, 0, .06, -.1, "D", 0),
    (1, 5, 4, 1, .001, .0001, 0, -.1, "SBw", 195),
    (1, 5, 4, 1, .001, .0001, .06, -.1, "D", 0),
    (1, 5, 5, 2, .002, .0002, .06, -.1, "D", 129),
    (3, 3, 5, 0, 0, 0, .12, 3, "C", 0),
    (3, 3, 6, 1, .002, .006, .12, 3, "C", 129),
    (3, 5, 6, 0, 0, 0, .06, -.1, "D", 0),
    (3, 5, 7, 1, .001, .0001, .06, -.1, "D", 1),
]


def export_text(records=RECORDS, program_cycles=None):
    lines = ["Name:\tsynthetic.060", "Channel:\t2", "Tester\tMaccor #1", "Procedure\tTest.000",
             "Description\tEssai mesuré", "Started\t14/11/2026 12:00:00", "", COLUMNS, ""]
    for rec, row in enumerate(records, 1):
        stamp = datetime(2026, 11, 14, 12) + timedelta(minutes=row[2])
        program_cycle = 0 if program_cycles is None else program_cycles[rec - 1]
        values = [rec, program_cycle, *row, stamp.strftime("%d/%m/%Y %H:%M:%S"), 0]
        lines.append("\t".join(map(str, values)) + "\t")
    return "\r\n".join(lines) + "\r\n"


class MaccorTextTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        self.path = Path(directory) / "record.TXT"
        self.path.write_bytes(export_text().encode("cp1252"))

    def test_program_counter_and_final_off_control_preserve_exported_cycle_c(self):
        terminal = (3, 6, 7, 1, .001, .0001, 0, -.1, "O", 193)
        rows = [*RECORDS, terminal]
        counters = [0, 0] + [1] * 8 + [2] * 5
        self.path.write_bytes(export_text(rows, counters).encode("cp1252"))
        raw = parsing.parse_timeseries(self.path)
        self.assertEqual(raw.cycle.tolist(), [record[0] for record in RECORDS])
        self.assertEqual(raw.maccor_program_cycle.tolist(), counters[:-1])
        self.assertEqual(calc.per_cycle(raw).cycle.tolist(), [1])
        for bad, message in (
            (export_text(rows, counters[:-1] + [0]), "decreasing"),
            (export_text(rows + [terminal]), "only at the end"),
            (export_text([*RECORDS, (*terminal[:-1], 192)]), "terminal mode and status"),
        ):
            self.path.write_bytes(bad.encode("cp1252"))
            with self.assertRaisesRegex(parsing.SourceFormatError, message):
                parsing.parse_timeseries(self.path)

    def test_bounded_recognition_metadata_and_generic_text_exclusion(self):
        notes = self.path.with_name("notes.txt")
        notes.write_bytes(b"Unrelated notes\n" + b"a" * 100_000)
        with patch.object(maccor_text, "parse_timeseries", side_effect=AssertionError("full parse")):
            self.assertIsNone(parsing.recognize_source(notes))
            self.assertIsNone(parsing.recognize_source(self.path.with_suffix(".000")))
            self.assertEqual(parsing.recognize_source(self.path), parsing.FORMAT_MACCOR_TEXT)
            self.assertEqual(parsing.parser_identity(self.path), parsing.current_parser_identity_for_extension("TXT"))
            meta = import_inspection.inspect_file(str(self.path)).metadata
            self.assertEqual(meta["remarks"], "Essai mesuré")
            self.assertEqual((meta["start_time"], meta["channel"]), ("2026-11-14T12:00:00", "2"))
            self.assertEqual(meta["raw"]["Maccor"]["Procedure"], "Test.000")
            self.assertFalse(protocol.reconstruct_declared_protocol(meta["raw"])["capabilities"]["declared_protocol_available"])
            self.assertEqual(import_file_hints.inspect_header_hint(str(self.path))["supplier"], "Maccor")
            self.assertIs(import_file_hints.inspect_header_hint(str(notes))["compatible"], False)
            with self.assertRaises(import_inspection.SourceInspectionRejection):
                import_inspection.inspect_file(str(notes))
            listed = files.list_import_folder_files(self.path.parent)
            self.assertEqual([f["filename"] for f in listed["files"]], [self.path.name])
            screened = files.list_import_sources([], [str(self.path.parent)], screen_sources=True)
            self.assertEqual([f["filename"] for f in screened["files"]], [self.path.name])
            self.assertEqual(screened["skipped"]["unsupported"], 1)
            for path, expected in ((notes, "unsupported"), (self.path, "recognized")):
                stat = path.stat()
                fact = dict(path=str(path), extension=".txt", recognition="pending", size=stat.st_size, mtime_ns=stat.st_mtime_ns)
                for enabled in (False, True):
                    result = import_search_worker.inspect_fact(fact, enabled)
                    self.assertEqual(result["recognition"], expected)
        self.path.write_bytes(b"Name:\tfile.060\nDescription\t" + b"a" * 100_000 + b"\n" + export_text().encode())
        self.assertIsNone(parsing.recognize_source(self.path))

    def test_counters_clocks_standby_and_incomplete_tail_survive_cache(self):
        with patch.object(cache, "CACHE_DIR", self.path.parent / "cache"):
            key = parsing.compute_hash(self.path)
            info = cache.build(key, self.path)
            self.assertEqual((info["rows"], info["cycles"]), (14, 1))
            raw = cache.load_raw(key, info["parser_version"])
            cycles = cache.load_cycles(key, info["parser_version"], cache.CALC_VERSION)
        canonical_cycling.validate_raw_timeseries(raw)
        self.assertEqual(raw.step.tolist(), [1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6])
        np.testing.assert_allclose(raw.charge_capacity_mah[2:6], [0, 2, 0, 1])
        np.testing.assert_allclose(raw.maccor_capacity_ah[2:6], [0, .002, .002, .003])
        np.testing.assert_allclose(raw.discharge_capacity_mah[6:10], [0, 1, 1, 2])
        np.testing.assert_allclose(raw.current_ma[6:10], [-60, 0, -60, -60])
        self.assertEqual(raw.voltage_v.min(), -.1)
        self.assertEqual((raw.total_time_s.iloc[-1], raw.time_s.iloc[-1]), (420, 60))
        self.assertEqual(set(raw.status), {"Rest", "Chg", "DChg", "Standby"})
        self.assertEqual(raw.loc[7, "maccor_end_status"], 195)
        self.assertEqual(cycles.cycle.tolist(), [1])
        self.assertFalse(raw.cycle_complete.iloc[-1])
        row = cycles.iloc[0]
        np.testing.assert_allclose([row.charge_capacity_mah, row.discharge_capacity_mah,
                                    row.charge_energy_mwh, row.discharge_energy_mwh], [3, 2, 9, .2])
        self.assertAlmostEqual(row.coulombic_efficiency_pct, 200 / 3)
        self.assertTrue(np.isnan(row.cv_reached))
        self.assertTrue(np.isnan(row.cv_charge_capacity_mah))
        # Completing the last discharge makes that cycle eligible on a subsequent parse.
        updated = list(RECORDS)
        updated[-1] = (*updated[-1][:-1], 129)
        self.path.write_bytes(export_text(updated).encode("cp1252"))
        self.assertEqual(calc.per_cycle(parsing.parse_timeseries(self.path)).cycle.tolist(), [1, 3])

    def test_full_resolution_plot_keeps_partial_tail_and_uses_recorded_test_clock(self):
        # Include a gap between steps that cannot be reconstructed from the
        # step-relative clock, and an unfinished last cycle after a complete one.
        rows = [(*r[:2], r[2] + (1 if i >= 4 else 0), *r[3:]) for i, r in enumerate(RECORDS)]
        self.path.write_bytes(export_text(rows).encode("cp1252"))
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        with Session(engine) as db, patch.object(cache, "CACHE_DIR", self.path.parent / "cache"):
            source = scanner.ingest_path(db, self.path, parse_now=True)
            cell = Cell(name="Maccor test")
            chain = Test(cell=cell, name="internal source chain")
            db.add(TestFile(test=chain, file=source, position=0))
            db.commit()
            spec = analysis_engine.default_spec("Recorded clock")
            spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
            trace = analysis_engine.compute_time_capacity(db, spec, None, precision="full")["cell_traces"][0]
            spec["computation"].setdefault("time_capacity", {})["x_axis"] = "capacity_mah"
            capacity_trace = analysis_engine.compute_time_capacity(db, spec, None, precision="full")["cell_traces"][0]
        np.testing.assert_array_equal(trace["source_cycle"], [row[0] for row in rows])
        np.testing.assert_allclose(trace["time_s"], [row[2] * 60 for row in rows])
        np.testing.assert_allclose(trace["voltage_v"], [row[7] for row in rows])
        self.assertEqual(trace["phase"][7:10], ["rest", "discharge", "discharge"])
        np.testing.assert_allclose(capacity_trace["display_x"], [0, 0, 0, 2, 2, 3, 3, 4, 4, 5, 5, 7, 7, 8])

    def test_unverified_units_and_malformed_records_fail_without_publishing_data(self):
        content = export_text()
        cases = [
            (content.replace("Cap. [Ah]", "Cap. [mAh]"), "Expected a Maccor"),
            (content.replace("3\t0\t1\t3", "2\t0\t1\t3"), "consecutive"),
            (content.replace("\tSBw\t195\t", "\tX\t195\t"), "operating mode"),
            (content.replace("\t0\t-0.1\tSBw", "\t0.1\t-0.1\tSBw"), "standby"),
            (content.replace("\t0.002\t0.0002\t0.06\t-0.1\tD", "\t0.0009\t0.0002\t0.06\t-0.1\tD"), "decreases"),
            (content.replace("\t0.12\t3\tC", "\t-0.12\t3\tC"), "unsigned"),
            (content.replace("\t0.12\t3\tC", "\t0.12\tnan\tC"), "Voltage"),
            (content.rstrip() + "\textra\textra\n", "field count"),
        ]
        seconds = [(*r[:2], r[2] * 60, r[3] * 60, *r[4:]) for r in RECORDS]
        second_lines = export_text(seconds).splitlines()
        correct_lines = content.splitlines()
        for i in range(len(second_lines)):
            if second_lines[i][:1].isdigit():
                values = second_lines[i].split("\t")
                values[12] = correct_lines[i].split("\t")[12]
                second_lines[i] = "\t".join(values)
        cases.append(("\n".join(second_lines), "minutes"))
        for value, message in cases:
            with self.subTest(message=message):
                self.assertNotEqual(value, content)
                self.path.write_bytes(value.encode("cp1252"))
                with self.assertRaisesRegex(parsing.SourceFormatError, message):
                    maccor_text.parse_timeseries(self.path)
