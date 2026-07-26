# Spec 013: make preflight faster (build + test)

Status: **implemented**. Tooling only — no application code. Written 2026-07-26.

## Implementation record

Branch: `feature/build-performance`.

- Restored parallel preflight orchestration and per-module backend test runner.
- Split frontend verification into parallel `tsc -b` and `vite build` stages.
- Parallelised NDAX parity comparisons in `test_fast_neware.py`.
- Added `.preflight-cache.json` skip logic with `--no-cache` override.

Verification (2026-07-26):

```text
python -m unittest tests.test_preflight_script tests.test_check_versions_script tests.test_fast_neware -v
```

## 0. Dependency: the parallel preflight branch

> **This spec builds on work that is not on `main`.** The parallelisation commit
> (`c44d829`) was reverted on `main` by `16615ad` as follow-up **R1 of the spec 012 review** —
> because it was scope creep on the cell-library branch, **not** because it was faulty. It is
> preserved on **`feature/preflight-parallel`** (at `42e5580`), including
> `scripts/run_backend_tests.py`.
>
> Consequences:
> - On `main` today there is **no** `ThreadPoolExecutor` wave and **no** `run_backend_tests.py`;
>   preflight is serial again (~135 s).
> - **§2.1 and §2.2 assume the parallel branch.** §2.1 splits a stage so it can join the parallel
>   wave; §2.2 is only worth doing because work is distributed per module. Land
>   `feature/preflight-parallel` first, then apply this spec on top.
> - **§2.3 (skip the frontend build) is independent** and can land on `main` at any time.
>
> The timings in §1 were measured on the current tree. They are properties of `tsc`, `vite` and
> the test suite, so they hold regardless of which branch orchestrates them.

## 1. Measured baseline

All on the development machine, warm caches, nothing else running:

| Component | Time | Note |
|---|---|---|
| Backend suite, serial | **54.4 s** | 353 tests, 34 subtests |
| ↳ `test_fast_neware.py::test_sample_files_identical` | **25.4 s** | **47 % of the entire suite** |
| ↳ next slowest test | 1.3 s | `test_portable_analysis.py` |
| `npx tsc -b` (warm) | ~16 s | |
| `npx tsc -b` (cold, tsbuildinfo deleted) | ~14 s | incremental cache is **not** paying off |
| `npx vite build` | **43.3 s** | |
| ↳ same with `--minify false` | 40.7 s | minification is only ~3 s |
| ↳ same with `--minify false --target esnext` | 36.8 s | |
| Frontend stage `npm run build` (`tsc -b && vite build`) | **~58 s** | the two run **serially** |

### What this means

1. **Backend parallelism is already at its floor.** One test is 47 % of the suite, so no number
   of workers helps — the stage cannot finish faster than that single test (~25 s + overhead,
   matching the observed ~30 s).
2. **The frontend stage serialises two independent jobs.** `npm run build` is
   `tsc -b && vite build`, but Vite transpiles with esbuild and **never type-checks**. There is
   no data dependency between them.
3. **Minification is not the bottleneck.** Turning it off saves ~3 s of 43 s. The cost is Rollup
   parsing and tree-shaking ~7–9 MB of vendor code (`plotly.js-dist-min`, `xlsx`, `jspdf`,
   `html2canvas`).

## 2. Changes

### 2.1 Split the frontend stage into two parallel stages

**Where:** `scripts/preflight.py`, `build_stages()` (~line 134), which currently runs
`npm --prefix frontend run build`.

Replace that single stage with two stages that join the existing parallel wave:

- `npx --prefix frontend tsc -b` (type check)
- `npx --prefix frontend vite build` (bundle)

Both must still be reported individually so a failure names the right one. `STAGE_COUNT` is
hardcoded to `4` (~line 19) — derive it from the stage list instead of bumping the literal.

**Expected:** frontend critical path ~58 s → ~43 s.

**Risk:** none functionally — they already run in the same order-independent way. Keep
`npm run build` as-is for release builds; only preflight splits them.

