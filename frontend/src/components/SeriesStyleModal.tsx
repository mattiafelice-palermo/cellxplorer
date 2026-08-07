import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  ColorInput,
  ColorPicker,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconList,
  IconPlus,
  IconRotate,
  IconSwitchHorizontal,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  PlotLineDash,
  PlotMarkerMode,
  PlotMarkerSymbol,
  PlotStyle,
  SeriesStyleOverride,
  SeriesStyleRule,
} from "../api";
import {
  DEFAULT_SHADOW,
  SERIES_RULE_FIELDS,
  SERIES_RULE_OPERATORS,
  emptySeriesRule,
  isEmptyOverride,
  isSecondarySeries,
  matchingRules,
  pruneOverrides,
  resolveAllSeriesStyles,
  seriesRuleError,
  type BaseSeriesStyle,
  type ResolvedSeriesStyle,
  type SeriesDescriptor,
} from "../seriesStyling";
import { PALETTE_OPTIONS, PLOT_PALETTES, plotPalette } from "../plotStyle";
import {
  builtInPaletteSelection,
  customPaletteSelection,
  duplicatePaletteColor,
  movePaletteColor,
  removePaletteColor,
  reversePalette,
  savedPaletteSelection,
  seriesWithOwnColour,
  setPaletteColor,
  type PaletteSelection,
} from "../paletteDraft";
import Plot from "./Plot";

/** The real plot, rebuilt with the draft styling applied. */
export type SeriesPreviewBuilder = (draft: {
  overrides: Record<string, SeriesStyleOverride>;
  rules: SeriesStyleRule[];
  /** Uncommitted style fields to preview, e.g. a palette being composed. */
  styleOverlay?: Partial<PlotStyle>;
}) => { data: unknown[]; layout: Record<string, unknown> };

const DASH_OPTIONS: { value: PlotLineDash; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dot", label: "Dotted" },
  { value: "dash", label: "Dashed" },
  { value: "longdash", label: "Long dash" },
];

const SYMBOL_OPTIONS: { value: PlotMarkerSymbol; label: string }[] = [
  { value: "circle", label: "Circle" },
  { value: "square", label: "Square" },
  { value: "diamond", label: "Diamond" },
  { value: "triangle-up", label: "Triangle" },
  { value: "cross", label: "Cross" },
  { value: "x", label: "X" },
];

const MARKER_MODE_OPTIONS: { value: PlotMarkerMode; label: string }[] = [
  { value: "none", label: "Line only" },
  { value: "points", label: "Points only" },
  { value: "lines_points", label: "Line + points" },
];

/** Fixed so the plot never relayouts when the right-hand content changes. */
const PREVIEW_WIDTH = 620;
const PREVIEW_HEIGHT = 465; // 4:3 aspect ratio
/**
 * The pseudo-entry that edits the tab's base style.
 *
 * Every series resolves from that base, so editing it is "style everything at
 * once" — the job the sidebar's global Lines section used to do. Putting it at
 * the head of the same list keeps one place and one mental model, and cannot
 * collide with a real series key (those are `c…`, `g…`, `dcir-…`, and so on).
 */
export const ALL_SERIES_KEY = "__all_series__";

const SERIES_PANEL_WIDTH = 260;
/**
 * Collapsed: swatch and visibility only, which is what picking a series needs.
 * Wide enough to keep the "Series" heading and the chevron on one line.
 */
const SERIES_PANEL_COLLAPSED_WIDTH = 104;

/** Commit delay: long enough to swallow a colour drag, short enough to feel live. */
const COMMIT_DEBOUNCE_MS = 250;
/**
 * A held-key repeat can be slower than the other style controls' debounce.
 * Keep legend edits local until there has been a real pause; committing the
 * draft rebuilds the modal preview and the analysis plot.
 */
const LEGEND_NAME_DEBOUNCE_MS = 500;

/** Neutral starting colour for a freshly added palette swatch. */
const NEW_PALETTE_COLOR = "#868e96";

/** Maximum number of colours a palette can hold. */
export const MAX_PALETTE_COLOURS = 20;

/**
 * Which preset the plot's current palette corresponds to, for seeding the
 * scratch palette and its `Select`.
 *
 * A saved palette wins if `palette_id` is set (even if that palette has since
 * been deleted — then the resolved colours are used as a one-off custom
 * selection). Otherwise it's a built-in preset, or a hand-edited custom list.
 */
function currentPaletteSelection(
  style: PlotStyle,
  palettes: { id: string; colors: string[] }[] | undefined,
): PaletteSelection {
  if (style.palette_id) {
    const saved = palettes?.find((p) => p.id === style.palette_id);
    return savedPaletteSelection(style.palette_id, saved?.colors ?? plotPalette(style));
  }
  if (style.palette === "custom") {
    return customPaletteSelection(plotPalette(style));
  }
  return builtInPaletteSelection(style.palette);
}

/**
 * Whether two colour lists differ, so the modal knows whether the scratch
 * palette being composed has actually diverged from the plot's current one.
 */
function palettesDiffer(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((color, index) => color !== b[index]);
}

/**
 * Editor for how each series is drawn.
 *
 * Edits are held locally and pushed to the analysis spec on a debounce. Writing
 * every keystroke straight through re-rendered the whole analysis page and
 * rebuilt the main plot behind the modal, which made a colour drag crawl.
 */
