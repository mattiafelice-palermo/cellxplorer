# 110 — Analysis naming, C-rate categories and current appearance

Status: Implemented; clean-Windows verification pending.

- Select the suggested title when opening the new-analysis or plot-save title field.
  Returning to the field does not select text again.
- In equally spaced C-rate plots, group positive rates whose full span is at
  most 1% of the largest rate in the group. Prefer a simple representative
  inside that span. Keep measured values in tooltips, numerical axes and exports.
- Expose the stacked Time/Capacity current series in Series appearance, with
  separate left/right quantity keys. Preserve default line styles and scientific
  values. Live, saved and exported views use the same overrides.

Focused renderer/export tests and desktop-width in-app browser checks passed.
Local canonical preflight passed all checks except the known native occupied-port
owner test. No check was skipped; clean-Windows preflight is the merge gate.
