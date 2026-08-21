# Review: Spec 050 — runtime performance optimization

Status: **Final review clean but BLOCKED on required local end-to-end profile**  
Branch: `feature/runtime-performance-optimization`  
Merge base with `main`: `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)

## Cumulative review scope

Performed the Parent 050 cumulative review against the verified merge base and re-ran the scope comparison after 050.4. The branch remains a fast-forward candidate relative to the verified merge base (`behind_by: 0`) and contains the complete 050.1-050.4 workstream plus repository workflow-infrastructure changes under `docs/specs/workflow/` and `tests/test_spec_workflow.py`. Those workflow changes are cumulative branch scope even though they are not runtime-performance implementation.

Proto-child `050.P1` remains planning-only and does not block parent completion.

All authored numeric children are review-clean. The cumulative implementation has no open reviewer finding. Parent final review cannot be completed because 050.4 deliberately makes the optimization decision depend on a real local desktop/browser end-to-end profile that neither agent environment can execute.

## Child outcomes

### 050.1 — analysis query and cache lifecycle

Review-clean after `e3625a7` plus review fix `a7e84d7`.

- Editor autosave no longer causes broad scientific-query invalidation.
- Live and saved-preview Time/Capacity requests propagate React Query aborts.
- Compatible placeholder data may remain visible while the replacement request runs, but cannot drive plot/image/vector export.
- Family-owned scientific cache projections are explicit; `ANALYSIS_CACHE_VERSION` intentionally changed from 6 to 7 while scientific/result-schema versions remained unchanged.

### 050.2 — cycle-addressable raw cache and source index

Review-clean after `43b6cbe` plus review fix `7b70b4a`.

- Canonical parser-versioned raw Parquet remains the scientific source of truth.
- An independent physical-layout/index generation provides exact source-local cycle membership, row-group addressing and bounded source metadata.
- Legacy raw caches remain scientifically valid and are converted only off the request critical path.
- Cleanup/conversion races are closed at the live deletion boundary.

### 050.3 — indexed Time/Capacity data path

Review-clean after `483ca2b` plus review fix `836ee0d`.

- Time/Capacity now plans requested dense global cycles from compact indexes before loading raw records.
- Narrow requests selectively read only contributing sources/groups/columns and remove row-group spillover before unchanged scientific transforms.
- In-progress background conversion does not block the request; the request takes the safe legacy fallback.
- Extreme stale range endpoints are clamped to known dense cycles before tuple materialization.
- Existing continuation, phase/capacity, derivative, protocol-mask, voltage-availability, provenance and full-resolution export semantics remain preserved.

### 050.4 — end-to-end Time/Capacity profiling and optimization decision gate

Review-clean after implementation `92af225`, round-1 fix `36aa9ee`, and round-2 fix `57cff5a`.

The child adds an opt-in, local, bounded profiler around the real compact/standard Time/Capacity interaction. It separates backend/cache/access facts, HTTP round trip, frontend result-to-plot preparation, Plotly completion and total interaction time. It also distinguishes HTTP responses from React Query memory hits and keeps selection-entry count, resolved Cell count and Plotly trace count separate.

Four reviewer findings were resolved:

- R1: frontend query identity is no longer conflated with the backend result-cache digest.
- R2: React Query memory hits no longer inherit stale backend profiling facts.
- R3: actual resolved Cell count is recorded independently of selection entries and Plotly trace count.
- R4: profiling no longer repeatedly serializes the full scientific response after the backend timing boundary; a profiled miss serializes the scientific body once and only patches the small profiling object thereafter.

050.4 intentionally does **not** select or implement a speculative optimization. That decision is reserved for the real end-to-end measurements.

## Cumulative scientific, cache and migration closure

- No SQLite migration is introduced by Spec 050.
- `CALC_VERSION` remains unchanged because scientific meaning is unchanged.
- Parser identities and `CANONICAL_RAW_VERSION` remain unchanged.
- Time/Capacity and other `RESULT_SCHEMA_VERSIONS` remain unchanged.
- `ANALYSIS_CACHE_VERSION` 6 -> 7 is the deliberate 050.1 analysis-result key-generation change.
- 050.2 `RAW_CACHE_LAYOUT_VERSION` is a physical access/layout generation and does not enter scientific analysis-result identity.
- 050.4 profiling is opt-in observation only; ordinary Time/Capacity request/response behavior and persisted scientific result bodies remain unchanged.
- Golden analysis verification was reported PASS with committed expected digests unchanged during the runtime/scientific implementation rounds.
- Full-resolution selected-range export remains exact; all-cycle export is expected to read all detailed rows.

## Accepted performance evidence through 050.3

On the approved 71,190-row / 193-cycle source, the indexed path structurally removes full-source materialization for narrow requests:

| Request | Legacy raw rows materialized | Indexed raw groups / rows materialized | Exact rows entering transforms | Returned points |
| --- | ---: | ---: | ---: | ---: |
| 1 cycle | 71,190 | 1/18 / 4,096 | 2,590 | 2,590 |
| 20 cycles | 71,190 | 3/18 / 12,288 | 10,611 | 10,611 |
| 150 cycles | 71,190 | 14/18 / 57,344 | 56,044 | 56,044 |
| All cycles | 71,190 | 18/18 / 71,190 | 71,190 | 71,190 |

This is durable architectural evidence, not a claim about complete user-visible latency. The 050.3 harness uses a full-detail backend configuration and does not measure React/Plotly completion.

## Verification evidence

### Implementer-reported

- 050.1 focused frontend/backend policy tests, TypeScript check and canonical preflight: PASS.
- 050.2 focused raw/preparation/cache/stitch, golden and mixed-parser/canonical verification plus canonical preflight: PASS.
- 050.3 focused suite: PASS (252 initially; 254 after review fixes); golden analysis: PASS (30, expected digests unchanged); indexed/legacy profiler: PASS; canonical preflight: PASS.
- Parent documentation R1 fix: `git diff --check` and canonical preflight: PASS.
- 050.4 initial profiling/backend regressions, frontend lifecycle tests/build, golden analysis and canonical preflight: PASS.
- 050.4 R1-R3 fixes: focused regressions PASS; frontend tests PASS (648); backend/preflight modules PASS (147); frontend type check and production bundle PASS; canonical preflight PASS (4/4).
- 050.4 R4 fix: serialization regression PASS; response byte-count check PASS; focused backend tests PASS (6); focused frontend profiling/query-policy tests PASS (14); canonical preflight PASS (4/4).
- Browser/end-to-end 050.4 scenario matrix: **NOT RUN**.

### Reviewer-independent

- Reviewed every numeric child implementation/fix and the cumulative branch through the GitHub connector against the active specs, current code and focused tests.
- Confirmed the final indexed Time/Capacity path, cache/version architecture, cleanup/conversion boundaries, profiling state machine, backend profiling response path and durable performance guidance by inspection.
- Re-checked the branch against merge base `1dc3525e`; the comparison reports `behind_by: 0`, so no newer base commit is being silently omitted from this review point.
- Reviewer-side repository commands and browser/manual checks were not run in the repository-owned Chat + GitHub-connector environment.

## Findings

### Parent R1 — Medium: durable performance documentation misstated the one-cycle legacy transform input

Status: **Resolved in `1fe2beb96e817cf2a0684c0b22d1bf93a136dbc6`**

The durable table now correctly distinguishes 71,190 raw rows materialized from 2,590 exact selected rows entering transforms and 2,590 returned points for the one-cycle legacy path. No runtime/scientific/cache/version behavior changed in that fix.

No parent or child implementation finding remains open.

## External acceptance gate

Parent 050 is blocked on the evidence explicitly required by 050.4: a representative local desktop/browser end-to-end Time/Capacity profile using the newly reviewed instrumentation.

The minimum useful local exercise is to:

1. open a representative prepared long analysis;
2. run `window.cellxplorerPerformance.timeCapacity.enable()`;
3. run `window.cellxplorerPerformance.timeCapacity.reset()`;
4. exercise representative scenarios including `1-3 -> 1-20`, neighbour navigation, broad/all-cycle transitions, one versus several Cells, cache-hit/reopen and derivative/display changes; include a continuation boundary if representative data are available;
5. run `window.cellxplorerPerformance.timeCapacity.exportJson()` and provide the exported records;
6. disable profiling afterward with `window.cellxplorerPerformance.timeCapacity.disable()`.

The scenario matrix should use repeated runs where practical and preserve the recorded cache/access classifications. The reviewer will then resume the same final review, identify the dominant latency stage, and decide whether a numeric 050.5 optimization child is justified or whether Spec 050 can close without further optimization.

## Merge/readiness status

Parent 050 is **not merge-ready and not COMPLETE** solely because the required local end-to-end profiling evidence is unavailable to both agents. There is no open implementer finding. The correct workflow state is `BLOCKED` until the user supplies the exported 050.4 profile; neither agent should continue polling or implement speculative optimization while blocked.
