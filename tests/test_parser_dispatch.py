"""Source-format adapter dispatch tests (Spec 040.2).

Covers `backend/app/services/parsing.py`'s format-neutral facade: format
recognition (cases 1-5), the adapter descriptor (case 6), binary/Excel parse
parity before/after the dispatch refactor (cases 7-8), metadata dispatch
parity (case 9), canonical validation still running at the full-parse/cache
boundary rather than at recognition (case 10), the deferred 040.1 review gap
that metadata/list reads must not trigger a full parse (case 11), unchanged
import-inspection/scanner extension behavior (case 12), and the deterministic
transitional `parsing.PARSER_VERSION` bundle (case 13). See
`docs/specs/040.2-source-format-adapter-dispatch.md`.

The binary/Excel parity hashes in `BinaryParityTests`/`ExcelParityTests` were
captured from the pre-refactor implementation and independently reproduced
byte-for-byte after the refactor (see the spec's implementation record); any
future schema, dtype, or value drift changes them.
"""
from __future__ import annotations

import hashlib
import os
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from openpyxl import Workbook

from app.services import import_inspection, neware_excel, parsing
from app.services.canonical_cycling import CANONICAL_RAW_VERSION, validate_raw_timeseries

_GOLDEN_SOURCES_DIR = ROOT / "tests" / "fixtures" / "golden_analysis" / "sources"
_GOLDEN_NDAX = _GOLDEN_SOURCES_DIR / "cycles_time_steps.ndax"

_RECORD_HEADERS = [
    "DataPoint",
    "Cycle Index",
    "Step Index",
    "Step Type",
    "Time(min)",
    "Total Time(min)",
    "Current(mA)",
    "Voltage(V)",
    "Chg. Cap.(mAh)",
    "DChg. Cap.(mAh)",
    "Date",
    "Power(W)",
]


def _write_minimal_workbook(path: Path) -> None:
    """A compact structured Neware-shaped workbook (Spec 039 style), no
    private source data: one cycle, Rest -> CC Chg -> CC DChg."""
    base = datetime(2026, 1, 1, 12, 0, 0)
    segments = [
        (1, 1, "Rest", [0.0, 1.0], [3.50, 3.50], 0.0, 0.0),
        (1, 2, "CC Chg", [0.0, 1.0, 2.0], [3.50, 3.60, 3.70], 1.0, 0.0),
        (1, 3, "CC DChg", [0.0, 1.0, 2.0], [3.70, 3.20, 3.00], 0.0, 1.5),
    ]
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "record"
    sheet.append(_RECORD_HEADERS)
    data_point = 1
    total_time_min = 0.0
    for cycle, step_index, step_type, times, voltages, chg_rate, dchg_final in segments:
        for time_value, voltage in zip(times, voltages):
            fraction = time_value / times[-1] if times[-1] else 0.0
            is_charge = "Chg" in step_type and "DChg" not in step_type
            is_discharge = "DChg" in step_type
            charge_cap = chg_rate * time_value if is_charge else 0.0
            discharge_cap = dchg_final * fraction if is_discharge else 0.0
            current = 1.0 if is_charge else (-1.0 if is_discharge else 0.0)
            timestamp = base + timedelta(minutes=total_time_min + time_value)
            sheet.append(
                [
                    data_point,
                    cycle,
                    step_index,
                    step_type,
                    time_value,
                    total_time_min + time_value,
                    current,
                    voltage,
                    charge_cap,
                    discharge_cap,
                    timestamp,
                    current * voltage / 1000.0,
                ]
            )
            data_point += 1
        total_time_min += times[-1]
    workbook.save(path)


def _write_unrelated_workbook(path: Path) -> None:
    """A generic `.xlsx` with no Neware-shaped `record` sheet at all."""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Sheet1"
    sheet.append(["Date", "Value"])
    sheet.append(["2026-01-01", 1.0])
    workbook.save(path)


def _content_hash(df: pd.DataFrame) -> str:
    return hashlib.sha256(df.astype(str).to_csv(index=False).encode("utf-8")).hexdigest()


