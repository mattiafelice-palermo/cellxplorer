# CellXplorer visual style guide

## Purpose and authority

This is the canonical visual contract for CellXplorer. It applies to every new or modified
frontend surface: pages, analysis tabs, cards, tables, forms, modals, menus, empty states,
notifications, and loading states.

Use this order when visual instructions conflict:

1. an explicit user decision or a design decision marked **locked** in the active spec;
2. this guide;
3. the closest established shared component or neighbouring screen;
4. Mantine defaults.

An implementation spec may override this guide only when it names the exception and explains why.
Do not create a one-off visual language merely because a mockup omits details.

The authoritative implementation anchors are:

- `frontend/src/main.tsx` for the Mantine theme;
- `frontend/src/app.css` for global geometry and theme-safe CSS;
- `frontend/src/App.tsx` for the application shell;
- shared components under `frontend/src/components/`;
- `frontend/src/features/analyses/editor/AnalysisEditor.tsx` for editor composition and
  `frontend/src/features/analyses/editor/plotting/` for plot style and export behavior.

## Visual character

CellXplorer is a scientific desktop tool, not a marketing website. The interface should feel:

- quiet, compact, and information-dense;
- precise rather than decorative;
- consistent enough that repeated workflows become visually predictable;
- restrained in color, using emphasis only for state or action;
- stable while data loads, without flashing or rearranging controls;
- usable in both light and dark chrome at the system-selected UI zoom.

Prefer a small number of clearly grouped controls over large hero elements, oversized cards,
gradients, glass effects, heavy shadows, or decorative animation.

## UI stack and reusable primitives

- Use Mantine components and theme tokens before custom HTML/CSS.
- Use Tabler icons; do not mix icon families.
- Reuse an existing CellXplorer component when the interaction already exists. Important examples
  include plot headers/style panels, `RecognitionProgress`, `ProtocolStructureViewer`,
  `PlaceInFoldersModal`, `FolderTree`, `DestructiveImpactModal`, and shared export controls.
- Keep global CSS exceptional. Component-local layout belongs in props, `style`, or a CSS module.
- Do not add a second design-token system. Mantine spacing, radius, color, and typography tokens
  are the application tokens.

## Color system

### Chrome palette

`frontend/src/main.tsx` selects the application primary color from `APP_BRANDING`:

```ts
createTheme({
  primaryColor: APP_BRANDING.primaryColor, // Stable teal; Beta betaBlue; Alpha alphaPurple
  defaultRadius: "md",
});
```

Use colors by meaning:

| Meaning | Mantine color | Typical use |
|---|---|---|
| Primary / active | current theme primary (`teal`, `betaBlue`, or `alphaPurple`) | Main action, active eye, progress, selected state |
| Semantic success / running | `teal` | Success notification, completed operation, healthy/running state |
| Draft / unsaved attention | `yellow` | Draft plot, update-pending action, non-destructive attention |
| Changed / caution | `orange` | Changed source, caution alert, action needing review |
| Error / destructive / offline | `red` | Errors, destructive actions, failed jobs, unavailable data |
| Neutral / inactive / cached | `gray` or semantic defaults | Secondary metadata, inactive controls, cached status |

Do not assign a new hue to a state when one of these meanings already fits. Never rely on color
alone: pair it with a label, icon, pattern, weight, or disabled state.

### Theme-safe surface recipes

Use semantic tokens for ordinary chrome:

```tsx
bg="var(--mantine-color-body)"
bg="var(--mantine-color-default)"
borderColor="var(--mantine-color-default-border)"
```

Use these recipes when a numbered tint is needed:

```tsx
// Subtle raised or nested neutral surface
"light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"

// Selected or active channel-primary surface
"var(--mantine-primary-color-light)"
```

Mantine numbered shades such as `gray.0`, `teal.0`, `--mantine-color-gray-0`, and
`--mantine-color-white` do not switch automatically in dark mode. Never use them alone for a
chrome background.

For text, prefer `c="dimmed"` and Mantine's inherited text color. For borders, prefer
`withBorder` or `--mantine-color-default-border`; do not hardcode pale gray borders that disappear
in dark mode.

