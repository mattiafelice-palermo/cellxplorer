import os
import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import protocol


def synthetic_header():
    return {
        "Step.Step_Info.Step1.Step_Type": "1",
        "Step.Step_Info.Step1.Limit.Main.Curr.Value": "5",
        "Step.Step_Info.Step1.Limit.Main.Rate.Value": "0.5",
        "Step.Step_Info.Step1.Limit.Main.Stop_Volt.Value": "42000",
        "Step.Step_Info.Step1.Limit.Main.Time.Value": "3600000",
        "Step.Step_Info.Step1.Record.Main.Time.Value": "1000",
        "Step.Step_Info.Step1.Protect.Main.Volt.Upper.Value": "45000",
        "Step.Step_Info.Step1.Protect.Main.Volt.Lower.Value": "20000",
        "Step.Step_Info.Step2.Step_Type": "4",
        "Step.Step_Info.Step2.Limit.Main.Time.Value": "600000",
        "Step.Step_Info.Step3.Step_Type": "2",
        "Step.Step_Info.Step3.Limit.Main.Curr.Value": "5",
        "Step.Step_Info.Step3.Limit.Main.Rate.Value": "0.5",
        "Step.Step_Info.Step3.Limit.Main.Stop_Volt.Value": "30000",
        "Step.Step_Info.Step4.Step_Type": "5",
        "Step.Step_Info.Step4.Limit.Other.Start_Step.Value": "1",
        "Step.Step_Info.Step4.Limit.Other.Cycle_Count.Value": "10",
        "Step.Step_Info.Step5.Step_Type": "7",
        "Step.Step_Info.Step5.Limit.Main.Curr.Value": "10",
        "Step.Step_Info.Step5.Limit.Main.Volt.Value": "42000",
        "Step.Step_Info.Step5.Limit.Main.Stop_Curr.Value": "0.5",
        "Step.Step_Info.Step6.Step_Type": "6",
        # Duplicate editor copy must not double the protocol.
        "EditStep.Step_Info.Step1.Step_Type": "1",
    }


