import unittest

import pandas as pd

from backend.app.models import Cell, SourceFile
from backend.app.services import rate_capability


def charge_pair_protocol() -> dict:
    return {
        "steps": [
            {
                "number": 10,
                "type_id": 1,
                "type": "CC charge",
                "direction": "charge",
                "c_rate": 5.0,
                "stop_voltage_v": 3.65,
            },
            {
                "number": 11,
                "type_id": 3,
                "type": "CV charge",
                "direction": "charge",
                "c_rate": 5.0,
                "target_voltage_v": 3.65,
                "stop_c_rate": 0.05,
            },
            {
                "number": 12,
                "type_id": 4,
                "type": "Rest",
                "direction": "rest",
            },
            {
                "number": 13,
                "type_id": 2,
                "type": "CC discharge",
                "direction": "discharge",
                "c_rate": 1 / 3,
                "stop_voltage_v": 2.8,
            },
            {
                "number": 14,
                "type_id": 4,
                "type": "Rest",
                "direction": "rest",
            },
            {
                "number": 15,
                "type_id": 5,
                "type": "Cycle",
                "direction": "control",
            },
        ]
    }


class ProtocolPairTests(unittest.TestCase):
    def test_cc_and_cv_remain_distinct_but_form_one_charge_protocol(self):
        pairs = rate_capability.build_rate_pairs(charge_pair_protocol())

        self.assertEqual(len(pairs), 1)
        pair = pairs[0]
        self.assertEqual(pair["charge"]["structure"], "cc_cv")
        self.assertEqual(pair["charge"]["measurement_step_index"], 10)
        self.assertEqual(pair["charge"]["step_indices"], [10, 11])
        self.assertEqual(pair["discharge"]["measurement_step_index"], 13)
        self.assertIn("rest", pair["between_tokens"])
        self.assertIn("control", pair["after_tokens"])


class CapacityExtractionTests(unittest.TestCase):
    def setUp(self):
        self.pair = rate_capability.build_rate_pairs(charge_pair_protocol())[0]
        self.cell = Cell(id=4, name="Example")
        self.source = SourceFile(
            id=8,
            hash="b" * 64,
            path="example.ndax",
            filename="example.ndax",
            size=1,
            ext="ndax",
        )

    def frame(self, discharge_last_voltage=2.8):
        return pd.DataFrame(
            {
                "record_index": range(9),
                "cycle": [20] * 9,
                "step": [100, 100, 100, 101, 101, 101, 102, 102, 102],
                "step_index": [10, 10, 10, 11, 11, 11, 13, 13, 13],
                "voltage_v": [
                    3.3,
                    3.55,
                    3.65,
                    3.65,
                    3.65,
                    3.65,
                    3.6,
                    3.2,
                    discharge_last_voltage,
                ],
                "current_ma": [250, 250, 250, 200, 80, 2.5, -17, -17, -17],
                "charge_capacity_mah": [0, 7, 14.3, 0, 20, 35.2, 0, 0, 0],
                "discharge_capacity_mah": [0, 0, 0, 0, 0, 0, 0, 25, 49.5],
            }
        )

    def extract(self, frame):
        return rate_capability.extract_pair_executions(
            frame,
            self.pair,
            cell=self.cell,
            source=self.source,
            label="Example",
            nominal_capacity_mah=50,
            active_mass_mg=100,
            electrode_area_cm2=2,
            cutoff_tolerance_v=0.03,
        )

    def test_charge_capacity_uses_cc_step_only_not_following_cv(self):
        executions = self.extract(self.frame())
        charge = next(row for row in executions if row["family"] == "charge")

        self.assertTrue(charge["valid"])
        self.assertAlmostEqual(charge["capacity_mah"], 14.3)
        self.assertAlmostEqual(charge["capacity_mah_g"], 143)
        self.assertAlmostEqual(charge["current_ma"], 250)
        self.assertAlmostEqual(charge["observed_c_rate"], 5)

    def test_incomplete_discharge_cutoff_invalidates_both_interpretations(self):
        executions = self.extract(self.frame(discharge_last_voltage=3.4))

        self.assertTrue(executions)
        self.assertTrue(all(not row["valid"] for row in executions))
        self.assertTrue(
            all(
                not row["validation"]["reference_phase_completed"]
                if row["family"] == "charge"
                else not row["validation"]["measurement_cutoff_reached"]
                for row in executions
            )
        )


def execution(
    ordinal: int,
    rate: float,
    *,
    family: str = "discharge",
    fixed_rate: float = 1 / 3,
) -> dict:
    return {
        "id": f"point-{ordinal}",
        "family": family,
        "cell_id": 1,
        "cell_name": "Example",
        "label": "Example",
        "filename": "example.ndax",
        "source_hash": "c" * 64,
        "pair_ordinal": ordinal,
        "charge_structure": "cccv" if family == "discharge" else "cc_cv",
        "scaffold_signature": "charge>rest>discharge>rest>control",
        "rate_c": rate,
        "fixed_rate_c": fixed_rate,
        "upper_voltage_v": 3.65,
        "lower_voltage_v": 2.8,
        "capacity_mah": 50 - rate,
        "valid": True,
    }


