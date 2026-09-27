import mmap
import os
import struct
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

import NewareNDA

from app.routers.files import (
    _build_fast_neware_capacity_bundle_preview,
    capacity_efficiency_preview_from_cycles,
    capacity_preview_from_cycles,
)
from app.services import calc, continuation_preview, fast_neware, parsing

FULL_PARITY_SOURCE = ROOT / "tests" / "fixtures" / "golden_analysis" / "sources" / "cycles_time_steps.ndax"

_NDC_PAGE_SIZE = 4096
_NDC_RECORD_SIZE = 87
_NDC_PAYLOAD_OFFSET = 125
_NDC_TRAILER_SIZE = 56


def _compact_ndc_rows(repeat_count: int = 5) -> list[dict[str, object]]:
    """Return semantically selected records for the compact binary fixture.

    The rows deliberately cross the page boundary and retain charge/discharge,
    rest, SIM, pause, CCCV, CP, and multiple current-range paths.  The final
    invalid row proves the decoder's validity filter without introducing an
    unknown valid status into the compact success fixture.
    """

    pattern = [
        (4, 1, 0),       # Rest
        (2, 2, -1000),   # CC_DChg
        (1, 3, 1000),    # CC_Chg
        (3, 3, 10),      # CV_Chg
        (4, 4, 0),       # Rest
        (7, 5, 100),     # CCCV_Chg
        (8, 6, -100),    # CP_DChg
        (9, 7, 100),     # CP_Chg
        (13, 8, 0),      # Pause
        (17, 9, 0),      # SIM
        (20, 10, -1000), # CCCV_DChg
    ]
    base = datetime(2026, 1, 1, 12, 0, 0)
    rows: list[dict[str, object]] = []
    index = 1
    for cycle in range(repeat_count):
        for status_code, step_index, current_range in pattern:
            rows.append(
                {
                    "index": index,
                    "cycle": cycle,
                    "step_index": step_index,
                    "status_code": status_code,
                    "time_ms": index * 1000,
                    "voltage_raw": 35000 + index * 10,
                    "current_raw": 100 + index,
                    "charge_capacity_raw": index * 10,
                    "discharge_capacity_raw": index * 5,
                    "charge_energy_raw": index * 20,
                    "discharge_energy_raw": index * 9,
                    "timestamp": base + timedelta(seconds=index),
                    "current_range": current_range,
                }
            )
            index += 1

    rows.append(
        {
            "index": index,
            "cycle": repeat_count,
            "step_index": 99,
            "status_code": 255,
            "time_ms": index * 1000,
            "voltage_raw": 36000,
            "current_raw": 999,
            "charge_capacity_raw": 999,
            "discharge_capacity_raw": 999,
            "charge_energy_raw": 999,
            "discharge_energy_raw": 999,
            "timestamp": base + timedelta(seconds=index),
            "current_range": 123456,
            "valid": 0,
        }
    )
    return rows


def _encode_ndc_record(row: dict[str, object]) -> bytes:
    record = bytearray(_NDC_RECORD_SIZE)
    record[7] = int(row.get("valid", 0x55))
    struct.pack_into(
        "<IIBB",
        record,
        8,
        int(row["index"]),
        int(row["cycle"]),
        int(row["step_index"]),
        int(row["status_code"]),
    )
    struct.pack_into(
        "<Qii",
        record,
        23,
        int(row["time_ms"]),
        int(row["voltage_raw"]),
        int(row["current_raw"]),
    )
    struct.pack_into(
        "<qqqq",
        record,
        43,
        int(row["charge_capacity_raw"]),
        int(row["discharge_capacity_raw"]),
        int(row["charge_energy_raw"]),
        int(row["discharge_energy_raw"]),
    )
    timestamp = row["timestamp"]
    assert isinstance(timestamp, datetime)
    struct.pack_into(
        "<HBBBBB",
        record,
        75,
        timestamp.year,
        timestamp.month,
        timestamp.day,
        timestamp.hour,
        timestamp.minute,
        timestamp.second,
    )
    struct.pack_into("<i", record, 82, int(row["current_range"]))
    return bytes(record)


