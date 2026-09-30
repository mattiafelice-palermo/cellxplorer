use std::path::MAIN_SEPARATOR as SEP;
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::app_channel::AppChannel;

pub const UPDATE_NOTIFICATION_EVENT: &str = "app-update-notification-activated";
pub const UPDATE_NOTIFICATION_TAG: &str = "cellxplorer-app-update";
pub const UPDATE_NOTIFICATION_KIND: &str = "cellxplorer-app-update";

pub const BETA_INSTALL_NOTIFICATION_EVENT: &str = "beta-install-notification-activated";
pub const BETA_INSTALL_NOTIFICATION_TAG: &str = "cellxplorer-beta-install";
pub const BETA_INSTALL_NOTIFICATION_KIND: &str = "cellxplorer-beta-install";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotificationActivatedPayload {
    pub kind: String,
    pub tag: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BetaInstallNotificationActivatedPayload {
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

static ACTIVE_BETA_INSTALL_NOTIFICATION: Mutex<ActiveUpdateNotification> =
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

pub fn beta_install_activation_payload(
    version: &str,
) -> Option<BetaInstallNotificationActivatedPayload> {
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(BetaInstallNotificationActivatedPayload {
        kind: BETA_INSTALL_NOTIFICATION_KIND.to_string(),
        tag: BETA_INSTALL_NOTIFICATION_TAG.to_string(),
        version: version.to_string(),
    })
}

fn update_notification_title(app: &AppHandle) -> Result<String, String> {
    let channel = AppChannel::from_identifier(app.config().identifier.as_str())?;
    Ok(format!(
        "{} update available",
        channel.product_name()
    ))
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

        let title = update_notification_title(&app)?;
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&title)
            .body(&format!(
                "Version {} is ready. Click to view the update.",
                payload.version
            ));
        if let Some(app_id) = toast_app_id(&app.config().identifier) {
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

/// Stable-only toast when a separate CellXplorer Beta preview is available.
#[tauri::command]
pub fn show_beta_install_notification(app: AppHandle, version: String) -> Result<(), String> {
    if app.config().identifier.as_str() != crate::app_channel::STABLE_IDENTIFIER {
        return Err(
            "CellXplorer Beta availability notifications are only shown in CellXplorer Stable."
                .to_string(),
        );
    }

    let Some(payload) = beta_install_activation_payload(&version) else {
        return Err("Beta version is required.".to_string());
    };

    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = payload;
        return Err("Windows notifications are only supported on Windows.".to_string());
    }

    #[cfg(windows)]
    {
        let generation = {
            let mut active = ACTIVE_BETA_INSTALL_NOTIFICATION
                .lock()
                .map_err(|_| "Beta notification state is unavailable.".to_string())?;
            active.generation = active.generation.wrapping_add(1);
            active.version = payload.version.clone();
            active.generation
        };

        let mut notification = notify_rust::Notification::new();
        notification
            .summary("CellXplorer Beta available")
            .body(&format!(
                "Version {} is available as a separate preview app. Click to review.",
                payload.version
            ));
        if let Some(app_id) = toast_app_id(&app.config().identifier) {
            notification.app_id(&app_id);
        }

        let handle = notification
            .show()
            .map_err(|error| format!("Could not show the Beta notification: {error}"))?;

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

                let still_current = ACTIVE_BETA_INSTALL_NOTIFICATION
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

                let Some(event_payload) = beta_install_activation_payload(&version_for_thread)
                else {
                    return;
                };

                show_main_window(&app_for_thread);
                let _ = app_for_thread.emit(BETA_INSTALL_NOTIFICATION_EVENT, event_payload);
            });
        });

        Ok(())
    }
}

pub const ANALYSIS_NOTIFICATION_EVENT: &str = "analysis-update-notification-activated";
pub const ANALYSIS_NOTIFICATION_KIND: &str = "cellxplorer-analysis-update";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisNotificationActivatedPayload {
    pub kind: String,
    pub database_id: String,
}

