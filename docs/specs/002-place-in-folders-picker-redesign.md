# Spec 002: "Place in folders" picker redesign

Status: **ready to implement**. Frontend-only — no backend, model, or migration changes.
Written 2026-07-25.

Redesigns the existing `PlaceInFoldersModal` from a flat, always-expanded checklist into a
two-pane dialog with a collapsible folder tree and a read-only impact pane. The dialog becomes
**strictly additive**: it can file items into folders, never remove them.

## Reference mockup

![Place in folders — target design](assets/002-place-in-folders.png)

The image is the agreed target. Where the image and the written rules below disagree, **the
written rules win**. Two known flaws in the image, both introduced by the brief it was
generated from:

1. **`New test` shows a mixed checkbox while its right pane lists two items as "Will be
   added".** Those contradict: if one item is already there and the other two are staged, all
   three will be present after Apply, so the checkbox must render **full teal**, not mixed. To
   see a genuine mixed state you need a folder where at least one selected item is *not*
   staged and *not* present. Follow §6 (State model), not the image.
2. **The footer reads "Adding 2 items to 2 folders"**; with three items selected and two
   folders ticked the correct string under §5.4 is "Adding 3 items to 2 folders". The counts in
   the image are illustrative only.

Everything else in the image — geometry, colours, tree states, muted-tick tooltip, right-pane
rows, the Projects pointer line, footer layout — is normative.

## 1. Goal and scope

**Goal.** Make it practical to file cells and replicate groups into folders when the workspace
has many folders, and make it obvious which of the selected items are already filed where.

**In scope:** the shared picker component and the tree used by it.
**Out of scope:** removing items from folders (see §2.1), folder cascade/inheritance, folder
timestamps, sharing/ownership. None of those exist in the data model.

**No backend work.** Everything needed is already in `GET /api/tree`.

## 2. Locked design decisions

### 2.1 The dialog is additive-only

Ticking a folder stages an **add**. Unticking **cancels that pending add** — it never deletes
an existing membership. There is no removal path in this dialog.

*Rationale.* With multiple items selected, "untick a folder that holds only some of them" has
no unambiguous meaning ("which cell am I removing?"). Making bulk gestures additive removes the
ambiguity entirely. Removal already has a precise home: the Projects tree, where you see one
folder's contents and remove a named cell (`DELETE /api/folders/{id}/cells/{cellId}`, already
wired there with a confirm). The right pane carries a one-line pointer to it.

**Consequence:** the modal's mutation only ever issues `POST` calls. Delete the `del(...)`
branches from the current implementation.

### 2.2 The checkbox shows the projected end state

Not "what I clicked" — **what will be true after Apply**. See §6 for the derivation. This makes
the mixed state meaningful and self-consistent with the right pane.

### 2.3 Only explicitly-ticked folders are acted on

Preserve the existing safety property: folders the user never clicked are never modified, even
when they partially contain the selection. (Trivially true once the dialog is additive, but
state it so nobody "helpfully" reconciles untouched folders.)

### 2.4 Cells and replicate groups are peers

The picker takes `cellIds` **and** `groupIds`. Counts, right-pane rows, and footer strings must
cover both. Cells use a battery glyph, replicate groups a layered-squares glyph.

## 3. What exists today

- `frontend/src/components/PlaceInFoldersModal.tsx` — current implementation. Props (**keep
  this API unchanged**, three call sites depend on it):
  `{ opened, onClose, cellIds?: number[], groupIds?: number[], title?: string, onSaved?: () => void }`.
  Today it renders a flat `FolderChecklist`, diffs `desired` vs membership on Apply, and issues
  both POST and DELETE.
- `frontend/src/components/FolderChecklist.tsx` — presentational flat list; exports
  `flattenFolders(nodes, depth)` and `FlatFolder`. **No collapse, no search**: every folder in
  the workspace is rendered, always. This is the core problem being fixed.
