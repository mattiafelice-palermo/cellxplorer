import {
  Accordion,
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDeviceFloppy,
  IconPalette,
  IconPlus,
} from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";

import {
  AnalysisSpec,
  AnalysisTabKey,
  ColorPaletteSettings,
  ComputeResult,
  get,
  PlotStyle,
  PlotStylePresetSettings,
  put,
  SeriesStyleOverride,
  SeriesStyleRule,
  TimeCapacityResult,
} from "../api";
import {
  DebouncedColorInput,
  DebouncedNumberInput,
  DebouncedTextInput,
} from "./DebouncedInputs";
import { applyPlotStylePreset } from "../plotStylePresets";
import {
  cyclesSeriesDescriptors,
  timeCapacitySeriesDescriptors,
  type SeriesDescriptor,
} from "../seriesStyling";
import { SeriesStyleModal, type SeriesPreviewBuilder } from "./SeriesStyleModal";
import {
  PLOT_PALETTES,
  PALETTE_OPTIONS,
  currentPlotStyle,
  writeScopedStyle,
  plotPalette,
  cePalette,
  normalizePlotStyle,
} from "../plotStyle";

const LEGEND_INSIDE_POSITION_OPTIONS: {
  value: PlotStyle["legend_inside_position"];
  label: string;
}[] = [
  { value: "top_left", label: "Top left" },
  { value: "top_center", label: "Top center" },
  { value: "top_right", label: "Top right" },
  { value: "center_left", label: "Center left" },
  { value: "center", label: "Center" },
  { value: "center_right", label: "Center right" },
  { value: "bottom_left", label: "Bottom left" },
  { value: "bottom_center", label: "Bottom center" },
  { value: "bottom_right", label: "Bottom right" },
  { value: "custom", label: "Custom (dragged)" },
];

const COLOR_SWATCHES = Array.from(
  new Set(Object.entries(PLOT_PALETTES).filter(([key]) => key !== "custom").flatMap(([, colors]) => colors))
);

const MARKER_SYMBOL_OPTIONS = [
  { value: "circle", label: "Circle" },
  { value: "square", label: "Square" },
  { value: "diamond", label: "Diamond" },
  { value: "triangle-up", label: "Triangle" },
  { value: "cross", label: "Cross" },
  { value: "x", label: "X" },
];

function snapshotPaletteColors(
  style: PlotStyle,
  targets: { key: string; label: string; sub: string }[]
): void {
  const palette = plotPalette(style);
  targets.forEach((target, index) => {
    if (!style.custom_colors[target.key]) {
      style.custom_colors[target.key] = palette[index % palette.length];
    }
  });
}

function plotColorTargets(
  result: ComputeResult | TimeCapacityResult | undefined
): { key: string; label: string; sub: string }[] {
  const targets: { key: string; label: string; sub: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, sub: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ key, label, sub });
  };

  if (result && "cell_traces" in result) {
    for (const s of result.cell_traces) {
      if (s.group_id !== null) add(`g${s.group_id}`, s.group_name ?? `replicate #${s.group_id}`, "replicate");
      else add(`c${s.cell_id}`, s.label, "cell");
    }
    return targets;
  }

  for (const agg of result?.aggregates ?? []) add(`g${agg.group_id}`, agg.group_name, "replicate");
  for (const s of result?.cell_series ?? []) {
    if (s.group_id !== null) add(`g${s.group_id}`, s.group_name ?? `replicate #${s.group_id}`, "replicate");
    else add(`c${s.cell_id}`, s.label, "cell");
  }
  return targets;
}

