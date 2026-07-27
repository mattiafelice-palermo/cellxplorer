# Cumulative Review 017–019: CellXplorer in-app updater

Branch: `feature/updater-017-019`  
Reviewed head: `338a4908a2c87548edc5082e737288365b535ab3`  
Base and merge base: `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`  
Cumulative branch scope: six commits ahead of `main`  
Status: **R1–R6 code follow-ups addressed; R7 packaged/visual/workflow verification still open — not ready to merge or tag**

Reviewed specifications:

- Spec 017 — Secure Tauri updater foundation
- Spec 018 — In-app update experience
- Spec 019 — Automated GitHub release publishing

This review consolidates the unresolved Round 2 findings for Specs 017 and 018 and the re-review of
the hardened Spec 019 implementation. Use this file as the next Composer handoff; do not work from
the earlier individual review files independently.

## Overall assessment

The architecture is now close to the intended design:

- Tauri owns signed update checks, verified download bytes, installer launch and Python-sidecar exit.
- The frontend exposes a restrained power-menu badge and one-modal download/install flow.
- The release workflow uses pinned actions, exact stable tags, `main` ancestry, public-host gating,
  draft staging, immutable published releases and post-upload manifest validation.
- No database, Parquet, cache, migration or scientific-calculation behavior is changed.

The branch is still not safe to release. One cross-layer check/download race can discard verified
installer bytes. An immediate installer-command failure can be shown as a retryable download error.
The release workflow can run concurrently against the same draft, and its staged-asset verification
still validates local/metadata representations rather than the actual uploaded manifest and
signature contents. The signing secret has also not been proven to match the public key embedded in
installed clients.

## Confirmed resolved

### Spec 017

- `Mutex<PendingAppUpdate>` is registered as the exact Tauri managed-state type.
- Invalid install calls validate before consuming update state.
- Download completions are generation- and version-bound.
- Replacement/clear is blocked while `downloading` is true.
- Pre-hook and post-hook Windows updater behavior is documented correctly.
- Separate review-file workflow documentation is corrected.

### Spec 018

- Progress accumulation occurs inside the reducer and preserves rapid channel events.
- Unknown-size downloads use striped animated progress without a fake percentage.
- Safe Rust/Tauri string errors are preserved.
- Teal update and amber automation indicators use different positions and accessible naming.
- Mixed plain-text and bullet release notes preserve their individual structure.
- Automatic check failures preserve a known update.

### Spec 019

- `latest.json` discovery matches the pinned Tauri action's workspace-root output.
- Tauri action v1 API asset URLs are resolved against release-asset metadata.
- Publishing is staged as a draft and undrafted only after verification.
- Manual dispatch is build-only.
- Stable tags are restricted to `vMAJOR.MINOR.PATCH` and must point into `main` history.
- Published releases are guarded against replacement.
- Third-party actions are pinned to full commit SHAs.
- Private repositories are blocked from stable publishing.
- The ordinary preflight workflow no longer duplicates tag release builds.

## Remaining findings

### R1 — High: a check already in flight can erase a completed verified download

**Affected files**

- `src-tauri/src/app_updates.rs`
- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/appUpdater.ts`
- Rust and frontend updater tests

### Current

`check_app_update()` checks `pending.downloading` before awaiting the network request, but does not
bind its eventual result to the pending-state revision observed at check start.

A real sequence remains possible:

1. Update A is already available.
2. An automatic check starts while the modal is closed.
3. The user opens the modal and downloads A while that check is awaiting the network.
4. Download A completes and verified bytes are stored; `downloading` becomes false.
5. The older check returns and is now allowed to replace or clear pending state.
6. The verified bytes are removed immediately before install.

The frontend contributes to the race because an automatic `check_started` action preserves the
`available` state, and `downloadAndLaunchInstaller()` does not await an existing check.

### Target

- Add a monotonic Rust pending-state revision/check token.
- Capture it before `updater.check().await` and apply the result only if the revision still matches.
- Increment the revision when download/install or another material pending-state transition begins.
- A stale check must leave the current update and verified bytes untouched.
- If an automatic check finishes after the modal opened or a protected flow began, ignore its result.
- Before download, await any existing check, re-read current state and revalidate the selected
  release.

### Acceptance criteria

- Stale `None`, same-version and newer-version check results cannot discard verified bytes.
- A non-stale check still replaces/clears pending state normally.
- Opening the modal while an automatic check is running prevents that result from closing or
  replacing the modal.
- Normal UI flow never overlaps `check_app_update` and `download_app_update`.
- Rust and frontend tests reproduce the exact sequence above.

---

### R2 — High: release runs for the same tag are not serialized

**Affected files**

- `.github/workflows/release.yml`
- `tests/test_release_workflow.py`
- release documentation

### Current

The workflow has no `concurrency` group. Two runs for the same tag can pass the initial release guard
before either creates the draft. Both may then create/find and replace assets in the same draft.
The pinned Tauri action deliberately deletes matching draft assets before uploading replacements,
so overlapping runs can mix installer, signature and manifest state or publish while the other run
is still mutating the draft.

### Target

Add workflow-level concurrency keyed by workflow and ref/tag, with release runs serialized rather
than canceled mid-publish. For example, use the equivalent of:

```yaml
concurrency:
  group: cellxplorer-release-${{ github.ref }}
  cancel-in-progress: false
