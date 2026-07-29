# 025 — Collapsible Analyses / Samples sections inside project folders

**Status:** Implemented
**Branch:** `feature/projects-folder-sections`
**Scope:** frontend only — `ProjectsPage.tsx`, new pure module + tests

## What exists today

A folder renders its contents as four flat runs in a fixed, hard-coded order:

```tsx
{folder.children.map(renderFolderNode)}
{folder.cells.map(renderCellNode)}
{folder.replicate_groups.map(renderReplicateGroupNode)}
{folder.analyses.map(renderAnalysisNode)}
```

`visibleTreeItems(nodes, expanded)` builds the parallel flat list that backs
shift-click range selection, in the same order. Expand all / Collapse all live in the
"Folders" toolbar (`expandAll`, `collapseAll`, plus `expandSelected` / `collapseSelected`
in adjacent dropdowns).

## Goal

Offer, next to Expand all / Collapse all, an option to group each folder's contents into two
independently collapsible sections — **Analyses** and **Samples** (samples = cells + replicate
groups) — with a user-chosen order (analyses first or samples first).

## Locked design decisions

1. **One ordering function feeds both the render and `visibleTreeItems`.** These are two
   parallel descriptions of the same list, and shift-click ranges are computed from the flat
   one. If sectioning changes the visual order and the flat list is not rebuilt identically,
   a shift-click silently selects rows the user never saw. This is the single biggest hazard
   in this spec: the ordering must exist in exactly one place.
2. **Empty sections are hidden.** A folder with no analyses must not grow an empty "Analyses"
   header. Sectioning exists to reduce noise; unconditional headers would add it.
3. **Sub-folders stay unsectioned and always first.** They are the navigational spine of the
   tree. Burying them under a collapsible header is a regression regardless of the chosen
   ordering.
4. **The ordering preference is global, not per folder.** Per-folder ordering is a large amount
   of persisted state buying an inconsistency users are unlikely to want.
5. **Section headers show counts.** `Analyses (3)`. A collapsed section that says nothing about
   what it contains is a worse trade than the space it saves.
6. **The view options live in one popover, not three toolbar buttons.** Sectioning, ordering,
   and (spec 026) the metric columns are all view preferences; three more buttons would crowd
   a toolbar that already carries two split buttons and an icon action.
7. **Section collapse state is per (folder, section) and is not persisted.** It is a transient
   viewing state like folder expansion, which is also in-memory only.

## Tasks

### T1 — Pure ordering module

**File (new):** `frontend/src/folderSections.ts`
**File (new):** `frontend/tests/folderSections.test.ts`

```ts
export type SectionKey = "analyses" | "samples";
export type SectionOrder = "analyses-first" | "samples-first";

export type SectionableFolder = {
  cells: unknown[];
  replicate_groups: unknown[];
  analyses: unknown[];
};

/** Sections to render for this folder, in display order, empties omitted. */
export function visibleSections(folder: SectionableFolder, order: SectionOrder): SectionKey[];

/** Row count a section header reports. */
export function sectionCount(folder: SectionableFolder, section: SectionKey): number;

/** Stable identity for a folder's section, used as the collapse-state key. */
export function sectionStateKey(folderId: number, section: SectionKey): string;

/** Persisted view preferences. */
export type ProjectViewPreferences = { sectioned: boolean; order: SectionOrder };
export function loadViewPreferences(storage: Pick<Storage, "getItem">): ProjectViewPreferences;
export function saveViewPreferences(storage: Pick<Storage, "setItem">, value: ProjectViewPreferences): void;
```

Defaults: `{ sectioned: false, order: "samples-first" }` — off by default so existing users see
no change until they ask for it, and samples-first because that is today's order.
`loadViewPreferences` must survive absent, malformed, and partial JSON by falling back to the
defaults field by field.

**Acceptance:** tests cover both orders; a folder with only analyses yields `["analyses"]`; an
empty folder yields `[]`; counts add cells + replicate groups for `samples`; malformed and
partial stored JSON fall back to defaults.

### T2 — Single ordering used by render and range selection

**File:** `frontend/src/pages/ProjectsPage.tsx`

`visibleTreeItems` gains the view preferences and the collapsed-section set, and emits:

1. the folder row;
2. (if expanded) sub-folder subtrees;
3. (if expanded) either the flat legacy runs when `sectioned` is false, or, for each section
   from `visibleSections(folder, order)`: the section header is **not** a `TreeItem` (it is not
   selectable), and the section's rows only when that section is not collapsed.

Within `samples`, cells precede replicate groups, matching today's order.

The render block mirrors this exactly by calling the same `visibleSections` helper.

**Acceptance:** with sectioning on, shift-clicking from the first row to the last selects
exactly the rows on screen, in screen order, and never a row inside a collapsed section.

### T3 — Section headers

**File:** `frontend/src/pages/ProjectsPage.tsx`

Inherits [`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

A header row per visible section: a chevron that rotates on expand/collapse (matching the
folder rows' existing chevron treatment), the section name, and the count. Indented one level
deeper than its folder, with its rows one level deeper again. Not draggable, not selectable,
not a drop target in its own right — a drop anywhere inside the folder subtree already files
into the folder (`handleDropOnFolder` wraps the whole subtree), and that must keep working
when the pointer is over a section header.

**Acceptance:** clicking a header toggles only that section, in that folder; a folder with both
sections shows both counts; dropping a cell onto a section header files it into the folder.

### T4 — View popover

**File:** `frontend/src/pages/ProjectsPage.tsx`

A "View" button next to Collapse all opening a popover with:

- **Group into sections** — a `Switch`;
- **Order** — a `SegmentedControl` of Samples first / Analyses first, disabled while sectioning
  is off.

Changes persist immediately through `saveViewPreferences`.

**Acceptance:** toggling sectioning re-renders every expanded folder; the setting survives a
reload; with sectioning off the order control is visibly disabled rather than hidden (so the
relationship between the two is legible).

### T5 — Expand all / Collapse all cover sections

**File:** `frontend/src/pages/ProjectsPage.tsx`

`expandAll` clears the collapsed-section set (everything open); `collapseAll` collapses folders,
which implicitly hides sections. `collapseSelected` / `expandSelected` keep operating on folders
only.

**Acceptance:** Expand all with sectioning on shows every section expanded, including sections
the user had collapsed by hand.

## Implementation order

T1 → T2 → T3 → T4 → T5.

## Verification

- `node --test frontend/tests/folderSections.test.ts`
- `npx tsc --noEmit`, `npx vite build` — `frontend/src/**` changed.
- Manual: turn sectioning on, collapse Analyses in one folder, confirm the other folder's
  Analyses stays open; shift-click across a sectioned folder and confirm the selection matches
  what is on screen.
