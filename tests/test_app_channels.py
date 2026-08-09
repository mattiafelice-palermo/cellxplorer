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
MAIN_RS = ROOT / "src-tauri" / "src" / "main.rs"
RELAUNCH_RS = ROOT / "src-tauri" / "src" / "relaunch.rs"
BETA_BOOTSTRAP_RS = ROOT / "src-tauri" / "src" / "beta_bootstrap.rs"
BETA_BOOTSTRAP_COORDINATOR = (
    ROOT / "frontend" / "src" / "components" / "BetaBootstrapCoordinator.tsx"
)


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

    def test_both_channels_share_nsis_template_and_backend_resource(self):
        # Spec 030: the backend ships as a PyInstaller onedir folder bundled as a
        # resource, not a single-file externalBin sidecar (onefile re-extracted
        # 85 MB to temp on every launch).
        for config in (self.stable, self.beta):
            self.assertEqual(
                config["bundle"]["windows"]["nsis"]["template"],
                "cellxplorer-installer.nsi",
            )
            self.assertNotIn(
                "externalBin",
                config["bundle"],
                "externalBin is single-file; the onedir backend must be a resource.",
            )
            self.assertEqual(
                config["bundle"]["resources"],
                {"binaries/backend": "binaries/backend"},
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
        helper = (
            ROOT / "src-tauri" / "kill_installation_processes.ps1"
        ).read_text(encoding="utf-8")
        template = (
            ROOT / "src-tauri" / "cellxplorer-installer.nsi"
        ).read_text(encoding="utf-8")
        self.assertIn("kill_installation_processes.ps1", hooks)
        self.assertIn("StartsWith", helper)
        self.assertIn("$protectedProcessIds", helper)
        self.assertIn("ParentProcessId", helper)
        self.assertIn("[switch]$BackendOnly", helper)
        self.assertIn('-like "cellxplorer-backend*.exe"', helper)
        self.assertIn("$quietChecksRequired = 5", helper)
        self.assertIn("$quietChecks -lt $quietChecksRequired", helper)
        self.assertIn('KillInstallationProcesses "-BackendOnly"', hooks)
        self.assertNotIn("[System.IO.File]::Open", helper)
        self.assertIn("$INSTDIR", hooks)
        combined = hooks + helper
        self.assertNotIn("taskkill /F /T /IM cellxplorer.exe", combined)
        self.assertNotIn("taskkill /F /T /IM cellxplorer-backend.exe", combined)
        self.assertNotIn("/IM cellxplorer.exe", combined)
        self.assertIn("Var RunCurrentUninstaller", template)
        self.assertIn(
            'WriteUninstaller "$PLUGINSDIR\\cellxplorer-current-uninstall.exe"',
            template,
        )
        self.assertIn("StrCpy $RunCurrentUninstaller 1", template)

    def test_stable_and_beta_updater_endpoints_are_channel_specific(self):
        stable = json.loads(STABLE_CONF.read_text(encoding="utf-8"))
        beta = deep_merge(stable, json.loads(BETA_OVERLAY.read_text(encoding="utf-8")))
        stable_endpoint = stable["plugins"]["updater"]["endpoints"][0]
        beta_endpoint = beta["plugins"]["updater"]["endpoints"][0]
        self.assertIn("release-channels/stable/latest.json", stable_endpoint)
        self.assertIn("release-channels/beta/latest.json", beta_endpoint)
        self.assertNotIn("/releases/latest/", stable_endpoint)
        self.assertNotIn("/releases/latest/", beta_endpoint)

    def test_beta_self_updater_gate_is_removed(self):
        source = APP_UPDATES_RS.read_text(encoding="utf-8")
        self.assertNotIn("reject_beta_channel_updates", source)

    def test_nsis_template_is_shared(self):
        nsis = NSIS.read_text(encoding="utf-8")
        self.assertIn("PRODUCTNAME", nsis)
        self.assertNotIn("CellXplorer Beta", nsis)

    def test_nsis_branding_is_channel_specific(self):
        nsis = NSIS.read_text(encoding="utf-8")
        self.assertIn('!define CX_BRAND_RGB "3678B7"', nsis)
        self.assertIn("!define CX_BRAND_COLORREF 0x00B77836", nsis)
        self.assertIn('!define CX_BRAND_RGB "12B886"', nsis)
        self.assertIn("!define CX_BRAND_COLORREF 0x0086B812", nsis)
        self.assertGreaterEqual(nsis.count("${CX_BRAND_RGB}"), 8)
        self.assertIn("${CX_BRAND_COLORREF}", nsis)
        self.assertEqual(nsis.count('"12B886"'), 1)
        self.assertEqual(nsis.count("0x0086B812"), 1)

    def test_each_installer_run_records_a_new_installation_identity(self):
        nsis = NSIS.read_text(encoding="utf-8")
        main = MAIN_RS.read_text(encoding="utf-8")
        rust = BETA_BOOTSTRAP_RS.read_text(encoding="utf-8")
        self.assertIn("ole32::CoCreateGuid", nsis)
        self.assertIn('"InstallInstanceId" "$CxInstallInstanceId"', nsis)
        self.assertIn("current_beta_install_instance_id()", main)
        self.assertIn('"CELLXPLORER_INSTALL_INSTANCE_ID"', main)
        self.assertIn('"installInstanceId": install_instance_id', rust)

    def test_restart_helper_precedes_tauri_and_is_shared(self):
        main = MAIN_RS.read_text(encoding="utf-8")
        helper = RELAUNCH_RS.read_text(encoding="utf-8")
        self.assertLess(
            main.index("relaunch::run_if_requested()"),
            main.index("tauri::generate_context!()"),
        )
        self.assertEqual(main.count("relaunch::schedule_relaunch()?"), 2)
        self.assertIn("--relaunch-after-pid", helper)
        self.assertIn("OpenProcess", helper)
        self.assertIn("WaitForSingleObject", helper)
        self.assertNotIn("Start-Sleep", main)
        self.assertNotIn("AppHandle::restart()", main)

    def test_beta_bootstrap_checksum_buffer_stays_off_tauri_thread_stack(self):
        source = BETA_BOOTSTRAP_RS.read_text(encoding="utf-8")
        self.assertIn("vec![0_u8; 1024 * 1024]", source)
        self.assertNotIn("let mut buffer = [0_u8; 1024 * 1024]", source)

    def test_retry_activation_requires_and_forwards_overwrite_confirmation(self):
        main = MAIN_RS.read_text(encoding="utf-8")
        rust = BETA_BOOTSTRAP_RS.read_text(encoding="utf-8")
        frontend = BETA_BOOTSTRAP_COORDINATOR.read_text(encoding="utf-8")
        self.assertIn("confirm_replace_existing_beta: bool", main)
        self.assertIn("validate_staged_copy_for_activation", rust)
        self.assertIn(
            'invoke("apply_beta_bootstrap", { token, confirmReplaceExistingBeta })',
            frontend,
        )
        self.assertIn("applyToken(token, hasExistingBeta && confirmReplace)", frontend)
        self.assertIn("if (hasExistingBeta && !confirmReplace)", frontend)
        self.assertNotIn(
            "if (hasExistingBeta && !confirmReplace && !outstandingToken)",
            frontend,
        )
        self.assertIn('typeof error === "string" && error.trim()', frontend)

    def test_beta_first_render_gate_uses_the_installation_marker(self):
        main = MAIN_RS.read_text(encoding="utf-8")
        rust = BETA_BOOTSTRAP_RS.read_text(encoding="utf-8")
        frontend_main = (ROOT / "frontend" / "src" / "main.tsx").read_text(
            encoding="utf-8"
        )
        coordinator = BETA_BOOTSTRAP_COORDINATOR.read_text(encoding="utf-8")
        self.assertIn("beta_bootstrap_gate_required", main)
        self.assertIn("bootstrap_gate_required", main)
        self.assertIn("scientific_preparation_pending", rust)
        self.assertIn(
            'invoke<boolean>("beta_bootstrap_gate_required")',
            frontend_main,
        )
        self.assertIn(
            "gateRequiredOnLaunch || devMock === \"loading\"",
            coordinator,
        )
        self.assertIn("Continue in background", coordinator)

    def test_beta_chrome_uses_channel_colors_without_redefining_semantic_teal(self):
        main = (ROOT / "frontend" / "src" / "main.tsx").read_text(encoding="utf-8")
        update_modal = (
            ROOT / "frontend" / "src" / "components" / "AppUpdateModal.tsx"
        ).read_text(encoding="utf-8")
        beta_modal = (
            ROOT / "frontend" / "src" / "components" / "BetaInstallModal.tsx"
        ).read_text(encoding="utf-8")
        self.assertNotIn("teal: [...betaBlue]", main)
        self.assertGreaterEqual(update_modal.count("APP_BRANDING.primaryColor"), 7)
        self.assertNotIn('color="teal"', update_modal)
        self.assertNotIn('color="teal"', beta_modal)

        chrome_only = [
            "features/analyses/database/AnalysisDatabaseTable.tsx",
            "features/analyses/workspace/AnalysisWorkspaceTabs.tsx",
            "components/CellLibraryColumnMenu.tsx",
            "components/CellSamplePopovers.tsx",
            "components/CommandPalette.tsx",
            "components/DcirPlotCard.tsx",
            "components/FilenameTemplateEditor.tsx",
            "components/FolderTree.module.css",
            "components/FolderTree.tsx",
            "components/RecognitionProgress.tsx",
            "components/StepsPlotCard.tsx",
        ]
        for relative in chrome_only:
            with self.subTest(relative=relative):
                source = (
                    ROOT / "frontend" / "src" / Path(relative)
                ).read_text(encoding="utf-8")
                self.assertNotIn("teal", source)

        mixed_semantics = [
            "pages/AnalysisPage.tsx",
            "pages/InboxPage.tsx",
            "pages/LibraryPage.tsx",
            "pages/ProjectsPage.tsx",
        ]
        for relative in mixed_semantics:
            with self.subTest(relative=relative):
                source = (
                    ROOT / "frontend" / "src" / Path(relative)
                ).read_text(encoding="utf-8")
                self.assertNotIn("--mantine-color-teal", source)
                self.assertNotIn('"teal.0"', source)

        protocol_segments = (
            ROOT / "frontend" / "src" / "components" / "ProtocolSegmentsPanel.tsx"
        ).read_text(encoding="utf-8")
        protocol_viewer = (
            ROOT / "frontend" / "src" / "components" / "ProtocolStructureViewer.tsx"
        ).read_text(encoding="utf-8")
        self.assertEqual(protocol_segments.count("--mantine-color-teal"), 1)
        self.assertEqual(protocol_viewer.count("--mantine-color-teal"), 1)
        self.assertIn('charge: "var(--mantine-color-teal-6)"', protocol_segments)
        self.assertIn('charge: "var(--mantine-color-teal-6)"', protocol_viewer)

    def test_nsis_destructive_uninstall_targets_channel_specific_data_root(self):
        nsis = NSIS.read_text(encoding="utf-8")
        self.assertIn('!define CX_PROFILE_DATA_DIR ".cellxplorer-beta"', nsis)
        self.assertIn('!define CX_PROFILE_DATA_DIR ".cellxplorer"', nsis)
        self.assertIn('com.cellxplorer.desktop.beta', nsis)
        self.assertIn('com.cellxplorer.desktop', nsis)
        self.assertIn(r'RmDir /r "$PROFILE\${CX_PROFILE_DATA_DIR}"', nsis)
        self.assertIn(r'"$PROFILE\${CX_PROFILE_DATA_DIR}"', nsis)
        self.assertNotIn(r'RmDir /r "$PROFILE\.cellxplorer"', nsis)
        self.assertNotIn(r'"$PROFILE\.cellxplorer"', nsis)
        self.assertIn("Unsupported CellXplorer bundle identifier for profile data directory", nsis)


if __name__ == "__main__":
    unittest.main()
