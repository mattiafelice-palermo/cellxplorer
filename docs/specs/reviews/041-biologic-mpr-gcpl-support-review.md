# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**Returned handoff head:** `86bc6f6cd1eef7705ab866ee40865af03e6e9ea0`  
**Status:** **CHANGES REQUIRED / SCIENTIFIC CLOSURE BLOCKED — not ready to merge**

This is the fresh cumulative Parent 041 review required after child 041.6 became review-clean. It compares the full feature branch against the verified merge base rather than relying only on child reviews.

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
- Generic Time/Capacity voltage selection and saved/export/portable presentation remain format-neutral; no BioLogic-specific downstream scientific branch was added.
- No relational migration or `CALC_VERSION` bump was introduced.
- Runtime requirements do not add a GPL BioLogic parser dependency.
- README/changelog/project architecture text describes current MPR support truthfully as metadata-only.
- No concrete unrelated implementation feature was identified in the cumulative branch scope.

## Finding status

### R1 — RESOLVED: retired gcpl3 saved artifacts are no longer live after metadata-only downgrade

The returned fix applies the generic canonical-cycling guard before saved-artifact signature/cache access, covering full artifact get/lookup, thumbnail lookup/latest and stale-client artifact store.

Warmup now checks persisted capability when discovering tasks, rechecks it at task admission, and checks again on late completion. A source withdrawn between task admission and browser completion therefore cannot cause a retired thumbnail read or prepared-marker write. The old forensic artifact bytes may remain physically, but their prepared marker is cleared and live endpoints cannot serve them.

The focused regression creates a real persisted-retired scenario: old `bm:gcpl3:r1` provenance, matching saved artifact/thumbnails/prepared marker, then normal source reconciliation. It asserts 422 `canonical_cycling_unavailable` before all artifact/thumbnail loaders and stores, asserts warmup builds no task, and covers the late-completion race without reading the old thumbnails.

This resolves the scientific-output leak originally reported as R1.

### R2 — Medium: the canonical-capability guard lazy-loads full `header_meta` once per source on hot paths

Affected files:
- `backend/app/services/analysis_engine.py`
- `backend/app/services/parsing.py`
- focused capability/query-count or deferred-column regression tests
- `backend/app/services/cache_maintenance.py` only if the chosen fix changes warmup loading strategy

**Current**

The R1 fix correctly tried to keep the new artifact/warmup capability boundary bounded by adding:

```python
preload_cell_sources(db, cells)
```

to `canonical_cycling_capability()`. That preload deliberately uses:

```python
.defer(SourceFile.header_meta)
```

because `header_meta` is large and the repository explicitly avoids decoding it on cache-hit paths.

However, the subsequent capability loop calls `parsing.source_record_metadata_only(source)` for every selected source. That function eventually executes:

```python
header = getattr(source, "header_meta", None)
```

for every ordinary canonical non-MPR source whose `parse_status` is not `metadata_only`. For current `.mpr` sources, `source_requires_biologic_mpr_reinspection()` dereferences `header_meta` even earlier, before the `parse_status == "metadata_only"` short-circuit.

Because `header_meta` was intentionally deferred, each such dereference is a lazy ORM column load. In a multi-cell analysis this reintroduces one SQL query plus JSON materialization per source after the bounded preload. The capability check now sits in multiple latency-sensitive paths:

- normal scientific compute/cache-hit guarding;
- saved-artifact and hover-thumbnail reads introduced by the R1 fix;
- artifact writes;
- warmup discovery/admission/late completion.

This contradicts the explicit loading invariant documented in `preload_cell_sources()` that `header_meta` should remain deferred on cache-hit paths, and it misses R1's acceptance requirement to avoid an avoidable request-path N+1 solution.

The issue is not source-file I/O and does not corrupt science, but it can make a cached/preview operation scale with selected source count and repeatedly deserialize large persisted headers.

**Target**

Make the live canonical-cycling capability decision from bounded relational/scalar state without lazily materializing full `SourceFile.header_meta` per selected source.

