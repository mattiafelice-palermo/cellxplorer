[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipFrontend,
    [switch]$SkipBackend,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$frontendRoot = Join-Path $repoRoot "frontend"
$backendExe = Join-Path $repoRoot "dist\cellxplorer-backend.exe"
$sidecarExe = Join-Path $repoRoot "src-tauri\binaries\cellxplorer-backend-x86_64-pc-windows-msvc.exe"

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
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "CellXplorer application build" -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"

if (-not $SkipInstall) {
    Write-Host "Installing root npm dependencies..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund") $repoRoot

    Write-Host "Installing frontend npm dependencies..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund") $frontendRoot
}

if (-not $SkipFrontend) {
    Write-Host "Building the frontend..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("run", "build") $frontendRoot
}

if (-not $SkipBackend) {
    Write-Host "Building the Python backend sidecar..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("run", "build:backend") $repoRoot

    if (-not (Test-Path $backendExe)) {
        throw "PyInstaller did not create $backendExe"
    }

    New-Item -ItemType Directory -Force (Split-Path $sidecarExe) | Out-Null
    Copy-Item $backendExe $sidecarExe -Force
    Write-Host "Copied backend sidecar to $sidecarExe" -ForegroundColor Green
}
elseif (-not (Test-Path $sidecarExe)) {
    throw "The sidecar is missing. Run without -SkipBackend first: $sidecarExe"
}

if (-not $SkipInstaller) {
    Write-Host "Building the Windows installer..." -ForegroundColor Yellow
    Invoke-Checked "npm.cmd" @("run", "tauri:build") $repoRoot

    $installer = Get-ChildItem (Join-Path $repoRoot "src-tauri\target\release\bundle\nsis") `
        -Filter "*-setup.exe" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) {
        throw "Tauri did not create an NSIS installer."
    }

    Write-Host "`nInstaller created:" -ForegroundColor Green
    Write-Host $installer.FullName -ForegroundColor Green
}

Write-Host "`nBuild complete." -ForegroundColor Green
