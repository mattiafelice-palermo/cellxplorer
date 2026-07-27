# Review 022: Isolated Beta data and one-time Stable library copy

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/stable-beta-app-identities`  
Reviewed head: `67edf2682160461e7c7947112abc4bc82f1b538a`  
Base and merge base: `main` at `6c08a59c61a2607c47e036fac91486fb69a4c200`  
Branch position: 4 commits ahead, 0 behind  
Review status: **changes required — not ready to merge or release**

## Scope assessment

Spec 022 was implemented cumulatively on the same branch as Spec 021 rather than on a separate
post-merge branch. The relevant Spec 022 delta is the two commits from the previously reviewed
Spec 021 head `f7dfec4927febcd712b5574940c5968b216a8bc8` to the current head.

The branch therefore contains:

- Spec 021 application-identity implementation;
- Spec 021 review follow-ups;
- Spec 022 data isolation and first-run copy workflow.

The unresolved elevated installed-Windows matrix from Review 021 remains a cumulative branch
blocker. This review concentrates on the new Spec 022 implementation.

## Confirmed by code reading

The implementation establishes several correct foundations:

- Stable and Beta default to `%USERPROFILE%\.cellxplorer` and
  `%USERPROFILE%\.cellxplorer-beta`, respectively.
- `CELLXPLORER_DATA` remains an exact override.
- Packaged backend startup rejects missing or unsupported channel values.
- Rust passes both `CELLXPLORER_CHANNEL` and the resolved `CELLXPLORER_DATA` to the sidecar.
- Data-folder and log-folder actions use the current edition's resolved root.
- Stable bootstrap endpoints return 404.
- The first-run modal is Beta-only, has no close button, and cannot be dismissed with Escape or an
  outside click.
- Copy is explicit; `Start empty` is available when Stable cannot be copied.
- The Stable database is opened read-only and copied through SQLite's backup API.
- The staged copy receives a new database-instance UUID.
- External source paths remain references; app-managed Stable imports are copied and rewritten.
- Caches, logs, backups and download history are not intentionally copied.
- The Tauri command accepts only a lowercase 32-character hexadecimal stage token.
- No migration revision or `CALC_VERSION` change was introduced.

These foundations should be preserved while addressing the findings below.

## Findings

### R1 — Critical: the Beta uninstaller's destructive option deletes the Stable data root

**Affected files**

- `src-tauri/cellxplorer-installer.nsi`
- installer contract tests
- `docs/windows-packaging.md`

### Current

The shared uninstaller UI always displays:

```text
%USERPROFILE%\.cellxplorer
```

and the destructive uninstall path always executes:

```nsis
RmDir /r "$PROFILE\.cellxplorer"
```

This code is used by both products. Therefore, selecting **Remove all CellXplorer Beta data** in the
Beta uninstaller deletes the Stable library and leaves `.cellxplorer-beta` behind.

This is a direct scientific-data-loss defect and reverses the central safety guarantee of Spec 022.

### Target

Define one exact channel/product-specific profile data directory in the NSIS template:

```text
CellXplorer      -> $PROFILE\.cellxplorer
CellXplorer Beta -> $PROFILE\.cellxplorer-beta
```

Use the resolved directory consistently for:

- the path displayed in the destructive-uninstall page;
- confirmation copy;
- the actual recursive deletion;
- any installer/uninstaller diagnostics or tests.

Do not infer it from a loose substring. Use the exact bundle identifier or another exact
build-time product constant.

The default **Keep my database and cached data** path must continue deleting neither root.

### Acceptance criteria

- Destructive Stable uninstall deletes only a disposable `.cellxplorer` root.
- Destructive Beta uninstall deletes only a disposable `.cellxplorer-beta` root.
- Each test root contains unique sentinel DB/import/cache files proving the other root was untouched.
- Default uninstall preserves both data roots.
- Installer tests assert the exact resolved data path for each product.
- Documentation describes the separate destructive-uninstall targets.
- The test is performed only with disposable data.

---

### R2 — High: apply failures can leave the frontend running with no backend

**Affected files**

- `src-tauri/src/main.rs`
- `src-tauri/src/beta_bootstrap.rs`
- `frontend/src/components/BetaBootstrapCoordinator.tsx`
- Rust lifecycle tests

### Current

`apply_beta_bootstrap` currently:

1. validates the stage;
2. stops the backend;
3. activates the staged database/imports;
4. schedules relaunch;
5. exits.

If activation fails after step 2, the command returns an error to the existing frontend while the
backend has already been killed.

If relaunch scheduling fails after activation, the command also returns while:

- the old backend is dead;
- the copied database may already be active;
- the success marker may already exist;
- the frontend displays a retryable setup error even though normal API calls cannot work.

The user is left in a half-transitioned process that may require manual termination.

### Target

Make the lifecycle non-returning once the backend is stopped.

A safe sequence must guarantee all of the following:

- relaunch capability is established before stopping the backend or changing live data;
- pre-stop validation failures return normally without changing anything;
- after backend stop, any activation failure restores the prior Beta state;
- after backend stop, the current process exits and a replacement process is launched even when
  activation fails;
- the next launch can display a durable, safe explanation when activation failed;
- the frontend never presents a normal retry button while its backend is known to be dead.

Do not use `AppHandle::restart()` because of the existing single-instance race.

### Acceptance criteria

- Simulated validation failure leaves the backend and live Beta data untouched.
- Simulated DB activation failure restores the previous Beta state and relaunches.
- Simulated import activation failure restores the previous Beta state and relaunches.
- Simulated relaunch-scheduling failure occurs before backend stop/data mutation.
- No post-stop code path returns to the existing frontend.
- A successful copy still performs one clean delayed relaunch.
- Tests prove lifecycle ordering rather than checking only helper return values.

---

### R3 — High: import activation is not atomic and rollback restores only the database

**Affected files**

- `src-tauri/src/beta_bootstrap.rs`
- Rust activation tests

### Current

`move_staged_imports()` renames top-level staged import entries into the live Beta imports directory
one at a time.

If an error occurs after one or more successful moves—for example, a later destination already
exists or marker writing fails—`activate_staged_copy()`:

- removes the newly activated database;
- restores the rollback database;
- does not move already activated imports back into staging;
- does not remove those partial live imports.

The Beta root is then no longer pristine, the staged snapshot is incomplete, and retry may be
blocked. The existing failure test conflicts on the first item, so it does not exercise partial
activation.

### Target

Treat database, imports and marker as one recoverable transition.

Use either:

- an atomic directory-swap design for the complete imports tree; or
- a durable rollback journal that records every moved path and reverses all moves on failure.

Required ordering:

1. validate everything;
2. preserve current DB/import state;
3. activate staged DB and complete staged imports;
4. write the marker last;
5. remove rollback material only after all steps succeed.

On any failure, the exact pre-apply Beta state must be restored and the complete stage retained for
diagnosis or retry.

### Acceptance criteria

- Failure after the first of multiple import moves leaves no partial live imports.
- Marker-write failure restores both database and imports.
- Existing live import directories are never merged partially.
- Successful activation preserves nested import hierarchy.
- The stage remains complete after a failed activation.
- Tests compare the complete pre/post filesystem tree, not only the live DB file.

---

### R4 — High: the mandatory first-run safety gate fails open while status loads or errors

**Affected files**

- `frontend/src/components/BetaBootstrapCoordinator.tsx`
- `frontend/src/betaBootstrapPolicy.ts`
- `backend/app/services/beta_bootstrap.py`
- frontend component/policy tests

### Current

The bootstrap coordinator opens the modal only when the status response says `needsChoice: true`.

Consequences:

- while the status request is loading, no modal is shown and the normal Beta UI is usable;
- if the status request fails, no modal or blocking error is shown;
- a corrupt `beta-bootstrap.json` becomes `blockingReason` with `needsChoice: false`, so the frontend
  renders no setup surface at all;
- users can begin interacting with a supposedly pristine Beta library before making the required
  Copy/Start-empty decision.

The backend status response also conflates a corrupt marker with copy unavailability instead of
returning an explicit setup-state error.

### Target

For installed Beta, setup must fail closed until a safe terminal status is known.

Introduce an explicit status model, such as:

```text
loading
choice-required
complete
blocked-error
```

Rules:

- `loading` shows a non-dismissible setup modal or full blocking surface;
- `choice-required` shows Copy/Start empty;
- `complete` removes the gate;
- status/network/marker errors show a blocking error with Retry and data/log-folder diagnostics;
- corrupt marker metadata must never silently permit normal library use;
- Stable remains entirely unaffected.

### Acceptance criteria

- Initial Beta render is blocked before the status response completes.
- Network/500 status failure remains blocked and offers Retry.
- Corrupt/unsupported marker remains blocked with a clear recovery message.
- Completed `copied` or `empty` marker removes the gate.
- Stable never renders or requests bootstrap UI.
- Component tests cover loading, error, corrupt-marker, choice and completed states.
- No normal Beta route action can run before setup reaches `complete` or the user makes a choice.

---

### R5 — High: staged data is trusted without complete integrity and live-state validation

**Affected files**

- `backend/app/services/beta_bootstrap.py`
- `src-tauri/src/beta_bootstrap.rs`
- staging/apply tests

### Current

The backend validates the staged SQLite database and managed imports while creating them, but the
manifest contains no staged database digest or import inventory/digests.

The Rust apply command later validates only:

- token shape;
- manifest schema/token;
- expected staged database filename;
- the presence of the staged DB.

It does not verify:

- staged DB integrity or checksum;
- the expected copied-import inventory and checksums;
- unexpected files;
- symlinks inside staged DB/import paths;
- whether the live Beta database/imports are still pristine immediately before overwrite.

The stage exists on disk between HTTP staging and Tauri activation. A corrupted/tampered stage or a
race that creates Beta content can therefore reach destructive activation.

### Target

Publish a self-verifying manifest containing at least:

- SHA-256 and byte size of the staged DB;
- a normalized list of staged managed imports with relative path, size and SHA-256;
- expected import count;
- source instance/revision;
- token and schema version.

During apply, after stopping the backend but before changing live files:

- reject symlinks and any path outside the canonical Beta stage root;
- verify the entire manifest, DB digest and import inventory;
- run or invoke a reliable SQLite integrity check;
- verify the current live Beta root is still pristine and has no completed marker;
- reject unexpected staged content;
- mutate nothing when validation fails.

### Acceptance criteria

- Modified staged DB bytes are rejected before live mutation.
- Modified, missing or extra staged imports are rejected.
- A staged symlink is rejected.
- A stage path escaping the Beta root is rejected.
- A newly non-pristine live Beta library is not overwritten.
- Manifest counts and file inventory must match exactly.
- Failed validation leaves backend/live data unchanged or follows the safe relaunch behavior from R2.

---

### R6 — Medium: a successfully staged copy can become unretryable and abandoned stages are unbounded

**Affected files**

- `backend/app/services/beta_bootstrap.py`
- `frontend/src/components/BetaBootstrapCoordinator.tsx`
- staging cleanup/retry tests

### Current

After successful staging:

- `_active_stage_token` remains set until the process is stopped;
- the frontend does not retain a retryable staged-token state;
- if the Tauri invoke fails before process shutdown, clicking Copy again calls `stage-copy`, which
  returns 409 because a stage is already active;
- there is no resume/discard endpoint.

Stale cleanup skips:

- the newest directory; and
- every directory containing a completed `manifest.json`.

Therefore, completed but abandoned stages—including copied source files—can remain indefinitely.

### Target

Model staged-copy ownership explicitly.

Required behavior:

- retain the returned token in frontend state until activation succeeds or the user discards it;
- retry activation with the same token rather than restaging;
- add a narrow discard/recovery operation if needed;
- reconcile the process lock with an existing valid manifest after restart;
- keep at most the newest retryable failed stage;
- remove consumed stages after successful activation;
- remove older abandoned completed/incomplete stages after the bounded retention period;
- never delete a stage currently being applied.

### Acceptance criteria

- A pre-stop Tauri invoke failure can retry the same token successfully.
- Retry does not issue another `stage-copy`.
- Process restart can recognize a valid outstanding stage safely.
- Consumed stage directories are removed after success.
- Old manifest-bearing stages are cleaned according to the retention policy.
- The newest failed stage remains available for retry/diagnostics.
- No endless 409 loop is possible.

---

### R7 — Medium: Stable compatibility classification accepts insufficiently recognized databases

**Affected files**

- `backend/app/services/beta_bootstrap.py`
- compatibility fixtures/tests

### Current

`inspect_stable_database()` considers a database compatible when:

- integrity passes;
- at least one non-system table exists;
- no readable numeric revision is greater than the current revision.

It does not require the canonical CellXplorer core tables or verify that the revision belongs to the
packaged migration registry.

A partial/unrelated SQLite database or an unsupported nonnumeric revision can be reported as
compatible and offered for copying, only to fail later during direct SQL against
`app_settings`/`source_files`.

### Target

Reuse or extract the canonical database-recognition policy.

A copyable Stable database must:

- pass full integrity check;
- contain the required CellXplorer core tables;
- have a recognized current/older revision or satisfy the repository's explicitly supported legacy
  policy;
- reject unknown revision identities;
- distinguish corrupt, unrecognized and too-new states in the status response.

Do not duplicate migration application in the bootstrap service.

### Acceptance criteria

- Random SQLite DB is `unrecognized`.
- Partial CellXplorer schema is `unrecognized`.
- Unknown revision is `unrecognized`.
- Future revision is `too new`.
- Supported legacy/current databases are copyable.
- Status and `stage-copy` return consistent classifications/messages.

---

### R8 — Medium: managed imports are copied through unbounded whole-file memory reads

**Affected files**

- `backend/app/services/beta_bootstrap.py`
- managed-import copy tests

### Current

Each managed import is loaded with `source_path.read_bytes()` and then written with
`target.write_bytes()`.

Large `.nda`/`.ndax` files can consume their full size in memory, and repeated files can produce
large transient allocations during an already expensive first-run operation.

### Target

Copy managed imports with bounded chunks while computing SHA-256 and byte count in one pass.

- write to a temporary target;
- flush and close it;
- verify size/checksum;
- atomically rename it into the staged import tree;
- remove partial temporary files on failure.

Do not parse source files.

### Acceptance criteria

- Copy memory use is bounded independently of source size.
- Size/hash verification still occurs.
- Simulated interrupted copy leaves no final partial file.
- Nested paths remain unchanged.
- Tests use a multi-chunk fixture and checksum-failure case.

---

### R9 — High: required verification and implementation record are incomplete

**Affected files**

- `docs/specs/022-beta-data-isolation.md`
- `docs/specs/reviews/022-beta-data-isolation-review.md`
- backend/frontend/Rust tests
- installed Windows verification record

### Current

The spec is marked **complete**, but:

- its acceptance checklist is entirely unchecked;
- it contains no command-result implementation record;
- the required review file did not exist at the reviewed head;
- the head has no attached combined status checks or workflow runs;
- several tests explicitly required by the spec are absent.

Missing or materially incomplete automated coverage includes:

- corrupt, unrecognized and future Stable DBs;
- live concurrent SQLite backup behavior;
- external path preservation;
- checksum mismatch;
- excluded cache/log/backup/history content;
- stale-stage cleanup;
- complete router HTTP contracts;
- status loading/error component behavior;
- frontend stage/apply/retry sequence;
- Rust partial-import rollback;
- staged tampering and non-pristine live-state rejection.

The automated results recorded in Review 021 predate the Spec 022 commit and do not verify the new
implementation. Review 021's elevated installed-Windows matrix also remains incomplete.

### Target

After R1–R8:

1. add the missing contract/failure-path tests;
2. run and record the exact Spec 022 commands;
3. perform the disposable Stable/Beta copy matrix in installed applications;
4. complete the still-pending relevant Spec 021 installed checks;
5. update the Spec 022 status/checklist only for checks actually completed.

### Acceptance criteria

Record exact results for:

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

Also record the installed disposable matrix:

- Stable and Beta run simultaneously from different data roots.
- The blocking first-run modal appears before normal Beta use.
- Copy preserves Stable DB hash, UUID and contents.
- Beta receives a new UUID.
- external paths remain references;
- managed imports are copied and rewritten;
- caches begin empty;
- edits in either edition do not affect the other;
- Start empty does not prompt again;
- data/log folder buttons open the correct roots;
- default uninstall preserves both roots;
- destructive Stable/Beta uninstall deletes only its own disposable root;
- no production tag or release is created.

## Additional documentation correction

`docs/windows-packaging.md` still states that both editions share `.cellxplorer` until Spec 022.
That statement is now stale on this branch and must be replaced with the implemented root matrix.
The uninstaller section must also describe the product-specific destructive data target from R1.

## Verification record

### Implementer reported

- Commit `67edf2682160461e7c7947112abc4bc82f1b538a` reports implementation of the isolated Beta root,
  bootstrap API, Tauri apply command and blocking setup modal.
- The Spec 022 document is marked complete.
- No Spec 022 command results or installed-Windows observations were recorded.
- Review 021 records earlier automated checks and installer builds, but those occurred before the
  Spec 022 implementation and cannot establish this feature's correctness.

### Reviewer independently inspected

- branch/base/merge-base and cumulative branch scope;
- Spec 022 and its acceptance criteria;
- Python channel/data-root resolution;
- packaged sidecar environment and startup validation;
- bootstrap service/router;
- SQLite staging, instance UUID and managed-import path rewriting;
- Rust token validation, stage validation, activation and rollback;
- Tauri lifecycle/relaunch command;
- frontend blocking-modal policy and coordinator;
- frontend/backend/Rust test coverage;
- custom NSIS uninstall behavior;
- durable architecture and packaging documentation;
- commit status and attached workflow runs.

### Reviewer independently ran

No repository commands, installer builds or Windows manual checks were run. The review is based on
the remote GitHub branch and executable-code inspection. The reviewed head has no attached status
checks or workflow runs.

## Follow-up order

1. R1 — fix the destructive Beta uninstall data target.
2. R2 — make bootstrap apply lifecycle non-returning and recoverable after backend stop.
3. R3 — make database/import/marker activation transactional.
4. R4 — make the first-run gate fail closed.
5. R5 — verify the complete staged payload and live pristine state.
6. R6 — add retry/discard and bounded stage cleanup.
7. R7 — harden Stable database recognition.
8. R8 — stream managed imports.
9. R9 — add missing tests and perform the full verification matrix.

## Merge decision

**Not ready to merge.**

R1 can delete the user's Stable scientific library from the Beta uninstaller. R2–R5 can leave Beta
in a partially activated or backend-dead state, and the first-run gate currently fails open during
status errors. These are release-blocking defects.

Do not start Spec 023, merge the cumulative branch, or publish either channel until this review is
implemented and re-reviewed. The existing pending elevated Review 021 Windows matrix must also be
completed before merge.

## Implementation record (R1–R9)

Implementer head after follow-ups: pending push on `feature/stable-beta-app-identities`.  
Reviewed head addressed: `67edf2682160461e7c7947112abc4bc82f1b538a`.

### R1–R8 summary

| ID | Change |
|---|---|
| R1 | NSIS `CX_PROFILE_DATA_DIR` from exact `BUNDLEID`; Beta deletes only `.cellxplorer-beta`. Docs + installer contract tests updated. |
| R2 | `apply_beta_bootstrap` validates → schedules relaunch → stops backend → activates → exits. Never returns a post-stop error to the frontend. Apply-failure marker written on activation failure. |
| R3 | Whole-tree imports swap with `imports.bootstrap-rollback`; DB/imports/marker restored together; stage retained for retry. |
| R4 | Fail-closed setup states `loading` / `choice-required` / `complete` / `blocked-error`; corrupt marker and status errors block normal use. |
| R5 | Manifest carries DB digest/size and import inventory; Rust verifies digests, integrity, inventory, symlinks, unexpected files, and live pristine state before mutation (re-checks after backend stop). |
| R6 | Outstanding stage token in status; frontend retries same token; `POST /discard-stage`; bounded cleanup keeps newest retryable stage. |
| R7 | Stable inspection reuses migration recognition (`REVISION_BY_ID`, core tables, legacy policy) without migrating. |
| R8 | Managed imports copied in 1 MiB chunks via temp + atomic rename with hash/size verification. |

### Commands actually run

```text
python -m unittest tests.test_app_channels tests.test_beta_bootstrap tests.test_database_migrations -v
→ Ran 49 tests — OK

