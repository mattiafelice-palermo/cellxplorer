# Spec 006: destructive-action impact warnings + unsaved draft plots

Status: **implemented**. Backend (one new endpoint) + frontend. Written 2026-07-25.

Two independent parts that can ship separately:

- **A** — before exploding a replicate or removing a cell from the library, show what it will do
  to existing analyses and saved plots.
- **B** — make an unsaved plot visible as a draft card, and let it survive leaving the analysis.

---

# Part A — Impact warnings for destructive actions

## A.1 Why this is needed (not only UX)

Neither destructive path touches analyses today:

- `delete_cell_from_library` (`backend/app/routers/library.py` ~141) removes `FolderCell`,
  `ProjectCell`, `GroupCell`, `ReplicateGroupCell`, `CellTag`, `CellMetadata`, `Test`,
  `TestFile` — **not** `Analysis.spec`.
- `ungroup_replicates` (`backend/app/routers/replicates.py` ~318) deletes the
  `ReplicateGroupCell` rows and any now-empty groups — **not** `Analysis.spec`.

So `spec.selection.entries` keeps `{kind: "cell"|"replicate_group", ref_id: <gone>}`.
`analysis_engine.resolve_selection` tolerates this — it collects them into `missing_refs` and
carries on — so nothing crashes, but an analysis can quietly lose samples or become empty with
no warning at any point.

## A.2 Locked decision: never auto-delete an analysis

The warning states that an analysis **will be left with no samples**. It must **not** delete it
as a side effect. An analysis carries a title, description, saved plots and tags that the user
may still want; destroying that because a cell was removed is irreversible and surprising.

Offer deletion as an explicit, **unchecked-by-default** checkbox in the modal:
*"Also delete the N analyses that would be left empty"*. The user opts in per action.

## A.3 New endpoint: impact preview

Client-side derivation from `GET /api/analyses` summaries is not reliable enough — the modal
must name affected **plots**, which needs each analysis's saved-plot list and per-plot
exclusions. Add one endpoint:

```
POST /api/analyses/usage
body: { "cell_ids": number[], "group_ids": number[] }
->
{
  "analyses": [
    {
      "id": 12,
      "title": "LFP baseline",
      "matched": [ { "kind": "cell", "ref_id": 5, "name": "NG_2026…" } ],
      "remaining_entry_count": 0,        // entries left after the removal
      "becomes_empty": true,
      "plots": [ { "id": "p1", "name": "Capacity fade", "tab": "cycles", "affected": true } ]
    }
  ],
  "empty_after": [12]                    // ids where becomes_empty is true
}
```

Rules:

- An analysis matches if `spec.selection.entries` contains any of the given cells, **or** any of
  the given groups, **or** a group whose members include a given cell. Resolve groups through
  `ReplicateGroupCell` so "delete this cell" also flags analyses that reference it only via a
  replicate.
- `remaining_entry_count` counts entries that survive; `becomes_empty` is
  `remaining_entry_count == 0`.
- A saved plot is `affected: true` unless its own `selection.exclusions` already exclude every
  matched sample (i.e. it was not showing them anyway). Plots of an analysis that becomes empty
  are all affected.
- Read-only. It must not mutate anything.

Put it in `backend/app/routers/analyses.py` next to the other analysis routes.

## A.4 Where the warning appears

Four call sites, all routed through **one shared component** — do not write the modal four
times:

| Action | Site |
|---|---|
| Explode replicate (project tree) | `ProjectsPage.tsx`, `explodeReplicate` (context menu + toolbar) |
| Ungroup replicate (cell database) | `LibraryPage.tsx`, `ungroupReplicates` |
| Remove selected cells | `LibraryPage.tsx`, `removeCells` / `confirmRemoveSelected` |
| Remove single cell | the cell editor's **Remove from library** |

New component `frontend/src/components/DestructiveImpactModal.tsx`:

```ts
{
  opened: boolean;
  onClose: () => void;
  title: string;                 // "Explode replicate?" / "Remove 3 cells?"
  cellIds?: number[];
  groupIds?: number[];
  confirmLabel: string;          // "Explode" / "Remove"
  onConfirm: (options: { deleteEmptyAnalyses: boolean }) => void;
}
```