```

A second run should wait. If the first publishes successfully, the second must then fail the existing
non-draft release guard without modifying assets. If the first leaves a draft, the second may resume
that draft.

### Acceptance criteria

- Only one release workflow for a specific tag/ref can mutate the draft at a time.
- An in-progress publisher is not canceled after creating a draft.
- A queued rerun after successful publication fails before the Tauri action.
- A queued rerun after a failed draft may resume safely.
- Workflow tests enforce the concurrency group and `cancel-in-progress: false`.

---

### R3 — High: updater signing identity is not proven against the embedded public key

**Affected files**

- `.github/workflows/release.yml`
- `scripts/verify_updater_manifest.py` or a focused signing-identity helper
- `src-tauri/tauri.conf.json`
- release tests and documentation

### Current

The workflow verifies only that `TAURI_SIGNING_PRIVATE_KEY` is non-empty. Tauri can successfully
produce updater signatures with a valid but different private key from the public key embedded in
CellXplorer. Such a release builds and publishes, but installed clients reject it with a key-ID or
signature error.

The repository cannot inspect GitHub's secret, and no build-only workflow or recorded check proves
that the staged `.sig` belongs to the configured public key.

### Target

Before final undraft, verify the signing identity of the generated updater signature against the
public key in `src-tauri/tauri.conf.json`.

A small acceptable safeguard is to parse the minisign key ID from the configured public key and from
the generated `.sig` and require equality. A full cryptographic verification of the setup executable
and signature with the embedded public key is stronger. Do not print or persist the private key.

### Acceptance criteria

- A signature produced by a different valid private key fails before publication.
- The committed public key is read from the actual Tauri configuration.
- The check uses generated/staged signature data, not a hardcoded expected ID.
- Tests cover matching and mismatched key identities.
- No private-key content or password appears in logs or artifacts.

---

### R4 — Medium: an immediate install-command error can be misclassified as a download failure

**Affected files**

- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/tests/appUpdater.test.ts`

### Current

After verified download, `runDownload()` dispatches `launching` and then classifies an outer error by
checking `stateRef.current.status === "launching"`.

`stateRef.current` updates after React renders. If `install_app_update` rejects immediately, the ref
can still say `downloading`, and the failure is shown as `error/download`. The user then receives
**Later / Retry download** instead of the required non-dismissible **Restart CellXplorer** recovery
after `/api/session/finish` may already have closed the diagnostic session.

### Target

Track the async operation phase locally inside `runDownload()`. Once download resolves, set the local
phase to install/launch and use it in the catch block. Do not infer control-flow phase from React
render timing.

### Acceptance criteria

- Download-command rejection produces `error/download`.
- Immediate install-command rejection produces `error/install` even with a stale state ref.
- Install errors remain non-dismissible and offer only full-app restart.
- A focused test exercises immediate rejection timing.

---

### R5 — Medium: staged release verification does not verify the uploaded manifest/signature contents

**Affected files**

- `.github/workflows/release.yml`
- `scripts/verify_updater_manifest.py`
- `tests/test_release_workflow.py`

### Current

