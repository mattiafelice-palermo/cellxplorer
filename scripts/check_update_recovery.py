"""Execute the production NSIS readiness policy without installing any software.

Only disposable files, named pipes and child processes are used. No registry
keys or real application processes are modified. This is not signed/UAC coverage.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from check_installer_scope import nsis_compiler

ROOT = Path(__file__).resolve().parents[1]


def compile_fixture(output: Path, parent: Path, *, relay: bool = False) -> Path:
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
!define VERSION "1.0.0"
!define BUNDLEID "com.cellxplorer.desktop"
!define CX_RECOVERY_TIMEOUT_MS 2000
{('!define CX_RECOVERY_ELEVATION_VERB "open"' if relay else '')}
Var UpdateMode
Var CxExisting
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
    ${{GetOptions}} $CMDLINE "/CXHASH=" $CxRecoveryHash
    Call CxLockRecoveryPayload
    FileOpen $0 "{output / 'relay-child.txt'}" w
    FileWrite $0 "independent child owns its payload locks"
    FileClose $0
    Sleep 2000
    SetErrorLevel 7
    Quit
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/CXTESTRELAY" $0
  ${{IfNot}} ${{Errors}}
    ${{GetOptions}} $CMDLINE "/CXHASH=" $CxRecoveryHash
    Call CxLockRecoveryPayload
    StrCpy $0 "/CXTESTCHILD /CXHASH=$CxRecoveryHash"
    Call CxElevateRecovery
  ${{EndIf}}
  StrCpy $UpdateMode 1
  Call CxReadRecovery
  StrCpy $CxExisting 1
  StrCpy $INSTDIR "{parent.parent}"
  Call CxPrepareRecovery
FunctionEnd
Section
  FileOpen $0 "{marker}" w
  FileWrite $0 "committed only after originating process exit"
  FileClose $0
SectionEnd
'''
    path = output / "recovery-policy.nsi"
    path.write_text(source, encoding="utf-8")
    result = subprocess.run([str(nsis_compiler()), "/V2", str(path)], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return executable


def run_case(output: Path, parent: Path, case: str) -> dict:
    output.mkdir(parents=True)
    executable = compile_fixture(output, parent)
    marker = output / "committed.txt"
    # This child is the originating process. The success case must exit before
    # NSIS is allowed past the handshake; the outer Python process observes it.
    command = r'''
$ErrorActionPreference = 'Stop'
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
$payloadVersion = '1.0.0'
$payloadChannel = 'stable'
$payloadHash = 'PAYLOADHASH'
if ('CASE' -eq 'wrong-origin') { $origin = 'C:\wrong\powershell.exe' }
if ('CASE' -eq 'wrong-process') { $originPid = OUTERPID }
if ('CASE' -eq 'wrong-version') { $payloadVersion = '2.0.0' }
if ('CASE' -eq 'wrong-channel') { $payloadChannel = 'alpha' }
if ('CASE' -eq 'wrong-hash') { $payloadHash = '0' * 64 }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = 'EXECUTABLE'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.Arguments = '/P /UPDATE /CXRECOVERY=' + $nonce + ' /CXPID=' + $originPid + ' /CXORIGIN="' + $origin + '" /CXVERSION=' + $payloadVersion + ' /CXCHANNEL=' + $payloadChannel + ' /CXHASH=' + $payloadHash
$process = [Diagnostics.Process]::Start($start)
if ('CASE' -like 'wrong-*') {
  if (-not $process.WaitForExit(15000)) { throw 'Invalid origin process hung' }
  if ($process.ExitCode -ne 2) { throw 'Invalid origin returned wrong status' }
} else {
  if (-not $connection.AsyncWaitHandle.WaitOne(15000)) { throw 'Installer did not connect' }
  $pipe.EndWaitForConnection($connection)
  if ((Read-One) -ne 82) { throw 'Readiness was not acknowledged' }
  if (Test-Path -LiteralPath 'MARKER') { throw 'Destructive phase ran before COMMIT' }
  if ('CASE' -eq 'commit' -or 'CASE' -eq 'origin-hangs' -or 'CASE' -eq 'cancel-after-ack' -or 'CASE' -eq 'disconnect-after-exit-authorization') {
    $pipe.WriteByte(67); $pipe.Flush()
    if ((Read-One) -ne 65) { throw 'COMMIT was not acknowledged' }
    if ('CASE' -eq 'cancel-after-ack') {
      $pipe.Dispose()
      if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 2) { throw 'Late-ACK cancellation remained armed' }
      if (Test-Path -LiteralPath 'MARKER') { throw 'Cancelled attempt installed before later origin exit' }
    } else {
      $pipe.WriteByte(69); $pipe.Flush()
      if ('CASE' -eq 'disconnect-after-exit-authorization') {
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
if ('CASE' -ne 'commit') { $pipe.Dispose() }
'''
    for old, new in {"CASE": case, "EXECUTABLE": str(executable).replace("'", "''"), "MARKER": str(marker).replace("'", "''"), "OUTERPID": str(os.getpid()), "PAYLOADHASH": hashlib.sha256(executable.read_bytes()).hexdigest()}.items():
        command = command.replace(old, new)
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    result = subprocess.run([str(parent), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True, timeout=35)
    if result.returncode:
        evidence = output / 'recovery-error.txt'
        diagnostic = evidence.read_text(encoding='utf-8', errors='replace') if evidence.exists() else 'no installer diagnostic'
        raise RuntimeError(f"Recovery {case} failed ({diagnostic}): {result.stdout!r} {result.stderr!r}")
    deadline = time.monotonic() + 5
    while case == "commit" and not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if marker.exists() != (case == "commit"):
        raise RuntimeError(f"Recovery {case}: incorrect post-handshake file state")
    return {"case": case, "passed": True, "post_exit_commit": marker.exists()}


def run_relay_case(output: Path, parent: Path) -> dict:
    output.mkdir()
    if not output.resolve().is_relative_to((ROOT / "tmp").resolve()):
        raise RuntimeError("Relay replacement fixture must stay inside repository tmp")
    executable = compile_fixture(output, parent, relay=True)
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    process = subprocess.Popen([str(executable), "/CXTESTRELAY", f"/CXHASH={digest}"])
    marker = output / "relay-child.txt"
    deadline = time.monotonic() + 10
    while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.025)
    if not marker.exists() or process.poll() is not None:
        raise RuntimeError("Relay did not retain a live checked child")
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
    if process.wait(timeout=15) != 7:
        raise RuntimeError("Relay failed to wait for/propagate checked child exit status")
    return {"case": "relay-lock-lifetime-and-child-exit", "passed": True, "actual_uac": False}


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


def main() -> None:
    if os.name != "nt":
        raise RuntimeError("Recovery policy execution requires Windows; refusing to silently skip")
    parent = Path(shutil.which("powershell.exe") or "")
    if not parent.is_file():
        raise RuntimeError("Windows PowerShell is required")
    scratch = ROOT / "tmp"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="recovery-policy-", dir=scratch) as directory:
        rows = [run_case(Path(directory) / case, parent, case) for case in ["commit", "cancel", "wrong-origin", "wrong-process", "wrong-version", "wrong-channel", "wrong-hash", "invalid-commit", "disconnected", "origin-hangs", "cancel-after-ack", "disconnect-after-exit-authorization"]]
        rows.append(run_relay_case(Path(directory) / "relay", parent))
        rows.append(run_prelock_replacement_case(Path(directory) / "pre-lock", parent))
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
    print(json.dumps({"native_recovery_policy": rows}, indent=2))


if __name__ == "__main__":
    main()
