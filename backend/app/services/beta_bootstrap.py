"""Shared first-run library bootstrap for the Beta and Alpha channels.

The historical module name is retained because Beta's released bootstrap API imports it.  The
implementation below is destination- and source-channel aware; the Beta-named functions at the
bottom remain compatibility wrappers for the Spec 022 contract.
"""

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
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import APP_DATA_DIR, APP_VERSION, IMPORT_DIR, INSTALL_INSTANCE_ID
from ..models import Analysis, Cell, Folder, ReplicateGroup, SourceFile, Test
from ..services.app_channel import (
    alpha_default_data_root,
    beta_default_data_root,
    resolve_app_channel,
    stable_default_data_root,
)
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
ALPHA_MARKER_NAME = "alpha-bootstrap.json"
ALPHA_APPLY_FAILURE_NAME = "alpha-bootstrap-apply-error.json"
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


@dataclass(frozen=True)
class BootstrapDestination:
    channel: Literal["beta", "alpha"]
    product_name: str
    marker_name: str
    apply_failure_name: str
    decisions: frozenset[str]
    copied_decision: str
    source_channels: frozenset[str]
    replacement_field: str


BETA_DESTINATION = BootstrapDestination(
    channel="beta",
    product_name="CellXplorer Beta",
    marker_name=MARKER_NAME,
    apply_failure_name=APPLY_FAILURE_NAME,
    decisions=frozenset({"copied", "empty", "current"}),
    copied_decision="copied",
    source_channels=frozenset({"stable"}),
    replacement_field="replaceExistingBeta",
)
ALPHA_DESTINATION = BootstrapDestination(
    channel="alpha",
    product_name="CellXplorer Alpha",
    marker_name=ALPHA_MARKER_NAME,
    apply_failure_name=ALPHA_APPLY_FAILURE_NAME,
    decisions=frozenset({"empty", "copied-stable", "copied-beta", "current"}),
    copied_decision="copied-stable",
    source_channels=frozenset({"stable", "beta"}),
    replacement_field="replaceExistingAlpha",
)


def _destination(channel: str) -> BootstrapDestination:
    if channel == "beta":
        return BETA_DESTINATION
    if channel == "alpha":
        return ALPHA_DESTINATION
    raise BetaBootstrapValidation(f"Bootstrap is not available for the {channel} channel.")


def _source_product_name(channel: str) -> str:
    return {
        "stable": "CellXplorer",
        "beta": "CellXplorer Beta",
        "alpha": "CellXplorer Alpha",
    }.get(channel, f"CellXplorer {channel.title()}")


def _create_source_snapshot(
    source_database: Path,
    destination_root: Path,
) -> tuple[Path, Path | None]:
    """Make a private SQLite input when source sidecars are present.

    SQLite may update WAL shared-memory read marks merely by opening a live database.  Copying
    the database and any existing sidecars first keeps the source product read-only while still
    allowing the normal SQLite backup API to observe a live WAL snapshot.
    """
    sidecars = [
        Path(f"{source_database}-wal"),
        Path(f"{source_database}-shm"),
        Path(f"{source_database}-journal"),
    ]
    present_sidecars = [item for item in sidecars if item.is_file()]
    if not present_sidecars:
        return source_database, None

    snapshot_root = (
        destination_root
        / BOOTSTRAP_SUBDIR
        / f".source-snapshot-{secrets.token_hex(STAGE_TOKEN_BYTES)}"
    )
    snapshot_root.mkdir(parents=True, exist_ok=False)
    try:
        snapshot_database = snapshot_root / source_database.name
        shutil.copy2(source_database, snapshot_database)
        for sidecar in present_sidecars:
            shutil.copy2(sidecar, Path(f"{snapshot_database}{sidecar.name[len(source_database.name):]}"))
        return snapshot_database, snapshot_root
    except BaseException:
        shutil.rmtree(snapshot_root, ignore_errors=True)
        raise


def _remove_source_snapshot(snapshot_root: Path | None) -> None:
    if snapshot_root is not None:
        shutil.rmtree(snapshot_root, ignore_errors=True)


class BetaBootstrapError(RuntimeError):
    pass