The workflow validates the local `$GITHUB_WORKSPACE/latest.json` and a JSON list of draft asset
metadata. It proves that an installer asset ID/name and a `.sig` filename exist, but it does not:

- require a `latest.json` asset in the draft metadata;
- download and validate the actual uploaded draft `latest.json`;
- prove that the inline manifest signature equals the uploaded `.sig` contents.

The final undraft therefore relies on the pinned action's upload implementation rather than
validating the exact staged bytes that clients will consume.

### Target

While the release is still draft:

1. locate `latest.json` and the matching `.sig` by release-asset ID/name;
2. download both through the authenticated draft asset API;
3. validate the downloaded `latest.json` as the release manifest;
4. require its signature text to equal the downloaded `.sig` contents;
5. retain the existing installer asset-ID/name and version/notes checks.

### Acceptance criteria

- Missing uploaded `latest.json` fails.
- A stale or altered uploaded manifest fails even if the local manifest is correct.
- An uploaded `.sig` differing from `latest.json.platforms[...].signature` fails.
- Wrong installer asset ID/name, notes, version or repository still fails.
- Tests use offline fixtures representing downloaded draft assets.

---

### R6 — Low: bullet release notes use `<li>` outside a list container

**Affected file**

- `frontend/src/components/AppUpdateModal.tsx`

### Current

Bullet lines render as `component="li"` directly inside a Mantine `Stack`, not inside `<ul>` or
`<ol>`. The bullet is visually correct, but the HTML list structure is invalid and may not be
announced correctly by assistive technology.

### Target

Render consecutive bullet runs inside a real `<ul>`, or render decorative bullet rows without using
`<li>`. Preserve mixed text/bullet order and compact spacing.

### Acceptance criteria

- Every `<li>` is inside `<ul>` or `<ol>`.
- Mixed notes preserve order and plain-text safety.
- Repeated lines keep stable keys.
- The bounded release-note scroll area is unchanged.

---

### R7 — Medium: required packaged, visual and workflow verification remains incomplete

**Affected files**

- Specs 017–019
- their review/implementation records
- release and project-context documentation

### Current

Implementer-reported checks:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml
# 16 passed

node --test frontend\tests\appUpdater.test.ts
# 19 passed

python -m unittest tests.test_updater_configuration -v
# 10 passed

python -m unittest tests.test_release_notes_script tests.test_release_workflow -v
# 25 passed

python scripts\check_versions.py
# PASS: all version declarations match 0.15.0

