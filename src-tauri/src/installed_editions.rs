//! Read-only bootstrap discovery. Unknown is never equivalent to absent.
use crate::app_channel::AppChannel;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Availability {
    Installed,
    Absent,
    Unknown,
}

#[derive(Serialize)]
pub struct InstalledEdition {
    channel: &'static str,
    availability: Availability,
}

fn combine(evidence: &[Availability]) -> Availability {
    if evidence.contains(&Availability::Installed) {
        Availability::Installed
    } else if evidence.is_empty() || evidence.contains(&Availability::Unknown) {
        Availability::Unknown
    } else {
        Availability::Absent
    }
}

#[cfg(windows)]
fn installation_payload_availability(
    executable: std::io::Result<bool>,
    uninstaller: std::io::Result<bool>,
    has_uninstall_registration: bool,
) -> Availability {
    match (executable, uninstaller) {
        (Ok(false), Ok(false)) => Availability::Absent,
        (Ok(true), Ok(_)) if has_uninstall_registration => Availability::Installed,
        _ => Availability::Unknown,
    }
}

#[cfg(windows)]
fn probe_installation_directory(directory: &str, has_uninstall_registration: bool) -> Availability {
    use std::{
        io::{Error, ErrorKind},
        path::Path,
    };
    let file_present = |name: &str| match Path::new(directory).join(name).metadata() {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(Error::new(
            ErrorKind::InvalidData,
            "Expected an installation file.",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    };
    // Missing payloads prove a stale installation entry. Read errors and
    // unexpected objects must not silently count as missing files.
    installation_payload_availability(
        file_present("cellxplorer.exe"),
        file_present("uninstall.exe"),
        has_uninstall_registration,
    )
}

#[cfg(windows)]
fn probe_registration(result: std::io::Result<winreg::RegKey>) -> Availability {
    use std::io::ErrorKind;
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Availability::Absent,
        Err(_) => Availability::Unknown,
        Ok(key) => {
            // An unreadable/malformed registration is not proof of absence.
            let location: Result<String, _> = key.get_value("InstallLocation");
            let Ok(location) = location else {
                return Availability::Unknown;
            };
            let Ok(directory) = crate::installation_scope::normalized_install_directory(&location)
            else {
                return Availability::Unknown;
            };
            probe_installation_directory(&directory, true)
        }
    }
}

#[cfg(windows)]
fn probe_manufacturer_registration(result: std::io::Result<winreg::RegKey>) -> Availability {
    use std::io::ErrorKind;
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Availability::Absent,
        Err(_) => Availability::Unknown,
        Ok(key) => match key.get_value::<String, _>("") {
            Ok(location) => {
                match crate::installation_scope::normalized_install_directory(&location) {
                    Ok(directory) => probe_installation_directory(&directory, false),
                    Err(_) => Availability::Unknown,
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Availability::Absent,
            Err(_) => Availability::Unknown,
        },
    }
}

#[cfg(windows)]
fn discover(channel: AppChannel) -> Availability {
    use winreg::{enums::*, RegKey};
    let mut evidence = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let root = RegKey::predef(hive);
            let key = root.open_subkey_with_flags(
                format!(
                    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
                    channel.product_name()
                ),
                KEY_READ | view,
            );
            let mut availability = probe_registration(key);
            if availability == Availability::Absent {
                // A manufacturer-only legacy registration may still represent
                // an application. Language-only keys do not represent installs.
                availability = probe_manufacturer_registration(root.open_subkey_with_flags(
                    format!(r"Software\cellxplorer\{}", channel.product_name()),
                    KEY_READ | view,
                ));
            }
            evidence.push(availability);
        }
    }
    combine(&evidence)
}

#[cfg(not(windows))]
fn discover(_channel: AppChannel) -> Availability {
    Availability::Unknown
}

