import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"
PREFLIGHT_WORKFLOW = ROOT / ".github" / "workflows" / "preflight.yml"

TAURI_ACTION_SHA = "1deb371b0cd8bd54025b384f1cd735e725c4060f"


class ReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        cls.preflight = PREFLIGHT_WORKFLOW.read_text(encoding="utf-8")

    def test_tag_trigger_exists_only_in_release_workflow(self):
        self.assertIn('tags:\n      - "v*"', self.release)
        self.assertNotIn("tags:", self.preflight)

    def test_preflight_still_runs_on_main_and_manual_dispatch(self):
        self.assertIn("branches:\n      - main", self.preflight)
        self.assertIn("workflow_dispatch:", self.preflight)

    def test_release_job_runs_on_windows(self):
        self.assertIn("runs-on: windows-latest", self.release)

    def test_release_workflow_has_contents_write(self):
        self.assertIn("contents: write", self.release)

    def test_release_preflight_uses_no_cache(self):
        self.assertIn("python scripts/preflight.py --no-cache", self.release)

    def test_release_runs_expected_version_gate_for_tags(self):
        self.assertIn(
            'python scripts/check_versions.py --expected-version "${{ github.ref_name }}"',
            self.release,
        )

    def test_pyinstaller_is_installed_in_release_workflow(self):
        self.assertIn("python -m pip install pyinstaller", self.release)

    def test_signing_secret_names_are_present_without_values(self):
        for name in (
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        ):
            self.assertIn(name, self.release)
            self.assertNotIn(f"{name}=", self.release)

    def test_tauri_action_is_pinned_to_full_sha(self):
        self.assertIn(f"tauri-apps/tauri-action@{TAURI_ACTION_SHA}", self.release)
        self.assertNotRegex(self.release, r"tauri-apps/tauri-action@v\d")

    def test_updater_json_prefers_nsis_and_disables_plain_binary(self):
        self.assertIn("updaterJsonPreferNsis: true", self.release)
        self.assertIn("uploadPlainBinary: false", self.release)
        self.assertIn("uploadUpdaterJson: true", self.release)
        self.assertIn("uploadUpdaterSignatures: true", self.release)

    def test_manual_dispatch_is_build_only_by_default(self):
        self.assertIn("workflow_dispatch:", self.release)
        self.assertIn("publish:", self.release)
        self.assertIn("default: false", self.release)
        self.assertIn("uploadWorkflowArtifacts: true", self.release)

    def test_sidecar_is_prepared_with_existing_build_script(self):
        self.assertIn(
            ".\\scripts\\build-app.ps1 -SkipInstall -SkipFrontend -SkipInstaller -ForceBackend",
            self.release,
        )


if __name__ == "__main__":
    unittest.main()
