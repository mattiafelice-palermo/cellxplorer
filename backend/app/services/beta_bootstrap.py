"""Beta first-run library copy from Stable (Spec 022)."""

from __future__ import annotations

from uuid import uuid4
import hashlib
import json
import logging
import re
import secrets
import shutil
import sqlite3
import threading
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import APP_DATA_DIR, APP_VERSION, IMPORT_DIR, INSTALL_INSTANCE_ID
from ..models import Analysis, Cell, Folder, ReplicateGroup, SourceFile, Test
from ..services.app_channel import resolve_app_channel, stable_default_data_root
from ..services.database_identity import DATABASE_INSTANCE_ID_KEY
from ..services.scientific_preparation import (
    SCIENTIFIC_PREPARATION_KEY,
    get_state as get_scientific_preparation_state,
    is_pending as scientific_preparation_is_pending,
    pending_value as scientific_preparation_pending_value,
)
from ..services.database_migrations import (
    CORE_TABLES,
    REVISION_BY_ID,
    _connect_readonly,
    _existing_tables,
    _integrity_error,
    _is_future_revision,
    _looks_like_legacy_cellxplorer,
    _read_revision,
)

logger = logging.getLogger(__name__)

MARKER_NAME = "beta-bootstrap.json"
APPLY_FAILURE_NAME = "beta-bootstrap-apply-error.json"
BOOTSTRAP_SUBDIR = "bootstrap"
MANIFEST_NAME = "manifest.json"
STAGED_DB_NAME = "staged-cellxplorer.db"
LOCK_NAME = ".stage-copy.lock"
MARKER_SCHEMA_VERSION = 1
MANIFEST_SCHEMA_VERSION = 1
STAGE_TOKEN_BYTES = 16
STAGE_RETENTION_HOURS = 24
COPY_CHUNK_SIZE = 1024 * 1024

_TOKEN_PATTERN = re.compile(rf"^[0-9a-f]{{{STAGE_TOKEN_BYTES * 2}}}$")

_stage_lock = threading.Lock()
_active_stage_token: str | None = None


class BetaBootstrapError(RuntimeError):
    pass


class BetaBootstrapConflict(BetaBootstrapError):
    pass


class BetaBootstrapValidation(BetaBootstrapError):
    pass


@dataclass(frozen=True)
class StableInspection:
    exists: bool
    compatible: bool
    corrupt: bool
    too_new: bool
    unrecognized: bool
    path: Path
    instance_id: str | None
    schema_revision: str | None
    message: str | None


def marker_path(data_root: Path | None = None) -> Path:
    return (data_root or APP_DATA_DIR) / MARKER_NAME


def apply_failure_path(data_root: Path | None = None) -> Path:
    return (data_root or APP_DATA_DIR) / APPLY_FAILURE_NAME


def bootstrap_root(data_root: Path | None = None) -> Path:
    return (data_root or APP_DATA_DIR) / BOOTSTRAP_SUBDIR


def stable_library_root(home: Path | None = None) -> Path:
    return stable_default_data_root(home or Path.home())


def stable_database_path(home: Path | None = None) -> Path:
    return stable_library_root(home) / "cellxplorer.db"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def read_marker(data_root: Path | None = None) -> dict[str, Any] | None:
    path = marker_path(data_root)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BetaBootstrapValidation(
            "Beta setup metadata is corrupt. Remove beta-bootstrap.json or contact support."
        ) from error
    if payload.get("schemaVersion") != MARKER_SCHEMA_VERSION:
        raise BetaBootstrapValidation("Beta setup metadata uses an unsupported version.")
    decision = payload.get("decision")
    if decision not in {"copied", "empty", "current"}:
        raise BetaBootstrapValidation("Beta setup metadata is invalid.")
    app_version = payload.get("appVersion")
    if app_version is not None and not isinstance(app_version, str):
        raise BetaBootstrapValidation("Beta setup metadata is invalid.")
    install_instance_id = payload.get("installInstanceId")
    if install_instance_id is not None and not isinstance(install_instance_id, str):
        raise BetaBootstrapValidation("Beta setup metadata is invalid.")
    return payload


