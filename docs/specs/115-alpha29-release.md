# 115 — Alpha 0.29.0-alpha.29 release

Status: Complete; published and independently verified 2026-11-25.

Publish the main-line changes since published Alpha .24. Revisions .25–.28 are
unpublished development checkpoints; bump the prepared .28 to .29, keeping the
0.29.0 core. Consolidate the four fixes in the .29 release notes.

Review scope: witnessed Maccor standby and same-step stop/resume records,
acquisition-break preservation in bounded previews, numeric Maccor block decoding,
shared verified cache builds, and the classic BioLogic MB control/energy layout
with evidence-bounded delayed half-cycle alignment. No new frontend features.
Preserve unrelated local files and all real user profiles. Release preparation
changes no application behavior beyond the already merged work.

## Required verification

- Fresh version/tag/notes validation, canonical local and exact-main Windows
  preflight, focused parser/cache tests and available private scientific corpora.
  Never regenerate frozen expectations to pass a release gate.
- Signed release workflow with packaged science, policy and mandatory native
  installer gates. Independently download public assets and verify signature,
  manifest, release notes and Alpha feed. Protect Stable/Beta feed blobs.
- Native CI exercises candidate /UPDATE installation in disposable Windows
  accounts. It does not prove the old installed client's launcher, interactive
  UAC behavior or full recovery handshake. Do not install locally or migrate
  a real user profile to extend that coverage.

## Initial verification

Application main `611e53a40628868ace76e0097d01c7a8ee5f248f` passed
[Windows preflight 45622270732](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/45622270732).
The read-only release-diff review found no confirmed regressions; 147 focused
parser, cache, identity and continuation tests passed with a short Windows temp
root. All existing version declarations matched .28 before release preparation.

## Scientific and local verification

- The main private BioLogic corpus passes unchanged: eight sources across five
  chains. The private three-source continued-import regression passes without
  skips. The independent CP byte/export check passes for four sources, 115,216
  rows, all three electrode channels and 12 source-evidenced loop boundaries.
- The real Maccor binary/text-pair check passes for 40,946 records, 924 executed
  steps and 184 complete cycles, including standby records and full plot/cache
  parity within export precision. Cycle 185 remains incomplete.
- The optional Spec 084 corpus does **not** pass its historical frozen baseline:
  two permissive GCPL cases already expose independently verified cycle identity
  while capacity and efficiency remain unavailable. An isolated checkout of
  published .24 and the release candidate produce exactly the same complete
  scientific snapshot, SHA-256
  `4bca0e9873a923966eaff881755ea1e895cc617ee5beaaaa25724c42cfab0721`.
  Both show the same 28 differences from those old expectations. This is
  pre-existing baseline drift, not new release behavior. No expectations were
  regenerated; private data remains local.
- The restricted-sandbox preflight cannot create directory junctions or query
  native port owners; its startup-lifespan worker also stalled and was stopped.
  Both affected native test modules pass with normal Windows permissions
  (20 tests). The complete four-worker no-cache preflight then passed with normal
  Windows permissions: all 252 backend/frontend test files/modules, version
  consistency, type checking and production build (4/4 stages; 185.48 seconds).

## Release checkpoint

Release preparation commit and annotated tag target:
`ef090a4eabc00622ebd9e7c863b18b67d140e7b0` (`v0.29.0-alpha.29`).
Its exact-main [Windows preflight 45631114396](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/45631114396)
passed, including the named Clean Windows preflight job. The signed release
[workflow 45631273322](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/45631273322)
passed, including frozen science/API checks, installation policy and the mandatory
native upgrade/reinstall gate. The native coverage boundary above remains unchanged.

## Release outcome

- [Alpha 0.29.0-alpha.29](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.29.0-alpha.29)
  was published as a non-draft prerelease at `2026-11-25T14:23:52Z`.
- Independently downloaded all three public assets, matched their sizes and
  SHA-256 digests, checked exact release notes, validated the updater manifest
  and cryptographically verified the installer against the embedded updater key.
  Installer SHA-256:
  `c82e1db9147b5677285706249a67d48985967f2d5865217bf1ad89774178c9fd`.
- Public raw Alpha feed bytes match the release manifest. The feed branch
  advanced from `a018275f3a3fb182fc0717855765864820b234c3` to
  `6a97959e7bfffb625e70bbee7adf842f79a7b60d`. README, Stable and Beta
  blobs remain unchanged. The published tag was not moved.
- No private data or frozen expectations were uploaded or modified. No local
  installation, real-profile migration or unrelated-worktree cleanup was performed.