export function PlotStylePanel({
  opened,
  spec,
  result,
  update,
  onToggle,
  axisScope = "cycles",
  buildSeriesPreview,
  ceOverlayActive = false,
  timeCapacityStacked = false,
  yTitlePlaceholder,
}: {
  opened: boolean;
  spec: AnalysisSpec;
  result: ComputeResult | TimeCapacityResult | undefined;
  update: (fn: (s: AnalysisSpec) => void) => void;
  onToggle: () => void;
  axisScope?: AnalysisTabKey;
  /**
   * Builds the live series-style preview using the trace/layout engine that
   * lives alongside the plot cards. The per-series editor only works with a
   * real preview, so it (and its "Series appearance…" trigger) is hidden
   * whenever this isn't supplied.
   */
  buildSeriesPreview?: SeriesPreviewBuilder;
  /** Whether the coulombic-efficiency overlay's right-axis controls apply here. */
  ceOverlayActive?: boolean;
  /** Whether the time/capacity stacked view's right-axis controls apply here. */
  timeCapacityStacked?: boolean;
  /** Placeholder shown in the Y-axis title input when it is empty. */
  yTitlePlaceholder?: string;
}) {
  const queryClient = useQueryClient();
  const presetQuery = useQuery({
    queryKey: ["plot-style-presets"],
    queryFn: () => get<PlotStylePresetSettings>("/api/settings/plot-style-presets"),
    staleTime: 5 * 60_000,
  });
  const paletteQuery = useQuery({
    queryKey: ["color-palettes"],
    queryFn: () => get<ColorPaletteSettings>("/api/settings/color-palettes"),
    staleTime: 5 * 60_000,
  });
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [applyPresetRanges, setApplyPresetRanges] = useState(false);
  const [applyPresetTicks, setApplyPresetTicks] = useState(false);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetFamily, setPresetFamily] = useState<"all" | "cycles" | "time_capacity">(
    axisScope === "time_capacity" ? "time_capacity" : "cycles",
  );
  const [presetDefault, setPresetDefault] = useState(false);
  const [seriesStyleOpen, setSeriesStyleOpen] = useState(false);
  const style = currentPlotStyle(spec, axisScope);
  const colorTargets = plotColorTargets(result);
  const computeResult = result && "cell_traces" in result ? undefined : result;
  const showRightAxisControls = ceOverlayActive || timeCapacityStacked;
  const setStyle = (fn: (style: PlotStyle) => void) => {
    update((s) => writeScopedStyle(s, axisScope, fn));
  };

  // Per-series styling. Descriptors come from whichever result this tab shows —
  // the time/capacity result has `cell_traces`, the cycles result has
  // `cell_series` — so the editor lists exactly what is on screen.
  const timeCapacityResult = result && "cell_traces" in result ? result : undefined;
  const seriesDescriptors = useMemo(() => {
    if (timeCapacityResult) return timeCapacitySeriesDescriptors(timeCapacityResult.cell_traces);
    if (computeResult) {
      return cyclesSeriesDescriptors(
        computeResult.aggregates,
        computeResult.cell_series,
        spec.presentation.show_individual_cells,
      );
    }
    return [];
  }, [timeCapacityResult, computeResult, spec]);
  // Resolved once per style change rather than per render: plotPalette returns
  // a fresh array each call, so an inline callback changed identity constantly
  // and re-resolved every series on every render.
  const seriesBaseDefaults = useMemo(
    () => ({
      palette: plotPalette(style),
      customColors: style.custom_colors,
      lineWidth: style.line_width,
      lineDash: style.line_dash,
      markerMode: style.marker_mode,
      markerSymbol: style.marker_symbol,
      markerSize: style.marker_size,
      markerOpen: style.marker_open,
    }),
    [style],
  );
  const seriesKeyOrder = useMemo(
    () => new Map(seriesDescriptors.map((item, index) => [item.key, index])),
    [seriesDescriptors],
  );
  const seriesBaseFor = useCallback(
    (descriptor: SeriesDescriptor) => {
      const index = seriesKeyOrder.get(descriptor.key) ?? 0;
      const { palette } = seriesBaseDefaults;
      return {
        color: seriesBaseDefaults.customColors[descriptor.key] ?? palette[index % palette.length],
        lineWidth: seriesBaseDefaults.lineWidth,
        lineDash: seriesBaseDefaults.lineDash,
        markerMode: seriesBaseDefaults.markerMode,
        markerSymbol: seriesBaseDefaults.markerSymbol,
        markerSize: seriesBaseDefaults.markerSize,
        markerOpen: seriesBaseDefaults.markerOpen,
        opacity: 1,
      };
    },
    [seriesKeyOrder, seriesBaseDefaults],
  );
  const customisedSeriesCount = Object.keys(style.series_overrides ?? {}).length;
  const seriesRuleCount = (style.series_rules ?? []).length;
  const seriesStyleSummary =
    customisedSeriesCount || seriesRuleCount
      ? [
          customisedSeriesCount ? `${customisedSeriesCount} customised` : null,
          seriesRuleCount ? `${seriesRuleCount} rule${seriesRuleCount === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const setAxisTitle = (key: "x_title" | "y_title" | "y2_title", value: string) => {
    setStyle((next) => void (next[key] = value || null));
  };
  const setAxis = (axis: "x_axis" | "y_axis" | "y2_axis", fn: (axis: PlotStyle["x_axis"]) => void) => {
    setStyle((next) => {
      next[axis] = { ...next[axis] };
      fn(next[axis]);
    });
  };
  const axisRangeError = (axis: PlotStyle["x_axis"]) =>
    axis.mode === "manual" &&
    axis.min !== null &&
    axis.max !== null &&
    axis.min >= axis.max
      ? "Minimum must be smaller than maximum."
      : undefined;
  const availablePresets = (presetQuery.data?.presets ?? []).filter(
    (preset) => preset.plot_family === "all" || preset.plot_family === axisScope,
  );
  const customPaletteOptions = (paletteQuery.data?.palettes ?? []).map((palette) => ({
    value: `user:${palette.id}`,
    label: palette.name,
  }));
  const paletteOptions = [
    ...PALETTE_OPTIONS.filter((option) => option.value !== "custom"),
    ...(customPaletteOptions.length
      ? [{ group: "Custom palettes", items: customPaletteOptions }]
      : []),
    { value: "custom", label: "Manual colors" },
  ];
  const savePreset = useMutation({
    mutationFn: () => {
      const id = crypto.randomUUID();
      const existing = presetQuery.data?.presets ?? [];
      return put<PlotStylePresetSettings>("/api/settings/plot-style-presets", {
        presets: [
          ...existing,
          {
            id,
            name: presetName.trim(),
            plot_family: presetFamily,
            style,
            is_default: presetDefault,
          },
        ],
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["plot-style-presets"], saved);
      setSavePresetOpen(false);
      setPresetName("");
      setPresetDefault(false);
      notifications.show({ message: "Plot-style preset saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save the preset.", color: "red" }),
  });
  const applySelectedPreset = () => {
    const preset = availablePresets.find((item) => item.id === selectedPresetId);
    if (!preset) return;
    setStyle((next) => {
      Object.assign(
        next,
        applyPlotStylePreset(
          next,
          normalizePlotStyle(preset.style),
          applyPresetRanges,
          applyPresetTicks,
        ),
      );
    });
  };

  if (!opened) {
    return (
      <Paper
        withBorder
        p={4}
        style={{ width: 42, flexShrink: 0, display: "flex", alignItems: "center", flexDirection: "column" }}
      >
        <Tooltip label="Show plot style">
          <ActionIcon variant="subtle" onClick={onToggle} mt={4} aria-label="Show plot style">
            <IconChevronLeft size={16} />
          </ActionIcon>
        </Tooltip>
        <Text
          size="xs"
          c="dimmed"
          mt="sm"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          Style
        </Text>
      </Paper>
    );
  }

  return (
    <Paper
      withBorder
      p="sm"
      style={{ width: 310, flexShrink: 0, maxHeight: 590, overflowY: "auto" }}
    >
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">
          Plot style
        </Text>
        <Tooltip label="Hide plot style">
          <ActionIcon variant="subtle" onClick={onToggle} aria-label="Hide plot style">
            <IconChevronRight size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Stack gap={6} mb="sm">
        <Select
          label="Style preset"
          placeholder={presetQuery.isLoading ? "Loading presets..." : "Choose preset"}
          data={availablePresets.map((preset) => ({
            value: preset.id,
            label: `${preset.name}${preset.is_default ? " (default)" : ""}`,
          }))}
          value={selectedPresetId}
          onChange={setSelectedPresetId}
          clearable
        />
        <Group gap="md">
          <Checkbox
            size="xs"
            label="Apply ranges"
            checked={applyPresetRanges}
            onChange={(event) => setApplyPresetRanges(event.currentTarget.checked)}
          />
          <Checkbox
            size="xs"
            label="Apply ticks"
            checked={applyPresetTicks}
            onChange={(event) => setApplyPresetTicks(event.currentTarget.checked)}
          />
        </Group>
        <Group grow>
          <Button
            size="xs"
            variant="default"
            disabled={!selectedPresetId}
            onClick={applySelectedPreset}
          >
            Apply
          </Button>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={13} />}
            onClick={() => {
              setPresetFamily(axisScope === "time_capacity" ? "time_capacity" : "cycles");
              setSavePresetOpen(true);
            }}
          >
            Save current
          </Button>
        </Group>
      </Stack>
      <Accordion multiple defaultValue={["colors", "axes", "ce-overlay"]}>
        <Accordion.Item value="colors">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Colors
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Select
                label="Palette"
                data={paletteOptions}
                value={style.palette_id ? `user:${style.palette_id}` : style.palette}
                onChange={(value) =>
                  value &&
                  setStyle((next) => {
                    if (value.startsWith("user:")) {
                      const palette = paletteQuery.data?.palettes.find(
                        (item) => item.id === value.slice(5),
                      );
                      if (!palette) return;
                      next.palette = "custom";
                      next.palette_id = palette.id;
                      next.palette_colors = [...palette.colors];
                      next.custom_colors = {};
                      return;
                    }
                    if (value === "custom") {
                      // freeze the CURRENT colors so nothing jumps
                      snapshotPaletteColors(next, colorTargets);
                      next.palette_id = null;
                      next.palette_colors = [];
                      next.palette = "custom";
                      return;
                    }
                    next.palette_id = null;
                    next.palette_colors = [];
                    next.custom_colors = {};
                    next.palette = value as PlotStyle["palette"];
                  })
                }
              />
              {colorTargets.length > 0 && (
                <Stack gap={6}>
                  {colorTargets.map((target, index) => {
                    const activePalette = plotPalette(style);
                    const fallback = activePalette[index % activePalette.length];
                    return (
                      <DebouncedColorInput
                        key={target.key}
                        label={target.label}
                        description={target.sub}
                        value={style.custom_colors[target.key] ?? fallback}
                        format="hex"
                        onCommit={(value) =>
                          setStyle((next) => {
                            if (next.palette !== "custom") {
                              // editing one series must not repaint the others:
                              // snapshot the active palette before going custom
                              snapshotPaletteColors(next, colorTargets);
                              next.palette = "custom";
                            }
                            next.custom_colors[target.key] = value;
                          })
                        }
                        swatches={COLOR_SWATCHES}
                        swatchesPerRow={8}
                      />
                    );
                  })}
                </Stack>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="lines">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Lines
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              {/* The controls below apply to every series at once; this opens
                  the editor for styling series individually or by rule. */}
              {buildSeriesPreview && (
                <>
                  <Button
                    variant="light"
                    leftSection={<IconPalette size={15} />}
                    onClick={() => setSeriesStyleOpen(true)}
                  >
                    Series appearance…
                  </Button>
                  {seriesStyleSummary && (
                    <Text size="xs" c="dimmed">
                      {seriesStyleSummary}
                    </Text>
                  )}
                </>
              )}
              <Divider label="Applies to all series" labelPosition="left" />
              <Group grow>
                <DebouncedNumberInput
                  label="Width"
                  min={0.5}
                  max={8}
                  step={0.25}
                  value={style.line_width}
                  onCommit={(value) =>
                    setStyle((next) => void (next.line_width = value ?? 2.5))
                  }
                />
                <Select
                  label="Dash"
                  data={[
                    { value: "solid", label: "Solid" },
                    { value: "dot", label: "Dot" },
                    { value: "dash", label: "Dash" },
                    { value: "longdash", label: "Long dash" },
                  ]}
                  value={style.line_dash}
                  onChange={(value) =>
                    value && setStyle((next) => void (next.line_dash = value as PlotStyle["line_dash"]))
                  }
                />
              </Group>
              <Group grow>
                <Select
                  label="Markers"
                  data={[
                    { value: "none", label: "None" },
                    { value: "points", label: "Points" },
                    { value: "lines_points", label: "Lines + points" },
                  ]}
                  value={style.marker_mode}
                  onChange={(value) =>
                    value && setStyle((next) => void (next.marker_mode = value as PlotStyle["marker_mode"]))
                  }
                />
                <DebouncedNumberInput
                  label="Size"
                  min={2}
                  max={14}
                  value={style.marker_size}
                  onCommit={(value) =>
                    setStyle((next) => void (next.marker_size = value ?? 5))
                  }
                />
              </Group>
              {style.marker_mode !== "none" && (
                <Group grow align="flex-end">
                  <Select
                    label="Marker shape"
                    data={MARKER_SYMBOL_OPTIONS}
                    value={style.marker_symbol}
                    onChange={(value) =>
                      value &&
                      setStyle((next) => void (next.marker_symbol = value as PlotStyle["marker_symbol"]))
                    }
                  />
                  <Switch
                    label="Open (outline only)"
                    checked={style.marker_open}
                    onChange={(event) =>
                      setStyle((next) => void (next.marker_open = event.currentTarget.checked))
                    }
                    mb={8}
                  />
                </Group>
              )}
              <Group grow>
                <DebouncedNumberInput
                  label="Cells opacity"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={style.individual_opacity}
                  onCommit={(value) =>
                    setStyle((next) => void (next.individual_opacity = value ?? 0.35))
                  }
                />
                <DebouncedNumberInput
                  label="Band opacity"
                  min={0.02}
                  max={0.6}
                  step={0.02}
                  value={style.band_opacity}
                  onCommit={(value) =>
                    setStyle((next) => void (next.band_opacity = value ?? 0.18))
                  }
                />
              </Group>
              {axisScope === "cycles" && (
                <>
                  <Divider label="Below minimum replicate count" labelPosition="left" />
                  <Text size="xs" c="dimmed">
                    These markers identify aggregate points where fewer cells contribute than the
                    minimum selected for the replicate band.
                  </Text>
                  <DebouncedColorInput
                    label="Point color"
                    value={style.low_n_color}
                    format="hex"
                    onCommit={(value) => setStyle((next) => void (next.low_n_color = value))}
                    swatches={COLOR_SWATCHES}
                    swatchesPerRow={8}
                  />
                  <Group grow>
                    <Select
                      label="Marker"
                      data={[
                        { value: "circle", label: "Circle" },
                        { value: "square", label: "Square" },
                        { value: "diamond", label: "Diamond" },
                        { value: "cross", label: "Cross" },
                        { value: "x", label: "X" },
                        { value: "triangle-up", label: "Triangle" },
                      ]}
                      value={style.low_n_marker_symbol}
                      onChange={(value) =>
                        value &&
                        setStyle(
                          (next) =>
                            void (next.low_n_marker_symbol =
                              value as PlotStyle["low_n_marker_symbol"])
                        )
                      }
                    />
                    <DebouncedNumberInput
                      label="Marker size"
                      min={2}
                      max={20}
                      value={style.low_n_marker_size}
                      onCommit={(value) =>
                        setStyle((next) => void (next.low_n_marker_size = value ?? 8))
                      }
                    />
                  </Group>
                </>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {ceOverlayActive && (
          <Accordion.Item value="ce-overlay">
            <Accordion.Control>
              <Text fw={700} size="sm">
                CE overlay
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  These settings apply only to coulombic-efficiency traces on the right axis.
                </Text>
                <Select
                  label="CE colors"
                  data={[
                    { value: "match", label: "Match primary series" },
                    { value: "secondary", label: "Independent palette" },
                    { value: "single", label: "Single color" },
                  ]}
                  value={style.ce_palette_mode ?? "match"}
                  onChange={(value) =>
                    value &&
                    setStyle((next) => {
                      next.ce_palette_mode = value as NonNullable<PlotStyle["ce_palette_mode"]>;
                      next.ce_custom_colors = {};
                    })
                  }
                />
                {(style.ce_palette_mode ?? "match") === "secondary" && (
                  <Select
                    label="CE palette"
                    data={paletteOptions.filter(
                      (option) => !("value" in option) || option.value !== "custom",
                    )}
                    value={
                      style.ce_palette_id
                        ? `user:${style.ce_palette_id}`
                        : "app"
                    }
                    onChange={(value) =>
                      value &&
                      setStyle((next) => {
                        if (value.startsWith("user:")) {
                          const palette = paletteQuery.data?.palettes.find(
                            (item) => item.id === value.slice(5),
                          );
                          if (!palette) return;
                          next.ce_palette_id = palette.id;
                          next.ce_palette_colors = [...palette.colors];
                        } else {
                          next.ce_palette_id = null;
                          next.ce_palette_colors = [
                            ...(PLOT_PALETTES[value as PlotStyle["palette"]] ??
                              PLOT_PALETTES.app),
                          ];
                        }
                        next.ce_custom_colors = {};
                      })
                    }
                  />
                )}
                {(style.ce_palette_mode ?? "match") === "single" && (
                  <DebouncedColorInput
                    label="CE color"
                    value={style.ce_single_color ?? "#495057"}
                    format="hex"
                    onCommit={(value) =>
                      setStyle((next) => {
                        next.ce_single_color = value;
                        next.ce_custom_colors = {};
                      })
                    }
                    swatches={COLOR_SWATCHES}
                    swatchesPerRow={8}
                  />
                )}
                {colorTargets.length > 0 && (
                  <Stack gap={6}>
                    {colorTargets.map((target, index) => {
                      const palette =
                        style.ce_palette_mode === "secondary"
                          ? cePalette(style)
                          : plotPalette(style);
                      const mainColor =
                        style.ce_palette_mode === "single"
                          ? style.ce_single_color ?? "#495057"
                          : style.custom_colors[target.key] ?? palette[index % palette.length];
                      return (
                        <DebouncedColorInput
                          key={`ce-${target.key}`}
                          label={`${target.label} CE`}
                          description={target.sub}
                          value={style.ce_custom_colors[target.key] ?? mainColor}
                          format="hex"
                          onCommit={(value) =>
                            setStyle((next) => {
                              next.ce_custom_colors[target.key] = value;
                            })
                          }
                          swatches={COLOR_SWATCHES}
                          swatchesPerRow={8}
                        />
                      );
                    })}
                  </Stack>
                )}
                <Group grow>
                  <DebouncedNumberInput
                    label="Width"
                    min={0.5}
                    max={8}
                    step={0.25}
                    value={style.ce_line_width}
                    onCommit={(value) => setStyle((next) => void (next.ce_line_width = value ?? 1.5))}
                  />
                  <Select
                    label="Dash"
                    data={[
                      { value: "solid", label: "Solid" },
                      { value: "dot", label: "Dot" },
                      { value: "dash", label: "Dash" },
                      { value: "longdash", label: "Long dash" },
                    ]}
                    value={style.ce_line_dash}
                    onChange={(value) =>
                      value && setStyle((next) => void (next.ce_line_dash = value as PlotStyle["ce_line_dash"]))
                    }
                  />
                </Group>
                <Group grow>
                  <Select
                    label="Markers"
                    data={[
                      { value: "none", label: "None" },
                      { value: "points", label: "Points" },
                      { value: "lines_points", label: "Lines + points" },
                    ]}
                    value={style.ce_marker_mode}
                    onChange={(value) =>
                      value &&
                      setStyle((next) => void (next.ce_marker_mode = value as PlotStyle["ce_marker_mode"]))
                    }
                  />
                  <DebouncedNumberInput
                    label="Marker size"
                    min={2}
                    max={14}
                    value={style.ce_marker_size}
                    onCommit={(value) => setStyle((next) => void (next.ce_marker_size = value ?? 5))}
                  />
                </Group>
                {style.ce_marker_mode !== "none" && (
                  <Group grow align="flex-end">
                    <Select
                      label="Marker shape"
                      data={MARKER_SYMBOL_OPTIONS}
                      value={style.ce_marker_symbol ?? "circle"}
                      onChange={(value) =>
                        value &&
                        setStyle((next) => void (next.ce_marker_symbol = value as PlotStyle["ce_marker_symbol"]))
                      }
                    />
                    <Switch
                      label="Open (outline only)"
                      checked={style.ce_marker_open ?? false}
                      onChange={(event) =>
                        setStyle((next) => void (next.ce_marker_open = event.currentTarget.checked))
                      }
                      mb={8}
                    />
                  </Group>
                )}
                <DebouncedNumberInput
                  label="Opacity"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={style.ce_opacity}
                  onCommit={(value) => setStyle((next) => void (next.ce_opacity = value ?? 0.7))}
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}

        <Accordion.Item value="axes">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Axes
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <DebouncedTextInput
                label="X title"
                placeholder={axisScope === "time_capacity" ? "Time / capacity" : "Cycle"}
                value={style.x_title ?? ""}
                onCommit={(value) => setAxisTitle("x_title", value)}
              />
              <DebouncedTextInput
                label="Y title"
                placeholder={yTitlePlaceholder}
                value={style.y_title ?? ""}
                onCommit={(value) => setAxisTitle("y_title", value)}
              />
              <Select
                label="X range"
                data={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                ]}
                value={style.x_axis.mode}
                onChange={(value) =>
                  value && setAxis("x_axis", (axis) => void (axis.mode = value as "auto" | "manual"))
                }
              />
              {style.x_axis.mode === "manual" && (
                <Group grow>
                  <DebouncedNumberInput
                    label="X min"
                    placeholder="Auto"
                    step={0.1}
                    decimalScale={8}
                    error={axisRangeError(style.x_axis)}
                    value={style.x_axis.min}
                    onCommit={(value) => setAxis("x_axis", (axis) => void (axis.min = value))}
                  />
                  <DebouncedNumberInput
                    label="X max"
                    placeholder="Auto"
                    step={0.1}
                    decimalScale={8}
                    value={style.x_axis.max}
                    onCommit={(value) => setAxis("x_axis", (axis) => void (axis.max = value))}
                  />
                </Group>
              )}
              <Select
                label="Y range"
                data={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                ]}
                value={style.y_axis.mode}
                onChange={(value) =>
                  value && setAxis("y_axis", (axis) => void (axis.mode = value as "auto" | "manual"))
                }
              />
              {style.y_axis.mode === "manual" && (
                <Group grow>
                  <DebouncedNumberInput
                    label="Y min"
                    placeholder="Auto"
                    step={0.1}
                    decimalScale={8}
                    error={axisRangeError(style.y_axis)}
                    value={style.y_axis.min}
                    onCommit={(value) => setAxis("y_axis", (axis) => void (axis.min = value))}
                  />
                  <DebouncedNumberInput
                    label="Y max"
                    placeholder="Auto"
                    step={0.1}
                    decimalScale={8}
                    value={style.y_axis.max}
                    onCommit={(value) => setAxis("y_axis", (axis) => void (axis.max = value))}
                  />
                </Group>
              )}
              <Text size="10px" c="dimmed">
                Leave one bound empty to clamp only that side.
              </Text>
              <Group grow align="start">
                <Select
                  label="X ticks"
                  data={[
                    { value: "auto", label: "Automatic" },
                    { value: "step", label: "Step size" },
                    { value: "count", label: "Tick count" },
                  ]}
                  value={style.x_axis.tick_mode}
                  onChange={(value) =>
                    value &&
                    setAxis(
                      "x_axis",
                      (axis) => void (axis.tick_mode = value as PlotStyle["x_axis"]["tick_mode"])
                    )
                  }
                />
                {style.x_axis.tick_mode === "step" ? (
                  <DebouncedNumberInput
                    label="X step"
                    min={0}
                    step={0.1}
                    decimalScale={8}
                    value={style.x_axis.dtick}
                    onCommit={(value) =>
                      setAxis("x_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                    }
                  />
                ) : style.x_axis.tick_mode === "count" ? (
                  <DebouncedNumberInput
                    label="X tick count"
                    min={2}
                    max={30}
                    step={1}
                    allowDecimal={false}
                    value={style.x_axis.tick_count}
                    onCommit={(value) =>
                      setAxis(
                        "x_axis",
                        (axis) => void (axis.tick_count = value && value >= 2 ? Math.round(value) : null)
                      )
                    }
                  />
                ) : <div />}
              </Group>
              <Group grow align="start">
                <Select
                  label="Y ticks"
                  data={[
                    { value: "auto", label: "Automatic" },
                    { value: "step", label: "Step size" },
                    { value: "count", label: "Tick count" },
                  ]}
                  value={style.y_axis.tick_mode}
                  onChange={(value) =>
                    value &&
                    setAxis(
                      "y_axis",
                      (axis) => void (axis.tick_mode = value as PlotStyle["y_axis"]["tick_mode"])
                    )
                  }
                />
                {style.y_axis.tick_mode === "step" ? (
                  <DebouncedNumberInput
                    label="Y step"
                    min={0}
                    step={0.1}
                    decimalScale={8}
                    value={style.y_axis.dtick}
                    onCommit={(value) =>
                      setAxis("y_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                    }
                  />
                ) : style.y_axis.tick_mode === "count" ? (
                  <DebouncedNumberInput
                    label="Y tick count"
                    min={2}
                    max={30}
                    step={1}
                    allowDecimal={false}
                    value={style.y_axis.tick_count}
                    onCommit={(value) =>
                      setAxis(
                        "y_axis",
                        (axis) => void (axis.tick_count = value && value >= 2 ? Math.round(value) : null)
                      )
                    }
                  />
                ) : <div />}
              </Group>
              <Group grow>
                <DebouncedNumberInput
                  label="X title gap"
                  description="Axis title to tick labels"
                  min={0}
                  max={80}
                  value={style.x_axis.title_standoff}
                  onCommit={(value) =>
                    setAxis("x_axis", (axis) => void (axis.title_standoff = value ?? 14))
                  }
                />
                <DebouncedNumberInput
                  label="X label gap"
                  description="Tick labels to axis"
                  min={0}
                  max={40}
                  value={style.x_axis.tick_label_standoff}
                  onCommit={(value) =>
                    setAxis("x_axis", (axis) => void (axis.tick_label_standoff = value ?? 4))
                  }
                />
              </Group>
              <Group grow>
                <DebouncedNumberInput
                  label="Y title gap"
                  description="Axis title to tick labels"
                  min={0}
                  max={80}
                  value={style.y_axis.title_standoff}
                  onCommit={(value) =>
                    setAxis("y_axis", (axis) => void (axis.title_standoff = value ?? 14))
                  }
                />
                <DebouncedNumberInput
                  label="Y label gap"
                  description="Tick labels to axis"
                  min={0}
                  max={40}
                  value={style.y_axis.tick_label_standoff}
                  onCommit={(value) =>
                    setAxis("y_axis", (axis) => void (axis.tick_label_standoff = value ?? 4))
                  }
                />
              </Group>
              {showRightAxisControls && (
                <>
                  <Divider label={ceOverlayActive ? "Right axis (CE)" : "Second current axis"} labelPosition="left" />
                  <DebouncedTextInput
                    label="Right axis title"
                    placeholder={ceOverlayActive ? "CE (%)" : "Current / C-rate"}
                    value={style.y2_title ?? ""}
                    onCommit={(value) => setAxisTitle("y2_title", value)}
                  />
                  <Select
                    label="Right axis range"
                    data={[
                      { value: "auto", label: "Auto" },
                      { value: "manual", label: "Manual" },
                    ]}
                    value={style.y2_axis.mode}
                    onChange={(value) =>
                      value && setAxis("y2_axis", (axis) => void (axis.mode = value as "auto" | "manual"))
                    }
                  />
                  {style.y2_axis.mode === "manual" && (
                    <Group grow>
                      <DebouncedNumberInput
                        label="Right min"
                        placeholder="Auto"
                        step={0.1}
                        decimalScale={8}
                        error={axisRangeError(style.y2_axis)}
                        value={style.y2_axis.min}
                        onCommit={(value) => setAxis("y2_axis", (axis) => void (axis.min = value))}
                      />
                      <DebouncedNumberInput
                        label="Right max"
                        placeholder="Auto"
                        step={0.1}
                        decimalScale={8}
                        value={style.y2_axis.max}
                        onCommit={(value) => setAxis("y2_axis", (axis) => void (axis.max = value))}
                      />
                    </Group>
                  )}
                  <Select
                    label="Right ticks"
                    data={[
                      { value: "auto", label: "Automatic" },
                      { value: "step", label: "Step size" },
                      { value: "count", label: "Tick count" },
                    ]}
                    value={style.y2_axis.tick_mode}
                    onChange={(value) =>
                      value &&
                      setAxis(
                        "y2_axis",
                        (axis) => void (axis.tick_mode = value as PlotStyle["y2_axis"]["tick_mode"])
                      )
                    }
                  />
                  {style.y2_axis.tick_mode === "step" && (
                    <DebouncedNumberInput
                      label="Right tick step"
                      min={0}
                      step={0.1}
                      decimalScale={8}
                      value={style.y2_axis.dtick}
                      onCommit={(value) =>
                        setAxis("y2_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                      }
                    />
                  )}
                  {style.y2_axis.tick_mode === "count" && (
                    <DebouncedNumberInput
                      label="Right tick count"
                      min={2}
                      max={30}
                      step={1}
                      allowDecimal={false}
                      value={style.y2_axis.tick_count}
                      onCommit={(value) =>
                        setAxis(
                          "y2_axis",
                          (axis) => void (axis.tick_count = value && value >= 2 ? Math.round(value) : null)
                        )
                      }
                    />
                  )}
                  <Group grow>
                    <DebouncedNumberInput
                      label="Right title gap"
                      description="Axis title to tick labels"
                      min={0}
                      max={80}
                      value={style.y2_axis.title_standoff}
                      onCommit={(value) =>
                        setAxis("y2_axis", (axis) => void (axis.title_standoff = value ?? 14))
                      }
                    />
                    <DebouncedNumberInput
                      label="Right label gap"
                      description="Tick labels to axis"
                      min={0}
                      max={40}
                      value={style.y2_axis.tick_label_standoff}
                      onCommit={(value) =>
                        setAxis("y2_axis", (axis) => void (axis.tick_label_standoff = value ?? 4))
                      }
                    />
                  </Group>
                </>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="fonts">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Fonts and ticks
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Group grow>
                <DebouncedNumberInput
                  label="Axis title size"
                  min={6}
                  max={40}
                  value={style.axis_title_size}
                  onCommit={(value) => setStyle((next) => void (next.axis_title_size = value ?? 14))}
                />
                <DebouncedNumberInput
                  label="Tick label size"
                  min={5}
                  max={32}
                  value={style.tick_font_size}
                  onCommit={(value) => setStyle((next) => void (next.tick_font_size = value ?? 12))}
                />
              </Group>
              <DebouncedNumberInput
                label="Legend size"
                min={5}
                max={32}
                value={style.legend_font_size}
                onCommit={(value) => setStyle((next) => void (next.legend_font_size = value ?? 12))}
              />
              <Select
                label="Tick marks"
                data={[
                  { value: "none", label: "None" },
                  { value: "outside", label: "Outside" },
                  { value: "inside", label: "Inside" },
                ]}
                value={style.tick_marks}
                onChange={(value) =>
                  value && setStyle((next) => void (next.tick_marks = value as PlotStyle["tick_marks"]))
                }
              />
              {style.tick_marks !== "none" && (
                <Group grow>
                  <DebouncedNumberInput
                    label="Tick length"
                    min={1}
                    max={20}
                    value={style.tick_length}
                    onCommit={(value) => setStyle((next) => void (next.tick_length = value ?? 5))}
                  />
                  <DebouncedNumberInput
                    label="Tick width"
                    min={0.5}
                    max={5}
                    step={0.5}
                    value={style.tick_width}
                    onCommit={(value) => setStyle((next) => void (next.tick_width = value ?? 1))}
                  />
                </Group>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="frame">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Grid and frame
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Switch
                label="Grid"
                checked={style.show_grid}
                onChange={(event) =>
                  setStyle((next) => void (next.show_grid = event.currentTarget.checked))
                }
              />
              <Switch
                label="Zero line (Y)"
                checked={style.show_zero_line}
                onChange={(event) =>
                  setStyle((next) => void (next.show_zero_line = event.currentTarget.checked))
                }
              />
              <Switch
                label="Border"
                checked={style.show_frame}
                onChange={(event) =>
                  setStyle((next) => void (next.show_frame = event.currentTarget.checked))
                }
              />
              <Group grow>
                <DebouncedColorInput
                  label="Border color"
                  value={style.frame_color}
                  format="hex"
                  onCommit={(value) => setStyle((next) => void (next.frame_color = value))}
                  swatches={COLOR_SWATCHES}
                  swatchesPerRow={8}
                />
                <DebouncedNumberInput
                  label="Border width"
                  min={1}
                  max={5}
                  value={style.frame_width}
                  onCommit={(value) => setStyle((next) => void (next.frame_width = value ?? 1))}
                />
              </Group>
              <Group grow>
                <DebouncedColorInput
                  label="Plot bg"
                  value={style.plot_bgcolor}
                  format="hex"
                  onCommit={(value) => setStyle((next) => void (next.plot_bgcolor = value))}
                  swatches={COLOR_SWATCHES}
                  swatchesPerRow={8}
                />
                <DebouncedColorInput
                  label="Paper bg"
                  value={style.paper_bgcolor}
                  format="hex"
                  onCommit={(value) => setStyle((next) => void (next.paper_bgcolor = value))}
                  swatches={COLOR_SWATCHES}
                  swatchesPerRow={8}
                />
              </Group>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="legend">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Legend
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Switch
                label="Show legend"
                checked={spec.presentation.legend}
                onChange={(event) =>
                  update((s) => void (s.presentation.legend = event.currentTarget.checked))
                }
              />
              {spec.presentation.legend && (
                <>
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    radius={4}
                    data={[
                      { value: "outside", label: "Outside" },
                      { value: "inside", label: "Inside" },
                    ]}
                    value={style.legend_mode === "outside" ? "outside" : "inside"}
                    styles={{
                      root: { padding: 3 },
                      indicator: { boxShadow: "none", border: "1px solid var(--mantine-color-gray-3)" },
                      label: { paddingBlock: 6 },
                    }}
                    onChange={(value) =>
                      setStyle((next) => {
                        next.legend_mode = value as "outside" | "inside";
                        if (value === "inside" && next.legend_inside_position === "custom") {
                          next.legend_custom_x = Math.min(1, Math.max(0, next.legend_custom_x));
                          next.legend_custom_y = Math.min(1, Math.max(0, next.legend_custom_y));
                        }
                      })
                    }
                  />
                  {style.legend_mode === "outside" ? (
                    <Select
                      label="Side"
                      data={[
                        { value: "bottom", label: "Bottom" },
                        { value: "top", label: "Top" },
                        { value: "left", label: "Left" },
                        { value: "right", label: "Right" },
                      ]}
                      value={style.legend_side}
                      onChange={(value) =>
                        value &&
                        setStyle((next) => void (next.legend_side = value as PlotStyle["legend_side"]))
                      }
                    />
                  ) : (
                    <>
                      <Select
                        label="Position"
                        data={LEGEND_INSIDE_POSITION_OPTIONS}
                        value={style.legend_inside_position}
                        onChange={(value) =>
                          value &&
                          setStyle((next) => {
                            next.legend_mode = "inside";
                            next.legend_inside_position = value as PlotStyle["legend_inside_position"];
                          })
                        }
                      />
                      <SegmentedControl
                        size="xs"
                        fullWidth
                        radius={4}
                        data={[
                          { value: "h", label: "Horizontal" },
                          { value: "v", label: "Vertical" },
                        ]}
                        value={style.legend_orientation}
                        onChange={(value) =>
                          setStyle((next) => void (next.legend_orientation = value as "h" | "v"))
                        }
                      />
                      <Text size="10px" c="dimmed">
                        Drag the legend directly on the plot for a custom position. The dragged position is saved with the plot.
                      </Text>
                    </>
                  )}
                  {((style.legend_mode === "outside" && ["top", "bottom"].includes(style.legend_side)) ||
                    (style.legend_mode !== "outside" && style.legend_orientation === "h")) && (
                    <DebouncedNumberInput
                      label="Legend entry width (px)"
                      description="Use 0 for automatic sizing. Wider entries flow onto additional rows sooner."
                      min={0}
                      max={600}
                      step={20}
                      value={style.legend_entry_width}
                      onCommit={(value) =>
                        setStyle((next) => void (next.legend_entry_width = Math.max(0, value ?? 0)))
                      }
                    />
                  )}
                </>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      {buildSeriesPreview && (
        <SeriesStyleModal
          opened={seriesStyleOpen}
          onClose={() => setSeriesStyleOpen(false)}
          descriptors={seriesDescriptors}
          overrides={style.series_overrides ?? {}}
          rules={style.series_rules ?? []}
          baseFor={seriesBaseFor}
          buildPreview={buildSeriesPreview}
          onChange={({ overrides, rules }) =>
            setStyle((next) => {
              next.series_overrides = overrides;
              next.series_rules = rules;
            })
          }
        />
      )}
      <Modal
        opened={savePresetOpen}
        onClose={() => setSavePresetOpen(false)}
        title="Save plot-style preset"
        centered
      >
        <Stack gap="sm">
          <TextInput
            label="Preset name"
            value={presetName}
            onChange={(event) => setPresetName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && presetName.trim()) savePreset.mutate();
            }}
            autoFocus
          />
          <Select
            label="Available for"
            value={presetFamily}
            data={[
              { value: "all", label: "All plot types" },
              { value: "cycles", label: "Cycles plots" },
              { value: "time_capacity", label: "Time / capacity plots" },
            ]}
            onChange={(value) =>
              value &&
              setPresetFamily(value as "all" | "cycles" | "time_capacity")
            }
          />
          <Switch
            label="Use as default for new plots"
            checked={presetDefault}
            onChange={(event) => setPresetDefault(event.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            The preset stores all current styling, ranges, and tick settings. When applying it,
            ranges and ticks can be left unchanged independently.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSavePresetOpen(false)}>
              Cancel
            </Button>
            <Button
              leftSection={<IconDeviceFloppy size={14} />}
              disabled={!presetName.trim()}
              loading={savePreset.isPending}
              onClick={() => savePreset.mutate()}
            >
              Save preset
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
