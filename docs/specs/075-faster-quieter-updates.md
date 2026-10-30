# 075 — Faster, quieter updates

Status: Implementation in progress.
Branch: `codex/faster-quieter-updates` (shared by all children).

## Approved scope and locked constraints

The user requested a windowless installer/restart, an audited and trimmed package,
faster release CI with unchanged test coverage, and faster installation-owned
process cleanup. Publish the next Alpha only after verification succeeds.
Differential updates and manual installer upgrade-choice redesign are deferred.

Do not weaken the signature-verified recovery protocol from 073, shutdown
authorization, scope/elevation rules, exact installation destination, process-path
ownership, protected installer ancestry, late-process detection, or failure gates.
Never operate on the user's real installation, registration or scientific data.
Use disposable test processes/directories locally; native installation remains in
the existing dedicated-account GitHub-hosted matrix.

This parent is not independently implementable. Implement children sequentially,
with a committed/pushed checkpoint per child and one final shared-branch merge.

1. [075.1 — Native installer helper](075.1-native-installer-helper.md).
2. [075.2 — Audited runtime package](075.2-audited-runtime-package.md).
3. [075.3 — CI overlap and final verification](075.3-ci-overlap-and-closure.md).

Acceptance: native helper and process fixtures pass; frozen parser/cache/report
smoke passes; clean package inventory records changes; canonical no-cache
preflight, unchanged recovery/policy suite and full hosted install matrix pass;
only then merge and publish the next exact Alpha with verified public assets/feed.
