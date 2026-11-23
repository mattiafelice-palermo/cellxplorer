# 114 — Alpha 0.29.0-alpha.24 release

Status: Complete; published and independently verified 2026-11-23.

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

## Release outcome

- Immutable source/peeled tag: `d73931d883b9ef8275c2efee4f9b7ce21e2c3eb0`.
  Fresh four-worker no-cache local preflight passed all 252 modules/files and
  version, type and production-bundle stages. The exact-main
  [Windows preflight 45086611574](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/45086611574)
  passed. Thirty-two focused release-card/progress tests also passed.
- The current eight-source/five-chain BioLogic corpus passed unchanged. The
  real Maccor binary/text-pair verifier passed 40,946 records, 924 executed
  steps, 184 complete cycles, both standby records, cache reload and full plots
  against export precision. Cycle 185 remained incomplete. Private originals
  and reports were not committed or uploaded.
- [Signed release workflow 45086834700](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/45086834700)
  passed packaged science/API, installer policy, mandatory candidate native
  upgrade/reinstall and final asset gates. The native coverage boundary above
  still applies; no local installation or real-profile migration was performed.
- [Alpha 0.29.0-alpha.24](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.29.0-alpha.24)
  was published as a non-draft prerelease at `2026-11-23T00:21:36Z`.
  Independently downloaded all three public assets, matched sizes/digests and
  exact release notes, validated the manifest and cryptographically verified
  the installer against the embedded updater public key. Installer SHA-256:
  `2f3c5fc027b505573f2941bf28f13312c6d0f6ad8d6fe150e7883a7268ef9e74`.
- Public raw Alpha feed bytes match the release manifest. Feed branch advanced
  from `cfa85d472f0b6dd9c3cb8d3363a4f4bf0d99296c` to
  `a018275f3a3fb182fc0717855765864820b234c3`; README, Stable and Beta blobs
  are unchanged. The published tag was not moved.
