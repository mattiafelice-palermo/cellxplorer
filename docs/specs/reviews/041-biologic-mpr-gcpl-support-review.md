# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**R2 implementation checkpoint:** `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`  
**Initial user-amendment checkpoint:** `befc0863de5b616d8d08de180afe8d909a9d8252`  
**R3/R4 returned implementation checkpoint:** `29952b5b7d685897bc04f20ed605523345e95cab`  
**Status:** **CHANGES REQUIRED / SCIENTIFIC CLOSURE BLOCKED — not ready to merge**

This is the cumulative Parent 041 review. R1/R2 were previously resolved and the implementation review was clean before the 2026-08-15 user amendment. The amendment deliberately adds one narrow cycle-identity exception for a declared, non-repeating charge/rest-only or discharge/rest-only MPR when decoded rows prove constant-zero half-cycle, monotonic `Ns`, one signed active-current direction and at least one active row. The inferred cycle `1` is source-local only.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app smoke, browser/manual checks, or private MPR/MPT parity during this amendment review.

## Confirmed cumulative behavior

The following parent-level properties remain intact:

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
- The current MPR adapter identity is `bm:gcpl7:r1`; both `bm:gcpl5:r1` and `bm:gcpl6:r1` are now legacy/reinspection-only identities.
- The constant-zero half-cycle requirement is enforced before the single-direction fallback; non-zero or regressing half-cycle values remain rejected.
- Source-local cycle numbering is compatible with the existing generic stitcher: each source's local cycle labels are remapped densely to test-global cycles while `source_cycle` preserves the local label, so multiple source-local cycle-1 segments do not collide.
- Legacy BioLogic reinspection runs from the post-listening scientific warmup thread rather than delaying API reachability.

## Finding status

### R1 — RESOLVED: retired gcpl3 saved artifacts are no longer live after metadata-only downgrade

The generic canonical-cycling guard applies before saved-artifact signature/cache access and across warmup discovery, task admission and late completion. Retired scientific bytes may remain for forensic cleanup but are not live.

### R2 — RESOLVED: live capability guards no longer materialize deferred `header_meta`

The generic capability path uses persisted scalar identity/status/error state with `include_header=False`; header-aware behavior remains limited to reconciliation/presentation paths that genuinely need persisted header evidence.

### R3 — RESOLVED: settings eligibility is now provisional until decoded-row verification succeeds

The returned `gcpl7` implementation separates header eligibility from verified canonical capability.

Header-only inspection remains record-decode-free and now advertises a bounded pending state instead of claiming canonical rows already exist:

```text
canonical_cycling = false
canonical_cycling_pending = true
metadata_only = false
cycle_identity_source = single_direction_pending
```

Pending is deliberately distinct from terminal metadata-only: import/continuation preparation may proceed automatically, while generic scientific consumers fail closed until promotion. Successful full parsing promotes the persisted source to verified canonical capability. Candidate row-verification failure clears pending/canonical flags, removes live row/cycle/capacity summaries and persists the source as current-parser metadata-only with the failure reason retained.

Focused tests now cover pending header capability, valid charge/discharge promotion, persisted failure after declared/raw mismatch, and continuation preparation of pending candidates.

### R4 — High: offline unsafe gcpl6 registrations still expose old parser-derived Cell Database capacity summaries

Affected files:
- `backend/app/services/scanner.py`
- `backend/app/services/parsing.py` as needed for a bounded scalar downgrade helper
- `backend/app/routers/library.py` only if the chosen fix belongs at the summary boundary rather than reconciliation
- `tests/test_biologic_closure.py`
- focused Library/source-summary tests as needed

**Current**

The returned implementation correctly advances the adapter to `gcpl7`, makes both `bm:gcpl5:r1` and `bm:gcpl6:r1` legacy identities, rejects declared/raw direction mismatches, and prevents old `gcpl6` raw/cycle caches from being used by analysis through the generic capability guard.

However, `scanner.reinspect_legacy_biologic_sources()` simply skips a legacy source when `location_status != "online"`. An offline persisted `bm:gcpl6:r1` row therefore keeps its pre-upgrade scalar scientific summaries unchanged: `row_count`, `cycle_count`, `capacity_summary_status="ready"`, and the stored charge/discharge/max-capacity values may all remain live.

That is not merely cosmetic stale metadata. `library.cell_capacity_totals()` intentionally stays relational and bounded; it does not invoke parser capability. If every source has `capacity_summary_status == "ready"`, it sums the persisted `total_charge_capacity_mah` / `total_discharge_capacity_mah` and max discharge value. Consequently an offline `gcpl6` source whose canonical output is no longer trusted can still publish parser-derived capacity numbers in the Cell Database even though analysis correctly reports `canonical_cycling_unavailable`.

The new regression `test_previous_gcpl6_identity_is_reinspected_and_offline_rows_fail_closed` proves the offline identity is treated as unavailable by `source_record_metadata_only()`, but it deliberately leaves `parser_version="bm:gcpl6:r1"` and currently does not assert that the old scalar scientific summaries are withdrawn.

This leaves part of the unsafe `gcpl6` scientific output live and does not satisfy R4's offline fail-closed requirement.

**Target**

When a persisted `gcpl5`/`gcpl6` BioLogic source cannot be re-read because it is offline, reconcile its **live relational scientific state** to fail closed without opening the source:

