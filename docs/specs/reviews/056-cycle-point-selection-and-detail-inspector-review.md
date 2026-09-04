# Review 056 — Cycle point selection and detail inspector

Specification: [`../056-cycle-point-selection-and-detail-inspector.md`](../056-cycle-point-selection-and-detail-inspector.md)
Branch: `feature/cycle-point-selection-inspector`
Merge base: `main` at `7aae0021db94bd565320922a1a5be80fb7a1c05d`
Initial implementation commit: `c36d35607e8e55f234a059dc7cf18375aed8bade`
R1-R4 fix commit: `55abb63a4104232c03a4eab6a82d601f953d5b02`
Status: **Review clean — entering final cumulative review**

## Confirmed

- The branch still has the correct merge base and no unrelated stacked implementation scope.
- Point-selection ownership remains Cycles-local; the shared `Plot.tsx` wrapper and backend scientific code remain unchanged.
- Original scientific global-cycle identity and source-local provenance remain separate from displayed/reindexed X coordinates.
- Aggregate point metadata still derives the exact finite contributing Cell IDs for the plotted quantity at each cycle.
- The lazy detail request remains an immutable derived one-cycle Time/Capacity request with query-key/body parity, cancellation through React Query, shared cache identity, existing trace construction, and the existing refinement endpoint.
- Selection/inspector state remains transient and does not use the normal Cycles `update(...)`, dirty, autosave, saved-plot, or export state paths.

## Verification record

### Implementer-reported

- Focused R1-R4 suite: PASS, 39/39.
- Full frontend suite: PASS, 779/779.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS.
- `python scripts/preflight.py --no-cache`: PASS, 4/4 stages; all 163 backend/frontend modules passed in 53.02 s.
- `git diff --cached --check`: PASS.
- Manual browser acceptance matrix: **NOT RUN**.

### Reviewer-independent

I independently:

- refreshed branch head `55abb63a4104232c03a4eab6a82d601f953d5b02` and current `main`/merge base `7aae0021db94bd565320922a1a5be80fb7a1c05d`;
- re-read the authoritative workflow/review/spec and compared the cumulative branch against the merge base;
- inspected the R1-R4 code paths, focused regressions, and the affected export/artifact/refinement boundaries;
- queried commit status/workflow evidence; no GitHub status checks or workflow runs are attached to the fix SHA.

I did **not** independently execute the reported test/build/preflight commands or a browser/manual acceptance session.

## Finding resolution

### R1 — Resolved: cancelled or superseded detail refinement can no longer win

`CycleDetail` now uses the existing `TimeCapacityRefinementLifecycle`. Every `cancelRefinement()` advances the lifecycle generation before clearing the timer/aborting the controller; each request begins against the current generation; response acceptance goes through `acceptResponse(...)`, which rejects superseded/cancelled generations and stale overview identity. Request-identity changes and unmount cleanup both invoke that cancellation boundary. Focused tests exercise superseded and cancelled generations deterministically.

### R2 — Resolved: mixed primary and CE rows retain measure/unit identity

Homogeneous selections keep the compact shared Y heading. Mixed-measure selections use the generic `Y value` heading only together with an explicit per-row `record.quantityLabel` under the sample name, preserving the exact active primary quantity label/units and `Coulombic efficiency (%)` for CE rows.

### R3 — Resolved: point-selection metadata stays out of persisted/exported artifacts

`cycleTracesForResult(...)` now emits selection metadata only when explicitly requested by the live Cycles interactive path. The live card derives sanitized export traces with `withoutCyclePointSelectionMetadata(...)`, and `portableFigure(...)` defensively sanitizes again before serialization without mutating its inputs. Focused renderer/policy tests verify both opt-in live metadata and clean artifact traces.

### R4 — Resolved: relayout clears the completed transient selection coherently

`invalidateGeometry()` now delegates to the full `clear()` path. Any Plotly relayout therefore cancels construction and clears the committed outline, records, halos, anchor, and inspector together instead of preserving a partially represented selection.

## Decision

**REVIEW CLEAN — R1, R2, R3, and R4 are closed. Enter final cumulative review.**

The remaining manual browser matrix is not an implementation finding. Its status and merge-readiness consequence are evaluated in the final cumulative review.
