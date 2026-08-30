import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCOPE_SCRIPT = ROOT / "src-tauri" / "installation_process_scope.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


class InstallationProcessScopeTests(unittest.TestCase):
    def test_process_ownership_boundary_and_protected_ids(self):
        if POWERSHELL is None:
            self.skipTest("PowerShell is required for the process-scope contract probe")

        script_path = str(SCOPE_SCRIPT).replace("'", "''")
        command = rf"""
. '{script_path}'
$prefix = Get-InstallationProcessPathPrefix -InstallDir 'C:/Apps/CellXplorer/'
$uncPrefix = Get-InstallationProcessPathPrefix -InstallDir '\\server/share/CellXplorer/'
$protected = [System.Collections.Generic.HashSet[int]]::new()
$null = $protected.Add(42)
[ordered]@{{
    exact = Test-InstallationProcessCandidate -ProcessId 1 -ExecutablePath 'C:\Apps\CellXplorer\cellxplorer.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected
    sibling = Test-InstallationProcessCandidate -ProcessId 2 -ExecutablePath 'C:\Apps\CellXplorer Beta\cellxplorer.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected
    caseInsensitive = Test-InstallationProcessCandidate -ProcessId 3 -ExecutablePath 'c:\apps\cellxplorer\CELLXPLORER.EXE' -InstallPathPrefix $prefix -ProtectedProcessIds $protected
    separatorNormalized = Test-InstallationProcessCandidate -ProcessId 4 -ExecutablePath 'C:/Apps/CellXplorer/cellxplorer.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected
    prefixCollision = Test-InstallationProcessCandidate -ProcessId 5 -ExecutablePath 'C:\Apps\CellXplorer-old\cellxplorer.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected
    protected = Test-InstallationProcessCandidate -ProcessId 42 -ExecutablePath 'C:\Apps\CellXplorer\cellxplorer.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected
    backendOnly = Test-InstallationProcessCandidate -ProcessId 6 -ExecutablePath 'C:\Apps\CellXplorer\cellxplorer-backend-1.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected -BackendOnly
    backendOnlyRejectsMain = Test-InstallationProcessCandidate -ProcessId 7 -ExecutablePath 'C:\Apps\CellXplorer\cellxplorer.exe' -InstallPathPrefix $prefix -ProtectedProcessIds $protected -BackendOnly
    uncExact = Test-InstallationOwnedExecutablePath -ExecutablePath '\\SERVER\SHARE\CELLXPLORER\cellxplorer.exe' -InstallPathPrefix $uncPrefix
    uncSibling = Test-InstallationOwnedExecutablePath -ExecutablePath '\\server\share\CellXplorer Beta\cellxplorer.exe' -InstallPathPrefix $uncPrefix
}} | ConvertTo-Json -Compress
"""
        result = subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            self.fail(
                "PowerShell process-scope probe failed:\n"
                f"stdout={result.stdout}\nstderr={result.stderr}"
            )

        observed = json.loads(result.stdout)
        self.assertEqual(
            observed,
            {
                "exact": True,
                "sibling": False,
                "caseInsensitive": True,
                "separatorNormalized": True,
                "prefixCollision": False,
                "protected": False,
                "backendOnly": True,
                "backendOnlyRejectsMain": False,
                "uncExact": True,
                "uncSibling": False,
            },
        )


if __name__ == "__main__":
    unittest.main()
