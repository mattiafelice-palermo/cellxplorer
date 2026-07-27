#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_channel;
mod app_updates;
mod beta_bootstrap;
mod update_notifications;

use app_channel::{resolve_data_root, AppChannel};
use app_updates::PendingAppUpdate;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct BackendChild(Mutex<Option<CommandChild>>);

struct BackendEndpoint(String);

struct LifecycleState {
    quitting: AtomicBool,
    close_notice_shown: AtomicBool,
}

#[cfg(target_os = "windows")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}

struct PendingDeepLink(Mutex<Option<String>>);

#[cfg(target_os = "windows")]
fn set_dwm_color(hwnd: *mut std::ffi::c_void, attribute: u32, color: u32) {
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            attribute,
            &color as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(target_os = "windows")]
fn apply_window_frame_color_to_hwnd(hwnd: *mut std::ffi::c_void, channel: AppChannel) {
    let frame_color = channel.frame_color_bgr();
    const WHITE: u32 = 0x00ff_ffff;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;

    set_dwm_color(hwnd, DWMWA_BORDER_COLOR, frame_color);
    set_dwm_color(hwnd, DWMWA_CAPTION_COLOR, frame_color);
    set_dwm_color(hwnd, DWMWA_TEXT_COLOR, WHITE);
}

#[cfg(target_os = "windows")]
fn apply_webview_window_frame_color(window: &tauri::WebviewWindow, channel: AppChannel) {
    if let Ok(hwnd) = window.hwnd() {
        apply_window_frame_color_to_hwnd(hwnd.0 as *mut std::ffi::c_void, channel);
    }
}

#[cfg(target_os = "windows")]
fn apply_native_window_frame_color(window: &tauri::Window, channel: AppChannel) {
    if let Ok(hwnd) = window.hwnd() {
        apply_window_frame_color_to_hwnd(hwnd.0 as *mut std::ffi::c_void, channel);
    }
}

fn apply_window_icon(window: &tauri::WebviewWindow, channel: AppChannel) {
    let icon = Image::new(channel.window_icon_rgba(), 256, 256);
    let _ = window.set_icon(icon);
}

fn finish_window_branding(window: &tauri::WebviewWindow, channel: AppChannel) {
    apply_window_icon(window, channel);
    #[cfg(target_os = "windows")]
    apply_webview_window_frame_color(window, channel);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_main_window_for_update(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable.".to_string())?;
    window
        .unminimize()
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn is_main_window_visible(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn queue_deep_link(app: &AppHandle, channel: AppChannel, url: String) {
    if !channel.accepts_deep_link(&url) {
        return;
    }
    if let Some(state) = app.try_state::<PendingDeepLink>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(url.clone());
        }
    }
    show_main_window(app);
    let _ = app.emit("portable-import-requested", url);
}

#[tauri::command]
fn take_pending_deep_link(state: tauri::State<'_, PendingDeepLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

fn stop_backend(app: &AppHandle) {
    if let Some(child_state) = app.try_state::<BackendChild>() {
        if let Ok(mut child) = child_state.0.lock() {
            if let Some(child) = child.take() {
                // The PyInstaller onefile launcher re-executes itself, so
                // killing only the direct child orphans the inner process,
                // which keeps the backend port and the installed exe locked.
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &child.pid().to_string()])
                        .creation_flags(0x08000000)
                        .status();
                }
                let _ = child.kill();
            }
        }
    }
}

pub(crate) fn prepare_exit_for_update(app: &AppHandle) {
    if let Some(lifecycle) = app.try_state::<LifecycleState>() {
        lifecycle.quitting.store(true, Ordering::SeqCst);
    }
    stop_backend(app);
}

fn quit_application(app: &AppHandle) {
    if let Some(lifecycle) = app.try_state::<LifecycleState>() {
        if lifecycle.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
    }
    stop_backend(app);
    app.exit(0);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit_application(&app);
}

