# 047 — Continued-cell import workspace

**Status:** Plan  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Authoring baseline:** `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
**Planned branch:** `feature/continued-cell-import-workspace`  
**Depends on:** Specs 034.2/034.4, 035.8, and 036 as implemented on the eventual merge base  
**Shape:** three sequential implementation children  
**Final review document:** `reviews/047-continued-cell-import-workspace-review.md`

> **Implementation-base rule:** this document records the code inspected while authoring the plan.
> Before implementation, follow `AGENTS.md`: check whether another feature branch is still active,
> resolve the then-current `main`, and identify the real merge base. Do not create the planned branch
> from this recorded commit if `main` has moved or the one-feature-at-a-time rule still blocks it.

All UI work inherits `AGENTS.md`, `docs/specs/README.md`,
`docs/agent-knowledge/README.md`, `docs/agent-knowledge/state-and-performance.md`,
`docs/agent-knowledge/visual-style-guide.md`, and the locked import-shell decisions in
`docs/specs/036-import-modal-shell-consistency.md`.

Read the parent before any child. The decisions below are binding unless the user explicitly changes
them.

---

## Goal

Replace the current **One continued cell** Step-3 editor with a compact, usable workspace that looks
and behaves like the existing **Separate cells** Step-3 modal while preserving CellXplorer's
continuation model and safety rules.

The target workflow is:

```text
several physical cycling source files
              ↓
one ordered source chain
              ↓
