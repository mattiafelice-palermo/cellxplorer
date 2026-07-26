from __future__ import annotations

from alembic.operations import Operations
from sqlalchemy.engine import Connection

revision = "0002"
down_revision = "0001"
description = "Add cached maximum discharge-capacity summary"


def _columns(connection: Connection, table: str) -> set[str]:
    return {
        str(row[1])
        for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")').fetchall()
    }


def upgrade(operations: Operations, connection: Connection) -> None:
    source_columns = _columns(connection, "source_files")
    if source_columns and "max_discharge_capacity_mah" not in source_columns:
        operations.execute(
            "ALTER TABLE source_files ADD COLUMN max_discharge_capacity_mah FLOAT"
        )
    if source_columns:
        operations.execute(
            "UPDATE source_files "
            "SET capacity_summary_status = 'pending' "
            "WHERE parse_status = 'parsed' "
            "AND max_discharge_capacity_mah IS NULL"
        )
