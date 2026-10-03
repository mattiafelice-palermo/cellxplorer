"""Compile the real NSIS template and execute isolated installer-policy checks.

No application is installed. Runtime checks use unique disposable HKCU keys and
scratch paths only. This cannot prove signed/native UAC install/update acceptance.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]


def nsis_compiler() -> Path:
    compiler = Path(os.environ["LOCALAPPDATA"]) / "tauri/NSIS/makensis.exe"
    if not compiler.is_file():
        raise RuntimeError("Cached Tauri NSIS compiler is unavailable.")
    return compiler


def render_template(source: str, values: dict) -> str:
    """Small strict renderer for the template's each/if/else constructs.

    The compiler fixture uses no resource loops; template sections outside the
    payload are the exact production code. Unsupported tokens fail closed.
    """
    tokens = list(re.finditer(r"{{(.*?)}}", source, re.S))
    def render(start: int, end: int, context: dict) -> str:
        output = []; pos = start
        while pos < end:
            token = next((t for t in tokens if pos <= t.start() < end), None)
            if token is None:
                output.append(source[pos:end]); break
            output.append(source[pos:token.start()]); expression = token.group(1).strip().strip("~").strip()
            if expression.startswith(("#each ", "#if ")):
                kind, key = expression[1:].split(" ", 1)
                alias = key.split(" as ", 1)[1].strip("| ") if " as " in key else None
                key = key.split(" as ")[0]
                depth = 1; alternate = None; closing = None
                for candidate in tokens:
                    if candidate.start() < token.end(): continue
                    if candidate.start() >= end: break
                    command = candidate.group(1).strip().strip("~").strip()
                    if command.startswith(("#each ", "#if ")): depth += 1
                    elif command.startswith("/"):
                        depth -= 1
                        if depth == 0: closing = candidate; break
                    elif command == "else" and depth == 1: alternate = candidate
                if closing is None: raise ValueError("Unclosed template block")
                body_end = alternate.start() if alternate else closing.start()
                value = context.get(key, values.get(key))
                if kind == "each":
                    for item in value or []: output.append(render(token.end(), body_end, {**context, "this": item, **({alias: item} if alias else {})}))
                elif value: output.append(render(token.end(), body_end, context))
                elif alternate: output.append(render(alternate.end(), closing.start(), context))
                pos = closing.end(); continue
            if expression not in context and expression not in values:
                raise ValueError(f"Unsupported template token {expression!r}")
            output.append(str(context.get(expression, values.get(expression, "")))); pos = token.end()
        return "".join(output)
    return render(0, len(source), {})


def compile_template(channel: str, output: Path) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    support = ROOT / "src-tauri/target/release/nsis/x64"
    for name in ["utils.nsh", "FileAssociation.nsh", "English.nsh"]:
        shutil.copyfile(support / name, output / name)
    compiler = nsis_compiler()
    cached = (support / "installer.nsi").read_text(encoding="utf-8")
    source = (ROOT / "src-tauri/cellxplorer-installer.nsi").read_text(encoding="utf-8")
    definitions = dict(re.findall(r'^!define (\w+) "(.*?)"$', cached, re.M))
    values = {key: definitions[name] for name, key in re.findall(r'^!define (\w+) "{{(\w+)}}"$', source, re.M)}
    conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    product = {"stable": "CellXplorer", "beta": "CellXplorer Beta", "alpha": "CellXplorer Alpha"}[channel]
    identifier = "com.cellxplorer.desktop" + ("" if channel == "stable" else f".{channel}")
    icon_root = "icons" if channel == "stable" else f"icons-{channel}"
    # A compiler-only placeholder payload. Never execute this setup artifact.
    payload = output / "fixture-payload.exe"; payload.write_bytes(b"Compiler fixture only")
    values.update(product_name=product, bundle_id=identifier, install_mode="currentUser", compression="zlib",
        version=conf["version"], main_binary_path=str(payload), out_file=str(output / f"{channel}-compile-only.exe"),
        installer_icon=str(ROOT / f"src-tauri/{icon_root}/icon.ico"), uninstaller_icon=str(ROOT / f"src-tauri/{icon_root}/icon.ico"),
        signed_plugins_path="", installer_hooks=str(ROOT / "src-tauri/nsis-hooks.nsh"),
        languages=["English"], language_files=[str(output / "English.nsh")],
        deep_link_protocols=["cellxplorer" + ("" if channel == "stable" else f"-{channel}")],
        resources=[], resources_dirs=[], resources_ancestors=[], binaries=[], file_associations=[])
    rendered = render_template(source, values)
    path = output / f"{channel}.nsi"; path.write_text(rendered, encoding="utf-8")
    process = subprocess.run([str(compiler), "/V2", str(path)], cwd=output, text=True, capture_output=True)
    (output / f"{channel}-compile.log").write_text(process.stdout + process.stderr, encoding="utf-8")
    if process.returncode: raise RuntimeError(process.stdout + process.stderr)
    return Path(values["out_file"])


def run_policy_checks(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    # The policy is production code; replacing its error UI keeps CLI failures
    # observable without native screen control or unattended dialogs.
    policy = (ROOT / "src-tauri/installation_scope.nsh").read_text()
    policy = re.sub(r'^\s*MessageBox .*$', '', policy, flags=re.M)
    policy = policy.replace('Function ${PREFIX}CxScopeError\n', f'Function ${{PREFIX}}CxScopeError\n  FileOpen $9 "{output / "policy-error.txt"}" w\n  FileWrite $9 "record=$CxRecordDir compare=$CxCompareDir manufacturer=$CxManufacturerDir user=$CxUserDir machine=$CxMachineDir r0=$0 r1=$1 r2=$2 r3=$3 r4=$4"\n  FileClose $9\n')
    policy_path = output / "policy.nsh"; policy_path.write_text(policy, encoding="utf-8")
    executable = output / "policy-check.exe"
    fixture = f'''Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include StrFunc.nsh
${{StrLoc}}
${{UnStrLoc}}
!define PRODUCTNAME "CellXplorer Scope Test {token}"
!define MAINBINARYNAME "cellxplorer"
!define BUNDLEID "com.cellxplorer.desktop"
!define UNINSTKEY "Software\\CellXplorerScopeTests\\{token}\\Uninstall"
!define MANUPRODUCTKEY "Software\\CellXplorerScopeTests\\{token}\\Manufacturer"
Var UpdateMode
!include "{policy_path}"
OutFile "{executable}"
Function .onInit
  ${{GetOptions}} $CMDLINE "/CASE=" $8
  ${{If}} $8 == "traversal"
    StrCpy $CxRecordDir "C:\\App\\..\\Other"
    Call CxNormalizeDirectory
    SetErrorLevel 20
    Quit
  ${{ElseIf}} $8 == "component-space"
    StrCpy $CxRecordDir "C:\\App \\Other"
    Call CxNormalizeDirectory
    SetErrorLevel 20
    Quit
  ${{ElseIf}} $8 == "unicode-drive"
    StrCpy $CxRecordDir "A€broken"
    Call CxNormalizeDirectory
    SetErrorLevel 20
    Quit
  ${{EndIf}}
  StrCpy $CxElevated 0
  StrCpy $CxRequestedScope ""
  StrCpy $CxRecordDir '$\\"C:\\Scope Fixture\\App$\\"'
  Call CxNormalizeDirectory
  FileOpen $9 "{output / 'policy-trace.txt'}" w
  FileWrite $9 "first=$CxRecordDir$\\r$\\n"
  FileClose $9
  StrCmp $CxRecordDir "C:\\Scope Fixture\\App" +3
    SetErrorLevel 10
    Quit
  SetRegView 64
  WriteRegStr HKCU "${{UNINSTKEY}}" "InstallLocation" '$\\"C:\\Scope Fixture\\App$\\"'
  WriteRegStr HKCU "${{UNINSTKEY}}" "MainBinaryName" "cellxplorer.exe"
  WriteRegStr HKCU "${{UNINSTKEY}}" "DisplayName" "${{PRODUCTNAME}}"
  WriteRegStr HKCU "${{MANUPRODUCTKEY}}" "" "C:\\Scope Fixture\\App"
  ${{If}} ${{Errors}}
    SetErrorLevel 13
    Quit
  ${{EndIf}}
  SetRegView 32
  WriteRegStr HKCU "${{UNINSTKEY}}" "InstallLocation" '$\\"C:\\Scope Fixture\\App$\\"'
  WriteRegStr HKCU "${{UNINSTKEY}}" "MainBinaryName" "cellxplorer.exe"
  WriteRegStr HKCU "${{UNINSTKEY}}" "DisplayName" "${{PRODUCTNAME}}"
  WriteRegStr HKCU "${{MANUPRODUCTKEY}}" "" "C:\\Scope Fixture\\App"
  ${{If}} ${{Errors}}
    SetErrorLevel 13
    Quit
  ${{EndIf}}
  ${{If}} $8 == "conflict"
    WriteRegStr HKCU "${{MANUPRODUCTKEY}}" "" "C:\\Other"
  ${{ElseIf}} $8 == "wrong-channel"
    WriteRegStr HKCU "${{UNINSTKEY}}" "BundleId" "com.cellxplorer.desktop.alpha"
  ${{ElseIf}} $8 == "wrong-binary"
    WriteRegStr HKCU "${{UNINSTKEY}}" "MainBinaryName" "other.exe"
  ${{EndIf}}
  Call CxDiscoverScope
  FileOpen $9 "{output / 'policy-trace.txt'}" a
  FileWrite $9 "user=$CxUserDir record=$CxRecordDir compare=$CxCompareDir manufacturer=$CxManufacturerDir$\\r$\\n"
  FileClose $9
  StrCmp $CxUserDir "C:\\Scope Fixture\\App" +3
    SetErrorLevel 11
    Quit
  StrCpy $CxRequestedScope "machine"
  Call CxDiscoverScope
  StrCmp $CxUserDir "C:\\Scope Fixture\\App" +3
    SetErrorLevel 12
    Quit
FunctionEnd
Function .onGUIEnd
  SetRegView 64
  DeleteRegKey HKCU "Software\\CellXplorerScopeTests\\{token}"
  SetRegView 32
  DeleteRegKey HKCU "Software\\CellXplorerScopeTests\\{token}"
  DeleteRegKey /ifempty HKCU "Software\\CellXplorerScopeTests"
FunctionEnd
Section
  WriteUninstaller "{output / 'policy-uninstall.exe'}"
SectionEnd
Section Uninstall
  StrCpy $CxScope "user"
  StrCpy $CxElevated 0
  StrCpy $CxRequestedScope ""
  StrCpy $INSTDIR "C:\\Scope Fixture\\App"
  Call un.CxDiscoverScope
  Call un.CxApplyScope
  Call un.CxRemoveRegistration
  SetRegView 64
  ReadRegStr $0 HKCU "${{UNINSTKEY}}" "InstallLocation"
  StrCmp $0 "" +3
    SetErrorLevel 21
    Quit
  SetRegView 32
  ReadRegStr $0 HKCU "${{MANUPRODUCTKEY}}" ""
  StrCmp $0 "" +3
    SetErrorLevel 22
    Quit
SectionEnd
'''
    source = output / "policy-check.nsi"; source.write_text(fixture, encoding="utf-8")
    compiled = subprocess.run([str(nsis_compiler()), "/V2", str(source)], cwd=output, text=True, capture_output=True)
    (output / "policy-compile.log").write_text(compiled.stdout + compiled.stderr, encoding="utf-8")
    if compiled.returncode: raise RuntimeError(compiled.stdout + compiled.stderr)
    import winreg
    def cleanup():
        # Cleanup also runs if NSIS aborts before its GUI lifecycle callback.
        for view in [winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY]:
            for leaf in ["Uninstall", "Manufacturer", ""]:
                key = f"Software\\CellXplorerScopeTests\\{token}" + (f"\\{leaf}" if leaf else "")
                try: winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, key, view)
                except FileNotFoundError: pass
    try:
        process = subprocess.run([str(executable), "/S"], timeout=20)
        if process.returncode: raise RuntimeError(f"NSIS policy execution failed: {process.returncode}")
        # Recreate after the GUI callback, then test the production uninstaller
        # registry cleanup independently with no application files to remove.
        for view in [winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY]:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, f"Software\\CellXplorerScopeTests\\{token}\\Uninstall", 0, winreg.KEY_WRITE | view) as key:
                for name, value in [("InstallLocation", '"C:\\Scope Fixture\\App"'), ("MainBinaryName", "cellxplorer.exe"), ("DisplayName", f"CellXplorer Scope Test {token}")]: winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, f"Software\\CellXplorerScopeTests\\{token}\\Manufacturer", 0, winreg.KEY_WRITE | view) as key: winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "C:\\Scope Fixture\\App")
        process = subprocess.run([str(output / "policy-uninstall.exe"), "/S", f"_?={output}"], timeout=20)
        if process.returncode: raise RuntimeError(f"NSIS policy cleanup failed: {process.returncode}")
        for case in ["traversal", "component-space", "unicode-drive", "conflict", "wrong-channel", "wrong-binary"]:
            cleanup()
            process = subprocess.run([str(executable), "/S", f"/CASE={case}"], timeout=20)
            if process.returncode != 2: raise RuntimeError(f"NSIS negative case {case} returned {process.returncode}, expected 2")
    finally:
        cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-policy-tests", action="store_true")
    args = parser.parse_args()
    output = ROOT / "tmp/070-nsis-compile"
    for channel in ["stable", "beta", "alpha"]:
        artifact = compile_template(channel, output)
        print(f"Compiled {channel}: {artifact.name} (compiler fixture, never install)")
    if args.run_policy_tests:
        run_policy_checks(output)
        print("Production NSIS normalization/discovery passed against disposable HKCU fixtures")


if __name__ == "__main__": main()
