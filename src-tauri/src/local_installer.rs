//! Local input for the standard updater, never an unsigned installer launcher.
use crate::app_channel::{validate_release_version, AppChannel};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;

pub fn verify_signature(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let verify = || -> Result<(), Box<dyn std::error::Error>> {
        let key = String::from_utf8(STANDARD.decode(public_key.trim())?)?;
        let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
        PublicKey::decode(&key)?.verify(bytes, &Signature::decode(&signature)?, true)?;
        Ok(())
    };
    verify().map_err(|_| "The local installer signature is invalid. Select the matching official .exe and .sig files.".into())
}

pub fn validate_identity(channel: AppChannel, current: &str, product: &str, version: &str) -> Result<(), String> {
    if product != channel.product_name() {
        return Err("The signed installer belongs to a different application channel.".into());
    }
    validate_release_version(channel, version)?;
    let candidate = semver::Version::parse(version).map_err(|_| "Invalid installer version.")?;
    let running = semver::Version::parse(current).map_err(|_| "Invalid running application version.")?;
    if candidate < running {
        return Err("A local installer cannot downgrade this application. Select the same or a newer version.".into());
    }
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{fs::OpenOptions, io::{Read, Write}, os::windows::{ffi::OsStrExt, fs::OpenOptionsExt}, path::Path};
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};

    fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
        if !path.is_absolute() || path.to_string_lossy().starts_with(r"\\") {
            return Err("Select an absolute local file path, not a network location.".into());
        }
        let file = OpenOptions::new().read(true).share_mode(1).open(path)
            .map_err(|_| "The selected local file could not be opened. Check its path and close any writer.")?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > maximum {
            return Err("The selected local file is empty, too large or not a regular file.".into());
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(maximum + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.is_empty() || bytes.len() as u64 > maximum { return Err("Invalid local file size.".into()); }
        Ok(bytes)
    }

    fn query(block: &[u8], name: &str) -> Result<(*const u8, usize), String> {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        if unsafe { VerQueryValueW(block.as_ptr().cast(), name.as_ptr(), &mut pointer, &mut length) } == 0 || pointer.is_null() {
            return Err("The signed installer has no unambiguous Windows product/version identity.".into());
        }
        Ok((pointer.cast(), length as usize))
    }

    fn resource_text(block: &[u8], name: &str) -> Result<String, String> {
        let (pointer, units) = query(block, name)?;
        if units == 0 || units > 512 { return Err("Invalid installer version resource.".into()); }
        // The version API may return a separate converted string buffer within the
        // supplied block. Keep that block alive and validate UTF-16, including NUL.
        let text = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), units) };
        if text.last() != Some(&0) { return Err("Unterminated installer version resource.".into()); }
        String::from_utf16(&text[..units - 1]).map_err(|_| "Invalid installer version text.".into())
    }

    fn resource_identity(path: &Path) -> Result<(String, String), String> {
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
        if size == 0 || size > 4 * 1024 * 1024 { return Err("The signed file has no supported Windows installer version resource.".into()); }
        let mut block = vec![0u8; size as usize];
        if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, block.as_mut_ptr().cast()) } == 0 {
            return Err("Could not read the verified installer's product version.".into());
        }
        let (translations, length) = query(&block, r"\VarFileInfo\Translation")?;
        if length == 0 || length % 4 != 0 || length > 64 { return Err("Ambiguous installer resource languages.".into()); }
        let mut identity = None;
        for index in 0..length / 4 {
            let language = unsafe { std::ptr::read_unaligned(translations.add(index * 4).cast::<u16>()) };
            let codepage = unsafe { std::ptr::read_unaligned(translations.add(index * 4 + 2).cast::<u16>()) };
            let prefix = format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\");
            let next = (resource_text(&block, &(prefix.clone() + "ProductName"))?, resource_text(&block, &(prefix + "ProductVersion"))?);
            if identity.as_ref().is_some_and(|old| old != &next) { return Err("Conflicting signed installer identities.".into()); }
            identity = Some(next);
        }
        identity.ok_or_else(|| "Missing installer identity.".into())
    }

    pub fn load(installer: &str, signature: &str, key: &str, channel: AppChannel, current: &str) -> Result<(String, Vec<u8>), String> {
        let path = Path::new(installer);
        if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
            return Err("Select a signed Windows .exe installer.".into());
        }
        let bytes = read_bounded(path, MAX_INSTALLER_BYTES)?;
        let signature = String::from_utf8(read_bounded(Path::new(signature), MAX_SIGNATURE_BYTES)?)
            .map_err(|_| "The signature is not valid text.")?;
        verify_signature(&bytes, &signature, key)?;
        if bytes.len() < 64 || !bytes.starts_with(b"MZ") { return Err("The signed payload is not a Windows installer.".into()); }

        // Version APIs accept a pathname, so inspect an exact, read-back copy of
        // the verified bytes while retaining no-delete directory/file handles.
        // Never obtain identity by re-opening the user's mutable selected path.
        let stage = tempfile::Builder::new().prefix("cellxplorer-local-verification-").tempdir().map_err(|e| e.to_string())?;
        let directory = OpenOptions::new().read(true).share_mode(3).custom_flags(0x02000000).open(stage.path()).map_err(|e| e.to_string())?;
        let staged_path = stage.path().join("installer.exe");
        let mut writer = OpenOptions::new().create_new(true).read(true).write(true).share_mode(1).open(&staged_path).map_err(|e| e.to_string())?;
        writer.write_all(&bytes).and_then(|_| writer.sync_all()).map_err(|e| e.to_string())?;
        drop(writer);
        let mut pinned = OpenOptions::new().read(true).share_mode(1).open(&staged_path).map_err(|e| e.to_string())?;
        let mut actual = Vec::new();
        Read::by_ref(&mut pinned).take(MAX_INSTALLER_BYTES + 1).read_to_end(&mut actual).map_err(|e| e.to_string())?;
        if actual != bytes { return Err("The staged local installer changed during verification.".into()); }
        let (product, version) = resource_identity(&staged_path)?;
        validate_identity(channel, current, &product, &version)?;
        drop(pinned);
        drop(directory);
        Ok((version, bytes))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn ordinary_text_is_not_an_installer_resource() {
            let file = tempfile::NamedTempFile::new().unwrap();
            assert!(resource_identity(file.path()).is_err());
        }
        #[test]
        fn bounded_reads_reject_oversize_and_network_paths() {
            let mut file = tempfile::NamedTempFile::new().unwrap();
            file.write_all(b"12345").unwrap();
            assert!(read_bounded(file.path(), 4).is_err());
            assert!(read_bounded(Path::new(r"\\server\share\installer.exe"), 10).is_err());
        }
    }
}

