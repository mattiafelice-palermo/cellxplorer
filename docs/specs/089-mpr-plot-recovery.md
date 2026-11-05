# 089 — Accessible MPR plotting recovery

Status: Complete; browser acceptance, Astra Medium review and canonical preflight passed.
Branch: `codex/mpr-plot-recovery`.
Review document: [089 review](reviews/089-mpr-plot-recovery-review.md).

## Request and scope

Make the four supplied exploratory MPR cases accessible from the latest local
Alpha.21 checkout, retaining table resizing and subsequent features. Their
structural reader and permissive plotting support already exist under Spec 084;
Safe mode intentionally declines their unresolved scientific interpretation.

## Behavior

Offer an explicit Try Permissive action beside rejected MPR files in both the
folder browser and indexed search, and explain recovery beside the Safe error.
Open the preview and switch only that source's mode. Update mode state
synchronously; preserve mode/version rejection facts and other staged sources. Keep registration,
offline, structural decoding and actual permissive rejection gates. Label the
chosen mode in the list. Do not change default Safe interpretation or fabricate
capacity, CE or cycles. No real user database, app installation or release work.

## Acceptance

Exercise actual result handlers and mode-aware selection/inspection, then use
a disposable browser profile to recover the four originals and plot them.
Run the canonical preflight before commit/push and merge to main.


## Verification evidence

- Started from current main `317f5924`, Alpha.21, including persistent table
  resizing, electrode naming and import folder navigation.
- Browser reproduced the four Safe rejections, used each row's new retry,
  selected all four with independent Permissive modes, and imported four Cells
  into a disposable library. All reached READY and remained READY after reload.
- Each Cell Overview rendered recorded voltage. Three rendered one SVG voltage
  path; the backward-clock case rendered two separate paths. Reload retained
  the exploratory notice and original instrument-error record 40,674.
- SHA-256 checks confirmed all thirteen supplied originals remain unchanged.
- Seventeen focused production-handler, mode and readability checks passed.
  Independent Astra Medium review found no remaining actionable findings after
  eligibility and rejection-retention corrections.
- The initial preflight used a too-long disposable TEMP root: an independently
  reproduced candidate pathname was 261 characters and failed at `os.replace`.
  The canonical unchanged checks passed with a shorter TEMP root: all four
  stages and all 220 backend/frontend test files/modules, using four workers.
