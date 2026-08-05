import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  ColorInput,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconRotate,
  IconTrash,
} from "@tabler/icons-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import type {
  PlotLineDash,
  PlotMarkerMode,
  PlotMarkerSymbol,
  SeriesStyleOverride,
  SeriesStyleRule,
} from "../api";
import {
  DEFAULT_SHADOW,
  SERIES_RULE_FIELDS,
  SERIES_RULE_OPERATORS,
  emptySeriesRule,
  isEmptyOverride,
  matchingRules,
  pruneOverrides,
  resolveSeriesStyle,
  seriesRuleError,
  type BaseSeriesStyle,
  type SeriesDescriptor,
} from "../seriesStyling";
import Plot from "./Plot";

/** The real plot, rebuilt with the draft styling applied. */
export type SeriesPreviewBuilder = (
  overrides: Record<string, SeriesStyleOverride>,
  rules: SeriesStyleRule[],
) => { data: unknown[]; layout: Record<string, unknown> };

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
const SERIES_PANEL_WIDTH = 260;
/** Collapsed: swatch and visibility only, which is what picking a series needs. */
const SERIES_PANEL_COLLAPSED_WIDTH = 62;

/** Commit delay: long enough to swallow a colour drag, short enough to feel live. */
const COMMIT_DEBOUNCE_MS = 250;

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
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>("series");
  const [seriesCollapsed, setSeriesCollapsed] = useState(false);

  // Local draft. The spec is only written on a debounce and on close.
  const [draftOverrides, setDraftOverrides] = useState(overrides);
  const [draftRules, setDraftRules] = useState(rules);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ overrides: Record<string, SeriesStyleOverride>; rules: SeriesStyleRule[] } | null>(
    null,
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!opened) return;
    setDraftOverrides(overrides);
    setDraftRules(rules);
    setActiveKey((current) =>
      current && descriptors.some((d) => d.key === current) ? current : descriptors[0]?.key ?? null,
    );
    // Only when the dialog opens: re-syncing on every prop change would fight
    // the debounce and undo edits mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const flush = useCallback(() => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    if (pending.current) {
      onChangeRef.current(pending.current);
      pending.current = null;
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

  const handleClose = () => {
    flush();
    onClose();
  };

  const active = useMemo(
    () => descriptors.find((d) => d.key === activeKey) ?? descriptors[0] ?? null,
    [descriptors, activeKey],
  );

  const resolvedByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveSeriesStyle>>();
    for (const descriptor of descriptors) {
      map.set(
        descriptor.key,
        resolveSeriesStyle(baseFor(descriptor), descriptor, draftRules, draftOverrides),
      );
    }
    return map;
  }, [descriptors, draftRules, draftOverrides, baseFor]);

  const setOverride = (key: string, patch: SeriesStyleOverride) =>
    commit(
      pruneOverrides({ ...draftOverrides, [key]: { ...(draftOverrides[key] ?? {}), ...patch } }),
      draftRules,
    );

  const clearOverride = (key: string) => {
    const next = { ...draftOverrides };
    delete next[key];
    commit(next, draftRules);
  };

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
  const preview = useMemo(
    () => (opened ? buildPreview(previewOverrides, previewRules) : { data: [], layout: {} }),
    [opened, buildPreview, previewOverrides, previewRules],
  );

  const activeOverride = active ? draftOverrides[active.key] ?? {} : {};
  const activeResolved = active ? resolvedByKey.get(active.key) : null;
  const activeRules = active ? matchingRules(active, draftRules) : [];
  const markerMode = activeResolved?.markerMode ?? "none";
  const lineEnabled = markerMode !== "points";
  const markersEnabled = markerMode !== "none";

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Series appearance"
      size="94rem"
      styles={{ content: { height: "min(58rem, 94vh)", display: "flex", flexDirection: "column" } }}
    >
      <Group align="stretch" gap="sm" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        {/* The plot is deliberately fixed width. It used to share the row with
            flexible panels, so switching to Rules — whose controls are wider —
            resized the plot and forced Plotly to relayout on every tab change. */}
        <PanelShell title="Preview" style={{ width: PREVIEW_WIDTH, flex: "none" }}>
          <Plot
            data={preview.data as never}
            layout={
              {
                ...preview.layout,
                autosize: true,
                width: undefined,
                height: undefined,
                margin: { l: 56, r: 16, t: 16, b: 48 },
              } as never
            }
            config={{ displayModeBar: false, responsive: true } as never}
            useResizeHandler
            style={{ width: "100%", height: "100%", flex: 1, minHeight: 0 }}
          />
        </PanelShell>

        <PanelShell
          title={seriesCollapsed ? "" : "Series"}
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
              {descriptors.map((descriptor) => {
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
                    aria-label={style?.hidden ? `Show ${descriptor.label}` : `Hide ${descriptor.label}`}
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
            </Stack>
          </ScrollArea>
        </PanelShell>

        <PanelShell
          title={tab === "rules" ? "Rules" : "Appearance"}
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

                <Group grow align="start">
                  <LegendNameInput
                    seriesKey={active.key}
                    placeholder={active.label}
                    value={activeOverride.name ?? ""}
                    onCommit={(next) => setOverride(active.key, { name: next || null })}
                  />
                  <ColorInput
                    size="xs"
                    label="Colour"
                    format="hex"
                    value={activeResolved?.color ?? "#000000"}
                    onChange={(value) => setOverride(active.key, { color: value })}
                  />
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
                      style={{ minWidth: 176 }}
                      label="Colour"
                      description=" "
                      format="hex"
                      value={activeResolved.shadowColor ?? DEFAULT_SHADOW.color}
                      onChange={(value) => setOverride(active.key, { shadow_color: value })}
                    />
                    <NumberInput
                      size="xs"
                      style={{ minWidth: 132 }}
                      label="Opacity"
                      description=" "
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
                      style={{ minWidth: 132 }}
                      label="Spread"
                      description="px"
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
                      style={{ minWidth: 132 }}
                      label="Offset X"
                      description="% of span"
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
                      style={{ minWidth: 132 }}
                      label="Offset Y"
                      description="% of span"
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
function LegendNameInput({
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

  return (
    <TextInput
      size="xs"
      label="Legend name"
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commitRef.current(next), 200);
      }}
      onBlur={() => {
        if (timer.current) clearTimeout(timer.current);
        commitRef.current(text);
      }}
    />
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
