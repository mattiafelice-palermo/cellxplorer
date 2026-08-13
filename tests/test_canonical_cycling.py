"""Canonical cycling data contract and validation tests (Spec 040.1).

Covers `backend/app/services/canonical_cycling.py` in isolation (cases 1-9),
current real/synthetic parser output (cases 10-11), and proves the validator
does not change scientific output (case 12). See
`docs/agent-knowledge/canonical-cycling-data.md` for the narrative contract.
"""
from __future__ import annotations

import os
import shutil
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from openpyxl import Workbook

from app.services import cache, calc, canonical_cycling, parsing
from app.services.canonical_cycling import CanonicalCyclingError, validate_raw_timeseries


def _minimal_frame(**overrides) -> pd.DataFrame:
    """A small, otherwise-valid canonical frame: two executed steps (charge
    then discharge) inside one cycle, with `time_s` resetting at the step
    boundary — exactly the shape `calc.per_cycle` assumes."""
    base = {
        "record_index": [0, 1, 2, 3],
        "cycle": [1, 1, 1, 1],
        "step_index": [1, 1, 2, 2],
        "step": [1, 1, 2, 2],
        "status": ["CC_Chg", "CC_Chg", "CC_DChg", "CC_DChg"],
        "time_s": [0.0, 1.0, 0.0, 1.0],
        "voltage_v": [3.5, 3.6, 3.6, 3.5],
        "current_ma": [100.0, 100.0, -100.0, -100.0],
        "charge_capacity_mah": [0.0, 0.1, 0.1, 0.1],
        "discharge_capacity_mah": [0.0, 0.0, 0.0, 0.05],
    }
    base.update(overrides)
    return pd.DataFrame(base)


class MinimalFrameTests(unittest.TestCase):
    """Case 1: a minimal valid canonical cycling frame passes."""

    def test_minimal_valid_frame_passes(self):
        validate_raw_timeseries(_minimal_frame())  # must not raise

    def test_missing_required_column_fails(self):
        df = _minimal_frame().drop(columns=["current_ma"])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("current_ma", str(ctx.exception))

    def test_require_cycling_false_skips_required_column_check(self):
        df = _minimal_frame()[["record_index", "voltage_v"]]
        validate_raw_timeseries(df, require_cycling=False)  # must not raise


class RecordIndexTests(unittest.TestCase):
    """Case 2: duplicate `record_index` fails."""

    def test_duplicate_record_index_fails(self):
        df = _minimal_frame(record_index=[0, 0, 2, 3])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("record_index", str(ctx.exception))

    def test_missing_record_index_value_fails(self):
        df = _minimal_frame(record_index=[0, None, 2, 3])
        with self.assertRaises(CanonicalCyclingError):
            validate_raw_timeseries(df)


class CycleTests(unittest.TestCase):
    """Case 3: non-integer/ambiguous `cycle` fails."""

    def test_non_integer_cycle_fails(self):
        df = _minimal_frame(cycle=[1, 1.5, 1, 1])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("cycle", str(ctx.exception))

    def test_non_numeric_cycle_fails(self):
        df = _minimal_frame(cycle=["a", "b", "c", "d"])
        with self.assertRaises(CanonicalCyclingError):
            validate_raw_timeseries(df)

    def test_gaps_in_cycle_labels_are_accepted(self):
        # Spec: gaps are allowed because stitch.observed_local_cycles already
        # maps observed labels densely; the validator must not invent labels.
        df = _minimal_frame(cycle=[1, 1, 5, 5])
        validate_raw_timeseries(df)  # must not raise


