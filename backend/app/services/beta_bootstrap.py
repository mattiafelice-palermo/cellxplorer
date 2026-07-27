"""Beta first-run library copy from Stable (Spec 022)."""

from __future__ import annotations

from uuid import uuid4
import hashlib
import json
import logging
import secrets
import sqlite3
import threading
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import APP_DATA_DIR, IMPORT_DIR
from ..models import Analysis, Cell, Folder, ReplicateGroup, SourceFile, Test
from ..services.app_channel import resolve_app_channel, stable_default_data_root
from ..services.database_identity import DATABASE_INSTANCE_ID_KEY
from ..services.database_migrations import (
    _connect_readonly,
    _existing_tables,
    _integrity_error,
    _is_future_revision,
    _read_revision,
)

logger = logging.getLogger(__name__)

MARKER_NAME = "beta-bootstrap.json"
BOOTSTRAP_SUBDIR = "bootstrap"
MANIFEST_NAME = "manifest.json"
STAGED_DB_NAME = "staged-cellxplorer.db"
LOCK_NAME = ".stage-copy.lock"
MARKER_SCHEMA_VERSION = 1
MANIFEST_SCHEMA_VERSION = 1
STAGE_TOKEN_BYTES = 16
STAGE_RETENTION_HOURS = 24

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
    if decision not in {"copied", "empty"}:
        raise BetaBootstrapValidation("Beta setup metadata is invalid.")
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
        "completedAt": _utc_now_iso(),
        "sourceDatabaseInstanceId": source_database_instance_id,
        "sourceSchemaRevision": source_schema_revision,
    }
    _atomic_write_json(marker_path(data_root), payload)
    return payload


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
    if marker_path(root).exists():
        return False
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


