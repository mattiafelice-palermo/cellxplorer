# 098 — Faster Windows MPR header I/O and Alpha release

Status: Implemented and verified; release publication paused by the user pending indexing/filter
acceptance. Branch `feature/faster-index-io`, from main `3be12835`.

## User-directed acceptance follow-up

The larger development scan completed all 2,659 header checks: 937 searchable,
1,722 excluded, 821 metadata ready and 116 unavailable, zero pending. A separate
read-only recheck of all unavailable sources found 115 empty VMP data blocks and
one invalid module boundary. Do not broaden format admission to hide those errors.
Keep a persistent completion message after the active progress bar disappears.

The cycle filter returned no results because all 937 searchable files had unknown
header cycle counts and the development library contained zero imported sources.
The user explicitly chose counts from imported files rather than an additional
record-counting scan. Label the field Known source cycles and explain the MPR
limitation. MPR counts must come from parsed, online, exact-size/mtime imported
sources; no plan-loop inference, source reads on queries, or continued-Cell totals.
Other formats retain their declared-header/persisted-source fallback. Keep existing
saved-search keys and unknown-value behavior. Release publication remains paused.

## Integration evidence

82 initial MPR/header/indexer focused tests passed. The actual integrated production
worker completed the original 300-file folder in 24.23 seconds, rescan 6.09 seconds,
with all original indexed metadata/classifications unchanged and monotonic progress.
A separate-process UNC writer changed size/timestamps on an owned NAS scratch file
12 times; both the held-handle and final-path fingerprints observed every change.
The scratch file/directory were removed without recursive deletion or source edits.
This is same-machine SMB validation, not a different-machine writer test.

Complete verification and publish only the feature branch while the user-requested
release pause holds. No release tag or installer is published by this tranche.

Integrate the measured buffered raw-descriptor opener and narrow Windows
size/mtime queries for header-only MPR inspection. Preserve three handle
checkpoints and the final indexer path checkpoint, four bounded readers,
metadata semantics, retries and progress. Full scientific record reads keep
their existing I/O. Use standard-library fallbacks on other platforms and
unsupported Windows APIs, without falling back through rejected reparse points.

Experiments on the authorized 300-file corpus reduced median complete indexing
from 45.39 to 20.42 seconds. All 119 ready, 170 unsupported and 11 unavailable
results matched; all explicit source-change checks remained. These are observed
cache-uncontrolled network timings, not cold-cache guarantees. Private artifacts
remain under ignored data/. No Astra review requested for this integration.

Before integration: native ABI, fallback, cleanup, timestamp/size mutation and
source-rejection tests; independent-process SMB writer control using only owned
scratch data; actual-folder metadata/progress/rescan verification; canonical
no-cache preflight. Merge and publish the next Alpha using existing signed
draft/verify/publish release workflow. Include cumulative unreleased 096–098 notes.

## Final checks for the paused integration checkpoint

Canonical Python 3.14 `python scripts/preflight.py --no-cache`, four workers,
passed **226 backend/frontend test modules and 4/4 stages**, 246.17 seconds wall
time. Versions are synchronized at unreleased `0.28.0-alpha.25`. The first full
run exposed an access-error fixture that mocked only the former opener, and a
scheduler fixture whose two-second fake stall budget was consumed by real process
startup under parallel load. The access fixture now covers both openers; scheduler
fairness uses a deterministic virtual clock while real crash/cancellation tests
remain. No production deadline or scientific assertion was relaxed.

The persistent completion message and imported-only MPR cycle-filter contract pass
policy, SQL, type and build checks. Browser visual acceptance is not claimed:
computer use could not verify the browser URL. No main merge, release tag or
installer publication is included in this checkpoint; await user acceptance.