class StepIdentityTests(unittest.TestCase):
    """Cases 4-5: `step`/`step_index` structural consistency."""

    def test_repeated_step_index_across_distinct_steps_is_accepted(self):
        # A looped protocol segment: step_index 1 executed twice as step 1
        # and step 2. Many `step` values sharing one `step_index` is normal.
        df = _minimal_frame(
            step_index=[1, 1, 1, 1],
            step=[1, 1, 2, 2],
            status=["CC_Chg", "CC_Chg", "CC_Chg", "CC_Chg"],
            current_ma=[100.0, 100.0, 100.0, 100.0],
            discharge_capacity_mah=[0.0, 0.0, 0.0, 0.0],
        )
        validate_raw_timeseries(df)  # must not raise

    def test_one_step_mapping_to_two_step_indexes_fails(self):
        # step=1 rows carry step_index values 1 and 2 — scientifically
        # impossible: one executed occurrence cannot belong to two
        # programmed steps.
        df = _minimal_frame(step_index=[1, 2, 2, 2], step=[1, 1, 2, 2])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        message = str(ctx.exception)
        self.assertIn("step", message)
        self.assertIn("step_index", message)


class TimeColumnTests(unittest.TestCase):
    """Case 6: `time_s` reset at an executed-step boundary is accepted."""

    def test_time_s_reset_at_step_boundary_is_accepted(self):
        df = _minimal_frame(time_s=[0.0, 5.0, 0.0, 3.0])
        validate_raw_timeseries(df)  # must not raise

    def test_negative_time_s_fails(self):
        df = _minimal_frame(time_s=[0.0, -1.0, 0.0, 1.0])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("time_s", str(ctx.exception))


class TotalTimeTests(unittest.TestCase):
    """Case 7: decreasing `total_time_s` fails beyond tolerance."""

    def test_decreasing_total_time_s_fails(self):
        df = _minimal_frame(total_time_s=[0.0, 1.0, 0.5, 2.0])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("total_time_s", str(ctx.exception))

    def test_non_decreasing_total_time_s_passes(self):
        df = _minimal_frame(total_time_s=[0.0, 1.0, 1.0, 2.0])
        validate_raw_timeseries(df)  # must not raise, including the plateau

    def test_tiny_floating_point_decrease_is_tolerated(self):
        df = _minimal_frame(total_time_s=[0.0, 1.0, 1.0 - 1e-9, 2.0])
        validate_raw_timeseries(df)  # must not raise


class OptionalColumnTests(unittest.TestCase):
    """Case 8: missing optional energy/timestamp/auxiliary voltage columns
    remains valid."""

    def test_minimal_frame_has_no_standard_optional_columns_and_still_passes(self):
        df = _minimal_frame()
        for column in canonical_cycling.STANDARD_OPTIONAL_COLUMNS:
            self.assertNotIn(column, df.columns)
        validate_raw_timeseries(df)  # must not raise

    def test_present_optional_columns_are_still_checked(self):
        df = _minimal_frame(timestamp=["not-a-date", "also-not", "no", "no"])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("timestamp", str(ctx.exception))


class VoltageCapabilitiesTests(unittest.TestCase):
    """Spec 040.4: the bounded voltage-role capability representation."""

    def test_default_is_two_electrode_and_bounded(self):
        result = canonical_cycling.voltage_capabilities()
        self.assertEqual(
            result["capabilities"],
            {"primary_voltage": True, "working_potential": False, "counter_potential": False},
        )
        self.assertEqual(result["voltage_roles"], {"voltage_v": "cell"})
        self.assertIsNone(result["reference_electrode"])
        self.assertFalse(result["voltage_v_derived"])

    def test_three_electrode_capability_only_names_present_channels(self):
        result = canonical_cycling.voltage_capabilities(
            working_potential_available=True,
            counter_potential_available=True,
            reference_electrode="Li/Li+",
            voltage_derived=True,
        )
        self.assertEqual(
            result["capabilities"],
            {"primary_voltage": True, "working_potential": True, "counter_potential": True},
        )
        self.assertEqual(
            result["voltage_roles"],
            {
                "voltage_v": "cell",
                "working_potential_v": "working_vs_reference",
                "counter_potential_v": "counter_vs_reference",
            },
        )
        self.assertEqual(result["reference_electrode"], "Li/Li+")
        self.assertTrue(result["voltage_v_derived"])

    def test_one_electrode_available_does_not_invent_the_other(self):
        result = canonical_cycling.voltage_capabilities(working_potential_available=True)
        self.assertTrue(result["capabilities"]["working_potential"])
        self.assertFalse(result["capabilities"]["counter_potential"])
        self.assertIn("working_potential_v", result["voltage_roles"])
        self.assertNotIn("counter_potential_v", result["voltage_roles"])

    def test_voltage_quantities_map_to_locked_canonical_names(self):
        self.assertEqual(
            canonical_cycling.VOLTAGE_QUANTITIES,
            {
                "voltage": "voltage_v",
                "working_potential": "working_potential_v",
                "counter_potential": "counter_potential_v",
            },
        )
        self.assertEqual(canonical_cycling.DEFAULT_VOLTAGE_QUANTITY, "voltage")

    def test_quantity_label_defaults_and_role_override(self):
        self.assertEqual(canonical_cycling.voltage_quantity_label("voltage"), "Cell voltage (V)")
        self.assertEqual(
            canonical_cycling.voltage_quantity_label("working_potential"),
            "Working potential vs ref (V)",
        )
        self.assertEqual(
            canonical_cycling.voltage_quantity_label("counter_potential"),
            "Counter potential vs ref (V)",
        )


