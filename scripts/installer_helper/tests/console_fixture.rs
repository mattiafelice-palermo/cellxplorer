// Deliberately a CONSOLE-subsystem child: only CREATE_NO_WINDOW can prevent a
// new console when our windowless restart helper launches this test executable.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    let console = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
    #[cfg(not(windows))]
    let console: *mut std::ffi::c_void = std::ptr::null_mut();
    std::fs::write(
        &args[0],
        serde_json::to_vec(&serde_json::json!({
            "args": &args[1..], "console": !console.is_null(),
        }))
        .unwrap(),
    )
    .unwrap();
}
