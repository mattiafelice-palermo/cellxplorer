# 068 — Customizable plot reference lines

Status: Implemented; Astra Medium review, focused regressions, browser acceptance and full preflight passed.
Branch: `codex/alpha-analysis-improvements`.
Review document: [068 review](reviews/068-customizable-reference-lines-review.md).

## Approved scope

Add a shared Reference lines editor in plot appearance settings. Multiple stable
ID lines can be added, duplicated, removed, enabled/disabled and reordered.
Horizontal or vertical lines bind to a supported numeric X, left Y or right Y
axis and its quantity/units. Set an exact position and full axis-domain span or
bounded numeric span. Unsupported axes and incompatible quantity changes must
not reinterpret an old threshold silently. Categorical axes are not numeric.

## Appearance

Each line has color, opacity, width, solid/dotted/dashed/long-dashed styling and
behind/in-front-of-data layering. List order controls same-layer stacking.
Labels have arbitrary plain text, optional value/units, visibility, along-line
position, side/alignment, rotation, pixel offsets, font size/color and background
and border. Allow precise free label placement in plot-domain coordinates;
dragging must update saved settings where the shared Plotly runtime supports it.
Escape/cancel follows existing appearance-draft behavior; Reset restores defaults.
Bound the editor and keep keyboard controls and live preview usable.

## Architecture and safety

Persist presentation only in the existing plot style JSON with tolerant defaults
for old plots. Share layout composition across supported analysis families and
live, thumbnail, image and portable output. Merge existing shapes/annotations:
never replace point-selection geometry, frames, source boundaries or legends.
No scientific recompute, raw data mutation or CALC_VERSION bump. Data exports
retain measured values; image/PDF/portable figures retain references. Verify
layering with the actual installed Plotly version, including WebGL where used.

## Acceptance

Tests cover normalization, limits, IDs/order, every supported axis, finite values,
spans, quantity changes, label position/content/style, existing shapes, disabled
references, saved/portable roundtrip and old plot compatibility. Browser checks
creation/editing/duplicate/reorder, front/back layering, label positioning,
save/restore and export, in light/dark. Astra Medium review, full preflight and
commit/push checkpoint. Axis breaks are explicitly declined by the user.

## Verification

70 focused frontend tests and 36 portable-analysis tests passed. Production-family
regressions cover numeric axes, stacked current axes, categorical C-rate suppression,
derivatives, units and voltage-channel changes. The portable HTML roundtrip preserves
references and measured values without changing scientific cache identity.

Browser acceptance used disposable application data: creation, Cancel/Apply/Escape,
duplicate/order, precise and dragged labels, save/reload, PNG export, light/dark,
unit suppression/restoration, WebGL front/back layers, and stable adaptive zoom and
cycle navigation. A lower-panel stacked label retained its paper Y=0.2 after drag
and reopening. Canonical preflight passed all 4 stages (113.03 seconds, 4 workers).
Native desktop acceptance is not claimed.
