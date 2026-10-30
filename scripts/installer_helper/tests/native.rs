#![cfg(windows)]

use std::{
    fs,
    path::Path,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

const HELPER: &str = env!("CARGO_BIN_EXE_cellxplorer-installer-helper");
const FIXTURE: &str = env!("CARGO_BIN_EXE_installer-process-fixture");

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn copy_fixture(root: &Path, name: &str) -> std::path::PathBuf {
    fs::create_dir_all(root).unwrap();
    let exe = root.join(name);
    fs::copy(FIXTURE, &exe).unwrap();
    exe
}
fn wait_file(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "fixture never ready: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}
fn hold(exe: &Path, ready: &Path) -> Process {
    let child = Process(Command::new(exe).arg("--hold").arg(ready).spawn().unwrap());
    wait_file(ready);
    child
}
fn cleanup(root: &Path, backend_only: bool) {
    let mut command = Command::new(HELPER);
    command.arg("--cleanup").arg(root);
    if backend_only {
        command.arg("--backend-only");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "cleanup: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
fn native_restart_preserves_windows_argv_and_uses_own_directory_not_cwd() {
    let dir = tempfile::tempdir().unwrap();
    fs::copy(HELPER, dir.path().join("helper.exe")).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_installer-argv-console-fixture"),
        dir.path().join("cellxplorer.exe"),
    )
    .unwrap();
    let output = dir.path().join("argv.json");
    let values = vec![
        output.to_str().unwrap(),
        "",
        "space\ttab a",
        "& ` $(literal)",
        "quote\"backslash\\",
        "end\\",
        "Unicode €日本 🧪",
        "/CXALLUSERS",
    ];
    let hex: String = serde_json::to_vec(&values)
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let status = Command::new(dir.path().join("helper.exe"))
        .args(["--restart", &hex])
        .current_dir(std::env::temp_dir())
        .status()
        .unwrap();
    assert!(status.success());
    wait_file(&output);
    let received: serde_json::Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert_eq!(received["args"], serde_json::json!(values[1..]));
    assert_eq!(received["console"], false);
}

#[test]
fn helper_has_gui_subsystem_and_rejects_invalid_requests() {
    let bytes = fs::read(HELPER).unwrap();
    let pe = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    assert_eq!(
        u16::from_le_bytes(bytes[pe + 24 + 68..pe + 24 + 70].try_into().unwrap()),
        2
    );
    // Read RT_MANIFEST from the PE resource table, not an arbitrary byte string.
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::{
        FindResourceW, LoadLibraryExW, LoadResource, LockResource, SizeofResource,
        LOAD_LIBRARY_AS_DATAFILE,
    };
    let filename: Vec<u16> = std::ffi::OsStr::new(HELPER)
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        let module = LoadLibraryExW(
            filename.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_AS_DATAFILE,
        );
        assert!(!module.is_null());
        let resource = FindResourceW(module, 1usize as *const u16, 24usize as *const u16);
        assert!(!resource.is_null());
        let data = LoadResource(module, resource);
        let length = SizeofResource(module, resource) as usize;
        let content = std::slice::from_raw_parts(LockResource(data) as *const u8, length);
        let manifest = std::str::from_utf8(content).unwrap().to_owned();
        FreeLibrary(module);
        assert!(manifest.contains("requestedExecutionLevel"));
        assert!(manifest.contains("level=\"asInvoker\"") || manifest.contains("level='asInvoker'"));
        assert!(!manifest.contains("requireAdministrator"));
    }
    for args in [
        vec!["--cleanup", "C:\\"],
        vec!["--cleanup", "relative"],
        vec!["--restart", "gg"],
        vec!["--restart", "5b315d"],
    ] {
        assert!(!Command::new(HELPER).args(args).status().unwrap().success());
    }
}

#[test]
fn cleanup_reaps_only_exact_root_preserves_other_channels_and_outside_descendant() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("CellXplorer");
    let sibling = dir.path().join("CellXplorer Beta");
    let collision = dir.path().join("CellXplorer-old");
    let exe = copy_fixture(&root, "cellxplorer.exe");
    let outside = copy_fixture(&sibling, "cellxplorer.exe");
    let collision_exe = copy_fixture(&collision, "cellxplorer.exe");
    let ready = dir.path().join("owned.ready");
    let outside_ready = dir.path().join("outside.ready");
    let collision_ready = dir.path().join("collision.ready");
    let descendant_ready = dir.path().join("descendant.ready");
    let mut owner = Process(
        Command::new(&exe)
            .arg("--descendant")
            .arg(&outside)
            .arg(&outside_ready)
            .arg(&ready)
            .spawn()
            .unwrap(),
    );
    wait_file(&ready);
    wait_file(&outside_ready);
    let outside_pid: u32 = fs::read_to_string(&outside_ready).unwrap().parse().unwrap();
    let mut sibling_child = hold(&outside, &descendant_ready);
    let mut collision_child = hold(&collision_exe, &collision_ready);
    cleanup(&root, false);
    assert!(owner.0.try_wait().unwrap().is_some());
    assert!(sibling_child.0.try_wait().unwrap().is_none());
    assert!(collision_child.0.try_wait().unwrap().is_none());
    // The outside orphan remains alive. Clean up only this isolated fixture root.
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, outside_pid);
        assert!(!handle.is_null());
        assert_eq!(WaitForSingleObject(handle, 0), 258);
        CloseHandle(handle);
    }
    cleanup(&sibling, false);
}