one Cell
```

The source files are not concatenated or rewritten. The user reviews their order, sees a combined
capacity preview in global Cell cycle numbering, edits one Cell-level draft, and imports one Cell.

The final workspace must make the common path obvious without permanently filling the modal with
diagnostic alerts.

---

## Product model that must not change

The current user-facing hierarchy is:

```text
Cell
└── ordered SourceFiles
```

`Test` / `TestFile` remain internal compatibility storage. Continued import creates one Cell and one
internal Test row with the source order stored through the existing position relation. The UI must not
show Test names, create multiple Tests, or split a continuation because a protocol changes.

The final ordered source is the **Tracked tail**. Every preceding source is a **Historical source**.

Cell-level name, notes, scientific overrides, presets, and folder placement belong to the Cell draft.
They must not change merely because the user previews or reorders a source.

---

## Current implementation anchors

### `frontend/src/pages/InboxPage.tsx` — `ImportModal`

Current Step 3 already owns:

- `drafts`, active draft state, staged-source removal, add-more flow, and lazy previews;
- the `Separate cells` / `One continued cell` `SegmentedControl`;
- `continuedCellDraft`, initialized from the first staged draft;
- destination folders;
- raw-data modal loading through `/api/imports/raw-data`;
- the final `/api/imports/cells` mutation and job token;
- sticky shell footer state for registration / Continue in background / Done;
- the separate-cell three-pane layout.

In continued mode it currently delegates the editor to `ContinuedImportEditor`. The continued editor
owns its own import button, while the shared shell footer owns the separate-cell import button. This
is inconsistent with Spec 036 and is corrected by 047.

### `frontend/src/components/ContinuedImportEditor.tsx`

Current continued-editor state includes:

- ordered staged-source keys;
- drag index;
- selected preview source;
- explicit continuation inspection request;
- `ContinuationInspectResult`;
- acknowledgement IDs;
- `continuedImportCanSubmit(...)`;
- a source-specific lazy capacity preview;
- source-chain rendering;
- Cell name / notes / scientific values / presets.

The current component also renders several persistent alerts and the acknowledgement list directly in
the workspace. The resulting page is vertically dense and is the main UX target of this spec.

### `frontend/src/components/ContinuationSourceList.tsx`

This is a shared continuation-source list. It already supports:

- drag-and-drop;
- up/down actions;
- removal;
- Historical source / Tracked tail roles;
- source status badges;
- cycle/time/protocol/path/hash details;
- raw-data actions;
- per-source finding rows.

The compact card geometry and drag behavior are worth preserving. The continued-import workspace needs
a **compact import presentation**, not a replacement interaction model. Existing-cell continuation
management must keep its current default presentation.

### `frontend/src/continuationPolicy.ts`

Current pure policy owns:

- source movement;
- suggested ordering;
- submission blocking;
- acknowledgement identity;
- metadata-only acknowledgement binding;
- source-role labels;
- scientific-draft validation.

Keep these semantics unless a child explicitly says otherwise.

### `frontend/src/api.ts`

Relevant types and calls include:

- `ImportPreview` / `ImportPreviewResult`;
- `ContinuationInspectRequest`;
- `ContinuationInspectSource`;
- `ContinuationInspectResult`;
- `inspectContinuationSources(...)`;
- import source/cell draft types.

The ordinary import preview currently exposes one source's bounded:

```ts
capacity_preview: {
  x: number[];
  y: number[];
  quantity: string;
  label: string;
} | null
```

### Backend

`backend/app/services/continuations.py` owns deterministic continuation compatibility and findings.

`backend/app/services/stitch.py` already owns the authoritative source-local → global cycle mapping.
Its `stitch_cycles(...)` path:

- loads the ordered sources at their own parser identities;
- enumerates observed local cycle labels;
- maps them densely into global Cell cycles;
- records source segment identity;
- fails closed when an ordered cache is missing.

Do not recreate this global-cycle mapping in React.

`backend/app/routers/files.py` owns import discovery, inspection, source preview, raw-data preview,
continuation inspection, and final registration endpoints.

### Focused tests

Extend the existing surfaces rather than creating a parallel continuation model:

- `frontend/tests/continuationPolicy.test.ts`
- `frontend/tests/multiSourceImport.test.ts`
- `frontend/tests/importPreviewPolicy.test.ts`
- `tests/test_continuations.py`
- `tests/test_import_flow.py`

A small new frontend policy test file is acceptable for source-color/session/workspace helpers when it
keeps those helpers React-free.

---

# Locked design decisions

## 1. Keep the existing Step-3 shell and mode selector

This is still **Step 3 of 3** inside `ImportModalShell`.

Keep the current full-width:

```text
Separate cells | One continued cell
```

choice at the top of the work area.

Do not create a new modal size, wizard step, page, or window for continued import.

Spec 036 remains binding:

- fixed modal geometry;
- stable work-area top;
- sticky footer;
- no whole-modal scrolling in Step 3;
- `min-width: 0` on constrained flex children;
- pane-local scrolling.

## 2. Final layout is a three-column workspace

When `One continued cell` is active, use:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Separate cells                    One continued cell                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Add more sources       Destination folders       Inspect continuity          │
├─────────────────┬─────────────────────────────────┬───────────────────────────┤
│ Source chain    │ Preview                         │ Cell draft                │
│                 │                                 │                           │
│ compact rows    │ combined capacity plot          │ Cell name                 │
│ drag/reorder    │ source/combined selector        │ notes                     │
│ remove          │ Raw data button                 │ scientific values         │
│                 │ selected-source summary         │ presets                   │
│                 │                                 │                           │
├─────────────────┴─────────────────────────────────┴───────────────────────────┤
│ Review N selected files...                  Cancel   Import one continued cell│
└─────────────────────────────────────────────────────────────────────────────┘
```

Suggested starting geometry at normal UI zoom:

- source chain: ~300–330 px, fixed/flex-none;
- preview: flexible, `minWidth` roughly 480–520 px;
- Cell draft: ~360–400 px, fixed/flex-none.

Use the existing modal's available dimensions and adjust within these ranges if browser verification
shows clipping. Do not introduce a horizontal scrollbar to compensate for poor flex constraints.

## 3. Source rows stay compact and draggable

The target row is the compact source-card style already established by
`ContinuationSourceList.tsx`, not a tall diagnostic card and not a full table.

Each continued-import row should read approximately as:

```text
[●1] [drag] filename.......................... [Ready] [↑]
          [Historical source]                         [↓]
          Cycles: 1–120  |  Time: 15 Jan 2024       [×]
```

The final source uses `Tracked tail`.