def read_apply_failure(data_root: Path | None = None) -> dict[str, Any] | None:
    """Read the apply-failure record the Tauri shell writes after a rolled-back activation.

    A malformed record must never block setup, so unreadable content is ignored.
    """
    path = apply_failure_path(data_root)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("Ignoring unreadable Beta bootstrap apply-failure record at %s", path)
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def write_marker(
    decision: str,
    *,
    source_database_instance_id: str | None = None,
    source_schema_revision: str | None = None,
    data_root: Path | None = None,
) -> dict[str, Any]:
    payload = {
        "schemaVersion": MARKER_SCHEMA_VERSION,
        "decision": decision,
        "appVersion": APP_VERSION,
        "installInstanceId": INSTALL_INSTANCE_ID,
        "completedAt": _utc_now_iso(),
        "sourceDatabaseInstanceId": source_database_instance_id,
        "sourceSchemaRevision": source_schema_revision,
    }
    _atomic_write_json(marker_path(data_root), payload)
    return payload


def _marker_acknowledges_current_install(marker: dict[str, Any] | None) -> bool:
    if marker is None:
        return False
    if INSTALL_INSTANCE_ID is not None:
        return marker.get("installInstanceId") == INSTALL_INSTANCE_ID
    # Development and legacy launchers do not have an NSIS installation
    # identity. Retain the previous per-version behavior in that environment.
    return marker.get("appVersion") == APP_VERSION


def imports_has_payload(import_dir: Path | None = None) -> bool:
    root = import_dir or IMPORT_DIR
    if not root.is_dir():
        return False
    for item in root.rglob("*"):
        if item.is_file():
            return True
    return False


def beta_is_pristine(db: Session, data_root: Path | None = None) -> bool:
    root = data_root or APP_DATA_DIR
    # The marker acknowledges a setup decision; it is not library content.
    # Keep this definition aligned with the Rust activation safety check.
    if imports_has_payload(root / "imports"):
        return False
    counts = [
        db.query(func.count(SourceFile.id)).scalar() or 0,
        db.query(func.count(Test.id)).scalar() or 0,
        db.query(func.count(Cell.id)).scalar() or 0,
        db.query(func.count(ReplicateGroup.id)).scalar() or 0,
        db.query(func.count(Folder.id)).scalar() or 0,
        db.query(func.count(Analysis.id)).scalar() or 0,
    ]
    return sum(counts) == 0


def _inspection(
    path: Path,
    *,
    exists: bool = True,
    compatible: bool = False,
    corrupt: bool = False,
    too_new: bool = False,
    unrecognized: bool = False,
    instance_id: str | None = None,
    schema_revision: str | None = None,
    message: str | None = None,
) -> StableInspection:
    return StableInspection(
        exists=exists,
        compatible=compatible,
        corrupt=corrupt,
        too_new=too_new,
        unrecognized=unrecognized,
        path=path,
        instance_id=instance_id,
        schema_revision=schema_revision,
        message=message,
    )


_UNRECOGNIZED_MESSAGE = (
    "The Stable library database is not recognized as a CellXplorer library."
)


