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
struct RegistryRoot {
    root: winreg::RegKey,
    scope: InstallScope,
    uninstall_path: String,
    manufacturer_path: String,
}

#[cfg(windows)]
fn registry_key_if_present<T>(result: std::io::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(key) => Ok(Some(key)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read installation scope from the registry.".into()),
    }
}

#[cfg(windows)]
fn optional_manufacturer_location(key: Option<&winreg::RegKey>) -> Result<Option<String>, String> {
    let Some(key) = key else { return Ok(None); };
    match key.get_value::<String, _>("") {
        Ok(location) => Ok(Some(location)),
        // NSIS also stores its language preference in this product key. That
        // metadata-only key has no default value and is not an installation.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("The registered installation location is invalid.".into()),
    }
}

#[cfg(windows)]
fn registered_records_from_roots(roots: &[RegistryRoot]) -> Result<Vec<InstallationRecord>, String> {
    use winreg::enums::*;
    let mut records = Vec::new();
    for registry_root in roots {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let key = registry_key_if_present(registry_root.root.open_subkey_with_flags(&registry_root.uninstall_path, KEY_READ | view))?;
            let manufacturer = registry_key_if_present(registry_root.root.open_subkey_with_flags(&registry_root.manufacturer_path, KEY_READ | view))?;
            let location = optional_manufacturer_location(manufacturer.as_ref())?;
            if key.is_none() && location.is_none() { continue; }
            if key.is_none() {
                // Legacy keep-data uninstallers left this value. Ignore only
                // a valid local path with neither application nor uninstaller.
                let path = normalized_install_directory(location.as_deref().unwrap_or_default())?;
                if !std::path::Path::new(&path).join("cellxplorer.exe").exists() && !std::path::Path::new(&path).join("uninstall.exe").exists() { continue; }
            }
            let key = key.ok_or("The installation registry record is incomplete.")?;
            match key.get_value::<String, _>("InstallScope") {
                Ok(value) if value == if registry_root.scope == InstallScope::User { "user" } else { "machine" } => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                _ => return Err("The registered installation scope conflicts with its registry hive.".into()),
            }
            records.push(InstallationRecord {
                scope: registry_root.scope,
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
fn registered_records(channel: AppChannel) -> Result<Vec<InstallationRecord>, String> {
    use winreg::{enums::*, RegKey};
    let uninstall_path = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", channel.product_name());
    let manufacturer_path = format!("Software\\cellxplorer\\{}", channel.product_name());
    let roots = [
        RegistryRoot { root: RegKey::predef(HKEY_CURRENT_USER), scope: InstallScope::User, uninstall_path: uninstall_path.clone(), manufacturer_path: manufacturer_path.clone() },
        RegistryRoot { root: RegKey::predef(HKEY_LOCAL_MACHINE), scope: InstallScope::Machine, uninstall_path, manufacturer_path },
    ];
    registered_records_from_roots(&roots)
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

#[cfg(all(test, windows))]
mod registry_reader_tests {
    use super::*;
    use std::{sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};
    use winreg::{enums::*, RegKey};

    // HKCU\Software can be shared across WOW64 views. Fixture identities use
    // distinct subkeys so conflict coverage does not depend on view isolation.
    const VIEWS: [u32; 2] = [KEY_WOW64_64KEY, KEY_WOW64_32KEY];
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct FixtureNamespace { path: String }

    impl FixtureNamespace {
        fn new() -> Self {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let path = format!("Software\\CellXplorerRegistryReaderTests-{}-{now}-{sequence}", std::process::id());
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&path).expect("create isolated HKCU fixture namespace");
            drop(key);
            Self { path }
        }

        fn root(&self, label: &str, scope: InstallScope) -> RegistryRoot {
            let prefix = format!("{}\\{label}", self.path);
            RegistryRoot {
                root: RegKey::predef(HKEY_CURRENT_USER),
                scope,
                uninstall_path: format!("{prefix}\\Uninstall"),
                manufacturer_path: format!("{prefix}\\Manufacturer"),
            }
        }
    }

    impl Drop for FixtureNamespace {
        fn drop(&mut self) {
            // Delete only the unique subtree created by this test fixture.
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.path);
        }
    }

    fn create_fixture_key(path: &str, view: u32) -> RegKey {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags(path, KEY_READ | KEY_WRITE | view)
            .expect("create key inside the disposable HKCU fixture namespace");
        key
    }

    fn write_language_only_key(root: &RegistryRoot, view: u32) {
        let key = create_fixture_key(&root.manufacturer_path, view);
        key.set_value("Installer Language", &"1033".to_owned()).expect("write fixture language metadata");
    }

    fn write_registration(root: &RegistryRoot, view: u32, path: &str, manufacturer_default: bool) {
        let uninstall = create_fixture_key(&root.uninstall_path, view);
        let quoted_path = format!("\"{path}\"");
        let scope = if root.scope == InstallScope::User { "user" } else { "machine" };
        uninstall.set_value("InstallLocation", &quoted_path).unwrap();
        uninstall.set_value("InstallScope", &scope).unwrap();
        uninstall.set_value("MainBinaryName", &"cellxplorer.exe".to_owned()).unwrap();
        uninstall.set_value("BundleId", &crate::app_channel::ALPHA_IDENTIFIER.to_owned()).unwrap();
        if manufacturer_default {
            let manufacturer = create_fixture_key(&root.manufacturer_path, view);
            manufacturer.set_value("", &path.to_owned()).unwrap();
        }
    }

    #[test]
    fn language_only_hkcu_key_does_not_hide_machine_like_registration_in_either_view() {
        let fixture = FixtureNamespace::new();
        let user = fixture.root("UserFixture", InstallScope::User);
        let machine = fixture.root("MachineFixture", InstallScope::Machine);
        for view in VIEWS {
            write_language_only_key(&user, view);
            write_registration(&machine, view, "C:\\Alpha\\Fixture", true);
        }

        let records = registered_records_from_roots(&[user, machine]).unwrap();
        assert_eq!(records.len(), 2, "the valid duplicate-view registration should be collected");
        let identity = registered_identity(AppChannel::Alpha, &records).unwrap();
        assert_eq!(identity.scope, InstallScope::Machine);
        assert_eq!(identity.directory, "C:\\Alpha\\Fixture");
    }

    #[test]
    fn absent_keys_and_language_key_without_default_are_not_installations() {
        let fixture = FixtureNamespace::new();
        let empty = fixture.root("EmptyFixture", InstallScope::User);
        let metadata_only = fixture.root("MetadataFixture", InstallScope::User);
        write_language_only_key(&metadata_only, KEY_WOW64_32KEY);

        assert!(registered_records_from_roots(&[empty]).unwrap().is_empty());
        assert!(registered_records_from_roots(&[metadata_only]).unwrap().is_empty());
    }

    #[test]
    fn uninstall_registration_without_manufacturer_default_remains_incomplete() {
        let fixture = FixtureNamespace::new();
        let machine = fixture.root("IncompleteFixture", InstallScope::Machine);
        write_registration(&machine, KEY_WOW64_64KEY, "C:\\Alpha\\Fixture", false);
        write_language_only_key(&machine, KEY_WOW64_64KEY);

        let error = registered_records_from_roots(&[machine]).unwrap_err();
        assert_eq!(error, "The installation manufacturer record is missing.");
    }

    #[test]
    fn malformed_and_non_string_manufacturer_defaults_remain_rejected() {
        let fixture = FixtureNamespace::new();
        let malformed = fixture.root("MalformedFixture", InstallScope::User);
        let malformed_key = create_fixture_key(&malformed.manufacturer_path, KEY_WOW64_64KEY);
        malformed_key.set_value("", &"relative\\path".to_owned()).unwrap();
        assert!(registered_records_from_roots(&[malformed]).is_err());

        let non_string = fixture.root("NonStringFixture", InstallScope::User);
        let non_string_key = create_fixture_key(&non_string.manufacturer_path, KEY_WOW64_32KEY);
        non_string_key.set_value("", &1033u32).unwrap();
        let error = registered_records_from_roots(&[non_string]).unwrap_err();
        assert_eq!(error, "The registered installation location is invalid.");
    }

    #[test]
    fn registry_access_errors_are_not_downgraded_to_missing_keys() {
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "fixture key missing");
        assert!(registry_key_if_present::<()>(Err(missing)).unwrap().is_none());
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "fixture access denied");
        assert_eq!(registry_key_if_present::<()>(Err(denied)).unwrap_err(), "Could not read installation scope from the registry.");
    }

    #[test]
    fn restricted_registry_handle_cannot_turn_a_read_error_into_missing_location() {
        let fixture = FixtureNamespace::new();
        let machine = fixture.root("RestrictedFixture", InstallScope::Machine);
        let writable = create_fixture_key(&machine.manufacturer_path, KEY_WOW64_64KEY);
        writable.set_value("", &"C:\\Alpha\\Fixture".to_owned()).unwrap();
        drop(writable);
        let restricted = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&machine.manufacturer_path, KEY_SET_VALUE | KEY_WOW64_64KEY)
            .expect("reopen only the disposable fixture key with write-only value access");

        let error = optional_manufacturer_location(Some(&restricted)).unwrap_err();
        assert_eq!(error, "The registered installation location is invalid.");
    }

    #[test]
    fn conflicting_disjoint_fixture_roots_remain_rejected() {
        let fixture = FixtureNamespace::new();
        let first = fixture.root("FirstMachineFixture", InstallScope::Machine);
        let second = fixture.root("SecondMachineFixture", InstallScope::Machine);
        write_registration(&first, KEY_WOW64_64KEY, "C:\\Alpha\\First", true);
        write_registration(&second, KEY_WOW64_32KEY, "C:\\Alpha\\Second", true);

        match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(&first.uninstall_path, KEY_READ | KEY_WOW64_32KEY) {
            Ok(_) => eprintln!("HKCU Software fixture keys are visible across WOW64 views on this host."),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => eprintln!("HKCU Software fixture keys are isolated by WOW64 view on this host."),
            Err(error) => panic!("could not inspect the disposable fixture's alternate registry view: {error}"),
        }

        let records = registered_records_from_roots(&[first, second]).unwrap();
        assert!(records.len() >= 2);
        assert!(records.iter().any(|record| record.install_location.contains("First")));
        assert!(records.iter().any(|record| record.install_location.contains("Second")));
        assert!(registered_identity(AppChannel::Alpha, &records).is_err());
    }

    #[test]
    fn dropping_fixture_removes_its_unique_hkcu_namespace() {
        let fixture = FixtureNamespace::new();
        let path = fixture.path.clone();
        let key = create_fixture_key(&format!("{path}\\OwnedValue"), KEY_WOW64_64KEY);
        key.set_value("Marker", &"test-only".to_owned()).unwrap();
        drop(key);
        drop(fixture);

        let result = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&path);
        assert!(matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::NotFound));
    }
}