/// Schedule a fresh process to start after this one has exited far enough to
/// release `tauri_plugin_single_instance`'s lock. `AppHandle::restart()` spawns
/// *before* exit, so the replacement can see the lock, hand off to the dying
/// instance, and exit — leaving no app and no backend.
fn schedule_relaunch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // PowerShell quoting: double any single quotes inside the path.
        let exe_arg = exe.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Start-Sleep -Seconds 1; Start-Process -FilePath '{}'",
            exe_arg
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            // CREATE_NO_WINDOW — same flag used by stop_backend's taskkill.
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| format!("could not schedule relaunch: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 1; exec '{}'", exe.display()))
            .spawn()
            .map_err(|error| format!("could not schedule relaunch: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
fn restart_app(app: AppHandle) -> Result<(), String> {
    // Schedule first so a failed spawn leaves the running backend intact.
    schedule_relaunch()?;
    if let Some(lifecycle) = app.try_state::<LifecycleState>() {
        lifecycle.quitting.store(true, Ordering::SeqCst);
    }
    // Kill the Python sidecar before exiting; otherwise it keeps the
    // loopback port and the new instance fails to bind.
    stop_backend(&app);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn apply_beta_bootstrap(app: AppHandle, token: String) -> Result<(), String> {
    let channel = channel_for_app(&app)?;
    if channel != AppChannel::Beta {
        return Err("Beta bootstrap is only available in the Beta channel.".to_string());
    }
    let beta_root = app_data_dir_for_channel(channel);

    // Pre-stop validation may return to the frontend. Nothing is mutated yet.
    let _ = beta_bootstrap::validate_staged_copy(&beta_root, &token)?;

    // Establish relaunch capability before stopping the backend or changing data.
    schedule_relaunch()?;

    if let Some(lifecycle) = app.try_state::<LifecycleState>() {
        lifecycle.quitting.store(true, Ordering::SeqCst);
    }
    stop_backend(&app);

    // After backend stop this command must not return a retryable error to the
    // existing frontend. Always exit; the delayed relaunch recovers the app.
    match (|| {
        let paths = beta_bootstrap::validate_staged_copy(&beta_root, &token)?;
        beta_bootstrap::activate_staged_copy(&beta_root, &paths)?;
        Ok::<(), String>(())
    })() {
        Ok(()) => {
            beta_bootstrap::clear_apply_failure_marker(&beta_root);
            let _ = beta_bootstrap::remove_consumed_stage(&beta_root, &token);
        }
        Err(error) => {
            let _ = beta_bootstrap::write_apply_failure_marker(&beta_root, &error);
        }
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn startup_mode() -> String {
    if std::env::args().any(|arg| arg == "--hidden") {
        "startup".to_string()
    } else {
        "manual".to_string()
    }
}

fn available_backend_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[tauri::command]
fn backend_api_base(endpoint: tauri::State<'_, BackendEndpoint>) -> String {
    endpoint.0.clone()
}

fn channel_for_app(app: &AppHandle) -> Result<AppChannel, String> {
    AppChannel::from_identifier(app.config().identifier.as_str())
}

#[cfg(target_os = "windows")]
fn autostart_status(channel: AppChannel) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            channel.autostart_registry_value(),
        ])
        .creation_flags(0x08000000)
        .status()
        .map_err(|error| error.to_string())?;
    Ok(status.success())
}

#[cfg(not(target_os = "windows"))]
fn autostart_status(_channel: AppChannel) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    autostart_status(channel_for_app(&app)?)
}

#[cfg(target_os = "windows")]
fn update_autostart(channel: AppChannel, enabled: bool) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("reg.exe");
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let value = format!("\"{}\" --hidden", executable.display());
        command.args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            channel.autostart_registry_value(),
            "/t",
            "REG_SZ",
            "/d",
            &value,
            "/f",
        ]);
    } else {
        command.args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            channel.autostart_registry_value(),
            "/f",
        ]);
    }
    let status = command
        .creation_flags(0x08000000)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() || (!enabled && !autostart_status(channel)?) {
        Ok(enabled)
    } else {
        Err("Windows could not update the startup setting".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn update_autostart(_channel: AppChannel, _enabled: bool) -> Result<bool, String> {
    Err("Launch at startup is available in the Windows app".to_string())
}

#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    update_autostart(channel_for_app(&app)?, enabled)
}

#[tauri::command]
fn set_tray_status(app: AppHandle, message: Option<String>) -> Result<(), String> {
    let channel = channel_for_app(&app)?;
    let tray = app
        .tray_by_id("cellxplorer-tray")
        .ok_or_else(|| "Tray icon is unavailable".to_string())?;
    let tooltip = message
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| channel.product_name().to_string());
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| error.to_string())
}

