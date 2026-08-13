import os
import shutil
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import cache, calc, parsing


def raw_frame(**overrides):
    base = {
        "cycle": [1, 1, 1, 2, 2],
        "status": ["CC_Chg", "CC_Chg", "CC_DChg", "CCCV_Chg", "CC_DChg"],
        "charge_capacity_mah": [1.0, 2.0, 2.0, 1.9, 1.9],
        "discharge_capacity_mah": [0.0, 0.0, 1.8, 0.0, 1.7],
        "charge_energy_mwh": [3.0, 6.0, 6.0, 5.9, 5.9],
        "discharge_energy_mwh": [0.0, 0.0, 5.5, 0.0, 5.2],
        "voltage_v": [3.0, 3.4, 3.1, 3.5, 3.0],
        "timestamp": pd.to_datetime(
            ["2026-01-01 00:00", "2026-01-01 01:00", "2026-01-01 02:00",
             "2026-01-01 03:00", "2026-01-01 04:00"]
        ),
    }
    base.update(overrides)
    return pd.DataFrame(base)


class PerCycleTests(unittest.TestCase):
    def test_basic_aggregation(self):
        out = calc.per_cycle(raw_frame())
        self.assertEqual(list(out.columns), calc.CYCLE_COLUMNS)
        self.assertEqual(list(out["cycle"]), [1, 2])
        self.assertEqual(list(out["charge_capacity_mah"]), [2.0, 1.9])
        self.assertEqual(list(out["discharge_capacity_mah"]), [1.8, 1.7])
        np.testing.assert_allclose(out["coulombic_efficiency_pct"], [90.0, 1.7 / 1.9 * 100])
        # mean charge voltage over the Chg rows only
        np.testing.assert_allclose(out["mean_charge_voltage_v"], [3.2, 3.5])
        np.testing.assert_allclose(out["mean_discharge_voltage_v"], [3.1, 3.0])
        self.assertEqual(out["start_timestamp"].iloc[0], pd.Timestamp("2026-01-01 00:00"))

    def test_charge_and_discharge_voltage_endpoints(self):
        out = calc.per_cycle(raw_frame())
        np.testing.assert_allclose(out["first_charge_voltage_v"], [3.0, 3.5])
        np.testing.assert_allclose(out["last_charge_voltage_v"], [3.4, 3.5])
        np.testing.assert_allclose(out["first_discharge_voltage_v"], [3.1, 3.0])
        np.testing.assert_allclose(out["last_discharge_voltage_v"], [3.1, 3.0])

    def test_zero_charge_capacity_gives_nan_efficiency(self):
        df = raw_frame(charge_capacity_mah=[0.0] * 5, charge_energy_mwh=[0.0] * 5)
        out = calc.per_cycle(df)
        self.assertTrue(out["coulombic_efficiency_pct"].isna().all())
        self.assertTrue(out["energy_efficiency_pct"].isna().all())

    def test_no_status_column(self):
        df = raw_frame().drop(columns=["status"])
        out = calc.per_cycle(df)
        self.assertTrue(out["mean_charge_voltage_v"].isna().all())
        self.assertTrue(out["mean_discharge_voltage_v"].isna().all())
        self.assertEqual(list(out["charge_capacity_mah"]), [2.0, 1.9])

    def test_no_timestamp_column(self):
        df = raw_frame().drop(columns=["timestamp"])
        out = calc.per_cycle(df)
        self.assertTrue(out["start_timestamp"].isna().all())

    def test_empty_frame(self):
        out = calc.per_cycle(pd.DataFrame())
        self.assertTrue(out.empty)
        self.assertEqual(list(out.columns), calc.CYCLE_COLUMNS)

    def test_cycle_with_only_rest(self):
        df = raw_frame(status=["Rest"] * 5)
        out = calc.per_cycle(df)
        self.assertTrue(out["mean_charge_voltage_v"].isna().all())


