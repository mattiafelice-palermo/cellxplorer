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

EXPECTED_STABLE_ENDPOINT = (
    "https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/"
    "release-channels/stable/latest.json"
)
EXPECTED_BETA_ENDPOINT = (
    "https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/"
    "release-channels/beta/latest.json"
)
BETA_OVERLAY = ROOT / "src-tauri" / "tauri.beta.conf.json"
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
        self.assertEqual(endpoints, [EXPECTED_STABLE_ENDPOINT])
        self.assertTrue(endpoints[0].startswith("https://"))
        self.assertNotIn("/releases/latest/", endpoints[0])

    def test_resolved_beta_config_uses_beta_channel_endpoint(self):
        overlay = json.loads(BETA_OVERLAY.read_text(encoding="utf-8"))
        endpoints = overlay["plugins"]["updater"]["endpoints"]
        self.assertEqual(endpoints, [EXPECTED_BETA_ENDPOINT])
        self.assertNotIn("/releases/latest/", endpoints[0])

    def test_beta_self_updater_gate_is_removed(self):
        source = self.app_updates_rs
        self.assertNotIn("reject_beta_channel_updates", source)

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

    def test_beta_install_commands_are_registered(self):
        beta_installer_rs = (ROOT / "src-tauri" / "src" / "beta_installer.rs").read_text(
            encoding="utf-8"
        )
        for needle in (
            "beta_installer::detect_beta_installation",
            "beta_installer::check_beta_install",
            "beta_installer::download_beta_install",
            "beta_installer::install_beta",
            "beta_installer::open_beta_application",
            "PendingBetaInstall",
            "BETA_CHANNEL_ENDPOINT",
        ):
            self.assertIn(needle, self.main_rs + beta_installer_rs)
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

    def test_pending_update_state_is_managed_as_mutex(self):
        """Tauri resolves managed state by exact type; commands request Mutex<PendingAppUpdate>."""
        self.assertIn(
            "Mutex::new(PendingAppUpdate::default())",
            self.main_rs,
        )
        self.assertNotRegex(
            self.main_rs,
            r"\.manage\(\s*PendingAppUpdate::default\(\)\s*\)",
        )
        self.assertIn(
            "State<'_, Mutex<PendingAppUpdate>>",
            self.app_updates_rs,
        )
        self.assertGreaterEqual(
            self.app_updates_rs.count("State<'_, Mutex<PendingAppUpdate>>"),
            3,
        )

    def test_frontend_does_not_get_broad_updater_permissions(self):
        permissions = self.capabilities["permissions"]
        self.assertFalse(any(permission.startswith("updater:") for permission in permissions))

    def test_nsis_recognizes_updater_and_update_flags(self):
        self.assertIn('${GetOptions} $CMDLINE "/UPDATER" $UpdateMode', self.nsis)
        self.assertIn('${GetOptions} $CMDLINE "/UPDATE" $UpdateMode', self.nsis)
        self.assertIn("StrCpy $UpdateMode 1", self.nsis)

    def test_notification_plugin_and_window_command_are_wired(self):
        frontend_package = json.loads(
            (ROOT / "frontend" / "package.json").read_text(encoding="utf-8")
        )
        update_notifications_rs = (
            ROOT / "src-tauri" / "src" / "update_notifications.rs"
        ).read_text(encoding="utf-8")
        frontend_adapter = (
            ROOT / "frontend" / "src" / "updateNotifications.ts"
        ).read_text(encoding="utf-8")
        coordinator = (
            ROOT / "frontend" / "src" / "components" / "AppUpdateCoordinator.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn('notify-rust = "4.18"', self.cargo)
        self.assertNotIn("tauri-plugin-notification", self.cargo)
        self.assertNotIn(
            "@tauri-apps/plugin-notification",
            frontend_package.get("dependencies", {}),
        )
        self.assertNotIn("tauri_plugin_notification::init()", self.main_rs)
        self.assertIn("show_main_window_for_update", self.main_rs)
        self.assertIn(
            "show_main_window_for_update",
            self.main_rs.split("tauri::generate_handler!")[1],
        )
        self.assertIn("update_notifications::show_update_notification", self.main_rs)
        self.assertIn('UPDATE_NOTIFICATION_EVENT: &str = "app-update-notification-activated"', update_notifications_rs)
        self.assertIn("show_update_notification", update_notifications_rs)
        self.assertIn("listenForUpdateNotificationActivation", frontend_adapter)
        self.assertIn("listenForUpdateNotificationActivation", coordinator)
        self.assertNotIn("new Notification(", frontend_adapter)
        self.assertNotIn("notification.onclick", frontend_adapter)
        permissions = self.capabilities["permissions"]
        self.assertNotIn("notification:default", permissions)
        self.assertFalse(any(permission.startswith("updater:") for permission in permissions))
        self.assertFalse(
            any(
                permission.startswith("shell:")
                or permission.startswith("process:")
                or permission == "core:window:allow-create"
                for permission in permissions
            )
        )
        for needle in (
            "app_updates::check_app_update",
            "app_updates::download_app_update",
            "app_updates::install_app_update",
        ):
            self.assertIn(needle, self.main_rs)


if __name__ == "__main__":
    unittest.main()
