use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

pub const TIMEOUT: Duration = Duration::from_secs(10);
pub const INTERVAL: Duration = Duration::from_millis(200);
pub const QUIET_SAMPLES: usize = 5;

pub fn check_command_length(executable: &str, arguments: &[String]) -> Result<(), String> {
    // Conservative exact upper bound for Windows argv quoting: every backslash
    // may need doubling, every quote escaping, plus outer quotes/separators/NUL.
    let length = std::iter::once(executable)
        .chain(arguments.iter().map(String::as_str))
        .map(|value| {
            3 + value
                .encode_utf16()
                .map(|c| {
                    if c == b'\\' as u16 || c == b'"' as u16 {
                        2
                    } else {
                        1
                    }
                })
                .sum::<usize>()
        })
        .sum::<usize>()
        + 1;
    if length > 32767 {
        Err("Restart command exceeds the Windows command-line limit".into())
    } else {
        Ok(())
    }
}

pub fn decode_arguments(hex: &str) -> Result<Vec<String>, String> {
    if hex.is_empty() || hex.len() > 65536 || hex.len() % 2 != 0 || !hex.is_ascii() {
        return Err("Invalid restart argument encoding".into());
    }
    let bytes = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            let nibble = |byte: u8| (byte as char).to_digit(16).map(|n| n as u8);
            Ok(nibble(chunk[0]).ok_or("Invalid restart hex")? * 16
                + nibble(chunk[1]).ok_or("Invalid restart hex")?)
        })
        .collect::<Result<Vec<u8>, String>>()?;
    let arguments: Vec<String> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if arguments.iter().any(|value| value.contains('\0')) {
        return Err("NUL is not permitted in restart arguments".into());
    }
    Ok(arguments)
}

pub fn normalize(path: &str) -> String {
    let path = path.trim().replace('/', "\\");
    let path = if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        path.strip_prefix("\\\\?\\").unwrap_or(&path).to_string()
    };
    path
}

fn ordinal_prefix(path: &str, prefix: &str) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::CompareStringOrdinal;
        let path: Vec<u16> = path.encode_utf16().collect();
        let prefix: Vec<u16> = prefix.encode_utf16().collect();
        path.len() >= prefix.len()
            && unsafe {
                CompareStringOrdinal(
                    path.as_ptr(),
                    prefix.len() as i32,
                    prefix.as_ptr(),
                    prefix.len() as i32,
                    1,
                )
            } == 2 // CSTR_EQUAL; no locale-sensitive mapping or Unicode expansion
    }
    #[cfg(not(windows))]
    {
        path.get(..prefix.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    }
}

pub fn owned(path: &str, prefix: &str, backend_only: bool) -> bool {
    let path = normalize(path);
    ordinal_prefix(&path, prefix)
        && (!backend_only || {
            let name = path.rsplit('\\').next().unwrap_or("").to_ascii_lowercase();
            name.starts_with("cellxplorer-backend") && name.ends_with(".exe")
        })
}

pub fn ancestors(pid: u32, parents: &HashMap<u32, u32>) -> HashSet<u32> {
    let mut result = HashSet::new();
    let mut next = pid;
    while next != 0 && result.insert(next) {
        next = parents.get(&next).copied().unwrap_or(0);
    }
    result
}

/// Monotonic, non-resetting timeout; seeing a late child resets only quiet count.
pub fn observe(quiet: &mut usize, any_owned: bool, elapsed: Duration) -> Result<bool, String> {
    check_budget(elapsed)?;
    *quiet = if any_owned { 0 } else { *quiet + 1 };
    Ok(*quiet >= QUIET_SAMPLES)
}

pub fn check_budget(elapsed: Duration) -> Result<(), String> {
    if elapsed >= TIMEOUT {
        Err("Installation-owned processes did not remain absent before the cleanup deadline".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_arguments_are_data_and_preserve_unicode_and_special_characters() {
        let values = vec![
            "",
            "a b",
            "& ` $(literal)",
            "a\"b\\",
            "終わり €",
            "/CXALLUSERS",
        ];
        let hex: String = serde_json::to_vec(&values)
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(decode_arguments(&hex).unwrap(), values);
        assert_eq!(decode_arguments("5b5d").unwrap(), Vec::<String>::new());
    }
    #[test]
    fn malformed_and_non_string_restart_values_are_rejected() {
        for hex in [
            "",
            "0",
            "gg",
            "c3",
            "6e756c6c",
            "5b315d",
            "5b225c7530303030225d",
        ] {
            assert!(decode_arguments(hex).is_err(), "{hex}");
        }
        assert!(decode_arguments(&"00".repeat(32769)).is_err());
        assert!(check_command_length("C:\\app.exe", &["\\".repeat(20000)]).is_err());
        assert!(check_command_length("C:\\app.exe", &["日本🧪".into()]).is_ok());
    }
    #[test]
    fn directory_boundary_backend_selector_and_extended_paths() {
        let prefix = "c:\\apps\\cellxplorer\\";
        assert!(owned("C:/Apps/CellXplorer/cellxplorer.exe", prefix, false));
        assert!(owned(
            "\\\\?\\C:\\Apps\\CellXplorer\\cellxplorer-backend-1.exe",
            prefix,
            true
        ));
        // Unicode lowercasing would merge these DISTINCT Windows directories.
        assert!(!owned(
            "C:\\Apps\\i\u{307}\\worker.exe",
            "C:\\Apps\\İ\\",
            false
        ));
        assert!(!owned(
            "C:\\Apps\\İ\\worker.exe",
            "C:\\Apps\\i\u{307}\\",
            false
        ));
        for path in [
            "C:\\Apps\\CellXplorer Beta\\cellxplorer.exe",
            "C:\\Apps\\CellXplorer-old\\cellxplorer.exe",
            "",
            "C:\\Apps\\CellXplorer",
        ] {
            assert!(!owned(path, prefix, false));
        }
        assert!(!owned(
            "C:\\Apps\\CellXplorer\\cellxplorer.exe",
            prefix,
            true
        ));
        assert!(owned(
            "\\\\?\\UNC\\server\\share\\app\\worker.exe",
            "\\\\server\\share\\app\\",
            false
        ));
    }
    #[test]
    fn protects_complete_ancestry_and_terminates_cycles() {
        let parents = HashMap::from([(9, 8), (8, 7), (7, 8)]);
        assert_eq!(ancestors(9, &parents), HashSet::from([9, 8, 7]));
    }
    #[test]
    fn five_quiet_samples_late_child_reset_and_fixed_deadline() {
        let mut quiet = 0;
        for n in 0..4 {
            assert!(!observe(&mut quiet, false, INTERVAL * n).unwrap());
        }
        assert!(!observe(&mut quiet, true, INTERVAL * 4).unwrap());
        for n in 5..9 {
            assert!(!observe(&mut quiet, false, INTERVAL * n).unwrap());
        }
        assert!(observe(&mut quiet, false, INTERVAL * 9).unwrap());
        assert!(observe(&mut quiet, true, TIMEOUT).is_err());
        assert!(observe(&mut quiet, false, TIMEOUT).is_err());
    }
}