- Call sites:
  1. `LibraryPage.tsx` — multi-select toolbar, `cellIds={selectedIds}`.
  2. `LibraryPage.tsx` — cell-editor header, `cellIds={[selectedId]}`.
  3. `ProjectsPage.tsx` — context menu, `cellIds` + `groupIds`.
  4. `LibraryPage.tsx` — the **create-replicate dialog** embeds `FolderChecklist` directly (not
     the modal) to pick folders for a group being created. See §8.
- Data: `GET /api/tree` → `Tree { folders: FolderNode[] }`;
  `FolderNode { id, name, parent_id, cell_ids: number[], cells[], replicate_groups: {id,name,cell_ids}[], children: FolderNode[], analyses[] }`.
- Endpoints used: `POST /api/folders/{id}/cells {cell_ids}`,
  `POST /api/folders/{id}/replicate-groups {group_ids}`, `POST /api/folders {name, parent_id}`.

## 4. Component structure

Extract the tree so the create-replicate dialog can reuse it:

- **`FolderTree.tsx`** (new, presentational). Renders the collapsible tree: search box, rows,
  the inline "+ New folder" row. Props roughly:
  `{ folders: FolderNode[], checkedState: (node) => "none"|"some"|"all"|"complete",
     onToggle: (node) => void, highlightedId?: number|null,
     onHighlight?: (node) => void, counts: (node) => number,
     search: string, onSearch: (v: string) => void, onCreateFolder: (name, parentId) => void }`
  It owns expand/collapse state internally (§7.2).
- **`PlaceInFoldersModal.tsx`** — owns staging state, membership derivation, the right pane, the
  footer, and the Apply mutation. Same public props as today.
- **`FolderChecklist.tsx`** — delete once both consumers use `FolderTree`, or keep as a thin
  wrapper if that is less churn. Do not leave two divergent folder lists in the codebase.

## 5. Layout

Modal **900 × 640 px**, centred, white, 12 px radius, shadow `0 8px 32px rgba(0,0,0,0.12)`.
Light theme. Mantine tokens: teal `#0CA678` (`teal-6`), tint `#E6FCF5` (`teal-0`), borders
`#E9ECEF` (`gray-2`), body `#212529`, secondary `#868E96` (`gray-6`), muted tick `#ADB5BD`
(`gray-5`). **No red anywhere in this dialog.**

### 5.1 Header — 56 px
Title 18 px/700, from the `title` prop, e.g. *"Place 3 items in folders"*. Subtitle 12 px
`#868E96`: **"Tick the folders these items should be filed into."** Close ✕ top right.
1 px bottom divider.

### 5.2 Body — 520 px, two panes split by a 1 px vertical divider
Left **380 px**, right **519 px**.

**Left pane.** Search band 52 px: full-width input, 36 px tall, radius 8, 1 px `#DEE2E6`,
magnifier icon, placeholder *"Search folders"*. Then the tree, scrolling vertically only
(never horizontally — names truncate). Rows 36 px, radius 6, 20 px indent per depth level:

`chevron (20 px, ▸/▾, blank-but-reserved for leaves) · checkbox (18 px) · folder icon (16 px, teal outline) · name (14 px, truncate with …) · right-aligned count (12 px, #868E96)`

Row hover `#F8F9FA`; keyboard focus a 2 px teal ring; **highlighted** row (drives the right
pane) `#E6FCF5` fill with a 3 px teal left edge bar. Last row inside the scroll area is the
inline **"+ New folder"** (teal `+` + teal 13 px label).

**Right pane.** Header: teal folder icon (28 px) + folder name 18 px/700; breadcrumb below,
12 px `#868E96`, ancestors joined with ` › `. 1 px divider. Then one row per selected item,
44 px, separated by 1 px `#F1F3F5`:

`glyph (20 px) · item label (14 px, truncate) · right-aligned status pill`

Status pills, 26 px tall, radius 13, 12 px text: **"Already here"** (`#F1F3F5` fill, `#495057`
text) · **"Will be added"** (`#C3FAE8`/teal-1 fill, `#0B7285` text) · **"Not here"**
(transparent, `#ADB5BD` text, no fill). **No interactive controls in this pane at all.**

