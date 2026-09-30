# 064 — Searchable filters and source discovery workspace

Status: Implemented; independent Astra high review clean and full preflight passed.
Branch: `codex/indexed-search-filters`.

Review document: [064 review](reviews/064-indexed-search-filters-review.md).

## Locked scope

Within loader step 1, Search indexed locations uses the existing right panel for Preview / Filters
tabs. The ordinary folder picker and shared plot implementation retain their contracts. Clicking
or keyboard-activating a result reveals Preview; checkbox-only inclusion does not switch tabs.
Background updates never steal the tab or focus. Filters, query, scroll and selections survive tab
changes; result/filter changes reset pagination, not staged selections.

Filters has a search box at its top that searches category names, field names and aliases (for
example cycles, mass, dates, analysis, filename). Matching controls/categories are revealed;
searching for a control never changes the applied search. Expand/collapse all, active section
counts, removable chips above results, reset-all and undo-last-filter are provided. Follow the
visual style guide: compact Mantine controls, channel/theme colors, stable scrollbars, keyboard
labels and explanatory hover/focus help instead of prose-heavy panels.

## Filters and actions

- Location/file: enabled indexed root, filename/path/folder, format, supplier, size range.
- Dates: file creation (when supported), file modified, source-header test start, first indexed;
  before/after/between, today/last 7/30 days shortcuts. File dates and test dates are distinguished.
- Source header: barcode, remarks, part number, technique, device/channel where normalized.
- Cycling: recorded source cycle count, active material mass (mg), nominal capacity (mAh),
  recorded duration (hours UI, seconds storage). Only normalized cheap headers or already persisted
  source facts; never parse records/caches or calculate to satisfy a filter. Missing stays unknown.
  Material identity/chemistry can be searched in explicitly recorded Cell metadata; never inferred
  from part numbers or filenames. Source count is never a continued Cell's aggregate count.
- CellXplorer: known source-path registration, used/not used in analysis, specific analysis,
  replicate membership/specific group, linked Cell name/notes/visible curated metadata. Membership
  is the linked Cell's current shared analysis sample-set membership, including replicate expansion,
  not per-plot visibility. Raw/override Cell metadata remains excluded. Show relationship names and
  offer Open Cell / Open analysis / Show in folder. Copied paths are not checksum-proven duplicates.
- Folder context: count of indexed recognized compatible files in the same immediate folder,
  before result filters, deduplicated across overlapping roots. Label counts partial when relevant
  indexing is incomplete/offline. Counts never traverse folders on search.
- Text conditions: up to 16 field/operator/value conditions with Match all / Match any. Fields
  include Any searchable field, filename, path, folder, individual source-header and Cell fields.
  Contains/not contains/equal/not equal/starts/ends/has value/is missing. Explicit case option.
- Regex is opt-in and explicitly applied, with field, case option and useful invalid-pattern errors.
  Pure Python matching runs in an isolated stoppable process, at most two concurrent jobs and a
  three-second wall deadline. No catastrophic pattern may block the application request worker.
- Sorting: relevance/name, newest modified/created/indexed/test start, size. Unknowns last and
  deterministic canonical-path tie break. Saved named search presets include query, filters and
  sort; database-scoped existing AppSetting persistence, bounded 30 presets, user can delete.

Range filters support known-only/include-unknown/unknown-only. Conditions combine with basic
facets/ranges through AND, with all/any controlling text conditions only. Pending metadata never
means zero; filters explicitly handle unknowns. Results show field/value match explanations.

## Architecture and performance

All conditions, counts, sorting and pagination apply to the entire local catalog before LIMIT.
Search requests never stat/read/hash sources or generate scientific caches. Extend the disposable
catalog with nullable creation/first-indexed/folder facts and bounded normalized metadata fields.
Preserve existing entries on derived schema upgrade; old missing fields remain unknown until a
normal reconciliation. Raise metadata enrichment version to refresh new header fields. Live changes
refresh facts using existing Spec 063 workers. No scientific schema migration / CALC_VERSION change.

Use one local relational snapshot for source-to-Cell/analysis/replicate metadata; avoid N+1 and
per-source header JSON expansion. Resolve known mapped/UNC/case aliases using catalog root facts.
Apply this snapshot through temporary indexed SQLite tables; do not copy relationships into the
disposable persistent catalog where they could become stale. Regex jobs receive immutable facts,
no source access. Simple queries stay on the current fast path. Measure broad filtered and
relationship requests in a disposable large catalog; target subsecond under normal local load,
report actual timings and limitations rather than promise universal hardware/NAS latency.

## Verification and completion

Focused backend coverage: ranges/unknowns, text operators/all-any/escaping, relationships including
multi-source Cells and replicate analyses, alias identity, pre-pagination totals/counts, stable sort,
creation/header facts, stale facts/live refresh, old catalog upgrade, invalid/slow regex deadline,
presets validation/preservation and filesystem-free queries. Frontend policies cover searched
filter discovery, chip/reset/undo, preset normalization, tab activation without checkbox/refetch
switches. Browser-check light/dark, keyboard, filter search, tab retention, active chips, large
results space, scrollbars, presets, relationship explanations and Show in folder.

Run canonical preflight and independent GPT 6 Astra high review after each implementation/browser
round until clean. Record review in `docs/specs/reviews/064-indexed-search-filters-review.md`.
Synchronize app version per repository policy, commit/push feature, merge/push main. No release/tag.
Private NAS and installed WebView acceptance remain environment gates, not claimed browser evidence.