class BetaBootstrapConflict(BetaBootstrapError):
    pass


class BetaBootstrapValidation(BetaBootstrapError):
    pass


@dataclass(frozen=True)
class SourceInspection:
    channel: str
    exists: bool
    compatible: bool
    corrupt: bool
    too_new: bool
    unrecognized: bool
    path: Path
    instance_id: str | None
    schema_revision: str | None
    message: str | None


# Kept as an alias so existing Beta callers and focused tests retain their public type name.
StableInspection = SourceInspection


def _marker_path_for(destination: BootstrapDestination, data_root: Path | None = None) -> Path:
    return (data_root or APP_DATA_DIR) / destination.marker_name


def _apply_failure_path_for(
    destination: BootstrapDestination,
    data_root: Path | None = None,
) -> Path:
    return (data_root or APP_DATA_DIR) / destination.apply_failure_name


def _bootstrap_root_for(data_root: Path | None = None) -> Path:
    return (data_root or APP_DATA_DIR) / BOOTSTRAP_SUBDIR


def marker_path(data_root: Path | None = None) -> Path:
    return _marker_path_for(BETA_DESTINATION, data_root)


def apply_failure_path(data_root: Path | None = None) -> Path:
    return _apply_failure_path_for(BETA_DESTINATION, data_root)


def bootstrap_root(data_root: Path | None = None) -> Path:
    return _bootstrap_root_for(data_root)


def alpha_marker_path(data_root: Path | None = None) -> Path:
    return _marker_path_for(ALPHA_DESTINATION, data_root)


def alpha_apply_failure_path(data_root: Path | None = None) -> Path:
    return _apply_failure_path_for(ALPHA_DESTINATION, data_root)


def alpha_bootstrap_root(data_root: Path | None = None) -> Path:
    return _bootstrap_root_for(data_root)


def stable_library_root(home: Path | None = None) -> Path:
    return stable_default_data_root(home or Path.home())


def beta_library_root(home: Path | None = None) -> Path:
    return beta_default_data_root(home or Path.home())


def alpha_library_root(home: Path | None = None) -> Path:
    return alpha_default_data_root(home or Path.home())


def stable_database_path(home: Path | None = None) -> Path:
    return stable_library_root(home) / "cellxplorer.db"


def source_library_root(source: str, home: Path | None = None) -> Path:
    if source == "stable":
        return stable_library_root(home)
    if source == "beta":
        return beta_library_root(home)
    raise BetaBootstrapValidation("Alpha cannot copy from that source channel.")


def source_database_path(source: str, home: Path | None = None) -> Path:
    return source_library_root(source, home) / "cellxplorer.db"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def _read_marker_for(
    destination: BootstrapDestination,
    data_root: Path | None = None,
) -> dict[str, Any] | None:
    path = _marker_path_for(destination, data_root)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BetaBootstrapValidation(
            f"{destination.product_name} setup metadata is corrupt. "
            f"Remove {destination.marker_name} or contact support."
        ) from error
    if not isinstance(payload, dict):
        raise BetaBootstrapValidation(f"{destination.product_name} setup metadata is invalid.")
    if payload.get("schemaVersion") != MARKER_SCHEMA_VERSION:
        raise BetaBootstrapValidation(
            f"{destination.product_name} setup metadata uses an unsupported version."
        )
    decision = payload.get("decision")
    if decision not in destination.decisions:
        raise BetaBootstrapValidation(f"{destination.product_name} setup metadata is invalid.")
    app_version = payload.get("appVersion")
    if app_version is not None and not isinstance(app_version, str):
        raise BetaBootstrapValidation(f"{destination.product_name} setup metadata is invalid.")
    install_instance_id = payload.get("installInstanceId")
    if install_instance_id is not None and not isinstance(install_instance_id, str):
        raise BetaBootstrapValidation(f"{destination.product_name} setup metadata is invalid.")
    if destination.channel == "alpha" and decision in {"copied-stable", "copied-beta"}:
        if payload.get("sourceChannel") not in destination.source_channels:
            raise BetaBootstrapValidation(
                "CellXplorer Alpha setup metadata is missing a valid source channel."
            )
    return payload


