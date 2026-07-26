# Spec 010: Cell library columns, replicate summary, and status explanation

Status: **implemented**. Backend + migration + frontend.  
Review document: [`reviews/010-cell-library-columns-and-status-review.md`](reviews/010-cell-library-columns-and-status-review.md).  
Implement this spec before Spec 012. Written 2026-07-26.

Read this whole file before editing. For UI work, also read
`docs/agent-knowledge/visual-style-guide.md`.

## 1. Goal

Make the main Cell Database table scientifically useful and easier to interpret:

1. remove the visible **Tests** and **Files** columns;
2. add **Max specific discharge** (`mAh/g`);
3. move replicate membership into its own **Replicates** column;
4. remove replicate-name badges from below the cell name;
5. add a clickable information control beside the **Status** header explaining the badges.

This spec changes the table presentation but must preserve the existing Cell/Test/SourceFile
architecture.

## 2. Locked design decisions

### 2.1 Do not delete Tests or Files from the data model or API

`Test` means one cycling procedure associated with a cell. A test may contain an ordered sequence
of source files that are stitched into one record. The current common case is one test and one
file, so these counts are not useful in the main table.

Remove only the two visible columns from `LibraryPage.tsx`. Keep `n_tests`, `n_files`, `Test`,
`TestFile`, and all related endpoints unchanged.

### 2.2 Scientific definition of “Max specific discharge”

The displayed value is:

```text
maximum per-cycle discharge capacity [mAh]
------------------------------------------------
effective active mass [g]
```

Equivalent implementation using mass in mg:

```text
max_specific_discharge_capacity_mah_g =
    max_discharge_capacity_mah * 1000 / effective_active_mass_mg
```

Rules:

- `max_discharge_capacity_mah` is the maximum finite value of the existing per-cycle
  `discharge_capacity_mah` column.
- It is **not** total discharge capacity divided by mass.
- For cells with more than one source file, take the maximum per-cycle value across all files;
  do not sum file maxima.
- Use the existing effective active-mass precedence returned by
  `scientific_metadata.active_mass_mg.effective_value`:
  override → legacy metadata → source header.
- Return/display `null` when:
  - no finite per-cycle discharge capacity exists;
  - the source summary is pending or failed;
  - effective active mass is missing, non-finite, or `<= 0`.
- Display with one decimal place and the unit `mAh/g`.
- Do not bump `CALC_VERSION`: the per-cycle calculation is unchanged. This is an additional
  persisted summary derived from the existing cycle cache.

### 2.3 Replicate count semantics

The **Replicates** value is the number of replicate groups that contain the cell.

It is not:

- the number of cells in a group;
- the number of sibling cells;
- a boolean “is replicate” flag.

A cell may belong to more than one replicate group, so counts above one are valid.

### 2.4 Status semantics stay unchanged

Do not redesign the status state machine or remove badges. The information control explains the
existing distinction:

- **Active / Complete**: user-managed cycling lifecycle.
- **Ready / Changed / Source changing / Offline / Parsing / Calculating / Summary failed**:
  source and cached-data state.

## 3. What already exists

### Frontend

`frontend/src/pages/LibraryPage.tsx` currently contains:

- `LIBRARY_CELL_TABLE_COL_WIDTHS`;
- `CapacityValue`;
- the Cell Database toolbar and table;
- visible columns:
  `Cell, Tests, Files, Cycles, Total charge, Total discharge, Status, Created, Actions`;
- `replicateGroups` query;
- `groupsByCellId`, mapping each cell id to `ReplicateGroupSummary[]`;
- replicate-name badges rendered below the cell name;
- the complete existing status-badge rendering.

`frontend/src/api.ts` defines `CellSummary`, including `n_tests`, `n_files`,
capacity totals, scientific metadata, and source-state booleans.

### Backend

`backend/app/services/cache.py`:

- `capacity_totals(cycles)` currently returns total charge and total discharge;
- `build(...)` includes those values in its return payload.

`backend/app/services/scanner.py`:

- `apply_capacity_summary(sf, info)` persists the two totals;
- `start_capacity_summary_backfill()` fills summaries for older parsed sources.

`backend/app/models.py`:

- `SourceFile.total_charge_capacity_mah`;
- `SourceFile.total_discharge_capacity_mah`;
- `SourceFile.capacity_summary_status`.

`backend/app/routers/library.py`:

- `_empty_cell_file_summary`;
- `_cell_file_summaries`, an aggregate SQL query used by `GET /api/cells`;
- `cell_capacity_totals`;
- `cell_dict`;
- `list_cells`.

The optimized list endpoint deliberately does not open Parquet files. Preserve that property.

### Migrations

The current migration head is `0001`:

- `backend/app/migrations/versions/v0001_initial.py`;
- `backend/app/migrations/registry.py`.

## 4. Backend implementation

### 4.1 Extend the persisted source summary

**Files:**

- `backend/app/services/cache.py`
- `backend/app/services/scanner.py`
- `backend/app/models.py`

Add nullable `SourceFile.max_discharge_capacity_mah`.

Extend `capacity_totals(cycles)` so it also returns:

```python
"max_discharge_capacity_mah": <finite maximum or None>
```

Implementation requirements:

- convert the column with `pd.to_numeric(..., errors="coerce")`;
- ignore NaN/non-finite values;
- return `None` if no finite value exists;
- round the persisted raw mAh value to 6 decimals, matching the totals.

Extend `scanner.apply_capacity_summary` to persist the new value before setting
`capacity_summary_status = "ready"`.

`cache.build(...)` already spreads the summary dictionary into its result. Do not add a second
calculation path.

### 4.2 Add migration `0002`

**Files:**

- new `backend/app/migrations/versions/v0002_max_discharge_summary.py`
- `backend/app/migrations/registry.py`
- `backend/app/migrations/versions/v0001_initial.py`

Migration metadata:

```python
revision = "0002"
down_revision = "0001"
description = "Add cached maximum discharge-capacity summary"
```

Upgrade behavior:

1. add nullable `FLOAT` column `max_discharge_capacity_mah` to `source_files` when absent;
2. set `capacity_summary_status = 'pending'` for rows where:
   - `parse_status = 'parsed'`, and
   - `max_discharge_capacity_mah IS NULL`.

This causes the existing non-blocking capacity-summary backfill to calculate the new field.

Also add `max_discharge_capacity_mah` through migration `0002` only. Do not modify the
released `0001` revision after it ships; fresh databases receive the column when migrations
run through `0002`.

Register `v0002_max_discharge_summary` after `v0001_initial` in `registry.py`.

Do not add downgrade support; migrations in this repository are forward-only.

### 4.3 Return the normalized value from cell endpoints

**File:** `backend/app/routers/library.py`

Extend the internal file-summary dictionaries with raw `max_discharge_capacity_mah`:

- `_empty_cell_file_summary`;
- `_cell_file_summaries` using `func.max(SourceFile.max_discharge_capacity_mah)`;
- the ORM/detail path used by `cell_dict`.

Add a small pure helper with a grep-able name such as:

```python
def max_specific_discharge_capacity(
    max_discharge_capacity_mah: float | None,
    active_mass_mg: float | None,
) -> float | None:
    ...
```

Requirements:

- reject `None`, non-finite values, and mass `<= 0`;
- calculate `max_mAh * 1000 / mass_mg`;
- round to 6 decimals.

For both `GET /api/cells` and `GET /api/cells/{id}`, return:

```json
"max_specific_discharge_capacity_mah_g": 152.345678
```

or `null`.

For `list_cells`, use the already-computed scientific metadata dictionary and its
`active_mass_mg.effective_value`; do not issue one query per cell.

Do not expose the raw source-level maximum in `CellSummary` unless it is needed internally.

## 5. Frontend API type

**File:** `frontend/src/api.ts`

Add to `CellSummary`:

```ts
max_specific_discharge_capacity_mah_g: number | null;
```

Keep `n_tests` and `n_files` in the type even though their columns are removed.

## 6. Table redesign

**File:** `frontend/src/pages/LibraryPage.tsx`

The final visible order is:

1. selection checkbox;
2. **Cell**;
3. **Replicates**;
4. **Cycles**;
5. **Max specific discharge**;
6. **Total charge**;
7. **Total discharge**;
8. **Status** + information control;
9. **Created**;
10. **Actions**.

### 6.1 Remove Tests and Files columns

Remove their `<col>`, `<Table.Th>`, and `<Table.Td>` elements.

Do not remove their API fields or backend calculations.

### 6.2 Cell column

Keep:

- cell name;
- optional description;
- `CellHoverCard`.

Remove the replicate-group badges currently rendered below the description.

Long names and descriptions must still truncate without expanding the row.

### 6.3 Replicates column

Reuse `groupsByCellId`.

While `replicateGroups` is loading, render a dimmed `…`, not an incorrect temporary `0`.

On query failure, render `Unavailable` in red with a tooltip
`"Replicate membership could not be loaded."`.

When the loaded count is zero:

- show plain dimmed `0`;
- no hover card.

When the count is above zero:

- render the count as a keyboard-focusable `UnstyledButton`;
- use dotted underline, matching summary hover targets in
  `AnalysisDatabaseTable.tsx`;
- open a Mantine `HoverCard`, `withinPortal`, approximately 300–340 px wide;
- heading: `Replicate groups`;
- list every group name, one per row;
- read-only: clicking a name does not navigate or mutate anything;
- apply truncation and expose the full name with `title` or tooltip.

The hover target must work by pointer and keyboard focus.

### 6.4 Max specific discharge column

Create a display helper similar to `CapacityValue`, but with unit `mAh/g`.

States:

- value available → `123.4 mAh/g`;
- summary pending → dimmed italic `Calculating...` with the existing summary tooltip;
- summary failed → red `Unavailable` with the existing failure tooltip;
- summary ready but mass/value missing → `—` with tooltip:
  `"Add a valid active mass to calculate specific discharge capacity."`

Do not calculate the value again in the frontend.

### 6.5 Status information control

Add `IconInfoCircle` beside the `Status` text in the same header cell.

Use:

