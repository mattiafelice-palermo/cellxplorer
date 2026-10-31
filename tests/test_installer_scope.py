"""Read-only contracts; native signed UAC acceptance is a separate matrix."""
import base64
import json
import os
import subprocess
import time
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
        recovery = (ROOT / 'src-tauri/src/update_recovery.rs').read_text()
        handoff = self.updates.split('let handoff =', 1)[1]
        self.assertLess(handoff.index('prepare_verified_recovery'), handoff.index('prepared.commit()'))
        self.assertLess(handoff.index('prepared.commit()'), handoff.index('prepare_exit_for_update'))
        self.assertLess(handoff.index('prepared.commit()'), handoff.index('prepared.authorize_exit()'))
        self.assertLess(handoff.index('prepared.authorize_exit()'), handoff.index('prepare_exit_for_update'))
        shutdown = handoff.split('crate::prepare_exit_for_update(&app);', 1)[1].split('Err(error) =>', 1)[0]
        self.assertNotIn('restore_failed_install', shutdown)
        self.assertNotIn('return Err', shutdown)
        ack_only = recovery.split('pub fn commit(', 1)[1].split('pub fn authorize_exit(', 1)[0]
        self.assertNotIn('b"E"', ack_only)
        self.assertIn('self.acknowledged = true', ack_only)
        self.assertIn('if !self.acknowledged || !self.is_alive()', recovery)
        self.assertNotIn('running_installation(', handoff)
        self.assertIn('restore_failed_install(&mut pending, update, bytes)', handoff)
        self.assertIn('create_new(true)', recovery)
        self.assertIn('share_mode(1)', recovery)
        self.assertIn('if actual != bytes', recovery)
        self.assertIn('GetNamedPipeClientProcessId', recovery)
        self.assertIn('authenticate_peer(&pipe, &path)', recovery)
        self.assertIn('b\'A\'', recovery)
        self.assertNotIn('registered_records(', recovery)
        self.assertIn('origin.encode_utf16().count() * 2 > 700', recovery)
        self.assertIn('parameters.encode_utf16().count() + 4 >= 1000', recovery)
        self.assertIn('.download(', self.updates)

    def test_typed_terminal_error_requires_disarmed_pre_exit_ownership(self):
        command = self.updates.split('pub async fn install_app_update(', 1)[1].split('#[cfg(test)]', 1)[0]
        self.assertIn('Result<(), InstallAppUpdateFailure>', command)
        self.assertIn('pending.require_idle_install_handoff()?;', command)
        failure = command.split('if let Err(error) = prepared.authorize_exit()', 1)[1].split('// Final consent', 1)[0]
        self.assertLess(failure.index('drop(prepared)'), failure.index('InstallAppUpdateFailure::aborted'))
        self.assertLess(command.index('prepared.authorize_exit()'), command.index('prepare_exit_for_update'))
        irreversible = command.split('crate::prepare_exit_for_update(&app);', 1)[1].split('return Ok(());', 1)[0]
        self.assertNotIn('return Err', irreversible)
        self.assertIn('std::mem::forget(prepared)', irreversible)

    def test_restart_uses_original_user_and_trusted_process_scoped_helper(self):
        self.assertIn('RunAsUser "$INSTDIR\\cellxplorer-installer-helper.exe"', self.nsis)
        self.assertIn("'--restart $CxRestartArgs'", self.nsis)
        self.assertNotIn('RunAsUser "$WINDIR\\System32\\WindowsPowerShell', self.nsis)
        source = (ROOT / 'scripts/installer_helper/src/main.rs').read_text()
        policy = (ROOT / 'scripts/installer_helper/src/policy.rs').read_text(encoding='utf-8')
        self.assertIn('directory.join("cellxplorer.exe")', source)
        self.assertIn('.current_dir(directory).args(arguments)', source)
        self.assertIn('windows_subsystem = "windows"', source)
        self.assertIn('creation_flags(0x0800_0000)', source)
        self.assertIn('Vec<String>', policy)
        self.assertIn('hex.len() > 65536', policy)
        self.assertIn('check_command_length', source)

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
        command = (
            "function Quote-Argument" + function
            + "\n$phaseWatch = [Diagnostics.Stopwatch]::StartNew()"
            + "\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)"
            + "\n$phase = 'convert-from-json'"
            + "\n[Console]::Error.WriteLine(('phase={0}; elapsed_ms={1:N0}' -f $phase, $phaseWatch.Elapsed.TotalMilliseconds))"
            + "\n[Console]::Error.Flush()"
            + f"\n$values = ConvertFrom-Json -InputObject '{data}'"
            + "\n$phase = 'quote-arguments'"
            + "\n[Console]::Error.WriteLine(('phase={0}; elapsed_ms={1:N0}' -f $phase, $phaseWatch.Elapsed.TotalMilliseconds))"
            + "\n[Console]::Error.Flush()"
            + "\n$workWatch = [Diagnostics.Stopwatch]::StartNew()"
            + "\n$quoted = @(foreach ($value in $values) { Quote-Argument $value })"
            + "\n$workWatch.Stop()"
            + "\n$quoteWorkMs = $workWatch.Elapsed.TotalMilliseconds"
            + "\nif ($quoteWorkMs -gt 10000) { [Console]::Error.WriteLine(('phase=quote-arguments-exceeded; elapsed_ms={0:N0}' -f $quoteWorkMs)); exit 124 }"
            + "\n$phase = 'emit-json'"
            + "\n[Console]::Error.WriteLine(('phase={0}; elapsed_ms={1:N0}' -f $phase, $phaseWatch.Elapsed.TotalMilliseconds))"
            + "\n[Console]::Error.Flush()"
            + "\n$payload = @{ quoted = $quoted; quote_work_ms = $quoteWorkMs }"
            + "\n[Console]::WriteLine((ConvertTo-Json -InputObject $payload -Compress))"
        )
        encoded_command = base64.b64encode(command.encode('utf-16le')).decode('ascii')
        process_startup_timeout_seconds = 30
        process_started = time.monotonic()
        try:
            result = subprocess.run(
                ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded_command],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=process_startup_timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            elapsed_ms = (time.monotonic() - process_started) * 1000
            captured_stdout = exc.stdout or ''
            captured_stderr = exc.stderr or ''
            if isinstance(captured_stdout, bytes):
                captured_stdout = captured_stdout.decode('utf-8', errors='replace')
            if isinstance(captured_stderr, bytes):
                captured_stderr = captured_stderr.decode('utf-8', errors='replace')
            phases = [line for line in captured_stderr.splitlines() if line.startswith('phase=')]
            last_phase = phases[-1] if phases else 'PowerShell startup (script body not entered)'
            self.fail(
                f'PowerShell exceeded the {process_startup_timeout_seconds}s process/startup budget '
                f'after {elapsed_ms:.0f} ms; last phase: {last_phase}; '
                f'stdout={captured_stdout[-2000:]!r}; stderr={captured_stderr[-2000:]!r}'
            )
        self.assertEqual(
            result.returncode,
            0,
            f'stdout={result.stdout[-2000:]!r}; stderr={result.stderr[-2000:]!r}',
        )
        payload = json.loads(result.stdout)
        quoted = payload['quoted']
        quote_work_ms = float(payload['quote_work_ms'])
        self.assertLessEqual(quote_work_ms, 10_000, f'PowerShell quoting exceeded 10s: {result.stderr}')
        count = ctypes.c_int()
        parser = ctypes.windll.shell32.CommandLineToArgvW
        parser.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
        parser.restype = ctypes.POINTER(ctypes.c_wchar_p)
        roundtrip_started = time.monotonic()
        parsed = parser('fixture.exe ' + ' '.join(quoted), ctypes.byref(count))
        try:
            roundtrip = [parsed[i] for i in range(1, count.value)]
        finally:
            ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
            ctypes.windll.kernel32.LocalFree(parsed)
        roundtrip_ms = (time.monotonic() - roundtrip_started) * 1000
        self.assertEqual(roundtrip, values)
        self.assertLessEqual(
            quote_work_ms + roundtrip_ms,
            10_000,
            f'Quote + Win32 round-trip work exceeded 10s: '
            f'quote={quote_work_ms:.1f} ms, roundtrip={roundtrip_ms:.1f} ms, '
            f'process={(time.monotonic() - process_started) * 1000:.1f} ms',
        )


if __name__ == '__main__': unittest.main()
