from __future__ import annotations

import json

import sqlalchemy as sa
from alembic.operations import Operations
from sqlalchemy import inspect
from sqlalchemy.engine import Connection

revision = "0005"
down_revision = "0004"
description = "Move folder watches to multi-format matching and drop recursion/cadence overrides"

# Columns retired by Spec 047.4 review findings R19-R21: a watch now matches a
# set of extensions/formats, never recurses, and always follows the global
# source-monitor cadence.
_RETIRED_COLUMNS = (
    "extension",
    "source_format",
    "recursive",
    "recursion_depth",
    "cadence_value",
    "cadence_unit",
)


def _column_names(connection: Connection, table: str) -> set[str]:
    return {column["name"] for column in inspect(connection).get_columns(table)}


def upgrade(operations: Operations, connection: Connection) -> None:
    if not inspect(connection).has_table("cell_folder_watches"):
        # A database created after this revision builds the table in its final
        # shape; there is nothing to migrate.
        return

    columns = _column_names(connection, "cell_folder_watches")

    if "extensions" not in columns:
        operations.add_column(
            "cell_folder_watches",
            sa.Column("extensions", sa.JSON(), nullable=False, server_default="[]"),
        )
    if "source_formats" not in columns:
        operations.add_column(
            "cell_folder_watches",
            sa.Column("source_formats", sa.JSON(), nullable=False, server_default="[]"),
        )

    # Carry each existing single-value watch into the new list columns so a
    # configured watch keeps matching exactly what it matched before.
    if "extension" in columns or "source_format" in columns:
        select_result = connection.execute(
            sa.text(
                "SELECT id, "
                f"{'extension' if 'extension' in columns else 'NULL'} AS extension, "
                f"{'source_format' if 'source_format' in columns else 'NULL'} AS source_format "
                "FROM cell_folder_watches"
            )
        )
        rows = select_result.fetchall()
        select_result.close()

        updates = [
            {
                "extensions": json.dumps(
                    [str(row.extension).strip().lower().lstrip(".")] if row.extension else []
                ),
                "source_formats": json.dumps(
                    [str(row.source_format).strip()] if row.source_format else []
                ),
                "id": row.id,
            }
            for row in rows
        ]
        if updates:
            update_result = connection.execute(
                sa.text(
                    "UPDATE cell_folder_watches "
                    "SET extensions = :extensions, source_formats = :source_formats "
                    "WHERE id = :id"
                ),
                updates,
            )
            update_result.close()

    retired = [name for name in _RETIRED_COLUMNS if name in columns]
    if retired:
        with operations.batch_alter_table("cell_folder_watches") as batch:
            for name in retired:
                batch.drop_column(name)