export function SeriesStyleModal({
  opened,
  onClose,
  descriptors,
  overrides,
  rules,
  baseFor,
  buildPreview,
  onChange,
  baseStyle,
  onBaseChange,
  palettes,
  onApplyPalette,
  onSavePalette,
}: {
  opened: boolean;
  onClose: () => void;
  descriptors: SeriesDescriptor[];
  overrides: Record<string, SeriesStyleOverride>;
  rules: SeriesStyleRule[];
  /** Palette colour and tab defaults for a series, before overrides. */
  baseFor: (descriptor: SeriesDescriptor) => BaseSeriesStyle;
  buildPreview: SeriesPreviewBuilder;
  onChange: (next: {
    overrides: Record<string, SeriesStyleOverride>;
    rules: SeriesStyleRule[];
  }) => void;
  /**
   * The tab's base style, edited through the "All series" entry. This is the
   * bottom layer every series resolves from, so it belongs in the same place
   * as the per-series settings rather than in a separate sidebar section.
   */
  baseStyle: PlotStyle;
  onBaseChange: (fn: (style: PlotStyle) => void) => void;
  /** User-saved palettes, shown below the built-in ones in the Palettes tab. */
  palettes?: { id: string; name: string; kind: string; colors: string[] }[];
  /**
   * Applies a palette's colours to every series. `paletteId` is the saved
   * palette's id, or null for a built-in palette. Omitting this prop hides
   * the Palettes tab entirely — the panel has no way to apply a palette
   * without it.
   */
  onApplyPalette?: (colors: string[], paletteId: string | null) => void;
  /** Saves the currently resolved series colours as a new named palette. */
  onSavePalette?: (name: string, colors: string[]) => void;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>("series");
  const [seriesCollapsed, setSeriesCollapsed] = useState(false);
  const [paletteSaveName, setPaletteSaveName] = useState("");

  // The palette being composed. Purely local scratch state: it only reaches
  // the plot when "Apply palette" calls `onApplyPalette`. Everything else in
  // this modal is live-editing, but a palette is a set of colours edited as a
  // unit, so committing colour-by-colour would flash a half-built palette
  // onto the real plot on every click.
  const [scratchColors, setScratchColors] = useState<string[]>(() => plotPalette(baseStyle));
  const [paletteSelection, setPaletteSelection] = useState<PaletteSelection>(() =>
    currentPaletteSelection(baseStyle, palettes),
  );
  const [selectedSwatch, setSelectedSwatch] = useState(0);

  /**
   * Stable per-slot ids for the palette swatches, parallel to `scratchColors`.
   *
   * Colours can repeat (the same hex twice in one palette), so dnd-kit's
   * sortable items and React's list keys cannot be keyed by colour value —
   * two swatches with the same colour would collide. Each slot gets a unique
   * id once, generated here, and every mutation below (move, duplicate,
   * delete, add, reverse, drag) applies the identical operation to this array
   * in lockstep with `scratchColors`, so index `i` in one array always
   * describes the same physical swatch as index `i` in the other.
   */
  const nextSwatchIdRef = useRef(0);
  const genSwatchId = useCallback(() => `swatch-${nextSwatchIdRef.current++}`, []);
  const genSwatchIds = useCallback(
    (count: number) => Array.from({ length: count }, () => genSwatchId()),
    [genSwatchId],
  );
  const [swatchIds, setSwatchIds] = useState<string[]>(() => genSwatchIds(scratchColors.length));
  // Which swatch's colour-picker popover is open, if any. Only one at a time —
  // opening a different swatch's popover, or any structural change to the
  // palette (add/remove/duplicate/reverse/preset/drag), closes it.
  const [openSwatchIndex, setOpenSwatchIndex] = useState<number | null>(null);

  // Local draft. The spec is only written on a debounce and on close.
  const [draftOverrides, setDraftOverrides] = useState(overrides);
  const [draftRules, setDraftRules] = useState(rules);
  // Draft of the "All series" base style, kept local for the same reason as
  // the per-series draft above: writing straight to `onBaseChange` on every
  // control re-renders the whole analysis page and rebuilds the main plot on
  // every drag tick.
  const [draftBaseStyle, setDraftBaseStyle] = useState(baseStyle);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ overrides: Record<string, SeriesStyleOverride>; rules: SeriesStyleRule[] } | null>(
    null,
  );
  const baseCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBase = useRef<PlotStyle | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBaseChangeRef = useRef(onBaseChange);
  onBaseChangeRef.current = onBaseChange;

  useEffect(() => {
    if (!opened) return;
    setDraftOverrides(overrides);
    setDraftRules(rules);
    setDraftBaseStyle(baseStyle);
    setActiveKey((current) =>
      current === ALL_SERIES_KEY || (current && descriptors.some((d) => d.key === current))
        ? current
        : ALL_SERIES_KEY,
    );
    setScratchColors(plotPalette(baseStyle));
    setSwatchIds(genSwatchIds(plotPalette(baseStyle).length));
    setPaletteSelection(currentPaletteSelection(baseStyle, palettes));
    setSelectedSwatch(0);
    setOpenSwatchIndex(null);
    // Only when the dialog opens: re-syncing on every prop change would fight
    // the debounce and undo edits mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  /** Restores the scratch palette to the plot's currently-applied one. */
  const resetScratchPalette = useCallback(() => {
    const colors = plotPalette(baseStyle);
    setScratchColors(colors);
    setSwatchIds(genSwatchIds(colors.length));
    setPaletteSelection(currentPaletteSelection(baseStyle, palettes));
    setSelectedSwatch(0);
    setOpenSwatchIndex(null);
  }, [baseStyle, palettes, genSwatchIds]);

  const duplicateScratchSwatch = () => {
    const next = duplicatePaletteColor(scratchColors, selectedSwatch);
    if (next === scratchColors) return;
    setScratchColors(next);
    // Not `duplicatePaletteColor` on the id array: that would duplicate the
    // id too, and two swatches must never share one — each gets a fresh id.
    setSwatchIds((ids) => {
      const nextIds = [...ids];
      nextIds.splice(selectedSwatch + 1, 0, genSwatchId());
      return nextIds;
    });
    setPaletteSelection(customPaletteSelection(next));
    setSelectedSwatch(selectedSwatch + 1);
    setOpenSwatchIndex(null);
  };

  /**
   * Removes the colour at `index` (defaults to the selected swatch, for the
   * toolbar's keyboard-reachable actions). Used by the per-swatch × button
   * and by Delete/Backspace on a focused swatch, as well as the toolbar.
   */
  const removeSwatchAt = (index: number) => {
    const next = removePaletteColor(scratchColors, index);
    if (next === scratchColors) return;
    setScratchColors(next);
    setSwatchIds((ids) => removePaletteColor(ids, index));
    setPaletteSelection(customPaletteSelection(next));
    setSelectedSwatch((current) => {
      const adjusted = index < current ? current - 1 : current;
      return Math.min(adjusted, next.length - 1);
    });
    setOpenSwatchIndex(null);
  };

  const addScratchSwatch = () => {
    const next = [...scratchColors, NEW_PALETTE_COLOR];
    setScratchColors(next);
    setSwatchIds((ids) => [...ids, genSwatchId()]);
    setPaletteSelection(customPaletteSelection(next));
    setSelectedSwatch(next.length - 1);
    setOpenSwatchIndex(null);
  };

  /** Edits the colour at `index` through the shared normalising helper. */
  const editScratchSwatchAt = (index: number, value: string) => {
    const next = setPaletteColor(scratchColors, index, value);
    if (next === scratchColors) return;
    setScratchColors(next);
    setPaletteSelection(customPaletteSelection(next));
  };

  const reverseScratchPalette = () => {
    const next = reversePalette(scratchColors);
    setScratchColors(next);
    setSwatchIds((ids) => reversePalette(ids));
    setPaletteSelection(customPaletteSelection(next));
    setSelectedSwatch((index) => next.length - 1 - index);
    setOpenSwatchIndex(null);
  };

  /** Reorders the palette via the existing pure helper, driven by drag-and-drop. */
  const reorderScratchSwatch = (from: number, to: number) => {
    const next = movePaletteColor(scratchColors, from, to);
    if (next === scratchColors) return;
    setScratchColors(next);
    setSwatchIds((ids) => movePaletteColor(ids, from, to));
    setPaletteSelection(customPaletteSelection(next));
    setSelectedSwatch(to);
  };

  const handleSwatchDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = swatchIds.indexOf(String(active.id));
    const to = swatchIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    reorderScratchSwatch(from, to);
  };

  /** A real drag beginning always closes whichever swatch's popover is open. */
  const handleSwatchDragStart = () => setOpenSwatchIndex(null);

  const swatchSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const applyPreset = (value: string | null) => {
    if (!value) return;
    if (value.startsWith("builtin:")) {
      const key = value.slice("builtin:".length) as PlotStyle["palette"];
      const colors = PLOT_PALETTES[key] ?? PLOT_PALETTES.app;
      setScratchColors(colors);
      setSwatchIds(genSwatchIds(colors.length));
      setPaletteSelection(builtInPaletteSelection(key));
      setSelectedSwatch(0);
      setOpenSwatchIndex(null);
    } else if (value.startsWith("saved:")) {
      const id = value.slice("saved:".length);
      const saved = palettes?.find((p) => p.id === id);
      if (!saved) return;
      setScratchColors([...saved.colors]);
      setSwatchIds(genSwatchIds(saved.colors.length));
      setPaletteSelection(savedPaletteSelection(id, saved.colors));
      setSelectedSwatch(0);
      setOpenSwatchIndex(null);
    }
  };

  const applyScratchPalette = () => {
    onApplyPalette?.(scratchColors, paletteSelection.palette_id);
  };

  const flush = useCallback(() => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    if (pending.current) {
      onChangeRef.current(pending.current);
      pending.current = null;
    }
    if (baseCommitTimer.current) {
      clearTimeout(baseCommitTimer.current);
      baseCommitTimer.current = null;
    }
    if (pendingBase.current) {
      const toApply = pendingBase.current;
      pendingBase.current = null;
      onBaseChangeRef.current((next) => void Object.assign(next, toApply));
    }
  }, []);

  useEffect(() => () => flush(), [flush]);

  const commit = useCallback(
    (nextOverrides: Record<string, SeriesStyleOverride>, nextRules: SeriesStyleRule[]) => {
      setDraftOverrides(nextOverrides);
      setDraftRules(nextRules);
      pending.current = { overrides: nextOverrides, rules: nextRules };
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => {
        commitTimer.current = null;
        if (pending.current) {
          onChangeRef.current(pending.current);
          pending.current = null;
        }
      }, COMMIT_DEBOUNCE_MS);
    },
    [],
  );

  // Same debounce as `commit` above, kept on its own timer since the base
  // style and the per-series draft are independent and can be edited
  // without the other's pending edit resetting its delay.
  const commitBaseStyle = useCallback((next: PlotStyle) => {
    setDraftBaseStyle(next);
    pendingBase.current = next;
    if (baseCommitTimer.current) clearTimeout(baseCommitTimer.current);
    baseCommitTimer.current = setTimeout(() => {
      baseCommitTimer.current = null;
      if (pendingBase.current) {
        const toApply = pendingBase.current;
        pendingBase.current = null;
        onBaseChangeRef.current((next) => void Object.assign(next, toApply));
      }
    }, COMMIT_DEBOUNCE_MS);
  }, []);

  const patchBaseStyle = (patch: Partial<PlotStyle>) =>
    commitBaseStyle({ ...draftBaseStyle, ...patch });

  const handleClose = () => {
    flush();
    onClose();
  };

  const isAllSeries = activeKey === ALL_SERIES_KEY;

  const active = useMemo(
    () =>
      isAllSeries ? null : descriptors.find((d) => d.key === activeKey) ?? descriptors[0] ?? null,
    [descriptors, activeKey, isAllSeries],
  );

  const resolvedByKey = useMemo(
    () =>
      resolveAllSeriesStyles({
        descriptors,
        baseFor,
        rules: draftRules,
        overrides: draftOverrides,
        linkSecondaryColors: draftBaseStyle.link_secondary_colors ?? false,
        secondaryNameMode: draftBaseStyle.secondary_name_mode ?? "independent",
        secondaryNameSuffix: draftBaseStyle.secondary_name_suffix ?? null,
      }),
    [
      descriptors,
      draftRules,
      draftOverrides,
      baseFor,
      draftBaseStyle.link_secondary_colors,
      draftBaseStyle.secondary_name_mode,
      draftBaseStyle.secondary_name_suffix,
    ],
  );

  // Current resolved colour of every series, in list order and de-duplicated,
  // for "Save current colours as palette…".
  const currentSeriesColors = useMemo(() => {
    const seen = new Set<string>();
    const colors: string[] = [];
    for (const descriptor of descriptors) {
      const color = resolvedByKey.get(descriptor.key)?.color;
      if (color && !seen.has(color)) {
        seen.add(color);
        colors.push(color);
      }
    }
    return colors;
  }, [descriptors, resolvedByKey]);

  /**
   * Series grouped by plot, then by quantity label or axis, in that order.
   *
   * On most tabs every descriptor is plot 0 / axis "y" — a single group — and
   * `heading` is left `null` for all of them so nothing renders: there is
   * nothing to disambiguate. A heading only appears once a second plot or a
   * secondary quantity/axis is actually present.
   */
  const seriesGroups = useMemo(() => {
    const groups = new Map<string, { plot: number; axis: "y" | "y2"; measureLabel?: string; items: SeriesDescriptor[] }>();
    for (const descriptor of descriptors) {
      const plot = descriptor.plot ?? 0;
      const axis = descriptor.axis ?? "y";
      const measureLabel = descriptor.measureLabel;
      const key = `${plot}:${measureLabel ?? axis ?? "y"}`;
      let group = groups.get(key);
      if (!group) {
        group = { plot, axis, measureLabel, items: [] };
        groups.set(key, group);
      }
      group.items.push(descriptor);
    }
    const ordered = Array.from(groups.values()).sort((a, b) => {
      if (a.plot !== b.plot) return a.plot - b.plot;
      if (a.axis === b.axis) return 0;
      return a.axis === "y" ? -1 : 1;
    });
    const multiPlot = new Set(ordered.map((g) => g.plot)).size > 1;
    const showHeadings = ordered.length > 1;
    return ordered.map((group) => ({
      key: `${group.plot}:${group.measureLabel ?? group.axis ?? "y"}`,
      heading: showHeadings
        ? `${multiPlot ? `Plot ${group.plot + 1} · ` : ""}${
            group.measureLabel ?? (group.axis === "y2" ? "Right axis" : "Left axis")
          }`
        : null,
      items: group.items,
    }));
  }, [descriptors]);

  const setOverride = (key: string, patch: SeriesStyleOverride) =>
    commit(
      pruneOverrides({ ...draftOverrides, [key]: { ...(draftOverrides[key] ?? {}), ...patch } }),
      draftRules,
    );

  // The legend input is memoized so background/query-driven parent renders do
  // not make Mantine reconcile the controlled input while a key is repeating.
  // Keep this callback stable for the same reason; the ref always points to
  // the latest draft-aware setter.
  const setOverrideRef = useRef(setOverride);
  setOverrideRef.current = setOverride;
  const commitLegendName = useCallback(
    (next: string) => {
      if (!activeKey) return;
      setOverrideRef.current(activeKey, { name: next || null });
    },
    [activeKey],
  );

  const clearOverride = (key: string) => {
    const next = { ...draftOverrides };
    delete next[key];
    commit(next, draftRules);
  };

  // Series with their own explicit colour that a palette apply cannot touch.
  const seriesOwningColour = useMemo(() => seriesWithOwnColour(draftOverrides), [draftOverrides]);

  const clearSeriesColours = () => {
    if (seriesOwningColour.length === 0) return;
    let next = draftOverrides;
    for (const key of seriesOwningColour) {
      next = { ...next, [key]: { ...next[key], color: null } };
    }
    commit(pruneOverrides(next), draftRules);
  };

  // "Preset palette" dropdown data: built-in presets, then saved palettes.
  const presetSelectData = useMemo(() => {
    const groups: { group: string; items: { value: string; label: string }[] }[] = [
      {
        group: "Built-in",
        items: PALETTE_OPTIONS.filter((option) => option.value !== "custom").map((option) => ({
          value: `builtin:${option.value}`,
          label: option.label,
        })),
      },
    ];
    if (palettes && palettes.length > 0) {
      groups.push({
        group: "Saved palettes",
        items: palettes.map((palette) => ({ value: `saved:${palette.id}`, label: palette.name })),
      });
    }
    return groups;
  }, [palettes]);
  const presetSelectValue = paletteSelection.palette_id
    ? `saved:${paletteSelection.palette_id}`
    : paletteSelection.palette !== "custom"
      ? `builtin:${paletteSelection.palette}`
      : null;

  const setRules = (nextRules: SeriesStyleRule[]) => commit(draftOverrides, nextRules);

  const patchRule = (id: string, patch: Partial<SeriesStyleRule>) =>
    setRules(draftRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  const patchRuleStyle = (id: string, patch: SeriesStyleOverride) =>
    setRules(
      draftRules.map((rule) =>
        rule.id === id ? { ...rule, style: { ...rule.style, ...patch } } : rule,
      ),
    );

  const moveRule = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draftRules.length) return;
    const next = [...draftRules];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setRules(next);
  };

  // Deferred so dragging a colour or holding a spinner stays responsive: the
  // controls update immediately and the plot catches up a frame later.
  const previewOverrides = useDeferredValue(draftOverrides);
  const previewRules = useDeferredValue(draftRules);

  // The scratch palette only reaches the preview while it's actually being
  // composed and it differs from what's already applied — otherwise the
  // overlay would be a needless no-op copy of the committed palette.
  const scratchPaletteDirty = useMemo(
    () => palettesDiffer(scratchColors, plotPalette(baseStyle)),
    [scratchColors, baseStyle],
  );
  const paletteOverlay = useMemo<Partial<PlotStyle> | undefined>(
    () =>
      tab === "palettes" && scratchPaletteDirty
        ? { palette: "custom", palette_id: null, palette_colors: scratchColors }
        : undefined,
    [tab, scratchPaletteDirty, scratchColors],
  );
  const preview = useMemo(
    () =>
      opened
        ? buildPreview({ overrides: previewOverrides, rules: previewRules, styleOverlay: paletteOverlay })
        : { data: [], layout: {} },
    [opened, buildPreview, previewOverrides, previewRules, paletteOverlay],
  );

  /**
   * Stable object identities for Plotly.
   *
   * `react-plotly.js` compares `layout` and `config` by reference. Building
   * them inline meant every render — every keystroke, every tab switch —
   * handed Plotly a new object and forced a full relayout of the whole plot.
   * That, not the state updates, was the lag.
   */
  const previewLayout = useMemo(
    () => ({
      ...preview.layout,
      autosize: false,
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      showlegend: false,
      legend: undefined,
      margin: { l: 64, r: 64, t: 16, b: 56 },
    }),
    [preview.layout],
  );
  const previewConfig = useMemo(() => ({ displayModeBar: false, responsive: true }), []);
  const previewStyle = useMemo(
    () => ({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }),
    [],
  );

  const activeOverride = active ? draftOverrides[active.key] ?? {} : {};
  const activeResolved = active ? resolvedByKey.get(active.key) : null;
  const activeRules = active ? matchingRules(active, draftRules) : [];
  const markerMode = activeResolved?.markerMode ?? "none";
  const lineEnabled = markerMode !== "points";
  const markersEnabled = markerMode !== "none";
  const baseLineEnabled = draftBaseStyle.marker_mode !== "points";
  const baseMarkersEnabled = draftBaseStyle.marker_mode !== "none";
  const activeIsSecondary = active ? isSecondarySeries(active) : false;
  const activeLinkColor = active
    ? draftOverrides[active.key]?.link_color ?? draftBaseStyle.link_secondary_colors ?? false
    : false;

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Series appearance"
      size="94rem"
      styles={{ content: { height: "min(58rem, 94vh)", display: "flex", flexDirection: "column" } }}
    >
      <Group align="stretch" gap="sm" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        {/* The plot is deliberately fixed width and height. It used to share the row with
            flexible panels, so switching to Rules — whose controls are wider —
            resized the plot and forced Plotly to relayout on every tab change. */}
        <PreviewPanel
          preview={preview}
          previewLayout={previewLayout}
          previewConfig={previewConfig}
          previewStyle={previewStyle}
          resolvedByKey={resolvedByKey}
          descriptors={descriptors}
        />

        <PanelShell
          title="Series"
          right={
            <Group gap={4} wrap="nowrap">
              {!seriesCollapsed && (
                <Badge size="xs" variant="light">
                  {descriptors.length}
                </Badge>
              )}
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label={seriesCollapsed ? "Expand series list" : "Collapse series list"}
                onClick={() => setSeriesCollapsed((current) => !current)}
              >
                {seriesCollapsed ? <IconChevronRight size={15} /> : <IconChevronLeft size={15} />}
              </ActionIcon>
            </Group>
          }
          style={{
            width: seriesCollapsed ? SERIES_PANEL_COLLAPSED_WIDTH : SERIES_PANEL_WIDTH,
            flex: "none",
          }}
        >
          <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
            <Stack gap={2}>
              <Tooltip
                label="All series"
                disabled={!seriesCollapsed}
                position="right"
                withArrow
              >
                <Group
                  gap={6}
                  wrap="nowrap"
                  px={6}
                  py={4}
                  justify={seriesCollapsed ? "center" : undefined}
                  onClick={() => setActiveKey(ALL_SERIES_KEY)}
                  style={{
                    borderRadius: 4,
                    cursor: "pointer",
                    background: isAllSeries ? "var(--mantine-primary-color-light)" : undefined,
                  }}
                >
                  <Text size="xs" fw={600} truncate style={{ flex: seriesCollapsed ? "none" : 1 }}>
                    {seriesCollapsed ? "All" : "All series"}
                  </Text>
                </Group>
              </Tooltip>
              <Divider my={2} />
              {seriesGroups.map((group) => (
                <Fragment key={group.key}>
                  {group.heading && !seriesCollapsed && (
                    <Text
                      size="9px"
                      fw={700}
                      c="dimmed"
                      tt="uppercase"
                      px={6}
                      pt={6}
                      pb={2}
                      style={{ letterSpacing: 0.4 }}
                    >
                      {group.heading}
                    </Text>
                  )}
                  {group.items.map((descriptor) => {
                    const style = resolvedByKey.get(descriptor.key);
                    const customised = !isEmptyOverride(draftOverrides[descriptor.key]);
                    const swatch = (
                      <div
                        aria-hidden="true"
                        style={{
                          width: 14,
                          height: 3,
                          borderRadius: 2,
                          flex: "none",
                          background: style?.color ?? "#888",
                        }}
                      />
                    );
                    const visibility = (
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="gray"
                        aria-label={
                          style?.hidden ? `Show ${descriptor.label}` : `Hide ${descriptor.label}`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          setOverride(descriptor.key, { hidden: !style?.hidden });
                        }}
                      >
                        {style?.hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                      </ActionIcon>
                    );
                    return (
                      <Tooltip
                        key={descriptor.key}
                        label={style?.name ?? descriptor.label}
                        disabled={!seriesCollapsed}
                        position="right"
                        withArrow
                      >
                        <Group
                          gap={6}
                          wrap="nowrap"
                          px={6}
                          py={4}
                          justify={seriesCollapsed ? "center" : undefined}
                          onClick={() => setActiveKey(descriptor.key)}
                          style={{
                            borderRadius: 4,
                            cursor: "pointer",
                            background:
                              descriptor.key === active?.key
                                ? "var(--mantine-primary-color-light)"
                                : undefined,
                            opacity: style?.hidden ? 0.5 : 1,
                          }}
                        >
                          {swatch}
                          {!seriesCollapsed && (
                            <>
                              <Text size="xs" truncate style={{ flex: 1 }} title={style?.name}>
                                {style?.name ?? descriptor.label}
                              </Text>
                              {customised && (
                                <Tooltip label="Has its own settings">
                                  <Badge size="xs" variant="light" color="grape" circle>
                                    {" "}
                                  </Badge>
                                </Tooltip>
                              )}
                            </>
                          )}
                          {visibility}
                        </Group>
                      </Tooltip>
                    );
                  })}
                </Fragment>
              ))}
            </Stack>
          </ScrollArea>
        </PanelShell>

        <PanelShell
          title={tab === "rules" ? "Rules" : tab === "palettes" ? "Palettes" : "Appearance"}
          // minWidth 0 matters: without it the wider Rules controls set the
          // panel's min-content width and stole space from the plot.
          style={{ flex: "1 1 0", minWidth: 0 }}
          bodyPadding={0}
          right={
            <Tabs value={tab} onChange={setTab} variant="pills">
              <Tabs.List>
                <Tabs.Tab value="series">Series</Tabs.Tab>
                <Tabs.Tab value="rules">
                  Rules{draftRules.length ? ` (${draftRules.length})` : ""}
                </Tabs.Tab>
                {onApplyPalette && <Tabs.Tab value="palettes">Palettes</Tabs.Tab>}
              </Tabs.List>
            </Tabs>
          }
        >
          {tab === "rules" ? (
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="sm" p="xs">
                <Group justify="space-between" wrap="nowrap">
                  <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                    Style many series at once. Later rules win over earlier ones, and anything set on
                    an individual series wins over all of them.
                  </Text>
                  <Button
                    size="compact-xs"
                    leftSection={<IconPlus size={13} />}
                    onClick={() => setRules([...draftRules, emptySeriesRule()])}
                  >
                    Add rule
                  </Button>
                </Group>

                {draftRules.length === 0 && (
                  <Alert color="gray" p="xs">
                    <Text size="xs">
                      No rules yet. A rule like “replicate group contains 25C → colour blue” styles
                      every matching series at once.
                    </Text>
                  </Alert>
                )}

                {draftRules.map((rule, index) => {
                  const error = seriesRuleError(rule);
                  const matched = descriptors.filter((d) => matchingRules(d, [rule]).length > 0);
                  return (
                    <Paper key={rule.id} withBorder p="xs">
                      <Stack gap="xs">
                        <Group gap="xs" wrap="nowrap">
                          <Switch
                            size="xs"
                            checked={rule.enabled}
                            aria-label="Enable rule"
                            onChange={(event) =>
                              patchRule(rule.id, { enabled: event.currentTarget.checked })
                            }
                          />
                          <Badge size="xs" variant="light" color={matched.length ? "blue" : "gray"}>
                            {matched.length} match{matched.length === 1 ? "" : "es"}
                          </Badge>
                          <div style={{ flex: 1 }} />
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            aria-label="Move rule up"
                            disabled={index === 0}
                            onClick={() => moveRule(index, -1)}
                          >
                            <IconArrowUp size={14} />
                          </ActionIcon>
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            aria-label="Move rule down"
                            disabled={index === draftRules.length - 1}
                            onClick={() => moveRule(index, 1)}
                          >
                            <IconArrowDown size={14} />
                          </ActionIcon>
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="red"
                            aria-label="Delete rule"
                            onClick={() => setRules(draftRules.filter((r) => r.id !== rule.id))}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Group>

                        <Group gap="xs" wrap="nowrap" align="end">
                          <Select
                            size="xs"
                            w={140}
                            data={SERIES_RULE_FIELDS}
                            allowDeselect={false}
                            value={rule.field}
                            onChange={(value) =>
                              patchRule(rule.id, { field: (value as typeof rule.field) ?? "label" })
                            }
                          />
                          <Select
                            size="xs"
                            w={140}
                            data={SERIES_RULE_OPERATORS}
                            allowDeselect={false}
                            value={rule.operator}
                            onChange={(value) =>
                              patchRule(rule.id, {
                                operator: (value as typeof rule.operator) ?? "contains",
                              })
                            }
                          />
                          <TextInput
                            size="xs"
                            style={{ flex: 1 }}
                            placeholder="Value"
                            error={error ?? undefined}
                            value={rule.value}
                            onChange={(event) =>
                              patchRule(rule.id, { value: event.currentTarget.value })
                            }
                          />
                        </Group>

                        <Group gap="xs" wrap="wrap" align="end">
                          <ColorInput
                            size="xs"
                            w={150}
                            label="Colour"
                            format="hex"
                            placeholder="unchanged"
                            value={rule.style.color ?? ""}
                            onChange={(value) => patchRuleStyle(rule.id, { color: value || null })}
                          />
                          <Select
                            size="xs"
                            w={130}
                            label="Line style"
                            placeholder="unchanged"
                            clearable
                            data={MARKER_MODE_OPTIONS}
                            value={rule.style.marker_mode ?? null}
                            onChange={(value) =>
                              patchRuleStyle(rule.id, { marker_mode: (value as PlotMarkerMode) ?? null })
                            }
                          />
                          <Select
                            size="xs"
                            w={120}
                            label="Dash"
                            placeholder="unchanged"
                            clearable
                            data={DASH_OPTIONS}
                            value={rule.style.line_dash ?? null}
                            onChange={(value) =>
                              patchRuleStyle(rule.id, { line_dash: (value as PlotLineDash) ?? null })
                            }
                          />
                          <NumberInput
                            size="xs"
                            w={100}
                            label="Width"
                            placeholder="—"
                            min={0.5}
                            max={12}
                            step={0.5}
                            decimalScale={1}
                            value={rule.style.line_width ?? ""}
                            onChange={(value) =>
                              patchRuleStyle(rule.id, {
                                line_width: value === "" ? null : Number(value),
                              })
                            }
                          />
                          <Select
                            size="xs"
                            w={130}
                            label="Symbol"
                            placeholder="unchanged"
                            clearable
                            data={SYMBOL_OPTIONS}
                            value={rule.style.marker_symbol ?? null}
                            onChange={(value) =>
                              patchRuleStyle(rule.id, {
                                marker_symbol: (value as PlotMarkerSymbol) ?? null,
                              })
                            }
                          />
                        </Group>
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            </ScrollArea>
          ) : tab === "palettes" ? (
            <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
                <Stack gap="sm" p="xs">
                  <Text size="xs" c="dimmed">
                    Applies a full set of colours to every series at once. Changes here only reach the
                    plot once you apply them.
                  </Text>

                  <Group gap="xs" wrap="nowrap" align="end">
                    <Select
                      size="xs"
                      label="Preset palette"
                      placeholder="Custom"
                      style={{ flex: 1 }}
                      data={presetSelectData}
                      value={presetSelectValue}
                      onChange={applyPreset}
                      renderOption={({ option }) => {
                        const colors =
                          option.value?.startsWith("builtin:")
                            ? PLOT_PALETTES[(option.value.slice("builtin:".length) as PlotStyle["palette"]) ?? "app"]
                            : option.value?.startsWith("saved:")
                              ? palettes?.find((p) => p.id === option.value.slice("saved:".length))?.colors ?? []
                              : [];
                        return (
                          <Group gap={6} wrap="nowrap" style={{ flex: 1 }}>
                            <Text size="xs" style={{ flex: 1 }}>
                              {option.label}
                            </Text>
                            <Group gap={2} wrap="nowrap" style={{ flex: "none" }} aria-hidden="true">
                              {colors.slice(0, 8).map((color, index) => (
                                <div
                                  key={index}
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 2,
                                    flex: "none",
                                    background: color,
                                  }}
                                />
                              ))}
                            </Group>
                          </Group>
                        );
                      }}
                    />
                    <Tooltip label="Reverse palette order">
                      <ActionIcon
                        size="lg"
                        variant="default"
                        aria-label="Reverse palette order"
                        onClick={reverseScratchPalette}
                      >
                        <IconSwitchHorizontal size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>

                  <div>
                    <Group justify="space-between" align="center" mb={4}>
                      <Text size="xs" fw={700}>
                        Current palette
                      </Text>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label={scratchColors.length >= MAX_PALETTE_COLOURS ? "A palette can hold up to 20 colours" : "Duplicate colour"}>
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            aria-label="Duplicate colour"
                            disabled={scratchColors.length >= MAX_PALETTE_COLOURS}
                            onClick={duplicateScratchSwatch}
                          >
                            <IconCopy size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                    <Text size="9px" c="dimmed" mb={8}>
                      Click a colour to edit it. Drag to reorder, or focus a colour and press Space
                      then the arrow keys.
                    </Text>

                    <Group wrap="wrap" gap="xs" pb={4}>
                      <DndContext
                        sensors={swatchSensors}
                        collisionDetection={closestCenter}
                        onDragStart={handleSwatchDragStart}
                        onDragEnd={handleSwatchDragEnd}
                      >
                        <SortableContext items={swatchIds} strategy={rectSortingStrategy}>
                          {scratchColors.map((color, index) => (
                            <SortablePaletteSwatch
                              key={swatchIds[index]}
                              id={swatchIds[index]}
                              color={color}
                              index={index}
                              selected={index === selectedSwatch}
                              removeDisabled={scratchColors.length <= 1}
                              popoverOpened={index === openSwatchIndex}
                              onSelect={() => {
                                setSelectedSwatch(index);
                                setOpenSwatchIndex(index);
                              }}
                              onPopoverClose={() =>
                                setOpenSwatchIndex((current) => (current === index ? null : current))
                              }
                              onColorChange={(value) => editScratchSwatchAt(index, value)}
                              onRemove={() => removeSwatchAt(index)}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                      <Tooltip label={scratchColors.length >= MAX_PALETTE_COLOURS ? "A palette can hold up to 20 colours" : "Add colour"}>
                        <UnstyledButton
                          aria-label="Add colour"
                          onClick={addScratchSwatch}
                          disabled={scratchColors.length >= MAX_PALETTE_COLOURS}
                          style={{
                            width: 40,
                            height: 40,
                            flex: "none",
                            borderRadius: 8,
                            border: "1px dashed var(--mantine-color-default-border)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--mantine-color-dimmed)",
                            opacity: scratchColors.length >= MAX_PALETTE_COLOURS ? 0.5 : 1,
                            cursor: scratchColors.length >= MAX_PALETTE_COLOURS ? "not-allowed" : "pointer",
                          }}
                        >
                          <IconPlus size={16} />
                        </UnstyledButton>
                      </Tooltip>
                    </Group>
                  </div>

                  {onSavePalette && (
                    <>
                      <Divider label="Save current colours as palette…" labelPosition="left" />
                      <Group gap="xs" wrap="nowrap" align="end">
                        <TextInput
                          size="xs"
                          style={{ flex: 1 }}
                          placeholder="Palette name"
                          value={paletteSaveName}
                          onChange={(event) => setPaletteSaveName(event.currentTarget.value)}
                        />
                        <Button
                          size="xs"
                          disabled={!paletteSaveName.trim() || currentSeriesColors.length === 0}
                          onClick={() => {
                            onSavePalette(paletteSaveName.trim(), currentSeriesColors);
                            setPaletteSaveName("");
                          }}
                        >
                          Save
                        </Button>
                      </Group>
                    </>
                  )}

                  {seriesOwningColour.length > 0 && (
                    <Alert color="gray" p="xs">
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <Text size="xs" c="dimmed">
                          {seriesOwningColour.length} series have their own colour and will not
                          change.
                        </Text>
                        <Button size="compact-xs" variant="subtle" onClick={clearSeriesColours}>
                          Clear their colours
                        </Button>
                      </Group>
                    </Alert>
                  )}
                </Stack>
              </ScrollArea>

              <Group
                justify="space-between"
                wrap="nowrap"
                px="xs"
                py={8}
                style={{
                  flex: "none",
                  borderTop: "1px solid var(--mantine-color-default-border)",
                }}
              >
                <Button variant="subtle" size="xs" onClick={resetScratchPalette}>
                  Reset
                </Button>
                <Group gap="xs" wrap="nowrap">
                  <Button variant="default" size="xs" onClick={resetScratchPalette}>
                    Cancel
                  </Button>
                  <Button size="xs" onClick={applyScratchPalette}>
                    Apply palette
                  </Button>
                </Group>
              </Group>
            </Box>
          ) : isAllSeries ? (
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="sm" p="xs">
                <Text size="sm" fw={700}>
                  All series
                </Text>
                <Text size="xs" c="dimmed">
                  Applies to every series that has not been given its own setting.
                </Text>

                {/* Chosen before the line and marker groups because it decides
                    which of them apply. */}
                <div>
                  <Text size="xs" fw={500} mb={4}>
                    Line style
                  </Text>
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    data={MARKER_MODE_OPTIONS}
                    value={draftBaseStyle.marker_mode}
                    onChange={(value) => patchBaseStyle({ marker_mode: value as PlotMarkerMode })}
                  />
                </div>

                <Divider label="Line" labelPosition="left" />
                <Group grow align="start">
                  <Select
                    size="xs"
                    label="Dash"
                    data={DASH_OPTIONS}
                    allowDeselect={false}
                    disabled={!baseLineEnabled}
                    value={draftBaseStyle.line_dash}
                    onChange={(value) => value && patchBaseStyle({ line_dash: value as PlotLineDash })}
                  />
                  <NumberInput
                    size="xs"
                    label="Width"
                    min={0.5}
                    max={12}
                    step={0.5}
                    decimalScale={1}
                    disabled={!baseLineEnabled}
                    value={draftBaseStyle.line_width}
                    onChange={(value) => {
                      if (value === "") return;
                      patchBaseStyle({ line_width: Number(value) });
                    }}
                  />
                </Group>

                <Divider label="Markers" labelPosition="left" />
                <Group grow align="start">
                  <Select
                    size="xs"
                    label="Symbol"
                    data={SYMBOL_OPTIONS}
                    allowDeselect={false}
                    disabled={!baseMarkersEnabled}
                    value={draftBaseStyle.marker_symbol}
                    onChange={(value) =>
                      value && patchBaseStyle({ marker_symbol: value as PlotMarkerSymbol })
                    }
                  />
                  <NumberInput
                    size="xs"
                    label="Size"
                    min={1}
                    max={30}
                    disabled={!baseMarkersEnabled}
                    value={draftBaseStyle.marker_size}
                    onChange={(value) => {
                      if (value === "") return;
                      patchBaseStyle({ marker_size: Number(value) });
                    }}
                  />
                  <Switch
                    size="xs"
                    mt={22}
                    label="Open"
                    disabled={!baseMarkersEnabled}
                    checked={draftBaseStyle.marker_open}
                    onChange={(event) =>
                      patchBaseStyle({ marker_open: event.currentTarget.checked })
                    }
                  />
                </Group>

                {descriptors.some((d) => isSecondarySeries(d)) && (
                  <>
                    <Divider label="Secondary axis" labelPosition="left" />
                    <Switch
                      size="xs"
                      label="Link colours to the primary series"
                      description="A right-axis series takes the colour of the same cell on the left axis."
                      checked={draftBaseStyle.link_secondary_colors ?? false}
                      onChange={(event) =>
                        patchBaseStyle({ link_secondary_colors: event.currentTarget.checked })
                      }
                    />
                    <Select
                      size="xs"
                      label="Legend names"
                      data={[
                        { value: "independent", label: "Independent" },
                        { value: "derive", label: "Follow the primary series" },
                      ]}
                      allowDeselect={false}
                      value={draftBaseStyle.secondary_name_mode ?? "independent"}
                      onChange={(value) =>
                        value &&
                        patchBaseStyle({
                          secondary_name_mode: value as "derive" | "independent",
                        })
                      }
                    />
                    <TextInput
                      size="xs"
                      label="Name suffix"
                      placeholder=" CE"
                      disabled={(draftBaseStyle.secondary_name_mode ?? "independent") !== "derive"}
                      value={draftBaseStyle.secondary_name_suffix ?? ""}
                      onChange={(event) =>
                        patchBaseStyle({ secondary_name_suffix: event.currentTarget.value })
                      }
                    />
                  </>
                )}
              </Stack>
            </ScrollArea>
          ) : !active ? (
            <Alert color="gray" m="xs">
              This plot has no series to style yet.
            </Alert>
          ) : (
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="sm" p="xs">
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" fw={700} truncate title={active.label}>
                    {active.label}
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconRotate size={13} />}
                    disabled={isEmptyOverride(draftOverrides[active.key])}
                    onClick={() => clearOverride(active.key)}
                  >
                    Reset
                  </Button>
                </Group>

                {activeRules.length > 0 && (
                  <Alert color="blue" p="xs">
                    <Text size="xs">
                      {activeRules.length} rule{activeRules.length === 1 ? "" : "s"} also
                      appl{activeRules.length === 1 ? "ies" : "y"} here. Anything you set below wins
                      over them.
                    </Text>
                  </Alert>
                )}

                {activeIsSecondary && (
                  <Switch
                    size="xs"
                    label="Link colour to primary series"
                    checked={activeLinkColor}
                    onChange={(event) =>
                      setOverride(active.key, { link_color: event.currentTarget.checked })
                    }
                  />
                )}

                <Group grow align="start">
                  <LegendNameInput
                    seriesKey={active.key}
                    placeholder={active.label}
                    value={activeOverride.name ?? ""}
                    onCommit={commitLegendName}
                  />
                  <div>
                    <ColorInput
                      size="xs"
                      label="Colour"
                      format="hex"
                      disabled={activeIsSecondary && activeLinkColor}
                      value={activeResolved?.color ?? "#000000"}
                      onChange={(value) => setOverride(active.key, { color: value })}
                    />
                    {activeIsSecondary && activeLinkColor && (
                      <Text size="9px" c="dimmed" mt={2}>
                        Colour comes from the primary series.
                      </Text>
                    )}
                  </div>
                  <NumberInput
                    size="xs"
                    label="Opacity"
                    min={0.05}
                    max={1}
                    step={0.05}
                    decimalScale={2}
                    value={activeResolved?.opacity ?? 1}
                    onChange={(value) =>
                      setOverride(active.key, { opacity: value === "" ? null : Number(value) })
                    }
                  />
                </Group>

                {/* Chosen before the line and marker groups because it decides
                    which of them apply. */}
                <div>
                  <Text size="xs" fw={500} mb={4}>
                    Line style
                  </Text>
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    data={MARKER_MODE_OPTIONS}
                    value={markerMode}
                    onChange={(value) =>
                      setOverride(active.key, { marker_mode: value as PlotMarkerMode })
                    }
                  />
                </div>

                <Divider label="Line" labelPosition="left" />
                <Group grow align="start">
                  <Select
                    size="xs"
                    label="Dash"
                    data={DASH_OPTIONS}
                    allowDeselect={false}
                    disabled={!lineEnabled}
                    value={activeResolved?.lineDash ?? "solid"}
                    onChange={(value) =>
                      setOverride(active.key, { line_dash: (value as PlotLineDash) ?? null })
                    }
                  />
                  <NumberInput
                    size="xs"
                    label="Width"
                    min={0.5}
                    max={12}
                    step={0.5}
                    decimalScale={1}
                    disabled={!lineEnabled}
                    value={activeResolved?.lineWidth ?? 2.5}
                    onChange={(value) =>
                      setOverride(active.key, { line_width: value === "" ? null : Number(value) })
                    }
                  />
                  <Select
                    size="xs"
                    label="Shape"
                    data={[
                      { value: "linear", label: "Straight" },
                      { value: "spline", label: "Smoothed" },
                      { value: "hv", label: "Stepped" },
                    ]}
                    allowDeselect={false}
                    disabled={!lineEnabled}
                    value={activeResolved?.lineShape ?? "linear"}
                    onChange={(value) =>
                      setOverride(active.key, {
                        line_shape: (value as "linear" | "spline" | "hv") ?? null,
                      })
                    }
                  />
                </Group>

                <Divider label="Markers" labelPosition="left" />
                <Group grow align="start">
                  <Select
                    size="xs"
                    label="Symbol"
                    data={SYMBOL_OPTIONS}
                    allowDeselect={false}
                    disabled={!markersEnabled}
                    value={activeResolved?.markerSymbol ?? "circle"}
                    onChange={(value) =>
                      setOverride(active.key, {
                        marker_symbol: (value as PlotMarkerSymbol) ?? null,
                      })
                    }
                  />
                  <NumberInput
                    size="xs"
                    label="Size"
                    min={1}
                    max={30}
                    disabled={!markersEnabled}
                    value={activeResolved?.markerSize ?? 5}
                    onChange={(value) =>
                      setOverride(active.key, { marker_size: value === "" ? null : Number(value) })
                    }
                  />
                  <Switch
                    size="xs"
                    mt={22}
                    label="Open"
                    disabled={!markersEnabled}
                    checked={activeResolved?.markerOpen ?? false}
                    onChange={(event) =>
                      setOverride(active.key, { marker_open: event.currentTarget.checked })
                    }
                  />
                </Group>

                <Divider label="Drop shadow" labelPosition="left" />
                <Switch
                  size="xs"
                  label="Drop shadow"
                  checked={activeResolved?.shadow ?? false}
                  onChange={(event) =>
                    setOverride(active.key, { shadow: event.currentTarget.checked })
                  }
                />
                {activeResolved?.shadow && (
                  <Box
                    className="series-style-shadow-controls"
                  >
                    <ColorInput
                      size="xs"
                      label="Colour"
                      format="hex"
                      value={activeResolved.shadowColor ?? DEFAULT_SHADOW.color}
                      onChange={(value) => setOverride(active.key, { shadow_color: value })}
                    />
                    <NumberInput
                      size="xs"
                      label="Opacity"
                      min={0.02}
                      max={1}
                      step={0.05}
                      decimalScale={2}
                      value={activeResolved.shadowOpacity}
                      onChange={(value) =>
                        setOverride(active.key, {
                          shadow_opacity: value === "" ? null : Number(value),
                        })
                      }
                    />
                    <NumberInput
                      size="xs"
                      label="Spread (px)"
                      min={0}
                      max={24}
                      step={1}
                      value={activeResolved.shadowSpread}
                      onChange={(value) =>
                        setOverride(active.key, {
                          shadow_spread: value === "" ? null : Number(value),
                        })
                      }
                    />
                    <NumberInput
                      size="xs"
                      label="Offset X (% span)"
                      min={-20}
                      max={20}
                      step={0.5}
                      decimalScale={1}
                      value={activeResolved.shadowOffsetX}
                      onChange={(value) =>
                        setOverride(active.key, {
                          shadow_offset_x: value === "" ? null : Number(value),
                        })
                      }
                    />
                    <NumberInput
                      size="xs"
                      label="Offset Y (% span)"
                      min={-20}
                      max={20}
                      step={0.5}
                      decimalScale={1}
                      value={activeResolved.shadowOffsetY}
                      onChange={(value) =>
                        setOverride(active.key, {
                          shadow_offset_y: value === "" ? null : Number(value),
                        })
                      }
                    />
                  </Box>
                )}

                <Divider label="Legend" labelPosition="left" />
                <Switch
                  size="xs"
                  label="Show in legend"
                  checked={activeResolved?.showInLegend ?? true}
                  onChange={(event) =>
                    setOverride(active.key, { show_in_legend: event.currentTarget.checked })
                  }
                />
              </Stack>
            </ScrollArea>
          )}
        </PanelShell>
      </Group>
    </Modal>
  );
}

/**
 * Legend name field with its own state.
 *
 * Driving this straight from the draft made every keystroke re-resolve every
 * series and rebuild the preview before the character appeared, so holding
 * Backspace did nothing and then deleted everything at once. Typing is local
 * and instant; the draft is updated on a short debounce.
 */
const LegendNameInput = memo(function LegendNameInput({
  seriesKey,
  value,
  placeholder,
  onCommit,
}: {
  seriesKey: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldEraseKey = useRef(false);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  // Re-seed only when the selected series changes, never on the draft coming
  // back, which would fight what is being typed.
  useEffect(() => {
    setText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const scheduleCommit = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      commitRef.current(next);
    }, LEGEND_NAME_DEBOUNCE_MS);
  };

  return (
    <TextInput
      size="xs"
      label="Legend name"
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        // A held Backspace/Delete may repeat more slowly than the debounce.
        // Wait for keyup rather than committing between individual repeats.
        if (!heldEraseKey.current) scheduleCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        heldEraseKey.current = true;
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      }}
      onKeyUp={(event) => {
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        heldEraseKey.current = false;
        scheduleCommit(event.currentTarget.value);
      }}
      onBlur={(event) => {
        heldEraseKey.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        commitRef.current(event.currentTarget.value);
      }}
    />
  );
});

