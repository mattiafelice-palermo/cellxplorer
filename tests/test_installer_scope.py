"""Read-only contracts; native signed UAC acceptance is a separate matrix."""
import json
import os
import subprocess
from pathlib import Path
import unittest

from scripts.check_installer_scope import render_template

ROOT = Path(__file__).resolve().parents[1]


class InstallerScopeTests(unittest.TestCase):
    def setUp(self):
        self.nsis = (ROOT / "src-tauri/cellxplorer-installer.nsi").read_text()
        self.scope = (ROOT / "src-tauri/installation_scope.nsh").read_text()
        self.rust = (ROOT / "src-tauri/src/installation_scope.rs").read_text()
        self.updates = (ROOT / "src-tauri/src/app_updates.rs").read_text()

    def test_fresh_manifest_is_user_and_explicit_machine_action_elevates(self):
        conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        self.assertEqual(conf["bundle"]["windows"]["nsis"]["installMode"], "currentUser")
        self.assertIn("RequestExecutionLevel user", self.nsis)
        self.assertNotIn("RequestExecutionLevel admin", self.nsis)
        self.assertNotIn("MULTIUSER_EXECUTIONLEVEL Highest", self.nsis)
        self.assertIn('ExecShell "runas" "$EXEPATH" "/CXALLUSERS"', self.scope)
        self.assertIn('$LOCALAPPDATA\\${PRODUCTNAME}', self.scope)
        self.assertIn('StrCpy $INSTDIR $CxMachineDir', self.scope)
        self.assertIn('StrCpy $INSTDIR $CxUserDir', self.scope)

    def test_discovery_checks_both_views_and_original_user_hive_and_preserves_compare(self):
        self.assertIn('SetRegView 64', self.scope)
        self.assertIn('SetRegView 32', self.scope)
        self.assertIn('${OrIf} $CxElevated != 1', self.scope)
        self.assertIn('StrCpy $CxCompareDir $CxRecordDir', self.scope)
        self.assertIn('${If} $CxCompareDir != $CxRecordDir', self.scope)
        self.assertIn('${AndIf} $CxMachineDir != ""', self.scope)
        self.assertIn('"InstallScope"', self.scope)
        self.assertIn('"BundleId"', self.scope)

    def test_directory_and_scope_selectors_are_crosschecks(self):
        self.assertIn('${If} $CxRecordDir != $INSTDIR', self.scope)
        self.assertNotIn('StrCpy $INSTDIR $CxExpectedDir', self.scope)
        self.assertIn('${AndIf} $CxExisting != 1', self.scope)
        self.assertIn('GetFullPathNameW', self.scope)
        self.assertIn('${If} $3 ==', self.scope)
        self.assertIn('Choose a local folder writable', self.nsis)

    def test_update_child_scope_directory_and_update_flag_precede_final_directory(self):
        child = self.nsis.split('${If} $RunCurrentUninstaller = 1', 1)[1].split('!ifmacrodef NSIS_HOOK_PREINSTALL', 1)[0]
        self.assertIn('${If} $4 != $INSTDIR', child)
        self.assertIn('Call CxNormalizeDirectory', child)
        self.assertIn('StrCpy $R1 "$R1 /CXALLUSERS"', child)
        self.assertIn('StrCpy $R1 "$R1 /UPDATE"', child)
        self.assertLess(child.index('/UPDATE'), child.index('_?=$4'))
        self.assertNotIn('ExecWait "$INSTDIR\\uninstall.exe"', child)

    def test_uninstall_removes_authenticated_registration_in_both_views_preserving_data(self):
        self.assertIn('Call un.CxDiscoverScope', self.nsis)
        self.assertIn('Call un.CxRemoveRegistration', self.nsis)
        cleanup = self.scope.split('Function un.CxRemoveRegistration\n', 1)[1]
        self.assertIn('SetRegView 64', cleanup)
        self.assertIn('SetRegView 32', cleanup)
        self.assertIn('${If} $CxRecordDir != $INSTDIR', cleanup)
        self.assertIn('DeleteRegValue SHCTX "${MANUPRODUCTKEY}" ""', cleanup)
        data = self.nsis.split('; Delete app data if the checkbox is selected', 1)[1]
        self.assertIn('${AndIf} $UpdateMode <> 1', data)
        self.assertIn('${AndIf} $CxScope == "user"', data)
        self.assertIn('Var CxStartupState', self.nsis)
        startup = self.nsis.split('; Apply choices from the branded setup page.', 1)[1]
        self.assertIn('${If} $CxScope == "user"', startup)

    def test_checked_handoff_happens_before_shutdown_and_failure_restores_verified_bytes(self):
        handoff = self.updates.split('let handoff =', 1)[1]
        self.assertLess(handoff.index('launch_verified_update'), handoff.index('prepare_exit_for_update'))
        self.assertIn('restore_failed_install(&mut pending, update, bytes)', handoff)
        self.assertIn('create_new(true)', self.rust)
        self.assertIn('share_mode(1)', self.rust)
        self.assertIn('if staged != bytes', self.rust)
        self.assertIn('if info.hProcess.is_null()', self.rust)
        self.assertIn('ERROR_CANCELLED', self.rust)
        self.assertIn('command.encode_utf16().count() > 700', self.rust)
        self.assertIn('parameters.encode_utf16().count() + 4 >= 1000', self.rust)
        self.assertIn('.download(', self.updates)

    def test_restart_uses_original_user_and_trusted_process_scoped_helper(self):
        self.assertIn('RunAsUser "$WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', self.nsis)
        self.assertIn('-ExecutionPolicy Bypass -File "$INSTDIR\\restart_application.ps1"', self.nsis)
        script = (ROOT / 'src-tauri/restart_application.ps1').read_text()
        self.assertIn("$PSScriptRoot 'cellxplorer.exe'", script)
        self.assertIn('$start.UseShellExecute = $false', script)
        self.assertNotIn('Invoke-Expression', script)
        self.assertIn('ConvertFrom-Json', script)
        self.assertIn('ArgumentsHex.Length -gt 65536', script)

    def test_compile_renderer_preserves_nested_conditionals_alias_and_fails_unknown_tokens(self):
        source = '{{#if flag}}a{{#each items as |item|}}{{item}}{{/each}}{{else}}b{{/if}}'
        self.assertEqual(render_template(source, {'flag': True, 'items': ['x', 'y']}), 'axy')
        self.assertEqual(render_template(source, {'flag': False, 'items': []}), 'b')
        with self.assertRaises(ValueError): render_template('{{unrecognized}}', {})

    @unittest.skipUnless(os.name == 'nt', 'Windows command-line parser')
    def test_restart_helper_preserves_special_application_arguments_without_launching_app(self):
        import ctypes
        script = (ROOT / 'src-tauri/restart_application.ps1').read_text()
        function = script.split('function Quote-Argument', 1)[1].split('$quoted =', 1)[0]
        values = ['simple', '', 'space & ` $(literal)', 'quote"backslash\\', 'end\\', 'Unicode €日本', '/CXALLUSERS']
        data = json.dumps(values, ensure_ascii=False).replace("'", "''")
        command = "function Quote-Argument" + function + f"\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$values = ConvertFrom-Json -InputObject '{data}'\n$quoted = @(foreach ($value in $values) {{ Quote-Argument $value }})\n[Console]::WriteLine((ConvertTo-Json -InputObject $quoted -Compress))"
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        quoted = json.loads(result.stdout)
        count = ctypes.c_int()
        parser = ctypes.windll.shell32.CommandLineToArgvW
        parser.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
        parser.restype = ctypes.POINTER(ctypes.c_wchar_p)
        parsed = parser('fixture.exe ' + ' '.join(quoted), ctypes.byref(count))
        try:
            roundtrip = [parsed[i] for i in range(1, count.value)]
            self.assertEqual(roundtrip, values)
        finally:
            ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
            ctypes.windll.kernel32.LocalFree(parsed)


if __name__ == '__main__': unittest.main()
