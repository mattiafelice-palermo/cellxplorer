//! Registry-authenticated installation identity and checked Windows update handoff.
//! The installer independently repeats scope/path checks after any elevation.
#[cfg(windows)]
use std::path::PathBuf;
use crate::app_channel::AppChannel;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallScope { User, Machine }

#[derive(Debug, Clone)]
pub struct InstallationRecord {
    pub scope: InstallScope,
    pub install_location: String,
    pub manufacturer_location: String,
    pub main_binary: String,
    pub bundle_id: Option<String>, // Missing only for legacy installers.
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationIdentity { pub scope: InstallScope, pub directory: String }

/// Registry paths can be quoted (InstallLocation) or unquoted (manufacturer key).
/// Reject nonlocal/relative paths and shell/control characters before normalization.
pub fn normalized_install_directory(value: &str) -> Result<String, String> {
    let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 { &value[1..value.len()-1] } else { value };
    if value.len() < 4 || !value.as_bytes()[0].is_ascii_alphabetic() || value.as_bytes()[1] != b':' || value.as_bytes()[2] != b'\\'
        || value.chars().any(|c| c.is_control() || ['"', '<', '>', '|', '*', '?', '/', '$'].contains(&c))
        || value[3..].contains(':') {
        return Err("The registered installation directory is not a supported local path.".into());
    }
    let mut components: Vec<&str> = Vec::new();
    for part in value[3..].split('\\') {
        if part.is_empty() { continue; }
        if part == "." || part == ".." || part.ends_with(['.', ' ']) { return Err("The registered installation path is ambiguous.".into()); }
        components.push(part);
    }
    if components.is_empty() { return Err("An installation cannot use a drive root.".into()); }
    Ok(format!("{}\\{}", &value[..2], components.join("\\")))
}

fn registered_identity(channel: AppChannel, records: &[InstallationRecord]) -> Result<InstallationIdentity, String> {
    let mut identities: Vec<InstallationIdentity> = Vec::new();
    for record in records {
        let directory = normalized_install_directory(&record.install_location)?;
        let manufacturer = normalized_install_directory(&record.manufacturer_location)?;
        if !directory.eq_ignore_ascii_case(&manufacturer) || !record.main_binary.eq_ignore_ascii_case("cellxplorer.exe")
            || record.bundle_id.as_deref().is_some_and(|id| id != match channel {
                AppChannel::Stable => crate::app_channel::STABLE_IDENTIFIER,
                AppChannel::Beta => crate::app_channel::BETA_IDENTIFIER,
                AppChannel::Alpha => crate::app_channel::ALPHA_IDENTIFIER,
            }) {
            return Err("Installation registry records conflict with this application. Repair the installation before updating.".into());
        }
        let identity = InstallationIdentity { scope: record.scope, directory };
        if !identities.iter().any(|i| i.scope == identity.scope && i.directory.eq_ignore_ascii_case(&identity.directory)) { identities.push(identity); }
    }
    if identities.len() != 1 { return Err("The installation scope is missing or ambiguous. Use the signed installer to repair it before updating.".into()); }
    Ok(identities.remove(0))
}

pub fn installation_identity(channel: AppChannel, records: &[InstallationRecord], running_exe: &str) -> Result<InstallationIdentity, String> {
    let identity = registered_identity(channel, records)?;
    let expected = format!("{}\\cellxplorer.exe", identity.directory);
    if !expected.eq_ignore_ascii_case(running_exe) { return Err("The running application does not match its registered installation directory.".into()); }
    Ok(identity)
}

/// Quote Windows arguments without introducing NSIS option selectors through /ARGS.
pub fn quote_windows_argument(argument: &str) -> Result<String, String> {
    if argument.chars().any(|c| c == '\0' || c == '\r' || c == '\n') { return Err("An application argument contains a control character.".into()); }
    let mut escaped = String::from("\"");
    let mut slashes = 0;
    for c in argument.chars() {
        if c == '\\' { slashes += 1; continue; }
        if c == '"' { escaped.push_str(&"\\".repeat(slashes * 2 + 1)); escaped.push('"'); }
        else { escaped.push_str(&"\\".repeat(slashes)); escaped.push(c); }
        slashes = 0;
    }
    escaped.push_str(&"\\".repeat(slashes * 2)); escaped.push('"'); Ok(escaped)
}

pub fn update_installer_arguments(identity: &InstallationIdentity, args: &[String]) -> Result<String, String> {
    let directory = normalized_install_directory(&identity.directory)?;
    let scope = if identity.scope == InstallScope::Machine { "/CXALLUSERS" } else { "/CXCURRENTUSER" };
    // Hex keeps arbitrary application arguments out of NSIS option parsing.
    // A dedicated restart helper decodes this exact argv array without invoking a shell.
    let restart = serde_json::to_string(args).map_err(|error| error.to_string())?;
    let encoded = encode_hex(restart.as_bytes());
    let command = format!("/P /UPDATE /R {scope} /CXRESTART={encoded} /CXEXPECTEDDIR={} /D={directory}", quote_windows_argument(&directory)?);
    // Bundled NSIS uses 1024 UTF-16 code units for CMDLINE, including exe name.
    // Reserve room for the unique staging path and reject instead of truncating.
    if command.encode_utf16().count() > 700 { return Err("The installation path or restart arguments exceed the safe installer limit. Close the application and use the signed installer manually.".into()); }
    Ok(command)
}

fn encode_hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

#[cfg(windows)]
fn registered_records(channel: AppChannel) -> Result<Vec<InstallationRecord>, String> {
    use winreg::{enums::*, RegKey};
    let mut records = Vec::new();
    for (hive, scope) in [(HKEY_CURRENT_USER, InstallScope::User), (HKEY_LOCAL_MACHINE, InstallScope::Machine)] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let root = RegKey::predef(hive);
            let uninstall = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", channel.product_name());
            let manufacturer = format!("Software\\cellxplorer\\{}", channel.product_name());
            let read = |path: &str| -> Result<Option<RegKey>, String> {
                match root.open_subkey_with_flags(path, KEY_READ | view) {
                    Ok(key) => Ok(Some(key)), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(_) => Err("Could not read installation scope from the registry.".into()),
                }
            };
            let key = read(&uninstall)?;
            let location = read(&manufacturer)?.map(|key| key.get_value::<String, _>("")).transpose().map_err(|_| "The registered installation location is invalid.")?;
            if key.is_none() && location.is_none() { continue; }
            if key.is_none() {
                // Legacy keep-data uninstallers left this value. Ignore only
                // a valid local path with neither application nor uninstaller.
                let path = normalized_install_directory(location.as_deref().unwrap_or_default())?;
                if !std::path::Path::new(&path).join("cellxplorer.exe").exists() && !std::path::Path::new(&path).join("uninstall.exe").exists() { continue; }
            }
            let key = key.ok_or("The installation registry record is incomplete.")?;
            match key.get_value::<String, _>("InstallScope") {
                Ok(value) if value == if scope == InstallScope::User { "user" } else { "machine" } => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                _ => return Err("The registered installation scope conflicts with its registry hive.".into()),
            }
            records.push(InstallationRecord {
                scope,
                install_location: key.get_value("InstallLocation").map_err(|_| "The installation registry record has no location.")?,
                manufacturer_location: location.ok_or("The installation manufacturer record is missing.")?,
                main_binary: key.get_value("MainBinaryName").map_err(|_| "The installation registry record has no application identity.")?,
                bundle_id: match key.get_value("BundleId") { Ok(value) => Some(value), Err(error) if error.kind() == std::io::ErrorKind::NotFound => None, Err(_) => return Err("The installation channel identity is invalid.".into()) },
            });
        }
    }
    Ok(records)
}

