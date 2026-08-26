# Review — Spec 053: Fully isolated Alpha application and release channel

**Status:** Final code review clean — externally blocked
**Branch:** `codex/alpha-release-channel`
**Merge base with `main`:** `e396a32f86a4bfd8f4ed9c547096a08bc397d911`
**Parent:** [`../053-alpha-application-release-channel.md`](../053-alpha-application-release-channel.md)
**Reviewed branch head:** current branch including `b8fee81` and the reviewer clean transition for 053.2

## Final conclusion

The cumulative implementation is code-review clean. Child 053.1 is review-clean at `d1fc3e9`; Child 053.2 is review-clean after the R1-R3 corrections in `b8fee81`. No remaining implementation finding was established in the final cumulative review.

The workflow must nevertheless end **BLOCKED**, not COMPLETE, because Parent 053 §12 and Child 053.2 §§11-12 require the disposable installed/update/uninstall Windows/browser matrix and that evidence remains **NOT RUN**. Automated unit/integration checks and local build rehearsals do not substitute for the required installed three-product acceptance matrix.

The feature is therefore **not complete and not merge-ready yet**. The blocking dependency is external/manual acceptance evidence, not an implementer defect.

## Cumulative scope reviewed

The branch remains based on the verified merge base `e396a32`. The cumulative diff is confined to the Alpha product/release feature and its workflow/review documentation: three-channel runtime identity and branding, Alpha packaging/configuration/assets, updater/tag/manifest/release-channel policy, the shared release workflow, release documentation, and focused regression tests. No copied frontend/backend application tree was introduced.

The final architecture matches Parent 053's locked model:

- Stable, Beta, and Alpha are explicit three-value channels; unsupported non-empty channel values fail closed.
- Alpha owns `com.cellxplorer.desktop.alpha`, `cellxplorer-alpha://`, `.cellxplorer-alpha`, Alpha-specific Windows branding/installer identity, and `alpha/latest.json`.
- `CELLXPLORER_DATA` remains the exact override for every channel.
- Alpha has no Beta bootstrap/install coordinator path and is not treated as “not Beta therefore Stable”.
- Alpha uses the shared standard updater state machine, accepts only exact `X.Y.Z-alpha.N`, and does not use Stable's first-Beta-install state.
- Stable and Beta version/tag/feed behavior remains preserved; Alpha and Beta are not ordered against each other, only against the latest published exact Stable core.
- Alpha GitHub releases are prereleases and manual dispatch remains build-only.
- The orphan `release-channels` branch remains manifest-only and is never initialized from `main`.
- Publication protects all non-target manifests and `README.md`, uses optimistic/non-force branch movement, verifies the selected pointer through API and public raw bytes, and revalidates the complete tree.
- First-Alpha bootstrap eligibility depends on authoritative publication history before publication; after a successful Alpha undraft, the post-publication validation correctly treats Alpha as published.
- The pre-existing first-Beta bootstrap exception remains independent of Alpha history.
- The required pre-first-Alpha `release-channels/README.md` update is explicitly recorded as a pending, unauthorized release-preparation step; no such branch mutation was performed.

## Child review reconciliation

### 053.1

The canonical 053.1 review records a clean result after R1-R3 were resolved. Reviewer-owned checks there included 55 Python channel/config/icon tests, 58 frontend channel/bootstrap/updater tests, TypeScript checking, deterministic Beta icon regeneration, Alpha icon frame inspection, and an audit of remaining Beta comparisons. Implementer-reported Rust/build/preflight/package evidence was also recorded. The installed Windows/browser matrix remained NOT RUN and was explicitly carried forward rather than waived.

### 053.2

Round 1 found three concrete defects/requirements and returned only R1-R3. The returned fix `b8fee81` resolves all three:

- **R1 resolved:** the first Alpha publication no longer fails its own post-undraft tree validation; post-publication Alpha evidence is derived from prior published history or this job's successful Alpha undraft, while pre-publication bootstrap still uses authoritative history.
- **R2 resolved:** Beta bootstrap no longer depends on Alpha publication history in either `release_channels.py` or the release workflow.
- **R3 resolved:** the separate `release-channels` README preparation is recorded as pending/unauthorized in the implementation record and packaging procedure without mutating that branch.

The canonical 053.2 review records reviewer re-execution of the focused release/channel suite at 103 passing tests plus an offline replay of the first-Alpha lifecycle. Implementer-reported canonical `python scripts\preflight.py --no-cache` passed 4/4 stages with all 157 backend/frontend modules, with prior Node/Rust/build-only checks also reported passing.

## Parent acceptance reconciliation

The code and automated/build evidence support the following Parent 053 requirements: the two children were implemented sequentially and are review-clean; Stable/Beta contracts are preserved; Alpha has the locked independent product/runtime/data/update/release identity; Alpha exact updater/tag/manifest rules are enforced; first-Alpha bootstrap/post-bootstrap and all-non-target protection are covered; no database migration, `CALC_VERSION` change, scientific-result change, copied application tree, production tag/release, or unauthorized `release-channels` mutation was introduced.

The following parent acceptance items remain dependent on the **required disposable installed Windows/browser matrix** and therefore cannot be marked satisfied from repository tests alone:

- Stable, Beta, and Alpha install side by side with distinct Windows registration/install/uninstall/shortcut/deep-link/autostart identities;
- all three run simultaneously with channel-local single-instance behavior;
- same-channel self-update isolation for Stable/Beta/Alpha using signed installed artifacts;
- crossed-manifest behavior in installed products;
- uninstall isolation and destructive Alpha-data removal boundaries;
- end-to-end updater notification/modal/product identity in installed applications.

## Verification evidence

**Reviewer-independent evidence actually performed during this workflow:**

- 053.1 reviewer-focused Python/frontend/type/icon/channel audits as recorded in the child review;
- 053.2 Round-1 reviewer release/channel suite: PASS (101);
- 053.2 returned-fix reviewer release/channel suite: PASS (103);
- offline first-Alpha pre-/post-publication lifecycle replay: PASS after `b8fee81`;
- cumulative branch/code/spec/documentation inspection against merge base `e396a32`.

**Implementer-reported evidence reused proportionately:**

- canonical `python scripts\preflight.py --no-cache`: PASS (4/4; 157 modules) on the 053.2 returned-fix handoff;
- Rust `cargo test` / `cargo check`: PASS (51 tests reported);
- frontend updater/channel focused tests: PASS (50 reported);
- Stable/Beta/Alpha unsigned local build-only rehearsals: PASS;
- no production tag, GitHub release, or `release-channels` mutation performed.

**Required evidence still missing:**

- disposable installed/update/uninstall Windows/browser matrix: **NOT RUN**.

## Findings

**None.** No implementation finding remains open.

## Blocking gate

Parent 053 §12 explicitly requires the complete three-product disposable install/update/uninstall matrix, and Child 053.2 §12 explicitly instructs the reviewer to use external `BLOCKED` when that matrix is unavailable. That evidence is currently unavailable.

**Terminal reviewer decision: BLOCKED.**

The feature must not be marked COMPLETE or merge-ready until the required disposable installed Windows/browser matrix is actually run and reviewed. Resume the same final review when that external evidence becomes available. Do not self-approve it, publish/tag a release, or mutate `release-channels` merely to unblock the workflow.