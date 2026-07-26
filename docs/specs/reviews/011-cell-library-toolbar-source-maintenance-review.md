# Review 011: Cell library toolbar and source maintenance

Branch: `feature/cell-library-toolbar-source-maintenance`  
Status: **follow-ups required before merge**

## Confirmed

- The combined endpoint accepts selected cell IDs while preserving the no-body tray call.
- The main action is **Check and update**; the dropdown contains only **Check only**.
- The standalone **Update changed** button was removed.
- Actions are right-aligned and the search field remains on the left.
- Replicate availability correctly supports adding one selected cell to an existing group.
- Final check/update notifications remain owned by `App.tsx`.
- The implementation record reports targeted tests and preflight passing.
- Manual browser verification was not run.

## Follow-ups

### R1 — High: clean the branch scope

This branch already contains the complete Spec 012 sorting/filtering implementation.

**Target:** finish and merge Spec 010 first, then rebuild/rebase this branch from current `main` with only Spec 011 changes. The branch must not add `CellLibraryColumnMenu.tsx`, `libraryTableLogic.ts`, the Spec 012 tests, or the Spec 012 implementation.

### R2 — Medium: disable both split-button segments while starting

The main segment shows loading during `startSourceMaintenance.isPending`, but the chevron and **Check only** item are disabled only after the job appears as running. A second request can be started during the initial request window.

**Target:** include `startSourceMaintenance.isPending` in the disabled state of the chevron and dropdown item.

### R3 — Medium: do not disable source maintenance because search has no matches

The source button uses `allCells.length`, which is the current global-search result. With a search returning zero rows, the button is disabled even though the default action should check all active cells.

**Target:** base availability on whether the library contains source-backed cells, not on the current search result. Searching/filtering to zero visible rows must not disable the all-active action.

## Follow-up order

`R1 → R2 → R3`

## Verification

```bash
python -m unittest tests.test_source_and_replicates -v
python scripts/preflight.py
```

Manually verify narrow layout, keyboard access, the pending-request window, zero-result search, loading, and failure states.