def inspect_stable_database(home: Path | None = None) -> StableInspection:
    path = stable_database_path(home)
    if not path.is_file() or path.stat().st_size == 0:
        return StableInspection(
            exists=False,
            compatible=False,
            corrupt=False,
            too_new=False,
            unrecognized=False,
            path=path,
            instance_id=None,
            schema_revision=None,
            message="No Stable library database was found.",
        )

    integrity = _integrity_error(path)
    if integrity:
        return StableInspection(
            exists=True,
            compatible=False,
            corrupt=True,
            too_new=False,
            unrecognized=False,
            path=path,
            instance_id=None,
            schema_revision=None,
            message="The Stable library database failed integrity checks.",
        )

    tables = _existing_tables(path)
    if not tables:
        return StableInspection(
            exists=True,
            compatible=False,
            corrupt=False,
            too_new=False,
            unrecognized=True,
            path=path,
            instance_id=None,
            schema_revision=None,
            message="The Stable library database is not recognized.",
        )

    revision, revision_error = _read_revision(path, tables)
    if revision_error:
        return StableInspection(
            exists=True,
            compatible=False,
            corrupt=False,
            too_new=False,
            unrecognized=True,
            path=path,
            instance_id=None,
            schema_revision=revision,
            message=revision_error,
        )

    if revision and _is_future_revision(revision):
        return StableInspection(
            exists=True,
            compatible=False,
            corrupt=False,
            too_new=True,
            unrecognized=False,
            path=path,
            instance_id=None,
            schema_revision=revision,
            message="The Stable library uses a newer schema than this Beta build supports.",
        )

    instance_id = _read_instance_id(path)
    return StableInspection(
        exists=True,
        compatible=True,
        corrupt=False,
        too_new=False,
        unrecognized=False,
        path=path,
        instance_id=instance_id,
        schema_revision=revision,
        message=None,
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
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _path_is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _cleanup_stale_staging(active_token: str | None = None) -> None:
    root = bootstrap_root()
    if not root.is_dir():
        return
    cutoff = datetime.now(timezone.utc).timestamp() - STAGE_RETENTION_HOURS * 3600
    candidates = sorted(
        (item for item in root.iterdir() if item.is_dir()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for index, item in enumerate(candidates):
        if active_token and item.name == active_token:
            continue
        if index == 0:
            continue
        if item.stat().st_mtime >= cutoff:
            continue
        if (item / MANIFEST_NAME).is_file():
            continue
        try:
            for child in sorted(item.rglob("*"), reverse=True):
                if child.is_file():
                    child.unlink(missing_ok=True)
                elif child.is_dir():
                    child.rmdir()
            item.rmdir()
        except OSError:
            logger.warning("Could not remove stale beta bootstrap stage %s", item)


def build_status(db: Session) -> dict[str, Any]:
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")

    decision: str | None = None
    blocking_reason: str | None = None
    try:
        marker = read_marker()
        if marker:
            decision = str(marker["decision"])
    except BetaBootstrapValidation as error:
        blocking_reason = str(error)

    pristine = beta_is_pristine(db) if blocking_reason is None else False
    stable = inspect_stable_database()
    needs_choice = blocking_reason is None and decision is None and pristine

    copy_blocking: str | None = None
    if not stable.compatible:
        copy_blocking = stable.message or "The Stable library cannot be copied safely."

    return {
        "channel": "beta",
        "decision": decision,
        "needsChoice": needs_choice,
        "betaPristine": pristine,
        "stableDatabaseExists": stable.exists,
        "stableDatabaseCompatible": stable.compatible,
        "stableDatabasePath": str(stable.path),
        "blockingReason": blocking_reason or (copy_blocking if needs_choice else None),
    }


def start_empty_library(db: Session) -> dict[str, Any]:
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    if read_marker() is not None:
        raise BetaBootstrapConflict("Beta setup has already completed.")
    if not beta_is_pristine(db):
        raise BetaBootstrapConflict("Beta already contains library data and cannot be reset from here.")
    payload = write_marker("empty")
    return {"decision": payload["decision"], "restartRequired": False}


def stage_stable_copy(db: Session) -> dict[str, Any]:
    global _active_stage_token
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    if read_marker() is not None:
        raise BetaBootstrapConflict("Beta setup has already completed.")
    if not beta_is_pristine(db):
        raise BetaBootstrapConflict("Beta already contains library data.")

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
    copied_imports = 0

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
            rows = connection.execute("SELECT id, path, hash, size FROM source_files").fetchall()
            for row_id, raw_path, file_hash, file_size in rows:
                source_path = Path(str(raw_path))
                if _path_is_under(source_path, stable_imports):
                    relative = source_path.resolve().relative_to(stable_imports.resolve())
                    target = stage_imports / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if not source_path.is_file():
                        raise BetaBootstrapValidation(
                            f"A managed import is missing from the Stable library: {relative}"
                        )
                    data = source_path.read_bytes()
                    if file_size is not None and len(data) != int(file_size):
                        raise BetaBootstrapValidation(
                            f"Import size mismatch for {relative.name}."
                        )
                    if file_hash:
                        digest = hashlib.sha256(data).hexdigest()
                        if digest != str(file_hash):
                            raise BetaBootstrapValidation(
                                f"Import checksum mismatch for {relative.name}."
                            )
                    target.write_bytes(data)
                    rewritten = (beta_imports / relative).resolve()
                    connection.execute(
                        "UPDATE source_files SET path = ? WHERE id = ?",
                        (str(rewritten), row_id),
                    )
                    copied_imports += 1
                else:
                    external_paths += 1
            connection.commit()

        if _sha256_file(stable.path) != stable_hash_before:
            raise BetaBootstrapError("The Stable library changed during copying.")
        if stable.path.stat().st_mtime_ns != stable_mtime_ns_before:
            raise BetaBootstrapError("The Stable library changed during copying.")

        manifest = {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "token": token,
            "sourceDatabaseInstanceId": source_instance_id,
            "sourceSchemaRevision": source_revision,
            "stagedDatabase": STAGED_DB_NAME,
            "copiedImports": copied_imports,
            "externalSourcePaths": external_paths,
            "createdAt": _utc_now_iso(),
        }
        _atomic_write_json(stage_dir / MANIFEST_NAME, manifest)

        return {
            "token": token,
            "sourceDatabaseInstanceId": source_instance_id,
            "sourceSchemaRevision": source_revision,
            "copiedImports": copied_imports,
            "externalSourcePaths": external_paths,
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
