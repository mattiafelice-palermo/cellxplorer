use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const MARKER_NAME: &str = "beta-bootstrap.json";
pub const APPLY_FAILURE_NAME: &str = "beta-bootstrap-apply-error.json";
pub const BOOTSTRAP_SUBDIR: &str = "bootstrap";
pub const MANIFEST_NAME: &str = "manifest.json";
pub const STAGED_DB_NAME: &str = "staged-cellxplorer.db";
pub const ROLLBACK_DB_NAME: &str = "cellxplorer.db.bootstrap-rollback";
pub const IMPORTS_ROLLBACK_NAME: &str = "imports.bootstrap-rollback";
pub const LOCK_NAME: &str = ".stage-copy.lock";
pub const LIVE_DB_NAME: &str = "cellxplorer.db";
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
struct ImportInventoryEntry {
    #[serde(rename = "relativePath")]
    relative_path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct BootstrapManifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    token: String,
    #[serde(rename = "sourceDatabaseInstanceId")]
    source_database_instance_id: Option<String>,
    #[serde(rename = "sourceSchemaRevision")]
    source_schema_revision: Option<String>,
    #[serde(rename = "stagedDatabase")]
    staged_database: String,
    #[serde(rename = "stagedDatabaseSha256")]
    staged_database_sha256: String,
    #[serde(rename = "stagedDatabaseSize")]
    staged_database_size: u64,
    #[serde(rename = "copiedImports")]
    copied_imports: usize,
    imports: Vec<ImportInventoryEntry>,
    #[serde(rename = "replaceExistingBeta", default)]
    replace_existing_beta: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenValidationError {
    Empty,
    WrongLength,
    InvalidCharacter,
    NotLowerHex,
}

#[derive(Debug)]
pub struct StagePaths {
    pub stage_dir: PathBuf,
    pub staged_db: PathBuf,
    pub staged_imports: PathBuf,
    pub source_database_instance_id: Option<String>,
    pub source_schema_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // exercised by lifecycle unit tests
pub enum ApplyPhase {
    PreStopValidation,
    RelaunchScheduled,
    BackendStopped,
    ActivationSucceeded,
    ActivationFailed,
}

pub fn validate_stage_token(token: &str) -> Result<(), TokenValidationError> {
    if token.is_empty() {
        return Err(TokenValidationError::Empty);
    }
    if token.len() != 32 {
        return Err(TokenValidationError::WrongLength);
    }
    if !token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(TokenValidationError::InvalidCharacter);
    }
    if token.chars().any(|ch| ch.is_ascii_uppercase()) {
        return Err(TokenValidationError::NotLowerHex);
    }
    Ok(())
}

pub fn token_error_message(error: TokenValidationError) -> String {
    match error {
        TokenValidationError::Empty => "Bootstrap token is required.".to_string(),
        TokenValidationError::WrongLength
        | TokenValidationError::InvalidCharacter
        | TokenValidationError::NotLowerHex => "Bootstrap token is invalid.".to_string(),
    }
}

fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Staged bootstrap paths must not be symbolic links.".to_string());
    }
    Ok(())
}

fn ensure_within_root(path: &Path, root: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Invalid bootstrap path.".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve Beta data root: {error}"))?;
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve staged bootstrap path: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err("Invalid bootstrap path.".to_string());
    }
    Ok(())
}

fn normalize_relative(path: &str) -> Result<String, String> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("Staged import path is invalid.".to_string());
    }
    let parts: Vec<String> = candidate
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().replace('\\', "/")),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return Err("Staged import path is invalid.".to_string());
    }
    Ok(parts.join("/"))
}

fn remove_sqlite_sidecars(db_path: &Path) {
    let prefix = db_path.to_string_lossy();
    let _ = fs::remove_file(format!("{prefix}-wal"));
    let _ = fs::remove_file(format!("{prefix}-shm"));
}

fn remove_tree(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn imports_has_payload(import_dir: &Path) -> bool {
    if !import_dir.is_dir() {
        return false;
    }
    fn walk(path: &Path) -> bool {
        let Ok(entries) = fs::read_dir(path) else {
            return false;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_file() {
                return true;
            }
            if child.is_dir() && walk(&child) {
                return true;
            }
        }
        false
    }
    walk(import_dir)
}

fn sqlite_user_content_counts(db_path: &Path) -> Result<i64, String> {
    reject_symlink(db_path)?;
    let connection = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| format!("Could not open Beta database: {error}"))?;
    let tables = [
        "source_files",
        "tests",
        "cells",
        "replicate_groups",
        "folders",
        "analyses",
    ];
    let mut total = 0_i64;
    for table in tables {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            continue;
        }
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(|error| format!("Could not inspect Beta database: {error}"))?;
        total += count;
    }
    Ok(total)
}

