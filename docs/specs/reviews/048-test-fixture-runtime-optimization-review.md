# Spec 048 implementation review — Test and release runtime optimization

Status: **Child 048.1 review-clean; parent not merge-ready because 048.2 remains**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed 048.1 implementation: `f03486ecb543e8119c4d948c258a5b14c56195fe`

## Review scope and result

Child 048 remains review-clean. This round independently reviewed the final child-048.1 fixes for the release/CI runtime work, including the live workflows, resolver/build-script behavior, regression tests, branch scope, and hosted Windows rehearsal.

**Result: 048.1 is review-clean.** R4-R7 are resolved. The workflow may advance to queued child 048.2.

The final 048.1 architecture preserves the release correctness/publication barriers while removing duplicated or serial work:

- the canonical `main` Windows preflight remains available for exact-SHA reuse;
- exact-SHA trust is restricted to the canonical workflow/name/path, exact SHA, `push`, `main`, and the named `Clean Windows preflight` job;
- a failed canonical job blocks release, while missing/cancelled/skipped evidence uses the complete release-local no-cache fallback;
- the independent Rust-cache warmer can no longer delay a completed canonical-job decision;
- `main` and release dependency installs use native GitHub Actions parallel steps;
- release restores the shared production Rust cache without saving a tag-scoped cache;
- exact-reuse frontend and sidecar inputs are built concurrently, with the backend-only sidecar path genuinely independent of frontend state;
- fallback preflight builds the selected-channel frontend once and stamps that same bundle;
- frontend stamp verification, packaged-input checks, real sidecar smoke, Tauri build, signed-draft verification, updater/signature validation, publication, and channel-pointer checks remain ordered and fail-closed.

## Verification record

### Implementer-reported final verification

- focused follow-up suite: **PASS**, 87 tests;
- workflow YAML parse: **PASS**, both workflows;
- `python -m compileall -q scripts tests`: **PASS**;
- `git diff --check`: **PASS**;
- `python scripts\\preflight.py --no-cache`: **PASS**, 4/4 stages, 152.02 s, all 128 backend/frontend tasks;
- `python scripts\\preflight.py`: **PASS**, 4/4 stages, 110.15 s, all 68 backend modules;
- hosted Windows rehearsal run `31975338254`: **PASS**;
- cold Rust release-profile compile: cache miss, **427.81 s**;
- warm Rust release-profile compile: exact cache hit, **138.97 s**;
- exact-reuse frontend build: **20.09 s**;
- exact-reuse sidecar build: **66.42 s**;
- hosted channel verification and packaged-backend smoke: **PASS**;
- temporary diagnostic workflow: **removed before handoff**.

### Reviewer-independent verification

I independently inspected through the GitHub connector:

- current `main` head and correct merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`;
- final branch code through `f03486ecb543e8119c4d948c258a5b14c56195fe`;
- `.github/workflows/preflight.yml` and `.github/workflows/release.yml`;
- `scripts/build-app.ps1`;
- `scripts/resolve_preflight_reuse.py`;
- `tests/test_release_workflow.py` and `tests/test_app_channels.py`;
- hosted Actions run `31975338254`, all three successful jobs, the cold-cache logs, warm-cache logs, and exact-reuse release-input job steps;
- comparison from the rehearsal commit `f77de71...` to final `f03486e...`: the only subsequent branch changes were removal of the temporary diagnostic workflow and documentation/implementation-record updates, so the hosted run exercised the retained production code.

The hosted cache evidence is material: the same cache family/key changed from a cold miss at 427.81 s to an exact hit at 138.97 s, a reduction of about 67.5% in the measured release-profile Cargo compile. The warm log confirms an exact full-key restore. The exact-reuse input job independently confirms the frontend and backend-only sidecar paths complete, followed by channel verification and packaged-backend smoke.

I did **not** execute local commands in this Chat + GitHub-only reviewer session.

### Runtime-evidence limitation

The diagnostic rehearsal intentionally did not create a fake tag or publish a release. It therefore does not measure a signed production tag from job start through channel-pointer publication. The first actual release after merge remains the authoritative end-to-end release-ready timing measurement. This does not block 048.1 because the child required cache/runtime evidence without publishing a fake release, and the hosted run proves the new cache and exact-reuse input paths directly.

## Findings

### R1 — RESOLVED: timing-history scheduler reverted

Clean hosted evidence showed longest-first scheduling was slower; the experiment is removed.

### R2 — RESOLVED: partition experiment reverted

The original Neware Excel and portable-analysis module topology is restored.

### R3 — RESOLVED: Vite 8 / Rolldown migration

The compatible migration remains accepted based on prior verification and direct-build improvement.

### R4 — High — RESOLVED: backend-only sidecar no longer races frontend stamp

`build-app.ps1` now skips frontend-stamp verification only when both frontend and installer are intentionally skipped. Installer-producing paths still verify the frontend, and release keeps both the post-build verification and the immediate pre-Tauri re-verification. The hosted exact-reuse rehearsal passed from a clean checkout.

### R5 — High — RESOLVED: exact-SHA decision is based on canonical job, not helper completion

`resolve_preflight_reuse.py` now fetches and classifies the named canonical job even while the overall workflow is active. Tests cover active-workflow/canonical-success, canonical-failure, canonical-job polling, helper independence, fallback states, and fail-closed timeout behavior.

### R6 — Medium — RESOLVED: main dependency installs use native parallel steps

`preflight.yml` now places backend pip and frontend npm installation in one native `parallel` group after both language setup actions, with separate names/logs and normal failure propagation. Structural tests cover the group.

### R7 — Medium — RESOLVED: hosted cache/runtime evidence obtained

Hosted run `31975338254` provided a cold cache miss followed by an exact warm hit and demonstrated a material release-profile Cargo reduction (427.81 s -> 138.97 s). The same run exercised the corrected exact-reuse frontend + backend-only sidecar path and passed release-input verification and backend smoke. No fake tag/release was published, and the temporary diagnostic workflow was removed afterward.

## Merge readiness

**Parent Spec 048 is not ready to merge yet because child 048.2 remains queued.** Child 048.1 itself is review-clean and may advance to 048.2.
