"""Independent byte fixtures for MB container, EIS and scientific boundaries."""
from __future__ import annotations

import os
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
from app.db import Base
from app.models import Cell, Test, TestFile
from app.services import analysis_engine, biologic_mpr, cache, calc, parsing, scanner
from app.services.filesystem_cleanup import TemporaryDirectory


def write_mb(path, rows, *, classic=False, frequency=True):
    # Storage definitions intentionally do not use the production registry/dtype.
    fields = [(131, "H", "ns", 0), (39, "H", "range", 115),
              (4, "d", "time", 0), (20, "f", "control", 0), (6, "f", "voltage", 3.5),
              (8, "f", "current", 1), (7, "d", "dq", 0),
              (13, "d", "q", 0)]
    if frequency:
        fields += [(32, "f", "frequency", 0), (36, "f", "impedance", 0)]
    fields += [(467 if classic else 211, "d", "q", 0), (468, "I", "half", 0)]
    ids = [1, 2, 3, 21, 31, 65] + [f[0] for f in fields]
    raw = b"".join(struct.pack("<B", row.get("flags", 1)) + b"".join(
        struct.pack("<" + fmt, row.get(name, default)) for _, fmt, name, default in fields)
        for row in rows)
    data = (struct.pack("<IB", len(rows), len(ids)) + struct.pack(
        ("<" if classic else ">") + str(len(ids)) + "H", *ids)).ljust(
            406 if classic else 1007, b"\0") + raw

    def module(short, long, payload, version):
        prefix = b"MODULE" + short.ljust(10, b" ") + long.ljust(25, b" ")
        sizes = struct.pack("<II", len(payload), version) if classic else struct.pack(
            "<IIII", 0xffffffff, len(payload), 0, version)
        return prefix + sizes + b"03/12/26" + payload

    path.write_bytes(b"BIO-LOGIC MODULAR FILE\x1a" + b" " * 25 + b"\0" * 4 +
        module(b"VMP Set", b"VMP settings", b"\x7fMB settings", 0 if classic else 10) +
        module(b"VMP data", b"VMP data", data, 3 if classic else 11))
    return path


def eis_rows():
    return [dict(time=100, q=0), dict(time=110, dq=1, q=1),
            dict(time=120, ns=1, frequency=0, voltage=888, dq=900, q=901),
            dict(time=130, ns=1, frequency=100, voltage=888, dq=900, q=1801, flags=10),
            dict(time=140, ns=1, frequency=0, voltage=888, dq=900, q=2701),
            dict(time=150, ns=2, dq=1000, q=3701),
            dict(time=160, ns=2, dq=1, q=3702),
            dict(time=170, ns=3, current=-1, half=1, q=0),
            dict(time=180, ns=3, current=-1, half=1, dq=-2, q=-2)]


class BiologicMbTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.cache_patch = patch.object(cache, "CACHE_DIR", self.directory / "cache")
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)

    def test_both_layouts_exclude_whole_eis_execution_and_counter_leakage(self):
        for classic in (False, True):
            with self.subTest(classic=classic):
                path = write_mb(self.directory / f"mb-{classic}.mpr", eis_rows(), classic=classic)
                original = path.read_bytes()
                with biologic_mpr.read_mpr_header(path) as header:
                    self.assertIsNone(header.vmp_data.records)
                    self.assertEqual(header.vmp_data.record_offset, 406 if classic else 1007)
                for mode in ("safe", "permissive"):
                    metadata = parsing.metadata_for_read_mode(path, parsing.read_header_metadata(path), mode)
                    self.assertEqual(metadata["technique"], "MB")
                    self.assertFalse(metadata["absolute_timestamps"])
                    frame = parsing.parse_timeseries(path, read_mode=mode)
                    self.assertEqual(frame.record_index.tolist(), [1, 2, 6, 7, 8, 9])
                    self.assertNotIn(888, frame.voltage_v.tolist())
                    self.assertEqual(frame.mpr_acquisition_segment.tolist(), [1, 1, 2, 2, 2, 2])
                    summary = calc.per_cycle(frame)
                    self.assertEqual(len(summary), 1)
                    self.assertEqual(summary.charge_capacity_mah.tolist(), [2])
                    self.assertEqual(summary.discharge_capacity_mah.tolist(), [2])
                    self.assertEqual(summary.coulombic_efficiency_pct.tolist(), [100])
                    self.assertEqual(analysis_engine._continuous_time(frame).time_s.tolist(),
                                     [100, 110, 150, 160, 170, 180])
                    self.assertEqual(frame.attrs["biologic_gcpl"]["excluded_eis_records"], 3)
                self.assertEqual(path.read_bytes(), original)

    def test_no_frequency_layout_and_unmatched_phase_remain_plottable(self):
        path = write_mb(self.directory / "no-eis.mpr", eis_rows()[:2], frequency=False)
        frame = parsing.parse_timeseries(path)
        self.assertFalse(frame.cycle_complete.any())
        self.assertTrue(calc.per_cycle(frame).empty)
        self.assertEqual(frame.charge_capacity_mah.tolist(), [0, 1])

    def test_bad_science_is_rejected_in_both_modes_without_exposing_eis_fallback(self):
        for name, mutate in [
            ("clock", lambda r: r[1].update(time=90)),
            ("error", lambda r: r[1].update(flags=9)),
            ("sign", lambda r: r[1].update(dq=-1, q=-1)),
            ("counter", lambda r: r[1].update(q=200)),
            ("zero-duration", lambda r: r[1].update(time=100)),
            ("neutral-transfer", lambda r: (r[0].update(current=0, flags=3), r[1].update(current=0, flags=3))),
            ("half-regression", lambda r: r[-1].update(half=0)),
            ("nan", lambda r: r[1].update(voltage=float("nan"))),
        ]:
            rows = eis_rows()
            mutate(rows)
            path = write_mb(self.directory / f"{name}.mpr", rows)
            for mode in ("safe", "permissive"):
                with self.subTest(name=name, mode=mode), self.assertRaises(parsing.SourceFormatError):
                    parsing.parse_timeseries(path, read_mode=mode)

    def test_truncation_versions_and_classic_non_mb_fail_closed(self):
        for classic in (False, True):
            path = write_mb(self.directory / "bad.mpr", eis_rows(), classic=classic)
            original = path.read_bytes()
            variants = [original[:-1], original + b"extra"]
            wrong_technique = bytearray(original)
            wrong_technique[52 + (57 if classic else 65)] = 0x77
            if classic:
                variants.append(wrong_technique)
            for data in variants:
                path.write_bytes(data)
                with self.assertRaises(parsing.SourceFormatError):
                    parsing.parse_timeseries(path)

    def test_frequencyless_unknown_impedance_families_are_rejected(self):
        for column in (98, 166, 175):
            path = write_mb(self.directory / "impedance.mpr", eis_rows()[:2], frequency=False)
            payload = bytearray(path.read_bytes())
            # Replace the equally wide current-control column with another
            # known four-byte impedance field. Reader widths remain valid.
            data_offset = 52 + 65 + len(b"\x7fMB settings") + 65
            old = struct.pack(">H", 20)
            at = payload.index(old, data_offset + 5, data_offset + 50)
            payload[at:at + 2] = struct.pack(">H", column)
            path.write_bytes(payload)
            with self.subTest(column=column), self.assertRaises(parsing.SourceFormatError):
                parsing.parse_timeseries(path)

    def test_frequency_mapping_is_scoped_to_mb_preserving_existing_readers(self):
        ids = (1, 2, 3, 21, 31, 65, 131, 4, 7, 5, 6, 211, 468, 32)
        layout = biologic_mpr._resolve_column_layout(ids, record_stride=43)
        self.assertIn(32, layout.ignored_known_column_ids)
        self.assertNotIn("raw_frequency_hz", layout.record_dtype.names)

    def test_derivative_does_not_smooth_or_differentiate_across_eis(self):
        frame = pd.DataFrame({"cycle": [1] * 6, "segment": [0] * 6,
                              "voltage_v": [1, 2, 3, 10, 20, 30],
                              "mpr_acquisition_segment": [1, 1, 1, 2, 2, 2]})
        capacity = np.array([0., 1, 2, 2, 3, 4])
        settings = {"view": "dqdv", "smoothing_window": 3}
        x, y = analysis_engine._derivative_curve(frame, ["charge"] * 6, capacity, capacity, settings)
        independent = [analysis_engine._derivative_curve(frame.iloc[a:b], ["charge"] * 3,
                       capacity[a:b], capacity[a:b], settings) for a, b in ((0, 3), (3, 6))]
        np.testing.assert_allclose(x, np.concatenate([v[0] for v in independent]), equal_nan=True)
        np.testing.assert_allclose(y, np.concatenate([v[1] for v in independent]), equal_nan=True)
        # Concatenation with ordinary Neware/GCPL rows fills this optional
        # column with NaN. Those rows must retain their original derivatives.
        mixed = frame.copy()
        mixed["segment"] = [0, 0, 0, 1, 1, 1]
        mixed["mpr_acquisition_segment"] = [np.nan, np.nan, np.nan, 1, 1, 1]
        mixed_x, mixed_y = analysis_engine._derivative_curve(mixed, ["charge"] * 6, capacity, capacity, settings)
        np.testing.assert_allclose(mixed_x, x, equal_nan=True)
        np.testing.assert_allclose(mixed_y, y, equal_nan=True)

    def test_indexed_bounded_source_preview_keeps_native_time_and_eis_breaks(self):
        from app.routers import files
        rows = eis_rows()
        rows += [dict(row, time=row["time"] + 200, half=row.get("half", 0) + 2) for row in eis_rows()]
        path = write_mb(self.directory / "indexed.mpr", rows, classic=True)
        fingerprint = parsing.capture_source_fingerprint(path)
        info = cache.build(fingerprint.hash, path)
        source = {"hash": fingerprint.hash, "parser_version": info["parser_version"],
                  "source_key": "mb", "filename": path.name}
        original_load = cache.load_raw_cycles
        for axis in ("time", "capacity"):
            with patch.object(cache, "load_raw", side_effect=AssertionError("full read")), \
                 patch.object(cache, "load_raw_cycles", wraps=original_load) as selected:
                preview = files._build_continuation_preview(
                    [source], quantity="voltage", voltage_x_axis=axis, cycle_start=2, cycle_end=2)
                self.assertTrue(selected.called)
                segment = preview["segments"][0]
                self.assertEqual(segment["display_break_before"], [2])
                if axis == "time":
                    self.assertEqual(segment["x"], [300, 310, 350, 360, 370, 380])

    def test_scanner_cache_reload_and_real_analysis_projections_preserve_eis_gaps(self):
        path = write_mb(self.directory / "analysis.mpr", eis_rows(), classic=True)
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()
        self.addCleanup(session.close)
        source = scanner.ingest_path(session, path, parse_now=True)
        self.assertEqual(source.parse_status, "parsed")
        self.assertEqual(source.cycle_count, 1)
        diagnostics = cache.load_parser_warnings(source.hash, source.parser_version)
        self.assertEqual(diagnostics[0]["code"], "biologic_mb_eis_exclusion")
        self.assertEqual(diagnostics[0]["severity"], "info")
        self.assertEqual(diagnostics[0]["count"], 3)
        raw = cache.load_raw(source.hash, source.parser_version)
        pd.testing.assert_frame_equal(raw, parsing.parse_timeseries(path))
        cell = Cell(name="MB")
        session.add(cell)
        session.flush()
        test = Test(cell_id=cell.id, name="internal")
        session.add(test)
        session.flush()
        session.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        session.commit()
        spec = analysis_engine.default_spec("MB")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        spec["computation"]["time_capacity"] = {
            "view": "voltage_current", "display_mode": "consecutive", "cycle_start": 1, "time_unit": "s",
        }
        for axis in ("time", "capacity_mah"):
            spec["computation"]["time_capacity"]["x_axis"] = axis
            for precision, compact in (("full", False), ("standard", True)):
                result = analysis_engine.compute_time_capacity(
                    session, spec, None, precision=precision, compact=compact)
                trace = result["cell_traces"][0]
                self.assertNotIn(888, trace["voltage_v"])
                self.assertTrue(trace["display_break_before"])
                if axis == "time":
                    np.testing.assert_allclose(trace["display_x"], [100, 110, 150, 160, 170, 180])
        before = {p: p.read_bytes() for p in (self.directory / "cache").rglob("*.parquet")}
        with patch.object(parsing, "parse_timeseries", side_effect=AssertionError("unexpected reparse")):
            cache.build(source.hash, path)
        for p, data in before.items():
            self.assertEqual(p.read_bytes(), data)

    def test_selected_cycle_native_clock_survives_warmup_and_compact_navigation(self):
        from app.services import time_capacity_reusable, time_capacity_workers
        rows = eis_rows()
        rows += [dict(row, time=row["time"] + 200, half=row.get("half", 0) + 2) for row in eis_rows()]
        path = write_mb(self.directory / "navigation.mpr", rows)
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()
        self.addCleanup(session.close)
        source = scanner.ingest_path(session, path, parse_now=True)
        cell = Cell(name="MB navigation")
        session.add(cell)
        session.flush()
        internal = Test(cell_id=cell.id, name="internal")
        session.add(internal)
        session.flush()
        session.add(TestFile(test_id=internal.id, file_id=source.id, position=0))
        session.commit()
        spec = analysis_engine.default_spec("Navigation")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        spec["computation"]["time_capacity"] = {
            "view": "voltage_current", "x_axis": "time", "display_mode": "consecutive",
            "time_reference": "selected_range", "time_unit": "s", "cycle_start": 2, "cycle_end": 2,
        }
        built = time_capacity_workers._build_jobs(session, spec, None, use_current_versions=False,
                    viewport_width=1200, precision="standard", compact=True)
        self.assertIsNotNone(built)
        jobs, request = built[:2]
        self.assertIsNone(time_capacity_reusable.artifact_key(jobs[0], request))
        prepared = time_capacity_reusable.prepare(session, spec, None)
        self.assertEqual(prepared["prepared"], 0)
        for precision, compact in (("full", False), ("standard", True)):
            result = analysis_engine.compute_time_capacity(session, spec, None,
                            precision=precision, compact=compact)
            trace = result["cell_traces"][0]
            self.assertEqual(trace["display_break_before"], [2])
            self.assertEqual(trace["display_x"], [300, 310, 350, 360, 370, 380])


if __name__ == "__main__":
    unittest.main()
