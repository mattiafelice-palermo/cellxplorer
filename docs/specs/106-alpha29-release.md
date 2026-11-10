# 106 — Alpha 0.29.0-alpha.1 release

Status: Complete; published and independently verified on 2026-11-10. User
authorized publication after accepting the refined What’s New design. The existing
checkout was used; no worktrees.

## Scope and boundaries

Publish the already-synchronized `0.29.0-alpha.1` declarations as
`v0.29.0-alpha.1`, from main. The previous published Alpha is
`v0.28.0-alpha.27`. Include Specs 101–103 and the approved four-card What’s New
composition from 105. The temporary 104 chooser redesign was reverted; the
previous direct-action Alpha chooser remains unchanged.

No new application implementation, dependency changes, real-library operation or
local installation is authorized by release preparation. Preserve all unrelated
untracked files. Stable and Beta release assets and feed blobs must not change.

## Required verification

- Fresh version/tag/notes validation, unchanged private corpora and canonical
  local preflight (report any local host boundary accurately).
- Exact-main clean-Windows canonical preflight; no skipped assertions or relaxed
  deadlines. Signed workflow must pass frozen/source science, NSIS/Rust policy,
  native upgrade/reinstall/isolation and final asset recheck before publication.
- Independently verify public installer/signature/notes/manifest and raw Alpha
  feed after publication. Compare non-target feed blob SHAs with the captured
  pre-release snapshot. Never rebuild or overwrite an already published tag.

## Initial evidence

- Accepted application main: `3fad047b`; exact-main preflight `42844993528`
  passed. All maintained declarations already match `0.29.0-alpha.1`; the target
  tag and release do not yet exist, so no additional version increment is needed.
- Pre-release feed branch tip: `e4694d1b`. Protected blobs: README
  `5e7251cbf9f9733b01a3a379711fa695f9994301`, Stable
  `e7185f464c1b7d00a00c2cc94a604895720f171d`, Beta
  `3f208d96f29e190f4a369726624bfaaa2674224b`.
- Updater signing-key secret is present. The password secret is absent; the
  production workflow requires the key and permits an empty password. No secret
  values were retrieved. Earlier signed Alpha publication is independently visible.
- Fresh unchanged private verification passes both corpora: 6 sources/3 chains
  and 13 sources/12 chains. No expectations were regenerated. Version, tag and
  exact-version release-note extraction checks pass.

## Publication and final verification

- Immutable release source and peeled tag: `297d4414b4760f0845ae62d3b815a04cbe1f578b`.
  Exact-main [clean-Windows preflight 42848535548](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42848535548)
  passed. Fresh local no-cache preflight passed 239 of 240 test files; the known
  local occupied-port owner assertion in `test_start_webapp` failed, without any
  assertion being skipped or weakened. The clean-Windows gate covers that test.
- [Signed release workflow 42849504151](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42849504151)
  passed frozen/source scientific parity, packaged API checks, installation
  registry/NSIS policy, mandatory native upgrade/reinstall and final asset checks.
- [Alpha 0.29.0-alpha.1](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.29.0-alpha.1)
  was published as a non-draft GitHub prerelease at `2026-11-10T16:04:35Z`.
  Its three public assets are the Alpha x64 setup, matching `.sig` and `latest.json`.
- Independently downloaded all three public assets, matched API sizes/digests,
  verified release notes against the exact changelog section, validated the
  manifest's version/product/asset URLs/signature and cryptographically verified
  the setup bytes against the unchanged embedded updater public key.
  Setup SHA-256: `971eac83bcf4935663a94e1c6538bd3b649475fa0be72c1c01efb7d0ed151991`.
- The public raw Alpha feed is byte-identical to the release manifest. The feed
  branch moved to `9ebcdba55ecda7b715c144c6c0935940bfbee867`; README, Stable and
  Beta blobs retain the pre-release hashes above. The published tag was not moved.
- No local installer was launched and no real user library was modified.