def stepped_frame(charge_steps, discharge=2.546):
    """One cycle whose charge spans several steps, each restarting the counter.

    Mirrors real Neware data: capacity and energy accumulate inside a step and
    reset to 0 at the next one.
    """
    rows = []
    step = 1
    for total in charge_steps:
        for fraction in (0.0, 0.5, 1.0):
            rows.append(
                {
                    "cycle": 1,
                    "step": step,
                    "status": "CC_Chg" if step == 1 else "CV_Chg",
                    "charge_capacity_mah": total * fraction,
                    "discharge_capacity_mah": 0.0,
                    "charge_energy_mwh": total * fraction * 3.6,
                    "discharge_energy_mwh": 0.0,
                    "voltage_v": 3.6,
                }
            )
        step += 1
    for fraction in (0.0, 0.5, 1.0):
        rows.append(
            {
                "cycle": 1,
                "step": step,
                "status": "CC_DChg",
                "charge_capacity_mah": 0.0,
                "discharge_capacity_mah": discharge * fraction,
                "charge_energy_mwh": 0.0,
                "discharge_energy_mwh": discharge * fraction * 3.4,
                "voltage_v": 3.4,
            }
        )
    return pd.DataFrame(rows)


class StepResetCapacityTests(unittest.TestCase):
    """Neware's counters reset each step, so a phase total is a sum of steps.

    A per-cycle maximum kept only the largest step: a CC+CV charge silently
    lost its CV portion, which inflated coulombic efficiency past 100%.
    """

    def test_cc_plus_cv_charge_sums_both_steps(self):
        out = calc.per_cycle(stepped_frame([2.551021, 0.181603]))
        np.testing.assert_allclose(out["charge_capacity_mah"], [2.732624], rtol=1e-6)
        np.testing.assert_allclose(out["discharge_capacity_mah"], [2.546], rtol=1e-6)
        # 2.546 / 2.7326 = 93.2%, not the 99.8% a per-cycle max produced.
        np.testing.assert_allclose(
            out["coulombic_efficiency_pct"], [2.546 / 2.732624 * 100], rtol=1e-6
        )

    def test_evenly_split_charge_does_not_report_100_percent(self):
        # The pathological real case: two equal charge steps halved the total.
        out = calc.per_cycle(stepped_frame([0.632768, 0.632524], discharge=1.055))
        np.testing.assert_allclose(out["charge_capacity_mah"], [1.265292], rtol=1e-6)
        ce = float(out["coulombic_efficiency_pct"].iloc[0])
        self.assertAlmostEqual(ce, 1.055 / 1.265292 * 100, places=6)
        self.assertLess(ce, 90.0)

    def test_energy_is_summed_per_step_too(self):
        out = calc.per_cycle(stepped_frame([2.551021, 0.181603]))
        np.testing.assert_allclose(
            out["charge_energy_mwh"], [2.732624 * 3.6], rtol=1e-6
        )
        np.testing.assert_allclose(
            out["energy_efficiency_pct"],
            [(2.546 * 3.4) / (2.732624 * 3.6) * 100],
            rtol=1e-6,
        )

    def test_single_combined_step_is_unchanged(self):
        # A protocol written as one CCCV step never resets mid-charge.
        out = calc.per_cycle(stepped_frame([2.732624]))
        np.testing.assert_allclose(out["charge_capacity_mah"], [2.732624], rtol=1e-6)

    def test_rest_and_opposite_phase_steps_contribute_nothing(self):
        df = stepped_frame([2.551021, 0.181603])
        rest = df.iloc[:3].copy()
        rest["step"] = 99
        rest["status"] = "Rest"
        rest["charge_capacity_mah"] = 0.0
        out = calc.per_cycle(pd.concat([df, rest], ignore_index=True))
        np.testing.assert_allclose(out["charge_capacity_mah"], [2.732624], rtol=1e-6)

    def test_charge_time_is_unaffected(self):
        # Time already summed per step; guard against regressing it.
        df = stepped_frame([2.551021, 0.181603])
        df["time_s"] = [0, 100, 200, 0, 50, 100, 0, 300, 600]
        out = calc.per_cycle(df)
        np.testing.assert_allclose(out["charge_time_h"], [(200 + 100) / 3600.0])
        np.testing.assert_allclose(out["discharge_time_h"], [600 / 3600.0])

    def test_explicit_cv_charge_metrics(self):
        df = pd.DataFrame(
            {
                "cycle": [1] * 6,
                "step": [1, 1, 2, 2, 2, 3],
                "status": ["CC_Chg", "CC_Chg", "CV_Chg", "CV_Chg", "CV_Chg", "CC_DChg"],
                "time_s": [0, 100, 0, 60, 120, 0],
                "voltage_v": [3.5, 4.2, 4.2, 4.2, 4.2, 3.8],
                "current_ma": [2, 2, 1.5, 1.0, 0.5, -2],
                "charge_capacity_mah": [0, 1.0, 0, 0.2, 0.3, 1.3],
                "discharge_capacity_mah": [0, 0, 0, 0, 0, 1.2],
                "charge_energy_mwh": [0, 3.5, 0, 0.8, 1.2, 4.7],
                "discharge_energy_mwh": [0, 0, 0, 0, 0, 4.2],
            }
        )
        out = calc.per_cycle(df)
        self.assertAlmostEqual(out.loc[0, "cv_charge_time_h"], 120 / 3600)
        self.assertAlmostEqual(out.loc[0, "cv_charge_capacity_mah"], 0.3)
        self.assertAlmostEqual(out.loc[0, "cv_charge_fraction_pct"], 0.3 / 1.3 * 100)
        self.assertEqual(out.loc[0, "cv_charge_event_count"], 1)
        self.assertEqual(out.loc[0, "cv_reached"], 1)

    def test_combined_cccv_requires_plateau_and_taper(self):
        df = pd.DataFrame(
            {
                "cycle": [1] * 5,
                "step": [1] * 5,
                "status": ["CCCV_Chg"] * 5,
                "time_s": [0, 60, 120, 180, 240],
                "voltage_v": [3.5, 4.0, 4.199, 4.2, 4.2],
                "current_ma": [2, 2, 2, 1.5, 0.5],
                "charge_capacity_mah": [0, 0.5, 1.0, 1.2, 1.3],
                "discharge_capacity_mah": [0] * 5,
                "charge_energy_mwh": [0, 1, 2, 3, 4],
                "discharge_energy_mwh": [0] * 5,
            }
        )
        out = calc.per_cycle(df)
        self.assertEqual(out.loc[0, "cv_reached"], 1)
        self.assertGreater(out.loc[0, "cv_charge_capacity_mah"], 0)