Below the list, 12 px `#868E96`: **"To take items out of a folder, open it in Projects."**

When no folder is highlighted, the pane shows centred 13 px `#868E96`: *"Select a folder to see
how it is affected."*

### 5.3 Footer — 64 px
1 px top divider, `#F8F9FA`. Left: the summary string (§5.4), 13 px `#495057`. Right:
**"Cancel"** (outline, 38 px) then **"Apply"** (solid teal, 38 px/600). Apply is **disabled and
greyed when nothing is staged**.

### 5.4 Footer summary string
Let `itemsAdded` = number of **distinct selected items** that will gain at least one new folder
membership; `foldersReceiving` = number of folders that will gain at least one item.

- Nothing staged → **"No folders selected"** (`#868E96`), Apply disabled.
- Otherwise → **"Adding {itemsAdded} item{s} to {foldersReceiving} folder{s}"**.

Pluralise both independently. Do not name the folders here — the tree already shows them.

## 6. State model

Per folder *F*, over the selected item set *S* (cells + groups):

```
present(F)  = items in S already filed in F        // from FolderNode.cell_ids / replicate_groups[].id
staged(F)   = true when the user has ticked F      // Set<folderId>, empty initially
projected(F)= staged(F) ? S : present(F)           // additive: ticking adds ALL of S
```

Checkbox rendering is a pure function of `projected(F)` and `present(F)`:

| Condition | Render | Click |
|---|---|---|
| `present(F) = S` (already complete) | **muted grey tick** `#ADB5BD`, tooltip *"All selected items are already here."* | no-op |
| `projected(F) = S` (staged, will be complete) | **solid teal ☑** | unstage → back to `present` |
| `projected(F) = ∅` | **empty ☐** | stage → ☑ |
| otherwise (some, not all) | **mixed ▣** (teal fill, white horizontal bar) | stage → ☑ |

The mixed state can therefore only ever appear for an **unstaged** folder that already holds
*some but not all* of the selection. One click resolves it to full. This is the fix for the
inconsistency noted in the mockup.

Right-pane status per item *i* in the highlighted folder *F*:

```
i ∈ present(F)                → "Already here"
i ∉ present(F) and staged(F)  → "Will be added"
otherwise                     → "Not here"
```

Apply, for each `F ∈ staged` (skip folders where `present(F) = S`):

```
POST /api/folders/{F}/cells             { cell_ids:  cellIds  minus those already in F }
POST /api/folders/{F}/replicate-groups  { group_ids: groupIds minus those already in F }
```

Skip a call entirely when its id list is empty. On success: invalidate `["tree"]`, `["cells"]`,
`["replicate-groups"]`; show a teal notification summarising the same counts as the footer;
call `onSaved?.()`; close.

## 7. Interactions

### 7.1 Staging reset
`staged` resets **only when the dialog opens** — a `useEffect` keyed on `[opened]` alone.
**Do not** add `cellIds`/`groupIds` to that dependency array: they are fresh array literals
from the parents (`[cell.id]`, `selectedIds.map(...)`) and would reset on every parent render,
wiping a click the instant it happened. This exact bug was fixed once already (spec 001, A0);
do not reintroduce it.

### 7.2 Expansion
Owned by `FolderTree`, not persisted across opens. On open, expand every folder that is an
ancestor of a folder where `present(F)` is non-empty — so the user immediately sees where the
items already live. Additionally, **auto-expand any branch containing a staged folder and keep
it open while staged**, so a tick can never hide inside a collapsed branch. Everything else
starts collapsed. There are no expand-all / collapse-all buttons.

### 7.3 Highlighting
Clicking a row's **name or icon** highlights it (right pane follows). Clicking the **checkbox**
stages/unstages *and* highlights. Clicking the **chevron** only expands/collapses and must not
change highlight or staging — `stopPropagation`. Initial highlight: the first folder with
non-empty `present(F)`, else none (placeholder pane).

