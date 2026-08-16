import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
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
  VisuallyHidden,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconGripVertical,
  IconMinus,
  IconPencil,
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
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { modals } from "@mantine/modals";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type {
  PlotLineDash,
  PlotMarkerMode,
  PlotMarkerSymbol,
  PlotStyle,
  SeriesStyleOverride,
  SeriesStyleRule,
} from "../../../../api";
import {
  SERIES_RULE_FIELDS,
  SERIES_RULE_OPERATORS,
  applySeriesOverridePatch,
  emptySeriesRule,
  isEmptyOverride,
  isSecondarySeries,
  linkedSecondarySeriesKeys,
  matchingRules,
  moveSeriesWithinGroup,
  orderedSeriesDescriptors,
  pruneOverrides,
  resolveAllSeriesStyles,
  seriesSelectionResult,
  seriesRuleError,
  sharedValue,
  type BaseSeriesStyle,
  type ResolvedSeriesStyle,
  type SeriesDescriptor,
} from "./seriesStyling";
import {
  PALETTE_OPTIONS,
  PLOT_PALETTES,
  applyAllSeriesStylePatch,
  applyPaletteToStyle,
  plotPalette,
  withoutSeriesColors,
} from "./plotStyle";
import {
  builtInPaletteSelection,
  customPaletteSelection,
  duplicatePaletteColor,
  movePaletteColor,
  paletteOverflowMode,
  removePaletteColor,
  reversePalette,
  savedPaletteSelection,
  seriesWithOwnColour,
  setPaletteColor,
  type PaletteSelection,
} from "./paletteDraft";
import Plot from "../../../../components/Plot";
import {
  buildLegendPreview,
  expandLegendPreview,
  LEGEND_PREVIEW_CONFIG,
  LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT,
  LEGEND_PREVIEW_EXPANDED_WIDTH,
  LEGEND_PREVIEW_MIN_HEIGHT,
  LEGEND_PREVIEW_WIDTH,
} from "./legendPreview";
import {
  PALETTE_PREVIEW_HEIGHT,
  PALETTE_PREVIEW_PLOT,
  PALETTE_PREVIEW_VIEWBOX,
  PALETTE_PREVIEW_WIDTH,
  generatePalettePreviewChartElements,
  palettePreviewPath,
} from "./palettePreview";

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

