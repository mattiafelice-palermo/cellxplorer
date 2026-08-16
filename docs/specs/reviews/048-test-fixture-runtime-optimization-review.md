# Spec 048 implementation review — Test and release runtime optimization

Status: **Changes requested — child 048.1**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed 048.1 implementation: `3a9eb0191720f46788d4c92c287725d2c58054a7`

## Review scope and result

Child 048 remains review-clean. This round reviews child `048.1-release-ci-runtime-optimization.md` against the live release/preflight workflows, existing build script semantics, workflow tests, and the current merge base.

The implementation has several correct foundations:

- main preflight is no longer suppressed/cancelled when a release tag appears;
- release permissions drop `actions: write` and exact-SHA reuse is restricted to the canonical workflow, exact SHA, `push`, and `main`;
- a failed canonical Windows job blocks release while missing/cancelled/skipped evidence can fall back to the complete local no-cache preflight;
- release Rust-cache use is restore-only and the main workflow owns a matching shared cache family;
- release dependency installation uses current native GitHub Actions `parallel` syntax;
- the local fallback builds the selected-channel Vite bundle once, stamps that already-built `frontend/dist`, and retains the later channel verification;
- signing, packaged-backend smoke, staged draft verification, updater-manifest/signature validation, publication, and channel-pointer checks remain ordered.

The branch is not review-clean because two release-path defects are visible directly from code, one safe CI parallelism opportunity required by the child remains unused, and the runtime/cache behavior has not yet been exercised on a hosted runner.

## Verification record

### Implementer-reported

- focused release/runner/preflight tests: **PASS**, 84 tests;
- both workflow YAML files parsed with available PyYAML: **PASS**;
- `python -m compileall -q scripts tests`: **PASS**;
- `git diff --check`: **PASS**;
- `python scripts\\preflight.py --no-cache`: **PASS**, 4/4 stages, 115.25 s, all 128 backend/frontend tasks;
- `python scripts\\preflight.py`: **PASS**, 4/4 stages, 105.20 s, all 68 backend modules;
- hosted cold/warm release rehearsal: **NOT RUN** because the implementer environment lacked `gh`/workflow-dispatch access.

### Reviewer-independent

I independently inspected through the GitHub connector:

- current `main` head and merge base — both remain `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`;
- the cumulative branch scope through reviewer handoff `2ba27662d9c6606981a4e632cbb437128aae8d51`;
- `.github/workflows/preflight.yml` and `.github/workflows/release.yml`;
- `scripts/resolve_preflight_reuse.py`;
- `scripts/build-app.ps1`;
- release workflow tests and exact-SHA resolver tests;
- current official GitHub Actions `parallel` semantics and the current `Swatinem/rust-cache` `cache-hit`, `shared-key`, `add-job-id-key`, and `save-if` behavior.

I did **not** independently execute local commands or dispatch a new workflow in this Chat + GitHub-only reviewer session.

## Previously resolved child-048 findings

### R1 — RESOLVED: timing-history scheduler reverted

Clean hosted evidence showed longest-first scheduling was slower; the experiment is removed.

### R2 — RESOLVED: partition experiment reverted

The original Neware Excel and portable-analysis module topology is restored.

### R3 — RESOLVED: Vite 8 / Rolldown migration

The compatible migration remains accepted based on prior verification and direct-build improvement.

## 048.1 findings

### R4 — High — exact-reuse sidecar build races the frontend channel stamp

Affected files:

- `.github/workflows/release.yml`
- `scripts/build-app.ps1`
- `tests/test_release_workflow.py`

**Current**

On the exact-SHA reuse path, `release.yml` runs these two steps in one native `parallel` group:

```text
python scripts/build_frontend_channel.py <channel>
.\scripts\build-app.ps1 -Channel <channel> -SkipInstall -SkipFrontend -SkipInstaller -ForceBackend
```

However, `build-app.ps1` does not treat `-SkipFrontend` as a backend-only path. Before it starts the PyInstaller backend build, its `-SkipFrontend` branch immediately runs:

```text
python scripts/frontend_channel.py verify --channel <channel>
```

A fresh exact-reuse release checkout has skipped the release-local preflight, so `frontend/dist` and its channel stamp do not yet exist. The sidecar member can therefore fail immediately while the parallel frontend member is still building. The two operations are not actually independent under the current build-script contract.

**Target**

Make the backend-only sidecar path genuinely independent of frontend state while preserving all later release verification. The smallest acceptable design is to make `build-app.ps1` avoid frontend-stamp verification when both frontend and installer work are intentionally skipped, or introduce an equally explicit backend-only path. Do not remove the workflow-level channel verification after both parallel members finish or the final verification immediately before Tauri packaging.

**Acceptance criteria**

- The exact-reuse sidecar command succeeds on a clean checkout with no pre-existing `frontend/dist`.
- Backend-only building still stages the complete PyInstaller onedir payload and preserves `-ForceBackend` behavior.
- Normal installer-building paths still require/verify the correct frontend channel before packaging.
- A regression test proves `-SkipFrontend -SkipInstaller` no longer requires a pre-existing frontend stamp.
- The release workflow verifies frontend stamp + packaged inputs + backend smoke after the parallel group and again preserves the pre-Tauri stamp barrier.

