# Spec 016: "Reindex remaining cycles" has no effect

Status: **implemented** (2026-07-26).

Reported: with **Hide diagnostic cycles** on and **Reindex remaining cycles** switched on, the
cycles plot does not change — the gaps left by the hidden cycles remain, and the x-axis still
runs to the original last cycle. Expected: the surviving cycles close up and are renumbered
1…N.

Confirmed from the screenshots: the plot is **pixel-identical** with the toggle off and on
(`51 HIDDEN · 170 SHOWN`, x-axis still reaching ~220).

## 1. Cause

The reindex computation itself is **correct and already implemented**. The failure is that the
plot is never recomputed, and — behind that — the axis would be restored stale even once it is.

### 1.1 Primary: `viewSignature` omits the flag

`frontend/src/pages/AnalysisPage.tsx` (~7891) builds the memo key for the cycle plot:

```ts
const viewSignature = useMemo(() => JSON.stringify({
  quantity: spec.presentation.quantity,
  normalize: spec.presentation.normalize_by_mass ?? false,
  ce: spec.presentation.ce_overlay,
  individual: spec.presentation.show_individual_cells,
  legend: spec.presentation.legend,
  hideDiagnostics: spec.presentation.hide_diagnostic_cycles ?? false,
  diagnosticTolerance: spec.presentation.diagnostic_tolerance ?? null,
  style: currentPlotStyle(spec, "cycles"),
}), [spec]);
```

`reindex_diagnostic_cycles` is **not in it**. The traces are memoised on that key:

```ts
const exportTraces = useMemo(() => (result ? tracesForResult(result, spec) : []),
  [result, viewSignature]);          // ~7912
```

So toggling reindex mutates `spec`, `viewSignature` is unchanged, the memo returns the cached
array, and nothing re-renders. `tracesForResult` → `withoutDiagnosticCycles(..., reindex)` is
never re-entered.

The block carries two comments stating exactly this rule — *"normalize … MUST invalidate the
trace/layout memos"* and *"Hiding diagnostics drops points from every trace, so it belongs here
for the same reason"*. The reindex flag changes what is plotted in precisely the same way and
was simply not added when the feature landed.

The `layout` memo (~7936) uses the same `viewSignature`, so it is fixed by the same change.

### 1.2 Secondary: the axis window would be restored stale

Even with §1.1 fixed, two things pin the old x range:

- `zoomSignature` (~7932) is
  `` `${result?.computed_at}|${quantity}|${normalize_by_mass ? "g" : "abs"}` `` — no reindex
  flag. `useZoomMemory` therefore treats the reindexed plot as the *same* view and re-applies
  the remembered x range.
- `cyclePlotLayout`'s `uirevision` (~6995) is built from the same three parts, so Plotly also
  preserves the user's pan/zoom across the change.

Reindexing changes the x domain fundamentally (here 1…221 → 1…170). Keeping the old window
would leave a stretched axis with empty space on the right — the gaps would close but the plot
would still look wrong. **Both must be treated as a new view.**

Note `resetManualAxis(s, "cycles", "x_axis")` is already called from the toggle handler
(~4636). That clears an explicit **manual** range, which is a different mechanism from the zoom
memory and `uirevision`; it is correct but not sufficient.

### 1.3 Not affected

- `withoutDiagnosticCycles` (~2653) and its `remap` — verified correct; do not change.
- The saved-plot preview path (`tracesForResult` at ~3506) keys on `savedPlotPreviewSignature`,
  which serialises the whole `presentation` object, so it already picks the flag up.
- The portable-export path (~7424) builds traces directly from the spec with no memo.

## 2. The fix

1. Add to `viewSignature` (~7891), next to `hideDiagnostics`:
   ```ts
   reindexDiagnostics: spec.presentation.reindex_diagnostic_cycles ?? false,
   ```
2. Add the same flag to `zoomSignature` (~7932) so the zoom memory starts a fresh view.
3. Add it to `uirevision` in `cyclePlotLayout` (~6995) for the same reason.

Keep the existing `resetManualAxis` call.

Use a short, stable serialisation in the two string keys (e.g. `|reidx` / `|noreidx`, or `1`/`0`)
— consistent with how `normalize_by_mass` is already encoded as `g`/`abs`.

### Guard against the next occurrence

This is the second presentation flag to be added without updating `viewSignature`. Add a comment
there naming the rule explicitly:

> Any `presentation` field that changes **what is plotted** (not merely how it is styled) must
> appear here, in `zoomSignature`, and in `uirevision`. A flag that changes the data but not
> these keys silently does nothing.

## 3. Acceptance

1. With **Hide diagnostic cycles** on, toggling **Reindex remaining cycles** visibly changes the
   plot on the first click, with no other interaction needed.
2. Reindexed, the surviving cycles are contiguous — no gaps — and the x-axis ends at the number
   of shown cycles (170 in the reported case), not the original last cycle (~221).
3. Toggling it back restores the gapped view and the original axis extent.
4. Any zoom applied before toggling is not re-applied afterwards; the reindexed plot opens at its
   own natural range.
5. The `51 HIDDEN · 170 SHOWN` disclosure is unchanged by reindexing — it reports hiding, not
   renumbering.
6. Replicate bands and the CE overlay stay aligned with the reindexed x values (they share the
   same remap by construction).
7. Exports and the saved-plot thumbnail agree with the on-screen plot in both states.
8. The reindexed numbering is display-only: CSV/XLSX export and the portable report still carry
   the **real** cycle numbers.

Criterion 8 is the one to be careful about — reindexing is a *viewing* aid. If an export ever
emits `1…170` instead of the true cycle numbers, that is a data-integrity bug, not a cosmetic
one. Confirm the current export path reports real numbers and keep it that way.

## 4. Verification

- `cd frontend && npx tsc --noEmit && npx vite build` (a `frontend/src` change — see the
  build rule in `013-faster-preflight.md` §2.4).
- Manual, on the reported analysis (`DCIR test`, 51 hidden / 170 shown): walk criteria 1–4.
- Export CSV in the reindexed state and confirm the cycle column holds real cycle numbers
  (criterion 8).
- No backend change, so no `pytest` needed.

## 5. Optional follow-up (not required)

`viewSignature` is hand-maintained and this class of bug will recur. A cheap hardening: derive it
from an explicit allow-list constant, e.g. `PLOT_AFFECTING_PRESENTATION_KEYS`, and build both
`viewSignature` and `zoomSignature` from that one list. Out of scope here — the immediate fix
should stay minimal — but worth doing if a third flag ever goes missing.
