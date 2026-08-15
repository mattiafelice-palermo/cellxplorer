# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**R2 implementation checkpoint:** `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`  
**Returned workflow head inspected:** `cf5d4a9c69c8fd3e30f1f384635c1c2dedcdc399`  
**Status:** **IMPLEMENTATION REVIEW CLEAN / SCIENTIFIC CLOSURE BLOCKED — not ready to merge**

This is the fresh cumulative Parent 041 review required after child 041.6 became review-clean. It compares the complete feature branch against the verified merge base rather than relying only on child reviews.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app smoke, browser/manual checks, or private MPR/MPT parity during this review.

## Confirmed cumulative behavior

The following parent-level properties were independently re-inspected and remain consistent with the locked design:

- The production MPR reader is independently authored, bounded and limited to the independently observed 16-ID / 53-byte GCPL record layout; the synthetic-only 15-ID / 49-byte variant is rejected.
- The currently verified real MPR has no independently decoded full-cycle identity, so production canonical mapping fails closed and the source is registered metadata-only rather than inventing cycles.
- Three-electrode voltage roles and signed Ewe/Ece handling are explicit; unsupported current/cycle semantics fail closed.
- `.mpr` is admitted through the central source-format registry and `.mpt` is not a user import format.
- Current BioLogic parser identity is `bm:gcpl5:r1`; retired/pre-R8 registrations are reconciled from persisted evidence without opening source files at startup.
- Metadata-only import registration persists provenance/metadata and queues no cycling-cache job. Continued-import acknowledgement is content-hash bound.
- Cell Database list summaries remain relational and bounded; no list-row source-file or Parquet reads were introduced.
- Generic compute and portable export fail closed when canonical cycling is unavailable.
- Saved-artifact get/lookup, thumbnail lookup/latest, store and warmup now use the same generic canonical-cycling capability boundary, so retired scientific artifacts cannot remain live after a source is downgraded to metadata-only.
- The saved-artifact/warmup capability guard remains bounded: live capability checks use persisted scalar identity/status/error state and leave `SourceFile.header_meta` deferred on cache-hit/artifact/warmup paths.
- Generic Time/Capacity voltage selection and saved/export/portable presentation remain format-neutral; no BioLogic-specific downstream scientific branch was added.
- No relational migration or `CALC_VERSION` bump was introduced.
- Runtime requirements do not add a GPL BioLogic parser dependency.
- README/changelog/project architecture text describes current MPR support truthfully as metadata-only.
- No concrete unrelated implementation feature was identified in the cumulative branch scope.
- `main` remains at the original merge base `aca39740039b4d7146afc9104f5c471bff7c7c46` during this final-review round.

## Finding status

### R1 — RESOLVED: retired gcpl3 saved artifacts are no longer live after metadata-only downgrade

The returned fix applies the generic canonical-cycling guard before saved-artifact signature/cache access, covering full artifact get/lookup, thumbnail lookup/latest and stale-client artifact store.

Warmup checks persisted capability when discovering tasks, rechecks it at task admission, and checks again on late completion. A source withdrawn between task admission and browser completion therefore cannot cause a retired thumbnail read or prepared-marker write. The old forensic artifact bytes may remain physically, but their prepared marker is cleared and live endpoints cannot serve them.

The focused regression creates a persisted retired scenario with old `bm:gcpl3:r1` provenance and matching saved artifacts/thumbnails/prepared marker, then performs normal source reconciliation. It asserts `canonical_cycling_unavailable` before artifact/thumbnail cache access and covers the late-completion race.

### R2 — RESOLVED: live capability guards no longer materialize deferred `header_meta`

The R2 fix adds an explicit bounded scalar-only capability mode rather than removing the fail-closed guard.

`canonical_cycling_capability()` now calls `source_record_metadata_only(..., include_header=False)` and `source_record_capability(..., include_header=False)`. In that mode:

- retired `bm:gcpl3:r1` identities remain metadata-only;
- pre-R8 `bm:gcpl4:r1` identities remain fail-closed until reconciliation;
- current `parse_status="metadata_only"` sources remain blocked;
- current reinspection state can be represented from persisted scalar error/status state;
- ordinary canonical sources do not dereference deferred `header_meta` merely to conclude that canonical cycling is available.