Default compact rows must **not** permanently show:

- full source path;
- hash;
- protocol signature;
- findings;
- long inspection messages;
- raw-data contents.

Those details belong in the center selected-source summary, tooltips, or the secondary continuity
review.

Keep:

- drag-and-drop;
- up/down buttons as the non-drag / keyboard-accessible ordering path;
- remove action;
- filename truncation + full-value tooltip/title;
- stable `staged_name` identity.

Target the same compact footprint as the current source cards / separate-cell loaded-file cards,
roughly one 88–104 px row at 100% UI zoom rather than the current expanded diagnostic stack.

## 4. One source color follows one source throughout the open modal

Each staged source gets a session-only display color from the existing CellXplorer **plot palette**,
not an ad-hoc chrome palette.

The source's color appears in:

- its numbered circle in the left source list;
- its segment of the combined preview plot;
- optionally its small source index annotation / hover label.

The number remains visible, so color is never the only identifier.

**Color belongs to source identity, not list position.**

Therefore:

```text
source B is orange
→ drag B from position 2 to position 3
→ source B remains orange
→ its plot segment remains orange
```

Reordering must not recolor every source.

Adding a source assigns the next available palette slot while preserving colors already assigned in
this open import session. Removing a source does not reshuffle the surviving colors.

The mapping is presentation-only:

- do not persist it to SQLite;
- do not add it to import payloads;
- do not affect scientific/cache identity;
- it may be reconstructed when the modal is reopened.

If the current `PLOT_PALETTES.app` location would create an undesirable dependency from import UI into
the analyses feature, extract only the shared palette definition into a neutral presentation module
and preserve existing analysis consumers. Do not introduce a second set of nearly identical colors.

## 5. No plot legend

The combined continuation preview has **no bottom/right Plotly legend**.

The left source chain is the visual key: numbered source circles and plot segments use the same
colors.

The plot may use restrained vertical join separators and small numeric source annotations (`1`, `2`,
`3`, `4`) to make boundaries clear, but it must not reintroduce a large filename legend.

Hover text may include source number and filename.

## 6. Raw data is an on-demand button

Do not embed a raw-data table in the main continued-cell workspace.

Keep one compact **Raw data** button in the preview area. It reuses the existing raw-data modal and
pagination path in `InboxPage.tsx`.

Raw-data access remains capability-gated:

- canonical cycling source selected → enabled;
- metadata-only/non-canonical source → disabled with an explanatory tooltip;
- combined/all-sources view with no individual source target → either disable the button or bind it
  explicitly to the currently selected source row. Do not make the target ambiguous.

## 7. Remove persistent warning/finding clutter, not validation

The main three-column workspace must not permanently render:

- blue/orange/red continuation finding Alerts;
- per-source finding rows;
- an acknowledgement checklist;
- a large "inspection deferred" Alert.

The backend continuation inspection and submission safety contract remain.

Findings that actually require user action move to a compact secondary **Continuity review** surface
implemented by 047.3.

Blocking findings still block import. Confirmation findings still require acknowledgement. Metadata-
only acknowledgement remains identity-bound. The product becomes quieter; it does not become less
safe.

## 8. Continuity inspection remains explicit

Do not parse every staged source merely because the user switched to `One continued cell`.

The top command area retains **Inspect continuity**.

Before it is requested, use restrained helper/state copy rather than an Alert, for example:

```text
Inspect continuity to prepare the combined preview.
```

The expensive all-source preview introduced in 047.2 is allowed only behind this explicit
continuation-inspection boundary.

## 9. Combined preview uses authoritative backend stitching

The combined plot represents the source chain in **global Cell cycle numbering**.

Do not derive that numbering in the frontend by:

- adding local cycle numbers;
- assuming every file restarts at 1;
- assuming local cycles are contiguous;
- concatenating preview-array indices.

Use `backend/app/services/stitch.py`'s existing dense observed-cycle mapping. It already handles
restart/continue/overlap/gap labels consistently with the scientific application.

