# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**R2 implementation checkpoint:** `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`  
**User-amendment implementation checkpoint:** `befc0863de5b616d8d08de180afe8d909a9d8252`  
**Status:** **CHANGES REQUIRED / SCIENTIFIC CLOSURE BLOCKED — not ready to merge**

This is the cumulative Parent 041 review. R1/R2 were previously resolved and the implementation review was clean before the 2026-08-15 user amendment. The amendment deliberately adds one narrow cycle-identity exception for a declared, non-repeating charge/rest-only or discharge/rest-only MPR when decoded rows prove constant-zero half-cycle, monotonic `Ns`, one signed active-current direction and at least one active row. The inferred cycle `1` is source-local only.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app smoke, browser/manual checks, or private MPR/MPT parity during this amendment review.

## Confirmed cumulative behavior

The following earlier Parent 041 properties remain intact after the amendment unless explicitly covered by R3/R4 below:

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
- The amendment correctly advances the MPR adapter identity from `gcpl5` to `gcpl6` and keeps persisted `bm:gcpl5:r1` registrations fail-closed until source reinspection.
- The constant-zero half-cycle requirement is enforced before the new fallback by `_validate_supported_half_cycle()`; non-zero or regressing half-cycle values remain rejected.
- Source-local cycle numbering is compatible with the existing generic stitcher: each source's local cycle labels are remapped densely to test-global cycles while `source_cycle` preserves the local label, so multiple source-local cycle-1 segments do not collide.
- The gcpl5 reinspection pass runs from the post-listening scientific warmup thread rather than delaying API reachability.

## Finding status

### R1 — RESOLVED: retired gcpl3 saved artifacts are no longer live after metadata-only downgrade

The generic canonical-cycling guard now applies before saved-artifact signature/cache access and across warmup discovery, task admission and late completion. Retired scientific bytes may remain for forensic cleanup but are not live.

### R2 — RESOLVED: live capability guards no longer materialize deferred `header_meta`

The generic capability path uses persisted scalar identity/status/error state with `include_header=False`; header-aware behavior remains limited to reconciliation/presentation paths that genuinely need persisted header evidence.

### R3 — High: header-only eligibility is published as verified canonical cycling before decoded-row validation

Affected files:
- `backend/app/services/biologic_gcpl.py`
- `backend/app/services/parsing.py`
- `backend/app/services/scanner.py`
- `backend/app/routers/files.py`
- `tests/test_biologic_closure.py`
- `tests/test_import_flow.py`

**Current**

The user amendment requires the cycle-1 exception only after **decoded rows** prove the bounded single-direction conditions. Header inspection intentionally does not decode the VMP data records: `read_gcpl_header_metadata()` opens the MPR with `decode_records=False` and can therefore establish only that the declared settings are *eligible* for the fallback.

However, `_gcpl_metadata_from_document()` converts that settings-only eligibility directly into:

```python
"cycling_rows": True
"canonical_cycling": True
"metadata_only": False
"cycle_identity_source": "single_direction_inferred"
```

before any row has been checked. The warning itself says the adapter **will verify** the rows later, which confirms that this state is still provisional.

That provisional header result is then used as persisted capability state. A newly inspected/registered candidate can be stored as `unparsed`/`parsing` while its header already says canonical cycling is available. Import preview text likewise reports `Canonical cycling rows available` from the header-only result.

More importantly, if the later full cache build rejects the decoded rows, the normal import/scanner failure paths set `parse_status="error"` and `parse_error`, but they do not downgrade the persisted header capability to metadata-only. The scalar capability guard introduced by Parent R2 intentionally does not load `header_meta`; for a current non-retired source whose status is merely `error`, `source_record_metadata_only(..., include_header=False)` therefore does not identify it as metadata-only. The branch can consequently retain a persisted state that advertises canonical capability even though the row-level proof required by the amendment failed.

This violates the amendment's locked distinction between a declared candidate and a **verified** single-direction source. Mixed directions, non-monotonic execution and other fallback failures are required to remain metadata-only, not canonical-capable registrations with a generic parse error.

**Target**

Keep header inspection bounded and record-decode-free, but distinguish **single-direction candidate/eligibility** from **verified canonical cycling**.

