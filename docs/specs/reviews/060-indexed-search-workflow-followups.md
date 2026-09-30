# Indexed search workflow follow-ups

User-authorized follow-up to Spec 060, implemented on `codex/indexed-search-workflow`.

## Ordered scope

1. Preserve search context across scope changes, reconcile removed/disabled location and format
   filters, keep pagination valid, and make keyboard navigation update the preview.
2. Reconfigure only affected scans; changing refresh preferences must not restart scans.
   Retain results from unavailable locations with truthful status and precise recovery messages.
3. Reclaim the folder sidebar in indexed mode, compact empty selection, label and highlight match
   reasons, provide discovered case-insensitive technique filters and a clear reset action.
4. Manage locations inline in the search workspace. Adding a root opens one clearly labelled folder
   chooser, without an intervening Add dialog. Keep path entry available in settings.
5. Reveal results in their containing folder, retain search context on return, and show useful page
   ranges and specific indexing states. Inspect registration lookup and background progress costs.

Reuse source previews, import eligibility and authoritative checksum checks. Search queries remain
local-only; no new service, source parser, persistent scientific schema or data migration.
Use the existing visual style, help tooltips, theme tokens and keyboard/selection conventions.

## Verification

Use an isolated catalog/library for browser checks of scope restoration, stale filters, keyboard
preview, location addition/removal, unavailable roots, match explanations, light/dark geometry
and Escape behavior. Run repository preflight before landing. Real SMB and installed WebView
behavior require their own environment and must not be inferred from local simulation.

## Acceptance evidence

- Isolated browser/library checks passed for query restoration across scopes, labelled/highlighted
  metadata matches, arrow-key preview, Space selection, containing-folder focus, removed-location
  filter recovery, unavailable-location retained results with disabled inclusion, and nested Escape.
- Location addition uses one folder-only chooser with `Add search location` / `Index this folder`.
  Advanced settings stay inline and collapsed in the loader. Empty and small selections retain
  result height; the preview divider supports pointer/keyboard resizing, capped at 45% in search.
- Browser geometry was checked in the current light-theme narrow window. No live SMB share,
  installed WebView, or dark-theme browser acceptance is claimed for this tranche.
- Final repository preflight passed all 4 stages in 89.54 seconds (93 backend modules and
  90 frontend policy files); log: `tmp/search-workflow-preflight-reviewed.log`.
- Seven matched synthetic rounds with 100,000 library paths measured registration lookup at
  302.7 ms median before and 121.0 ms after, with identical matches. This is registration-only,
  not total query or network-drive latency. No additional cache or scientific schema was added.

Independent Astra review found no blockers. Its mixed filename/folder explanation finding was
fixed and re-reviewed clean. That final helper change passed preflight; no additional mixed-query
browser acceptance is claimed after the development server restart.
