# 105 — Scientific What’s New cards and chooser restoration

Status: In progress. Branch: `codex/whats-new-release-cards`.

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
