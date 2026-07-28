; Stop only processes running from this installation directory. Stable and Beta
; share executable image names but install to different folders; never taskkill
; by shared process name alone. PyInstaller runs a launcher and an inner backend
; process, so keep reaping and waiting until every installation-owned process
; has released its executable instead of relying on one snapshot and a fixed
; 400 ms delay.
!macro KillInstallationProcesses
  nsExec::ExecToStack 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& { $$ErrorActionPreference = ''Stop''; $$root = ''$INSTDIR''.TrimEnd(''\'', ''/''); if (-not $$root) { exit 0 }; $$prefix = $$root + ''\''; $$deadline = [DateTime]::UtcNow.AddSeconds(10); do { $$owned = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) }); foreach ($$process in $$owned) { taskkill.exe /F /T /PID $$process.ProcessId | Out-Null }; if ($$owned.Count -gt 0) { Start-Sleep -Milliseconds 200 } } while ($$owned.Count -gt 0 -and [DateTime]::UtcNow -lt $$deadline); $$remaining = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) }); $$locked = @(); foreach ($$file in @(Get-ChildItem -LiteralPath $$root -Filter ''cellxplorer-backend*.exe'' -File -ErrorAction SilentlyContinue)) { try { $$stream = [System.IO.File]::Open($$file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); $$stream.Dispose() } catch { $$locked += $$file.FullName } }; if ($$remaining.Count -gt 0 -or $$locked.Count -gt 0) { Write-Output ''CellXplorer processes or backend file locks did not clear in time.''; exit 1 }; exit 0 }"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "CellXplorer could not stop its running application and backend processes. Close CellXplorer and try again.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillInstallationProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillInstallationProcesses
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !if "${STARTMENUFOLDER}" != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif

  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 desktop_shortcut_done
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  desktop_shortcut_done:
!macroend
