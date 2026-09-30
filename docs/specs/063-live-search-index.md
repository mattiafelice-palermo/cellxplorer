# 063 — Live search catalog and safe scheduled fallback

Status: Implemented; independent Astra review clean. Branch: `codex/live-search-index`.

Review document: [063-live-search-index-review.md](reviews/063-live-search-index-review.md).

## Scope and locked decisions

Users choose ordinary Windows folders, mapped drives or UNC roots; no IT setup, server agent,
Everything installation, administrator permission or scientific-data change is required. Add
recursive Windows directory notifications to the disposable search catalog from Spec 060.
App closed/suspended, disconnections and notification loss cannot promise perfect freshness.
Actual private NAS acceptance is deferred until the user regains access, approximately 20 days.

Healthy monitoring updates only affected paths, including filenames added/deleted/renamed and
existing source headers changed by writing. Directory moves/additions require the affected subtree
to be enumerated. No periodic full-root scan while notifications remain healthy. Initial indexing,
startup after a monitoring gap, reconnect, overflow, event queue overflow, failed event application,
changed root/content configuration and explicit refresh justify reconciliation. No file-count
shortcut or recursive directory-mtime shortcut can establish unchanged membership.

If notifications are unsupported, use scheduled background refresh while the app runs, default
every 24 hours. Existing manual/3-day/week preferences remain supported. Shorter intervals (1, 4,
12 hours) require an explicit per-location acknowledgement, validated in the backend, stating
possible network/server load and advising against frequent scans for large shared folders.
Persist settings in the existing AppSetting, not the scientific schema. Automatic jobs are jittered,
serialized and non-overlapping; outages have bounded exponential retry. Respect global automation
pause and the search indexing pause. Resume reconciles the gap.

## Safety and resource bounds

- Only the local regenerable catalog changes. Never modify source files, Cell/source registration,
  scientific caches or adopted updates. Offline/denied paths retain last-known catalog entries.
- Native network operations run outside the request thread. A blocked worker must be stoppable.
  Cap concurrent subscriptions and expose refresh-only mode if the limit is reached; one recursive
  subscription covers a root, not one subscription per descendant. No junction/symlink traversal.
- Batch and deduplicate events in a bounded queue. Only enabled formats are enriched, through the
  existing header helpers; no hashes/full cycling reads. Wait for stable size/mtime with bounded
  retry. Large folder events use a bounded, cancellable subtree worker. Unknown scope requires a
  root reconciliation; do not silently drop events.
- Attach monitoring before initial/recovery enumeration, retain events during scanning, then replay
  them. Generation/session tokens discard late obsolete worker results. Partial scans cannot prune
  unseen entries. Confirm removals against accessible parent/subtree; an outage is not a deletion.
- Monitor connection and last complete reconciliation are distinct. Never label a connected watcher
  as proof of perfect freshness. Network device capability and load remain environment-dependent.
- Because Windows excludes renaming/replacing the watched directory itself from its events, each
  isolated watcher probes only its configured root's file identity every 30 seconds. This is one
  metadata request per root, never a recursive walk. Failure or changed identity requires recovery;
  roots unable to provide stable identity use refresh-only mode.

## Interface

Reuse Settings → File search and the loader Locations panel. Per root show Monitoring connected,
Connecting/Reconnecting, Refresh-only, Paused or Disabled; show last completed reconciliation and
next scheduled/recovery refresh when applicable. Unsupported monitoring gets a concise visible
explanation of non-live results and refresh cadence. Preserve Rescan/Refresh all/manual rebuild.
Keep detailed help in hover/focus info buttons; acknowledgement is adjacent to the interval control.
Live search results invalidate on catalog revision using cheap local polls, not filesystem requests.

## Verification and completion

Use disposable catalog roots only. Required checks: native deep creation/rename/delete, subtree
addition, events during scan, queue overflow, unsupported notifications, worker timeout/reconnect,
partial traversal retention, pause/resume, schedule/jitter and acknowledgement validation. Add
focused regression tests and run canonical preflight. Browser-check existing settings/loader style,
states and interval gate. Independent Astra review loop until clean. Record native/local evidence
separately from unverified real NAS and installed WebView behavior. Commit/push then merge main;
follow repository version policy without creating a release/tag.

Completion evidence (2026-09-30): canonical `python scripts/preflight.py --no-cache` passed
all four stages, including all 184 backend/frontend test files/modules, in 183.75 seconds.
Native Windows regressions and development-browser checks passed. Actual NAS and installed
WebView acceptance remain deferred; version declarations are synchronized at `0.28.0-alpha.3`.
