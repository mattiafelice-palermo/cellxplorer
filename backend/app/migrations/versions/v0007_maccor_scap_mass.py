"""Apply the Maccor grams default to source metadata already held in the library."""
import json

from alembic.operations import Operations
from sqlalchemy.engine import Connection

from ...services.maccor_metadata import normalization

revision = "0007"
down_revision = "0006"
description = "Resolve missing Maccor source masses from recorded startup metadata"


def upgrade(operations: Operations, connection: Connection) -> None:
    select_headers = """
        SELECT id, json_extract(header_meta, '$.Maccor')
        FROM source_files
        WHERE id > ? AND active_mass_mg IS NULL AND parse_status <> 'metadata_only'
          AND (ext IN ('txt', 'csv') OR ext GLOB '[0-9][0-9][0-9]'
               OR (ext = 'xlsx' AND (parser_version IS NULL OR parser_version LIKE 'mx:%')))
          AND CASE WHEN json_valid(header_meta) THEN json_type(header_meta, '$.Maccor') END = 'object'
        ORDER BY id LIMIT 128
    """
    last_id = 0
    while rows := connection.exec_driver_sql(select_headers, (last_id,)).all():
        last_id = rows[-1].id
        for source_id, fields in rows:
            values = normalization(json.loads(fields))
            if values["active_mass_mg"] is None:
                continue
            # Older readers still need their normal header refresh for other startup facts.
            connection.exec_driver_sql("""
                UPDATE source_files SET active_mass_mg = ?, header_meta = CASE
                    WHEN json_type(header_meta, '$.maccor_normalization') = 'object'
                    THEN json_set(header_meta, '$.maccor_normalization', json(?)) ELSE header_meta END
                WHERE id = ?
            """, (values["active_mass_mg"], json.dumps(values, allow_nan=False), source_id))
