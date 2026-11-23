from backend.app.services.filesystem_cleanup import TemporaryDirectory, remove_tree
import os
import shutil
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

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

    def test_missing_completion_flags_in_mixed_sources_keep_legacy_cycles(self):
        frame = raw_frame(cycle_complete=[np.nan, np.nan, np.nan, False, False])
        out = calc.per_cycle(frame)
        self.assertEqual(list(out["cycle"]), [1])

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
            remove_tree(d)

    def tearDown(self):
        parsing.parse_timeseries = self._orig
        d = cache.raw_path(self.HASH).parent
        if d.exists():
            remove_tree(d)

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
            remove_tree(d)

    def tearDown(self):
        cache.wait_for_pending(self.HASH)
        parsing.parse_timeseries = self._orig
        d = cache.raw_path(self.HASH, self.PARSER_IDENTITY).parent
        if d.exists():
            remove_tree(d)

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

    def test_write_behind_publishes_prepared_cache_without_self_join(self):
        with patch.object(cache.logger, "exception") as log_exception:
            cache.build_write_behind(self.HASH, "unused.ndax")
            cache.wait_for_pending(self.HASH)

        log_exception.assert_not_called()
        self.assertTrue(cache.raw_path(self.HASH, self.PARSER_IDENTITY).exists())
        self.assertTrue(cache.cycles_path(self.HASH, self.PARSER_IDENTITY).exists())
        self.assertTrue(cache.raw_index_path(self.HASH, self.PARSER_IDENTITY).exists())
        self.assertTrue(
            cache.time_capacity_derived_path(self.HASH, self.PARSER_IDENTITY).exists()
        )
        self.assertTrue(
            cache.time_capacity_derived_index_path(self.HASH, self.PARSER_IDENTITY).exists()
        )
        self.assertEqual(self.calls, 1)

    def test_second_call_uses_existing_cache(self):
        cache.build_write_behind(self.HASH, "unused.ndax")
        cache.wait_for_pending(self.HASH)
        cycles = cache.build_write_behind(self.HASH, "unused.ndax")
        self.assertEqual(self.calls, 1)  # no re-parse
        self.assertEqual(list(cycles["cycle"]), [1, 2])


class SharedCacheBuildTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(TemporaryDirectory()))
        self.enterContext(patch.object(cache, "CACHE_DIR", self.directory / "cache"))
        self.picker = self.directory / "picker.ndax"
        self.preview = self.directory / "preview.ndax"
        for path in (self.picker, self.preview):
            path.write_bytes(b"same source")
        self.fingerprint = parsing.capture_source_fingerprint(self.preview)
        self.key = self.fingerprint.hash
        self.frame = _canonical_cache_test_frame()
        self.expected_cycles = calc.per_cycle(self.frame)
        self.joined = threading.Event()
        original = cache._start_cache_build

        def observe_join(*args, **kwargs):
            result = original(*args, **kwargs)
            if not result[1]:
                self.joined.set()
            return result

        self.enterContext(patch.object(cache, "_start_cache_build", side_effect=observe_join))

    def preview_cycles(self):
        return cache.build_write_behind(self.key, self.preview, expected_fingerprint=self.fingerprint)

    def assert_shared_import(self, picker_first):
        parsing_started = threading.Event()
        release_parse = threading.Event()
        publishing = threading.Event()
        release = threading.Event()
        original = cache._publish_optimized_raw

        def read(_path):
            parsing_started.set()
            self.assertTrue(release_parse.wait(10))
            return self.frame

        def publish(*args):
            publishing.set()
            self.assertTrue(release.wait(10))
            return original(*args)

        with (
            patch.object(parsing, "parse_timeseries", side_effect=read) as parse,
            patch.object(parsing, "compute_hash", wraps=parsing.compute_hash) as checksum,
            patch.object(calc, "per_cycle", wraps=calc.per_cycle) as derive,
            patch.object(cache, "_publish_optimized_raw", side_effect=publish) as writer,
            patch.object(cache, "_write_atomic", wraps=cache._write_atomic) as writes,
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            try:
                if picker_first:
                    self.assertEqual(cache.schedule_build(self.key, self.picker)["status"], "started")
                else:
                    preview = pool.submit(self.preview_cycles)
                self.assertTrue(parsing_started.wait(10))
                if picker_first:
                    preview = pool.submit(self.preview_cycles)
                else:
                    self.assertEqual(cache.schedule_build(self.key, self.picker)["status"], "started")
                self.assertTrue(self.joined.wait(10))
                release_parse.set()
                self.assertTrue(publishing.wait(10))
                cycles = preview.result(timeout=10)
                pd.testing.assert_frame_equal(cycles, self.expected_cycles, check_exact=True)
                cycles.loc[0, "cycle"] = 99
                waiter = pool.submit(cache.wait_for_pending, self.key)
                with self.assertRaises(TimeoutError):
                    waiter.result(timeout=.05)
                self.assertCountEqual([call.args[0] for call in checksum.call_args_list], [self.preview, self.picker])
            finally:
                release_parse.set()
                release.set()
                cache.wait_for_pending(self.key)

            info = cache.build(self.key, self.preview, expected_fingerprint=self.fingerprint)
            self.assertTrue(info["cached"])
            self.assertEqual(checksum.call_count, 3)
            parse.assert_called_once()
            derive.assert_called_once()
            writer.assert_called_once()
            self.assertEqual(sum(call.args[1].name.startswith("cycles__") for call in writes.call_args_list), 1)
            pd.testing.assert_frame_equal(cache.load_cycles(self.key, info["parser_version"], cache.CALC_VERSION),
                                          self.expected_cycles, check_exact=True)
            self.assertTrue(cache.time_capacity_derived_path(self.key, info["parser_version"]).is_file())

    def test_picker_first_serves_preview_before_publication(self):
        self.assert_shared_import(picker_first=True)

    def test_preview_first_serves_picker_and_registration(self):
        self.assert_shared_import(picker_first=False)

    def test_joining_preview_checks_its_own_path_before_and_after_waiting(self):
        entered = threading.Event()
        release = threading.Event()

        def parse(_path):
            entered.set()
            self.assertTrue(release.wait(10))
            return self.frame

        with patch.object(parsing, "parse_timeseries", side_effect=parse) as reader, ThreadPoolExecutor(2) as pool:
            owner = pool.submit(cache.build, self.key, self.picker)
            try:
                self.assertTrue(entered.wait(10))
                changed = self.directory / "different.ndax"
                changed.write_bytes(b"other bytes")
                with self.assertRaisesRegex(cache.SourceChangedDuringBuild, "hash"):
                    cache.build_write_behind(self.key, changed)
                with self.assertRaisesRegex(cache.SourceChangedDuringBuild, "missing"):
                    cache.build_write_behind(self.key, self.directory / "missing.ndax")
                preview = pool.submit(self.preview_cycles)
                self.assertTrue(self.joined.wait(10))
                self.preview.write_bytes(b"changed while preview waited")
            finally:
                release.set()
            with self.assertRaises(cache.SourceChangedDuringBuild):
                preview.result(timeout=10)
            self.assertFalse(owner.result(timeout=10)["cached"])
            reader.assert_called_once()

    def test_failed_publication_releases_joiners_and_can_be_retried(self):
        writing = threading.Event()
        release = threading.Event()
        original = cache._write_atomic

        def fail_cycles(frame, path):
            if path.name.startswith("cycles__"):
                writing.set()
                self.assertTrue(release.wait(10))
                raise OSError("cycle write interrupted")
            original(frame, path)

        with patch.object(parsing, "parse_timeseries", return_value=self.frame) as parse:
            with patch.object(cache, "_write_atomic", side_effect=fail_cycles), ThreadPoolExecutor(1) as pool:
                self.preview_cycles()
                try:
                    self.assertTrue(writing.wait(10))
                    durable = pool.submit(cache.build, self.key, self.picker)
                    self.assertTrue(self.joined.wait(10))
                finally:
                    release.set()
                with self.assertRaisesRegex(OSError, "cycle write interrupted"):
                    durable.result(timeout=10)
            self.assertNotIn(self.key, cache.pending_hashes())
            self.assertFalse(cache.raw_path(self.key, parsing.parser_identity(self.picker)).exists())
            self.assertFalse(cache.build(self.key, self.picker)["cached"])
            self.assertEqual(parse.call_count, 2)

    def test_parse_error_reaches_preview_and_durable_waiter_before_retry(self):
        entered = threading.Event()
        release = threading.Event()

        def fail(_path):
            entered.set()
            self.assertTrue(release.wait(10))
            raise ValueError("invalid measurement")

        with patch.object(parsing, "parse_timeseries", side_effect=fail) as parse, ThreadPoolExecutor(2) as pool:
            preview = pool.submit(self.preview_cycles)
            try:
                self.assertTrue(entered.wait(10))
                durable = pool.submit(cache.build, self.key, self.picker)
                self.assertTrue(self.joined.wait(10))
            finally:
                release.set()
            for result in (preview, durable):
                with self.assertRaisesRegex(ValueError, "invalid measurement"):
                    result.result(timeout=10)
            parse.assert_called_once()
        with patch.object(parsing, "parse_timeseries", return_value=self.frame):
            self.assertFalse(cache.build(self.key, self.picker)["cached"])

    def test_late_optional_request_prepares_from_published_raw(self):
        skipped = threading.Event()
        release = threading.Event()
        prepare = cache._CacheBuild.prepare_derived

        def observe_skip(work, *args):
            prepare(work, *args)
            if work.skipped_time_capacity:
                skipped.set()
                self.assertTrue(release.wait(10))

        with (
            patch.object(parsing, "parse_timeseries", return_value=self.frame) as parse,
            patch.object(cache._CacheBuild, "prepare_derived", observe_skip),
            ThreadPoolExecutor(2) as pool,
        ):
            base = pool.submit(cache.build, self.key, self.picker, prepare_time_capacity=False)
            try:
                self.assertTrue(skipped.wait(10))
                preview = pool.submit(self.preview_cycles)
                with self.assertRaises(TimeoutError):
                    preview.result(timeout=.05)
            finally:
                release.set()
            info = base.result(timeout=10)
            pd.testing.assert_frame_equal(preview.result(timeout=10), self.expected_cycles, check_exact=True)
            cache.wait_for_pending(self.key)
            parse.assert_called_once()
            self.assertTrue(cache.time_capacity_derived_path(self.key, info["parser_version"]).is_file())

    def test_forced_rebuild_waits_then_reparses(self):
        first_write = threading.Event()
        release = threading.Event()
        original = cache._publish_optimized_raw

        def publish(*args):
            first_write.set()
            self.assertTrue(release.wait(10))
            return original(*args)

        with (
            patch.object(parsing, "parse_timeseries", return_value=self.frame) as parse,
            patch.object(cache, "_publish_optimized_raw", side_effect=publish),
            ThreadPoolExecutor(1) as pool,
        ):
            self.preview_cycles()
            try:
                self.assertTrue(first_write.wait(10))
                forced = pool.submit(cache.build, self.key, self.picker, force=True)
                with self.assertRaises(TimeoutError):
                    forced.result(timeout=.05)
                parse.assert_called_once()
            finally:
                release.set()
            self.assertFalse(forced.result(timeout=10)["cached"])
            self.assertEqual(parse.call_count, 2)

    def test_process_handoff_waits_while_picker_verifies_source(self):
        hashing = threading.Event()
        release = threading.Event()
        original = parsing.compute_hash

        def checksum(path):
            hashing.set()
            self.assertTrue(release.wait(10))
            return original(path)

        with (
            patch.object(parsing, "compute_hash", side_effect=checksum),
            patch.object(parsing, "parse_timeseries", return_value=self.frame),
            ThreadPoolExecutor(1) as pool,
        ):
            cache.schedule_build(self.key, self.picker)
            try:
                self.assertTrue(hashing.wait(10))
                handoff = pool.submit(cache.wait_for_pending, self.key)
                with self.assertRaises(TimeoutError):
                    handoff.result(timeout=.05)
            finally:
                release.set()
            handoff.result(timeout=10)
            self.assertTrue(cache.cycles_path(self.key, parsing.parser_identity(self.picker)).is_file())


class CacheSourceSafetyTests(unittest.TestCase):
    def test_expected_hash_mismatch_is_rejected_before_parse(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "mismatch.ndax"
            source.write_bytes(b"stable")
            fingerprint = parsing.capture_source_fingerprint(source)
            wrong = parsing.SourceFingerprint(
                "0" * 64,
                fingerprint.size,
                fingerprint.mtime_ns,
            )
            with patch.object(parsing, "parse_timeseries") as parse:
                with self.assertRaises(cache.SourceChangedDuringBuild):
                    cache.build(fingerprint.hash, source, expected_fingerprint=wrong)
            parse.assert_not_called()

    def test_cache_build_hashes_once_then_uses_stat_only_guards(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "one-digest.ndax"
            source.write_bytes(b"cache source")
            fingerprint = parsing.capture_source_fingerprint(source)
            original_hash = parsing.compute_hash
            with patch.object(cache, "CACHE_DIR", Path(temp) / "cache"), \
                patch.object(parsing, "compute_hash", wraps=original_hash) as digest, \
                patch.object(
                    parsing,
                    "parse_timeseries",
                    return_value=_canonical_cache_test_frame(),
                ):
                cache.build(
                    fingerprint.hash,
                    source,
                    expected_fingerprint=fingerprint,
                )

        self.assertEqual(digest.call_count, 1)

    def test_moving_source_is_rejected_before_new_cache_is_published(self):
        file_hash = "feedface" + "2" * 56
        cache_directory = cache.raw_path(file_hash).parent
        if cache_directory.exists():
            remove_tree(cache_directory)
        try:
            with TemporaryDirectory() as temp:
                source = Path(temp) / "moving.ndax"
                source.write_bytes(b"stable")

                def parse_and_change(_path):
                    source.write_bytes(b"changed-source")
                    return _canonical_cache_test_frame()

                with patch.object(parsing, "parse_timeseries", side_effect=parse_and_change):
                    with self.assertRaises(cache.SourceChangedDuringBuild):
                        cache.build(file_hash, source)
            self.assertFalse(cache.raw_path(file_hash).exists())
            self.assertFalse(cache.cycles_path(file_hash).exists())
        finally:
            if cache_directory.exists():
                remove_tree(cache_directory)

    def test_source_change_after_atomic_write_removes_new_outputs(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "after-write.ndax"
            source.write_bytes(b"stable")
            fingerprint = parsing.capture_source_fingerprint(source)
            file_hash = fingerprint.hash
            parser_identity = parsing.parser_identity(source)
            cache_directory = cache.raw_path(file_hash, parser_identity).parent
            if cache_directory.exists():
                remove_tree(cache_directory)

            original_write = cache._write_atomic

            def write_then_change(frame, target):
                original_write(frame, target)
                if target.name.startswith("cycles__"):
                    source.write_bytes(b"changed-after-write")

            try:
                with patch.object(parsing, "parse_timeseries", return_value=_canonical_cache_test_frame()), \
                    patch.object(cache, "_write_atomic", side_effect=write_then_change):
                    with self.assertRaises(cache.SourceChangedDuringBuild):
                        cache.build(file_hash, source, expected_fingerprint=fingerprint)
                self.assertFalse(cache.raw_path(file_hash, parser_identity).exists())
                self.assertFalse(cache.cycles_path(file_hash, parser_identity).exists())
            finally:
                if cache_directory.exists():
                    remove_tree(cache_directory)


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
