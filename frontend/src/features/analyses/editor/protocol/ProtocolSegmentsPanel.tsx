import {
  Accordion,
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Popover,
  Radio,
  ScrollArea,
  SegmentedControl,
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
} from "../../../../api";
import {
  cRateExamples,
  FILTER_FIELDS,
  isEnumFilterField,
  operatorLabel,
  operatorsFor,
  protocolFilterValueOptions,
  type StepFilter,
  stepMatches,
} from "./protocolStepFilters";
import { normalizeGroup } from "./protocolGroupNormalization";
import {
  adjacentStepsAroundMatches,
  stepsInSameGroupsAsMatches,
  type NeighbourDirection,
  type NeighbourScope,
} from "./protocolStepNeighbours";
import { groupSuggestionsByFamily } from "./suggestionGrouping";

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
  /**
   * Show just the show/hide eye per segment without the calculation
   * exclude / use-only controls. The series tabs (DCIR) want segment
   * visibility but not the cycle-tab computation filters.
   */
  showVisibilityToggle?: boolean;
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
  // Provenance fields for grouping and auto-populating names
  protocolSignature?: string;
  pairLabel?: string;
  cellNames?: string[];
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
            <Text size="10px" ff="monospace" c="var(--mantine-primary-color-7)" truncate pl={12}>
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
            group.depth === 0 ? "var(--mantine-color-body)" : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
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
              <Badge size="xs" variant="light" color="var(--mantine-primary-color-6)" style={{ flexShrink: 0 }}>
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
                  <Text size="xs" fw={600} c="var(--mantine-primary-color-7)">
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
                            segment.id === editingId ? "var(--mantine-primary-color-4)" : undefined,
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
                                color="var(--mantine-primary-color-6)"
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
        <Paper withBorder radius="md" p={6} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
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
    <Paper p="xs" withBorder radius="md" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
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
  steps,
}: {
  query: string;
  onQuery: (value: string) => void;
  filters: StepFilter[];
  onFilters: (filters: StepFilter[]) => void;
  steps: ProtocolStep[];
}) {
  const update = (id: string, patch: Partial<StepFilter>) =>
    onFilters(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap" align="end">
        <TextInput
          size="xs"
          label="Filters"
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
        const valueOptions = protocolFilterValueOptions(steps, filter.field);
        const enumField = isEnumFilterField(filter.field);
        return (
          <Group key={filter.id} gap={6} wrap="nowrap" align="flex-end">
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
                  value: "",
                });
              }}
            />
            <Select
              size="xs"
              w={enumField ? 118 : 132}
              data={operatorsFor(filter.field).map((op) => ({
                value: op,
                label: operatorLabel(op),
              }))}
              value={filter.operator}
              onChange={(value) =>
                value && update(filter.id, { operator: value as StepFilter["operator"] })
              }
            />
            {enumField && filter.operator !== "contains" ? (
              <Select
                size="xs"
                placeholder={valueOptions.length === 0 ? "None in protocol" : "Choose value"}
                searchable
                nothingFoundMessage="No matching value"
                disabled={valueOptions.length === 0}
                data={valueOptions}
                value={filter.value || null}
                onChange={(value) => update(filter.id, { value: value ?? "" })}
                comboboxProps={{ withinPortal: true }}
                style={{ flex: 1 }}
              />
            ) : (
              <Autocomplete
                size="xs"
                placeholder={
                  enumField
                    ? "Type or choose value"
                    : field?.hint ?? "Type or choose value"
                }
                data={valueOptions}
                value={filter.value}
                onChange={(value) => update(filter.id, { value: value ?? "" })}
                comboboxProps={{ withinPortal: true }}
                style={{ flex: 1 }}
              />
            )}
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              mb={2}
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

