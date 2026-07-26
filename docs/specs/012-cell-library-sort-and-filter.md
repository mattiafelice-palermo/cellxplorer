# Spec 012: Excel-style sorting and filtering for the Cell Database table

Status: **implemented**. Frontend-only.  
Depends on Spec 010’s final column set. Written 2026-07-26.

## Implementation record

Branch: `feature/cell-library-sort-and-filter`.

Added `libraryTableLogic.ts`, `CellLibraryColumnMenu.tsx`, header sort/filter menus applied before
client pagination, and selection pruning when filters hide rows.

Verification (2026-07-26):

```text
node --test frontend/tests/libraryTableLogic.test.ts
python scripts/preflight.py
```

## Acceptance checklist

- [x] Every data column except select/actions has a sort/filter menu.
- [x] Filter controls match the column data type.
- [x] Filtering and sorting occur before pagination.
- [x] Null scientific values sort last.
- [x] Active sort/filter state is visible in headers.
- [x] Global search and column filters combine correctly.
- [x] Hidden filtered-out cells are removed from selection.
- [x] No backend refetch occurs per filter keystroke.
- [x] Replicate loading/error does not produce false zero filtering.
- [ ] Keyboard, overflow, light and dark behavior (manual UI check).
- [x] Pure tests and canonical preflight pass.
