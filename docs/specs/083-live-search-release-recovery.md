# 083 — Live-search release recovery

Status: Release recovery complete; Alpha.17 published. Original intermittent cause unproven.
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

## Verified publication

Canonical main preflight on release commit `f680302f` passed all 213 committed
backend/frontend files/modules (run `41493440755`). Local no-cache preflight
passed 4/4 stages and 214 files/modules, including the unrelated local-only
protocol-converter test, which was not staged or shipped.

Only the unpublished Alpha.17 tag was moved, with its previous object SHA as an
explicit push lease. The signed release workflow `41493528372` passed, including
the mandatory native upgrade/reinstall matrix and final asset recheck, and
published Alpha `0.28.0-alpha.17` on 2026-11-02. No published version was replaced.

Independent public-download verification passed: installer SHA256
`4a6583b8996dc9c9898142fa20882ef12616dabaf948f379382de11e58688cb5`,
signature against the embedded updater public key, exact manifest version,
release notes, signature and asset identity. The public raw Alpha pointer serves
Alpha.17. Stable, Beta and channel README blob SHAs are unchanged.

This recovers publication and improves diagnostics; it does not establish or
claim a behavioral fix for the original intermittent coordinator exception.
Scientific calculations, indexing behavior, all deadlines and release gates are
unchanged. No installation or real-profile data mutation was performed locally.
