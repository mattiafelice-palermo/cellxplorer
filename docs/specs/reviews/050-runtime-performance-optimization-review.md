# Review: Spec 050 — runtime performance optimization

Status: **Changes required — final review round 1**  
Branch: `feature/runtime-performance-optimization`  
Merge base with `main`: `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Reviewed branch head: `c6e782c52aefecb042d5c887b23908b9bf6c10f7`  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)

## Cumulative review scope

Performed the Parent 050 cumulative review against the verified merge base rather than only re-reading the child specifications. The branch is 31 commits ahead of `main` and 0 behind at this review point. Runtime-performance implementation spans the three scheduled numeric children 050.1-050.3. The branch also contains repository workflow-infrastructure changes under `docs/specs/workflow/` plus `tests/test_spec_workflow.py`; those changes are not runtime-performance implementation, but they are part of the cumulative branch that would be merged as it currently exists.

All three scheduled numeric children are review-clean. Proto-child `050.P1` remains planning-only and does not block parent completion. Reserved child 050.4 was explicitly judged unnecessary from the 050.3 profiling evidence and was not authored or implemented.

The runtime implementation is cumulatively clean by code/test inspection, but the parent is not yet merge-ready because one durable performance-documentation error remains.

## Child outcomes

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

## Cumulative scientific, cache and migration closure

- No SQLite migration is introduced by Spec 050.
- `CALC_VERSION` is unchanged because scientific meaning is unchanged.
- Parser identities and `CANONICAL_RAW_VERSION` are unchanged by the physical layout optimization.
- Time/Capacity and other `RESULT_SCHEMA_VERSIONS` remain unchanged because response shape/meaning is preserved.
- `ANALYSIS_CACHE_VERSION` 6 -> 7 is the deliberate 050.1 result-key generation change and is documented in `analysis_cache.py`.
- 050.2 `RAW_CACHE_LAYOUT_VERSION` is a physical cache/access generation and does not enter scientific analysis-result identity.
- The golden analysis regression run reported 30 tests PASS with committed expected digests unchanged after 050.3 and its review fixes.
- Full-resolution selected-range export remains exact; all-cycle export is expected to read all detail.

## Performance evidence and 050.4 decision

The repeatable 050.3 profiler on the approved 71,190-row / 193-cycle source demonstrates the structural removal of full-source raw materialization for narrow requests:

| Request | Legacy raw rows materialized | Indexed raw groups / rows materialized | Exact rows entering transforms | Returned points |
| --- | ---: | ---: | ---: | ---: |
| 1 cycle | 71,190 | 1/18 / 4,096 | 2,590 | 2,590 |
| 20 cycles | 71,190 | 3/18 / 12,288 | 10,611 | 10,611 |
| 150 cycles | 71,190 | 14/18 / 57,344 | 56,044 | 56,044 |
| All cycles | 71,190 | 18/18 / 71,190 | 71,190 | 71,190 |

The one-cycle indexed request bypassed `load_raw()` and reduced the recorded backend median from 0.145 s to 0.115 s; the important acceptance evidence is the bounded group/row access and exact selected-transform input, not a universal wall-time threshold. Wider requests remain dominated by unchanged scientific transforms and serialization. On this evidence, no distinct backend overview/LRU/prefetch bottleneck justified reserved child 050.4, so it remains not needed.

## Verification evidence

### Implementer-reported

Across the final child/fix handoffs:

- 050.1 focused frontend/backend policy tests, TypeScript check and `git diff --check`: PASS; canonical preflight: PASS.
- 050.2 focused raw/preparation/cache/stitch, golden and mixed-parser/canonical verification: PASS; canonical preflight: PASS.
- 050.3 initial focused suite: PASS (252 tests); golden analysis: PASS (30, expected digests unchanged); profiler: PASS; canonical preflight: PASS (4/4, 75 backend modules).
- 050.3 R1/R2 fix: focused path/raw-layout suite PASS (20 tests); expanded focused suite PASS (254 tests); golden analysis PASS (30, digests SAME); corrected profiler PASS; canonical preflight PASS (4/4, 75 backend modules).
- Browser/manual Time/Capacity autosave/export checks: NOT RUN.
- Browser/manual 050.3 interaction/profile matrix: NOT RUN.

### Reviewer-independent

- Reviewed each implementation/fix through the GitHub connector against the active child specifications and current code/tests; child reviews record the exact inspected boundaries.
- Re-checked the complete branch against merge base `1dc3525e`: 31 commits ahead, 0 behind.
- Inspected the cumulative cache/version architecture, final indexed Time/Capacity path, durable state/performance documentation, profiler record and canonical preflight discovery behavior.
- Confirmed `scripts/run_backend_tests.py` discovers every `tests/test_*.py`, so the branch's unrelated `tests/test_spec_workflow.py` is within the canonical preflight backend-module discovery rather than an untested side file.
- The current branch head has no GitHub combined-status checks attached.
- Reviewer-side repository commands and browser checks were not run in the repository-owned Chat + GitHub-connector environment.

## Cumulative branch-scope note

Merging this branch as-is will also merge the workflow-infrastructure updates under `docs/specs/workflow/` and `tests/test_spec_workflow.py`, which predate workflow initialization for this Spec 050 run. They are not part of the runtime scientific implementation, but they are cumulative branch scope and have not been silently excluded from this review. If a performance-only merge is required, that scope should be split deliberately rather than reset or discarded by this reviewer.

## Findings

### R1 — Medium: durable performance documentation misstates the one-cycle legacy transform input

Affected files:
- `docs/agent-knowledge/state-and-performance.md`
- `docs/specs/050.3-indexed-time-capacity-data-path.md` (authoritative profiling record/reference; no runtime behavior change required)

**Current**

The durable performance table in `docs/agent-knowledge/state-and-performance.md` reports the one-cycle legacy request as:

```text
raw rows materialized = 71,190
selected rows into transforms = 71,190
returned points = 2,590
```

The 050.3 implementation record and profiler semantics establish the actual boundary as 71,190 raw rows materialized by the legacy reader, followed by exact cycle filtering to **2,590 rows entering the scientific transforms**, with 2,590 returned points. `analysis_engine.compute_time_capacity()` also records `selected_rows_before_transforms` only after cycle filtering. The durable table therefore conflates full raw materialization with scientific-transform input for this case.

This does not indicate a runtime or scientific-output defect, but `docs/agent-knowledge/state-and-performance.md` is durable architectural guidance for later agents. Leaving the contradiction would materially misdescribe which cost 050.3 removes and could lead future performance work to optimize a transform cost that is not present.

**Target**

Correct the durable profiling table to the measured/profiler semantics: the one-cycle legacy path materializes 71,190 raw rows but sends 2,590 exact selected rows into transforms. Verify the complete table against `scripts/profile_time_capacity_path.py` and the 050.3 implementation record while making no runtime/scientific change.

**Acceptance criteria**

- The one-cycle legacy row reports 71,190 raw rows materialized, **2,590** rows entering transforms, and 2,590 returned points.
- The other matrix rows are checked against the profiler/050.3 implementation record and any transcription mismatch is corrected.
- No runtime implementation, scientific formula, cache identity, `CALC_VERSION`, parser/canonical version, result schema, raw-layout version, or database migration changes are introduced for this documentation fix.
- Run the appropriate documentation/diff verification and canonical preflight before handoff, recording exact results.

## Merge/readiness status

Parent 050 is **not yet merge-ready** because R1 leaves the durable performance knowledge internally inconsistent with the accepted 050.3 profiling evidence. The runtime implementation itself is cumulatively review-clean. After R1 is corrected and re-reviewed, the parent can be completed if no new cumulative defect is found; the unrun browser/manual checks are recorded evidence gaps but are not a hard external gate under the authored 050.1/050.3 acceptance wording when the environment cannot run them.
