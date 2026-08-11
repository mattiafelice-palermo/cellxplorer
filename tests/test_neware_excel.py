from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import calc, neware_excel


RECORD_HEADERS = [
    "DataPoint",
    "Cycle Index",
    "Step Index",
    "Step Type",
    "Time(min)",
    "Total Time(min)",
    "Current(mA)",
    "Voltage(V)",
    "Capacity(mAh)",
    "Spec. Cap.(mAh/g)",
    "Chg. Cap.(mAh)",
    "Chg. Spec. Cap.(mAh/g)",
    "DChg. Cap.(mAh)",
    "DChg. Spec. Cap.(mAh/g)",
    "Date",
    "Power(W)",
]

STEP_HEADERS = [
    "Cycle Index",
    "Step Index",
    "Step Number",
    "Step Type",
    "Step Time(min)",
    "Oneset Date",
    "End Date",
    "Capacity(mAh)",
    "Energy(Wh)",
    "Oneset Volt.(V)",
    "End Voltage(V)",
]


def _phase(step_type: str) -> str:
    if "DChg" in step_type:
        return "discharge"
    if "Chg" in step_type:
        return "charge"
    return "rest"


def _energy(power: list[float], total_time_min: list[float]) -> float:
    return sum(
        abs((power[index - 1] + power[index]) / 2.0)
        * max(0.0, total_time_min[index] - total_time_min[index - 1])
        / 60.0
        * 1000.0
        for index in range(1, len(power))
    )


def _write_synthetic_workbook(
    path: Path,
    *,
    include_step: bool = True,
    shuffled_records: bool = False,
    record_headers: list[str] | None = None,
) -> None:
    """Create a compact Neware-shaped workbook without private source data."""

    base = datetime(2026, 1, 1, 12, 0, 0)
    segments = [
        # Cycle 1 contains the same programmed step twice.  The second
        # occurrence must receive a distinct executed ``step`` id.
        (1, 1, "Rest", [0.0, 1.0], [3.50, 3.50], [0.0, 0.0], [0.0, 0.0]),
        (1, 2, "CC Chg", [0.0, 1.0, 2.0], [3.50, 3.60, 3.70], [0.0, 1.0, 2.0], [0.01] * 3),
        (1, 3, "Rest", [0.0, 1.0], [3.70, 3.70], [0.0, 0.0], [0.0, 0.0]),
        (1, 2, "CC Chg", [0.0, 1.0], [3.70, 3.80], [0.0, 0.5], [0.01] * 2),
        (1, 4, "CV Chg", [0.0, 1.0, 2.0], [3.80, 3.80, 3.80], [0.0, 0.2, 0.4], [0.005] * 3),
        (1, 5, "CC DChg", [0.0, 1.0, 2.0], [3.80, 3.20, 3.00], [0.0, 0.75, 1.5], [-0.008] * 3),
        (2, 1, "Rest", [0.0, 1.0], [3.00, 3.00], [0.0, 0.0], [0.0, 0.0]),
        (2, 2, "CC Chg", [0.0, 1.0, 2.0], [3.00, 3.40, 3.70], [0.0, 0.8, 1.6], [0.01] * 3),
        (2, 3, "CV Chg", [0.0, 1.0], [3.70, 3.70], [0.0, 0.2], [0.005] * 2),
        (2, 4, "CC DChg", [0.0, 1.0, 2.0], [3.70, 3.30, 3.00], [0.0, 0.6, 1.2], [-0.008] * 3),
    ]

    rows: list[dict[str, object]] = []
    summaries: list[list[object]] = []
    total_time_min = 0.0
    data_point = 1
    for cycle, step_index, step_type, times, voltages, capacities, power in segments:
        phase = _phase(step_type)
        current = 1.0 if phase == "charge" else -1.0 if phase == "discharge" else 0.0
        dates = [base + timedelta(minutes=total_time_min + value) for value in times]
        total_times = [total_time_min + value for value in times]
        for index, (time, total, voltage, capacity, watts, timestamp) in enumerate(
            zip(times, total_times, voltages, capacities, power, dates)
        ):
            rows.append(
                {
                    "DataPoint": data_point,
                    "Cycle Index": cycle,
                    "Step Index": step_index,
                    "Step Type": step_type,
                    "Time(min)": time,
                    "Total Time(min)": total,
                    "Current(mA)": current,
                    "Voltage(V)": voltage,
                    "Capacity(mAh)": capacity,
                    "Spec. Cap.(mAh/g)": capacity / 10.0,
                    "Chg. Cap.(mAh)": capacity if phase == "charge" else 0.0,
                    "Chg. Spec. Cap.(mAh/g)": capacity / 10.0 if phase == "charge" else 0.0,
                    "DChg. Cap.(mAh)": capacity if phase == "discharge" else 0.0,
                    "DChg. Spec. Cap.(mAh/g)": capacity / 10.0 if phase == "discharge" else 0.0,
                    "Date": timestamp,
                    "Power(W)": watts,
                }
            )
            data_point += 1

        summaries.append(
            [
                cycle,
                step_index,
                len(summaries) + 1,
                step_type,
                times[-1],
                dates[0],
                dates[-1],
                max(capacities) - min(capacities) if phase != "rest" else 0.0,
                _energy(power, total_times) / 1000.0,
                voltages[0],
                voltages[-1],
            ]
        )
        total_time_min = total_times[-1]

    workbook = Workbook()
    record_sheet = workbook.active
    record_sheet.title = "record"
    headers = record_headers or RECORD_HEADERS
    record_sheet.append(headers)
    source_rows = list(reversed(rows)) if shuffled_records else rows
    for row in source_rows:
        record_sheet.append([row.get(header.strip(), row.get(header)) for header in headers])

    if include_step:
        step_sheet = workbook.create_sheet("step")
        step_sheet.append(STEP_HEADERS)
        for summary in summaries:
            step_sheet.append(summary)

    workbook.save(path)


