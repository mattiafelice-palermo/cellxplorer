# Review 056 — Cycle point selection and detail inspector

Specification: [`../056-cycle-point-selection-and-detail-inspector.md`](../056-cycle-point-selection-and-detail-inspector.md)
Branch: `feature/cycle-point-selection-inspector`
Merge base: `main` at `7aae0021db94bd565320922a1a5be80fb7a1c05d`
Initial implementation commit: `c36d35607e8e55f234a059dc7cf18375aed8bade`
R1-R4 fix commit: `55abb63a4104232c03a4eab6a82d601f953d5b02`
R5 documentation fix commit: `6858a1acc2221483faf5ea0b7be09d73b50a1e52`
Status: **Review clean; BLOCKED on required manual browser acceptance**

## Confirmed

- The branch still has the correct merge base and no unrelated stacked implementation scope.
- Point-selection ownership remains Cycles-local; the shared `Plot.tsx` wrapper and backend scientific code remain unchanged.
- Original scientific global-cycle identity and source-local provenance remain separate from displayed/reindexed X coordinates.
- Aggregate point metadata still derives the exact finite contributing Cell IDs for the plotted quantity at each cycle.
- The lazy detail request remains an immutable derived one-cycle Time/Capacity request with query-key/body parity, cancellation through React Query, shared cache identity, existing trace construction, and the existing refinement endpoint.
- Selection/inspector state remains transient and does not use the normal Cycles `update(...)`, dirty, autosave, saved-plot, or export state paths.
- The cumulative implementation diff remains limited to Spec 056 documentation/workflow, Cycles/analysis-editor frontend ownership, saved-artifact sanitization, and focused frontend regression coverage. There are no backend, migration, calculation-version, parser, shared Plot-wrapper, or persistent schema changes.
- The R5 patch is documentation-only apart from the atomic workflow handoff and updates only the requested current-status surfaces.

## Verification record

### Implementer-reported

- Focused R1-R4 suite: PASS, 39/39.
- Full frontend suite: PASS, 779/779.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS.
- `python scripts/preflight.py --no-cache`: PASS, 4/4 stages; all 163 backend/frontend modules passed in 53.02 s.
- R5 documentation diff: `git diff --check` PASS before commit.
- Manual browser acceptance matrix: **NOT RUN**.

### Reviewer-independent

I independently:

- refreshed R5 head `6858a1acc2221483faf5ea0b7be09d73b50a1e52` and re-read the authoritative `FINAL_REVIEW` state;
- inspected the complete R5 commit and confirmed it is limited to `docs/specs/056-cycle-point-selection-and-detail-inspector.md`, `docs/specs/README.md`, and the atomic workflow handoff files;
- verified that Spec 056 now records implementation complete and R1-R4 independently review-clean, names the actual `55abb63` fix checkpoint, and preserves the manual matrix as NOT RUN/pending;
- verified that `docs/specs/README.md` no longer labels Spec 056 as Plan and does not claim COMPLETE or merge readiness.

I did **not** independently execute the reported test/build/preflight commands or a browser/manual acceptance session.

## Finding resolution

### R1 — Resolved: cancelled or superseded detail refinement can no longer win

`CycleDetail` uses the existing `TimeCapacityRefinementLifecycle`; cancellation/supersession advances generation and stale responses are rejected.

### R2 — Resolved: mixed primary and CE rows retain measure/unit identity

Homogeneous selections keep the compact shared Y heading, while mixed-measure selections expose each row's exact `quantityLabel`.

### R3 — Resolved: point-selection metadata stays out of persisted/exported artifacts

Selection metadata is opt-in for live Cycles traces and is sanitized from export/portable figure paths without mutating inputs.

### R4 — Resolved: relayout clears the completed transient selection coherently

Relayout now clears construction, committed outline, records, halos, anchor, and inspector together.

### R5 — Resolved: durable status documentation matches the reviewed state

`docs/specs/056-cycle-point-selection-and-detail-inspector.md` no longer says R1-R4 are awaiting re-review and now explicitly records implementation complete, R1-R4 independently review-clean, and the manual browser matrix as NOT RUN/pending. `docs/specs/README.md` no longer labels the feature Plan and likewise preserves the outstanding manual gate without claiming completion or merge readiness. No unrelated or historical status text was rewritten.

## Open findings

### R6 — P2: browser-confirmed selection and detail defects; approved refinement batch

Affected files: Cycles selection policy/hook/card/inspector and focused tests.