### 2.2 Parallelise the NDAX parity test

**Where:** `tests/test_fast_neware.py::FastNdaxReadTests::test_sample_files_identical`.

It is a triple nested loop executed inside **one** test method:

```python
for path in found:                     # 2 sample files
    for mode in ("chg", "dchg", "auto"):
        for softcyc in (True, False):
            with self.subTest(...):
                self.compare(path, mode, softcyc)
```

That is **12 comparisons, each doing two full file parses** (original NewareNDA + fast reader) —
24 full parses, all serial, ~2.1 s each. Because the runner distributes work **per module**, the
whole 25 s lands on a single worker.

**Fix:** run the 12 combinations in a `ProcessPoolExecutor`.

- **Processes, not threads.** `fast_neware.install()` / `uninstall()` monkeypatches module
  globals; concurrent threads would race on that global state. Each process gets its own import
  state and is safe.
- The worker must be a **module-level function** taking `(path, mode, softcyc)` and returning a
  comparison result (or a failure description), so it is picklable.
- Keep the assertions in the parent: the worker returns what differed; the test asserts and
  reports per combination, preserving today's failure detail (file, mode, softcyc).
- Cap workers at `min(12, cpu_count())`, and fall back to the current serial loop when
  `cpu_count()` is 1 or the pool cannot start — this test must never become flaky.

**Expected:** 25.4 s → ~4 s, taking the backend stage from ~30 s to well under 10 s.

**Do not** weaken the test: all 12 combinations must still run and still compare full frames.
This is the exact-match guarantee for the fast reader — it is the reason the fast path is
trustworthy.

### 2.3 Skip the frontend build when nothing frontend changed

Biggest practical win for iterative work: a backend-only change should not pay 43 s of Vite.

- Hash the frontend inputs: everything under `frontend/src/**`, plus `frontend/index.html`,
  `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`,
  `frontend/tsconfig.json`, and this script's own stage definition.
- Store the hash of the last **successful** run in a cache file (e.g.
  `.preflight-cache.json` at the repo root, git-ignored).
- If the hash is unchanged **and** the previous run passed, skip both frontend stages and print
  `SKIP: frontend build (unchanged since last successful run)` — visibly, never silently.
- Always provide an override: `--no-cache` flag and/or `CELLXPLORER_PREFLIGHT_NO_CACHE=1`.
- Never skip on a failed previous run, and never skip if the cache file is missing or
  unparseable.

**Correctness rule:** it is far better to run an unnecessary build than to skip a necessary one.
When in doubt, build. Any input not in the hash list is a correctness bug — include the lockfile
and config files, not just `src/**`.

**Expected:** backend-only iterations drop to roughly the backend stage alone (~10 s with §2.2).

## 2.4 RULE — when `vite build` is required

This is **normative**, not advice. It has two jobs: it tells a human or agent whether a manual
`npx vite build` is worth running, and it **defines the hash inputs for §2.3**. The table and the
cache's input list are the same list — if they ever disagree, the cache is wrong.

### What each check actually catches

- `tsc --noEmit` — type errors across `frontend/src/**` only.
- `vite build` — everything type-checking cannot see: module resolution as Rollup performs it,
  missing or renamed static assets, `index.html` references, CSS/asset pipeline failures,
  dynamic `import()` of a path that does not exist, and plugin/config errors.
- `node --test frontend/tests/*.test.ts` — the pure-logic modules only.

### The table

| Changed path | `tsc` | **`vite build`** | `node --test` | `pytest` |
|---|:--:|:--:|:--:|:--:|
| `frontend/src/**` | ✅ | **✅** | ✅ | — |
| `frontend/index.html`, `frontend/public/**` | — | **✅** | — | — |
| `frontend/vite.config.ts` | — | **✅** | — | — |
| `frontend/tsconfig.json` | ✅ | **✅** | — | — |
| `frontend/package.json`, `package-lock.json` | ✅ | **✅** | ✅ | — |
| `frontend/tests/**` | — | **—** | ✅ | — |
| `backend/**`, `tests/**` (Python) | — | **—** | — | ✅ |
| `scripts/**` | — | **—** | — | ✅ |
| `src-tauri/**` | — | **—** | — | — |
| `docs/**`, `*.md`, `AGENTS.md` | — | **—** | — | — |

