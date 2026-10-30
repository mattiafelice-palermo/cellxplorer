#![cfg_attr(windows, windows_subsystem = "windows")]

mod policy;
#[cfg(windows)]
mod processes;

use std::{path::PathBuf, process::Command};

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode, hex] if mode == "--restart" => {
            let arguments = policy::decode_arguments(hex)?;
            // The user token is supplied by NSIS RunAsUser. Neither the executable
            // nor the working directory can be chosen through untrusted argv.
            let helper = std::env::current_exe().map_err(|e| e.to_string())?;
            let directory = helper.parent().ok_or("Missing installation directory")?;
            let executable = directory.join("cellxplorer.exe");
            policy::check_command_length(&executable.to_string_lossy(), &arguments)?;
            let mut command = Command::new(executable);
            command.current_dir(directory).args(arguments);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, before creation
            }
            command
                .spawn()
                .map_err(|e| format!("Restart failed: {e}"))?;
            Ok(())
        }
        [mode, directory] if mode == "--cleanup" => cleanup(directory, false),
        [mode, directory, option] if mode == "--cleanup" && option == "--backend-only" => {
            cleanup(directory, true)
        }
        _ => Err("Invalid installer helper arguments".into()),
    }
}

fn cleanup(directory: &str, backend_only: bool) -> Result<(), String> {
    let path = PathBuf::from(directory);
    if !path.is_absolute()
        || path.parent().is_none()
        || !path.is_dir()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Cleanup requires an existing non-root absolute installation directory".into());
    }
    #[cfg(windows)]
    return processes::cleanup(&path, backend_only);
    #[cfg(not(windows))]
    {
        let _ = backend_only;
        Err("Installation cleanup requires Windows".into())
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
