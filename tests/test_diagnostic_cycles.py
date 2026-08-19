from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import diagnostic_cycles as dc


def series_from(rows) -> dict:
    return {
        "x": [cycle for cycle, _, _ in rows],
        "quantities": {
            "charge_capacity_mah": [charge for _, charge, _ in rows],
            "discharge_capacity_mah": [discharge for _, _, discharge in rows],
        },
    }


def capacity_rows(count: int, overrides: dict[int, tuple[float, float]] | None = None):
    overrides = overrides or {}
    return [
        (cycle, *(overrides.get(cycle) or (1.0, 1.0)))
        for cycle in range(1, count + 1)
    ]


class DiagnosticCycleTests(unittest.TestCase):
    def test_finds_the_complete_lower_capacity_support_block(self):
        rows = capacity_rows(
            120,
            {
                30: (1.0, 0.5),
                31: (0.02, 0.02),
                32: (0.02, 0.02),
                33: (0.02, 0.02),
                34: (0.5, 1.0),
            },
        )
        found = dc.find_in_series(series_from(rows), formation_cycles=3)
        self.assertEqual(sorted(found), [30, 31, 32, 33, 34])

    def test_uses_lower_phase_capacity_and_only_lower_tail(self):
        rows = capacity_rows(60, {30: (1.0, 0.5), 31: (1.2, 1.2), 32: (0.9, 0.9)})
        self.assertEqual(sorted(dc.find_in_series(series_from(rows))), [30])

    def test_formation_cycles_are_excluded(self):
        rows = capacity_rows(
            40,
            {1: (0.01, 0.01), 2: (0.01, 0.01), 3: (0.01, 0.01), 20: (0.01, 0.01)},
        )
        self.assertEqual(
            sorted(dc.find_in_series(series_from(rows), formation_cycles=3)),
            [20],
        )

    def test_gradual_capacity_fade_shifts_the_local_baseline(self):
        rows = [
            (cycle, 1.0 - 0.4 * (cycle - 1) / 399, 1.0 - 0.4 * (cycle - 1) / 399)
            for cycle in range(1, 401)
        ]
        self.assertEqual(
            dc.find_in_series(series_from(rows), formation_cycles=3),
            set(),
        )

    def test_missing_phase_capacity_is_unknown(self):
        rows = capacity_rows(40)
        rows[19] = (20, None, 0.01)
        self.assertEqual(dc.find_in_series(series_from(rows)), set())

    def test_short_post_formation_series_have_no_baseline(self):
        rows = capacity_rows(14, {4: (0.01, 0.01)})
        self.assertEqual(
            dc.find_in_series(series_from(rows), formation_cycles=3),
            set(),
        )

    def test_excluded_series_do_not_contribute(self):
        result = {
            "cell_series": [
                {**series_from(capacity_rows(40, {20: (1.0, 0.01)})), "excluded": True},
            ]
        }
        self.assertEqual(dc.find_across(result), [])

    def test_union_across_series_keeps_quantities_in_step(self):
        a = series_from(capacity_rows(40, {10: (1.0, 0.01)}))
        b = series_from(capacity_rows(40, {30: (0.01, 1.0)}))
        self.assertEqual(dc.find_across({"cell_series": [a, b]}), [10, 30])

    def test_tolerance_is_adjustable(self):
        rows = capacity_rows(60, {30: (0.79, 0.79)})
        series = series_from(rows)
        self.assertEqual(dc.find_in_series(series), set())
        self.assertEqual(dc.find_in_series(series, tolerance=0.2), {30})

    def test_short_series_have_no_baseline(self):
        rows = capacity_rows(5, {3: (0.01, 0.01)})
        self.assertEqual(dc.find_in_series(series_from(rows)), set())


if __name__ == "__main__":
    unittest.main()
