use std::path::MAIN_SEPARATOR as SEP;
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const UPDATE_NOTIFICATION_EVENT: &str = "app-update-notification-activated";
pub const UPDATE_NOTIFICATION_TAG: &str = "cellxplorer-app-update";
pub const UPDATE_NOTIFICATION_KIND: &str = "cellxplorer-app-update";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotificationActivatedPayload {
    pub kind: String,
    pub tag: String,
    pub version: String,
}

#[derive(Debug, Default)]
struct ActiveUpdateNotification {
    generation: u64,
    version: String,
}

static ACTIVE_UPDATE_NOTIFICATION: Mutex<ActiveUpdateNotification> =
    Mutex::new(ActiveUpdateNotification {
        generation: 0,
        version: String::new(),
    });

pub fn activation_payload(version: &str) -> Option<UpdateNotificationActivatedPayload> {
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(UpdateNotificationActivatedPayload {
        kind: UPDATE_NOTIFICATION_KIND.to_string(),
        tag: UPDATE_NOTIFICATION_TAG.to_string(),
        version: version.to_string(),
    })
}

pub fn should_deliver_activation(
    active_generation: u64,
    active_version: &str,
    event_generation: u64,
    event_version: &str,
) -> bool {
    active_generation == event_generation && active_version == event_version
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(windows)]
fn toast_app_id(identifier: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let curr_dir = exe.parent()?.to_string_lossy();
    // Match the official plugin: only use the app id for installed builds.
    if curr_dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
        || curr_dir.ends_with(format!("{SEP}target{SEP}release").as_str())
    {
        return None;
    }
    Some(identifier.to_string())
}

/// Display a Windows toast for an available update. Returns only after Windows accepts the toast.
/// Body/default activation focuses the existing main window and emits
/// `app-update-notification-activated` with a fixed identity payload.
#[tauri::command]
pub fn show_update_notification(app: AppHandle, version: String) -> Result<(), String> {
    let Some(payload) = activation_payload(&version) else {
        return Err("Update version is required.".to_string());
    };

    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = payload;
        return Err("Windows update notifications are only supported on Windows.".to_string());
    }

    #[cfg(windows)]
    {
        let generation = {
            let mut active = ACTIVE_UPDATE_NOTIFICATION
                .lock()
                .map_err(|_| "Update notification state is unavailable.".to_string())?;
            active.generation = active.generation.wrapping_add(1);
            active.version = payload.version.clone();
            active.generation
        };

        let identifier = app.config().identifier.clone();
        let mut notification = notify_rust::Notification::new();
        notification
            .summary("CellXplorer update available")
            .body(&format!(
                "Version {} is ready. Click to view the update.",
                payload.version
            ));
        if let Some(app_id) = toast_app_id(&identifier) {
            notification.app_id(&app_id);
        }

        let handle = notification
            .show()
            .map_err(|error| format!("Could not show the update notification: {error}"))?;

        let app_for_thread = app.clone();
        let version_for_thread = payload.version.clone();
        thread::spawn(move || {
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                let activate = matches!(
                    response,
                    notify_rust::NotificationResponse::Default
                );
                if !activate {
                    return;
                }

                let still_current = ACTIVE_UPDATE_NOTIFICATION
                    .lock()
                    .map(|active| {
                        should_deliver_activation(
                            active.generation,
                            &active.version,
                            generation,
                            &version_for_thread,
                        )
                    })
                    .unwrap_or(false);
                if !still_current {
                    return;
                }

                let Some(event_payload) = activation_payload(&version_for_thread) else {
                    return;
                };

                show_main_window(&app_for_thread);
                let _ = app_for_thread.emit(UPDATE_NOTIFICATION_EVENT, event_payload);
            });
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_payload_requires_trimmed_non_empty_version() {
        assert!(activation_payload("").is_none());
        assert!(activation_payload("   ").is_none());
        let payload = activation_payload(" 0.16.0 ").expect("version");
        assert_eq!(payload.kind, UPDATE_NOTIFICATION_KIND);
        assert_eq!(payload.tag, UPDATE_NOTIFICATION_TAG);
        assert_eq!(payload.version, "0.16.0");
    }

    #[test]
    fn stale_generation_or_version_is_not_delivered() {
        assert!(should_deliver_activation(3, "0.16.0", 3, "0.16.0"));
        assert!(!should_deliver_activation(3, "0.16.0", 2, "0.16.0"));
        assert!(!should_deliver_activation(3, "0.16.0", 3, "0.16.1"));
    }
}
