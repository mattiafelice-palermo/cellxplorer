import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, Tooltip, VisuallyHidden } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconGripVertical,
  IconInfoCircle,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";

import type { ContinuationFinding, ContinuationInspectSource } from "../api";
import {
  continuationSourceCanOpenRawData,
  findingSummary,
  sourceRoleLabel,
} from "../continuationPolicy";

export type ContinuationSourceListVariant = "default" | "compact-import";

function sourceStatusColor(source: ContinuationInspectSource) {
  if (source.inspection_status === "error") return "red";
  if (source.inspection_status === "pending") return "yellow";
  return "teal";
}

function compactSourceStatusLabel(source: ContinuationInspectSource) {
  if (source.inspection_status === "error") return "Error";
  if (source.cache_build_status === "started" || source.cache_build_status === "building") return "Preparing";
  if (source.inspection_status === "pending") return "Not inspected";
  return "Ready";
}

function sourceFindingColor(finding: ContinuationFinding) {
  if (finding.severity === "blocking") return "red";
  if (finding.severity === "confirmation") return "orange";
  if (finding.severity === "warning") return "yellow";
  return "gray";
}

function sourceFindingIcon(finding: ContinuationFinding) {
  if (finding.severity === "blocking") return <IconAlertTriangle size={14} aria-hidden="true" />;
  return <IconInfoCircle size={14} aria-hidden="true" />;
}

/** A source's stable session color on its visible position number. The number is always present, so color is never the only identifier. */
function SourceColorCircle({ number, color }: { number: number; color?: string }) {
  return (
    <Text
      aria-hidden="true"
      size="xs"
      fw={700}
      style={{
        flex: "none",
        width: 20,
        height: 20,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        background: color ?? "var(--mantine-color-gray-5)",
      }}
    >
      {number}
    </Text>
  );
}

function compactMetaLine(source: ContinuationInspectSource): string | null {
  const parts: string[] = [];
  if (source.local_cycle_count !== null && source.local_cycle_count !== undefined) {
    parts.push(`Cycles ${source.local_cycle_start ?? "—"}–${source.local_cycle_end ?? "—"} (${source.local_cycle_count})`);
  }
  if (source.start_time) parts.push(source.start_time);
  return parts.length ? parts.join(" · ") : null;
}

