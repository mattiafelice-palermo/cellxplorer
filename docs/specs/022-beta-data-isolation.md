# Spec 022: Isolated Beta data and one-time Stable library copy

Status: **review follow-ups R1–R9 implemented — awaiting re-review**  
Repository: `mattiafelice-palermo/cellxplorer`  
Target branch: `feature/stable-beta-app-identities` (Specs 021–023 release train)  
Depends on: Spec 021 application identities  
Review document: `docs/specs/reviews/022-beta-data-isolation-review.md`

## 1. Goal

Give CellXplorer Beta its own canonical data root and provide a safe, explicit first-run option to
copy the user's Stable library into Beta.

After this specification:

- Stable and Beta can run simultaneously without sharing SQLite, caches, logs, backups or settings;
- a Beta migration cannot make the Stable database unusable;
- the user may begin Beta with a one-time snapshot of the Stable library or with an empty library;
- copied Stable and Beta libraries evolve independently after the snapshot.

This specification does not synchronize the two databases and does not publish Beta releases.

### 1.1 July 2026 startup-choice amendment

The shipped workflow now supersedes the original one-time/pristine-only clauses in sections 3,
6.2, 7, and the historical checklist:

- the choice is acknowledged once per installed Beta application version;
- a first Beta install offers **Start clean** or **Copy Stable library**;
- a new Beta version with an inherited Beta library offers **Use existing Beta library** or
  **Copy Stable library**;
- copying over an inherited Beta library requires a clear overwrite warning and explicit
  confirmation;
- the staged manifest records whether replacement was authorized;
- activation moves the existing Beta database and managed imports to rollback locations, restores
  them on any failure, and deletes them only after the Stable snapshot activates successfully;
- choosing the existing library changes no scientific data and only updates the version-scoped
  acknowledgement marker.

The Stable library remains read-only throughout and no synchronization is introduced.

## 2. Locked data-root matrix

| Data | Stable | Beta |
|---|---|---|
| Root | `%USERPROFILE%\.cellxplorer` | `%USERPROFILE%\.cellxplorer-beta` |
| SQLite | `cellxplorer.db` | `cellxplorer.db` under Beta root |
| Cache | `cache\` | separate `cache\` |
| Imports | `imports\` | separate `imports\` |
| Logs | `logs\` | separate `logs\` |
| Backups | `backups\` | separate `backups\` |
| Download history | separate Stable file | separate Beta file |
| Bootstrap metadata | none | `beta-bootstrap.json` |

`CELLXPLORER_DATA` remains the highest-priority explicit override for development and tests in both
channels. When set, do not append `.cellxplorer` or `.cellxplorer-beta`.

Channel is supplied by Spec 021 as `CELLXPLORER_CHANNEL=stable|beta`. Do not infer channel from the
data directory or version string.

## 3. Locked user workflow

On the first Beta launch with a pristine Beta library, show a blocking modal:

```text
Set up CellXplorer Beta

Beta keeps its library separate from the stable app. You can copy a snapshot of
your current Stable library, or start with an empty Beta library.

