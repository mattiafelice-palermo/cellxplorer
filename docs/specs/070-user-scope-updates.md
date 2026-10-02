# 070 — User-scope installation and unattended application updates

Status: Planned.
Branch: `codex/alpha-analysis-improvements`.
Review document: [070 review](reviews/070-user-scope-updates-review.md).

## Goal and locked constraints

Fresh installations default to current-user scope in a writable local application
folder, supporting passive signed updates without repeated elevation. Retain an
explicit all-users installation path, whose updates legitimately need UAC.
Windows permission policy cannot be bypassed by quiet installer flags. No new
privileged service, permanent elevation, relaxed Program Files ACLs or disabled
UAC. Preserve Stable/Beta/Alpha identity, update signing and data roots.

## Existing installations

Inspect installer/registry discovery before changing scope. An update must keep
the existing installation's scope and directory, not silently create a duplicate
per-user installation. Existing all-users installations continue to elevate.
If safe automatic migration cannot be validated, document an explicit one-time
reinstallation/migration path rather than deploy an unverified migration. Data
roots stay untouched; uninstall must preserve data as today. Clearly report this
limit in the implementation report: default changes alone do not remove UAC
from already installed machine-scope copies.

## Integration and acceptance

Check NSIS multiuser mode/defaults, branded setup page, registry discovery,
shortcuts/deep links/startup, installation-owned process shutdown, same-scope
update/restart and uninstall for all channels. Frontend remains standard user.
Add contract regressions and compile the installer where available. A disposable
native install/update matrix is required for claiming actual UAC-free update
acceptance; browser/static tests cannot prove it. If bundled/signing assets or
native controls are unavailable, complete safe implementation and report that
specific acceptance gap. Astra Medium review, preflight, commit/push checkpoint.
No version bump, release/tag or changes to the user's real installed application.