const MIXED_SWITCH_STYLES = {
  track: {
    backgroundColor: "var(--mantine-color-orange-light)",
    borderColor: "var(--mantine-color-orange-outline)",
  },
  thumb: {
    borderColor: "var(--mantine-color-orange-outline)",
  },
};

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
  onOverwritePalette,
  onDeletePalette,
  onRenamePalette,
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
  /**
   * Replaces a saved palette's colours in place, leaving its id, name and
   * kind untouched. Omitting this prop leaves the save control creating new
   * palettes only, even when the typed/fallback name matches an existing one.
   */
  onOverwritePalette?: (id: string, colors: string[]) => void;
  /**
   * Deletes a saved palette. Omitting this prop hides the "Saved palettes"
   * section entirely, since there would be no way to act on it.
   */
  onDeletePalette?: (id: string) => void;
  /** Renames a saved palette, leaving its id, kind and colours untouched. */
  onRenamePalette?: (id: string, name: string) => void;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
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
  /**
   * Series hidden in the modal's preview only, so the user can temporarily
   * isolate series while judging line and marker styling. This never reaches
   * `draftOverrides`/`onChange` — the app's own visibility mechanism is the
   * only thing that should hide a series from the real analysis plot.
   */
  const [previewHidden, setPreviewHidden] = useState<Set<string>>(new Set());
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
    setSelectedKeys(new Set());
    setSelectionAnchor(null);
    setActiveKey(ALL_SERIES_KEY);
    setScratchColors(plotPalette(baseStyle));
    setSwatchIds(genSwatchIds(plotPalette(baseStyle).length));
    setPaletteSelection(currentPaletteSelection(baseStyle, palettes));
    setSelectedSwatch(0);
    setOpenSwatchIndex(null);
    setPreviewHidden(new Set());
    // Only when the dialog opens: re-syncing on every prop change would fight
    // the debounce and undo edits mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const descriptorKeySet = useMemo(
    () => new Set(descriptors.map((descriptor) => descriptor.key)),
    [descriptors],
  );

  // Descriptor lists can change when a result refreshes. Keep concrete
  // selection honest without turning an empty selection into the All series
  // base-style editor. If exactly one selected key survives, make it the
  // active key as well so single-series actions still target it.
  useEffect(() => {
    const validSelectedKeys = new Set(
      Array.from(selectedKeys).filter((key) => descriptorKeySet.has(key)),
    );
    setSelectedKeys((current) => {
      if (
        validSelectedKeys.size === current.size &&
        Array.from(validSelectedKeys).every((key) => current.has(key))
      ) {
        return current;
      }
      return validSelectedKeys;
    });
    setSelectionAnchor((current) => (current && descriptorKeySet.has(current) ? current : null));
    setActiveKey((current) => {
      if (validSelectedKeys.size === 1) return Array.from(validSelectedKeys)[0];
      if (validSelectedKeys.size > 1) return null;
      return current === ALL_SERIES_KEY ? current : null;
    });
  }, [descriptorKeySet, selectedKeys]);

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
  const seriesSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Loads a saved palette's colours into the scratch palette being composed.
   * Shared by the preset dropdown's "saved:" branch and the "Saved palettes"
   * list's Apply control below, so there is exactly one place that knows how
   * to do this.
   */
  const applySavedPalette = useCallback(
    (id: string, colors: string[]) => {
      setScratchColors([...colors]);
      setSwatchIds(genSwatchIds(colors.length));
      setPaletteSelection(savedPaletteSelection(id, colors));
      setSelectedSwatch(0);
      setOpenSwatchIndex(null);
    },
    [genSwatchIds],
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
      applySavedPalette(id, saved.colors);
    }
  };

  const applyScratchPalette = () => {
    // A series reorder is held as a complete base-style snapshot until its
    // debounce fires. Flush that snapshot before applying a palette so it
    // cannot land afterward with stale palette/custom-colour fields.
    flush();
    // Keep the local base draft at the same palette as the parent. The next
    // order patch is built from this draft, so palette-then-reorder composes
    // with the already-applied palette instead of resurrecting its old one.
    setDraftBaseStyle((current) => {
      const next = { ...current };
      applyPaletteToStyle(next, scratchColors, paletteSelection.palette_id);
      return next;
    });
    onApplyPalette?.(scratchColors, paletteSelection.palette_id);
    // The parent drops per-series colours so the palette reaches every series.
    // This draft is only synced from the spec on open, so mirror that here or
    // the next edit would commit the stale colours back over the new palette.
    setDraftOverrides((current) => withoutSeriesColors(current));
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
    commitBaseStyle(applyAllSeriesStylePatch(draftBaseStyle, patch));

  const handleClose = () => {
    flush();
    onClose();
  };

  const isAllSeries = activeKey === ALL_SERIES_KEY && selectedKeys.size === 0;

  const active = useMemo(
    () =>
      selectedKeys.size === 1
        ? descriptors.find((descriptor) => selectedKeys.has(descriptor.key)) ?? null
        : null,
    [descriptors, selectedKeys],
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
      items: orderedSeriesDescriptors(group.items, draftBaseStyle.series_order),
    }));
  }, [descriptors, draftBaseStyle.series_order]);

  const handleSeriesDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const nextOrder = moveSeriesWithinGroup(
      descriptors,
      draftBaseStyle.series_order,
      String(event.active.id),
      String(event.over.id),
    );
    if (nextOrder) patchBaseStyle({ series_order: nextOrder });
  };

  const selectConcreteKeys = (keys: Iterable<string>, anchor: string | null) => {
    const next = new Set(keys);
    setSelectedKeys(next);
    setSelectionAnchor(anchor);
    setActiveKey(next.size === 1 ? Array.from(next)[0] : null);
    setTab("series");
  };

  const selectSeries = (key: string, event: ReactMouseEvent<HTMLElement>) => {
    const group = seriesGroups.find((candidate) => candidate.items.some((item) => item.key === key));
    const anchorGroup = selectionAnchor
      ? seriesGroups.find((candidate) => candidate.items.some((item) => item.key === selectionAnchor))
      : undefined;

    if (event.shiftKey) event.preventDefault();
    const selection = seriesSelectionResult(
      group && anchorGroup?.key === group.key ? group.items : [],
      selectedKeys,
      selectionAnchor,
      key,
      { shiftKey: event.shiftKey, toggleKey: event.ctrlKey || event.metaKey },
    );
    selectConcreteKeys(selection.keys, selection.anchor);
  };

  const toggleSeriesCheckbox = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectConcreteKeys(next, key);
  };

  const toggleQuantitySelection = (items: SeriesDescriptor[]) => {
    const keys = items.map((item) => item.key);
    const allSelected = keys.length > 0 && keys.every((key) => selectedKeys.has(key));
    const next = new Set(selectedKeys);
    if (allSelected) keys.forEach((key) => next.delete(key));
    else keys.forEach((key) => next.add(key));
    selectConcreteKeys(next, allSelected ? null : keys[0] ?? null);
  };

  const selectAllSeriesBase = () => {
    setSelectedKeys(new Set());
    setSelectionAnchor(null);
    setActiveKey(ALL_SERIES_KEY);
    setTab("series");
  };

  const bulkTargetKeys = useMemo(
    () => (isAllSeries ? descriptors.map((descriptor) => descriptor.key) : Array.from(selectedKeys)),
    [descriptors, isAllSeries, selectedKeys],
  );

  const bulkResolvedStyles = useMemo(
    () =>
      bulkTargetKeys
        .map((key) => resolvedByKey.get(key))
        .filter((style): style is ResolvedSeriesStyle => Boolean(style)),
    [bulkTargetKeys, resolvedByKey],
  );

  const bulkResolved = useMemo(
    () => ({
      color: sharedValue(bulkResolvedStyles.map((style) => style.color)),
      opacity: sharedValue(bulkResolvedStyles.map((style) => style.opacity)),
      markerMode: sharedValue(bulkResolvedStyles.map((style) => style.markerMode)),
      lineDash: sharedValue(bulkResolvedStyles.map((style) => style.lineDash)),
      lineWidth: sharedValue(bulkResolvedStyles.map((style) => style.lineWidth)),
      lineShape: sharedValue(bulkResolvedStyles.map((style) => style.lineShape)),
      markerSymbol: sharedValue(bulkResolvedStyles.map((style) => style.markerSymbol)),
      markerSize: sharedValue(bulkResolvedStyles.map((style) => style.markerSize)),
      markerOpen: sharedValue(bulkResolvedStyles.map((style) => style.markerOpen)),
      showInLegend: sharedValue(bulkResolvedStyles.map((style) => style.showInLegend)),
    }),
    [bulkResolvedStyles],
  );

  const linkedBulkColourKeys = useMemo(
    () =>
      linkedSecondarySeriesKeys(
        descriptors,
        bulkTargetKeys,
        draftOverrides,
        draftBaseStyle.link_secondary_colors ?? false,
      ),
    [
      descriptors,
      bulkTargetKeys,
      draftOverrides,
      draftBaseStyle.link_secondary_colors,
    ],
  );
  const bulkColourEnabled = linkedBulkColourKeys.length === 0;
  const allSeriesColourEnabled = isAllSeries || bulkColourEnabled;

  const setOverride = (key: string, patch: SeriesStyleOverride) =>
    commit(
      applySeriesOverridePatch(draftOverrides, [key], patch),
      draftRules,
    );

  const applyBulkPatch = (patch: SeriesStyleOverride) => {
    if (bulkTargetKeys.length === 0) return;
    commit(applySeriesOverridePatch(draftOverrides, bulkTargetKeys, patch), draftRules);
  };

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

  const clearBulkOverrides = () => {
    if (bulkTargetKeys.length === 0) return;
    const next = { ...draftOverrides };
    for (const key of bulkTargetKeys) delete next[key];
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

  /**
   * Confirms and then deletes a saved palette from the preset dropdown.
   *
   * Deleting only removes the saved entry — it never touches a plot, since
   * every plot that used this palette already stored its own copy of the
   * colours when it was applied.
   */
  const confirmDeletePalette = useCallback(
    (id: string, name: string) => {
      modals.openConfirmModal({
        title: "Delete palette",
        children: (
          <Text size="sm">
            Delete "{name}"? Plots already using it keep their colours, since each plot stores its
            own copy.
          </Text>
        ),
        labels: { confirm: "Delete", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => onDeletePalette?.(id),
      });
    },
    [onDeletePalette],
  );

  /**
   * The saved palette record matching the current selection, if any — used
   * both for the preview heading's name and to gate the rename pencil.
   *
   * Looked up by id rather than trusting `palette_id` alone: a selection can
   * point at a palette that has since been deleted (see `currentPaletteSelection`),
   * in which case there is nothing left to rename.
   */
  const savedPaletteForSelection = useMemo(
    () => (paletteSelection.palette_id ? palettes?.find((p) => p.id === paletteSelection.palette_id) : undefined),
    [paletteSelection.palette_id, palettes],
  );

  const currentPaletteName = useMemo(() => {
    if (savedPaletteForSelection) return savedPaletteForSelection.name;
    if (paletteSelection.palette_id) return "Custom palette"; // saved palette since deleted
    if (paletteSelection.palette !== "custom") {
      return (
        PALETTE_OPTIONS.find((option) => option.value === paletteSelection.palette)?.label ??
        paletteSelection.palette
      );
    }
    return "Custom palette";
  }, [savedPaletteForSelection, paletteSelection.palette_id, paletteSelection.palette]);

  const canRenamePalette = Boolean(savedPaletteForSelection) && Boolean(onRenamePalette);

  /**
   * Resolves what the "Save current colours as palette…" control targets:
   * the typed name if there is one, else the currently selected saved
   * palette's name, matched case-insensitively against the saved list so the
   * button can offer an update instead of always creating a new entry.
   */
  const typedName = paletteSaveName.trim();
  const fallbackName = savedPaletteForSelection?.name ?? "";
  const effectiveName = typedName || fallbackName;
  const matchedPalette = useMemo(
    () =>
      palettes?.find(
        (palette) => palette.name.trim().toLowerCase() === effectiveName.trim().toLowerCase(),
      ),
    [palettes, effectiveName],
  );
  const matchedPaletteUnchanged = useMemo(
    () =>
      Boolean(
        matchedPalette &&
          matchedPalette.colors.length === scratchColors.length &&
          matchedPalette.colors.every(
            (color, index) => color.toLowerCase() === scratchColors[index]?.toLowerCase(),
          ),
      ),
    [matchedPalette, scratchColors],
  );
  const saveControlDisabled =
    !effectiveName || scratchColors.length === 0 || (Boolean(matchedPalette) && matchedPaletteUnchanged && !typedName);
  const saveControlLabel = matchedPalette
    ? `Update "${matchedPalette.name}"`
    : effectiveName
      ? `Save as "${effectiveName}"`
      : "Save";
  const saveControlTitle = matchedPalette
    ? `Replace the colours of "${matchedPalette.name}"`
    : effectiveName
      ? `Create a new palette called "${effectiveName}"`
      : "Type a palette name";

  const paletteHeading = useMemo(
    () => (
      <PaletteNameHeading
        name={currentPaletteName}
        paletteId={paletteSelection.palette_id}
        canRename={canRenamePalette}
        onRename={onRenamePalette}
      />
    ),
    [currentPaletteName, paletteSelection.palette_id, canRenamePalette, onRenamePalette],
  );

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

  // The modal preview must use the current local draft. Parent persistence is
  // still debounced below, but deferring these inputs made the visible plot
  // lag behind a colour drag, spinner change, or rule edit by an intentional
  // stale render.
  const previewOverrides = draftOverrides;
  const previewRules = draftRules;

  /**
   * Layers the preview-only eye toggle on top of the current local draft,
   * without mutating it. Only the modal's own preview plot sees this merged
   * object; parent persistence still receives the unmerged draft through the
   * bounded commit debounce.
   */
  const previewOverridesWithHiding = useMemo(() => {
    if (previewHidden.size === 0) return previewOverrides;
    const merged = { ...previewOverrides };
    for (const key of previewHidden) {
      merged[key] = { ...(merged[key] ?? {}), hidden: true };
    }
    return merged;
  }, [previewOverrides, previewHidden]);

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
  // Include the local base draft so drag-order and All-series edits reach both
  // Plotly previews before their debounced parent commit. A scratch palette is
  // layered last because it is intentionally not persisted until Apply.
  const previewStyleOverlay = useMemo<Partial<PlotStyle>>(
    () => ({ ...draftBaseStyle, ...(paletteOverlay ?? {}) }),
    [draftBaseStyle, paletteOverlay],
  );
  // Build one unhidden figure for the detached legend. The scientific preview
  // may omit traces when the modal eye is used, but that eye is deliberately
  // independent from persisted legend membership.
  const unhiddenPreview = useMemo(
    () =>
      opened
        ? buildPreview({
            overrides: previewOverrides,
            rules: previewRules,
            styleOverlay: previewStyleOverlay,
          })
        : { data: [], layout: {} },
    [opened, buildPreview, previewOverrides, previewRules, previewStyleOverlay],
  );
  const preview = useMemo(
    () =>
      !opened || previewHidden.size === 0
        ? unhiddenPreview
        : buildPreview({
            overrides: previewOverridesWithHiding,
            rules: previewRules,
            styleOverlay: previewStyleOverlay,
          }),
    [
      opened,
      buildPreview,
      previewOverridesWithHiding,
      previewRules,
      previewStyleOverlay,
      previewHidden,
      unhiddenPreview,
    ],
  );
  const legendPreview = useMemo(() => buildLegendPreview(unhiddenPreview), [unhiddenPreview]);

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
  const legendPreviewConfig = LEGEND_PREVIEW_CONFIG;
  const legendPreviewStyle = useMemo(() => {
    const height =
      typeof legendPreview.layout.height === "number"
        ? legendPreview.layout.height
        : LEGEND_PREVIEW_MIN_HEIGHT;
    return { width: LEGEND_PREVIEW_WIDTH, height };
  }, [legendPreview.layout]);

  const activeOverride = active ? draftOverrides[active.key] ?? {} : {};
  const activeResolved = active ? resolvedByKey.get(active.key) : null;
  const activeRules = active ? matchingRules(active, draftRules) : [];
  const markerMode = activeResolved?.markerMode ?? "none";
  const lineEnabled = markerMode !== "points";
  const markersEnabled = markerMode !== "none";
  const activeIsSecondary = active ? isSecondarySeries(active) : false;
  const activeLinkColor = active
    ? draftOverrides[active.key]?.link_color ?? draftBaseStyle.link_secondary_colors ?? false
    : false;
  const bulkLineEnabled =
    bulkResolved.markerMode.mixed || bulkResolved.markerMode.value !== "points";
  const bulkMarkersEnabled =
    bulkResolved.markerMode.mixed || bulkResolved.markerMode.value !== "none";

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
          opened={opened}
          preview={preview}
          previewLayout={previewLayout}
          previewConfig={previewConfig}
          previewStyle={previewStyle}
          legendPreview={legendPreview}
          legendPreviewConfig={legendPreviewConfig}
          legendPreviewStyle={legendPreviewStyle}
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
              {!seriesCollapsed && (
                <Text size="9px" c="dimmed" px={6} pb={2}>
                  Hiding here only affects this preview, not the plot.
                </Text>
              )}
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
                  onClick={selectAllSeriesBase}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    selectAllSeriesBase();
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isAllSeries}
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
              <DndContext
                sensors={seriesSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleSeriesDragEnd}
              >
                {seriesGroups.map((group) => {
                  const selectedCount = group.items.filter((item) => selectedKeys.has(item.key)).length;
                  const allSelected = group.items.length > 0 && selectedCount === group.items.length;
                  const partiallySelected = selectedCount > 0 && !allSelected;
                  const heading = group.heading ?? "Plotted series";
                  return (
                    <Fragment key={group.key}>
                      {!seriesCollapsed && (
                        <Group gap={6} wrap="nowrap" px={6} pt={6} pb={2}>
                          <Checkbox
                            size="xs"
                            checked={allSelected}
                            indeterminate={partiallySelected}
                            aria-label={`Select all ${heading}`}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleQuantitySelection(group.items)}
                          />
                          <Text
                            size="9px"
                            fw={700}
                            c="dimmed"
                            tt="uppercase"
                            truncate
                            style={{ letterSpacing: 0.4, flex: 1 }}
                          >
                            {heading} ({group.items.length})
                          </Text>
                        </Group>
                      )}
                      <SortableContext
                        items={group.items.map((item) => item.key)}
                        strategy={verticalListSortingStrategy}
                      >
                        {group.items.map((descriptor) => (
                          <SortableSeriesRow
                            key={descriptor.key}
                            descriptor={descriptor}
                            resolvedStyle={resolvedByKey.get(descriptor.key)}
                            customised={!isEmptyOverride(draftOverrides[descriptor.key])}
                            selected={selectedKeys.has(descriptor.key)}
                            seriesCollapsed={seriesCollapsed}
                            previewHidden={previewHidden.has(descriptor.key)}
                            onSelect={(event) => selectSeries(descriptor.key, event)}
                            onKeyboardSelect={() => selectConcreteKeys([descriptor.key], descriptor.key)}
                            onCheckboxChange={() => toggleSeriesCheckbox(descriptor.key)}
                            onTogglePreview={() =>
                              setPreviewHidden((current) => {
                                const next = new Set(current);
                                if (next.has(descriptor.key)) next.delete(descriptor.key);
                                else next.add(descriptor.key);
                                return next;
                              })
                            }
                          />
                        ))}
                      </SortableContext>
                    </Fragment>
                  );
                })}
              </DndContext>
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
                {onApplyPalette && (
                  <>
                    <Box
                      component="span"
                      aria-hidden="true"
                      style={{
                        alignSelf: "stretch",
                        width: 1,
                        marginInline: 4,
                        background: "var(--mantine-color-default-border)",
                      }}
                    />
                    <Tabs.Tab value="palettes" title="Palettes apply globally to all series">
                      <Group gap={4} wrap="nowrap">
                        <span>Palettes</span>
                        <Badge size="xs" variant="light" color="gray">
                          Global
                        </Badge>
                      </Group>
                    </Tabs.Tab>
                  </>
                )}
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
                      searchable
                      nothingFoundMessage="No palette found"
                      style={{ flex: 1 }}
                      data={presetSelectData}
                      value={presetSelectValue}
                      onChange={applyPreset}
                      renderOption={({ option }) => {
                        const isSaved = option.value?.startsWith("saved:") ?? false;
                        const savedId = isSaved ? option.value.slice("saved:".length) : null;
                        const colors =
                          option.value?.startsWith("builtin:")
                            ? PLOT_PALETTES[(option.value.slice("builtin:".length) as PlotStyle["palette"]) ?? "app"]
                            : savedId
                              ? palettes?.find((p) => p.id === savedId)?.colors ?? []
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
                            {/* Only saved palettes can be deleted here — built-ins are permanent. */}
                            {savedId && onDeletePalette && (
                              <Tooltip label={`Delete palette "${option.label}"`}>
                                <ActionIcon
                                  size="xs"
                                  variant="subtle"
                                  color="red"
                                  aria-label={`Delete palette "${option.label}"`}
                                  // Stops the click from selecting this option or closing the
                                  // dropdown — it should only open the delete confirmation.
                                  onMouseDown={(event) => {
                                    event.stopPropagation();
                                    event.preventDefault();
                                  }}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    event.preventDefault();
                                    confirmDeletePalette(savedId, option.label);
                                  }}
                                >
                                  <IconX size={12} />
                                </ActionIcon>
                              </Tooltip>
                            )}
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
                      <Stack gap={2} align="center" style={{ flex: "none" }}>
                        <div style={{ height: 16 }} />
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
                      </Stack>
                    </Group>
                  </div>

                  <PalettePreview colors={scratchColors} heading={paletteHeading} />

                  <Group wrap="nowrap" align="center" gap="xs">
                    <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                      If the plot has more than {scratchColors.length} series
                    </Text>
                    <Select
                      size="xs"
                      w={240}
                      data={[
                        { value: "repeat", label: "Repeat the palette" },
                        { value: "generate", label: "Generate additional colours" },
                      ]}
                      value={paletteOverflowMode(baseStyle.palette_overflow_mode)}
                      onChange={(value) => {
                        if (value) {
                          patchBaseStyle({ palette_overflow_mode: value as "repeat" | "generate" });
                        }
                      }}
                    />
                  </Group>

                  {onSavePalette && (
                    <>
                      <Divider label="Save current colours as palette…" labelPosition="left" />
                      <Group gap="xs" wrap="nowrap" align="end">
                        <TextInput
                          size="xs"
                          style={{ flex: 1 }}
                          placeholder={fallbackName || "Palette name"}
                          value={paletteSaveName}
                          onChange={(event) => setPaletteSaveName(event.currentTarget.value)}
                        />
                        <Tooltip label={saveControlTitle}>
                          <Button
                            size="xs"
                            disabled={saveControlDisabled}
                            title={saveControlTitle}
                            onClick={() => {
                              if (matchedPalette && onOverwritePalette) {
                                onOverwritePalette(matchedPalette.id, scratchColors);
                              } else {
                                onSavePalette(effectiveName, scratchColors);
                              }
                              setPaletteSaveName("");
                            }}
                          >
                            {saveControlLabel}
                          </Button>
                        </Tooltip>
                      </Group>
                      {matchedPalette && (
                        <Text size="9px" c="dimmed">
                          Updating a palette does not change plots that already use it — each plot
                          keeps its own copy of the colours.
                        </Text>
                      )}
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
                <Tooltip label="Go back to the palette the plot is currently using">
                  <Button variant="subtle" size="xs" onClick={resetScratchPalette}>
                    Reset
                  </Button>
                </Tooltip>
                <Button size="xs" onClick={applyScratchPalette}>
                  Apply palette
                </Button>
              </Group>
            </Box>
          ) : isAllSeries || selectedKeys.size > 1 ? (
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="sm" p="xs">
                <Group justify="space-between" wrap="nowrap" align="start">
                  <div>
                    <Text size="sm" fw={700}>
                      {isAllSeries ? "All series" : `${selectedKeys.size} series selected`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {isAllSeries
                        ? "Shows the effective values across every current series. Choosing a value applies it to all of them."
                        : "Changes apply to all selected series."}
                    </Text>
                  </div>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconRotate size={13} />}
                    onClick={clearBulkOverrides}
                  >
                    {isAllSeries ? "Reset all series" : "Reset selected"}
                  </Button>
                </Group>

                <Group grow align="start">
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Colour
                      </Text>
                      {bulkResolved.color.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <ColorInput
                      size="xs"
                      format="hex"
                      aria-label="Bulk colour"
                      disabled={!allSeriesColourEnabled}
                      placeholder={bulkResolved.color.mixed ? "Mixed" : "Colour"}
                      value={bulkResolved.color.mixed ? "" : bulkResolved.color.value ?? ""}
                      onChange={(value) => applyBulkPatch({ color: value || null })}
                    />
                    {!allSeriesColourEnabled && (
                      <Text size="9px" c="dimmed" mt={2}>
                        Bulk colour editing is disabled because colour is linked from the primary
                        series for {linkedBulkColourKeys.length === 1 ? "one" : linkedBulkColourKeys.length} selected secondary series.
                      </Text>
                    )}
                  </div>
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Opacity
                      </Text>
                      {bulkResolved.opacity.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <NumberInput
                      size="xs"
                      min={0.05}
                      max={1}
                      step={0.05}
                      decimalScale={2}
                      aria-label="Bulk opacity"
                      placeholder={bulkResolved.opacity.mixed ? "Mixed" : undefined}
                      value={bulkResolved.opacity.mixed ? "" : bulkResolved.opacity.value ?? ""}
                      onChange={(value) =>
                        applyBulkPatch({ opacity: value === "" ? null : Number(value) })
                      }
                    />
                  </div>
                </Group>

                <div>
                  <Group gap={4} mb={4}>
                    <Text size="xs" fw={500}>
                      Line style
                    </Text>
                    {bulkResolved.markerMode.mixed && (
                      <Badge size="xs" variant="light" color="gray">
                        Mixed
                      </Badge>
                    )}
                  </Group>
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    data={MARKER_MODE_OPTIONS}
                    value={bulkResolved.markerMode.mixed ? "" : bulkResolved.markerMode.value ?? ""}
                    onChange={(value) => applyBulkPatch({ marker_mode: value as PlotMarkerMode })}
                  />
                </div>

                <Divider label="Line" labelPosition="left" />
                <Group grow align="start">
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Dash
                      </Text>
                      {bulkResolved.lineDash.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <Select
                      size="xs"
                      data={DASH_OPTIONS}
                      allowDeselect={false}
                      disabled={!bulkLineEnabled}
                      placeholder={bulkResolved.lineDash.mixed ? "Mixed" : undefined}
                      value={bulkResolved.lineDash.mixed ? null : bulkResolved.lineDash.value ?? null}
                      onChange={(value) => value && applyBulkPatch({ line_dash: value as PlotLineDash })}
                    />
                  </div>
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Width
                      </Text>
                      {bulkResolved.lineWidth.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <NumberInput
                      size="xs"
                      min={0.5}
                      max={12}
                      step={0.5}
                      decimalScale={1}
                      disabled={!bulkLineEnabled}
                      placeholder={bulkResolved.lineWidth.mixed ? "Mixed" : undefined}
                      value={bulkResolved.lineWidth.mixed ? "" : bulkResolved.lineWidth.value ?? ""}
                      onChange={(value) =>
                        applyBulkPatch({ line_width: value === "" ? null : Number(value) })
                      }
                    />
                  </div>
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Shape
                      </Text>
                      {bulkResolved.lineShape.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <Select
                      size="xs"
                      data={[
                        { value: "linear", label: "Straight" },
                        { value: "spline", label: "Smoothed" },
                        { value: "hv", label: "Stepped" },
                      ]}
                      allowDeselect={false}
                      disabled={!bulkLineEnabled}
                      placeholder={bulkResolved.lineShape.mixed ? "Mixed" : undefined}
                      value={bulkResolved.lineShape.mixed ? null : bulkResolved.lineShape.value ?? null}
                      onChange={(value) =>
                        value && applyBulkPatch({ line_shape: value as "linear" | "spline" | "hv" })
                      }
                    />
                  </div>
                </Group>

                <Divider label="Markers" labelPosition="left" />
                <Group grow align="start">
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Symbol
                      </Text>
                      {bulkResolved.markerSymbol.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <Select
                      size="xs"
                      data={SYMBOL_OPTIONS}
                      allowDeselect={false}
                      disabled={!bulkMarkersEnabled}
                      placeholder={bulkResolved.markerSymbol.mixed ? "Mixed" : undefined}
                      value={bulkResolved.markerSymbol.mixed ? null : bulkResolved.markerSymbol.value ?? null}
                      onChange={(value) =>
                        value && applyBulkPatch({ marker_symbol: value as PlotMarkerSymbol })
                      }
                    />
                  </div>
                  <div>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Size
                      </Text>
                      {bulkResolved.markerSize.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <NumberInput
                      size="xs"
                      min={1}
                      max={30}
                      disabled={!bulkMarkersEnabled}
                      placeholder={bulkResolved.markerSize.mixed ? "Mixed" : undefined}
                      value={bulkResolved.markerSize.mixed ? "" : bulkResolved.markerSize.value ?? ""}
                      onChange={(value) =>
                        applyBulkPatch({ marker_size: value === "" ? null : Number(value) })
                      }
                    />
                  </div>
                  <Box>
                    <Group gap={4} mb={4}>
                      <Text size="xs" fw={500}>
                        Open
                      </Text>
                      {bulkResolved.markerOpen.mixed && (
                        <Badge size="xs" variant="light" color="gray">
                          Mixed
                        </Badge>
                      )}
                    </Group>
                    <Box style={{ minHeight: 30, display: "flex", alignItems: "center" }}>
                      <MixedStateSwitch
                        ariaLabel="Open"
                        mixed={bulkResolved.markerOpen.mixed}
                        checked={bulkResolved.markerOpen.value ?? false}
                        disabled={!bulkMarkersEnabled}
                        mixedAction="turn Open on for all selected series"
                        onChange={(checked) => applyBulkPatch({ marker_open: checked })}
                      />
                    </Box>
                    {bulkResolved.markerOpen.mixed && (
                      <Text size="9px" c="orange" mt={2}>
                        Mixed — click to turn Open on for all selected series.
                      </Text>
                    )}
                  </Box>
                </Group>

                <Divider label="Legend" labelPosition="left" />
                <Box>
                  <MixedStateSwitch
                    label="Show in legend"
                    mixed={bulkResolved.showInLegend.mixed}
                    checked={bulkResolved.showInLegend.value ?? true}
                    mixedAction="show all selected series in the legend"
                    onChange={(checked) => applyBulkPatch({ show_in_legend: checked })}
                  />
                  {bulkResolved.showInLegend.mixed && (
                    <Text size="9px" c="orange" mt={2}>
                      Mixed — click to show all selected series in the legend.
                    </Text>
                  )}
                </Box>

                <Text size="xs" c="dimmed">
                  Legend name is available when exactly one series is selected.
                </Text>

                {isAllSeries && descriptors.some((d) => isSecondarySeries(d)) && (
                  <>
                    <Divider label="Global secondary-axis defaults" labelPosition="left" />
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
              {descriptors.length === 0
                ? "This plot has no series to style yet."
                : "No series selected. Select a series or All series to edit its appearance."}
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
                  <Box>
                    <Text size="xs" fw={500} mb={4}>
                      Open
                    </Text>
                    <Box style={{ minHeight: 30, display: "flex", alignItems: "center" }}>
                      <Switch
                        size="xs"
                        aria-label="Open"
                        disabled={!markersEnabled}
                        checked={activeResolved?.markerOpen ?? false}
                        onChange={(event) =>
                          setOverride(active.key, { marker_open: event.currentTarget.checked })
                        }
                      />
                    </Box>
                  </Box>
                </Group>

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

function MixedStateSwitch({
  label,
  ariaLabel,
  mixed,
  checked,
  disabled,
  mixedAction,
  onChange,
}: {
  label?: ReactNode;
  ariaLabel?: string;
  mixed: boolean;
  checked: boolean;
  disabled?: boolean;
  mixedAction: string;
  onChange: (checked: boolean) => void;
}) {
  const mixedHint = `Mixed — click to ${mixedAction}`;
  return (
    <Switch
      size="xs"
      label={label}
      aria-label={ariaLabel}
      title={mixed ? mixedHint : undefined}
      disabled={disabled}
      checked={mixed ? false : checked}
      thumbIcon={
        mixed ? (
          <IconMinus size={11} stroke={3} color="var(--mantine-color-orange-light-color)" />
        ) : undefined
      }
      styles={mixed ? MIXED_SWITCH_STYLES : undefined}
      onChange={(event) => onChange(mixed ? true : event.currentTarget.checked)}
    />
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

/** A concrete Series-panel row with an accessible, group-local drag handle. */
function SortableSeriesRow({
  descriptor,
  resolvedStyle,
  customised,
  selected,
  seriesCollapsed,
  previewHidden,
  onSelect,
  onKeyboardSelect,
  onCheckboxChange,
  onTogglePreview,
}: {
  descriptor: SeriesDescriptor;
  resolvedStyle: ResolvedSeriesStyle | undefined;
  customised: boolean;
  selected: boolean;
  seriesCollapsed: boolean;
  previewHidden: boolean;
  onSelect: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyboardSelect: () => void;
  onCheckboxChange: () => void;
  onTogglePreview: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: descriptor.key });
  const label = resolvedStyle?.name ?? descriptor.label;
  const shiftCheckboxClick = useRef(false);

  return (
    <Tooltip
      label={label}
      disabled={!seriesCollapsed}
      position="right"
      withArrow
    >
      <Group
        ref={setNodeRef}
        gap={6}
        wrap="nowrap"
        px={6}
        py={4}
        justify={seriesCollapsed ? "center" : undefined}
        onPointerDown={(event) => {
          if (event.shiftKey && event.button === 0) {
            return;
          }
          listeners?.onPointerDown?.(event);
        }}
        onClick={(event) => {
          if (event.shiftKey) event.preventDefault();
          onSelect(event);
        }}
        onContextMenu={(event) => {
          if (event.shiftKey) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onKeyboardSelect();
        }}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        style={{
          borderRadius: 4,
          cursor: "pointer",
          background: selected ? "var(--mantine-primary-color-light)" : undefined,
          opacity: previewHidden ? 0.5 : 1,
          transform: CSS.Transform.toString(transform),
          transition,
          zIndex: isDragging ? 1 : undefined,
          userSelect: "none",
        }}
      >
        {!seriesCollapsed && (
          <Checkbox
            size="xs"
            checked={selected}
            aria-label={`Select ${label}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              shiftCheckboxClick.current = event.shiftKey && event.button === 0;
            }}
            onClick={(event) => {
              event.stopPropagation();
              const rangeClick = event.shiftKey || shiftCheckboxClick.current;
              if (!rangeClick) return;
              // The checkbox is only a visual selection affordance. Shift-click
              // must follow the row's range-selection path, and preventing the
              // native click keeps the controlled checkbox from toggling one
              // endpoint before the range is applied.
              event.preventDefault();
              shiftCheckboxClick.current = true;
              onSelect(event);
            }}
            onChange={() => {
              // React may surface checkbox changes from the native click before
              // the click handler runs. Suppress that one shift-click; keyboard
              // changes still use the ordinary checkbox toggle path.
              if (shiftCheckboxClick.current) return;
              onCheckboxChange();
            }}
            onKeyDown={(event) => {
              // A keyboard toggle is independent from a prior mouse gesture.
              // Clear the mouse guard before Shift+Space can reach onChange.
              if (event.key === " " || event.key === "Enter") shiftCheckboxClick.current = false;
            }}
            onBlur={() => {
              shiftCheckboxClick.current = false;
            }}
          />
        )}
        {!seriesCollapsed && (
          <ActionIcon
            ref={setActivatorNodeRef}
            size="xs"
            variant="subtle"
            color="gray"
            aria-label={`Reorder ${label}`}
            title={`Reorder ${label}`}
            {...attributes}
            {...listeners}
            onPointerDown={(event) => {
              event.stopPropagation();
              listeners?.onPointerDown?.(event);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <IconGripVertical size={14} />
          </ActionIcon>
        )}
        <div
          aria-hidden="true"
          style={{
            width: 14,
            height: 3,
            borderRadius: 2,
            flex: "none",
            background: resolvedStyle?.color ?? "#888",
          }}
        />
        {!seriesCollapsed && (
          <>
            <Text size="xs" truncate style={{ flex: 1 }} title={label}>
              {label}
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
        <ActionIcon
          size="xs"
          variant="subtle"
          color="gray"
          aria-label={
            previewHidden ? `Show ${label} in the preview` : `Hide ${label} in the preview`
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePreview();
          }}
        >
          {previewHidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
        </ActionIcon>
      </Group>
    </Tooltip>
  );
}

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
      <Text size="9px" c="dimmed" style={{ marginBottom: 4 }}>
        {index + 1}
      </Text>
      <Popover
        opened={popoverOpened}
        onChange={(opened) => {
          if (!opened) onPopoverClose();
        }}
        position="bottom"
        withArrow
        shadow="md"
        trapFocus
        withinPortal
        closeOnClickOutside
        closeOnEscape
      >
        <Popover.Target>
          <Tooltip label={color} position="bottom" disabled={selected || popoverOpened}>
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
          aria-label={`Remove colour ${index + 1}`}
          disabled={removeDisabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <IconX size={10} stroke={2.5} />
        </ActionIcon>
      </Tooltip>
    </Stack>
  );
}

/** Height, in px, of the palette preview's empty placeholder. */
const PALETTE_PREVIEW_EMPTY_HEIGHT = 220;

/**
 * The palette preview's heading: the current palette's name, with an inline
 * rename affordance when it names a saved palette.
 *
 * Editing is local state, committed through `onRename` only on Enter or the
 * tick button; Escape or blur discards the edit instead. An empty or
 * whitespace-only name is never committed — the field just closes back to
 * showing the existing name.
 */
function PaletteNameHeading({
  name,
  paletteId,
  canRename,
  onRename,
}: {
  name: string;
  paletteId: string | null;
  canRename: boolean;
  onRename?: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);

  const startEditing = () => {
    setDraftName(name);
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draftName.trim();
    if (trimmed && paletteId) onRename?.(paletteId, trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraftName(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <TextInput
        size="xs"
        mb={2}
        value={draftName}
        autoFocus
        aria-label={`Rename palette "${name}"`}
        onChange={(event) => setDraftName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        onBlur={cancel}
        rightSection={
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            aria-label="Save name"
            // Fires before the input's onBlur cancels the edit.
            onMouseDown={(event) => event.preventDefault()}
            onClick={commit}
          >
            <IconCheck size={12} />
          </ActionIcon>
        }
      />
    );
  }

  return (
    <Group gap={4} wrap="nowrap" mb={2}>
      <Text size="xs" fw={700} truncate title={name} style={{ flex: 1 }}>
        {name}
      </Text>
      {canRename && (
        <Tooltip label={`Rename palette "${name}"`}>
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            aria-label={`Rename palette "${name}"`}
            onClick={startEditing}
          >
            <IconPencil size={12} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

/**
 * Every colour in the palette being composed, drawn as one line each in a scientific chart.
 *
 * The modal's main preview is the real plot, which may only have a handful
 * of series — nowhere near enough to show what colours 4..N of a larger
 * palette look like. This renders every colour instead, as hand-built SVG
 * in a styled chart with gridlines, axes, and legend.
 *
 * Memoised, with the path data itself memoised on `colors`, so neither
 * recomputes on renders caused by unrelated modal state (e.g. typing a
 * legend name on another tab).
 */
const PalettePreview = memo(function PalettePreview({
  colors,
  heading,
}: {
  colors: string[];
  heading: ReactNode;
}) {
  const strokes = useMemo(
    () => colors.map((color, index) => ({ color, d: palettePreviewPath(index, colors.length) })),
    [colors],
  );

  const chartElements = useMemo(() => generatePalettePreviewChartElements(colors), [colors]);

  if (strokes.length === 0) {
    return (
      <Paper withBorder p="xs">
        {heading}
        <Text size="9px" c="dimmed" mb={8}>
          One line per colour, so you can judge the whole palette even when the plot uses fewer
          series.
        </Text>
        <div
          style={{
            width: "100%",
            height: PALETTE_PREVIEW_EMPTY_HEIGHT,
            borderRadius: 4,
            border: "1px solid var(--mantine-color-default-border)",
            background: "transparent",
          }}
        />
      </Paper>
    );
  }

  return (
    <Paper withBorder p="xs">
      {heading}
      <Text size="9px" c="dimmed" mb={8}>
        One line per colour, so you can judge the whole palette even when the plot uses fewer
        series.
      </Text>
      <VisuallyHidden>
        {`Preview of ${strokes.length} colour${strokes.length === 1 ? "" : "s"}, one curve per colour.`}
      </VisuallyHidden>
      <svg
        viewBox={PALETTE_PREVIEW_VIEWBOX}
        width={PALETTE_PREVIEW_WIDTH}
        height={PALETTE_PREVIEW_HEIGHT}
        preserveAspectRatio="xMidYMid meet"
        style={{
          display: "block",
          width: "100%",
          height: "auto",
          color: "var(--mantine-color-text, #495057)",
        }}
        role="img"
        aria-label={`Preview of ${strokes.length} palette colour${strokes.length === 1 ? "" : "s"}`}
      >
        {/* Gridlines */}
        {chartElements.gridLines.map((line, idx) =>
          line.type === "vertical" ? (
            <line
              key={`vgrid-${idx}`}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="currentColor"
              opacity={0.22}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
          ) : (
            <line
              key={`hgrid-${idx}`}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="currentColor"
              opacity={0.22}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}

        {/* Axes */}
        {chartElements.axes.map((axis, idx) =>
          axis.type === "baseline" ? (
            <line
              key={`baseline-${idx}`}
              x1={axis.x1}
              y1={axis.y1}
              x2={axis.x2}
              y2={axis.y2}
              stroke="currentColor"
              opacity={0.48}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
          ) : (
            <line
              key={`axis-${idx}`}
              x1={axis.x1}
              y1={axis.y1}
              x2={axis.x2}
              y2={axis.y2}
              stroke="currentColor"
              opacity={0.48}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}

        {/* Y axis tick labels */}
        {chartElements.yTickLabels.map((label, idx) => (
          <text
            key={`ytick-${idx}`}
            x={label.x}
            y={label.y}
            fontSize={18}
            fill="currentColor"
            opacity={0.82}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {label.text}
          </text>
        ))}

        {/* X axis tick labels */}
        {chartElements.xTickLabels.map((label, idx) => (
          <text
            key={`xtick-${idx}`}
            x={label.x}
            y={label.y}
            fontSize={18}
            fill="currentColor"
            opacity={0.82}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {label.text}
          </text>
        ))}

        {/* Y axis title */}
        <text
          transform="translate(26,149) rotate(-90)"
          fontSize={20}
          fill="currentColor"
          opacity={0.82}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          Value
        </text>

        {/* X axis title */}
        <text
          x={362}
          y={PALETTE_PREVIEW_PLOT.bottom + 62}
          fontSize={20}
          fill="currentColor"
          opacity={0.82}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          X
        </text>

        {/* Series curves */}
        {strokes.map(({ color, d }, index) => (
          <path
            key={index}
            d={d}
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Legend */}
        <g>
          {chartElements.legendEntries.map((entry, idx) => {
            const legendX = 672;
            const legendY = 44 + idx * 27;
            return (
              <g key={`legend-${idx}`}>
                {/* Color line sample */}
                <line
                  x1={legendX}
                  y1={legendY}
                  x2={702}
                  y2={legendY}
                  stroke={entry.color}
                  strokeWidth={3}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Legend label */}
                <text
                  x={712}
                  y={legendY}
                  fontSize={18}
                  style={{
                    fill: "currentColor",
                  }}
                  opacity={entry.color === "transparent" ? 0.62 : 0.82}
                  dominantBaseline="middle"
                >
                  {entry.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </Paper>
  );
});

/** Fixed scientific preview with a separate passive Plotly legend preview. */
function PreviewPanel({
  opened,
  preview,
  previewLayout,
  previewConfig,
  previewStyle,
  legendPreview,
  legendPreviewConfig,
  legendPreviewStyle,
}: {
  opened: boolean;
  preview: { data: unknown[]; layout: Record<string, unknown> };
  previewLayout: Record<string, unknown>;
  previewConfig: Record<string, unknown>;
  previewStyle: React.CSSProperties;
  legendPreview: { data: readonly unknown[]; layout: Readonly<Record<string, unknown>> };
  legendPreviewConfig: Record<string, unknown>;
  legendPreviewStyle: React.CSSProperties;
}) {
  const [legendExpanded, setLegendExpanded] = useState(false);
  const legendHeight =
    typeof legendPreview.layout.height === "number"
      ? legendPreview.layout.height
      : LEGEND_PREVIEW_MIN_HEIGHT;
  const expandedLegendPreview = useMemo(() => expandLegendPreview(legendPreview), [legendPreview]);
  const expandedLegendHeight =
    typeof expandedLegendPreview.layout.height === "number"
      ? Math.max(LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT, expandedLegendPreview.layout.height)
      : LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT;
  const expandedLegendStyle = useMemo(
    () => ({ width: LEGEND_PREVIEW_EXPANDED_WIDTH, height: expandedLegendHeight }),
    [expandedLegendHeight],
  );

  useEffect(() => {
    if (!opened) setLegendExpanded(false);
  }, [opened]);

  return (
    <>
      <Stack gap="sm" style={{ width: PREVIEW_WIDTH, flex: "none", minWidth: 0, minHeight: 0 }}>
        <PanelShell
          title="Preview"
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
        <PanelShell
          title="Legend preview"
          right={
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={legendPreview.data.length === 0}
              aria-label="Open full legend preview"
              onClick={() => setLegendExpanded(true)}
            >
              Open full legend
            </Button>
          }
          style={{ width: PREVIEW_WIDTH, height: legendHeight + 56, flex: "none" }}
          bodyPadding={0}
        >
          {legendPreview.data.length > 0 ? (
            <Plot
              data={legendPreview.data as never}
              layout={legendPreview.layout as never}
              config={legendPreviewConfig as never}
              style={legendPreviewStyle}
            />
          ) : (
            <Box
              style={{
                height: legendHeight,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text size="xs" c="dimmed">
                No legend entries
              </Text>
            </Box>
          )}
        </PanelShell>
      </Stack>

      <Modal
        opened={legendExpanded}
        onClose={() => setLegendExpanded(false)}
        title="Full legend preview"
        size="xl"
        centered
        styles={{ body: { overflow: "auto" } }}
      >
        {expandedLegendPreview.data.length > 0 ? (
          <Plot
            data={expandedLegendPreview.data as never}
            layout={expandedLegendPreview.layout as never}
            config={legendPreviewConfig as never}
            style={expandedLegendStyle}
          />
        ) : (
          <Text size="sm" c="dimmed">
            No legend entries
          </Text>
        )}
      </Modal>
    </>
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