fn user_home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data_dir_for_channel(channel: AppChannel) -> PathBuf {
    resolve_data_root(channel, &user_home_dir())
}

#[allow(deprecated)]
#[tauri::command]
fn open_app_folder(app: AppHandle, kind: String) -> Result<(), String> {
    let channel = channel_for_app(&app)?;
    let base = app_data_dir_for_channel(channel);
    let path = if kind == "logs" {
        base.join("logs")
    } else {
        base
    };
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    app.shell()
        .open(path.to_string_lossy().to_string(), None)
        .map_err(|error| error.to_string())
}

#[allow(deprecated)]
#[tauri::command]
fn open_download(app: AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err("The file is no longer at this location.".to_string());
    }
    app.shell()
        .open(path, None)
        .map_err(|error| error.to_string())
}

/// Put the file itself on the clipboard as a file reference (CF_HDROP), so it
/// pastes into Explorer, mail, or a document exactly like copying it from a
/// folder. The web clipboard cannot express this: it carries MIME payloads,
/// and Chromium only allows a safe subset of those for writing.
#[tauri::command]
fn copy_download_file(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err("The file is no longer at this location.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Single quotes are PowerShell's literal string; escape by doubling.
        let escaped = path.replace('\'', "''");
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("Set-Clipboard -LiteralPath '{escaped}'"),
            ])
            .creation_flags(0x08000000)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Windows refused to copy the file to the clipboard.".to_string());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Copying files to the clipboard is only supported on Windows.".to_string())
    }
}

