# 061 — Activity Center analysis updates

## Approved scope

Implement the approved two-tab Activity Center mockup. **Updates** is selected on every open;
**Processing** retains job progress, counters, errors and item details. Each adopted source-data
update affecting existing analyses creates an expandable “Analyses received new data” notice.
Rows show affected analyses, unique updated Cells, known source-cycle deltas and current readiness,
and open analyses through existing guarded navigation. Scientific/cache/worker policy is unchanged.

## Ownership and invariants

- Use existing `ActivityEvent` JSON records; no persistent schema change.
- Emit only for adopted `source_update` and `continuation_attached` invalidations. Property edits,
  reorder/detach, checks without adoption, initial imports and cache builds do not generate notices.
- Source-check runs, explicit update batches and portable-report adoption each own a UUID batch
  key. Group partial successes within that batch; never group unrelated runs by timestamp.
- Direct updates and individual continuation attachments form separate notices. Record only
  analysed Cells. Existing normal activity-log events remain available in Settings.
- Counts are positive **source-cycle count deltas**, not stitched Cell totals. Omit the total
  when any affected source delta is unknown; attachments may still be preparing.
- `/api/analysis-updates` returns bounded newest-first bulk relational summaries and in-memory
  warmup state. No source/cache probes, scientific signatures, parser reads or preparation on poll.
- Ready means adopted source data is available. Refreshing/Queued describe saved-plot work;
  Preparing data/Needs attention cover unfinished/failed sources. Status describes current
  readiness. Removed analyses retain the snapshot title but cannot be opened.

## UI and acceptance

Follow the visual style guide: Mantine Tabs/Accordion/Badge, Tabler icons, compact sm/xs text,
theme-safe surfaces, bounded vertical scrolling with gutters, accessible truncated names.
Latest entry expands initially without collapsing user selection on polling. Only viewing
Processing acknowledges failed jobs. Opening Updates does not hide them.

Verify durable batch grouping, no duplicate Cell/source counts, unknown cycle counts,
dependency selection, deleted analyses and truthful status. Check both tabs, empty/loading/error
states, small viewports, scrolling, and guarded analysis navigation in the browser. Run preflight.

## Notification settings and desktop delivery

Settings → Notifications owns three independent switches: in-app data updates, Windows data
updates, and Windows app updates. All default on; the existing app-update preference retains
its saved value. Gear buttons in Activity Center and its bubble use guarded navigation directly
to that tab. Disabling notifications retains update history. Preferences are local to the
app/browser profile, like the existing application-update schedule.

Desktop data notifications use the existing notify-rust Windows bridge with no new dependency.
Clicking a toast focuses the existing window and opens Updates, scoped to the active database.
It announces available new data, not completed saved-plot preparation. Counts omit private file,
Cell and analysis names. Native delivery is once per producer batch; background polling remains
enabled while minimized. First setup baselines existing history, and disabled/actively viewed
notices do not replay as a backlog. Delivery requires a running desktop app and remains subject
to Windows notification settings. A desktop rebuild is needed for the new native command.

## Implementation record

User-selected notification variant 4 adds an outlined Activity button with an unread analysis
count and a brief, anchored bubble. Review opens Updates and acknowledges current versions;
dismissing the bubble only hides the message. It disappears after seven seconds; the badge stays
until read. Per-event version acknowledgements are bounded and scoped to the database instance,
so continued changes within a live batch become unread again. The compact relational feed polls
every five seconds outside the modal and every two seconds inside; no scientific work is started.

Branch: `codex/activity-center-updates`, from current `main` (previous fix already merged).
Review document: [061 review](reviews/061-activity-center-analysis-updates-review.md).
Status: implemented, independent Astra Medium code review clean.

Verification: canonical preflight passed all 181 backend/frontend files/modules and all four
stages; focused Windows Rust notification tests passed (3). Browser acceptance used an isolated
profile: light/dark Activity Center, narrow viewport, Processing details, default Updates reopening,
analysis navigation, header/bubble dismissal and acknowledgement, gear route, independent switch
save/reload persistence and app-update switch relocation. Native Windows toast appearance and OS
click delivery are not visually verified; they require the rebuilt desktop app.
