import { ActionIcon, Alert, Box, Button, ColorInput, Divider, Group, Modal, NumberInput, Paper, Select, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlotReferenceLine, PlotStyle } from "../../../../api";
import Plot from "../../../../components/Plot";
import type { SeriesPreviewBuilder } from "./SeriesStyleModal";
import { MAX_REFERENCE_LINES, applyReferenceLabelMoves, axisBinding, createReferenceLine, normalizeReferenceLines, referenceAxesFromLayout, referenceAxisMatches, referenceLabelDraggingSupported, referenceLineIssue, type ReferenceAxis } from "./plotReferenceLines";

type Props = { opened: boolean; onClose: () => void; style: PlotStyle; buildPreview: SeriesPreviewBuilder; onApply: (lines: PlotReferenceLine[]) => void };
const previewConfig = { displaylogo: false, responsive: true };
const plotStyle = { width: "100%", height: 440 };
const axisName = (axis: ReferenceAxis) => `${axis.axis === "x" ? "X" : axis.axis === "y" ? "Left Y" : axis.axis === "y3" ? "Right Y" : "Y2"}: ${axis.label}`;
const uid = () => globalThis.crypto?.randomUUID?.() ?? `reference-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The real family builder previews only a modal-owned draft. Apply writes one scoped style edit. */
export function ReferenceLinesEditor({ opened, onClose, style, buildPreview, onApply }: Props) {
  const [draft, setDraft] = useState<PlotReferenceLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const lastPreview = useRef<ReturnType<SeriesPreviewBuilder>>({ data: [], layout: {} });
  useEffect(() => {
    if (!opened) return;
    const lines = normalizeReferenceLines(style.reference_lines);
    setDraft(lines);
    setSelected(lines[0]?.id ?? null);
    // Snapshot once per opening. Parent result/style refreshes must not replace an edit in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  const figure = useMemo(() => {
    if (!opened) return lastPreview.current;
    const next = buildPreview({ overrides: style.series_overrides ?? {}, rules: style.series_rules ?? [], styleOverlay: { reference_lines: draft } });
    lastPreview.current = next;
    return next;
  }, [opened, buildPreview, draft, style.series_overrides, style.series_rules]);
  const previewLayout = useMemo(() => ({ ...figure.layout, height: 440, autosize: true }) as Partial<Plotly.Layout>, [figure.layout]);
  const dragSupported = referenceLabelDraggingSupported(previewLayout);
  const axes = referenceAxesFromLayout(figure.layout as Partial<Plotly.Layout>);
  const numericAxes = axes.filter((axis) => axis.numeric);
  const line = draft.find((candidate) => candidate.id === selected);
  const patch = (fn: (next: PlotReferenceLine) => void) => setDraft((current) => current.map((entry) => {
    if (entry.id !== selected) return entry;
    const next = { ...entry, binding: { ...entry.binding }, span: { ...entry.span, binding: { ...entry.span.binding } }, label: { ...entry.label } };
    fn(next);
    return next;
  }));
  const label = (fn: (next: PlotReferenceLine["label"]) => void) => patch((next) => fn(next.label));
  const add = () => {
    const axis = numericAxes.find((candidate) => candidate.axis === "y") ?? numericAxes[0];
    const cross = axis && axes.find((candidate) => candidate.axis === axis.cross_axis);
    if (!axis || !cross || draft.length >= MAX_REFERENCE_LINES) return;
    const added = createReferenceLine(axis, cross, uid());
    setDraft((current) => [...current, added]); setSelected(added.id);
  };
  const duplicate = (entry: PlotReferenceLine) => {
    if (draft.length >= MAX_REFERENCE_LINES) return;
    const copied = normalizeReferenceLines([{ ...entry, id: uid() }])[0];
    const index = draft.findIndex((candidate) => candidate.id === entry.id);
    setDraft([...draft.slice(0, index + 1), copied, ...draft.slice(index + 1)]); setSelected(copied.id);
  };
  const move = (index: number, delta: number) => {
    const next = [...draft]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; setDraft(next);
  };
  const issue = line ? referenceLineIssue(line, axes) : null;
  const invalidSpan = draft.some((entry) => entry.span.mode === "bounded" && entry.span.min >= entry.span.max);
  const sameDirection = line?.binding.axis === "x";
  const perpendicular = numericAxes.filter((axis) => (axis.axis === "x") !== sameDirection);
  const bindingMatches = line ? referenceAxisMatches(line.binding, axes) : undefined;
  const number = (value: number | string, fn: (value: number) => void) => { if (typeof value === "number" && Number.isFinite(value)) fn(value); };
  const action = (title: string, disabled: boolean, click: () => void, icon: React.ReactNode) => <Tooltip label={title}><ActionIcon size="sm" variant="subtle" aria-label={title} disabled={disabled} onClick={click}>{icon}</ActionIcon></Tooltip>;
  return <Modal opened={opened} onClose={onClose} title="Reference lines" size="min(1100px, 94vw)" centered>
    <Stack gap="sm">
      <Group align="flex-start" gap="md" wrap="wrap">
        <Box style={{ flex: "1 1 460px", minWidth: 0 }}>
          <Paper withBorder p="xs">
            <Text size="xs" c="dimmed" mb="xs">{dragSupported ? "Live preview · drag labels to position them freely" : previewLayout.annotations?.length ? "Use free coordinates to position labels; this plot contains other annotations" : "Live preview · use along-line or free coordinates to position labels"}</Text>
            {figure.data.length ? <Plot data={figure.data as Plotly.Data[]} layout={previewLayout} config={previewConfig} style={plotStyle}
              onReferenceLabelMove={(moves) => setDraft((current) => { const next = { ...style, reference_lines: current }; applyReferenceLabelMoves(next, moves); return next.reference_lines!; })} />
              : <Text size="sm" c="dimmed" p="md">A computed plot is needed to preview and bind reference lines.</Text>}
          </Paper>
        </Box>
        <Stack gap="xs" style={{ flex: "1 1 350px", minWidth: 0, maxHeight: "calc(66vh / var(--cellxplorer-ui-zoom, 1))", overflowY: "auto" }}>
          <Group justify="space-between"><Text fw={700} size="sm">Lines ({draft.length}/{MAX_REFERENCE_LINES})</Text><Button size="compact-xs" variant="light" leftSection={<IconPlus size={13} />} onClick={add} disabled={!numericAxes.length || draft.length >= MAX_REFERENCE_LINES}>Add line</Button></Group>
          <Box style={{ maxHeight: 146, overflowY: "auto", flexShrink: 0 }}>
            {draft.map((entry, index) => <Group key={entry.id} gap={4} wrap="nowrap" py={2}>
              <Button size="compact-xs" variant={selected === entry.id ? "light" : "subtle"} style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }} onClick={() => setSelected(entry.id)} title={entry.label.text || `Line ${index + 1}`}><Text size="xs" truncate>{entry.enabled ? "" : "Hidden · "}{entry.label.text || `Line ${index + 1}`} · {entry.position} {entry.binding.units}</Text></Button>
              {action("Move reference line up", index === 0, () => move(index, -1), <IconArrowUp size={13} />)}
              {action("Move reference line down", index === draft.length - 1, () => move(index, 1), <IconArrowDown size={13} />)}
              {action("Duplicate reference line", draft.length >= MAX_REFERENCE_LINES, () => duplicate(entry), <IconCopy size={13} />)}
              {action("Remove reference line", false, () => { const next = draft.filter((candidate) => candidate.id !== entry.id); setDraft(next); if (selected === entry.id) setSelected(next[Math.min(index, next.length - 1)]?.id ?? null); }, <IconTrash size={13} />)}
            </Group>)}
          </Box>
          {!line && <Text size="sm" c="dimmed">Add a line to mark a threshold or event.</Text>}
          {line && <>
            <Divider />
            <Switch label="Show line" checked={line.enabled} onChange={(event) => patch((next) => { next.enabled = event.target.checked; })} />
            {issue && <Alert color="yellow" title="Reference unavailable"><Text size="xs">{issue}</Text><Text size="xs">Saved binding: {line.binding.quantity} ({line.binding.units || "unitless"})</Text></Alert>}
            <Select size="xs" label="Orientation" value={line.binding.axis === "x" ? "vertical" : "horizontal"} data={[{ value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical", disabled: !numericAxes.some((axis) => axis.axis === "x") }]}
              onChange={(value) => { const axis = numericAxes.find((candidate) => (candidate.axis === "x") === (value === "vertical")); if (!axis) return; patch((next) => { next.binding = axisBinding(axis); const cross = axes.find((candidate) => candidate.axis === axis.cross_axis); if (cross) next.span.binding = axisBinding(cross); }); }} />
            <Select size="xs" label="Axis quantity and units" value={bindingMatches ? line.binding.axis : "saved"}
              data={[...(!bindingMatches ? [{ value: "saved", label: "Saved axis is unavailable", disabled: true }] : []), ...axes.filter((axis) => (axis.axis === "x") === sameDirection).map((axis) => ({ value: axis.axis, label: axisName(axis), disabled: !axis.numeric }))]}
              onChange={(value) => { const axis = axes.find((candidate) => candidate.axis === value); if (axis) patch((next) => { next.binding = axisBinding(axis); }); }} />
            <NumberInput size="xs" label={`Exact position${line.binding.units ? ` (${line.binding.units})` : ""}`} value={line.position} onChange={(value) => number(value, (position) => patch((next) => { next.position = position; }))} />
            <Select size="xs" label="Span" value={line.span.mode} data={[{ value: "domain", label: "Full axis domain" }, { value: "bounded", label: "Bounded numeric span", disabled: !perpendicular.length }]}
              onChange={(value) => patch((next) => { next.span.mode = value as "domain" | "bounded"; if (value === "bounded" && !referenceAxisMatches(next.span.binding, axes) && perpendicular[0]) next.span.binding = axisBinding(perpendicular[0]); })} />
            {line.span.mode === "bounded" && <>
              <Select size="xs" label="Span axis quantity and units" value={referenceAxisMatches(line.span.binding, axes) ? line.span.binding.axis : "saved"} data={[...(!referenceAxisMatches(line.span.binding, axes) ? [{ value: "saved", label: "Saved span is unavailable", disabled: true }] : []), ...perpendicular.map((axis) => ({ value: axis.axis, label: axisName(axis) }))]}
                onChange={(value) => { const axis = perpendicular.find((candidate) => candidate.axis === value); if (axis) patch((next) => { next.span.binding = axisBinding(axis); }); }} />
              <Group grow><NumberInput size="xs" label="Span minimum" value={line.span.min} onChange={(value) => number(value, (min) => patch((next) => { next.span.min = min; }))} /><NumberInput size="xs" label="Span maximum" value={line.span.max} error={line.span.min >= line.span.max ? "Must exceed minimum" : undefined} onChange={(value) => number(value, (max) => patch((next) => { next.span.max = max; }))} /></Group>
            </>}
            <Divider label="Line appearance" />
            <ColorInput size="xs" label="Line color" value={line.color} onChange={(value) => patch((next) => { next.color = value; })} />
            <Group grow><NumberInput size="xs" label="Opacity (0–1)" min={0} max={1} step={0.1} value={line.opacity} onChange={(value) => number(value, (opacity) => patch((next) => { next.opacity = opacity; }))} /><NumberInput size="xs" label="Width (px)" min={0.1} max={20} step={0.5} value={line.width} onChange={(value) => number(value, (width) => patch((next) => { next.width = width; }))} /></Group>
            <Group grow><Select size="xs" label="Line style" value={line.dash} data={[{ value: "solid", label: "Solid" }, { value: "dot", label: "Dotted" }, { value: "dash", label: "Dashed" }, { value: "longdash", label: "Long dashed" }]} onChange={(value) => patch((next) => { next.dash = value as PlotReferenceLine["dash"]; })} /><Select size="xs" label="Layer" value={line.layer} data={[{ value: "below", label: "Behind data" }, { value: "above", label: "In front of data" }]} onChange={(value) => patch((next) => { next.layer = value as PlotReferenceLine["layer"]; })} /></Group>
            <Divider label="Label" />
            <Switch label="Show label" checked={line.label.visible} onChange={(event) => label((next) => { next.visible = event.target.checked; })} />
            <TextInput size="xs" label="Label text" maxLength={500} value={line.label.text} onChange={(event) => label((next) => { next.text = event.target.value; })} />
            <Group><Switch size="xs" label="Include value" checked={line.label.include_value} onChange={(event) => label((next) => { next.include_value = event.target.checked; })} /><Switch size="xs" label="Include units" checked={line.label.include_units} onChange={(event) => label((next) => { next.include_units = event.target.checked; })} /></Group>
            <Select size="xs" label="Label placement" value={line.label.placement} data={[{ value: "line", label: "Along line" }, { value: "free", label: "Free plot-domain coordinates" }]} onChange={(value) => label((next) => { next.placement = value as "line" | "free"; })} />
            {line.label.placement === "line" ? <NumberInput size="xs" label="Along line (0–1)" min={0} max={1} step={0.1} value={line.label.along} onChange={(value) => number(value, (along) => label((next) => { next.along = along; }))} /> : <Group grow><NumberInput size="xs" label="Label X (0–1)" min={0} max={1} step={0.05} value={line.label.x} onChange={(value) => number(value, (x) => label((next) => { next.x = x; }))} /><NumberInput size="xs" label="Label Y (0–1)" min={0} max={1} step={0.05} value={line.label.y} onChange={(value) => number(value, (y) => label((next) => { next.y = y; }))} /></Group>}
            <Group grow><Select size="xs" label="Side / anchor" value={line.label.side} data={["above", "below", "left", "right"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} onChange={(value) => label((next) => { next.side = value as PlotReferenceLine["label"]["side"]; })} /><Select size="xs" label="Text alignment" value={line.label.align} data={["left", "center", "right"]} onChange={(value) => label((next) => { next.align = value as PlotReferenceLine["label"]["align"]; })} /></Group>
            <Group grow><NumberInput size="xs" label="Rotation (°)" min={-180} max={180} value={line.label.angle} onChange={(value) => number(value, (angle) => label((next) => { next.angle = angle; }))} /><NumberInput size="xs" label="Font size (px)" min={6} max={72} value={line.label.font_size} onChange={(value) => number(value, (font_size) => label((next) => { next.font_size = font_size; }))} /></Group>
            <Group grow><NumberInput size="xs" label="X offset (px)" min={-1000} max={1000} value={line.label.xshift} onChange={(value) => number(value, (xshift) => label((next) => { next.xshift = xshift; }))} /><NumberInput size="xs" label="Y offset (px)" min={-1000} max={1000} value={line.label.yshift} onChange={(value) => number(value, (yshift) => label((next) => { next.yshift = yshift; }))} /></Group>
            <ColorInput size="xs" label="Text color" value={line.label.color} onChange={(value) => label((next) => { next.color = value; })} />
            <ColorInput size="xs" label="Label background" format="rgba" value={line.label.background} onChange={(value) => label((next) => { next.background = value; })} />
            <ColorInput size="xs" label="Border color" value={line.label.border_color} onChange={(value) => label((next) => { next.border_color = value; })} />
            <Group grow><NumberInput size="xs" label="Border width (px)" min={0} max={10} value={line.label.border_width} onChange={(value) => number(value, (border_width) => label((next) => { next.border_width = border_width; }))} /><NumberInput size="xs" label="Border padding (px)" min={0} max={30} value={line.label.border_pad} onChange={(value) => number(value, (border_pad) => label((next) => { next.border_pad = border_pad; }))} /></Group>
          </>}
        </Stack>
      </Group>
      <Group justify="space-between"><Button variant="subtle" size="sm" onClick={() => { setDraft([]); setSelected(null); }}>Reset reference lines</Button><Group><Button variant="default" size="sm" onClick={onClose}>Cancel</Button><Button size="sm" disabled={invalidSpan} onClick={() => { onApply(normalizeReferenceLines(draft)); onClose(); }}>Apply</Button></Group></Group>
    </Stack>
  </Modal>;
}
