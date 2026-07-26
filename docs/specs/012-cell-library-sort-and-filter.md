# Spec 012: Excel-style sorting and filtering for the Cell Database table

Status: **implemented**. Frontend-only.  
Depends on Spec 010’s final column set. Written 2026-07-26.

Read this whole file before editing. For UI work, also read
`docs/agent-knowledge/visual-style-guide.md`.

## 1. Goal

Add a compact sort/filter menu to every meaningful Cell Database column.

The target is **Excel-like discoverability**, not a full spreadsheet clone:

- click a column header to open its menu;
- sort ascending or descending;
- filter with a control appropriate to the data type;
- rows update immediately;
- active sort/filter state is visible in the header.

Do not implement Sort by color, Sheet View, advanced “Text Filters”, column resizing, column hiding,
or a distinct-value checkbox list for every numeric value.

## 2. Sortable/filterable columns

Menus apply to:

- Cell
- Replicates
- Cycles
- Max specific discharge
- Total charge
- Total discharge
- Status
- Created

Do not add menus to the selection checkbox or Actions column.

## 3. Filter semantics

Filters on different columns combine with **AND**. Multiple selected status values combine with **OR**.

| Column | Control | Rules |
|---|---|---|
| Cell | text input | case-insensitive substring on name and description |
| Replicates | name text + min/max count | name matches any group; min/max inclusive; `Maximum = 0` means no groups |
| Numeric columns | min/max inputs | inclusive bounds; zero valid; null/unavailable excluded when a bound is active |
| Status | checkbox list | fixed order; OR within column; shared derivation with badges |
| Created | from/to dates | local-day boundaries, inclusive |

Until replicate membership loads successfully, replicate filters stay disabled and must not treat
every cell as having zero replicates. On replicate query failure, show a compact error and keep
replicate sort/filter disabled.

## 4. Sort semantics

One active sort at a time. Default: `{ column: "cell", direction: "asc" }`.

Finite numeric and date values sort normally. `null`, NaN, or invalid values always sort last in
both directions. Preserve original row order as the final tie-breaker.

Status primary ordering: Complete/Active first, then severity:
`summary failed > offline > changed > source changing > parsing > calculating > ready`.

Replicate sort uses group count and stays disabled until canonical replicate membership is available.

## 5. LibraryPage data flow

Processing order:

```text
backend global search result
→ column filters
→ sort
→ pagination slice
```

Session-only state: `cellSort`, `cellFilters` (not persisted).

Consequences:

- page count and footer totals describe the filtered/sorted result;
- when column filters narrow the search result, counts distinguish filtered rows from search rows;
- reset page to 1 when search, filters, sort, or page size changes;
- prune selected ids to remaining filtered rows before pagination;
- sorting alone must not clear selection;
- header select-all continues to affect the current page only.

Performance: client-side only; memoize row construction and filtered/sorted output; no backend
refetch per filter keystroke; no Parquet reads or per-row API calls.

## 6. Menu UI

`CellLibraryColumnMenu.tsx` follows the `AnalysisDatabaseTable` header-menu pattern:

- Mantine `Menu`, `closeOnItemClick={false}`, `withinPortal`;
- full-width header target with bold label and sort/filter icon;
- sort ascending, sort descending, divider, column filters, per-column Clear filter;
- `aria-label="Sort and filter <column label>"`.

## 7. Pure tests

`frontend/tests/libraryTableLogic.test.ts` covers sort/filter/status/date/replicate rules with plain
Node-compatible TypeScript and no DOM.

## 8. Out of scope

Backend/server pagination, column resizing or hiding, multiple sort keys, filter persistence, sort
by color, advanced text operators, Excel OK/Cancel staging, and changes to `AnalysisDatabaseTable.tsx`.

## 9. Implementation record

Branch: merged through `main` from `feature/cell-library-sort-and-filter`.

Added `libraryTableLogic.ts`, `CellLibraryColumnMenu.tsx`, header sort/filter menus applied before
client pagination, and selection pruning when filters hide rows.

Verification (2026-07-26):

```text
node --test frontend/tests/libraryTableLogic.test.ts
python scripts/preflight.py
```

Manual UI verification not yet run in a live session.

## 10. Review of the implementation — follow-up tasks

Review document: `012-cell-library-sort-and-filter-review.md`.  
Status after follow-ups: **addressed in working tree** (2026-07-26).

| Task | Priority | Status |
|---|---|---|
| R1 — Keep unrelated preflight parallelisation off this merge | High | addressed (`feature/preflight-parallel`) |
| R2 — Disable replicate sort until membership loads | Medium | addressed |
| R3 — Result counts reflect column filters | Medium | addressed |
| R4 — Restore concise locked-behavior sections in this spec | Low | addressed |

## 11. Acceptance checklist

- [x] Every data column except select/actions has a sort/filter menu.
- [x] Filter controls match the column data type.
- [x] Filtering and sorting occur before pagination.
- [x] Null scientific values sort last.
- [x] Active sort/filter state is visible in headers.
- [x] Global search and column filters combine correctly.
- [x] Hidden filtered-out cells are removed from selection.
- [x] No backend refetch occurs per filter keystroke.
- [x] Replicate loading/error does not produce false zero filtering or sorting.
- [ ] Keyboard, overflow, light and dark behavior (manual UI check).
- [x] Pure tests and canonical preflight pass.