def _canonical_cache_test_frame():
    """`raw_frame()` plus the canonical columns (Spec 040.1) it omits.

    `raw_frame()` intentionally exercises only the columns `calc.per_cycle`
    reads; the cache-build boundary tests below go through
    `canonical_cycling.validate_raw_timeseries` and need the full required
    shape, without changing the underlying cycle/capacity values those tests
    assert on.
    """
    frame = raw_frame()
    frame["record_index"] = range(len(frame))
    frame["step_index"] = [1, 1, 2, 1, 2]
    frame["step"] = [1, 1, 2, 3, 4]
    frame["time_s"] = [0.0, 1.0, 0.0, 0.0, 0.0]
    frame["current_ma"] = [100.0, 100.0, -100.0, 100.0, -100.0]
    return frame


class CacheBuildIdempotencyTests(unittest.TestCase):
    HASH = "deadbeef" + "0" * 56

    def setUp(self):
        self.calls = 0
        self._orig = parsing.parse_timeseries
        parsing.parse_timeseries = self._counting_parse
        d = cache.raw_path(self.HASH).parent
        if d.exists():
            shutil.rmtree(d)

    def tearDown(self):
        parsing.parse_timeseries = self._orig
        d = cache.raw_path(self.HASH).parent
        if d.exists():
            shutil.rmtree(d)

    def _counting_parse(self, path):
        self.calls += 1
        return _canonical_cache_test_frame()

    def test_build_skips_parse_when_cached(self):
        info1 = cache.build(self.HASH, "unused.ndax")
        self.assertFalse(info1["cached"])
        info2 = cache.build(self.HASH, "unused.ndax")
        self.assertTrue(info2["cached"])
        self.assertEqual(self.calls, 1)
        # identical row/cycle counts from parquet metadata
        self.assertEqual(info1["rows"], info2["rows"])
        self.assertEqual(info1["cycles"], info2["cycles"])

    def test_force_rebuilds(self):
        cache.build(self.HASH, "unused.ndax")
        cache.build(self.HASH, "unused.ndax", force=True)
        self.assertEqual(self.calls, 2)


