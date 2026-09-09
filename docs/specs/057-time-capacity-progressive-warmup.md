# 057 — Progressive Time/Capacity navigation warmup

Status: Implemented; automated verification and bounded browser acceptance passed.
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

Use one speculative request at a time, low-priority backend execution, compact responses,
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
   duplicate sweeps, unbounded memory retention, or concurrent speculative requests.
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
