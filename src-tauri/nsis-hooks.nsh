; Stop only processes running from this installation directory. Stable and Beta
; share executable image names but install to different folders; never taskkill
; by shared process name alone. PyInstaller runs a launcher and an inner backend
; process, so keep reaping and waiting until every installation-owned process
; has released its executable instead of relying on one snapshot and a fixed
; 400 ms delay.
!define CELLXPLORER_HOOK_SOURCE_DIR "${__FILEDIR__}"

!macro KillInstallationProcesses MODE_ARGUMENT
  InitPluginsDir
  File /oname=$PLUGINSDIR\cellxplorer-kill-installation-processes.ps1 "${CELLXPLORER_HOOK_SOURCE_DIR}\kill_installation_processes.ps1"
  nsExec::ExecToStack 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\cellxplorer-kill-installation-processes.ps1" -InstallDir "$INSTDIR" ${MODE_ARGUMENT}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "CellXplorer could not stop its running application and backend processes. Close CellXplorer and try again.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillInstallationProcesses ""
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The active uninstaller itself runs from $INSTDIR. NSIS handles the main
  ; application immediately before this hook; only reap orphaned PyInstaller
  ; backend processes here so uninstall.exe can never become a cleanup target.
  !insertmacro KillInstallationProcesses "-BackendOnly"
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
