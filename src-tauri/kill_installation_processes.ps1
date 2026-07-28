param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"
$root = $InstallDir.TrimEnd('\', '/')
if (-not $root) {
    exit 0
}

$prefix = "$root\"
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    $owned = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($process in $owned) {
        & taskkill.exe /F /T /PID $process.ProcessId | Out-Null
    }
    if ($owned.Count -gt 0) {
        Start-Sleep -Milliseconds 200
    }
} while ($owned.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

$remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
})
if ($remaining.Count -gt 0) {
    Write-Error "CellXplorer processes did not stop in time."
    exit 1
}

$locked = @()
foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter "cellxplorer-backend*.exe" -File -ErrorAction SilentlyContinue)) {
    try {
        $stream = [System.IO.File]::Open(
            $file.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $stream.Dispose()
    }
    catch {
        $locked += $file.FullName
    }
}
if ($locked.Count -gt 0) {
    Write-Error "CellXplorer backend file locks did not clear in time."
    exit 1
}
