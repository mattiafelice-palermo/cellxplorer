# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**Final-review head inspected before this review:** `ed16228ff6ceecf7d29935eb1a720a28c9b6d437`  
**Status:** **CHANGES REQUIRED / SCIENTIFIC CLOSURE BLOCKED — not ready to merge**

This is the fresh cumulative Parent 041 review required after child 041.6 became review-clean. It compares the full feature branch against the verified merge base rather than relying only on child reviews.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app smoke, browser/manual checks, or private MPR/MPT parity during this review.

## Confirmed cumulative behavior

The following parent-level properties were independently re-inspected and are consistent with the locked design:

- The production MPR reader is independent and bounded. It accepts only the independently observed 16-ID / 53-byte GCPL record layout and rejects the synthetic-only 15-ID / 49-byte variant.
- The currently verified real MPR layout has no independently decoded full-cycle identity. Production canonical mapping therefore fails closed and the source is registered metadata-only rather than inventing cycles.
- Ewe/Ece handling is explicit: working and counter potentials are retained as auxiliary channels; primary cell voltage is derived from working-counter only under the verified signed contract. Unsupported measured-current semantics fail closed.
- `.mpr` is admitted through the central supported-source registry; `.mpt` is not a user import format.
- Parser identity is source-specific. Current BioLogic identity is `bm:gcpl5:r1`; retired/pre-R8 MPR identities are reconciled through persisted evidence without reading the source file on startup.
- Metadata-only import registration stores provenance/metadata and deliberately queues no cycling cache job. Continued-import acknowledgement is content-hash bound.
- Cell Database list summaries remain relational and bounded; the list path does not open source files, read Parquet per row, or deserialize the full stored header.
- Generic scientific compute endpoints and portable export guard canonical-cycling availability before cache-backed computation/export.
- Generic Time/Capacity voltage-channel selection, saved-plot configuration, export identity and presentation remain format-neutral; no BioLogic-specific scientific branch was added downstream of parsing.
- No persistent schema migration was added. `CALC_VERSION` remains unchanged because generic scientific meaning did not change.
- Runtime requirements do not add a GPL BioLogic parser dependency. Production code uses the project-owned reader/adapter; durable provenance documentation records the external comparison boundary.
- README, changelog and project architecture documentation truthfully describe the currently verified MPR support as metadata-only rather than claiming completed scientific parity.
- The broad analysis/artifact diff is attributable to the generic three-electrode voltage-channel/saved-artifact work required by 041.5; no concrete unrelated implementation feature was identified in the cumulative branch scope.

## Finding

### R1 — High: retired gcpl3 saved plot artifacts can remain renderable after the source is downgraded to metadata-only

Affected files:
- `backend/app/routers/analyses.py`
- `backend/app/services/analysis_cache.py` and/or the shared artifact-capability boundary
- `backend/app/services/cache_maintenance.py`
- `tests/test_biologic_closure.py`
- focused saved-artifact / warmup endpoint tests as appropriate

**Current**

The gcpl3 retirement path correctly changes the live `SourceFile` registration to metadata-only, but deliberately leaves old caches on disk for forensic cleanup. That is safe only if every live scientific consumer checks persisted capability before reading those caches.

The main compute endpoints and portable export do this. The saved-plot artifact surface does not.

`reclassify_retired_biologic_source()` changes parser/capability/status fields but preserves the source hash, historical `Analysis.provenance`, saved artifact files, thumbnail indexes and prepared markers.

For a saved analysis pinned to the rejected `bm:gcpl3:r1` identity:

1. `sources_changed_since_compute()` compares source **hashes only**, so the capability/parser downgrade does not mark the source changed when the bytes are identical.
2. `analysis_cache.saved_plot_data_signature()` calls `result_key(..., use_current_versions=False)`, so historical provenance can continue resolving the old pinned gcpl3 parser identity. The old saved-plot scientific signature can therefore remain exactly the signature under which the invalid artifact/thumbnail was stored.
3. `get_plot_artifact`, artifact lookup, thumbnail lookup, `thumbnail/latest`, and artifact store call `_guard_saved_plot_protocol_analysis()` but do **not** call the canonical-cycling capability guard before calculating the signature or reading/writing the artifact cache.
4. `WarmupCoordinator._tasks_for_analyses()` likewise uses the pinned saved-plot signature and can treat a matching prepared marker + old thumbnail as already ready without checking that the selected source is now metadata-only.
5. The Analysis Database hover preview calls `thumbnail/latest`, so this is user-visible: an invalid gcpl3 plot thumbnail can still be displayed after startup reconciliation has explicitly withdrawn the underlying scientific semantics.

This violates the Parent 041 fail-closed requirement and the earlier upgrade-safety decision that retired gcpl3 caches may remain only as non-live forensic data.

**Target**

Make persisted canonical-cycling capability authoritative at **every saved-artifact live boundary**, before any retired artifact/thumbnail can be read, adopted, considered prepared, or newly stored.

Reuse the generic canonical-cycling capability mechanism; do not add a BioLogic-specific artifact branch. It is acceptable to retain old artifact files physically for later cleanup, but no live UI/export/warmup consumer may present or perpetuate them once the source is metadata-only.

