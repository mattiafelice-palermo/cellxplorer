# 114 — Alpha 0.29.0-alpha.24 release

Status: Release verification in progress. Authorized 2026-11-23.

Publish the main-line changes since published Alpha .16. Revisions .17–.23 are
unpublished development checkpoints; bump the prepared .23 to .24, keeping the
0.29.0 core. Consolidate the final net behavior in the .24 release notes, including
the SCap-grams default that supersedes the earlier checkpoint's manual-unit-only
workflow. Do not advertise unsupported Maccor layouts or CV interpretation.

Review scope: new Maccor readers and scientific mapping, import/search/tracking
integration, SCap metadata migration 0007, concurrent network import and
cancellation, progress presentation, default monitoring preferences and release
cards. Preserve unrelated local files and all real user profiles. Release
preparation changes no application behavior beyond the already merged work.

## Required verification

- Fresh version/tag/notes validation, canonical local and exact-main Windows
  preflight, focused Maccor/migration tests and available private BioLogic checks.
- Signed release workflow with packaged science, policy and mandatory native
  installer gates. Independently download public assets and verify signature,
  manifest, release notes and Alpha feed. Protect Stable/Beta feed blobs.
- The native CI gate exercises candidate /UPDATE installation in disposable
  Windows accounts. It does not prove the old installed client's launcher,
  interactive UAC behavior or full recovery handshake; retain the documented
  boundary in `docs/windows-packaging.md`. Do not install locally to fill it.

## Initial verification

Accepted application main is `ad9db1c3`; its clean-Windows preflight
[45085898280](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/45085898280)
passes. Thirty-four focused Maccor and migration tests pass. The private
three-source continued-import regression passes without skips. No private
expectations were regenerated.
