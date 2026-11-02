# 083 — Live-search release recovery

Status: Investigation and implementation in progress.
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