def _ndc_bytes(rows: list[dict[str, object]], *, trailing: bytes = b"") -> bytes:
    header = bytearray(_NDC_PAGE_SIZE)
    header[0] = 1  # filetype
    header[2] = 5  # NDC version
    pages: list[bytes] = []
    records_per_page = (_NDC_PAGE_SIZE - _NDC_PAYLOAD_OFFSET - _NDC_TRAILER_SIZE) // _NDC_RECORD_SIZE
    for offset in range(0, len(rows), records_per_page):
        page = bytearray(_NDC_PAGE_SIZE)
        for slot, row in enumerate(rows[offset : offset + records_per_page]):
            start = _NDC_PAYLOAD_OFFSET + slot * _NDC_RECORD_SIZE
            page[start : start + _NDC_RECORD_SIZE] = _encode_ndc_record(row)
        pages.append(bytes(page))
    if not pages:
        pages.append(bytes(_NDC_PAGE_SIZE))
    return bytes(header) + b"".join(pages) + trailing


def _write_compact_ndax(path: Path) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("data.ndc", _ndc_bytes(_compact_ndc_rows()))


def _write_split_v11_ndax(path: Path) -> None:
    """Sparse run-info and five status steps in a split NDC-11 source."""
    def member(kind: int, rows: list[bytes], offset: int, trailer: int) -> bytes:
        header = bytearray(_NDC_PAGE_SIZE)
        header[0], header[2] = kind, 11
        page = bytearray(_NDC_PAGE_SIZE)
        for index, row in enumerate(rows):
            start = offset + index * len(row)
            page[start:start + len(row)] = row
        assert offset + sum(map(len, rows)) <= _NDC_PAGE_SIZE - trailer
        return bytes(header + page)

    statuses = [4, 1, 2, 1, 2]
    steps = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
    data_rows = [
        struct.pack("<ff", 33000.0 + index * 10, 0.0 if step == 1 else (1.0 if step % 2 == 0 else -1.0))
        for index, step in enumerate(steps, 1)
    ]
    run_rows = [
        struct.pack(
            "<ixffff8xiiiih",
            (index % 2) * 1000,
            float(index),
            float(index) / 2,
            0.0,
            0.0,
            1000,
            1_700_000_000 + index,
            step,
            index,
            0,
        )
        for index, step in enumerate(steps, 1)
        if index != 4
    ]
    step_rows = [
        struct.pack("<ii16sb12s", 0, index, b"", status, b"")
        for index, status in enumerate(statuses, 1)
    ]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("data.ndc", member(1, data_rows, 132, 4))
        archive.writestr("data_runInfo.ndc", member(18, run_rows, 132, 16))
        archive.writestr("data_step.ndc", member(7, step_rows, 132, 5))


def _read_ndc(path: Path, reader):
    with path.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
        return reader(mapped)


def _assert_exact_frame(test_case: unittest.TestCase, expected: pd.DataFrame, actual: pd.DataFrame) -> None:
    test_case.assertEqual(list(expected.columns), list(actual.columns))
    test_case.assertTrue((expected.dtypes == actual.dtypes).all())
    test_case.assertTrue(expected.equals(actual))


