# Review 056 — Cycle point selection and detail inspector

Specification: [`../056-cycle-point-selection-and-detail-inspector.md`](../056-cycle-point-selection-and-detail-inspector.md)
Branch: `feature/cycle-point-selection-inspector`
Merge base: `main` at `7aae0021db94bd565320922a1a5be80fb7a1c05d`
Implementation commit: `c36d35607e8e55f234a059dc7cf18375aed8bade`
Status: **Changes required**

## Confirmed

- The branch has the correct merge base and no unrelated stacked implementation scope: it contains the Spec 056 plan, reviewer workflow initialization, and the implementation checkpoint.
- Point-selection ownership is Cycles-local. `useCyclePointSelection.ts` owns Ctrl-modified pointer capture, click/rectangle classification, polygon construction, Escape/blur/visibility cancellation, rendered screen-space projection, and selection lifecycle. The shared `Plot.tsx` wrapper is unchanged.
- Selectable Cycles traces publish explicit metadata rather than deriving identity from trace names or hover HTML. Cell records retain original global cycle plus source-local provenance; aggregate records carry the exact finite contributing Cell IDs for the plotted quantity at each cycle.
- The detail request is an immutable derived one-cycle Time/Capacity request. The React Query key and HTTP request body use the same derived spec/signatures, the request uses the existing `/time-capacity` endpoint and shared cache namespace, and request cancellation uses the query `AbortSignal`.
- The inspector is transient and does not call the Cycles `update(...)` path. It remains mounted over the Cycles card, uses accessible names for icon actions/navigation, and only mounts `CycleDetail` after disclosure expansion.
- No backend code, migration, `CALC_VERSION`, `SPEC_VERSION`, shared Plot wrapper, or persistent AnalysisSpec schema was changed.

## Verification record

### Implementer-reported

- `node --test frontend\tests\cyclePointSelectionPolicy.test.ts frontend\tests\cycleTraceRenderer.test.ts`: PASS, 17/17.
- Focused suite including `frontend\tests\timeCapacityQueryPolicy.test.ts`: PASS, 30/30.
- Full frontend suite: PASS, 773/773.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS.
- `python scripts\preflight.py --no-cache`: PASS, 4/4 stages; all 163 backend/frontend test files/modules passed in 59.06 s.
- `git diff --cached --check`: PASS.
- Manual browser acceptance matrix: **NOT RUN**.

### Reviewer-independent

I independently:

- refreshed the remote branch and confirmed `c36d35607e8e55f234a059dc7cf18375aed8bade` as the review head;
- compared the complete branch against merge base `7aae0021db94bd565320922a1a5be80fb7a1c05d` and inspected all implementation files;
- traced the gesture lifecycle, screen-space candidate projection, aggregate contributor derivation, diagnostic-cycle provenance, one-cycle request/key construction, Time/Capacity placeholder/refinement behavior, and saved/portable artifact path;
- queried GitHub status/workflow evidence for the implementation SHA; there are no attached commit statuses or workflow runs.

I did **not** independently execute the frontend/backend test commands or a browser/manual acceptance session. The implementer's no-cache preflight is the canonical aggregate verification evidence for this handoff.

## Findings

### R1 — High: cancelled or superseded detail refinement can still win a response race

Affected files:
- `frontend/src/features/analyses/editor/families/cycles/CyclePointInspector.tsx`
- focused regression coverage for the inspector refinement lifecycle

**Current**

`CycleDetail` increments `refinementGenerationRef` when a refinement is scheduled, but `cancelRefinement()` only clears the timer and aborts the current controller. Response acceptance compares the response against the request's own captured `generation` and the unchanged request identity. `timeCapacityRefinementRequestIsCurrent(...)` verifies that captured generation and overview identity, but it does not compare against the inspector's current generation.

Consequently, if an old same-cycle/same-quantity refinement resolves across an abort race after a later zoom/refinement or after autorange cancellation, its callback can still satisfy both current checks and call `setRefinedResult(response)`. The existing Time/Capacity `TimeCapacityRefinementLifecycle` avoids this class of race by advancing the generation when pending work is cancelled and rejecting responses whose generation is no longer current.

**Target**

Make inspector refinement latest-wins across every schedule, cancellation, reset, request-identity change, and unmount. Reuse `TimeCapacityRefinementLifecycle` where practical, or provide an equivalent explicit current-generation guard; abort alone must not be the correctness boundary.

**Acceptance criteria**

- A response from refinement N cannot become displayed after refinement N+1 has been scheduled.
- A response from refinement N cannot repopulate detail after autorange/reset/cancellation invalidates it.
- Changing active cycle or X/Y quantity still invalidates all older refinement responses.
- Add focused deterministic regression coverage for superseded/cancelled response acceptance rather than relying on network abort timing.

### R2 — Medium: mixed primary and CE rows lose their Y quantity and unit identity

