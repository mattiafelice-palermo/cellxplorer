# Review 017: Secure Tauri updater foundation

Branch: `feature/updater-017-019`  
Reviewed head: `5ad0cc7c9796c300f3ee82119bb3fbfaa202ef8a`  
Base and merge base: `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`  
Cumulative scope: one commit ahead of `main`  
Status: **follow-ups addressed** (awaiting re-review)

## Assessment

The implementation follows the intended architecture: the official Tauri updater plugin owns signed
checks, verified downloads and installer launch; FastAPI and scientific data are not involved; the
webview receives only narrow custom commands; the existing Python-sidecar cleanup is attached to
`on_before_exit`; and the NSIS template accepts both update flags.

The foundation is not usable yet. The managed-state type does not match the type requested by the
commands, so every updater command will fail when invoked. The pending-update transition helpers
also mutate state before validating it and do not protect an in-flight download from a concurrent
check or install, which can lose the pending update or associate installer bytes with the wrong
release.

The branch scope is clean. Specs 018 and 019 and their assets are documentation-only additions on
the intentionally shared branch, not unrelated implementation.

## Confirmed

- `tauri-plugin-updater` is added and the lockfile is updated.
- `createUpdaterArtifacts`, the HTTPS endpoint, the committed public key and `basicUi` are configured.
- No direct `updater:*` capability is granted to the webview.
- `check_app_update`, `download_app_update` and `install_app_update` are the only updater commands.
- `Update::download` is used for signature verification before bytes are stored.
- No standard mutex guard is held across the download `await`.
- Every checked `Update` receives the `on_before_exit` hook.
- The hook sets the quitting state and calls the existing backend process-tree cleanup.
- Check and download do not intentionally stop the backend.
- The custom installer recognizes `/UPDATER` and `/UPDATE`.
- No migration, `CALC_VERSION`, database, Parquet or scientific-data change is present.

## Follow-ups

### R1 — High: the updater commands request a managed state type that is never registered

**Affected files**

- `src-tauri/src/main.rs`
- `src-tauri/src/app_updates.rs`
- `tests/test_updater_configuration.py`

### Current

`main.rs` registers:

```rust
.manage(PendingAppUpdate::default())
```

All three commands request:

```rust
State<'_, Mutex<PendingAppUpdate>>
```

Tauri resolves managed state by its exact Rust type. `PendingAppUpdate` and
`Mutex<PendingAppUpdate>` are different managed types, so command invocation cannot resolve the
requested state and fails before the command body runs.

The current configuration test checks only that the text `PendingAppUpdate` exists, so it does not
detect this mismatch.

### Target

Register the exact state type consumed by the commands:

```rust
.manage(Mutex::new(PendingAppUpdate::default()))
```

Add a focused regression check that fails if the registration and command state types diverge.

### Acceptance criteria

- All three updater commands resolve their managed state in a Tauri runtime.
- `main.rs` manages `Mutex<PendingAppUpdate>`, not the bare struct.
- A focused test fails when the mutex wrapper is removed or the command state type changes.
- `cargo test` and `cargo check` pass.

---

### R2 — High: invalid or concurrent calls can destroy or mix pending-update state

**Affected file**

- `src-tauri/src/app_updates.rs`

### Current

`take_verified_install()` calls `pending.update.take()` before it has established that:

- the requested version matches;
- verified bytes exist;
- no download is still running.

Consequences:

- a wrong expected version removes the pending update;
- install before download completion removes the update and then fails for missing bytes;
- `AlreadyDownloading` is mapped by `install_app_update`, but `take_verified_install()` can never
  return it;
- retry requires another network check instead of preserving the valid pending state.

There is also no identity guard around download completion. A download clones update A and releases
the mutex. While it is running, `check_app_update` can replace or clear the managed state. When the
old download completes, `finish_download_success()` stores A's verified bytes into whatever state
exists at that moment. This can pair bytes for release A with the `Update` metadata for release B,
or leave verified bytes with no pending update.

### Target