It fetches the impact, renders it, and hands back the checkbox state. The caller stays
responsible for the actual mutation.

## A.5 Modal content

- **Loading**: a spinner with *"Checking where this is used…"*. Never let the confirm button be
  pressed before the impact is known.
- **No impact**: fall through to the existing plain confirm — do not show an empty scary modal.
- **With impact**: a short lead line, then a per-analysis list:

```
This replicate is used in 2 analyses.

▸ LFP baseline                                     3 plots affected
    Capacity fade · Rate comparison · CE overview
▸ Cell 5 deep-dive                     ⚠ will be left with no samples
    Capacity fade

☐ Also delete the 1 analysis that would be left empty
                                        [ Cancel ]  [ Explode ]
```

- Analyses that become empty are marked with an amber warning, listed first.
- The confirm button is red (destructive). The checkbox is **unchecked by default** and only
  rendered when at least one analysis would be left empty.
- If the impact request fails, say so and let the user proceed or cancel — a failed *preview*
  must not block a legitimate action, but it must not silently pretend there is no impact.

## A.6 After confirming

- Perform the existing mutation unchanged.
- If `deleteEmptyAnalyses` was ticked, delete exactly the ids from `empty_after` (recompute
  server-side at deletion time; do not trust a stale client list).
- Invalidate `["analyses"]`, `["tree"]`, `["cells"]`, `["replicate-groups"]`.
- Cell delete still leaves dangling cell refs (engine `missing_refs`). Replicate explode/ungroup
  strips the removed `replicate_group` entries from analysis specs after the mutation so the UI
  is not left with a dead replicate the user already acknowledged in the modal.

## A.7 Acceptance

1. Exploding a replicate used by 2 analyses lists both, with their affected plots, before doing
   anything.
2. Removing a cell that is referenced only *via* a replicate still flags the analyses that use
   that replicate.
3. An analysis that would be left with no samples is called out and sorted first.
4. With the checkbox unticked (default), no analysis is deleted — it is simply left empty.
5. With it ticked, exactly the empty-after analyses are deleted.
6. An action with no impact shows the ordinary confirm, not the impact modal.
7. All four call sites use the same component.

---

# Part B — Unsaved draft plots

## B.1 What already exists

`AnalysisPage.tsx` already tracks `hasUnsavedPlot`, `plotWorkspaceTouched` and
`activePlotDirty`, and the leave prompt (`leavePrompt`, ~8642 and ~10436) already offers **Go
back / Discard / Save (and leave)**.

New in this spec: a **visible** draft card, a **"Leave as draft"** option that persists, and a
warning when *New plot* would discard a draft.

## B.2 Storage: one draft per plot tab (`spec.draft_plots`)

```ts
spec.draft_plots?: Partial<Record<AnalysisTabKey, {
  tab: AnalysisTabKey;
  name: string | null;           // null until the user names it
  selection, computation, aggregation, presentation;   // same shape as SavedAnalysisPlot
  updated_at: string;            // ISO
}>>
```

Legacy single `spec.draft_plot` is migrated into `draft_plots[tab]` on load.

**Rejected alternative:** a `draft: true` flag inside `saved_plots`. Roughly a dozen places
iterate `saved_plots` — the warmup queue, thumbnail preparation, the saved-plot list, portable
export, the command palette — and each would need a filter. One missed filter puts a draft into
an exported report or the warmup queue. A separate field cannot leak by omission.

Consequences to verify while implementing:
- `analysis_cache._scientific_spec` does not read `draft_plots`, so **no cache invalidation**.
- `cache_maintenance.warmup._tasks_for_analyses` iterates `saved_plots` only, so drafts
  **never enter the warmup queue**.
- `portable_analysis` must not export drafts — strip both `draft_plots` and legacy `draft_plot`.

Exactly **one** draft per plot tab (cycles, steps, DCIR, …), not one global draft for the
analysis.

## B.3 The draft card

