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

from app.services import fast_neware

FULL_PARITY_SOURCE = ROOT / "tests" / "fixtures" / "golden_analysis" / "sources" / "cycles_time_steps.ndax"

_NDC_PAGE_SIZE = 4096
_NDC_RECORD_SIZE = 87
_NDC_PAYLOAD_OFFSET = 125
_NDC_TRAILER_SIZE = 56


def _compact_ndc_rows() -> list[dict[str, object]]:
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
    for cycle in range(5):
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
            "cycle": 5,
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


if __name__ == "__main__":
    unittest.main()
