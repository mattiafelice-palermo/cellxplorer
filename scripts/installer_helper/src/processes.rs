use crate::policy;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
        ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        },
    },
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct Entry {
    parent: u32,
    name: String,
}

type Guard<'a> = &'a dyn Fn() -> Result<(), String>;

fn snapshot(guard: Guard<'_>) -> Result<HashMap<u32, Entry>, String> {
    guard()?;
    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if raw == INVALID_HANDLE_VALUE {
            return Err(format!("Process snapshot failed ({})", GetLastError()));
        }
        let handle = Handle(raw);
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(handle.0, &mut entry);
        let mut rows = HashMap::new();
        while ok != 0 {
            guard()?;
            let end = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            rows.insert(
                entry.th32ProcessID,
                Entry {
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..end]),
                },
            );
            ok = Process32NextW(handle.0, &mut entry);
        }
        if GetLastError() != ERROR_NO_MORE_FILES {
            return Err("Incomplete process snapshot".into());
        }
        guard()?;
        Ok(rows)
    }
}

fn image(handle: &Handle) -> Option<String> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        None
    } else {
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

struct Scan {
    owned: Vec<u32>,
    unresolved: bool,
}

fn owned_pids(
    prefix: &str,
    backend_only: bool,
    protected: &HashSet<u32>,
    guard: Guard<'_>,
    previously_owned: &mut HashSet<u32>,
) -> Result<Scan, String> {
    let mut rows = Vec::new();
    let mut unresolved = false;
    for (pid, entry) in snapshot(guard)? {
        guard()?;
        if pid == 0 || protected.contains(&pid) {
            continue;
        }
        // Like Win32_Process.ExecutablePath, Windows can withhold a foreign
        // protected process's image path. Never guess ownership from its name.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = unsafe { GetLastError() };
            if error != ERROR_INVALID_PARAMETER
                && (entry.name.to_ascii_lowercase().starts_with("cellxplorer")
                    || previously_owned.contains(&pid))
            {
                unresolved = true;
            }
            continue;
        }
        let handle = Handle(raw);
        match image(&handle) {
            Some(path) if policy::owned(&path, prefix, backend_only) => {
                rows.push(pid);
                previously_owned.insert(pid);
            }
            None if (entry.name.to_ascii_lowercase().starts_with("cellxplorer")
                || previously_owned.contains(&pid))
                && unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0 =>
            {
                // Windows may release an exiting image before signaling its
                // process object. Retry within the original deadline; this is
                // NOT evidence of absence and can never count as a quiet sample.
                unresolved = true;
            }
            _ => {}
        }
    }
    Ok(Scan {
        owned: rows,
        unresolved,
    })
}

fn stop(
    pid: u32,
    prefix: &str,
    backend_only: bool,
    guard: Guard<'_>,
) -> Result<Option<Handle>, String> {
    guard()?;
    unsafe {
        let raw = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if raw.is_null() {
            let error = GetLastError();
            return if error == ERROR_INVALID_PARAMETER {
                Ok(None)
            } else if error == ERROR_ACCESS_DENIED {
                // A known-owned process may be in final teardown. The caller
                // resets quiet count and re-inspects on the next bounded sweep.
                Ok(None)
            } else {
                Err(format!("Cannot stop owned process {pid} ({error})"))
            };
        }
        let handle = Handle(raw);
        // Re-query the SAME handle used for termination, so PID reuse cannot
        // terminate another edition or an unrelated replacement process.
        let Some(path) = image(&handle) else {
            return if WaitForSingleObject(handle.0, 0) == WAIT_OBJECT_0 {
                Ok(None)
            } else {
                // Do not terminate an unverified image. Retain this exact
                // handle as unresolved until it signals or the deadline fails.
                Ok(Some(handle))
            };
        };
        if !policy::owned(&path, prefix, backend_only) {
            return Ok(None);
        }
        guard()?;
        if TerminateProcess(handle.0, 1) == 0 {
            let error = GetLastError();
            if error != ERROR_ACCESS_DENIED {
                return Err(format!("Failed to terminate owned process {pid} ({error})"));
            }
        }
        Ok(Some(handle))
    }
}

pub fn cleanup(directory: &Path, backend_only: bool) -> Result<(), String> {
    let start = Instant::now();
    let guard = || policy::check_budget(start.elapsed());
    let prefix = format!(
        "{}\\",
        policy::normalize(&directory.to_string_lossy()).trim_end_matches('\\')
    );
    let parents = snapshot(&guard)?
        .into_iter()
        .map(|(pid, entry)| (pid, entry.parent))
        .collect();
    let protected = policy::ancestors(std::process::id(), &parents);
    guard()?;
    let mut quiet = 0;
    let mut samples = 0;
    let mut pending = Vec::<Handle>::new();
    let mut previously_owned = HashSet::new();
    loop {
        let scan = owned_pids(
            &prefix,
            backend_only,
            &protected,
            &guard,
            &mut previously_owned,
        )?;
        samples += 1;
        for pid in &scan.owned {
            if let Some(handle) = stop(*pid, &prefix, backend_only, &guard)? {
                pending.push(handle);
            }
        }
        // TerminateProcess is asynchronous. A process disappearing from the PID
        // snapshot is not sufficient; its retained kernel handle must signal.
        pending.retain(|handle| unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0);
        if policy::observe(
            &mut quiet,
            !scan.owned.is_empty() || scan.unresolved || !pending.is_empty(),
            start.elapsed(),
        )? {
            break;
        }
        std::thread::sleep(policy::INTERVAL.min(policy::TIMEOUT.saturating_sub(start.elapsed())));
    }
    let final_scan = owned_pids(
        &prefix,
        backend_only,
        &protected,
        &guard,
        &mut previously_owned,
    )?;
    if !final_scan.owned.is_empty() || final_scan.unresolved || start.elapsed() >= policy::TIMEOUT {
        return Err("Installation-owned processes remain after cleanup".into());
    }
    println!(
        "Installation process cleanup: {} ms, {samples} quiet/active samples",
        start.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, time::Duration};

    #[test]
    fn injected_expiry_during_snapshot_and_before_stop_is_an_error() {
        let expired = || policy::check_budget(policy::TIMEOUT);
        assert!(snapshot(&expired).is_err());
        // Failure happens before any process open or termination (PID zero).
        assert!(stop(0, "C:\\fixture\\", false, &expired).is_err());
        let calls = Cell::new(0);
        let expires_during_enumeration = || {
            calls.set(calls.get() + 1);
            policy::check_budget(if calls.get() < 3 {
                Duration::ZERO
            } else {
                policy::TIMEOUT
            })
        };
        assert!(snapshot(&expires_during_enumeration).is_err());
        assert_eq!(calls.get(), 3);
    }
}
