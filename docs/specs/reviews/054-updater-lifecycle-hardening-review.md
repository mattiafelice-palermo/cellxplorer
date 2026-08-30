# Spec 054 — Updater lifecycle hardening — Final Review

## Final review status

**Implementation review clean; final acceptance BLOCKED on an external/manual dependency.** Both numeric children are implementation-review clean. No product-code or repository-controlled verification finding remains. Spec 054 is **not complete and not merge-ready** because the required live signed in-app passive-update matrix cannot be performed until a safe disposable Windows desktop/VM is available.

The mandatory desktop observations are not waived and are not inferred from configuration or build logs. When the environment becomes available, resume FINAL_REVIEW and execute the matrix before marking the parent complete.

## Review base and cumulative scope

The correct dependency merge base remains Spec 053 checkpoint:

`1a687ad0aac6cbdf3a6fee6a1c1b72ee644e867d`

The branch is ahead of that base and not behind it. The cumulative branch scope includes:

- separately authored repository workflow-protocol update `c8b10380cb690886d1590938a44da430e58cca4c` immediately after the dependency base; this is workflow infrastructure, not updater product behavior;
- Spec 054 specifications, workflow state/coordination and review records;
- 054.1 target-installation process ownership/cleanup changes and focused tests;
- 054.2 passive updater configuration, frontend applying/retry behavior, custom-NSIS passive progress initialization repair, and focused tests;
- the narrow pre-existing Alpha-bootstrap hosted-path test portability repair at `8506722f68a4916c2ff52ae05cedd647d01ae290`;
- evidence/reviewer-only commits after product checkpoint `f3047f7684b2e5629f38055e443815eb3000dfee`.

No production updater/bootstrap code changed after `f3047f7`. The three hosted signed build-only runs therefore exercised the current product/test tree; later commits only record evidence and review/workflow state.

## Child 054.1 — channel-isolated updater shutdown

**Accepted / review-clean.** The canonical child review records R1/R2 resolved.

Cumulative code inspection remains clean:

- install ownership is exact install-root path membership with case-insensitive, directory-boundary-safe matching;
- target cleanup protects the installer/uninstaller ancestor chain;
- cleanup kills by PID rather than a shared executable image name;
- the helper/import basename contract is exact;
- cleanup waits for target processes to remain absent and aborts on failure;
- the running Tauri application retains tracked-backend ownership rather than global process-name ownership.

Packaged evidence already accepted for 054.1 demonstrates Stable/Beta/Alpha side-by-side operation, target-only update/uninstall cleanup, and explicit sibling frontend plus backend PID/install-root survival with live `/api/health` returning `status=ok` and `database.status=ready` after each target-channel update.

This satisfies the parent's cross-channel process-isolation requirement by packaged evidence.

## Child 054.2 — non-interactive automatic updates

**Implementation child review clean.** The canonical child review closes R1 and reclassifies former R2 from an implementer finding to the parent external/manual gate; the live acceptance rows themselves remain pending.

Cumulative code inspection remains clean:

- Stable updater configuration uses `windows.installMode = "passive"`;
- Beta and Alpha resolve to the same passive updater mode while retaining distinct identifiers/endpoints;
- standalone NSIS installation remains `perMachine` and is not conflated with updater UI mode;
- updater artifacts and cryptographic verification remain enabled;
- frontend presents download progress and a protected `Applying update…` state before session finish/install takeover;
- duplicate update actions are prevented during active states;
- pre-exit install retry reuses Rust-restored verified bytes rather than re-downloading;
- version/channel validation remains in force;
- R1's passive NSIS path now initializes its custom fonts/frame before progress-page styling and re-hides Back/Next/Cancel after MUI page creation without restoring interactive wizard pages.

## Verification evidence

### Local / implementer-reported

Recorded handoffs report:

- focused updater/config/channel suite after R1: **PASS** (49 tests);
- frontend updater tests: **PASS**;
- frontend typecheck/build: **PASS**;
- Rust updater tests: **PASS**;
- canonical `python scripts\preflight.py --no-cache`: **PASS**, 4/4 stages;
- Alpha-bootstrap portability regression: **PASS**.

These local commands were reported by the implementer; the reviewer did not rerun them locally.

### Reviewer-verified hosted build-only evidence

The reviewer independently inspected the repository's manual `release.yml` build-only runs on exact product checkpoint `f3047f7684b2e5629f38055e443815eb3000dfee`:

