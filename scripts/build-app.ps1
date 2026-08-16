[CmdletBinding()]
param(
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",
    [switch]$SkipInstall,
    [switch]$SkipFrontend,
    [switch]$SkipBackend,
    [switch]$SkipInstaller,
    # Rebuild the sidecar even when the Python sources are unchanged.
    [switch]$ForceBackend
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:CARGO_TARGET_DIR = Join-Path $repoRoot "src-tauri\target"
$frontendRoot = Join-Path $repoRoot "frontend"
# PyInstaller --onedir output: a folder (launcher exe + _internal/), not one file.
# onefile re-extracted 85 MB to %TEMP% on every launch; onedir loads from disk and
# is scanned by Defender once at install (spec 030). Staged as a Tauri resource,
# not an externalBin sidecar, because sidecars must be a single file.
$backendDistDir = Join-Path $repoRoot "dist\cellxplorer-backend"
$backendExe = Join-Path $backendDistDir "cellxplorer-backend.exe"
$sidecarDir = Join-Path $repoRoot "src-tauri\binaries\backend"
$sidecarExe = Join-Path $sidecarDir "cellxplorer-backend.exe"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )

    if (-not $WorkingDirectory) {
        $WorkingDirectory = $repoRoot
    }

    Write-Host "`n> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    Push-Location $WorkingDirectory
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
        Pop-Location
    }
}

function Get-BackendFingerprint {
    <#
        Hash everything PyInstaller bakes into the sidecar: the Python sources,
        the entry point, the pinned requirements and the bundled assets. The
        sidecar is by far the slowest stage (~70s) and changes least often, so
        skipping it when nothing it contains has changed is the single biggest
        saving on a repeat package. Hashing contents rather than trusting
        timestamps means a stale sidecar cannot be shipped by accident.
    #>
    $roots = @("backend", "packaging") | ForEach-Object { Join-Path $repoRoot $_ } | Where-Object { Test-Path $_ }
    $files = Get-ChildItem -Path $roots -Recurse -File -Include *.py, *.txt, *.js, *.json |
        Where-Object { $_.FullName -notmatch '\\(__pycache__|\.pytest_cache)\\' } |
        Sort-Object FullName
    $lines = foreach ($file in $files) {
        $relative = $file.FullName.Substring($repoRoot.Length).TrimStart('\')
        "$relative=$((Get-FileHash $file.FullName -Algorithm SHA256).Hash)"
    }
    # The build command itself is part of the identity: changing PyInstaller
    # flags must invalidate the stamp even when no source file moved.
    $lines += "cmd=$((Get-Content (Join-Path $repoRoot 'package.json') -Raw))"
    $joined = [string]::Join("`n", $lines)
    $stream = [System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($joined))
    (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
}

Write-Host "CellXplorer application build" -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"
Write-Host "Channel: $Channel" -ForegroundColor Cyan

$tauriConf = Get-Content (Join-Path $repoRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$betaConfPath = Join-Path $repoRoot "src-tauri\tauri.beta.conf.json"
if ($Channel -eq "beta") {
    if (-not (Test-Path $betaConfPath)) {
        throw "Missing beta Tauri overlay: $betaConfPath"
    }
    $betaConf = Get-Content $betaConfPath -Raw | ConvertFrom-Json
    $productName = $betaConf.productName
} else {
    $productName = $tauriConf.productName
}
$appVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
$expectedInstallerName = "$productName" + "_${appVersion}_x64-setup.exe"

if (-not $SkipInstall) {
    Write-Host "Installing root npm dependencies..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund") $repoRoot

    Write-Host "Installing frontend npm dependencies..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund") $frontendRoot
}

if (-not $SkipFrontend) {
    Write-Host "Building the frontend..." -ForegroundColor Yellow
    $previousChannel = $env:VITE_CELLXPLORER_CHANNEL
    $env:VITE_CELLXPLORER_CHANNEL = $Channel
    try {
        Invoke-Checked "npm.cmd" @("run", "build") $frontendRoot
        Invoke-Checked "python" @("scripts/frontend_channel.py", "write", "--channel", $Channel) $repoRoot
    }
    finally {
        if ($null -eq $previousChannel) {
            Remove-Item Env:VITE_CELLXPLORER_CHANNEL -ErrorAction SilentlyContinue
        } else {
            $env:VITE_CELLXPLORER_CHANNEL = $previousChannel
        }
    }
}
else {
    if (-not $SkipInstaller) {
        Write-Host "Verifying frontend channel stamp..." -ForegroundColor Yellow
        Invoke-Checked "python" @("scripts/frontend_channel.py", "verify", "--channel", $Channel) $repoRoot
    }
    else {
        Write-Host "Skipping frontend channel verification for backend-only build." -ForegroundColor DarkGray
    }
}

if (-not $SkipBackend) {
    # Stamp sits beside the folder, not inside it, so the bundled resource is
    # exactly PyInstaller's output with nothing extra.
    $stampFile = Join-Path $repoRoot "src-tauri\binaries\backend.stamp"
    $fingerprint = Get-BackendFingerprint
    $current = if (Test-Path $stampFile) { (Get-Content $stampFile -Raw).Trim() } else { "" }

    if (-not $ForceBackend -and (Test-Path $sidecarExe) -and $current -eq $fingerprint) {
        Write-Host "Backend sidecar is up to date; skipping PyInstaller." -ForegroundColor Green
        Write-Host "  (use -ForceBackend to rebuild it anyway)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "Building the Python backend sidecar..." -ForegroundColor Yellow
        Invoke-Checked "npm.cmd" @("run", "build:backend") $repoRoot

        if (-not (Test-Path $backendExe)) {
            throw "PyInstaller did not create $backendExe"
        }

        # Replace the staged folder wholesale so a removed file in a rebuild cannot
        # linger. The parent (binaries/) is gitignored.
        if (Test-Path $sidecarDir) { Remove-Item $sidecarDir -Recurse -Force }
        New-Item -ItemType Directory -Force $sidecarDir | Out-Null
        Copy-Item (Join-Path $backendDistDir "*") $sidecarDir -Recurse -Force
        # Stamp only after the copy succeeds, so an interrupted build re-runs.
        Set-Content -Path $stampFile -Value $fingerprint -Encoding utf8
        Write-Host "Staged backend folder to $sidecarDir" -ForegroundColor Green
    }
}
elseif (-not (Test-Path $sidecarExe)) {
    throw "The backend folder is missing. Run without -SkipBackend first: $sidecarExe"
}

if (-not $SkipInstaller) {
    Write-Host "Verifying frontend channel stamp before packaging..." -ForegroundColor Yellow
    Invoke-Checked "python" @("scripts/frontend_channel.py", "verify", "--channel", $Channel) $repoRoot

    Write-Host "Building the Windows installer..." -ForegroundColor Yellow
    $tauriArgs = @("tauri", "build")
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        Write-Host "No TAURI_SIGNING_PRIVATE_KEY; using --no-sign for local packaging." -ForegroundColor Yellow
        $tauriArgs += "--no-sign"
    }
    if ($Channel -eq "beta") {
        $tauriArgs += @("--config", "src-tauri/tauri.beta.conf.json")
    }
    Invoke-Checked "npx.cmd" $tauriArgs $repoRoot

    $installerDir = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
    $installer = Get-ChildItem $installerDir -Filter $expectedInstallerName -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $installer) {
        throw "Tauri did not create the expected installer: $expectedInstallerName"
    }

    Write-Host "`nInstaller created:" -ForegroundColor Green
    Write-Host $installer.FullName -ForegroundColor Green
}

Write-Host "`nBuild complete." -ForegroundColor Green
