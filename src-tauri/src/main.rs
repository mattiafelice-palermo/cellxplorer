#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
fn apply_window_frame_color_to_hwnd(hwnd: *mut std::ffi::c_void) {
    const APP_TEAL: u32 = 0x0086_b812;
    const WHITE: u32 = 0x00ff_ffff;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;

    set_dwm_color(hwnd, DWMWA_BORDER_COLOR, APP_TEAL);
    set_dwm_color(hwnd, DWMWA_CAPTION_COLOR, APP_TEAL);
    set_dwm_color(hwnd, DWMWA_TEXT_COLOR, WHITE);
}

#[cfg(target_os = "windows")]
fn apply_webview_window_frame_color(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        apply_window_frame_color_to_hwnd(hwnd.0 as *mut std::ffi::c_void);
    }
}

#[cfg(target_os = "windows")]
fn apply_native_window_frame_color(window: &tauri::Window) {
    if let Ok(hwnd) = window.hwnd() {
        apply_window_frame_color_to_hwnd(hwnd.0 as *mut std::ffi::c_void);
    }
}

fn apply_window_icon(window: &tauri::WebviewWindow) {
    let icon = Image::new(include_bytes!("../icons/icon-256.rgba"), 256, 256);
    let _ = window.set_icon(icon);
}

fn finish_window_branding(window: &tauri::WebviewWindow) {
    apply_window_icon(window);
    #[cfg(target_os = "windows")]
    apply_webview_window_frame_color(window);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn queue_deep_link(app: &AppHandle, url: String) {
    if !url.starts_with("cellxplorer://import-analysis") {
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

#[cfg(target_os = "windows")]
fn autostart_status() -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "CellXplorer",
        ])
        .creation_flags(0x08000000)
        .status()
        .map_err(|error| error.to_string())?;
    Ok(status.success())
}

#[cfg(not(target_os = "windows"))]
fn autostart_status() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn is_autostart_enabled() -> Result<bool, String> {
    autostart_status()
}

#[cfg(target_os = "windows")]
fn update_autostart(enabled: bool) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("reg.exe");
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let value = format!("\"{}\" --hidden", executable.display());
        command.args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "CellXplorer",
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
            "CellXplorer",
            "/f",
        ]);
    }
    let status = command
        .creation_flags(0x08000000)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() || (!enabled && !autostart_status()?) {
        Ok(enabled)
    } else {
        Err("Windows could not update the startup setting".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn update_autostart(_enabled: bool) -> Result<bool, String> {
    Err("Launch at startup is available in the Windows app".to_string())
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    update_autostart(enabled)
}

#[tauri::command]
fn set_tray_status(app: AppHandle, message: Option<String>) -> Result<(), String> {
    let tray = app
        .tray_by_id("cellxplorer-tray")
        .ok_or_else(|| "Tray icon is unavailable".to_string())?;
    let tooltip = message
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "CellXplorer".to_string());
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| error.to_string())
}

fn app_data_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("CELLXPLORER_DATA") {
        return PathBuf::from(value);
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cellxplorer")
}

#[allow(deprecated)]
#[tauri::command]
fn open_app_folder(app: AppHandle, kind: String) -> Result<(), String> {
    let base = app_data_dir();
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

fn main() {
    let start_hidden = std::env::args().any(|arg| arg == "--hidden");
    let initial_deep_link =
        std::env::args().find(|arg| arg.starts_with("cellxplorer://import-analysis"));
    let startup_label = if start_hidden { "startup" } else { "manual" };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(url) = args
                .into_iter()
                .find(|arg| arg.starts_with("cellxplorer://import-analysis"))
            {
                queue_deep_link(app, url);
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
        .invoke_handler(tauri::generate_handler![
            backend_api_base,
            is_autostart_enabled,
            open_app_folder,
            quit_app,
            set_autostart_enabled,
            set_tray_status,
            startup_mode,
            take_pending_deep_link
        ])
        .setup(move |app| {
            let backend_port = available_backend_port()?;
            app.manage(BackendEndpoint(format!("http://127.0.0.1:{backend_port}")));
            let version = app.package_info().version.to_string();
            let sidecar = app
                .shell()
                .sidecar("cellxplorer-backend")?
                .env("CELLXPLORER_PORT", backend_port.to_string())
                .env("CELLXPLORER_STARTUP_MODE", startup_label)
                .env("CELLXPLORER_APP_VERSION", version);
            let (_rx, child) = sidecar.spawn()?;
            app.manage(BackendChild(Mutex::new(Some(child))));

            let open_item = MenuItem::with_id(app, "open", "Open CellXplorer", true, None::<&str>)?;
            let maintain_item = MenuItem::with_id(
                app,
                "check_update",
                "Check and update sources",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit CellXplorer", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&open_item, &maintain_item, &separator, &quit_item])?;

            TrayIconBuilder::with_id("cellxplorer-tray")
                .icon(app.default_window_icon().expect("application icon").clone())
                .tooltip("CellXplorer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "check_update" => {
                        let _ = app.emit("tray-check-update", ());
                        if let Some(tray) = app.tray_by_id("cellxplorer-tray") {
                            let _ = tray
                                .set_tooltip(Some("CellXplorer - checking and updating sources"));
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
                })
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
                finish_window_branding(&window);
                if start_hidden {
                    let _ = window.hide();
                }
            }
            if let Some(url) = initial_deep_link.clone() {
                queue_deep_link(app.handle(), url);
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
                apply_native_window_frame_color(window);
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
                                let _ = tray.set_tooltip(Some(
                                    "CellXplorer is running - right-click for actions",
                                ));
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CellXplorer");
}
