use std::process::Command;

const RELAUNCH_AFTER_PID_ARG: &str = "--relaunch-after-pid";

fn parse_parent_pid(args: impl IntoIterator<Item = String>) -> Result<Option<u32>, String> {
    let mut args = args.into_iter();
    let mut parent_pid = None;

    while let Some(arg) = args.next() {
        if arg != RELAUNCH_AFTER_PID_ARG {
            continue;
        }
        if parent_pid.is_some() {
            return Err("Relaunch parent PID was provided more than once.".to_string());
        }
        let raw = args
            .next()
            .ok_or_else(|| "Relaunch parent PID is missing.".to_string())?;
        let pid = raw
            .parse::<u32>()
            .map_err(|_| "Relaunch parent PID is invalid.".to_string())?;
        if pid == 0 {
            return Err("Relaunch parent PID must be greater than zero.".to_string());
        }
        parent_pid = Some(pid);
    }

    Ok(parent_pid)
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    type Handle = *mut c_void;

    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const WAIT_FAILED: u32 = u32::MAX;
    const ERROR_INVALID_PARAMETER: u32 = 87;
    const RELAUNCH_WAIT_MS: u32 = 60_000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    struct ProcessHandle(Handle);

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(super) fn wait_for_parent_exit(parent_pid: u32) -> Result<(), String> {
        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, parent_pid) };
        if handle.is_null() {
            let error = unsafe { GetLastError() };
            if error == ERROR_INVALID_PARAMETER {
                return Ok(());
            }
            return Err(format!(
                "could not open the previous CellXplorer process {parent_pid} (Windows error {error})"
            ));
        }
        let handle = ProcessHandle(handle);
        match unsafe { WaitForSingleObject(handle.0, RELAUNCH_WAIT_MS) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(format!(
                "the previous CellXplorer process {parent_pid} did not exit within 60 seconds"
            )),
            WAIT_FAILED => {
                let error = unsafe { GetLastError() };
                Err(format!(
                    "could not wait for the previous CellXplorer process {parent_pid} (Windows error {error})"
                ))
            }
            result => Err(format!(
                "waiting for the previous CellXplorer process returned unexpected status {result}"
            )),
        }
    }

    pub(super) fn configure_hidden(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use std::process::Command;
    use std::thread;
    use std::time::Duration;

    pub(super) fn wait_for_parent_exit(parent_pid: u32) -> Result<(), String> {
        for _ in 0..600 {
            let running = Command::new("kill")
                .args(["-0", &parent_pid.to_string()])
                .status()
                .map_err(|error| {
                    format!("could not inspect the previous CellXplorer process: {error}")
                })?
                .success();
            if !running {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(format!(
            "the previous CellXplorer process {parent_pid} did not exit within 60 seconds"
        ))
    }

    pub(super) fn configure_hidden(_command: &mut Command) {}
}

/// Start a helper copy before stopping the backend. The helper receives the
/// exact current PID and deliberately does not initialize Tauri.
pub(crate) fn schedule_relaunch() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command.args([RELAUNCH_AFTER_PID_ARG, &std::process::id().to_string()]);
    platform::configure_hidden(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not schedule relaunch: {error}"))
}

/// Handle the helper mode before Tauri and its single-instance plugin exist.
/// Waiting on the old process handle means the replacement starts only after
/// Windows has completed teardown and released the single-instance resources.
pub(crate) fn run_if_requested() -> Result<bool, String> {
    let Some(parent_pid) = parse_parent_pid(std::env::args().skip(1))? else {
        return Ok(false);
    };

    platform::wait_for_parent_exit(parent_pid)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    platform::configure_hidden(&mut command);
    command
        .spawn()
        .map_err(|error| format!("could not launch the replacement process: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parent_pid_parser_accepts_one_exact_helper_argument() {
        assert_eq!(
            parse_parent_pid(strings(&["--hidden", RELAUNCH_AFTER_PID_ARG, "1234"])).unwrap(),
            Some(1234)
        );
        assert_eq!(parse_parent_pid(strings(&["--hidden"])).unwrap(), None);
    }

    #[test]
    fn parent_pid_parser_rejects_malformed_or_repeated_values() {
        assert!(parse_parent_pid(strings(&[RELAUNCH_AFTER_PID_ARG])).is_err());
        assert!(parse_parent_pid(strings(&[RELAUNCH_AFTER_PID_ARG, "not-a-pid"])).is_err());
        assert!(parse_parent_pid(strings(&[RELAUNCH_AFTER_PID_ARG, "0"])).is_err());
        assert!(parse_parent_pid(strings(&[
            RELAUNCH_AFTER_PID_ARG,
            "1234",
            RELAUNCH_AFTER_PID_ARG,
            "5678",
        ]))
        .is_err());
    }
}
