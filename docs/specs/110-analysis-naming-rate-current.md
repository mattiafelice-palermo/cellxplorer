# 110 — Analysis naming, C-rate categories and current appearance

Status: Complete. Clean-Windows preflight passed for implementation `8e274e41`.

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
owner test. [Clean-Windows preflight](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/43100330432)
passed all stages on retry after an unchanged installer PowerShell probe timed
out. No check was skipped or weakened.
