use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct PendingAppUpdate {
    update: Option<tauri_plugin_updater::Update>,
    downloaded_bytes: Option<Vec<u8>>,
    downloading: bool,
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
) -> AppUpdateRelease {
    pending.update = Some(update);
    pending.downloaded_bytes = None;
    pending.downloading = false;
    release_from_update(pending.update.as_ref().expect("update was just stored"))
}

pub fn clear_pending_update(pending: &mut PendingAppUpdate) {
    *pending = PendingAppUpdate::default();
}

pub fn begin_download(pending: &mut PendingAppUpdate, expected_version: &str) -> Result<(), PendingUpdateError> {
    if pending.downloading {
        return Err(PendingUpdateError::AlreadyDownloading);
    }
    let update = pending
        .update
        .as_ref()
        .filter(|update| update.version == expected_version)
        .ok_or(PendingUpdateError::MissingPendingUpdate)?;
    if update.version != expected_version {
        return Err(PendingUpdateError::VersionMismatch);
    }
    pending.downloading = true;
    Ok(())
}

pub fn finish_download_success(pending: &mut PendingAppUpdate, bytes: Vec<u8>) {
    pending.downloading = false;
    pending.downloaded_bytes = Some(bytes);
}

pub fn finish_download_failure(pending: &mut PendingAppUpdate) {
    pending.downloading = false;
}

pub fn take_verified_install(
    pending: &mut PendingAppUpdate,
    expected_version: &str,
) -> Result<(tauri_plugin_updater::Update, Vec<u8>), PendingUpdateError> {
    let update = pending
        .update
        .take()
        .filter(|update| update.version == expected_version)
        .ok_or(PendingUpdateError::MissingPendingUpdate)?;
    let bytes = pending
        .downloaded_bytes
        .take()
        .ok_or(PendingUpdateError::MissingVerifiedBytes)?;
    pending.downloading = false;
    Ok((update, bytes))
}

pub fn restore_failed_install(
    pending: &mut PendingAppUpdate,
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
) {
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

fn user_safe_error(error: impl std::fmt::Display) -> String {
    format!("Could not complete the update request: {error}")
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, Mutex<PendingAppUpdate>>,
) -> Result<Option<AppUpdateRelease>, String> {
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
    match update {
        Some(update) => Ok(Some(replace_pending_update(&mut pending, update))),
        None => {
            clear_pending_update(&mut pending);
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn download_app_update(
    expected_version: String,
    on_progress: Channel<AppUpdateDownloadEvent>,
    state: State<'_, Mutex<PendingAppUpdate>>,
) -> Result<(), String> {
    let update = {
        let mut pending = lock_pending(&state)?;
        begin_download(&mut pending, &expected_version).map_err(|error| match error {
            PendingUpdateError::AlreadyDownloading => {
                "An update download is already in progress.".to_string()
            }
            PendingUpdateError::MissingPendingUpdate
            | PendingUpdateError::VersionMismatch
            | PendingUpdateError::MissingVerifiedBytes => {
                "No pending update matches the requested version.".to_string()
            }
        })?;
        pending
            .update
            .as_ref()
            .expect("begin_download validated pending update")
            .clone()
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
            finish_download_success(&mut pending, bytes);
            Ok(())
        }
        Err(error) => {
            finish_download_failure(&mut pending);
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
            PendingUpdateError::MissingPendingUpdate | PendingUpdateError::VersionMismatch => {
                "No pending update matches the requested version.".to_string()
            }
            PendingUpdateError::MissingVerifiedBytes => {
                "Download and verify the update before installing.".to_string()
            }
            PendingUpdateError::AlreadyDownloading => {
                "An update download is still in progress.".to_string()
            }
        })?
    };

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

    #[test]
    fn clear_pending_update_resets_state() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            downloaded_bytes: Some(vec![1]),
            ..Default::default()
        };

        clear_pending_update(&mut pending);

        assert!(!pending.downloading);
        assert!(pending.downloaded_bytes.is_none());
        assert!(pending.update.is_none());
    }

    #[test]
    fn begin_download_requires_pending_update() {
        let mut pending = PendingAppUpdate::default();
        assert_eq!(
            begin_download(&mut pending, "0.15.0"),
            Err(PendingUpdateError::MissingPendingUpdate)
        );
    }

    #[test]
    fn begin_download_rejects_overlap() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            ..Default::default()
        };
        assert_eq!(
            begin_download(&mut pending, "0.15.0"),
            Err(PendingUpdateError::AlreadyDownloading)
        );
    }

    #[test]
    fn download_failure_keeps_retryable_state_without_verified_bytes() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            ..Default::default()
        };

        finish_download_failure(&mut pending);

        assert!(pending.downloaded_bytes.is_none());
        assert!(!pending.downloading);
    }

    #[test]
    fn finish_download_success_stores_verified_bytes() {
        let mut pending = PendingAppUpdate {
            downloading: true,
            ..Default::default()
        };

        finish_download_success(&mut pending, vec![9, 9, 9]);

        assert_eq!(pending.downloaded_bytes, Some(vec![9, 9, 9]));
        assert!(!pending.downloading);
    }

    #[test]
    fn take_verified_install_requires_pending_update() {
        let mut pending = PendingAppUpdate::default();
        let result = take_verified_install(&mut pending, "0.15.0");
        assert!(matches!(result, Err(PendingUpdateError::MissingPendingUpdate)));
    }
}
