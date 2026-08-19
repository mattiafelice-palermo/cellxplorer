# Bug: "Add DCIR series" modal crashes — `Cannot read properties of undefined (reading 'map')`

Date: 2026-08-12
Branch: `feature/dcir-segment-scoping-and-plot-affordance`
Status: **fixed** in commit `8e24c7f` ("Fix release note sections and DCIR suggestion modal").
`groupCellsByApplicability` now returns Mantine's grouped `{ group, items: [...] }` shape. This
document is retained as the root-cause record for the class of bug described under
*Also check* and *Why the tests did not catch this*.

## Symptom

Opening the DCIR tab works and existing series render. Clicking **Add series** (the
"Add DCIR series" modal) crashes the page:

```
TypeError: Cannot read properties of undefined (reading 'map')
    at parseItem (chunk-DAZWBEET.js:14905:25)
    at getParsedComboboxData (chunk-DAZWBEET.js:14914:15)
    at mountMemo / useMemo
```

`parseItem` and `getParsedComboboxData` are **Mantine Combobox/Select internals**, so the
crash is a malformed `data` prop passed to a `Select`, not application logic.

## Root cause

`groupCellsByApplicability` in
`frontend/src/features/analyses/editor/families/dcir/suggestionGrouping.ts`
returns the **wrong shape** for Mantine grouped select data.

It currently returns a FLAT array where each non-applicable item carries a `group` string:

```ts
// WRONG - what the helper returns today
[
  { value: "120", label: "Cell A" },
  { group: "Cells with no DCIR segment", value: "118", label: "Cell B", disabled: true },
  { group: "Cells with no DCIR segment", value: "115", label: "Cell C", disabled: true },
]
```

Mantine 7 expects grouped data as objects with a `group` key **and an `items` array**:

```ts
// CORRECT - Mantine's grouped ComboboxData
[
  { value: "120", label: "Cell A" },
  {
    group: "Cells with no DCIR segment",
    items: [
      { value: "118", label: "Cell B", disabled: true },
      { value: "115", label: "Cell C", disabled: true },
    ],
  },
]
```

Mantine's `parseItem` branches on the presence of a `group` key. Seeing `group` on those flat
objects, it treats each as a group and evaluates `item.items.map(...)`. `items` is `undefined`,
hence the crash.

This only fires when at least one cell has **no** applicable DCIR segment — which is why the
tab renders fine until the modal opens with a mixed cell list.

## Where it is used

`frontend/src/features/analyses/editor/families/dcir/DcirPlotCard.tsx`, the `Cell` `Select`
in the "Add / Edit DCIR series" modal (~line 946). It is called only when
`protocols.data` is truthy; otherwise a flat list of all cells is used (that path is fine).

## Fix

Change `groupCellsByApplicability` to return Mantine's grouped shape: applicable cells as
plain items first, then a single group object whose `items` array holds the disabled
non-applicable cells. Emit the group object **only** when `nonApplicable.length > 0` — an
empty `items` array renders a stray heading.

Suggested return type:

```ts
type Item = { value: string; label: string; disabled?: boolean };
type Grouped = Item | { group: string; items: Item[] };
```

## Also check (same class of bug)

`frontend/src/features/analyses/editor/protocol/suggestionGrouping.ts` exports
`groupSuggestionsByFamily`, written in the same round. Verify it emits
`{ group, items: [...] }` and not flat items carrying a `group` key.

It is currently **not rendered** — a later change filters DCIR suggestions to the selected
protocol and renders them flat, so `ProtocolSegmentsPanel.tsx` no longer imports it. So it
cannot be causing this crash, but it will crash the same way if anyone wires it back in.

## Why the tests did not catch this

`frontend/tests/suggestionGrouping.test.ts` passes (490/490 green, and preflight passed
5/5). The tests assert the helper's own invented shape rather than Mantine's contract, so
they encode the bug instead of catching it.

When fixing, **update those assertions to the grouped shape** — otherwise the corrected
helper will fail its own tests. Consider asserting the contract explicitly, e.g. that every
element either has `value`+`label` or has `group`+a non-empty `items` array, and that no
element carries both `group` and `value`.

Note also that neither typecheck nor preflight caught it: the `data` prop was typed by the
helper's own return annotation rather than Mantine's `ComboboxData`. Typing the helper's
return as Mantine's `ComboboxData` would have failed compilation and is worth doing as part
of the fix.

## Reproduction

1. Open an analysis whose selected cells span several protocol families, where at least one
   cell has no DCIR segment defined.
2. DCIR tab → **Add series**.
3. Page renders the "Page failed to render" boundary with the trace above.

## Related context

The surrounding feature work (grouped/filtered DCIR pair suggestions, protocol-first
selection, provenance on saved segments, clickable empty plot area) is committed on this
branch and is unrelated to the crash except that this helper was added in the same batch.
The DCIR **applicability filter itself is correct and must not be "fixed"** — segments are
matched to cells by protocol signature, and that logic was verified against live data.
