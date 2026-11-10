# 105 — Scientific What’s New cards and chooser restoration

Status: Complete. Branch: `codex/whats-new-release-cards`.

## User decisions

- Restore the Alpha chooser to its pre-104 Direct actions version. Spec 104 was
  applied to the wrong surface; preserve earlier installation-aware setup safety.
  No worktrees, real-library operations, installer or release publication.
- What’s New has four cards only: cumulative quantities, equivalent full cycles,
  imported source identification and source data limitations. Omit the export and
  installation cards. Use scientific titles/descriptions, not promotional copy.
- Keep Previous visible (disabled on the first card), Next/Done and direct card
  navigation. Dismissal and setup/update gating remain intact.
- Use production graph and UI components with explicitly synthetic examples, not
  invented interface illustrations. Example links must never access real Cells.
- Preserve access to the existing bundled file-search guide/walkthrough.

## Verification

Production-handler tests for navigation, safe examples and restored setup; build,
light/dark/narrow/zoom browser acceptance and canonical preflight. Commit and push
the branch; merge only after required verification passes. Preserve unrelated files.

## Verification record

- Chooser coordinator, CSS and handler tests match `a74988d0^` byte-for-byte in
  Git's normalized comparison. Earlier setup/recovery protections remain intact.
- 17 focused production-handler/policy tests pass; production TypeScript and Vite
  build pass. Tour tests cover four cards, Previous/Next/Done/direct navigation,
  FEC axis changes, inert synthetic links, retained search guide, release-specific
  channel dismissal and setup/update/dialog gates.
- Local canonical no-cache preflight passes version/typecheck/bundle and 239 of
  240 modules/files. The sole failure is the native occupied-port ownership test
  (`tests.test_start_webapp`), reproducing the prior local-host limitation. No
  test or launcher logic was changed to accommodate it. Final exact-revision
  clean-Windows verification remains required before merge.
- Isolated production-component browser acceptance passes in light/dark, at
  390 x 844 and normal desktop width, and at 70%, 100% and 160% UI zoom.
  Previous/Next/Done, direct navigation, the FEC axis switch, inert Cell links,
  the real collapsed limitation disclosure and retained search guide work.
  The restored chooser shows its original direct actions; empty start retains
  a separate unchecked acknowledgement and disabled destructive action.
- [Clean-Windows preflight](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42777710813)
  passes all 239 modules/files and all four stages on implementation revision
  `4af67bc2` (attempt 2), including the native occupied-port test. Attempt 1
  failed only the unchanged one-shot header-reader worker test. That test also
  passed three isolated local repetitions; the identical-revision full retry
  passed without any indexer/test changes, skips or deadline modifications.
- No real-library operation, worktree, version bump or installer publication.
