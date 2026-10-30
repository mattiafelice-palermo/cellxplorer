# 075 — Faster, quieter updates

Status: Complete. Merged to `main`; Alpha 0.28.0-alpha.12 published and verified.
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

## Final integration acceptance

Corrected candidate `68a973e7` passed [signed build-only rehearsal
41130041034](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41130041034),
including canonical no-cache preflight (205 hosted modules), frozen scientific
parity, 13 helper tests, 73 Rust tests, signature verification, 17 recovery cases
and all eight native install/reinstall cases. Local no-cache preflight passed
206 modules. Final independent integration review found no actionable blockers.
Native matrix: 143 seconds in this rehearsal versus 163 seconds in Alpha .11;
this does not establish a warm-cache end-to-end release speedup. Interactive UAC,
old installed updater and end-to-end recovery are outside this matrix's evidence.

## Publication acceptance

[Alpha .12](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.28.0-alpha.12)
at `edba7f66` passed [release workflow 41133559623](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41133559623),
including all eight native cases and final immutable asset recheck. Independent
public downloads passed manifest/notes checks and actual installer-byte
verification against the embedded updater public key. The public Alpha feed is
byte-identical to the release manifest; README/Stable/Beta blobs are unchanged,
and GitHub's normal latest release remains Stable. Setup was not run locally.

Installer: 84,382,738 bytes versus .11's 86,185,063 (1,802,325 bytes / 2.1% less).
Release job: 14m59s versus .11's 15m42s, a modest single-run improvement, not a
substantial or controlled speedup. Exact-SHA preflight reuse and a full Rust cache
hit were observed, but main Rust test compilation still took 2m47s. No claim of
eliminated compilation or generally faster native-matrix timing is supported.
