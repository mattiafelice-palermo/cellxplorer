from __future__ import annotations

import logging
import re
import sqlite3
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import inspect
from sqlalchemy.engine import Engine

from ..config import APP_VERSION, BACKUP_DIR
from ..migrations.registry import (
    CURRENT_SCHEMA_REVISION,
    REVISION_BY_ID,
    revisions_after,
)

logger = logging.getLogger(__name__)

ALEMBIC_VERSION_TABLE = "alembic_version"
BACKUP_LIMIT = 5
CORE_TABLES = {"source_files", "cells", "tests"}


@dataclass(frozen=True)
class DatabaseStatus:
    status: str
    compatible: bool
    app_version: str
    schema_revision: str | None
    supported_revision: str
    previous_revision: str | None
    migration_performed: bool
    legacy_database: bool
    backup_path: str | None
    message: str

    def as_dict(self) -> dict:
        return asdict(self)


class DatabaseMigrationError(RuntimeError):
    pass


def _status(
    status: str,
    *,
    compatible: bool,
    schema_revision: str | None,
    previous_revision: str | None = None,
    migration_performed: bool = False,
    legacy_database: bool = False,
    backup_path: Path | None = None,
    message: str,
) -> DatabaseStatus:
    return DatabaseStatus(
        status=status,
        compatible=compatible,
        app_version=APP_VERSION,
        schema_revision=schema_revision,
        supported_revision=CURRENT_SCHEMA_REVISION,
        previous_revision=previous_revision,
        migration_performed=migration_performed,
        legacy_database=legacy_database,
        backup_path=str(backup_path) if backup_path else None,
        message=message,
    )