class FastCycleNumberTests(unittest.TestCase):
    """The vectorized cycle-number generator must reproduce the original
    per-row state machine exactly, including SIM/Pause/Rest edge cases."""

    def assert_same(self, statuses, mode="chg"):
        df = pd.DataFrame({"Status": pd.Series(statuses, dtype="str")})
        orig = np.asarray(fast_neware._ORIG_GEN_CYCLE(df, mode), dtype="int64")
        fast = np.asarray(fast_neware._fast_generate_cycle_number(df, mode), dtype="int64")
        self.assertTrue(np.array_equal(orig, fast), f"{mode}: {orig} != {fast}")

    def test_simple_cycles(self):
        seq = ["Rest"] + ["CC_Chg"] * 3 + ["CC_DChg"] * 3 + ["CC_Chg"] * 3 + ["CC_DChg"] * 2
        for mode in ("chg", "dchg", "auto"):
            self.assert_same(seq, mode)

    def test_cccv_cp_and_rest_interleaved(self):
        seq = (
            ["Rest", "CCCV_Chg", "CCCV_Chg", "Rest", "CP_DChg", "Rest",
             "CC_Chg", "CV_Chg", "CC_DChg", "CCCV_Chg", "Rest", "CCCV_DChg",
             "CP_Chg", "CP_Chg", "CR_DChg", "CC_Chg"]
        )
        for mode in ("chg", "dchg", "auto"):
            self.assert_same(seq, mode)

    def test_sim_and_pause(self):
        seq = ["SIM", "SIM", "CC_Chg", "Pause", "CC_DChg", "SIM", "CC_Chg",
               "Pause", "CC_Chg", "CC_DChg", "CC_Chg"]
        for mode in ("chg", "dchg"):
            self.assert_same(seq, mode)

    def test_starts_with_discharge(self):
        seq = ["CC_DChg"] * 2 + ["CC_Chg"] * 2 + ["CC_DChg"] * 2 + ["CC_Chg"]
        for mode in ("chg", "dchg", "auto"):
            self.assert_same(seq, mode)

    def test_no_incremental_steps(self):
        self.assert_same(["Rest", "Rest", "Pause"], "chg")

    def test_bad_mode_raises_keyerror(self):
        df = pd.DataFrame({"Status": pd.Series(["Rest"], dtype="str")})
        with self.assertRaises(KeyError):
            fast_neware._fast_generate_cycle_number(df, "bogus")


class FastNdaxDecoderTests(unittest.TestCase):
    """Direct parity tests for the compact, independently encoded NDC pages."""

    def test_compact_pages_match_original_and_preserve_decoded_contract(self):
        rows = _compact_ndc_rows()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compact.ndc"
            path.write_bytes(_ndc_bytes(rows))
            self.assertGreater(path.stat().st_size, _NDC_PAGE_SIZE * 2)

            original = _read_ndc(path, fast_neware._ORIG_READ_5_1)
            fast = _read_ndc(path, fast_neware._fast_read_ndc_5_filetype_1)

        _assert_exact_frame(self, original, fast)
        self.assertEqual(
            list(fast.columns),
            [
                "Index",
                "Cycle",
                "Step_Index",
                "Status",
                "Time",
                "Voltage",
                "Current(mA)",
                "Charge_Capacity(mAh)",
                "Discharge_Capacity(mAh)",
                "Charge_Energy(mWh)",
                "Discharge_Energy(mWh)",
                "Timestamp",
                "Step",
            ],
        )
        self.assertEqual(len(fast), len(rows) - 1)
        self.assertEqual(
            set(fast["Status"]),
            {
                "Rest",
                "CC_DChg",
                "CC_Chg",
                "CV_Chg",
                "CCCV_Chg",
                "CP_DChg",
                "CP_Chg",
                "Pause",
                "SIM",
                "CCCV_DChg",
            },
        )
        self.assertEqual(int(fast.iloc[0]["Index"]), 1)
        self.assertEqual(int(fast.iloc[-1]["Index"]), 55)
        second = fast.iloc[1]
        self.assertEqual(int(second["Cycle"]), 1)
        self.assertEqual(int(second["Step_Index"]), 2)
        self.assertEqual(int(second["Step"]), 2)
        self.assertEqual(float(second["Time"]), 2.0)
        self.assertAlmostEqual(float(second["Voltage"]), 3.502)
        self.assertAlmostEqual(float(second["Current(mA)"]), 1.02)
        self.assertAlmostEqual(float(second["Charge_Capacity(mAh)"]), 20 * 0.01 / 3600)
        self.assertAlmostEqual(float(second["Discharge_Energy(mWh)"]), 18 * 0.01 / 3600)
        self.assertEqual(
            second["Timestamp"],
            pd.Timestamp("2026-01-01T12:00:02"),
        )

    def test_partial_trailing_page_delegates_to_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "partial.ndc"
            path.write_bytes(_ndc_bytes(_compact_ndc_rows()[:3], trailing=b"partial"))
            expected = _read_ndc(path, fast_neware._ORIG_READ_5_1)
            with patch.object(
                fast_neware,
                "_ORIG_READ_5_1",
                wraps=fast_neware._ORIG_READ_5_1,
            ) as original:
                actual = _read_ndc(path, fast_neware._fast_read_ndc_5_filetype_1)

        _assert_exact_frame(self, expected, actual)
        original.assert_called_once()

    def test_unknown_status_and_range_delegate_to_original(self):
        for field, value in (("status_code", 255), ("current_range", 123456)):
            with self.subTest(field=field):
                row = dict(_compact_ndc_rows()[0])
                row[field] = value
                with tempfile.TemporaryDirectory() as temporary:
                    path = Path(temporary) / f"unknown-{field}.ndc"
                    path.write_bytes(_ndc_bytes([row]))
                    with patch.object(
                        fast_neware,
                        "_ORIG_READ_5_1",
                        wraps=fast_neware._ORIG_READ_5_1,
                    ) as original:
                        with self.assertRaises(KeyError):
                            _read_ndc(path, fast_neware._fast_read_ndc_5_filetype_1)
                original.assert_called_once()


