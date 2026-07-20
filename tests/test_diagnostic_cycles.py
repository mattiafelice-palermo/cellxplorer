from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import diagnostic_cycles as dc


# Cycles 60-120 of NG_20251127_LFP_LP_MoL_378_FM_CY_FC, the same fixture the
# TypeScript tests use. The two implementations must agree exactly, or a
# portable report would describe a different plot than the app rendered.
REAL_BLOCK = (
    [(c, 0.801, 2.4) for c in range(60, 87)]
    + [
        (87, 2.774, 0.925),
        (88, 2.781, 2.876),
        (89, 1.399, 2.871),
        (90, 0.033, 0.033),
        (91, 0.026, 0.026),
        (92, 0.008, 0.016),
        (93, 0.862, 1.428),
    ]
    + [(c, 0.801, 2.4) for c in range(94, 121)]
)


def series_from(rows) -> dict:
    return {
        "x": [c for c, _, _ in rows],
        "quantities": {
            "discharge_time_h": [d for _, d, _ in rows],
            "charge_time_h": [g for _, _, g in rows],
        },
    }


class DiagnosticCycleTests(unittest.TestCase):
    def test_finds_the_whole_real_block_and_only_it(self):
        found = dc.find_in_series(series_from(REAL_BLOCK))
        self.assertEqual(sorted(found), [87, 88, 89, 90, 91, 92, 93])

    def test_a_degrading_cell_is_never_hidden(self):
        # Capacity would collapse, but the discharge still takes a normal time.
        rows = [(c, 4.0 if c <= 120 else 3.7, 2.4) for c in range(1, 201)]
        self.assertEqual(dc.find_in_series(series_from(rows)), set())

    def test_gradual_fade_shifts_the_baseline(self):
        rows = [(c, 4.0 * (1 - 0.4 * c / 400), 2.4) for c in range(1, 401)]
        self.assertEqual(dc.find_in_series(series_from(rows)), set())

    def test_excluded_series_do_not_contribute(self):
        result = {
            "cell_series": [
                {**series_from(REAL_BLOCK), "excluded": True},
            ]
        }
        self.assertEqual(dc.find_across(result), [])

    def test_union_across_series_keeps_quantities_in_step(self):
        a = series_from([(c, 0.02 if c == 70 else 0.801, 2.4) for c in range(60, 121)])
        b = series_from([(c, 0.02 if c == 80 else 0.801, 2.4) for c in range(60, 121)])
        result = {"cell_series": [a, b]}
        self.assertEqual(dc.find_across(result), [70, 80])

    def test_ranges_are_compact_and_auditable(self):
        self.assertEqual(dc.cycle_ranges([90, 87, 88, 89]), [(87, 90)])
        self.assertEqual(dc.format_ranges([87, 88, 89, 170, 171]), "87–89, 170–171")
        self.assertEqual(dc.format_ranges([5]), "5")
        self.assertEqual(dc.format_ranges([]), "")

    def test_tolerance_is_adjustable(self):
        rows = [(c, 1.20 if c == 80 else 1.0, 2.4) for c in range(60, 121)]
        # 20% deviation: inside the default tolerance, caught by a tighter one.
        self.assertEqual(dc.find_in_series(series_from(rows)), set())
        self.assertEqual(dc.find_in_series(series_from(rows), tolerance=0.1), {80})

    def test_short_series_have_no_baseline(self):
        rows = [(c, 0.01 if c == 3 else 4.0, 2.4) for c in range(1, 6)]
        self.assertEqual(dc.find_in_series(series_from(rows)), set())


if __name__ == "__main__":
    unittest.main()