The combined preview is display-only and bounded. It reuses existing per-source scientific caches and
the existing capacity-preview quantity semantics. It must not create a second numerical cache.

## 10. Preserve Spec 035.8's lazy-preview performance intent

Spec 047 narrowly refines the old rule that continued import requests only one active-source
preview.

The new rule is:

```text
ordinary source preview
→ still lazy, one source on demand

combined continuation preview
→ no request when Step 3 opens
→ explicit Inspect continuity requested
→ required source caches become ready through the existing inspection path
→ then one bounded combined-chain preview may be requested
```

No `drafts.forEach(loadPreview)`, no uncontrolled N concurrent browser requests, and no eager parse on
mode switch.

## 11. One primary import action, in the sticky footer

Remove the continued editor's internal/top `Import one continued cell` primary button.

The canonical action lives in `ImportModalShell`'s sticky footer, matching Separate cells:

```text
Cancel                                  Import one continued cell
```

During registration, the existing registration/progress/Continue-in-background/Done footer state
takes over unchanged.

`Add more sources`, destination folders, and `Inspect continuity` remain work-area commands.

## 12. Cell draft remains independent of source selection and order

The right pane edits exactly one `ContinuedCellDraft`.

Changing:

- selected preview source;
- combined vs individual preview;
- source order;
- source color;
- raw-data target

must not alter Cell name, notes, metadata or scientific overrides.

Preserve existing active-material and electrode-area preset semantics.

## 13. Separate-cell mode is not redesigned

The user's current Separate cells Step-3 modal is the visual reference.

Do not redesign:

- Replicates;
- Loaded files;
- separate-cell detail editor;
- separate-cell lazy preview;
- separate-cell duplicate handling.

Shared changes must have regression coverage proving that separate mode remains behaviorally intact.

## 14. No scientific/schema version change is expected

This feature changes workflow presentation and adds a bounded pre-registration display preview.

Expected consequences:

- no SQLite migration;
- no released migration edits;
- no `CALC_VERSION` bump;
- no change to final imported scientific values;
- no change to source checksum ownership;
- no change to cache invalidation rules.

If implementation discovers a need to change scientific cached meaning, stop and escalate rather than
silently expanding this spec.

## 15. Close the known project-context drift

The current project-context architecture mirror is stale in at least two durable places:

1. it still describes the canonical hierarchy as `SourceFile → Test → Cell`;
2. it still describes the currently verified BioLogic MPR path as metadata-only in cases for which
   current `AGENTS.md`/implementation now recognize the narrow verified GCPL source-local cycle path.

047.3 must perform the maintenance procedure in
`docs/project-context/CELLXPLORER_CONTEXT_MAINTENANCE.md`, update the canonical repository copy, update
its synchronization metadata, check the other three Project-context files for contradictions, and
tell the user exactly which uploaded Project mirror file(s) must be replaced.

Do not use the UI redesign itself as a reason to rewrite unrelated project-context sections.

---

# Child plan

Implement sequentially on one shared feature branch, with a pushed review checkpoint after each child.

## 047.1 — Continued-cell workspace and compact source chain

Owns:

- three-column continued-mode workspace;
- compact draggable source rows;
- source selection for preview;
- stable session source colors and colored number circles;
- Add more / destination-folder command placement;
- Cell-draft pane;
- one footer-owned import action;
- source/action state projection needed by that footer;
- existing safety semantics retained while the later review surface is still pending.

**Does not add the combined all-source preview endpoint.**

## 047.2 — Source-colored combined continuation preview

Owns:

- bounded backend chain-preview endpoint;
- authoritative `stitch_cycles(...)` global-cycle mapping;
- combined source-segment plot;
- exact source color parity with the left list;
- no Plotly legend;
- individual/combined preview selection;
- selected-source summary;
- Raw data as a button only;
- explicit-inspection / lazy-load performance contract.

**Does not redesign continuation finding semantics.**

## 047.3 — Continuity review, integration closure, and context sync

Owns:

