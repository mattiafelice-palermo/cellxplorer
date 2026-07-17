# Database migrations

CellXplorer versions its SQLite schema independently from the application, Neware parser, and
scientific calculation versions.

The current identifiers are:

- Application version: `APP_VERSION` in `backend/app/config.py`
- Database schema revision: `CURRENT_SCHEMA_REVISION` in
  `backend/app/migrations/registry.py`
- Parser version: `PARSER_VERSION` in `backend/app/services/parsing.py`
- Derived-data version: `CALC_VERSION` in `backend/app/config.py`

## Startup behavior

Before sessions, source monitoring, or cache backfills start, CellXplorer:

1. Runs SQLite `PRAGMA integrity_check`.
2. Reads the single revision in the standard `alembic_version` table.
3. Recognizes an existing unversioned CellXplorer database by its core tables.
4. Creates a consistent backup with SQLite's backup API before changing an existing database.
5. Applies every packaged migration in order.
6. Validates that every SQLAlchemy model table and column exists.
7. Starts normal services only when the resulting schema is supported.

The latest five automatic migration backups are retained under:

```text
%USERPROFILE%\.cellxplorer\backups
```

When `CELLXPLORER_DATA` is set, `backups/` lives under that directory instead.

If the database is corrupt, unrecognized, newer than the application, or fails migration,
CellXplorer starts in compatibility mode. The frontend explains the problem, normal API operations
return HTTP 503, and diagnostic/status endpoints remain available. A failed migration is never
silently stamped as successful.

## Adding a migration

1. Add a module under `backend/app/migrations/versions/`.
2. Give it a monotonically increasing revision such as `0002`.
3. Set `down_revision` to the previous revision.
4. Implement `upgrade(operations, connection)` using Alembic operations or carefully scoped SQL.
5. Import and append it in `backend/app/migrations/registry.py`.
6. Add migration tests that start from the previous schema and verify data preservation.

Do not edit an already released migration. Do not use `Base.metadata.create_all()` as a substitute
for a new production migration. The `0001` revision uses it only to establish the historical
CellXplorer 0.5 baseline and normalize the columns previously handled by `ensure_runtime_schema()`.

Downgrades are intentionally unsupported. Restoring the pre-migration backup is the recovery path.
