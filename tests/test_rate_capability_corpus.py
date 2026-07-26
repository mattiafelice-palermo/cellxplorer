import json
from pathlib import Path
import unittest

import pandas as pd

from backend.app.models import Cell, SourceFile
from backend.app.services import rate_capability


CORPUS_PATH = (
    Path(__file__).parent / "fixtures" / "rate_capability_corpus.json"
)
NOMINAL_CAPACITY_MAH = 50.0


def _case_values(case: dict, plural: str, singular: str, count: int):
    configured = case.get(plural)
    if configured is not None:
        if len(configured) != count:
            raise AssertionError(
                f"{case['name']}: {plural} must contain {count} values"
            )
        return configured
    return [case[singular]] * count


def _synthetic_case(case: dict) -> tuple[dict, pd.DataFrame]:
    rates = case["swept_rates"]
    count = len(rates)
    structures = case.get("structures") or [case["structure"]] * count
    fixed_rates = _case_values(case, "fixed_rates", "fixed_rate", count)
    upper_voltages = _case_values(
        case, "upper_voltages_v", "upper_voltage_v", count
    )
    lower_voltages = _case_values(
        case, "lower_voltages_v", "lower_voltage_v", count
    )
    scaffolds = case.get("scaffolds") or [case["scaffold"]] * count
    completions = case.get("completions") or [
        case.get("complete", True)
    ] * count
    for field, values in (
        ("structures", structures),
        ("scaffolds", scaffolds),
        ("completions", completions),
    ):
        if len(values) != count:
            raise AssertionError(
                f"{case['name']}: {field} must contain {count} values"
            )

    steps: list[dict] = []
    rows: list[dict] = []
    step_number = int(case["step_start"])
    record_index = 0

    def add_rows(
        *,
        cycle: int,
        index: int,
        voltages: list[float],
        current_ma: float,
        charge_capacity: float = 0.0,
        discharge_capacity: float = 0.0,
    ) -> None:
        nonlocal record_index
        for position, voltage in enumerate(voltages):
            fraction = position / max(1, len(voltages) - 1)
            rows.append(
                {
                    "record_index": record_index,
                    "cycle": cycle,
                    "step": index * 10 + cycle,
                    "step_index": index,
                    "voltage_v": voltage,
                    "current_ma": current_ma,
                    "charge_capacity_mah": charge_capacity * fraction,
                    "discharge_capacity_mah": discharge_capacity * fraction,
                }
            )
            record_index += 1

    for ordinal, swept_rate in enumerate(rates):
        structure = structures[ordinal]
        fixed_rate = fixed_rates[ordinal]
        upper = upper_voltages[ordinal]
        lower = lower_voltages[ordinal]
        complete = completions[ordinal]
        charge_rate = swept_rate if case["family"] == "charge" else fixed_rate
        discharge_rate = (
            fixed_rate if case["family"] == "charge" else swept_rate
        )
        cycle = ordinal + 1
        charge_capacity = max(5.0, 50.0 - 2.5 * charge_rate)
        discharge_capacity = max(5.0, 50.0 - 2.5 * discharge_rate)
        charge_end = upper if complete else upper - 0.25
        discharge_end = lower if complete else lower + 0.35

        if structure == "cc_cv":
            cc_step = step_number
            steps.append(
                {
                    "number": cc_step,
                    "type_id": 1,
                    "type": "CC charge",
                    "direction": "charge",
                    "c_rate": charge_rate,
                    "stop_voltage_v": upper,
                }
            )
            add_rows(
                cycle=cycle,
                index=cc_step,
                voltages=[lower + 0.1, (lower + upper) / 2, charge_end],
                current_ma=charge_rate * NOMINAL_CAPACITY_MAH,
                charge_capacity=charge_capacity,
            )
            step_number += 1
            cv_step = step_number
            steps.append(
                {
                    "number": cv_step,
                    "type_id": 3,
                    "type": "CV charge",
                    "direction": "charge",
                    "c_rate": charge_rate,
                    "target_voltage_v": upper,
                }
            )
            add_rows(
                cycle=cycle,
                index=cv_step,
                voltages=[charge_end, charge_end, charge_end],
                current_ma=charge_rate * NOMINAL_CAPACITY_MAH / 2,
                charge_capacity=charge_capacity + 20.0,
            )
            step_number += 1
        else:
            charge_step = step_number
            steps.append(
                {
                    "number": charge_step,
                    "type_id": 7 if structure == "cccv" else 1,
                    "type": "CCCV charge" if structure == "cccv" else "CC charge",
                    "direction": "charge",
                    "c_rate": charge_rate,
                    (
                        "target_voltage_v"
                        if structure == "cccv"
                        else "stop_voltage_v"
                    ): upper,
                }
            )
            add_rows(
                cycle=cycle,
                index=charge_step,
                voltages=[lower + 0.1, (lower + upper) / 2, charge_end],
                current_ma=charge_rate * NOMINAL_CAPACITY_MAH,
                charge_capacity=charge_capacity,
            )
            step_number += 1

        scaffold = scaffolds[ordinal]
        if scaffold in {"rest_only", "rest_control"}:
            steps.append(
                {
                    "number": step_number,
                    "type_id": 4,
                    "type": "Rest",
                    "direction": "rest",
                }
            )
            step_number += 1

        discharge_step = step_number
        steps.append(
            {
                "number": discharge_step,
                "type_id": 2,
                "type": "CC discharge",
                "direction": "discharge",
                "c_rate": discharge_rate,
                "stop_voltage_v": lower,
            }
        )
        add_rows(
            cycle=cycle,
            index=discharge_step,
            voltages=[upper - 0.05, (lower + upper) / 2, discharge_end],
            current_ma=-discharge_rate * NOMINAL_CAPACITY_MAH,
            discharge_capacity=discharge_capacity,
        )
        step_number += 1

        if scaffold in {"rest_only", "rest_control"}:
            steps.append(
                {
                    "number": step_number,
                    "type_id": 4,
                    "type": "Rest",
                    "direction": "rest",
                }
            )
            step_number += 1
        if scaffold == "rest_control":
            steps.append(
                {
                    "number": step_number,
                    "type_id": 5,
                    "type": "Cycle",
                    "direction": "control",
                }
            )
            step_number += 1

    return {"steps": steps}, pd.DataFrame(rows)


class SyntheticRateCapabilityCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        document = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        cls.cases = document["cases"]
        cls.cell = Cell(id=41, name="Synthetic corpus")

    def test_corpus_contains_positive_and_negative_protocol_families(self):
        positive = [case for case in self.cases if case["expect_match"]]
        negative = [case for case in self.cases if not case["expect_match"]]

        self.assertGreaterEqual(len(positive), 6)
        self.assertGreaterEqual(len(negative), 6)
        self.assertEqual(
            {case["family"] for case in positive},
            {"charge", "discharge"},
        )
        self.assertTrue(
            {"cc", "cc_cv", "cccv"}.issubset(
                {
                    case.get("structure")
                    for case in positive
                    if case.get("structure")
                }
            )
        )

    def test_full_recognition_pipeline_against_corpus(self):
        for case_number, case in enumerate(self.cases, start=1):
            with self.subTest(case=case["name"]):
                reconstructed, raw = _synthetic_case(case)
                pairs = rate_capability.build_rate_pairs(reconstructed)
                self.assertEqual(len(pairs), len(case["swept_rates"]))

                source = SourceFile(
                    id=case_number,
                    hash=f"{case_number:064x}",
                    path=f"{case['name']}.ndax",
                    filename=f"{case['name']}.ndax",
                    size=1,
                    ext="ndax",
                )
                executions: list[dict] = []
                for pair in pairs:
                    executions.extend(
                        rate_capability.extract_pair_executions(
                            raw,
                            pair,
                            cell=self.cell,
                            source=source,
                            label=self.cell.name,
                            nominal_capacity_mah=NOMINAL_CAPACITY_MAH,
                            active_mass_mg=100.0,
                            electrode_area_cm2=2.0,
                            cutoff_tolerance_v=0.03,
                        )
                    )

                family = case["family"]
                rules = case.get("rules") or {}
                config = rate_capability._merged_config(
                    {
                        "computation": {
                            "rate_capability": {
                                "families": {family: rules}
                            }
                        }
                    }
                )
                blocks = rate_capability.detect_sweep_blocks(
                    executions, family, config
                )
                opposite = (
                    "discharge" if family == "charge" else "charge"
                )
                self.assertEqual(
                    rate_capability.detect_sweep_blocks(
                        executions, opposite, config
                    ),
                    [],
                )

                if not case["expect_match"]:
                    self.assertEqual(blocks, [])
                    continue

                self.assertTrue(blocks)
                best = blocks[0]
                self.assertEqual(
                    [round(value, 6) for value in best["rates_c"]],
                    [
                        round(value, 6)
                        for value in case["expected_rates"]
                    ],
                )
                self.assertEqual(
                    len(best["points"]),
                    case.get(
                        "expected_point_count",
                        len(case["swept_rates"]),
                    ),
                )
                if case.get("structure"):
                    self.assertEqual(
                        best["charge_structure"], case["structure"]
                    )


if __name__ == "__main__":
    unittest.main()
