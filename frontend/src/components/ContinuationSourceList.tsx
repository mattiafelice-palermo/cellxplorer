import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconGripVertical } from "@tabler/icons-react";

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

export function ContinuationSourceList({
  sources,
  findings,
  onMove,
  onDragStart,
  onDrop,
  onOpenRawData,
  disabled = false,
  emptyMessage = "No continuation sources selected.",
}: {
  sources: ContinuationInspectSource[];
  findings: ContinuationFinding[];
  onMove: (index: number, direction: -1 | 1) => void;
  onDragStart?: (index: number) => void;
  onDrop?: (index: number) => void;
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
            draggable={Boolean(onDragStart)}
            onDragStart={() => onDragStart?.(index)}
            onDragOver={(event) => { if (onDrop) event.preventDefault(); }}
            onDrop={() => onDrop?.(index)}
          >
            <Stack gap={4}>
              <Group gap="xs" wrap="nowrap">
                <IconGripVertical size={16} color="var(--mantine-color-gray-5)" />
                <Text size="sm" fw={600} truncate style={{ flex: 1, minWidth: 0 }}>{source.filename}</Text>
                {role && <Badge size="xs" variant="light" color={role === "Tracked tail" ? "teal" : "gray"}>{role}</Badge>}
                <Badge size="xs" variant="light" color={sourceStatusColor(source)}>{source.inspection_status}</Badge>
                <Tooltip label={`Move ${source.filename} up`}>
                  <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} up`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}><IconArrowUp size={14} /></ActionIcon>
                </Tooltip>
                <Tooltip label={`Move ${source.filename} down`}>
                  <ActionIcon size="sm" variant="subtle" aria-label={`Move ${source.filename} down`} disabled={disabled || index === sources.length - 1} onClick={() => onMove(index, 1)}><IconArrowDown size={14} /></ActionIcon>
                </Tooltip>
              </Group>
              <Group gap="xs" pl={26} wrap="wrap">
                <Text size="xs" c="dimmed">Cycles: {source.local_cycle_start ?? "—"}–{source.local_cycle_end ?? "—"} ({source.local_cycle_count ?? "—"})</Text>
                <Text size="xs" c="dimmed">Time: {source.start_time ?? "—"} → {source.end_time ?? "—"}</Text>
                <Text size="xs" c="dimmed">Protocol: {source.protocol_signature ?? "—"}</Text>
                {source.hash && <Text size="xs" c="dimmed">Hash: {source.hash.slice(0, 12)}…</Text>}
                {onOpenRawData && <Button size="compact-xs" variant="subtle" onClick={() => onOpenRawData(source.key)}>Raw data</Button>}
              </Group>
              {source.inspection_error && <Text size="xs" c="red" pl={26}>{source.inspection_error}</Text>}
              {sourceFindings.map((finding) => <Text key={finding.id} size="xs" c={sourceFindingColor(finding)} pl={26}>{findingSummary(finding)}</Text>)}
            </Stack>
          </Paper>
        );
      })}
      {findings.filter((finding) => finding.source_keys.length === 0).map((finding) => <Text key={finding.id} size="xs" c={sourceFindingColor(finding)}>{findingSummary(finding)}</Text>)}
    </Stack>
  );
}
