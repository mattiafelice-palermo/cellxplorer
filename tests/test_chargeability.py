import unittest
from unittest.mock import patch

import pandas as pd

from backend.app.models import Cell, SourceFile
from backend.app.services import chargeability


def reconstructed_protocol(reference_name: str = "User1") -> dict:
    return {
        "signature": "example-protocol",
        "steps": [
            {
                "number": 19,
                "type_id": 2,
                "type": "CC discharge",
                "direction": "discharge",
                "conditions": [
                    {
                        "expression": "DischargeAh",
                        "stores_as": reference_name,
                    }
                ],
            },
            {
                "number": 25,
                "type_id": 2,
                "type": "CC discharge",
                "direction": "discharge",
                "conditions": [
                    {
                        "expression": f"0.8*{reference_name}-DischargeAh",
                        "stores_as": None,
                    }
                ],
            },
            {
                "number": 29,
                "type_id": 3,
                "type": "CV charge",
                "direction": "charge",
                "c_rate": 10.0,
                "current_ma": 511.4,
                "target_voltage_v": 3.65,
                "conditions": [
                    {
                        "expression": f"ChargeAh-({reference_name}*0.60)",
                        "stores_as": None,
                    }
                ],
            },
        ],
    }


class LinearExpressionTests(unittest.TestCase):
    def test_recognizes_algebraically_equivalent_capacity_ratios(self):
        self.assertEqual(
            chargeability.capacity_fraction("ChargeAh - 0.6*User1", "charge"),
            ("User1", 0.6),
        )
        self.assertEqual(
            chargeability.capacity_fraction("0.8*Reference-DischargeAh", "discharge"),
            ("Reference", 0.8),
        )
        self.assertEqual(
            chargeability.capacity_fraction("(2*ChargeAh)/2 - Reference*0.6", "charge"),
            ("Reference", 0.6),
        )

    def test_rejects_calls_attributes_and_nonlinear_expressions(self):
        for expression in (
            "__import__('os').system('echo unsafe')",
            "source.value-ChargeAh",
            "ChargeAh*Reference",
            "ChargeAh-Reference**2",
        ):
            self.assertIsNone(
                chargeability.capacity_fraction(expression, "charge"),
                expression,
            )
        self.assertIsNone(
            chargeability.capacity_fraction(
                "DischargeAh-0.6*Reference",
                "charge",
            )
        )


class CandidateDetectionTests(unittest.TestCase):
    def test_detects_semantic_soc_window_without_fixed_step_or_variable_names(self):
        candidates = chargeability.detect_candidates(
            reconstructed_protocol("ProtocolCapacity")
        )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["step_index"], 29)
        self.assertEqual(candidate["preparation_step_index"], 25)
        self.assertEqual(candidate["reference_step_index"], 19)
        self.assertEqual(candidate["reference_variable"], "ProtocolCapacity")
        self.assertAlmostEqual(candidate["initial_soc_pct"], 20)
        self.assertAlmostEqual(candidate["final_soc_pct"], 80)
        self.assertAlmostEqual(candidate["current_ceiling_c"], 10)
        self.assertAlmostEqual(candidate["target_voltage_v"], 3.65)

    def test_requires_the_same_reference_for_preparation_and_charge(self):
        protocol = reconstructed_protocol()
        protocol["steps"][1]["conditions"][0]["expression"] = (
            "DischargeAh-0.8*AnotherReference"
        )

        self.assertEqual(chargeability.detect_candidates(protocol), [])

    def test_request_protocol_cache_reuses_only_exact_parser_header_and_nominal(self):
        first = SourceFile(
            id=1,
            hash="a" * 64,
            path="first.ndax",
            filename="first.ndax",
            size=1,
            ext="ndax",
            header_meta={"Step": {"one": "charge"}},
        )
        equivalent = SourceFile(
            id=2,
            hash="b" * 64,
            path="equivalent.ndax",
            filename="equivalent.ndax",
            size=1,
            ext="ndax",
            header_meta={"Step": {"one": "charge"}},
        )
        changed_header = SourceFile(
            id=3,
            hash="c" * 64,
            path="changed.ndax",
            filename="changed.ndax",
            size=1,
            ext="ndax",
            header_meta={"Step": {"one": "discharge"}},
        )
        entries = []
        with patch.object(
            chargeability.protocol,
            "reconstruct_protocol",
            side_effect=lambda header, nominal: {
                "header": header,
                "nominal": nominal,
            },
        ) as reconstruct:
            first_result = chargeability._reconstruct_protocol_for_request(
                first, 100.0, "parser-a", entries
            )
            equivalent_result = chargeability._reconstruct_protocol_for_request(
                equivalent, 100.0, "parser-a", entries
            )
            changed_result = chargeability._reconstruct_protocol_for_request(
                changed_header, 100.0, "parser-a", entries
            )
            different_parser_result = chargeability._reconstruct_protocol_for_request(
                equivalent, 100.0, "parser-b", entries
            )
            different_nominal_result = chargeability._reconstruct_protocol_for_request(
                equivalent, 200.0, "parser-a", entries
            )

        self.assertIs(first_result, equivalent_result)
        self.assertIsNot(first_result, changed_result)
        self.assertIsNot(first_result, different_parser_result)
        self.assertIsNot(first_result, different_nominal_result)
        self.assertEqual(reconstruct.call_count, 4)


class RawExtractionTests(unittest.TestCase):
    def test_uses_the_larger_recorded_capacity_direction_and_builds_soc(self):
        timestamps = pd.date_range("2026-01-01", periods=6, freq="60s")
        raw = pd.DataFrame(
            {
                "record_index": range(6),
                "timestamp": timestamps,
                "cycle": [7, 7, 8, 8, 8, 8],
                "step": [100, 100, 200, 200, 200, 200],
                "step_index": [19, 19, 29, 29, 29, 29],
                "current_ma": [-17, -17, 500, 300, 100, 20],
                "charge_capacity_mah": [0, 0, 0, 10, 20, 29.7],
                "discharge_capacity_mah": [20, 49.5, 0, 0, 0, 0],
            }
        )
        candidate = chargeability.detect_candidates(reconstructed_protocol())[0]
        candidate["protocol_signature"] = "example-protocol"
        cell = Cell(id=4, name="Example cell")
        source = SourceFile(
            id=8,
            hash="a" * 64,
            path="example.ndax",
            filename="example.ndax",
            size=1,
            ext="ndax",
        )

        matches = chargeability._occurrence_rows(
            raw,
            candidate,
            cell=cell,
            source=source,
            label="Example cell",
            nominal_capacity_mah=50,
            active_mass_mg=100,
            electrode_area_cm2=2,
        )

        self.assertEqual(len(matches), 1)
        match = matches[0]
        self.assertAlmostEqual(match["reference_capacity_mah"], 49.5)
        self.assertEqual(match["reference"]["quantity"], "discharge_capacity_mah")
        self.assertAlmostEqual(match["delivered_capacity_mah"], 29.7)
        self.assertAlmostEqual(match["observed_final_soc_pct"], 80)
        self.assertAlmostEqual(match["x"]["soc_pct"][-1], 80)
        self.assertAlmostEqual(match["x"]["capacity_mah_g"][-1], 297)
        self.assertAlmostEqual(match["x"]["capacity_mah_cm2"][-1], 14.85)
        self.assertAlmostEqual(match["y"]["c_rate"][0], 10)


if __name__ == "__main__":
    unittest.main()
