import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconGripVertical,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";

import type { ContinuationFinding, ContinuationInspectSource } from "../api";
import {
  findingSummary,
  sourceRoleLabel,
} from "../continuationPolicy";

function sourceStatusColor(source: ContinuationInspectSource) {
  if (source.inspection_status === "error") return "red";
  if (source.inspection_status === "pending") return "yellow";
  return "teal";
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

export function ContinuationSourceList({
  sources,
  findings,
  onMove,
  onDragStart,
  onDrop,
  onRemove,
  onOpenRawData,
  disabled = false,
  emptyMessage = "No continuation sources selected.",
}: {
  sources: ContinuationInspectSource[];
  findings: ContinuationFinding[];
  onMove: (index: number, direction: -1 | 1) => void;
  onDragStart?: (index: number) => void;
  onDrop?: (index: number) => void;
  onRemove?: (sourceKey: string) => void;
  onOpenRawData?: (sourceKey: string) => void;
  disabled?: boolean;
  emptyMessage?: string;
}) {
  if (!sources.length) return <Text size="sm" c="dimmed">{emptyMessage}</Text>;
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
                <Tooltip label={`Move ${source.filename} up`}>
                  <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} up`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}><IconArrowUp size={14} /></ActionIcon>
                </Tooltip>
                <Tooltip label={`Move ${source.filename} down`}>
                  <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} down`} disabled={disabled || index === sources.length - 1} onClick={() => onMove(index, 1)}><IconArrowDown size={14} /></ActionIcon>
                </Tooltip>
                {onRemove && <Tooltip label={`Remove ${source.filename}`}>
                  <ActionIcon size="sm" variant="subtle" color="red" aria-label={`Remove ${source.filename}`} disabled={disabled || sources.length <= 1} onClick={() => onRemove(source.key)}><IconX size={14} /></ActionIcon>
                </Tooltip>}
              </Group>
              <Group gap="xs" pl={26} wrap="wrap">
                <Text size="xs" c="dimmed">Cycles: {source.local_cycle_start ?? "—"}–{source.local_cycle_end ?? "—"} ({source.local_cycle_count ?? "—"})</Text>
                <Text size="xs" c="dimmed">Time: {source.start_time ?? "—"} → {source.end_time ?? "—"}</Text>
                <Text size="xs" c="dimmed">Protocol: {source.protocol_signature ?? "—"}</Text>
                {source.hash && <Text size="xs" c="dimmed">Hash: {source.hash.slice(0, 12)}…</Text>}
                {onOpenRawData && <Button size="compact-xs" variant="subtle" onClick={() => onOpenRawData(source.key)}>Raw data</Button>}
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