class MalformedValueTests(unittest.TestCase):
    """Case 9: malformed/non-numeric capacity/current/voltage values fail
    clearly."""

    def test_non_numeric_voltage_fails(self):
        df = _minimal_frame(voltage_v=["bad", 3.6, 3.6, 3.5])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("voltage_v", str(ctx.exception))

    def test_non_numeric_current_fails(self):
        df = _minimal_frame(current_ma=["bad", 100.0, -100.0, -100.0])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("current_ma", str(ctx.exception))

    def test_non_numeric_capacity_fails(self):
        df = _minimal_frame(charge_capacity_mah=["bad", 0.1, 0.1, 0.1])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("charge_capacity_mah", str(ctx.exception))

    def test_negative_capacity_fails(self):
        df = _minimal_frame(charge_capacity_mah=[0.0, -0.1, 0.1, 0.1])
        with self.assertRaises(CanonicalCyclingError) as ctx:
            validate_raw_timeseries(df)
        self.assertIn("charge_capacity_mah", str(ctx.exception))

    def test_infinite_voltage_fails(self):
        df = _minimal_frame(voltage_v=[float("inf"), 3.6, 3.6, 3.5])
        with self.assertRaises(CanonicalCyclingError):
            validate_raw_timeseries(df)


_GOLDEN_SOURCES_DIR = ROOT / "tests" / "fixtures" / "golden_analysis" / "sources"


class BinaryParserOutputTests(unittest.TestCase):
    """Case 10: current real/synthetic Neware binary parser output satisfies
    validation."""

    def test_golden_binary_sources_satisfy_validation(self):
        paths = sorted(_GOLDEN_SOURCES_DIR.glob("*.ndax"))
        if not paths:
            self.skipTest("no golden .ndax fixtures present")
        for path in paths:
            with self.subTest(file=path.name):
                df = parsing.parse_timeseries(path)
                validate_raw_timeseries(df)

    def test_current_sign_convention_is_positive_charge_negative_discharge(self):
        """Locks the observed convention documented in
        docs/agent-knowledge/canonical-cycling-data.md point 4."""
        path = _GOLDEN_SOURCES_DIR / "cycles_time_steps.ndax"
        if not path.exists():
            self.skipTest("golden cycles_time_steps.ndax fixture not present")
        df = parsing.parse_timeseries(path)
        means = df.groupby("status")["current_ma"].mean()
        self.assertGreater(means["CC_Chg"], 0.0)
        self.assertGreater(means["CCCV_Chg"], 0.0)
        self.assertLess(means["CC_DChg"], 0.0)
        self.assertEqual(means["Rest"], 0.0)


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


