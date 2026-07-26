# Review 012: Cell library sorting and filtering

Branch: `feature/cell-library-sort-and-filter`  
Status: **follow-ups required before merge**

## Confirmed

- Typed filters and one-column sorting are implemented in pure frontend logic.
- Filtering and sorting occur before pagination.
- Null scientific values remain last in both sort directions.
- Status derivation is shared with table badges.
- Cell, replicate, numeric, status, and date filters follow the intended semantics.
- Selection is pruned when filters hide cells.
- Focused pure tests cover the main sorting and filtering rules.
- The implementation record reports the tests and preflight passing.
- Manual browser verification was not run.

## Follow-ups

### R1 — High: clean the branch scope

The branch contains cumulative Specs 010/011 plus unrelated preflight parallelisation work (`scripts/preflight.py`, `scripts/run_backend_tests.py`, and broad test-file edits).

**Target:** after Specs 010 and 011 are merged, rebase/rebuild this branch from current `main` with only the Spec 012 UI logic, component, tests, LibraryPage integration, spec, and index update. Move unrelated developer-tooling work to a separate reviewed branch.

### R2 — Medium: disable replicate sorting until membership is available

Replicate filter inputs are disabled during loading/error, but the two sort items remain enabled. Users can sort all rows using temporary zero memberships.

**Target:** keep the menu open so it can show loading/error information, but disable both replicate sort actions until the canonical replicate query succeeds. Do not apply a false-zero replicate sort.

### R3 — Medium: make result counts reflect column filters

Pagination uses the filtered result, but the lower label still reports `allCells.length`; the footer totals also describe the unfiltered global-search result. This can show one page while claiming many more matching rows.

**Target:** use `filteredSortedRows.length` for the pagination result count. Make footer totals describe the filtered result, or clearly distinguish filtered and pre-filter totals.

### R4 — Low: restore Spec 012 as a source-of-truth document

The committed Spec 012 contains only an implementation record and checklist; the locked filtering, sorting, loading, selection, and performance rules are absent.

**Target:** restore a concise self-contained behavior section so future review/fix agents do not depend on the original chat.

## Follow-up order

`R1 → R2 → R3 → R4`

## Verification

```bash
node --test frontend/tests/libraryTableLogic.test.ts
python scripts/preflight.py
```

Manually verify every header menu, keyboard navigation, replicate loading/error, filtered result counts, overflow, and light/dark mode.
