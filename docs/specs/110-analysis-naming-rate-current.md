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

## Alpha release

Published as [0.29.0-alpha.3](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.29.0-alpha.3)
on 2026-11-11, from `cffa73f8a1a368038b09bb17772dc9f71e23c7df`.
The release uses the version already prepared on main; only the Alpha revision
advanced since .2. Fresh focused verification passed 31 frontend and 10 worker
tests. Fresh local preflight passed 242/243 test files and modules and all other
stages; the only failure was the known local Windows port-owner check. The
[exact-commit Windows preflight](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/43101963318)
and [signed release workflow](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/43108362290)
passed, including the mandatory native installer checks.

Independent public checks matched the published assets, release notes and Alpha
feed, verified the installer against the embedded updater key, and confirmed the
Stable and Beta feed blobs were unchanged. Installer SHA-256:
`c05aefd37ff8a03166ab6f9b5af694fda0b1f42383dabfceeb2c1de83ca101f9`.
