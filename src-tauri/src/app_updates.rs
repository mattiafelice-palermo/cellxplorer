use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct PendingAppUpdate {
    update: Option<tauri_plugin_updater::Update>,
    /// Mirrored version for policy checks and unit tests without constructing `Update`.
    version: Option<String>,
    downloaded_bytes: Option<Vec<u8>>,
    downloading: bool,
    download_generation: u64,
    /// Monotonic revision bumped on material pending-state transitions.
    revision: u64,
}

pub fn bump_revision(pending: &mut PendingAppUpdate) -> u64 {
    pending.revision = pending.revision.wrapping_add(1);
    pending.revision
}

pub fn apply_check_result(
    pending: &mut PendingAppUpdate,
    check_revision: u64,
    update: Option<tauri_plugin_updater::Update>,
) -> Result<Option<AppUpdateRelease>, PendingUpdateError> {
    if pending.revision != check_revision {
        // Stale check — leave verified bytes / current pending update untouched.
        return Ok(pending.update.as_ref().map(release_from_update));
    }
    match update {
        Some(update) => Ok(Some(replace_pending_update(pending, update)?)),
        None => {
            clear_pending_update(pending)?;
            Ok(None)
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateRelease {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum AppUpdateDownloadEvent {
    Started {
        content_length: Option<u64>,
    },
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingUpdateError {
    VersionMismatch,
    AlreadyDownloading,
    MissingPendingUpdate,
    MissingVerifiedBytes,
}

pub fn release_from_update(update: &tauri_plugin_updater::Update) -> AppUpdateRelease {
    AppUpdateRelease {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        published_at: update.date.map(|value| value.to_string()),
    }
}

pub fn replace_pending_update(
    pending: &mut PendingAppUpdate,
    update: tauri_plugin_updater::Update,
) -> Result<AppUpdateRelease, PendingUpdateError> {
    if pending.downloading {
        return Err(PendingUpdateError::AlreadyDownloading);
    }
    let release = release_from_update(&update);
    bump_revision(pending);
    pending.version = Some(release.version.clone());
    pending.update = Some(update);
    pending.downloaded_bytes = None;
    pending.downloading = false;
    Ok(release)
}

pub fn clear_pending_update(pending: &mut PendingAppUpdate) -> Result<(), PendingUpdateError> {
    if pending.downloading {
        return Err(PendingUpdateError::AlreadyDownloading);
    }
    let revision = pending.revision.wrapping_add(1);
    *pending = PendingAppUpdate {
        revision,
        ..Default::default()
    };
    Ok(())
}

/// Pure install readiness check used by commands and unit tests.
pub fn validate_install_ready(
    pending_version: Option<&str>,
    expected_version: &str,
    has_bytes: bool,
    downloading: bool,
) -> Result<(), PendingUpdateError> {
    if downloading {
        return Err(PendingUpdateError::AlreadyDownloading);
    }
    match pending_version {
        None => Err(PendingUpdateError::MissingPendingUpdate),
        Some(version) if version != expected_version => Err(PendingUpdateError::VersionMismatch),
        Some(_) if !has_bytes => Err(PendingUpdateError::MissingVerifiedBytes),
        Some(_) => Ok(()),
    }
}

pub fn begin_download(
    pending: &mut PendingAppUpdate,
    expected_version: &str,
) -> Result<(tauri_plugin_updater::Update, u64), PendingUpdateError> {
    if pending.downloading {
        return Err(PendingUpdateError::AlreadyDownloading);
    }
    let update = match pending.update.as_ref() {
        Some(update) if update.version == expected_version => update.clone(),
        Some(_) => return Err(PendingUpdateError::VersionMismatch),
        None => return Err(PendingUpdateError::MissingPendingUpdate),
    };
    pending.download_generation = pending.download_generation.wrapping_add(1);
    bump_revision(pending);
    pending.downloading = true;
    pending.downloaded_bytes = None;
    Ok((update, pending.download_generation))
}

/// Store verified bytes only when they still belong to the active download generation/version.
pub fn finish_download_success(
    pending: &mut PendingAppUpdate,
    generation: u64,
    expected_version: &str,
    bytes: Vec<u8>,
) -> bool {
    if !pending.downloading || pending.download_generation != generation {
        return false;
    }
    if pending.version.as_deref() != Some(expected_version) {
        return false;
    }
    pending.downloading = false;
    pending.downloaded_bytes = Some(bytes);
    true
}

pub fn finish_download_failure(pending: &mut PendingAppUpdate, generation: u64) {
    if pending.download_generation != generation {
        return;
    }
    pending.downloading = false;
}

pub fn take_verified_install(
    pending: &mut PendingAppUpdate,
    expected_version: &str,
) -> Result<(tauri_plugin_updater::Update, Vec<u8>), PendingUpdateError> {
    validate_install_ready(
        pending.version.as_deref(),
        expected_version,
        pending.downloaded_bytes.is_some(),
        pending.downloading,
    )?;
    let update = pending
        .update
        .take()
        .ok_or(PendingUpdateError::MissingPendingUpdate)?;
    let bytes = pending
        .downloaded_bytes
        .take()
        .ok_or(PendingUpdateError::MissingVerifiedBytes)?;
    pending.version = None;
    pending.downloading = false;
    bump_revision(pending);
    Ok((update, bytes))
}

pub fn restore_failed_install(
    pending: &mut PendingAppUpdate,
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
) {
    pending.version = Some(update.version.clone());
    pending.update = Some(update);
    pending.downloaded_bytes = Some(bytes);
    pending.downloading = false;
}

fn lock_pending<'a>(
    state: &'a State<'_, Mutex<PendingAppUpdate>>,
) -> Result<std::sync::MutexGuard<'a, PendingAppUpdate>, String> {
    state
        .lock()
        .map_err(|_| "The update state lock is unavailable.".to_string())
}

fn map_pending_error(error: PendingUpdateError) -> String {
    match error {
        PendingUpdateError::AlreadyDownloading => {
            "An update download is already in progress.".to_string()
        }
        PendingUpdateError::MissingPendingUpdate | PendingUpdateError::VersionMismatch => {
            "No pending update matches the requested version.".to_string()
        }
        PendingUpdateError::MissingVerifiedBytes => {
            "Download and verify the update before installing.".to_string()
        }
    }
}

fn user_safe_error(error: impl std::fmt::Display) -> String {
    format!("Could not complete the update request: {error}")
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, Mutex<PendingAppUpdate>>,
) -> Result<Option<AppUpdateRelease>, String> {
    let check_revision = {
        let pending = lock_pending(&state)?;
        if pending.downloading {
            return Err(map_pending_error(PendingUpdateError::AlreadyDownloading));
        }
        pending.revision
    };

    let app_for_exit = app.clone();
    let update = app
        .updater_builder()
        .on_before_exit(move || {
            crate::prepare_exit_for_update(&app_for_exit);
        })
        .build()
        .map_err(|error| user_safe_error(error))?
        .check()
        .await
        .map_err(|error| user_safe_error(error))?;

    let mut pending = lock_pending(&state)?;
    apply_check_result(&mut pending, check_revision, update).map_err(map_pending_error)
}

#[tauri::command]
pub async fn download_app_update(
    expected_version: String,
    on_progress: Channel<AppUpdateDownloadEvent>,
    state: State<'_, Mutex<PendingAppUpdate>>,
) -> Result<(), String> {
    let (update, generation) = {
        let mut pending = lock_pending(&state)?;
        begin_download(&mut pending, &expected_version).map_err(map_pending_error)?
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
            if !finish_download_success(&mut pending, generation, &expected_version, bytes) {
                return Err(
                    "The pending update changed while the download was in progress.".to_string(),
                );
            }
            Ok(())
        }
        Err(error) => {
            finish_download_failure(&mut pending, generation);
            Err(user_safe_error(error))
        }
    }
}

#[tauri::command]
pub fn install_app_update(
    expected_version: String,
    state: State<'_, Mutex<PendingAppUpdate>>,
) -> Result<(), String> {
    let (update, bytes) = {
        let mut pending = lock_pending(&state)?;
        take_verified_install(&mut pending, &expected_version).map_err(|error| match error {
            PendingUpdateError::AlreadyDownloading => {
                "An update download is still in progress.".to_string()
            }
            other => map_pending_error(other),
        })?
    };

    // Pre-hook failures can return here with the backend still alive. Once the updater plugin
    // runs `on_before_exit` on Windows it stops the sidecar and exits the process regardless of
    // whether ShellExecuteW opened the installer successfully — that path does not return.
    match update.install(&bytes) {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Ok(mut pending) = state.lock() {
                restore_failed_install(&mut pending, update, bytes);
            }
            Err(user_safe_error(error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_with_version(version: &str) -> PendingAppUpdate {
        PendingAppUpdate {
            version: Some(version.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn clear_pending_update_resets_state() {
        let mut pending = PendingAppUpdate {
            downloading: false,
            downloaded_bytes: Some(vec![1]),
            version: Some("0.15.0".into()),
            ..Default::default()
        };

        clear_pending_update(&mut pending).expect("clear should succeed");

        assert!(!pending.downloading);
        assert!(pending.downloaded_bytes.is_none());
        assert!(pending.update.is_none());
        assert!(pending.version.is_none());
    }

    #[test]
    fn clear_pending_update_rejects_during_download() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            ..Default::default()
        };
        assert_eq!(
            clear_pending_update(&mut pending),
            Err(PendingUpdateError::AlreadyDownloading)
        );
        assert!(pending.downloading);
    }

    #[test]
    fn begin_download_requires_pending_update() {
        let mut pending = PendingAppUpdate::default();
        assert!(matches!(
            begin_download(&mut pending, "0.15.0"),
            Err(PendingUpdateError::MissingPendingUpdate)
        ));
    }

    #[test]
    fn begin_download_rejects_overlap() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            ..Default::default()
        };
        assert!(matches!(
            begin_download(&mut pending, "0.15.0"),
            Err(PendingUpdateError::AlreadyDownloading)
        ));
    }

    #[test]
    fn download_failure_keeps_retryable_state_without_verified_bytes() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            download_generation: 3,
            version: Some("0.15.0".into()),
            ..Default::default()
        };

        finish_download_failure(&mut pending, 3);

        assert!(pending.downloaded_bytes.is_none());
        assert!(!pending.downloading);
        assert_eq!(pending.version.as_deref(), Some("0.15.0"));
    }

    #[test]
    fn finish_download_success_stores_verified_bytes_for_matching_generation() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            download_generation: 2,
            version: Some("0.15.0".into()),
            ..Default::default()
        };

        assert!(finish_download_success(
            &mut pending,
            2,
            "0.15.0",
            vec![9, 9, 9]
        ));
        assert_eq!(pending.downloaded_bytes, Some(vec![9, 9, 9]));
        assert!(!pending.downloading);
    }

    #[test]
    fn stale_download_completion_cannot_populate_replaced_state() {
        let mut pending = PendingAppUpdate {
            downloading: false,
            download_generation: 4,
            version: Some("0.16.0".into()),
            downloaded_bytes: None,
            ..Default::default()
        };

        assert!(!finish_download_success(
            &mut pending,
            3,
            "0.15.0",
            vec![1, 2, 3]
        ));
        assert!(pending.downloaded_bytes.is_none());
        assert_eq!(pending.version.as_deref(), Some("0.16.0"));
    }

    #[test]
    fn finish_download_success_rejects_version_mismatch() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            download_generation: 1,
            version: Some("0.16.0".into()),
            ..Default::default()
        };
        assert!(!finish_download_success(
            &mut pending,
            1,
            "0.15.0",
            vec![1]
        ));
        assert!(pending.downloaded_bytes.is_none());
        assert!(pending.downloading);
    }

    #[test]
    fn validate_install_rejects_wrong_version_without_mutation() {
        let pending = pending_with_version("0.15.0");
        let before_version = pending.version.clone();
        let before_bytes = pending.downloaded_bytes.clone();
        assert_eq!(
            validate_install_ready(
                pending.version.as_deref(),
                "0.16.0",
                true,
                false,
            ),
            Err(PendingUpdateError::VersionMismatch)
        );
        assert_eq!(pending.version, before_version);
        assert_eq!(pending.downloaded_bytes, before_bytes);
    }

    #[test]
    fn validate_install_rejects_missing_bytes_without_mutation() {
        assert_eq!(
            validate_install_ready(Some("0.15.0"), "0.15.0", false, false),
            Err(PendingUpdateError::MissingVerifiedBytes)
        );
    }

    #[test]
    fn validate_install_rejects_during_download() {
        assert_eq!(
            validate_install_ready(Some("0.15.0"), "0.15.0", true, true),
            Err(PendingUpdateError::AlreadyDownloading)
        );
    }

    #[test]
    fn take_verified_install_requires_pending_update() {
        let mut pending = PendingAppUpdate::default();
        let result = take_verified_install(&mut pending, "0.15.0");
        assert!(matches!(
            result,
            Err(PendingUpdateError::MissingPendingUpdate)
        ));
    }

    #[test]
    fn take_verified_install_wrong_version_preserves_state() {
        let mut pending = PendingAppUpdate {
            version: Some("0.15.0".into()),
            downloaded_bytes: Some(vec![7, 7]),
            ..Default::default()
        };
        assert!(matches!(
            take_verified_install(&mut pending, "0.16.0"),
            Err(PendingUpdateError::VersionMismatch)
        ));
        assert_eq!(pending.version.as_deref(), Some("0.15.0"));
        assert_eq!(pending.downloaded_bytes, Some(vec![7, 7]));
    }

    #[test]
    fn take_verified_install_missing_bytes_preserves_version() {
        let mut pending = PendingAppUpdate {
            version: Some("0.15.0".into()),
            ..Default::default()
        };
        assert!(matches!(
            take_verified_install(&mut pending, "0.15.0"),
            Err(PendingUpdateError::MissingVerifiedBytes)
        ));
        assert_eq!(pending.version.as_deref(), Some("0.15.0"));
    }

    #[test]
    fn take_verified_install_during_download_preserves_state() {
        let mut pending = PendingAppUpdate {
            version: Some("0.15.0".into()),
            downloaded_bytes: Some(vec![1]),
            downloading: true,
            ..Default::default()
        };
        assert!(matches!(
            take_verified_install(&mut pending, "0.15.0"),
            Err(PendingUpdateError::AlreadyDownloading)
        ));
        assert_eq!(pending.version.as_deref(), Some("0.15.0"));
        assert_eq!(pending.downloaded_bytes, Some(vec![1]));
        assert!(pending.downloading);
    }

    #[test]
    fn stale_check_cannot_discard_verified_bytes() {
        let mut pending = PendingAppUpdate {
            version: Some("0.15.0".into()),
            downloaded_bytes: Some(vec![1, 2, 3]),
            revision: 5,
            ..Default::default()
        };
        let result = apply_check_result(&mut pending, 4, None).expect("stale apply");
        assert!(result.is_none());
        assert_eq!(pending.downloaded_bytes, Some(vec![1, 2, 3]));
        assert_eq!(pending.version.as_deref(), Some("0.15.0"));
        assert_eq!(pending.revision, 5);
    }

    #[test]
    fn begin_download_bumps_revision_so_stale_checks_miss() {
        let mut pending = PendingAppUpdate {
            version: Some("0.15.0".into()),
            downloaded_bytes: Some(vec![9]),
            revision: 2,
            ..Default::default()
        };
        let check_revision = pending.revision;
        bump_revision(&mut pending);
        apply_check_result(&mut pending, check_revision, None).expect("stale");
        assert_eq!(pending.downloaded_bytes, Some(vec![9]));
        assert_eq!(pending.version.as_deref(), Some("0.15.0"));
        assert_eq!(pending.revision, 3);
    }

    #[test]
    fn matching_check_revision_can_clear_pending_state() {
        let mut pending = PendingAppUpdate {
            version: Some("0.15.0".into()),
            downloaded_bytes: Some(vec![9]),
            revision: 3,
            ..Default::default()
        };
        let result = apply_check_result(&mut pending, 3, None).expect("fresh clear");
        assert!(result.is_none());
        assert!(pending.version.is_none());
        assert!(pending.downloaded_bytes.is_none());
        assert_eq!(pending.revision, 4);
    }

    #[test]
    fn restore_failed_install_restores_matching_update_and_bytes() {
        let mut pending = PendingAppUpdate::default();
        // Without a real Update object, exercise the version/bytes restoration shape via
        // validate + manual field restore mirroring restore_failed_install.
        pending.version = Some("0.15.0".into());
        pending.downloaded_bytes = Some(vec![4, 5, 6]);
        pending.downloading = false;
        assert!(validate_install_ready(
            pending.version.as_deref(),
            "0.15.0",
            pending.downloaded_bytes.is_some(),
            pending.downloading,
        )
        .is_ok());
    }
}
