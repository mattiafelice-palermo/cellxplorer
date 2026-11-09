# 100 — Foreground-first startup indexing

Status: Implemented and pushed; clean-Windows preflight required before main merge.

## Report and confirmed code paths

User reports an unresponsive Alpha setup modal, analyses and import folder browser
when three tracked locations start indexing. The affected runtime is unavailable
here, so this change does not establish the entire incident's cause. Code confirms
that indexing starts in backend lifespan, before the channel setup decision; it
also confirms normal-priority scanner/watcher/header processes and synchronous
watcher spawning from configuration requests.

## Contract

Production indexing admission waits ten seconds from backend lifespan and until
the current Alpha/Beta installation has an acknowledged destination setup marker.
Stable and browser development need no native setup marker. This is a cheap destination-only check, not a library or
source-edition inspection. Unresolved marker checks are bounded to two per second.
Foreground API requests block admission; release requires one quiet second after
the last overlapping request, including exception cleanup. Known cheap status
polls do not starve indexing. The request path never waits for indexing or reads
bootstrap markers. Existing indexed results remain available.

Gate root scan/delta admission, watcher creation and full-scan header
refills. Existing lightweight watcher polling continues so heartbeat, pause and
notification-loss recovery remain correct while foreground requests run. Active headers drain with their existing deadlines; idle readers close
while foreground work is active. Admission waiting creates no source timeout or
unavailable classification. Pause, cancellation, epoch ownership, four-reader
limit, source-change checks and scientific semantics remain unchanged. Incremental
workers already in flight retain their existing bounded execution behavior.
Scanner and monitor coordinator threads plus discovery/delta/header/watcher
processes use existing below-normal Windows scheduling helpers. Configure still
updates pause/removal state immediately, but only the monitor starts watchers.
No persistent schema, UI, parser identity or real library changes are required.

## Verification

Ten focused admission regressions pass; the existing 35-test admission/live
lifecycle rerun passed after preserving immediate pause state. Canonical local
preflight passes version/type/build stages and all test modules except the
pre-existing native launcher listener owner-reporting failures on this host.
No test or deadline was suppressed. Clean-Windows verification is pending. NAS/affected
three-location responsiveness acceptance must be repeated on the affected host;
local deterministic tests alone are not that acceptance.

Final isolated rerun on the pushed code: 54 admission/header/watcher/application
lifespan tests passed (76.77 s), including all ten new admission regressions.
Local full preflight failed only the unchanged launcher test module because
listener owner information is unavailable on this host; type/build/version passed.
The GitHub connector has no workflow-dispatch tool, no GitHub CLI is available,
and the in-app browser is signed out. User action is needed to dispatch the
existing preflight workflow for `codex/indexing-foreground-priority` or provide
a signed-in browser. No main merge or installer publication was performed.
