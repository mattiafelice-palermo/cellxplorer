# 036 — Import modal shell consistency

**Status:** Implemented
**Repository:** `mattiafelice-palermo/cellxplorer`
**Depends on:** The import modals created by Spec 035.1–035.8/035.12.
**Branch:** `feature/spec-035-user-experience-optimization` (see *Branch note*).
**Review document:** None yet.

All UI work inherits [`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

## Branch note

This spec edits surfaces that exist only on the Spec 035 branch. Creating a branch from `main`
would not contain the modals being changed, so the work continues on the shared 035 branch by
deliberate exception to the one-feature-per-branch rule.

## Problem

The three import steps were built incrementally and no longer agree on where anything lives.
Measured in the running app at a 1230x872 viewport:

| Step | Width | Height | Header | Primary actions |
|---|---|---|---|---|
| 1 `Load cell files` | 1088 | 768 | 60 | Footer, bottom-right |
| 2 `Choose files to import` | 1107 | 772 | 68 | **Inside the modal title** |
| 3 `Import cells` | 1107 | 785 | 60 | Toolbar under the tabs |

Three steps, three different action locations, and the modal resizes between them.

Worse, every state change injects a block **above** the work area, so the panes the user is reading
move down. Measured in step 3:

| State | Panes start at |
|---|---|
| Normal | y ~159 |
| + duplicate warning | y 238 |
| + registration progress | y ~390 |

Step 1 has the same fault: selecting files reveals a *Selected sources* panel that shrinks the file
list above it.

Also measured:

- Step 3 overflows horizontally by 92 px (`scrollWidth` 1184 vs `clientWidth` 1092).
- Step 3's body is 1461 px tall inside a 785 px modal, so nothing holds a stable position.
- Step 2's buttons are children of the Mantine `title` element, so the accessible name is
  `"Choose files to importBackContinue with 12 files"`.
- Long explanatory sentences occupy vertical space in all three steps.

## Locked decisions

1. **One shell.** All three steps render through a single component with one fixed width and height.
   Advancing a step must not resize or reposition the dialog.
2. **Actions live in a sticky footer**, never in the header or title. Order is secondary-left,
   primary-right: `[Cancel] ....... [Back] [Continue]`.
3. **Reserved slots.** Notices and progress occupy a footer region that is present in the layout
   whether or not it currently shows anything, so appearing costs zero layout shift.
4. **The work area is the only scrolling region** and keeps a stable top edge.
5. **Prose becomes info affordances.** Standing explanations move into an `IconInfoCircle`
   tooltip/popover next to the control they describe. Text that reports *current state* (counts,
   sizes, conflicts) stays visible.
6. Step-specific commands that are not navigation (`Add more sources`, `Remove all already
   imported`, the destination-folder picker) stay in the work area, not the footer.

## Tasks

### T1 — `ImportModalShell`

New `frontend/src/components/ImportModalShell.tsx` plus a CSS module. Props: `opened`, `onClose`,
`title`, `step`/`totalSteps`, `notice`, `progress`, `actions`, `closeDisabled`, `children`.

Fixed geometry for every step; body is a flex column; `children` scroll; footer is fixed.

Acceptance: all three steps report the same modal width and height; the footer never scrolls.

### T2 — Adopt the shell in all three steps

`ImportFilesystemPickerModal.tsx` and the two modals in `InboxPage.tsx`. Step 2's buttons leave the
title. Step 3's `Cancel`/`Import N cells` leave the toolbar.

Acceptance: the accessible modal name is exactly the step title.

### T3 — Progress and notices into reserved slots

Registration progress and `Continue in background` render in the footer, not above the tabs.
Duplicate/conflict alerts render in the notice slot.

Acceptance: the work area's top edge does not move when progress starts or a warning appears.

### T4 — Stabilise step 1's selected-sources panel

Give it a reserved height so revealing it does not shrink the file browser.

### T5 — Replace standing prose with info buttons

The three sentences named above, plus the scientific-values explanation in step 3.

### T6 — Fix step 3's horizontal overflow

The three panes must fit; the detail pane flexes.

Acceptance: no horizontal scrollbar at 1230 px.

## Verification

```powershell
node --test frontend\tests\*.test.ts
cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..
python scripts\preflight.py
```

Browser checks (authorized by the user for this spec): all three steps in light and dark, the work
area's top edge stable across normal/warning/progress states, and no horizontal scrollbar.

## Implementation record

Branch `feature/spec-035-user-experience-optimization`, version `0.18.0-beta004`.

- **T1/T2** — `ImportModalShell.tsx` + `.module.css`. All three steps adopt it. Measured after:
  every step is **1248x810 with the work area starting at y=106**, against 1088/1107/1107 and three
  different action locations before. Step 2's buttons left the title, so the accessible name is now
  `"Import cellsStep 3 of 3"` rather than `"Choose files to importBackContinue with 12 files"`;
  `buttonsInHeader` is `[]` on all three.
- **T3** — Registration progress and the duplicate/conflict alerts moved into footer slots.
  `workTop` measured at **106 in all three states** (idle, duplicate warning, registration
  progress), against ~159 / 238 / ~390 before. `Continue in background` is now the footer's primary
  button while running instead of a fourth action location.
- **T4** — Step 1's *Selected sources* panel is always mounted at a fixed height, showing
  "Nothing selected yet." when empty. Verified: selecting 12 files no longer shrinks the browser.
- **T5** — Three standing sentences became `titleInfo` tooltips, plus `ImportInfoHint` on the
  *Scientific values* divider and the metadata toggle.
- **T6** — Panes narrowed to 250/330 with an explicit `flex: none`, the command row wraps, and the
  shell carries `min-width: 0`. Horizontal overflow **92 px -> 0**.

### A mistake worth recording

The first version of the shell used `overflow-x: hidden` on the work area without `min-width: 0` on
the flex items. That did not contain the content: the work div stretched to 1201 px inside a
1011 px dialog and the overflow was **clipped and unreachable**, which is worse than the scrollbar
it replaced. Flex items need explicit `min-width: 0` to be constrained by their container, and the
scroll axis should be `auto`, never `hidden`, when content can legitimately exceed the box.

### Verification

```text
npx.cmd tsc --noEmit          clean
npx.cmd vite build            built
python scripts\preflight.py   PREFLIGHT PASSED, 5/5
```

Browser: full three-step flow driven end to end against an isolated data root, in **light and
dark**, including a real 3-cell import that reached `READY` in the Cell Database.

### Not done

- The three-pane layout is unchanged below ~1150 px viewport width; narrow-window behaviour was not
  designed, only kept from overflowing.
- `InboxPage.tsx` still contains a dead local `ImportFilesystemPickerModal` (~460 lines) that
  duplicates the shared component and is never rendered. Left alone to keep this diff reviewable.
- The `Raw cycling data` sub-modal still uses a plain `Modal`; it is not one of the three steps.