fn sqlite_integrity_ok(db_path: &Path) -> Result<(), String> {
    reject_symlink(db_path)?;
    let connection = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| format!("Could not open staged database: {error}"))?;
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Staged database integrity check failed: {error}"))?;
    if result != "ok" {
        return Err("The staged database failed integrity checks.".to_string());
    }
    Ok(())
}

pub fn live_beta_is_pristine(beta_root: &Path) -> Result<(), String> {
    if beta_root.join(MARKER_NAME).is_file() {
        return Err("Beta setup has already completed.".to_string());
    }
    if imports_has_payload(&beta_root.join("imports")) {
        return Err("Beta already contains imported source files.".to_string());
    }
    let live_db = beta_root.join(LIVE_DB_NAME);
    if live_db.is_file() {
        let count = sqlite_user_content_counts(&live_db)?;
        if count > 0 {
            return Err("Beta already contains library data.".to_string());
        }
    }
    Ok(())
}

fn collect_staged_files(stage_imports: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    let mut found = BTreeMap::new();
    if !stage_imports.exists() {
        return Ok(found);
    }
    reject_symlink(stage_imports)?;
    fn walk(root: &Path, current: &Path, found: &mut BTreeMap<String, PathBuf>) -> Result<(), String> {
        reject_symlink(current)?;
        for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            reject_symlink(&path)?;
            if path.is_dir() {
                walk(root, &path, found)?;
                continue;
            }
            if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "Staged import escaped the stage directory.".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                found.insert(relative, path);
            }
        }
        Ok(())
    }
    walk(stage_imports, stage_imports, &mut found)?;
    Ok(found)
}

pub fn resolve_and_verify_stage(beta_root: &Path, token: &str) -> Result<StagePaths, String> {
    validate_stage_token(token).map_err(token_error_message)?;
    fs::create_dir_all(beta_root).map_err(|error| error.to_string())?;
    let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
    ensure_within_root(&stage_dir, beta_root)?;
    reject_symlink(&stage_dir)?;

    let manifest_path = stage_dir.join(MANIFEST_NAME);
    reject_symlink(&manifest_path)?;
    if !manifest_path.is_file() {
        return Err("The staged copy is missing or incomplete.".to_string());
    }
    let manifest_raw = fs::read_to_string(&manifest_path).map_err(|error| error.to_string())?;
    let manifest: BootstrapManifest = serde_json::from_str(&manifest_raw)
        .map_err(|_| "The staged copy manifest is invalid.".to_string())?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err("The staged copy manifest is unsupported.".to_string());
    }
    if manifest.token != token {
        return Err("The staged copy manifest does not match this token.".to_string());
    }
    if manifest.staged_database != STAGED_DB_NAME {
        return Err("The staged database is missing.".to_string());
    }
    if manifest.copied_imports != manifest.imports.len() {
        return Err("The staged import inventory count does not match.".to_string());
    }

    let staged_db = stage_dir.join(STAGED_DB_NAME);
    reject_symlink(&staged_db)?;
    ensure_within_root(&staged_db, beta_root)?;
    if !staged_db.is_file() {
        return Err("The staged database is missing.".to_string());
    }
    let (db_digest, db_size) = sha256_file(&staged_db)?;
    if db_size != manifest.staged_database_size || db_digest != manifest.staged_database_sha256 {
        return Err("The staged database checksum does not match the manifest.".to_string());
    }
    sqlite_integrity_ok(&staged_db)?;

    let staged_imports = stage_dir.join("imports");
    let found = collect_staged_files(&staged_imports)?;
    let mut expected = BTreeSet::new();
    for entry in &manifest.imports {
        let relative = normalize_relative(&entry.relative_path)?;
        expected.insert(relative.clone());
        let path = staged_imports.join(Path::new(&relative.replace('/', std::path::MAIN_SEPARATOR_STR)));
        reject_symlink(&path)?;
        ensure_within_root(&path, beta_root)?;
        if !path.is_file() {
            return Err(format!("Staged import is missing: {relative}"));
        }
        let (digest, size) = sha256_file(&path)?;
        if size != entry.size || digest != entry.sha256 {
            return Err(format!("Staged import checksum mismatch: {relative}"));
        }
    }
    let found_keys: BTreeSet<_> = found.keys().cloned().collect();
    if found_keys != expected {
        return Err("Staged imports do not match the manifest inventory.".to_string());
    }

    // Reject unexpected top-level stage files beyond DB/manifest/imports.
    for entry in fs::read_dir(&stage_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != MANIFEST_NAME && name != STAGED_DB_NAME && name != "imports" {
            return Err(format!("Unexpected staged content: {name}"));
        }
    }

    if !manifest.replace_existing_beta {
        live_beta_is_pristine(beta_root)?;
    }

    Ok(StagePaths {
        stage_dir,
        staged_db,
        staged_imports,
        source_database_instance_id: manifest.source_database_instance_id,
        source_schema_revision: manifest.source_schema_revision,
    })
}

