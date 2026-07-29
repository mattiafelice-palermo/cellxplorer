# 028 — `per_cycle` performance: CV loop and status predicates

**Status:** Implemented
**Branch:** `feature/calc-status-and-cv-vectorization`
**Scope:** backend only — `services/calc.py`, `services/analysis_engine.py`, `config.py`, tests
**Nature:** pure performance. **No output may change.**

## Why

Profiling the import pipeline on the real library (44 files, 1–767 cycles, up to 523 k rows)
put half the compute in `calc.per_cycle`, and 77 % of *that* in one function:

```
per_cycle                     0.800 s / 3 calls
  _cv_charge_by_cycle         0.614 s          <- 77 %
  phase_total (x4)            0.065 s
```

Two separable causes, both measured:

1. **`_cv_charge_by_cycle` iterates `groupby` groups in Python** (`calc.py:84`). Walking the
   groupby alone is 4.7 ms; the per-group body costs ~0.75 ms × 201 groups. It also recomputes
   `group["status"].astype(str).str.lower()` *inside* the loop when the whole column was already
   lowered once above it.
2. **Status predicates run over every row.** `status` holds **4 distinct values across 523 067
   rows**, yet `lower() + 2× str.contains` costs 59.9 ms per call. Evaluated over the distinct
   values instead: 8.2 ms — **7× — with an identical result**. `analysis_engine._phase_from_raw`
   has the same shape with *four* `str.contains` over full raw frames.

Prototype measurements on the real library (bit-identical output on 44/44 files):

| | now | after | speedup |
|---|---:|---:|---:|
| `_cv_charge_by_cycle` | — | — | 3.0–5.5× |
| `per_cycle`, all 44 files | 7.70 s | 3.56 s | **2.16×** |
| full import compute, all 44 files | 16.26 s | 12.05 s | 1.35× |

The win scales with **cycle count**, not row count — it is per-(cycle, step) group overhead.
Two row-heavy/cycle-light files (~430 k rows, ~300 cycles) gain only 1.7–1.8×.

## Locked design decisions

1. **Output must be bit-identical.** This is scientific code feeding a cache keyed by
   `CALC_VERSION`. The acceptance bar is exact equality (`atol=0`) against the current
   implementation on the golden corpus *and* on every file in a real library — not "close".
2. **`CALC_VERSION` is bumped anyway**, to 1.6.0. The outputs are identical on everything we can
   test, so the bump is precautionary: it costs one recompute and removes any chance of a cache
   entry produced by a code path an edge case reaches differently. Correctness beats the
   recompute cost.
3. **Substring semantics are preserved exactly.** `Series.str.contains` defaults to
   `regex=True`, but every needle used here (`cv_chg`, `cv charge`, `cccv`, `chg`, `charge`,
   `dchg`, `discharge`) is regex-inert, so plain `in` over lowered strings is equivalent. Any
   future needle containing a regex metacharacter would silently change meaning — the helper
   documents this.
4. **`NaN` keeps its current behaviour.** Today the column is `.astype(str)`-ed first, so a
   missing status becomes the literal `"nan"` and matches nothing. The helper applies `str()`
   per distinct value, reproducing that.
5. **The group loop stays a loop.** It is rewritten to walk *numpy slices* rather than pandas
   sub-frames. A fully vectorised plateau-detection rewrite would be faster still, but the
   per-group logic (terminal-voltage plateau, current taper, contiguous region slice) is subtle
   scientific code; keeping it line-for-line recognisable is worth more than the last few ms.
6. **`analysis_engine.py:1067` is out of scope.** It slices `.iloc[start:end]` inside a per-step
   loop — a different shape, on small slices, with no measurement showing it matters.

## Tasks

### T1 — Shared status predicate

**File:** `backend/app/services/calc.py`

```python
def status_matches(status: pd.Series, *needles: str) -> np.ndarray:
    """True where the lower-cased status contains any needle.

    Evaluated over the distinct values (typically ~4) and mapped back, instead of
    over every row.
    """
```

Implemented with `pd.factorize`, then a boolean lookup indexed by the codes.

**Acceptance:** identical to `status.astype(str).str.lower().str.contains(n)` OR-ed across
needles, for: normal values; mixed case; a column containing `NaN`; an empty frame; a
single-value column; and a value list longer than the row count is impossible so no special case
is needed.

### T2 — `_cv_charge_by_cycle` walks numpy slices

**File:** `backend/app/services/calc.py`

Same decisions in the same order. Changes only:

- the CV mask comes from `status_matches(...)` (T1);
- `cccv` is decided once for the column, not per group;
- group blocks are derived once (`factorize` on the `(cycle, step)` pair, then a stable argsort),
  and the body indexes numpy arrays instead of pandas sub-frames.

The existing ordering (`sort_values(["cycle", step, record_index, time_s])` on the full frame
before selecting CV rows) must be reproduced, including its effect on which rows land at the
plateau boundaries.

**Acceptance:** exact equality with the pre-change implementation on the golden corpus and on a
real library; the ordering fallbacks (no `step`/`step_index` column, no `record_index`/`time_s`
column) are covered by tests, because those paths are absent from the corpus.

### T3 — `_phase_from_raw` uses the shared predicate

**File:** `backend/app/services/analysis_engine.py`

Replace the four full-column `str.contains` calls with two `status_matches` calls. This runs on
full raw frames during analysis compute, so it is the same win again.

**Acceptance:** golden corpus analyses unchanged.

### T4 — `CALC_VERSION` 1.5.0 → 1.6.0

**File:** `backend/app/config.py`, with a changelog line stating the change is performance-only
and that the bump is precautionary.

### T5 — Tests

**File:** `tests/test_calc_and_cache.py` (or the module that covers `calc`)

- `status_matches` acceptance cases from T1;
- `_cv_charge_by_cycle` on a synthetic frame exercising: an explicit `CV_Chg` step, a `CCCV_Chg`
  step that does taper, a `CCCV_Chg` step that does *not* taper (must contribute nothing), a
  cycle with no CV at all, and the no-`step`-column fallback.

## Verification

- `python -m unittest tests.test_calc_and_cache tests.test_golden_analysis`
- `python scripts/preflight.py`
- Ad-hoc: re-run the real-library equality check (44 files, `atol=0`) before merging.

## Not done, and why

**Parse (now the largest remaining share of import compute, ~51 %).** Profiled on the 767-cycle
file: `read_ndax` is 90 % of parse, split between the already-vectorised record read and
**0.137 s of zip extraction (20 % of parse)**. NewareNDA extracts `data.ndc` to a temp file and
`fast_neware` mmaps it, so removing that round-trip means taking over NewareNDA's file
orchestration — which `fast_neware` deliberately does not do ("all surrounding logic remains
NewareNDA's own code, so output is identical by construction"). The remainder is zlib
decompression and dtype casts, i.e. irreducible work already running as C. Not worth the
complexity; revisit only if very large files become a complaint.
