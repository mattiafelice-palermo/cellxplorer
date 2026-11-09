[CmdletBinding()]
param(
    [ValidateRange(1, 65535)] [int]$BackendPort = 8642,
    [ValidateRange(1, 65535)] [int]$FrontendPort = 5173,
    [switch]$NoBrowser,
    [switch]$SkipInstall,
    [switch]$StopExisting
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$frontendRoot = Join-Path $repoRoot "frontend"
$startedProcesses = @()

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )

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

function Test-LocalPort {
    param([int]$Port)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(300)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Get-ListeningPortOwnerIds {
    param([int]$Port)

    $connections = @()
    try {
        $connections = @(
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        )
    }
    catch {
        # CIM may be unavailable even though TCP itself works. The independent
        # netstat lookup below must still run in that case.
    }
    $ownerIds = @(
        $connections |
            Where-Object { $_.OwningProcess -gt 0 } |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($ownerIds.Count -gt 0) {
        return $ownerIds
    }

    # Get-NetTCPConnection is available on supported Windows versions, but keep a
    # netstat fallback so the prompt can still identify the process on a restricted
    # PowerShell installation.
    $netstatLines = @(netstat.exe -ano -p tcp 2>$null)
    foreach ($line in $netstatLines) {
        if ($line -match '^\s*TCP\s+\S+:([0-9]+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$matches[1] -eq $Port -and [int]$matches[2] -gt 0) {
            [int]$matches[2]
        }
    }
}

function Find-AvailableWebappPort {
    param([int]$PreferredPort, [int[]]$ReservedPorts = @())

    for ($offset = 1; $offset -le 100; $offset++) {
        $candidatePort = (($PreferredPort - 1 + $offset) % 65535) + 1
        if ($ReservedPorts -contains $candidatePort) { continue }
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidatePort)
        try {
            $listener.ExclusiveAddressUse = $true
            $listener.Start()
            return $candidatePort
        }
        catch {
            # Try the next port; do not alter its existing owner.
        }
        finally {
            $listener.Stop()
        }
    }
    throw "No available local port found near $PreferredPort. Pass an explicit alternative port."
}

function Get-PortOwners {
    param([int]$Port)

    $ownerIds = @(Get-ListeningPortOwnerIds $Port | Select-Object -Unique)
    foreach ($ownerId in $ownerIds) {
        $process = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
        $cimProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        [PSCustomObject]@{
            ProcessId = [int]$ownerId
            ProcessName = if ($process) { $process.ProcessName } else { "PID $ownerId" }
            ExecutablePath = if ($cimProcess) { $cimProcess.ExecutablePath } else { $null }
            CommandLine = if ($cimProcess) { $cimProcess.CommandLine } else { $null }
        }
    }
}

function Wait-ForLocalPortClosed {
    param([int]$Port)

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-LocalPort $Port)) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Port $Port is still in use after the selected process was stopped."
}

function Stop-WebappProcessTree {
    param([int]$ProcessId)
    if ($ProcessId -eq $PID) { throw "Refusing to stop the launcher itself (PID $PID)." }
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        throw "Could not stop process tree $ProcessId. Check its permissions."
    }
}

function Ensure-WebappPortAvailable {
    param([int]$Port, [string]$Name, [string]$PortOption, [switch]$StopExisting, [int[]]$ReservedPorts = @())

    if (-not (Test-LocalPort $Port)) {
        return $Port
    }

    $owners = @(Get-PortOwners $Port)
    if ($owners.Count -eq 0) {
        $alternativePort = Find-AvailableWebappPort -PreferredPort $Port -ReservedPorts $ReservedPorts
        Write-Host "$Name port $Port is already in use, but Windows could not identify its owner. The existing process will remain running." -ForegroundColor Yellow
        if ($StopExisting) {
            throw "Cannot safely stop an unidentified owner of $Name port $Port. Pass -$PortOption $alternativePort to use an available port."
        }
        $answer = (Read-Host "Use available $Name port $alternativePort instead? [y/N]").Trim()
        if ($answer -notmatch '^(?i:y|yes)$') {
            throw "$Name port $Port remains in use. Pass -$PortOption $alternativePort to use an available port."
        }
        Write-Host "Using $Name port $alternativePort. Continuing startup..." -ForegroundColor Green
        return $alternativePort
    }

    Write-Host "$Name port $Port is already in use by:" -ForegroundColor Yellow
    foreach ($owner in $owners) {
        $details = @($owner.ProcessName, "PID $($owner.ProcessId)") -join ", "
        if ($owner.ExecutablePath) {
            $details += ", $($owner.ExecutablePath)"
        }
        elseif ($owner.CommandLine) {
            $details += ", $($owner.CommandLine)"
        }
        Write-Host "  $details"
    }

    $answer = if ($StopExisting) { "yes" } else { (Read-Host "Stop the process tree using $Name port $Port and continue? [y/N]").Trim() }
    if ($answer -notmatch '^(?i:y|yes)$') {
        throw "$Name port $Port remains in use. Stop the existing server or pass -$PortOption with another port."
    }

    foreach ($owner in $owners) {
        Write-Host "Stopping $($owner.ProcessName) (PID $($owner.ProcessId)) ..." -ForegroundColor Yellow
        try {
            Stop-WebappProcessTree $owner.ProcessId
        }
        catch {
            throw "Could not stop $($owner.ProcessName) (PID $($owner.ProcessId)): $($_.Exception.Message)"
        }
    }

    Wait-ForLocalPortClosed $Port
    Write-Host "$Name port $Port is available. Continuing startup..." -ForegroundColor Green
    return $Port
}

