# 057 — Progressive Time/Capacity navigation warmup

Status: Implemented; automated verification and bounded browser acceptance passed.
Superseded: [Spec 058](058-reusable-time-capacity-data.md) replaces the overlapping-window sweep with reusable per-Cell arrays.
Base: `main` at `4a69ed51` (`v0.27.1-beta.1`).
Implementation branch: `feature/time-capacity-progressive-warmup`.

## User decisions

- Use the existing checkout and a normal branch; create no worktree.
- Register this spec on main before implementation.
- Prepare navigation progressively across the whole available cycle extent of an open
  Time/Capacity plot, not just the current neighbourhood.
- Ordinary mouse movement must not pause preparation. Clicks, keyboard input, scrolling,
  slider/cycle navigation, and plot/settings changes yield priority to user work.
- Preserve all published Beta functionality, scientific values, and time-reference semantics.

## Scope and design

Only the active, visible Time/Capacity view admits progressive scientific preparation.
Start after the displayed result settles and a short idle interval. Prepare the current
cycle-window width, beginning near the displayed range and eventually covering every valid
window start through the available extent. Prepare the exact production moving-preview and
settled-request identities so ordinary navigation consumes the prepared cache; do not revive
the disabled absolute-time buffered-panning experiment or change per-Cell alignment.

Use at most four speculative requests at a time, low-priority backend execution, compact responses,
and existing source/settings-sensitive cache keys. Persist successful prepared results via
the existing bounded disk result cache, without saving or modifying the analysis recipe.
Keep speculative frontend retention bounded. A saved plot can reuse valid prepared results
after reopening/restarting; eviction or source/settings changes may require preparation again.
Do not promise every range remains resident when the dataset exceeds the cache budget.

Any pointer-down/click, keyboard input, wheel/touch interaction, active slider gesture,
foreground scientific request, or plot identity change blocks new speculative admissions.
Mousemove alone does not reset idle time. An already-running backend calculation may finish;
do not falsely claim aborting HTTP cancels CPU work or launch overlapping replacements.
Resume after interaction settles. Normal navigation remains enabled throughout and populates
its existing caches. Do not repeat a finished sweep continuously or retry failures in a loop.
Pause when hidden, inactive, unsupported, empty, or Continuous mode disables cycle navigation.

Existing global saved-plot warming should likewise ignore ordinary mouse movement while
retaining explicit interaction gates. Do not expand this feature to other analysis families.

## Acceptance

1. Opening a populated Cycle-aligned Time/Capacity plot admits warming after idle without
   opening the slider. Mousemove cannot starve it.
2. Clicks anywhere, slider activity, keyboard/wheel input, and plot changes pause admission;
   foreground navigation remains authoritative and warming later resumes.
3. Deterministic coverage reaches all valid starts for the current window size, without
   duplicate sweeps, unbounded memory retention, or more than four concurrent speculative requests.
4. Prepared preview and committed ranges use identical request/cache keys to navigation.
   Reopened saved plots reuse disk results when valid; changed source/spec identities do not.
5. Continuous mode, hidden/inactive views, empty samples, and ongoing foreground loading
   cannot admit speculative work. Scientific data, alignment, and saved-plot dirty state stay unchanged.
6. Focused scheduler/request/persistence tests, canonical preflight, and a browser check of
   idle admission plus interaction pause/resume. Report any unperformed acceptance explicitly.

## Delivery

Implement and verify on the feature branch, commit and push the completed change, then merge
to main after acceptance. No version bump, tag, or release is authorized by this spec.

## Implementation and verification — 2026-09-09

### Parallel throughput follow-up

The user amended the serial requirement to parallel preparation using four workers.
Four completion-driven HTTP slots feed the existing shared backend pool, without changing
its host-dependent 2/4/6-process sizing or creating another pool. The cap survives card
unmounts and sweep changes. Completions refill immediately; a 100 ms timer only discovers
idle/gate changes. Only explicit user input and identity changes reset the 1.5 s idle clock.
Cache-only retained-family reads are identified separately from foreground queries.

