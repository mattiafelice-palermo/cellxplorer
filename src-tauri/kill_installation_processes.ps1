param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = "SilentlyContinue"
$root = $InstallDir.TrimEnd('\', '/')
if (-not $root) {
    exit 0
}

$prefix = "$root\"
Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    & taskkill.exe /F /T /PID $_.ProcessId | Out-Null
}

Start-Sleep -Milliseconds 400
