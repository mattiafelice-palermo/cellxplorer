# Review 056 — Cycle point selection and detail inspector

Specification: [`../056-cycle-point-selection-and-detail-inspector.md`](../056-cycle-point-selection-and-detail-inspector.md)
Branch: `feature/cycle-point-selection-inspector`
Merge base: `main` at `7aae0021db94bd565320922a1a5be80fb7a1c05d`
Initial implementation commit: `c36d35607e8e55f234a059dc7cf18375aed8bade`
R1-R4 fix commit: `55abb63a4104232c03a4eab6a82d601f953d5b02`
Status: **Changes required in final cumulative review**

## Confirmed

- The branch still has the correct merge base and no unrelated stacked implementation scope.
- Point-selection ownership remains Cycles-local; the shared `Plot.tsx` wrapper and backend scientific code remain unchanged.
- Original scientific global-cycle identity and source-local provenance remain separate from displayed/reindexed X coordinates.
- Aggregate point metadata still derives the exact finite contributing Cell IDs for the plotted quantity at each cycle.
- The lazy detail request remains an immutable derived one-cycle Time/Capacity request with query-key/body parity, cancellation through React Query, shared cache identity, existing trace construction, and the existing refinement endpoint.
- Selection/inspector state remains transient and does not use the normal Cycles `update(...)`, dirty, autosave, saved-plot, or export state paths.
- The cumulative implementation diff remains limited to Spec 056 documentation/workflow, Cycles/analysis-editor frontend ownership, saved-artifact sanitization, and focused frontend regression coverage. There are no backend, migration, calculation-version, parser, shared Plot-wrapper, or persistent schema changes.

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

- refreshed fix head `55abb63a4104232c03a4eab6a82d601f953d5b02` and current `main`/merge base `7aae0021db94bd565320922a1a5be80fb7a1c05d`;
- re-read the authoritative workflow/review/spec and compared the cumulative feature branch against the merge base;
- inspected the R1-R4 code paths, focused regressions, query/refinement behavior, original-cycle provenance, aggregate contributor truth, and export/artifact boundaries;
- confirmed current `main` remains exactly the merge base and the cumulative branch is ahead only;
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

## Findings

### R5 — Low: durable Spec 056 status documentation still describes the pre-review state

Affected files:
- `docs/specs/056-cycle-point-selection-and-detail-inspector.md`
- `docs/specs/README.md`

**Current**

The cumulative implementation and R1-R4 re-review are clean, but the durable status documentation has not been closed accordingly. The Spec 056 status still says that R1-R4 fixes are "awaiting independent re-review", while `docs/specs/README.md` still labels Spec 056 **Plan.**. Those statements are now false after the reviewer closed R1-R4 and entered final cumulative review.

**Target**

Update the current status documentation to reflect the actual reviewed state without overstating completion: Spec 056 is implemented, R1-R4 are review-clean/closed, and final cumulative completion is still pending the manual browser acceptance matrix. Preserve the historical implementation/review record and do not claim manual checks were run.

**Acceptance criteria**

- `docs/specs/056-cycle-point-selection-and-detail-inspector.md` no longer says R1-R4 are awaiting independent re-review and accurately states that R1-R4 are closed/review-clean.
- `docs/specs/README.md` no longer labels Spec 056 **Plan.** and instead records the implemented/review-clean code state plus the outstanding final manual-browser gate.
- Both files continue to state the manual browser acceptance matrix truthfully as NOT RUN/pending; neither file declares the workflow COMPLETE or merge-ready before that evidence exists.
- No historical spec/review text or unrelated status entries are rewritten.

## Final-review external gate

The manual browser acceptance matrix is still **NOT RUN**. This is not an additional implementation finding. The spec explicitly defines browser checks for the real Ctrl/pointer gesture boundary, Plotly zoom/pan/modebar/legend regressions, theme/layout behavior, dirty/autosave/network behavior, saved previews/exports, and detail interaction. Under the repository workflow, final `COMPLETE` requires this remaining manual acceptance evidence after R5 is resolved.

## Decision

**CHANGES REQUIRED — R1-R4 are closed; implement R5 only.**

After R5 is handed back, resume `FINAL_REVIEW`. If the documentation is clean but the manual browser matrix is still unavailable, the workflow should enter `BLOCKED` rather than invent another finding or mark `COMPLETE`.
