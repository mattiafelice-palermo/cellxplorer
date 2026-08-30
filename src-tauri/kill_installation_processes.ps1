param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,

    [switch]$BackendOnly
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "installation_process_scope.ps1")
$prefix = Get-InstallationProcessPathPrefix -InstallDir $InstallDir
if (-not $prefix) {
    throw "The installation directory is required for process cleanup."
}

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
        return Test-InstallationProcessCandidate `
            -ProcessId ([int]$_.ProcessId) `
            -ExecutablePath $_.ExecutablePath `
            -InstallPathPrefix $prefix `
            -ProtectedProcessIds $protectedProcessIds `
            -BackendOnly:$BackendOnly
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