Header-aware behavior remains the default for reconciliation/presentation paths that genuinely need persisted binary-layout or protocol evidence.

The focused regression instruments SQL and verifies that a capability check over eight canonical Neware/Excel-style sources plus one metadata-only MPR issues no query containing `header_meta`. The existing retired/pre-R8 and saved-artifact regressions remain in the focused verification tranche.

No new implementation finding remains after the R2 re-review and resumed cumulative pass.

## External scientific closure gate — still BLOCKED

This is **not** an implementer-actionable code finding.

Parent 041 explicitly requires at least one privacy-approved same-experiment `.mpr` / `.mpt` pair for final scientific closure unless the user amends that requirement. The latest implementer handoff still reports no paired `.mpt`, and a reviewer File Library search surfaced only specification documents mentioning `.mpt`, not a same-experiment validation file.

Accordingly:

- real MPR/MPT semantic parity is **NOT RUN**;
- the currently verified real MPR remains metadata-only because full-cycle identity is unresolved;
- the required real registered-source scientific matrix for Cycles, Time/Capacity, Steps, DCIR, Rate Capability and Chargeability cannot truthfully be claimed complete from the current real source;
- synthetic `raw_cycle_index` fixtures remain regression evidence, not substitute external ground truth;
- the feature cannot truthfully be marked `COMPLETE` or ready to merge under the locked Parent 041 acceptance criteria.

The repository workflow helper currently has no distinct `BLOCKED` state: `FINAL_REVIEW` can only transition to `COMPLETE`. Therefore the truthful repository state is to remain `REVIEWER + FINAL_REVIEW` with no open implementation findings until the required paired evidence is supplied, or the user explicitly amends the parent requirement.

## Verification record

### Implementer-reported

Latest R2 implementation checkpoint: `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`.

- Focused closure/analysis/protocol/parsing suites: reported PASS — 89 tests.
- `python scripts\preflight.py`: reported PASS — 5/5; 68 backend modules and 541 frontend policy tests passed; unchanged TypeScript/Vite stages were skipped by the canonical preflight cache.
- R2 deferred-header regression: reported PASS — no `header_meta` SQL query across eight canonical sources and one metadata-only MPR.
- R1 focused backend closure/cache-maintenance/protocol suites: previously reported PASS — 49 tests.
- Earlier R6/R9 checkpoint `7f39d3f`: full backend suite previously reported PASS — 1,145 tests; golden digests unchanged.
- Final frontend/import-progress checkpoint `f5ee8f4`: focused frontend suite previously reported PASS — 20 tests; preflight 5/5 reported PASS.
- Paired MPR/MPT semantic parity: **NOT RUN**; no paired `.mpt` available.
- Packaged Windows MPR smoke: NOT RUN.
- Live browser/manual matrix: NOT RUN.

### Reviewer independently inspected

- Exact R1 patch `33b0efea55ed89e9b7dd18206f57f92d5cda63cc` and its saved-artifact/warmup regression coverage.
- Exact R2 patch `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3` and returned workflow head `cf5d4a9c69c8fd3e30f1f384635c1c2dedcdc399`.
- Artifact read/lookup/thumbnail/store guard ordering.
- Warmup discovery, `_is_current()` admission and late `complete()` capability race handling.
- Bounded source-chain preload and deferred-column behavior.
- Scalar-only versus header-aware metadata-only/reinspection capability paths.
- R2 SQL instrumentation regression.
- Current MPR reader fail-closed layout support and parser-identity upgrade boundary.
- Metadata-only source lifecycle/import acknowledgement and no-cache-job behavior.
- Cell Database relational/list-path boundary.
- Generic scientific, saved-artifact, portable-export and voltage-channel integration boundaries.
- Current `main` head and merge base.
- Parent 041 locked paired-file closure requirement and current workflow state model.

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

**IMPLEMENTATION REVIEW CLEAN — no open R findings. SCIENTIFIC CLOSURE BLOCKED.**

The branch is **not ready to merge** under the current Parent 041 requirements. The only remaining blocker is the locked external same-experiment `.mpr` / `.mpt` validation gate. Keep the workflow in `REVIEWER + FINAL_REVIEW` with no open implementation findings. Resume final scientific closure when the paired evidence is available, or if the user explicitly amends the parent requirement.