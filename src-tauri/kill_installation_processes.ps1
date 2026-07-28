param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,

    [switch]$BackendOnly
)

$ErrorActionPreference = "Stop"
$root = $InstallDir.TrimEnd('\', '/')
if (-not $root) {
    exit 0
}

$prefix = "$root\"

# NSIS may run uninstall.exe directly from $INSTDIR when another installer
# launches it with _?=<install-dir>. The PowerShell helper is its child, so a
# blanket install-directory kill would terminate the uninstaller itself before
# it can remove files and registry entries. Protect this helper's complete
# ancestor chain; all ordinary app/backend processes remain eligible.
$processSnapshot = @(Get-CimInstance Win32_Process)
$protectedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$ancestorProcessId = [int]$PID
while ($ancestorProcessId -gt 0 -and $protectedProcessIds.Add($ancestorProcessId)) {
    $ancestor = $processSnapshot |
        Where-Object { [int]$_.ProcessId -eq $ancestorProcessId } |
        Select-Object -First 1
    if (-not $ancestor) {
        break
    }
    $ancestorProcessId = [int]$ancestor.ParentProcessId
}

function Get-InstallationOwnedProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
        if (
            -not $_.ExecutablePath -or
            -not $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
            $protectedProcessIds.Contains([int]$_.ProcessId)
        ) {
            return $false
        }

        if ($BackendOnly) {
            return [System.IO.Path]::GetFileName($_.ExecutablePath) -like "cellxplorer-backend*.exe"
        }

        return $true
    })
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
$quietChecksRequired = 5
$quietChecks = 0
do {
    $owned = @(Get-InstallationOwnedProcesses)
    foreach ($process in $owned) {
        & taskkill.exe /F /T /PID $process.ProcessId | Out-Null
    }
    if ($owned.Count -gt 0) {
        $quietChecks = 0
    }
    else {
        $quietChecks += 1
    }
    if ($quietChecks -lt $quietChecksRequired) {
        Start-Sleep -Milliseconds 200
    }
} while ($quietChecks -lt $quietChecksRequired -and [DateTime]::UtcNow -lt $deadline)

$remaining = @(Get-InstallationOwnedProcesses)
if ($remaining.Count -gt 0 -or $quietChecks -lt $quietChecksRequired) {
    Write-Error "CellXplorer processes did not stop and remain absent long enough to release their executable files."
    exit 1
}