/**
 * One colour in the palette being composed: its 1-based index, a large
 * swatch, and a colour-picker popover anchored to the swatch while it is
 * open.
 *
 * Sortable via @dnd-kit: `useSortable` supplies the drag handle props
 * (`attributes`/`listeners`) that go on the whole item, a `transform` for the
 * live reorder animation, and `isDragging` for the raised/faded drag state.
 * The "Move left"/"Move right" toolbar buttons remain as the alternative that
 * does not require first "picking up" the item with the keyboard sensor.
 *
 * The remove (×) button sits on top of the swatch and is only ever revealed
 * by CSS (`:hover`/`:focus-within` on `.palette-swatch`, see app.css) — never
 * by JS mouseenter/mouseleave state — and stops pointer/click propagation so
 * dnd-kit never mistakes clicking it for the start of a drag.
 *
 * The popover's dropdown is rendered `withinPortal`, so DOM-wise it sits
 * outside this whole item — but React still bubbles its synthetic events
 * (pointerdown, keydown) up through the *component* tree, i.e. through this
 * item, regardless of where the portal lands in the DOM. Without stopping
 * that propagation, dragging the colour picker's saturation/hue handles
 * would be seen by dnd-kit's pointer sensor as dragging the swatch, and
 * arrow/Backspace/Delete keys typed into the hex field would be seen by this
 * item's own keydown handler as reorder or remove commands. Both are
 * stopped at the dropdown's root.
 */