class FastNdaxReadTests(unittest.TestCase):
    """End-to-end NewareNDA.read parity at compact and real-source boundaries."""

    def compare(self, path, mode, softcyc):
        fast_neware.uninstall()
        orig = NewareNDA.read(str(path), software_cycle_number=softcyc,
                              cycle_mode=mode, log_level="ERROR")
        fast_neware.install()
        try:
            fast = NewareNDA.read(str(path), software_cycle_number=softcyc,
                                  cycle_mode=mode, log_level="ERROR")
        finally:
            fast_neware.uninstall()
        self.assertEqual(list(orig.columns), list(fast.columns))
        self.assertTrue((orig.dtypes == fast.dtypes).all(),
                        f"dtypes differ: {orig.dtypes} vs {fast.dtypes}")
        self.assertTrue(orig.equals(fast), f"{path.name} mode={mode} soft={softcyc}")

    def test_compact_fixture_all_combinations_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compact.ndax"
            _write_compact_ndax(path)
            for mode in ("chg", "dchg", "auto"):
                for softcyc in (True, False):
                    with self.subTest(file=path.name, mode=mode, soft=softcyc):
                        self.compare(path, mode, softcyc)

    def test_committed_real_source_identical(self):
        self.compare(FULL_PARITY_SOURCE, "chg", True)