A header-only candidate must not be published through the live capability contract as already verified canonical cycling. The import/scanner pipeline may still automatically queue/perform the full parse without asking the user for a metadata-only acknowledgement; the candidate state simply must not become scientifically usable until the decoded-row validation succeeds.

After a successful full parse of a candidate, persist/promote the source to current canonical capability and normal parsed/cache state. If a structurally valid candidate fails the bounded single-direction row checks (mixed sign, non-monotonic `Ns`, unsupported half-cycle, ambiguous active direction, etc.), persist a truthful fail-closed metadata-only/unavailable capability rather than leaving the source canonical-capable with only a generic error. Truly corrupt/invalid source failures may remain errors as appropriate; the important distinction is that failure to prove the cycle-1 exception cannot leave canonical capability live.

Do not solve this by decoding all VMP records during the batch/header inspection path.

**Acceptance criteria**

- Header-only inspection of a declared single-direction MPR remains `decode_records=False` / bounded and does not claim that row-verified canonical cycling already exists.
- The candidate still proceeds automatically to normal full scientific preparation; no new user acknowledgement is required merely because row verification is pending.
- A valid charge/rest-only and a valid discharge/rest-only source become `parsed`, current-parser canonical sources only after full row validation and cache publication succeed.
- A declared single-direction source whose rows violate one of the amendment conditions ends in a persisted fail-closed non-canonical state; generic analysis/artifact/warmup capability checks return `canonical_cycling_unavailable` before scientific cache use.
- A failed fallback verification cannot leave `header_meta`/scalar source state claiming canonical cycling or `cycle_identity_source="single_direction_inferred"` as an accomplished fact.
- Focused import/scanner regressions cover at least a settings-eligible source with row-level mixed signs or non-monotonic `Ns`, including the persisted post-failure capability state.
- Existing metadata-only acknowledgement semantics for genuinely non-candidate MPR sources remain unchanged.
- No full record decode, source-wide scientific computation or per-file heavy work is added to the header-only batch inspection path.

### R4 — High: the cycle-1 fallback does not verify observed direction against the declared per-`Ns` protocol direction

Affected files:
- `backend/app/services/biologic_gcpl.py`
- `tests/test_biologic_gcpl.py`
- `tests/test_biologic_closure.py` / import lifecycle tests as needed for the persisted fail-closed result
- parser-identity/reinspection declarations if the corrected contract invalidates existing `gcpl6` cache output

**Current**

The amendment is specifically for a declared **charge/rest-only** or **discharge/rest-only** run whose decoded rows confirm that same single-direction execution.

`_is_single_direction_protocol()` currently collapses the declared settings to a boolean. It verifies that all declared active sequences have one direction, but it does not return/preserve which direction that is. `_single_direction_cycle_is_safe()` then checks only that the decoded current contains one non-zero sign globally. `_validate_document_settings()` verifies that observed `Ns` values exist in the settings but does not compare the observed operation to the declared sequence for that `Ns`.

As a result, a file with a declared charge-only protocol can pass the fallback when its decoded rows are all negative-current discharge rows. The raw mapper then labels those rows `CC_DChg`, while the persisted declared protocol still says charge. Likewise, an `Ns` declared as Rest can carry an active galvanostatic row without the fallback itself rejecting the declared/raw semantic contradiction, provided the source remains globally one-sign and other raw/capacity checks pass.

That produces internally inconsistent scientific representations: protocol-aware consumers can see a different operation/direction from the canonical raw rows. It also violates the fail-closed intent of the amendment; a one-sign current is not sufficient proof if it contradicts the settings that made the source eligible for the exception.

**Target**

For the no-full-cycle-field fallback, validate decoded execution against the declared sequence semantics indexed by normalized `Ns`, not only against a global settings boolean.

At minimum:

- observed active rows/blocks for an `Ns` declared charge must have the supported positive charge direction;
- observed active rows/blocks for an `Ns` declared discharge must have the supported negative discharge direction;
- an observed `Ns` declared Rest must not execute as an active current operation;
- unsupported/control/ambiguous declared directions remain ineligible;
- partial files may observe only a subset of the declared sequence and may start at a later declared `Ns`; do not require execution to begin at sequence 1 merely to enforce semantic agreement.

Any mismatch must fail closed and, together with R3, end in a non-canonical persisted state.