Affected files:
- `frontend/src/features/analyses/editor/families/cycles/CyclePointInspector.tsx`
- presentation/policy regression coverage as appropriate

**Current**

Each selection record correctly carries `quantityLabel`, but the table uses one shared Y header. When all records have one label it shows that label; when a rectangle/polygon selects both a primary Cycles trace and a CE trace it falls back to the generic header `Y value`. The individual rows then show only the sample label and numeric Y value. Because primary and CE records for the same Cell/group use the same `sampleLabel`, a mixed selection no longer tells the user which numeric row is capacity/energy/etc. and which is Coulombic efficiency, nor the corresponding units.

This conflicts with the locked table contract that the displayed Y quantity and unit remain explicit and that CE selections use the CE label/right-axis value.

**Target**

Keep quantity/unit identity visible for every selected row in a mixed-measure selection. A compact shared header is fine for homogeneous selections; mixed primary/CE selections need an explicit per-row quantity/measure label (or an equivalent unambiguous presentation).

**Acceptance criteria**

- A mixed primary + CE selection clearly identifies the quantity and unit of every row.
- Primary rows retain the exact active Cycles quantity label, including normalization and units.
- CE rows are explicitly identified as `Coulombic efficiency (%)`.
- Homogeneous selections remain compact and truthfully labelled.

### R3 — Medium: live point-selection metadata is serialized into saved/portable plot artifacts

Affected files:
- `frontend/src/features/analyses/editor/families/cycles/CyclePlotCard.tsx`
- `frontend/src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx`
- focused artifact/trace regression coverage

**Current**

`cycleTracesForResult(...)` now adds `meta.cellxplorerCycleSelection` to the canonical Cycles traces. That same builder is used by saved-plot preview/artifact generation. `SavedPlotPreviews.tsx:portableFigure(...)` serializes the complete trace objects with `JSON.stringify`, so `cellxplorerCycleSelection` is persisted inside the stored/portable figure data even though it is only needed by the live interactive Cycles inspector.

The metadata is not the user's current selected-point set, but it is still point-selection-specific state added to a saved/portable artifact, contrary to the locked ownership/persistence boundary.

**Target**

Keep selectable metadata on the live interactive Cycles trace path only, or sanitize it before saved/portable figure serialization. Saved thumbnails, plot artifacts, portable figures, and exports must contain only their established scientific/presentation data.

**Acceptance criteria**

- Live interactive Cycles traces still expose the metadata needed for hit testing and point identity.
- Stored `PlotArtifact.figure.data` and portable Cycles snapshots contain no `cellxplorerCycleSelection` metadata.
- Existing saved thumbnail/image/data semantics remain unchanged.
- Add focused regression coverage demonstrating that selection-specific metadata does not cross the artifact boundary.

### R4 — Medium: relayout preserves the inspector but drops the required committed selection outline

Affected files:
- `frontend/src/features/analyses/editor/families/cycles/CyclePlotCard.tsx`
- `frontend/src/features/analyses/editor/families/cycles/useCyclePointSelection.ts`
- focused state/lifecycle coverage as appropriate

**Current**

Every Cycles `plotly_relayout` schedules `pointSelection.invalidateGeometry()`. That method cancels in-progress geometry and sets `completedShape` to `null`, but leaves the completed selection records intact. The inspector and reprojected point halos therefore survive a zoom/pan/relayout while the committed rectangle/polygon outline disappears permanently.

The spec requires the completed rectangle/polygon outline to remain visible at low opacity while the selection is active. If the implementation cannot truthfully transform a screen-space committed shape through a relayout, the spec permits deterministic clearing rather than retaining a partially represented selection.

**Target**

After relayout, either preserve/reproject a geometrically truthful committed outline together with the records, or clear the completed selection/inspector as one coherent state. Do not preserve selected records while silently dropping a required part of their active-selection emphasis.

**Acceptance criteria**

- Zoom/pan/relayout never leaves an active inspector/record set with its required committed outline silently removed.
- In-progress gesture cancellation on relayout remains safe.
- If records are preserved, halos and the committed shape remain geometrically consistent with the new viewport; if that cannot be guaranteed, the selection is cleared coherently.

## Manual-only risks remaining

The browser matrix remains **NOT RUN**. Static review cannot verify the real Plotly/CSS interaction boundary for `.nsewdrag`, Windows/UI scaling, modebar overlap, smooth pointer capture outside the plot, Light/Dark/narrow inspector geometry, or absence of incidental dirty/autosave/network behavior during live gestures. These are still required final acceptance evidence; they are not converted into an additional implementation finding while R1-R4 are open.

## Decision

**CHANGES REQUIRED — return R1, R2, R3, and R4 to the implementer.**

The branch is not ready to merge. Fix only the recorded findings, rerun focused verification plus the canonical handoff validation required by the repository/spec, and hand the workflow back for re-review. Manual/browser acceptance remains truthfully unperformed at this review checkpoint.
