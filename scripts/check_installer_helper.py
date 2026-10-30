"""Run the exact NSIS helper hash/pinning code without touching an installation."""
from pathlib import Path
import subprocess

from check_installer_scope import ROOT, nsis_compiler


def main() -> None:
    output = ROOT / "tmp/075-helper-policy"
    output.mkdir(parents=True, exist_ok=True)
    empty = output / "empty-installation-fixture"
    empty.mkdir(exist_ok=True)
    # Deliberately broken old installed helper must never be selected.
    (empty / "cellxplorer-installer-helper.exe").write_bytes(b"not executable; old installed helper")
    production = (ROOT / "src-tauri/installer_helper.nsh").read_text(encoding="utf-8")
    production = production.replace(
        '  MessageBox MB_ICONSTOP|MB_OK "CellXplorer could not prepare its verified installer helper. The installation has not been authorized. Close setup and try again."\n  Abort',
        '  SetErrorLevel 20\n  Quit',
    )
    for case in ["valid", "tampered", "missing"]:
        source = production
        if case != "valid":
            injection = ('  FileOpen $0 "$PLUGINSDIR\\cellxplorer-installer-helper.exe" w\n'
                         '  FileWrite $0 "tampered"\n  FileClose $0\n') if case == "tampered" else '  Delete "$PLUGINSDIR\\cellxplorer-installer-helper.exe"\n'
            source = source.replace('  ; Directory replacement', injection + '  ; Directory replacement', 1)
        include = output / f"{case}.nsh"
        include.write_text(source, encoding="utf-8")
        exe = output / f"{case}.exe"
        fixture = f'''Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!define CELLXPLORER_HOOK_SOURCE_DIR "{ROOT / 'src-tauri'}"
!include "{include}"
OutFile "{exe}"
Function .onInit
  Call CxPrepareInstallerHelper
  ; The verified image cannot be rewritten or renamed while pinned.
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\\cellxplorer-installer-helper.exe" w
  ${{IfNot}} ${{Errors}}
    FileClose $0
    SetErrorLevel 21
    Quit
  ${{EndIf}}
  ClearErrors
  Rename "$PLUGINSDIR\\cellxplorer-installer-helper.exe" "$PLUGINSDIR\\replacement.exe"
  ${{IfNot}} ${{Errors}}
    SetErrorLevel 22
    Quit
  ${{EndIf}}
  nsExec::ExecToStack '\"$PLUGINSDIR\\cellxplorer-installer-helper.exe\" --cleanup \"{empty}\"'
  Pop $0
  Pop $1
  ${{If}} $0 != 0
    SetErrorLevel 23
    Quit
  ${{EndIf}}
  Call CxReleaseInstallerHelper
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
'''
        script = output / f"{case}.nsi"
        script.write_text(fixture, encoding="utf-8")
        subprocess.run([str(nsis_compiler()), "/V2", str(script)], check=True, capture_output=True)
        result = subprocess.run([str(exe), "/S"], timeout=20, capture_output=True)
        expected = 0 if case == "valid" else 20
        if result.returncode != expected:
            raise RuntimeError(f"Helper policy {case}: {result.returncode}, expected {expected}")
        print(f"PASS: helper {case}; exit={result.returncode}")


if __name__ == "__main__":
    main()