#[cfg(windows)]
pub fn running_installation(channel: AppChannel) -> Result<InstallationIdentity, String> {
    let exe = std::env::current_exe().and_then(std::fs::canonicalize).map_err(|_| "Could not identify the running installation.")?;
    let identity = registered_identity(channel, &registered_records(channel)?)?;
    // Resolve filesystem aliases for equivalence, retaining the authenticated
    // registry spelling for the installer's unchanged destination.
    let registered_exe = std::fs::canonicalize(std::path::Path::new(&identity.directory).join("cellxplorer.exe"))
        .map_err(|_| "The registered application could not be identified.")?;
    if !registered_exe.as_os_str().to_string_lossy().eq_ignore_ascii_case(&exe.as_os_str().to_string_lossy()) {
        return Err("The running application does not match its registered installation directory.".into());
    }
    if identity.scope == InstallScope::User && process_is_elevated()? { return Err("Close the elevated application and run it normally before updating a current-user installation.".into()); }
    Ok(identity)
}

#[cfg(windows)]
pub fn process_is_elevated() -> Result<bool, String> {
    use windows_sys::Win32::{Foundation::CloseHandle, Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY}, System::Threading::{GetCurrentProcess, OpenProcessToken}};
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err("Could not determine the Windows user context.".into()); }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 }; let mut size = 0;
        let ok = GetTokenInformation(token, TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut size);
        CloseHandle(token);
        if ok == 0 { Err("Could not determine Windows elevation.".into()) } else { Ok(elevation.TokenIsElevated != 0) }
    }
}

