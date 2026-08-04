# 037 — Per-series style editor

**Status:** Implemented (Cycles tab); review pending
**Repository:** `mattiafelice-palermo/cellxplorer`
**Depends on:** None. Branched from `main` at `9a443ba`.
**Branch:** `feature/series-style-editor`
**Review document:** None yet.

All UI work inherits [`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

## Problem

Plot appearance is one `PlotStyle` object per analysis tab. `line_width`, `line_dash`,
`marker_mode`, `marker_symbol`, `marker_size`, `marker_open` and `opacity` apply to **every** series
at once. The only per-series escape hatches are `custom_colors` and `ce_custom_colors`, which cover
colour and nothing else, and they are edited from a long scrolling sidebar section mixed in with
axis, legend and export settings.

So a user who wants one reference cell dashed, or one group thicker, cannot express it, and a user
who just wants "all the 25C cells blue" has to set colours one at a time.

## Locked decisions

1. **Series identity is the existing key.** `c<cell_id>` for a cell series and `g<group_id>` for a
   replicate-group aggregate — the same keys `custom_colors` already uses, so existing saved plots
   keep their colours with no migration. CE overlay traces use the same key prefixed `ce:`.
2. **Three layers, resolved in one place.** Base `PlotStyle` → matching rules in order → explicit
   per-series override. Later layers win field by field; an unset field falls through. One pure
   function owns this so the live plot, thumbnails and exports cannot disagree.
3. **Rules are declarative and ordered.** A rule matches on a series field (`label`, `cell_name`,
   `group_name`, `kind`) with an operator (`contains`, `equals`, `starts_with`, `ends_with`,
   `matches` for regex). Later rules override earlier ones. A rule never wins over an explicit
   per-series override — the user's direct edit is always final.
4. **An invalid regex never breaks a plot.** It matches nothing and is reported in the editor.
5. **The editor is its own modal**, opened from a button in the analysis sidebar. It is not a
   sidebar section.
6. **The modal shows a live preview** built from the same trace builder as the real plot, so what
   the user sees is what the plot will do.
7. **Legend identity is editable per series**: display name, and whether the series appears in the
   legend at all.
8. **Additive only.** Every new field is optional. A spec with no `series_overrides` and no
   `series_rules` renders exactly as before.

## Data model

Added to `PlotStyle`, both optional:

```ts
series_overrides?: Record<string, SeriesStyleOverride>;
series_rules?: SeriesStyleRule[];
```

`SeriesStyleOverride` carries every field as optional: `name`, `color`, `line_width`, `line_dash`,
`line_shape`, `marker_mode`, `marker_symbol`, `marker_size`, `marker_open`, `opacity`, `shadow`,
`show_in_legend`, `hidden`.

## Tasks

### T1 — `frontend/src/seriesStyling.ts` (pure)

Series descriptors, rule matching, and `resolveSeriesStyle(base, descriptor, rules, overrides)`.
No React, no Plotly. Fully unit tested.

### T2 — Types

`SeriesStyleOverride`, `SeriesStyleRule`, and the two optional `PlotStyle` fields in `api.ts`.

### T3 — Trace builder uses the resolver

The cycles trace builder resolves each series through T1 instead of reading `style.line_*` and
`style.marker_*` directly. Colour precedence keeps `custom_colors` working as the lowest layer.

### T4 — `SeriesStyleModal`

Series list, per-series editor, rules editor, and a live preview. Opened from a sidebar button.

### T5 — Sidebar button

Replaces the scattered per-series colour controls as the entry point; existing global controls stay
where they are.

## Verification

```powershell
node --test frontend\tests\seriesStyling.test.ts
cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..
python scripts\preflight.py
```

## Out of scope

Tabs other than Cycles keep global styling in this spec; the resolver is written so they can adopt
it without changing the model.

## Implementation record

Branch `feature/series-style-editor`, from `main` at `9a443ba`. Version `0.19.0-beta001`.

### T1 — `frontend/src/seriesStyling.ts`

Descriptors, rule matching, and `resolveSeriesStyle`. Pure: no React, no Plotly, no network.
Also exports `seriesPlotlyMode` / `seriesPlotlySymbol` so the modal and the trace builder translate
a resolved style to Plotly identically, and `pruneOverrides` so a spec does not accumulate `{}`.

### T2 — Types

`SeriesStyleOverride`, `SeriesStyleRule`, `PlotLineDash`, `PlotMarkerSymbol`, `PlotMarkerMode`, and
the two optional `PlotStyle` fields.

### T3 — Trace builder

The cycles builder resolves both aggregate and cell series through T1. The base passed in carries
exactly what each trace previously hardcoded — including the grouped-cell width reduction, the
individual-cell opacity, and every `compact` thumbnail value — so a plot with no overrides and no
rules produces the same traces as before. `hidden` skips the trace; `shadow` emits a wider faint
copy underneath first, because Plotly has no line shadow.

### T4/T5 — `SeriesStyleModal` and the entry point

Series list, per-series editor, rules editor, and a live preview that re-resolves through the same
function the plot uses. Opened from a **Series appearance…** button at the top of the sidebar's
*Lines* section, above a new "Applies to all series" divider that makes the existing global controls
honest about their scope. The button subtitle reports how many series are customised and how many
rules exist.

### Decisions made without asking

- **Series identity reuses the `custom_colors` keys** (`c<id>` / `g<id>`), so saved plots keep their
  colours and no migration is needed. `custom_colors` remains the colour source under the new
  layers rather than being replaced.
- **Rules lose to explicit overrides.** A bulk rule silently undoing a hand-set value would be worse
  than a rule appearing not to work, and the editor says so where both apply to a series.
- **An invalid regex matches nothing and never throws** — a half-typed pattern must not blank a plot.
- **Grouped cell series stay keyed by cell**, so an individual cell inside a replicate group can be
  styled even though its default colour comes from the group.

### Verification

```text
node --test frontend\tests\seriesStyling.test.ts   16 tests, pass
npx.cmd tsc --noEmit                               clean
npx.cmd vite build                                 built
python scripts\preflight.py                        PREFLIGHT PASSED, 5/5
```

### Not done

- **No browser verification.** The modal, its preview, and light/dark rendering have not been seen
  running; the user asked for sparing browser use and confirmed changes themselves.
- Only the **Cycles** tab resolves per-series styling. Time/capacity, Steps, DCIR, Chargeability and
  C-rate still use the global style. The resolver is tab-agnostic, so adopting it elsewhere is
  wiring, not redesign.
- The **CE overlay** still uses `ce_custom_colors` and the global `ce_*` fields. The `ce:` key prefix
  is reserved in the model but not yet emitted.
- Rules expose colour, dash, width and marker mode. The remaining override fields (shape, symbol,
  size, opacity, shadow, legend visibility) are per-series only for now.
- No preset integration: `PlotStylePreset` does not yet carry overrides or rules.
