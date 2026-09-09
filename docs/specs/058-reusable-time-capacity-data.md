# 058 — Reusable Time/Capacity data

Status: Implemented; automated verification and bounded browser acceptance passed.
Branch: `feature/reusable-time-capacity-data` from `main` at `aeed219c`.

## User decision

Replace exhaustive overlapping-window preparation with reusable per-Cell data, including
the vectorized numeric conversion validated on Gen2C. This supersedes Spec 057's exhaustive
window sweep. No version bump, tag, or release. Preserve unrelated work and real user data.

## Contract

- Initially accelerate the verified single-source, unfiltered, consecutive Time-axis,
  compact standard voltage/current path using the cell-voltage channel. Other configurations,
  full-resolution exports, and refinements retain their existing scientific paths. Unsupported
  views do not restart exhaustive window preparation.
- Prepare full-resolution sorted per-Cell cycle, canonical time, voltage/current, and source-cycle
  arrays once. Do not pre-downsample or pre-rebase to one window. Select, rebase, and use the
  unchanged production envelope downsampler at request time.
- Persistent artifacts are keyed by source/parser/layout/calculation identity, not window width,
  start, density, label, time unit, or plot id. Metadata and provenance remain request-owned.
- Atomic publication, explicit bounded per-artifact and per-process memory, immutable shared
  arrays, and the existing analysis-cache disk budget govern retention. Missing, corrupt,
  unsupported, or oversized artifacts fall back to the existing indexed path without failing
  scientific requests. Foreground requests do not build whole-source artifacts.
- Only active idle plots admit preparation. Retain explicit-input/visibility/foreground gates,
  drain admitted work safely, and update temporary diagnostics to report Cell preparation instead
  of overlapping request counts. Do not retain speculative result arrays in React Query.
- Retain existing bounded foreground result caching; stop speculative window-result persistence.
  Existing cached results are not deleted automatically.
- Vectorize JSON-safe conversions without changing rounding, NaN/null, infinity, signed-zero,
  fractional integer conversion, or large-integer behavior. No calculation meaning change.

## Acceptance and delivery

1. Reusable/ordinary parity for ranges, resolutions, time units, unequal tails, and empty windows;
   unsupported views and exports remain on existing paths.
2. Identity invalidation, corrupt/missing artifact fallback, atomic store, memory and disk bounds,
   concurrency, and cleanup behavior covered by tests.
3. Idle preparation and interaction pause/resume verified in a disposable browser analysis;
   navigation must not regenerate a finite sweep or dirty the analysis.
4. Repeat Gen2C comparison on isolated copies, including exact scientific parity and navigation
   timings. Distinguish backend timings from browser rendering and report skipped coverage.
5. Run canonical preflight, commit and push the feature, then merge to main after acceptance.

## Verification (2026-09-09)

- `python scripts/preflight.py`: **PREFLIGHT PASSED**, 4/4 stages, all 168
  backend/frontend files/modules passed, 49.84 seconds. Version remains `0.27.1-beta.1`.
  Existing large-chunk/dynamic-import bundle warnings remain non-failing.
- Nine focused backend tests cover exact ranges/density/time-unit/tail parity, identity
  changes, immutable concurrent reads, compression corruption, missing/deleted artifacts,
  failed atomic publication, disk/RAM limits, oversized admission, unsupported paths, recipe
  and provenance non-persistence, and vector conversion edge cases. Frontend policy tests
  cover normalized preparation identity, one global batch slot, input gating, and exclusions.
- Isolated copied Gen2C snapshot: production four-worker path matched exact scientific
  digests for all **544 windows**, including **1,632/1,632 reusable Cell hits**. One preparation
  took **0.203 s**, stored **2,440,730 bytes**, and retained **10,632,916 array bytes** in the
  parent process. A second preparation reused all three Cells. No speculative window-cache bytes.
- Same-run interleaved 120-request samples: reusable route median **16.52 ms**, p95 **19.15 ms**;
  already-persisted full-result hits median **7.05 ms**, p95 **15.89 ms**. These are backend route
  timings, not browser rendering. The sequential all-window ordinary run included persistence
  (median 36.71 ms) and is not a matched pure computation-speed comparison.
- Disposable synthetic browser on isolated backend: one idle preparation, range/width change
  from 31–50 to 11–50 produced foreground requests only, saved plot preparation reused the Cell
  and retained Saved/disabled Update state, foreground activity paused preparation, and Continuous
  mode reported ordinary reads without a sweep. Dark debug panel visually inspected. Browser
  timing, every unsupported UI configuration, and large-library cancellation latency were not
  exhaustively measured; admitted batches finish before the slot is released.
- Real user databases/source files were not changed. No version bump, tag, or release.