#[tauri::command]
fn reveal_download(path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.is_file() {
        return Err("The file is no longer at this location.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer /select,PATH opens the folder with the file highlighted.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", target.display()))
            .creation_flags(0x08000000)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Fall back to opening the containing folder.
        let folder = target
            .parent()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn main() {
    let context = tauri::generate_context!();
    let channel = AppChannel::from_identifier(context.config().identifier.as_str())
        .expect("unsupported application identifier");
    let start_hidden = std::env::args().any(|arg| arg == "--hidden");
    let initial_deep_link = std::env::args().find(|arg| channel.accepts_deep_link(arg));
    let startup_label = if start_hidden { "startup" } else { "manual" };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let channel = AppChannel::from_identifier(app.config().identifier.as_str())
                .expect("unsupported application identifier");
            if let Some(url) = args.into_iter().find(|arg| channel.accepts_deep_link(arg)) {
                queue_deep_link(app, channel, url);
            } else {
                show_main_window(app);
            }
        }))
        .manage(LifecycleState {
            quitting: AtomicBool::new(false),
            close_notice_shown: AtomicBool::new(false),
        })
        .manage(PendingDeepLink(Mutex::new(None)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(PendingAppUpdate::default()))
        .invoke_handler(tauri::generate_handler![
            app_updates::check_app_update,
            app_updates::download_app_update,
            app_updates::install_app_update,
            apply_beta_bootstrap,
            backend_api_base,
            is_autostart_enabled,
            is_main_window_visible,
            open_app_folder,
            open_download,
            copy_download_file,
            reveal_download,
            quit_app,
            restart_app,
            set_autostart_enabled,
            set_tray_status,
            show_main_window_for_update,
            startup_mode,
            take_pending_deep_link,
            update_notifications::show_update_notification
        ])
        .setup(move |app| {
            let app_channel = AppChannel::from_identifier(app.config().identifier.as_str())
                .expect("unsupported application identifier");
            let backend_port = available_backend_port()?;
            app.manage(BackendEndpoint(format!("http://127.0.0.1:{backend_port}")));
            let version = app.package_info().version.to_string();
            let sidecar = app
                .shell()
                .sidecar("cellxplorer-backend")?
                .env("CELLXPLORER_PORT", backend_port.to_string())
                .env("CELLXPLORER_STARTUP_MODE", startup_label)
                .env("CELLXPLORER_APP_VERSION", version)
                .env("CELLXPLORER_CHANNEL", app_channel.as_str())
                .env(
                    "CELLXPLORER_DATA",
                    app_data_dir_for_channel(app_channel).to_string_lossy().to_string(),
                );
            let (_rx, child) = sidecar.spawn()?;
            app.manage(BackendChild(Mutex::new(Some(child))));

            let open_label = format!("Open {}", app_channel.product_name());
            let open_item = MenuItem::with_id(app, "open", open_label, true, None::<&str>)?;
            let maintain_item = MenuItem::with_id(
                app,
                "check_update",
                "Check and update sources",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_label = format!("Quit {}", app_channel.product_name());
            let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&open_item, &maintain_item, &separator, &quit_item])?;

            TrayIconBuilder::with_id("cellxplorer-tray")
                .icon(app.default_window_icon().expect("application icon").clone())
                .tooltip(app_channel.product_name())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let product_name = AppChannel::from_identifier(app.config().identifier.as_str())
                        .map(|channel| channel.product_name().to_string())
                        .unwrap_or_else(|_| "CellXplorer".to_string());
                    match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "check_update" => {
                        let _ = app.emit("tray-check-update", ());
                        if let Some(tray) = app.tray_by_id("cellxplorer-tray") {
                            let _ = tray
                                .set_tooltip(Some(format!("{product_name} - checking and updating sources")));
                        }
                    }
                    "quit" => {
                        let _ = app.emit("tray-quit-requested", ());
                        let handle = app.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_secs(2));
                            quit_application(&handle);
                        });
                    }
                    _ => {}
                }})
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                finish_window_branding(&window, app_channel);
                if start_hidden {
                    let _ = window.hide();
                }
            }
            if let Some(url) = initial_deep_link.clone() {
                queue_deep_link(app.handle(), app_channel, url);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if matches!(
                event,
                WindowEvent::Focused(_)
                    | WindowEvent::ThemeChanged(_)
                    | WindowEvent::Resized(_)
                    | WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Ok(channel) =
                    AppChannel::from_identifier(window.app_handle().config().identifier.as_str())
                {
                    apply_native_window_frame_color(window, channel);
                }
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let quitting = app
                    .try_state::<LifecycleState>()
                    .is_some_and(|state| state.quitting.load(Ordering::SeqCst));
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(state) = app.try_state::<LifecycleState>() {
                        if !state.close_notice_shown.swap(true, Ordering::SeqCst) {
                            if let Some(tray) = app.tray_by_id("cellxplorer-tray") {
                                let tooltip = AppChannel::from_identifier(
                                    app.config().identifier.as_str(),
                                )
                                .map(|channel| {
                                    format!("{} is running - right-click for actions", channel.product_name())
                                })
                                .unwrap_or_else(|_| {
                                    "CellXplorer is running - right-click for actions".to_string()
                                });
                                let _ = tray.set_tooltip(Some(tooltip));
                            }
                        }
                    }
                }
            }
        })
        .run(context)
        .expect("error while running CellXplorer");
}
