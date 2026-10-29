; Policy is inside the exact signature-verified payload. No remote repair scripts.
Var CxRecoveryToken
Var CxRecoveryPid
Var CxRecoveryOrigin
Var CxRecoveryArguments
Var CxRecoveryParent
Var CxRecoveryPipe
Var CxRecoveryPath
Var CxRecoveryCanonical
Var CxRecoveryVersion
Var CxRecoveryChannel
Var CxRecoveryWait
Var CxRecoveryPhase
Var CxRecoveryHash
Var CxRecoverySelfLock
Var CxRecoveryDirectoryLock
Var CxRecoveryHashAlgorithm
Var CxRecoveryHashObject
Var CxRecoveryHashState
Var CxRecoveryHashBuffer
Var CxRecoveryHashDigest
Var CxRecoveryComputedHash
Var CxRecoveryExpectedByte
!ifndef CX_RECOVERY_TIMEOUT_MS
  !define CX_RECOVERY_TIMEOUT_MS 60000
!endif
!ifndef CX_RECOVERY_ELEVATION_VERB
  !define CX_RECOVERY_ELEVATION_VERB "runas"
!endif

Function CxReadRecovery
  StrCpy $CxRecoveryToken ""
  StrCpy $CxRecoveryArguments ""
  ${GetOptions} $CMDLINE "/CXRECOVERY=" $CxRecoveryToken
  ${If} ${Errors}
    Return
  ${EndIf}
  StrLen $0 $CxRecoveryToken
  ${If} $0 != 64
    Call CxScopeError
  ${EndIf}
  StrCpy $1 0
  ${DoWhile} $1 < 64
    StrCpy $2 $CxRecoveryToken 1 $1
    ${StrLoc} $3 "0123456789abcdef" $2 ">"
    ${If} $3 == ""
      Call CxScopeError
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  ${GetOptions} $CMDLINE "/CXPID=" $CxRecoveryPid
  ${GetOptions} $CMDLINE "/CXORIGIN=" $CxRecoveryOrigin
  ${GetOptions} $CMDLINE "/CXVERSION=" $CxRecoveryVersion
  ${GetOptions} $CMDLINE "/CXCHANNEL=" $CxRecoveryChannel
  ${GetOptions} $CMDLINE "/CXHASH=" $CxRecoveryHash
  ${If} $CxRecoveryPid == ""
  ${OrIf} $CxRecoveryOrigin == ""
  ${OrIf} $UpdateMode != 1
  ${OrIf} $CxRecoveryVersion != "${VERSION}"
    Call CxScopeError
  ${EndIf}
  !if "${BUNDLEID}" == "com.cellxplorer.desktop.alpha"
    StrCpy $0 "alpha"
  !else if "${BUNDLEID}" == "com.cellxplorer.desktop.beta"
    StrCpy $0 "beta"
  !else
    StrCpy $0 "stable"
  !endif
  ${If} $CxRecoveryChannel != $0
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryArguments '/CXRECOVERY=$CxRecoveryToken /CXPID=$CxRecoveryPid /CXORIGIN=$\"$CxRecoveryOrigin$\" /CXVERSION=$CxRecoveryVersion /CXCHANNEL=$CxRecoveryChannel /CXHASH=$CxRecoveryHash'
  Call CxLockRecoveryPayload
FunctionEnd

