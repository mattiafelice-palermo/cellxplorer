; The candidate setup, not an older installation, owns the cleanup executable.
!include "${CELLXPLORER_HOOK_SOURCE_DIR}\binaries\installer-helper.sha256.nsh"
Var CxHelperFileLock
Var CxHelperDirectoryLock
Var CxHelperAlgorithm
Var CxHelperHashObject
Var CxHelperHashState
Var CxHelperHashBuffer
Var CxHelperHashDigest
Var CxHelperComputedHash

!macro DefineInstallerHelper PREFIX
Function ${PREFIX}CxHelperFailure
  MessageBox MB_ICONSTOP|MB_OK "CellXplorer could not prepare its verified installer helper. The installation has not been authorized. Close setup and try again."
  Abort
FunctionEnd

Function ${PREFIX}CxPrepareInstallerHelper
  ${If} $CxHelperFileLock != ""
    Return
  ${EndIf}
  Push $0
  Push $1
  Push $2
  Push $4
  Push $5
  InitPluginsDir
  ClearErrors
  File "/oname=$PLUGINSDIR\cellxplorer-installer-helper.exe" "${CELLXPLORER_HOOK_SOURCE_DIR}\binaries\cellxplorer-installer-helper.exe"
  ${If} ${Errors}
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  ; Directory replacement and file writes/deletes stay denied through execution.
  System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR", i 0x80, i 3, p 0, i 3, i 0x02000000, p 0)p.s'
  Pop $CxHelperDirectoryLock
  System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\cellxplorer-installer-helper.exe", i 0x80000000, i 1, p 0, i 3, i 0, p 0)p.s'
  Pop $CxHelperFileLock
  ${If} $CxHelperDirectoryLock == -1
  ${OrIf} $CxHelperFileLock == -1
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  ; Hash the locked handle and compare with the digest compiled into signed
  ; setup. A replacement between extraction and lock acquisition fails closed.
  System::Call 'bcrypt::BCryptOpenAlgorithmProvider(*p.s, w "SHA256", p 0, i 0)i.r0'
  Pop $CxHelperAlgorithm
  ${If} $0 != 0
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  System::Call 'bcrypt::BCryptGetProperty(p $CxHelperAlgorithm, w "ObjectLength", *i.r1, i 4, *i.r2, i 0)i.r0'
  ${If} $0 != 0
  ${OrIf} $1 <= 0
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  System::Alloc $1
  Pop $CxHelperHashObject
  System::Call 'bcrypt::BCryptCreateHash(p $CxHelperAlgorithm, *p.s, p $CxHelperHashObject, i r1, p 0, i 0, i 0)i.r0'
  Pop $CxHelperHashState
  ${If} $0 != 0
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  System::Alloc 65536
  Pop $CxHelperHashBuffer
  ${Do}
    System::Call 'kernel32::ReadFile(p $CxHelperFileLock, p $CxHelperHashBuffer, i 65536, *i.r1, p 0)i.r0'
    ${If} $0 == 0
      Call ${PREFIX}CxHelperFailure
    ${EndIf}
    ${If} $1 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'bcrypt::BCryptHashData(p $CxHelperHashState, p $CxHelperHashBuffer, i r1, i 0)i.r0'
    ${If} $0 != 0
      Call ${PREFIX}CxHelperFailure
    ${EndIf}
  ${Loop}
  System::Alloc 32
  Pop $CxHelperHashDigest
  System::Call 'bcrypt::BCryptFinishHash(p $CxHelperHashState, p $CxHelperHashDigest, i 32, i 0)i.r0'
  ${If} $0 != 0
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  StrCpy $CxHelperComputedHash ""
  StrCpy $4 $CxHelperHashDigest
  StrCpy $5 0
  ${DoWhile} $5 < 32
    System::Call '*$4(&i1.r0)'
    IntOp $0 $0 & 0xff
    IntFmt $0 "%02x" $0
    StrCpy $CxHelperComputedHash "$CxHelperComputedHash$0"
    IntOp $4 $4 + 1
    IntOp $5 $5 + 1
  ${Loop}
  System::Call 'bcrypt::BCryptDestroyHash(p $CxHelperHashState)'
  System::Call 'bcrypt::BCryptCloseAlgorithmProvider(p $CxHelperAlgorithm, i 0)'
  System::Free $CxHelperHashObject
  System::Free $CxHelperHashBuffer
  System::Free $CxHelperHashDigest
  ${If} $CxHelperComputedHash != "${CX_INSTALLER_HELPER_SHA256}"
    Call ${PREFIX}CxHelperFailure
  ${EndIf}
  Pop $5
  Pop $4
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}CxReleaseInstallerHelper
  ${If} $CxHelperFileLock != ""
    System::Call 'kernel32::CloseHandle(p $CxHelperFileLock)'
    StrCpy $CxHelperFileLock ""
  ${EndIf}
  ${If} $CxHelperDirectoryLock != ""
    System::Call 'kernel32::CloseHandle(p $CxHelperDirectoryLock)'
    StrCpy $CxHelperDirectoryLock ""
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DefineInstallerHelper ""
!insertmacro DefineInstallerHelper "un."