static ACTIVE_ANALYSIS_NOTIFICATION: Mutex<ActiveUpdateNotification> = Mutex::new(ActiveUpdateNotification {
    generation: 0, version: String::new(),
});

pub fn analysis_activation_payload(database_id: &str) -> Option<AnalysisNotificationActivatedPayload> {
    let id = database_id.trim();
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return None;
    }
    Some(AnalysisNotificationActivatedPayload { kind: ANALYSIS_NOTIFICATION_KIND.to_string(), database_id: id.to_string() })
}

pub fn should_deliver_analysis_activation(active_database: &str, event_database: &str) -> bool {
    !event_database.is_empty() && active_database == event_database
}

/// New data is available, not a promise that all saved plots have finished preparing.
#[tauri::command]
pub fn show_analysis_update_notification(app: AppHandle, database_id: String, analyses: u32, cells: u32) -> Result<(), String> {
    let payload = analysis_activation_payload(&database_id).ok_or("Invalid database identity.")?;
    if analyses == 0 || cells == 0 || analyses > 100_000 || cells > 100_000 {
        return Err("Invalid update counts.".to_string());
    }
    #[cfg(not(windows))]
    { let _ = (app, payload); Err("Windows notifications are only supported on Windows.".to_string()) }
    #[cfg(windows)]
    {
        {
            let mut active = ACTIVE_ANALYSIS_NOTIFICATION.lock().map_err(|_| "Notification state is unavailable.")?;
            active.version = payload.database_id.clone();
        }
        let channel = AppChannel::from_identifier(app.config().identifier.as_str())?;
        let mut notification = notify_rust::Notification::new();
        notification.summary(&format!("{}: new analysis data", channel.product_name()))
            .body(&format!("{} {} received new data from {} {}. Click to review in Activity Center.",
                analyses, if analyses == 1 { "analysis" } else { "analyses" }, cells, if cells == 1 { "cell" } else { "cells" }));
        if let Some(app_id) = toast_app_id(&app.config().identifier) { notification.app_id(&app_id); }
        let handle = notification.show().map_err(|error| format!("Could not show data update notification: {error}"))?;
        thread::spawn(move || {
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                if !matches!(response, notify_rust::NotificationResponse::Default) { return; }
                // Older data toasts remain in Windows notification history. Every
                // batch for this database opens the same Activity Center; a newer
                // batch must not make an older visible notification unclickable.
                let current = ACTIVE_ANALYSIS_NOTIFICATION.lock().map(|active|
                    should_deliver_analysis_activation(&active.version, &payload.database_id)).unwrap_or(false);
                if current {
                    show_main_window(&app);
                    let _ = app.emit(ANALYSIS_NOTIFICATION_EVENT, payload.clone());
                }
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
    fn analysis_identity_is_bounded_and_validated() {
        assert!(analysis_activation_payload("").is_none());
        assert!(analysis_activation_payload("../bad").is_none());
        assert!(analysis_activation_payload(&"a".repeat(129)).is_none());
        let payload = analysis_activation_payload(" db-123 ").unwrap();
        assert_eq!(payload.database_id, "db-123");
        assert_eq!(payload.kind, ANALYSIS_NOTIFICATION_KIND);
        // Subsequent batches have the same database identity: older toasts
        // remain actionable, while another database's toast is rejected.
        assert!(should_deliver_analysis_activation("db-123", &payload.database_id));
        assert!(!should_deliver_analysis_activation("db-456", &payload.database_id));
        assert!(!should_deliver_analysis_activation("", ""));
    }

    #[test]
    fn stale_generation_or_version_is_not_delivered() {
        assert!(should_deliver_activation(3, "0.16.0", 3, "0.16.0"));
        assert!(!should_deliver_activation(3, "0.16.0", 2, "0.16.0"));
        assert!(!should_deliver_activation(3, "0.16.0", 3, "0.16.1"));
    }
}