def inspect_stable_database(home: Path | None = None) -> StableInspection:
    """Classify the Stable database read-only, using the same recognition rules as migration.

    This never migrates or otherwise writes to the Stable library; a database that would need a
    migration is copied as-is and migrated inside Beta after activation.
    """
    path = stable_database_path(home)
    if not path.is_file() or path.stat().st_size == 0:
        return _inspection(
            path,
            exists=False,
            message="No Stable library database was found.",
        )

    # Copy eligibility justifies the thorough scan; the launch path uses quick_check.
    try:
        integrity = _integrity_error(path, pragma="integrity_check")
    except OSError as error:
        return _inspection(
            path,
            corrupt=True,
            message=f"The Stable library database could not be read: {error}",
        )
    if integrity:
        return _inspection(
            path,
            corrupt=True,
            message=f"The Stable library database failed integrity checks: {integrity}",
        )

    try:
        tables = _existing_tables(path)
    except (OSError, sqlite3.DatabaseError):
        return _inspection(path, unrecognized=True, message=_UNRECOGNIZED_MESSAGE)

    revision, revision_error = _read_revision(path, tables)
    if revision_error:
        return _inspection(path, unrecognized=True, message=revision_error)

    if revision is not None and revision not in REVISION_BY_ID:
        if _is_future_revision(revision):
            return _inspection(
                path,
                too_new=True,
                schema_revision=revision,
                message="The Stable library uses a newer schema than this Beta build supports.",
            )
        return _inspection(
            path,
            unrecognized=True,
            schema_revision=revision,
            message=f"The Stable library uses unknown schema revision {revision}.",
        )

    if not tables:
        return _inspection(path, unrecognized=True, message=_UNRECOGNIZED_MESSAGE)

    if not _looks_like_legacy_cellxplorer(tables):
        expected = ", ".join(sorted(CORE_TABLES))
        return _inspection(
            path,
            unrecognized=True,
            schema_revision=revision,
            message=(
                "The Stable library database is missing expected CellXplorer tables "
                f"({expected})."
            ),
        )

    return _inspection(
        path,
        compatible=True,
        instance_id=_read_instance_id(path),
        schema_revision=revision,
    )


def _read_instance_id(db_path: Path) -> str | None:
    try:
        with closing(_connect_readonly(db_path)) as connection:
            row = connection.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (DATABASE_INSTANCE_ID_KEY,),
            ).fetchone()
    except sqlite3.DatabaseError:
        return None
    if not row or not row[0]:
        return None
    return str(row[0])