[Copy Stable library]  [Start empty]
```

Rules:

- the modal appears only in the Beta edition;
- it has no close button and cannot be dismissed by Escape or outside click;
- Stable never shows it;
- the user must make one explicit choice;
- copying is never automatic;
- the Stable database is never modified;
- after either choice, write a durable Beta bootstrap marker and never prompt again;
- if Stable is absent or cannot be copied, `Start empty` remains available;
- after the choice, Stable and Beta are independent—no automatic synchronization.

Use normal compact CellXplorer modal geometry. The primary action is `Copy Stable library`; the
secondary action is `Start empty`. During staging, disable both actions and show a determinate stage
label or indeterminate loader; do not invent a percentage.

## 4. Current implementation anchors

### Data configuration

- `backend/app/config.py`
  - `APP_DATA_DIR`
  - `CACHE_DIR`
  - `IMPORT_DIR`
  - `LOG_DIR`
  - `BACKUP_DIR`
  - `DB_PATH`
- `backend/app/db.py`
- `backend/app/main.py`
- `backend/app/migrations/`
- `backend/app/services/download_registry.py`
- database status/compatibility service and `/api/database/status`
- existing database instance UUID helper used by startup persistence

### Desktop shell

- `src-tauri/src/app_channel.rs` from Spec 021
- `src-tauri/src/main.rs`
  - sidecar environment construction
  - `app_data_dir`
  - `open_app_folder`
  - `stop_backend`
  - `schedule_relaunch`
  - `restart_app`
- `packaging/backend_entry.py`

### Frontend

- `frontend/src/App.tsx`
  - database-status startup query
  - compatibility/error surfaces
- `frontend/src/main.tsx`
- `frontend/src/api.ts`
- `frontend/src/startupQueryPersistence.ts`

### Migration and safety docs/tests

- `docs/database-migrations.md`
- `tests/test_database_migrations.py` and related compatibility tests
- tests that use `CELLXPLORER_DATA`

## 5. Channel-aware data resolution

Extend the backend channel helper (`backend/app/services/app_channel.py`):

```py
def app_channel() -> Literal["stable", "beta"]: ...
def default_data_root(channel: str, home: Path) -> Path: ...
def resolve_data_root(env: Mapping[str, str], home: Path) -> Path: ...
```

Rules:

1. `CELLXPLORER_DATA` wins exactly when present.
2. Otherwise:
   - Stable -> `~/.cellxplorer`
   - Beta -> `~/.cellxplorer-beta`
3. In a packaged sidecar, missing/invalid `CELLXPLORER_CHANNEL` is an error.
4. Browser/source development may default to Stable only through an explicit development path.
5. Resolve the root once before importing modules that construct paths.
6. Every backend path constant must derive from that single root.
7. Do not add channel-specific path conditions throughout services.

Rust must resolve the same root through the Spec 021 channel helper and pass both:

```text
CELLXPLORER_CHANNEL
CELLXPLORER_DATA
```

to the sidecar. `open_app_folder` and log-folder actions must use the same resolved root.

Add an internal startup assertion or diagnostic test that Rust and backend resolve identical paths
for Stable, Beta and an explicit override.

## 6. Bootstrap state

Add a Beta-only service and router:

```text
backend/app/services/beta_bootstrap.py
backend/app/routers/beta_bootstrap.py
```

Register the router under:

```text
/api/beta-bootstrap
```

Stable requests to these endpoints return HTTP 404. Do not expose copy operations in Stable.

### 6.1 Marker

Beta marker path:

```text
%USERPROFILE%\.cellxplorer-beta\beta-bootstrap.json
```

Schema:

```json
{
  "schemaVersion": 1,
  "decision": "copied" | "empty",
  "completedAt": "ISO-8601 UTC",
  "sourceDatabaseInstanceId": "string or null",
  "sourceSchemaRevision": "string or null"
}
```

Write atomically: temporary file, flush, then replace. Invalid/corrupt marker content must produce a
clear recoverable error, not silently re-run a copy.

### 6.2 Pristine Beta definition

Copy is allowed only when the Beta library is pristine.

Implement one tested predicate. A Beta database is pristine when:

- no `SourceFile`, `Test`, `Cell`, `ReplicateGroup`, `Folder` user content or `Analysis` exists;
- no imported source payload exists under Beta `imports/`;
- no bootstrap marker exists;
- only schema/migration rows and automatically created internal settings are present.

Do not rely on file size or database creation time.

Once any user content exists, the copy endpoint must return HTTP 409 and never overwrite it.

## 7. API contract

### `GET /api/beta-bootstrap/status`

Response:

```json
{
  "channel": "beta",
  "decision": null | "copied" | "empty",
  "needsChoice": true,
  "betaPristine": true,
  "stableDatabaseExists": true,
  "stableDatabaseCompatible": true,
  "stableDatabasePath": "C:\\Users\\...\\.cellxplorer\\cellxplorer.db",
  "blockingReason": null
}
```

Rules:

- return display-safe paths only;
- do not expose stack traces;
- `needsChoice` is true only when no marker exists and Beta is pristine;
- inspect Stable read-only;
- distinguish absent, corrupt, unrecognized and newer-than-Beta databases;
- copy may be disabled with a plain-language `blockingReason`;
- `Start empty` remains possible unless the Beta root itself is unusable.

### `POST /api/beta-bootstrap/stage-copy`

No arbitrary path input.

Response:

```json
{
  "token": "32 lowercase hex characters",
  "sourceDatabaseInstanceId": "uuid",
  "sourceSchemaRevision": "revision",
  "copiedImports": 3,
  "externalSourcePaths": 17,
  "restartRequired": true
}
```

Return:

- 404 in Stable;
- 409 when Beta is not pristine or a decision already exists;
- 422 when Stable is absent/incompatible;
- 500 with safe recovery text when staging fails.

### `POST /api/beta-bootstrap/start-empty`

No body.

Response:

```json
{
  "decision": "empty",
  "restartRequired": false
}
```

Write the marker only after confirming Beta remains pristine.

## 8. Safe Stable snapshot

`stage-copy` must use SQLite's online backup API. Never copy a live `.db`, `-wal` or `-shm` file
with `shutil.copy`.

Required sequence:

1. Resolve Stable and Beta roots from channel helpers.
2. Assert source is exactly Stable `cellxplorer.db`.
3. Assert destination staging area is under:
   `.cellxplorer-beta\bootstrap\<token>\`.
4. Open Stable SQLite read-only.
5. Run `PRAGMA integrity_check`; require exactly `ok`.
6. Read Stable schema revision and reject a revision newer than the Beta application supports.
7. Use `sqlite3.Connection.backup()` into `staged-cellxplorer.db`.
8. Run `PRAGMA integrity_check` on the staged database.
9. Generate a **new database instance UUID** in the staged copy using the existing canonical
   setting/helper. Do not let the clone retain Stable's instance UUID.
10. Record source instance UUID and revision in the staging manifest.
11. Do not run arbitrary schema SQL or edit released migrations.
12. Leave Stable opened read-only and unchanged.

The normal Beta startup migration pipeline may migrate the copied database after it becomes active.
Do not duplicate migration logic in the bootstrap service.

## 9. Imports and source paths

Original external Neware files are not duplicated.

For every source path in the copied database:

- paths outside Stable `imports/` remain unchanged;
- paths under Stable `imports/` must be copied into staged Beta `imports/`;
- preserve relative hierarchy and filenames;
- verify copied file size and SHA-256 against the database checksum where available;
- rewrite only the copied database rows that pointed inside Stable `imports/` so they point to Beta
  `imports/`;
- do not rewrite external network/local paths;
- do not parse source files during bootstrap.

The staged database carries a durable post-activation scientific-preparation marker. This does not
copy or parse cache data inside the snapshot transaction. After the copied database is active and
the ordinary Beta backend has started, a resumable background job verifies available sources,
builds missing current-version scientific caches, and refreshes capacity summaries. The setup
surface appears before normal library interaction and shows real file-count progress. It remains
gated by default until that one-time pass finishes, but the user may explicitly continue in the
background without cancelling the same preparation job; genuine offline/changed/parser failures
remain visible per source afterward.

Do not copy:

- `cache/`;
- `logs/`;
- `backups/`;
- `downloads-history.json`;
- pending portable-import staging;
- temporary files;
- `.wal` or `.shm`.

Beta regenerates caches normally from checksums and source paths.

## 10. Applying the staged copy

Add one narrow Tauri command:

```rust
apply_beta_bootstrap(token: String) -> Result<(), String>
```

It is Beta-only and accepts only a 32-character lowercase hex token.

The frontend flow after successful staging:

1. call `/api/session/finish`;
2. invoke `apply_beta_bootstrap(token)`;
3. show a non-dismissible restarting state.

The command must:

1. validate channel is Beta;
2. resolve the token directory under the Beta root—no caller-supplied filesystem path;
3. validate the staging manifest, staged DB and copied imports;
4. stop the current Beta backend using existing process-tree cleanup;
5. preserve the pristine current Beta DB as a temporary rollback file;
6. atomically replace `cellxplorer.db` with the staged DB;
7. move staged imports into Beta `imports/`;
8. write `beta-bootstrap.json` with decision `copied`;
9. schedule the existing delayed relaunch;
10. exit the current Beta process.

Failure behavior:

- Stable files are never touched;
- if activation fails before relaunch, restore the pristine Beta DB;
- retain the staged snapshot for retry/diagnostics;
- do not leave a marker claiming success;
- return/log a safe error;
- never delete a non-pristine Beta database.

The command must not accept `..`, separators, absolute paths or symlinks escaping the Beta root.

## 11. Frontend bootstrap coordinator

Create a focused component, for example:

```text
frontend/src/components/BetaBootstrapCoordinator.tsx
```

Place it above normal application use but do not globally rewrite `App.tsx`.

Behavior:

- disabled in Stable and plain browser mode unless an explicit dev mock is used;
- queries status after the Beta backend is reachable;
- opens the locked modal when `needsChoice` is true;
- keeps normal application content visible behind the modal;
- handles loading, blocked-copy, staging, restart and error states;
- `Start empty` is always clearly available when copy is blocked;
- failed staging leaves the modal open and offers retry;
- no notification-only success; the restart is the completion.

Development mock modes may be added for:

```text
?mockBetaBootstrap=available
?mockBetaBootstrap=blocked
?mockBetaBootstrap=copy-error
```

Mocks must be development-only.

## 12. Concurrency and locking

- Two Beta processes are already prevented by the Beta single-instance identity.
- Stable may be running while the snapshot is taken; SQLite backup must handle this.
- Reject a second stage-copy request while one is active.
- Use a lock file or process-local mutex plus token-state validation.
- Stage into a new token directory and publish the manifest last.
- Clean abandoned staging directories older than 24 hours only when no copy/apply is active.
- Never delete the most recent failed stage automatically if it is needed for diagnosis/retry.

## 13. Tests

### Path policy

- Stable default root is `.cellxplorer`.
- Beta default root is `.cellxplorer-beta`.
- explicit `CELLXPLORER_DATA` overrides both exactly.
- invalid packaged channel fails.
- Rust and Python policy fixtures agree.

### Bootstrap service

Using isolated temporary roots:

- Stable endpoint returns 404.
- pristine Beta requires a choice.
- marker suppresses future prompts.
- non-pristine Beta rejects copy.
- absent Stable disables copy but permits empty.
- corrupt/unrecognized/newer Stable blocks copy safely.
- SQLite backup captures a consistent database while source connection remains open.
- staged integrity check passes.
- Stable file hash and modification metadata remain unchanged.
- staged database receives a new instance UUID.
- external paths remain unchanged.
- Stable-import paths are copied and rewritten.
- checksum mismatch aborts staging.
- caches/logs/backups/history are not copied.
- abandoned stage cleanup is bounded.

### Apply command

Extract pure path/token/transition helpers for tests:

- malformed token rejected;
- traversal rejected;
- Stable channel rejected;
- missing/invalid manifest rejected;
- activation preserves rollback;
- simulated import move failure restores prior Beta DB;
- success writes marker only after DB/import activation.

### Frontend

- modal only appears for Beta `needsChoice`;
- modal cannot dismiss;
- blocked copy explains reason and keeps Start empty;
- staging disables duplicate clicks;
- copy success invokes finish-session then Tauri apply;
- errors remain retryable;
- Stable renders no bootstrap UI.

Run:

```powershell
python -m unittest tests.test_app_channels tests.test_beta_bootstrap tests.test_database_migrations -v
node --test frontend\tests\betaBootstrap.test.ts frontend\tests\appChannel.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
python scripts\preflight.py --no-cache
```

## 14. Manual verification

Use a disposable Stable database containing:

- external source paths;
- at least one app-managed imported source;
- cells, replicate groups, folders, analyses and saved plots;
- enough data to trigger a normal migration backup if applicable.

Verify:

1. Stable starts from `.cellxplorer`; Beta starts from `.cellxplorer-beta`.
2. Both processes run simultaneously and use different DB/log/cache paths.
3. First Beta launch shows the blocking setup modal.
4. Copy produces a matching library structure.
5. External source paths remain shared references.
6. app-managed imports exist under Beta root and paths are rewritten.
7. Stable DB hash/content/UUID remain unchanged.
8. Beta has a new database instance UUID.
9. Beta caches begin empty and rebuild normally.
10. Editing/deleting/creating records in Beta does not affect Stable.
11. A Beta migration or compatibility failure does not affect Stable startup.
12. Start empty creates a normal empty Beta library and does not prompt again.
13. Uninstalling either application leaves both data roots untouched.
14. Data-folder and log-folder actions open the correct edition's directories.

## 15. Data and migration consequences

- No persistent schema revision is required solely for channel isolation.
- Do not edit a released migration.
- Do not bump `CALC_VERSION`.
- A copied Stable database is migrated through the existing forward-only startup pipeline.
- Caches are intentionally not copied.
- A new instance UUID is mandatory.
- Stable and Beta are independent after copying.

## 16. Out of scope

- ongoing sync or conflict resolution;
- writing back from Beta to Stable;
- copying only selected cells;
- cache copying;
- source-file duplication outside Stable imports;
- Beta release publishing or update feeds;
- Stable-to-Beta installer download;
- automatic silent copy;
- cloud backup;
- database downgrade support.

## 17. Implementation order

1. Copy/index the spec on the Spec 021–023 branch.
2. Centralize Python and Rust channel-aware data roots.
3. Pass exact channel/data-root environment to the sidecar.
4. Add marker/status/pristine policy and tests.
5. Implement safe SQLite staging and import-path handling.
6. Implement Beta-only atomic apply/restart command and rollback.
7. Add the blocking frontend coordinator and dev mocks.
8. Update durable architecture/migration/packaging documentation.
9. Run all focused checks and preflight.
10. Perform the disposable copy and simultaneous-run matrix.
11. Record exact results; do not tag or publish.

## 18. Acceptance checklist

- [x] Stable and Beta use separate roots without an explicit override. (unit/policy tests)
- [x] Every persistent/runtime path follows the correct root. (Python/Rust path tests + docs)
- [ ] Stable and Beta can run simultaneously without SQLite/cache/log conflicts. (installed matrix pending elevated install)
- [x] First Beta launch requires Copy or Start empty. (fail-closed gate + coordinator policy tests)
- [x] Stable is opened read-only and remains unchanged. (bootstrap service tests)
- [x] Copy uses SQLite backup, not raw DB/WAL copying. (stage_stable_copy)
- [x] copied DB gets a new instance UUID. (bootstrap tests)
- [x] external sources are referenced, not duplicated. (bootstrap tests)
- [x] Stable-managed imports are copied and rewritten safely. (streaming copy + inventory tests)
- [x] caches/logs/backups/history are not copied. (stage content tests)
- [x] non-pristine Beta is never overwritten. (Rust + Python tests)
- [x] apply is token-scoped, atomic and rollback-safe. (Rust activation tests + non-returning lifecycle)
- [x] no database migration or `CALC_VERSION` change is introduced.
- [ ] full tests and disposable manual matrix pass. (automated suite PASS; installed matrix incomplete)
- [x] no user release is tagged before Spec 023.

## 19. Composer handoff

```text
Implement docs/specs/022-beta-data-isolation.md on feature/stable-beta-app-identities
(Specs 021–023 release train).

Read the spec, Spec 021, AGENTS.md, architecture.md, change-playbooks.md,
docs/database-migrations.md and the visual style guide first.

Locked safety rules:
- Stable root stays .cellxplorer; Beta root is .cellxplorer-beta.
- CELLXPLORER_DATA overrides both exactly.
- Copy is explicit and one-time.
- Use sqlite3 backup; never copy a live DB/WAL pair.
- Stable is read-only and must remain byte-for-byte unchanged.
- Never overwrite non-pristine Beta data.
- Regenerate the copied database instance UUID.
- Do not copy caches, logs, backups or download history.
- Do not tag or publish; Spec 023 owns the release.
```
