# 098 — Faster Windows MPR header I/O and Alpha release

Status: Complete; browser acceptance verified and Alpha 0.28.0-alpha.25 published
on 2026-11-08. Local listener-discovery verification boundary recorded below.
Implementation branch `feature/faster-index-io`, from main `3be12835`.
Release branch: `codex/release-alpha-25`, from confirmed main `6eaa785c`.

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

## Authorized release acceptance — 2026-11-08

The user confirmed the five incoming commits and requested the usual release if
the checkout matched. Live `origin/main` was exactly `6eaa785c`, five commits ahead
of local main, with synchronized Alpha.25 declarations and no Alpha.23–25 release
tags. Local main was fast-forwarded; unrelated untracked work was preserved.
This authorization supersedes the earlier publication pause after final checks.

Fresh browser acceptance used an isolated synthetic library and the current
Alpha-styled frontend through the supported Vite proxy. The actual indexer found
six fixtures: four searchable, two excluded, three metadata-ready and one empty
MPR header unavailable, with zero pending. Settings retained `Scan complete` and
the last header-check total after the active bar disappeared. A Rescan visibly
showed unknown-total discovery; Activity/Processing retained completed header
results. Dark-mode layout and the completed counts were inspected.

The indexed picker displayed `Known source cycles` and its MPR explanation.
Seeded persisted source facts covered a parsed matching source with 20 cycles,
a stale-size/mtime source and an unimported source. A minimum of 10 with known
values only returned exactly the matching source. Including unknown values
restored all four searchable entries and displayed Unknown for stale/unimported
sources; restoring known-only again returned one. The harness suppressed unrelated
scientific backfills/source polling to keep seeded facts stable; this is UI/filter
acceptance, not a new scientific parsing or NAS benchmark. No installed WebView,
remote-machine writer, or fresh reproduction of the recorded NAS timing is claimed.

The release notes are cumulative from published Alpha.22 and use the established
New features/Bug fixes headings. No application implementation was changed during
release preparation. Final fresh preflight, corpus and signed publication results
will be recorded below.

Fresh scientific verification passes both frozen private corpora without changing
expectations (six sources/three chains and thirteen sources/twelve chains).
Local no-cache preflight passed versions, type check, bundle and every test module
except the native launcher module: its disposable listeners cannot be discovered
as listening on this host. Focused reproduction also fails. An independent native
.NET TcpListener is omitted by GetActiveTcpListeners and reported by CIM with
unknown State, despite accepting connections. No unknown-state process is treated
as safe to terminate, and no test is skipped or weakened. The original checkpoint
has a successful clean Windows canonical run `42515480515`; complete unchanged
preflight will also be run on this release branch before merging. This is a local
verification boundary, not a claimed passing local run or a proven launcher fix.

## Verified Alpha.25 publication

- Complete unchanged clean-Windows branch preflight `42521890857` passed all
  four stages and all 226 committed test files/modules in 202.15 seconds,
  including the native launcher module. This supplies the fresh full-suite
  validation unavailable on the local host; local failure is not relabeled a pass.
- The acceptance/changelog branch was pushed and fast-forwarded to main.
  Release tag `v0.28.0-alpha.25` identifies `d280ba4a`, which retains every
  application implementation file from the confirmed `6eaa785c` checkpoint.
- Exact-main canonical run `42522300811` also passed all four stages and all
  226 files/modules in 230.17 seconds, including launcher tests. No test,
  scientific expectation, production watchdog or process-ownership guard was relaxed.
- Signed release workflow `42522304760` succeeded, including registry/NSIS
  policy, mandatory native upgrade/reinstall matrix, final asset recheck,
  publication and public channel-pointer verification.
- Independently downloaded public installer SHA256:
  `905abe3bcb422cd52e1bf0b75d95d6b7b37bf0eaaae9a96890f2860245d2c96f`.
  Its updater signature verifies against the committed public key. Public
  manifest validation passes exact version, release notes, asset identity and
  signature; the raw Alpha feed serves Alpha.25.
- Stable, Beta and channel README blob SHAs are unchanged. Earlier published
  tags/installers are unchanged. No local installation, real-profile mutation,
  private-source upload or fresh NAS benchmark was performed. Owned acceptance
  servers were stopped; browser screenshots and fixtures remain untracked.