function SortablePaletteSwatch({
  id,
  color,
  index,
  selected,
  removeDisabled,
  popoverOpened,
  onSelect,
  onPopoverClose,
  onColorChange,
  onRemove,
}: {
  id: string;
  color: string;
  index: number;
  selected: boolean;
  removeDisabled: boolean;
  popoverOpened: boolean;
  onSelect: () => void;
  onPopoverClose: () => void;
  onColorChange: (value: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  // The hex text field is typed freely, including transiently-invalid text
  // (e.g. a paste mid-edit); it only pushes a colour through when the value
  // is valid, via the shared `setPaletteColor` helper (invalid input is
  // rejected there and this field simply keeps showing what was typed until
  // it is corrected or the popover re-opens on the current colour).
  const [hexText, setHexText] = useState(color);
  useEffect(() => {
    if (popoverOpened) setHexText(color);
    // Re-seed only when the popover opens (or the colour changes while
    // open, e.g. via the picker) — not on every parent render, which would
    // clobber an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popoverOpened, color]);

  return (
    <Stack
      ref={setNodeRef}
      gap={2}
      align="center"
      className="palette-swatch"
      style={{
        flex: "none",
        position: "relative",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 1 : undefined,
        cursor: "grab",
      }}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        // Delete/Backspace removes the swatch; every other key (Space/Enter
        // to pick up, arrow keys to move, Escape to cancel) must still reach
        // dnd-kit's own keyboard-sensor handler, which `{...listeners}`
        // supplied above and this explicit prop would otherwise shadow. This
        // only runs while the popover is closed: while open, the dropdown's
        // own onKeyDown below stops these events before they bubble here.
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          if (!removeDisabled) onRemove();
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
    >
      <Text size="9px" c="dimmed">
        {index + 1}
      </Text>
      <Popover
        opened={popoverOpened}
        onClose={onPopoverClose}
        position="bottom"
        withArrow
        shadow="md"
        trapFocus
        withinPortal
      >
        <Popover.Target>
          <Tooltip label={color} disabled={selected || popoverOpened}>
            <UnstyledButton
              aria-label={`Colour ${index + 1}: ${color}`}
              title={color}
              onClick={onSelect}
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: color,
                outline: selected ? "2px solid var(--mantine-primary-color-6)" : "1px solid var(--mantine-color-default-border)",
                outlineOffset: 2,
              }}
            />
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Stack gap={6} style={{ width: 200 }}>
            <ColorPicker
              format="hex"
              value={color}
              onChange={(value) => {
                setHexText(value);
                onColorChange(value);
              }}
              fullWidth
            />
            <TextInput
              size="xs"
              label={`Colour ${index + 1}`}
              value={hexText}
              onChange={(event) => setHexText(event.currentTarget.value)}
              onBlur={(event) => onColorChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onColorChange(event.currentTarget.value);
                }
              }}
            />
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <Tooltip label={`Remove colour ${index + 1}`}>
        <ActionIcon
          className="palette-swatch-remove"
          radius="xl"
          aria-label={`Remove colour ${index + 1}`}
          disabled={removeDisabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 18,
            height: 18,
            minWidth: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: removeDisabled ? "var(--mantine-color-body)" : "var(--mantine-color-body)",
            border: `1px solid var(--mantine-color-default-border)`,
            color: "var(--mantine-color-dimmed)",
          }}
        >
          <IconX size={12} />
        </ActionIcon>
      </Tooltip>
    </Stack>
  );
}