#[test]
fn backend_only_and_late_child_still_require_full_quiet_window() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    let backend = copy_fixture(&root, "cellxplorer-backend-1.exe");
    let main = copy_fixture(&root, "cellxplorer.exe");
    let outside = copy_fixture(&dir.path().join("launcher"), "fixture.exe");
    let mut main_process = hold(&main, &dir.path().join("main.ready"));
    let late_ready = dir.path().join("late.ready");
    let mut launcher = Process(
        Command::new(outside)
            .arg("--delayed")
            .arg(&backend)
            .arg(&late_ready)
            .spawn()
            .unwrap(),
    );
    let start = Instant::now();
    cleanup(&root, true);
    wait_file(&late_ready);
    assert!(
        fs::metadata(&late_ready)
            .unwrap()
            .modified()
            .unwrap()
            .elapsed()
            .unwrap()
            >= Duration::from_millis(800),
        "late observation did not reset the quiet window"
    );
    assert!(start.elapsed() >= Duration::from_millis(800));
    assert!(main_process.0.try_wait().unwrap().is_none());
    assert!(
        launcher.0.try_wait().unwrap().is_some(),
        "late backend child was not reaped"
    );
    cleanup(&root, false);
}

#[test]
fn cleanup_protects_installer_ancestor_inside_target_directory() {
    let dir = tempfile::tempdir().unwrap();
    let wrapper = copy_fixture(dir.path(), "uninstall.exe");
    let output = dir.path().join("ancestor.json");
    let status = Command::new(wrapper)
        .arg("--ancestor")
        .arg(HELPER)
        .arg(dir.path())
        .arg(&output)
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(fs::read_to_string(output).unwrap(), "0");
}

#[test]
fn cleanup_preserves_plain_directory_when_target_ends_in_unicode_whitespace() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("CellXplorer\u{a0}");
    let plain = dir.path().join("CellXplorer");
    let target_exe = copy_fixture(&target, "cellxplorer.exe");
    let plain_exe = copy_fixture(&plain, "cellxplorer.exe");
    let mut target_child = hold(&target_exe, &dir.path().join("target.ready"));
    let mut plain_child = hold(&plain_exe, &dir.path().join("plain.ready"));
    cleanup(&target, false);
    assert!(target_child.0.try_wait().unwrap().is_some());
    assert!(
        plain_child.0.try_wait().unwrap().is_none(),
        "a distinct plain directory's process was killed"
    );
}