- **Stable run 45 / run id `33330210124`: PASS** — release-local no-cache preflight green; updater signing secret available to Tauri; Stable NSIS executable plus `.exe.sig` produced; artifact `windows-x64-nsis` id `9737543578`, `85,156,028` bytes, digest `sha256:a79cc97d4b848d9f39dbe3961d1db9b997ab49334ff079c8362a83340513afeb`.
- **Beta run 46 / run id `33330717773`: PASS** — release-local no-cache preflight and Beta channel verification green; `tauri.beta.conf.json`; signed NSIS executable plus `.exe.sig`; artifact id `9737654461`, `85,147,409` bytes, digest `sha256:1556de928f9c745b0378096dc5aa3185bea0eba15b687a71521f1513874cff7f`.
- **Alpha run 47 / run id `33331143970`: PASS** — release-local no-cache preflight green across 4/4 stages and 158 backend/frontend modules/files, including `tests.test_alpha_bootstrap`; Alpha channel verification green; `tauri.alpha.conf.json`; signed NSIS executable plus `.exe.sig`; artifact id `9737778011`, `85,145,397` bytes, digest `sha256:09a6fa7c8523671f9f9d61afee190d1c90d15df0253cb5d0e131dfc3f7e62315`.

All three were deliberately build-only: release upload/publication and release-channel pointer steps were skipped. This proves signed channel-specific updater inputs can be generated safely without publishing a release.

## Parent acceptance assessment

| Parent acceptance criterion | Status | Evidence |
| --- | --- | --- |
| At least two channels can run concurrently | PASS | Accepted 054.1 packaged matrix |
| Updating one channel does not terminate sibling frontend/backend | PASS | Accepted 054.1 Stable/Beta/Alpha target-update matrix with sibling backend PID/path and `/api/health` |
| Update does not show the full installer wizard | **PENDING EXTERNAL** | Passive config/code is clean, but live desktop observation is mandatory |
| User sees meaningful application-level update progress | **PENDING EXTERNAL** | Frontend code/tests cover download/applying; passive takeover must still be observed live |
| Successful update ends with expected new version running/ready to relaunch | **PENDING EXTERNAL** | Requires live signed in-app update |
| Failed download/install remains understandable/retryable | PARTIAL / **PENDING EXTERNAL** | Pre-exit failure/retry is covered by code/tests; post-takeover user-visible behavior remains a live acceptance item where practical |
| Existing user data remain present after update | **PENDING EXTERNAL** | Requires disposable installed data-preservation check |

## External/manual acceptance gate

A safe disposable Windows desktop/VM is currently unavailable. The real per-machine Stable/Beta/Alpha installations and user data are not acceptable destructive test fixtures. GitHub-hosted build jobs do not provide the required interactive/visual installed-app observation surface.

Before Spec 054 can become COMPLETE/merge-ready, resume final review and, for Stable, Beta and Alpha using real signed updater inputs and disposable state, record:

1. older installed build and explicit in-app update initiation;
2. determinate download progress when length is known and visibly active indeterminate behavior otherwise;
3. `Applying update…` before old-app exit;
4. no ordinary interactive NSIS wizard;
5. compact passive updater/progress window visible after CellXplorer exits and while installation runs;
6. no material blank/no-feedback interval between the CellXplorer handoff and passive progress;
7. no installer interaction required and an understandable completion/failure outcome;
8. automatic relaunch when supported, or exact clear manual-launch fallback;
9. requested new version installed/running;
10. representative analyses, saved plots and settings preserved;
11. a concurrently running sibling channel remains responsive, including backend health;
12. controlled download/install failure if practical, otherwise an exact NOT RUN reason;
13. exact channel/build/artifact observations without exposing private signing material.

The signed artifacts verified above satisfy the input-production portion of this gate; they do not satisfy the live observations.

## Findings

**None.** There is no remaining implementation defect, spec deviation, repository-controlled regression risk, or agent-actionable verification gap. The only unresolved requirement is the external/manual desktop acceptance input described above.

## Merge readiness

- 054.1: **accepted**.
- 054.2: **implementation review clean**; live rows moved unchanged to final external gate.
- Cumulative product/code review: **clean**.
- Signed Stable/Beta/Alpha build-only artifacts: **reviewer-verified**.
- Required live disposable-Windows passive-update matrix: **NOT RUN**.
- Spec 054: **BLOCKED, not COMPLETE**.
- Branch: **not ready to merge** until the external desktop matrix is completed and the resumed cumulative final review is clean.
