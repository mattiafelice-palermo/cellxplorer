# 091 — Single continuous project-table header dividers

Status: Complete; browser acceptance, Astra Medium review and canonical preflight passed.
Branch: `codex/single-table-header-dividers`.
Review document: [091 review](reviews/091-single-table-header-dividers-review.md).

## Request and cause

The Projects tree header gained doubled vertical lines when resizable columns
were introduced. The shared resize handle paints its own right border four
pixels beside the header/body grid's existing divider.

## Behavior

Let the Projects grid own the visible separators. Retain the shared eight-pixel
pointer hit area, pointer capture, keyboard resizing and persisted column widths.
Allow the shared handle's decorative divider to be omitted where the table already
provides one. Other users of the handle retain their existing presentation.
No scientific/cache identity, data, version, application installation or release
changes are needed.

## Acceptance

Verify a disposable Projects tree with nested folders and a Cell in light and
dark modes. Header/body divider coordinates must align, with one visible line
per boundary. Verify keyboard and pointer resizing and reload persistence.
Run canonical preflight before committing, pushing and merging this separate
feature after Spec 090.


## Browser evidence

A separate disposable backend/library and frontend preview displayed a nested
folder tree with one Cell. In light and dark modes the three metric header/body
border x-coordinates matched exactly. All four resize handles retained eight-pixel
hit areas and painted no extra border. Keyboard resizing changed Name from 380
to 396 pixels, a pointer drag changed it to 436 pixels, and reload restored 436.
Light/dark screenshots were saved locally outside tracked source. Automatic theme
was restored and the disposable servers were stopped afterward.

Independent Astra Medium review found no issues. No additional source-mirroring
unit tests were added for this reversible presentation change; browser geometry
and input checks exercise the actual controls. Existing cache/application/science
versions remain unchanged.


Canonical four-worker no-cache preflight passed all four stages and all 221
backend/frontend test files/modules. Both requested fixes are verified on the
latest main lineage without an application release-version bump.