### 7.4 Search
Case-insensitive substring on folder name. A folder matches if its own name matches; **its
ancestors are always kept visible** so hierarchy is never lost (same approach as the
protocol-step filter). Matching branches render expanded. Clearing the box **keeps** any
branches that were opened during the search (and any the user expanded by hand) — restoring
the stricter §7.2 collapse would hide the folders the user just found, which is less useful.
Hide the search band entirely when the workspace has fewer than 10 folders.

### 7.5 New folder
Clicking "+ New folder" replaces the row in place with a 32 px text input (placeholder *"Folder
name"*), Enter commits, Escape cancels, blur commits if non-empty. Parent = the **highlighted
folder** if one is highlighted, else root (`parent_id: null`). After
`POST /api/folders`, invalidate `["tree"]`, then **auto-stage and highlight the new folder** —
creating a folder here always means "and put these items in it".

### 7.6 Counts
The right-aligned number is `cells.length + replicate_groups.length + analyses.length` for that
folder — direct contents only, **not** recursive. This matches the badge already used in the
Projects tree; keep them consistent.

## 8. The create-replicate dialog

`LibraryPage`'s "Create replicate group" modal embeds `FolderChecklist` to choose folders for
the group being created. Migrate it to `FolderTree` (search + collapse) with `maxHeight ~220`
and **no right pane** — that dialog is narrow and the group does not exist yet, so every folder
is trivially `projected = ∅`, i.e. plain empty/checked checkboxes with no mixed or muted state.

While there, fix the outstanding race from spec 001 R2: the prefill's `ensureQueryData(...)
.then(...)` can overwrite folders the user already ticked. Guard it with a
`groupFoldersTouched` ref and apply the refreshed prefill only when the user has not interacted.

## 9. Edge cases

| Case | Behaviour |
|---|---|
| No folders exist | Tree area shows `Alert color="gray"`: *"No folders yet. Create one below."* The "+ New folder" row stays available. |
| Selection is empty (`cellIds` and `groupIds` both empty) | Footer reads *"Nothing selected"*, Apply disabled. Should not happen — call sites gate on a non-empty selection. |
| Every folder already holds everything | All rows render muted; footer *"No folders selected"*; Apply disabled. |
| A folder holds the group but not its member cells | These are independent memberships. Judge `present(F)` per item id only; never infer a cell's membership from its group's. |
| Same cell reachable via two folders | Irrelevant here — membership is per folder and explicit. |
| `POST` fails mid-loop | Surface the error notification, invalidate `["tree"]`, keep the dialog **open** so the user can see what landed and retry. Do not silently close. |
| Very deep nesting | Indent caps at depth 6 (120 px) to protect the 380 px pane; deeper levels reuse that indent. |

## 10. Explicitly excluded

Do not add: removal controls (× / Undo / "Will be removed"), any red or destructive styling,
folder "Updated" dates or any timestamp column, owner names or avatars, a checkbox on an "All
folders" root, cascade / inheritance / "(includes …)" language, a filter dropdown, expand-all
or collapse-all buttons, a selection chip strip, or a generic folder-contents browser in the
right pane.

## 11. Acceptance criteria

1. With ~78 folders the dialog opens showing a **collapsed** tree; only branches holding the
   selection are expanded. No horizontal scrollbar at any nesting depth.
2. Typing in search narrows the tree, keeps ancestors visible, and expands matches; clearing
   the box keeps those found branches open (it does not collapse back to §7.2).
3. A folder holding **some** selected items renders **mixed** and is **not** modified unless
   clicked. One click makes it full teal; the right pane's rows flip from "Not here" to "Will
   be added" in the same interaction.
4. A folder holding **all** selected items renders as a **muted grey tick**, is not clickable,
   and shows the tooltip.
5. Toggling a folder never removes anything: after Apply, no `DELETE` request is issued (verify
   in the network panel), and no previously-filed item loses its folder.
6. Clicking the chevron neither stages nor changes the highlight.
7. "+ New folder" creates under the highlighted folder (root when none), and the new folder
   arrives **already ticked and highlighted**.
8. Footer string matches §5.4 exactly, pluralises correctly, and Apply is disabled when nothing
   is staged.
9. Replicate groups behave identically to cells throughout (staging, right-pane rows, counts,
   footer).
10. All three existing call sites still work with unchanged props; the create-replicate dialog
    uses the same tree and its prefill no longer clobbers user ticks.

## 12. Verification

- `cd frontend && npx tsc --noEmit && npx vite build` — both must pass.
- `node --test --experimental-strip-types frontend/tests/*.test.ts` — expect the pre-existing
  2 failures (`cellSamplePopovers.test.ts`, `protocolGroups.test.ts`, `.tsx` type-stripping);
  **no new failures**.
- Add a unit test for the state model. Put the derivation in a plain `.ts` module (e.g.
  `frontend/src/folderPlacement.ts` exporting `projectedState(present, staged, selection)` and
  the footer-string builder) so it is testable under node's type stripping — a `.tsx` component
  is not. Cover: none/some/all/complete transitions, and the summary pluralisation.
- No `pytest` needed; nothing backend changes.
- Manual pass (shared dev DB caveat: 8643 shares `~/.cellxplorer` with the running app on 8642,
  and this dialog writes real folder membership — use a throwaway folder): open from the cell
  database with 2 cells selected, tick a folder, Apply, confirm in Projects.

## 13. Implementation order

1. Extract `FolderTree` with search + collapse; render it inside the existing modal to replace
   `FolderChecklist` (behaviour unchanged at this point).
2. Switch the state model to §6 (projected end state, additive-only) and delete the `del(...)`
   calls.
3. Add the right pane + footer summary.
4. Migrate the create-replicate dialog (§8) and fix its prefill race.
5. Delete or reduce `FolderChecklist`; extract the pure state module and add its test.

---

# Review of the implementation — follow-up tasks

Reviewed 2026-07-25. **Overall: accepted.** The implementation follows the spec closely, and
notably gets the two things right that this spec exists to protect: the §6 state model and the
additive-only guarantee. The follow-ups below are all cosmetic or code-quality — none change
behaviour the user can get wrong.

## What the review verified (do not redo)

`tsc`/`vite build` were run by the implementer and are not repeated here. The reviewer ran:

| Check | Result |
|---|---|
| `node --test --experimental-strip-types frontend/tests/folderPlacement.test.ts` | **11 passed, 0 failed** |

Confirmed correct by reading the code — do not re-litigate:

- **§6 state model** is an exact match, including the ordering subtlety: `complete` is tested
  **before** `staged`, so a folder that already holds everything can never be re-staged.
  `placementItemStatus` and the footer builder match §5.4 verbatim.
- **§12** is satisfied properly: `frontend/src/folderPlacement.ts` is pure and React-free, with
  11 tests. One is explicitly named for the mockup contradiction
  (*"checkbox: staged projects to full even when partially present"*), which locks in the fix.
- **§2.1 additive-only** holds: zero `del(...)` calls in `PlaceInFoldersModal.tsx` or
  `FolderTree.tsx`. The Apply mutation only issues `POST`.
- **§4**: `FolderChecklist.tsx` is deleted with **no** remaining references anywhere in `src/`
  or `tests/` — there is no second, divergent folder list left in the tree.
- **§7.1**: the reset `useEffect` is keyed on `[opened]` alone. The spec-001-A0 bug has not
  been reintroduced.
- **§7.3**: the chevron's handler calls `stopPropagation` and sits outside the name group, so
  expanding neither stages nor re-highlights. Checkbox stages **and** highlights; the name/icon
  group highlights only.
- **§7.4**: `visibleIdsForSearch` keeps every ancestor of a match visible, `matchingBranchIds`
  expands matching branches, and the search band is hidden below 10 folders.
- **§7.5**: inline create with Enter/Escape/blur; parent is the highlighted folder (root when
  none); on success the new folder is **auto-staged and highlighted**.
- **§7.6**: counts are direct (`cells + replicate_groups + analyses`), not recursive.
- **§8**: the create-replicate dialog now embeds `FolderTree` with only `"all"`/`"none"`
  states, and the spec-001 **R2 prefill race is fixed** — `groupFoldersTouched` is reset on
  open, set in `onToggle`, and checked before the `ensureQueryData(...).then(...)` prefill
  applies.
- **§9 error path**: on failure the dialog stays open and invalidates `["tree"]`. Because
  `addPlan` recomputes from fresh membership, folders that already succeeded drop out of the
  plan — a retry is naturally idempotent.
- Public props are unchanged; all three call sites still compile against them.

## R1. Invalid CSS property on the chevron cell

**Priority: nit.** `frontend/src/components/FolderTree.tsx` line ~286:

```tsx
<Box w={20} style={{ flexShrink: 0, displayContent: "center" }}>
```

`displayContent` is not a CSS property (React passes it through; the browser drops it). The
intent was presumably to centre the chevron in its 20 px cell. Replace with
`display: "flex", alignItems: "center", justifyContent: "center"`, or delete the property if
the current alignment already looks right.

**Acceptance:** no invalid style keys remain; chevron alignment unchanged or improved.

## R2. Row hover is done by mutating the DOM, and can drop out mid-interaction

**Priority: low.** Same file, the row `Group` uses `onMouseEnter`/`onMouseLeave` to write
`event.currentTarget.style.background` directly.

This fights React's rendering. The hover tint is an inline style React does not know about, so
**any re-render while the pointer is resting on the row** — e.g. ticking a folder, which changes
`staged` and re-renders the tree — re-applies the `style` prop and wipes the tint until the
next mouse movement. It is a small flicker, but it happens exactly during the dialog's primary
interaction.

**Target:** move hover to CSS so it survives re-render — a CSS module class with `:hover`, or
Mantine's `styles={{ root: { "&:hover": {...} } }}`, keeping the highlighted state in the
`style` prop as it is now. Do not keep both mechanisms.

**Acceptance:** hovering a row and ticking its checkbox leaves the hover tint intact without
moving the mouse.

## R3. Clearing the search box does not restore the pre-search expansion

**Priority: low — decide, then either fix or amend the spec.** §7.4 states *"Clearing the box
restores §7.2."* The implementation only ever **adds** `searchExpand` ids into `expanded`
(the effect early-returns on an empty query), so branches opened by a search stay open after
the query is cleared, and expansion accumulates across successive searches.

**Resolution (2026-07-25): (b).** §7.4 was amended so clearing search keeps found branches
open. No code change.

## R4. `flattenAll` re-walks the whole tree inside a loop

**Priority: nit.** `PlaceInFoldersModal.tsx`, in the `addPlan` memo:

```ts
for (const folderId of staged) {
  const node = flattenAll(roots).find((folder) => folder.id === folderId);
```

`flattenAll(roots)` is rebuilt on every iteration — O(staged × folders). Harmless at realistic
sizes, but hoist it out of the loop (or build a `Map<id, FolderNode>` once) since the same memo
already walks the tree elsewhere.

## Follow-up order and verification

R1 and R4 are one-line changes; R2 is a small refactor; R3 is a decision first. After any of
them: `npx tsc --noEmit && npx vite build`, and re-run
`node --test --experimental-strip-types frontend/tests/folderPlacement.test.ts` (11 must still
pass). No backend change, so no `pytest` needed.

## Still unverified (needs a browser)

The reviewer did not run the app: the dev backend on 8643 shares `~/.cellxplorer` with the
user's app on 8642, and **Apply writes real folder membership**. Use a throwaway folder when
checking these:

- **Acceptance criterion 1** — that a depth-6 folder in the 380 px pane produces **no
  horizontal scrollbar**. The row uses `truncate` + `minWidth: 0` and caps indent at 120 px, so
  it should hold, but this project has been bitten by Mantine `ScrollArea` width behaviour
  before (the `ScrollArea.Autosize` horizontal-bar bug in the DCIR/Steps series lists) — worth
  one look.
- The overall visual match to `assets/002-place-in-folders.png` (geometry, pill colours, muted
  tick, highlighted left bar).
- End-to-end: open from the cell database with 2 cells selected, tick a folder, Apply, and
  confirm the placement in Projects.
