import { Alert, Box, Button, Group, NumberInput, ScrollArea, Select, Stack, Switch, Text } from "@mantine/core";
import { useState } from "react";
import type { CycleShadingConfig, PlotCycleShading } from "../../../../api";
import {
  applyCycleShading, cycleShadingRangeReady, cycleShadingSummary, defaultCycleShadingConfig, MAX_CYCLE_SHADING_BANDS,
  MAX_CYCLE_SHADING_BOUND, resetCycleShading, resolvedCycleShading,
} from "./cycleShading";

export function CycleShadingEditor({ scratch, selectedSampleKeys, availableMaximum, onPreview, onApply }: {
  scratch: PlotCycleShading | undefined;
  selectedSampleKeys: string[];
  availableMaximum: number | null;
  onPreview: (value: PlotCycleShading | undefined) => void;
  onApply: () => void;
}) {
  const [applyTo, setApplyTo] = useState<"selected" | "all">(selectedSampleKeys.length ? "selected" : "all");
  const targets = applyTo === "all" ? null : selectedSampleKeys;
  const canApply = targets === null || targets.length > 0;
  const config = (targets === null ? scratch?.defaults : resolvedCycleShading(scratch, targets[0])) ?? defaultCycleShadingConfig(availableMaximum);
  const patch = (value: Partial<CycleShadingConfig>) => onPreview(applyCycleShading(scratch, { ...config, ...value }, targets));
  const fullRangeAvailable = availableMaximum != null && Number.isFinite(availableMaximum) && availableMaximum >= 1;
  const updateFullRange = () => patch({ cycle_start: 1, cycle_end: defaultCycleShadingConfig(availableMaximum).cycle_end, range_source: "full", range_confirmed: true });
  const mixed = targets && targets.length > 1 && targets.some((key) => JSON.stringify(resolvedCycleShading(scratch, key)) !== JSON.stringify(resolvedCycleShading(scratch, targets[0])));
  const percentInput = (label: string, field: "first_lightness" | "last_lightness" | "first_saturation" | "last_saturation") => (
    <NumberInput label={label} size="xs" min={0} max={100} suffix=" %" decimalScale={1}
      value={config[field]} onChange={(value) => typeof value === "number" && patch({ [field]: value })} />
  );
  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
        <Stack gap="sm" p="xs">
          <Text size="xs" c="dimmed">Keep each sample's color hue and vary its shade across scientific cycles. Only Voltage/Capacity curves change; charge and discharge share the same cycle shade.</Text>
          <Select size="xs" label="Apply to" value={applyTo} onChange={(value) => value && setApplyTo(value as "selected" | "all")}
            data={[{ value: "all", label: "All samples" }, { value: "selected", label: `Selected samples (${selectedSampleKeys.length})`, disabled: !selectedSampleKeys.length }]} />
          {mixed && <Alert color="gray" p="xs"><Text size="xs">Selected samples have different shading settings. Edits apply the displayed settings to those samples together.</Text></Alert>}
          <Switch size="xs" label="Enable cycle shading" checked={config.enabled} disabled={!canApply || (!cycleShadingRangeReady(config) && !fullRangeAvailable)}
            onChange={(event) => patch({ ...(!cycleShadingRangeReady(config) && fullRangeAvailable ? {
              cycle_start: 1, cycle_end: defaultCycleShadingConfig(availableMaximum).cycle_end, range_source: "full", range_confirmed: true,
            } : {}), enabled: event.currentTarget.checked })} />
          <Select size="xs" label="Vary across cycles" value={config.mode} disabled={!canApply}
            data={[{ value: "lightness", label: "Lightness" }, { value: "saturation", label: "Saturation" }, { value: "both", label: "Lightness and saturation" }]}
            onChange={(value) => value && patch({ mode: value as CycleShadingConfig["mode"] })} />
          {config.mode !== "saturation" && <Group gap="xs" grow>{percentInput("First lightness", "first_lightness")}{percentInput("Last lightness", "last_lightness")}</Group>}
          {config.mode !== "lightness" && <Group gap="xs" grow>{percentInput("First saturation", "first_saturation")}{percentInput("Last saturation", "last_saturation")}</Group>}
          <Switch size="xs" label="Reverse gradient" checked={config.reverse} onChange={(event) => patch({ reverse: event.currentTarget.checked })} />
          <Select size="xs" label="Progression" value={config.progression} data={[{ value: "smooth", label: "Smooth" }, { value: "stepped", label: "Stepped bands" }]}
            onChange={(value) => value && patch({ progression: value as CycleShadingConfig["progression"] })} />
          {config.progression === "stepped" && <NumberInput size="xs" label="Band count" min={2} max={MAX_CYCLE_SHADING_BANDS} allowDecimal={false}
            value={config.bands} onChange={(value) => typeof value === "number" && patch({ bands: value })} />}
          <Text size="xs" fw={700}>Fixed cycle mapping</Text>
          <Text size="xs" c="dimmed">Bounds stay fixed when you navigate or new cycles arrive. Cycles outside the bounds use the nearest endpoint shade.</Text>
          {!fullRangeAvailable && <Alert color="gray" p="xs"><Text size="xs">The full scientific cycle range is unavailable. Enter explicit fixed bounds below; the displayed window is never used as a fallback.</Text></Alert>}
          <Group gap="xs" grow>
            <NumberInput size="xs" label="First cycle" min={1} max={config.cycle_end} allowDecimal={false} value={config.cycle_start}
              onChange={(value) => typeof value === "number" && patch({ cycle_start: Math.min(value, config.cycle_end), range_source: "manual", range_confirmed: true })} />
            <NumberInput size="xs" label="Last cycle" min={config.cycle_start} max={MAX_CYCLE_SHADING_BOUND} allowDecimal={false} value={config.cycle_end}
              onChange={(value) => typeof value === "number" && patch({ cycle_end: Math.max(value, config.cycle_start), range_source: "manual", range_confirmed: true })} />
          </Group>
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">{config.range_source === "full" ? "Frozen from full available range" : "Explicit fixed bounds"}</Text>
            <Button size="compact-xs" variant="default" disabled={!fullRangeAvailable || !canApply} onClick={updateFullRange}>Update full range</Button>
          </Group>
          <Text size="xs">{cycleShadingSummary(config)}</Text>
          <Text size="xs" c="dimmed">The preview uses these settings. Apply saves them to the plot. Gray samples stay neutral; unknown cycles keep their base color.</Text>
        </Stack>
      </ScrollArea>
      <Group justify="space-between" px="xs" py={8} style={{ flex: "none", borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Button size="xs" variant="subtle" disabled={!canApply} onClick={() => onPreview(resetCycleShading(scratch, targets))}>Reset shading</Button>
        <Button size="xs" disabled={!canApply} onClick={onApply}>Apply shading</Button>
      </Group>
    </Box>
  );
}