Function CxLockRecoveryPayload
  ; This already-running verified image is the independent relay. If its client
  ; closes during UAC, it still pins BOTH the executable and staging directory.
  ; Hash after locking: replacement before lock acquisition must never elevate.
  StrCpy $CxRecoveryPhase "payload-lock"
  StrLen $0 $CxRecoveryHash
  ${If} $0 != 64
    Call CxScopeError
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "$EXEDIR", i 0x80, i 3, p 0, i 3, i 0x02000000, p 0)p.s'
  Pop $CxRecoveryDirectoryLock
  System::Call 'kernel32::CreateFileW(w "$EXEPATH", i 0x80000000, i 1, p 0, i 3, i 0, p 0)p.s'
  Pop $CxRecoverySelfLock
  ${If} $CxRecoveryDirectoryLock == -1
  ${OrIf} $CxRecoverySelfLock == -1
    Call CxScopeError
  ${EndIf}
  System::Call 'bcrypt::BCryptOpenAlgorithmProvider(*p.s, w "SHA256", p 0, i 0)i.r0'
  Pop $CxRecoveryHashAlgorithm
  ${If} $0 != 0
    Call CxScopeError
  ${EndIf}
  System::Call 'bcrypt::BCryptGetProperty(p $CxRecoveryHashAlgorithm, w "ObjectLength", *i.r1, i 4, *i.r2, i 0)i.r0'
  ${If} $0 != 0
  ${OrIf} $1 <= 0
    Call CxScopeError
  ${EndIf}
  System::Alloc $1
  Pop $CxRecoveryHashObject
  System::Call 'bcrypt::BCryptCreateHash(p $CxRecoveryHashAlgorithm, *p.s, p $CxRecoveryHashObject, i r1, p 0, i 0, i 0)i.r0'
  Pop $CxRecoveryHashState
  ${If} $0 != 0
    Call CxScopeError
  ${EndIf}
  System::Alloc 65536
  Pop $CxRecoveryHashBuffer
  ${Do}
    System::Call 'kernel32::ReadFile(p $CxRecoverySelfLock, p $CxRecoveryHashBuffer, i 65536, *i.r1, p 0)i.r0'
    ${If} $0 == 0
      Call CxScopeError
    ${EndIf}
    ${If} $1 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'bcrypt::BCryptHashData(p $CxRecoveryHashState, p $CxRecoveryHashBuffer, i r1, i 0)i.r0'
    ${If} $0 != 0
      Call CxScopeError
    ${EndIf}
  ${Loop}
  System::Alloc 32
  Pop $CxRecoveryHashDigest
  System::Call 'bcrypt::BCryptFinishHash(p $CxRecoveryHashState, p $CxRecoveryHashDigest, i 32, i 0)i.r0'
  ${If} $0 != 0
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryComputedHash ""
  StrCpy $4 $CxRecoveryHashDigest
  StrCpy $5 0
  ${DoWhile} $5 < 32
    System::Call '*$4(&i1.r0)'
    IntOp $0 $0 & 0xff
    IntFmt $0 "%02x" $0
    StrCpy $CxRecoveryComputedHash "$CxRecoveryComputedHash$0"
    IntOp $4 $4 + 1
    IntOp $5 $5 + 1
  ${Loop}
  System::Call 'bcrypt::BCryptDestroyHash(p $CxRecoveryHashState)'
  System::Call 'bcrypt::BCryptCloseAlgorithmProvider(p $CxRecoveryHashAlgorithm, i 0)'
  System::Free $CxRecoveryHashObject
  System::Free $CxRecoveryHashBuffer
  System::Free $CxRecoveryHashDigest
  ${If} $CxRecoveryComputedHash != $CxRecoveryHash
    Call CxScopeError
  ${EndIf}
  ; Do not close either lock. The relay supervises elevation until child exit;
  ; the final child also acquires its own locks before acknowledging readiness.
FunctionEnd

Function CxElevateRecovery
  ; $0 contains the fully bounded argument string. Use an actual process handle,
  ; not fire-and-forget ExecShell, so lock ownership outlives client/app shutdown.
  !if ${NSIS_PTR_SIZE} > 4
    !define CX_SHELLEXECUTE_SIZE 112
  !else
    !define CX_SHELLEXECUTE_SIZE 60
  !endif
  System::Call '*(i ${CX_SHELLEXECUTE_SIZE}, i 0x140, p 0, w "${CX_RECOVERY_ELEVATION_VERB}", w "$EXEPATH", w "$0", p 0, &i${NSIS_PTR_SIZE} 1, p 0, p 0, p 0, p 0, &i${NSIS_PTR_SIZE} 0, p 0, p 0)p.r9'
  System::Call 'shell32::ShellExecuteExW(p r9)i.r0'
  ${If} $0 == 0
    System::Free $9
    SetErrorLevel 1
    Quit
  ${EndIf}
  System::Call '*$9(i, i, p, p, p, p, p, &i${NSIS_PTR_SIZE}, p, p, p, p, &i${NSIS_PTR_SIZE}, p, p.r8)'
  System::Free $9
  ${If} $8 == 0
    Call CxScopeError
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p r8, i -1)i.r0'
  ${If} $0 != 0
    Call CxScopeError
  ${EndIf}
  System::Call 'kernel32::GetExitCodeProcess(p r8, *i.r0)i.r1'
  System::Call 'kernel32::CloseHandle(p r8)'
  ${If} $1 == 0
    Call CxScopeError
  ${EndIf}
  SetErrorLevel $0
  Quit
FunctionEnd

Function CxRecoverySignalFailure
  ; Closing the transport makes preparation/acknowledgement fail, never succeed.
  ${If} $CxRecoveryPipe != ""
  ${AndIf} $CxRecoveryPipe != -1
    System::Call 'kernel32::CloseHandle(p $CxRecoveryPipe)'
    StrCpy $CxRecoveryPipe ""
  ${EndIf}
FunctionEnd

Function CxRecoveryCanonicalPath
  System::Call 'kernel32::CreateFileW(w "$CxRecoveryPath", i 0, i 7, p 0, i 3, i 0, p 0)p.r8'
  ${If} $8 == -1
    Call CxScopeError
  ${EndIf}
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r8, w .r9, i ${NSIS_MAX_STRLEN}, i 0)i.r0'
  System::Call 'kernel32::CloseHandle(p r8)'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPath $9
FunctionEnd