Use the existing persisted scalar facts wherever sufficient (`ext`, `parser_version`, `parse_status`, reconciliation state). If a legacy persisted edge genuinely still requires header evidence, resolve it through a bounded one-time reconciliation or a bounded bulk strategy rather than one deferred-column query per source on every live capability check.

Do not weaken the fail-closed gcpl3/gcpl4 reconciliation semantics merely to improve performance.

**Acceptance criteria**

- A capability check over multiple ordinary canonical Neware/Excel sources does not lazy-load `SourceFile.header_meta` once per source.
- A current metadata-only MPR is still detected correctly without opening its source file and without per-request reparsing.
- Retired `bm:gcpl3:r1`, pre-R8 gcpl4 and `requires_reinspection` cases remain fail-closed with the same warnings/capability result.
- Saved artifact get/lookup/thumbnail/store and warmup retain the R1 capability guard.
- Add a focused regression proving the capability path remains bounded as source count grows. A SQL statement-count assertion, deferred-column-state assertion, or equivalent deterministic check is acceptable.
- The regression specifically proves ordinary canonical cache-hit/artifact capability checks do not materialize full headers merely to conclude `canonical_cycling=true`.
- No source-file reads, Parquet reads, scientific recomputation, migration or `CALC_VERSION` change is introduced.

## External scientific closure gate — still BLOCKED

This remains independent of R2 and is **not** an implementer-actionable code finding.

Parent 041 explicitly requires at least one privacy-approved same-experiment `.mpr` / `.mpt` pair for final scientific closure unless the user amends that requirement. No paired `.mpt` ground truth is currently available.

Accordingly:

- real MPR/MPT semantic parity is **NOT RUN**;
- the currently verified real MPR remains metadata-only because full-cycle identity is unresolved;
- the required real registered-source scientific matrix for Cycles, Time/Capacity, Steps, DCIR, Rate Capability and Chargeability cannot truthfully be claimed complete from the current real source;
- synthetic `raw_cycle_index` fixtures remain regression evidence, not substitute external ground truth.

Even after R2 is fixed, Parent 041 must remain in `FINAL_REVIEW` / scientifically blocked until the required paired evidence is supplied and the locked parity/registered-source closure checks are completed, or the user explicitly amends the parent requirement.

## Verification record

### Implementer-reported

R1 implementation checkpoint: `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`.

- Focused backend closure/cache-maintenance/protocol suites: reported PASS — 49 tests.
- `python scripts\preflight.py`: reported PASS 5/5; 68 backend modules and 541 frontend policy tests passed; unchanged TypeScript/Vite stages were skipped by the canonical preflight cache.
- Paired MPR/MPT semantic parity: **NOT RUN**; no `.mpt` available.
- Packaged Windows MPR smoke: NOT RUN.
- Live browser/manual matrix: NOT RUN.

Earlier implementation verification remains recorded in child 041.6, including the 1,145-test backend run at `7f39d3f` and final frontend/preflight runs at `f5ee8f4`.

### Reviewer independently inspected in this R1 re-review

- Exact R1 patch `33b0efea55ed89e9b7dd18206f57f92d5cda63cc` and returned workflow head `86bc6f6cd1eef7705ab866ee40865af03e6e9ea0`.
- Artifact read/lookup/thumbnail/store guard ordering.
- Warmup discovery, `_is_current()` admission and late `complete()` capability race handling.
- R1 regression fixture and cache-loader/store assertions.
- `preload_cell_sources()` loading strategy.
- `source_record_metadata_only()` and `source_requires_biologic_mpr_reinspection()` persisted-header access.
- Current `main` head, which remains the original merge base `aca39740039b4d7146afc9104f5c471bff7c7c46`.

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

**CHANGES REQUIRED — R1 is resolved; return R2 only and resume `FINAL_REVIEW`.**

The branch is **not ready to merge**. After R2 returns, re-check the bounded capability path and the previously fixed saved-artifact boundary. If no further implementation defects remain, Parent 041 will still remain scientifically blocked by the external paired MPR/MPT closure gate until that evidence is available or the user explicitly changes the locked requirement.