#[cfg(windows)]
pub use windows::load;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_identity_is_same_channel_and_never_a_downgrade() {
        assert!(validate_identity(AppChannel::Alpha, "0.28.0-alpha.15", "CellXplorer Alpha", "0.28.0-alpha.15").is_ok());
        assert!(validate_identity(AppChannel::Alpha, "0.28.0-alpha.15", "CellXplorer Alpha", "0.28.0-alpha.16").is_ok());
        for (product, version) in [("CellXplorer Alpha", "0.28.0-alpha.14"), ("CellXplorer Beta", "0.28.0-alpha.16"), ("CellXplorer Alpha", "0.28.0-beta.16"), ("CellXplorer Alpha", "arbitrary")] {
            assert!(validate_identity(AppChannel::Alpha, "0.28.0-alpha.15", product, version).is_err());
        }
    }
    #[test]
    fn verification_fails_closed_on_missing_or_malformed_inputs() {
        assert!(verify_signature(b"MZ", "", "").is_err());
        assert!(verify_signature(b"MZ", "not-a-signature", "not-a-key").is_err());
    }

    #[test]
    fn same_minisign_vector_accepts_original_and_rejects_altered_payload() {
        let key = STANDARD.encode("untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n");
        let signature = STANDARD.encode("untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n");
        verify_signature(b"test", &signature, &key).unwrap();
        assert!(verify_signature(b"tesT", &signature, &key).is_err());
        assert!(verify_signature(b"test", &signature, &STANDARD.encode("different key")).is_err());
    }
}
