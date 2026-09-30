# 061 — Activity Center analysis updates review

Reviewed the working tree on `codex/activity-center-updates` on 2026-09-30 against
Spec 061 and the visual style guide. This is an independent code review; browser
acceptance and full preflight remain with the implementing agent. No implementation
files were edited or full preflight run by this reviewer.

## Findings

### P2 — Completed large queues can remain Refreshing indefinitely

`backend/app/services/cache_maintenance.py:749-756` treats every missing job item as
queued. The existing `_job_items` deliberately retains only `tasks[:200]`, while
`_tasks` contains the entire queue. `background_jobs.record_result` updates an
existing detail row only, so tasks beyond that cap never acquire a status here.
After all work completes, analyses with those tasks still appear Refreshing.

Track compact completion/current status independently of the capped Processing
detail rows, preserving the cap. Add a regression with more than 200 tasks that
finishes the queue and confirms terminal analysis readiness, including a failure
beyond the detail cap.

### P2 — Detached updated sources are reported as available

`backend/app/services/analysis_updates.py:82-103` queries current states by Cell but
does not compare the recorded `changes[].source_id` with current source membership.
After an updated continuation is detached, a Cell with its original parsed source
still present passes every check and is labeled Ready. The tooltip claims the
updated data is available, although the data associated with this notice is gone.
The existing Changed since update state currently catches only a removed Cell or
an entirely empty chain.

Bulk-read current Cell/source membership and compare recorded source identities
before declaring readiness. Preserve all attached source IDs when a continuation
operation attaches multiple files (the current producer passes only the final ID).
Add a regression that detaches the updated continuation while retaining a parsed
original source and expects Changed since update.

### P2 — Skipped work is incorrectly described as preparation on demand

`backend/app/services/cache_maintenance.py:757-758` maps all skipped items to
`on_demand`, whose UI tooltip promises preparation when opened. Existing skipped
outcomes include a plot already prepared in the foreground (`foreground_ready`),
a superseded task (`next_task`), and unavailable scientific capability (`complete`,
including persisted `disposition="unavailable"`). None of those establishes an
on-demand disposition. Older failed/skipped generations also remain in `_tasks`
when a newer generation is appended to a live queue, and can override its success.

Reduce current status by plot and current generation using explicit completion
dispositions. Report foreground-prepared plots as ready, ignore superseded work,
and describe unavailable work honestly. Add cases for foreground completion,
superseded generation followed by successful replacement, and unavailable plots.

## Other observations

Producer-owned UUID batching, source-cycle delta deduplication, UTC serialization,
snapshot titles for removed analyses, bounded relational polling, default Updates,
and guarded analysis navigation follow the intended approach. The new surface
uses established Mantine components and theme-safe colors; no independent browser
acceptance claim is made here. Existing eight focused tests do not cover the
three lifecycle cases above.

## Outcome

Changes requested for the three readiness findings before final acceptance.

## Follow-up review — 2026-09-30

The large-queue finding is resolved by compact task-level `activity_state`, and
the source-membership finding is resolved by persisting all attachment source IDs
and comparing them with current bulk-read membership. Latest-generation reduction
and explicit skipped/unavailable handling address the core of the third finding.
The implementing agent reports 11 focused tests and canonical preflight passing
(179 modules, all four stages), plus light/dark and 760×600 browser acceptance;
these executions were not independently repeated by this reviewer.

One P2 follow-up remains: `foreground_ready` marks pending tasks cancelled and
ready, but `next_task` unconditionally overwrites their state with superseded as
it drains them. A subsequent idle poll therefore changes a foreground-prepared
analysis from Ready to Changed since update. Preserve the ready disposition for
cancelled foreground-completed tasks and extend the regression to actually drain
the cancelled task with `next_task`. Review verdict remains changes requested
until that lifecycle edge is corrected.

## Notification follow-up review — 2026-09-30

The cancelled-task guard and regression that drains the queue resolve the remaining
foreground-readiness finding. Reviewed the user-selected header variant 4 in
`AnalysisUpdateIndicator.tsx`, `analysisUpdateNoticePolicy.ts`, App wiring and
policy tests. Database-scoped version acknowledgements, bounded storage, deduplicated
counts, timed bubble dismissal without acknowledgement, and shared query identity
follow the intended design. No scientific work is introduced by notification polling.

One P2 acknowledgement race remains in `ActivityCenter`: after closing Processing,
its tab state remains `processing`. On reopening, the effect that resets Updates
only schedules a state change; the subsequent Processing acknowledgement effect
still runs with the old tab value from that render. A failed job arriving while
the modal is closed is therefore acknowledged merely by reopening default Updates.
Reset the tab on close or otherwise gate acknowledgement on genuine Processing
activation. Verify close Processing → receive a new failed job → reopen Updates
leaves that failure unacknowledged. Verdict remains changes requested for this
specific lifecycle race; the three original readiness findings are resolved.

## Desktop notification review — 2026-09-30

Resetting the tab while closed resolves the Processing acknowledgement race.
Reviewed the independent preference storage, notification settings, native delivery
baseline, frontend bridge, and Rust command/activation path. The delivery baseline
is separate from in-app read versions; disabled and viewed batches are baselined,
first setup suppresses history, and counts avoid exposing analysis or Cell names.
The endpoint remains a relational/in-memory read and introduces no scientific
preparation on polling. Settings and the new controls follow existing Mantine
patterns. Browser and Rust test results are implementing-agent evidence; native
Windows toast appearance and activation have not been visually exercised.

### P2 — Earlier visible data toasts lose their click action

`show_analysis_update_notification` creates a new independent Windows toast for
each delivery, without a replacement tag or closing prior notifications. It also
advances a single global generation and accepts activation only when
`should_deliver_activation` matches that latest generation. When a second batch
arrives, clicking the first notification retained in Windows notification centre
silently does nothing. Each toast promises to open Activity Center, and unlike an
app-version-specific action, older data toasts still have a valid same-database
destination. Accept earlier deliveries for the same database (the frontend already
checks the active database identity), or replace prior toasts so only the actionable
notification remains. Cover activation after two same-database deliveries.

Verdict: all previous findings resolved; changes requested for this native
activation lifecycle issue. Full preflight of the latest additions remains with
the implementing agent.

## Final re-review — 2026-09-30

The native activation finding is resolved. Data-toast activation now compares
database identity without rejecting an earlier batch merely because a newer toast
was delivered. The frontend retains its active-database check. The focused Rust
guard tests cover same-database acceptance and different/empty identity rejection.
The command is registered in the Tauri invoke handler.

**Verdict: clean code review; no remaining actionable findings in the reviewed
feature and notification additions.** All findings above are resolved and retained
as review history. The implementing agent reports canonical preflight passing all
181 backend/frontend files/modules and all four stages, focused Rust tests passing, and browser
checks of settings persistence, gear navigation, default Updates reopening,
light/dark presentation, small viewport behavior and analysis navigation.

This reviewer inspected the final code and regression coverage, without rerunning
full preflight or independently repeating browser checks. Native Windows toast
appearance and actual OS click delivery remain visually untested; the code review
and Rust guard tests do not establish that end-to-end desktop acceptance.
