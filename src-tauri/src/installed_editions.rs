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
fn probe_registration(result: std::io::Result<winreg::RegKey>) -> Availability {
    use std::{io::ErrorKind, path::PathBuf};
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Availability::Absent,
        Err(_) => Availability::Unknown,
        Ok(key) => {
            // An unreadable/malformed registration or stale executable is not proof of absence.
            let location: Result<String, _> = key.get_value("InstallLocation");
            let Ok(location) = location else {
                return Availability::Unknown;
            };
            let Ok(directory) = crate::installation_scope::normalized_install_directory(&location)
            else {
                return Availability::Unknown;
            };
            match PathBuf::from(directory).join("cellxplorer.exe").metadata() {
                Ok(metadata) if metadata.is_file() => Availability::Installed,
                _ => Availability::Unknown,
            }
        }
    }
}

#[cfg(windows)]
fn discover(channel: AppChannel) -> Availability {
    use std::io::ErrorKind;
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
                match root.open_subkey_with_flags(
                    format!(r"Software\cellxplorer\{}", channel.product_name()),
                    KEY_READ | view,
                ) {
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(_) => availability = Availability::Unknown,
                    Ok(key) => match key.get_value::<String, _>("") {
                        Err(error) if error.kind() == ErrorKind::NotFound => {}
                        _ => availability = Availability::Unknown,
                    },
                }
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
        let namespace = format!(
            r"Software\CellXplorer.Tests\installed-editions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        struct Fixture(String);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0);
            }
        }
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(&namespace)
            .unwrap();
        let _fixture = Fixture(namespace.clone());
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
            Availability::Unknown
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
