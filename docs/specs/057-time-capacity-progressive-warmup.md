# 057 — Progressive Time/Capacity navigation warmup

Status: Spec registered; implementation pending.
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