Hardcoded hex colors are allowed only when they are persisted plot presentation data, part of an
explicit data-visualization palette, or required by a file/export format. They are not allowed for
ordinary application chrome.

### Plot palette

Plot colors are separate from chrome colors. The default CellXplorer plot palette is owned by
`PLOT_PALETTES.app` in `features/analyses/editor/plotting/plotStyle.ts`:

```text
#12b886, #2E86AB, #E63946, #43AA8B, #F4A261,
#7B2D8E, #588157, #BC4749, #3A0CA3, #FB8500
```

The plot system also provides Pastel, Publication, Presentation, Okabe-Ito, Tableau, Blues,
Viridis, Monochrome, and user-defined palettes. Build traces through `plotPalette`,
`custom_colors`, and the existing style helpers. Do not assign ad hoc series colors inside a new
analysis tab.

Color should identify the same entity consistently within one figure. When color already denotes
cell identity, distinguish another dimension with line dash, marker, or bar pattern rather than a
second unrelated color mapping.

## Typography

Use the existing Mantine font stack and the following hierarchy:

| Role | Preferred treatment |
|---|---|
| Main page heading | `Title order={2}` or `order={3}`, following neighbouring pages |
| Major card/modal heading | `Title order={4}` or `Text fw={700}` |
| Plot title | `Text size="lg" fw={800}` |
| Section/container heading | `Text size="sm" fw={700}` |
| Body and control-adjacent copy | `Text size="sm"` |
| Metadata/helper text | `Text size="xs" c="dimmed"` |
| Compact structural label | `Text size="xs" fw={700} tt="uppercase" c="dimmed"` |
| Dense protocol/index annotation | 10–11 px only where the established viewer already does so |

Use weight and spacing before introducing another text size. Avoid body text below `xs`; 10 px is
reserved for dense structural metadata, never instructions or error messages.

Use sentence case for headings, labels, menu items, and buttons. Preserve scientific
capitalization and units (`DCIR`, `SoC`, `C-rate`, `mAh/g`). Button labels should be short action
phrases such as “Add series”, “Export image”, or “Save plot”.

## Spacing, radius, borders, and elevation

- The global default radius is `md`. Use it for cards, modals, inputs, and ordinary grouped
  surfaces.
- Use `sm`/`xs` radius only for dense inner controls, pills, or plot internals that already use it.
- Prefer `withBorder` for cards and panels. Borders establish hierarchy more often than shadows.
- Keep shadows light and exceptional: popovers, menus, modals, and the segmented-control indicator.
- Standard page padding is Mantine `md`, established by `AppShell.Main`.
- Standard card padding is `sm` or `md`; use `xs` for dense nested cards.
- Standard control/group gaps are `xs` or 6–8 px. Use `sm` between related sections and `md`/`lg`
  only between major page regions.
- Avoid stacking several bordered cards with large padding when a divider or compact group would
  communicate the same hierarchy.

## Buttons and icons

### Button sizing matrix

Keep controls in the same row at the same size.

| Context | Button size | Variant | Icon size |
|---|---|---|---|
| Global header utility | `compact-sm` | `subtle` | 14 px |
| Dense row/tree action | `compact-xs` or `compact-sm` | `subtle`/`light` | 12–14 px |
| Analysis plot header/export action | `xs` | usually `default`; primary save uses semantic color | 14 px |
| Standard page or modal action | Mantine default or `sm` | primary filled, secondary `default` | 16 px |
| Icon-only row action | `ActionIcon size="xs"` or `"sm"` | `subtle` | 13–14 px |
| Standalone icon action | default/`sm` ActionIcon | `subtle` | 16–18 px |

Do not introduce `lg` buttons into ordinary workflows. Larger controls are appropriate only for a
true empty-state call to action or accessibility need.

### Button hierarchy

- One primary action per local decision area: filled current channel primary.
- Secondary actions: `variant="default"`.
- Tertiary/navigation utilities: `variant="subtle"`.
- Low-emphasis semantic actions: `variant="light"` with the semantic color.
- Destructive actions: red. Use a filled red button only in the final destructive confirmation;
  routine delete icons remain subtle red.
- Draft/update actions use yellow; new/save actions use the channel primary, matching the analysis
  plot header.
