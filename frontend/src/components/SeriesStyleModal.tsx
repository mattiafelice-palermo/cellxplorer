import {
  ActionIcon,
  Alert,
  Badge,
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
  IconEye,
  IconEyeOff,
  IconPlus,
  IconRotate,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import type {
  PlotLineDash,
  PlotMarkerMode,
  PlotMarkerSymbol,
  SeriesStyleOverride,
  SeriesStyleRule,
} from "../api";
import {
  SERIES_RULE_FIELDS,
  SERIES_RULE_OPERATORS,
  emptySeriesRule,
  isEmptyOverride,
  matchingRules,
  pruneOverrides,
  resolveSeriesStyle,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  seriesRuleError,
  type BaseSeriesStyle,
  type SeriesDescriptor,
} from "../seriesStyling";
import Plot from "./Plot";

/** Sample curve for one series, used only by the preview. */
export interface SeriesPreviewData {
  key: string;
  x: number[];
  y: (number | null)[];
}

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
  { value: "none", label: "Line" },
  { value: "points", label: "Points" },
  { value: "lines_points", label: "Both" },
];

/**
 * Editor for how each series is drawn.
 *
 * Three layers, mirroring `seriesStyling.ts`: the tab's base style, ordered
 * rules for bulk changes, and a per-series override that always wins. The
 * preview re-resolves through the same function the real plot uses, so it
 * cannot drift from the result.
 */
