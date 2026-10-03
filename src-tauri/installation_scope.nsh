; Runtime scope. The setup/uninstaller manifest stays asInvoker. Every elevated
; destination comes from matching HKLM records or a fixed fresh Program Files path.
Var CxScope
Var CxUserDir
Var CxMachineDir
Var CxUserView
Var CxMachineView
Var CxRecordDir
Var CxCompareDir
Var CxManufacturerDir
Var CxRequestedScope
Var CxExpectedDir
Var CxElevated
Var CxExisting
Var CxRestartArgs
Var CxScopeButton

!macro CxReadScope PREFIX HIVE DEST VIEW EXPECTEDSCOPE
  ReadRegStr $CxRecordDir ${HIVE} "${UNINSTKEY}" "InstallLocation"
  ReadRegStr $CxManufacturerDir ${HIVE} "${MANUPRODUCTKEY}" ""
  ReadRegStr $2 ${HIVE} "${UNINSTKEY}" "MainBinaryName"
  ReadRegStr $3 ${HIVE} "${UNINSTKEY}" "DisplayName"
  ${If} $CxRecordDir == ""
  ${AndIf} $2 == ""
  ${AndIf} $3 == ""
    ; Old keep-data uninstallers left a manufacturer path. Ignore only a
    ; provably removed installation, with neither application nor uninstaller.
    ${If} $CxManufacturerDir != ""
      StrCpy $CxRecordDir $CxManufacturerDir
      Call ${PREFIX}CxNormalizeDirectory
      ${If} ${FileExists} "$CxRecordDir\${MAINBINARYNAME}.exe"
      ${OrIf} ${FileExists} "$CxRecordDir\uninstall.exe"
        Call ${PREFIX}CxScopeError
      ${EndIf}
    ${EndIf}
  ${Else}
    ${If} $CxRecordDir == ""
    ${OrIf} $CxManufacturerDir == ""
    ${OrIf} $2 != "${MAINBINARYNAME}.exe"
    ${OrIf} $3 != "${PRODUCTNAME}"
      Call ${PREFIX}CxScopeError
    ${EndIf}
    Call ${PREFIX}CxNormalizeDirectory
    StrCpy $CxCompareDir $CxRecordDir
    StrCpy $CxRecordDir $CxManufacturerDir
    Call ${PREFIX}CxNormalizeDirectory
    ${If} $CxCompareDir != $CxRecordDir
      Call ${PREFIX}CxScopeError
    ${EndIf}
    ReadRegStr $2 ${HIVE} "${UNINSTKEY}" "BundleId"
    ${If} $2 != ""
    ${AndIf} $2 != "${BUNDLEID}"
      Call ${PREFIX}CxScopeError
    ${EndIf}
    ReadRegStr $2 ${HIVE} "${UNINSTKEY}" "InstallScope"
    ${If} $2 != ""
    ${AndIf} $2 != "${EXPECTEDSCOPE}"
      Call ${PREFIX}CxScopeError
    ${EndIf}
    ${If} ${DEST} != ""
    ${AndIf} ${DEST} != $CxRecordDir
      Call ${PREFIX}CxScopeError
    ${EndIf}
    ${If} ${DEST} == ""
      StrCpy ${DEST} $CxRecordDir
      StrCpy ${VIEW} $4
    ${EndIf}
  ${EndIf}
!macroend

!macro CxScopeFunctions PREFIX
Function ${PREFIX}CxReadElevation
  System::Call 'kernel32::GetCurrentProcess()p.r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p.r1)i.r2'
  ${If} $2 == 0
    Call ${PREFIX}CxScopeError
  ${EndIf}
  System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i.r0, i 4, *i.r2)i.r3'
  System::Call 'kernel32::CloseHandle(p r1)'
  ${If} $3 == 0
    Call ${PREFIX}CxScopeError
  ${EndIf}
  StrCpy $CxElevated $0
FunctionEnd

Function ${PREFIX}CxScopeError
  MessageBox MB_ICONSTOP|MB_OK "The installation scope or directory could not be validated. Repair conflicting installation records or reinstall this edition. Your scientific data has not been changed."
  SetErrorLevel 2
  Quit
FunctionEnd