**`frontend/tests/**` genuinely does not need a build or a type-check.** `tsconfig.json` sets
`"include": ["src"]`, and `tsc --noEmit --listFiles` reports **zero** files from
`frontend/tests/` in the program. Those files are also not reachable from the Vite entry graph.
Verified, not assumed — and it is why the rule is finer than "did anything under `frontend/`
change".

`src-tauri/**` needs neither: Rust changes are validated by `cargo` / a Tauri build, which
preflight does not run.

### Binding rules

1. **A frontend build is required whenever any row marked ✅ under `vite build` changed.**
   Skipping is only permitted through the §2.3 cache, never by human judgement in the moment.
2. **The §2.3 hash must cover exactly the ✅ rows** — including `package-lock.json`,
   `vite.config.ts`, `tsconfig.json`, `index.html` and `public/**`, not just `src/**`. A path
   that requires a build but is missing from the hash is a **correctness bug**, not a tuning
   choice.
3. **When in doubt, build.** An unnecessary ~43 s build is cheap; shipping an unbuildable tree
   is not.
4. **Never skip for a release or packaging build.** The cache applies to preflight verification
   only. Any artefact that will be distributed is built unconditionally.
5. **A skip must be visible.** Print the reason; never skip silently.
6. **Adding a new frontend input adds a row here and an entry in the hash, in the same change.**

## 3. Explicitly rejected

Measured and not worth it:

- **Disabling minification** (`--minify false`): saves ~3 s and makes the verified artefact
  differ from the shipped one. Not worth the loss of parity.
- **`--target esnext`**: ~6 s, but changes output semantics versus the shipped bundle. Same
  objection, larger.
- **Externalising Plotly** (loading `plotly.js-dist-min` as a plain script instead of bundling):
  would cut the largest chunk of Rollup's work, but changes every `import Plotly` call site and
  risks the offline-desktop guarantee. Disproportionate.
- **More backend workers**: pointless until §2.2 lands; the suite is bounded by one test, not by
  worker count.

## 4. Projected result

| Scenario | Now | After |
|---|---|---|
| Full preflight (frontend changed) | ~59 s | **~45 s** (bounded by `vite build`) |
| Backend-only change | ~59 s | **~10–15 s** (frontend stages skipped) |
| Backend stage alone | ~30 s | **<10 s** |

After this, `vite build` (~43 s) is the floor for any run that touches the frontend. Going below
it means attacking the bundle itself (§3), which is not recommended now.

## 5. Acceptance

1. `python scripts/preflight.py` reports type-check and bundle as **separate** stages, and a
   failure in either names that stage.
2. `STAGE_COUNT` is derived from the stage list, not a hardcoded literal.
3. The full backend suite still passes with **353 tests / 34 subtests**, and
   `test_sample_files_identical` still performs all 12 comparisons.
4. Deliberately breaking one comparison (e.g. temporarily perturb the fast reader) still fails
   the test with the offending file, mode and softcyc named.
5. Re-running preflight with no changes skips the frontend stages and says so.
6. Touching any file under `frontend/src/`, or `package-lock.json`, or `vite.config.ts`,
   un-skips the frontend stages.
7. `--no-cache` forces a full run.
8. A previously failed run never results in a skip.

## 6. Verification

- Time `python scripts/preflight.py` before and after; record both in the implementation record.
- `python -m pytest tests/test_fast_neware.py -q --durations=5` to confirm the parity test's new
  duration.
- `python -m pytest tests/ -q` must still report 353 passed / 34 subtests.
- Verify the skip logic by: running twice (second should skip), then `touch`ing a file in
  `frontend/src/` and running again (should not skip).