### Placement — its own card, outside the Saved plots container

`SavedPlotsPanel` is itself a `<Paper p="sm" withBorder>` (`AnalysisPage.tsx` ~8386). The draft
card is a **separate `Paper` rendered immediately before it as a sibling** — *not* a row inside
that panel, and not inside its list.

Implement it in the `savedPlotsPanelFor(tab)` helper (~9735) so every plot tab picks it up from
one place:

```tsx
const savedPlotsPanelFor = (tab: AnalysisTabKey) => (
  <>
    <DraftPlotCard … />          {/* renders null when it should not show */}
    <SavedPlotsPanel … />
  </>
);
```

### Visibility — appears while a plot is unsaved, disappears the moment it is saved

Show the card when **either**:

- a persisted `spec.draft_plot` exists, **or**
- the current view is an unsaved *new* plot — i.e. `hasUnsavedPlot` **and** no saved plot is
  currently open (`activeSavedPlotId === null`).

Hide it otherwise. In particular:

- **Saving the plot hides it immediately** (it becomes a normal saved-plot row), and it stays
  hidden until the user starts another new plot.
- **An edited saved plot does *not* show a draft card.** That state already has its own
  affordance — the **Update plot** button, which enables on `activePlotDirty`. Showing a draft
  card as well would present two competing "you have unsaved work" signals for one situation.
  This is the reason the rule tests `activeSavedPlotId === null` rather than `hasUnsavedPlot`
  alone (`hasUnsavedPlot` is also true for a dirty saved plot).

### Appearance

- Same internal geometry as a saved-plot row (thumbnail slot, title, subtitle, timestamp) so it
  reads as the same kind of object, but in its own bordered card.
- **Amber accent** as a hint only: soft yellow border and a low-intensity
  `color-mix` tint (not a solid yellow fill). Theme-aware — see spec 004 R4.
- Header chip: **DRAFT**. Title falls back to *"Unsaved plot"* when unnamed.
- Actions: **Save as new plot** (opens the existing save dialog) and **Discard**.
- Draft card thumbnails reuse `SavedPlotPreview` / `SavedTimeCapacityPreview` (same
  `savedRowThumbnail` path as saved plots) under synthetic ids `__draft__:<tab>`. They must
  **not** enter the idle warmup queue.

## B.4 Edited saved plot: an amber chip, not a card

A saved plot that has been edited is a different situation from a never-saved plot, and gets a
lighter-weight signal.

- **No draft card** (§B.3).
- An **amber chip** appears beside that plot's name in the Saved plots list. The row title is a
  `<Group gap={6}>` holding the tab badge and `<Text fw={700}>{plot.name}</Text>`
  (`AnalysisPage.tsx` ~8474) — the chip goes in that Group, after the name:

  ```tsx
  {active && activePlotDirty && (
    <Badge size="xs" variant="light" color="yellow">Edited</Badge>
  )}
  ```

- Rendered only for the **active** plot and only while `activePlotDirty`. It disappears on
  Update plot (baseline is reset) or on discard.
- **Non-interactive.** The **Update plot** button already sits directly above; a clickable chip
  would be a second route to the same action.
- Theme-aware amber (see spec 004 R4) — `variant="light" color="yellow"` resolves through
  Mantine and is safe; do not hardcode `yellow.0`.

## B.5 Leaving the analysis

The prompt differs by situation, because the available outcomes differ.

### B.5.1 Unsaved new plot (no saved plot open)

1. **Go back** (dismisses)
2. **Save as new plot…** (existing flow: name + description)
3. **Leave as draft** — writes `spec.draft_plot` from the current view, then proceeds
4. **Discard** (red)

"Leave as draft" replaces any existing draft. If one already exists and differs, say so in the
prompt rather than silently overwriting.

### B.5.2 Edited saved plot (`activePlotDirty`)

Four outcomes:

1. **Go back** (dismisses)
2. **Update "&lt;plot name&gt;"** — primary; writes the changes back to the existing plot
3. **Save as a copy…** — opens the usual name + description step and creates a **new** plot,
   leaving the original untouched
