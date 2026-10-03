param([Parameter(Mandatory=$true)][string]$ArgumentsHex)
$ErrorActionPreference = 'Stop'
# Executed using Tauri's RunAsUser, never the installer's elevated user token.
# Only this installation's application can be launched; arguments are data.
if ($ArgumentsHex.Length -gt 65536 -or $ArgumentsHex.Length % 2 -ne 0 -or $ArgumentsHex -notmatch '^[0-9a-f]+$') { throw 'Invalid restart arguments.' }
$bytes = [byte[]]::new($ArgumentsHex.Length / 2)
for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($ArgumentsHex.Substring($i * 2, 2), 16) }
$arguments = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($bytes))
if ($arguments -isnot [array]) { throw 'Restart arguments must be a JSON array.' }
function Quote-Argument([string]$value) {
    if ($value.IndexOf([char]0) -ge 0) { throw 'Invalid restart argument.' }
    # Windows CommandLineToArgvW quoting: double slashes before quotes/end.
    '"' + [regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$quoted = foreach ($argument in $arguments) {
    if ($argument -isnot [string]) { throw 'Invalid restart argument type.' }
    Quote-Argument $argument
}
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $PSScriptRoot 'cellxplorer.exe'
$start.WorkingDirectory = $PSScriptRoot
$start.UseShellExecute = $false
$start.Arguments = $quoted -join ' '
[Diagnostics.Process]::Start($start) | Out-Null