class WriteBehindTests(unittest.TestCase):
    HASH = "cafebabe" + "1" * 56
    # "unused.ndax" is never actually opened (parse_timeseries is
    # monkeypatched below), but its extension IS used for per-source parser
    # identity resolution (Spec 040.3), which is extension-only for binary
    # Neware and therefore needs no real file on disk.
    PARSER_IDENTITY = parsing.parser_identity("unused.ndax")

    def setUp(self):
        self.calls = 0
        self._orig = parsing.parse_timeseries
        parsing.parse_timeseries = self._counting_parse
        d = cache.raw_path(self.HASH, self.PARSER_IDENTITY).parent
        if d.exists():
            shutil.rmtree(d)

    def tearDown(self):
        cache.wait_for_pending(self.HASH)
        parsing.parse_timeseries = self._orig
        d = cache.raw_path(self.HASH, self.PARSER_IDENTITY).parent
        if d.exists():
            shutil.rmtree(d)

    def _counting_parse(self, path):
        self.calls += 1
        return _canonical_cache_test_frame()

    def test_returns_cycles_immediately_and_writes_behind(self):
        cycles = cache.build_write_behind(self.HASH, "unused.ndax")
        self.assertEqual(list(cycles["cycle"]), [1, 2])
        self.assertEqual(self.calls, 1)
        # a subsequent build() must wait for the background write, then
        # find complete caches and skip the parse
        info = cache.build(self.HASH, "unused.ndax")
        self.assertTrue(info["cached"])
        self.assertEqual(self.calls, 1)
        self.assertEqual(info["parser_version"], self.PARSER_IDENTITY)
        self.assertTrue(cache.raw_path(self.HASH, self.PARSER_IDENTITY).exists())
        self.assertTrue(cache.cycles_path(self.HASH, self.PARSER_IDENTITY).exists())
        # no stray temp files
        leftovers = list(cache.raw_path(self.HASH, self.PARSER_IDENTITY).parent.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

    def test_second_call_uses_existing_cache(self):
        cache.build_write_behind(self.HASH, "unused.ndax")
        cache.wait_for_pending(self.HASH)
        cycles = cache.build_write_behind(self.HASH, "unused.ndax")
        self.assertEqual(self.calls, 1)  # no re-parse
        self.assertEqual(list(cycles["cycle"]), [1, 2])


class CapacityTotalsTests(unittest.TestCase):
    def test_returns_finite_maximum_discharge(self):
        cycles = pd.DataFrame({"discharge_capacity_mah": [1.0, 3.5, 2.0]})
        totals = cache.capacity_totals(cycles)
        self.assertEqual(totals["max_discharge_capacity_mah"], 3.5)

    def test_ignores_nan_discharge_values(self):
        cycles = pd.DataFrame({"discharge_capacity_mah": [1.0, float("nan"), 2.0]})
        totals = cache.capacity_totals(cycles)
        self.assertEqual(totals["max_discharge_capacity_mah"], 2.0)

    def test_no_valid_discharge_values_returns_none(self):
        cycles = pd.DataFrame({"discharge_capacity_mah": [float("nan"), None]})
        totals = cache.capacity_totals(cycles)
        self.assertIsNone(totals["max_discharge_capacity_mah"])

    def test_ignores_infinite_discharge_values(self):
        cycles = pd.DataFrame({"discharge_capacity_mah": [1.0, float("inf"), 3.0]})
        totals = cache.capacity_totals(cycles)
        self.assertEqual(totals["max_discharge_capacity_mah"], 3.0)

    def test_only_invalid_discharge_values_returns_none(self):
        cycles = pd.DataFrame({"discharge_capacity_mah": [float("inf"), float("nan")]})
        totals = cache.capacity_totals(cycles)
        self.assertIsNone(totals["max_discharge_capacity_mah"])


if __name__ == "__main__":
    unittest.main()


class StatusMatchesTests(unittest.TestCase):
    """Spec 028: status predicates evaluated over distinct values, not every row."""

    def reference(self, status, *needles):
        """What the code did before: lower-case every row, then str.contains."""
        lowered = status.astype(str).str.lower()
        mask = pd.Series(False, index=status.index)
        for needle in needles:
            mask = mask | lowered.str.contains(needle)
        return mask.to_numpy()

    def test_matches_the_row_wise_implementation(self):
        status = pd.Series(["CC_Chg", "CV_Chg", "CCCV_Chg", "CC_DChg", "Rest"])
        for needles in [("cv_chg",), ("cv_chg", "cv charge"), ("chg", "charge"), ("cccv",)]:
            with self.subTest(needles=needles):
                np.testing.assert_array_equal(
                    calc.status_matches(status, *needles),
                    self.reference(status, *needles),
                )

    def test_matching_is_case_insensitive(self):
        status = pd.Series(["cv_chg", "CV_CHG", "Cv_ChG"])
        self.assertTrue(calc.status_matches(status, "cv_chg").all())

    def test_a_missing_status_matches_nothing(self):
        # The old code ran .astype(str) first, turning NaN into the string "nan".
        status = pd.Series(["CV_Chg", None, np.nan])
        result = calc.status_matches(status, "cv_chg")
        np.testing.assert_array_equal(result, np.array([True, False, False]))
        np.testing.assert_array_equal(result, self.reference(status, "cv_chg"))

    def test_an_empty_column_returns_an_empty_mask(self):
        result = calc.status_matches(pd.Series([], dtype=object), "cv_chg")
        self.assertEqual(len(result), 0)
        self.assertEqual(result.dtype, bool)

    def test_a_single_repeated_value_is_handled(self):
        status = pd.Series(["Rest"] * 50)
        self.assertFalse(calc.status_matches(status, "cv_chg").any())
        self.assertTrue(calc.status_matches(status, "rest").all())


class CvChargeByCycleTests(unittest.TestCase):
    """Spec 028: the CV walk's decisions, including paths absent from the corpus."""

    def frame(self, rows):
        return pd.DataFrame(rows)

    def test_explicit_cv_step_contributes_its_own_delta(self):
        df = self.frame({
            "cycle": [1, 1, 1],
            "step": [2, 2, 2],
            "status": ["CV_Chg", "CV_Chg", "CV_Chg"],
            "time_s": [0.0, 1800.0, 3600.0],
            "charge_capacity_mah": [0.0, 1.0, 2.0],
            "voltage_v": [4.2, 4.2, 4.2],
            "current_ma": [100.0, 50.0, 10.0],
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        self.assertAlmostEqual(times[0], 1.0)
        self.assertAlmostEqual(caps[0], 2.0)
        self.assertEqual(events[0], 1)

    def test_a_cccv_step_that_tapers_counts_only_the_plateau(self):
        df = self.frame({
            "cycle": [1] * 4,
            "step": [1] * 4,
            "status": ["CCCV_Chg"] * 4,
            "time_s": [0.0, 3600.0, 7200.0, 10800.0],
            "charge_capacity_mah": [0.0, 1.0, 2.0, 3.0],
            # first two rows climb to the plateau, last two sit on it
            "voltage_v": [4.0, 4.1, 4.2, 4.2],
            "current_ma": [100.0, 100.0, 100.0, 10.0],
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        # plateau is rows 2..3 only: 1 h and 1 mAh, not the whole step
        self.assertAlmostEqual(times[0], 1.0)
        self.assertAlmostEqual(caps[0], 1.0)
        self.assertEqual(events[0], 1)

    def test_a_cccv_step_that_never_tapers_contributes_nothing(self):
        df = self.frame({
            "cycle": [1] * 4,
            "step": [1] * 4,
            "status": ["CCCV_Chg"] * 4,
            "time_s": [0.0, 3600.0, 7200.0, 10800.0],
            "charge_capacity_mah": [0.0, 1.0, 2.0, 3.0],
            "voltage_v": [4.2, 4.2, 4.2, 4.2],
            "current_ma": [100.0, 100.0, 100.0, 100.0],  # flat: no CV reached
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        self.assertEqual(list(times), [0.0])
        self.assertEqual(list(caps), [0.0])
        self.assertEqual(list(events), [0.0])

    def test_a_cycle_with_no_cv_at_all_is_zero(self):
        df = self.frame({
            "cycle": [1, 1],
            "step": [1, 1],
            "status": ["CC_Chg", "CC_DChg"],
            "time_s": [0.0, 3600.0],
            "charge_capacity_mah": [0.0, 1.0],
            "voltage_v": [4.0, 3.0],
            "current_ma": [100.0, -100.0],
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        self.assertEqual(list(times), [0.0])
        self.assertEqual(list(events), [0.0])

    def test_frames_without_a_step_column_still_work(self):
        # The corpus always has `step`; the __step fallback would otherwise be
        # exercised by nothing.
        df = self.frame({
            "cycle": [1, 1],
            "status": ["CV_Chg", "CV_Chg"],
            "time_s": [0.0, 3600.0],
            "charge_capacity_mah": [0.0, 2.0],
            "voltage_v": [4.2, 4.2],
            "current_ma": [100.0, 10.0],
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        self.assertAlmostEqual(times[0], 1.0)
        self.assertAlmostEqual(caps[0], 2.0)
        self.assertEqual(events[0], 1)

    def test_two_cv_steps_in_one_cycle_accumulate(self):
        df = self.frame({
            "cycle": [1] * 4,
            "step": [2, 2, 5, 5],
            "status": ["CV_Chg"] * 4,
            "time_s": [0.0, 3600.0, 7200.0, 10800.0],
            "charge_capacity_mah": [0.0, 1.0, 0.0, 2.0],
            "voltage_v": [4.2] * 4,
            "current_ma": [100.0, 10.0, 100.0, 10.0],
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        self.assertAlmostEqual(times[0], 2.0)
        self.assertAlmostEqual(caps[0], 3.0)
        self.assertEqual(events[0], 2)

    def test_cycles_absent_from_the_index_are_ignored(self):
        df = self.frame({
            "cycle": [1, 1, 99, 99],
            "step": [1, 1, 1, 1],
            "status": ["CV_Chg"] * 4,
            "time_s": [0.0, 3600.0, 0.0, 3600.0],
            "charge_capacity_mah": [0.0, 1.0, 0.0, 5.0],
            "voltage_v": [4.2] * 4,
            "current_ma": [100.0, 10.0, 100.0, 10.0],
        })
        times, caps, events = calc._cv_charge_by_cycle(df, pd.Index([1]))
        self.assertEqual(len(caps), 1)
        self.assertAlmostEqual(caps[0], 1.0)
