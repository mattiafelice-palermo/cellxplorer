use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::app_channel::{
    validate_release_version, AppChannel, BETA_CHANNEL_ENDPOINT, BETA_PRODUCT_NAME,
    STABLE_IDENTIFIER,
};
use crate::app_updates::{
    apply_check_result, begin_download, finish_download_failure, finish_download_success,
    take_verified_install, AppUpdateDownloadEvent, AppUpdateRelease, PendingAppUpdate,
    PendingUpdateError,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BetaInstallationInfo {
    pub installed: bool,
    pub installed_version: Option<String>,
    pub executable_path: Option<String>,
}

/// Distinct Tauri-managed state for Stable-owned first-time Beta installation.
///
/// This must remain a real newtype: Tauri keys managed state by concrete `TypeId`, and a type
/// alias would collide with `Mutex<PendingAppUpdate>` used by the standard self-updater.
#[derive(Default)]
pub struct PendingBetaInstall {
    inner: PendingAppUpdate,
}

impl PendingBetaInstall {
    fn inner(&self) -> &PendingAppUpdate {
        &self.inner
    }

    fn inner_mut(&mut self) -> &mut PendingAppUpdate {
        &mut self.inner
    }
}

fn require_stable_channel(app: &AppHandle) -> Result<(), String> {
    if app.config().identifier.as_str() != STABLE_IDENTIFIER {
        return Err(
            "CellXplorer Beta installation is only available from CellXplorer Stable.".to_string(),
        );
    }
    let _ = AppChannel::from_identifier(app.config().identifier.as_str())?;
    Ok(())
}

fn lock_pending<'a>(
    state: &'a State<'_, Mutex<PendingBetaInstall>>,
) -> Result<std::sync::MutexGuard<'a, PendingBetaInstall>, String> {
    state
        .lock()
        .map_err(|_| "The Beta installation state lock is unavailable.".to_string())
}

fn map_pending_error(error: PendingUpdateError) -> String {
    match error {
        PendingUpdateError::AlreadyDownloading => {
            "A CellXplorer Beta download is already in progress.".to_string()
        }
        PendingUpdateError::MissingPendingUpdate | PendingUpdateError::VersionMismatch => {
            "No pending CellXplorer Beta release matches the requested version.".to_string()
        }
        PendingUpdateError::MissingVerifiedBytes => {
            "Download and verify CellXplorer Beta before installing.".to_string()
        }
    }
}

fn user_safe_error(error: impl std::fmt::Display) -> String {
    format!("Could not complete the CellXplorer Beta request: {error}")
}

fn strip_registry_quotes(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

#[cfg(windows)]
fn read_uninstall_value(root: &winreg::RegKey, value_name: &str) -> Option<String> {
    let uninstall = root
        .open_subkey(format!(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{BETA_PRODUCT_NAME}"
        ))
        .ok()?;
    uninstall.get_value(value_name).ok()
}

#[cfg(windows)]
fn read_installed_version_from_registry() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let root = winreg::RegKey::predef(hive);
        if let Some(version) = read_uninstall_value(&root, "DisplayVersion") {
            let version = version.trim();
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
fn resolve_beta_executable_from_registry() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let root = winreg::RegKey::predef(hive);
        if let Some(display_icon) = read_uninstall_value(&root, "DisplayIcon") {
            let path = PathBuf::from(strip_registry_quotes(&display_icon));
            if path.is_file() {
                return Some(path);
            }
        }
        if let Some(install_location) = read_uninstall_value(&root, "InstallLocation") {
            let dir = PathBuf::from(strip_registry_quotes(&install_location));
            let candidate = dir.join("cellxplorer.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn resolve_beta_executable_from_registry() -> Option<PathBuf> {
    None
}

fn read_installed_version(executable: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(version) = read_installed_version_from_registry() {
            return Some(version);
        }
    }
    let _ = executable;
    None
}

fn installation_info_for_executable(executable: Option<PathBuf>) -> BetaInstallationInfo {
    let Some(executable) = executable else {
        return BetaInstallationInfo {
            installed: false,
            installed_version: None,
            executable_path: None,
        };
    };
    let installed_version = read_installed_version(&executable);
    BetaInstallationInfo {
        installed: true,
        installed_version,
        executable_path: Some(executable.to_string_lossy().into_owned()),
    }
}

pub fn detect_beta_installation_info() -> BetaInstallationInfo {
    installation_info_for_executable(resolve_beta_executable_from_registry())
}

fn beta_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let app_for_exit = app.clone();
    let endpoint =
        url::Url::parse(BETA_CHANNEL_ENDPOINT).map_err(|error| user_safe_error(error))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| user_safe_error(error))?
        .on_before_exit(move || {
            crate::prepare_exit_for_update(&app_for_exit);
        })
        .build()
        .map_err(|error| user_safe_error(error))
}