def _write_minimal_excel_workbook(path: Path) -> None:
    """A compact structured Neware-shaped workbook (Spec 039 style), no
    private source data: two cycles, each Rest -> CC Chg -> CC DChg."""
    base = datetime(2026, 1, 1, 12, 0, 0)
    segments = [
        (1, 1, "Rest", [0.0, 1.0], [3.50, 3.50], 0.0, 0.0),
        (1, 2, "CC Chg", [0.0, 1.0, 2.0], [3.50, 3.60, 3.70], 1.0, 0.0),
        (1, 3, "CC DChg", [0.0, 1.0, 2.0], [3.70, 3.20, 3.00], 0.0, 1.5),
        (2, 1, "Rest", [0.0, 1.0], [3.00, 3.00], 0.0, 0.0),
        (2, 2, "CC Chg", [0.0, 1.0, 2.0], [3.00, 3.40, 3.70], 1.0, 0.0),
        (2, 3, "CC DChg", [0.0, 1.0, 2.0], [3.70, 3.30, 3.00], 0.0, 1.2),
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


class ExcelParserOutputTests(unittest.TestCase):
    """Case 11: Parent 039 generated Excel parser output satisfies
    validation."""

    def test_synthetic_excel_workbook_satisfies_validation(self):
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "synthetic.xlsx"
            _write_minimal_excel_workbook(path)
            df = parsing.parse_timeseries(path)  # already validated internally
            validate_raw_timeseries(df)  # explicit, independent re-check
            means = df.groupby("status")["current_ma"].mean()
            self.assertGreater(means["CC_Chg"], 0.0)
            self.assertLess(means["CC_DChg"], 0.0)


class NoMutationAndNoNumericalChangeTests(unittest.TestCase):
    """Case 12: existing `calc.per_cycle` numerical output before/after
    validator insertion is identical for representative fixtures.

    The validator is only ever an assertion — it takes no branch that writes
    back to `df`. This proves that empirically: validating a frame leaves it
    byte-identical, and `calc.per_cycle`'s output does not depend on whether
    validation ran first.
    """

    def test_validation_does_not_mutate_the_frame(self):
        paths = sorted(_GOLDEN_SOURCES_DIR.glob("*.ndax"))
        if not paths:
            self.skipTest("no golden .ndax fixtures present")
        for path in paths[:1]:
            df = parsing.parse_timeseries(path)
            before = df.copy(deep=True)
            validate_raw_timeseries(df)
            pd.testing.assert_frame_equal(df, before)

    def test_per_cycle_output_identical_with_and_without_validation(self):
        paths = sorted(_GOLDEN_SOURCES_DIR.glob("*.ndax"))
        if not paths:
            self.skipTest("no golden .ndax fixtures present")
        for path in paths:
            with self.subTest(file=path.name):
                raw = parsing.parse_timeseries(path)
                cycles_without_prior_validation = calc.per_cycle(raw.copy(deep=True))
                validated = raw.copy(deep=True)
                validate_raw_timeseries(validated)
                cycles_after_validation = calc.per_cycle(validated)
                pd.testing.assert_frame_equal(
                    cycles_without_prior_validation, cycles_after_validation
                )


class CacheBuildBoundaryWiringTests(unittest.TestCase):
    """Validation runs at the full-parse / cache-build boundary
    (`cache.build` / `cache.build_write_behind`), not inside
    `parsing.parse_timeseries` itself — existing dispatch-mechanics tests in
    `tests/test_neware_excel.py` call `parsing.parse_timeseries` directly
    with deliberately minimal/mocked frames, so validating there would
    reject already-passing tests that are not exercising the canonical
    contract at all.
    """

    HASH = "c0ffee00" + "2" * 56

    def setUp(self):
        self._orig = parsing.parse_timeseries
        directory = cache.raw_path(self.HASH).parent
        if directory.exists():
            shutil.rmtree(directory)

    def tearDown(self):
        cache.wait_for_pending(self.HASH)
        parsing.parse_timeseries = self._orig
        directory = cache.raw_path(self.HASH).parent
        if directory.exists():
            shutil.rmtree(directory)

    def test_build_rejects_a_frame_that_violates_the_canonical_contract(self):
        parsing.parse_timeseries = lambda path: _minimal_frame(record_index=[0, 0, 2, 3])
        with self.assertRaises(CanonicalCyclingError):
            cache.build(self.HASH, "unused.ndax")
        # Nothing should have been written for a frame that failed validation.
        self.assertFalse(cache.raw_path(self.HASH).exists())

    def test_build_write_behind_rejects_a_frame_that_violates_the_canonical_contract(self):
        parsing.parse_timeseries = lambda path: _minimal_frame(record_index=[0, 0, 2, 3])
        with self.assertRaises(CanonicalCyclingError):
            cache.build_write_behind(self.HASH, "unused.ndax")

    def test_build_accepts_a_conforming_frame(self):
        parsing.parse_timeseries = lambda path: _minimal_frame()
        info = cache.build(self.HASH, "unused.ndax")
        self.assertFalse(info["cached"])
        self.assertTrue(cache.raw_path(self.HASH, info["parser_version"]).exists())


def _three_electrode_frame() -> pd.DataFrame:
    """A synthetic three-electrode canonical frame (Spec 040.4): known
    working/counter potentials with voltage_v = working - counter, proving
    the multi-voltage path end to end without a real BioLogic parser."""
    working = pd.Series([3.10, 3.20, 3.15, 3.05])
    counter = pd.Series([0.10, 0.10, 0.12, 0.11])
    return _minimal_frame(
        working_potential_v=working.tolist(),
        counter_potential_v=counter.tolist(),
        voltage_v=(working - counter).tolist(),
    )


class MultiVoltagePathCacheTests(unittest.TestCase):
    """Spec 040.4 cases 1-3: a synthetic canonical raw cache preserves both
    auxiliary potentials exactly, a selective raw-column load returns them,
    and cache identity is unaffected by whether they are present."""

    HASH = "c0ffee00" + "4" * 56
    TWO_ELECTRODE_HASH = "c0ffee00" + "5" * 56

    def setUp(self):
        self._orig = parsing.parse_timeseries
        for file_hash in (self.HASH, self.TWO_ELECTRODE_HASH):
            directory = cache.raw_path(file_hash).parent
            if directory.exists():
                shutil.rmtree(directory)

    def tearDown(self):
        parsing.parse_timeseries = self._orig
        for file_hash in (self.HASH, self.TWO_ELECTRODE_HASH):
            cache.wait_for_pending(file_hash)
            directory = cache.raw_path(file_hash).parent
            if directory.exists():
                shutil.rmtree(directory)

    def test_three_electrode_frame_passes_validation(self):
        validate_raw_timeseries(_three_electrode_frame())  # must not raise

    def test_cache_build_preserves_aux_voltage_columns_exactly(self):
        frame = _three_electrode_frame()
        parsing.parse_timeseries = lambda path: frame
        info = cache.build(self.HASH, "unused.ndax")

        loaded = cache.load_raw(self.HASH, info["parser_version"])
        self.assertIsNotNone(loaded)
        pd.testing.assert_series_equal(
            loaded["working_potential_v"], frame["working_potential_v"], check_names=False
        )
        pd.testing.assert_series_equal(
            loaded["counter_potential_v"], frame["counter_potential_v"], check_names=False
        )
        pd.testing.assert_series_equal(loaded["voltage_v"], frame["voltage_v"], check_names=False)

    def test_selective_raw_column_load_returns_aux_voltage_columns(self):
        parsing.parse_timeseries = lambda path: _three_electrode_frame()
        info = cache.build(self.HASH, "unused.ndax")

        selected = cache.load_raw_columns(
            self.HASH, info["parser_version"], ["working_potential_v", "counter_potential_v"]
        )
        self.assertIsNotNone(selected)
        self.assertEqual(set(selected.columns), {"working_potential_v", "counter_potential_v"})
        self.assertEqual(len(selected), 4)

    def test_cache_identity_unaffected_by_optional_column_presence(self):
        """A source with the aux columns and a source without them, both
        recognized as the same format/extension, must resolve to the exact
        same parser identity — the identity is a static per-format fact
        (Spec 040.3), never a function of which optional columns a
        particular parse happened to produce."""
        parsing.parse_timeseries = lambda path: _three_electrode_frame()
        three_electrode_info = cache.build(self.HASH, "three.ndax")

        parsing.parse_timeseries = lambda path: _minimal_frame()
        two_electrode_info = cache.build(self.TWO_ELECTRODE_HASH, "two.ndax")

        self.assertEqual(three_electrode_info["parser_version"], two_electrode_info["parser_version"])


if __name__ == "__main__":
    unittest.main()