- removal of persistent finding/acknowledgement clutter from the main workspace;
- secondary Continuity review for blocking/confirmation cases;
- unobtrusive inspected/review-required state;
- registration/progress integration audit;
- separate-cell and existing-cell continuation regression;
- `state-and-performance.md` update for the new explicit combined-preview boundary;
- project-context drift correction and mirror instructions;
- spec index/review links and final Parent 047 verification.

---

# Out of scope

- redesigning existing-Cell attach/reorder/detach management;
- changing what constitutes scientific continuation compatibility;
- concatenating or rewriting source files;
- changing parser semantics;
- new source formats;
- making source metadata editable;
- replicate grouping in continued mode;
- persisting source colors;
- a general application-wide alert/warning redesign;
- redesigning the raw-data modal;
- altering source-monitoring/tracked-tail semantics;
- introducing a user-visible Test entity.

---

# Parent acceptance criteria

Parent 047 is complete when all of the following are true.

### Workspace

- `One continued cell` uses the existing Step-3 shell and mode selector.
- Source chain, Preview, and Cell draft are three stable independently usable panes.
- No whole-Step-3 horizontal overflow is introduced.
- The main toolbar and mode selector remain fixed while panes scroll.
- Continued mode has one primary Import action and it lives in the sticky footer.

### Source chain

- Rows retain compact current-style geometry.
- Rows remain draggable.
- Up/down controls remain usable without drag-and-drop.
- Remove uses stable source identity.
- Final visible source is Tracked tail; the rest are Historical source.
- Reorder/removal do not mutate the Cell draft.
- Each source gets a stable session color shown on its numbered circle.
- Source color follows the source across reorder.

### Preview

- Step-3 open/mode switch does not eagerly parse every source.
- After explicit continuity inspection, the combined preview can show the complete ordered chain.
- Global cycles come from backend stitching semantics.
- Each source segment uses exactly the same source color as its left-row number.
- There is no Plotly legend.
- Raw data is an on-demand button, not an embedded table.
- Individual-source preview remains lazy.
- Metadata-only/incomplete chains do not masquerade as complete combined scientific previews.

### Validation

- Continuation validation still runs through the current backend contract.
- Blocking findings cannot be bypassed.
- Confirmation/metadata-only acknowledgements remain identity-bound.
- The main workspace contains no persistent finding stack or acknowledgement checklist.
- Required review occurs in the secondary continuity-review surface.

### Import lifecycle

- Final request still creates one Cell with ordered `sources[]`.
- Submitted source order exactly matches visible order.
- Registration remains the existing asynchronous 202/background handoff.
- Scientific cache preparation remains post-registration.
- Separate-cell mode is unchanged.

### Visual/accessibility

- Styling matches the current Step-3 Separate cells modal and visual style guide.
- Source identity colors are plot-presentation colors, not semantic chrome.
- Selected state is still recognizable independently from source color.
- Long filenames truncate with tooltip/title.
- All icon-only controls have accessible names/tooltips.
- Light and dark mode remain legible.
- Keyboard access remains available for source ordering and all form/actions.

### Documentation

- `state-and-performance.md` records the explicit combined-preview exception to active-source-only
  preview loading.
- the known project-context architecture drift is corrected;
- affected uploaded mirror file(s) are named for replacement.

---

# Parent implementation order

1. Implement and review 047.1.
2. Implement and review 047.2.
3. Implement and review 047.3.
4. Run the cumulative parent regression matrix.
5. Record final parent findings in
   `docs/specs/reviews/047-continued-cell-import-workspace-review.md`.
6. Merge only after all child reviews and cumulative verification are clean.

---

# Parent verification

Each child defines focused tests. Final closure must use the repository's then-current canonical
commands. At the authoring baseline, that includes:

```powershell
node --test frontend\tests\continuationPolicy.test.ts frontend\tests\multiSourceImport.test.ts frontend\tests\importPreviewPolicy.test.ts
python -m unittest tests.test_continuations tests.test_import_flow

cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..

python scripts\preflight.py
```

Do not claim browser checks from typecheck/build results. Record each manual check as
`PASS`, `FAIL`, or `NOT RUN`.