Function ${PREFIX}CxNormalizeDirectory
  ; Input/output CxRecordDir; support the legacy quoted InstallLocation format.
  StrCpy $0 $CxRecordDir 1
  ${If} $0 == '$\"'
    StrCpy $0 $CxRecordDir 1 -1
    ${If} $0 != '$\"'
      Call ${PREFIX}CxScopeError
    ${EndIf}
    StrCpy $CxRecordDir $CxRecordDir -1 1
  ${EndIf}
  StrLen $0 $CxRecordDir
  ${If} $0 < 4
  ${OrIf} $0 > 900
    Call ${PREFIX}CxScopeError
  ${EndIf}
  StrCpy $0 $CxRecordDir 2 1
  ${If} $0 != ':\'
    Call ${PREFIX}CxScopeError
  ${EndIf}
  System::Call 'shlwapi::PathGetDriveNumberW(w "$CxRecordDir")i.r0'
  ${If} $0 < 0
    Call ${PREFIX}CxScopeError
  ${EndIf}
  !if "${PREFIX}" == "un."
    ${UnStrLoc} $0 $CxRecordDir '$\"' '>'
  !else
    ${StrLoc} $0 $CxRecordDir '$\"' '>'
  !endif
  ${If} $0 != ""
    Call ${PREFIX}CxScopeError
  ${EndIf}
  !if "${PREFIX}" == "un."
    ${UnStrLoc} $0 $CxRecordDir '/' '>'
  !else
    ${StrLoc} $0 $CxRecordDir '/' '>'
  !endif
  ${If} $0 != ""
    Call ${PREFIX}CxScopeError
  ${EndIf}
  ; Reject traversal, control characters and ambiguous component endings
  ; before Windows canonicalization could erase evidence of a conflict.
  StrCpy $0 3
  StrCpy $2 ""
  cx_normalize_loop_${PREFIX}:
    StrCpy $1 $CxRecordDir 1 $0
    ${If} $1 == ""
    ${OrIf} $1 == '\'
      ${If} $2 != ""
        StrCpy $3 $2 1 -1
        ${If} $3 == '.'
        ${OrIf} $3 == ' '
          Call ${PREFIX}CxScopeError
        ${EndIf}
      ${EndIf}
      StrCpy $2 ""
    ${Else}
      ${If} $1 == ':'
      ${OrIf} $1 == '$'
      ${OrIf} $1 == '$\r'
      ${OrIf} $1 == '$\n'
      ${OrIf} $1 == '$\t'
      ${OrIf} $1 == '<'
      ${OrIf} $1 == '>'
      ${OrIf} $1 == '|'
      ${OrIf} $1 == '*'
      ${OrIf} $1 == '?'
        Call ${PREFIX}CxScopeError
      ${EndIf}
      StrCpy $2 "$2$1"
    ${EndIf}
    ${If} $1 != ""
      IntOp $0 $0 + 1
      Goto cx_normalize_loop_${PREFIX}
    ${EndIf}
  StrCpy $0 $CxRecordDir 1 -1
  ${If} $0 == ' '
  ${OrIf} $0 == '.'
    Call ${PREFIX}CxScopeError
  ${EndIf}
  ; Win32 canonicalization supports fresh folders that do not exist. NSIS's
  ; instruction can clear an aliased input/output register for absent paths.
  System::Call 'kernel32::GetFullPathNameW(w "$CxRecordDir", i ${NSIS_MAX_STRLEN}, w .r5, p 0)i.r0'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    Call ${PREFIX}CxScopeError
  ${EndIf}
  StrCpy $CxRecordDir $5
  ; NSIS GetFullPathName appends a trailing slash for roots; roots are forbidden.
  StrLen $0 $CxRecordDir
  ${If} $0 <= 3
    Call ${PREFIX}CxScopeError
  ${EndIf}
  StrCpy $0 $CxRecordDir 1 -1
  ${If} $0 == '\'
    StrCpy $CxRecordDir $CxRecordDir -1
  ${EndIf}
FunctionEnd



Function ${PREFIX}CxDiscoverScope
  StrCpy $CxUserDir ""
  StrCpy $CxMachineDir ""
  StrCpy $4 64
  SetRegView 64
  !insertmacro CxReadScope "${PREFIX}" HKLM $CxMachineDir $CxMachineView "machine"
  ${If} $CxRequestedScope != "machine"
  ${OrIf} $CxElevated != 1
    !insertmacro CxReadScope "${PREFIX}" HKCU $CxUserDir $CxUserView "user"
  ${EndIf}
  StrCpy $4 32
  SetRegView 32
  !insertmacro CxReadScope "${PREFIX}" HKLM $CxMachineDir $CxMachineView "machine"
  ${If} $CxRequestedScope != "machine"
  ${OrIf} $CxElevated != 1
    !insertmacro CxReadScope "${PREFIX}" HKCU $CxUserDir $CxUserView "user"
  ${EndIf}
  ${If} $CxUserDir != ""
  ${AndIf} $CxMachineDir != ""
    Call ${PREFIX}CxScopeError
  ${EndIf}
