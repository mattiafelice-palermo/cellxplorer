from __future__ import annotations

import sqlalchemy as sa
from alembic.operations import Operations
from sqlalchemy import inspect
from sqlalchemy.engine import Connection

revision = "0003"
down_revision = "0002"
description = "Persist import submission claims and lifecycle state"


def upgrade(operations: Operations, connection: Connection) -> None:
    if not inspect(connection).has_table("import_submissions"):
        operations.create_table(
            "import_submissions",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("token", sa.String(100), nullable=False, unique=True),
            sa.Column("fingerprint", sa.String(64), nullable=False),
            sa.Column("job_id", sa.Integer(), nullable=True),
            sa.Column("submitted_cells", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("submitted_sources", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(20), nullable=False, server_default="accepted"),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
        )
    index_names = {index["name"] for index in inspect(connection).get_indexes("import_submissions")}
    if "ix_import_submissions_token" not in index_names:
        operations.create_index(
            "ix_import_submissions_token",
            "import_submissions",
            ["token"],
            unique=True,
        )
    if "ix_import_submissions_job_id" not in index_names:
        operations.create_index(
            "ix_import_submissions_job_id",
            "import_submissions",
            ["job_id"],
        )
    if "ix_import_submissions_status" not in index_names:
        operations.create_index(
            "ix_import_submissions_status",
            "import_submissions",
            ["status"],
        )