Because `befc086` can already create `bm:gcpl6:r1` canonical caches for inputs that the corrected contract must reject, the fix must also preserve cache/provenance safety. Advance the MPR parser identity again or provide an equivalently deterministic invalidation/reinspection boundary that proves no cache created under the unsafe `gcpl6` contract can remain live after the correction. Offline persisted sources must fail closed until they can be safely reconciled/reinspected.

**Acceptance criteria**

- Declared charge + decoded negative/discharge current is rejected by the fallback.
- Declared discharge + decoded positive/charge current is rejected.
- A declared Rest `Ns` carrying an active galvanostatic execution is rejected.
- Valid charge/rest-only and discharge/rest-only sources remain accepted.
- A valid partial source that starts at a later declared `Ns` remains accepted when all observed execution agrees with the corresponding declared steps.
- The fallback continues to require constant-zero half-cycle, monotonic `Ns`, at least one active row, one observed current sign and no loop/repeat structure.
- Protocol metadata and canonical raw `status`/current direction cannot disagree for an accepted fallback source.
- Existing explicit `raw_cycle_index` semantic tests are not unnecessarily constrained by this fallback-only rule.
- Any canonical cache/provenance created under the now-unsafe `bm:gcpl6:r1` acceptance boundary cannot remain current after the fix; focused upgrade/offline tests cover the chosen revision/invalidation strategy.
- No BioLogic-specific branch is added to downstream generic scientific calculations.

## External scientific closure gate — still BLOCKED

This remains separate from R3/R4 and is **not** an implementer-actionable code finding.

The user amendment deliberately permits the narrow single-direction source-local cycle-1 fallback without a paired `.mpt`; it does **not** waive Parent 041's general same-experiment `.mpr` / `.mpt` validation requirement for multi-cycle scientific closure.

Accordingly:

- real general MPR/MPT semantic parity remains **NOT RUN**;
- the narrow single-direction exception can be implemented/reviewed independently of that missing pair;
- synthetic single-direction fixtures are regression evidence for the exception, not substitute ground truth for general GCPL cycle semantics;
- Parent 041 still cannot be marked `COMPLETE` or ready to merge under the current acceptance criteria after code findings are resolved unless the paired gate is satisfied or explicitly amended.

## Verification record

### Implementer-reported for amendment checkpoint `befc0863de5b616d8d08de180afe8d909a9d8252`

- Single-direction MPR mapper/import/cache focused suites: reported PASS — 251 tests.
- `python scripts\preflight.py --no-cache`: reported PASS — 5/5; all 68 backend modules, 541 frontend policy tests, TypeScript type check and Vite production bundle passed.
- Vite completed with the existing chunk-size and static/dynamic-import warnings.
- `git diff --check`: reported PASS.
- Paired MPR/MPT semantic parity: **NOT RUN**; no paired `.mpt` available.
- Browser/manual feature verification: NOT RUN.

Earlier R1/R2 verification remains historical evidence and is not restated as proof of the amendment.

### Reviewer independently inspected in this amendment review

- Exact amendment diff `3e9596cf93c3d40dcd15fc3be6ae9fde605a17e5..befc0863de5b616d8d08de180afe8d909a9d8252`.
- Amended Parent 041 and 041.6 locked single-direction conditions.
- GCPL settings direction decoding and declared protocol construction.
- `_validate_document_settings()`, `_validate_supported_half_cycle()`, `_single_direction_cycle_is_safe()` and the canonical mapper ordering.
- Header-only metadata construction and its persisted capability flags.
- Import preview/capacity-preview, registration, cache-worker result publication and scanner parse/update paths.
- Persisted scalar/header capability behavior after the prior Parent R2 fix.
- gcpl5 → gcpl6 identity/reinspection path and startup warmup ownership.
- Generic multi-source stitch behavior for source-local cycle labels.
- New focused mapper/import/closure tests, including the absence of declared-vs-observed direction mismatch and post-row-verification capability regressions.
- Current `main` head and merge base.

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

**CHANGES REQUIRED — R3 and R4.**

The single-direction amendment is directionally correct and preserves the existing generic stitch/scientific architecture, but the current implementation promotes a settings-only candidate to canonical capability before the required row proof and does not enforce semantic agreement between the declared per-`Ns` direction and the decoded execution.

Return only R3/R4 to the implementer and resume `FINAL_REVIEW` after the fixes. The separate general paired MPR/MPT scientific-closure gate remains unchanged.