Function CxPrepareRecovery
  ${If} $CxRecoveryToken == ""
    Return
  ${EndIf}
  ${If} $CxExisting != 1
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPhase "origin"
  System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i $CxRecoveryPid)p.s'
  Pop $CxRecoveryParent
  ${If} $CxRecoveryParent == 0
    Call CxScopeError
  ${EndIf}
  StrCpy $1 ${NSIS_MAX_STRLEN}
  System::Call 'kernel32::QueryFullProcessImageNameW(p $CxRecoveryParent, i 0, w .r0, *i r1)i.r2'
  ${If} $2 == 0
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPath $0
  Call CxRecoveryCanonicalPath
  StrCpy $CxRecoveryCanonical $CxRecoveryPath
  StrCpy $CxRecoveryPath "$INSTDIR\${MAINBINARYNAME}.exe"
  Call CxRecoveryCanonicalPath
  ${If} $CxRecoveryPath != $CxRecoveryCanonical
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPath $CxRecoveryOrigin
  Call CxRecoveryCanonicalPath
  ${If} $CxRecoveryPath != $CxRecoveryCanonical
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPhase "connect"
  System::Call 'kernel32::CreateFileW(w "\\.\pipe\CellXplorerRecovery-$CxRecoveryToken", i 0x12019b, i 0, p 0, i 3, i 0, p 0)p.s'
  Pop $CxRecoveryPipe
  ${If} $CxRecoveryPipe == -1
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPhase "server"
  System::Call 'kernel32::GetNamedPipeServerProcessId(p $CxRecoveryPipe, *i.r0)i.r1'
  ${If} $1 == 0
  ${OrIf} $0 != $CxRecoveryPid
    Call CxScopeError
  ${EndIf}
  ; Both sides use message-mode nonblocking reads with bounded polling.
  StrCpy $CxRecoveryPhase "mode"
  StrCpy $0 3
  System::Call 'kernel32::SetNamedPipeHandleState(p $CxRecoveryPipe, *i r0, p 0, p 0)i.r1'
  ${If} $1 == 0
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryPhase "ready"
  System::Call 'kernel32::WriteFile(p $CxRecoveryPipe, m "R", i 1, *i.r0, p 0)i.r1'
  ${If} $1 == 0
  ${OrIf} $0 != 1
    Call CxScopeError
  ${EndIf}
  StrCpy $CxRecoveryWait 0
  StrCpy $CxRecoveryPhase "commit"
  StrCpy $CxRecoveryExpectedByte 67
  Call CxRecoveryReadExpected
  StrCpy $CxRecoveryPhase "ack"
  System::Call 'kernel32::WriteFile(p $CxRecoveryPipe, m "A", i 1, *i.r0, p 0)i.r1'
  ${If} $1 == 0
  ${OrIf} $0 != 1
    Call CxScopeError
  ${EndIf}
  ; Do not arm a late ACK that the client never consumed. It must explicitly
  ; authorize exit AFTER reading ACK, and retain its server until process exit.
  StrCpy $CxRecoveryPhase "exit-authorization"
  StrCpy $CxRecoveryExpectedByte 69
  Call CxRecoveryReadExpected
  StrCpy $CxRecoveryPhase "exit"
  StrCpy $CxRecoveryWait 0
  ${Do}
    System::Call 'kernel32::WaitForSingleObject(p $CxRecoveryParent, i 25)i.r0'
    ${If} $0 == 0
      ${ExitDo}
    ${EndIf}
    ${If} $0 != 258
      Call CxScopeError
    ${EndIf}
    System::Call 'kernel32::PeekNamedPipe(p $CxRecoveryPipe, p 0, i 0, p 0, p 0, p 0)i.r1'
    ${If} $1 == 0
      ; Handle simultaneous server closure/process exit without mistaking an
      ; earlier cancellation for permission to install on some later user exit.
      System::Call 'kernel32::WaitForSingleObject(p $CxRecoveryParent, i 0)i.r0'
      ${If} $0 == 0
        ${ExitDo}
      ${EndIf}
      Call CxScopeError
    ${EndIf}
    IntOp $CxRecoveryWait $CxRecoveryWait + 25
    ${If} $CxRecoveryWait >= ${CX_RECOVERY_TIMEOUT_MS}
      Call CxScopeError
    ${EndIf}
  ${Loop}
  System::Call 'kernel32::CloseHandle(p $CxRecoveryParent)'
  System::Call 'kernel32::CloseHandle(p $CxRecoveryPipe)'
  StrCpy $CxRecoveryPipe ""
FunctionEnd

Function CxRecoveryReadExpected
  StrCpy $CxRecoveryWait 0
  ${Do}
    StrCpy $0 0
    System::Call 'kernel32::ReadFile(p $CxRecoveryPipe, *i.r0, i 1, *i.r1, p 0)i.r2 ?e'
    Pop $3
    ${If} $2 != 0
    ${AndIf} $1 == 1
      ${If} $0 != $CxRecoveryExpectedByte
        Call CxScopeError
      ${EndIf}
      ${ExitDo}
    ${EndIf}
    ${If} $3 != 232
    ${OrIf} $CxRecoveryWait >= ${CX_RECOVERY_TIMEOUT_MS}
      Call CxScopeError
    ${EndIf}
    Sleep 25
    IntOp $CxRecoveryWait $CxRecoveryWait + 25
  ${Loop}
FunctionEnd
