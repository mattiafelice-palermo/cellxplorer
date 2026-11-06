# 095 — Cumulative Alpha.22 release review

Status: Review and local verification complete; hosted publication pending.
Branch: `codex/release-alpha-22`.

## Scope and baseline

The user requested review of accumulated updates, an accurate changelog, push,
merge to main and a new release. Live GitHub release history identifies
`v0.28.0-alpha.17` as the latest published Alpha. Alpha.18 through Alpha.21 are
committed development checkpoints without published tags/installers. The
reviewed source tip is `b428b7f1`; all tracked work is already on main.

Publish Alpha `0.28.0-alpha.22` with cumulative notes from Alpha.17, retaining
the historical checkpoint entries and clearly identifying them as unpublished.
No application implementation changes are part of this release-preparation batch.
Leave unrelated untracked backlog, protocol-converter and temporary files out.

## Reviewed user-facing changes

- 084/089/092: verified BioLogic recording extensions, per-source reading modes,
  exploratory voltage fallback, explicit Safe-to-Permissive retry and the later
  Permissive default for new MPR selections. Warnings and read identities persist.
- 085: resume after a known header worker exits, with retryable failed metadata
  and clearer counts. The original network-share report remains unverified.
- 086/087: inline scientific presets, concurrency protection, remembered column
  widths, electrode display naming and current replacement-Cell names.
- 088: registration-owned import Recents and successful-visit Back navigation.
- 090: exact, format-scoped Neware cache equivalence, not arbitrary version reuse.
- 091–094: single dividers, live resizing, nullable data-refresh timestamps,
  About, simplified Cell tabs, a reachable scrollbar and pinned Cell actions.

Changelog claims were checked against the net production-code diff and each
specification's acceptance evidence. No claim of universal BioLogic scientific
validation, resolved private-network behavior, corrected free-text mass, or a
reproduced sample plotting lockout is included.

## Release gates

Synchronize all version declarations, validate tag and extracted release notes,
run four-worker no-cache preflight using a short disposable TEMP/TMP root and
verify available frozen private corpora without refreshing expectations. Push
the completed branch and merge; publish only after exact-main CI and mandatory
signed/native installer gates. Independently verify public installer digest,
updater signature, notes, manifest and Alpha pointer, with Stable/Beta unchanged.
Do not install the application or modify real user profiles locally.

## Review-discovered hosted CI blocker

Main CI run `42195121863` failed only the import-registration Recent-folder
assertion: Windows supplied a short `RUNNER~1` TEMP path, while production source
resolution stored the canonical long directory spelling. Capture the expected
resolved parent while it exists and keep the exact persisted-folder assertion.
No product path behavior, deadlines, scientific expectations or tests are removed.

Focused verification passes both normally and with TEMP redirected to a genuine
Windows 8.3 alias obtained through `GetShortPathNameW`; the probe confirms its
raw and resolved directory spellings differ. Both private corpora verify without
baseline updates: six sources/three chains (9, 9, 1,175 cycles) and thirteen
sources/twelve chains (including 1,867 and 207 verified-cycle chains).

Final four-worker no-cache preflight passed all four stages in 162.24 seconds:
version consistency, 222 local backend/frontend test files/modules, TypeScript
and production bundle. The count includes the unrelated untracked converter
test, which is not part of the release; hosted verification covers committed
files only. The initial unmodified local run also passed, and the corrected
assertion was then verified with the complete suite again.