class FormatRecognitionTests(unittest.TestCase):
    """Cases 1-5: format recognition and dispatch."""

    def test_nda_selects_neware_binary(self):
        self.assertEqual(parsing.recognize_source("source.nda"), parsing.FORMAT_NEWARE_BINARY)

    def test_ndax_selects_neware_binary(self):
        self.assertEqual(parsing.recognize_source("source.ndax"), parsing.FORMAT_NEWARE_BINARY)

    def test_valid_structured_xlsx_selects_neware_excel(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "structured.xlsx"
            _write_minimal_workbook(path)
            self.assertEqual(parsing.recognize_source(path), parsing.FORMAT_NEWARE_EXCEL)

    def test_arbitrary_xlsx_is_not_recognized(self):
        """Case 4: extension alone must never grant `neware_excel` — Parent
        039's structural contract."""
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "unrelated.xlsx"
            _write_unrelated_workbook(path)
            self.assertIsNone(parsing.recognize_source(path))
            self.assertFalse(neware_excel.is_supported_workbook(path))
            with self.assertRaises(parsing.UnsupportedSourceFormatError):
                parsing.source_parser_descriptor(path)

    def test_unsupported_extension_fails_clearly(self):
        self.assertIsNone(parsing.recognize_source("source.csv"))
        with self.assertRaises(parsing.UnsupportedSourceFormatError):
            parsing.parse_timeseries("source.csv")
        with self.assertRaises(parsing.UnsupportedSourceFormatError):
            parsing.source_parser_descriptor("source.csv")
        result = parsing.read_header_metadata("source.csv")
        self.assertEqual(result["raw"], {})
        self.assertIn("error", result)


class AdapterDescriptorTests(unittest.TestCase):
    """Case 6: the adapter descriptor exposes format id, adapter revision,
    and canonical raw version."""

    def test_binary_descriptor(self):
        descriptor = parsing.source_parser_descriptor("source.ndax")
        self.assertEqual(descriptor["format_id"], parsing.FORMAT_NEWARE_BINARY)
        self.assertEqual(descriptor["adapter_revision"], parsing.NEWARE_NDA_VERSION)
        self.assertEqual(descriptor["canonical_raw_version"], CANONICAL_RAW_VERSION)

    def test_excel_descriptor(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "structured.xlsx"
            _write_minimal_workbook(path)
            descriptor = parsing.source_parser_descriptor(path)
        self.assertEqual(descriptor["format_id"], parsing.FORMAT_NEWARE_EXCEL)
        self.assertEqual(descriptor["adapter_revision"], str(neware_excel.EXCEL_PARSER_REVISION))
        self.assertEqual(descriptor["canonical_raw_version"], CANONICAL_RAW_VERSION)


class BinaryParityTests(unittest.TestCase):
    """Case 7: `parsing.parse_timeseries` for the existing binary golden
    fixture is numerically/schema identical before/after the 040.2 dispatch
    refactor."""

    EXPECTED_SHAPE = (71190, 13)
    EXPECTED_COLUMNS = [
        "record_index",
        "cycle",
        "step",
        "step_index",
        "status",
        "time_s",
        "voltage_v",
        "current_ma",
        "charge_capacity_mah",
        "discharge_capacity_mah",
        "charge_energy_mwh",
        "discharge_energy_mwh",
        "timestamp",
    ]
    EXPECTED_HASH = "0ca93bae328d28885cd22ba8b5596c70aba25c1e209b0c82c49333825fb5010a"

    def test_binary_output_matches_pre_refactor_snapshot(self):
        if not _GOLDEN_NDAX.is_file():
            self.skipTest("golden .ndax fixture not present")
        df = parsing.parse_timeseries(_GOLDEN_NDAX)
        self.assertEqual(df.shape, self.EXPECTED_SHAPE)
        self.assertEqual(list(df.columns), self.EXPECTED_COLUMNS)
        self.assertEqual(_content_hash(df), self.EXPECTED_HASH)
        validate_raw_timeseries(df)  # case 10: output obeys canonical validation


class ExcelParityTests(unittest.TestCase):
    """Case 8: `parsing.parse_timeseries` for a Parent 039 Excel fixture is
    identical before/after the 040.2 dispatch refactor."""

    EXPECTED_SHAPE = (8, 15)
    EXPECTED_COLUMNS = [
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
    ]
    EXPECTED_HASH = "e075b2dd596e31bca1c49ab2b6c381221edd6ab80bba1007725ec418036f9fbd"

    def test_excel_output_matches_pre_refactor_snapshot(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "structured.xlsx"
            _write_minimal_workbook(path)
            df = parsing.parse_timeseries(path)
        self.assertEqual(df.shape, self.EXPECTED_SHAPE)
        self.assertEqual(list(df.columns), self.EXPECTED_COLUMNS)
        self.assertEqual(_content_hash(df), self.EXPECTED_HASH)
        validate_raw_timeseries(df)  # case 10: output obeys canonical validation


class HeaderMetadataDispatchParityTests(unittest.TestCase):
    """Case 9: `read_header_metadata` dispatch preserves normalized metadata
    for both current format families."""

    def test_binary_metadata_is_curated(self):
        if not _GOLDEN_NDAX.is_file():
            self.skipTest("golden .ndax fixture not present")
        meta = parsing.read_header_metadata(_GOLDEN_NDAX)
        self.assertNotIn("error", meta)
        self.assertIsNotNone(meta["nda_version"])
        self.assertNotIn("source_format", meta)
        self.assertGreater(len(meta["raw"]), 0)

    def test_excel_metadata_is_curated(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "structured.xlsx"
            _write_minimal_workbook(path)
            meta = parsing.read_header_metadata(path)
        self.assertNotIn("error", meta)
        self.assertIsNone(meta["nda_version"])
        self.assertEqual(meta["source_format"], "Neware Excel")
        self.assertIn("capabilities", meta)


class MetadataDoesNotFullyParseTests(unittest.TestCase):
    """Case 11: the deferred 040.1 review gap — metadata/list reads must
    not trigger the full timeseries parser for either format family.

    040.1's review recorded this as structurally true but untested; this is
    the test that lands it (see
    docs/specs/reviews/040.1-canonical-cycling-data-contract-and-validation-review.md,
    "Test coverage").
    """

    def test_binary_metadata_does_not_call_the_full_parser(self):
        if not _GOLDEN_NDAX.is_file():
            self.skipTest("golden .ndax fixture not present")
        with mock.patch.object(
            parsing, "_parse_neware_binary_timeseries", side_effect=AssertionError("full parse")
        ), mock.patch.object(parsing.NewareNDA, "read", side_effect=AssertionError("full parse")):
            parsing.read_header_metadata(_GOLDEN_NDAX)  # must not raise

    def test_excel_metadata_does_not_call_the_full_parser(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "structured.xlsx"
            _write_minimal_workbook(path)
            with mock.patch.object(
                neware_excel, "parse_timeseries", side_effect=AssertionError("full parse")
            ):
                parsing.read_header_metadata(path)  # must not raise

    def test_import_inspection_does_not_call_the_full_parser(self):
        if not _GOLDEN_NDAX.is_file():
            self.skipTest("golden .ndax fixture not present")
        with mock.patch.object(parsing, "parse_timeseries", side_effect=AssertionError("full parse")):
            inspection = import_inspection.inspect_file(str(_GOLDEN_NDAX))
        self.assertEqual(inspection.hash, parsing.compute_hash(_GOLDEN_NDAX))


class ExtensionPolicyUnchangedTests(unittest.TestCase):
    """Case 12: import-inspection/scanner extension behavior is unchanged."""

    def test_supported_extensions_unchanged(self):
        self.assertEqual(
            parsing.SUPPORTED_NEWARE_SOURCE_EXTENSIONS, frozenset({".nda", ".ndax", ".xlsx"})
        )

    def test_source_filename_allowed_matches_supported_extensions(self):
        self.assertTrue(parsing.source_filename_allowed("a.nda"))
        self.assertTrue(parsing.source_filename_allowed("a.ndax"))
        self.assertTrue(parsing.source_filename_allowed("a.xlsx"))
        self.assertFalse(parsing.source_filename_allowed("a.csv"))
        self.assertFalse(parsing.source_filename_allowed("a.mpr"))

    def test_source_parser_family_unchanged(self):
        self.assertEqual(parsing.source_parser_family("a.nda"), "binary")
        self.assertEqual(parsing.source_parser_family("a.ndax"), "binary")
        self.assertEqual(parsing.source_parser_family("a.xlsx"), "excel")
        self.assertIsNone(parsing.source_parser_family("a.csv"))


class TransitionalParserBundleTests(unittest.TestCase):
    """Case 13: `parsing.PARSER_VERSION` remains the deterministic
    transitional global bundle until Spec 040.3, built from the same two
    adapter revisions the new descriptor system exposes."""

    def test_parser_version_is_built_from_the_two_adapter_revisions(self):
        binary_descriptor = parsing.source_parser_descriptor("a.ndax")
        excel_revision = parsing._NEWARE_EXCEL_FORMAT.adapter_revision
        self.assertEqual(
            parsing.PARSER_VERSION,
            f"{binary_descriptor['adapter_revision']}-cxp{excel_revision}",
        )
        self.assertLessEqual(len(parsing.PARSER_VERSION), 30)

    def test_parser_version_is_stable_across_repeated_reads(self):
        self.assertEqual(parsing.PARSER_VERSION, parsing.PARSER_VERSION)
        self.assertEqual(
            parsing.PARSER_VERSION,
            f"{parsing.NEWARE_NDA_VERSION}-cxp{neware_excel.EXCEL_PARSER_REVISION}",
        )


if __name__ == "__main__":
    unittest.main()