4. **Discard changes** (red)

**Implementation note.** `savePlotAndLeave` currently decides update-vs-create by whether
`activePlot` exists:

```ts
const plot = activePlot
  ? savedPlotFromSpec(next, activeTab, activePlot.name, subtitle, activePlot.description, activePlot)
  : savedPlotFromSpec(next, activeTab, leavePrompt.name, subtitle, leavePrompt.description || null);
```

"Save as a copy" needs the create path **while `activePlot` exists**, so add an explicit flag to
`leavePrompt` (e.g. `mode: "new" | "update" | "copy"`) and branch on that rather than on
`activePlot`. The copy must go through the existing `stage: "details"` step to collect a name and
description, defaulting the name to something like `"<original name> (copy)"`.

### B.5.3 Layout

Four actions is the maximum this dialog should carry. Keep **Discard** visually separated as a
subtle red button on the left (as today), then **Go back**, then the two save actions on the
right with the situation's primary action last. Only the copy action takes an ellipsis, since it
is the only one that opens a further step.

### B.5.4 Consistency with the tab close guard

`AnalysisWorkspaceTabs` already blocks closing a tab with unsaved plot changes ("Review it
before closing the tab."). That guard must route into these same prompts rather than showing a
second, different dialog.

## B.6 New plot while a draft exists

*New plot* must warn before clearing an existing draft:

> **Discard the current draft?**
> Starting a new plot will discard the unsaved draft "<name or 'Unsaved plot'>".
> [ Cancel ] [ Save as new plot… ] [ Discard and start new ]

Do not silently overwrite. If there is no draft and nothing unsaved, *New plot* proceeds
immediately as today.

## B.7 Restoring

Opening an analysis with a `draft_plot` shows the draft card but **does not** auto-apply it —
the user lands on their normal view. Clicking the card applies the draft's tab and settings to
the workspace. This keeps opening an analysis predictable.

## B.8 Acceptance

1. Starting a new plot and changing settings shows the amber draft card **as its own card**
   between the plot area and the Saved plots container — not as a row inside that container.
2. Saving that plot makes the card disappear immediately; it stays hidden until the user starts
   another new plot.
3. Opening a saved plot and editing it shows **no** draft card — instead an amber **Edited**
   chip appears beside that plot's name in the Saved plots list, and **Update plot** enables.
   The chip clears on Update plot or discard, and never shows on a non-active plot.
4. Leaving with an edited saved plot open offers all four outcomes: go back, update that plot,
   save as a copy (name + description step), discard changes.
5. "Save as a copy" leaves the original plot untouched and adds a new one.
6. Leaving with **Leave as draft** persists it; reopening the analysis shows the card, and the
   normal view is unchanged until the card is clicked.
7. **New plot** with a draft present warns and offers save / discard / cancel.
8. Closing the analysis **tab** routes into these same prompts, not a second dialog.
9. A draft never appears in the saved-plot list, the warmup queue, thumbnails, or a portable
   export.
10. Only one draft exists per analysis; a second "leave as draft" replaces it after warning.
11. Discarding removes `spec.draft_plot` entirely.
12. The draft card and the Edited chip are legible in both light and dark themes.

---

## Suggested order

Part A first (it closes a real data-integrity blind spot), then Part B. Within A: the endpoint,
then the shared modal, then wire the four call sites. Within B: storage + card, then the leave
prompt, then the New-plot guard.

## Verification

- `pytest tests/` — add coverage for `/api/analyses/usage`: a cell referenced directly, a cell
  referenced only through a replicate, an analysis that becomes empty, and an analysis that does
  not. Add a portable-export test asserting `draft_plot` is not exported.
- `cd frontend && npx tsc --noEmit && npx vite build`.
- Frontend unit tests: expect the two known pre-existing `.tsx` type-stripping failures
  (`cellSamplePopovers`, `protocolGroups`) and no new ones.
- Manual: the seven A.7 and seven B.7 criteria. Use a throwaway analysis — these actions delete
  real data from the shared dev DB.

---

# Review of the implementation — follow-up tasks

Reviewed 2026-07-25 against the current uncommitted worktree, including the analysis-workspace
keep-mounted behaviour and the newer analysis-query invalidation rules. This was a code-reading
review first, as required by `docs/specs/README.md`.

## Verification actually run

- `python -m unittest tests.test_analysis_usage tests.test_portable_analysis`
  — **17 tests passed**.
- One read-only in-memory probe removed the sole cell selected through a one-member replicate.
  `preview_removal_usage` returned
  `remaining_entry_count: 1`, `becomes_empty: false`, and an empty `empty_after` list.
- A second read-only in-memory probe performed that cell deletion and called the current
  post-mutation usage recheck. The analysis still existed, but the response contained no affected
  analyses because the cell-to-group membership had already been deleted.

The full Python suite, TypeScript build, Vite build, and browser flows were **not rerun**. The
spec's two known direct-Node `.tsx` loader failures (`cellSamplePopovers` and `protocolGroups`)
remain known/pre-existing and are not follow-up work for this spec.

## What the review confirmed

- `POST /api/analyses/usage` is read-only and correctly handles direct cell references, explicit
  group removal, partial removal from a multi-cell replicate, empty-after sorting, and plot
  exclusions for the cases covered by the focused tests.
- All four destructive entry points route through the shared
  `DestructiveImpactModal`: project explode (toolbar and context menu), database ungroup, selected
  cell removal, and single-cell/editor removal.
- The shared modal blocks confirmation while loading, falls through to the ordinary confirmation
  when there is no impact, exposes preview errors instead of pretending there is no impact, and
  keeps the delete-empty checkbox unchecked by default.
- Drafts use the separate top-level `spec.draft_plot`, not `saved_plots`.
  `analysis_cache._scientific_spec` ignores it, warmup iterates only `saved_plots`, and portable
  export/import explicitly remove it. The focused portable test confirms it is absent from the
  exported package and views.
- The draft card is a sibling before `SavedPlotsPanel`, uses theme-aware amber styling, has no
  thumbnail generation path, and the Edited badge is limited to the active dirty saved plot.
- The edited-plot leave dialog has update, copy, discard, and go-back actions; copy uses the create
  path and leaves the original saved plot untouched. Closing a workspace tab dispatches the same
  leave event instead of opening a second dialog.

## Known/pre-existing failures — do not fix here

- The two direct Node test failures caused by importing `.tsx` without a Node 24 loader are outside
  Spec 006.
- No destructive browser flow was exercised against the shared development database during this
  review. Do not infer that the visual/manual acceptance criteria passed.

## R1 — Correct empty-after detection and deletion for cells selected through replicates

**Priority: P1**

**Files:** `backend/app/services/analysis_usage.py`, `backend/app/routers/analyses.py`,
`frontend/src/components/DestructiveImpactModal.tsx`, the destructive callers as needed, and
`tests/test_analysis_usage.py`.

**Current:** In `preview_removal_usage`, a `replicate_group` entry increments `surviving`
whenever any requested cell belongs to it, even when the request removes the group's last member
or all of its members. The library deletion then removes the empty group. Consequently the modal
does not say that a group-only analysis will become empty and does not offer its deletion. The
optional deletion helper also recomputes usage only *after* the destructive mutation; at that
point the membership rows needed to associate the removed cells with the dangling group no longer
exist, so the analysis cannot be rediscovered.

**Target:** A replicate entry survives cell removal only when at least one member remains after
subtracting all requested cell ids. Preserve the locked unchecked-by-default behaviour. When
delete-empty is requested, carry only preflight candidates forward, then have the backend
re-resolve those candidate analyses against current database state after the destructive mutation
and delete only candidates that now resolve to zero samples. Do not trust the client to declare
an analysis empty, and do not delete anything when the checkbox is unticked.

**Acceptance:**

1. Removing the sole member of a one-cell replicate marks a group-only analysis `becomes_empty`.
2. Removing all members of a replicate in one batch does the same.
3. Removing only one member from a multi-cell replicate leaves its entry surviving.
4. With deletion unticked, all those analyses remain.
5. With deletion ticked, a backend recheck deletes exactly the preflight candidates that are
   actually empty after the mutation.
6. Focused tests cover preview and post-mutation deletion for single-member, all-member, and
   partial-member cases.

## R2 — Invalidate every analysis result family after destructive changes

**Priority: P1**

**Files:** `frontend/src/pages/LibraryPage.tsx`, `frontend/src/pages/ProjectsPage.tsx`, and
`frontend/src/analysisQueryCache.ts` only if a shared helper needs adjustment.

**Current:** Single-cell removal calls `invalidateAnalysisQueries`, but batch cell removal,
database ungroup, and project explode invalidate only some list/tree queries. Analysis specs keep
the same dangling reference, so their React Query keys do not change. Under the current
keep-mounted workspace policy, an editor can therefore continue showing computed traces for cells
or groups that were just removed.

**Target:** After every one of the four destructive mutations, invalidate the compact lists named
in §A.6 and all analysis result/preview/artifact query families through the existing shared helper.
Keep hidden editors stale without eagerly refetching them; the visible/next-activated editor should
refresh through the established workspace policy.

**Acceptance:**

1. Single and batch cell removal, database ungroup, and project explode all use the same complete
   invalidation set.
2. A mounted hidden editor cannot retain a fresh cache status for pre-removal data.
3. Reopening/activating the affected analysis fetches the post-removal empty/partial result.
4. Unaffected hidden analyses are not eagerly recomputed.

## R3 — Persist a draft without making it the normal reopened workspace

**Priority: P1**

**Files:** `frontend/src/pages/AnalysisPage.tsx` and a focused pure-policy test under
`frontend/tests/`.

**Current:** `leaveAsDraft` writes `draft_plot` into a clone of the current working spec and saves
that same current selection/computation/presentation at the top level. Normal autosave may already
have persisted those values. Reopening therefore lands on the draft settings before the card is
clicked, contrary to §B.7.

**Target:** Capture a restorable normal-workspace snapshot before an unsaved new plot diverges.
When leaving as draft, store the unsaved view only in `draft_plot` and persist the normal
top-level workspace. Applying the card may then copy the draft into the live workspace. Do not
change the locked `AnalysisDraftPlot` storage shape or put drafts into `saved_plots`.

**Acceptance:**

1. Save a draft whose axes/settings visibly differ from the normal view.
2. Reopen/remount the analysis: the normal view is present and the draft card is visible.
3. Click the card: only then are the draft tab and settings applied.
4. A focused policy test verifies that the persisted top-level view and `draft_plot` are distinct
   and survive serialization.

## R4 — Make draft save actions save the draft, not whichever view is active

**Priority: P1**

**Files:** `frontend/src/pages/AnalysisPage.tsx`, `frontend/src/components/DraftPlotCard.tsx` only
if its callback contract needs clarification, and focused frontend tests.

**Current:** Both the draft-card **Save as new plot** action and the same action in the
**Discard the current draft?** guard only open `saveDraft`. `commitSavedPlot` always serializes the
current top-level `spec`. If a persisted draft exists while a different saved plot is active, the
app saves a copy of the active plot and then clears the real draft. In the New-plot guard, saving
also does not continue into the requested clean new plot.

**Target:** Carry an explicit save source (`live workspace` versus `persisted draft`) through the
save dialog. A persisted draft must create a saved plot from its own
selection/computation/aggregation/presentation regardless of the active view. When this save was
triggered by **New plot**, complete the save and then initialize the clean new workspace requested
by the user.

**Acceptance:**

1. Keep draft A, open a visibly different saved plot B, and save from A's draft card: the new
   saved plot matches A and B is unchanged.
2. The persisted draft is cleared only after A is saved successfully.
3. Choosing **Save as new plot…** from the New-plot guard saves the draft and then opens a clean
   new plot.
4. Live, never-persisted drafts still save from the current workspace.
5. Focused tests cover both save sources and the post-save continuation.

## R5 — Make Discard actually clear the unsaved workspace state

**Priority: P1**

**Files:** `frontend/src/pages/AnalysisPage.tsx`, with focused frontend state-transition tests.

**Current:** The leave modal's **Discard** / **Discard changes** handler only invokes
`proceed()`. It does not restore the active saved plot or normal pre-draft workspace, clear the
dirty baseline/touched state, or reconcile top-level values already written by autosave. With the
default keep-mounted policy, navigating away and back can therefore show the same draft card or
Edited badge that the user explicitly discarded.

**Target:** Before proceeding, restore the correct baseline: the original saved plot for edited
saved work, or the captured normal workspace for an unsaved new plot. Clear the corresponding
dirty/touched/baseline state and persist the restored top-level spec when autosave may have written
the discarded values. Preserve an older, separate persisted draft unless the action explicitly
discards that draft.

**Acceptance:**

1. Edit a saved plot, choose **Discard changes**, navigate back under keep-mounted mode: no Edited
   chip remains and the saved plot settings are restored.
2. Change a new plot, choose **Discard**, navigate back: no live draft card remains and the normal
   workspace is restored.
3. Closing a tab through the same prompt produces the same outcomes.
4. Discard never updates the saved plot and never silently removes a different persisted draft.

## R6 — Fix analysis pluralization in destructive-impact messages

**Priority: P3**

**Files:** `frontend/src/components/DestructiveImpactModal.tsx`,
`frontend/src/pages/LibraryPage.tsx`, and `frontend/src/pages/ProjectsPage.tsx`.

**Current:** Strings built as `analysis${count === 1 ? "" : "es"}` render
**analysises** for plural counts.

**Target:** Render **analysis** / **analyses** correctly in the checkbox and completion
notifications without changing the modal logic.

**Acceptance:** Counts 1 and 2 render grammatically correct labels in every destructive call site.

## Follow-up order

1. R1 — it fixes the destructive decision and deletion set.
2. R2 — it prevents scientifically stale mounted plots after the mutation.
3. R3 — establish the correct normal/draft baseline model.
4. R4 — route saves through that model.
5. R5 — route discard through that model.
6. R6 — wording-only cleanup.

After implementation, run the focused backend tests first, then the spec's frontend checks. Manual
verification remains required for the destructive modal and keep-mounted draft transitions; use
throwaway data rather than the shared real library.

## R* implementation record

Implemented 2026-07-25 against the review follow-ups above. Locked decisions unchanged (no
auto-delete; drafts outside `saved_plots`; no silent rewrite of surviving `selection.entries`).

| Item | Change |
|---|---|
| **R1** | Replicate entries survive cell removal only when `members - requested_cells` is non-empty. Optional delete-empty carries preflight `empty_after` ids to `POST /api/analyses/purge-empty-candidates`, which re-resolves each candidate and deletes only those with zero samples. |
| **R2** | Single/batch cell removal, database ungroup, and project explode all invalidate §A.6 lists plus analysis result families via `invalidateAnalysisQueries` (`refetchType: "none"`). |
| **R3** | `normalWorkspace` snapshot (kept in workspace editor state) is restored on Leave as draft **for the persisted spec** so cold open lands on the normal view + draft card (B.7). The in-session editor keeps the draft as the live view after Leave as draft so keep-mounted navigate-away/back does not look like a revert. Pure helpers in `frontend/src/analysisDraftPolicy.ts`. |
| **R4** | Save dialog carries `source: live \| draft` and optional `afterSave: new_plot`. Draft-card / New-plot-guard saves use the persisted draft; New-plot continuation opens a clean workspace after save. |
| **R5** | Leave Discard restores the active saved-plot baseline or the captured normal workspace, persists the restored top-level spec, and does not clear a separate persisted draft. |
| **R6** | Checkbox and completion toasts use **analysis** / **analyses**. |

**Verification:** `python -m unittest tests.test_analysis_usage` (9 ok); `node --test frontend/tests/analysisDraftPolicy.test.ts` (8 ok); `npx tsc --noEmit` and `npx vite build` ok. Manual keep-mounted destructive/draft checks still recommended on throwaway data. Pre-existing Node `.tsx` loader failures intentionally untouched.