Parallel route testing exposed raw-index probe contention selecting the compatibility
fallback, and an empty optional phase-array downsampling failure there. Background-only,
context-local index reads may wait at the existing consistency lock; foreground probes
remain nonblocking. The fallback preserves its deliberately omitted phase array.

A bounded golden-source benchmark used four Cells (three cloned source caches), 16 distinct
moving/settled requests, a warmed four-process pool with four distinct PID acknowledgements,
fresh result-cache directories per pass, and independent database sessions. ABBA lane order
was 1/4/4/1. Miss times: serial 2.606/3.345 s; parallel 1.613/1.735 s (median throughput
about 1.78x). Hit times: serial 1.228/1.271 s; parallel 1.118/1.034 s. Every response had
the expected hit/miss status and exact scientific digest parity. These are bounded fixture
route timings, not a real-library or installed-desktop latency guarantee.

Browser: the isolated 50-cycle Cell completed 62/62 requests; initial four admissions
arrived within 9 ms, followed by completion-driven refills (no 500 ms pacing). Changing
window width and opening diagnostics showed an explicit idle wait before the new sweep.
That sweep then completed 82/82 requests (one hit, 81 misses). Final
`python scripts/preflight.py`: **PREFLIGHT PASSED**, **4/4 stages**, all **167**
backend/frontend files/modules passed, **79.19 s**. Focused regressions cover the
shared four-slot cap, context-local background lock policy/restoration, and compact
fallback downsampling. No version, release, schema, or scientific calculation changes.

### Temporary diagnostics follow-up

User requested a separate Activity-like warmup button because progress was invisible. The
temporary `NavigationWarmupDebugButton` subscribes to a memory-only diagnostic store; the
existing sweep publishes admission reasons, completed/total request counts, in-flight range,
cache hits/misses, last response duration, and errors. No extra compute requests or database
writes are added. Percentages count completed requests (two per window), not cache residency.
Remove the button/store and diagnostic publication when debugging is finished. No release or
version bump is part of this temporary instrumentation.

Verification: browser displayed 37/62 requests, a click-induced idle wait at 51/62,
and completion at 62/62 (one cache hit, 61 misses), with readable header and modal progress.
The final preflight rerun passed 4/4 stages and all 167 modules/files in 85.86 s. An earlier
preflight run failed; that failure did not recur on the full unchanged-code rerun. The new
store test covers active-owner selection, duplicate-notification suppression, truthful error
counts, and cleanup. Synthetic browser data was isolated from the real library.

### Original implementation

- Added a finite constant-space sweep for the active Time/Capacity window width. It walks
  every valid start, producing the shared production moving/full range specifications at
  viewport width 1200, standard precision, compact responses, and background priority.
- Successful results persist in the existing budgeted disk cache, without speculative
  React Query arrays, analysis mutations, or job-token churn. A module-wide admission lock
  prevents overlapping progressive requests across card lifetimes. Failures end the sweep.
- Explicit input and foreground loading pause admissions; movement alone does not. Disabled,
  hidden/inactive, Continuous, explicit-cycle-list, and empty views do not admit work.
- Browser verification used a disposable synthetic 50-cycle Cell, not the user's database:
  idle requests began without opening the slider; moving/full requests progressed at each
  range; clicks introduced idle gaps; slider/key navigation rendered updated ranges and
  warming resumed. Changing width started a new sweep. Leaving Time/Capacity stopped it.
- The browser check exposed a range-dependent `source_data_signature` reset. Replaced it
  with the existing source-descriptor identity, added a regression, and verified subsequent
  navigation did not restart a completed sweep. A separate foreground API request returned
  `cache_status: hit` for the prepared saved configuration.
- Six focused frontend tests pass, covering finite coverage, invalid/large extents,
  explicit event selection, idle/serial admission, range-stable source identity, and exact
  request density/persistence. Backend coverage confirms background-persisted results are
  reused by transient foreground requests.
- Final `python scripts/preflight.py`: **PREFLIGHT PASSED**, **4/4 stages**, all **166**
  backend/frontend files/modules passed, **89.55 s**. No scientific/version changes.
- Browser checks were bounded functional checks, not a large-real-dataset latency benchmark
  or an installed-desktop restart/eviction endurance test. Cache residency remains budgeted.