#[tauri::command]
pub fn detect_beta_installation(app: AppHandle) -> Result<BetaInstallationInfo, String> {
    require_stable_channel(&app)?;
    Ok(detect_beta_installation_info())
}

#[tauri::command]
pub async fn check_beta_install(
    app: AppHandle,
    state: State<'_, Mutex<PendingBetaInstall>>,
) -> Result<Option<AppUpdateRelease>, String> {
    require_stable_channel(&app)?;
    let check_revision = {
        let pending = lock_pending(&state)?;
        if pending.inner().is_downloading() {
            return Err(map_pending_error(PendingUpdateError::AlreadyDownloading));
        }
        pending.inner().revision()
    };

    let update = beta_updater(&app)?
        .check()
        .await
        .map_err(|error| user_safe_error(error))?;

    if let Some(candidate) = update.as_ref() {
        validate_release_version(AppChannel::Beta, &candidate.version)?;
    }

    let mut pending = lock_pending(&state)?;
    apply_check_result(pending.inner_mut(), check_revision, update).map_err(map_pending_error)
}

#[tauri::command]
pub async fn download_beta_install(
    app: AppHandle,
    expected_version: String,
    on_progress: Channel<AppUpdateDownloadEvent>,
    state: State<'_, Mutex<PendingBetaInstall>>,
) -> Result<(), String> {
    require_stable_channel(&app)?;
    validate_release_version(AppChannel::Beta, &expected_version)?;
    let (update, generation) = {
        let mut pending = lock_pending(&state)?;
        begin_download(pending.inner_mut(), &expected_version).map_err(map_pending_error)?
    };

    let mut started = false;
    let download_result = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_progress.send(AppUpdateDownloadEvent::Started { content_length });
                }
                let _ = on_progress.send(AppUpdateDownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_progress.send(AppUpdateDownloadEvent::Finished);
            },
        )
        .await;

    let mut pending = lock_pending(&state)?;
    match download_result {
        Ok(bytes) => {
            if !finish_download_success(pending.inner_mut(), generation, &expected_version, bytes) {
                return Err(
                    "The pending CellXplorer Beta release changed while the download was in progress."
                        .to_string(),
                );
            }
            Ok(())
        }
        Err(error) => {
            finish_download_failure(pending.inner_mut(), generation);
            Err(user_safe_error(error))
        }
    }
}

#[tauri::command]
pub fn install_beta(
    app: AppHandle,
    expected_version: String,
    state: State<'_, Mutex<PendingBetaInstall>>,
) -> Result<(), String> {
    require_stable_channel(&app)?;
    validate_release_version(AppChannel::Beta, &expected_version)?;
    let (update, bytes) = {
        let mut pending = lock_pending(&state)?;
        take_verified_install(pending.inner_mut(), &expected_version).map_err(
            |error| match error {
                PendingUpdateError::AlreadyDownloading => {
                    "A CellXplorer Beta download is still in progress.".to_string()
                }
                other => map_pending_error(other),
            },
        )?
    };

    match update.install(&bytes) {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Ok(mut pending) = state.lock() {
                crate::app_updates::restore_failed_install(pending.inner_mut(), update, bytes);
            }
            Err(user_safe_error(error))
        }
    }
}

#[tauri::command]
pub fn open_beta_application(app: AppHandle) -> Result<(), String> {
    require_stable_channel(&app)?;
    let info = detect_beta_installation_info();
    let Some(path) = info.executable_path else {
        return Err("CellXplorer Beta is not installed.".to_string());
    };
    std::process::Command::new(&path)
        .spawn()
        .map_err(|error| format!("Could not open CellXplorer Beta: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::any::TypeId;

    #[test]
    fn strip_registry_quotes_removes_wrapping_quotes() {
        assert_eq!(
            strip_registry_quotes(r#""C:\Program Files\CellXplorer Beta""#),
            r"C:\Program Files\CellXplorer Beta"
        );
    }

    #[test]
    fn missing_executable_reports_not_installed_without_reading_machine_state() {
        let info = installation_info_for_executable(None);
        assert!(!info.installed);
        assert!(info.executable_path.is_none());
    }

    #[test]
    fn beta_pending_state_has_a_distinct_tauri_type() {
        assert_ne!(
            TypeId::of::<PendingBetaInstall>(),
            TypeId::of::<PendingAppUpdate>()
        );
        assert_ne!(
            TypeId::of::<Mutex<PendingBetaInstall>>(),
            TypeId::of::<Mutex<PendingAppUpdate>>()
        );
    }

    #[test]
    fn beta_and_standard_pending_revisions_are_independent() {
        let mut standard = PendingAppUpdate::default();
        let mut beta = PendingBetaInstall::default();

        crate::app_updates::bump_revision(beta.inner_mut());

        assert_eq!(standard.revision(), 0);
        assert_eq!(beta.inner().revision(), 1);

        crate::app_updates::bump_revision(&mut standard);

        assert_eq!(standard.revision(), 1);
        assert_eq!(beta.inner().revision(), 1);
    }
}
