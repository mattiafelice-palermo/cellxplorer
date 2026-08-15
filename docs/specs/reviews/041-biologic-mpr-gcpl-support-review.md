# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**R2 implementation checkpoint:** `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`  
**Initial user-amendment checkpoint:** `befc0863de5b616d8d08de180afe8d909a9d8252`  
**R3/R4 implementation checkpoint:** `29952b5b7d685897bc04f20ed605523345e95cab`  
**R4/R5 correction checkpoint:** `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`  
**Status:** **IMPLEMENTATION REVIEW CLEAN / SCIENTIFIC CLOSURE BLOCKED — not ready to merge**

This is the cumulative Parent 041 review. R1/R2 were previously resolved and the implementation review was clean before the 2026-08-15 user amendment. The amendment deliberately adds one narrow cycle-identity exception for a declared, non-repeating charge/rest-only or discharge/rest-only MPR when decoded rows prove constant-zero half-cycle, monotonic `Ns`, one signed active-current direction and at least one active row. The inferred cycle `1` is source-local only.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app smoke, browser/manual checks, or private MPR/MPT parity during this amendment review.

## Confirmed cumulative behavior

The following parent-level properties remain consistent with the locked design:

- The production MPR reader remains independently authored, bounded and limited to the independently observed 16-ID / 53-byte GCPL record layout; the synthetic-only 15-ID / 49-byte variant remains rejected.
- `.mpr` remains admitted through the central source-format registry and `.mpt` remains excluded as a user import format.
- Three-electrode voltage roles and signed Ewe/Ece handling remain explicit.
- Metadata-only continuation acknowledgement remains content-hash bound.
- Cell Database list summaries remain relational and bounded.
- Generic scientific compute, saved-artifact, warmup and portable-export capability guards remain format-neutral.
- The R1 saved-artifact/warmup fail-closed boundary remains present.
- The R2 live capability guard remains scalar/header-free on cache-hit/artifact/warmup paths.
- Generic Time/Capacity voltage selection and saved/export/portable presentation remain format-neutral; no BioLogic-specific downstream scientific calculation branch was added.
- No relational migration or `CALC_VERSION` bump was introduced.
- Runtime requirements still do not add a GPL BioLogic parser dependency.
- `main` remains at the original merge base `aca39740039b4d7146afc9104f5c471bff7c7c46`.
- The current MPR adapter identity is `bm:gcpl7:r1`; both `bm:gcpl5:r1` and `bm:gcpl6:r1` are legacy/reinspection-only identities.
- The constant-zero half-cycle requirement is enforced before the single-direction fallback; non-zero or regressing half-cycle values remain rejected.
- Source-local cycle numbering is compatible with the existing generic stitcher: each source's local cycle labels are remapped densely to test-global cycles while `source_cycle` preserves the local label, so multiple source-local cycle-1 segments do not collide.
- Legacy BioLogic reinspection runs from the post-listening scientific warmup thread rather than delaying API reachability.

## Finding status

### R1 — RESOLVED: retired gcpl3 saved artifacts are no longer live after metadata-only downgrade

The generic canonical-cycling guard applies before saved-artifact signature/cache access and across warmup discovery, task admission and late completion. Retired scientific bytes may remain for forensic cleanup but are not live.

### R2 — RESOLVED: live capability guards no longer materialize deferred `header_meta`

The generic capability path uses persisted scalar identity/status/error state with `include_header=False`; header-aware behavior remains limited to reconciliation/presentation paths that genuinely need persisted header evidence.

### R3 — RESOLVED: settings eligibility is provisional until decoded-row verification succeeds

The `gcpl7` implementation separates header eligibility from verified canonical capability.

Header-only inspection remains record-decode-free and advertises a bounded pending state instead of claiming canonical rows already exist:

```text
canonical_cycling = false
canonical_cycling_pending = true
metadata_only = false
cycle_identity_source = single_direction_pending
```

Pending is deliberately distinct from terminal metadata-only: import/continuation preparation proceeds automatically, while generic scientific consumers fail closed until promotion. Successful full parsing promotes the persisted source to verified canonical capability. Candidate row-verification failure clears pending/canonical flags, removes live row/cycle/capacity summaries and persists the source as current-parser metadata-only with the failure reason retained.

Focused tests cover pending header capability, valid charge/discharge promotion, persisted failure after declared/raw mismatch, and continuation preparation of pending candidates.

### R4 — RESOLVED: declared/raw direction and legacy gcpl6 upgrade boundaries now fail closed completely

The current mapper validates the source's observed execution against the declared single-direction protocol at the normalized `Ns` level before allowing the cycle-1 fallback. Declared charge cannot be satisfied by discharge-current rows, declared discharge cannot be satisfied by charge-current rows, and active execution on a declared Rest sequence is rejected. A partial source beginning at a later declared `Ns` remains valid when the observed subset is internally consistent.

The parser identity advanced from `gcpl6` to `gcpl7`; both `bm:gcpl5:r1` and `bm:gcpl6:r1` are reinspection-only.