/**
 * Preview panel with fixed dimensions and optional legend popover.
 */
function PreviewPanel({
  preview,
  previewLayout,
  previewConfig,
  previewStyle,
  resolvedByKey,
  descriptors,
}: {
  preview: { data: unknown[]; layout: Record<string, unknown> };
  previewLayout: Record<string, unknown>;
  previewConfig: Record<string, unknown>;
  previewStyle: React.CSSProperties;
  resolvedByKey: Map<string, ResolvedSeriesStyle>;
  descriptors: SeriesDescriptor[];
}) {
  const [legendOpened, setLegendOpened] = useState(false);

  // Build the list of visible series in draw order for the legend popover
  const visibleSeries = useMemo(() => {
    return descriptors
      .map((descriptor) => ({
        descriptor,
        resolved: resolvedByKey.get(descriptor.key),
      }))
      .filter(({ resolved }) => resolved && !resolved.hidden && resolved.showInLegend);
  }, [descriptors, resolvedByKey]);

  return (
    <Popover opened={legendOpened} onClose={() => setLegendOpened(false)} position="bottom-start">
      <Popover.Target>
        <PanelShell
          title="Preview"
          right={
            <Tooltip label="Show legend" disabled={visibleSeries.length === 0}>
              <ActionIcon
                size="sm"
                variant={legendOpened ? "filled" : "subtle"}
                color={legendOpened ? "gray" : "gray"}
                aria-label="Toggle legend"
                disabled={visibleSeries.length === 0}
                onClick={() => setLegendOpened((prev) => !prev)}
              >
                <IconList size={15} />
              </ActionIcon>
            </Tooltip>
          }
          style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT + 56, flex: "none" }}
          bodyPadding={0}
        >
          <Plot
            data={preview.data as never}
            layout={previewLayout as never}
            config={previewConfig as never}
            style={previewStyle}
          />
        </PanelShell>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Stack gap={6} style={{ maxWidth: 320 }}>
          {visibleSeries.length === 0 ? (
            <Text size="xs" c="dimmed">
              No visible series
            </Text>
          ) : (
            <Stack gap={4}>
              {visibleSeries.map(({ descriptor, resolved }) => (
                <Group
                  key={descriptor.key}
                  gap={6}
                  wrap="nowrap"
                  style={{
                    borderRadius: 4,
                    padding: "4px 6px",
                    background: "var(--mantine-color-default-hover)",
                  }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 2,
                      flex: "none",
                      background: resolved?.color ?? "#888",
                    }}
                  />
                  <Text
                    size="xs"
                    truncate
                    title={resolved?.name ?? descriptor.label}
                    style={{ flex: 1 }}
                  >
                    {resolved?.name ?? descriptor.label}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Titled container so every panel in the dialog is labelled the same way. */
function PanelShell({
  title,
  right,
  style,
  bodyPadding = "xs",
  children,
}: {
  title: string;
  right?: React.ReactNode;
  style?: React.CSSProperties;
  bodyPadding?: string | number;
  children: React.ReactNode;
}) {
  return (
    <Paper
      withBorder
      style={{ display: "flex", flexDirection: "column", minHeight: 0, ...style }}
    >
      <Group
        justify="space-between"
        wrap="nowrap"
        px="xs"
        py={6}
        style={{
          flex: "none",
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Text size="sm" fw={700}>
          {title}
        </Text>
        {right}
      </Group>
      <Box p={bodyPadding} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </Box>
    </Paper>
  );
}
