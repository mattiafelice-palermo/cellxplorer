use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

pub const MARKER_NAME: &str = "beta-bootstrap.json";
pub const BOOTSTRAP_SUBDIR: &str = "bootstrap";
pub const MANIFEST_NAME: &str = "manifest.json";
pub const STAGED_DB_NAME: &str = "staged-cellxplorer.db";
pub const ROLLBACK_DB_NAME: &str = "cellxplorer.db.bootstrap-rollback";
pub const LOCK_NAME: &str = ".stage-copy.lock";
pub const LIVE_DB_NAME: &str = "cellxplorer.db";

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
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenValidationError {
    Empty,
    WrongLength,
    InvalidCharacter,
    NotLowerHex,
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

pub fn stage_directory<'a>(beta_root: &'a Path, token: &str) -> Result<PathBuf, TokenValidationError> {
    validate_stage_token(token)?;
    Ok(beta_root.join(BOOTSTRAP_SUBDIR).join(token))
}

pub fn resolve_stage_paths(beta_root: &Path, token: &str) -> Result<StagePaths, String> {
    validate_stage_token(token).map_err(token_error_message)?;
    let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
    if stage_dir
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Invalid bootstrap token.".to_string());
    }
    let manifest_path = stage_dir.join(MANIFEST_NAME);
    if !manifest_path.is_file() {
        return Err("The staged copy is missing or incomplete.".to_string());
    }
    let manifest_raw = fs::read_to_string(&manifest_path).map_err(|error| error.to_string())?;
    let manifest: BootstrapManifest =
        serde_json::from_str(&manifest_raw).map_err(|_| "The staged copy manifest is invalid.".to_string())?;
    if manifest.schema_version != 1 {
        return Err("The staged copy manifest is unsupported.".to_string());
    }
    if manifest.token != token {
        return Err("The staged copy manifest does not match this token.".to_string());
    }
    let staged_db = stage_dir.join(&manifest.staged_database);
    if manifest.staged_database != STAGED_DB_NAME || !staged_db.is_file() {
        return Err("The staged database is missing.".to_string());
    }
    Ok(StagePaths {
        stage_dir: stage_dir.clone(),
        manifest_path,
        staged_db,
        staged_imports: stage_dir.join("imports"),
        source_database_instance_id: manifest.source_database_instance_id,
        source_schema_revision: manifest.source_schema_revision,
    })
}

pub struct StagePaths {
    pub stage_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub staged_db: PathBuf,
    pub staged_imports: PathBuf,
    pub source_database_instance_id: Option<String>,
    pub source_schema_revision: Option<String>,
}

