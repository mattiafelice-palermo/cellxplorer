# 112 — Alpha 0.29.0-alpha.14 release

Status: Release verification in progress. Authorized 2026-11-21.

Publish the completed main-line changes since published Alpha .3. Revisions
.4–.13 are untagged development checkpoints; increment the prepared .13 to .14
without changing the 0.29.0 core. Review the net change, preserve unrelated local
files, and leave the separate planned/non-implementable Spec 111 branch intact.
No virtual-cell functionality is part of this release. No local installation or
real user-profile operation is authorized or needed.

Scope: GCPL counters/units and paused loops, recorded mass choices, independent
BioLogic quantity verdicts, import eligibility/continuation previews, deferred
React input fixes, imported-Cell feedback, time origins/Days and discharge-first
analysis. Consolidate the user-facing changes in the .14 release notes.

## Verification

- The current eight-source/five-chain GCPL corpus passes unchanged, including
  late-reset and paused-loop recordings. The private three-file continued import
  recording regression passes without skips. Seventy-five focused BioLogic and
  discharge-first tests pass.
- The historical four-source CP3 baseline does not pass exact comparison:
  raw/trace hashes and warnings change because the independent-quantity update
  withholds inconsistent CP capacity instead of clipping it into a curve. Cycle
  tables remain unchanged. Expectations were not regenerated. The independent
  byte-level CP oracle passes all 115,216 records, three voltage channels,
  1,036.159015 minutes, 12 source loop boundaries and selected export checks.
- Require fresh canonical local and exact-main clean-Windows preflight, signed
  frozen-runtime/native installer gates and independent public signature/feed
  verification. Capture the pre-release channel branch and protect non-target
  blobs. Never move an already published tag.
