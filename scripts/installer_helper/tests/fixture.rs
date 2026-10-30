#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{path::PathBuf, process::Command, time::Duration};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--hold") => {
            std::fs::write(&args[1], std::process::id().to_string()).unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        Some("--delayed") => {
            std::thread::sleep(Duration::from_millis(350));
            let mut child = Command::new(&args[1])
                .args(["--hold", &args[2]])
                .spawn()
                .unwrap();
            let _ = child.wait();
        }
        Some("--ancestor") => {
            let status = Command::new(&args[1])
                .args(["--cleanup", &args[2]])
                .status()
                .unwrap();
            std::fs::write(&args[3], status.code().unwrap_or(-1).to_string()).unwrap();
        }
        Some("--descendant") => {
            let _outside = Command::new(&args[1])
                .args(["--hold", &args[2]])
                .spawn()
                .unwrap();
            std::fs::write(&args[3], "ready").unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        _ => {
            // Restart fixture is copied as cellxplorer.exe. First argv is an
            // output path; subsequent argv must survive an actual CreateProcess.
            let output = PathBuf::from(&args[0]);
            #[cfg(windows)]
            let console = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
            #[cfg(not(windows))]
            let console: *mut std::ffi::c_void = std::ptr::null_mut();
            std::fs::write(
                output,
                serde_json::to_vec(
                    &serde_json::json!({"args": &args[1..], "console": !console.is_null()}),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }
}