function ShowNeighboursButton({
  disabled,
  matchSteps,
  allSteps,
  groups,
  onShow,
}: {
  disabled: boolean;
  matchSteps: Set<number>;
  allSteps: number[];
  groups: ProtocolGroup[];
  onShow: (steps: Set<number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(1);
  const [direction, setDirection] = useState<NeighbourDirection>("both");
  const [scope, setScope] = useState<NeighbourScope>("group");

  return (
    <Button.Group>
      <Button
        size="compact-xs"
        variant="light"
        color="var(--mantine-primary-color-6)"
        disabled={disabled}
        onClick={() => onShow(stepsInSameGroupsAsMatches(groups, matchSteps))}
      >
        Show neighbours
      </Button>
      <Popover
        withinPortal
        position="bottom-end"
        shadow="md"
        width={300}
        opened={open}
        onChange={setOpen}
      >
        <Popover.Target>
          <Button
            size="compact-xs"
            variant="light"
            color="var(--mantine-primary-color-6)"
            px={6}
            disabled={disabled}
            aria-label="Show neighbour options"
            onClick={() => setOpen((value) => !value)}
          >
            <IconChevronDown size={14} />
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="sm">
            <Text size="xs" fw={600}>
              Show steps that are
            </Text>
            <Group justify="space-between" wrap="nowrap" align="center">
              <Text size="xs">Adjacent steps</Text>
              <NumberInput
                size="xs"
                w={72}
                min={1}
                max={999}
                allowDecimal={false}
                value={count}
                onChange={(value) => setCount(typeof value === "number" && value >= 1 ? value : 1)}
              />
            </Group>
            <SegmentedControl
              size="xs"
              fullWidth
              value={direction}
              onChange={(value) => setDirection(value as NeighbourDirection)}
              data={[
                { label: "Before", value: "before" },
                { label: "After", value: "after" },
                { label: "Both", value: "both" },
              ]}
            />
            <SegmentedControl
              size="xs"
              fullWidth
              value={scope}
              onChange={(value) => setScope(value as NeighbourScope)}
              data={[
                { label: "Within the same group", value: "group" },
                { label: "All", value: "all" },
              ]}
            />
            <Group justify="flex-end">
              <Button
                size="compact-xs"
                variant="light"
                color="var(--mantine-primary-color-6)"
                onClick={() => {
                  onShow(
                    adjacentStepsAroundMatches(
                      allSteps,
                      groups,
                      matchSteps,
                      count,
                      direction,
                      scope
                    )
                  );
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </Group>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Button.Group>
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
  const [shownNeighbours, setShownNeighbours] = useState<Set<number> | null>(null);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [lastAutoGeneratedName, setLastAutoGeneratedName] = useState<string | null>(null);
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
  useEffect(() => {
    setShownNeighbours(null);
  }, [query, filters, activeSignature]);
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

  // Rendering the nested step tree is the expensive part of this modal. Keeping
  // it out of the name field's render path is what makes typing the segment
  // name fast: the memo excludes `name`, so a keystroke no longer rebuilds every
  // ProtocolGroupNode. It still recomputes when the actual inputs (active
  // family, selection, filters, expand state) change.
  const treeContent = useMemo(() => {
    if (loading || !activeFamily) return null;
    const family = activeFamily;
    const selected = selectedSteps(targets, family.signature);
    const selectedSet = new Set(selected);
    const groups = familyGroups(family);
    const allSteps = uniqueSorted(groupSteps(groups));
    const byNumber = new Map(family.protocol?.steps.map((step) => [step.number, step]) ?? []);
    // Null means "not filtering", which keeps steps that carry no protocol
    // detail visible instead of silently dropping them.
    const filtering = Boolean(query.trim() || filters.some((f) => f.value.trim()));
    const visibleSteps = filtering
      ? new Set(
          allSteps.filter((n) => {
            const step = byNumber.get(n);
            return step ? stepMatches(step, filters, query) : false;
          })
        )
      : null;
    const displaySteps =
      filtering && visibleSteps && shownNeighbours
        ? new Set([...visibleSteps, ...shownNeighbours])
        : visibleSteps;
    return (
      <Box>
        <Group justify="space-between" wrap="nowrap" mb={6}>
          <Group gap="xs" wrap="nowrap">
            <Badge size="sm" variant="light" color="var(--mantine-primary-color-6)">
              {selected.length}/{allSteps.length} steps
            </Badge>
            {visibleSteps && (
              <Text size="xs" c="dimmed">
                {visibleSteps.size} match the filters
                {displaySteps && displaySteps.size > visibleSteps.size
                  ? ` · ${displaySteps.size} shown`
                  : ""}
              </Text>
            )}
          </Group>
          <Group gap={6} wrap="nowrap">
            {visibleSteps && (
              <>
                <Button
                  size="compact-xs"
                  variant="light"
                  color="var(--mantine-primary-color-6)"
                  disabled={visibleSteps.size === 0}
                  onClick={() => toggleSteps(family.signature, [...visibleSteps], true)}
                >
                  Select {visibleSteps.size} matching
                </Button>
                <ShowNeighboursButton
                  disabled={visibleSteps.size === 0}
                  matchSteps={visibleSteps}
                  allSteps={allSteps}
                  groups={groups}
                  onShow={setShownNeighbours}
                />
              </>
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
              visibleSteps={displaySteps}
              defaultOpen={expandAll ?? group.depth === 0}
              onToggleSteps={(steps, checked) => toggleSteps(family.signature, steps, checked)}
            />
          ))}
        </Stack>
      </Box>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeFamily, targets, filters, query, expandEpoch, expandAll, shownNeighbours]);

  return (
    <Modal
      opened
      onClose={onClose}
      title={draft.id ? "Edit protocol segment" : "Create protocol segment"}
      // Wide enough that the segment list is an extra panel rather than a
      // slice taken out of the step table.
      size="min(1240px, calc(100vw - 3rem))"
      centered
      styles={{
        content: {
          maxHeight: "calc(100dvh - 2rem)",
          display: "flex",
          flexDirection: "column",
        },
        body: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        },
      }}
    >
      <Group
        align="stretch"
        gap="sm"
        wrap="nowrap"
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
      <Stack
        gap="sm"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          // Keep segment controls, filters, and protocol picker visible while
          // the step list scrolls inside the modal or its ScrollArea.
          style={{
            position: "sticky",
            top: 0,
            zIndex: 3,
            background: "var(--mantine-color-body)",
            paddingBottom: 8,
            flexShrink: 0,
          }}
        >
        <Stack gap="sm">
        <Group align="end" wrap="nowrap">
          <TextInput
            label="Segment name"
            placeholder="Formation, RPT, rate block..."
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            style={{ flex: 1 }}
            autoFocus
            // When steps are picked but the name is still blank, point the user
            // at the one field that keeps the Add button disabled.
            error={count > 0 && !name.trim() ? "Name this segment to add it" : undefined}
          />
          <Box pb={count > 0 && !name.trim() ? 27 : 7} style={{ flexShrink: 0 }}>
            <Text size="xs" fw={700}>{count} selected steps</Text>
            <Text size="xs" c="dimmed">
              {targets.length} selected {targets.length === 1 ? "protocol" : "protocols"}
            </Text>
          </Box>
          <Group gap={8} pb={count > 0 && !name.trim() ? 24 : 4} wrap="nowrap" style={{ flexShrink: 0 }}>
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
          <Paper p="xs" withBorder bg="light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))">
            <Group align="end" wrap="nowrap">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Group gap={6} mb={4}>
                  <IconSparkles size={15} color="var(--mantine-primary-color-6)" />
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
                  data={groupSuggestionsByFamily(
                    suggestions.map((suggestion) => ({
                      id: suggestion.id,
                      label: suggestion.label,
                      protocolNumber: suggestion.protocolSignature
                        ? protocolNumber(families, suggestion.protocolSignature)
                        : null,
                      signature: suggestion.protocolSignature ?? "",
                      cellNames: suggestion.cellNames ?? [],
                    }))
                  )}
                  value={suggestionId}
                  onChange={(value) => {
                    if (!value) {
                      setSuggestionId(null);
                      return;
                    }
                    setSuggestionId(value);
                    const selected = suggestions.find((s) => s.id === value);
                    if (!selected) return;

                    // Auto-apply the suggestion: set targets and active signature
                    setTargets(
                      selected.segment.targets.map((target) => ({
                        ...target,
                        step_indices: [...target.step_indices],
                      }))
                    );
                    setActiveSignature(
                      selected.segment.targets[0]?.protocol_signature ?? null
                    );

                    // Auto-populate name only if it's empty or matches a previous auto-generated name
                    if (
                      !name.trim() ||
                      name === lastAutoGeneratedName
                    ) {
                      const firstCellName = selected.cellNames?.[0] ?? "Unknown cell";
                      const protocolNum = selected.protocolSignature
                        ? protocolNumber(families, selected.protocolSignature)
                        : null;
                      const pairLabel = selected.pairLabel ?? selected.label;
                      const autoName = `${firstCellName} · Protocol ${protocolNum} · ${pairLabel}`;
                      setName(autoName);
                      setLastAutoGeneratedName(autoName);
                    }

                    setValidationError(null);
                  }}
                />
              </Box>
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

        <Group align="flex-start" wrap="nowrap" gap="sm">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <StepFilterBar
              query={query}
              onQuery={setQuery}
              filters={filters}
              onFilters={setFilters}
              steps={activeFamily?.protocol?.steps ?? []}
            />
          </Box>
          {!loading && families.length > 0 && (
            <>
              <Divider orientation="vertical" style={{ alignSelf: "stretch" }} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <ProtocolPicker
                  families={families}
                  activeSignature={activeFamily?.signature ?? null}
                  onSelect={setActiveSignature}
                  targets={targets}
                />
              </Box>
            </>
          )}
        </Group>

        {hasErrors && (
          <Alert color="yellow">Some cell protocols could not be loaded. Available families are still selectable.</Alert>
        )}
        {validationError && <Alert color="red">{validationError}</Alert>}
        {loading && (
          <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">Loading cell protocols...</Text></Group>
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
        </Stack>
        </Box>

        <ScrollArea
          type="auto"
          offsetScrollbars
          style={{ flex: 1, minHeight: 0 }}
        >
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
            {treeContent}
          </Stack>
        </ScrollArea>
      </Stack>
      <Divider orientation="vertical" style={{ alignSelf: "stretch" }} />
      <Box
        style={{
          width: 268,
          flexShrink: 0,
          minHeight: 0,
          alignSelf: "stretch",
          display: "flex",
          flexDirection: "column",
        }}
      >
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
  showVisibilityToggle = false,
  showSuggestions = false,
  suggestions = [],
  suggestionsLoading = false,
  suggestionsError = false,
  validateSegment,
}: ProtocolSegmentsPanelProps) {
  const [draft, setDraft] = useState<SegmentDraft | null>(null);
  const [collapsed, setCollapsed] = useState(false);
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
        <Group justify="space-between" mb={collapsed ? 0 : "xs"} wrap="nowrap">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
            </ActionIcon>
            <Box style={{ minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <Text fw={700} size="sm" truncate>{title}</Text>
                {segments.length > 0 && (
                  <Badge size="xs" variant="light" color="gray">
                    {segments.length}
                  </Badge>
                )}
              </Group>
              {subtitle && <Text size="xs" c="dimmed">{subtitle}</Text>}
              {onlySegmentIds.length > 0 && <Text size="xs" c="var(--mantine-primary-color-6)">Use-only filter active</Text>}
            </Box>
          </Group>
          <Tooltip label={cellIds.length === 0 ? "Add analysis samples first" : "Create protocol segment"}>
            <span>
              <ActionIcon size="sm" variant="light" disabled={cellIds.length === 0} onClick={() => openEditor()} aria-label="Create protocol segment">
                <IconPlus size={14} />
              </ActionIcon>
            </span>
          </Tooltip>
        </Group>

        <Collapse in={!collapsed}>
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
                      {segment.targets.length > 0 && (
                        <Text size="10px" c="dimmed">
                          {segment.targets.map((target, idx) => {
                            const num = protocolNumber(loadedFamilies, target.protocol_signature);
                            const family = loadedFamilies.find((f) => f.signature === target.protocol_signature);
                            const cellNames = [...new Set(family?.files.map((f) => f.cellName) ?? [])];
                            const cellLabel = cellNames.length === 0 ? "no cells" : cellNames.length === 1 ? cellNames[0] : `${cellNames[0]} +${cellNames.length - 1} more`;
                            return (
                              <div key={idx}>
                                Protocol {num} · {cellLabel}
                              </div>
                            );
                          })}
                        </Text>
                      )}
                    </Box>
                    <Group gap={1} wrap="nowrap">
                      {(showPlotControls || showVisibilityToggle) && (
                        <Tooltip label={excluded ? "Excluded segments are not plotted" : filteredByOnly ? "Another segment is used exclusively" : hidden ? "Show in plot" : "Hide from plot"}>
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color={effectivelyHidden ? "gray" : "var(--mantine-primary-color-6)"}
                            disabled={excluded || filteredByOnly}
                            onClick={() => onToggleHidden(segment.id)}
                            aria-label={hidden ? `Show ${segment.name}` : `Hide ${segment.name}`}
                          >
                            {effectivelyHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                      {showPlotControls && (
                        <>
                          <Tooltip label={excluded ? "Include in calculations" : "Exclude from calculations and plot"}>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color={excluded ? "red" : "var(--mantine-primary-color-6)"}
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
                              color="var(--mantine-primary-color-6)"
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
        </Collapse>
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