Make validation and mutation atomic at the policy level.

- Validate `downloading`, expected version, pending update and verified bytes before taking anything.
- Preserve the complete state on every rejected install.
- Prevent a check from replacing state during an active download, or attach a generation/token to
  the download and discard completion when the generation no longer matches.
- Store downloaded bytes only when they still belong to the same pending update/version.
- Reject install while download is active.
- Keep one-time consumption only for the valid install path.

Extract testable state-transition helpers as needed; do not require a real updater server or
installer in unit tests.

### Acceptance criteria

Tests cover all of the following:

- wrong-version download/install is rejected without changing pending state;
- install with missing bytes leaves the update available for download;
- install during a download is rejected without mutation;
- a stale download completion cannot populate a replaced or cleared pending state;
- verified bytes can never be associated with a different version;
- download failure leaves the same update retryable;
- a valid update and its bytes can be taken exactly once;
- a pre-launch install error restores the matching update and bytes.

---

### R3 — Medium: the documented Windows installer-launch recovery path is not provided by Tauri 2.10

**Affected files**

- `src-tauri/src/app_updates.rs`
- `docs/specs/017-secure-tauri-updater-foundation.md`
- `docs/specs/018-in-app-update-experience.md`
- `docs/windows-packaging.md`
- `docs/agent-knowledge/architecture.md`

### Current

The specifications imply that an installer-launch failure can return to the frontend while the
backend remains alive.

In `tauri-plugin-updater` 2.10.1 on Windows, the upstream implementation:

1. extracts/prepares the installer;
2. runs `on_before_exit`;
3. calls `ShellExecuteW`;
4. does not inspect the `ShellExecuteW` result;
5. calls `std::process::exit(0)`.

Therefore:

- errors before `on_before_exit` can return and the current restoration branch is useful;
- once `on_before_exit` runs, CellXplorer and the backend exit regardless of whether Windows
  successfully opens the installer;
- the frontend cannot show the Spec 018 post-launch recovery modal described for that case.

Official source anchor:

`https://docs.rs/crate/tauri-plugin-updater/2.10.1/source/src/updater.rs`

### Target

Document the real boundary and design Spec 018 around it.

Do not invent a custom installer launcher in this follow-up. A requirement to verify successful
Windows process launch would need a separate product/architecture decision because it changes the
locked official-updater installation path.

### Acceptance criteria

- Documentation distinguishes pre-hook install errors from the post-hook Windows launch path.
- The pre-hook error path preserves/retries state.
- No document claims the backend remains alive after `on_before_exit`.
- Spec 018 does not require UI recovery after the updater has entered the Windows launch/exit path.
- The frontend treats a successful Windows install invocation as non-returning.

---

### R4 — Medium: required implementation and packaging verification is not recorded

**Affected files**

- `docs/specs/017-secure-tauri-updater-foundation.md`
- `docs/specs/reviews/017-secure-tauri-updater-foundation-review.md`

### Current

Spec 017 remains marked **planned**, its acceptance checklist is unchecked, and it has no
implementation record. The commit does not record test commands or results. No GitHub status checks
are attached to the reviewed head.

The specification requires a signed local package check and a disposable `/UPDATER` installer smoke
test because updater artifacts and the custom NSIS template changed. There is no evidence that
either was performed.

### Target

After R1–R3, record the implementation and the exact verification actually performed. Do not mark a
live end-to-end update as verified unless an N → N+1 update was genuinely exercised later.

### Acceptance criteria

Record results for:

```powershell
python -m unittest tests.test_updater_configuration -v
python scripts\preflight.py
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
```

Also record:

- signed local `build-app.cmd` result;
- presence of the NSIS setup executable and adjacent `.sig`;
- disposable installer smoke test using the update argument accepted by the pinned plugin;
- explicit confirmation that the private key/password are absent from the repository;
- anything not run, stated plainly.

Update the Spec 017 status and checklist to match the evidence.

---

### R5 — Low: the repository spec guide still directs reviews into the specification file

**Affected file**