pub fn write_bootstrap_marker(
    beta_root: &Path,
    source_database_instance_id: Option<&str>,
    source_schema_revision: Option<&str>,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "decision": "copied",
        "completedAt": utc_now_iso(),
        "sourceDatabaseInstanceId": source_database_instance_id,
        "sourceSchemaRevision": source_schema_revision,
    });
    let marker_path = beta_root.join(MARKER_NAME);
    let temp_path = beta_root.join(format!("{MARKER_NAME}.tmp"));
    fs::create_dir_all(beta_root).map_err(|error| error.to_string())?;
    fs::write(&temp_path, serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(&temp_path, &marker_path).map_err(|error| error.to_string())?;
    Ok(())
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

pub fn token_error_message(error: TokenValidationError) -> String {
    match error {
        TokenValidationError::Empty => "Bootstrap token is required.".to_string(),
        TokenValidationError::WrongLength => "Bootstrap token is invalid.".to_string(),
        TokenValidationError::InvalidCharacter | TokenValidationError::NotLowerHex => {
            "Bootstrap token is invalid.".to_string()
        }
    }
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

fn remove_sqlite_sidecars(db_path: &Path) {
    let prefix = db_path.to_string_lossy();
    let _ = fs::remove_file(format!("{prefix}-wal"));
    let _ = fs::remove_file(format!("{prefix}-shm"));
}

fn move_staged_imports(staged_imports: &Path, beta_imports: &Path) -> Result<(), String> {
    if !staged_imports.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(beta_imports).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(staged_imports).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let destination = beta_imports.join(entry.file_name());
        if destination.exists() {
            return Err("Beta imports already contain files.".to_string());
        }
        if file_type.is_dir() {
            fs::rename(entry.path(), &destination).map_err(|error| error.to_string())?;
        } else if file_type.is_file() {
            fs::rename(entry.path(), &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn clear_stage_lock(beta_root: &Path) {
    let lock_path = beta_root.join(BOOTSTRAP_SUBDIR).join(LOCK_NAME);
    let _ = fs::remove_file(lock_path);
}

pub fn validate_staged_copy(beta_root: &Path, token: &str) -> Result<StagePaths, String> {
    validate_stage_token(token).map_err(token_error_message)?;
    let paths = resolve_stage_paths(beta_root, token)?;
    ensure_within_root(&paths.stage_dir, beta_root)?;
    if beta_root.join(MARKER_NAME).is_file() {
        return Err("Beta setup has already completed.".to_string());
    }
    Ok(paths)
}

pub fn activate_staged_copy(beta_root: &Path, paths: &StagePaths) -> Result<(), String> {
    let live_db = beta_root.join(LIVE_DB_NAME);
    let rollback_db = beta_root.join(ROLLBACK_DB_NAME);
    let beta_imports = beta_root.join("imports");

    if rollback_db.is_file() {
        fs::remove_file(&rollback_db).map_err(|error| error.to_string())?;
    }

    if live_db.is_file() {
        fs::rename(&live_db, &rollback_db).map_err(|error| error.to_string())?;
    }
    remove_sqlite_sidecars(&live_db);

    let activation = (|| {
        fs::rename(&paths.staged_db, &live_db).map_err(|error| error.to_string())?;
        move_staged_imports(&paths.staged_imports, &beta_imports)?;
        write_bootstrap_marker(
            beta_root,
            paths.source_database_instance_id.as_deref(),
            paths.source_schema_revision.as_deref(),
        )?;
        Ok(())
    })();

    if activation.is_err() {
        let _ = fs::remove_file(&live_db);
        remove_sqlite_sidecars(&live_db);
        if rollback_db.is_file() {
            let _ = fs::rename(&rollback_db, &live_db);
        }
        return activation;
    }

    let _ = fs::remove_file(&rollback_db);
    remove_sqlite_sidecars(&rollback_db);
    clear_stage_lock(beta_root);
    Ok(())
}

pub fn apply_staged_copy(beta_root: &Path, token: &str) -> Result<(), String> {
    let paths = validate_staged_copy(beta_root, token)?;
    activate_staged_copy(beta_root, &paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    fn write_manifest(stage_dir: &Path, token: &str) {
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "token": token,
            "sourceDatabaseInstanceId": "stable-id",
            "sourceSchemaRevision": "0012",
            "stagedDatabase": STAGED_DB_NAME,
        });
        fs::write(
            stage_dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&payload).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn rejects_invalid_tokens() {
        assert!(validate_stage_token("").is_err());
        assert!(validate_stage_token("abc").is_err());
        assert!(validate_stage_token("ABCDEF0123456789ABCDEF0123456789").is_err());
        assert!(validate_stage_token("0123456789abcdef0123456789abcdef").is_ok());
    }

    #[test]
    fn activate_restores_rollback_when_import_move_fails() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(&stage_dir).unwrap();
        fs::write(stage_dir.join(STAGED_DB_NAME), b"staged-db").unwrap();
        fs::write(beta_root.join(LIVE_DB_NAME), b"live-db").unwrap();
        fs::create_dir_all(stage_dir.join("imports/existing")).unwrap();
        fs::create_dir_all(beta_root.join("imports/existing")).unwrap();
        write_manifest(&stage_dir, token);

        let paths = validate_staged_copy(&beta_root, token).expect("validate");
        let error = activate_staged_copy(&beta_root, &paths).expect_err("imports clash");
        assert!(error.contains("already contain"));
        assert!(beta_root.join(LIVE_DB_NAME).is_file());
        assert_eq!(
            fs::read_to_string(beta_root.join(LIVE_DB_NAME)).unwrap(),
            "live-db"
        );
        assert!(!beta_root.join(MARKER_NAME).exists());
    }

    #[test]
    fn successful_activation_writes_marker_and_live_database() {
        let (_dir, beta_root) = temp_root();
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = beta_root.join(BOOTSTRAP_SUBDIR).join(token);
        fs::create_dir_all(stage_dir.join("imports/nested")).unwrap();
        fs::write(stage_dir.join(STAGED_DB_NAME), b"staged-db").unwrap();
        let import_file = stage_dir.join("imports/nested/sample.nda");
        fs::write(&import_file, b"payload").unwrap();
        write_manifest(&stage_dir, token);

        let paths = validate_staged_copy(&beta_root, token).expect("validate");
        activate_staged_copy(&beta_root, &paths).expect("activate");

        assert_eq!(
            fs::read_to_string(beta_root.join(LIVE_DB_NAME)).unwrap(),
            "staged-db"
        );
        assert!(beta_root.join(MARKER_NAME).is_file());
        assert!(beta_root.join("imports/nested/sample.nda").is_file());
    }
}
