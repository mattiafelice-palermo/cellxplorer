# 081 follow-up — stale installation records

Related specification: [081](../081-illustrated-setup-and-update-refresh.md).
Branch: `codex/ignore-stale-installation-records`.
Status: Implemented and verified; ready for merge. Not yet released.

## R1 — Ignore conclusively stale installation entries

The Alpha.16 detector treats a manufacturer-only registry default value as
unknown even when its installation directory has neither `cellxplorer.exe` nor
`uninstall.exe`. A retained Stable test registration therefore displays the
generic yellow warning on a machine whose registered editions are Beta/Alpha.

Classify a valid local installation path as absent only when both payload files
are explicitly missing. Cover manufacturer-only legacy entries and stale uninstall
records. Missing/metadata-only keys remain absent. Malformed values, inaccessible
registry/filesystem state, unexpected filesystem objects and surviving partial
installations remain unknown. Check every hive/view and retain positive installed
evidence from another view. Do not remove registry entries, modify user data,
infer installation state from library folders, or change updater scope resolution.

Acceptance: reproduce the orphaned manufacturer-entry failure with an isolated
HKCU fixture, verify red/green, cover stale uninstall entries, partial installations
and read failures, run the full native suite and canonical no-cache preflight,
commit/push the focused branch and merge to main. No new release is requested.

## Implementation and verification — 2026-10-31

- The new manufacturer-only fixture reproduced the failure before the fix:
  expected `Absent`, actual `Unknown`. It now passes. The test also combines
  four registry-view results so a stale legacy value cannot keep the edition unknown.
- Both normal uninstall registrations and legacy manufacturer defaults validate
  their local paths and check both installation payloads with error-preserving
  metadata reads. Explicit absence of both files is stale/absent; access errors,
  malformed paths/values, unexpected objects and surviving partial installations
  remain unknown. No production registry cleanup or library operation was added.
- Four new regressions cover the reproduced orphan, stale uninstall records,
  partial/malformed/denied manufacturer entries, and filesystem access errors.
  The six focused detector tests pass using unique, isolated HKCU fixture keys;
  fixture files are harmless and never executed. Existing cross-view positive
  evidence and significant-Unicode-path regressions also remain passing.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` passed 97/97 native
  tests. Canonical `python scripts/preflight.py --no-cache` passed 4/4 stages and
  all 213 local backend/frontend test files/modules in 159.92 seconds (four workers).
  As in the release verification, that local count includes an unrelated untracked
  converter test that is not part of this fix. Typecheck and production bundle pass.
- This is a native detector-only correction; no frontend surface, installer scope
  resolver, update handoff, version declaration or published release artifact changed.
  Real installation records and libraries were left untouched. The installed
  Alpha.16 binary does not acquire the fix until a subsequent build is installed.