**Current:** Specific capacity resets to Time during loading; overlays drift at 90% UI zoom;
zero-length polygon edges admit every point. Expanded detail clips unnecessarily, cycle headings
are ambiguous, hover labels obstruct selection, and detail inherits unrelated saved styling.

**Target:** Implement the user-approved 2026-09-05 amendment in Spec 056, including outside-click
dismissal, viewport-bounded growing inspector, compact hover, selected marker emphasis, dashed
polygon preview, individual/all detail samples, and Cycles color identity without a plot legend.

**Acceptance criteria:** Focused regression tests for the confirmed defects and presentation
policies; full no-cache preflight; browser evidence for selection, quantities, layout, UI scaling,
dismissal, polygon preview and detail sample/color controls. Record remaining acceptance limits
truthfully. User explicitly switched this task from review to implementation; return to independent
review after the fixes rather than self-approving.

### R7 - User-requested shared sample prefix

The user observed that long experiment-family prefixes hide the useful sample identifiers in the
inspector table. Detect a shared prefix across distinct visible Cycles sample names, move that common
context into the Sample header, and display the informative remaining part in each row. Preserve
full names on hover and avoid empty/ambiguous suffixes or stripping meaningful numeric identifiers.
Verify both policy edge cases and the live Gen2C table. This follow-up refines the same Spec 056 scope.

### R6 implementer response - 2026-09-05

The approved batch is implemented, including the user's later clarification that cycle detail stays
expanded and placement checks all four sides before reducing height. The detailed browser evidence
and remaining manual scope are in the spec's R6 implementation section. In addition to the original
findings, browser verification corrected delayed Portal measurement, sticky-header overlap, and
subpixel exclusion of polygon boundary points. Final no-cache preflight at 0.27.1-alpha.21 passed
all 4 stages and 163 files/modules in 70.49 s. R6 awaits independent re-review.

### R7 implementer response - 2026-09-05

Implemented against the visible Cycles sample set, including the single-selected-point case. The
live Gen2C row now shows `2436-1`, the Sample header retains the shared family prefix, and the full
name remains available on hover. Numeric IDs stay intact; short/unrelated/singleton names do not
compress. Focused policy tests pass 26/26; final no-cache preflight at 0.27.1-alpha.22 passed
4/4 stages and all 163 files/modules in 67.34 s. R6 and R7 await independent review together.

### R8 - Retain the displayed figure during quantity changes

The user observed that switching detail from Time to Capacity temporarily removes the plot and
resizes its popup. Keep the last complete figure, including its original axes, while the new
quantity loads; replace it atomically when the response is ready. Preserve loading/error feedback
and never reinterpret old coordinates using the newly selected axis.

## Final-review external gate

The original full manual browser acceptance matrix remains incomplete. The 2026-09-05 implementer
response records focused live-app and isolated component browser checks; native Ctrl-drag,
replicate/CE/hidden-series scenarios, and the full-viewport document-scroll fallback still need
manual evidence. R6 also awaits independent re-review. Historical NOT RUN reports above describe
those earlier review sessions.

The required evidence is the Spec 056 manual browser matrix covering, in a suitable local application/browser environment:

- rectangle, polygon, single-click, cancellation, Escape, tab/result lifecycle, and CSS/Windows scaling behavior;
- the inspector table, mixed primary/CE labeling, scrolling, positioning, and Light/Dark/narrow geometry;
- always-expanded Time/Capacity detail loading (user amendment), quantity availability, selected-cycle navigation, deduplication, error/retry, and rapid-navigation stale-response behavior;
- no Cycles recompute, dirty/autosave mutation, or persistence from inspection actions;
- diagnostic reindex/original-cycle provenance and hidden/non-rendered selection boundaries;
- Plotly hover, zoom, pan, autoscale/reset, modebar, legend drag/application visibility, Style panel, saved previews, portable reports, and PNG/SVG/PDF/CSV/XLSX/Parquet export regressions.

Because that acceptance input is external to this reviewer session and the user has not authorized a local browser check for this turn, the workflow must remain blocked rather than inventing evidence.

## Decision

**REVIEW CLEAN — R1-R5 are closed. FINAL REVIEW BLOCKED only on the required manual browser acceptance matrix.**

Required next action: run and record the Spec 056 manual browser matrix in an appropriate local CellXplorer environment. When that evidence is available, resume the workflow with `resume-final-review`, re-read the results, and mark COMPLETE only if the matrix is clean. Any observed regression should instead be converted into a new stable review finding before completion.
