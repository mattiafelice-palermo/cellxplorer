import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQueries } from "@tanstack/react-query";
import {
  IconCalculator,
  IconCalculatorOff,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFocus2,
  IconListCheck,
  IconPencil,
  IconArrowRight,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  CellProtocol,
  FileProtocol,
  get,
  ProtocolSegment,
  ProtocolGroup,
  ProtocolSegmentTarget,
  ProtocolStep,
} from "../api";
import {
  cRateExamples,
  FILTER_FIELDS,
  operatorsFor,
  type StepFilter,
  stepMatches,
} from "../protocolStepFilters";

interface ProtocolFileRef {
  cellId: number;
  cellName: string;
  testName: string;
  fileId: number;
  filename: string;
  hash: string;
  observedSteps: {
    step_index: number;
    execution_count: number;
    cycle_count: number;
    cycles: number[];
  }[];
  protocol: FileProtocol;
}

interface ProtocolFamily {
  signature: string;
  protocol: FileProtocol | null;
  files: ProtocolFileRef[];
  unavailableSteps?: number[];
}

interface SegmentDraft {
  id: string | null;
  name: string;
  targets: ProtocolSegmentTarget[];
}

interface RangeDraft {
  from: number | null;
  to: number | null;
}

export interface ProtocolSegmentsPanelProps {
  cellIds: number[];
  segments: ProtocolSegment[];
  hiddenSegmentIds: string[];
  excludedSegmentIds: string[];
  onlySegmentIds: string[];
  onSaveSegment: (segment: ProtocolSegment) => void;
  onDeleteSegment: (segmentId: string) => void;
  onToggleHidden: (segmentId: string) => void;
  onToggleExcluded: (segmentId: string) => void;
  onUseOnly: (segmentId: string | null) => void;
  title?: string;
  subtitle?: string;
  emptyText?: string;
  showPlotControls?: boolean;
  showSuggestions?: boolean;
  suggestions?: ProtocolSegmentSuggestion[];
  suggestionsLoading?: boolean;
  suggestionsError?: boolean;
  validateSegment?: (segment: ProtocolSegment) => string | null;
}

export interface ProtocolSegmentSuggestion {
  id: string;
  label: string;
  description?: string;
  segment: ProtocolSegment;
}

function segmentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `protocol-segment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function selectedSteps(targets: ProtocolSegmentTarget[], signature: string): number[] {
  return targets.find((target) => target.protocol_signature === signature)?.step_indices ?? [];
}

function replaceTarget(
  targets: ProtocolSegmentTarget[],
  signature: string,
  steps: number[]
): ProtocolSegmentTarget[] {
  const next = targets.filter((target) => target.protocol_signature !== signature);
  const normalized = uniqueSorted(steps);
  if (normalized.length > 0) {
    next.push({ protocol_signature: signature, step_indices: normalized });
  }
  return next.sort((a, b) => a.protocol_signature.localeCompare(b.protocol_signature));
}

function targetCount(targets: ProtocolSegmentTarget[]): number {
  return targets.reduce((total, target) => total + target.step_indices.length, 0);
}

/**
 * The number a protocol is shown as.
 *
 * Both the picker and the segment list label protocols positionally, and when
 * each derived that position independently they could disagree — a segment
 * built against the first protocol was filed under a different number. One
 * lookup, used by both, removes the possibility.
 */
function protocolNumber(families: ProtocolFamily[], signature: string): number | null {
  const index = families.findIndex((family) => family.signature === signature);
  return index >= 0 ? index + 1 : null;
}

function shortSignature(signature: string): string {
  return signature.length > 14 ? `${signature.slice(0, 12)}...` : signature;
}

/**
 * Fill in the nesting fields a group may lack.
 *
 * Protocol groups reach this panel from several places — a live backend, a
 * cached analysis result, an imported portable report — and those can predate
 * the nested-block fields. Deriving what is missing keeps an older payload
 * rendering as a flat list instead of blanking the page.
 */
export function normalizeGroup(group: ProtocolGroup): ProtocolGroup {
  const children = (group.children ?? []).map(normalizeGroup);
  const own = group.step_numbers ?? [];
  return {
    ...group,
    id: group.id ?? `${group.kind}-${group.start_step}-${group.end_step}`,
    depth: group.depth ?? 0,
    children,
    step_numbers: own,
    all_step_numbers:
      group.all_step_numbers ??
      uniqueSorted([...own, ...children.flatMap((child) => child.all_step_numbers)]),
  };
}

function familyGroups(family: ProtocolFamily): ProtocolGroup[] {
  if (family.protocol?.groups.length) return family.protocol.groups.map(normalizeGroup);
  const stepNumbers = family.unavailableSteps ?? family.protocol?.steps.map((step) => step.number) ?? [];
  if (stepNumbers.length === 0) return [];
  return [
    {
      id: "fallback",
      kind: "sequence" as const,
      label: family.protocol ? "Protocol steps" : "Unavailable protocol steps",
      start_step: stepNumbers[0],
      end_step: stepNumbers[stepNumbers.length - 1],
      repeat_count: 1,
      control_step: null,
      depth: 0,
      step_numbers: stepNumbers,
      all_step_numbers: stepNumbers,
      children: [],
      summary: family.protocol
        ? `Steps ${stepNumbers[0]}-${stepNumbers[stepNumbers.length - 1]}`
        : "This protocol is not present in the current analysis samples.",
    },
  ];
}

/** Every step in a block and everything nested inside it. */
function groupSteps(groups: ProtocolGroup[]): number[] {
  return groups.flatMap((group) => group.all_step_numbers);
}

/**
 * One node of the protocol tree, with its nested blocks beneath it.
 *
 * Neware loops nest, so the panel has to as well: an ageing block sits inside
 * the outer block that repeats it. Selecting a block selects everything it
 * runs (`all_step_numbers`), while the step checkboxes listed under it are only
 * the steps it owns directly — the nested blocks render their own.
 */
const STEP_GRID = "26px 40px minmax(180px, 1fr) 78px 74px 68px 74px";

function StepTableHeader() {
  return (
    <Box
      style={{
        display: "grid",
        gridTemplateColumns: STEP_GRID,
        gap: 8,
        padding: "4px 8px",
        fontSize: 11,
        color: "var(--mantine-color-dimmed)",
        borderBottom: "1px solid var(--mantine-color-gray-2)",
      }}
    >
      <span />
      <span>#</span>
      <span>step / condition</span>
      <span>rate</span>
      <span>cut-off</span>
      <span>until</span>
      <span>max time</span>
    </Box>
  );
}

function factValue(step: ProtocolStep, keys: string[]): string | null {
  for (const key of keys) {
    const fact = (step.facts ?? []).find((entry) => entry.key === key);
    if (fact) return fact.value;
  }
  return null;
}

/** One step as an aligned row, so values can be compared down the column. */
function StepRow({
  step,
  number,
  checked,
  observed,
  onToggle,
}: {
  step: ProtocolStep | undefined;
  number: number;
  checked: boolean;
  observed: { executionCount: number; fileCount: number; cycles: number[]; detail: string };
  onToggle: (checked: boolean) => void;
}) {
  const rate = step ? factValue(step, ["rate", "current"]) : null;
  const rateFact = (step?.facts ?? []).find((f) => f.key === "rate" || f.key === "current");
  const cutoff = step ? factValue(step, ["to", "hold"]) : null;
  const until = step ? factValue(step, ["until"]) : null;
  const maxTime = step ? factValue(step, ["limit", "duration"]) : null;
  const conditions = step?.conditions ?? [];
  const dash = (
    <Text size="xs" c="dimmed">
      —
    </Text>
  );

  return (
    <Box
      style={{
        display: "grid",
        gridTemplateColumns: STEP_GRID,
        gap: 8,
        padding: "5px 8px",
        alignItems: "start",
        borderBottom: "1px solid var(--mantine-color-gray-1)",
      }}
    >
      <Checkbox
        size="xs"
        checked={checked}
        onChange={(event) => onToggle(event.currentTarget.checked)}
        aria-label={`Select step ${number}`}
        mt={2}
      />
      <Text size="xs" c="dimmed" ff="monospace" mt={2}>
        {number}
      </Text>
      <Box style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Box
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              flexShrink: 0,
              background: DIRECTION_COLOR[step?.direction ?? "rest"],
            }}
          />
          <Text size="xs" fw={500} truncate>
            {step?.type ?? `Step ${number}`}
          </Text>
        </Group>
        {conditions.map((condition, index) => (
          <Tooltip
            key={`${condition.expression}-${index}`}
            label={
              condition.name
                ? `${condition.name}: ${condition.expression} (as written in the protocol file)`
                : `${condition.expression} (as written in the protocol file)`
            }
            multiline
            maw={320}
          >
            <Text size="10px" ff="monospace" c="teal.7" truncate pl={12}>
              {condition.expression}
            </Text>
          </Tooltip>
        ))}
        {observed.executionCount > 0 && (
          <Tooltip
            label={<Text style={{ whiteSpace: "pre-line" }}>{observed.detail}</Text>}
            multiline
          >
            <Text size="10px" c="dimmed" pl={12}>
              {observed.executionCount}x · cycles {compactCycles(observed.cycles)}
            </Text>
          </Tooltip>
        )}
      </Box>
      <Box mt={2}>
        {rate ? (
          <Text size="xs" ff="monospace">
            {rate}
            {rateFact?.note && (
              <Tooltip label="Derived from the step current and the nominal capacity">
                <Text component="span" c="dimmed">
                  *
                </Text>
              </Tooltip>
            )}
          </Text>
        ) : (
          dash
        )}
      </Box>
      <Text size="xs" ff="monospace" mt={2}>
        {cutoff ?? dash}
      </Text>
      <Text size="xs" ff="monospace" mt={2}>
        {until ?? dash}
      </Text>
      <Text size="xs" ff="monospace" mt={2}>
        {maxTime ?? dash}
      </Text>
    </Box>
  );
}

function ProtocolGroupNode({
  group,
  selectedSet,
  byNumber,
  family,
  visibleSteps,
  defaultOpen,
  onToggleSteps,
}: {
  group: ProtocolGroup;
  selectedSet: Set<number>;
  byNumber: Map<number, ProtocolStep>;
  family: ProtocolFamily;
  visibleSteps: Set<number> | null;
  defaultOpen?: boolean;
  onToggleSteps: (steps: number[], checked: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? group.depth === 0);
  const owned = group.all_step_numbers;
  const nSelected = owned.filter((step) => selectedSet.has(step)).length;
  const allSelected = owned.length > 0 && nSelected === owned.length;
  const isBlock = group.kind === "repeated_block";
  const shownSteps = group.step_numbers.filter((n) => !visibleSteps || visibleSteps.has(n));
  // A block whose every step was filtered out, and whose children are equally
  // empty, is noise — drop it rather than leaving a header with nothing under it.
  const hasVisible =
    shownSteps.length > 0 || owned.some((n) => !visibleSteps || visibleSteps.has(n));
  if (!hasVisible) return null;

  return (
    <Box
      style={{
        border: "1px solid var(--mantine-color-gray-3)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--mantine-color-body)",
      }}
    >
      <Group
        gap={6}
        wrap="nowrap"
        align="center"
        p={8}
        style={{
          background:
            group.depth === 0 ? "var(--mantine-color-body)" : "var(--mantine-color-gray-0)",
        }}
      >
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? `Collapse ${group.summary}` : `Expand ${group.summary}`}
        >
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </ActionIcon>
        <Checkbox
          size="xs"
          checked={allSelected}
          indeterminate={nSelected > 0 && !allSelected}
          onChange={(event) => onToggleSteps(owned, event.currentTarget.checked)}
          aria-label={`Select ${group.summary}`}
        />
        <Box
          onClick={() => setOpen((value) => !value)}
          style={{ cursor: "pointer", flex: 1, minWidth: 0 }}
        >
          <Group gap={6} wrap="nowrap">
            <Text size="xs" fw={isBlock ? 600 : 500} truncate>
              {group.summary}
            </Text>
            {isBlock && (
              <Badge size="xs" variant="light" color="teal" style={{ flexShrink: 0 }}>
                x{group.repeat_count}
              </Badge>
            )}
          </Group>
        </Box>
        <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>
          {nSelected}/{owned.length}
        </Text>
      </Group>
      {open && (
        <Box mt={4}>
          {shownSteps.length > 0 && (
            <Box mb={6}>
              <StepTableHeader />
              {shownSteps.map((stepNumber) => (
                <StepRow
                  key={stepNumber}
                  step={byNumber.get(stepNumber)}
                  number={stepNumber}
                  checked={selectedSet.has(stepNumber)}
                  observed={observedStepSummary(family, stepNumber)}
                  onToggle={(checked) => onToggleSteps([stepNumber], checked)}
                />
              ))}
            </Box>
          )}
          <Stack gap={6} pl="md" pr={6} pb={6}>
            {group.children.map((child) => (
              <ProtocolGroupNode
                key={child.id}
                group={child}
                selectedSet={selectedSet}
                byNumber={byNumber}
                family={family}
                visibleSteps={visibleSteps}
                defaultOpen={defaultOpen}
                onToggleSteps={onToggleSteps}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}

function stepLabel(step: ProtocolStep | undefined, number: number): string {
  if (!step) return `Step ${number}`;
  return `Step ${number} - ${step.summary || step.type}`;
}

const DIRECTION_COLOR: Record<string, string> = {
  charge: "var(--mantine-color-teal-6)",
  discharge: "var(--mantine-color-indigo-5)",
  rest: "var(--mantine-color-gray-4)",
  control: "var(--mantine-color-grape-4)",
};

/**
 * One protocol step: what it is, then its settings as labelled values.
 *
 * The single pipe-separated summary is hard to scan across a hundred steps, so
 * the settings are laid out with their meanings visible. The parts come from
 * the backend rather than being parsed out of the summary, so nothing here can
 * round a C-rate differently from the rest of the app. Older payloads without
 * them fall back to the original line.
 */
function StepDetail({ step, number }: { step: ProtocolStep | undefined; number: number }) {
  if (!step) return <Text size="xs">Step {number}</Text>;
  const facts = step.facts ?? [];
  return (
    <Box>
      <Group gap={6} wrap="nowrap" align="center">
        <Box
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            flexShrink: 0,
            background: DIRECTION_COLOR[step.direction] ?? "var(--mantine-color-gray-4)",
          }}
        />
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {number}
        </Text>
        <Text size="xs" fw={600}>
          {step.type}
        </Text>
      </Group>
      {facts.length > 0 ? (
        <Group gap={10} wrap="wrap" mt={1} pl={18}>
          {facts.map((fact) => (
            <Group key={fact.key} gap={3} wrap="nowrap">
              <Text size="10px" c="dimmed">
                {fact.label}
              </Text>
              <Text size="10px" fw={600} ff="monospace">
                {fact.value}
              </Text>
              {fact.note && (
                <Tooltip label="Derived from the step current and the nominal capacity">
                  <Text size="10px" c="dimmed" fs="italic">
                    ({fact.note})
                  </Text>
                </Tooltip>
              )}
            </Group>
          ))}
        </Group>
      ) : (
        <Text size="10px" c="dimmed" pl={18}>
          {step.summary}
        </Text>
      )}
    </Box>
  );
}

function compactCycles(values: number[]): string {
  const cycles = uniqueSorted(values);
  if (cycles.length === 0) return "no cycling cycle";
  const ranges: string[] = [];
  let start = cycles[0];
  let end = start;
  for (const cycle of cycles.slice(1)) {
    if (cycle === end + 1) {
      end = cycle;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = end = cycle;
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  const visible = ranges.slice(0, 7).join(", ");
  return ranges.length > 7 ? `${visible}, ...` : visible;
}

function observedStepSummary(family: ProtocolFamily, stepNumber: number) {
  const matching = family.files.flatMap((file) =>
    file.observedSteps
      .filter((item) => item.step_index === stepNumber)
      .map((item) => ({ ...item, file }))
  );
  const executionCount = matching.reduce((total, item) => total + item.execution_count, 0);
  const cycles = uniqueSorted(matching.flatMap((item) => item.cycles));
  return {
    executionCount,
    fileCount: matching.length,
    cycles,
    detail: matching
      .map(
        (item) =>
          `${item.file.cellName} / ${item.file.filename}: ${item.execution_count} execution${item.execution_count === 1 ? "" : "s"}; cycles ${compactCycles(item.cycles)}`
      )
      .join("\n"),
  };
}

/**
 * Segments saved so far, grouped by the protocol they target.
 *
 * Keeping this beside the step list is what lets several segments be built in
 * one visit: previously each one meant saving, closing the modal, and opening
 * it again from scratch.
 */
function SegmentSidePanel({
  segments,
  families,
  editingId,
  onEdit,
  onDelete,
  onRename,
}: {
  segments: ProtocolSegment[];
  families: ProtocolFamily[];
  editingId: string | null;
  onEdit: (segment: ProtocolSegment) => void;
  onDelete: (segmentId: string) => void;
  onRename: (segment: ProtocolSegment, name: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const byProtocol = new Map<string, ProtocolSegment[]>();
  for (const segment of segments) {
    // A segment can span protocols; list it under each one it touches.
    for (const target of segment.targets) {
      const list = byProtocol.get(target.protocol_signature) ?? [];
      list.push(segment);
      byProtocol.set(target.protocol_signature, list);
    }
  }

  return (
    <Paper
      withBorder
      radius="md"
      p={8}
      style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <Text size="xs" fw={600} mb={6}>
        Segments ({segments.length})
      </Text>
      {segments.length === 0 ? (
        <Text size="10px" c="dimmed">
          Pick steps, name them, then choose Add segment. They collect here.
        </Text>
      ) : (
        <Box className="cx-vertical-scroll" style={{ flex: 1, minHeight: 0 }}>
          <Stack gap={8} pr={4}>
            {[...byProtocol.entries()].map(([signature, list]) => (
              <Box key={signature}>
                <Group gap={6} align="baseline" mb={4}>
                  <Text size="xs" fw={600} c="teal.7">
                    Protocol {protocolNumber(families, signature) ?? "—"}
                  </Text>
                  <Text size="10px" c="dimmed" ff="monospace">
                    {shortSignature(signature)}
                  </Text>
                </Group>
                <Stack gap={4}>
                  {list.map((segment) => {
                    const steps = segment.targets.reduce(
                      (total, target) => total + target.step_indices.length,
                      0
                    );
                    return (
                      <Paper
                        key={`${signature}-${segment.id}`}
                        withBorder
                        radius="sm"
                        p={6}
                        style={{
                          borderColor:
                            segment.id === editingId ? "var(--mantine-color-teal-4)" : undefined,
                        }}
                      >
                        {renaming === segment.id ? (
                          <TextInput
                            size="xs"
                            value={renameValue}
                            autoFocus
                            onChange={(event) => setRenameValue(event.currentTarget.value)}
                            onBlur={() => {
                              if (renameValue.trim()) onRename(segment, renameValue.trim());
                              setRenaming(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                              if (event.key === "Escape") setRenaming(null);
                            }}
                          />
                        ) : (
                          <Group gap={4} wrap="nowrap" align="center">
                            <Box style={{ flex: 1, minWidth: 0 }}>
                              <Text size="xs" fw={500} truncate>
                                {segment.name}
                              </Text>
                              <Text size="10px" c="dimmed">
                                {steps} step{steps === 1 ? "" : "s"}
                              </Text>
                            </Box>
                            <Tooltip label="Rename">
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="gray"
                                onClick={() => {
                                  setRenaming(segment.id);
                                  setRenameValue(segment.name);
                                }}
                                aria-label={`Rename ${segment.name}`}
                              >
                                <IconPencil size={12} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label="Load its steps for editing">
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="teal"
                                onClick={() => onEdit(segment)}
                                aria-label={`Edit ${segment.name}`}
                              >
                                <IconListCheck size={12} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label="Delete">
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="red"
                                onClick={() => onDelete(segment.id)}
                                aria-label={`Delete ${segment.name}`}
                              >
                                <IconTrash size={12} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        )}
                      </Paper>
                    );
                  })}
                </Stack>
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
}

/**
 * Choose which protocol to work on, and see which cells share it.
 *
 * Files are already grouped by protocol signature, so cells running byte-wise
 * identical programs collapse into one entry. Showing them all at once made
 * the list unreadable when an analysis holds several protocols; picking one
 * keeps the step table about a single program.
 */
function ProtocolPicker({
  families,
  activeSignature,
  onSelect,
  targets,
}: {
  families: ProtocolFamily[];
  activeSignature: string | null;
  onSelect: (signature: string) => void;
  targets: ProtocolSegmentTarget[];
}) {
  const [showCells, setShowCells] = useState(false);
  const active = families.find((f) => f.signature === activeSignature) ?? families[0];
  const label = (family: ProtocolFamily) => {
    const cells = [...new Set(family.files.map((file) => file.cellName))];
    const steps = family.protocol?.n_executable_steps ?? 0;
    const chosen = selectedSteps(targets, family.signature).length;
    const where = cells.length === 0 ? "not in samples" : `${cells.length} cell${cells.length === 1 ? "" : "s"}`;
    const number = protocolNumber(families, family.signature) ?? "—";
    return `Protocol ${number} — ${steps} steps, ${where}${chosen ? ` · ${chosen} selected` : ""}`;
  };

  return (
    <Stack gap={4}>
      <Group gap={8} wrap="nowrap" align="end">
        <Select
          size="xs"
          label="Protocol"
          style={{ flex: 1 }}
          data={families.map((family) => ({
            value: family.signature,
            label: label(family),
          }))}
          value={active?.signature ?? null}
          onChange={(value) => value && onSelect(value)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
        <Button
          size="compact-xs"
          variant="default"
          onClick={() => setShowCells((value) => !value)}
          disabled={!active || active.files.length === 0}
        >
          {showCells ? "Hide cells" : `Cells (${new Set(active?.files.map((f) => f.cellName)).size ?? 0})`}
        </Button>
      </Group>
      {showCells && active && (
        <Paper withBorder radius="md" p={6} bg="var(--mantine-color-gray-0)">
          <Box className="cx-vertical-scroll" style={{ maxHeight: 96 }}>
            <Stack gap={2}>
              {active.files.map((file) => (
                <Tooltip key={`${file.cellId}-${file.fileId}`} label={`${file.hash} — ${file.filename}`}>
                  <Text size="10px" c="dimmed" truncate>
                    {file.cellName} · {file.testName} / {file.filename}
                  </Text>
                </Tooltip>
              ))}
            </Stack>
          </Box>
        </Paper>
      )}
    </Stack>
  );
}

/**
 * The capacity every C-rate on screen is derived from, and what it converts to.
 *
 * Rates are shown as C-fractions throughout, so without this the reader has to
 * do the arithmetic themselves to know what current a step actually applies.
 */
function CapacityReference({ families }: { families: ProtocolFamily[] }) {
  const withCapacity = families
    .map((family) => family.protocol)
    .filter((protocol): protocol is FileProtocol => Boolean(protocol?.nominal_capacity_mah));
  if (withCapacity.length === 0) return null;
  const capacity = withCapacity[0].nominal_capacity_mah ?? null;
  const inferred = withCapacity[0].nominal_capacity_inferred;
  const mixed = new Set(withCapacity.map((p) => p.nominal_capacity_mah)).size > 1;
  // Constant for a whole protocol, so it belongs here rather than on 100 rows.
  const windows = withCapacity[0].summary?.protection_windows ?? [];
  const protection = windows
    .map((w) => `${w.lower_v ?? "?"}–${w.upper_v ?? "?"} V`)
    .join(", ");

  return (
    <Paper p="xs" withBorder radius="md" bg="var(--mantine-color-gray-0)">
      <Group gap="lg" wrap="wrap" align="center">
        <Box>
          <Text size="10px" c="dimmed" tt="uppercase">
            nominal capacity
          </Text>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} ff="monospace">
              {capacity?.toFixed(2)} mAh
            </Text>
            {inferred && (
              <Tooltip label="Reconstructed from the protocol's current and C-rate pairs, not declared by the file">
                <Text size="10px" c="dimmed" fs="italic">
                  inferred
                </Text>
              </Tooltip>
            )}
          </Group>
        </Box>
        {protection && (
          <Box>
            <Text size="10px" c="dimmed" tt="uppercase">
              protection window
            </Text>
            <Text size="xs" ff="monospace">
              {protection}
            </Text>
          </Box>
        )}
        <Group gap="sm" wrap="wrap">
          {cRateExamples(capacity).map((example) => (
            <Box key={example.label}>
              <Text size="10px" c="dimmed">
                {example.label}
              </Text>
              <Text size="xs" ff="monospace">
                {example.current}
              </Text>
            </Box>
          ))}
        </Group>
      </Group>
      {mixed && (
        <Text size="10px" c="dimmed" mt={4}>
          Families differ in nominal capacity; the conversions above use the first.
        </Text>
      )}
    </Paper>
  );
}

/** Free-text search plus stacking field comparisons. */
function StepFilterBar({
  query,
  onQuery,
  filters,
  onFilters,
}: {
  query: string;
  onQuery: (value: string) => void;
  filters: StepFilter[];
  onFilters: (filters: StepFilter[]) => void;
}) {
  const update = (id: string, patch: Partial<StepFilter>) =>
    onFilters(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          size="xs"
          placeholder="Search steps, rates, limits or conditions"
          value={query}
          onChange={(event) => onQuery(event.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Button
          size="compact-xs"
          variant="default"
          leftSection={<IconPlus size={12} />}
          onClick={() => {
            // Offer a field that is not already filtered, so stacking filters
            // does not start by repeating the previous one.
            const used = new Set(filters.map((f) => f.field));
            const next = FILTER_FIELDS.find((entry) => !used.has(entry.value)) ?? FILTER_FIELDS[0];
            onFilters([
              ...filters,
              {
                id: segmentId(),
                field: next.value,
                operator: operatorsFor(next.value)[0],
                value: "",
              },
            ]);
          }}
        >
          Filter
        </Button>
      </Group>
      {filters.map((filter) => {
        const field = FILTER_FIELDS.find((entry) => entry.value === filter.field);
        return (
          <Group key={filter.id} gap={6} wrap="nowrap">
            <Select
              size="xs"
              w={132}
              data={FILTER_FIELDS.map((entry) => ({ value: entry.value, label: entry.label }))}
              value={filter.field}
              onChange={(value) => {
                if (!value) return;
                const next = value as StepFilter["field"];
                // Keep the operator legal for the new field.
                const allowed = operatorsFor(next);
                update(filter.id, {
                  field: next,
                  operator: allowed.includes(filter.operator) ? filter.operator : allowed[0],
                });
              }}
            />
            <Select
              size="xs"
              w={84}
              data={operatorsFor(filter.field).map((op) => ({ value: op, label: op }))}
              value={filter.operator}
              onChange={(value) =>
                value && update(filter.id, { operator: value as StepFilter["operator"] })
              }
            />
            <TextInput
              size="xs"
              placeholder={field?.hint ?? "value"}
              value={filter.value}
              onChange={(event) => update(filter.id, { value: event.currentTarget.value })}
              style={{ flex: 1 }}
            />
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => onFilters(filters.filter((f) => f.id !== filter.id))}
              aria-label="Remove filter"
            >
              <IconX size={13} />
            </ActionIcon>
          </Group>
        );
      })}
    </Stack>
  );
}

function SegmentEditor({
  draft,
  families,
  segments,
  loading,
  hasErrors,
  onClose,
  onDelete,
  onSave,
  suggestions,
  suggestionsLoading,
  suggestionsError,
  showSuggestions,
  validateSegment,
}: {
  draft: SegmentDraft;
  families: ProtocolFamily[];
  segments: ProtocolSegment[];
  loading: boolean;
  hasErrors: boolean;
  onClose: () => void;
  onDelete: (segmentId: string) => void;
  onSave: (segment: ProtocolSegment) => void;
  suggestions: ProtocolSegmentSuggestion[];
  suggestionsLoading: boolean;
  suggestionsError: boolean;
  showSuggestions: boolean;
  validateSegment?: (segment: ProtocolSegment) => string | null;
}) {
  const [name, setName] = useState(draft.name);
  const [targets, setTargets] = useState<ProtocolSegmentTarget[]>(draft.targets);
  const [ranges, setRanges] = useState<Record<string, RangeDraft>>({});
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<StepFilter[]>([]);
  const [activeSignature, setActiveSignature] = useState<string | null>(null);
  // Remounting the tree is how "expand all"/"collapse all" reaches nodes that
  // own their own open state; the epoch changes the React key.
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const [expandEpoch, setExpandEpoch] = useState(0);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Pin the choice once, rather than falling back to families[0] on every
  // render. Protocol queries resolve one cell at a time and the list is kept
  // sorted by signature, so "the first family" is a different protocol at
  // 0.5s than at 2s. Steps selected before the list settled were being filed
  // against whichever protocol happened to sort first at that instant, which
  // then appeared under a different number once the rest arrived.
  useEffect(() => {
    if (loading || activeSignature !== null || families.length === 0) return;
    setActiveSignature(families[0].signature);
  }, [loading, activeSignature, families]);
  const activeFamily = families.find((f) => f.signature === activeSignature) ?? null;
  const count = targetCount(targets);

  const setFamilySteps = (signature: string, steps: number[]) => {
    setTargets((current) => replaceTarget(current, signature, steps));
  };

  const toggleSteps = (signature: string, steps: number[], checked: boolean) => {
    const current = new Set(selectedSteps(targets, signature));
    for (const step of steps) {
      if (checked) current.add(step);
      else current.delete(step);
    }
    setFamilySteps(signature, [...current]);
  };

  const [editingId, setEditingId] = useState<string | null>(draft.id);

  /** Store the current draft and clear the bench for the next one. */
  const save = () => {
    if (!name.trim() || count === 0) return;
    const segment = {
      id: editingId ?? segmentId(),
      name: name.trim(),
      targets: targets.map((target) => ({
        ...target,
        step_indices: uniqueSorted(target.step_indices),
      })),
    };
    const error = validateSegment?.(segment) ?? null;
    if (error) {
      setValidationError(error);
      return;
    }
    onSave(segment);
    setEditingId(null);
    setName("");
    setTargets([]);
    setValidationError(null);
  };

  const editSegment = (segment: ProtocolSegment) => {
    setEditingId(segment.id);
    setName(segment.name);
    setTargets(segment.targets.map((target) => ({ ...target })));
    setValidationError(null);
  };

  const selectedSuggestion = suggestions.find(
    (suggestion) => suggestion.id === suggestionId
  );

  return (
    <Modal
      opened
      onClose={onClose}
      title={draft.id ? "Edit protocol segment" : "Create protocol segment"}
      // Wide enough that the segment list is an extra panel rather than a
      // slice taken out of the step table.
      size="min(1240px, calc(100vw - 3rem))"
      centered
    >
      <Group align="stretch" gap="sm" wrap="nowrap">
      <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
        <Group align="end" wrap="nowrap">
          <TextInput
            label="Segment name"
            placeholder="Formation, RPT, rate block..."
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            style={{ flex: 1 }}
            autoFocus
          />
          <Box pb={7} style={{ flexShrink: 0 }}>
            <Text size="xs" fw={700}>{count} selected steps</Text>
            <Text size="xs" c="dimmed">
              {targets.length} selected {targets.length === 1 ? "protocol" : "protocols"}
            </Text>
          </Box>
          <Group gap={8} pb={4} wrap="nowrap" style={{ flexShrink: 0 }}>
            <Button variant="default" size="sm" onClick={onClose}>
              Done
            </Button>
            <Button
              size="sm"
              disabled={!name.trim() || count === 0}
              onClick={save}
              color={editingId ? "orange" : undefined}
              rightSection={editingId ? undefined : <IconArrowRight size={15} />}
            >
              {editingId ? "Save changes" : "Add segment"}
            </Button>
          </Group>
        </Group>

        {showSuggestions && (
          <Paper p="xs" withBorder bg="teal.0">
            <Group align="end" wrap="nowrap">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Group gap={6} mb={4}>
                  <IconSparkles size={15} color="var(--mantine-color-teal-6)" />
                  <Text size="xs" fw={700}>Suggested DCIR pairs</Text>
                </Group>
                <Select
                  size="xs"
                  placeholder={
                    suggestionsLoading
                      ? "Looking for long-rest / short-pulse pairs..."
                      : "Choose a detected rest / pulse pair"
                  }
                  searchable
                  disabled={suggestionsLoading || suggestions.length === 0}
                  data={suggestions.map((suggestion) => ({
                    value: suggestion.id,
                    label: suggestion.label,
                  }))}
                  value={suggestionId}
                  onChange={setSuggestionId}
                />
              </Box>
              <Button
                size="xs"
                variant="light"
                disabled={!selectedSuggestion}
                onClick={() => {
                  if (!selectedSuggestion) return;
                  setName(selectedSuggestion.segment.name);
                  setTargets(
                    selectedSuggestion.segment.targets.map((target) => ({
                      ...target,
                      step_indices: [...target.step_indices],
                    }))
                  );
                  setActiveSignature(
                    selectedSuggestion.segment.targets[0]?.protocol_signature ?? null
                  );
                  setValidationError(null);
                }}
              >
                Select pair
              </Button>
            </Group>
            {suggestionsError && (
              <Text size="xs" c="red" mt={5}>
                Automatic suggestions could not be loaded. You can still select the
                rest and pulse steps manually below.
              </Text>
            )}
            {!suggestionsLoading &&
              !suggestionsError &&
              suggestions.length === 0 && (
                <Text size="xs" c="dimmed" mt={5}>
                  No pair matches the current recognition limits. Manual step
                  selection remains available below.
                </Text>
              )}
            {selectedSuggestion?.description && (
              <Text size="xs" c="dimmed" mt={5}>
                {selectedSuggestion.description}
              </Text>
            )}
          </Paper>
        )}

        <CapacityReference families={families} />
        <StepFilterBar
          query={query}
          onQuery={setQuery}
          filters={filters}
          onFilters={setFilters}
        />

        {hasErrors && (
          <Alert color="yellow">Some cell protocols could not be loaded. Available families are still selectable.</Alert>
        )}
        {validationError && <Alert color="red">{validationError}</Alert>}
        {loading && (
          <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">Loading cell protocols...</Text></Group>
        )}

        {!loading && families.length > 0 && (
          <ProtocolPicker
            families={families}
            activeSignature={activeFamily?.signature ?? null}
            onSelect={setActiveSignature}
            targets={targets}
          />
        )}
        <Group gap={6} wrap="nowrap">
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              setExpandAll(true);
              setExpandEpoch((value) => value + 1);
            }}
          >
            Expand all
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              setExpandAll(false);
              setExpandEpoch((value) => value + 1);
            }}
          >
            Collapse all
          </Button>
        </Group>

        <ScrollArea h="min(52vh, 560px)" type="auto" offsetScrollbars style={{ flex: 1, minWidth: 0 }}>
          <Stack gap="md" pr="xs">
            {!loading && families.length === 0 && (
              <Alert color="gray">Add cells or replicates with protocol data before creating a segment.</Alert>
            )}
            {loading && (
              <Group gap="xs" p="md">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Reading protocols…
                </Text>
              </Group>
            )}
            {!loading && activeFamily && (() => {
              const family = activeFamily;
              const selected = selectedSteps(targets, family.signature);
              const selectedSet = new Set(selected);
              const groups = familyGroups(family);
              const allSteps = uniqueSorted(groupSteps(groups));
              const byNumber = new Map(family.protocol?.steps.map((step) => [step.number, step]) ?? []);
              // Null means "not filtering", which keeps steps that carry no
              // protocol detail visible instead of silently dropping them.
              const filtering = Boolean(query.trim() || filters.some((f) => f.value.trim()));
              const visibleSteps = filtering
                ? new Set(
                    allSteps.filter((n) => {
                      const step = byNumber.get(n);
                      return step ? stepMatches(step, filters, query) : false;
                    })
                  )
                : null;
              return (
                <Box>
                  <Group justify="space-between" wrap="nowrap" mb={6}>
                    <Group gap="xs" wrap="nowrap">
                      <Badge size="sm" variant="light" color="teal">
                        {selected.length}/{allSteps.length} steps
                      </Badge>
                      {visibleSteps && (
                        <Text size="xs" c="dimmed">
                          {visibleSteps.size} match the filters
                        </Text>
                      )}
                    </Group>
                    <Group gap={6} wrap="nowrap">
                      {visibleSteps && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="teal"
                          disabled={visibleSteps.size === 0}
                          onClick={() => toggleSteps(family.signature, [...visibleSteps], true)}
                        >
                          Select {visibleSteps.size} matching
                        </Button>
                      )}
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        disabled={selected.length === 0}
                        onClick={() => setFamilySteps(family.signature, [])}
                      >
                        Clear
                      </Button>
                    </Group>
                  </Group>

                  <Stack gap={8}>
                    {groups.map((group) => (
                      <ProtocolGroupNode
                        key={`${family.signature}-${group.id}-${expandEpoch}`}
                        group={group}
                        selectedSet={selectedSet}
                        byNumber={byNumber}
                        family={family}
                        visibleSteps={visibleSteps}
                        defaultOpen={expandAll ?? group.depth === 0}
                        onToggleSteps={(steps, checked) => toggleSteps(family.signature, steps, checked)}
                      />
                    ))}
                  </Stack>
                </Box>
              );
            })()}
          </Stack>
        </ScrollArea>
      </Stack>
      <Divider orientation="vertical" />
      <Box style={{ width: 268, flexShrink: 0, display: "flex" }}>
          <SegmentSidePanel
            segments={segments}
            families={families}
            editingId={editingId}
            onEdit={editSegment}
            onDelete={onDelete}
            onRename={(segment, next) => onSave({ ...segment, name: next })}
          />
      </Box>
      </Group>
    </Modal>
  );
}

export function ProtocolSegmentsPanel({
  cellIds,
  segments,
  hiddenSegmentIds,
  excludedSegmentIds,
  onlySegmentIds,
  onSaveSegment,
  onDeleteSegment,
  onToggleHidden,
  onToggleExcluded,
  onUseOnly,
  title = "Protocol segments",
  subtitle,
  emptyText = "No custom segments.",
  showPlotControls = true,
  showSuggestions = false,
  suggestions = [],
  suggestionsLoading = false,
  suggestionsError = false,
  validateSegment,
}: ProtocolSegmentsPanelProps) {
  const [draft, setDraft] = useState<SegmentDraft | null>(null);
  const protocolQueries = useQueries({
    queries: cellIds.map((cellId) => ({
      queryKey: ["cell-protocol", cellId, "with-observed-steps"],
      queryFn: () => get<CellProtocol>(`/api/cells/${cellId}/protocol?include_observed=true`),
      enabled: draft !== null,
      staleTime: 5 * 60_000,
    })),
  });
  const protocols = protocolQueries.flatMap((query) => (query.data ? [query.data] : []));
  const loading = protocolQueries.some((query) => query.isPending);
  const hasErrors = protocolQueries.some((query) => query.isError);

  const loadedFamilies = useMemo(() => {
    const bySignature = new Map<string, ProtocolFamily>();
    for (const cell of protocols) {
      for (const test of cell.tests) {
        for (const file of test.files) {
          const signature = file.protocol.signature;
          if (!signature) continue;
          const family = bySignature.get(signature) ?? {
            signature,
            protocol: file.protocol,
            files: [],
          };
          family.files.push({
            cellId: cell.cell_id,
            cellName: cell.cell_name,
            testName: test.name,
            fileId: file.id,
            filename: file.filename,
            hash: file.hash ?? file.source_hash ?? "Checksum unavailable",
            observedSteps: file.observed_steps ?? [],
            protocol: file.protocol,
          });
          bySignature.set(signature, family);
        }
      }
    }
    return [...bySignature.values()].sort((a, b) => a.signature.localeCompare(b.signature));
  }, [protocols]);

  const editorFamilies = useMemo(() => {
    if (!draft) return loadedFamilies;
    const known = new Set(loadedFamilies.map((family) => family.signature));
    const unavailable = draft.targets
      .filter((target) => !known.has(target.protocol_signature))
      .map((target): ProtocolFamily => ({
        signature: target.protocol_signature,
        protocol: null,
        files: [],
        unavailableSteps: uniqueSorted(target.step_indices),
      }));
    return [...loadedFamilies, ...unavailable];
  }, [draft, loadedFamilies]);

  const openEditor = (segment?: ProtocolSegment) => {
    setDraft({
      id: segment?.id ?? null,
      name: segment?.name ?? "",
      targets: segment?.targets.map((target) => ({
        ...target,
        step_indices: [...target.step_indices],
      })) ?? [],
    });
  };

  return (
    <>
      <Paper p="sm" withBorder>
        <Group justify="space-between" mb="xs">
          <Box>
            <Text fw={700} size="sm">{title}</Text>
            {subtitle && <Text size="xs" c="dimmed">{subtitle}</Text>}
            {onlySegmentIds.length > 0 && <Text size="xs" c="teal">Use-only filter active</Text>}
          </Box>
          <Tooltip label={cellIds.length === 0 ? "Add analysis samples first" : "Create protocol segment"}>
            <span>
              <ActionIcon size="sm" variant="light" disabled={cellIds.length === 0} onClick={() => openEditor()} aria-label="Create protocol segment">
                <IconPlus size={14} />
              </ActionIcon>
            </span>
          </Tooltip>
        </Group>

        {segments.length === 0 ? (
          <Text size="xs" c="dimmed">{emptyText}</Text>
        ) : (
          <Stack gap={4}>
            {segments.map((segment) => {
              const hidden = hiddenSegmentIds.includes(segment.id);
              const excluded = excludedSegmentIds.includes(segment.id);
              const only = onlySegmentIds.includes(segment.id);
              const filteredByOnly = onlySegmentIds.length > 0 && !only;
              const effectivelyHidden = hidden || excluded || filteredByOnly;
              return (
                <Box key={segment.id} py={3} style={{ opacity: effectivelyHidden ? 0.62 : 1 }}>
                  <Group justify="space-between" gap={4} wrap="nowrap">
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Group gap={5} wrap="nowrap">
                        <Text size="xs" fw={700} truncate>{segment.name}</Text>
                        {only && <Badge size="xs" variant="light">Only</Badge>}
                      </Group>
                      <Text size="10px" c="dimmed">
                        {targetCount(segment.targets)} steps / {segment.targets.length} {segment.targets.length === 1 ? "family" : "families"}
                      </Text>
                    </Box>
                    <Group gap={1} wrap="nowrap">
                      {showPlotControls && (
                        <>
                          <Tooltip label={excluded ? "Excluded segments are not plotted" : filteredByOnly ? "Another segment is used exclusively" : hidden ? "Show in plot" : "Hide from plot"}>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color={effectivelyHidden ? "gray" : "teal"}
                              disabled={excluded || filteredByOnly}
                              onClick={() => onToggleHidden(segment.id)}
                              aria-label={hidden ? `Show ${segment.name}` : `Hide ${segment.name}`}
                            >
                              {effectivelyHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label={excluded ? "Include in calculations" : "Exclude from calculations and plot"}>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color={excluded ? "red" : "teal"}
                              onClick={() => onToggleExcluded(segment.id)}
                              aria-label={excluded ? `Include ${segment.name} in calculations` : `Exclude ${segment.name} from calculations`}
                            >
                              {excluded ? <IconCalculatorOff size={14} /> : <IconCalculator size={14} />}
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label={only ? "Clear use-only filter" : `Use only ${segment.name}`}>
                            <ActionIcon
                              size="sm"
                              variant={only ? "light" : "subtle"}
                              color="teal"
                              onClick={() => onUseOnly(only ? null : segment.id)}
                              aria-label={only ? "Clear use-only filter" : `Use only ${segment.name}`}
                            >
                              <IconFocus2 size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </>
                      )}
                      <Tooltip label="Edit segment">
                        <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => openEditor(segment)} aria-label={`Edit ${segment.name}`}>
                          <IconEdit size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete segment">
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="red"
                          onClick={() =>
                            modals.openConfirmModal({
                              title: "Delete protocol segment?",
                              children: <Text size="sm">The definition and its saved-plot references will be removed.</Text>,
                              labels: { confirm: "Delete", cancel: "Cancel" },
                              confirmProps: { color: "red" },
                              onConfirm: () => onDeleteSegment(segment.id),
                            })
                          }
                          aria-label={`Delete ${segment.name}`}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Group>
                </Box>
              );
            })}
          </Stack>
        )}
      </Paper>

      {draft && (
        <SegmentEditor
          key={`${draft.id ?? "new"}-${draft.targets.map((target) => target.protocol_signature).join("|")}`}
          draft={draft}
          families={editorFamilies}
          segments={segments}
          loading={loading}
          hasErrors={hasErrors}
          onClose={() => setDraft(null)}
          onDelete={onDeleteSegment}
          onSave={onSaveSegment}
          suggestions={suggestions}
          suggestionsLoading={suggestionsLoading}
          suggestionsError={suggestionsError}
          showSuggestions={showSuggestions}
          validateSegment={validateSegment}
        />
      )}
    </>
  );
}
