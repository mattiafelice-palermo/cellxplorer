from __future__ import annotations

import sqlalchemy as sa
from alembic.operations import Operations
from sqlalchemy import inspect
from sqlalchemy.engine import Connection

revision = "0004"
down_revision = "0003"
description = "Persist per-Cell continued-import folder watches and candidates"


def upgrade(operations: Operations, connection: Connection) -> None:
    inspector = inspect(connection)
    if not inspector.has_table("cell_folder_watches"):
        operations.create_table(
            "cell_folder_watches",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column(
                "cell_id",
                sa.Integer(),
                sa.ForeignKey("cells.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("folder_path", sa.Text(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("pattern_kind", sa.String(20), nullable=False, server_default="glob"),
            sa.Column("pattern", sa.Text(), nullable=False, server_default="*"),
            sa.Column("extensions", sa.JSON(), nullable=False),
            sa.Column("source_formats", sa.JSON(), nullable=False),
            sa.Column(
                "ordering_rule",
                sa.String(40),
                nullable=False,
                server_default="timestamp_filename_hash",
            ),
            sa.Column("last_scan_at", sa.DateTime(), nullable=True),
            sa.Column("last_status", sa.String(40), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("folder_last_seen_at", sa.DateTime(), nullable=True),
            sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("cell_id", name="uq_cell_folder_watches_cell_id"),
        )
    if not inspector.has_table("cell_folder_watch_candidates"):
        operations.create_table(
            "cell_folder_watch_candidates",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column(
                "watch_id",
                sa.Integer(),
                sa.ForeignKey("cell_folder_watches.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("path", sa.Text(), nullable=False),
            sa.Column("filename", sa.String(255), nullable=False),
            sa.Column("hash", sa.String(64), nullable=True),
            sa.Column(
                "first_seen_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.Column(
                "last_seen_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.Column("stability_state", sa.String(30), nullable=False, server_default="pending"),
            sa.Column("observed_size", sa.Integer(), nullable=True),
            sa.Column("observed_mtime_ns", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(40), nullable=False, server_default="pending_stability"),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
            sa.UniqueConstraint("watch_id", "path", name="uq_cell_folder_watch_candidate_path"),
        )

    index_names = {
        index["name"]
        for table in ("cell_folder_watches", "cell_folder_watch_candidates")
        for index in inspect(connection).get_indexes(table)
    }
    if "ix_cell_folder_watches_cell_id" not in index_names:
        operations.create_index("ix_cell_folder_watches_cell_id", "cell_folder_watches", ["cell_id"])
    if "ix_cell_folder_watch_candidates_watch_id" not in index_names:
        operations.create_index(
            "ix_cell_folder_watch_candidates_watch_id",
            "cell_folder_watch_candidates",
            ["watch_id"],
        )
    if "ix_cell_folder_watch_candidates_hash" not in index_names:
        operations.create_index(
            "ix_cell_folder_watch_candidates_hash",
            "cell_folder_watch_candidates",
            ["hash"],
        )
    if "ix_cell_folder_watch_candidates_status" not in index_names:
        operations.create_index(
            "ix_cell_folder_watch_candidates_status",
            "cell_folder_watch_candidates",
            ["status"],
        )
