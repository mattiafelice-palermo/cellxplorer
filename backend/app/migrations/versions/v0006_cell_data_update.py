from alembic.operations import Operations
from sqlalchemy.engine import Connection

revision = "0006"
down_revision = "0005"
description = "Record Cell import and data refresh time without inventing historical dates"


def upgrade(operations: Operations, connection: Connection) -> None:
    columns = {row[1] for row in connection.exec_driver_sql('PRAGMA table_info("cells")')}
    if "last_data_update_at" not in columns:
        operations.execute("ALTER TABLE cells ADD COLUMN last_data_update_at DATETIME")