### R5 — High — exact-SHA resolver waits for the cache helper instead of the canonical job

Affected files:

- `scripts/resolve_preflight_reuse.py`
- `tests/test_release_workflow.py`
- `.github/workflows/preflight.yml`

**Current**

`preflight.yml` now has two independent jobs: the canonical `Clean Windows preflight` and `Warm Windows release Rust cache` (up to 20 minutes). In `_inspect_latest()`, the resolver checks the workflow-run status first. If the workflow run is `queued`/`in_progress`/etc., it returns `active` without fetching the job list.

As a result, even when `Clean Windows preflight` has already completed successfully, the release waits for the whole workflow run — including the non-correctness Rust-cache helper — before it can reuse the canonical result. The resolver waits only 600 seconds, so a slow/cache-miss helper can even turn an already-green canonical preflight into a release timeout.

**Target**

Resolve trust from the named canonical Windows job, not from completion of unrelated jobs in the same workflow run. For a trusted exact-SHA main-push run, inspect the jobs even while the overall run remains active:

- canonical job completed + success -> reuse immediately;
- canonical job completed + failure -> block release immediately;
- canonical job cancelled/skipped/missing -> full local fallback according to the existing policy;
- canonical job itself still queued/in-progress -> poll until that job resolves or the bounded wait expires;
- Rust-cache helper state must not delay or determine correctness reuse.

**Acceptance criteria**

- Test: workflow run still `in_progress`, canonical job completed `success` -> `reuse_preflight=true` without waiting for helper completion.
- Test: workflow run still active, canonical job completed `failure` -> release-blocking error.
- Test: canonical job itself active -> bounded polling continues.
- Test: cache-helper failure/running state does not change the canonical-job decision.
- Missing/cancelled/skipped canonical results retain the complete local fallback.

### R6 — Medium — safe main-preflight dependency installs remain serial

Affected files:

- `.github/workflows/preflight.yml`
- `tests/test_release_workflow.py` or a focused preflight-workflow test

**Current**

The release workflow correctly runs backend pip installation and frontend npm installation in a native `parallel` group. The main preflight performs the analogous independent installations serially:

```text
Install backend dependencies
Install frontend dependencies
```

The child explicitly says to apply the same principle elsewhere in CI when a material independent pair exists, and the user requested safe GitHub-CI parallelism wherever available. These two installs occur after Python/Node setup and write to separate dependency domains.

**Target**

Run the main-preflight backend and frontend dependency installs in one native `parallel` group while retaining separate names/logs and normal failure propagation.

**Acceptance criteria**

- Both existing command sets are preserved exactly in meaning.
- Native GitHub `parallel` syntax is used after both setup actions.
- Failure of either install fails the required canonical preflight job.
- Workflow tests structurally cover the main-preflight parallel group.

### R7 — Medium — hosted cache/runtime acceptance is still missing

Affected files:

- temporary diagnostic workflow if needed;
- `docs/specs/048.1-release-ci-runtime-optimization.md` implementation record;
- final workflow configuration as required by measured results.

**Current**

All reported verification is local/static. The implementation record explicitly has no hosted cold/warm cache evidence, no proof that the main cache-warmer command successfully seeds this Tauri crate on a clean Windows runner, and no measured evidence that the exact-reuse parallel frontend/sidecar topology reduces wall time. Static YAML cannot establish those points.

The current main cache-warmer is also intentionally main-only, so a feature-branch `workflow_dispatch` would skip it. The implementer nevertheless has a repository-only route already demonstrated earlier in Spec 048: temporarily add a branch-triggered diagnostic workflow, let pushes run it, collect run IDs/logs, then remove the diagnostic workflow before handoff.

**Target**

After R4-R6 are fixed, obtain hosted Windows evidence without publishing a fake release. A temporary feature-branch push-triggered diagnostic workflow is acceptable. At minimum prove:

1. the Rust warming command succeeds on a clean runner and creates a usable cache;
2. a subsequent comparable run reports `cache-hit=true` and materially reduces the Cargo/Tauri dependency-compile stage;
3. the corrected exact-reuse frontend + sidecar preparation path succeeds and is compared against serial execution if CPU contention is material;
4. temporary diagnostic workflow files are removed before final handoff.

If a specific hosted measurement shows a proposed parallel pair is slower or flaky, keep that pair serial and record the evidence rather than retaining concurrency for appearance.

**Acceptance criteria**

- Record GitHub Actions run IDs, host/run context, cache miss/hit state, and step wall times.
- At least one cold/seed and one warm comparison are available.
- No tag/release is published solely for benchmarking.
- Final implementation record clearly separates local tests from hosted evidence.
- Temporary diagnostic workflow is removed before review handoff.

## Decision

**CHANGES REQUIRED — do not begin 048.2 yet.**

Child 048.1 is not ready to advance. Fix R4-R7, rerun the focused workflow tests and canonical preflights, obtain the hosted evidence above, then hand 048.1 back for review. Child 048 remains review-clean; queued child 048.2 remains untouched.