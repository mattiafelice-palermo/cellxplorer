# 083 — Live-search release recovery

Status: Diagnostics verified; release recovery in progress.
Branch: `codex/fix-live-search-release-gate`.

## Report and scope

Alpha.17 publication was blocked by the exact-commit Windows preflight. Native
create/rename/delete/pause/resume acceptance timed out after the initial scan
succeeded and the incremental coordinator entered recovery. The exception was
hidden by the coordinator's general recovery handler.

Identify the failing boundary, add deterministic regression coverage, fix the
cause, and publish only after canonical and signed-installer gates pass. Preserve
the original native-test deadlines, worker watchdog, recovery semantics, source
files and real user data. Do not skip tests or weaken publication checks.

## Investigation

Ten sequential native lifecycle runs pass locally. Capture only exception type,
numeric OS codes and bounded function/line frames in memory so hosted failures
identify the failing boundary without exposing exception text or source paths.

Twenty additional lifecycle runs in four parallel local suites pass. The fresh
hosted Windows preflight on `308ab1d1` (run `41491932629`) passes with indexing
behavior and all deadlines unchanged. This establishes intermittency, not the
root cause of the original failure. Retain the bounded diagnostics so a recurrence
can identify the boundary instead of replacing the original error with only a
catalog-wait timeout. No speculative indexing change is justified by these runs.

Publication still requires a successful canonical main run for the release commit
and every mandatory signed/native release gate. Alpha.17 remains unpublished;
only an unpublished tag may be moved as permitted by the release playbook.
