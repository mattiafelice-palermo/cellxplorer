# Review: Build performance

Branch: `feature/build-performance`  
Covers: Specs 013 and 014  
Status: **addressed in working tree** (2026-07-26)

## Confirmed

- Preflight separates frontend type-checking and Vite bundling and runs independent stages in parallel.
- Stage count is derived dynamically.
- The frontend cache is visible, records only successful runs, and supports `--no-cache`.
- Backend tests are distributed by module.
- NDAX parity still compares every file/mode/software-cycle combination.
- Plotly runtime parity and incremental TypeScript configuration are implemented.
- Targeted unit tests are reported as passing.

## Follow-ups

### R1 — High: clean the branch or use the correct stacked base

The branch is ten commits ahead of `main` and contains Specs 010–012 and Cell Library application changes in addition to build tooling.

**Target:** either:

- open this as a stacked PR with `feature/cell-library-sort-and-filter` as its base; or
- after earlier features merge, rebuild/cherry-pick only the three build-performance commits onto current `main`.

Do not open the current cumulative branch directly against `main` as a standalone build-performance PR.

### R2 — High: restore real per-module test-data isolation

`scripts/run_backend_tests.py` gives every test module a separate `CELLXPLORER_DATA` directory. However, test modules such as `tests/test_activity_log.py` overwrite that environment variable with the shared repository `.test-cellplorer` path.

Parallel modules can therefore read and write the same local data despite the runner claiming isolation.

**Target:**

- change test setup assignments to `os.environ.setdefault(...)`, preserving the unique path supplied by the runner;
- check all backend test modules, not only one file;
- add a focused runner test proving that two modules receive different data paths.

### R3 — Medium: prevent nested parallelism from oversubscribing the machine

Preflight can run:

- up to 16 backend module subprocesses;
- up to 12 additional NDAX worker processes inside one module;
- TypeScript and Vite concurrently.

This can substantially exceed the CPU count and cause memory pressure or make preflight slower.

**Target:** establish one bounded worker policy. For example, reduce the inner NDAX pool when the module runner is already parallel, or run `test_fast_neware` separately with an explicit worker budget.

**Acceptance:** the maximum CPU-heavy child-process count is bounded and configurable, and timings are measured on the normal development machine.

### R4 — Medium: include the installed frontend toolchain in the cache identity

The skip hash covers source/configuration and `package-lock.json`, but not the actual installed dependency state or Node toolchain. A changed or stale `node_modules` tree can therefore reuse a previous successful cache entry.

**Target:** include at least:

- `frontend/node_modules/.package-lock.json` when present;
- Node version;
- installed TypeScript and Vite versions.

When any of these changes, type-check and bundle stages must run.

### R5 — Medium: complete the NDAX serial fallback

The process-pool code falls back only for `OSError` and `PermissionError`. Pool startup can also fail through `BrokenProcessPool` or `RuntimeError`, which currently aborts instead of using the required serial path.

**Target:** catch pool-infrastructure failures specifically and rerun serially. Do not swallow genuine comparison or parsing failures.

### R6 — Medium: record the required end-to-end verification

The implementation records show targeted unit tests, but not the full acceptance evidence required by the specs.

Before merge, record:

```bash
python scripts/preflight.py --no-cache
python scripts/preflight.py
python -m pytest tests/test_fast_neware.py -q --durations=5
python -m pytest tests/ -q
```

Also verify:

- touching a frontend input disables the skip;
- a failed run never enables the skip;
- Plotly mismatch, missing asset, unparseable header, and absent `node_modules` behave as specified;
- before/after timings are recorded.

## Follow-up order

`R1 → R2 → R3 → R4 → R5 → R6`

## Follow-up status (2026-07-26)

| Task | Status |
|---|---|
| R1 — stacked base / cherry-pick onto current `main` | Documented: merge library specs first or open stacked PR |
| R2 — `setdefault` for `CELLXPLORER_DATA` + runner isolation test | Addressed |
| R3 — bounded worker policy for nested parallelism | Addressed |
| R4 — toolchain inputs in frontend cache hash | Addressed |
| R5 — NDAX pool infrastructure fallback | Addressed |
| R6 — end-to-end verification record | Addressed in Spec 013 record |
