; The PyInstaller onefile sidecar re-executes itself, so the inner
; cellxplorer-backend.exe survives an ordinary parent kill and keeps the
; installed exe locked — which makes upgrades and uninstalls fail to
; replace/delete it. Reap the whole tree before any file operation.
; The main app is closed here too (everything in CellXplorer autosaves)
; so Tauri's fallback "running! Click OK to kill it" prompt never shows.
!macro KillBackendProcesses
  nsExec::Exec 'taskkill /F /T /IM cellxplorer.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM cellxplorer-backend.exe'
  Pop $0
  Sleep 400
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillBackendProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillBackendProcesses
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