FunctionEnd

Function ${PREFIX}CxApplyScope
  ${If} $CxScope == "machine"
    SetShellVarContext all
    ${If} $CxMachineView == 32
      SetRegView 32
    ${Else}
      SetRegView 64
    ${EndIf}
  ${Else}
    SetShellVarContext current
    ${If} $CxUserView == 32
      SetRegView 32
    ${Else}
      SetRegView 64
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend
!insertmacro CxScopeFunctions ""
!insertmacro CxScopeFunctions "un."

Function CxInitializeScope
  StrLen $0 $CMDLINE
  ${If} $0 >= 1000
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRequestedScope ""
  ${GetOptions} $CMDLINE "/CXALLUSERS" $0
  ${IfNot} ${Errors}
    StrCpy $CxRequestedScope "machine"
  ${EndIf}
  ${GetOptions} $CMDLINE "/CXCURRENTUSER" $0
  ${IfNot} ${Errors}
    ${If} $CxRequestedScope != ""
      Call CxScopeError
    ${EndIf}
    StrCpy $CxRequestedScope "user"
  ${EndIf}
  Call CxReadElevation
  ; Alternate-credential elevation cannot identify the original user's HKCU.
  ${If} $CxElevated == 1
  ${AndIf} $CxRequestedScope != "machine"
    MessageBox MB_ICONSTOP|MB_OK "Run setup normally, then choose All users if needed. An elevated setup cannot install for the original current user."
    Quit
  ${EndIf}
  Call CxDiscoverScope
  StrCpy $CxExisting 0
  StrCpy $CxScope "user"
  ${If} $CxMachineDir != ""
    ${If} $CxRequestedScope == "user"
      Call CxScopeError
    ${EndIf}
    StrCpy $CxScope "machine"
    StrCpy $CxExisting 1
    StrCpy $INSTDIR $CxMachineDir
  ${ElseIf} $CxUserDir != ""
    ${If} $CxRequestedScope == "machine"
      Call CxScopeError
    ${EndIf}
    StrCpy $CxExisting 1
    StrCpy $INSTDIR $CxUserDir
  ${ElseIf} $CxRequestedScope == "machine"
    StrCpy $CxScope "machine"
    StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
  ${Else}
    ; Fresh current-user installation never trusts /D as an arbitrary target.
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}
  ${If} $UpdateMode == 1
  ${AndIf} $CxExisting != 1
    Call CxScopeError
  ${EndIf}
  ${GetOptions} $CMDLINE "/CXEXPECTEDDIR=" $CxExpectedDir
  ${IfNot} ${Errors}
    StrCpy $CxRecordDir $CxExpectedDir
    Call CxNormalizeDirectory
    ${If} $CxRecordDir != $INSTDIR
      Call CxScopeError
    ${EndIf}
  ${EndIf}
  ${GetOptions} $CMDLINE "/CXRESTART=" $CxRestartArgs
  StrLen $0 $CxRestartArgs
  ${If} $0 > 700
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecordDir $INSTDIR
  Call CxNormalizeDirectory
  StrCpy $INSTDIR $CxRecordDir
  ${If} $CxScope == "machine"
  ${AndIf} $CxElevated != 1
    ; Preserve opaque updater argv and passive flags; /D must be last.
    StrCpy $0 "/CXALLUSERS /CXEXPECTEDDIR=$\"$INSTDIR$\""
    ${If} $UpdateMode == 1
      StrCpy $0 "$0 /P /UPDATE /R /CXRESTART=$CxRestartArgs"
    ${EndIf}
    ExecShell "runas" "$EXEPATH" "$0 /D=$INSTDIR"
    ${If} ${Errors}
      MessageBox MB_ICONEXCLAMATION|MB_OK "Windows approval was cancelled or setup could not start. Nothing has been installed."
      SetErrorLevel 1
    ${EndIf}
    Quit
  ${EndIf}
  Call CxApplyScope
FunctionEnd

