; Stop only processes running from this installation directory. Stable and Beta
; share executable image names but install to different folders; never taskkill
; by shared process name alone.
!macro KillInstallationProcesses
  nsExec::ExecToStack 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& { $$ErrorActionPreference = ''SilentlyContinue''; $$root = ''$INSTDIR''.TrimEnd(''\'', ''/'') ; if ($$root) { $$prefix = $$root + ''\'' ; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { taskkill.exe /F /T /PID $$_.ProcessId | Out-Null } ; Start-Sleep -Milliseconds 400 } }"'
  Pop $0
  Pop $1
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