export function SeriesStyleModal({
  opened,
  onClose,
  descriptors,
  overrides,
  rules,
  baseFor,
  previewData,
  onChange,
}: {
  opened: boolean;
  onClose: () => void;
  descriptors: SeriesDescriptor[];
  overrides: Record<string, SeriesStyleOverride>;
  rules: SeriesStyleRule[];
  /** Palette colour and tab defaults for a series, before overrides. */
  baseFor: (descriptor: SeriesDescriptor) => BaseSeriesStyle;
  previewData: SeriesPreviewData[];
  onChange: (next: {
    overrides: Record<string, SeriesStyleOverride>;
    rules: SeriesStyleRule[];
  }) => void;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(descriptors[0]?.key ?? null);
  const [tab, setTab] = useState<string | null>("series");

  const active = useMemo(
    () => descriptors.find((d) => d.key === activeKey) ?? descriptors[0] ?? null,
    [descriptors, activeKey],
  );

  const resolvedByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveSeriesStyle>>();
    for (const descriptor of descriptors) {
      map.set(descriptor.key, resolveSeriesStyle(baseFor(descriptor), descriptor, rules, overrides));
    }
    return map;
  }, [descriptors, rules, overrides, baseFor]);

  const setOverride = (key: string, patch: SeriesStyleOverride) => {
    const next = { ...overrides, [key]: { ...(overrides[key] ?? {}), ...patch } };
    onChange({ overrides: pruneOverrides(next), rules });
  };

  const clearOverride = (key: string) => {
    const next = { ...overrides };
    delete next[key];
    onChange({ overrides: next, rules });
  };

  const setRules = (nextRules: SeriesStyleRule[]) => onChange({ overrides, rules: nextRules });

  const patchRule = (id: string, patch: Partial<SeriesStyleRule>) =>
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  const patchRuleStyle = (id: string, patch: SeriesStyleOverride) =>
    setRules(
      rules.map((rule) => (rule.id === id ? { ...rule, style: { ...rule.style, ...patch } } : rule)),
    );

  const moveRule = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setRules(next);
  };

  const previewTraces = useMemo(() => {
    return previewData
      .map((data) => {
        const descriptor = descriptors.find((d) => d.key === data.key);
        if (!descriptor) return null;
        const style = resolvedByKey.get(data.key);
        if (!style || style.hidden) return null;
        return {
          x: data.x,
          y: data.y,
          type: "scatter" as const,
          mode: seriesPlotlyMode(style),
          name: style.name,
          showlegend: style.showInLegend,
          opacity: style.opacity,
          line: {
            color: style.color,
            width: style.lineWidth,
            dash: style.lineDash,
            shape: style.lineShape,
          },
          marker: {
            color: style.color,
            size: style.markerSize,
            symbol: seriesPlotlySymbol(style),
          },
        };
      })
      .filter(Boolean) as Record<string, unknown>[];
  }, [previewData, descriptors, resolvedByKey]);

  const shadowTraces = useMemo(() => {
    return previewData
      .map((data) => {
        const style = resolvedByKey.get(data.key);
        if (!style || style.hidden || !style.shadow) return null;
        return {
          x: data.x,
          y: data.y,
          type: "scatter" as const,
          mode: "lines" as const,
          hoverinfo: "skip" as const,
          showlegend: false,
          opacity: 0.18,
          line: { color: "#000000", width: style.lineWidth + 4, dash: style.lineDash },
        };
      })
      .filter(Boolean) as Record<string, unknown>[];
  }, [previewData, resolvedByKey]);

  const activeOverride = active ? overrides[active.key] ?? {} : {};
  const activeResolved = active ? resolvedByKey.get(active.key) : null;
  const activeRules = active ? matchingRules(active, rules) : [];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Series appearance"
      size="82rem"
      styles={{ content: { height: "min(56rem, 94vh)", display: "flex", flexDirection: "column" } }}
    >
      <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
        <Paper withBorder p="xs" style={{ flex: "none" }}>
          <Plot
            data={[...shadowTraces, ...previewTraces] as never}
            layout={
              {
                height: 240,
                margin: { l: 48, r: 12, t: 8, b: 36 },
                showlegend: true,
                legend: { orientation: "h", y: -0.25 },
                paper_bgcolor: "rgba(0,0,0,0)",
                plot_bgcolor: "rgba(0,0,0,0)",
              } as never
            }
            config={{ displayModeBar: false, responsive: true } as never}
            style={{ width: "100%" }}
          />
        </Paper>

        <Group align="stretch" gap="sm" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
          <Paper
            withBorder
            p="xs"
            w={260}
            style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}
          >
            <Group justify="space-between" mb={6} style={{ flex: "none" }}>
              <Text size="sm" fw={700}>
                Series
              </Text>
              <Badge size="xs" variant="light">
                {descriptors.length}
              </Badge>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
              <Stack gap={2}>
                {descriptors.map((descriptor) => {
                  const style = resolvedByKey.get(descriptor.key);
                  const customised = !isEmptyOverride(overrides[descriptor.key]);
                  return (
                    <Group
                      key={descriptor.key}
                      gap={6}
                      wrap="nowrap"
                      px={6}
                      py={4}
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
                      <Text size="xs" truncate style={{ flex: 1 }} title={style?.name}>
                        {style?.name ?? descriptor.label}
                      </Text>
                      {customised && (
                        <Tooltip label="Has its own settings">
                          <Badge size="xs" variant="light" color="grape">
                            •
                          </Badge>
                        </Tooltip>
                      )}
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
                    </Group>
                  );
                })}
              </Stack>
            </ScrollArea>
          </Paper>

          <Paper
            withBorder
            p="sm"
            style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
          >
            <Tabs value={tab} onChange={setTab} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Tabs.List style={{ flex: "none" }}>
                <Tabs.Tab value="series">Selected series</Tabs.Tab>
                <Tabs.Tab value="rules">
                  Rules{rules.length ? ` (${rules.length})` : ""}
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="series" style={{ flex: 1, minHeight: 0 }}>
                <ScrollArea style={{ height: "100%" }} type="auto" offsetScrollbars>
                  {!active ? (
                    <Alert color="gray" mt="sm">
                      This plot has no series to style yet.
                    </Alert>
                  ) : (
                    <Stack gap="sm" pt="sm" pr="xs">
                      <Group justify="space-between" wrap="nowrap">
                        <Text size="sm" fw={700} truncate>
                          {active.label}
                        </Text>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          leftSection={<IconRotate size={13} />}
                          disabled={isEmptyOverride(overrides[active.key])}
                          onClick={() => clearOverride(active.key)}
                        >
                          Reset
                        </Button>
                      </Group>

                      {activeRules.length > 0 && (
                        <Alert color="blue" p="xs">
                          <Text size="xs">
                            {activeRules.length} rule{activeRules.length === 1 ? "" : "s"} also
                            appl{activeRules.length === 1 ? "ies" : "y"} here. Anything you set below
                            wins over them.
                          </Text>
                        </Alert>
                      )}

                      <TextInput
                        size="xs"
                        label="Legend name"
                        placeholder={active.label}
                        value={activeOverride.name ?? ""}
                        onChange={(event) =>
                          setOverride(active.key, { name: event.currentTarget.value || null })
                        }
                      />
                      <Group grow>
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

                      <Divider label="Line" labelPosition="left" />
                      <Group grow>
                        <Select
                          size="xs"
                          label="Dash"
                          data={DASH_OPTIONS}
                          allowDeselect={false}
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
                          value={activeResolved?.lineWidth ?? 2.5}
                          onChange={(value) =>
                            setOverride(active.key, {
                              line_width: value === "" ? null : Number(value),
                            })
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
                          value={activeResolved?.lineShape ?? "linear"}
                          onChange={(value) =>
                            setOverride(active.key, {
                              line_shape: (value as "linear" | "spline" | "hv") ?? null,
                            })
                          }
                        />
                      </Group>

                      <Divider label="Markers" labelPosition="left" />
                      <SegmentedControl
                        size="xs"
                        fullWidth
                        data={MARKER_MODE_OPTIONS}
                        value={activeResolved?.markerMode ?? "none"}
                        onChange={(value) =>
                          setOverride(active.key, { marker_mode: value as PlotMarkerMode })
                        }
                      />
                      <Group grow>
                        <Select
                          size="xs"
                          label="Symbol"
                          data={SYMBOL_OPTIONS}
                          allowDeselect={false}
                          disabled={activeResolved?.markerMode === "none"}
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
                          disabled={activeResolved?.markerMode === "none"}
                          value={activeResolved?.markerSize ?? 5}
                          onChange={(value) =>
                            setOverride(active.key, {
                              marker_size: value === "" ? null : Number(value),
                            })
                          }
                        />
                      </Group>
                      <Switch
                        size="xs"
                        label="Open markers"
                        disabled={activeResolved?.markerMode === "none"}
                        checked={activeResolved?.markerOpen ?? false}
                        onChange={(event) =>
                          setOverride(active.key, { marker_open: event.currentTarget.checked })
                        }
                      />

                      <Divider label="Presentation" labelPosition="left" />
                      <Switch
                        size="xs"
                        label="Drop shadow"
                        checked={activeResolved?.shadow ?? false}
                        onChange={(event) =>
                          setOverride(active.key, { shadow: event.currentTarget.checked })
                        }
                      />
                      <Switch
                        size="xs"
                        label="Show in legend"
                        checked={activeResolved?.showInLegend ?? true}
                        onChange={(event) =>
                          setOverride(active.key, { show_in_legend: event.currentTarget.checked })
                        }
                      />
                      <Switch
                        size="xs"
                        label="Hide this series"
                        checked={activeResolved?.hidden ?? false}
                        onChange={(event) =>
                          setOverride(active.key, { hidden: event.currentTarget.checked })
                        }
                      />
                    </Stack>
                  )}
                </ScrollArea>
              </Tabs.Panel>

              <Tabs.Panel value="rules" style={{ flex: 1, minHeight: 0 }}>
                <ScrollArea style={{ height: "100%" }} type="auto" offsetScrollbars>
                  <Stack gap="sm" pt="sm" pr="xs">
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                        Style many series at once. Later rules win over earlier ones, and anything
                        set on an individual series wins over all of them.
                      </Text>
                      <Button
                        size="compact-xs"
                        leftSection={<IconPlus size={13} />}
                        onClick={() => setRules([...rules, emptySeriesRule()])}
                      >
                        Add rule
                      </Button>
                    </Group>

                    {rules.length === 0 && (
                      <Alert color="gray" p="xs">
                        <Text size="xs">
                          No rules yet. A rule like “group name contains 25C → colour blue” styles
                          every matching series at once.
                        </Text>
                      </Alert>
                    )}

                    {rules.map((rule, index) => {
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
                                disabled={index === rules.length - 1}
                                onClick={() => moveRule(index, 1)}
                              >
                                <IconArrowDown size={14} />
                              </ActionIcon>
                              <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="red"
                                aria-label="Delete rule"
                                onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}
                              >
                                <IconTrash size={14} />
                              </ActionIcon>
                            </Group>

                            <Group gap="xs" wrap="nowrap" align="end">
                              <Select
                                size="xs"
                                w={130}
                                data={SERIES_RULE_FIELDS}
                                allowDeselect={false}
                                value={rule.field}
                                onChange={(value) =>
                                  patchRule(rule.id, { field: (value as typeof rule.field) ?? "label" })
                                }
                              />
                              <Select
                                size="xs"
                                w={130}
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
                                w={120}
                                label="Markers"
                                placeholder="unchanged"
                                clearable
                                data={MARKER_MODE_OPTIONS}
                                value={rule.style.marker_mode ?? null}
                                onChange={(value) =>
                                  patchRuleStyle(rule.id, {
                                    marker_mode: (value as PlotMarkerMode) ?? null,
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
              </Tabs.Panel>
            </Tabs>
          </Paper>
        </Group>
      </Stack>
    </Modal>
  );
}
