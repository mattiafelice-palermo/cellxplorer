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
        return raw_frame()

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

    def setUp(self):
        self.calls = 0
        self._orig = parsing.parse_timeseries
        parsing.parse_timeseries = self._counting_parse
        d = cache.raw_path(self.HASH).parent
        if d.exists():
            shutil.rmtree(d)

    def tearDown(self):
        cache.wait_for_pending(self.HASH)
        parsing.parse_timeseries = self._orig
        d = cache.raw_path(self.HASH).parent
        if d.exists():
            shutil.rmtree(d)

    def _counting_parse(self, path):
        self.calls += 1
        return raw_frame()

    def test_returns_cycles_immediately_and_writes_behind(self):
        cycles = cache.build_write_behind(self.HASH, "unused.ndax")
        self.assertEqual(list(cycles["cycle"]), [1, 2])
        self.assertEqual(self.calls, 1)
        # a subsequent build() must wait for the background write, then
        # find complete caches and skip the parse
        info = cache.build(self.HASH, "unused.ndax")
        self.assertTrue(info["cached"])
        self.assertEqual(self.calls, 1)
        self.assertTrue(cache.raw_path(self.HASH).exists())
        self.assertTrue(cache.cycles_path(self.HASH).exists())
        # no stray temp files
        leftovers = list(cache.raw_path(self.HASH).parent.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

    def test_second_call_uses_existing_cache(self):
        cache.build_write_behind(self.HASH, "unused.ndax")
        cache.wait_for_pending(self.HASH)
        cycles = cache.build_write_behind(self.HASH, "unused.ndax")
        self.assertEqual(self.calls, 1)  # no re-parse
        self.assertEqual(list(cycles["cycle"]), [1, 2])


if __name__ == "__main__":
    unittest.main()
