# Review 010: Cell library columns and status

Spec: `010-cell-library-columns-and-status.md`  
Branch: `feature/cell-library-columns-and-status`  
Status: **follow-up changes required before merge**

## What was verified

Code review confirmed that:

- Tests and Files were removed only from the visible table.
- Maximum specific discharge uses the maximum per-cycle discharge capacity.
- Multiple source files use the maximum value, not the sum.
- Effective active-mass precedence and the `mAh/g` conversion are correct.
- The value is persisted and the Cell Database does not read Parquet files per row.
- Migration `0002`, scanner persistence, API output, table columns, replicate count and status help were implemented.
- The implementation record reports targeted tests and full preflight passing.

Manual browser verification was not performed.

## Follow-up tasks

### R1 — High: use unfiltered replicate data for cell membership

**File:** `frontend/src/pages/LibraryPage.tsx`

**Current:** `groupsByCellId` is built from the replicate query filtered by `replicateSearch`. Searching the Replicate Database therefore changes counts and hover content in the Cell Database.

**Target:** keep an unfiltered replicate-group query for canonical membership and a filtered query only for the Replicate Database table.

**Acceptance:**

- Cell replicate counts never change when `Search replicates` changes.
- Add-to-replicate options and removal-impact checks use all groups.
- Hidden groups are not omitted from membership or warnings.

### R2 — High: reject non-finite scientific values

**Files:**

- `backend/app/services/cache.py`
- `backend/app/routers/library.py`
- related tests

**Current:** `+inf` can become the cached maximum, and infinite active mass can produce `0.0 mAh/g`.

**Target:** use finite-value checks for discharge capacities and active mass.

**Acceptance:**

- `[1.0, +inf, 3.0]` gives `3.0`.
- only NaN/infinite/invalid values gives `None`.
- infinite or non-positive mass gives `null`.
- focused regression tests are added.

### R3 — Medium: restore migration `0001`

**Files:**

- `backend/app/migrations/versions/v0001_initial.py`
- Spec 010

**Current:** the released `0001` migration was edited to include the new column.

**Target:** revert `0001`; keep the schema change entirely in migration `0002`. Correct the instruction in Spec 010.

**Acceptance:**

- `v0001_initial.py` matches `main`.
- fresh databases still contain the new column.
- revision `0001` databases upgrade correctly through `0002`.

### R4 — Medium: make replicate details keyboard-accessible

**File:** `frontend/src/pages/LibraryPage.tsx`

**Current:** the count is focusable, but Mantine `HoverCard` is not keyboard-accessible.

**Target:** use an accessible popover or controlled interaction supporting pointer and keyboard.

**Acceptance:**

- hover works with a mouse;
- focus or Enter/Space reveals the group list;
- Escape closes it;
- appropriate ARIA state is provided.

### R5 — Medium: show calculation state while parsing

**File:** `frontend/src/pages/LibraryPage.tsx`

**Current:** parsing cells show `—` and the missing-mass tooltip because `has_summary_pending` is false until parsing completes.

**Target:** treat `has_parsing || has_summary_pending` as pending for Max specific discharge, Total charge and Total discharge.

**Acceptance:**

- parsing cells show `Calculating...`;
- missing-mass help appears only after parsing completes;
- failed and ready states remain unchanged.

## Follow-up order

`R1 → R2 → R3 → R4 → R5`

## Verification after changes

Run:

```bash
python -m unittest tests.test_calc_and_cache tests.test_source_and_replicates tests.test_database_migrations -v
python scripts/preflight.py
```

Then manually check:

- replicate search does not affect Cell Database counts;
- long replicate names;
- parsing, missing-mass and failure states;
- keyboard operation;
- light and dark mode.
