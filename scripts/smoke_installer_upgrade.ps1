param(
    [ValidateSet('stable', 'beta', 'alpha')][string]$Channel,
    [string]$Version,
    [string]$ReleaseId,
    # Internal worker entry point, always authenticated against the generated account plan.
    [ValidateSet('', 'user', 'machine')][string]$WorkerScope = '',
    [string]$Root,
    [switch]$ProfileProbe
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Remove-NativeCredentials {
    # Enumerate names only: never log secret values. Environment changes apply
    # to this controller process and every subsequently spawned native process.
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(GH_TOKEN|GITHUB_TOKEN|TAURI_SIGNING.*|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN.*|ID_TOKEN.*|GITHUB_(OUTPUT|ENV|PATH|STATE|STEP_SUMMARY))$') {
            Remove-Item -LiteralPath "Env:\$($entry.Name)"
        }
    }
}

function New-ControllerEvidence {
    $directory = Join-Path $env:RUNNER_TEMP ('cx-controller-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory | Out-Null
    $controller = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($controller)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($controller, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    # No worker SID, Users or Administrators grant; native-root Modify grants
    # below never apply to this separate protected sibling.
    return Join-Path $directory 'provenance.json'
}

function Assert-CI {
    Assert-True ($env:OS -eq 'Windows_NT' -and $env:GITHUB_ACTIONS -ceq 'true' -and
        $env:RUNNER_ENVIRONMENT -ceq 'github-hosted') 'Native installs are restricted to disposable GitHub-hosted Windows CI; never run locally.'
    Assert-True (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) 'RUNNER_TEMP required'
}

function Assert-TempRoot([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    Assert-True ($absolute.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $absolute -Leaf) -match '^cx-upgrade-[a-f0-9]{32}$') 'Gate root must be a unique RUNNER_TEMP child'
    Assert-True (-not ((Get-Item -LiteralPath $absolute).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Gate root cannot be a reparse point'
}

function Initialize-WorkerTemp([ValidateSet('user', 'machine')][string]$Scope) {
    Assert-TempRoot $Root
    $workerTemp = Join-Path $Root "temp-$Scope"
    if (Test-Path -LiteralPath $workerTemp) {
        Assert-True ((Get-Item -LiteralPath $workerTemp).PSIsContainer -and
            -not ((Get-Item -LiteralPath $workerTemp).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Worker temp must be a real gate-root directory'
    } else {
        New-Item -ItemType Directory -Path $workerTemp | Out-Null
    }
    # Set before starting credentialed PowerShell as well as before Add-Type:
    # Windows PowerShell's CodeDom compiler uses TEMP during helper loading.
    $env:TEMP = $workerTemp
    $env:TMP = $workerTemp
}

function Wait-CheckedProcess($Process, [int]$Timeout, [string]$Label, [int]$ExpectedExitCode = 0) {
    # In particular Start-Process -Credential can attach by PID. Cache its native
    # handle before it exits so ExitCode remains available after WaitForExit.
    $childHandle = $Process.Handle
    Assert-True ($childHandle -ne [IntPtr]::Zero) "$Label has no process handle"
    if (-not $Process.WaitForExit($Timeout)) {
        $Process.Kill()
        throw "$Label timed out"
    }
    Assert-True ($Process.ExitCode -eq $ExpectedExitCode) "$Label failed ($($Process.ExitCode)); expected $ExpectedExitCode"
}

function Invoke-ElevatedMachineWorker([pscredential]$Credential, [string]$Arguments) {
    Assert-CI
    Assert-TempRoot $Root
    Assert-True ($Credential.UserName -match '\\cxg-[a-f0-9]{12}-m$') 'Highest task requires the dedicated machine account'
    $taskName = 'CellXplorerGate-' + [guid]::NewGuid().ToString('N')
    $executable = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $runnerTemporary = $env:RUNNER_TEMP.Replace("'", "''")
    $machineTemporary = (Join-Path $Root 'temp-machine').Replace("'", "''")
    # Task Scheduler creates its own environment. Forward only CI attestations
    # already checked above and the validated scratch paths, never credentials.
    $command = "`$env:GITHUB_ACTIONS='true'; `$env:RUNNER_ENVIRONMENT='github-hosted'; `$env:RUNNER_TEMP='$runnerTemporary'; `$env:TEMP='$machineTemporary'; `$env:TMP='$machineTemporary'; & `"$executable`" $Arguments *> `"$Root\machine-stdout.log`"; exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action = New-ScheduledTaskAction -Execute $executable -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded" -WorkingDirectory $Root
    # CI's separate credentialed logon can be filtered even when runneradmin is
    # elevated. Task Scheduler provides a real full token for this admin account,
    # without changing UAC policy or elevating the standard-user worker.
    $registered = $false
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -User $Credential.UserName -Password ($Credential.GetNetworkCredential().Password) -RunLevel Highest | Out-Null
        $registered = $true
        Set-Content -LiteralPath "$Root\machine-stderr.log" -Value ''
        $started = Get-Date
        Start-ScheduledTask -TaskName $taskName
        $deadline = [DateTime]::UtcNow.AddMinutes(20)
        do {
            Start-Sleep -Milliseconds 250
            $task = Get-ScheduledTask -TaskName $taskName
            $info = Get-ScheduledTaskInfo -TaskName $taskName
            $complete = $info.LastRunTime -ge $started.AddSeconds(-1) -and
                [string]$task.State -notin @('Running', 'Queued') -and $info.LastTaskResult -ne 267011
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Machine scheduled worker timed out' }
        } while (-not $complete)
        Assert-True ($info.LastTaskResult -eq 0) "Machine scheduled worker failed ($($info.LastTaskResult))"
    } finally {
        if ($registered) {
            try {
                if ([string](Get-ScheduledTask -TaskName $taskName).State -in @('Running', 'Queued')) { Stop-ScheduledTask -TaskName $taskName }
            } finally {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            }
        }
    }
}

function Invoke-Setup([string]$Executable, [string]$Options, [string]$ExpectedHash = '') {
    $lock = $null
    try {
        if ((Split-Path $Executable -Parent) -ceq $Root) {
            # Retain read access while denying writes/deletes to verified stages.
            # Do not lock installed uninstall.exe: it legitimately deletes itself.
            $lock = [IO.File]::Open($Executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            Assert-True ($ExpectedHash -match '^[a-f0-9]{64}$') 'Staged installer requires a verified expected digest'
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($lock)).Replace('-', '').ToLowerInvariant() }
            finally { $hasher.Dispose() }
            Assert-True ($actualHash -ceq $ExpectedHash) 'Locked installer bytes differ from verified stage'
        }
        $process = Start-Process -FilePath $Executable -ArgumentList $Options -PassThru -WindowStyle Hidden
        # Only this process is stopped on timeout; runner teardown owns orphans.
        Wait-CheckedProcess $process 180000 'Installer'
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

function Get-Hash([string]$Path) {
    # Fresh standard-user workers need not have Get-FileHash's script module
    # available. Use the same whole-file SHA256 directly, with no module lookup.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hasher = $null
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $hasher) { $hasher.Dispose() }
        $stream.Dispose()
    }
}

function Get-InstallerCase([string]$Scope, [string]$Layout, [string]$Operation, [bool]$HasBaseline, [string]$Directory) {
    $scopeFlag = if ($Scope -eq 'machine') { '/CXALLUSERS' } else { '/CXCURRENTUSER' }
    $fresh = -not $HasBaseline -and $Layout -eq 'default' -and $Operation -eq 'upgrade'
    $options = if ($Operation -eq 'upgrade' -and -not $fresh) { "/S /UPDATE $scopeFlag /CXEXPECTEDDIR=`"$Directory`"" } else { "/S $scopeFlag /CXEXPECTEDDIR=`"$Directory`"" }
    $label = if ($fresh) { 'candidate-fresh-install' } elseif ($Operation -eq 'upgrade' -and -not $HasBaseline) { 'candidate-custom-update' } else { $Operation }
    return [pscustomobject]@{ Options = $options; Name = "$Scope/$Layout/$label"; NativePriorUpgrade = $HasBaseline -and $Operation -eq 'upgrade' }
}

function Get-Registration([string]$Product, [string]$Hive) {
    $records = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$Hive, $view)
        try {
            $key = $base.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product")
            if ($null -ne $key) {
                try {
                    $values = [ordered]@{}
                    foreach ($name in ($key.GetValueNames() | Sort-Object)) { $values[$name] = $key.GetValue($name) }
                    $manufacturer = $base.OpenSubKey("Software\CellXplorer\$Product")
                    $manufacturerDirectory = $null
                    if ($null -ne $manufacturer) {
                        try { $manufacturerDirectory = $manufacturer.GetValue('') }
                        finally { $manufacturer.Dispose() }
                    }
                    $records += ,([pscustomobject]@{ View = [string]$view; Values = $values; ManufacturerDirectory = $manufacturerDirectory })
                } finally { $key.Dispose() }
            }
        } finally { $base.Dispose() }
    }
    return $records
}

function Assert-Install([string]$Product, [string]$Scope, [string]$Directory, [string]$ExpectedVersion, [string]$BinaryHash = '') {
    $hive = if ($Scope -eq 'machine') { 'LocalMachine' } else { 'CurrentUser' }
    $otherHive = if ($Scope -eq 'machine') { 'CurrentUser' } else { 'LocalMachine' }
    $records = @(Get-Registration $Product $hive)
    Assert-True ($records.Count -gt 0) "No $Scope registration for $Product"
    Assert-True (@(Get-Registration $Product $otherHive).Count -eq 0) "Unexpected opposite-scope registration for $Product"
    foreach ($record in $records) {
        Assert-True ($record.Values['InstallLocation'].Trim('"').TrimEnd('\') -ieq $Directory.TrimEnd('\')) 'Install directory changed'
        Assert-True ($record.ManufacturerDirectory -is [string] -and $record.ManufacturerDirectory.TrimEnd('\') -ieq $Directory.TrimEnd('\')) 'Manufacturer directory does not match installation'
        Assert-True ($record.Values['DisplayVersion'] -ceq $ExpectedVersion) 'Installed version does not match exact candidate'
        if ($BinaryHash) {
            Assert-True ($record.Values['InstallScope'] -ceq $Scope) 'Installed scope metadata mismatch'
            Assert-True ($record.Values['BundleId'] -ceq ('com.cellxplorer.desktop' + $(if ($Channel -ne 'stable') { ".$Channel" } else { '' }))) 'Bundle identity mismatch'
        }
    }
    Assert-True (Test-Path -LiteralPath "$Directory\uninstall.exe") 'Missing real uninstaller'
    Assert-True (Test-Path -LiteralPath "$Directory\cellxplorer.exe") 'Missing real application'
    if ($BinaryHash) {
        $actualHash = Get-Hash "$Directory\cellxplorer.exe"
        $size = (Get-Item -LiteralPath "$Directory\cellxplorer.exe").Length
        Assert-True ($actualHash -ceq $BinaryHash) "Installed binary differs from candidate build: product=$Product scope=$Scope directory=$Directory expected=$BinaryHash actual=$actualHash bytes=$size"
    }
}

function Get-IdentitySnapshot([string]$Product, [string]$Directory) {
    $registry = @()
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, $view)
            try {
                $scheme = 'cellxplorer' + $(if ($Product -eq 'CellXplorer Beta') { '-beta' } elseif ($Product -eq 'CellXplorer Alpha') { '-alpha' } else { '' })
                foreach ($path in @("Software\CellXplorer\$Product", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product", "Software\Classes\$scheme\shell\open\command", 'Software\Microsoft\Windows\CurrentVersion\Run')) {
                    $key = $base.OpenSubKey($path)
                    if ($null -ne $key) {
                        try {
                            foreach ($name in ($key.GetValueNames() | Sort-Object)) {
                                if ($path.EndsWith('\Run') -and $name -cne $Product) { continue }
                                $registry += "$hive/$view/$path/$name/$($key.GetValueKind($name))=$($key.GetValue($name))"
                            }
                        } finally { $key.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
    return (@{ registry = $registry; binary = Get-Hash "$Directory\cellxplorer.exe"; uninstaller = Get-Hash "$Directory\uninstall.exe" } | ConvertTo-Json -Depth 8 -Compress)
}

function Move-LegacyFixture([string]$Product, [string]$Scope, [string]$From, [string]$To) {
    # Production fresh CLI intentionally ignores /D. Model a previously chosen
    # custom destination by relocating the REAL prior payload and its legacy
    # registration. This is not acceptance of the interactive directory picker.
    Assert-TempRoot $Root
    Assert-True ($To.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) 'Custom fixture escaped gate root'
    Assert-True (-not (Test-Path -LiteralPath $To)) 'Custom fixture already exists'
    Move-Item -LiteralPath $From -Destination $To
    $hive = if ($Scope -eq 'machine') { 'LocalMachine' } else { 'CurrentUser' }
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, $view)
        try {
            foreach ($path in @("Software\CellXplorer\$Product", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product", 'Software\Microsoft\Windows\CurrentVersion\Run')) {
                $key = $base.OpenSubKey($path, $true)
                if ($null -ne $key) {
                    try {
                        foreach ($name in $key.GetValueNames()) {
                            $value = $key.GetValue($name)
                            if ($value -is [string] -and $value.Contains($From)) {
                                $key.SetValue($name, $value.Replace($From, $To), $key.GetValueKind($name))
                            }
                        }
                    } finally { $key.Dispose() }
                }
            }
        } finally { $base.Dispose() }
    }
}

function Assert-WorkerAppData([string]$Profile, [string]$LocalData, [string]$RoamingData) {
    foreach ($folder in @(@{ Name = 'LocalAppData'; Path = $LocalData }, @{ Name = 'AppData'; Path = $RoamingData })) {
        Assert-True (-not [string]::IsNullOrWhiteSpace($folder.Path)) "$($folder.Name) resolution was empty (profile '$Profile')"
        Assert-True ($folder.Path -match '^[A-Za-z]:\\') "$($folder.Name) is not an absolute local path: '$($folder.Path)'"
        $absolute = [IO.Path]::GetFullPath($folder.Path)
        Assert-True ($absolute.StartsWith($Profile + '\', [StringComparison]::OrdinalIgnoreCase)) "$($folder.Name) escaped dedicated worker profile: '$absolute' (profile '$Profile')"
    }
}

function Get-TokenProfileEnvironment([Security.Principal.WindowsIdentity]$Identity) {
    if (-not ('CxInstallerTokenEnvironment' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CxInstallerTokenEnvironment {
    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);
    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyEnvironmentBlock(IntPtr block);
    public static Dictionary<string, string> Read(IntPtr token) {
        IntPtr block;
        if (token == IntPtr.Zero) throw new ArgumentException("A genuine worker token is required");
        if (!CreateEnvironmentBlock(out block, token, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            IntPtr cursor = block;
            while (true) {
                string entry = Marshal.PtrToStringUni(cursor);
                if (String.IsNullOrEmpty(entry)) break;
                int separator = entry.IndexOf('=');
                if (separator > 0) result.Add(entry.Substring(0, separator), entry.Substring(separator + 1));
                cursor = IntPtr.Add(cursor, checked((entry.Length + 1) * 2));
            }
            return result;
        } finally { DestroyEnvironmentBlock(block); }
    }
}
'@
    }
    # false means the controller environment is not inherited. Do not print the
    # block: only selected, validated profile paths are applied to this worker.
    return [CxInstallerTokenEnvironment]::Read($Identity.Token)
}

function Set-WorkerTokenProfileEnvironment([string]$Profile, [Collections.IDictionary]$EnvironmentBlock) {
    Assert-True ($EnvironmentBlock['USERPROFILE'] -ieq $Profile) 'Token environment profile differs from authenticated ProfileList identity'
    $localData = [string]$EnvironmentBlock['LOCALAPPDATA']
    $roamingData = [string]$EnvironmentBlock['APPDATA']
    Assert-WorkerAppData $Profile $localData $roamingData
    $profileDrive = [IO.Path]::GetPathRoot($Profile).TrimEnd('\')
    Assert-True ($profileDrive -match '^[A-Za-z]:$') 'Worker profile must use a local drive'
    $env:USERPROFILE = $Profile
    $env:HOMEDRIVE = $profileDrive
    $env:HOMEPATH = $Profile.Substring($profileDrive.Length)
    $env:LOCALAPPDATA = $localData
    $env:APPDATA = $roamingData
}

function Initialize-WorkerShellFolders([string]$Profile, [string]$Sid, [bool]$CreateFolders = $true) {
    # PowerShell/CLR may have cached shell paths before token environment repair.
    # A fresh same-token process consumes the corrected environment just as the
    # installer will. Never replace a failed resolution with invented paths.
    $quotedProfile = $Profile.Replace("'", "''")
    $quotedSid = $Sid.Replace("'", "''")
    $createLiteral = if ($CreateFolders) { '$true' } else { '$false' }
    $command = "function Assert-True { ${function:Assert-True} }`nfunction Assert-WorkerAppData { ${function:Assert-WorkerAppData} }`n" + @"
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
`$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
`$profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
Assert-True (`$sid -ceq '$quotedSid' -and `$profile -ieq '$quotedProfile') 'Fresh shell process identity/profile mismatch'
`$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
`$roamingData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
Assert-WorkerAppData `$profile `$localData `$roamingData
if ($createLiteral) {
    `$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::Create)
    `$roamingData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::Create)
    Assert-WorkerAppData `$profile `$localData `$roamingData
    Assert-True ((Test-Path -LiteralPath `$localData -PathType Container) -and (Test-Path -LiteralPath `$roamingData -PathType Container)) 'Windows did not initialize worker AppData directories'
}
@{ sid = `$sid; profile = `$profile; local = `$localData; roaming = `$roamingData } | ConvertTo-Json -Compress
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $start.Arguments = "-NoProfile -NonInteractive -EncodedCommand $encoded"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    try { Wait-CheckedProcess $child 30000 'Fresh worker shell-folder resolution' }
    catch {
        if ($child.HasExited) { Write-Host ($stderr.GetAwaiter().GetResult()) }
        throw
    }
    $folders = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
    Assert-True ($folders -is [pscustomobject] -and $folders.sid -is [string] -and
        $folders.profile -is [string] -and $folders.local -is [string] -and $folders.roaming -is [string]) 'Fresh shell result must be one typed JSON object'
    Assert-True ($folders.sid -ceq $Sid -and $folders.profile -ieq $Profile) 'Fresh shell result identity mismatch'
    Assert-WorkerAppData $Profile $folders.local $folders.roaming
    $child.Dispose()
    return $folders
}

function Initialize-WorkerProfile([string]$ExpectedAccount) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $accountName = $identity.Name.Split('\')[-1]
    Assert-True ($accountName -ceq $ExpectedAccount -and $accountName -match '^cxg-[a-f0-9]{12}-[um]$') 'Worker requires its dedicated disposable OS account'
    # Credentialed child processes can inherit the caller's environment. Resolve
    # genuine known folders under the logged-on token, never the runner's paths.
    $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $profileRecord = Get-ItemProperty -LiteralPath "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($identity.User.Value)"
    Assert-True ($profile -ieq $profileRecord.ProfileImagePath -and (Split-Path $profile -Leaf) -like "$accountName*") 'Worker profile must be its genuine disposable Windows profile'
    Write-Host "Profile identity verified: account=$accountName SID=$($identity.User.Value) profile=$profile"
    # Expand shell-folder paths using the verified token profile, not inherited
    # runner environment. Fresh LoadUserProfile accounts may not yet have AppData
    # folders: the default GetFolderPath option returns empty for absent folders.
    # Ask Windows to initialize its genuine known folders, then retain containment
    # checks; never substitute a fabricated directory when resolution fails.
    $env:USERNAME = $accountName
    $tokenEnvironment = Get-TokenProfileEnvironment $identity
    Write-Host "Token block paths: profile=$($tokenEnvironment['USERPROFILE']) local=$($tokenEnvironment['LOCALAPPDATA']) roaming=$($tokenEnvironment['APPDATA'])"
    Set-WorkerTokenProfileEnvironment $profile $tokenEnvironment
    Write-Host "Assigned process paths: profile=$env:USERPROFILE local=$env:LOCALAPPDATA roaming=$env:APPDATA"
    $folders = Initialize-WorkerShellFolders $profile $identity.User.Value
    Write-Host "Fresh shell paths: local=$($folders.local) roaming=$($folders.roaming)"
    $env:LOCALAPPDATA = $folders.local
    $env:APPDATA = $folders.roaming
    $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Assert-True ($isAdmin -eq ($WorkerScope -eq 'machine')) "Incorrect $WorkerScope worker token: elevated=$isAdmin, expected=$($WorkerScope -eq 'machine')"
    return $isAdmin
}

function Invoke-Worker {
    $accounts = Get-Content -LiteralPath "$Root\accounts.json" -Raw | ConvertFrom-Json
    $isAdmin = Initialize-WorkerProfile $accounts.$WorkerScope
    if ($ProfileProbe) {
        @{ completed = @('profile-bootstrap'); token_elevated = $isAdmin; account = $env:USERNAME } | ConvertTo-Json | Set-Content -LiteralPath "$Root\$WorkerScope-result.json"
        return
    }
    $plan = Get-Content -LiteralPath "$Root\plan.json" -Raw | ConvertFrom-Json
    $hasBaseline = [bool]$plan.previous.$Channel.("supports_${WorkerScope}_baseline")
    $machineResult = $null
    if ($WorkerScope -eq 'user') {
        $machineResult = Get-Content -LiteralPath "$Root\machine-result.json" -Raw | ConvertFrom-Json
        Assert-True ($machineResult.account -ceq $accounts.machine -and @($machineResult.completed).Count -eq 4) 'Machine-scope isolation baseline did not complete'
    }
    $products = [ordered]@{ stable = 'CellXplorer'; beta = 'CellXplorer Beta'; alpha = 'CellXplorer Alpha' }
    $directories = @{}
    $sentinels = @{}
    foreach ($entry in $products.GetEnumerator()) {
        $product = $entry.Value
        $protectedMachine = $WorkerScope -eq 'user' -and $entry.Key -ne $Channel
        $hives = if ($protectedMachine) { @('CurrentUser') } else { @('CurrentUser', 'LocalMachine') }
        foreach ($hive in $hives) {
            Assert-True (@(Get-Registration $product $hive).Count -eq 0) "Refusing pre-existing $product registration"
        }
        $directory = if ($WorkerScope -eq 'user' -and -not $protectedMachine) { Join-Path $env:LOCALAPPDATA $product } else { Join-Path $env:ProgramW6432 $product }
        if ($protectedMachine) {
            Assert-Install $product 'machine' $directory $plan.previous.($entry.Key).tag.Substring(1)
            Assert-True ((Get-Hash "$directory\cellxplorer.exe") -ceq $machineResult.protected_binary_hashes.($entry.Key)) 'Protected machine binary differs from completed machine fixture'
        } else {
            Assert-True (-not (Test-Path -LiteralPath $directory)) "Refusing pre-existing install directory $directory"
        }
        $directories[$entry.Key] = $directory
        $dataName = '.cellxplorer' + $(if ($entry.Key -ne 'stable') { '-' + $entry.Key } else { '' })
        $data = Join-Path $env:USERPROFILE $dataName
        Assert-True (-not (Test-Path -LiteralPath $data)) "Refusing pre-existing scientific data $data"
        New-Item -ItemType Directory -Path $data | Out-Null
        # A non-database sentinel: never launch the app or migrate scientific data.
        $sentinel = Join-Path $data 'installer-preserve-sentinel.bin'
        [IO.File]::WriteAllBytes($sentinel, [Text.Encoding]::UTF8.GetBytes([guid]::NewGuid().ToString()))
        $sentinels[$sentinel] = Get-Hash $sentinel
    }
    $scopeFlag = if ($WorkerScope -eq 'machine') { '/CXALLUSERS' } else { '/CXCURRENTUSER' }
    $product = $products[$Channel]
    $completed = @()
    # Machine worker installs the native other-channel identities. They remain
    # until runner teardown so the standard-user matrix protects those same real
    # installations even when historical releases never supported currentUser.
    foreach ($entry in $products.GetEnumerator()) {
        if ($WorkerScope -eq 'user' -and $entry.Key -ne $Channel) { continue }
        if ($entry.Key -eq $Channel -and -not $hasBaseline) { continue }
        Assert-True ($plan.previous.($entry.Key).("supports_${WorkerScope}_baseline")) "Prior $($entry.Key) installer has no proven $WorkerScope selection; cannot fake an old install"
        Assert-True ((Get-Hash "$Root\previous-$($entry.Key).exe") -ceq $plan.previous.($entry.Key).sha256) 'Verified previous installer bytes changed'
        Invoke-Setup "$Root\previous-$($entry.Key).exe" "/S /NS $scopeFlag" $plan.previous.($entry.Key).sha256
        Assert-Install $entry.Value $WorkerScope $directories[$entry.Key] $plan.previous.($entry.Key).tag.Substring(1)
        Write-Host "Verified baseline: scope=$WorkerScope product=$($entry.Value) tag=$($plan.previous.($entry.Key).tag) binary=$(Get-Hash "$($directories[$entry.Key])\cellxplorer.exe")"
    }
    $protected = @{}
    foreach ($entry in $products.GetEnumerator()) {
        if ($entry.Key -ne $Channel) { $protected[$entry.Key] = Get-IdentitySnapshot $entry.Value $directories[$entry.Key] }
    }
    foreach ($layout in @('default', 'custom')) {
        $directory = $directories[$Channel]
        if ($layout -eq 'custom') {
            # Return the selected channel to its prior release, then move only
            # this verified fresh payload/registration to a custom legacy path.
            $seed = if ($hasBaseline) { "$Root\previous-$Channel.exe" } else { "$Root\candidate.exe" }
            $seedHash = if ($hasBaseline) { $plan.previous.$Channel.sha256 } else { $plan.candidate_sha256 }
            Invoke-Setup $seed "/S /NS $scopeFlag" $seedHash
            $custom = Join-Path $Root "custom $WorkerScope $Channel"
            Move-LegacyFixture $product $WorkerScope $directory $custom
            $directory = $custom
        }
        if ($WorkerScope -eq 'machine') {
            # Reproduce HKCU language-only manufacturer key alongside HKLM install.
            $language = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\CellXplorer\$product")
            try {
                $language.DeleteValue('', $false)
                $language.SetValue('Installer Language', 1033, [Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $language.Dispose() }
        }
        foreach ($operation in @('upgrade', 'same-version-reinstall')) {
            Assert-True ((Get-Hash "$Root\candidate.exe") -ceq $plan.candidate_sha256) 'Verified candidate bytes changed'
            $case = Get-InstallerCase $WorkerScope $layout $operation $hasBaseline $directory
            $priorHash = if (Test-Path -LiteralPath "$directory\cellxplorer.exe") { Get-Hash "$directory\cellxplorer.exe" } else { 'absent' }
            Write-Host "BEGIN $($case.Name): directory=$directory installer=$($plan.candidate_sha256) expectedBinary=$($plan.binary_sha256) priorBinary=$priorHash"
            Invoke-Setup "$Root\candidate.exe" $case.Options $plan.candidate_sha256
            Assert-Install $product $WorkerScope $directory $plan.version $plan.binary_sha256
            Write-Host "PASS $($case.Name): binary=$(Get-Hash "$directory\cellxplorer.exe")"
            foreach ($entry in $protected.GetEnumerator()) {
                Assert-True ((Get-IdentitySnapshot $products[$entry.Key] $directories[$entry.Key]) -ceq $entry.Value) 'Another channel identity changed'
            }
            foreach ($entry in $sentinels.GetEnumerator()) {
                Assert-True ((Get-Hash $entry.Key) -ceq $entry.Value) 'Scientific data sentinel changed'
            }
            $completed += $case.Name
        }
        # Cleanup only the exact successfully verified installation, preserving data.
        Invoke-Setup "$directory\uninstall.exe" "/S /UPDATE $scopeFlag _?=$directory"
        Assert-True (-not (Test-Path -LiteralPath "$directory\cellxplorer.exe")) 'Keep-data uninstall left application binary'
        foreach ($hive in @('CurrentUser', 'LocalMachine')) {
            Assert-True (@(Get-Registration $product $hive).Count -eq 0) 'Uninstall left selected registration'
        }
    }
    foreach ($entry in $protected.GetEnumerator()) {
        Assert-True ((Get-IdentitySnapshot $products[$entry.Key] $directories[$entry.Key]) -ceq $entry.Value) 'Keep-data uninstall affected another channel'
    }
    foreach ($entry in $sentinels.GetEnumerator()) { Assert-True ((Get-Hash $entry.Key) -ceq $entry.Value) 'Keep-data uninstall damaged data sentinel' }
    $protectedHashes = @{}
    foreach ($entry in $products.GetEnumerator()) {
        if ($entry.Key -ne $Channel) { $protectedHashes[$entry.Key] = Get-Hash "$($directories[$entry.Key])\cellxplorer.exe" }
    }
    $coverage = if ($hasBaseline) { 'native prior-installer upgrade; old installed updater NOT executed' } else { "prior installer does not support $WorkerScope baseline; candidate fresh install/reinstall only" }
    @{ completed = $completed; token_elevated = $isAdmin; account = $env:USERNAME; baseline_coverage = $coverage; protected_binary_hashes = $protectedHashes } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$Root\$WorkerScope-result.json"
}

Assert-CI
if ($WorkerScope) {
    Assert-TempRoot $Root
    Initialize-WorkerTemp $WorkerScope
    Remove-NativeCredentials
    Invoke-Worker
    exit 0
}
Assert-True ($ProfileProbe -or ($Channel -and $Version)) 'Channel and Version required'
Assert-True (-not ($ProfileProbe -and $ReleaseId)) 'Profile-only probe cannot verify draft release provenance'
$Root = Join-Path $env:RUNNER_TEMP ('cx-upgrade-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null
Assert-TempRoot $Root
Write-Host "Installer gate evidence: $Root"
$evidence = $null
if (-not $ProfileProbe) {
    $prepare = @("$PSScriptRoot\installer_upgrade_gate.py", '--root', $Root, '--channel', $Channel, '--version', $Version)
    if ($ReleaseId) {
        $evidence = New-ControllerEvidence
        $prepare += @('--release-id', $ReleaseId, '--evidence', $evidence)
    }
    & python @prepare
    Assert-True ($LASTEXITCODE -eq 0) 'Artifact provenance / production signature verification failed'
}
$controllerOutput = $env:GITHUB_OUTPUT
$controllerSummary = $env:GITHUB_STEP_SUMMARY
Remove-NativeCredentials
if (-not $ProfileProbe) { Get-Content -LiteralPath "$Root\plan.json" }
Copy-Item -LiteralPath $PSCommandPath -Destination "$Root\smoke_installer_upgrade.ps1"
$accounts = @{}
$credentials = @{}
$created = @()
try {
    $token = [guid]::NewGuid().ToString('N').Substring(0, 12)
    foreach ($scope in @('machine', 'user')) {
        $suffix = if ($scope -eq 'user') { 'u' } else { 'm' }
        $name = "cxg-$token-$suffix"
        $password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
        New-LocalUser -Name $name -Password $password -Description 'Disposable CellXplorer installer CI gate' | Out-Null
        $created += $name
        $groupSid = if ($scope -eq 'machine') { 'S-1-5-32-544' } else { 'S-1-5-32-545' }
        $group = Get-LocalGroup -SID $groupSid
        Add-LocalGroupMember -Group $group -Member $name
        $accounts[$scope] = $name
        $credentials[$scope] = [pscredential]::new("$env:COMPUTERNAME\$name", $password)
        & icacls.exe $Root /grant "${name}:(OI)(CI)M" | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) 'Could not grant isolated worker access'
    }
    $accounts | ConvertTo-Json | Set-Content -LiteralPath "$Root\accounts.json"
    foreach ($scope in @('machine', 'user')) {
        # Real harmless credentialed exit-code probes, before any native installs.
        Initialize-WorkerTemp $scope
        foreach ($expectedExit in @(0, 7)) {
            $probe = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credentials[$scope] -LoadUserProfile -WindowStyle Hidden -PassThru -WorkingDirectory $Root -ArgumentList "-NoProfile -NonInteractive -Command `"Start-Sleep -Milliseconds 200; exit $expectedExit`""
            Wait-CheckedProcess $probe 30000 "$scope credentialed exit-code probe" $expectedExit
        }
        $workerArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Root\smoke_installer_upgrade.ps1`" -WorkerScope $scope -Root `"$Root`""
        if ($ProfileProbe) { $workerArguments += ' -ProfileProbe' } else { $workerArguments += " -Channel $Channel" }
        try {
            if ($scope -eq 'machine') {
                Invoke-ElevatedMachineWorker $credentials[$scope] $workerArguments
            } else {
                $worker = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credentials[$scope] -LoadUserProfile -WindowStyle Hidden -PassThru -WorkingDirectory $Root -ArgumentList $workerArguments -RedirectStandardOutput "$Root\$scope-stdout.log" -RedirectStandardError "$Root\$scope-stderr.log"
                Wait-CheckedProcess $worker 1200000 "$scope worker"
            }
        }
        finally {
            Get-Content -LiteralPath "$Root\$scope-stdout.log"
            Get-Content -LiteralPath "$Root\$scope-stderr.log"
        }
        $result = Get-Content -LiteralPath "$Root\$scope-result.json" -Raw | ConvertFrom-Json
        $expectedCases = if ($ProfileProbe) { 1 } else { 4 }
        Assert-True (@($result.completed).Count -eq $expectedCases) "$scope matrix incomplete"
        $result | ConvertTo-Json -Depth 6 | Write-Host
        if ($controllerSummary -and -not $ProfileProbe) {
            "Installer gate ($scope): $($result.baseline_coverage). Cases: $($result.completed -join ', ')." >> $controllerSummary
        }
    }
    if ($ProfileProbe) {
        Write-Host 'PASS: disposable worker profiles only; no installation tests or release provenance were accepted.'
    } else {
        Write-Host 'PASS: 8 native install/reinstall cases (see explicit baseline coverage); NOT old installed updater, interactive UAC, or end-to-end recovery coverage.'
    }
    if ($evidence) {
        Assert-True (Test-Path -LiteralPath $evidence) 'Controller provenance is missing'
        "provenance_path=$evidence" >> $controllerOutput
    }
} finally {
    foreach ($name in $created) { Remove-LocalUser -Name $name }
    # Evidence and dedicated profiles live until disposable runner teardown.
    # Never recursively delete a profile or product directory from this driver.
}