class NewareExcelParserTests(unittest.TestCase):
    def test_valid_workbook_is_recognized(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.xlsx"
            _write_synthetic_workbook(path)
            self.assertTrue(neware_excel.is_supported_workbook(path))

    def test_unrelated_xlsx_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "unrelated.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Sheet1"
            sheet.append(["Voltage", "Current"])
            sheet.append([3.7, 1.0])
            workbook.save(path)
            self.assertFalse(neware_excel.is_supported_workbook(path))
            with self.assertRaises(neware_excel.UnsupportedNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_missing_record_sheet_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "missing-record.xlsx"
            workbook = Workbook()
            workbook.active.title = "unit"
            workbook.save(path)
            with self.assertRaises(neware_excel.UnsupportedNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_each_missing_required_record_header_is_rejected(self):
        for missing in neware_excel.REQUIRED_RECORD_HEADERS:
            with self.subTest(missing=missing), TemporaryDirectory() as temporary:
                path = Path(temporary) / "missing-column.xlsx"
                headers = [header for header in RECORD_HEADERS if header != missing]
                _write_synthetic_workbook(path, record_headers=headers)
                with self.assertRaises(neware_excel.UnsupportedNewareExcelError):
                    neware_excel.parse_timeseries(path)

    def test_duplicate_normalized_headers_are_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "duplicate-header.xlsx"
            _write_synthetic_workbook(path, record_headers=RECORD_HEADERS + [" Voltage(V) "])
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_corrupt_xlsx_is_rejected_with_domain_error(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "corrupt.xlsx"
            path.write_bytes(b"not an xlsx zip")
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_canonical_mapping_dtypes_and_auxiliary_columns(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.xlsx"
            _write_synthetic_workbook(path, shuffled_records=True)
            frame = neware_excel.parse_timeseries(path)

        self.assertEqual(len(frame), 25)
        self.assertEqual(frame["record_index"].tolist(), list(range(1, 26)))
        self.assertEqual(
            list(frame.columns),
            [
                "record_index",
                "cycle",
                "step",
                "step_index",
                "status",
                "time_s",
                "total_time_s",
                "voltage_v",
                "current_ma",
                "charge_capacity_mah",
                "discharge_capacity_mah",
                "charge_energy_mwh",
                "discharge_energy_mwh",
                "timestamp",
                "power_w",
                "capacity_mah",
                "specific_capacity_mah_g",
                "charge_specific_capacity_mah_g",
                "discharge_specific_capacity_mah_g",
            ],
        )
        for column in ("record_index", "cycle", "step", "step_index"):
            self.assertEqual(str(frame[column].dtype), "int64")
        for column in (
            "time_s",
            "total_time_s",
            "voltage_v",
            "current_ma",
            "charge_capacity_mah",
            "discharge_capacity_mah",
            "charge_energy_mwh",
            "discharge_energy_mwh",
            "power_w",
            "capacity_mah",
            "specific_capacity_mah_g",
            "charge_specific_capacity_mah_g",
            "discharge_specific_capacity_mah_g",
        ):
            self.assertEqual(str(frame[column].dtype), "float64")
        self.assertEqual(str(frame["timestamp"].dtype), "datetime64[ns]")
        self.assertTrue(pd.api.types.is_string_dtype(frame["status"]))
        self.assertEqual(
            set(frame["status"]),
            {"Rest", "CC_Chg", "CV_Chg", "CC_DChg"},
        )

    def test_time_units_and_duplicate_timestamps_are_preserved(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.xlsx"
            _write_synthetic_workbook(path)
            frame = neware_excel.parse_timeseries(path)

        np.testing.assert_allclose(frame["time_s"].iloc[:6], [0.0, 60.0, 0.0, 60.0, 120.0, 0.0])
        np.testing.assert_allclose(
            frame["total_time_s"].iloc[:6], [0.0, 60.0, 60.0, 120.0, 180.0, 180.0]
        )
        self.assertGreater(int(frame["timestamp"].duplicated().sum()), 0)
        self.assertTrue(frame["total_time_s"].is_monotonic_increasing)

    def test_invalid_required_values_are_rejected(self):
        cases = {
            "G2": "NaN",
            "H2": "not-a-number",
            "P2": "Infinity",
            "O2": "not-a-date",
        }
        for cell, value in cases.items():
            with self.subTest(cell=cell), TemporaryDirectory() as temporary:
                path = Path(temporary) / "invalid-value.xlsx"
                _write_synthetic_workbook(path, include_step=False)
                workbook = load_workbook(path)
                workbook["record"][cell] = value
                workbook.save(path)
                with self.assertRaises(neware_excel.InvalidNewareExcelError):
                    neware_excel.parse_timeseries(path)

    def test_verified_statuses_map_to_canonical_values(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "statuses.xlsx"
            _write_synthetic_workbook(path, include_step=False)
            workbook = load_workbook(path)
            statuses = ["Rest", "CC Chg", "CCCV Chg", "CV Chg", "CC DChg", "CCCV DChg"]
            for row_number, status in enumerate(statuses, start=2):
                workbook["record"].cell(row_number, 4).value = status
            workbook.save(path)
            frame = neware_excel.parse_timeseries(path)

        self.assertTrue(
            {
                "Rest",
                "CC_Chg",
                "CCCV_Chg",
                "CV_Chg",
                "CC_DChg",
                "CCCV_DChg",
            }.issubset(set(frame["status"]))
        )

    def test_programmed_and_executed_steps_remain_distinct(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.xlsx"
            _write_synthetic_workbook(path)
            frame = neware_excel.parse_timeseries(path)

        repeated = frame.loc[
            (frame["cycle"] == 1) & (frame["step_index"] == 2), "step"
        ].unique()
        np.testing.assert_array_equal(repeated, [2, 4])
        self.assertEqual(frame["step"].nunique(), 10)
        self.assertEqual(frame.attrs["neware_excel"]["executed_step_count"], 10)
        self.assertTrue(frame.attrs["neware_excel"]["step_summary_validated"])
        self.assertTrue(frame["step"].is_monotonic_increasing)

    def test_time_reset_alone_starts_a_new_execution(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "time-reset-only.xlsx"
            _write_synthetic_workbook(path, include_step=False)
            workbook = load_workbook(path)
            record_sheet = workbook["record"]
            # Rows 3 and 4 are consecutive source records. Make the second
            # one share every other boundary signal with the first while its
            # step-relative time resets from one minute to zero.
            record_sheet["C4"] = 1
            record_sheet["D4"] = "Rest"
            record_sheet["E4"] = 0.0
            record_sheet["G4"] = 0.0
            record_sheet["P4"] = 0.0
            workbook.save(path)
            frame = neware_excel.parse_timeseries(path)

        reset_rows = frame.loc[frame["record_index"].isin([2, 3])]
        self.assertEqual(reset_rows["cycle"].tolist(), [1, 1])
        self.assertEqual(reset_rows["step_index"].tolist(), [1, 1])
        self.assertEqual(reset_rows["status"].tolist(), ["Rest", "Rest"])
        np.testing.assert_allclose(reset_rows["time_s"], [60.0, 0.0])
        np.testing.assert_allclose(reset_rows["total_time_s"], [60.0, 60.0])
        self.assertEqual(reset_rows["step"].tolist(), [1, 2])
        self.assertTrue(frame["step"].is_monotonic_increasing)

    def test_energy_counters_reset_at_each_executed_step(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.xlsx"
            _write_synthetic_workbook(path)
            frame = neware_excel.parse_timeseries(path)

        charge_first = frame.groupby("step")["charge_energy_mwh"].first()
        discharge_first = frame.groupby("step")["discharge_energy_mwh"].first()
        np.testing.assert_allclose(charge_first.to_numpy(), 0.0)
        np.testing.assert_allclose(discharge_first.to_numpy(), 0.0)
        self.assertGreater(float(frame["charge_energy_mwh"].max()), 0.0)
        self.assertGreater(float(frame["discharge_energy_mwh"].max()), 0.0)
        charge_rows = frame["status"].str.contains("Chg") & ~frame["status"].str.contains("DChg")
        discharge_rows = frame["status"].str.contains("DChg")
        np.testing.assert_allclose(frame.loc[charge_rows, "discharge_energy_mwh"], 0.0)
        np.testing.assert_allclose(frame.loc[discharge_rows, "charge_energy_mwh"], 0.0)

    def test_calc_per_cycle_consumes_excel_frame_without_special_case(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.xlsx"
            _write_synthetic_workbook(path)
            frame = neware_excel.parse_timeseries(path)

        cycles = calc.per_cycle(frame)
        self.assertEqual(cycles["cycle"].tolist(), [1, 2])
        np.testing.assert_allclose(cycles["charge_capacity_mah"], [2.9, 1.8])
        np.testing.assert_allclose(cycles["discharge_capacity_mah"], [1.5, 1.2])
        np.testing.assert_allclose(cycles["charge_energy_mwh"], [2.0 / 3.0, 5.0 / 12.0])
        np.testing.assert_allclose(cycles["discharge_energy_mwh"], [4.0 / 15.0, 4.0 / 15.0])
        np.testing.assert_allclose(cycles["charge_time_h"], [5.0 / 60.0, 3.0 / 60.0])
        np.testing.assert_allclose(cycles["discharge_time_h"], [2.0 / 60.0, 2.0 / 60.0])
        np.testing.assert_allclose(cycles["cv_charge_capacity_mah"], [0.4, 0.2])
        np.testing.assert_allclose(cycles["cv_charge_time_h"], [2.0 / 60.0, 1.0 / 60.0])

    def test_missing_step_summary_keeps_raw_capability(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "without-step.xlsx"
            _write_synthetic_workbook(path, include_step=False)
            self.assertTrue(neware_excel.is_supported_workbook(path))
            frame = neware_excel.parse_timeseries(path)

        self.assertEqual(len(frame), 25)
        self.assertFalse(frame.attrs["neware_excel"]["step_summary_available"])
        self.assertFalse(frame.attrs["neware_excel"]["step_summary_validated"])

    def test_step_summary_count_mismatch_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "step-count-mismatch.xlsx"
            _write_synthetic_workbook(path)
            workbook = load_workbook(path)
            workbook["step"].delete_rows(workbook["step"].max_row)
            workbook.save(path)
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_step_summary_identity_mismatch_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "step-identity-mismatch.xlsx"
            _write_synthetic_workbook(path)
            workbook = load_workbook(path)
            workbook["step"]["A2"] = 99
            workbook.save(path)
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_step_summary_duration_mismatch_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "step-duration-mismatch.xlsx"
            _write_synthetic_workbook(path)
            workbook = load_workbook(path)
            workbook["step"]["E2"] = 100.0
            workbook.save(path)
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_step_summary_rounding_uses_observed_record_cadence(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "rounded-step-time.xlsx"
            _write_synthetic_workbook(path)
            workbook = load_workbook(path)
            # The raw segment lasts 60 seconds; a rounded 63-second summary is
            # accepted within the observed 60-second record cadence.
            workbook["step"]["E2"] = 1.05
            workbook.save(path)
            frame = neware_excel.parse_timeseries(path)

        self.assertTrue(frame.attrs["neware_excel"]["step_summary_validated"])

    def test_unknown_status_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "unknown-status.xlsx"
            _write_synthetic_workbook(path, include_step=False)
            workbook = load_workbook(path)
            workbook["record"]["D2"] = "Unknown"
            workbook.save(path)
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_duplicate_datapoint_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "duplicate-datapoint.xlsx"
            _write_synthetic_workbook(path, include_step=False)
            workbook = load_workbook(path)
            workbook["record"]["A3"] = 1
            workbook.save(path)
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)

    def test_total_time_decrease_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "time-decrease.xlsx"
            _write_synthetic_workbook(path, include_step=False)
            workbook = load_workbook(path)
            workbook["record"]["F3"] = -1
            workbook.save(path)
            with self.assertRaises(neware_excel.InvalidNewareExcelError):
                neware_excel.parse_timeseries(path)


if __name__ == "__main__":
    unittest.main()