def read_marker(data_root: Path | None = None) -> dict[str, Any] | None:
    return _read_marker_for(BETA_DESTINATION, data_root)


def read_alpha_marker(data_root: Path | None = None) -> dict[str, Any] | None:
    return _read_marker_for(ALPHA_DESTINATION, data_root)


def read_apply_failure(data_root: Path | None = None) -> dict[str, Any] | None:
    """Read the apply-failure record the Tauri shell writes after a rolled-back activation.

    A malformed record must never block setup, so unreadable content is ignored.
    """
    path = _apply_failure_path_for(BETA_DESTINATION, data_root)
    return _read_apply_failure_for(BETA_DESTINATION, path)


def _read_apply_failure_for(
    destination: BootstrapDestination,
    path: Path,
) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning(
            "Ignoring unreadable %s bootstrap apply-failure record at %s",
            destination.product_name,
            path,
        )
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def read_alpha_apply_failure(data_root: Path | None = None) -> dict[str, Any] | None:
    return _read_apply_failure_for(
        ALPHA_DESTINATION,
        _apply_failure_path_for(ALPHA_DESTINATION, data_root),
    )


def write_marker(
    decision: str,
    *,
    source_database_instance_id: str | None = None,
    source_schema_revision: str | None = None,
    data_root: Path | None = None,
) -> dict[str, Any]:
    return _write_marker_for(
        BETA_DESTINATION,
        decision,
        source_database_instance_id=source_database_instance_id,
        source_schema_revision=source_schema_revision,
        data_root=data_root,
    )


def _write_marker_for(
    destination: BootstrapDestination,
    decision: str,
    *,
    source_channel: str | None = None,
    source_database_instance_id: str | None = None,
    source_schema_revision: str | None = None,
    data_root: Path | None = None,
) -> dict[str, Any]:
    if decision not in destination.decisions:
        raise BetaBootstrapValidation(f"{destination.product_name} setup decision is invalid.")
    if destination.channel == "alpha" and decision in {"copied-stable", "copied-beta"}:
        if source_channel not in destination.source_channels:
            raise BetaBootstrapValidation("CellXplorer Alpha requires a valid copy source.")
    payload = {
        "schemaVersion": MARKER_SCHEMA_VERSION,
        "decision": decision,
        "appVersion": APP_VERSION,
        "installInstanceId": INSTALL_INSTANCE_ID,
        "completedAt": _utc_now_iso(),
        "sourceDatabaseInstanceId": source_database_instance_id,
        "sourceSchemaRevision": source_schema_revision,
    }
    if destination.channel == "alpha" and decision in {"copied-stable", "copied-beta"}:
        payload["sourceChannel"] = source_channel
    _atomic_write_json(_marker_path_for(destination, data_root), payload)
    return payload


def write_alpha_marker(
    decision: str,
    *,
    source_channel: str | None = None,
    source_database_instance_id: str | None = None,
    source_schema_revision: str | None = None,
    data_root: Path | None = None,
) -> dict[str, Any]:
    return _write_marker_for(
        ALPHA_DESTINATION,
        decision,
        source_channel=source_channel,
        source_database_instance_id=source_database_instance_id,
        source_schema_revision=source_schema_revision,
        data_root=data_root,
    )


def _marker_acknowledges_current_install(marker: dict[str, Any] | None) -> bool:
    return _marker_acknowledges_for(BETA_DESTINATION, marker)


def _marker_acknowledges_for(
    _destination: BootstrapDestination,
    marker: dict[str, Any] | None,
) -> bool:
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


def _library_is_pristine(
    db: Session,
    data_root: Path,
    product_name: str,
) -> bool:
    # The marker acknowledges a setup decision; it is not library content.
    # Keep this definition aligned with the Rust activation safety check.
    if imports_has_payload(data_root / "imports"):
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


def beta_is_pristine(db: Session, data_root: Path | None = None) -> bool:
    return _library_is_pristine(db, data_root or APP_DATA_DIR, "CellXplorer Beta")


