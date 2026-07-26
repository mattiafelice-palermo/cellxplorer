# Spec 003: per-cycle capacity/energy ignores Neware's per-step counter reset

Status: **implemented** (see review section at the end). Backend-only, plus a `CALC_VERSION`
bump. Written 2026-07-25.

Scientific-correctness fix. Reported symptom: coulombic efficiency sometimes reads > 100 %
(user saw ~120 %).

## 1. The defect

Neware's capacity and energy counters **accumulate within a step and reset to zero at each step
boundary**. Real rows from cell `02161dc…`, cycle 4, at the CC→CV transition:

| record | step | status | time_s | charge_capacity_mah |
|---|---|---|---|---|
| 3047 | 15 | CC_Chg | 5842 | **2.551** |
| 3048 | **16** | CV_Chg | **0** | **0.000** |
| 3049 | 16 | CV_Chg | 1 | 0.000430 |

`calc.per_cycle` aggregated those columns with a **per-cycle maximum**:

```python
chg_cap = group_max("charge_capacity_mah")   # grouped[col].max(), grouped by cycle only
```

A maximum over a counter that restarts every step returns **only the largest single step**, not
the phase total. For that cycle the true charge is `2.551 (CC) + 0.182 (CV) = 2.733 mAh`; the
code used `2.551`.

Because CE is `discharge / charge`, and the **discharge is usually one step** (so its numerator
is right) while the **charge is often two** (CC + CV), the denominator is too small and CE is
inflated.

### Confirmed on real cached data

| Cell | Charge steps | Used | True | CE reported | CE true |
|---|---|---|---|---|---|
| `02161dc…` | 2.551 + 0.182 | 2.551 | 2.733 | 99.81 % | 93.18 % |
| `087238c…` | 51.030 + 0.330 | 51.030 | 51.359 | 98.07 % | 97.44 % |
| `1b226f9…` | **0.633 + 0.633** | 0.633 | 1.265 | **100.01 %** | 83.34 % |

A discarded fraction of ~1/6 of the charge yields exactly the reported 120 %. This is why the
bug is intermittent: a protocol written as a single combined `CCCV_Chg` step never resets
mid-charge and is unaffected.

## 2. Blast radius

All four `group_max` columns in `per_cycle`, plus everything derived from them:

- `charge_capacity_mah`, `discharge_capacity_mah` — understated
- `charge_energy_mwh`, `discharge_energy_mwh` — understated (energy counters reset identically:
  observed 0→2.184 then 0→2.212 on the two-step cell)
- `coulombic_efficiency_pct`, `energy_efficiency_pct` — ratios of wrong numbers
- `cv_charge_fraction_pct` — denominator too small, so **overstated**
- Downstream: `first_cycle_ce_pct` / `mean_ce_pct` (`analysis_engine`), retention and fade
  metrics, the Recap table, CSV/XLSX exports, portable reports, and
  `cache.capacity_totals` (which sums the per-cycle table, so it fixes itself).

## 3. Not affected — verified, do not change

- **Time.** `time_s` resets per step too, but `masked_step_time` **already** groups by
  `(cycle, step)`, takes the max, and sums — correct. `cycle_duration_h` uses wall-clock
  timestamps. No time fix is needed.
- **`_cv_charge_by_cycle`** already groups by `(cycle, step)` and sums across CV events.
- **Steps tab** (`step_blocks._sum_step_capacity`) and **Time/Capacity tab**
  (`analysis_engine._phase_capacity`) already sum per-step deltas and document the reset. Only
  `per_cycle` was left on the naive max.
- **Rate capability** and **chargeability** filter to a single `step_index` before taking a
  max, so no cross-step aggregation occurs.

## 4. The fix

Replace the per-cycle maximum with a **per-step delta summed over the cycle**, restricted to
the rows of the relevant phase:

```
charge capacity(cycle) = Σ over charge steps of ( max(col) − min(col) )
```

Use `max − min`, not `max`: if the counter resets, `min` is 0 and the result is identical; if a
file ever does *not* reset, the delta is still that step's true contribution. Correct either
way — the same rule `step_blocks._sum_step_capacity` already documents.

Requirements:

- Stay **fully vectorised** — `per_cycle`'s contract is "no per-cycle Python loop".
  `groupby(["cycle","step"]).agg(min,max)` → delta → `groupby(level="cycle").sum()`.
- **Mask by phase** using the existing `is_chg` / `is_dchg` status masks, so a Rest or an
  opposite-phase step cannot contribute.
- **Clip negatives to zero** to be safe against a non-monotonic counter.
- **Fallbacks:**
  - No `step` column → fall back to the per-cycle max (best available; only synthetic/legacy
    frames lack it).
  - No `status` column → sum over *all* steps unmasked. Verified safe: each capacity/energy
    column is phase-specific and reads exactly `0.0` outside its own phase (checked on real
    data across CC_Chg / CV_Chg / Rest / CC_DChg steps).
