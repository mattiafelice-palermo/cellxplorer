# 092 — Cell library usability

Status: Complete; canonical preflight passed all four stages. User waived Astra review.

Hide the legacy Protocol tab in Cell details. Default MPR selection to Permissive
through preview, inspection and registration, preserving explicit Safe overrides
and all existing interpretation warnings. Other formats retain Safe mode.

Preview table column widths directly during pointer dragging and commit React
state/persistence on release, preserving keyboard controls and zoom compensation.

Show Last update in the Cell Database and details. This is the last import or
scientific data refresh, not a filesystem modification or routine monitor check.
Migration 0006 adds a nullable Cell timestamp; historical values display a dash.
Source lifecycle and ordered membership writes advance it in the same transaction.
Cell notes and source location checks do not advance it.

Add About CellXplorer to the power menu with channel name, backend-reported
version, program description, repository and release links.

Validation: 112 backend modules and 110 frontend test files passed, including
focused timestamp/migration preservation and mixed-mode import regressions.
Type check and production build passed. Browser verified Last update dashes
and the About dialog version/links in dark mode. Backend tracking takes effect
after the application restarts and applies migration 0006.
