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

### Follow-up: the editor shipped empty

First user check: the modal listed **zero series** and the preview was blank.

Cause: the style panel derived its result with
`result && "cell_traces" in result ? undefined : result`, which discards the **time/capacity**
result — and that is the tab it was opened on. The button was rendered on every tab's panel while
only Cycles was wired, so on time/capacity it could only ever be empty.

Fixed by:

- **Descriptors for both tabs.** Time/capacity keys grouped cells as `g<id>` (it colours a group as
  one series), unlike Cycles which keys every cell. Descriptors now follow each tab's own scheme,
  because listing series the trace builder cannot match is what produced the empty panel.
- **Time/capacity honours per-series styling**, in both the derivative and the voltage/current
  views, so the editor actually changes that plot. The discharge-phase dash special case is kept as
  the base, with overrides layered on top.
- **The preview is the real plot.** The modal now takes a `buildPreview(overrides, rules)` callback;
  the panel calls the page's own `tracesForResult` / `cyclePlotLayout` or
  `tracesForTimeCapacity` / `timeCapacityLayout` against a draft spec. Bands, CE overlay, source
  boundaries, axis titles and aspect ratio all come along, and the preview cannot drift from the
  result. It builds only while the modal is open.
- **Layout**: preview on the left at ~52% width, filling the height; series list and editor on the
  right.

The descriptor builders moved into `seriesStyling.ts` as pure functions over structural types, and
four tests now pin them — including one asserting a populated result never yields an empty list.
That is the specific regression that shipped, and it is now impossible to reship silently.

### Follow-up: usability and performance

**The modal was sluggish, and the cause was architectural.** Every control change wrote straight
through to the analysis spec, which re-rendered the whole analysis page *and* rebuilt the main plot
behind the modal. A colour picker fires continuously while dragging, so a single drag triggered
dozens of full-page renders.

Now the modal holds a **local draft**, commits to the spec on a 250 ms debounce, and flushes on
close (and on unmount, so nothing is lost). The preview additionally uses `useDeferredValue`, so
the controls stay responsive and the plot catches up a frame later. Two independent brakes: the
debounce protects the page, the deferred value protects the modal.

**Line style leads the form.** The three-way control was renamed from "Markers" to **Line style**
(Line only / Points only / Line + points) and moved directly under colour and opacity, because it
decides which of the following groups apply. The Line group is disabled for *Points only* and the
Markers group for *Line only*, so the form states what is actually in effect.

**The drop shadow was invisible** because it was only implemented for Cycles, and the report came
from Time/capacity. It is now emitted by both tabs through one `shadowTraceFor` helper, and it is
tunable: colour, opacity, spread, and X/Y offset.

Offset is expressed as a **percentage of the series' own span, not pixels**. The shadow is a second
trace in data coordinates, so a pixel offset would drift as soon as the plot is zoomed. The field
labels say "% of span" rather than implying a precision the mechanism cannot deliver.

**Removed "Hide this series"** from the editor — the eye toggle in the series list already does it,
and two controls for one state invites them to disagree.

**Layout**: every panel now has a titled header (Preview / Series / Appearance / Rules), panels
stretch to the dialog height instead of leaving the lower half empty, the series list has a drag
divider (180–460 px), and the appearance form lays out in rows of three so it uses the width.

### Follow-up: layout, hover labels, and the last of the lag

**The resizer was the wrong answer.** Replaced with a chevron that collapses the series panel to a
62 px strip showing only the colour swatch and the visibility toggle, with the series name on hover.
That is all picking a series needs, and it frees the width without a drag interaction.

**The plot is now a fixed 620 px.** Switching Series ↔ Rules was slow because the plot shared a
flexible row with the right-hand panel; the Rules controls are wider, so their min-content width
stole space from the plot and forced a Plotly relayout on every tab change. The preview panel no
longer flexes, and the right panel carries `minWidth: 0` so its content can never push back. Same
plot, same size, both tabs.

**Legend name typing was still gated by the render cycle.** Holding Backspace did nothing and then
deleted everything at once, because each keystroke re-resolved every series and rebuilt the preview
before the character could appear. The field is now a small component with its own state: typing is
local and instant, the draft is updated on a 200 ms debounce, and it flushes on blur. It re-seeds
only when the selected series changes, so an incoming draft cannot fight what is being typed.

**Hover labels were enormous** because the full `.ndax` filename set their width.
`shortSourceName` truncates in the middle to 34 characters — keeping the distinguishing head and
the extension, since that is what tells two variants apart — and both layouts now set `hoverlabel`
from the plot's own paper colour, frame colour and tick font, so the box follows the app's styling
instead of Plotly's default.

### Not done

- **No browser verification.** The modal, its preview, and light/dark rendering have not been seen
  running; the user asked for sparing browser use and confirmed changes themselves.
- **Cycles** and **Time/capacity** resolve per-series styling. Steps, DCIR, Chargeability and C-rate
  still use the global style, and the button is still shown on their panels where it will list no
  series — the same class of gap that produced the empty modal, left open deliberately rather than
  hidden, since those tabs need their own key schemes.
- The **CE overlay** still uses `ce_custom_colors` and the global `ce_*` fields. The `ce:` key prefix
  is reserved in the model but not yet emitted.
- Rules expose colour, dash, width and marker mode. The remaining override fields (shape, symbol,
  size, opacity, shadow, legend visibility) are per-series only for now.
- No preset integration: `PlotStylePreset` does not yet carry overrides or rules.
