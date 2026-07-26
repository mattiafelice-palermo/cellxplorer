# Spec 011: Cell library toolbar and combined source maintenance action

Status: **implemented**. Small backend compatibility change + frontend.  
Independent of Spec 010, but implement after 010 for easier visual review. Written 2026-07-26.

Read this whole file before editing. For UI work, also read
`docs/agent-knowledge/visual-style-guide.md`.

## 1. Goal

Simplify and align the Cell Database toolbar:

1. keep only the search box on the left;
2. right-align all actions;
3. replace separate **Check sources** and **Update changed** buttons with one split action:
   - default: **Check and update**;
   - dropdown: **Check only**;
4. make replicate availability reflect which replicate operation is actually possible.

## 2. Locked behavior

### 2.1 Action scope

For both source-maintenance actions:

- when one or more cells are selected, operate on those selected cell ids;
- otherwise operate on all non-archived active cells;
- completed cells remain skipped by default;
- do not add an “include completed” option in this spec.

### 2.2 Default and alternate source actions

Main segment:

- label: `Check and update`;
- starts one source-check job with `update_after_check = true`;
- changed stable sources are updated by that same background job.

Dropdown contains exactly one item:

- label: `Check only`;
- checks source state without updating;
- after completion, changed cells in the checked scope are selected as they are today.

Remove the visible standalone `Update changed` button.

Do not delete the existing `/api/cells/update-changed-sources` endpoint. It may still be useful to
other code and is not part of this cleanup.

### 2.3 Replicate availability

Do **not** disable the entire Replicate menu when exactly one cell is selected. The menu contains
two different actions:

- `Group selected as replicate` requires at least 2 selected cells.
- `Add selected to replicate` requires at least 1 selected cell and at least 1 existing group.

Final rules:

| Selection | Replicate control | Group selected | Add selected |
|---|---|---|---|
| 0 cells | disabled | disabled | disabled |
| 1 cell | enabled | disabled | enabled when a group exists |
| 2+ cells | enabled | enabled | enabled when a group exists |

This preserves the valid one-cell “add to existing replicate” workflow.

## 3. What already exists

See spec sections 3–8 in the original brief for file anchors and UI requirements.

## 4. Implementation record

Branch: `feature/cell-library-toolbar-source-maintenance`.

- `create_source_check_update_job` accepts optional `CellSourceCheckRequest` body; no body still
  targets all active cells (tray behavior preserved).
- `LibraryPage.tsx`: consolidated `startSourceMaintenance` mutation, split button, right-aligned
  toolbar, Replicate disabled only when zero cells selected.
- Removed toolbar `Update changed` button and `changedCells` / `updateChangedSources` flow.

Verification (2026-07-26):

```text
python -m unittest tests.test_source_and_replicates -v  (new endpoint tests)
python scripts/preflight.py  → PREFLIGHT PASSED
```

Manual UI verification (§9) not yet run in a live session.

## 6. Review of the implementation — follow-up tasks

Review document: `011-cell-library-toolbar-source-maintenance-review.md`.  
Status after follow-ups: **addressed in working tree** (2026-07-26).

| Task | Priority | Status |
|---|---|---|
| R1 — Clean branch scope (no Spec 012 files on this branch) | High | addressed |
| R2 — Disable chevron and Check only while mutation is pending | Medium | addressed |
| R3 — Base source maintenance availability on unfiltered library cells | Medium | addressed |

## 5. Acceptance checklist

- [x] Search is the only left-aligned top-toolbar control.
- [x] All actions are right-aligned.
- [x] Main source action is Check and update.
- [x] Dropdown contains only Check only.
- [x] Selected-cell scope is preserved.
- [x] No-body tray call still handles all active cells.
- [x] Separate Update changed button is gone.
- [x] No duplicate completion notification appears (LibraryPage defers to App.tsx for check/update).
- [x] Replicate is disabled only with zero selected cells.
- [x] One selected cell can still be added to an existing replicate.
- [ ] Narrow layout, keyboard access, loading and failure states (manual UI check).
- [x] Targeted tests and canonical preflight pass.
