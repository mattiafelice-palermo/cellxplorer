from __future__ import annotations

from alembic.operations import Operations
from sqlalchemy.engine import Connection

revision = "0001"
down_revision = None
description = "Baseline the CellXplorer 0.5 database schema"


def _columns(connection: Connection, table: str) -> set[str]:
    return {
        str(row[1])
        for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")').fetchall()
    }


def upgrade(operations: Operations, connection: Connection) -> None:
    # Import lazily so the complete model registry is available in both the
    # source backend and the PyInstaller sidecar.
    from ... import models  # noqa: F401
    from ...db import Base

    Base.metadata.create_all(bind=connection)

    cell_columns = _columns(connection, "cells")
    if cell_columns and "cycling_status" not in cell_columns:
        operations.execute(
            "ALTER TABLE cells "
            "ADD COLUMN cycling_status VARCHAR(20) NOT NULL DEFAULT 'active'"
        )

    source_columns = _columns(connection, "source_files")
    source_additions = (
        ("nominal_capacity_mah", "FLOAT"),
        ("total_charge_capacity_mah", "FLOAT"),
        ("total_discharge_capacity_mah", "FLOAT"),
        ("max_discharge_capacity_mah", "FLOAT"),
        (
            "capacity_summary_status",
            "VARCHAR(20) NOT NULL DEFAULT 'pending'",
        ),
        ("observed_size", "INTEGER"),
        ("observed_mtime_ns", "INTEGER"),
        ("last_source_check_at", "DATETIME"),
    )
    for name, sql_type in source_additions:
        if source_columns and name not in source_columns:
            operations.execute(
                f"ALTER TABLE source_files ADD COLUMN {name} {sql_type}"
            )

    activity_columns = _columns(connection, "activity_events")
    if activity_columns and "started_at" not in activity_columns:
        operations.execute("ALTER TABLE activity_events ADD COLUMN started_at DATETIME")
        operations.execute(
            "UPDATE activity_events SET started_at = created_at WHERE started_at IS NULL"
        )
    if activity_columns and "finished_at" not in activity_columns:
        operations.execute("ALTER TABLE activity_events ADD COLUMN finished_at DATETIME")
        operations.execute(
            "UPDATE activity_events SET finished_at = created_at WHERE finished_at IS NULL"
        )