class ProtocolTests(unittest.TestCase):
    def test_observed_step_coverage_counts_executions_and_cycles(self):
        frame = pd.DataFrame(
            {
                "cycle": [1, 1, 1, 2, 2, 3],
                "step": [10, 10, 11, 12, 12, 13],
                "step_index": [5, 5, 6, 5, 5, 6],
            }
        )

        self.assertEqual(
            protocol.observed_step_coverage(frame),
            [
                {"step_index": 5, "execution_count": 2, "cycle_count": 2, "cycles": [1, 2]},
                {"step_index": 6, "execution_count": 2, "cycle_count": 2, "cycles": [1, 3]},
            ],
        )

    def test_signature_matches_equivalent_protocols_across_sources(self):
        first = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        second = protocol.reconstruct_protocol(dict(synthetic_header()), nominal_capacity_mah=20)

        self.assertEqual(first["signature"], second["signature"])
        self.assertEqual(len(first["signature"]), 64)

    def test_signature_changes_when_executable_settings_change(self):
        changed = synthetic_header()
        changed["Step.Step_Info.Step3.Limit.Main.Stop_Volt.Value"] = "29000"

        self.assertNotEqual(
            protocol.reconstruct_protocol(synthetic_header())["signature"],
            protocol.reconstruct_protocol(changed)["signature"],
        )

    def test_reconstructs_steps_and_explicit_loop(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        self.assertEqual(result["n_steps"], 6)
        self.assertEqual(result["steps"][0]["type"], "CC charge")
        self.assertEqual(result["steps"][0]["c_rate_source"], "explicit")
        self.assertIn("C/2", result["steps"][0]["summary"])
        loop = next(group for group in result["groups"] if group["kind"] == "repeated_block")
        self.assertEqual(loop["step_numbers"], [1, 2, 3])
        self.assertEqual(loop["repeat_count"], 10)

    def test_distinguishes_operational_cutoffs_from_protection(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        self.assertEqual(result["summary"]["charge_cutoffs"][0]["voltage_v"], 4.2)
        self.assertEqual(result["summary"]["discharge_cutoffs"][0]["voltage_v"], 3.0)
        self.assertEqual(
            result["summary"]["protection_windows"],
            [{"lower_v": 2.0, "upper_v": 4.5}],
        )

    def test_cccv_target_is_an_operational_cutoff(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        charge = {row["voltage_v"]: row["step_count"] for row in result["summary"]["charge_cutoffs"]}
        self.assertEqual(charge[4.2], 2)

    def test_infers_rate_only_when_explicit_rate_is_missing(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        cccv = result["steps"][4]
        self.assertEqual(cccv["c_rate"], 1.0)
        self.assertEqual(cccv["c_rate_source"], "inferred")

    def test_formats_stop_current_as_c_fraction_when_capacity_is_known(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        cccv = result["steps"][4]
        self.assertEqual(cccv["stop_c_rate"], 0.05)
        self.assertEqual(cccv["stop_c_rate_source"], "inferred")
        self.assertIn("until C/20", cccv["summary"])

    def test_reconstructs_nominal_capacity_from_explicit_current_rate_pairs(self):
        result = protocol.reconstruct_protocol(synthetic_header())
        cccv = result["steps"][4]
        self.assertEqual(cccv["stop_c_rate"], 0.05)
        self.assertIn("until C/20", cccv["summary"])
        self.assertTrue(any("Nominal capacity was reconstructed" in warning for warning in result["warnings"]))

    def test_formats_third_c_rate_as_fraction(self):
        header = synthetic_header()
        header["Step.Step_Info.Step1.Limit.Main.Rate.Value"] = "0.333"
        result = protocol.reconstruct_protocol(header, nominal_capacity_mah=10)
        self.assertIn("C/3", result["steps"][0]["summary"])

    def test_exposes_neware_global_user_capacity_assignment(self):
        header = synthetic_header()
        header["Step.Step_Info.Step3.Limit.Other.Cnd1.Expression"] = "DischargeAh"
        header["Step.Step_Info.Step3.Limit.Other.Cnd1.GlobleUserID"] = "71"

        result = protocol.reconstruct_protocol(header, nominal_capacity_mah=10)
        condition = result["steps"][2]["conditions"][0]

        self.assertEqual(condition["global_user_id"], 71)
        self.assertEqual(condition["stores_as"], "User1")


if __name__ == "__main__":
    unittest.main()


def nested_header() -> dict:
    """A protocol shaped like the real Alava test: loops three deep.

    Formation, then an outer block repeated 999 times that holds a diagnostic
    sequence followed by an ageing block repeated 19 times, whose own body
    contains a further repeat. Mirrors JR_ME_LPMol_511_ALAVA-1-4FC.
    """
    header: dict[str, str] = {}

    def measuring(number: int, type_id: str = "1") -> None:
        header[f"Step.Step_Info.Step{number}.Step_Type"] = type_id
        header[f"Step.Step_Info.Step{number}.Limit.Main.Curr.Value"] = "5"

    def loop(number: int, start: int, count: int) -> None:
        header[f"Step.Step_Info.Step{number}.Step_Type"] = "5"
        header[f"Step.Step_Info.Step{number}.Limit.Other.Start_Step.Value"] = str(start)
        header[f"Step.Step_Info.Step{number}.Limit.Other.Cycle_Count.Value"] = str(count)

    for number in (1, 2, 3):          # formation
        measuring(number)
    for number in (4, 5, 6, 7):       # diagnostic sequence inside the outer loop
        measuring(number)
    for number in (8, 9):             # ageing body
        measuring(number)
    loop(10, 8, 3)                    # innermost: repeat 8-9 three times
    measuring(11)                     # fast-charge style step after the inner repeat
    loop(12, 8, 19)                   # ageing block: repeat 8-11 nineteen times
    loop(13, 4, 999)                  # outer block: repeat 4-12 nine-hundred-ninety-nine times
    measuring(14)
    header["Step.Step_Info.Step15.Step_Type"] = "6"   # End
    return header


class NestedProtocolStructureTests(unittest.TestCase):
    """Loops nest in Neware files; reporting them as peers is unusable.

    The real protocol that motivated this is three deep, and flattening it put
    an ageing block beside the outer block that contains it, with overlapping
    step ranges and no way to select one phase.
    """

    def setUp(self):
        self.groups = protocol.reconstruct_protocol(nested_header(), 5000.0)["groups"]

    def find(self, nodes, summary_start):
        for node in nodes:
            if node["summary"].startswith(summary_start):
                return node
            found = self.find(node["children"], summary_start)
            if found:
                return found
        return None

    def test_top_level_holds_only_outermost_blocks(self):
        summaries = [group["summary"] for group in self.groups]
        self.assertEqual(
            summaries,
            ["Steps 1-3", "Steps 4-12, repeated 999 times", "Step 14"],
        )

    def test_inner_blocks_are_children_not_siblings(self):
        outer = self.find(self.groups, "Steps 4-12, repeated 999")
        child_summaries = [child["summary"] for child in outer["children"]]
        self.assertEqual(
            child_summaries, ["Steps 4-7", "Steps 8-11, repeated 19 times"]
        )

        ageing = self.find(self.groups, "Steps 8-11, repeated 19")
        self.assertEqual(
            [child["summary"] for child in ageing["children"]],
            ["Steps 8-9, repeated 3 times", "Step 11"],
        )
        # The innermost block has no nested block, so it owns its steps outright
        # rather than wrapping them in a child that restates its own range.
        innermost = self.find(self.groups, "Steps 8-9, repeated 3")
        self.assertEqual(innermost["children"], [])
        self.assertEqual(innermost["step_numbers"], [8, 9])

    def test_the_diagnostic_sequence_becomes_one_selectable_node(self):
        # The steps between an outer loop's start and its first inner loop are
        # exactly the diagnostic block, and must be selectable as a unit.
        block = self.find(self.groups, "Steps 4-7")
        self.assertEqual(block["kind"], "sequence")
        self.assertEqual(block["step_numbers"], [4, 5, 6, 7])

    def test_depth_reflects_real_nesting(self):
        self.assertEqual(self.find(self.groups, "Steps 4-12")["depth"], 0)
        self.assertEqual(self.find(self.groups, "Steps 8-11")["depth"], 1)
        self.assertEqual(self.find(self.groups, "Steps 8-9, repeated")["depth"], 2)

    def test_a_block_owns_every_step_it_runs(self):
        outer = self.find(self.groups, "Steps 4-12, repeated 999")
        # Selecting the outer block must select the nested steps too.
        self.assertEqual(outer["all_step_numbers"], [4, 5, 6, 7, 8, 9, 11])
        # while step_numbers stays the steps the block owns directly; here the
        # diagnostic sequence and the ageing block are both children.
        self.assertEqual(outer["step_numbers"], [])

    def test_no_step_is_claimed_by_two_nodes(self):
        seen: list[int] = []

        def walk(nodes):
            for node in nodes:
                seen.extend(node["step_numbers"])
                walk(node["children"])

        walk(self.groups)
        self.assertEqual(sorted(seen), sorted(set(seen)), "a step appears twice")
        # Every measuring step is represented exactly once; control steps are not.
        self.assertEqual(sorted(seen), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14])

    def test_a_loop_pointing_forwards_is_ignored(self):
        header = nested_header()
        header["Step.Step_Info.Step13.Limit.Other.Start_Step.Value"] = "99"
        groups = protocol.reconstruct_protocol(header, 5000.0)["groups"]
        # Malformed loops must not swallow the protocol or crash the tree.
        self.assertTrue(groups)
        self.assertTrue(any(g["summary"].startswith("Steps 8-11") for g in groups))


class StepFactsTests(unittest.TestCase):
    """Structured settings must say exactly what the summary line says."""

    def test_facts_cover_the_same_values_as_the_summary(self):
        for header in (synthetic_header(), nested_header()):
            result = protocol.reconstruct_protocol(header, nominal_capacity_mah=10)
            for step in result["steps"]:
                for fact in step["facts"]:
                    self.assertIn(
                        fact["value"],
                        step["summary"],
                        f"step {step['number']} fact {fact['key']} missing from summary",
                    )

    def test_a_cccv_charge_is_split_into_readable_parts(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        step = next(s for s in result["steps"] if s["type"] == "CCCV charge")
        facts = {fact["key"]: fact for fact in step["facts"]}
        self.assertEqual(facts["hold"]["label"], "Hold at")
        self.assertEqual(facts["hold"]["value"], "4.2 V")
        self.assertEqual(facts["until"]["value"], "C/20")

    def test_an_inferred_rate_is_marked_as_such(self):
        header = synthetic_header()
        # Drop the explicit rate so it has to be derived from current.
        del header["Step.Step_Info.Step1.Limit.Main.Rate.Value"]
        result = protocol.reconstruct_protocol(header, nominal_capacity_mah=10)
        rate = next(f for f in result["steps"][0]["facts"] if f["key"] == "rate")
        self.assertEqual(rate["note"], "inferred")

        explicit = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        rate = next(f for f in explicit["steps"][0]["facts"] if f["key"] == "rate")
        self.assertIsNone(rate["note"])

    def test_a_rest_reports_duration_rather_than_a_limit(self):
        result = protocol.reconstruct_protocol(synthetic_header(), nominal_capacity_mah=10)
        rest = next(s for s in result["steps"] if s["direction"] == "rest")
        keys = {fact["key"] for fact in rest["facts"]}
        self.assertIn("duration", keys)
        self.assertNotIn("limit", keys)
