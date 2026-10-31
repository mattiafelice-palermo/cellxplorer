"""Execute the production NSIS readiness policy without installing any software.

Only disposable files, named pipes and child processes are used. No registry
keys or real application processes are modified. This is not signed/UAC coverage.
"""
from __future__ import annotations

import base64
import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

from check_installer_scope import nsis_compiler

ROOT = Path(__file__).resolve().parents[1]
RELAY_READY_TIMEOUT = 10
RELAY_EXIT_TIMEOUT = 15


def compile_fixture(output: Path, parent: Path, *, relay: bool = False,
                    relay_release_event: str | None = None,
                    quoted_relay: bool = False, machine: bool = False,
                    version: str = "1.0.0", channel: str = "stable") -> Path:
    if relay and not relay_release_event:
        raise ValueError("Relay fixture requires a controller-owned release event")
    if quoted_relay and not relay:
        raise ValueError("Quoted relay arguments require a relay fixture")
    if machine and relay:
        raise ValueError("Full machine transport and relay-only fixtures are distinct")
    if channel not in {'stable', 'beta', 'alpha'} or not re.fullmatch(r'[0-9A-Za-z.-]+', version):
        raise ValueError("Invalid fixture release identity")
    relay_command = '/CXTESTCHILD /CXHASH=$CxRecoveryHash'
    quoted_check = ''
    if quoted_relay:
        relay_command += r' /CXTESTQUOTED=$\"C:\Quoted, folder Ω\client.exe$\" /CXTESTSECOND=$\"second quoted value$\"'
        quoted_check = r'''
    ${GetOptions} $CMDLINE "/CXTESTQUOTED=" $6
    ${If} $6 != "C:\Quoted, folder Ω\client.exe"
      Call CxScopeError
    ${EndIf}
    ${GetOptions} $CMDLINE "/CXTESTSECOND=" $6
    ${If} $6 != "second quoted value"
      Call CxScopeError
    ${EndIf}
'''
    marker = output / "committed.txt"
    executable = output / "recovery-policy.exe"
    source = f'''Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include StrFunc.nsh
${{StrLoc}}
!define MAINBINARYNAME "{parent.stem}"
!define VERSION "{version}"
!define BUNDLEID "com.cellxplorer.desktop{'.' + channel if channel != 'stable' else ''}"
!define CX_RECOVERY_TIMEOUT_MS 2000
{('!define CX_RECOVERY_ELEVATION_VERB "open"' if relay else '')}
Var UpdateMode
; Diagnostic hook only in this harmless compiler fixture, never in production.
!macro CX_RECOVERY_TEST_EXIT_SETTLEMENT
  FileOpen $6 "{output / 'settlement-started.txt'}" w
  FileWrite $6 "observed post-E disconnect; one settlement wait follows"
  FileClose $6
!macroend
!include "{ROOT / 'src-tauri/update_recovery.nsh'}"
OutFile "{executable}"
Function CxScopeError
  System::Call 'kernel32::GetLastError()i.r7'
  FileOpen $6 "{output / 'recovery-error.txt'}" w
  FileWrite $6 "phase=$CxRecoveryPhase last=$7 r0=$0 r1=$1 r2=$2 pid=$CxRecoveryPid"
  FileClose $6
  Call CxRecoverySignalFailure
  SetErrorLevel 2
  Quit
FunctionEnd
Function .onInit
  ${{GetOptions}} $CMDLINE "/CXTESTDELAY" $0
  ${{IfNot}} ${{Errors}}
    ${{GetOptions}} $CMDLINE "/CXHASH=" $CxRecoveryHash
    FileOpen $0 "{output / 'delay-started.txt'}" w
    FileWrite $0 "original verified image is running before own lock"
    FileClose $0
    Sleep 2000
    Call CxLockRecoveryPayload
    FileOpen $0 "{output / 'delay-accepted.txt'}" w
    FileWrite $0 "original bytes still match"
    FileClose $0
    SetErrorLevel 0
    Quit
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/CXTESTCHILD" $0
  ${{IfNot}} ${{Errors}}
    FileOpen $6 "{output / 'relay-child-phase.txt'}" w
    FileWrite $6 "child-entered"
    FileClose $6
    {quoted_check}
    ${{GetOptions}} $CMDLINE "/CXHASH=" $CxRecoveryHash
    Call CxLockRecoveryPayload
    FileOpen $6 "{output / 'relay-child-phase.txt'}" w
    FileWrite $6 "child-locked"
    FileClose $6
    System::Call 'kernel32::OpenEventW(i 0x100000, i 0, w "{relay_release_event or ''}")p.r7'
    ${{If}} $7 == 0
      Call CxScopeError
    ${{EndIf}}
    FileOpen $0 "{output / 'relay-child.txt'}" w
    FileWrite $0 "independent child owns its payload locks"
    FileClose $0
    ; Test-only synchronization, not a production recovery timeout. The child
    ; stays alive until the controller finishes BOTH lock assertions. Its guard
    ; uses the existing completion budget; it cannot wait indefinitely.
    System::Call 'kernel32::WaitForSingleObject(p r7, i {RELAY_EXIT_TIMEOUT * 1000})i.r0'
    System::Call 'kernel32::CloseHandle(p r7)'
    ${{If}} $0 != 0
      Call CxScopeError
    ${{EndIf}}
    SetErrorLevel 7
    Quit
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/CXTESTRELAY" $0
  ${{IfNot}} ${{Errors}}
    FileOpen $6 "{output / 'relay-parent-phase.txt'}" w
    FileWrite $6 "parent-entered"
    FileClose $6
    ${{GetOptions}} $CMDLINE "/CXHASH=" $CxRecoveryHash
    Call CxLockRecoveryPayload
    FileOpen $6 "{output / 'relay-parent-phase.txt'}" w
    FileWrite $6 "parent-locked-before-shell"
    FileClose $6
    StrCpy $0 "{relay_command}"
    Call CxElevateRecovery
  ${{EndIf}}
  StrCpy $UpdateMode 1
  Call CxReadRecovery
  StrCpy $CxExisting 1
  StrCpy $INSTDIR "{parent.parent}"
  ${{GetOptions}} $CMDLINE "/CXTESTMISSINGEXISTING" $0
  ${{IfNot}} ${{Errors}}
    StrCpy $CxExisting 0
  ${{EndIf}}
  Call CxPrepareRecovery
FunctionEnd
Section
  FileOpen $0 "{marker}" w
  FileWrite $0 "committed only after originating process exit"
  FileClose $0
SectionEnd
'''
    if machine:
        # Execute the production scope reader/selector/relay too. Only its OS
        # inputs are simulated: no registry writes, elevation or installation.
        policy = (ROOT / 'src-tauri/installation_scope.nsh').read_text()
        if policy.count('  StrCpy $CxElevated $0\nFunctionEnd') != 1:
            raise RuntimeError('Scope elevation input changed; review the harmless fixture before running')
        policy = policy.replace('  StrCpy $CxElevated $0\nFunctionEnd', '''  StrCpy $CxElevated $0
  ${GetOptions} $CMDLINE "/CXALLUSERS" $0
  ${IfNot} ${Errors}
    StrCpy $CxElevated 1
  ${Else}
    StrCpy $CxElevated 0
  ${EndIf}
FunctionEnd''')
        policy = re.sub(r'^\s*MessageBox .*$', '', policy, flags=re.M)
        # Replace the registry instruction, not the production validation logic.
        policy = re.sub(r'ReadRegStr (\S+) (\S+) "([^"\n]+)" "([^"\n]*)"',
                        r'!insertmacro FixtureReadReg \1 \2 "\3" "\4"', policy)
        policy = re.sub(r'^\s*ExecShell .*$', '  Call CxScopeError', policy, flags=re.M)
        policy = re.sub(r'Function un.CxInitializeScope\n.*?FunctionEnd',
                        lambda m: m[0].replace('Call CxScopeError', 'Call un.CxScopeError'), policy, flags=re.S)
        policy = policy.replace('Function ${PREFIX}CxScopeError\n', f'''Function ${{PREFIX}}CxScopeError
  FileOpen $9 "{output / 'recovery-error.txt'}" w
  FileWrite $9 "phase=$CxRecoveryPhase record=$CxRecordDir expected=$CxExpectedDir instdir=$INSTDIR origin=$CxRecoveryOrigin version=$CxRecoveryVersion channel=$CxRecoveryChannel hash=$CxRecoveryHash r0=$0 r1=$1"
  FileClose $9
''')
        policy_path = output / 'machine-policy.nsh'
        policy_path.write_text(policy, encoding='utf-8')
        definitions = f'''
${{UnStrLoc}}
!define PRODUCTNAME "CellXplorer Fixture"
!define UNINSTKEY "UnusedFixtureUninstall"
!define MANUPRODUCTKEY "UnusedFixtureManufacturer"
!macro FixtureReadReg DEST HIVE KEY FIELD
  StrCpy ${{DEST}} ""
  !if "${{HIVE}}" == "HKLM"
    !if "${{FIELD}}" == "InstallLocation"
      StrCpy ${{DEST}} '$\\"{parent.parent}$\\"'
    !else if "${{FIELD}}" == ""
      StrCpy ${{DEST}} "{parent.parent}"
    !else if "${{FIELD}}" == "MainBinaryName"
      StrCpy ${{DEST}} "{parent.name}"
    !else if "${{FIELD}}" == "DisplayName"
      StrCpy ${{DEST}} "${{PRODUCTNAME}}"
    !else if "${{FIELD}}" == "BundleId"
      StrCpy ${{DEST}} "${{BUNDLEID}}"
    !else if "${{FIELD}}" == "InstallScope"
      StrCpy ${{DEST}} "machine"
    !endif
  !endif
!macroend
!include "{policy_path}"
'''
        source = source.replace('OutFile ', definitions + '\nOutFile ', 1)
        source = re.sub(r'Function CxScopeError\n.*?FunctionEnd\n', '', source, count=1, flags=re.S)
        source = source.replace('!define CX_RECOVERY_TIMEOUT_MS 2000', '!define CX_RECOVERY_TIMEOUT_MS 2000\n!define CX_RECOVERY_ELEVATION_VERB "open"')
        source = source.replace('  Call CxReadRecovery\n  StrCpy $CxExisting 1\n  StrCpy $INSTDIR "' + str(parent.parent) + '"', '  Call CxInitializeScope')
        template = (ROOT / 'src-tauri/cellxplorer-installer.nsi').read_text()
        flags = template.split('Function .onInit\n', 1)[1].split('  !if "${DISPLAYLANGUAGESELECTOR}"', 1)[0]
        source = source.replace('Var UpdateMode', 'Var PassiveMode\nVar NoShortcutMode\nVar UpdateMode')
        source = source.replace('  StrCpy $UpdateMode 1\n  Call CxInitializeScope', flags + '\n  Call CxInitializeScope')
        source = source.replace('  Call CxPrepareRecovery', f'''
  ${{If}} $CxScope != "machine"
  ${{OrIf}} $CxExisting != 1
  ${{OrIf}} $CxExpectedDir != "{parent.parent}"
  ${{OrIf}} $INSTDIR != "{parent.parent}"
  ${{OrIf}} $CxRestartArgs != "5b5d"
    Call CxScopeError
  ${{EndIf}}
  Call CxPrepareRecovery''')
    path = output / "recovery-policy.nsi"
    path.write_text(source, encoding="utf-8")
    # The fixture source is UTF-8. ACP decoding lets two equally corrupted
    # string literals compare equal while failing against a real Unicode path.
    result = subprocess.run([str(nsis_compiler()), "/INPUTCHARSET", "UTF8", "/V2", str(path)], capture_output=True, text=True, timeout=60)
    (output / 'compile.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    if 'warning 6000:' in (result.stdout + result.stderr).lower():
        raise RuntimeError('Unresolved NSIS variable/constant in recovery fixture:\n' + result.stdout + result.stderr)
    return executable


def run_case(output: Path, parent: Path, case: str, *, machine: bool = False,
             version: str = "1.0.0", channel: str = "stable") -> dict:
    output.mkdir(parents=True)
    executable = compile_fixture(output, parent, machine=machine, version=version, channel=channel)
    marker = output / "committed.txt"
    # This child is the originating process. The success case must exit before
    # NSIS is allowed past the handshake; the outer Python process observes it.
    command = r'''
$ErrorActionPreference = 'Stop'
if ('CASE' -eq 'exit-inside-settlement') {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CxFixtureExit { [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code); public static void ExitNow() { if (!TerminateProcess(new IntPtr(-1), 0)) throw new InvalidOperationException("Fixture termination failed"); } }'
}
$nonce = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$pipe = [IO.Pipes.NamedPipeServerStream]::new(('CellXplorerRecovery-' + $nonce), [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Message, [IO.Pipes.PipeOptions]::Asynchronous, 64, 64)
$connection = $pipe.BeginWaitForConnection($null, $null)
function Read-One {
  $buffer = [byte[]]::new(1)
  $read = $pipe.BeginRead($buffer, 0, 1, $null, $null)
  if (-not $read.AsyncWaitHandle.WaitOne(15000)) { throw 'Pipe message timed out' }
  if ($pipe.EndRead($read) -ne 1) { throw 'Pipe closed before acknowledgement' }
  return $buffer[0]
}
$origin = (Get-Process -Id $PID).Path
$originPid = $PID
$payloadVersion = 'PAYLOADVERSION'
$payloadChannel = 'PAYLOADCHANNEL'
$payloadHash = 'PAYLOADHASH'
if ('CASE' -eq 'wrong-origin') { $origin = 'C:\wrong\powershell.exe' }
if ('CASE' -eq 'wrong-process') { $originPid = OUTERPID }
if ('CASE' -eq 'wrong-version') { $payloadVersion = '2.0.0' }
if ('CASE' -eq 'wrong-channel') { $payloadChannel = 'WRONGCHANNEL' }
if ('CASE' -eq 'wrong-hash') { $payloadHash = '0' * 64 }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = 'EXECUTABLE'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.Arguments = '/P /UPDATE /R /CXRECOVERY=' + $nonce + ' /CXPID=' + $originPid + ' /CXORIGIN="' + $origin + '" /CXVERSION=' + $payloadVersion + ' /CXCHANNEL=' + $payloadChannel + ' /CXHASH=' + $payloadHash + ' /CXRESTART=5b5d'
if ('CASE' -eq 'wrong-scope') { $start.Arguments += ' /CXCURRENTUSER' }
if ('CASE' -eq 'wrong-expected-directory') { $start.Arguments += ' /CXEXPECTEDDIR="C:\Wrong Fixture Directory"' }
if ('CASE' -eq 'wrong-existing') { $start.Arguments += ' /CXTESTMISSINGEXISTING' }
$process = [Diagnostics.Process]::Start($start)
if ('CASE' -like 'wrong-*') {
  if (-not $process.WaitForExit(15000)) { throw 'Invalid origin process hung' }
  if ($process.ExitCode -ne 2) { throw 'Invalid origin returned wrong status' }
} else {
  if (-not $connection.AsyncWaitHandle.WaitOne(15000)) { throw 'Installer did not connect' }
  $pipe.EndWaitForConnection($connection)
  if ((Read-One) -ne 82) { throw 'Readiness was not acknowledged' }
  if (Test-Path -LiteralPath 'MARKER') { throw 'Destructive phase ran before COMMIT' }
  if ('CASE' -eq 'commit' -or 'CASE' -eq 'origin-hangs' -or 'CASE' -eq 'cancel-after-ack' -or 'CASE' -eq 'disconnect-after-exit-authorization' -or 'CASE' -eq 'exit-inside-settlement' -or 'CASE' -eq 'exit-after-settlement') {
    $pipe.WriteByte(67); $pipe.Flush()
    if ((Read-One) -ne 65) { throw 'COMMIT was not acknowledged' }
    if ('CASE' -eq 'cancel-after-ack') {
      $pipe.Dispose()
      if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 2) { throw 'Late-ACK cancellation remained armed' }
      if (Test-Path -LiteralPath 'MARKER') { throw 'Cancelled attempt installed before later origin exit' }
    } else {
      $pipe.WriteByte(69); $pipe.Flush()
      if ('CASE' -eq 'exit-inside-settlement') {
        $pipe.Dispose()
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not [IO.File]::Exists('SETTLEMENT')) {
          if ([DateTime]::UtcNow -ge $deadline) { throw 'Installer did not observe the final-E disconnect' }
          [Threading.Thread]::Sleep(1)
        }
        if (Test-Path -LiteralPath 'MARKER') { throw 'Settlement installed before actual origin exit' }
        [CxFixtureExit]::ExitNow()
        throw 'Fixture process unexpectedly survived termination'
      }
      if ('CASE' -eq 'disconnect-after-exit-authorization' -or 'CASE' -eq 'exit-after-settlement') {
        $pipe.Dispose()
        Start-Sleep -Milliseconds 250
        if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 2) { throw 'Disconnected armed attempt survived until later origin exit' }
        if (Test-Path -LiteralPath 'MARKER') { throw 'Disconnected armed attempt changed files' }
      }
    }
    # Origin still lives here: even COMMIT cannot permit destructive work yet.
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath 'MARKER') { throw 'Destructive phase ran before origin exit' }
    if ('CASE' -eq 'origin-hangs') {
      if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 2) { throw 'Hung originating process was not rejected' }
      if (Test-Path -LiteralPath 'MARKER') { throw 'Installer mutated while origin remained alive' }
    }
  } else {
    if ('CASE' -eq 'invalid-commit') { $pipe.WriteByte(88); $pipe.Flush() }
    if ('CASE' -eq 'disconnected') { $pipe.Dispose() }
    if (-not $process.WaitForExit(10000)) { throw 'Uncommitted attempt did not time out' }
    if ($process.ExitCode -ne 2) { throw 'Uncommitted attempt returned wrong status' }
    if (Test-Path -LiteralPath 'MARKER') { throw 'Uncommitted attempt changed files' }
  }
}
if ('CASE' -eq 'commit') {
  # Match Rust's mem::forget contract: retain the KERNEL handle until OS exit.
  # CLR shutdown finalizers can otherwise close it while PowerShell is still
  # alive, which correctly looks like cancellation to the production policy.
  $pipe.SafePipeHandle.SetHandleAsInvalid()
} else { $pipe.Dispose() }
'''
    for old, new in {"CASE": case, "EXECUTABLE": str(executable).replace("'", "''"), "MARKER": str(marker).replace("'", "''"), "SETTLEMENT": str(output / 'settlement-started.txt').replace("'", "''"), "OUTERPID": str(os.getpid()), "PAYLOADHASH": hashlib.sha256(executable.read_bytes()).hexdigest(), "PAYLOADVERSION": version, "PAYLOADCHANNEL": channel, "WRONGCHANNEL": 'stable' if channel != 'stable' else 'alpha'}.items():
        command = command.replace(old, new)
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    result = subprocess.run([str(parent), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True, timeout=35)
    if result.returncode:
        evidence = output / 'recovery-error.txt'
        diagnostic = evidence.read_text(encoding='utf-8', errors='replace') if evidence.exists() else 'no installer diagnostic'
        raise RuntimeError(f"Recovery {case} failed ({diagnostic}): {result.stdout!r} {result.stderr!r}")
    deadline = time.monotonic() + 5
    should_commit = case in {"commit", "exit-inside-settlement"}
    while should_commit and not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if marker.exists() != should_commit:
        evidence = output / 'recovery-error.txt'
        diagnostic = evidence.read_text(encoding='utf-8', errors='replace') if evidence.exists() else 'no installer diagnostic'
        raise RuntimeError(f"Recovery {case}: incorrect post-handshake file state ({diagnostic})")
    if case in {"exit-inside-settlement", "exit-after-settlement"} and not (output / 'settlement-started.txt').exists():
        raise RuntimeError(f"Recovery {case}: did not exercise the settlement branch")
    return {"case": ('machine-' if machine else '') + case, "passed": True,
            "post_exit_commit": marker.exists(), "simulated_elevation": machine}


@contextmanager
def relay_release_event():
    """Own one unique manual-reset event; never inherit or open a user event."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateEventW.restype = wintypes.HANDLE
    kernel.SetEvent.argtypes = [wintypes.HANDLE]
    kernel.SetEvent.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    name = "Local\\CellXplorerRelayFixture-" + uuid.uuid4().hex
    handle = kernel.CreateEventW(None, True, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS: never reuse an event.
        kernel.CloseHandle(handle)
        raise RuntimeError("Relay fixture release event was not newly created")
    def release():
        if not kernel.SetEvent(handle):
            raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield name, release
    finally:
        kernel.CloseHandle(handle)


def assert_relay_locks(executable: Path, output: Path) -> None:
    try:
        with executable.open("r+b"):
            pass
    except PermissionError:
        pass
    else:
        raise RuntimeError("Relay payload could be opened for replacement")
    replacement = output.with_name(output.name + "-replacement")
    if not replacement.resolve().is_relative_to((ROOT / "tmp").resolve()):
        raise RuntimeError("Relay rename escaped fixture root")
    try:
        output.rename(replacement)
    except PermissionError:
        pass
    else:
        replacement.rename(output)
        raise RuntimeError("Relay staging directory could be renamed while launch was outstanding")


def relay_failure_state(output: Path, executable: Path, pid: int) -> dict:
    """Read-only failure evidence, after the unchanged readiness deadline expires."""
    state = {}
    for name in ("relay-parent-phase.txt", "relay-child-phase.txt", "recovery-error.txt"):
        path = output / name
        state[name] = path.read_text(errors="replace") if path.exists() else None
    if os.name != "nt":
        return state
    class Entry(ctypes.Structure):
        _fields_ = [("size",wintypes.DWORD),("usage",wintypes.DWORD),("pid",wintypes.DWORD),
                    ("heap",ctypes.c_size_t),("module",wintypes.DWORD),("threads",wintypes.DWORD),
                    ("parent",wintypes.DWORD),("priority",wintypes.LONG),("flags",wintypes.DWORD),
                    ("image",wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD,wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    for name in ("Process32FirstW","Process32NextW"):
        getattr(kernel,name).argtypes = [wintypes.HANDLE,ctypes.POINTER(Entry)]
        getattr(kernel,name).restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2,0)
    if snapshot == ctypes.c_void_p(-1).value:
        state['snapshot_error'] = ctypes.get_last_error()
        return state
    rows = []
    try:
        entry = Entry(size=ctypes.sizeof(Entry))
        valid = kernel.Process32FirstW(snapshot,ctypes.byref(entry))
        while valid:
            if entry.pid == pid or entry.parent == pid or entry.image.casefold() == executable.name.casefold():
                rows.append(dict(pid=entry.pid,parent=entry.parent,image=entry.image,threads=entry.threads))
            valid = kernel.Process32NextW(snapshot,ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    state['processes'] = rows
    return state


def run_relay_case(output: Path, parent: Path, *, on_child_ready=None,
                   quoted_relay: bool = False) -> dict:
    output.mkdir()
    if not output.resolve().is_relative_to((ROOT / "tmp").resolve()):
        raise RuntimeError("Relay replacement fixture must stay inside repository tmp")
    with relay_release_event() as (event_name, release):
        executable = compile_fixture(output, parent, relay=True, relay_release_event=event_name,
                                     quoted_relay=quoted_relay)
        digest = hashlib.sha256(executable.read_bytes()).hexdigest()
        process = subprocess.Popen([str(executable), "/CXTESTRELAY", f"/CXHASH={digest}"])
        marker = output / "relay-child.txt"
        started = time.monotonic()
        deadline = started + RELAY_READY_TIMEOUT
        try:
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.025)
            if marker.exists() and on_child_ready is not None:
                on_child_ready()
            if time.monotonic() >= deadline or not marker.exists() or process.poll() is not None:
                diagnostic = output / "recovery-error.txt"
                detail = diagnostic.read_text(errors="replace") if diagnostic.exists() else "none"
                raise RuntimeError(f"Relay did not retain a live checked child: marker={marker.exists()} "
                                   f"exit={process.poll()} elapsed={time.monotonic()-started:.3f}s error={detail} "
                                   f"state={relay_failure_state(output, executable, process.pid)}")
            assert_relay_locks(executable, output)
            if process.poll() is not None:
                raise RuntimeError("Relay exited before the controller released its checked child")
            release()
            if process.wait(timeout=RELAY_EXIT_TIMEOUT) != 7:
                raise RuntimeError("Relay failed to wait for/propagate checked child exit status")
        finally:
            # Even a failing assertion releases this harmless child, then joins
            # only our exact Popen process. Cleanup must not mask it with WinError 32.
            release()
            if process.poll() is None:
                try:
                    process.wait(timeout=RELAY_EXIT_TIMEOUT)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=RELAY_EXIT_TIMEOUT)
    return {"case": "relay-quoted-command-lock-lifetime-and-child-exit" if quoted_relay else "relay-lock-lifetime-and-child-exit",
            "passed": True, "actual_uac": False, "quoted_arguments": quoted_relay,
            "delayed_observer": on_child_ready is not None}


def run_prelock_replacement_case(output: Path, parent: Path) -> dict:
    output.mkdir()
    if not output.resolve().is_relative_to((ROOT / "tmp").resolve()):
        raise RuntimeError("Pre-lock fixture escaped repository tmp")
    executable = compile_fixture(output, parent)
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    process = subprocess.Popen([str(executable), "/CXTESTDELAY", f"/CXHASH={digest}"])
    deadline = time.monotonic() + 5
    while not (output / "delay-started.txt").exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.025)
    if process.poll() is not None or not (output / "delay-started.txt").exists():
        raise RuntimeError("Original relay did not reach the intentional pre-lock delay")
    archived = output.with_name(output.name + "-original")
    try:
        output.rename(archived)
    except PermissionError:
        if process.wait(timeout=10) != 0:
            raise RuntimeError("Unreplaced delayed relay did not validate its original bytes")
        return {"case": "pre-lock-path-substitution", "passed": True, "substitution_blocked_by_os": True}
    output.mkdir()
    # This replacement is data, never launched. The original already-running
    # verified image must reject it before reopening the pathname with elevation.
    executable.write_bytes(b"MZ-not-the-original-verified-payload")
    if process.wait(timeout=10) != 2 or (output / "delay-accepted.txt").exists():
        raise RuntimeError("Delayed original relay accepted a substituted payload path")
    return {"case": "pre-lock-path-substitution", "passed": True, "substitution_detected_by_hash": True}


def run_machine_transport_case(output: Path, probe: Path) -> dict:
    """Actual Rust client + both production NSIS passes, without UAC or writes to installations."""
    output.mkdir()
    origin = output / 'Client space, Ω' / 'client.exe'
    origin.parent.mkdir()
    shutil.copyfile(probe, origin)
    payload = compile_fixture(output, origin, machine=True)
    start = time.monotonic()
    result = subprocess.run([str(origin)], env={**os.environ, 'CX_RECOVERY_PROBE_INSTALLER': str(payload)},
                            capture_output=True, timeout=150)
    if result.returncode:
        evidence = output / 'recovery-error.txt'
        detail = evidence.read_text(errors='replace') if evidence.exists() else 'none'
        raise RuntimeError(f'Machine transport failed: {result.stdout!r} {result.stderr!r} {detail}')
    marker = output / 'committed.txt'
    deadline = time.monotonic() + 5
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.025)
    if not marker.exists():
        raise RuntimeError('Machine transport did not reach its post-origin-exit marker')
    return {'case': 'production-rust-machine-scope-quoted-paths', 'passed': True,
            'simulated_elevation': True, 'signature_or_uac_acceptance': False,
            'elapsed_seconds': round(time.monotonic() - start, 3)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--relay-diagnostic', action='store_true', help='Diagnostic relay-only repetitions; NOT full policy acceptance')
    parser.add_argument('--iterations', type=int, default=20)
    args = parser.parse_args()
    if os.name != "nt":
        raise RuntimeError("Recovery policy execution requires Windows; refusing to silently skip")
    parent = Path(shutil.which("powershell.exe") or "")
    if not parent.is_file():
        raise RuntimeError("Windows PowerShell is required")
    scratch = ROOT / "tmp"
    scratch.mkdir(exist_ok=True)
    if args.relay_diagnostic:
        if not 1 <= args.iterations <= 50:
            raise ValueError('Diagnostic repetitions must be bounded')
        print('DIAGNOSTIC ONLY: not full policy/UAC/release acceptance', flush=True)
        with tempfile.TemporaryDirectory(prefix='relay-diagnostic-', dir=scratch) as directory:
            for index in range(args.iterations):
                print(json.dumps(dict(iteration=index, result=run_relay_case(Path(directory)/str(index),parent))),flush=True)
        return
    with tempfile.TemporaryDirectory(prefix="recovery-policy-", dir=scratch) as directory:
        rows = [run_case(Path(directory) / case, parent, case) for case in ["commit", "cancel", "wrong-origin", "wrong-process", "wrong-version", "wrong-channel", "wrong-hash", "wrong-existing", "invalid-commit", "disconnected", "origin-hangs", "cancel-after-ack", "disconnect-after-exit-authorization", "exit-inside-settlement", "exit-after-settlement"]]
        rows.append(run_relay_case(Path(directory) / "relay", parent))
        # Regression: the old child's blind 2-second sleep made this otherwise
        # valid observation fail. All original deadlines and assertions remain.
        delayed = run_relay_case(Path(directory) / "relay-delayed-observer", parent,
                                 on_child_ready=lambda: time.sleep(2.5))
        delayed["case"] = "relay-delayed-observer-lock-lifetime-and-child-exit"
        rows.append(delayed)
        # Machine-update commands contain quoted scope/origin paths. Preserve
        # multiple quoted values, spaces, commas and Unicode through the actual
        # production System structure and ShellExecute call, not a copied stub.
        rows.append(run_relay_case(Path(directory) / "relay-quoted-command", parent,
                                   quoted_relay=True))
        rows.append(run_prelock_replacement_case(Path(directory) / "pre-lock", parent))
        for case in ['commit', 'cancel-after-ack', 'wrong-origin', 'wrong-version',
                     'wrong-channel', 'wrong-hash', 'wrong-scope', 'wrong-expected-directory']:
            rows.append(run_case(Path(directory) / ('machine-' + case), parent, case,
                                 machine=True, version='0.28.0-alpha.14', channel='alpha'))
        # Exercise the actual Rust launcher, kernel peer authentication, byte and
        # directory locks, COMMIT/ACK/exit authorization against production NSIS.
        subprocess.run(["cargo", "build", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"), "--example", "recovery_transport_probe"], check=True, timeout=300)
        probe = ROOT / "src-tauri/target/debug/examples/recovery_transport_probe.exe"
        transport_output = Path(directory) / "production-transport"
        transport_output.mkdir()
        payload = compile_fixture(transport_output, probe)
        environment = {**os.environ, "CX_RECOVERY_PROBE_INSTALLER": str(payload)}
        result = subprocess.run([str(probe)], env=environment, capture_output=True, timeout=150)
        if result.returncode:
            raise RuntimeError(f"Production Rust/NSIS transport failed: {result.stdout!r} {result.stderr!r}")
        marker = transport_output / 'committed.txt'
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.025)
        if not marker.exists():
            raise RuntimeError("Production transport did not permit the harmless post-exit marker")
        rows.append({"case": "production-rust-to-nsis-transport", "passed": True, "signature_or_uac_acceptance": False})
        rows.append(run_machine_transport_case(Path(directory) / 'machine-transport', probe))
    print(json.dumps({"native_recovery_policy": rows}, indent=2))


if __name__ == "__main__":
    main()
