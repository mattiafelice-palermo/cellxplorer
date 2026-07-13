import os
import sys
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