- retain the original source identity/path and any historical cache bytes for forensic/recovery purposes;
- keep or record an explicit legacy/reinspection-required capability state;
- clear or make unavailable parser-derived live row/cycle/capacity summary fields that were produced under the unsafe identity;
- ensure Cell Database relational summaries cannot display those old values while the source is blocked;
- do not require source I/O merely to perform this downgrade.

If the source is later relinked/comes online, normal current `gcpl7` reinspection may rebuild and republish verified summaries.

**Acceptance criteria**

- An offline persisted `bm:gcpl6:r1` source with previously `ready` capacity summaries becomes fail-closed at startup/reconciliation without opening the source.
- `cell_capacity_totals()` for a Cell containing that source returns unavailable/`None` values rather than the old gcpl6 totals.
- `row_count`/`cycle_count` and any other live parser-derived scalar values that imply current canonical data are withdrawn or otherwise guaranteed not to surface as current science.
- Old gcpl6 Parquet/cache bytes may remain physically present but cannot be served as live scientific output.
- Online valid legacy sources still re-inspect to `bm:gcpl7:r1` and republish verified summaries.
- Offline sources remain relinkable/recoverable; no source file or forensic cache is deleted merely by the downgrade.
- The downgrade remains relational/bounded and performs no source/Parquet reads.
- Existing R1/R2 capability/artifact/warmup protections remain intact.

### R5 — Low: 041.6 closure record is stale after the gcpl7 amendment fix

Affected file:
- `docs/specs/041.6-scientific-regression-real-file-parity-and-closure.md`

**Current**

The implementation record still identifies the user amendment as a `gcpl5 → gcpl6` transition and describes only `bm:gcpl5:r1` as the prior identity. It does not record the exact `29952b5b7d685897bc04f20ed605523345e95cab` R3/R4 implementation checkpoint, the `gcpl7` candidate/verified boundary, `gcpl5` + `gcpl6` reinspection policy, or the latest reported 172-test / no-cache preflight verification.

Those statements are now materially stale relative to the branch being reviewed.

**Target**

Update the pending implementation record to describe the current branch truth without rewriting historical checkpoints. Record the exact R3/R4 implementation SHA, current `gcpl7` semantics and legacy identities, and the latest implementer-reported verification. Preserve the explicit `MPR/MPT parity: NOT RUN` and browser/packaged/manual limitations.

**Acceptance criteria**

- Current amendment text says the live adapter is `gcpl7`, not `gcpl6`.
- Both `bm:gcpl5:r1` and `bm:gcpl6:r1` are documented as legacy/reinspection-only after the R3/R4 correction.
- `29952b5b7d685897bc04f20ed605523345e95cab` and the reported focused/preflight results are attributable to the correct checkpoint.
- Historical gcpl5/gcpl6 checkpoints remain historically accurate rather than being rewritten as if they were always gcpl7.
- MPR/MPT parity, packaged smoke and browser/manual evidence remain truthfully labelled RUN/NOT RUN.

## External scientific closure gate — still BLOCKED

This remains separate from R4/R5 and is **not** an implementer-actionable code finding.

The user amendment deliberately permits the narrow single-direction source-local cycle-1 fallback without a paired `.mpt`; it does **not** waive Parent 041's general same-experiment `.mpr` / `.mpt` validation requirement for multi-cycle scientific closure.

Accordingly:

- real general MPR/MPT semantic parity remains **NOT RUN**;
- the narrow single-direction exception can be implemented/reviewed independently of that missing pair;
- synthetic single-direction fixtures are regression evidence for the exception, not substitute ground truth for general GCPL cycle semantics;
- Parent 041 still cannot be marked `COMPLETE` or ready to merge under the current acceptance criteria after code findings are resolved unless the paired gate is satisfied or explicitly amended.

## Verification record

### Implementer-reported for R3/R4 checkpoint `29952b5b7d685897bc04f20ed605523345e95cab`

- Focused R3/R4 suites: reported PASS — 172 tests.
- `python scripts\preflight.py --no-cache`: reported PASS — 5/5; all 68 backend modules, 541 frontend tests, TypeScript type check and Vite production bundle passed.
- MPR/MPT semantic parity: **NOT RUN**; no paired `.mpt` available.
- Browser/manual feature verification: NOT RUN.

Historical earlier checkpoint verification remains historical evidence and is not restated as proof of the current implementation.

### Reviewer independently inspected in this round

- Exact returned implementation commit `29952b5b7d685897bc04f20ed605523345e95cab` against the R3/R4 handoff checkpoint.
- Current `main` head and merge base.
- `gcpl7` header pending/candidate capability construction.
- Full-map declared-per-`Ns` direction validation and partial-later-`Ns` behavior.
- Candidate promotion and semantic-failure downgrade paths in scanner/import publication.
- Scalar/header-free pending capability behavior.
- Continuation preparation of pending candidates.
- `gcpl5`/`gcpl6` legacy identity boundary and online/offline reinspection behavior.
- Cell Database relational capacity-summary behavior for persisted source summaries.
- Focused R3/R4 tests, including the offline gcpl6 regression's current assertions.
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

**CHANGES REQUIRED — R3 resolved; R4 remains open narrowly; R5 added.**

The row-verification architecture and declared-direction correction are now sound for newly prepared/current sources. The remaining scientific defect is the live relational summary state of offline unsafe `gcpl6` registrations. The closure record must also be brought forward to the actual `gcpl7` checkpoint.

Return only R4/R5 to the implementer and resume `FINAL_REVIEW` after the fixes. The separate general paired MPR/MPT scientific-closure gate remains unchanged.