- Cycles with no rows for a phase keep returning `0.0`, matching current behaviour.

Also harden `_cv_charge_by_cycle`: for a dedicated (non-combined) CV step it takes
`finite.max()`, which assumes the counter starts at 0. Change to `max − min` for consistency and
robustness — identical result when the counter resets.

## 5. Cache invalidation

**Bump `CALC_VERSION`** in `backend/app/config.py` (`1.4.0` → `1.5.0`). Per-cycle results are
cached as `cycles__pv<parser>__c<calc>.parquet` and `CALC_VERSION` also feeds
`analysis_cache`. Without the bump every already-imported cell keeps serving the old wrong
numbers after the code is fixed.

## 6. Tests

Add to `tests/test_calc_and_cache.py`:

1. **The bug case** — one cycle, charge split into CC (0→2.551) and CV (0→0.182) steps that
   each restart at 0, single-step discharge 2.546. Assert charge capacity `2.733`, and CE
   ≈ 93.18 % (**not** 99.81 %).
2. **The pathological case** — charge split into two equal 0.633 steps; assert charge `1.265`
   and CE ≈ 83.34 %, i.e. no longer ≈ 100 %.
3. **Energy** — same split, assert charge energy sums instead of maxing.
4. **Single combined `CCCV_Chg` step** — unchanged behaviour (regression guard).
5. **No `step` column** — falls back to the old per-cycle max, so existing tests keep passing.

## 7. Acceptance criteria

1. For a CC+CV charge, `charge_capacity_mah` equals the sum of both steps' deltas.
2. CE for the three real cells above matches the "CE true" column, and no cycle with a
   physically normal charge/discharge pair reports > 100 % purely from step splitting.
3. Charge/discharge **energy** and `energy_efficiency_pct` are summed the same way.
4. `charge_time_h` / `discharge_time_h` are **unchanged** (they were already correct).
5. Existing `tests/` pass; `CALC_VERSION` is bumped so caches rebuild.
6. `cv_charge_fraction_pct` falls (its denominator grows) — expected, not a regression.

---

# Implementation record

Implemented 2026-07-25 in the same session as the spec.

## Changes

| File | Change |
|---|---|
| `backend/app/services/calc.py` | Replaced the four `group_max(...)` capacity/energy aggregations in `per_cycle` with a new vectorised `phase_total(col, mask)` that sums per-`(cycle, step)` `max − min` deltas over the phase's rows. Added the `chg_rows`/`dchg_rows` masks with the no-status fallback. |
| `backend/app/services/calc.py` | `_cv_charge_by_cycle`: dedicated-CV branch now uses `max − min` instead of `max` (identical when the counter resets; robust if it ever does not). |
| `backend/app/config.py` | `CALC_VERSION` `1.4.0` → `1.5.0`, with a comment explaining why caches must rebuild. |
| `tests/test_calc_and_cache.py` | New `StepResetCapacityTests` (6 cases) plus a `stepped_frame` helper. |

`phase_total` keeps `per_cycle` fully vectorised — `groupby(["cycle","step"]).agg(min,max)` →
delta → `groupby(level="cycle").sum()`, no per-cycle Python loop.

## Verification

- `python -m pytest tests/` → **287 passed**, 34 subtests. No failures, none skipped.
- `tests/test_calc_and_cache.py` → 19 passed (13 pre-existing + 6 new).
- **Against real cached data** (read-only), `per_cycle` now returns exactly the
  independently step-summed truth:

| Cell | charge before | charge after | true | CE before | CE after |
|---|---|---|---|---|---|
| `02161dc…` c4 | 2.5510 | **2.7326** | 2.7326 | 99.81 % | **93.18 %** |
| `087238c…` c2 | 51.0298 | **51.3594** | 51.3594 | 98.07 % | **97.44 %** |
| `1b226f9…` c6 | 0.6328 | **1.2653** | 1.2653 | 100.01 % | **83.34 %** |

- Existing tests whose frames have no `step` column exercise the documented fallback and pass
  unchanged, confirming the fallback preserves prior behaviour.

## Notes for whoever picks this up next

- **Caches rebuild on next use.** Old `cycles__…__c1.4.0.parquet` files remain on disk until
  cache maintenance prunes them; the app writes and reads `c1.5.0` from now on. The first open
  of each analysis will recompute (expect one slower load per cell).
- **Previously exported numbers were affected.** Any CSV/XLSX export or portable report
  generated before this fix carries the understated capacities/energies and inflated CE for
  cells whose charge spanned multiple steps. There is no automatic migration for files already
  shared outside the app.
- `cv_charge_fraction_pct` now reads **lower** than before because its denominator grew. That
  is the corrected value, not a regression.
- Time was checked and is untouched: `masked_step_time` already summed per-step maxima, and a
  regression test (`test_charge_time_is_unaffected`) now pins that.
