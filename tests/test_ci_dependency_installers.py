import unittest
from pathlib import Path
import tempfile
import json
from unittest import mock

from scripts.compare_ci_installers import ROOT, UV_VERSION, pinned_requirements, validate_inventories
from scripts import compare_ci_installers


class DependencyInstallerTests(unittest.TestCase):
    def test_workflows_use_comparison_pin_and_equivalence_job_is_fatal(self):
        for name in ("preflight.yml", "release.yml"):
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertIn(f"uv=={UV_VERSION}", text)
        workflow = (ROOT / ".github/workflows/preflight.yml").read_text(encoding="utf-8")
        equivalence = workflow.split("  dependency-installer-equivalence:", 1)[1].split("  rust-cache-warm:", 1)[0]
        self.assertIn("scripts/compare_ci_installers.py", equivalence)
        self.assertNotIn("continue-on-error", equivalence)
        self.assertIn("if: always()", equivalence)
        self.assertIn("path: dependency-installer-equivalence.json", equivalence)

    def test_failed_install_records_phase_and_propagates_failure(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "report.json"
            with (mock.patch.object(compare_ci_installers, "run", side_effect=RuntimeError("installation failed")),
                  mock.patch.object(compare_ci_installers.tempfile, "mkdtemp", return_value=str(Path(root) / "scratch"))):
                with self.assertRaisesRegex(RuntimeError, "installation failed"):
                    compare_ci_installers.compare_environments(output)
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(report["verified"])
            self.assertEqual(report["phase"], "pip: create environment")
            self.assertIn("installation failed", report["error"])

    def test_exact_equivalence_with_only_pinned_tool(self):
        validate_inventories({"a": "1"}, {"a": "1", "uv": UV_VERSION}, {"a": "1"})

    def test_rejects_changed_missing_extra_or_wrong_tool_distribution(self):
        for installed in ({"a": "2", "uv": UV_VERSION}, {"uv": UV_VERSION}, {"a": "1", "b": "1", "uv": UV_VERSION}, {"a": "1", "uv": "0"}):
            with self.subTest(installed=installed), self.assertRaises(ValueError):
                validate_inventories({"a": "1"}, installed, {"a": "1"})

    def test_equal_inventories_still_must_match_required_pins(self):
        with self.assertRaises(ValueError):
            validate_inventories({"a": "2"}, {"a": "2", "uv": UV_VERSION}, {"a": "1"})

    def test_requirements_are_normalized_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "requirements.txt"
            path.write_text("A_b==1.0 # comment\n", encoding="utf-8")
            self.assertEqual(pinned_requirements([path]), {"a-b": "1.0"})
            for text in ("A>=1", "A==1\nA==2"):
                path.write_text(text, encoding="utf-8")
                with self.assertRaises(ValueError):
                    pinned_requirements([path])
