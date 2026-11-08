# 096 — Indexer spool access and clear progress

Status: Implemented; real-folder completion and browser progress verified. Full preflight is not green; do not merge.
Branch: `bugfix/indexer-spool-progress`. Base: main `2daaf2a`, application-identical
to published `v0.28.0-alpha.22`.

## Scope

Repair local IPC sharing-lock failures that abort network indexing. Keep the
45-second silence watchdog, cancellation, FIFO frame acknowledgement and partial
result retention. Use disposable process-temporary IPC outside redirected data
roots; cleanup errors do not trigger network recovery. Retry consumer locks across
polls under the unchanged watchdog; publish retries have a fixed five-second bound.

Expose discovery separately from fixed-total header checks, with a shared compact
Mantine progress bar in File search and Activity. Show excluded, pending, available
metadata and unavailable metadata counts explicitly. Cache unchanged unsupported
classification by metadata version, so a manual rescan does not reread every EIS
header. Scientific format admission and calculations remain unchanged.

Keep opt-in detailed JSONL diagnostics local, with metadata values omitted.
Private root paths, logs and verification artifacts are not committed.

## Verification

- Read architecture, state/performance, visual and change-playbook guidance, maintained
  manuals and the indexing/live-search/filter/recovery specifications before editing.
- `python -m unittest tests.test_import_search_transport tests.test_import_search_diagnostics`
  plus locked-final-frame full/delta regressions and the actual spawned scan/refresh/
  rename/offline/restart test: **20 tests passed** on Python 3.12.
- `node --test frontend/tests/importSearch.test.ts`: **4 passed**.
- Frontend type-check, production build and synchronized version checks pass.
- Canonical `python scripts/preflight.py --no-cache` was run on Python 3.14 and
  on the CI-matching Python 3.12, with a short Windows TEMP and four workers.
  Both **failed the test stage**. Python 3.14: four modules reported temporary
  cleanup/access errors (210.38 s). Python 3.12: eleven modules failed, predominantly
  WinError 145/5 cleanup errors; unchanged known-folder tests also had two redirected
  path assertions (241.38 s). The other three preflight stages passed in both runs.
  Tests and their safety assertions were not suppressed or relaxed.
- The user-authorized real network root completed: **300 candidates**, **119 ready
  metadata**, **170 excluded unsupported**, **11 unavailable headers**, **0 pending**.
  Reader errors identify empty data blocks and one invalid module boundary; format
  admission was not broadened. Representative GCPL/OCV whitelist metadata exactly
  matches fresh production header reads.
- Explicit rescans reuse the 119 ready and 170 versioned unsupported classifications,
  checking only the 11 unavailable headers. Extended final-runtime traces show one
  startup reconciliation, one explicit manual rescan and one later NAS-recovery
  scan. The watcher reported Windows error 64, failed a reconnect, then connected;
  its recovery scan completed normally. No spool access retries or worker restarts
  occurred. Real notification gaps still require reconciliation for correctness.
  Paths/logs remain local.
- Browser checks verified animated unknown-total discovery, determinate header progress
  in File search and Activity/Processing, explicit count labels, and completed state.
  Indeterminate ARIA no longer announces a false 100 percent. Dark chrome and the
  current narrow viewport were inspected; no installed WebView acceptance claimed.
- Application version is `0.28.0-alpha.23` for this branch only; no release/tag or main
  merge is authorized by this implementation record. Full preflight still needs a
  clean environment/result before integration.
