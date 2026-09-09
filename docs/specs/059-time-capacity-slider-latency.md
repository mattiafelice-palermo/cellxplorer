# 059 — Time/Capacity slider latency

Status: Implemented; exact-parity tests, bounded browser acceptance and preflight passed.
Branch: `feature/time-capacity-slider-latency` from `main` at `ff69d24d`.

## User request

Investigate the slider feeling slower after Spec 058 preparation, profile the end-to-end
voltage-versus-X path, and fix the identified planning, downsampling, and frontend overheads
where exact parity can be maintained. Do not change scientific meaning or navigation behaviour.
Continue the no-release scope of this optimization sequence: no version bump, tag or release.

## Constraints and acceptance

- Preserve exact plotted coordinates, selected rows/extrema/gaps, hover/source identity,
  metadata/provenance freshness, exports, visibility, time-unit and display-mode behaviour.
- Keep the last valid plot while new requests resolve. Preserve live moving previews and
  selected-range alignment; do not silently enable the old buffered-panning experiment.
- No exhaustive overlapping-window sweep, unbounded memory retention or new process pool.
- Use isolated copied Gen2C and synthetic data; never mutate real user databases/source files.
- Measure matched backend and browser phases before/after. Distinguish complete-result hits,
  reusable-array hits, misses, browser trace preparation, Plotly completion and slider admission.
  Investigate the cause of observed regression rather than assuming backend time explains it.
- Keep only proven beneficial optimizations; add regression tests and run canonical preflight.
- Browser-verify actual slider movement, final-range correctness, and unsupported paths.
- Commit/push the completed feature and merge to main under the repository workflow.

## Diagnosis and changes

Spec 058 changed what warmup means: reusable Cell arrays are prepared, not every complete
overlapping window response. A newly visited window still needs planning, downsampling,
serialization and a browser redraw. Comparing that path with the previous exhaustive sweep's
complete-result hits is not a like-for-like latency comparison.

The 50 ms pointer-idle promotion also bypassed the moving-preview request backpressure.
Sparse native pointer events triggered a full-resolution request while the moving request
was still running; resumed movement immediately superseded that full request. The baseline
browser reproduced this overlap and lost intermediate previews. Idle promotion now waits for
both the active moving request and latest pending range to settle. Held full previews, like
moving previews, are transient and do not create activity/persistence work.

Additional parity-preserving changes:

- Batch bounded NumPy extrema searches, preserving first ties, finite-value filtering,
  mandatory points, neighbours and the exact final index array.
- Reuse immutable validated single-source planning facts, bounded to 64 entries / 8 MiB,
  with a live raw/index identity probe on every request. Keep request metadata fresh.
- Use the plot-card preview state only as a session sentinel; pending pointer positions
  remain scheduler-owned. Skip the cycle/X index while experimental panning is disabled.
- Skip interactive export-only column construction. Hover/source-cycle identity remains;
  all actual data-export paths still construct full-resolution columns normally.

## Verification evidence

Matched Gen2C backend A/B: 40 sampled windows/resolutions, three interleaved repetitions,
four warmed workers, isolated copied database/cache, complete-result caches excluded.
Both variants use the same production route and worker wrapper; baseline substitutes the
pre-change sampler and disables planning memo. All 240 responses have exact scientific
digest parity. Median route: **38.01 -> 34.60 ms**; median job construction:
**10.75 -> 9.70 ms**. Route p95 **47.47 -> 49.18 ms** is noisy/non-improved; no tail-latency
or fixed end-to-end speedup claim follows from this modest median gain. Memo retained
three entries / 988,674 bytes. Local diagnostic report:
`tmp/spec059-compare-29f7tj7f/report.json` (not a shipped artifact).

Isolated live browser checks used the Gen2C analysis, 20-cycle windows, 3000-point moving /
4000-point final budgets, and matched 1600x1000 viewport. The old frontend against the same
warmed optimized backend reproduced concurrent moving/full requests for cycles 238-257
(starts 83 ms apart), followed by a competing moving request for 205-224. That reverse
sweep completed no intermediate profile before release. Optimized sweeps displayed two
intermediate windows and issued no competing idle-full request; repeated forward/reverse
sweeps reached the requested 2-21 and 272-291 endpoints. Returned trace extents correctly
reflect individual Cell availability. Browser HTTP/Plotly timings include dev/instrumentation
overhead and variable result/memory cache hits, so they are not a production speed ratio.
Capacity-axis fallback also rendered successfully with warmup explicitly paused, and the
previous-cycle button selected 271-290 through ordinary reads. User data was not changed.

- Focused backend: **54 tests passed**, 32.645 s.
- Focused navigation/query/renderer frontend: **63 tests passed**, 2.271 s.
- Canonical `python scripts/preflight.py`: **PREFLIGHT PASSED**, 4/4 stages,
  all **171 backend/frontend test files/modules** passed; **83.08 s** wall time.
  Type check and production bundle passed. Existing bundle-size/dynamic-import warnings remain.
