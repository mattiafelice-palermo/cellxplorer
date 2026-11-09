# 101 — Archive backed timezone data review

Implementation self-review, not an independent reviewer approval.

## Verification

- Eighteen focused archive/runtime-package regressions pass. Fresh local frozen
  backend passes `verify_packaged_science.py` and `smoke_packaged_backend.py`.
- Clean-Windows run 42668568897 passes all 229 committed test files/modules.
- Build-only run 42668616756 passes frozen API/science, signing, installer policy
  and eight native install/reinstall cases. Non-tag publication steps are skipped.
- Local full preflight's concurrent analysis/indexing timing failures and native
  listener failure are not relabeled passes. Isolated analysis rerun: 134 passed.

## Code reading

The upstream package is unmodified. Collection mode `py` prevents frozen PYZ
shadowing; the early runtime hook uses ordinary zipimport/resource semantics.
Archive paths/timestamps/attributes are deterministic. Exact membership and bytes
are verified before deletion; only the validated generated package subtree is
removed, and links/junctions or malformed layouts fail before deletion. Metadata
and licences remain shipped. The frozen verifier checks actual archive origin and
no loose package, all zones across historical/DST dates, folds and invalid names.
Bundle audit requires the exact archive file and rejects loose duplicates.

No scientific parser, calculation version, schema, raw data, real profile,
updater permission, installer scope or public release semantics change. Other
small-file groups remain intact; Tcl lacks a compatible ZIP loader in this build,
and a metadata archive probe demonstrates a native-file location regression.

## Follow ups and boundaries

No open implementation findings. A final audit-hardening follow-up explicitly
requires `_internal/tzdata.zip` as a file rather than trusting the component name;
its regression also rejects a missing archive in a synthetic report.

The packaged desktop was also launched under a non-conflicting Stable identity,
with disposable scientific and WebView profiles; Cell Database, Settings, API
health and frozen-worker startup pass with no timezone extraction. The older
Alpha test app was left running. Interactive UAC/old-client-updater acceptance is
not claimed. Tcl consolidation is a separate feature,
not permission to remove its clock, locale or encoding resources. Actual whole-app
installation speedup is not inferred from file-count reduction alone.