- `ActionIcon`, compact/subtle/gray;
- `aria-label="Explain cell statuses"`;
- a click-open Mantine `Popover`, `withinPortal`, about 360 px wide;
- semantic theme tokens; no hardcoded light-only background.

Locked copy:

**Title:** `Cell statuses`

**Body:**

- `Active / Complete — whether the cell is still expected to receive new cycling data. Completed cells are skipped by normal source checks.`
- `Ready — cached cycling data are available and the source has no detected change.`
- `Changed — the source file differs from the registered version and can be updated.`
- `Source changing — the file still appears to be written; updating is deferred.`
- `Offline — the registered source path cannot be reached.`
- `Parsing / Calculating / Summary failed — current state of preparing the cached cycling summary.`

Use short stacked rows or a compact definition list. Do not use a tooltip containing the whole
paragraph; the explanation must remain open long enough to read.

### 6.6 Geometry

Update `LIBRARY_CELL_TABLE_COL_WIDTHS` for the new column set.

Guidance, not exact pixels:

- Cell remains the flexible/widest column.
- Replicates: about 90–105 px.
- Cycles: about 70–80 px.
- Max specific discharge: about 145–165 px.
- Status must still fit two badges without clipping.
- Numeric values and headers should be right-aligned.
- The table may scroll horizontally at narrow widths; do not compress scientific headers into
  unreadable text.

Preserve light/dark behavior and selected-row styling.

## 7. Tests

### Backend tests

Update or add tests in:

- `tests/test_calc_and_cache.py`
- `tests/test_source_and_replicates.py`
- `tests/test_database_migrations.py`

Required cases:

1. `capacity_totals` returns the finite maximum discharge value.
2. NaN/non-numeric discharge values are ignored.
3. no valid discharge values returns `None`.
4. list-cell response calculates `mAh/g` using source active mass.
5. active-mass override takes precedence over source mass.
6. missing/zero mass returns `null`.
7. more than one file uses the maximum raw discharge, not the sum.
8. pending/error source summary returns `null`.
9. migration 0002 adds the column.
10. migration marks previously parsed rows pending so backfill can run.
11. a fresh baseline schema contains the new column.

### Frontend verification

No new browser-test framework is required. The implementation must pass TypeScript and production
build verification. Inspect manually:

- zero, one, and multiple replicate groups;
- long replicate names;
- loading/error states;
- missing active mass;
- summary pending/error;
- status popover in light and dark mode;
- keyboard focus on replicate count and status information button.

## 8. Out of scope

- deleting `Test`/`TestFile` or changing import architecture;
- changing the meaning of Active/Complete;
- new editable replicate workflows;
- a separate Cycling status and Data status column;
- sort/filter menus (Spec 012);
- column resizing or visibility controls;
- a `CALC_VERSION` bump.

## 9. Implementation order

1. cache summary helper and tests;
2. model + migration + migration tests;
3. scanner persistence/backfill;
4. library API aggregate and normalization tests;
5. frontend API type;
6. table columns and formatting;
7. replicate hover card;
8. status popover;
9. README spec index entry.

## 10. Verification

Run:

```bash
python -m unittest tests.test_calc_and_cache tests.test_source_and_replicates tests.test_database_migrations -v
python scripts/preflight.py
```

## 11. Acceptance checklist

- [x] Tests and Files no longer appear in the Cell Database table.
- [x] Their backend/API fields remain intact.
- [x] Max specific discharge is based on maximum per-cycle discharge capacity.
- [x] Effective active mass and unit conversion are correct.
- [x] The list endpoint does not open Parquet files per row.
- [x] Existing databases migrate and backfill.
- [x] Replicates shows group count, with names on hover/focus.
- [x] Replicate badges are removed from the Cell column.
- [x] Status information is readable by click and keyboard.
- [ ] Loading, error, null, long-text, light-mode and dark-mode states are handled (manual UI check).
- [x] Targeted tests and canonical preflight pass.

## 12. Implementation record

Branch: `feature/cell-library-columns-and-status`.

Added persisted `SourceFile.max_discharge_capacity_mah`, migration `0002`, library API field
`max_specific_discharge_capacity_mah_g`, and Cell Database table updates in `LibraryPage.tsx`.

Verification (2026-07-26):

```text
python -m unittest tests.test_calc_and_cache tests.test_source_and_replicates tests.test_database_migrations -v  → OK
python scripts/preflight.py  → PREFLIGHT PASSED (4/4 stages)
```

Manual UI verification (§7) not yet run in a live session.

## 13. Review of the implementation — follow-up tasks

Review branch: `feature/cell-library-columns-and-status`.  
Status after follow-ups: **addressed in working tree** (2026-07-26).

| Task | Priority | Status |
|---|---|---|
| R1 — unfiltered replicate data for cell membership | High | Done |
| R2 — reject non-finite scientific values | High | Done |
| R3 — restore migration `0001` | Medium | Done |
| R4 — keyboard-accessible replicate details | Medium | Done |
| R5 — show calculation state while parsing | Medium | Done |

Verification after follow-ups:

```text
python -m unittest tests.test_calc_and_cache tests.test_source_and_replicates tests.test_database_migrations -v
python scripts/preflight.py
```
