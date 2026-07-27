import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STABLE_CONF = ROOT / "src-tauri" / "tauri.conf.json"
BETA_OVERLAY = ROOT / "src-tauri" / "tauri.beta.conf.json"
BUILD_SCRIPT = ROOT / "scripts" / "build-app.ps1"
PACKAGE_JSON = ROOT / "package.json"
NSIS = ROOT / "src-tauri" / "cellxplorer-installer.nsi"
APP_UPDATES_RS = ROOT / "src-tauri" / "src" / "app_updates.rs"


def deep_merge(base: dict, overlay: dict) -> dict:
    merged = json.loads(json.dumps(base))
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


class AppChannelConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.stable = json.loads(STABLE_CONF.read_text(encoding="utf-8"))
        self.overlay = json.loads(BETA_OVERLAY.read_text(encoding="utf-8"))
        self.beta = deep_merge(self.stable, self.overlay)

    def test_stable_identity_matrix_unchanged(self):
        self.assertEqual(self.stable["productName"], "CellXplorer")
        self.assertEqual(self.stable["identifier"], "com.cellxplorer.desktop")
        self.assertEqual(self.stable["app"]["windows"][0]["title"], "CellXplorer")
        self.assertEqual(
            self.stable["plugins"]["deep-link"]["desktop"]["schemes"],
            ["cellxplorer"],
        )
        self.assertEqual(self.stable["bundle"]["icon"], ["icons/icon.ico"])

    def test_resolved_beta_config_matches_identity_matrix(self):
        self.assertEqual(self.beta["productName"], "CellXplorer Beta")
        self.assertEqual(self.beta["identifier"], "com.cellxplorer.desktop.beta")
        self.assertEqual(self.beta["app"]["windows"][0]["title"], "CellXplorer Beta")
        self.assertEqual(
            self.beta["plugins"]["deep-link"]["desktop"]["schemes"],
            ["cellxplorer-beta"],
        )
        self.assertEqual(self.beta["bundle"]["icon"], ["icons-beta/icon.ico"])
        self.assertEqual(
            self.beta["bundle"]["windows"]["nsis"]["installerIcon"],
            "icons-beta/icon.ico",
        )

    def test_both_channels_share_nsis_template_and_sidecar(self):
        for config in (self.stable, self.beta):
            self.assertEqual(
                config["bundle"]["windows"]["nsis"]["template"],
                "cellxplorer-installer.nsi",
            )
            self.assertEqual(
                config["bundle"]["externalBin"],
                ["binaries/cellxplorer-backend"],
            )

    def test_build_script_supports_explicit_channels(self):
        script = BUILD_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('[ValidateSet("stable", "beta")]', script)
        self.assertIn('[string]$Channel = "stable"', script)
        self.assertIn("VITE_CELLXPLORER_CHANNEL", script)
        self.assertIn("frontend_channel.py", script)
        self.assertIn("tauri.beta.conf.json", script)
        self.assertIn("--no-sign", script)
        self.assertIn("$expectedInstallerName", script)

    def test_package_json_exposes_channel_build_scripts(self):
        scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
        self.assertEqual(scripts["tauri:build:stable"], "python scripts/frontend_channel.py verify --channel stable && tauri build")
        self.assertEqual(
            scripts["tauri:build:beta"],
            "python scripts/frontend_channel.py verify --channel beta && tauri build --config src-tauri/tauri.beta.conf.json",
        )
        self.assertEqual(scripts["build:frontend:stable"], "python scripts/build_frontend_channel.py stable")
        self.assertEqual(scripts["build:frontend:beta"], "python scripts/build_frontend_channel.py beta")

    def test_nsis_hooks_scope_process_cleanup_to_install_dir(self):
        hooks = (ROOT / "src-tauri" / "nsis-hooks.nsh").read_text(encoding="utf-8")
        self.assertIn("StartsWith", hooks)
        self.assertIn("$INSTDIR", hooks)
        self.assertNotIn("taskkill /F /T /IM cellxplorer.exe", hooks)
        self.assertNotIn("taskkill /F /T /IM cellxplorer-backend.exe", hooks)
        self.assertNotIn("/IM cellxplorer.exe", hooks)

    def test_beta_update_commands_are_fail_closed_until_spec_023(self):
        source = APP_UPDATES_RS.read_text(encoding="utf-8")
        self.assertIn("reject_beta_channel_updates", source)
        self.assertIn("Spec 023", source)
        self.assertIn("reject_beta_channel_updates(&app)?;", source)

    def test_nsis_template_is_shared(self):
        nsis = NSIS.read_text(encoding="utf-8")
        self.assertIn("PRODUCTNAME", nsis)
        self.assertNotIn("CellXplorer Beta", nsis)


if __name__ == "__main__":
    unittest.main()
