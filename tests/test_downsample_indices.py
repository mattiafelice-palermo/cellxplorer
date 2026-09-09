"""Exact envelope-index parity against the frozen pre-optimization algorithm."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services.analysis_engine import _downsample_indices


def frozen_downsample_indices(length, max_points, visible, series=None):
    """Independent copy of the original algorithm; do not share production helpers."""
    if length <= max_points:
        return np.arange(length, dtype="int64")
    transitions = np.flatnonzero(visible[1:] != visible[:-1]) + 1
    mandatory = np.array([0, length - 1], dtype="int64")
    if len(transitions):
        mandatory = np.unique(
            np.concatenate((mandatory, np.maximum(0, transitions - 1), transitions))
        )
    usable_series = [
        np.asarray(values, dtype="float64")
        for values in (series or [])
        if len(values) == length and np.isfinite(values).any()
    ]
    if not usable_series:
        usable_series = [np.arange(length, dtype="float64")]
    remaining = max(1, max_points - len(mandatory))
    points_per_bucket = max(2, len(usable_series) * 2) * 3
    bucket_count = max(1, remaining // points_per_bucket)
    edges = np.linspace(0, length, bucket_count + 1).astype("int64")
    selected: set[int] = set(int(value) for value in mandatory)
    for start, end in zip(edges[:-1], edges[1:]):
        if end <= start:
            continue
        for values in usable_series:
            local = values[start:end]
            finite = np.flatnonzero(np.isfinite(local))
            if len(finite) == 0:
                continue
            finite_values = local[finite]
            extrema = (
                int(start + finite[int(np.argmin(finite_values))]),
                int(start + finite[int(np.argmax(finite_values))]),
            )
            for point in extrema:
                selected.update(range(max(0, point - 1), min(length, point + 2)))
    if len(selected) < max_points:
        fill = np.linspace(0, length - 1, max_points - len(selected) + 2).astype("int64")
        selected.update(int(value) for value in fill)
    return np.asarray(sorted(selected), dtype="int64")


class DownsampleIndicesTests(unittest.TestCase):
    def assert_parity(self, length, budget, visible, series=None):
        expected = frozen_downsample_indices(length, budget, visible, series)
        actual = _downsample_indices(length, budget, visible, series)
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.dtype, np.dtype("int64"))
        self.assertTrue(np.all(actual[1:] > actual[:-1]))
        return actual

    def test_small_inputs_and_budget_boundaries(self):
        for length in range(34):
            for budget in (-1, 0, 1, 2, 3, 7, 8, 13, 14, 31, 32, 33, 34):
                with self.subTest(length=length, budget=budget):
                    self.assert_parity(length, budget, np.ones(length, dtype=bool),
                                       [np.arange(length, dtype=float)])

    def test_fallback_and_ignored_series(self):
        length = 401
        for series in (None, [], [np.full(length, np.nan)],
                       [np.full(length, np.inf), np.full(length, -np.inf)],
                       [np.arange(length - 1), np.arange(length + 1)],
                       [np.arange(length - 1), np.zeros(length)]):
            for budget in (0, 7, 42, 101, 400):
                self.assert_parity(length, budget, np.ones(length, dtype=bool), series)

    def test_nonfinite_buckets_and_finite_extreme_limits(self):
        length = 600
        values = np.resize([np.nan, np.inf, -np.inf], length)
        values[150:300] = 0.0
        values[301] = np.finfo(float).max
        values[302] = -np.finfo(float).max
        values[450] = np.nextafter(0.0, 1.0)
        values[451] = -np.nextafter(0.0, 1.0)
        for budget in (1, 26, 49, 50, 100, 201, 599):
            self.assert_parity(length, budget, np.ones(length, dtype=bool), [values])

    def test_ties_signed_zero_and_uniform_fill(self):
        for values in (np.zeros(1000), np.resize([-0.0, 0.0], 1000),
                       np.resize([2., 2., -3., -3., 0., 0.], 1000)):
            for budget in (8, 14, 31, 100, 200, 301, 999):
                self.assert_parity(len(values), budget, np.ones(len(values), dtype=bool),
                                   [values, values[::-1]])
        # One bucket: tied minima/maxima choose the first row, then uniform
        # fill depends on the exact size of that three-point neighbourhood.
        actual = self.assert_parity(100, 8, np.ones(100, dtype=bool), [np.zeros(100)])
        np.testing.assert_array_equal(actual, [0, 1, 16, 33, 49, 66, 82, 99])

    def test_visibility_transitions_exceed_budget(self):
        length = 511
        for visible in (np.zeros(length, dtype=bool), np.arange(length) % 2 == 0,
                        np.arange(length) // 17 % 2 == 0):
            actual = self.assert_parity(length, 13, visible, [np.sin(np.arange(length))])
            transitions = np.flatnonzero(visible[1:] != visible[:-1]) + 1
            self.assertTrue(set(transitions).issubset(actual))
            self.assertTrue(set(transitions - 1).issubset(actual))

    def test_neighbours_across_bucket_boundaries(self):
        values = np.zeros(1000)
        values[[0, 249, 250, 749, 750, 999]] = [5, -9, 10, -10, 9, -5]
        actual = self.assert_parity(1000, 26, np.ones(1000, dtype=bool), [values])
        self.assertTrue({248, 249, 250, 251, 748, 749, 750, 751}.issubset(actual))

    def test_readonly_noncontiguous_and_dtype_conversion(self):
        for dtype in (np.float32, np.float64, np.int64, np.uint64, bool):
            source = np.arange(2048).astype(dtype)
            for values in (source[::2], source[::-2], source[::2].tolist()):
                if isinstance(values, np.ndarray):
                    values.flags.writeable = False
                before = np.asarray(values).tobytes()
                self.assert_parity(1024, 201, np.ones(1024, dtype=bool), [values])
                self.assertEqual(np.asarray(values).tobytes(), before)

    def test_randomized_exact_parity(self):
        rng = np.random.default_rng(20260909)
        for case in range(1200):
            length = int(rng.integers(1, 4097))
            budget = int(rng.integers(0, length + 30))
            visible = np.ones(length, dtype=bool)
            if case % 3 == 0:
                visible = rng.random(length) > .5
            elif case % 3 == 1:
                visible = np.arange(length) // int(rng.integers(1, 300)) % 2 == 0
            series = []
            for _ in range(int(rng.integers(0, 5))):
                values = rng.integers(-4, 5, size=length).astype(float)
                if case % 4 == 0:
                    values = rng.standard_normal(length)
                missing = rng.random(length)
                values[missing < .08] = np.nan
                values[(missing >= .08) & (missing < .12)] = np.inf
                values[(missing >= .12) & (missing < .16)] = -np.inf
                values[(missing >= .16) & (missing < .2)] = -0.0
                series.append(values)
            with self.subTest(case=case, length=length, budget=budget, series=len(series)):
                self.assert_parity(length, budget, visible, series)

    def test_large_realistic_envelopes(self):
        rng = np.random.default_rng(89)
        for length in (10_000, 100_003, 1_000_000):
            x = np.arange(length, dtype=float)
            voltage = 3.5 + .7 * np.sin(x / 1700) + rng.normal(0, .001, length)
            current = np.where(x % 2000 < 1000, 1., -1.)
            voltage[::3701] = np.nan
            current[::7103] = np.inf
            for budget in (500, 2000, 6000):
                self.assert_parity(length, budget, np.ones(length, dtype=bool),
                                   [voltage, current])

    def test_batch_boundaries_with_missing_data_and_ties(self):
        rng = np.random.default_rng(65536)
        for length in (65_535, 65_536, 65_537, 131_071, 131_072, 131_073):
            values = rng.integers(-2, 3, length).astype(float)
            values[10_000:60_000] = np.nan
            values[::71] = np.inf
            values[::89] = -np.inf
            values[::31] = -0.0
            values.flags.writeable = False
            for budget in (8, 26, 500, 2000, 6000):
                self.assert_parity(length, budget, np.ones(length, dtype=bool),
                                   [values, values[::-1]])


if __name__ == "__main__":
    unittest.main()
