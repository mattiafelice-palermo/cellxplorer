# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**R2 implementation checkpoint:** `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`  
**Initial user-amendment checkpoint:** `befc0863de5b616d8d08de180afe8d909a9d8252`  
**R3/R4 implementation checkpoint:** `29952b5b7d685897bc04f20ed605523345e95cab`  
**R4/R5 correction checkpoint:** `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`  
**Status:** **REOPENED FOR USER-REPORTED BUG — MPR/MPT PARITY DEFERRED**

This is the cumulative Parent 041 review. R1/R2 were previously resolved and the implementation review was clean before the 2026-08-15 user amendment. The amendment deliberately adds one narrow cycle-identity exception for a declared, non-repeating charge/rest-only or discharge/rest-only MPR when decoded rows prove constant-zero half-cycle, monotonic `Ns`, one signed active-current direction and at least one active row. The inferred cycle `1` is source-local only.

On 2026-08-16 the user explicitly amended the closure scope again: the same-experiment `.mpr` / `.mpt` parity work is deferred to a later implementation and must **not** block Parent 041 now. The previous parity gate is therefore historical, not a current acceptance requirement. The user also reported a newly found bug; no concrete bug description or implementation handoff is present in the live workflow yet, so this review remains open rather than declaring the parent complete.

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

## MPR/MPT parity — DEFERRED BY USER, no longer a Parent 041 closure gate

The original Parent 041 acceptance criteria required a privacy-approved same-experiment `.mpr` / `.mpt` pair for general multi-cycle semantic parity. That validation was never run because no matching `.mpt` was available.

On 2026-08-16 the user explicitly deferred that work to a later implementation. Therefore:

- MPR/MPT semantic parity remains truthfully **NOT RUN**;
- no parity claim is made for general multi-cycle GCPL semantics;
- the currently implemented narrow charge-only/discharge-only source-local cycle-1 support remains bounded by its own decoded-row proof and regressions;
- absence of a paired `.mpt` is **not** a blocker for closing or merging Parent 041;
- future expansion to general multi-cycle MPR support must establish its own scientific validation requirements rather than retroactively treating Parent 041 as having proved parity.

This amendment supersedes the earlier review text that kept Parent 041 in `FINAL_REVIEW` solely because the pair was unavailable.

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

**REOPENED — waiting for the newly user-reported bug to enter the implementation/review workflow.**

The previously reviewed implementation through `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a` has no open R finding: R1-R5 are resolved, including the `gcpl7` candidate/verified boundary, declared/raw direction proof and offline legacy summary invalidation.

The missing `.mpr/.mpt` pair is no longer a closure blocker by explicit user decision on 2026-08-16. Parent 041 is not marked complete yet only because the user has reported a new bug after the clean review and that bug has not yet been described/handed off in the live repository workflow. Once the bug is recorded and fixed, resume `FINAL_REVIEW` from that new delta; do not reintroduce MPR/MPT parity as a requirement for this parent.