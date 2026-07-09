#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{image::Image, Manager, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct BackendChild(Mutex<Option<CommandChild>>);

#[cfg(target_os = "windows")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}

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
    // DWM COLORREF is 0x00BBGGRR. App teal #12b886 becomes 0x0086b812.
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let sidecar = app.shell().sidecar("cellxplorer-backend")?;
            let (_rx, child) = sidecar.spawn()?;
            app.manage(BackendChild(Mutex::new(Some(child))));
            if let Some(window) = app.get_webview_window("main") {
                finish_window_branding(&window);
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

            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(child_state) = window.app_handle().try_state::<BackendChild>() {
                    if let Ok(mut child) = child_state.0.lock() {
                        if let Some(child) = child.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CellXplorer");
}