python scripts\preflight.py --no-cache
# PREFLIGHT PASSED — 5/5 stages completed successfully
```

No GitHub status checks or workflow runs are attached to reviewed head
`338a4908a2c87548edc5082e737288365b535ab3`.

Still unverified:

- explicit `cargo check` result;
- signed local setup executable and adjacent `.sig`;
- disposable `/UPDATER` basic-UI smoke test;
- complete DEV-mock Light/Dark/Auto, keyboard and 70/100/130/160% zoom matrix;
- `workflow_dispatch` build-only run on `windows-latest` and its artifacts;
- confirmation that build-only creates no release;
- unauthenticated public endpoint after repository visibility changes;
- production draft/stage/undraft run;
- real installed N → N+1 update, data preservation and sidecar cleanup.

### Target and acceptance criteria

After R1–R6:

1. run and record `cargo check` and all focused/preflight commands;
2. perform signed local packaging and `/UPDATER` smoke test;
3. complete and record the Spec 018 visual matrix;
4. run build-only GitHub rehearsal and inspect setup + `.sig` workflow artifacts;
5. confirm no release was created;
6. make the repository public only when intentionally ready;
7. run the stable tag workflow and inspect the draft verification/final publication;
8. perform and record the real N → N+1 installed update.

Do not mark the updater feature merge/release complete based only on unit tests or local builds.
After the durable workflow is finalized and merged, generate replacement Project context files for
`CELLXPLORER_ARCHITECTURE.md` and `CELLXPLORER_DEVELOPMENT_WORKFLOW.md`.

## Follow-up order

1. R1 — close the Rust/frontend check-download race.
2. R2 — serialize release runs by tag/ref.
3. R3 — verify signing identity against the embedded public key.
4. R4 — fix install-error phase classification.
5. R5 — validate the actual uploaded draft manifest and signature bytes.
6. R6 — correct list semantics.
7. R7 — perform and record packaged, visual and workflow verification.

## Merge and release readiness

**Not ready to merge as a completed feature. Not ready to push `v0.15.0`.**

The draft-staging architecture is the correct safety model and should be retained. The repository may
be made public separately when the user is ready, but public visibility alone does not clear the
remaining code and verification findings.

After R1–R7 are addressed, re-review the complete branch once more before merge. The first updater-
enabled release remains a manual bootstrap installation; the real in-app path requires a subsequent
N → N+1 release test.

## Verification record

### Implementer reported

- Spec 017/018 follow-up commit:
  `2f1af94f646e6c22ea1ef06e04401f021ad1eace`.
- Spec 019 hardening commit:
  `338a4908a2c87548edc5082e737288365b535ab3`.
- Focused tests and no-cache preflight reported as listed under R7.
- Build-only workflow rehearsal, packaged update and public release tests explicitly not performed.

### Reviewer independently performed

- Confirmed repository `mattiafelice-palermo/cellxplorer` and branch
  `feature/updater-017-019`.
- Confirmed merge base `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`.
- Confirmed current head `338a4908a2c87548edc5082e737288365b535ab3`, six commits ahead.
- Read the current Specs 017–019, their implementation/review records, Rust updater state,
  frontend coordinator/reducer/modal, release workflow, release helpers and focused tests.
- Re-checked the pinned Tauri action's manifest path, API asset URL and asset-replacement behavior.
- Confirmed the current workflow stages a draft and undrafts only after its local/metadata checks.
- Confirmed no commit status checks or workflow runs are attached to the reviewed head.
- Did not run repository commands, build an installer, execute GitHub Actions, publish a release or
  perform an installed Windows update in the reviewer environment.

## R* implementation record (cumulative follow-up)

### R1 — Check/download race

- Rust `PendingAppUpdate` carries a monotonic `revision`. Checks capture revision at start;
  `apply_check_result` ignores stale revisions so in-flight checks cannot clear verified bytes.
- Revision bumps on replace, clear, download begin, and install take.
- Frontend `checkEpochRef` invalidates automatic apply when the modal opens or download starts;
  download awaits any in-flight check before reading current available state.

### R2 — Release concurrency

- `release.yml` sets `concurrency.group: cellxplorer-release-${{ github.ref }}` with
  `cancel-in-progress: false`.

### R3 — Signing key identity

- `verify_updater_manifest.py` compares minisign key IDs from `--tauri-conf` pubkey and the
  signature (uploaded or local). Focused tests cover match and mismatch with synthetic fixtures.

### R4 — Install vs download error phase

- `runDownload` tracks a local `phase`; failures use `failurePhaseForLocalUpdatePhase` so an
  install-command error is not misclassified if React state lags.

### R5 — Uploaded draft assets

- After draft upload the workflow downloads `uploaded-latest.json` and the uploaded `.sig`, then
  verifies those bytes (not only local workspace copies). Missing `latest.json` asset fails closed.

### R6 — Release-note list semantics

- `AppUpdateModal` groups consecutive bullets into a real `<ul>` / `<li>` list.

### R7 — Packaged / visual / workflow verification

Recorded locally for this follow-up:

- `cargo test` / `cargo check` for `src-tauri` (pass after R1 borrow fix).
- Focused Python: `tests.test_release_notes_script`, `tests.test_release_workflow`,
  `tests.test_updater_configuration`.
- `node --test frontend/tests/appUpdater.test.ts`.
- Full `python scripts\preflight.py --no-cache` — **PREFLIGHT PASSED**.

Explicitly **not** performed (still required before merge/tag):

- Signed local setup executable and adjacent `.sig`.
- Disposable `/UPDATER` basic-UI smoke test.
- Complete DEV-mock Light/Dark/Auto, keyboard and zoom matrix.
- `workflow_dispatch` build-only run and artifact inspection.
- Unauthenticated public endpoint after repository visibility change.
- Production draft/stage/undraft tag publish.
- Real installed N → N+1 update, data preservation and sidecar cleanup.

**Do not push `v0.15.0` until those R7 items and a final branch re-review are complete.**