- Split actions use `Button.Group` with identical size/height and a 12–14 px chevron.
- Disabled buttons must remain visible when they teach what action becomes available. Hide an
  action only when it is irrelevant, not merely unavailable.

Every icon-only action needs an `aria-label` and normally a `Tooltip`. Use icons as reinforcement,
not as a replacement for an unfamiliar action label.

## Forms and selectors

- Prefer Mantine `TextInput`, `NumberInput`, `Select`, `MultiSelect`, `Switch`, `Checkbox`, and
  `SegmentedControl`.
- Use normal Mantine input size for standard forms; use `xs` only inside established dense analysis
  sidebars or menus.
- Labels should state the quantity or decision. Put units in the label or input suffix, not in a
  detached paragraph.
- Helper text is `xs` and dimmed. Validation text is explicit and red; do not communicate invalid
  state with a border alone.
- Related controls belong in a bordered section with a `sm`, bold heading. Avoid one card per
  individual field.
- Use `SegmentedControl` only for a short, mutually exclusive choice. Its shared geometry is
  defined in `app.css`; do not override it per screen.
- Dropdowns should show available scientific values where applicable rather than accepting
  arbitrary text.

## Cards, lists, tables, and trees

- A standard card is `Paper withBorder radius="md" p="sm"` or `p="md"`.
- Selection uses the theme-safe teal tint, usually with a stronger text weight or selection icon.
- Hover uses Mantine's semantic hover surface. Do not mutate `event.currentTarget.style` to create
  hover effects; use CSS or declarative state so rerenders cannot erase them.
- Long names must use `minWidth: 0` plus `truncate`, `lineClamp`, or ellipsis. Expose the full value
  with `title` or a tooltip.
- Do not add a horizontal scrollbar to a card merely because a name is long. Horizontal scrolling
  is acceptable for genuinely wide data tables and plot canvases.
- Tables use compact `sm` text, clear column headers, and right alignment for comparable numeric
  values. Avoid decorative zebra striping unless it materially improves a dense table.
- Tree indentation, chevrons, selection, drag target, and action placement should reuse
  `FolderTree` patterns.
- Series lists use the series color/symbol, a truncated name, an explicit visibility control, and
  compact edit/delete actions.

## Page and analysis layout

The application shell is an invariant:

- header: 52 px before UI zoom;
- navigation width: 290 px before UI zoom;
- main content padding: `md`;
- UI zoom applies to chrome/layout, not to scientific export dimensions.

Pages normally begin with a title/action row, followed by one main work surface. Keep primary
actions at the right side of the title row.

Analysis plots follow the established three-part layout:

- sample/settings sidebar: approximately 330 px;
- central plot card: flexible, minimum width about 520 px and minimum height about 590 px;
- collapsible style panel: approximately 310 px.

Tab-specific analysis logic belongs in a separate component when it would materially grow
`AnalysisEditor.tsx`. Match the neighbouring plot tabs: automatic-identification/settings section,
series and axes, full export header, plot surface, style panel, and saved plots.

Long modal workflows may use `lg`/`xl` or a deliberate rem width. Small confirmation and naming
dialogs should not be oversized. For scrollable workflow modals, keep the decision header/footer
visible with sticky positioning; the user should not need to scroll back to find Save, Done, or
Cancel. Four actions is the practical maximum in one modal footer.

## Plot surfaces and exports

Plot chrome follows the application theme; Plotly paper does not. Plot backgrounds are persisted
presentation settings and default to white so figures and exports remain publication-ready in
both light and dark UI modes.

Default plot styling is owned by `DEFAULT_PLOT_STYLE` in
`features/analyses/editor/plotting/plotStyle.ts`. Important defaults:

- white paper and plot background;
- 2.5 px solid lines;
- markers hidden by default, 5 px when enabled;
- grid on, zero line off, frame off;
- tick/legend text 12 px and axis titles 14 px;
- no automatic dark-mode recoloring of traces or paper.

Every analysis plot must use the shared plot-style, axis, export, and filename helpers. The live
plot, thumbnail, image export, portable figure, and CSV/XLSX export must describe the same final
figure and visibility state. A new plot tab is incomplete if only its on-screen Plotly figure
works.