function Wait-ForLocalPort {
    param(
        [int]$Port,
        [System.Diagnostics.Process]$Process,
        [string]$Name
    )

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "$Name stopped before port $Port became available."
        }
        if (Test-LocalPort $Port) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "$Name did not open port $Port within 45 seconds."
}

function Start-ChildCommand {
    param(
        [Parameter(Mandatory = $true)] [string]$CommandLine,
        [Parameter(Mandatory = $true)] [string]$WorkingDirectory
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "cmd.exe"
    $startInfo.Arguments = "/d /c `"$CommandLine`""
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($startInfo)
}

try {
    if ($BackendPort -eq $FrontendPort) { throw "Backend and frontend must use different ports." }
    $BackendPort = Ensure-WebappPortAvailable -Port $BackendPort -Name "Backend" -PortOption "BackendPort" -StopExisting:$StopExisting -ReservedPorts @($FrontendPort)
    $FrontendPort = Ensure-WebappPortAvailable -Port $FrontendPort -Name "Frontend" -PortOption "FrontendPort" -StopExisting:$StopExisting -ReservedPorts @($BackendPort)

    # Use this checkout's optional portable tools when present; no global PATH changes.
    foreach ($environment in @("venv312", "venv")) {
        $pythonScripts = Join-Path $repoRoot ".codex\$environment\Scripts"
        if (Test-Path (Join-Path $pythonScripts "python.exe")) {
            $env:PATH = "$pythonScripts;$env:PATH"
            break
        }
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        $nodeRoot = Get-ChildItem (Join-Path $repoRoot ".codex\tools") -Directory -Filter "node-*-win-x64" -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "npm.cmd") } | Select-Object -First 1
        if ($nodeRoot) { $env:PATH = "$($nodeRoot.FullName);$env:PATH" }
    }

    if ([string]::IsNullOrWhiteSpace($env:CELLXPLORER_DATA)) {
        $env:CELLXPLORER_DATA = Join-Path $repoRoot "data\development"
    }
    Write-Host "Development data: $env:CELLXPLORER_DATA"

    $rootModules = Join-Path $repoRoot "node_modules"
    $frontendModules = Join-Path $frontendRoot "node_modules"
    if (-not (Test-Path $rootModules) -or -not (Test-Path $frontendModules)) {
        if ($SkipInstall) {
            throw "npm dependencies are missing. Run without -SkipInstall once to install them."
        }
        Write-Host "Installing missing npm dependencies..." -ForegroundColor Yellow
        Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund") $repoRoot
        Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund") $frontendRoot
    }

    Write-Host "Starting backend on http://127.0.0.1:$BackendPort ..." -ForegroundColor Yellow
    $backend = Start-ChildCommand "set CELLXPLORER_PORT=$BackendPort&& python run.py" $repoRoot
    $startedProcesses += $backend

    Write-Host "Starting Vite frontend on http://127.0.0.1:$FrontendPort ..." -ForegroundColor Yellow
    $viteCommand = "set VITE_BACKEND_PORT=$BackendPort&& npm.cmd run dev -- --host 127.0.0.1 --port $FrontendPort --strictPort"
    $frontend = Start-ChildCommand $viteCommand $frontendRoot
    $startedProcesses += $frontend

    Wait-ForLocalPort $BackendPort $backend "Backend"
    Wait-ForLocalPort $FrontendPort $frontend "Frontend"

    $url = "http://127.0.0.1:$FrontendPort"
    Write-Host "`nCellXplorer is running at $url" -ForegroundColor Green
    Write-Host "Backend API: http://127.0.0.1:$BackendPort/api"
    Write-Host "Press Ctrl+C to stop both processes.`n"

    if (-not $NoBrowser) {
        Start-Process $url | Out-Null
    }

    while ($true) {
        if ($backend.HasExited) {
            throw "The backend stopped unexpectedly."
        }
        if ($frontend.HasExited) {
            throw "The frontend stopped unexpectedly."
        }
        Start-Sleep -Seconds 1
    }
}
finally {
    foreach ($process in $startedProcesses) {
        if ($process -and -not $process.HasExited) {
            try { Stop-WebappProcessTree $process.Id } catch { Write-Warning $_.Exception.Message }
        }
    }

}