The implementation should preserve bounded behavior. In particular, do not solve the warmup case with source-file reads, Parquet reads, scientific recomputation, or an avoidable request-path N+1 pattern.

**Acceptance criteria**

- Add a regression fixture containing:
  - a persisted MPR `SourceFile` registered under retired `bm:gcpl3:r1` canonical semantics;
  - an `Analysis` with provenance pinned to `bm:gcpl3:r1`;
  - a saved plot plus full artifact, saved/preview thumbnails, thumbnail index and/or prepared marker under the matching old data signature.
- After normal startup/reconciliation downgrades the source to current metadata-only state, all live saved-artifact read surfaces fail closed before serving the old scientific payload:
  - full artifact get/lookup;
  - thumbnail lookup/latest;
  - any equivalent saved-plot preview path.
- A stale client cannot store/re-publish an artifact for the downgraded metadata-only analysis merely because its old pinned signature still matches.
- Warmup does not treat the retired artifact/thumbnail as valid prepared work and does not authorize a render/store cycle that can revive it. A bounded generic “unavailable” disposition or equivalent fail-closed behavior is acceptable.
- The blocked response uses the existing generic `canonical_cycling_unavailable` capability contract (or an equivalently generic established artifact-unavailable contract), not an MPR-specific scientific special case.
- The regression proves the artifact/cache loader is not reached for a blocked retired source, or otherwise proves no retired artifact bytes can be returned.
- Ordinary Neware/Excel saved artifacts and warmup behavior remain unchanged.
- Portable export and normal compute/recompute remain blocked as they are today for the same metadata-only source.

## External scientific closure gate — still BLOCKED

This is independent of R1 and is **not** an implementer-actionable code finding.

Parent 041 explicitly locks final scientific closure to at least one privacy-approved same-experiment `.mpr` / `.mpt` pair unless the user changes that requirement. No paired `.mpt` ground truth is currently available.

Accordingly:

- real MPR/MPT semantic parity is **NOT RUN**;
- the currently verified real MPR stays metadata-only because full-cycle identity is unresolved;
- the required real registered-source scientific matrix for Cycles, Time/Capacity, Steps, DCIR, Rate Capability and Chargeability cannot truthfully be claimed complete from the current real source;
- synthetic `raw_cycle_index` fixtures remain regression evidence, not substitute external ground truth.

Even after R1 is fixed, Parent 041 must remain in `FINAL_REVIEW` / scientifically blocked until the required paired evidence is supplied and the locked parity/registered-source closure checks are completed, or the user explicitly amends the parent requirement.

## Verification record

### Implementer-reported verification available to the final review

Latest implementation checkpoint before workflow/review-only commits: `f5ee8f4d1ebba84ed4ffa964f969d0e7120a8384`.

- Final R11 focused frontend import-progress suite: PASS — 20 tests.
- `python scripts\preflight.py` on `f5ee8f4`: reported PASS — 5/5; 68 backend modules, 541 frontend policy tests, TypeScript and Vite production bundle passed.
- Earlier R6/R9 checkpoint `7f39d3f2edf74fbe4a4a7ec6b4536d88c15e0a0a`: reported full backend suite PASS — 1,145 tests; golden digests unchanged; focused MPR/import/protocol suites passed.
- Historical earlier checkpoint `01c7a73`: reported exact no-cache preflight PASS — 5/5.
- Paired MPR/MPT semantic parity: **NOT RUN**; no `.mpt` available.
- Packaged Windows MPR smoke: NOT RUN.
- Live browser/manual matrix: NOT RUN.

The workflow/review commits after `f5ee8f4` did not change production implementation before this cumulative review.

### Reviewer independently inspected in the cumulative review

- Current branch state and exact merge base.
- Full branch compare/scope at a high level plus representative implementation checkpoints.
- Parent 041 locked decisions and final acceptance requirements.
- Independent MPR reader layout/bounds/fingerprint logic and durable format provenance.
- GCPL canonical mapper cycle/step/current/voltage fail-closed behavior.
- Central source registry, `.mpr` admission and `.mpt` exclusion.
- gcpl3/gcpl4 retirement/reconciliation and current gcpl5 persisted capability behavior.
- Metadata-only import registration and no-cache-job path.
- Cell Database relational summary path.
- Generic analysis capability guard and hash-only staleness logic.
- Saved-plot result signatures, artifact/thumbnail load/store endpoints, warmup prepared-marker logic and Analysis Database preview call site.
- Portable-export canonical capability guard.
- Generic voltage-channel policy.
- Runtime dependency list and packaging import surface.
- Version/CALC_VERSION/migration scope.
- README, changelog and project architecture closure text.

### Reviewer did NOT independently execute

- Python/backend tests.
- Frontend policy tests.
- `scripts/preflight.py`.
- TypeScript/Vite build.
- Packaged Windows smoke.
- Browser/manual matrix.
- Private real-file parse during this final-review round.
- MPR/MPT semantic parity.

## Decision

**CHANGES REQUIRED — R1 must be fixed before the final cumulative code review can be clean.**

The branch is **not ready to merge**. After R1 returns, resume `FINAL_REVIEW` and re-check the saved-artifact/warmup capability boundary. If no further implementation defects remain, Parent 041 will still remain scientifically blocked by the external paired MPR/MPT closure gate until that evidence is available or the user explicitly changes the locked requirement.