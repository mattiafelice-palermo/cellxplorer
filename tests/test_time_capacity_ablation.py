"""Focused contracts for the benchmark-only Spec 050.13 harness."""
from __future__ import annotations

import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, "scripts")

import profile_time_capacity_ablation as ablation


def _frame(length: int = 5000) -> pd.DataFrame:
    cycle = np.repeat(np.arange(1, 11, dtype="int64"), length // 10)
    cycle = np.concatenate((cycle, np.full(length - len(cycle), 10, dtype="int64")))
    values = np.linspace(0.0, 1.0, length)
    return pd.DataFrame(
        {
            "cycle": cycle,
            "segment": np.zeros(length, dtype="int64"),
            "record_index": np.arange(length, dtype="int64"),
            "time_s": values,
            "voltage_v": 3.5 + values,
            "current_ma": np.where(np.arange(length) % 2, -1.0, 1.0),
            "status": np.where(np.arange(length) % 2, "DCHG", "CHG"),
            "source_cycle": cycle,
            "source_hash": np.full(length, "hash-a", dtype=object),
        }
    )


def _settings() -> dict:
    return {
        "cycles": [],
        "cycle_start": 1,
        "cycle_end": None,
        "x_axis": "time",
        "time_unit": "min",
        "display_mode": "consecutive",
        "max_points_per_cell": 400,
        "view": "voltage_current",
    }


class TimeCapacityAblationTests(unittest.TestCase):
    def test_vectorized_downsample_matches_current_rule(self) -> None:
        frame = _frame()
        visible = np.isfinite(frame["voltage_v"].to_numpy())
        series = [frame["voltage_v"].to_numpy(dtype="float64")]
        from app.services import analysis_engine

        expected = analysis_engine._downsample_indices(len(frame), 400, visible, series)
        candidate = ablation._vectorized_downsample_indices(len(frame), 400, visible, series)
        np.testing.assert_array_equal(candidate, expected)

    def test_dense_cycle_mapping_is_exact(self) -> None:
        frame = pd.DataFrame({"cycle": [10, 10, 14, 18, 18, 21]})
        mapping = {10: 1, 14: 2, 18: 3, 21: 4}
        expected = frame["cycle"].map(mapping).to_numpy(dtype="float64")
        candidate = ablation._dense_cycle_mapping(frame, mapping).to_numpy(dtype="float64")
        np.testing.assert_array_equal(candidate, expected)

    def test_direct_take_candidate_preserves_projection_digest(self) -> None:
        frame = _frame()
        settings = _settings()
        baseline = ablation._projection(frame, settings, "A0")
        direct = ablation._projection(frame, settings, "T10")
        self.assertEqual(direct.digest, baseline.digest)
        self.assertEqual(direct.trace_order_digest, baseline.trace_order_digest)

    def test_synthetic_tiers_keep_downsampling_contract(self) -> None:
        self.assertEqual([name for name, _end in ablation.SYNTHETIC_TIERS], ["S100", "S50", "S25"])
        self.assertEqual(ablation._features("T6+T7+T8+T10"), {"T6", "T7", "T8", "T10"})

    def test_catalog_covers_every_ablation_identifier(self) -> None:
        identifiers = {item["candidate"] for item in ablation._candidate_catalog()}
        self.assertEqual(identifiers, set(ablation.ABLATION_CANDIDATES))


if __name__ == "__main__":
    unittest.main()