The returned R4 correction closes the remaining offline relational-summary leak. `reinspect_legacy_biologic_sources()` now performs a database-only fail-closed downgrade for legacy rows that are offline or whose path is missing. The shared downgrade helper clears parser-derived row/cycle/capacity summaries, sets `capacity_summary_status="unavailable"`, records reinspection-required state and removes the legacy parser identity from live registration while leaving historical source/cache bytes untouched. Online legacy sources still pass through the current `gcpl7` header/full-parse path.

The focused regression now proves that an offline previously `ready` `bm:gcpl6:r1` registration:

- becomes metadata-only/reinspection-required;
- has `row_count` and `cycle_count` cleared;
- has charge/discharge/max-capacity scalars cleared;
- has `capacity_summary_status="unavailable"`;
- causes `library.cell_capacity_totals()` to return unavailable/`None` values rather than the old unsafe totals;
- retains historical old cache bytes for recovery/forensic cleanup.

No source/Parquet read is required for this offline downgrade.

### R5 — RESOLVED: 041.6 closure record now matches the gcpl7 amendment state

The implementation record now preserves the historical `gcpl5 → gcpl6` amendment checkpoint while explicitly recording that the live R3/R4 correction advances the adapter to `gcpl7` and makes both `bm:gcpl5:r1` and `bm:gcpl6:r1` reinspection-only.

It records the exact `29952b5b7d685897bc04f20ed605523345e95cab` R3/R4 implementation checkpoint and the implementer-reported 172-test / no-cache preflight evidence, while preserving `MPR/MPT semantic parity: NOT RUN` and packaged/manual/browser checks as NOT RUN.

## External scientific closure gate — still BLOCKED

This remains separate from the resolved R findings and is **not** an implementer-actionable code finding.

The user amendment deliberately permits the narrow single-direction source-local cycle-1 fallback without a paired `.mpt`; it does **not** waive Parent 041's general same-experiment `.mpr` / `.mpt` validation requirement for multi-cycle scientific closure.

Accordingly:

- real general MPR/MPT semantic parity remains **NOT RUN**;
- the narrow single-direction exception is implementation-review clean without that missing pair;
- synthetic single-direction fixtures are regression evidence for the exception, not substitute ground truth for general GCPL cycle semantics;
- Parent 041 still cannot be marked `COMPLETE` or ready to merge under the current acceptance criteria unless the paired gate is satisfied or explicitly amended.

The workflow helper currently has no distinct USER/BLOCKED state in the active JSON schema. The truthful repository state is therefore to remain `REVIEWER + FINAL_REVIEW` with no open implementation findings rather than falsely transitioning to `COMPLETE`.

## Verification record

### Implementer-reported for R3/R4 checkpoint `29952b5b7d685897bc04f20ed605523345e95cab`

- Focused R3/R4 suites: reported PASS — 172 tests.
- `python scripts\preflight.py --no-cache`: reported PASS — 5/5; all 68 backend modules, 541 frontend tests, TypeScript type check and Vite production bundle passed.
- MPR/MPT semantic parity: **NOT RUN**; no paired `.mpt` available.
- Browser/manual feature verification: NOT RUN.

### Implementer-reported for R4/R5 correction checkpoint `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`

- Focused R4/R5 suites: reported PASS — 172 tests.
- `python scripts\preflight.py --no-cache`: reported PASS — 5/5; all 68 backend modules, 541 frontend tests, TypeScript type check and Vite production bundle passed.
- MPR/MPT semantic parity: **NOT RUN**; no paired `.mpt` available.
- Browser/manual feature verification: NOT RUN.

Historical earlier checkpoint verification remains historical evidence and is not restated as proof of the current implementation.

### Reviewer independently inspected in the amendment rounds

- Exact amendment and correction deltas through `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`.
- Current `main` head and merge base.
- `gcpl7` header pending/candidate capability construction.
- Full-map declared-per-`Ns` direction validation and partial-later-`Ns` behavior.
- Candidate promotion and semantic-failure downgrade paths in scanner/import publication.
- Scalar/header-free pending capability behavior.
- Continuation preparation of pending candidates.
- `gcpl5`/`gcpl6` legacy identity boundary and online/offline reinspection behavior.
- Cell Database relational capacity-summary behavior for persisted source summaries.
- Offline legacy database-only downgrade and recovery/relink boundary.
- Focused R3/R4/R5 regression assertions.
- Current 041.6 implementation/verification record.

### Reviewer did NOT independently execute

- Python/backend tests.
- Frontend policy tests.
- `scripts/preflight.py`.
- TypeScript/Vite build.
- Packaged Windows smoke.
- Browser/manual matrix.
- Private real-file parse during this amendment review.
- MPR/MPT semantic parity.

## Decision

**IMPLEMENTATION REVIEW CLEAN — no open R findings. SCIENTIFIC CLOSURE BLOCKED.**

The narrow user-requested charge-only/discharge-only source-local cycle-1 exception is implementation-review clean at current head. R1-R5 are resolved, including the `gcpl7` candidate/verified boundary, declared/raw direction proof and offline legacy summary invalidation.

The branch is nevertheless **not ready to merge under the current Parent 041 acceptance criteria** because the separate general same-experiment MPR/MPT semantic-parity gate remains NOT RUN. Keep the workflow in `REVIEWER + FINAL_REVIEW` with no open findings. Resume final scientific closure when paired evidence is available, or if the user explicitly amends that remaining parent-level requirement.