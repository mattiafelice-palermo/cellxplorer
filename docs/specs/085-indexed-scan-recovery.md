# 085 — Indexed scan recovery and progress

Status: Complete; four-worker no-cache preflight passed. Branch: `codex/bio-scanner-analysis-improvements`.

## Scope

Continue a full indexed scan after an isolated worker exits during an identified
header, as already done for a stalled header. Retain a retryable unavailable
state for that file, clear stale metadata, notify observers, and inspect later
files. Do not guess a failed identity when the worker exits before a header is
announced. Display the file count and the subset awaiting format or metadata
with consistent definitions.

The user observed unavailable BioLogic headers and repeated reading on a
network drive in Alpha.17. The affected share and files are unavailable. Do
not claim this change proves the cause or repairs that particular incident.
Verify the available thirteen-source private MPR archive through a local
spawned scan and browser, and cover worker exit and count semantics with
synthetic tests. Preserve source files and normal scanner deadlines.

## Evidence and limit

The scanner suite passed 22 tests, including an actual spawned worker exit and
continuation. The current scanner indexed all thirteen archived MPR headers
locally; the browser returned the five expected sources for a 1,400–1,500 mg
header-mass filter. A separate disposable 2,500-file synthetic scan completed
with 2,250 recognized headers, 250 deliberately invalid files classified as
unsupported, and zero pending. This is local evidence only; the original
Alpha.17 network-drive incident remains unverified.
Canonical no-cache preflight passed all four stages and 219 test files/modules.