node --test frontend\tests\betaBootstrap.test.ts frontend\tests\appChannel.test.ts
→ 11 passed

cargo test --manifest-path src-tauri\Cargo.toml
→ 34 passed

cargo check --manifest-path src-tauri\Cargo.toml
→ Finished (warnings only for test-only helpers)

python scripts\preflight.py --no-cache
→ PREFLIGHT PASSED — 5/5 stages
```

Frontend `npx tsc --noEmit` and `npm.cmd run build` were exercised inside preflight (PASS).

### Installed Windows matrix

Not executed in this session:

- Per-machine NSIS silent install requires elevated UAC consent and was not automated.
- Destructive uninstall was **not** run against any profile data root (production or disposable
  `$PROFILE` path). Channel-specific delete targets are covered by NSIS template contract tests
  (`tests.test_app_channels.test_nsis_destructive_uninstall_targets_channel_specific_data_root`).
- Simultaneous Stable/Beta installed-run, first-run modal on installed Beta, and data/log folder
  open checks remain pending the elevated disposable matrix (same gap as Review 021).

No tags, publishes, merges, or Spec 023 work were started.

## Composer handoff

```text
Implement docs/specs/reviews/022-beta-data-isolation-review.md on
feature/stable-beta-app-identities.

Read this review first, then Spec 022 and Review 021.

Complete R1–R9 in order. Preserve the confirmed separate data roots, explicit
first-run choice, SQLite backup, new database UUID, external-path behavior and
temporary Beta updater gate.

Critical safeguards:
- The Beta uninstaller must never delete .cellxplorer.
- Once apply_beta_bootstrap stops the backend, it must never return to the
  existing frontend.
- DB, imports and marker must roll back as one transition.
- Installed Beta must remain blocked until setup status is safely known.
- Never overwrite a newly non-pristine Beta root.
- Retain/retry a completed stage instead of creating an endless 409 loop.

Use only disposable Stable/Beta roots for destructive and installed tests.
Do not tag, publish, merge or start Spec 023 until the branch is re-reviewed.
Record every command and manual check actually performed.
```
