//! Registry-independent transport for the new signature-verified NSIS payload.
//! The new payload owns installation policy; the kernel authenticates its pipe PID.
use crate::installation_scope::quote_windows_argument;

pub fn recovery_arguments(
    origin: &str,
    pid: u32,
    token: &str,
    version: &str,
    channel: &str,
    hash: &str,
    args: &[String],
) -> Result<String, String> {
    if pid == 0
        || token.len() != 64
        || !token.bytes().all(|c| c.is_ascii_hexdigit())
        || !["stable", "beta", "alpha"].contains(&channel)
        || hash.len() != 64
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        || version.is_empty()
        || !version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    {
        return Err("Invalid recovery handshake identity.".into());
    }
    let json = serde_json::to_vec(args).map_err(|e| e.to_string())?;
    let restart: String = json.iter().map(|b| format!("{b:02x}")).collect();
    let command = format!("/P /UPDATE /R /CXRECOVERY={token} /CXPID={pid} /CXORIGIN={} /CXVERSION={version} /CXCHANNEL={channel} /CXHASH={hash} /CXRESTART={restart}", quote_windows_argument(origin)?);
    // Reserve space for the payload's elevated scope/path expansion too.
    if command.encode_utf16().count() + origin.encode_utf16().count() * 2 > 700 {
        return Err("The recovery command exceeds the safe installer limit. Shorten the application arguments and retry.".into());
    }
    Ok(command)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
            ERROR_PIPE_LISTENING, HANDLE, INVALID_HANDLE_VALUE,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            },
            Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
        },
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_NOWAIT,
                PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE,
            },
            Threading::{
                GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
                WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_SHOW,
        },
    };

    struct Handle(HANDLE);
    // Kernel handles are thread-independent. This wrapper owns/closes one handle.
    unsafe impl Send for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn originating_sid() -> Result<String, String> {
        unsafe {
            let mut raw = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 {
                return Err("Could not identify the recovery user.".into());
            }
            let token = Handle(raw);
            let mut needed = 0;
            GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            if needed == 0 {
                return Err("Could not inspect the recovery user.".into());
            }
            let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ) == 0
            {
                return Err("Could not inspect the recovery user.".into());
            }
            let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
            let mut text = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return Err("Could not secure recovery transport.".into());
            }
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            Ok(sid)
        }
    }

    fn private_pipe(name: &str) -> Result<Handle, String> {
        // Explicit original-user SID; alternate-admin UAC receives only transport
        // read/write rights, not owner/DACL rights. No Everyone/Users grants.
        let sddl = wide(std::ffi::OsStr::new(&format!(
            "D:P(A;;GA;;;{})(A;;0x12019b;;;SY)(A;;0x12019b;;;BA)",
            originating_sid()?
        )));
        let mut descriptor = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("Could not secure installer transport.".into());
        }
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = wide(std::ffi::OsStr::new(name));
        let raw = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_MESSAGE
                    | PIPE_READMODE_MESSAGE
                    | PIPE_NOWAIT
                    | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                64,
                64,
                0,
                &security,
            )
        };
        unsafe {
            LocalFree(descriptor);
        }
        if raw == INVALID_HANDLE_VALUE {
            return Err("Could not create a private installer pipe.".into());
        }
        Ok(Handle(raw))
    }

    fn read_byte(
        pipe: &Handle,
        peer: Option<&Handle>,
        expected: u8,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if peer.is_some_and(|peer| unsafe { WaitForSingleObject(peer.0, 0) } != 258) {
                return Err("The authenticated installer stopped before handoff. The application remains open.".into());
            }
            let mut byte = 0;
            let mut count = 0;
            if unsafe { ReadFile(pipe.0, &mut byte, 1, &mut count, std::ptr::null_mut()) } != 0
                && count == 1
            {
                return if byte == expected {
                    Ok(())
                } else {
                    Err("The installer returned an invalid recovery message.".into())
                };
            }
            let error = unsafe { GetLastError() };
            if error != ERROR_NO_DATA || Instant::now() >= deadline {
                return Err("Installer preparation failed, was cancelled, or timed out. The application remains open.".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn authenticate_peer(pipe: &Handle, expected: &Path) -> Result<Handle, String> {
        let mut pid = 0;
        if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut pid) } == 0 {
            return Err("Could not authenticate the installer process.".into());
        }
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            return Err("Could not inspect the installer process.".into());
        }
        let process = Handle(raw);
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut size) } == 0
        {
            return Err("Could not identify the installer image.".into());
        }
        let actual = std::fs::canonicalize(PathBuf::from(String::from_utf16_lossy(
            &buffer[..size as usize],
        )))
        .map_err(|e| e.to_string())?;
        let expected = std::fs::canonicalize(expected).map_err(|e| e.to_string())?;
        if !actual
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
        {
            return Err("Recovery responder is not the verified installer.".into());
        }
        Ok(process)
    }

    fn wait_for_connection(
        pipe: &Handle,
        launcher: &Handle,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            let listening = unsafe { ConnectNamedPipe(pipe.0, std::ptr::null_mut()) } != 0;
            // With PIPE_NOWAIT, success means listening, not connected.
            if !listening {
                let error = unsafe { GetLastError() };
                if error == ERROR_PIPE_CONNECTED {
                    return Ok(());
                }
                if error != ERROR_PIPE_LISTENING {
                    return Err(
                        "Installer preparation could not connect. The application remains open."
                            .into(),
                    );
                }
            }
            if unsafe { WaitForSingleObject(launcher.0, 0) } != 258 {
                return Err(
                    "Installer preparation was cancelled or stopped. The application remains open."
                        .into(),
                );
            }
            if Instant::now() >= deadline {
                return Err(
                    "Installer preparation timed out. The application remains open.".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub struct PreparedRecovery {
        _stage: PathBuf,
        _locked_bytes: File,
        _locked_directory: File,
        _launcher: Handle,
        pipe: Handle,
        peer: Handle,
        acknowledged: bool,
    }
    impl PreparedRecovery {
        pub fn is_alive(&self) -> bool {
            unsafe { WaitForSingleObject(self.peer.0, 0) == 258 }
        }
        pub fn commit(&mut self) -> Result<(), String> {
            if !self.is_alive() {
                return Err(
                    "The installer stopped before commit. The application remains open.".into(),
                );
            }
            let mut written = 0;
            if unsafe {
                WriteFile(
                    self.pipe.0,
                    b"C".as_ptr(),
                    1,
                    &mut written,
                    std::ptr::null_mut(),
                )
            } == 0
                || written != 1
            {
                return Err(
                    "Could not commit installer handoff. The application remains open.".into(),
                );
            }
            read_byte(&self.pipe, Some(&self.peer), b'A', Duration::from_secs(10))?;
            if !self.is_alive() {
                return Err("The installer stopped before acknowledging handoff. The application remains open.".into());
            }
            self.acknowledged = true;
            Ok(())
        }
        pub fn authorize_exit(&mut self) -> Result<(), String> {
            // E is irreversible installation consent, not readiness. All
            // cancellable/fallible preparation and ACK validation precede it.
            // The caller must proceed straight to backend/app shutdown on success.
            if !self.acknowledged || !self.is_alive() {
                return Err("The installer is not ready for final authorization. The application remains open.".into());
            }
            let mut written = 0;
            if unsafe {
                WriteFile(
                    self.pipe.0,
                    b"E".as_ptr(),
                    1,
                    &mut written,
                    std::ptr::null_mut(),
                )
            } == 0
                || written != 1
            {
                return Err(
                    "Could not authorize application exit. The application remains open.".into(),
                );
            }
            self.acknowledged = false;
            Ok(())
        }
    }

    pub fn prepare_verified_recovery(
        bytes: &[u8],
        version: &str,
        channel: &str,
    ) -> Result<PreparedRecovery, String> {
        if bytes.len() < 64 || !bytes.starts_with(b"MZ") {
            return Err("The verified update is not a Windows installer.".into());
        }
        let origin = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|e| e.to_string())?;
        let origin = origin
            .to_str()
            .ok_or("The application path is not valid Unicode.")?;
        let origin = origin.strip_prefix(r"\\?\").unwrap_or(origin);
        let mut nonce = [0u8; 32];
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                nonce.as_mut_ptr(),
                nonce.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err("Could not create a secure installer handshake.".into());
        }
        let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let pipe = private_pipe(&format!(r"\\.\pipe\CellXplorerRecovery-{token}"))?;
        let stage = tempfile::Builder::new()
            .prefix("cellxplorer-verified-recovery-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let path = stage.path().join("installer.exe");
        let locked_directory = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(0x02000000)
            .open(stage.path())
            .map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .share_mode(1)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).map_err(|e| e.to_string())?;
        if actual != bytes {
            return Err("The staged installer changed. Download the update again.".into());
        }
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        use sha2::Digest;
        let hash = format!("{:x}", sha2::Sha256::digest(bytes));
        let parameters = recovery_arguments(
            origin,
            std::process::id(),
            &token,
            version,
            channel,
            &hash,
            &args,
        )?;
        if path.as_os_str().encode_wide().count() + parameters.encode_utf16().count() + 4 >= 1000 {
            return Err("The installer command is too long for safe recovery.".into());
        }
        let exe = wide(path.as_os_str());
        let parameters = wide(std::ffi::OsStr::new(&parameters));
        let verb = wide(std::ffi::OsStr::new("open"));
        let launcher = unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
            info.lpVerb = verb.as_ptr();
            info.lpFile = exe.as_ptr();
            info.lpParameters = parameters.as_ptr();
            info.nShow = SW_SHOW;
            if ShellExecuteExW(&mut info) == 0 {
                return Err(format!(
                    "Windows could not start recovery (error {}). The application remains open.",
                    GetLastError()
                ));
            }
            if info.hProcess.is_null() {
                return Err("Windows did not return a recovery process handle. The application remains open.".into());
            }
            Handle(info.hProcess)
        };
        // Initial process exit may be an elevation relay. Only the verified final
        // peer may provide readiness. Keep the byte lock through that relay.
        wait_for_connection(&pipe, &launcher, Duration::from_secs(120))?;
        let peer = authenticate_peer(&pipe, &path)?;
        read_byte(&pipe, Some(&peer), b'R', Duration::from_secs(120))?;
        Ok(PreparedRecovery {
            acknowledged: false,
            _stage: stage.keep(),
            _locked_bytes: file,
            _locked_directory: locked_directory,
            _launcher: launcher,
            pipe,
            peer,
        })
    }

    #[cfg(test)]
    mod pipe_tests {
        use super::*;
        #[test]
        fn listening_is_not_readiness_before_a_delayed_client_connects() {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!(
                r"\\.\pipe\CellXplorerRecovery-delayed-{}-{stamp}",
                std::process::id()
            );
            let pipe = private_pipe(&name).unwrap();
            let launcher = Handle(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    std::process::id(),
                )
            });
            let start = Instant::now();
            let client = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&name)
                    .unwrap()
            });
            wait_for_connection(&pipe, &launcher, Duration::from_secs(2)).unwrap();
            assert!(start.elapsed() >= Duration::from_millis(75));
            let _client = client.join().unwrap();
            authenticate_peer(&pipe, &std::env::current_exe().unwrap()).unwrap();
        }
        #[test]
        fn private_transport_rejects_name_collision() {
            let token = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!(
                r"\\.\pipe\CellXplorerRecovery-test-{}-{token}",
                std::process::id()
            );
            let _pipe = private_pipe(&name).unwrap();
            assert!(private_pipe(&name).is_err());
        }
        #[test]
        fn transport_authenticates_kernel_peer_and_rejects_missing_ack() {
            let token = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!(
                r"\\.\pipe\CellXplorerRecovery-peer-{}-{token}",
                std::process::id()
            );
            let pipe = private_pipe(&name).unwrap();
            let _client = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&name)
                .unwrap();
            unsafe {
                ConnectNamedPipe(pipe.0, std::ptr::null_mut());
            }
            let image = std::env::current_exe().unwrap();
            let peer = authenticate_peer(&pipe, &image).unwrap();
            assert!(authenticate_peer(&pipe, Path::new(r"C:\Windows\System32\cmd.exe")).is_err());
            assert!(read_byte(&pipe, Some(&peer), b'A', Duration::from_millis(25)).is_err());
        }
    }
}
#[cfg(windows)]
pub use windows::prepare_verified_recovery;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_command_has_no_registry_scope_or_target_selector() {
        let command = recovery_arguments(
            r"C:\Users\Alice\CellXplorer\cellxplorer.exe",
            42,
            &"ab".repeat(32),
            "1.0.0-alpha.1",
            "alpha",
            &"cd".repeat(32),
            &["/CXALLUSERS \"你好\"".into()],
        )
        .unwrap();
        assert!(command.contains("/CXPID=42 /CXORIGIN="));
        assert!(command.contains("/CXVERSION=1.0.0-alpha.1 /CXCHANNEL=alpha"));
        for selector in [" /D=", " /CXALLUSERS", " /CXCURRENTUSER", " /ARGS"] {
            assert!(!command.contains(selector));
        }
    }
    #[test]
    fn rejects_invalid_identity_and_overflow() {
        assert!(recovery_arguments(
            "app",
            0,
            &"ab".repeat(32),
            "1.0.0",
            "stable",
            &"cd".repeat(32),
            &[]
        )
        .is_err());
        assert!(
            recovery_arguments("app", 1, "bad", "1.0.0", "stable", &"cd".repeat(32), &[]).is_err()
        );
        assert!(recovery_arguments(
            "app",
            1,
            &"ab".repeat(32),
            "1.0.0",
            "unknown",
            &"cd".repeat(32),
            &[]
        )
        .is_err());
        assert!(recovery_arguments(
            "app",
            1,
            &"ab".repeat(32),
            "1.0.0",
            "stable",
            &"cd".repeat(32),
            &["x".repeat(500)]
        )
        .is_err());
        assert!(recovery_arguments(
            "a\nb",
            1,
            &"ab".repeat(32),
            "1.0.0",
            "stable",
            &"cd".repeat(32),
            &[]
        )
        .is_err());
    }
}