class SweepDetectionTests(unittest.TestCase):
    def test_monotonic_signal_splits_post_sweep_recovery_cycles(self):
        rates = [0.2, 1 / 3, 0.5, 1, 2, 3, 4, 5, 1 / 3, 1 / 3]
        rows = [execution(index, rate) for index, rate in enumerate(rates)]
        config = rate_capability._merged_config({"computation": {}})

        blocks = rate_capability.detect_sweep_blocks(rows, "discharge", config)

        self.assertEqual(len(blocks), 1)
        self.assertEqual(
            [round(value, 3) for value in blocks[0]["rates_c"]],
            [0.2, 0.333, 0.5, 1, 2, 3, 4, 5],
        )
        self.assertEqual(len(blocks[0]["points"]), 8)
        self.assertTrue(blocks[0]["monotonic"])

    def test_fixed_complementary_rate_is_a_semantic_rule(self):
        rows = [execution(index, rate) for index, rate in enumerate([0.2, 0.5, 1])]
        config = rate_capability._merged_config(
            {
                "computation": {
                    "rate_capability": {
                        "families": {
                            "discharge": {"fixed_rate_c": 1.0},
                        }
                    }
                }
            }
        )

        self.assertEqual(
            rate_capability.detect_sweep_blocks(rows, "discharge", config),
            [],
        )


def comparison_block(
    cell_id: int,
    family: str,
    capacities: list[float],
    rates: list[float] | None = None,
) -> dict:
    rates = rates or [0.2, 1.0, 5.0]
    return {
        "id": f"{cell_id}-{family}",
        "family": family,
        "cell_id": cell_id,
        "cell_name": f"Cell {cell_id}",
        "label": f"Cell {cell_id}",
        "points": [
            {
                "id": f"{cell_id}-{family}-{rate}",
                "cell_id": cell_id,
                "family": family,
                "rate_c": rate,
                "capacity_mah": capacity,
            }
            for rate, capacity in zip(rates, capacities)
        ],
    }


class CommonRateComparisonTests(unittest.TestCase):
    def test_uses_one_lowest_rate_shared_by_both_families_and_cells(self):
        cells = [Cell(id=1, name="Cell 1"), Cell(id=2, name="Cell 2")]
        blocks = [
            comparison_block(1, "charge", [50.0, 45.0, 20.0]),
            comparison_block(1, "discharge", [51.0, 46.0, 31.0]),
            comparison_block(2, "charge", [48.0, 42.0, 18.0]),
            comparison_block(2, "discharge", [49.0, 44.0, 29.0]),
        ]

        normalized, comparison = (
            rate_capability.build_common_rate_comparison(
                blocks, cells, tolerance=0.03
            )
        )

        self.assertTrue(comparison["available"])
        self.assertAlmostEqual(comparison["reference_rate_c"], 0.2)
        self.assertEqual(comparison["common_rates_c"], [0.2, 1.0, 5.0])
        self.assertEqual(len(comparison["points"]), 6)
        cell_one_5c = next(
            point
            for point in comparison["points"]
            if point["cell_id"] == 1 and point["rate_c"] == 5.0
        )
        self.assertAlmostEqual(
            cell_one_5c["asymmetry_ratio"],
            (31.0 / 51.0) / (20.0 / 50.0),
        )
        charge_reference = next(
            block
            for block in normalized
            if block["cell_id"] == 1 and block["family"] == "charge"
        )["points"][0]
        self.assertAlmostEqual(charge_reference["retention_pct"], 100.0)

    def test_reports_unavailable_when_any_cell_lacks_one_family(self):
        cells = [Cell(id=1, name="Cell 1"), Cell(id=2, name="Cell 2")]
        blocks = [
            comparison_block(1, "charge", [50.0, 45.0, 20.0]),
            comparison_block(1, "discharge", [51.0, 46.0, 31.0]),
            comparison_block(2, "charge", [48.0, 42.0, 18.0]),
        ]

        _, comparison = rate_capability.build_common_rate_comparison(
            blocks, cells, tolerance=0.03
        )

        self.assertFalse(comparison["available"])
        self.assertIsNone(comparison["reference_rate_c"])
        self.assertEqual(comparison["points"], [])

    def test_matches_small_rate_rounding_differences_between_cells(self):
        cells = [Cell(id=1, name="Cell 1"), Cell(id=2, name="Cell 2")]
        blocks = [
            comparison_block(1, "charge", [50.0, 45.0, 20.0]),
            comparison_block(1, "discharge", [51.0, 46.0, 31.0]),
            comparison_block(
                2,
                "charge",
                [48.0, 42.0, 18.0],
                rates=[0.199, 1.01, 5.05],
            ),
            comparison_block(
                2,
                "discharge",
                [49.0, 44.0, 29.0],
                rates=[0.199, 1.01, 5.05],
            ),
        ]

        _, comparison = rate_capability.build_common_rate_comparison(
            blocks, cells, tolerance=0.03
        )

        self.assertTrue(comparison["available"])
        self.assertAlmostEqual(comparison["reference_rate_c"], 0.1995)
        self.assertEqual(len(comparison["common_rates_c"]), 3)
        self.assertEqual(len(comparison["points"]), 6)


if __name__ == "__main__":
    unittest.main()