#[cfg(windows)]
pub fn launch_verified_update(identity: &InstallationIdentity, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::{fs::OpenOptions, io::{Read, Write}, os::windows::fs::OpenOptionsExt, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED}, UI::{Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS, SEE_MASK_NOASYNC}, WindowsAndMessaging::SW_SHOW}, System::Threading::{WaitForSingleObject, GetExitCodeProcess}};
    if bytes.len() < 64 || !bytes.starts_with(b"MZ") { return Err("The verified update is not a supported Windows installer.".into()); }
    let directory = tempfile::Builder::new().prefix("cellxplorer-verified-update-").tempdir().map_err(|e| e.to_string())?;
    let path = directory.path().join("installer.exe");
    // A new file in a new random directory. Deny write/delete sharing from the
    // first write through ShellExecuteEx, binding launch to the verified bytes.
    let mut file = OpenOptions::new().create_new(true).read(true).write(true).share_mode(1).open(&path).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file);
    // The loader needs compatible read sharing. Reopen without write access,
    // compare while locked, and retain the deny-write/delete handle through launch.
    let mut file = OpenOptions::new().read(true).share_mode(1).open(&path).map_err(|e| e.to_string())?;
    let mut staged = Vec::new(); file.read_to_end(&mut staged).map_err(|e| e.to_string())?;
    if staged != bytes { return Err("The staged installer changed before launch. Download the update again.".into()); }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let parameters = update_installer_arguments(identity, &args)?;
    if path.as_os_str().encode_wide().count() + parameters.encode_utf16().count() + 4 >= 1000 {
        return Err("The installer command exceeds the safe Windows installer limit. Use a shorter local temporary directory or install manually.".into());
    }
    let wide = |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let executable = wide(path.as_os_str()); let parameters = wide(std::ffi::OsStr::new(&parameters));
    let verb = wide(std::ffi::OsStr::new(if identity.scope == InstallScope::Machine { "runas" } else { "open" }));
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr(); info.lpFile = executable.as_ptr(); info.lpParameters = parameters.as_ptr(); info.nShow = SW_SHOW;
        if ShellExecuteExW(&mut info) == 0 {
            let error = GetLastError();
            return Err(if error == ERROR_CANCELLED { "Windows elevation was cancelled. The application is still running; retry when ready.".into() } else { format!("Windows could not start the installer (error {error}).") });
        }
        if info.hProcess.is_null() { return Err("Windows did not return an installer process. The application remains open.".into()); }
        {
            let waited = WaitForSingleObject(info.hProcess, 250);
            if waited == u32::MAX { CloseHandle(info.hProcess); return Err("Could not confirm the installer process. The application remains open.".into()); }
            if waited == 0 {
                let mut code = 0; let status = GetExitCodeProcess(info.hProcess, &mut code); CloseHandle(info.hProcess);
                if status == 0 { return Err("Could not confirm the installer launch. The application remains open.".into()); }
                return Err(format!("The installer stopped before handoff (exit code {code}). The application remains open."));
            }
            CloseHandle(info.hProcess);
        }
    }
    // Windows holds the launched executable image. Keep staged files for the
    // installer lifetime, as Tauri's standard updater also does.
    drop(file);
    Ok(directory.keep())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(scope: InstallScope, path: &str) -> InstallationRecord { InstallationRecord { scope, install_location: format!("\"{path}\""), manufacturer_location: path.into(), main_binary: "cellxplorer.exe".into(), bundle_id: None } }
    #[test] fn user_and_machine_keep_exact_directory() {
        for scope in [InstallScope::User, InstallScope::Machine] {
            let r = record(scope, "C:\\Custom Folder\\CellXplorer");
            let identity = installation_identity(AppChannel::Stable, &[r.clone(), r], "C:\\Custom Folder\\CellXplorer\\cellxplorer.exe").unwrap();
            assert_eq!(identity.scope, scope); assert_eq!(identity.directory, "C:\\Custom Folder\\CellXplorer");
        }
    }
    #[test] fn conflicts_missing_records_wrong_channel_and_exe_fail_closed() {
        let r = record(InstallScope::Machine, "C:\\Program Files\\CellXplorer");
        let exe = "C:\\Program Files\\CellXplorer\\cellxplorer.exe";
        assert!(installation_identity(AppChannel::Stable, &[], exe).is_err());
        assert!(installation_identity(AppChannel::Stable, &[r.clone(), record(InstallScope::User, "C:\\Users\\A\\App")], exe).is_err());
        let mut bad = r.clone(); bad.manufacturer_location = "C:\\Other".into();
        assert!(installation_identity(AppChannel::Stable, &[bad], exe).is_err());
        let mut bad = r.clone(); bad.bundle_id = Some("com.cellxplorer.desktop.alpha".into());
        assert!(installation_identity(AppChannel::Stable, &[bad], exe).is_err());
        assert!(installation_identity(AppChannel::Stable, &[r], "C:\\Other\\cellxplorer.exe").is_err());
    }
    #[test] fn paths_reject_roots_network_relative_and_ambiguous_components() {
        for path in ["A€broken", "C:\\", "relative", "\\\\server\\App", "C:\\App\\..\\Else", "C:\\App.", "C:\\App ", "C:\\App\" /CXALLUSERS", "C:\\App:stream"] { assert!(normalized_install_directory(path).is_err(), "{path}"); }
        assert_eq!(normalized_install_directory("\"C:\\App\\\"").unwrap(), "C:\\App");
    }
    #[test] fn updater_arguments_keep_directory_last_and_encode_application_arguments() {
        let identity = InstallationIdentity { scope: InstallScope::Machine, directory: "C:\\Program Files\\CellXplorer".into() };
        let args = vec!["--hidden".into(), "/CXALLUSERS \" space \\".into()];
        let value = update_installer_arguments(&identity, &args).unwrap();
        assert!(value.contains("/CXALLUSERS /CXRESTART="));
        assert!(value.ends_with("/D=C:\\Program Files\\CellXplorer"));
        assert!(!value.contains("/ARGS"));
        assert!(quote_windows_argument("trailing\\").unwrap().ends_with("\\\\\""));
        assert!(update_installer_arguments(&identity, &["long".repeat(200)]).is_err());
        assert!(update_installer_arguments(&identity, &["€".repeat(200)]).is_err());
    }
}