def alpha_is_pristine(db: Session, data_root: Path | None = None) -> bool:
    return _library_is_pristine(db, data_root or APP_DATA_DIR, "CellXplorer Alpha")


def _inspection(
    path: Path,
    *,
    channel: str = "stable",
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
        channel=channel,
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


def _inspect_database_direct(
    path: Path,
    *,
    source_channel: str,
    destination_product_name: str,
) -> SourceInspection:
    source_product_name = _source_product_name(source_channel)
    source_label = (
        ("Stable" if source_channel == "stable" else "Beta")
        if destination_product_name == "CellXplorer Beta"
        else source_product_name
    )
    unrecognized_message = (
        f"The {source_product_name} library database is not recognized as a CellXplorer library."
    )
    if source_channel == "stable":
        # Preserve the released Beta-facing message for the Stable wrapper.
        unrecognized_message = _UNRECOGNIZED_MESSAGE
    if not path.is_file() or path.stat().st_size == 0:
        return _inspection(
            path,
            channel=source_channel,
            exists=False,
            message=f"No {source_label} library database was found.",
        )

    try:
        integrity = _integrity_error(path, pragma="integrity_check")
    except OSError as error:
        return _inspection(
            path,
            channel=source_channel,
            corrupt=True,
            message=f"The {source_label} library database could not be read: {error}",
        )
    if integrity:
        return _inspection(
            path,
            channel=source_channel,
            corrupt=True,
            message=f"The {source_label} library database failed integrity checks: {integrity}",
        )

    try:
        tables = _existing_tables(path)
    except (OSError, sqlite3.DatabaseError):
        return _inspection(path, channel=source_channel, unrecognized=True, message=unrecognized_message)

    revision, revision_error = _read_revision(path, tables)
    if revision_error:
        return _inspection(path, channel=source_channel, unrecognized=True, message=revision_error)

    if revision is not None and revision not in REVISION_BY_ID:
        if _is_future_revision(revision):
            return _inspection(
                path,
                channel=source_channel,
                too_new=True,
                schema_revision=revision,
                message=(
                    f"The {source_label} library uses a newer schema than this "
                    f"{destination_product_name} build supports."
                ),
            )
        return _inspection(
            path,
            channel=source_channel,
            unrecognized=True,
            schema_revision=revision,
            message=f"The {source_label} library uses unknown schema revision {revision}.",
        )

    if not tables:
        return _inspection(path, channel=source_channel, unrecognized=True, message=unrecognized_message)

    if not _looks_like_legacy_cellxplorer(tables):
        expected = ", ".join(sorted(CORE_TABLES))
        return _inspection(
            path,
            channel=source_channel,
            unrecognized=True,
            schema_revision=revision,
            message=(
                f"The {source_label} library database is missing expected CellXplorer tables "
                f"({expected})."
            ),
        )

    return _inspection(
        path,
        channel=source_channel,
        compatible=True,
        instance_id=_read_instance_id(path),
        schema_revision=revision,
    )


def _inspect_database(
    path: Path,
    *,
    source_channel: str,
    destination_product_name: str,
    destination_root: Path | None = None,
) -> SourceInspection:
    if destination_root is None:
        return _inspect_database_direct(
            path,
            source_channel=source_channel,
            destination_product_name=destination_product_name,
        )
    snapshot_path, snapshot_root = _create_source_snapshot(path, destination_root)
    try:
        result = _inspect_database_direct(
            snapshot_path,
            source_channel=source_channel,
            destination_product_name=destination_product_name,
        )
        return replace(result, path=path)
    finally:
        _remove_source_snapshot(snapshot_root)


def inspect_stable_database(home: Path | None = None) -> StableInspection:
    """Classify the Stable database read-only, using the same recognition rules as migration.

    This never migrates or otherwise writes to the Stable library; a database that would need a
    migration is copied as-is and migrated inside Beta after activation.
    """
    return _inspect_database(
        stable_database_path(home),
        source_channel="stable",
        destination_product_name="CellXplorer Beta",
        destination_root=APP_DATA_DIR,
    )


def inspect_source_database(
    source: str,
    *,
    home: Path | None = None,
    destination_channel: Literal["beta", "alpha"] = "alpha",
    destination_root: Path | None = None,
) -> SourceInspection:
    if source not in {"stable", "beta"}:
        raise BetaBootstrapValidation("Alpha can copy only from Stable or Beta.")
    destination = _destination(destination_channel)
    return _inspect_database(
        source_database_path(source, home),
        source_channel=source,
        destination_product_name=destination.product_name,
        destination_root=destination_root or APP_DATA_DIR,
    )


def inspect_beta_database(home: Path | None = None) -> SourceInspection:
    return inspect_source_database(source="beta", home=home, destination_channel="alpha")


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


def _source_identity(path: Path) -> tuple[str, int, dict[str, tuple[str, int]]]:
    sidecars: dict[str, tuple[str, int]] = {}
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(f"{path}{suffix}")
        if sidecar.is_file():
            sidecars[suffix] = (_sha256_file(sidecar), sidecar.stat().st_mtime_ns)
    return _sha256_file(path), path.stat().st_mtime_ns, sidecars


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


def _read_lock_token_for(data_root: Path) -> str | None:
    lock_path = _bootstrap_root_for(data_root) / LOCK_NAME
    if not lock_path.is_file():
        return None
    try:
        token = lock_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token if _is_valid_token(token) else None


def _read_lock_token() -> str | None:
    return _read_lock_token_for(APP_DATA_DIR)


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


def _stage_directories(data_root: Path | None = None) -> list[Path]:
    root = _bootstrap_root_for(data_root)
    if not root.is_dir():
        return []
    items = [item for item in root.iterdir() if item.is_dir() and _is_valid_token(item.name)]
    return sorted(items, key=lambda item: item.stat().st_mtime, reverse=True)


def find_outstanding_stage_token(data_root: Path | None = None) -> str | None:
    """Newest stage directory that carries a complete manifest and can still be applied."""
    for item in _stage_directories(data_root):
        if _read_stage_manifest(item) is not None:
            return item.name
    return None


def _reconcile_active_stage_token(data_root: Path | None = None) -> str | None:
    """Recover stage ownership from the lock file after a backend restart."""
    global _active_stage_token
    with _stage_lock:
        if _active_stage_token is not None:
            return _active_stage_token
        token = _read_lock_token_for(data_root or APP_DATA_DIR)
        if token and _read_stage_manifest(_bootstrap_root_for(data_root) / token) is not None:
            _active_stage_token = token
        return _active_stage_token


def _remove_stage_directory(stage_dir: Path) -> None:
    shutil.rmtree(stage_dir, ignore_errors=False)


def _cleanup_stale_staging(
    active_token: str | None = None,
    *,
    data_root: Path | None = None,
    product_name: str = "CellXplorer Beta",
) -> None:
    """Bound abandoned staging without discarding the newest retryable snapshot."""
    root = _bootstrap_root_for(data_root)
    if not root.is_dir():
        return
    cutoff = datetime.now(timezone.utc).timestamp() - STAGE_RETENTION_HOURS * 3600
    candidates = [item for item in _stage_directories(data_root) if item.name != active_token]
    for index, item in enumerate(candidates):
        if index == 0:
            continue
        if item.stat().st_mtime >= cutoff:
            continue
        try:
            _remove_stage_directory(item)
        except OSError:
            logger.warning("Could not remove stale %s bootstrap stage %s", product_name, item)


def _discard_stage_for(
    token: str,
    destination: BootstrapDestination,
    data_root: Path,
) -> dict[str, Any]:
    """Delete a staged copy for one destination without touching another channel's root."""
    global _active_stage_token
    if not _is_valid_token(token):
        raise BetaBootstrapValidation("The staged copy token is invalid.")

    _reconcile_active_stage_token(data_root)
    known = {
        _active_stage_token,
        _read_lock_token_for(data_root),
        find_outstanding_stage_token(data_root),
    }
    if token not in known:
        source_label = "Stable" if destination.channel == "beta" else "library"
        raise BetaBootstrapValidation(
            f"There is no staged {source_label} copy with that token to discard."
        )

    root = _bootstrap_root_for(data_root)
    stage_dir = root / token
    if not _path_is_under(stage_dir, root):
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
        lock_path = root / LOCK_NAME
        if lock_path.is_file():
            try:
                current = lock_path.read_text(encoding="utf-8").strip()
            except OSError:
                current = ""
            if current == token or not current:
                lock_path.unlink(missing_ok=True)

    return {"token": token, "removed": removed}


def discard_stage(token: str) -> dict[str, Any]:
    """Beta compatibility wrapper for discarding a staged Stable copy."""
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    return _discard_stage_for(token, BETA_DESTINATION, APP_DATA_DIR)


def discard_alpha_stage(token: str, data_root: Path | None = None) -> dict[str, Any]:
    if resolve_app_channel() != "alpha":
        raise BetaBootstrapValidation("Alpha bootstrap is only available in the Alpha channel.")
    return _discard_stage_for(token, ALPHA_DESTINATION, data_root or APP_DATA_DIR)


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


def _source_status(inspection: SourceInspection) -> dict[str, Any]:
    return {
        "channel": inspection.channel,
        "productName": _source_product_name(inspection.channel),
        "databasePath": str(inspection.path),
        "exists": inspection.exists,
        "compatible": inspection.compatible,
        "blockingReason": None if inspection.compatible else inspection.message,
        "schemaRevision": inspection.schema_revision,
    }


def build_alpha_status(db: Session) -> dict[str, Any]:
    if resolve_app_channel() != "alpha":
        raise BetaBootstrapValidation("Alpha bootstrap is only available in the Alpha channel.")

    marker: dict[str, Any] | None = None
    decision: str | None = None
    setup_error: str | None = None
    try:
        marker = read_alpha_marker()
        if marker:
            decision = str(marker["decision"])
    except BetaBootstrapValidation as error:
        setup_error = str(error)

    apply_failure = read_alpha_apply_failure()
    apply_failure_message: str | None = None
    if apply_failure:
        raw_message = apply_failure.get("message")
        apply_failure_message = str(raw_message) if raw_message else "The staged copy could not be applied."

    pristine = alpha_is_pristine(db) if setup_error is None else False
    inspections = [
        inspect_source_database("stable", destination_channel="alpha"),
        inspect_source_database("beta", destination_channel="alpha"),
    ]
    acknowledged_for_install = _marker_acknowledges_for(ALPHA_DESTINATION, marker)
    needs_choice = setup_error is None and not acknowledged_for_install
    outstanding = _reconcile_active_stage_token(APP_DATA_DIR) or find_outstanding_stage_token(APP_DATA_DIR)
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
        "channel": "alpha",
        "setupState": setup_state,
        "decision": decision,
        "needsChoice": needs_choice,
        "alphaPristine": pristine,
        "alphaHasExistingLibrary": not pristine,
        "acknowledgedAppVersion": marker.get("appVersion") if marker else None,
        "acknowledgedInstallInstanceId": marker.get("installInstanceId") if marker else None,
        "sources": [_source_status(inspection) for inspection in inspections],
        "setupError": setup_error,
        "blockingReason": setup_error,
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


def start_alpha_empty_library(db: Session, data_root: Path | None = None) -> dict[str, Any]:
    if resolve_app_channel() != "alpha":
        raise BetaBootstrapValidation("Alpha bootstrap is only available in the Alpha channel.")
    root = data_root or APP_DATA_DIR
    if _marker_acknowledges_for(ALPHA_DESTINATION, read_alpha_marker(root)):
        raise BetaBootstrapConflict("Alpha setup has already completed.")
    if not alpha_is_pristine(db, root):
        raise BetaBootstrapConflict(
            "Alpha already contains library data and cannot be reset from here."
        )
    payload = write_alpha_marker("empty", data_root=root)
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


def use_alpha_current_library(db: Session, data_root: Path | None = None) -> dict[str, Any]:
    if resolve_app_channel() != "alpha":
        raise BetaBootstrapValidation("Alpha bootstrap is only available in the Alpha channel.")
    root = data_root or APP_DATA_DIR
    marker = read_alpha_marker(root)
    pristine = alpha_is_pristine(db, root)
    decision = str(marker["decision"]) if marker else ("empty" if pristine else "current")
    payload = write_alpha_marker(
        decision,
        source_channel=marker.get("sourceChannel") if marker else None,
        source_database_instance_id=marker.get("sourceDatabaseInstanceId") if marker else None,
        source_schema_revision=marker.get("sourceSchemaRevision") if marker else None,
        data_root=root,
    )
    return {"decision": payload["decision"], "restartRequired": False}


def stage_stable_copy(
    db: Session,
    *,
    confirm_replace_existing_beta: bool = False,
) -> dict[str, Any]:
    if resolve_app_channel() != "beta":
        raise BetaBootstrapValidation("Beta bootstrap is only available in the Beta channel.")
    return _stage_copy(
        db,
        destination=BETA_DESTINATION,
        source="stable",
        data_root=APP_DATA_DIR,
        destination_imports=IMPORT_DIR,
        confirm_replace_existing=confirm_replace_existing_beta,
        inspection=inspect_stable_database(),
    )


def stage_source_copy(
    db: Session,
    source: str,
    *,
    confirm_replace_existing_library: bool = False,
    destination_channel: Literal["beta", "alpha"] | None = None,
    data_root: Path | None = None,
) -> dict[str, Any]:
    destination_name = destination_channel or resolve_app_channel()
    destination = _destination(destination_name)
    if source not in destination.source_channels:
        raise BetaBootstrapValidation(
            f"{destination.product_name} can copy only from Stable or Beta."
        )
    if destination.channel == "beta" and source != "stable":
        raise BetaBootstrapValidation("Beta can copy only from Stable.")
    root = data_root or APP_DATA_DIR
    inspection = (
        inspect_stable_database()
        if source == "stable" and destination.channel == "beta"
        else inspect_source_database(
            source,
            destination_channel=destination.channel,
            destination_root=root,
        )
    )
    return _stage_copy(
        db,
        destination=destination,
        source=source,
        data_root=root,
        destination_imports=(IMPORT_DIR if destination.channel == "beta" and root == APP_DATA_DIR else root / "imports"),
        confirm_replace_existing=confirm_replace_existing_library,
        inspection=inspection,
    )


def _stage_copy(
    db: Session,
    *,
    destination: BootstrapDestination,
    source: str,
    data_root: Path,
    destination_imports: Path,
    confirm_replace_existing: bool,
    inspection: SourceInspection,
) -> dict[str, Any]:
    global _active_stage_token
    marker = _read_marker_for(destination, data_root)
    if _marker_acknowledges_for(destination, marker):
        raise BetaBootstrapConflict(
            f"{destination.product_name} setup has already been completed for this installation."
        )
    pristine = _library_is_pristine(db, data_root, destination.product_name)
    replace_existing = not pristine
    if replace_existing and not confirm_replace_existing:
        if destination.channel == "beta":
            raise BetaBootstrapConflict(
                "Confirm that copying Stable may replace the current Beta library."
            )
        raise BetaBootstrapConflict(
            "Confirm that copying the selected library may replace the current Alpha library."
        )

    _reconcile_active_stage_token(data_root)
    if find_outstanding_stage_token(data_root) is not None:
        if destination.channel == "beta":
            raise BetaBootstrapConflict(
                "A Stable library copy is already staged. Retry activation or discard it."
            )
        raise BetaBootstrapConflict(
            "A library copy is already staged. Retry activation or discard it."
        )

    if not inspection.exists or not inspection.compatible:
        raise BetaBootstrapValidation(
            inspection.message
            or f"The {_source_product_name(source)} library cannot be copied safely."
        )

    source_imports = inspection.path.parent / "imports"
    source_label = (
        "Stable" if source == "stable" and destination.channel == "beta" else _source_product_name(source)
    )

    token: str | None = None
    with _stage_lock:
        if _active_stage_token is not None:
            raise BetaBootstrapConflict(
                f"A {source_label} library copy is already in progress."
            )
        token = secrets.token_hex(STAGE_TOKEN_BYTES)
        stage_dir = _bootstrap_root_for(data_root) / token
        stage_dir.mkdir(parents=True, exist_ok=False)
        lock_path = _bootstrap_root_for(data_root) / LOCK_NAME
        lock_path.write_text(token + "\n", encoding="utf-8")
        _active_stage_token = token

    staged_db = stage_dir / STAGED_DB_NAME
    stage_imports = stage_dir / "imports"
    external_paths = 0
    inventory: dict[str, dict[str, Any]] = {}
    source_snapshot_root: Path | None = None

    try:
        source_identity_before = _source_identity(inspection.path)
        source_copy_path, source_snapshot_root = _create_source_snapshot(
            inspection.path,
            data_root,
        )

        with closing(_connect_readonly(source_copy_path)) as source_connection:
            with closing(sqlite3.connect(staged_db)) as destination_connection:
                source_connection.backup(destination_connection)

        integrity = _integrity_error(staged_db, pragma="integrity_check")
        if integrity:
            raise BetaBootstrapError(
                "The staged copy failed integrity checks."
                if destination.channel == "beta"
                else "The staged Alpha copy failed integrity checks."
            )

        source_instance_id = inspection.instance_id
        source_revision = inspection.schema_revision

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
                if not _path_is_under(source_path, source_imports):
                    external_paths += 1
                    continue
                relative = source_path.resolve().relative_to(source_imports.resolve())
                key = relative.as_posix()
                if not source_path.is_file():
                    raise BetaBootstrapValidation(
                        f"A managed import is missing from the {source_label} library: {key}"
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
                rewritten = (destination_imports / relative).resolve()
                connection.execute(
                    "UPDATE source_files SET path = ? WHERE id = ?",
                    (str(rewritten), row_id),
                )
            connection.commit()
            # The apply step accepts one plain SQLite file; the destination backend enables WAL
            # again when it opens the activated library.
            connection.execute("PRAGMA journal_mode=DELETE")
        _remove_sqlite_sidecars(staged_db)

        if _source_identity(inspection.path) != source_identity_before:
            raise BetaBootstrapError(f"The {source_label} library changed during copying.")

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
            destination.replacement_field: replace_existing,
            "createdAt": _utc_now_iso(),
        }
        if destination.channel == "alpha":
            manifest["sourceChannel"] = source
        _atomic_write_json(stage_dir / MANIFEST_NAME, manifest)

        result = {
            "token": token,
            "sourceDatabaseInstanceId": source_instance_id,
            "sourceSchemaRevision": source_revision,
            "copiedImports": len(staged_entries),
            "externalSourcePaths": external_paths,
            "restartRequired": True,
        }
        if destination.channel == "beta":
            result["replaceExistingBeta"] = replace_existing
        else:
            result["sourceChannel"] = source
            result["replaceExistingAlpha"] = replace_existing
            result["replaceExistingLibrary"] = replace_existing
        return result
    except Exception:
        with _stage_lock:
            _active_stage_token = None
            _bootstrap_root_for(data_root).joinpath(LOCK_NAME).unlink(missing_ok=True)
        if destination.channel == "alpha":
            try:
                _remove_stage_directory(stage_dir)
            except OSError:
                logger.warning("Could not remove failed %s bootstrap stage %s", destination.product_name, token)
        raise
    finally:
        _remove_source_snapshot(source_snapshot_root)
        _cleanup_stale_staging(
            active_token=token,
            data_root=data_root,
            product_name=destination.product_name,
        )


def clear_stage_lock(token: str) -> None:
    global _active_stage_token
    with _stage_lock:
        if _active_stage_token == token:
            _active_stage_token = None
        lock_path = bootstrap_root() / LOCK_NAME
        if lock_path.is_file() and lock_path.read_text(encoding="utf-8").strip() == token:
            lock_path.unlink(missing_ok=True)


def clear_alpha_stage_lock(token: str, data_root: Path | None = None) -> None:
    global _active_stage_token
    root = _bootstrap_root_for(data_root)
    with _stage_lock:
        if _active_stage_token == token:
            _active_stage_token = None
        lock_path = root / LOCK_NAME
        if lock_path.is_file() and lock_path.read_text(encoding="utf-8").strip() == token:
            lock_path.unlink(missing_ok=True)
