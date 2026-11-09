"""Exercise launcher port ownership with disposable native listeners only."""
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe")


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell required")
class LauncherPortTests(unittest.TestCase):
    def listener(self):
        process = subprocess.Popen(
            [sys.executable, "-u", "-c", "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(60)"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        return process, int(process.stdout.readline().strip())

    def run_functions(self, commands):
        path = str(ROOT / "scripts" / "start-webapp.ps1").replace("'", "''")
        prelude = f"""$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null;
$ast=[System.Management.Automation.Language.Parser]::ParseFile('{path}',[ref]$tokens,[ref]$errors);
if ($errors.Count) {{ throw ($errors | Out-String) }};
$ast.FindAll({{ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }},$false) | ForEach-Object {{ Invoke-Expression $_.Extent.Text }};
"""
        return subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", prelude + commands], capture_output=True, text=True, timeout=40, creationflags=subprocess.CREATE_NO_WINDOW)

    def test_both_selected_ports_are_released(self):
        backend, backend_port = self.listener()
        frontend, frontend_port = self.listener()
        result = self.run_functions(
            f"Ensure-WebappPortAvailable -Port {backend_port} -Name Backend -PortOption BackendPort -StopExisting; "
            f"Ensure-WebappPortAvailable -Port {frontend_port} -Name Frontend -PortOption FrontendPort -StopExisting"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        backend.wait(timeout=5)
        frontend.wait(timeout=5)
        self.assertIn(f"Backend port {backend_port} is available", result.stdout)
        self.assertIn(f"Frontend port {frontend_port} is available", result.stdout)

    def test_declining_preserves_listener(self):
        process, port = self.listener()
        result = self.run_functions(
            "function Read-Host { 'n' }; "
            f"Ensure-WebappPortAvailable -Port {port} -Name Frontend -PortOption FrontendPort"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"Frontend port {port} remains in use", result.stderr)
        self.assertIsNone(process.poll())

    def test_launcher_cannot_kill_itself(self):
        result = self.run_functions("Stop-WebappProcessTree $PID")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing to stop the launcher itself", result.stderr)

    def test_unidentified_listener_can_use_another_port_without_stopping_it(self):
        process, port = self.listener()
        reserved, reserved_port = self.listener()
        result = self.run_functions(
            "function Get-PortOwners { @() }; function Read-Host { 'y' }; "
            "function Stop-WebappProcessTree { throw 'must not stop anything' }; "
            f"$chosen = Ensure-WebappPortAvailable -Port {port} -Name Backend -PortOption BackendPort -ReservedPorts @({reserved_port}); "
            f"if ($chosen -eq {port} -or $chosen -eq {reserved_port}) {{ throw 'conflicting port selected' }}; "
            "$probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $chosen); "
            "try { $probe.ExclusiveAddressUse=$true; $probe.Start() } finally { $probe.Stop() }; "
            "Write-Host 'Alternative verified'"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Alternative verified", result.stdout)
        self.assertIsNone(process.poll())
        self.assertIsNone(reserved.poll())

    def test_unidentified_listener_decline_preserves_process(self):
        process, port = self.listener()
        result = self.run_functions(
            "function Get-PortOwners { @() }; function Read-Host { 'n' }; "
            f"Ensure-WebappPortAvailable -Port {port} -Name Backend -PortOption BackendPort"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"Backend port {port} remains in use", result.stderr)
        self.assertIsNone(process.poll())

    def test_stop_existing_cannot_stop_an_unidentified_listener(self):
        process, port = self.listener()
        result = self.run_functions(
            "function Get-PortOwners { @() }; function Read-Host { throw 'must not prompt' }; "
            "function Stop-WebappProcessTree { throw 'must not stop anything' }; "
            f"Ensure-WebappPortAvailable -Port {port} -Name Backend -PortOption BackendPort -StopExisting"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot safely stop an unidentified owner", result.stderr)
        self.assertIsNone(process.poll())

    def test_cim_failure_still_uses_netstat_and_rejects_pid_zero(self):
        result = self.run_functions(
            "function Get-NetTCPConnection { throw 'CIM unavailable' }; "
            "function netstat.exe { ' TCP 127.0.0.1:8642 0.0.0.0:0 LISTENING 123'; "
            "' TCP 127.0.0.1:8642 0.0.0.0:0 LISTENING 0'; ' TCP 127.0.0.1:8643 0.0.0.0:0 LISTENING 456' }; "
            "$owners = @(Get-ListeningPortOwnerIds 8642); "
            "if ($owners.Count -ne 1 -or $owners[0] -ne 123) { throw 'incorrect owner selection' }"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_port_search_skips_a_reserved_available_port(self):
        _process, port = self.listener()
        result = self.run_functions(
            f"$first = Find-AvailableWebappPort {port}; "
            f"$second = Find-AvailableWebappPort {port} -ReservedPorts @($first); "
            "if ($first -eq $second) { throw 'reserved port reused' }"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
