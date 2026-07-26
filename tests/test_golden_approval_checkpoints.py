"""Fail-closed tests for Spec 015's manual approval checkpoints."""
from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PRIOR_DATA_ROOT = os.environ.get("CELLXPLORER_DATA")
MODULE_DATA_ROOT = Path(tempfile.mkdtemp(prefix="golden-approval-test-"))
os.environ["CELLXPLORER_DATA"] = str(MODULE_DATA_ROOT)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

import golden_analysis_support  # noqa: E402

MODULE_SPEC = importlib.util.spec_from_file_location(
    "verify_golden_approval_checkpoints",
    ROOT / "scripts" / "verify_golden_approval_checkpoints.py",
)
assert MODULE_SPEC and MODULE_SPEC.loader
approval = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(approval)


class GoldenApprovalCheckpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            cls.env = golden_analysis_support.GoldenFixtureEnvironment.create(
                data_root=MODULE_DATA_ROOT,
            )
            cls.inputs = approval.load_checkpoint_inputs(cls.env)
        except Exception:
            shutil.rmtree(MODULE_DATA_ROOT, ignore_errors=True)
            golden_analysis_support.restore_data_root_binding(PRIOR_DATA_ROOT)
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.env.close()
        finally:
            shutil.rmtree(MODULE_DATA_ROOT, ignore_errors=True)
            golden_analysis_support.restore_data_root_binding(PRIOR_DATA_ROOT)

    def test_all_seven_baseline_checkpoints_match(self) -> None:
        report = approval.build_checkpoint_report(self.inputs)
        self.assertEqual(approval.checkpoint_failures(report), [])

    def test_each_mutated_checkpoint_input_fails_the_command_evaluator(self) -> None:
        mutations = {
            "checkpoint_1_cc_cv_capacity": lambda expected: expected[
                "cycles_baseline"
            ]["cell_series"][0]["quantities"]["charge_capacity_mah"].__setitem__(
                0, 999.0
            ),
            "checkpoint_2_efficiency_ce": lambda expected: expected[
                "cycles_baseline"
            ]["cell_series"][0]["quantities"][
                "coulombic_efficiency_pct"
            ].__setitem__(0, 1.0),
            "checkpoint_2_efficiency_ee": lambda expected: expected[
                "cycles_baseline"
            ]["cell_series"][0]["quantities"][
                "energy_efficiency_pct"
            ].__setitem__(0, 1.0),
            "checkpoint_3_time_capacity_reset": lambda expected: expected[
                "time_capacity_baseline"
            ]["cell_traces"][0]["capacity_mah"].__setitem__(200, None),
            "checkpoint_4_steps_duration": lambda expected: expected[
                "steps_baseline"
            ]["cell_series"][0]["quantities"]["block_duration_h"].__setitem__(
                0, 1.0
            ),
            "checkpoint_5_dcir": lambda expected: expected["dcir_baseline"][
                "cell_series"
            ][0]["quantities"]["dcir_mohm"].__setitem__(0, 1.0),
            "checkpoint_6_chargeability": lambda expected: expected[
                "chargeability_baseline"
            ]["matches"][0].__setitem__("reference_capacity_mah", 1.0),
            "checkpoint_7_rate_capability": lambda expected: expected[
                "rate_capability_baseline"
            ]["comparison"].__setitem__("reference_rate_c", 9.0),
        }
        for name, mutation in mutations.items():
            checkpoint = name.removesuffix("_ce").removesuffix("_ee")
            with self.subTest(mutation=name):
                report = approval.report_with_expected_mutation(
                    self.inputs,
                    mutation,
                )
                self.assertIs(report[checkpoint]["match"], False)
                self.assertIn(
                    checkpoint,
                    approval.checkpoint_failures(report),
                )

    def test_privacy_report_includes_unknown_flattened_header_fields(self) -> None:
        manifest = {
            "sources": [
                {
                    "key": "example",
                    "binary_path": "sources/example.ndax",
                    "sha256": "0" * 64,
                }
            ]
        }
        header = {
            "barcode": "batch-1",
            "raw": {
                "UnexpectedOwnerLabel": "someone@example.test",
                "Nested": {"FreeText": "complete"},
            },
        }
        with mock.patch(
            "app.services.parsing.read_header_metadata",
            return_value=header,
        ):
            report = golden_analysis_support.inspect_binary_privacy(
                manifest,
                ROOT / "tests" / "fixtures" / "golden_analysis",
            )
        source = report["sources"][0]
        fields = {
            item["path"]: item["value"]
            for item in source["flattened_header_fields"]
        }
        self.assertEqual(report["schema_version"], 2)
        self.assertEqual(source["flattened_header_field_count"], 3)
        self.assertEqual(
            fields["$.raw.UnexpectedOwnerLabel"],
            "someone@example.test",
        )
        self.assertEqual(fields["$.raw.Nested.FreeText"], "complete")


if __name__ == "__main__":
    unittest.main()