def _read_source_instance_id(stable_path: Path) -> str | None:
    return _read_instance_id(stable_path)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(COPY_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _remove_sqlite_sidecars(db_path: Path) -> None:
    """Drop `-wal`/`-shm`/`-journal` remnants so the stage holds only the files the apply expects."""
    for suffix in ("-wal", "-shm", "-journal"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)


def _path_is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _copy_import_streaming(
    source: Path,
    target: Path,
    expected_size: int | None,
    expected_hash: str | None,
) -> tuple[int, str]:
    """Copy one managed import in bounded chunks, verifying size and checksum before publishing.

    The bytes land in a sibling temporary file so a mismatch or interruption can never leave a
    partially written file inside the staged import tree that the apply step would accept.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    digest = hashlib.sha256()
    total = 0
    try:
        with source.open("rb") as reader, temp.open("wb") as writer:
            while True:
                chunk = reader.read(COPY_CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                total += len(chunk)
                writer.write(chunk)
        checksum = digest.hexdigest()
        if expected_size is not None and total != int(expected_size):
            raise BetaBootstrapValidation(f"Import size mismatch for {target.name}.")
        if expected_hash and checksum != str(expected_hash):
            raise BetaBootstrapValidation(f"Import checksum mismatch for {target.name}.")
        temp.replace(target)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return total, checksum


def _is_valid_token(token: str) -> bool:
    return bool(_TOKEN_PATTERN.fullmatch(token or ""))


def _read_lock_token() -> str | None:
    lock_path = bootstrap_root() / LOCK_NAME
    if not lock_path.is_file():
        return None
    try:
        token = lock_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token if _is_valid_token(token) else None


def _read_stage_manifest(stage_dir: Path) -> dict[str, Any] | None:
    """Return the manifest of a complete stage directory, or None when it is not usable."""
    manifest_path = stage_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        return None
    if payload.get("token") != stage_dir.name:
        return None
    if payload.get("stagedDatabase") != STAGED_DB_NAME:
        return None
    if not (stage_dir / STAGED_DB_NAME).is_file():
        return None
    if not isinstance(payload.get("stagedDatabaseSha256"), str):
        return None
    if not isinstance(payload.get("stagedDatabaseSize"), int):
        return None
    imports = payload.get("imports")
    if not isinstance(imports, list):
        return None
    if payload.get("copiedImports") != len(imports):
        return None
    return payload


def _stage_directories() -> list[Path]:
    root = bootstrap_root()
    if not root.is_dir():
        return []
    items = [item for item in root.iterdir() if item.is_dir() and _is_valid_token(item.name)]
    return sorted(items, key=lambda item: item.stat().st_mtime, reverse=True)


def find_outstanding_stage_token() -> str | None:
    """Newest stage directory that carries a complete manifest and can still be applied."""
    for item in _stage_directories():
        if _read_stage_manifest(item) is not None:
            return item.name
    return None


def _reconcile_active_stage_token() -> str | None:
    """Recover stage ownership from the lock file after a backend restart."""
    global _active_stage_token
    with _stage_lock:
        if _active_stage_token is not None:
            return _active_stage_token
        token = _read_lock_token()
        if token and _read_stage_manifest(bootstrap_root() / token) is not None:
            _active_stage_token = token
        return _active_stage_token


def _remove_stage_directory(stage_dir: Path) -> None:
    shutil.rmtree(stage_dir, ignore_errors=False)


def _cleanup_stale_staging(active_token: str | None = None) -> None:
    """Bound abandoned staging without discarding the newest retryable snapshot."""
    root = bootstrap_root()
    if not root.is_dir():
        return
    cutoff = datetime.now(timezone.utc).timestamp() - STAGE_RETENTION_HOURS * 3600
    candidates = [item for item in _stage_directories() if item.name != active_token]
    for index, item in enumerate(candidates):
        if index == 0:
            continue
        if item.stat().st_mtime >= cutoff:
            continue
        try:
            _remove_stage_directory(item)
        except OSError:
            logger.warning("Could not remove stale beta bootstrap stage %s", item)


def discard_stage(token: str) -> dict[str, Any]:
    """Delete a staged Stable copy the user chose not to apply."""
    global _active_stage_token
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    if not _is_valid_token(token):
        raise BetaBootstrapValidation("The staged copy token is invalid.")

    _reconcile_active_stage_token()
    known = {_active_stage_token, _read_lock_token(), find_outstanding_stage_token()}
    if token not in known:
        raise BetaBootstrapValidation("There is no staged Stable copy with that token to discard.")

    stage_dir = bootstrap_root() / token
    if not _path_is_under(stage_dir, bootstrap_root()):
        raise BetaBootstrapValidation("The staged copy token is invalid.")

    removed = False
    if stage_dir.is_dir():
        try:
            _remove_stage_directory(stage_dir)
        except OSError as error:
            raise BetaBootstrapError(f"The staged copy could not be removed: {error}") from error
        removed = True

    with _stage_lock:
        if _active_stage_token == token:
            _active_stage_token = None
        lock_path = bootstrap_root() / LOCK_NAME
        if lock_path.is_file():
            try:
                current = lock_path.read_text(encoding="utf-8").strip()
            except OSError:
                current = ""
            if current == token or not current:
                lock_path.unlink(missing_ok=True)

    return {"token": token, "removed": removed}


def build_status(db: Session) -> dict[str, Any]:
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")

    marker: dict[str, Any] | None = None
    decision: str | None = None
    setup_error: str | None = None
    try:
        marker = read_marker()
        if marker:
            decision = str(marker["decision"])
    except BetaBootstrapValidation as error:
        setup_error = str(error)

    apply_failure = read_apply_failure()
    apply_failure_message: str | None = None
    if apply_failure:
        raw_message = apply_failure.get("message")
        apply_failure_message = str(raw_message) if raw_message else "The staged copy could not be applied."

    pristine = beta_is_pristine(db) if setup_error is None else False
    stable = inspect_stable_database()
    acknowledged_for_install = _marker_acknowledges_current_install(marker)
    needs_choice = setup_error is None and not acknowledged_for_install

    copy_blocking: str | None = None
    if not stable.compatible:
        copy_blocking = stable.message or "The Stable library cannot be copied safely."

    outstanding = _reconcile_active_stage_token() or find_outstanding_stage_token()
    scientific_preparation = get_scientific_preparation_state(db)

    if setup_error:
        setup_state = "blocked-error"
    elif acknowledged_for_install:
        setup_state = "complete"
    elif needs_choice:
        setup_state = "choice-required"
    else:
        setup_state = "complete"

    return {
        "channel": "beta",
        "setupState": setup_state,
        "decision": decision,
        "needsChoice": needs_choice,
        "betaPristine": pristine,
        "betaHasExistingLibrary": not pristine,
        "acknowledgedAppVersion": marker.get("appVersion") if marker else None,
        "acknowledgedInstallInstanceId": (
            marker.get("installInstanceId") if marker else None
        ),
        "stableDatabaseExists": stable.exists,
        "stableDatabaseCompatible": stable.compatible,
        "stableDatabasePath": str(stable.path),
        "copyBlockingReason": copy_blocking,
        "setupError": setup_error,
        "blockingReason": setup_error or (copy_blocking if needs_choice else None),
        "outstandingStageToken": outstanding,
        "applyFailureMessage": apply_failure_message,
        "scientificPreparation": scientific_preparation,
        "scientificPreparationPending": scientific_preparation_is_pending(
            scientific_preparation
        ),
    }


def start_empty_library(db: Session) -> dict[str, Any]:
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    if _marker_acknowledges_current_install(read_marker()):
        raise BetaBootstrapConflict("Beta setup has already completed.")
    if not beta_is_pristine(db):
        raise BetaBootstrapConflict("Beta already contains library data and cannot be reset from here.")
    payload = write_marker("empty")
    return {"decision": payload["decision"], "restartRequired": False}


def use_current_library(db: Session) -> dict[str, Any]:
    """Keep the current Beta library and acknowledge this installation."""
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")

    marker = read_marker()
    pristine = beta_is_pristine(db)
    decision = str(marker["decision"]) if marker else ("empty" if pristine else "current")
    payload = write_marker(
        decision,
        source_database_instance_id=(
            marker.get("sourceDatabaseInstanceId") if marker else None
        ),
        source_schema_revision=marker.get("sourceSchemaRevision") if marker else None,
    )
    return {"decision": payload["decision"], "restartRequired": False}


def stage_stable_copy(
    db: Session,
    *,
    confirm_replace_existing_beta: bool = False,
) -> dict[str, Any]:
    global _active_stage_token
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    marker = read_marker()
    if _marker_acknowledges_current_install(marker):
        raise BetaBootstrapConflict("Beta setup has already been completed for this installation.")
    replace_existing_beta = not beta_is_pristine(db)
    if replace_existing_beta and not confirm_replace_existing_beta:
        raise BetaBootstrapConflict(
            "Confirm that copying Stable may replace the current Beta library."
        )

    _reconcile_active_stage_token()
    if find_outstanding_stage_token() is not None:
        raise BetaBootstrapConflict(
            "A Stable library copy is already staged. Retry activation or discard it."
        )

    stable = inspect_stable_database()
    if not stable.exists or not stable.compatible:
        raise BetaBootstrapValidation(stable.message or "The Stable library cannot be copied.")

    home = Path.home()
    stable_root = stable_library_root(home)
    stable_imports = stable_root / "imports"
    beta_imports = APP_DATA_DIR / "imports"

    with _stage_lock:
        if _active_stage_token is not None:
            raise BetaBootstrapConflict("A Stable library copy is already in progress.")
        token = secrets.token_hex(STAGE_TOKEN_BYTES)
        stage_dir = bootstrap_root() / token
        stage_dir.mkdir(parents=True, exist_ok=False)
        lock_path = bootstrap_root() / LOCK_NAME
        lock_path.write_text(token + "\n", encoding="utf-8")
        _active_stage_token = token

    staged_db = stage_dir / STAGED_DB_NAME
    stage_imports = stage_dir / "imports"
    external_paths = 0
    inventory: dict[str, dict[str, Any]] = {}

    try:
        stable_hash_before = _sha256_file(stable.path)
        stable_mtime_ns_before = stable.path.stat().st_mtime_ns

        with closing(_connect_readonly(stable.path)) as source:
            with closing(sqlite3.connect(staged_db)) as destination:
                source.backup(destination)

        integrity = _integrity_error(staged_db, pragma="integrity_check")
        if integrity:
            raise BetaBootstrapError("The staged copy failed integrity checks.")

        source_instance_id = _read_source_instance_id(stable.path)
        source_revision = stable.schema_revision

        with closing(sqlite3.connect(staged_db)) as connection:
            new_instance_id = str(uuid4())
            now = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
            connection.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (DATABASE_INSTANCE_ID_KEY, new_instance_id, now),
            )
            connection.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (
                    SCIENTIFIC_PREPARATION_KEY,
                    scientific_preparation_pending_value(),
                    now,
                ),
            )
            rows = connection.execute("SELECT id, path, hash, size FROM source_files").fetchall()
            for row_id, raw_path, file_hash, file_size in rows:
                source_path = Path(str(raw_path))
                if not _path_is_under(source_path, stable_imports):
                    external_paths += 1
                    continue
                relative = source_path.resolve().relative_to(stable_imports.resolve())
                key = relative.as_posix()
                if not source_path.is_file():
                    raise BetaBootstrapValidation(
                        f"A managed import is missing from the Stable library: {key}"
                    )
                if key not in inventory:
                    size, checksum = _copy_import_streaming(
                        source_path,
                        stage_imports / relative,
                        int(file_size) if file_size is not None else None,
                        str(file_hash) if file_hash else None,
                    )
                    inventory[key] = {
                        "relativePath": key,
                        "size": size,
                        "sha256": checksum,
                    }
                rewritten = (beta_imports / relative).resolve()
                connection.execute(
                    "UPDATE source_files SET path = ? WHERE id = ?",
                    (str(rewritten), row_id),
                )
            connection.commit()
            # The apply step rejects unexpected staged content, so hand over a single plain
            # database file; Beta re-enables WAL when it opens the activated library.
            connection.execute("PRAGMA journal_mode=DELETE")
        _remove_sqlite_sidecars(staged_db)

        if _sha256_file(stable.path) != stable_hash_before:
            raise BetaBootstrapError("The Stable library changed during copying.")
        if stable.path.stat().st_mtime_ns != stable_mtime_ns_before:
            raise BetaBootstrapError("The Stable library changed during copying.")

        # The digest must describe the final staged file, so take it after the instance-UUID and
        # import-path rewrites have been committed.
        staged_entries = list(inventory.values())
        manifest = {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "token": token,
            "sourceDatabaseInstanceId": source_instance_id,
            "sourceSchemaRevision": source_revision,
            "stagedDatabase": STAGED_DB_NAME,
            "stagedDatabaseSha256": _sha256_file(staged_db),
            "stagedDatabaseSize": staged_db.stat().st_size,
            "copiedImports": len(staged_entries),
            "imports": staged_entries,
            "externalSourcePaths": external_paths,
            "replaceExistingBeta": replace_existing_beta,
            "createdAt": _utc_now_iso(),
        }
        _atomic_write_json(stage_dir / MANIFEST_NAME, manifest)

        return {
            "token": token,
            "sourceDatabaseInstanceId": source_instance_id,
            "sourceSchemaRevision": source_revision,
            "copiedImports": len(staged_entries),
            "externalSourcePaths": external_paths,
            "replaceExistingBeta": replace_existing_beta,
            "restartRequired": True,
        }
    except Exception:
        with _stage_lock:
            _active_stage_token = None
            lock_path = bootstrap_root() / LOCK_NAME
            lock_path.unlink(missing_ok=True)
        raise
    finally:
        _cleanup_stale_staging(active_token=token)


def clear_stage_lock(token: str) -> None:
    global _active_stage_token
    with _stage_lock:
        if _active_stage_token == token:
            _active_stage_token = None
        lock_path = bootstrap_root() / LOCK_NAME
        if lock_path.is_file() and lock_path.read_text(encoding="utf-8").strip() == token:
            lock_path.unlink(missing_ok=True)
