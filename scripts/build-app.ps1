[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipFrontend,
    [switch]$SkipBackend,
    [switch]$SkipInstaller,
    # Rebuild the sidecar even when the Python sources are unchanged.
    [switch]$ForceBackend
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
    $stampFile = "$sidecarExe.stamp"
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

        New-Item -ItemType Directory -Force (Split-Path $sidecarExe) | Out-Null
        Copy-Item $backendExe $sidecarExe -Force
        # Stamp only after the copy succeeds, so an interrupted build re-runs.
        Set-Content -Path $stampFile -Value $fingerprint -Encoding utf8
        Write-Host "Copied backend sidecar to $sidecarExe" -ForegroundColor Green
    }
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
