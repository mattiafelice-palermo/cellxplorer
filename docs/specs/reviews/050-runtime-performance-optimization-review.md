# Review: Spec 050 — runtime performance optimization

Status: **Final review paused — 050.4 scheduled after user-directed scope amendment**  
Branch: `feature/runtime-performance-optimization`  
Merge base with `main`: `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Last cumulative review head before 050.4 amendment: `c6e782c52aefecb042d5c887b23908b9bf6c10f7`  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)

## Cumulative review scope to date

Performed the Parent 050 cumulative review against the verified merge base rather than only re-reading the child specifications. Runtime-performance implementation through 050.3 is review-clean. The branch also contains repository workflow-infrastructure changes under `docs/specs/workflow/` plus `tests/test_spec_workflow.py`; those changes are not runtime-performance implementation, but they are cumulative branch scope and remain part of the eventual final review.

Proto-child `050.P1` remains planning-only and does not block parent completion.

The first final-review round identified one documentation-only finding, R1. The implementer resolved it in `1fe2beb96e817cf2a0684c0b22d1bf93a136dbc6`, and the reviewer re-inspected the corrected row against the accepted 050.3 profiler semantics.

During that re-review, the user explicitly asked to reconsider reserved 050.4. The prior conclusion that 050.4 was unnecessary relied on backend structural profiling that intentionally used a full-detail request configuration and recorded `frontend_profile: not run`. That evidence proves 050.3 removed whole-source materialization for narrow requests, but it does not prove where the remaining **user-visible** latency lies for the real compact/standard Time/Capacity interaction.

The parent has therefore been amended and numeric child 050.4 authored as an end-to-end profiling and optimization decision gate. Parent final review is paused until 050.4 is implementation-complete and review-clean.

## Child outcomes so far

### 050.1 — analysis query and cache lifecycle

Review-clean after `e3625a7` plus review fix `a7e84d7`.

- Ordinary editor autosave persists state without broad scientific-query invalidation.
- Live and saved-preview Time/Capacity requests propagate the React Query abort signal.
- Previous Time/Capacity data is retained only across the defined scientific compatibility boundary.
- Backend result identities use explicit family-owned scientific projections.
- `ANALYSIS_CACHE_VERSION` changed from 6 to 7 for the cache-identity generation change; `CALC_VERSION` and per-kind response schema versions did not change.
- High child finding R1 was resolved by preventing retained placeholder data from driving plot/image/vector export while preserving the separately request-validated full-resolution data export.

### 050.2 — cycle-addressable raw cache and source index

Review-clean after `43b6cbe` plus review fix `7b70b4a`.

- The canonical parser-versioned raw Parquet remains the scientific raw cache; an independent physical-layout sidecar records exact source-local cycles, row-group membership, bounded timestamp facts and full-source finite voltage availability.
- The optimized writer uses 4,096-row Parquet groups selected from measured structural trade-offs on the approved 71,190-row source.
- Exact-cycle/column selective reads and cache-bytes-only legacy conversion are available without changing scientific identity.
- Background scientific preparation owns conversion; valid raw data without a usable sidecar remains a performance fallback rather than missing science.
- Medium child finding R1 was resolved by rechecking/holding the live pending/protected cleanup boundary at deletion time for automatic, budget and forced scientific cleanup paths.

### 050.3 — indexed Time/Capacity data path

Review-clean after `483ca2b` plus review fix `836ee0d`.

- Time/Capacity builds dense continuation mapping from compact 050.2 indexes before raw record loading and maps requested global cycles to exact source-local cycles.
- Indexed narrow requests read only contributing sources/groups and the explicit required-column projection; row-group spillover is removed before scientific transforms.
- Existing continuous-time, phase/capacity, derivative, protocol-mask, display/downsample and full-resolution serialization semantics remain the scientific path.
- Full-source voltage availability and source-descriptor timestamp facts come from bounded index metadata; valid legacy/unusable layouts retain the full-stitch fallback and genuinely missing middle sources remain fail-closed.
- High child finding R1 was resolved with a non-waiting raw/index consistency probe and non-waiting selective-read boundary so an in-progress background layout conversion does not become part of the Time/Capacity request critical path.
- Medium child finding R2 was resolved by intersecting/clamping range endpoints to the known dense global cycle bounds before materializing request tuples.

### 050.4 — end-to-end Time/Capacity profiling and optimization decision gate

Authored after the user reopened the decision during Parent 050 final review.

This child is intentionally profiling-first. It must instrument the real live compact/standard request and separate backend/HTTP, frontend preparation, Plotly completion and total interaction time, while making cache-hit/miss and indexed/legacy access state explicit. It must not pre-implement an overview, RAM LRU, neighbor prefetch, payload redesign or Plotly rewrite.

If neither agent environment can run the desktop/browser matrix, the child may become implementation/review-clean after instrumentation verification, but Parent 050 must then return to final review and enter `BLOCKED` until the user supplies the exported local profile needed for the optimization decision.

## Cumulative scientific, cache and migration closure through 050.3

- No SQLite migration is introduced by 050.1-050.3.
- `CALC_VERSION` is unchanged because scientific meaning is unchanged.
- Parser identities and `CANONICAL_RAW_VERSION` are unchanged by the physical layout optimization.
- Time/Capacity and other `RESULT_SCHEMA_VERSIONS` remain unchanged because response shape/meaning is preserved.
- `ANALYSIS_CACHE_VERSION` 6 -> 7 is the deliberate 050.1 result-key generation change and is documented in `analysis_cache.py`.
- 050.2 `RAW_CACHE_LAYOUT_VERSION` is a physical cache/access generation and does not enter scientific analysis-result identity.
- The golden analysis regression run reported 30 tests PASS with committed expected digests unchanged after 050.3 and its review fixes.
- Full-resolution selected-range export remains exact; all-cycle export is expected to read all detail.

050.4 is required to preserve these cumulative consequences: instrumentation is observation-only and must not introduce a SQLite/scientific/parser/canonical/raw-layout/result-schema generation change.

## Performance evidence through 050.3

The repeatable 050.3 profiler on the approved 71,190-row / 193-cycle source demonstrates the structural removal of full-source raw materialization for narrow requests:

| Request | Legacy raw rows materialized | Indexed raw groups / rows materialized | Exact rows entering transforms | Returned points |
| --- | ---: | ---: | ---: | ---: |
| 1 cycle | 71,190 | 1/18 / 4,096 | 2,590 | 2,590 |
| 20 cycles | 71,190 | 3/18 / 12,288 | 10,611 | 10,611 |
| 150 cycles | 71,190 | 14/18 / 57,344 | 56,044 | 56,044 |
| All cycles | 71,190 | 18/18 / 71,190 | 71,190 | 71,190 |

The one-cycle indexed request bypassed `load_raw()` and reduced the recorded backend median from 0.145 s to 0.115 s. The durable architectural evidence is the bounded group/row access and exact selected-transform input, not a universal wall-time threshold.

This evidence is **not** an end-to-end interaction profile: the 050.3 harness uses a full-detail backend configuration and explicitly records the frontend profile as not run. 050.4 now owns that missing measurement boundary.

## Verification evidence through Parent round 1

### Implementer-reported

- 050.1 focused frontend/backend policy tests, TypeScript check and `git diff --check`: PASS; canonical preflight: PASS.
- 050.2 focused raw/preparation/cache/stitch, golden and mixed-parser/canonical verification: PASS; canonical preflight: PASS.
- 050.3 initial focused suite: PASS (252 tests); golden analysis: PASS (30, expected digests unchanged); profiler: PASS; canonical preflight: PASS (4/4, 75 backend modules).
- 050.3 R1/R2 fix: focused path/raw-layout suite PASS (20 tests); expanded focused suite PASS (254 tests); golden analysis PASS (30, digests SAME); corrected profiler PASS; canonical preflight PASS (4/4, 75 backend modules).
- Parent R1 documentation fix: `git diff --check` PASS; canonical preflight PASS (4/4, 75 backend modules); runtime/scientific tests not rerun because the change was documentation-only.
- Browser/manual Time/Capacity autosave/export checks: NOT RUN.
- Browser/manual 050.3 interaction/profile matrix: NOT RUN.

### Reviewer-independent

- Reviewed each 050.1-050.3 implementation/fix through the GitHub connector against the active child specifications and current code/tests; child reviews record the exact inspected boundaries.
- Inspected the cumulative cache/version architecture, final indexed Time/Capacity path, durable state/performance documentation, profiler record and canonical preflight discovery behavior.
- Re-inspected Parent R1 fix `1fe2beb`: `docs/agent-knowledge/state-and-performance.md` now correctly reports the one-cycle legacy path as 71,190 raw rows materialized, 2,590 exact rows entering transforms and 2,590 returned points, matching the accepted 050.3 implementation record/profiler semantics.
- The current branch has no GitHub combined-status checks attached at the inspected heads.
- Reviewer-side repository commands and browser checks were not run in the repository-owned Chat + GitHub-connector environment.

## Cumulative branch-scope note

Merging this branch as-is will also merge the workflow-infrastructure updates under `docs/specs/workflow/` and `tests/test_spec_workflow.py`, which predate workflow initialization for this Spec 050 run. They are not part of the runtime scientific implementation, but they are cumulative branch scope and must remain visible in the eventual final merge-readiness decision. If a performance-only merge is required, that scope should be split deliberately rather than reset or discarded by this reviewer.

## Findings

### R1 — Medium: durable performance documentation misstates the one-cycle legacy transform input

Status: **Resolved in `1fe2beb96e817cf2a0684c0b22d1bf93a136dbc6`**

Affected files:
- `docs/agent-knowledge/state-and-performance.md`
- `docs/specs/050.3-indexed-time-capacity-data-path.md` (authoritative profiling reference)

**Current in final-review round 1**

The durable table incorrectly reported 71,190 one-cycle legacy rows entering scientific transforms, conflating full raw materialization with post-cycle-filter transform input.

**Target**

The durable table must distinguish 71,190 raw rows materialized from 2,590 exact selected rows entering transforms.

**Resolution**

`1fe2beb` changes only the durable table's one-cycle legacy transform-input value from 71,190 to 2,590. The remaining rows already matched the accepted profiler/050.3 record. No runtime/scientific/cache/version behavior changed.

**Acceptance criteria**

- **PASS by reviewer inspection:** one-cycle legacy row now reports 71,190 materialized / 2,590 transform-input / 2,590 returned.
- **PASS by reviewer inspection:** the remaining matrix rows match the accepted 050.3 record.
- **PASS:** no runtime/scientific/version change is present in the fix commit.
- **PASS implementer-reported:** `git diff --check` and canonical preflight passed.

## Merge/readiness status

Parent 050 is **not currently merge-ready** because the user explicitly extended the active workstream with numeric child 050.4 before completion. There is no open implementation defect from 050.1-050.3 or Parent R1. The next required action is implementation/review of 050.4, followed by a fresh cumulative Parent 050 final review and the evidence-backed optimization decision.