Simple single-axis families (DCIR, C-rate, chargeability, and steps) use
`plotting/plotLayout.ts:simpleCartesianLayout` and pass the final rendered traces into it. This
keeps manual ranges, tick modes, title standoffs, legend placement, dynamic margins, exports, and
saved previews on the same path. Numeric X controls should be hidden when a family deliberately
uses categorical X positions.

## Feedback and state

### Loading

- Preserve the last valid content during background refresh and dim it when appropriate.
- Avoid loader flashes for fast startup paths; use the existing delayed-loader patterns.
- Show one loader for one operation. A page-level loader and a plot-level loader must not visually
  stack for the same work.
- Use a realistic progress bar for multi-cell or multi-stage recognition when progress is known.
- Do not invent percentage progress from elapsed time.

### Empty, error, and success

- Empty states explain what is missing and offer the next relevant action.
- Inline errors use red `Alert`; mutation failures also use a concise notification.
- Warnings use yellow or orange according to the color meanings above.
- Success mutations use teal notifications.
- Do not show “No data” while a request is still loading or has failed.
- Keep notifications concise; detailed recovery instructions belong inline near the affected
  workflow.

### Unsaved and destructive state

- Unsaved/draft state is yellow and remains visually distinct from a saved teal state.
- Destructive actions require an impact-aware confirmation when they affect analyses, sources, or
  other durable state.
- Never use alarming red styling for reversible visibility toggles or ordinary removal from a
  view.

## Interaction, accessibility, and motion

- All controls must be keyboard reachable using the native Mantine element.
- Every icon-only control needs an accessible name.
- Preserve `Ctrl+A` in inputs and existing application shortcuts.
- Interactive analysis figures inherit navigation from the shared `Plot` wrapper: a mouse wheel
  and touchpad pinch zoom around the pointer, two-finger touchpad movement pans on both axes, and
  `Ctrl` + primary-button drag pans while ordinary Plotly drag behavior remains available. Do not
  reimplement these gestures per analysis family. Families that retain or refine a user viewport
  must pass their existing pointer-intent callback through the wrapper so synthetic relayouts keep
  the same debounce and persistence semantics as Plotly-owned interactions.
- Use `nowrap` deliberately and give flexible text children `minWidth: 0`.
- Do not make hover the only way to discover a necessary action.
- Keep motion functional and short. The established 160 ms plot-refresh fade, spinners, progress
  animation, menu transitions, and modal transitions are sufficient. Do not add decorative
  bouncing, pulsing, or long easing sequences.
- Maintain usable contrast in Auto, Light, and Dark. Selected, disabled, warning, and error states
  all need to remain legible in both schemes.

## Implementation recipes

Theme-safe nested card:

```tsx
<Paper
  withBorder
  radius="md"
  p="sm"
  bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
>
  ...
</Paper>
```

Compact section header:

```tsx
<Group justify="space-between" gap="xs" wrap="nowrap">
  <Text size="sm" fw={700} truncate>
    Step series
  </Text>
  <Button size="compact-xs" leftSection={<IconPlus size={12} />}>
    Add series
  </Button>
</Group>
```

Icon row action:

```tsx
<Tooltip label="Hide series">
  <ActionIcon
    size="sm"
    variant="subtle"
    color="teal"
    aria-label="Hide series"
  >
    <IconEye size={14} />
  </ActionIcon>
</Tooltip>
```

## UI implementation checklist

Before considering UI work complete, check:

1. The closest existing component was reused or intentionally matched.
2. Button sizes, variants, icon sizes, typography, spacing, and radius follow this guide.
3. Chrome uses semantic or `light-dark(...)` colors; no new chrome hex literals or bare pale
   numbered backgrounds were introduced.
4. Light, Dark, and Auto states are accounted for. Plot paper remains independent.
5. Long labels truncate without adding accidental horizontal scrolling.
6. Loading, empty, error, disabled, unsaved, and success states are distinct.
7. Icon-only controls have tooltips/accessible labels and actions remain keyboard reachable.
8. Analysis plots support the shared live, thumbnail, image, portable, and data-export paths.
9. TypeScript/build checks pass; visual browser verification is performed when requested or
   required by the active spec.

When a new durable visual pattern is intentionally introduced, update this guide and its shared
component in the same change. Do not document one-off exceptions as general rules.