- `docs/specs/README.md`

### Current

The branch uses the current separate-review convention and Spec 017 points to:

```text
docs/specs/reviews/017-secure-tauri-updater-foundation-review.md
```

However, the Lifecycle and handoff sections of `docs/specs/README.md` still tell agents to append the
review and R tasks to the same specification file. This directly contradicts the current convention
and can send Composer to the wrong document.

The branch already edits this README, so leaving the known discrepancy in place is avoidable.

### Target

Update the lifecycle and handoff text to use the separate review file while keeping implementation
records in the appropriate canonical documents.

### Acceptance criteria

- Review findings are read from `docs/specs/reviews/NNN-...-review.md`.
- The handoff prompt points Composer to the review file and tells it to read the linked spec.
- The guidance no longer instructs agents to append review findings to the spec.
- The Spec 017 index and review link remain correct.

## Follow-up order

1. R1 — fix the unusable command state registration.
2. R2 — make updater state transitions atomic and version-bound.
3. R3 — correct the Windows launch/error contract before implementing Spec 018.
4. R4 — run and record the required verification.
5. R5 — reconcile the spec workflow documentation.

## Merge readiness

**Not ready to treat Spec 017 as complete.**

Do not implement the Spec 018 frontend against the current command layer: the commands cannot
resolve their state, and their transition rules are not safe under invalid or overlapping calls.
After R1–R5 are addressed, review Spec 017 again before continuing with the UI.

The shared branch is also not intended to merge until Specs 018 and 019 are complete.

## Verification record

### Implementer reported

No implementation record or command results are present in the branch.

### Reviewer independently performed

- Confirmed branch `feature/updater-017-019`.
- Confirmed reviewed head `5ad0cc7c9796c300f3ee82119bb3fbfaa202ef8a`.
- Confirmed merge base `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`.
- Confirmed the branch is one commit ahead and contains no unrelated implementation.
- Read the complete Spec 017 and the changed Rust, Tauri config, NSIS, test and documentation files.
- Cross-checked Tauri managed-state type resolution against the official Tauri API documentation.
- Cross-checked `Update::download`, `Update::install` and the Windows `on_before_exit`/launch path
  against `tauri-plugin-updater` 2.10.1 source.
- Confirmed no status checks are attached to the reviewed commit.
- Did not execute repository commands or build/launch the Windows installer in the reviewer
  environment.

## R* implementation record

Status after follow-ups: **addressed** (awaiting re-review).

### R1

- Registered `.manage(Mutex::new(PendingAppUpdate::default()))` in `main.rs`.
- Added `tests.test_updater_configuration.UpdaterConfigurationTests.test_pending_update_state_is_managed_as_mutex`.

### R2

- Validated install readiness before taking state; wrong version / missing bytes / active download
  preserve pending state.
- Added download generation tokens; stale completions cannot populate replaced state.
- Blocked check/clear while a download is active.
- Expanded Rust unit tests in `src-tauri/src/app_updates.rs`.

### R3

- Documented the pre-hook vs post-hook Windows boundary in Specs 017/018,
  `docs/windows-packaging.md`, and `docs/agent-knowledge/architecture.md`.
- Frontend treats successful Windows install invocation as non-returning.

### R4

Recorded below under Verification after follow-ups.

### R5

- Updated `docs/specs/README.md` Lifecycle and handoff prompt to use separate review files under
  `docs/specs/reviews/`.

### Verification after follow-ups

```powershell
cargo test --manifest-path src-tauri\Cargo.toml
# 16 passed

python -m unittest tests.test_updater_configuration -v
# 10 passed

python scripts\preflight.py --no-cache
# PREFLIGHT PASSED — 5/5 stages completed successfully
```

Not run in this follow-up pass (stated plainly):

- signed local `build-app.cmd` with `TAURI_SIGNING_PRIVATE_KEY` (requires local signing secrets);
- disposable `/UPDATER` installer smoke test;
- live N → N+1 packaged update.

Confirmed: private updater key/password are absent from the repository.
