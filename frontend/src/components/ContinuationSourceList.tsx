import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, Tooltip, VisuallyHidden } from "@mantine/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { compactContinuationMetaLine as formatCompactContinuationMetaLine } from "../continuedImportWorkspacePolicy";

export type ContinuationSourceListVariant = "default" | "compact-import";

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

function pastelSourceColor(color?: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
  if (!match) return "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))";
  const red = Number.parseInt(match[1]!.slice(0, 2), 16);
  const green = Number.parseInt(match[1]!.slice(2, 4), 16);
  const blue = Number.parseInt(match[1]!.slice(4, 6), 16);
  const tint = (channel: number) => Math.round(channel + (255 - channel) * 0.78);
  return `rgb(${tint(red)} ${tint(green)} ${tint(blue)})`;
}

function sourceGutterTextColor(color?: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
  if (!match) return "var(--mantine-color-white)";
  const red = Number.parseInt(match[1]!.slice(0, 2), 16);
  const green = Number.parseInt(match[1]!.slice(2, 4), 16);
  const blue = Number.parseInt(match[1]!.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.67 ? "var(--mantine-color-dark-9)" : "var(--mantine-color-white)";
}

/** A minimal full-height identity rail: a short position cap above a larger drag zone. */
function SourceIdentityGutter({
  number,
  color,
  handleRef,
  handleAttributes,
  handleListeners,
  handleLabel,
  isDragging,
}: {
  number: number;
  color?: string;
  handleRef?: (element: HTMLElement | null) => void;
  handleAttributes?: DraggableAttributes;
  handleListeners?: DraggableSyntheticListeners;
  handleLabel?: string;
  isDragging?: boolean;
}) {
  const strongColor = color ?? "var(--mantine-color-gray-5)";
  return (
    <div
      style={{
        flex: "none",
        width: 20,
        alignSelf: "stretch",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: "0 0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: pastelSourceColor(color),
          color: "var(--mantine-color-dark-9)",
          fontSize: "var(--mantine-font-size-xs)",
          fontWeight: 700,
        }}
        aria-hidden="true"
      >
        {number}
      </div>
      <div
        ref={handleRef}
        {...handleAttributes}
        {...handleListeners}
        aria-label={handleLabel}
        style={{
          flex: 1,
          minHeight: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: strongColor,
          color: sourceGutterTextColor(color),
          cursor: isDragging ? "grabbing" : "grab",
          opacity: isDragging ? 0.8 : 1,
          touchAction: "none",
        }}
      >
        <IconGripVertical size={14} aria-hidden="true" />
      </div>
    </div>
  );
}

function compactMetaLine(source: ContinuationInspectSource): string | null {
  return formatCompactContinuationMetaLine(source);
}

function SortableCompactSourceCard({
  source,
  index,
  selected,
  metaLine,
  sourceColor,
  disabled,
  onRemove,
  canRemoveSource,
  onSelect,
}: {
  source: ContinuationInspectSource;
  index: number;
  selected: boolean;
  metaLine: string | null;
  sourceColor?: string;
  disabled: boolean;
  onRemove?: (sourceKey: string) => void;
  canRemoveSource?: (sourceKey: string) => boolean;
  onSelect?: (sourceKey: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: source.key, disabled });
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <Paper
      ref={setNodeRef}
      withBorder
      p={0}
      onClick={() => onSelect?.(source.key)}
      tabIndex={onSelect ? 0 : undefined}
      role={onSelect ? "button" : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onKeyDown={(event) => {
        if (!onSelect) return;
        // The drag handle owns its keyboard sensor events; only the row body
        // itself should activate source selection.
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
        overflow: "hidden",
        display: "flex",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <SourceIdentityGutter
        number={index + 1}
        color={sourceColor}
        handleRef={setActivatorNodeRef}
        handleAttributes={attributes}
        handleListeners={listeners}
        handleLabel={`Reorder ${source.filename}`}
        isDragging={isDragging}
      />
      <VisuallyHidden>Source {index + 1}. Use the drag handle to reorder.</VisuallyHidden>
      <Stack gap={4} style={{ flex: 1, minWidth: 0, padding: "8px" }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={selected ? 700 : 600} truncate title={source.filename} style={{ flex: 1, minWidth: 0 }}>
            {source.filename}
          </Text>
          {source.inspection_status === "error" && (
            <Tooltip label={source.inspection_error ?? "Inspection failed"}>
              <Badge size="xs" variant="light" color="red">Error</Badge>
            </Tooltip>
          )}
          {onRemove && <Tooltip label={`Remove ${source.filename}`}>
            <ActionIcon size="sm" variant="subtle" color="red" aria-label={`Remove ${source.filename}`} disabled={disabled || canRemoveSource?.(source.key) === false} onClick={(event) => { stop(event); onRemove(source.key); }}><IconX size={13} /></ActionIcon>
          </Tooltip>}
        </Group>
        {metaLine && <Text size="xs" c="dimmed" truncate title={metaLine} style={{ minWidth: 0, maxWidth: "100%" }}>{metaLine}</Text>}
      </Stack>
    </Paper>
  );
}

export function ContinuationSourceList({
  sources,
  findings,
  onMove,
  onDragStart,
  onDrop,
  onReorder,
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
  /** Compact-import reorder callback; dnd-kit supplies source and target indices. */
  onReorder?: (from: number, to: number) => void;
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
  const compactSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!sources.length) return <Text size="sm" c="dimmed">{emptyMessage}</Text>;

  if (variant === "compact-import") {
    const sourceIds = sources.map((source) => source.key);
    const handleDragEnd = ({ active, over }: DragEndEvent) => {
      if (!onReorder || disabled || !over || active.id === over.id) return;
      const from = sourceIds.indexOf(String(active.id));
      const to = sourceIds.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      onReorder(from, to);
    };

    return (
      <DndContext sensors={compactSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sourceIds} strategy={verticalListSortingStrategy}>
          <Stack gap={6}>
            {sources.map((source, index) => (
              <SortableCompactSourceCard
                key={source.key}
                source={source}
                index={index}
                selected={selectedSourceKey === source.key}
                metaLine={compactMetaLine(source)}
                sourceColor={colorsBySourceKey?.[source.key]}
                disabled={disabled || !onReorder}
                onRemove={onRemove && sources.length > 1 ? onRemove : undefined}
                canRemoveSource={canRemoveSource}
                onSelect={onSelect}
              />
            ))}
          </Stack>
        </SortableContext>
      </DndContext>
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