def _connect_readonly(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def _existing_tables(path: Path) -> set[str]:
    if not path.exists() or path.stat().st_size == 0:
        return set()
    with closing(_connect_readonly(path)) as connection:
        rows = connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    return {str(row[0]) for row in rows}


def _integrity_error(path: Path, pragma: str = "quick_check") -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    try:
        with closing(_connect_readonly(path)) as connection:
            rows = connection.execute(f"PRAGMA {pragma}").fetchall()
    except sqlite3.DatabaseError as exc:
        return str(exc)
    messages = [str(row[0]) for row in rows]
    return None if messages == ["ok"] else "; ".join(messages[:10])


def _read_revision(path: Path, tables: set[str]) -> tuple[str | None, str | None]:
    if ALEMBIC_VERSION_TABLE not in tables:
        return None, None
    try:
        with closing(_connect_readonly(path)) as connection:
            rows = connection.execute(
                f"SELECT version_num FROM {ALEMBIC_VERSION_TABLE}"
            ).fetchall()
    except sqlite3.DatabaseError as exc:
        return None, f"Could not read the schema revision: {exc}"
    if len(rows) != 1 or not rows[0][0]:
        return None, "The database has an invalid schema revision record."
    return str(rows[0][0]), None


def _looks_like_legacy_cellxplorer(tables: set[str]) -> bool:
    return len(CORE_TABLES.intersection(tables)) >= 2


def _is_future_revision(revision: str) -> bool:
    current_match = re.fullmatch(r"0*(\d+)", CURRENT_SCHEMA_REVISION)
    revision_match = re.fullmatch(r"0*(\d+)", revision)
    if current_match and revision_match:
        return int(revision_match.group(1)) > int(current_match.group(1))
    return False


def _create_backup(
    path: Path,
    from_revision: str | None,
    backup_dir: Path,
) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    label = from_revision or "legacy"
    backup_path = backup_dir / (
        f"cellxplorer-before-schema-{CURRENT_SCHEMA_REVISION}-"
        f"from-{label}-{timestamp}.db"
    )
    source = sqlite3.connect(path)
    destination = sqlite3.connect(backup_path)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    backups = sorted(
        backup_dir.glob("cellxplorer-before-schema-*.db"),
        key=lambda item: item.stat().st_mtime_ns,
        reverse=True,
    )
    for stale in backups[BACKUP_LIMIT:]:
        try:
            stale.unlink()
        except OSError:
            logger.warning("Could not remove old migration backup %s", stale)
    return backup_path


def _ensure_version_table(operations: Operations, connection) -> None:
    tables = set(inspect(connection).get_table_names())
    if ALEMBIC_VERSION_TABLE not in tables:
        operations.create_table(
            ALEMBIC_VERSION_TABLE,
            sa.Column("version_num", sa.String(32), primary_key=True, nullable=False),
        )


def _stamp_revision(connection, revision: str) -> None:
    connection.exec_driver_sql(f"DELETE FROM {ALEMBIC_VERSION_TABLE}")
    connection.execute(
        sa.text(
            f"INSERT INTO {ALEMBIC_VERSION_TABLE} (version_num) "
            "VALUES (:revision)"
        ),
        {"revision": revision},
    )


def _validate_current_schema(engine: Engine) -> None:
    from .. import models  # noqa: F401
    from ..db import Base

    with engine.connect() as connection:
        inspector = inspect(connection)
        actual_tables = set(inspector.get_table_names())
        missing_tables = set(Base.metadata.tables) - actual_tables
        if missing_tables:
            raise DatabaseMigrationError(
                "Missing tables after migration: " + ", ".join(sorted(missing_tables))
            )
        for table_name, table in Base.metadata.tables.items():
            actual_columns = {
                column["name"] for column in inspector.get_columns(table_name)
            }
            missing_columns = set(table.columns.keys()) - actual_columns
            if missing_columns:
                raise DatabaseMigrationError(
                    f"Missing columns in {table_name}: "
                    + ", ".join(sorted(missing_columns))
                )


def _apply_migrations(engine: Engine, current_revision: str | None) -> None:
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        operations = Operations(context)
        _ensure_version_table(operations, connection)
        for migration in revisions_after(current_revision):
            logger.info(
                "Applying database migration %s: %s",
                migration.revision,
                getattr(migration.module, "description", ""),
            )
            migration.module.upgrade(operations, connection)
            _stamp_revision(connection, migration.revision)


def migrate_database(
    engine: Engine,
    path: Path,
    *,
    backup_dir: Path | None = None,
) -> DatabaseStatus:
    path.parent.mkdir(parents=True, exist_ok=True)
    migration_backup_dir = backup_dir or BACKUP_DIR
    try:
        tables = _existing_tables(path)
    except (OSError, sqlite3.DatabaseError) as exc:
        logger.exception("Could not inspect the CellXplorer database")
        return _status(
            "database_corrupt",
            compatible=False,
            schema_revision=None,
            message=f"The database could not be read: {exc}",
        )

    # Every launch pays for this scan while the UI waits, so use the fast
    # page-level quick_check; the thorough scan runs before a migration
    # rewrites the file.
    integrity_error = _integrity_error(path)
    if integrity_error:
        logger.error("Database integrity check failed: %s", integrity_error)
        return _status(
            "database_corrupt",
            compatible=False,
            schema_revision=None,
            message=f"SQLite integrity check failed: {integrity_error}",
        )

    revision, revision_error = _read_revision(path, tables)
    if revision_error:
        return _status(
            "database_unrecognized",
            compatible=False,
            schema_revision=None,
            message=revision_error,
        )

    if revision is not None and revision not in REVISION_BY_ID:
        status = "database_too_new" if _is_future_revision(revision) else "database_unrecognized"
        message = (
            f"This database uses schema {revision}, but CellXplorer {APP_VERSION} "
            f"supports up to {CURRENT_SCHEMA_REVISION}."
            if status == "database_too_new"
            else f"The database uses unknown schema revision {revision}."
        )
        return _status(
            status,
            compatible=False,
            schema_revision=revision,
            message=message,
        )

    is_empty = not tables
    is_legacy = revision is None and not is_empty
    if is_legacy and not _looks_like_legacy_cellxplorer(tables):
        return _status(
            "database_unrecognized",
            compatible=False,
            schema_revision=None,
            legacy_database=True,
            message=(
                "This non-empty SQLite database does not look like a supported "
                "CellXplorer database and was not modified."
            ),
        )

    if revision == CURRENT_SCHEMA_REVISION:
        try:
            _validate_current_schema(engine)
        except Exception as exc:
            logger.exception("Current database schema validation failed")
            return _status(
                "migration_failed",
                compatible=False,
                schema_revision=revision,
                message=f"Schema validation failed: {exc}",
            )
        return _status(
            "ready",
            compatible=True,
            schema_revision=revision,
            message="The database schema is current.",
        )

    backup_path = None
    if not is_empty:
        integrity_error = _integrity_error(path, pragma="integrity_check")
        if integrity_error:
            logger.error(
                "Database integrity check failed before migration: %s",
                integrity_error,
            )
            return _status(
                "database_corrupt",
                compatible=False,
                schema_revision=revision,
                legacy_database=is_legacy,
                message=f"SQLite integrity check failed: {integrity_error}",
            )
        try:
            backup_path = _create_backup(
                path,
                revision,
                migration_backup_dir,
            )
            logger.info("Created pre-migration database backup at %s", backup_path)
        except Exception as exc:
            logger.exception("Could not create a database migration backup")
            return _status(
                "migration_failed",
                compatible=False,
                schema_revision=revision,
                previous_revision=revision,
                legacy_database=is_legacy,
                message=f"Migration was not started because backup creation failed: {exc}",
            )

    try:
        _apply_migrations(engine, revision)
        _validate_current_schema(engine)
    except Exception as exc:
        logger.exception("Database migration failed")
        engine.dispose()
        return _status(
            "migration_failed",
            compatible=False,
            schema_revision=revision,
            previous_revision=revision,
            legacy_database=is_legacy,
            backup_path=backup_path,
            message=f"Database migration failed: {exc}",
        )

    action = "Initialized" if is_empty else "Migrated"
    logger.info(
        "%s database schema from %s to %s",
        action,
        revision or ("legacy" if is_legacy else "empty"),
        CURRENT_SCHEMA_REVISION,
    )
    return _status(
        "ready",
        compatible=True,
        schema_revision=CURRENT_SCHEMA_REVISION,
        previous_revision=revision,
        migration_performed=True,
        legacy_database=is_legacy,
        backup_path=backup_path,
        message=(
            "Created a new versioned CellXplorer database."
            if is_empty
            else f"Migrated the database to schema {CURRENT_SCHEMA_REVISION}."
        ),
    )
