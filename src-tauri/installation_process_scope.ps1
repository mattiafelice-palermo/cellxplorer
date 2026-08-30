function Normalize-WindowsProcessPath {
    param(
        [AllowNull()]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    return $Path.Trim().Replace('/', '\')
}

function Get-InstallationProcessPathPrefix {
    param(
        [AllowNull()]
        [string]$InstallDir
    )

    $root = Normalize-WindowsProcessPath $InstallDir
    if ([string]::IsNullOrWhiteSpace($root)) {
        return $null
    }

    $root = $root.TrimEnd('\')
    if ([string]::IsNullOrWhiteSpace($root)) {
        return '\'
    }

    return "$root\"
}

function Test-InstallationOwnedExecutablePath {
    param(
        [AllowNull()]
        [string]$ExecutablePath,
        [Parameter(Mandatory = $true)]
        [string]$InstallPathPrefix
    )

    $candidate = Normalize-WindowsProcessPath $ExecutablePath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $false
    }

    return $candidate.StartsWith($InstallPathPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-BackendExecutablePath {
    param(
        [AllowNull()]
        [string]$ExecutablePath
    )

    $candidate = Normalize-WindowsProcessPath $ExecutablePath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $false
    }

    $fileName = $candidate.Substring($candidate.LastIndexOf('\') + 1)
    return $fileName -like 'cellxplorer-backend*.exe'
}

function Test-InstallationProcessCandidate {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [AllowNull()]
        [string]$ExecutablePath,
        [Parameter(Mandatory = $true)]
        [string]$InstallPathPrefix,
        [Parameter(Mandatory = $true)]
        $ProtectedProcessIds,
        [switch]$BackendOnly
    )

    if (-not (Test-InstallationOwnedExecutablePath -ExecutablePath $ExecutablePath -InstallPathPrefix $InstallPathPrefix)) {
        return $false
    }

    if ($ProtectedProcessIds.Contains($ProcessId)) {
        return $false
    }

    if ($BackendOnly) {
        return Test-BackendExecutablePath $ExecutablePath
    }

    return $true
}