#[tauri::command]
pub fn detect_installed_editions(app: tauri::AppHandle) -> Result<Vec<InstalledEdition>, String> {
    let current = AppChannel::from_identifier(app.config().identifier.as_str())?;
    if current == AppChannel::Stable {
        return Err("Bootstrap discovery is available only in Alpha/Beta.".into());
    }
    Ok([AppChannel::Stable, AppChannel::Beta, AppChannel::Alpha]
        .into_iter()
        .map(|channel| InstalledEdition {
            channel: channel.as_str(),
            availability: if channel == current {
                Availability::Installed
            } else {
                discover(channel)
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    struct RegistryFixture(String);

    #[cfg(windows)]
    impl Drop for RegistryFixture {
        fn drop(&mut self) {
            let _ =
                winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(&self.0);
        }
    }

    #[cfg(windows)]
    fn registry_fixture() -> (RegistryFixture, winreg::RegKey) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
        let namespace = format!(
            r"Software\CellXplorer.Tests\installed-editions-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        );
        let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(&namespace)
            .unwrap();
        (RegistryFixture(namespace), key)
    }

    #[cfg(windows)]
    #[test]
    fn native_manufacturer_only_stale_entry_is_absent() {
        let (_fixture, key) = registry_fixture();
        let directory = tempfile::tempdir().unwrap();
        let removed_install = directory.path().join("removed-stable");
        key.set_value("", &removed_install.to_string_lossy().to_string())
            .unwrap();
        let evidence = probe_manufacturer_registration(Ok(key));
        assert_eq!(evidence, Availability::Absent);
        assert_eq!(
            combine(&[
                Availability::Absent,
                Availability::Absent,
                evidence,
                Availability::Absent
            ]),
            Availability::Absent
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_manufacturer_records_preserve_partial_invalid_and_denied_states() {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let (fixture, key) = registry_fixture();
        let probe = || {
            probe_manufacturer_registration(
                RegKey::predef(HKEY_CURRENT_USER).open_subkey(&fixture.0),
            )
        };
        // Language-only keys carry no installation default value.
        key.set_value("Installer Language", &1033u32).unwrap();
        assert_eq!(probe(), Availability::Absent);
        key.set_value("", &123u32).unwrap();
        assert_eq!(probe(), Availability::Unknown);
        key.set_value("", &"relative\\directory").unwrap();
        assert_eq!(probe(), Availability::Unknown);
        let directory = tempfile::tempdir().unwrap();
        key.set_value("", &directory.path().to_string_lossy().to_string())
            .unwrap();
        assert_eq!(probe(), Availability::Absent);
        std::fs::write(directory.path().join("uninstall.exe"), b"never executed").unwrap();
        assert_eq!(probe(), Availability::Unknown);
        std::fs::remove_file(directory.path().join("uninstall.exe")).unwrap();
        std::fs::write(directory.path().join("cellxplorer.exe"), b"never executed").unwrap();
        assert_eq!(
            probe(),
            Availability::Unknown,
            "A surviving application without uninstall registration is incomplete, not absent"
        );
        assert_eq!(
            probe_manufacturer_registration(
                RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(&fixture.0, 0)
            ),
            Availability::Unknown
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_stale_uninstall_entry_is_absent_but_partial_payloads_are_unknown() {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let (fixture, key) = registry_fixture();
        let directory = tempfile::tempdir().unwrap();
        key.set_value(
            "InstallLocation",
            &format!("\"{}\"", directory.path().display()),
        )
        .unwrap();
        let probe =
            || probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&fixture.0));
        assert_eq!(probe(), Availability::Absent);
        std::fs::write(directory.path().join("uninstall.exe"), b"never executed").unwrap();
        assert_eq!(probe(), Availability::Unknown);
        std::fs::write(directory.path().join("cellxplorer.exe"), b"never executed").unwrap();
        assert_eq!(probe(), Availability::Installed);
        std::fs::remove_file(directory.path().join("cellxplorer.exe")).unwrap();
        std::fs::remove_file(directory.path().join("uninstall.exe")).unwrap();
        std::fs::create_dir(directory.path().join("uninstall.exe")).unwrap();
        assert_eq!(
            probe(),
            Availability::Unknown,
            "An unexpected object is not a missing file"
        );
    }

    #[cfg(windows)]
    #[test]
    fn payload_read_errors_never_prove_stale_absence() {
        use std::io::{Error, ErrorKind};
        for registered in [true, false] {
            assert_eq!(
                installation_payload_availability(
                    Err(Error::from(ErrorKind::PermissionDenied)),
                    Ok(false),
                    registered
                ),
                Availability::Unknown
            );
            assert_eq!(
                installation_payload_availability(
                    Ok(false),
                    Err(Error::from(ErrorKind::PermissionDenied)),
                    registered
                ),
                Availability::Unknown
            );
            assert_eq!(
                installation_payload_availability(
                    Ok(true),
                    Err(Error::from(ErrorKind::PermissionDenied)),
                    registered
                ),
                Availability::Unknown
            );
        }
    }
    #[test]
    fn discovery_requires_positive_evidence_and_complete_absence_checks() {
        use Availability::*;
        assert_eq!(combine(&[]), Unknown);
        assert_eq!(combine(&[Absent, Absent, Absent, Absent]), Absent);
        assert_eq!(combine(&[Absent, Unknown]), Unknown);
        assert_eq!(combine(&[Unknown, Installed]), Installed);
        assert_eq!(combine(&[Installed, Absent]), Installed);
    }

    #[cfg(windows)]
    #[test]
    fn native_registry_probe_preserves_missing_corrupt_stale_and_read_failure_states() {
        use std::io::{Error, ErrorKind};
        use winreg::{enums::*, RegKey};
        let (fixture, key) = registry_fixture();
        let namespace = &fixture.0;
        assert_eq!(
            probe_registration(key.open_subkey("missing")),
            Availability::Absent
        );
        assert_eq!(
            probe_registration(Err(Error::from(ErrorKind::PermissionDenied))),
            Availability::Unknown
        );
        assert_eq!(
            probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&namespace)),
            Availability::Unknown
        );
        key.set_value("InstallLocation", &123u32).unwrap();
        assert_eq!(
            probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&namespace)),
            Availability::Unknown
        );
        key.set_value("InstallLocation", &"relative\\directory")
            .unwrap();
        assert_eq!(
            probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&namespace)),
            Availability::Unknown
        );
        let directory = tempfile::tempdir().unwrap();
        let quoted = format!("\"{}\"", directory.path().display());
        key.set_value("InstallLocation", &quoted).unwrap();
        assert_eq!(
            probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&namespace)),
            Availability::Absent
        );
        std::fs::write(
            directory.path().join("cellxplorer.exe"),
            b"disposable detection fixture; never executed",
        )
        .unwrap();
        assert_eq!(
            probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&namespace)),
            Availability::Installed
        );
        assert_eq!(
            probe_registration(
                RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(&namespace, 0)
            ),
            Availability::Unknown
        );
        // Preserve significant Unicode path characters, matching installer scope resolution.
        let unicode_directory = directory.path().join("edition\u{a0}");
        std::fs::create_dir(&unicode_directory).unwrap();
        std::fs::write(unicode_directory.join("cellxplorer.exe"), b"never executed").unwrap();
        key.set_value(
            "InstallLocation",
            &unicode_directory.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(
            probe_registration(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&namespace)),
            Availability::Installed
        );
    }
}