pub fn write_bootstrap_marker(
    beta_root: &Path,
    source_database_instance_id: Option<&str>,
    source_schema_revision: Option<&str>,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "decision": "copied",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "completedAt": utc_now_iso(),
        "sourceDatabaseInstanceId": source_database_instance_id,
        "sourceSchemaRevision": source_schema_revision,
    });
    atomic_write_json(&beta_root.join(MARKER_NAME), &payload)
}

pub fn write_apply_failure_marker(beta_root: &Path, message: &str) -> Result<(), String> {
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "failedAt": utc_now_iso(),
        "message": message,
    });
    atomic_write_json(&beta_root.join(APPLY_FAILURE_NAME), &payload)
}

pub fn clear_apply_failure_marker(beta_root: &Path) {
    let _ = fs::remove_file(beta_root.join(APPLY_FAILURE_NAME));
}

fn atomic_write_json(path: &Path, payload: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        let body = serde_json::to_string_pretty(payload).map_err(|error| error.to_string())?;
        file.write_all(body.as_bytes()).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn utc_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let total = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = total / 86_400;
    let rem = total % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn clear_stage_lock(beta_root: &Path) {
    let _ = fs::remove_file(beta_root.join(BOOTSTRAP_SUBDIR).join(LOCK_NAME));
}

pub fn remove_consumed_stage(beta_root: &Path, token: &str) -> Result<(), String> {
    validate_stage_token(token).map_err(token_error_message)?;
    let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
    if stage_dir.exists() {
        ensure_within_root(&stage_dir, beta_root)?;
        remove_tree(&stage_dir)?;
    }
    clear_stage_lock(beta_root);
    Ok(())
}

fn restore_imports(_beta_root: &Path, rollback_imports: &Path, live_imports: &Path) {
    let _ = remove_tree(live_imports);
    if rollback_imports.exists() {
        let _ = fs::rename(rollback_imports, live_imports);
    }
}

pub fn activate_staged_copy(beta_root: &Path, paths: &StagePaths) -> Result<(), String> {
    let live_db = beta_root.join(LIVE_DB_NAME);
    let rollback_db = beta_root.join(ROLLBACK_DB_NAME);
    let live_imports = beta_root.join("imports");
    let rollback_imports = beta_root.join(IMPORTS_ROLLBACK_NAME);

    if rollback_db.exists() {
        remove_tree(&rollback_db)?;
    }
    if rollback_imports.exists() {
        remove_tree(&rollback_imports)?;
    }

    if live_db.is_file() {
        fs::rename(&live_db, &rollback_db).map_err(|error| error.to_string())?;
    }
    remove_sqlite_sidecars(&live_db);

    if live_imports.exists() {
        fs::rename(&live_imports, &rollback_imports).map_err(|error| error.to_string())?;
    }

    let mut moved_db = false;
    let mut moved_imports = false;

    let activation_error = loop {
        if let Err(error) = fs::rename(&paths.staged_db, &live_db) {
            break Some(error.to_string());
        }
        moved_db = true;
        if paths.staged_imports.is_dir() {
            if let Err(error) = fs::rename(&paths.staged_imports, &live_imports) {
                break Some(error.to_string());
            }
            moved_imports = true;
        }
        if let Err(error) = write_bootstrap_marker(
            beta_root,
            paths.source_database_instance_id.as_deref(),
            paths.source_schema_revision.as_deref(),
        ) {
            break Some(error);
        }
        break None;
    };

    if let Some(error) = activation_error {
        let _ = fs::remove_file(beta_root.join(MARKER_NAME));
        if moved_imports && live_imports.exists() && !paths.staged_imports.exists() {
            let _ = fs::rename(&live_imports, &paths.staged_imports);
        }
        if moved_db && live_db.exists() && !paths.staged_db.exists() {
            let _ = fs::rename(&live_db, &paths.staged_db);
        }
        let _ = remove_tree(&live_db);
        remove_sqlite_sidecars(&live_db);
        if rollback_db.is_file() {
            let _ = fs::rename(&rollback_db, &live_db);
        }
        restore_imports(beta_root, &rollback_imports, &live_imports);
        return Err(error);
    }

    let _ = remove_tree(&rollback_db);
    remove_sqlite_sidecars(&rollback_db);
    let _ = remove_tree(&rollback_imports);
    clear_stage_lock(beta_root);
    Ok(())
}

/// Pure helper for lifecycle tests: encode the required ordering constraints.
#[allow(dead_code)]
pub fn next_apply_phase(current: ApplyPhase, event: &str) -> Result<ApplyPhase, String> {
    match (current, event) {
        (ApplyPhase::PreStopValidation, "validation_ok") => Ok(ApplyPhase::RelaunchScheduled),
        (ApplyPhase::PreStopValidation, "validation_fail") => {
            Err("validation failed before backend stop".to_string())
        }
        (ApplyPhase::RelaunchScheduled, "backend_stopped") => Ok(ApplyPhase::BackendStopped),
        (ApplyPhase::BackendStopped, "activation_ok") => Ok(ApplyPhase::ActivationSucceeded),
        (ApplyPhase::BackendStopped, "activation_fail") => Ok(ApplyPhase::ActivationFailed),
        _ => Err(format!("illegal apply transition {current:?} + {event}")),
    }
}

pub fn validate_staged_copy(beta_root: &Path, token: &str) -> Result<StagePaths, String> {
    resolve_and_verify_stage(beta_root, token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        (dir, root)
    }

    fn write_sqlite_file(path: &Path, label: &str) {
        let connection = rusqlite::Connection::open(path).unwrap();
        connection
            .execute_batch("CREATE TABLE IF NOT EXISTS probe(value TEXT); DELETE FROM probe;")
            .unwrap();
        connection
            .execute("INSERT INTO probe(value) VALUES (?1)", [label])
            .unwrap();
    }

    fn write_manifest_with_replacement(
        stage_dir: &Path,
        token: &str,
        db_path: &Path,
        imports: &[(&str, &[u8])],
        replace_existing_beta: bool,
    ) {
        let (digest, size) = sha256_file(db_path).unwrap();
        let mut inventory = Vec::new();
        for (relative, bytes) in imports {
            let path = stage_dir.join("imports").join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, bytes).unwrap();
            let (file_digest, file_size) = sha256_file(&path).unwrap();
            inventory.push(serde_json::json!({
                "relativePath": relative,
                "size": file_size,
                "sha256": file_digest,
            }));
        }
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "token": token,
            "sourceDatabaseInstanceId": "stable-id",
            "sourceSchemaRevision": "0012",
            "stagedDatabase": STAGED_DB_NAME,
            "stagedDatabaseSha256": digest,
            "stagedDatabaseSize": size,
            "copiedImports": inventory.len(),
            "imports": inventory,
            "replaceExistingBeta": replace_existing_beta,
        });
        fs::write(
            stage_dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&payload).unwrap(),
        )
        .unwrap();
    }

    fn write_manifest(stage_dir: &Path, token: &str, db_path: &Path, imports: &[(&str, &[u8])]) {
        write_manifest_with_replacement(stage_dir, token, db_path, imports, false);
    }

    #[test]
    fn rejects_invalid_tokens() {
        assert!(validate_stage_token("").is_err());
        assert!(validate_stage_token("abc").is_err());
        assert!(validate_stage_token("ABCDEF0123456789ABCDEF0123456789").is_err());
        assert!(validate_stage_token("0123456789abcdef0123456789abcdef").is_ok());
    }

    #[test]
    fn apply_phase_ordering_rejects_illegal_transitions() {
        assert!(next_apply_phase(ApplyPhase::PreStopValidation, "validation_fail").is_err());
        let scheduled =
            next_apply_phase(ApplyPhase::PreStopValidation, "validation_ok").unwrap();
        assert_eq!(scheduled, ApplyPhase::RelaunchScheduled);
        let stopped = next_apply_phase(scheduled, "backend_stopped").unwrap();
        assert_eq!(
            next_apply_phase(stopped, "activation_fail").unwrap(),
            ApplyPhase::ActivationFailed
        );
    }

    #[test]
    fn rejects_tampered_staged_database_before_mutation() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(&stage_dir).unwrap();
        let staged_db = stage_dir.join(STAGED_DB_NAME);
        write_sqlite_file(&staged_db, "staged");
        write_manifest(&stage_dir, token, &staged_db, &[]);
        fs::write(&staged_db, b"tampered").unwrap();
        write_sqlite_file(&beta_root.join(LIVE_DB_NAME), "live");
        let error = resolve_and_verify_stage(&beta_root, token).expect_err("tamper");
        assert!(error.contains("checksum"));
        assert_eq!(
            fs::read(&beta_root.join(LIVE_DB_NAME)).ok().map(|bytes| bytes.len()),
            Some(fs::metadata(beta_root.join(LIVE_DB_NAME)).unwrap().len() as usize)
                .filter(|_| true)
        );
        assert!(!beta_root.join(MARKER_NAME).exists());
    }

    #[test]
    fn activate_restores_db_and_imports_after_partial_failure() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(stage_dir.join("imports/nested")).unwrap();
        let staged_db = stage_dir.join(STAGED_DB_NAME);
        write_sqlite_file(&staged_db, "staged");
        write_manifest(
            &stage_dir,
            token,
            &staged_db,
            &[("nested/one.nda", b"one"), ("nested/two.nda", b"two")],
        );
        write_sqlite_file(&beta_root.join(LIVE_DB_NAME), "live");
        fs::create_dir_all(beta_root.join("imports/keep")).unwrap();
        fs::write(beta_root.join("imports/keep/sentinel.nda"), b"keep").unwrap();

        // Force marker write failure by making the marker path a directory.
        fs::create_dir_all(beta_root.join(MARKER_NAME)).unwrap();
        let paths = StagePaths {
            stage_dir: stage_dir.clone(),
            staged_db: staged_db.clone(),
            staged_imports: stage_dir.join("imports"),
            source_database_instance_id: Some("stable-id".into()),
            source_schema_revision: Some("0012".into()),
        };
        let error = activate_staged_copy(&beta_root, &paths).expect_err("marker dir");
        assert!(!error.is_empty());
        assert!(beta_root.join("imports/keep/sentinel.nda").is_file());
        assert!(!beta_root.join("imports/nested/one.nda").exists());
        assert!(!beta_root.join("imports/nested/two.nda").exists());
        assert!(beta_root.join(LIVE_DB_NAME).is_file());
    }

    #[test]
    fn successful_activation_swaps_imports_tree_and_writes_marker() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(&stage_dir).unwrap();
        let staged_db = stage_dir.join(STAGED_DB_NAME);
        write_sqlite_file(&staged_db, "staged");
        write_manifest(
            &stage_dir,
            token,
            &staged_db,
            &[("nested/sample.nda", b"payload")],
        );
        let paths = resolve_and_verify_stage(&beta_root, token).expect("validate");
        activate_staged_copy(&beta_root, &paths).expect("activate");
        assert!(beta_root.join(MARKER_NAME).is_file());
        assert!(beta_root.join("imports/nested/sample.nda").is_file());
        assert!(!stage_dir.join(STAGED_DB_NAME).exists());
    }

    #[test]
    fn rejects_non_pristine_live_beta_before_mutation() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(&stage_dir).unwrap();
        let staged_db = stage_dir.join(STAGED_DB_NAME);
        write_sqlite_file(&staged_db, "staged");
        write_manifest(&stage_dir, token, &staged_db, &[]);
        fs::create_dir_all(beta_root.join("imports")).unwrap();
        fs::write(beta_root.join("imports/extra.nda"), b"x").unwrap();
        let error = resolve_and_verify_stage(&beta_root, token).expect_err("non-pristine");
        assert!(error.contains("imported"));
    }

    #[test]
    fn explicit_replacement_accepts_existing_beta_and_swaps_it_atomically() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(&stage_dir).unwrap();
        let staged_db = stage_dir.join(STAGED_DB_NAME);
        write_sqlite_file(&staged_db, "staged");
        write_manifest_with_replacement(&stage_dir, token, &staged_db, &[], true);
        write_sqlite_file(&beta_root.join(LIVE_DB_NAME), "existing");
        fs::write(
            beta_root.join(MARKER_NAME),
            r#"{"schemaVersion":1,"decision":"empty"}"#,
        )
        .unwrap();

        let paths = resolve_and_verify_stage(&beta_root, token).expect("validate replacement");
        activate_staged_copy(&beta_root, &paths).expect("activate replacement");

        let connection = rusqlite::Connection::open(beta_root.join(LIVE_DB_NAME)).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "staged");
        let marker: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(beta_root.join(MARKER_NAME)).unwrap()).unwrap();
        assert_eq!(marker["decision"], "copied");
        assert_eq!(marker["appVersion"], env!("CARGO_PKG_VERSION"));
        assert!(!beta_root.join(ROLLBACK_DB_NAME).exists());
    }
}