Function CellXplorerChooseAllUsers
  ${If} $CxExisting == 1
    MessageBox MB_ICONINFORMATION|MB_OK "This installation keeps its existing scope and directory. Uninstall while keeping data, then reinstall to change scope."
    Return
  ${EndIf}
  ExecShell "runas" "$EXEPATH" "/CXALLUSERS"
  ${If} ${Errors}
    MessageBox MB_ICONINFORMATION|MB_OK "Windows approval was cancelled. You can continue with a current-user installation."
    Return
  ${EndIf}
  Quit
FunctionEnd

Function un.CxInitializeScope
  StrLen $0 $CMDLINE
  ${If} $0 >= 1000
    Call un.CxScopeError
  ${EndIf}
  Call un.CxReadElevation
  StrCpy $CxRequestedScope ""
  ${GetOptions} $CMDLINE "/CXALLUSERS" $0
  ${IfNot} ${Errors}
    StrCpy $CxRequestedScope "machine"
  ${EndIf}
  ${If} $CxElevated == 1
  ${AndIf} $CxRequestedScope != "machine"
    MessageBox MB_ICONSTOP|MB_OK "Run this uninstaller normally. Elevated current-user removal cannot safely identify the original user's data."
    Quit
  ${EndIf}
  Call un.CxDiscoverScope
  StrCpy $CxRecordDir $INSTDIR
  Call un.CxNormalizeDirectory
  StrCpy $INSTDIR $CxRecordDir
  ${If} $CxMachineDir == $INSTDIR
    StrCpy $CxScope "machine"
  ${ElseIf} $CxUserDir == $INSTDIR
    StrCpy $CxScope "user"
  ${Else}
    Call un.CxScopeError
  ${EndIf}
  ${If} $CxScope == "machine"
  ${AndIf} $CxElevated != 1
    ; _?= is last and refers only to the authenticated current installation.
    StrCpy $0 "/CXALLUSERS"
    ${If} $UpdateMode == 1
      StrCpy $0 "$0 /P /UPDATE"
    ${EndIf}
    ExecShell "runas" "$EXEPATH" "$0 _?=$INSTDIR"
    ${If} ${Errors}
      MessageBox MB_ICONINFORMATION|MB_OK "Windows approval was cancelled. The application has not been removed."
      SetErrorLevel 1
    ${EndIf}
    Quit
  ${EndIf}
  Call un.CxApplyScope
FunctionEnd

Function CxValidateFreshDirectory
  ; Fresh custom paths must spell the actual local folder directly. A junction
  ; or short-name alias could otherwise break future registry/path matching.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0, i 7, p 0, i 3, i 0x02000000, p 0)p.r6'
  ${If} $6 == -1
    Call CxScopeError
  ${EndIf}
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r6, w .r5, i ${NSIS_MAX_STRLEN}, i 0)i.r0'
  System::Call 'kernel32::CloseHandle(p r6)'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    Call CxScopeError
  ${EndIf}
  StrCpy $5 $5 ${NSIS_MAX_STRLEN} 4
  ${If} $5 != $INSTDIR
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose the direct local folder path. Junctions and short-name aliases are unsupported for a fresh custom installation."
    Abort
  ${EndIf}
FunctionEnd

Function un.CxRemoveRegistration
  ; Discovery authenticated all matching views before file removal. Recheck
  ; each path and remove only this exact installation in its selected hive.
  SetRegView 64
  Call un.CxRemoveRegistrationView
  SetRegView 32
  Call un.CxRemoveRegistrationView
  Call un.CxApplyScope
FunctionEnd

Function un.CxRemoveRegistrationView
  ReadRegStr $CxRecordDir SHCTX "${UNINSTKEY}" "InstallLocation"
  ${If} $CxRecordDir != ""
    Call un.CxNormalizeDirectory
    ${If} $CxRecordDir != $INSTDIR
      Call un.CxScopeError
    ${EndIf}
    DeleteRegKey SHCTX "${UNINSTKEY}"
  ${EndIf}
  ReadRegStr $CxRecordDir SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $CxRecordDir != ""
    Call un.CxNormalizeDirectory
    ${If} $CxRecordDir == $INSTDIR
      DeleteRegValue SHCTX "${MANUPRODUCTKEY}" ""
      DeleteRegKey /ifempty SHCTX "${MANUPRODUCTKEY}"
    ${EndIf}
  ${EndIf}
FunctionEnd
