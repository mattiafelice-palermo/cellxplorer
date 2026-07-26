import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAURI_CONF = ROOT / "src-tauri" / "tauri.conf.json"
CARGO_TOML = ROOT / "src-tauri" / "Cargo.toml"
MAIN_RS = ROOT / "src-tauri" / "src" / "main.rs"
APP_UPDATES_RS = ROOT / "src-tauri" / "src" / "app_updates.rs"
CAPABILITIES = ROOT / "src-tauri" / "capabilities" / "default.json"
NSIS = ROOT / "src-tauri" / "cellxplorer-installer.nsi"

EXPECTED_ENDPOINT = (
    "https://github.com/mattiafelice-palermo/cellxplorer/releases/latest/download/latest.json"
)
PLACEHOLDER_PATTERNS = (
    "CONTENT FROM PUBLICKEY.PEM",
    "your public key",
    "placeholder",
    "changeme",
)


class UpdaterConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
        self.cargo = CARGO_TOML.read_text(encoding="utf-8")
        self.main_rs = MAIN_RS.read_text(encoding="utf-8")
        self.app_updates_rs = APP_UPDATES_RS.read_text(encoding="utf-8")
        self.capabilities = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        self.nsis = NSIS.read_text(encoding="utf-8")

    def test_bundle_builds_updater_artifacts(self):
        self.assertTrue(self.conf["bundle"]["createUpdaterArtifacts"])

    def test_updater_endpoint_is_public_https_github_release(self):
        endpoints = self.conf["plugins"]["updater"]["endpoints"]
        self.assertEqual(endpoints, [EXPECTED_ENDPOINT])
        self.assertTrue(endpoints[0].startswith("https://"))

    def test_insecure_transport_is_not_enabled(self):
        updater = self.conf["plugins"]["updater"]
        self.assertNotIn("dangerousInsecureTransportProtocol", updater)
        self.assertNotIn("dangerousAcceptInvalidCerts", updater)
        self.assertNotIn("dangerousAcceptInvalidHostnames", updater)

    def test_windows_install_mode_is_basic_ui(self):
        install_mode = self.conf["plugins"]["updater"]["windows"]["installMode"]
        self.assertEqual(install_mode, "basicUi")

    def test_committed_public_key_is_real(self):
        pubkey = self.conf["plugins"]["updater"]["pubkey"]
        self.assertIsInstance(pubkey, str)
        self.assertGreater(len(pubkey.strip()), 40)
        lowered = pubkey.lower()
        for pattern in PLACEHOLDER_PATTERNS:
            self.assertNotIn(pattern.lower(), lowered)
        self.assertFalse(Path(pubkey).exists())

    def test_rust_updater_dependency_is_at_least_2_10(self):
        match = re.search(r'tauri-plugin-updater\s*=\s*"([^"]+)"', self.cargo)
        self.assertIsNotNone(match, "tauri-plugin-updater dependency is missing")
        version = match.group(1)
        if version.startswith("2."):
            minor = int(version.split(".", 2)[1])
            self.assertGreaterEqual(minor, 10)

    def test_custom_commands_and_state_are_registered(self):
        for needle in (
            "tauri_plugin_updater::Builder::new().build()",
            "app_updates::check_app_update",
            "app_updates::download_app_update",
            "app_updates::install_app_update",
            "PendingAppUpdate",
            "prepare_exit_for_update",
            "on_before_exit",
        ):
            self.assertIn(needle, self.main_rs + self.app_updates_rs)

    def test_frontend_does_not_get_broad_updater_permissions(self):
        permissions = self.capabilities["permissions"]
        self.assertFalse(any(permission.startswith("updater:") for permission in permissions))

    def test_nsis_recognizes_updater_and_update_flags(self):
        self.assertIn('${GetOptions} $CMDLINE "/UPDATER" $UpdateMode', self.nsis)
        self.assertIn('${GetOptions} $CMDLINE "/UPDATE" $UpdateMode', self.nsis)
        self.assertIn("StrCpy $UpdateMode 1", self.nsis)


if __name__ == "__main__":
    unittest.main()
