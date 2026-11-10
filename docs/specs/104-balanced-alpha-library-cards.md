# 104 — Balanced Alpha library cards

Status: Implemented; clean-Windows preflight pending. Branch: `codex/balanced-alpha-chooser`.

## Approved scope

Replace Alpha's Direct actions chooser with the user-selected Balanced cards
composition: four selectable illustrated cards, current Alpha selected initially,
short labels/descriptions and a single Continue action. This supersedes Spec 081's
Direct actions composition for Alpha only. Keep the existing 88 px illustrations,
channel tokens, responsive layout and explicit destructive confirmations.
Do not create worktrees. Spec 103 is complete and merged before this work.

## Implementation and safety

`BetaBootstrapCoordinator.tsx` retains its existing status, installation detection,
copy/reset/keep handlers, pending-stage recovery and API/native boundaries.
Only verified installed copy sources appear. Unavailable choices stay disabled;
Continue rechecks availability. Card selection never performs an operation.
Changing cards clears replacement consent. Continue opens a source-specific
replacement confirmation for existing Alpha data, or the separate acknowledged
empty-reset dialog. Beta and Stable workflows are unchanged. No real user data,
installer or release changes are authorized by this UI task.

## Verification

Production coordinator regressions: default keep, selection without writes,
explicit source replacement, consent invalidation, acknowledged empty reset,
unavailable sources, staged recovery and unchanged Beta behavior. Build/typecheck,
light/dark keyboard and responsive browser acceptance, canonical preflight;
commit/push branch then merge main once required checks pass.

## Verification record

- 22 focused setup tests and production build/typecheck pass.
- In-app browser acceptance passes in dark/light presentation, with equal-height
  desktop cards (239 x 220.72 CSS px), a two-column narrow layout, keyboard arrow
  selection, separate replacement confirmation and initially unchecked reset
  acknowledgement. No horizontal document overflow at desktop width. Preview
  used development mock state and no connected backend; no real library changed.
- Canonical no-cache preflight with four workers and short isolated temporary
  paths passed 237/238 modules plus version/typecheck/bundle stages. Only
  `test_start_webapp.test_both_selected_ports_are_released` failed because local
  Windows could not identify the disposable port owner. No gate was skipped;
  clean-Windows canonical preflight is required before merge. The first restricted
  default-temp run failed additional modules and was stopped after hanging;
  the short-path unrestricted rerun supersedes it, not a source workaround.