export function ContinuationSourceList({
  sources,
  findings,
  onMove,
  onDragStart,
  onDrop,
  onRemove,
  canRemoveSource,
  onUpdateSource,
  onOpenRawData,
  updateDisabled = false,
  disabled = false,
  emptyMessage = "No continuation sources selected.",
  variant = "default",
  colorsBySourceKey,
  selectedSourceKey,
  onSelect,
}: {
  sources: ContinuationInspectSource[];
  findings: ContinuationFinding[];
  onMove: (index: number, direction: -1 | 1) => void;
  onDragStart?: (index: number) => void;
  onDrop?: (index: number) => void;
  onRemove?: (sourceKey: string) => void;
  canRemoveSource?: (sourceKey: string) => boolean;
  onUpdateSource?: (sourceKey: string) => void;
  updateDisabled?: boolean;
  onOpenRawData?: (sourceKey: string) => void;
  disabled?: boolean;
  emptyMessage?: string;
  /** "compact-import" is used only by the continued-cell import workspace. Default callers (existing-cell continuation management) are unaffected. */
  variant?: ContinuationSourceListVariant;
  /** Stable session source colors, keyed by source key. Compact-import only. */
  colorsBySourceKey?: Record<string, string>;
  /** Currently selected source for preview/details. Compact-import only. */
  selectedSourceKey?: string | null;
  onSelect?: (sourceKey: string) => void;
}) {
  if (!sources.length) return <Text size="sm" c="dimmed">{emptyMessage}</Text>;

  if (variant === "compact-import") {
    return (
      <Stack gap={6}>
        {sources.map((source, index) => {
          const role = sourceRoleLabel(source, index, sources.length);
          const selected = selectedSourceKey === source.key;
          const metaLine = compactMetaLine(source);
          const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
          return (
            <Paper
              key={source.key}
              withBorder
              p="xs"
              draggable={Boolean(onDragStart) && !disabled}
              onDragStart={() => onDragStart?.(index)}
              onDragOver={(event) => { if (onDrop && !disabled) event.preventDefault(); }}
              onDrop={() => { if (!disabled) onDrop?.(index); }}
              onClick={() => onSelect?.(source.key)}
              tabIndex={onSelect ? 0 : undefined}
              role={onSelect ? "button" : undefined}
              aria-pressed={onSelect ? selected : undefined}
              onKeyDown={(event) => {
                if (!onSelect) return;
                // Only the row's own key events select it -- a bubbled Enter/Space
                // from a nested Move/Remove ActionIcon must reach that control's
                // native activation, not be intercepted here.
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(source.key);
                }
              }}
              style={{
                cursor: onSelect ? "pointer" : undefined,
                borderColor: selected ? "var(--mantine-primary-color-5)" : undefined,
                background: selected ? "var(--mantine-primary-color-light)" : undefined,
              }}
            >
              <Stack gap={4}>
                <Group gap={6} wrap="nowrap">
                  <IconGripVertical size={14} color="var(--mantine-color-gray-5)" aria-hidden="true" />
                  <SourceColorCircle number={index + 1} color={colorsBySourceKey?.[source.key]} />
                  <VisuallyHidden>Source {index + 1}.</VisuallyHidden>
                  <Text size="sm" fw={selected ? 700 : 600} truncate title={source.filename} style={{ flex: 1, minWidth: 0 }}>
                    {source.filename}
                  </Text>
                  <Badge
                    size="xs"
                    variant="light"
                    color={sourceStatusColor(source)}
                    title={source.inspection_error ?? undefined}
                  >
                    {compactSourceStatusLabel(source)}
                  </Badge>
                  <Tooltip label={`Move ${source.filename} up`}>
                    <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} up`} disabled={disabled || index === 0} onClick={(event) => { stop(event); onMove(index, -1); }}><IconArrowUp size={13} /></ActionIcon>
                  </Tooltip>
                  <Tooltip label={`Move ${source.filename} down`}>
                    <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} down`} disabled={disabled || index === sources.length - 1} onClick={(event) => { stop(event); onMove(index, 1); }}><IconArrowDown size={13} /></ActionIcon>
                  </Tooltip>
                  {onRemove && <Tooltip label={`Remove ${source.filename}`}>
                    <ActionIcon size="sm" variant="subtle" color="red" aria-label={`Remove ${source.filename}`} disabled={disabled || sources.length <= 1 || canRemoveSource?.(source.key) === false} onClick={(event) => { stop(event); onRemove(source.key); }}><IconX size={13} /></ActionIcon>
                  </Tooltip>}
                </Group>
                <Group gap={6} pl={22} wrap="wrap">
                  {role && <Badge size="xs" variant="light" color={role === "Tracked tail" ? "teal" : "gray"}>{role}</Badge>}
                  {metaLine && <Text size="xs" c="dimmed" truncate>{metaLine}</Text>}
                </Group>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      {sources.map((source, index) => {
        const role = sourceRoleLabel(source, index, sources.length);
        const sourceFindings = findings.filter((finding) => finding.source_keys.includes(source.key));
        return (
          <Paper
            key={source.key}
            withBorder
            p="xs"
            draggable={Boolean(onDragStart) && !disabled}
            onDragStart={() => onDragStart?.(index)}
            onDragOver={(event) => { if (onDrop && !disabled) event.preventDefault(); }}
            onDrop={() => { if (!disabled) onDrop?.(index); }}
          >
            <Stack gap={4}>
              <Group gap="xs" wrap="nowrap">
                <IconGripVertical size={16} color="var(--mantine-color-gray-5)" />
                <Text size="sm" fw={600} truncate title={source.filename} style={{ flex: 1, minWidth: 0 }}>{source.filename}</Text>
                {role && <Badge size="xs" variant="light" color={role === "Tracked tail" ? "teal" : "gray"}>{role}</Badge>}
                <Badge size="xs" variant="light" color={sourceStatusColor(source)}>{source.inspection_status}</Badge>
                {source.location_status && <Badge size="xs" variant="light" color={source.location_status === "changed" || source.location_status === "changing" ? "orange" : source.location_status === "offline" ? "red" : "gray"}>{source.location_status}</Badge>}
                {source.parse_status && <Badge size="xs" variant="light" color={source.parse_status === "error" ? "red" : source.parse_status === "parsed" ? "teal" : "gray"}>{source.parse_status}</Badge>}
                <Tooltip label={`Move ${source.filename} up`}>
                  <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} up`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}><IconArrowUp size={14} /></ActionIcon>
                </Tooltip>
                <Tooltip label={`Move ${source.filename} down`}>
                  <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} down`} disabled={disabled || index === sources.length - 1} onClick={() => onMove(index, 1)}><IconArrowDown size={14} /></ActionIcon>
                </Tooltip>
                {onRemove && <Tooltip label={`Remove ${source.filename}`}>
                  <ActionIcon size="sm" variant="subtle" color="red" aria-label={`Remove ${source.filename}`} disabled={disabled || sources.length <= 1 || canRemoveSource?.(source.key) === false} onClick={() => onRemove(source.key)}><IconX size={14} /></ActionIcon>
                </Tooltip>}
              </Group>
              <Group gap="xs" pl={26} wrap="wrap">
                {source.source_path && <Text size="xs" c="dimmed" truncate title={source.source_path}>Path: {source.source_path}</Text>}
                <Text size="xs" c="dimmed">Cycles: {source.local_cycle_start ?? "—"}–{source.local_cycle_end ?? "—"} ({source.local_cycle_count ?? "—"})</Text>
                <Text size="xs" c="dimmed">Time: {source.start_time ?? "—"} → {source.end_time ?? "—"}</Text>
                <Text size="xs" c="dimmed">Protocol: {source.protocol_signature ?? "—"}</Text>
                {source.hash && <Text size="xs" c="dimmed">Hash: {source.hash.slice(0, 12)}…</Text>}
                {onOpenRawData && continuationSourceCanOpenRawData(source) && <Button size="compact-xs" variant="subtle" onClick={() => onOpenRawData(source.key)}>Raw data</Button>}
                {onUpdateSource && source.location_status === "changed" && <Button size="compact-xs" variant="default" leftSection={<IconRefresh size={13} />} disabled={updateDisabled} onClick={() => onUpdateSource(source.key)}>Update</Button>}
              </Group>
              {source.inspection_error && <Text size="xs" c="red" pl={26}>{source.inspection_error}</Text>}
              {sourceFindings.map((finding) => <Group key={finding.id} gap={4} wrap="nowrap" pl={26} c={sourceFindingColor(finding)}><span>{sourceFindingIcon(finding)}</span><Text size="xs" c="inherit">{findingSummary(finding)}</Text></Group>)}
            </Stack>
          </Paper>
        );
      })}
      {findings.filter((finding) => finding.source_keys.length === 0).map((finding) => <Group key={finding.id} gap={4} wrap="nowrap" c={sourceFindingColor(finding)}><span>{sourceFindingIcon(finding)}</span><Text size="xs" c="inherit">{findingSummary(finding)}</Text></Group>)}
    </Stack>
  );
}