class FastNdaxPreviewTests(unittest.TestCase):
    def test_split_v11_voltage_window_matches_authoritative_parser(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "split-v11.ndax"
            _write_split_v11_ndax(path)
            canonical = parsing.parse_timeseries(path)
            selected = fast_neware.read_recent_ndax_raw_for_preview(path, recent_cycle_count=1)
            self.assertIsNotNone(selected)
            expected = canonical[canonical["cycle"] == canonical["cycle"].max()].reset_index(drop=True)
            self.assertEqual(selected.cycle_count, int(canonical["cycle"].max()))
            for column in selected.raw.columns:
                pd.testing.assert_series_equal(
                    selected.raw[column].reset_index(drop=True),
                    expected[column],
                    check_names=False,
                )
            fast_plot = continuation_preview.voltage_preview_from_raw(
                continuation_preview.prepare_segmented_raw(
                    [selected.raw], time_origins_s=[selected.time_origin_s],
                ), max_points=600, x_axis="time",
            )
            expected_plot = continuation_preview.voltage_preview_from_raw(
                continuation_preview.prepare_segmented_raw(
                    [expected], time_origins_s=[float(canonical["time_s"].iloc[0])],
                ), max_points=600, x_axis="time",
            )
            for field in ("x", "y", "current_ma"):
                self.assertEqual(fast_plot[field], expected_plot[field])

    """The first-display tail reader must match the shared full-parse preview."""

    def test_cycle_start_vector_matches_reference_event_walk(self):
        rng = np.random.default_rng(4107)
        sequences = [
            np.asarray([], dtype="uint8"),
            np.asarray([4, 2, 1, 4, 17, 1, 4], dtype="uint8"),
            np.asarray([1, 1, 4, 4, 1, 2, 1], dtype="uint8"),
        ]
        sequences.extend(
            rng.integers(0, 256, size=2048, dtype="uint8") for _ in range(40)
        )
        for statuses in sequences:
            with self.subTest(length=len(statuses)):
                charge = np.isin(statuses, fast_neware._CHARGE_STATUS_CODES)
                rising = charge.copy()
                if rising.size:
                    rising[1:] = charge[1:] & ~charge[:-1]
                    rising[0] = True
                events = np.flatnonzero(rising)
                flags = np.flatnonzero(
                    np.isin(statuses, fast_neware._CYCLE_FLAG_STATUS_CODES)
                )
                expected = []
                flag_position = 0
                has_flag = False
                for event in events:
                    while flag_position < len(flags) and flags[flag_position] < event:
                        has_flag = True
                        flag_position += 1
                    if has_flag:
                        expected.append(int(event))
                        has_flag = False
                np.testing.assert_array_equal(
                    fast_neware._cycle_start_rows(statuses),
                    np.asarray(expected, dtype="int64"),
                )

    def assert_preview_exact(self, frame, cycle_start=None, cycle_end=None):
        prepared = continuation_preview.prepare_segmented_raw(
            [frame],
            time_origins_s=[float(frame["time_s"].iloc[0])],
        )
        for x_axis in ("time", "capacity"):
            expected = continuation_preview.voltage_preview_from_raw(
                prepared,
                max_points=600,
                x_axis=x_axis,
                cycle_start=cycle_start,
                cycle_end=cycle_end,
            )
            preview_rows = self.preview_rows
            fast_prepared = continuation_preview.prepare_segmented_raw(
                [preview_rows.raw],
                time_origins_s=[preview_rows.time_origin_s],
            )
            actual = continuation_preview.voltage_preview_from_raw(
                fast_prepared,
                max_points=600,
                x_axis=x_axis,
            )
            self.assertEqual(expected["x"], actual["x"], x_axis)
            self.assertEqual(expected["y"], actual["y"], x_axis)
            self.assertEqual(expected.get("current_ma"), actual.get("current_ma"), x_axis)

    def test_compact_tail_matches_shared_time_and_capacity_previews(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compact.ndax"
            _write_compact_ndax(path)
            full = parsing.parse_timeseries(path)
            self.preview_rows = fast_neware.read_recent_ndax_raw_for_preview(path)

        self.assertIsNotNone(self.preview_rows)
        self.assertEqual(self.preview_rows.cycle_count, int(full["cycle"].max()))
        self.assert_preview_exact(full)

    def test_requested_cycle_window_matches_shared_preview(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compact.ndax"
            _write_compact_ndax(path)
            full = parsing.parse_timeseries(path)
            self.preview_rows = fast_neware.read_recent_ndax_raw_for_preview(
                path,
                cycle_start=2,
                cycle_end=4,
            )

        self.assertIsNotNone(self.preview_rows)
        self.assert_preview_exact(full, cycle_start=2, cycle_end=4)

    def test_full_range_capacity_and_ce_match_canonical_cycle_summary(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compact.ndax"
            _write_compact_ndax(path)
            full = parsing.parse_timeseries(path)
            expected = calc.per_cycle(full)
            actual = fast_neware.read_ndax_capacity_ce_for_preview(path)

        self.assertIsNotNone(actual)
        self.assertEqual(actual.cycle_count, int(full["cycle"].max()))
        for column in (
            "cycle",
            "charge_capacity_mah",
            "discharge_capacity_mah",
            "coulombic_efficiency_pct",
        ):
            np.testing.assert_array_equal(
                expected[column].to_numpy(),
                actual.cycles[column].to_numpy(),
                err_msg=column,
            )

    def test_repeated_step_index_after_reset_stays_a_separate_run(self):
        rows = _compact_ndc_rows()
        base = datetime(2026, 1, 1, 12, 0, 0)
        # Reuse Step_Index 3 after an intervening Rest step and reset its
        # cumulative charge counter, as can happen in exported protocols.
        rows[5]["step_index"] = 3
        rows[5]["charge_capacity_raw"] = 0
        repeated = dict(rows[5])
        repeated.update(
            {
                "index": 7,
                "time_ms": 7000,
                "timestamp": base + timedelta(seconds=7),
                "charge_capacity_raw": 250,
            }
        )
        for row in rows[6:]:
            row["index"] = int(row["index"]) + 1
            row["time_ms"] = int(row["time_ms"]) + 1000
            row["timestamp"] = base + timedelta(seconds=int(row["index"]))
        rows.insert(6, repeated)

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "repeated-step-index.ndax"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("data.ndc", _ndc_bytes(rows))
            expected = calc.per_cycle(parsing.parse_timeseries(path))
            actual = fast_neware.read_ndax_capacity_ce_for_preview(path)

        self.assertIsNotNone(actual)
        for column in (
            "cycle",
            "charge_capacity_mah",
            "discharge_capacity_mah",
            "coulombic_efficiency_pct",
        ):
            np.testing.assert_array_equal(
                expected[column].to_numpy(),
                actual.cycles[column].to_numpy(),
                err_msg=column,
            )

    def test_zero_range_keeps_canonical_float_reduction(self):
        rows = _compact_ndc_rows()
        # Range 0 has a zero multiplier and can create signed-zero rounding
        # details, so this must stay on the exact per-row fallback.
        rows[2]["current_range"] = 0
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "zero-range.ndax"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("data.ndc", _ndc_bytes(rows))
            expected = calc.per_cycle(parsing.parse_timeseries(path))
            actual = fast_neware.read_ndax_capacity_ce_for_preview(path)

        self.assertIsNotNone(actual)
        for column in (
            "cycle",
            "charge_capacity_mah",
            "discharge_capacity_mah",
            "coulombic_efficiency_pct",
        ):
            np.testing.assert_array_equal(
                expected[column].to_numpy(),
                actual.cycles[column].to_numpy(),
                err_msg=column,
            )

    def test_simple_reader_bounds_declared_output_and_rejects_size_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "bounded.ndax"
            _write_compact_ndax(path)
            self.assertIsNone(
                fast_neware.read_recent_ndax_raw_for_preview(
                    path,
                    max_member_bytes=_NDC_PAGE_SIZE,
                )
            )

            # Keep the central-directory size page-aligned and plausible, but
            # smaller than the actual deflated member. The inflater must stop
            # at declared_size + 1 and reject instead of expanding without a
            # bound.
            data = bytearray(path.read_bytes())
            central_offset = data.rfind(b"PK\x01\x02")
            self.assertGreaterEqual(central_offset, 0)
            actual_size = struct.unpack_from("<I", data, central_offset + 24)[0]
            self.assertGreater(actual_size, 2 * _NDC_PAGE_SIZE)
            struct.pack_into("<I", data, central_offset + 24, 2 * _NDC_PAGE_SIZE)
            path.write_bytes(data)
            self.assertIsNone(fast_neware.read_recent_ndax_raw_for_preview(path))
            self.assertIsNone(fast_neware.read_ndax_capacity_ce_for_preview(path))

    def test_full_range_capacity_bundle_includes_all_three_series(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compact.ndax"
            _write_compact_ndax(path)
            canonical = calc.per_cycle(parsing.parse_timeseries(path))
            preview = _build_fast_neware_capacity_bundle_preview(
                {"source_path": str(path), "source_key": "source-1", "filename": path.name},
                cycle_start=None,
                cycle_end=None,
            )

        self.assertIsNotNone(preview)
        self.assertEqual(preview["quantity"], "capacity_bundle")
        self.assertEqual(preview["cycle_count"], len(canonical))
        segment = preview["segments"][0]
        self.assertEqual(segment["charge_capacity_x"], canonical["cycle"].astype(int).tolist())
        self.assertEqual(segment["discharge_capacity_x"], canonical["cycle"].astype(int).tolist())
        valid_efficiency = canonical.dropna(subset=["coulombic_efficiency_pct"])
        self.assertEqual(
            segment["coulombic_efficiency_x"],
            valid_efficiency["cycle"].astype(int).tolist(),
        )
        for key, column in (
            ("charge_capacity_y", "charge_capacity_mah"),
            ("discharge_capacity_y", "discharge_capacity_mah"),
        ):
            np.testing.assert_array_equal(segment[key], canonical[column].to_numpy())
        np.testing.assert_array_equal(
            segment["coulombic_efficiency_pct"],
            valid_efficiency["coulombic_efficiency_pct"].to_numpy(),
        )

    def test_large_capacity_bundle_keeps_full_extent_with_shared_sampling(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "large-compact.ndax"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("data.ndc", _ndc_bytes(_compact_ndc_rows(310)))
            canonical = calc.per_cycle(parsing.parse_timeseries(path))
            preview = _build_fast_neware_capacity_bundle_preview(
                {"source_path": str(path), "source_key": "source-1", "filename": path.name},
                cycle_start=None,
                cycle_end=None,
            )

        self.assertIsNotNone(preview)
        self.assertGreater(len(canonical), 600)
        self.assertEqual(preview["cycle_count"], int(canonical["cycle"].max()))
        segment = preview["segments"][0]
        for quantity, x_key, y_key in (
            ("charge_capacity_mah", "charge_capacity_x", "charge_capacity_y"),
            ("discharge_capacity_mah", "discharge_capacity_x", "discharge_capacity_y"),
        ):
            expected = capacity_preview_from_cycles(
                canonical,
                max_points=600,
                quantity=quantity,
            )
            self.assertEqual(segment[x_key], expected["x"])
            np.testing.assert_array_equal(segment[y_key], expected["y"])
            self.assertEqual(segment[x_key][0], 1)
            self.assertEqual(segment[x_key][-1], int(canonical["cycle"].max()))
        expected_ce = capacity_efficiency_preview_from_cycles(canonical, max_points=600)
        self.assertEqual(segment["coulombic_efficiency_x"], expected_ce["x"])
        np.testing.assert_array_equal(segment["coulombic_efficiency_pct"], expected_ce["y"])
        self.assertEqual(segment["coulombic_efficiency_x"][0], expected_ce["x"][0])
        self.assertEqual(segment["coulombic_efficiency_x"][-1], expected_ce["x"][-1])

    def test_auxiliary_ndc_layout_uses_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "aux.ndax"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("data.ndc", _ndc_bytes(_compact_ndc_rows()))
                archive.writestr("data_aux_1.ndc", b"aux")

            self.assertIsNone(fast_neware.read_recent_ndax_raw_for_preview(path))
            self.assertIsNone(fast_neware.read_ndax_capacity_ce_for_preview(path))


if __name__ == "__main__":
    unittest.main()
