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
  Grid,
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
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQueries } from "@tanstack/react-query";
import {
  IconCalculator,
  IconCalculatorOff,
  IconCheck,
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
  IconSettings,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  CellProtocol,
  FileProtocol,
  ProtocolFamilyGroup,
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
  compareProtocolFamilies,
  comparableProtocolStepNumbers,
  comparisonDimensionsFor,
  mapComparableProtocolStepNumbers,
  WORKFLOW_COMPARISON_DIMENSIONS,
  type ProtocolComparisonDimensions,
  type ProtocolComparisonMode,
  type ProtocolComparisonOptions,
  type ProtocolComparisonStatus,
} from "./protocolComparability";
import {
  adjacentStepsAroundMatches,
  stepsInSameGroupsAsMatches,
  type NeighbourDirection,
  type NeighbourScope,
} from "./protocolStepNeighbours";
import {
  mergeProtocolGroups,
  normalizeProtocolGroups,
  protocolGroupForDefinition,
  protocolGroupForProvenance,
  type ProtocolGroupDefinition,
} from "./protocolGroupPolicy";

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
  legacySignatures: string[];
  protocol: FileProtocol | null;
  files: ProtocolFileRef[];
  unavailableSteps?: number[];
}

interface SegmentDraft {
  id: string | null;
  name: string;
  targets: ProtocolSegmentTarget[];
  protocolGroupId: string | null;
}

interface RangeDraft {
  from: number | null;
  to: number | null;
}

export interface ProtocolSegmentsPanelProps {
  cellIds: number[];
  segments: ProtocolSegment[];
  protocolGroups?: ProtocolFamilyGroup[];
  onSaveProtocolGroups?: (groups: ProtocolFamilyGroup[]) => void;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function familyMatchesSignature(family: ProtocolFamily, signature: string): boolean {
  return family.signature === signature || family.legacySignatures.includes(signature);
}

function selectedSteps(
  targets: ProtocolSegmentTarget[],
  signature: string,
  family?: ProtocolFamily,
): number[] {
  const matches = targets.filter((target) =>
    family ? familyMatchesSignature(family, target.protocol_signature) : target.protocol_signature === signature
  );
  return uniqueSorted(matches.flatMap((target) => target.step_indices));
}

function replaceTarget(
  targets: ProtocolSegmentTarget[],
  family: ProtocolFamily,
  steps: number[]
): ProtocolSegmentTarget[] {
  const next = targets.filter((target) => !familyMatchesSignature(family, target.protocol_signature));
  const normalized = uniqueSorted(steps);
  if (normalized.length > 0) {
    next.push({ protocol_signature: family.signature, step_indices: normalized });
  }
  return next.sort((a, b) => a.protocol_signature.localeCompare(b.protocol_signature));
}

function protocolGroupMembers(
  group: ProtocolFamilyGroup,
  families: ProtocolFamily[],
): ProtocolFamily[] {
  const signatures = new Set(group.family_signatures);
  return families.filter(
    (family) =>
      signatures.has(family.signature) ||
      family.legacySignatures.some((signature) => signatures.has(signature)),
  );
}

function isSelectableProtocolGroup(group: ProtocolFamilyGroup): boolean {
  // Grouped selections are mapped by executable workflow order. A comparison
  // that ignored structure may be useful as evidence, but it is not safe to
  // expose as a selectable target because its source step indices are not
  // interchangeable.
  return group.comparison_dimensions.structure;
}

function protocolGroupReference(
  group: ProtocolFamilyGroup,
  families: ProtocolFamily[],
): ProtocolFamily | null {
  return (
    families.find((family) => familyMatchesSignature(family, group.reference_signature)) ??
    protocolGroupMembers(group, families)[0] ??
    null
  );
}

function selectedStepsForGroup(
  targets: ProtocolSegmentTarget[],
  group: ProtocolFamilyGroup,
  families: ProtocolFamily[],
): number[] {
  const reference = protocolGroupReference(group, families);
  return reference ? selectedSteps(targets, reference.signature, reference) : [];
}

function replaceGroupTargets(
  targets: ProtocolSegmentTarget[],
  group: ProtocolFamilyGroup,
  families: ProtocolFamily[],
  referenceSteps: number[],
): ProtocolSegmentTarget[] {
  if (!isSelectableProtocolGroup(group)) return targets;
  const reference = protocolGroupReference(group, families);
  if (!reference?.protocol) return targets;
  let next = targets;
  const options: ProtocolComparisonOptions = {
    ignoreEmptyRestPause: group.ignore_empty_rest_pause,
  };
  const comparableReferenceSteps = new Set(comparableProtocolStepNumbers(reference.protocol, options));
  const normalizedReferenceSteps = referenceSteps.filter((step) => comparableReferenceSteps.has(step));
  for (const family of protocolGroupMembers(group, families)) {
    if (!family.protocol) continue;
    const mapped =
      family.signature === reference.signature
        ? normalizedReferenceSteps
        : mapComparableProtocolStepNumbers(
            reference.protocol,
            family.protocol,
            normalizedReferenceSteps,
            options,
          );
    next = replaceTarget(next, family, mapped);
  }
  return next;
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
  const index = families.findIndex((family) => familyMatchesSignature(family, signature));
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
function segmentTargetFamilies(
  segment: ProtocolSegment,
  families: ProtocolFamily[],
): ProtocolFamily[] {
  const seen = new Set<string>();
  const result: ProtocolFamily[] = [];
  for (const target of segment.targets) {
    const family = families.find((item) => familyMatchesSignature(item, target.protocol_signature));
    if (!family || seen.has(family.signature)) continue;
    seen.add(family.signature);
    result.push(family);
  }
  return result;
}

function segmentTargetGroup(
  segment: ProtocolSegment,
  families: ProtocolFamily[],
  protocolGroups: ProtocolFamilyGroup[],
): ProtocolFamilyGroup | null {
  const targetSignatures = new Set(segmentTargetFamilies(segment, families).map((family) => family.signature));
  if (targetSignatures.size === 0) return null;
  const group = protocolGroupForProvenance(
    protocolGroups,
    segment.protocol_group_id,
    [...targetSignatures],
  );
  if (!group || !isSelectableProtocolGroup(group)) return null;
  const members = protocolGroupMembers(group, families);
  return members.length === targetSignatures.size && members.every((family) => targetSignatures.has(family.signature))
    ? group
    : null;
}

function segmentTargetLabel(
  segment: ProtocolSegment,
  families: ProtocolFamily[],
  protocolGroups: ProtocolFamilyGroup[],
): string {
  const targetFamilies = segmentTargetFamilies(segment, families);
  const group = segmentTargetGroup(segment, families, protocolGroups);
  if (group) return `${group.name} - ${targetFamilies.length} families`;
  if (targetFamilies.length > 1) {
    return `Grouped selection - ${targetFamilies.length} families`;
  }
  const labels = segment.targets.map((target) => {
    const family = families.find((item) => familyMatchesSignature(item, target.protocol_signature));
    return family
      ? `Protocol ${protocolNumber(families, family.signature) ?? "-"}`
      : shortSignature(target.protocol_signature);
  });
  return [...new Set(labels)].join(", ") || "No protocol targets";
}

function SegmentSidePanel({
  segments,
  families,
  protocolGroups,
  editingId,
  onEdit,
  onDelete,
  onRename,
}: {
  segments: ProtocolSegment[];
  families: ProtocolFamily[];
  protocolGroups: ProtocolFamilyGroup[];
  editingId: string | null;
  onEdit: (segment: ProtocolSegment) => void;
  onDelete: (segmentId: string) => void;
  onRename: (segment: ProtocolSegment, name: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const byProtocol = new Map<string, ProtocolSegment[]>();
  for (const segment of segments) {
    // A grouped segment has several source-local targets, but it is one saved
    // segment. Use one stable target key so the side panel does not render one
    // visual card per source family.
    const firstTarget = segment.targets[0];
    const family = firstTarget
      ? families.find((item) => familyMatchesSignature(item, firstTarget.protocol_signature))
      : undefined;
    const signature = family?.signature ?? firstTarget?.protocol_signature ?? `segment:${segment.id}`;
    const list = byProtocol.get(signature) ?? [];
    if (!list.some((item) => item.id === segment.id)) list.push(segment);
    byProtocol.set(signature, list);
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
                                {segmentTargetLabel(segment, families, protocolGroups)} - {steps} step{steps === 1 ? "" : "s"}
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

function ComparisonStatusBadge({ status }: { status: ProtocolComparisonStatus }) {
  const color = status === "same" ? "teal" : status === "different" ? "orange" : "gray";
  const label = status === "same" ? "Same" : status === "different" ? "Different" : "Ignored";
  return (
    <Badge size="xs" variant="light" color={color}>
      {label}
    </Badge>
  );
}

const COMPARISON_MODE_OPTIONS = [
  { value: "strict", label: "Strict" },
  { value: "workflow", label: "Workflow" },
  { value: "custom", label: "Custom" },
];

const COMPARISON_MODE_HELP: Record<ProtocolComparisonMode, string> = {
  strict: "All supported protocol identity fields must match, including voltage cutoffs and protection limits.",
  workflow: "Compare the ordered building blocks, loops, rates, and timing. Termination conditions, voltage, and recording settings remain visible but are ignored.",
  custom: "Choose which dimensions matter for this review. Excluded rows remain visible as ignored evidence.",
};

const CUSTOM_DIMENSION_OPTIONS: {
  key: keyof ProtocolComparisonDimensions;
  label: string;
}[] = [
  { key: "structure", label: "Step flow and loops" },
  { key: "termination", label: "Termination and control conditions" },
  { key: "rates", label: "C-rates and pulse schedule" },
  { key: "timing", label: "Rest and hold timing" },
  { key: "voltage", label: "Voltage cutoffs and protection" },
  { key: "recording", label: "Recording settings" },
];

function protocolFamilyLabel(families: ProtocolFamily[], family: ProtocolFamily): string {
  const number = protocolNumber(families, family.signature) ?? "—";
  const cells = [...new Set(family.files.map((file) => file.cellName))];
  const steps = family.protocol?.n_executable_steps ?? family.unavailableSteps?.length ?? 0;
  const where = cells.length === 0 ? "not in samples" : `${cells.length} cell${cells.length === 1 ? "" : "s"}`;
  return `Protocol ${number} — ${steps} steps, ${where}`;
}

interface GroupedProtocolProposal {
  key: string;
  members: ProtocolFamily[];
  reference: ProtocolFamily;
}

function groupedFamilyCellNames(family: ProtocolFamily): string[] {
  return uniqueStrings(family.files.map((file) => file.cellName));
}

function groupedCellNames(group: GroupedProtocolProposal): string[] {
  return uniqueStrings(group.members.flatMap(groupedFamilyCellNames));
}

function shortCellName(name: string): string {
  return name.length > 11 ? `${name.slice(0, 7)}...${name.slice(-2)}` : name;
}

function groupedProposalKey(families: ProtocolFamily[]): string {
  return families.map((family) => family.signature).sort().join("|");
}

function groupedProtocolProposals(
  families: ProtocolFamily[],
  mode: ProtocolComparisonMode,
  dimensions: ProtocolComparisonDimensions,
  options: ProtocolComparisonOptions,
  referenceSignature: string | null,
): GroupedProtocolProposal[] {
  const groups: GroupedProtocolProposal[] = [];
  for (const family of families) {
    const match = family.protocol
      ? groups.find(
          (group) =>
            Boolean(group.reference.protocol) &&
            compareProtocolFamilies(
              group.reference.protocol!,
              family.protocol!,
              mode,
              dimensions,
              options,
            ).comparable,
        )
      : undefined;
    if (match) {
      match.members.push(family);
      match.key = groupedProposalKey(match.members);
    } else {
      groups.push({ key: groupedProposalKey([family]), members: [family], reference: family });
    }
  }
  return groups.map((group) => ({
    ...group,
    reference:
      group.members.find((family) => family.signature === referenceSignature) ?? group.reference,
  }));
}

function persistedGroupingForProposal(
  proposal: GroupedProtocolProposal,
  groups: ProtocolFamilyGroup[],
  mode: ProtocolComparisonMode,
  dimensions: ProtocolComparisonDimensions,
  options: ProtocolComparisonOptions,
): ProtocolFamilyGroup | undefined {
  const definition: ProtocolGroupDefinition = {
    family_signatures: proposal.members.map((family) => family.signature),
    reference_signature: proposal.reference.signature,
    comparison_mode: mode,
    comparison_dimensions: dimensions,
    ignore_empty_rest_pause: options.ignoreEmptyRestPause ?? false,
  };
  return protocolGroupForDefinition(
    groups,
    definition,
  );
}

function compactGroupingEvidence(value: string): string {
  const normalized = value.trim();
  return normalized.length > 76 ? `${normalized.slice(0, 73)}...` : normalized;
}

function groupingDifferenceText(row: {
  status: ProtocolComparisonStatus;
  reference: string;
  candidate: string;
}): string {
  if (row.status === "same") return "Same as reference";
  if (row.status === "ignored") return `Ignored - ${compactGroupingEvidence(row.candidate)}`;
  const referenceParts = row.reference.split(" | ");
  const candidateParts = row.candidate.split(" | ");
  const index = candidateParts.findIndex((part, partIndex) => part !== referenceParts[partIndex]);
  const selectedIndex = index < 0 ? 0 : index;
  const reference = referenceParts[selectedIndex] ?? row.reference;
  const candidate = candidateParts[selectedIndex] ?? row.candidate;
  return `${compactGroupingEvidence(reference)} -> ${compactGroupingEvidence(candidate)}`;
}

function groupedProtocolSummary(
  proposal: GroupedProtocolProposal,
  mode: ProtocolComparisonMode,
  customDimensions: ProtocolComparisonDimensions,
  options: ProtocolComparisonOptions,
): string {
  const dimensions = comparisonDimensionsFor(mode, customDimensions);
  const selectedLabels = CUSTOM_DIMENSION_OPTIONS
    .filter((option) => dimensions[option.key])
    .map((option) => option.label.toLowerCase());
  const ignoredLabels = new Set<string>();
  if (proposal.reference.protocol) {
    for (const member of proposal.members.slice(1)) {
      if (!member.protocol) continue;
      const result = compareProtocolFamilies(
        proposal.reference.protocol,
        member.protocol,
        mode,
        customDimensions,
        options,
      );
      for (const option of CUSTOM_DIMENSION_OPTIONS) {
        const row = result.rows.find((item) => item.key === option.key);
        if (!dimensions[option.key] && row && row.reference !== row.candidate) {
          ignoredLabels.add(option.label.toLowerCase());
        }
      }
    }
  }
  const selected = selectedLabels.length
    ? `Matches on ${selectedLabels.slice(0, 2).join(" and ")}${selectedLabels.length > 2 ? " ..." : ""}`
    : "No comparison dimensions selected";
  const ignored = [...ignoredLabels][0];
  const emptyNote = options.ignoreEmptyRestPause ? " - empty rest/pause steps ignored" : "";
  return `${selected}${emptyNote}${ignored ? ` - ${ignored} remain source-local` : ""}`;
}

function GroupedProtocolComparisonModal({
  opened,
  onClose,
  families,
  activeSignature,
  existingGroups,
  onApplyGroups,
}: {
  opened: boolean;
  onClose: () => void;
  families: ProtocolFamily[];
  activeSignature: string | null;
  existingGroups: ProtocolFamilyGroup[];
  onApplyGroups?: (groups: ProtocolFamilyGroup[]) => void;
}) {
  const [mode, setMode] = useState<ProtocolComparisonMode>("custom");
  const [referenceSignature, setReferenceSignature] = useState<string | null>(activeSignature);
  const [customDimensions, setCustomDimensions] = useState<ProtocolComparisonDimensions>({
    ...WORKFLOW_COMPARISON_DIMENSIONS,
    termination: true,
  });
  const [ignoreEmptyRestPause, setIgnoreEmptyRestPause] = useState(true);
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");

  useEffect(() => {
    if (!opened) return;
    setReferenceSignature(activeSignature ?? families[0]?.signature ?? null);
    setMode("custom");
    setCustomDimensions({ ...WORKFLOW_COMPARISON_DIMENSIONS, termination: true });
    setIgnoreEmptyRestPause(true);
    setGroupNames({});
    setEditingGroupId(null);
    setEditingGroupName("");
  }, [opened, activeSignature, families]);

  const reference = families.find((family) => family.signature === referenceSignature) ?? families[0] ?? null;
  const comparedDimensions = comparisonDimensionsFor(mode, customDimensions);
  const hasSelectedDimension = Object.values(comparedDimensions).some(Boolean);
  const comparisonOptions: ProtocolComparisonOptions = {
    ignoreEmptyRestPause: mode !== "strict" && ignoreEmptyRestPause,
  };
  const proposals = useMemo(
    () => groupedProtocolProposals(
      families,
      mode,
      customDimensions,
      comparisonOptions,
      reference?.signature ?? null,
    ),
    [families, mode, customDimensions, comparisonOptions.ignoreEmptyRestPause, reference?.signature],
  );
  // A one-family proposal is the existing raw protocol, not a new grouping.
  // Do not create a second selectable object for it.
  const groupProposals = proposals.filter((proposal) => proposal.members.length > 1);
  const existingGroupingForProposal = (proposal: GroupedProtocolProposal) =>
    persistedGroupingForProposal(
      proposal,
      existingGroups,
      mode,
      comparedDimensions,
      comparisonOptions,
    );
  const duplicateGroupProposals = groupProposals.filter((proposal) =>
    existingGroupingForProposal(proposal),
  );
  const newGroupProposals = groupProposals.filter(
    (proposal) => !existingGroupingForProposal(proposal),
  );
  const candidates = families.filter((family) => family.signature !== reference?.signature);
  const candidateResults = candidates.map((family) => ({
    family,
    result:
      reference?.protocol && family.protocol
        ? compareProtocolFamilies(
            reference.protocol,
            family.protocol,
            mode,
            customDimensions,
            comparisonOptions,
          )
        : null,
  }));
  const allCells = uniqueStrings(families.flatMap(groupedFamilyCellNames));
  const canApply = Boolean(
    onApplyGroups &&
      families.length > 0 &&
      families.every((family) => family.protocol) &&
      hasSelectedDimension &&
      comparedDimensions.structure &&
      newGroupProposals.length > 0,
  );

  const nameFor = (proposal: GroupedProtocolProposal, index: number): string =>
    existingGroupingForProposal(proposal)?.name ??
    groupNames[proposal.key] ??
    `New protocol ${index + 1}`;

  const saveGroupRename = () => {
    const nextName = editingGroupName.trim();
    if (!editingGroupId || !nextName || !onApplyGroups) return;
    onApplyGroups(
      normalizeProtocolGroups(
        existingGroups.map((group) =>
          group.id === editingGroupId ? { ...group, name: nextName } : group,
        ),
      ),
    );
    setEditingGroupId(null);
    setEditingGroupName("");
  };

  const applyGroups = () => {
    if (!canApply || !onApplyGroups) return;
    const additions = newGroupProposals.map((proposal, index) => ({
      id: segmentId(),
      name: nameFor(proposal, index).trim() || `New protocol ${index + 1}`,
      family_signatures: proposal.members.map((family) => family.signature),
      reference_signature: proposal.reference.signature,
      comparison_mode: mode,
      comparison_dimensions: { ...comparedDimensions },
      ignore_empty_rest_pause: comparisonOptions.ignoreEmptyRestPause ?? false,
    }));
    onApplyGroups(mergeProtocolGroups(existingGroups, additions));
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Box>
          <Text fw={700} size="md">Compare and group protocol families</Text>
          <Text size="xs" c="dimmed" mt={2} fw={400}>
            Review the groups, name them, then make them available as protocol options.
          </Text>
        </Box>
      }
      size="min(1400px, calc(100vw - 2rem))"
      centered
      styles={{
        content: {
          maxHeight: "calc(100dvh - 2rem)",
          display: "flex",
          flexDirection: "column",
        },
        header: { alignItems: "flex-start" },
        title: { minWidth: 0, flex: 1 },
        body: { overflowY: "auto", minHeight: 0 },
      }}
    >
      <Stack gap="sm">
        <Grid gutter="md" align="stretch">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Paper
              withBorder
              radius="md"
              p="sm"
              h="100%"
              bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
            >
              <Stack gap="sm">
                <Box>
                  <Text size="xs" fw={700} mb={5}>Comparison basis</Text>
                  <SegmentedControl
                    fullWidth
                    size="xs"
                    data={COMPARISON_MODE_OPTIONS}
                    value={mode}
                    onChange={(value) => setMode(value as ProtocolComparisonMode)}
                  />
                  <Text size="xs" c="dimmed" mt={6}>{COMPARISON_MODE_HELP[mode]}</Text>
                </Box>
                <Select
                  size="xs"
                  label="Reference protocol"
                  data={families.map((family) => ({
                    value: family.signature,
                    label: protocolFamilyLabel(families, family),
                  }))}
                  value={reference?.signature ?? null}
                  onChange={(value) => value && setReferenceSignature(value)}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: true }}
                />
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    {newGroupProposals.length} new group{newGroupProposals.length === 1 ? "" : "s"}
                    {duplicateGroupProposals.length > 0
                      ? ` - ${duplicateGroupProposals.length} already applied`
                      : ""}
                    {` - ${allCells.length} cells`}
                  </Text>
                  <Badge size="xs" variant="light" color="var(--mantine-primary-color-6)">Preview</Badge>
                </Group>
                {mode === "custom" ? (
                  <Paper withBorder radius="md" p="xs" bg="var(--mantine-color-body)">
                    <Text size="xs" fw={700} mb={6}>Compare on these dimensions</Text>
                    <Stack gap={5}>
                      {CUSTOM_DIMENSION_OPTIONS.map((option) => (
                        <Checkbox
                          key={option.key}
                          size="xs"
                          label={option.label}
                          checked={customDimensions[option.key]}
                          onChange={(event) =>
                            setCustomDimensions((current) => ({
                              ...current,
                              [option.key]: event.currentTarget.checked,
                            }))
                          }
                        />
                      ))}
                      <Checkbox
                        size="xs"
                        label="Ignore empty rest/pause steps"
                        checked={ignoreEmptyRestPause}
                        onChange={(event) => setIgnoreEmptyRestPause(event.currentTarget.checked)}
                      />
                    </Stack>
                  </Paper>
                ) : (
                  <Checkbox
                    size="xs"
                    label="Ignore empty rest/pause steps"
                    checked={ignoreEmptyRestPause}
                    disabled={mode === "strict"}
                    onChange={(event) => setIgnoreEmptyRestPause(event.currentTarget.checked)}
                  />
                )}
                <Group gap="sm" wrap="wrap">
                  <Group gap={4} wrap="nowrap"><Badge size="xs" variant="light" color="teal">Same</Badge><Text size="10px" c="dimmed">matches</Text></Group>
                  <Group gap={4} wrap="nowrap"><Badge size="xs" variant="light" color="orange">Different</Badge><Text size="10px" c="dimmed">splits</Text></Group>
                  <Group gap={4} wrap="nowrap"><Badge size="xs" variant="light" color="gray">Ignored</Badge><Text size="10px" c="dimmed">evidence only</Text></Group>
                </Group>
                {existingGroups.length > 0 && onApplyGroups && (
                  <Box>
                    <Group justify="space-between" align="baseline" gap="xs" mb={6} wrap="nowrap">
                      <Text size="xs" fw={700}>Applied protocol groups</Text>
                      <Text size="xs" c="dimmed" ta="right">Rename or remove groups without changing source data.</Text>
                    </Group>
                    <Stack gap={4}>
                      {existingGroups.map((group) => (
                        <Paper key={group.id} withBorder radius="sm" p="xs">
                          {editingGroupId === group.id ? (
                            <Group gap={4} wrap="nowrap">
                              <TextInput
                                size="xs"
                                value={editingGroupName}
                                onChange={(event) => setEditingGroupName(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") saveGroupRename();
                                  if (event.key === "Escape") {
                                    setEditingGroupId(null);
                                    setEditingGroupName("");
                                  }
                                }}
                                aria-label={`Rename protocol group ${group.name}`}
                                autoFocus
                                style={{ flex: 1, minWidth: 0 }}
                              />
                              <Tooltip label="Save name" withArrow>
                                <ActionIcon
                                  size="sm"
                                  variant="subtle"
                                  color="teal"
                                  aria-label={`Save name for ${group.name}`}
                                  disabled={!editingGroupName.trim()}
                                  onClick={saveGroupRename}
                                >
                                  <IconCheck size={14} />
                                </ActionIcon>
                              </Tooltip>
                              <Tooltip label="Cancel rename" withArrow>
                                <ActionIcon
                                  size="sm"
                                  variant="subtle"
                                  color="gray"
                                  aria-label="Cancel rename"
                                  onClick={() => {
                                    setEditingGroupId(null);
                                    setEditingGroupName("");
                                  }}
                                >
                                  <IconX size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </Group>
                          ) : (
                            <Group justify="space-between" gap="xs" wrap="nowrap">
                              <Box style={{ minWidth: 0, flex: 1 }}>
                                <Text size="xs" fw={600} truncate title={group.name}>{group.name}</Text>
                                <Text size="10px" c="dimmed">
                                  {group.family_signatures.length} source families
                                </Text>
                              </Box>
                              <Group gap={2} wrap="nowrap">
                                <Tooltip label={`Rename ${group.name}`} withArrow>
                                  <ActionIcon
                                    size="sm"
                                    variant="subtle"
                                    color="gray"
                                    aria-label={`Rename protocol group ${group.name}`}
                                    onClick={() => {
                                      setEditingGroupId(group.id);
                                      setEditingGroupName(group.name);
                                    }}
                                  >
                                    <IconPencil size={14} />
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label={`Remove ${group.name}`} withArrow>
                                  <ActionIcon
                                    size="sm"
                                    variant="subtle"
                                    color="red"
                                    aria-label={`Remove protocol group ${group.name}`}
                                    onClick={() =>
                                      modals.openConfirmModal({
                                        title: `Remove ${group.name}?`,
                                        children: (
                                          <Text size="sm">
                                            This removes the named grouping from the protocol selector.
                                            Raw protocol families and existing segment definitions remain unchanged.
                                          </Text>
                                        ),
                                        labels: { confirm: "Remove group", cancel: "Cancel" },
                                        confirmProps: { color: "red" },
                                        onConfirm: () => {
                                          onApplyGroups(
                                            normalizeProtocolGroups(
                                              existingGroups.filter((item) => item.id !== group.id),
                                            ),
                                          );
                                          onClose();
                                        },
                                      })
                                    }
                                  >
                                    <IconTrash size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Group>
                          )}
                        </Paper>
                      ))}
                    </Stack>
                  </Box>
                )}
              </Stack>
            </Paper>
          </Grid.Col>

          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack gap="xs" h="100%">
              <Group justify="space-between" align="baseline" gap="xs" wrap="nowrap">
                <Text size="sm" fw={700}>Reference versus all existing protocols</Text>
                <Text size="xs" c="dimmed" ta="right">Scroll horizontally to inspect all families</Text>
              </Group>
              {families.length < 2 ? (
                <Paper withBorder p="md" radius="md" style={{ flex: 1 }}>
                  <Text size="sm" fw={600}>One protocol family available</Text>
                  <Text size="xs" c="dimmed" mt={4}>Select at least two protocol families in the analysis samples to compare and group them.</Text>
                </Paper>
              ) : !reference?.protocol ? (
                <Paper withBorder p="md" radius="md" style={{ flex: 1 }}>
                  <Text size="sm" fw={600}>Protocol details unavailable</Text>
                  <Text size="xs" c="dimmed" mt={4}>The selected reference family has no readable protocol details in the current sample set.</Text>
                </Paper>
              ) : (
                <ScrollArea type="auto" offsetScrollbars style={{ flex: 1 }}>
                  <Table withTableBorder highlightOnHover={false} miw={Math.max(780, 330 + candidates.length * 190)}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={150} style={{ position: "sticky", left: 0, zIndex: 4, background: "var(--mantine-color-body)" }}>Dimension</Table.Th>
                        <Table.Th w={205} style={{ background: "var(--mantine-primary-color-light)" }}>
                          <Text size="xs" fw={700}>Reference</Text>
                          <Text size="10px" c="dimmed" fw={400} lineClamp={2}>{protocolFamilyLabel(families, reference)}</Text>
                        </Table.Th>
                        {candidates.map((family) => (
                          <Table.Th key={family.signature} w={190}>
                            <Text size="xs" fw={700} lineClamp={1}>Protocol {protocolNumber(families, family.signature) ?? "-"}</Text>
                            <Text size="10px" c="dimmed" fw={400} lineClamp={2}>{protocolFamilyLabel(families, family)}</Text>
                          </Table.Th>
                        ))}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {CUSTOM_DIMENSION_OPTIONS.map((option) => (
                        <Table.Tr key={option.key}>
                          <Table.Td style={{ position: "sticky", left: 0, zIndex: 2, background: "var(--mantine-color-body)" }}>
                            <Text size="xs" fw={600}>{option.label}</Text>
                          </Table.Td>
                          <Table.Td style={{ background: "var(--mantine-primary-color-light)" }}>
                            <Text size="10px" c="dimmed">Baseline</Text>
                          </Table.Td>
                          {candidateResults.map(({ family, result }) => {
                            const row = result?.rows.find((item) => item.key === option.key);
                            return (
                              <Table.Td key={family.signature}>
                                {row ? (
                                  <Stack gap={3}>
                                    <ComparisonStatusBadge status={row.status} />
                                    <Text size="10px" c="dimmed" lineClamp={2} title={`${row.reference} -> ${row.candidate}`}>
                                      {groupingDifferenceText(row)}
                                    </Text>
                                  </Stack>
                                ) : <Text size="10px" c="dimmed">Unavailable</Text>}
                              </Table.Td>
                            );
                          })}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              )}
            </Stack>
          </Grid.Col>
        </Grid>

        <Box>
          <Group justify="space-between" align="baseline" gap="xs" mb={6} wrap="nowrap">
            <Text size="sm" fw={700}>Proposed protocol groups</Text>
            <Text size="xs" c="dimmed" ta="right">Name groups and review included protocols and cells. These become selectable after creation.</Text>
          </Group>
          {!hasSelectedDimension ? (
            <Paper withBorder p="sm" radius="md"><Text size="xs" c="dimmed">Select at least one comparison dimension to propose meaningful protocol groups.</Text></Paper>
          ) : !comparedDimensions.structure ? (
            <Paper withBorder p="sm" radius="md"><Text size="xs" c="dimmed">Select Step flow and loops before creating groups. Grouped step selections are mapped by workflow order, so a structural match is required.</Text></Paper>
          ) : groupProposals.length === 0 ? (
            <Paper withBorder p="sm" radius="md">
              <Text size="xs" c="dimmed">
                No new grouping is available under these settings. Each family would remain a
                separate existing protocol, so nothing will be created.
              </Text>
            </Paper>
          ) : (
            <Grid gutter="sm">
              {groupProposals.map((proposal, index) => {
                const cells = groupedCellNames(proposal);
                const existing = existingGroupingForProposal(proposal);
                return (
                  <Grid.Col key={proposal.key} span={{ base: 12, sm: 6 }}>
                    <Paper
                      withBorder
                      radius="md"
                      p="sm"
                      style={{ borderTop: `3px solid var(--mantine-primary-color-${index % 2 === 0 ? "6" : "7"})` }}
                    >
                      <Stack gap={7}>
                        <Group gap="xs" wrap="nowrap">
                          <Text size="10px" c="dimmed" tt="uppercase" fw={700} style={{ flexShrink: 0 }}>Group {index + 1}</Text>
                          <TextInput
                            size="xs"
                            value={nameFor(proposal, index)}
                            readOnly={Boolean(existing)}
                            onChange={(event) => setGroupNames((current) => ({ ...current, [proposal.key]: event.currentTarget.value }))}
                            aria-label={`Name protocol group ${index + 1}`}
                            style={{ flex: 1, minWidth: 0 }}
                          />
                        </Group>
                        <Group justify="space-between" gap="xs" wrap="nowrap">
                          <Text size="10px" c="dimmed">{proposal.members.length} source families - {cells.length} cell{cells.length === 1 ? "" : "s"}</Text>
                          {existing && <Badge size="xs" variant="light" color="gray">Already applied</Badge>}
                        </Group>
                        {existing && (
                          <Text size="xs" c="orange">
                            This grouping already exists as “{existing.name}”. Rename it in Applied protocol groups.
                          </Text>
                        )}
                        <Box>
                          <Text size="10px" c="dimmed" mb={4}>Includes protocols</Text>
                          <Group gap={4} wrap="wrap">
                            {proposal.members.map((family) => <Badge key={family.signature} size="xs" variant="light" color="var(--mantine-primary-color-6)">Protocol {protocolNumber(families, family.signature) ?? "-"}</Badge>)}
                          </Group>
                        </Box>
                        <Box>
                          <Text size="10px" c="dimmed" mb={4}>Cells in this group</Text>
                          <Group gap={4} wrap="wrap">
                            {cells.map((cell) => (
                              <Tooltip key={cell} label={cell} withArrow>
                                <Badge size="xs" variant="default" style={{ maxWidth: 92 }}><Text size="10px" truncate>{shortCellName(cell)}</Text></Badge>
                              </Tooltip>
                            ))}
                          </Group>
                        </Box>
                        <Text size="10px" c="dimmed" lineClamp={2} title={groupedProtocolSummary(proposal, mode, customDimensions, comparisonOptions)}>
                          {groupedProtocolSummary(proposal, mode, customDimensions, comparisonOptions)}
                        </Text>
                      </Stack>
                    </Paper>
                  </Grid.Col>
                );
              })}
            </Grid>
          )}
        </Box>

        <Divider />
        <Group justify="space-between" align="center" gap="sm" wrap="wrap-reverse">
          <Text size="xs" c="dimmed">No source data changes until you create named groups.</Text>
          <Group gap="xs">
            <Button variant="default" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={applyGroups} disabled={!canApply}>
              {newGroupProposals.length > 0
                ? `Create ${newGroupProposals.length} protocol group${newGroupProposals.length === 1 ? "" : "s"}`
                : "No new groups to create"}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Choose which protocol to work on, and see which cells share it.
 *
 * Files are already grouped by semantic protocol signature, so cells running
 * the same programmed protocol collapse into one entry. Showing them all at
 * once made the list unreadable when an analysis holds several protocols;
 * picking one keeps the step table about a single program.
 */
function ProtocolPicker({
  families,
  protocolGroups,
  onApplyGroups,
  activeSignature,
  onSelect,
  targets,
}: {
  families: ProtocolFamily[];
  protocolGroups: ProtocolFamilyGroup[];
  onApplyGroups?: (groups: ProtocolFamilyGroup[]) => void;
  activeSignature: string | null;
  onSelect: (signature: string) => void;
  targets: ProtocolSegmentTarget[];
}) {
  const [showCells, setShowCells] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const activeGroup = protocolGroups.find(
    (group) => group.id === activeSignature && isSelectableProtocolGroup(group),
  ) ?? null;
  const active = families.find((f) => f.signature === activeSignature) ??
    (activeGroup ? protocolGroupReference(activeGroup, families) : null) ??
    families[0];
  const activeMembers = activeGroup ? protocolGroupMembers(activeGroup, families) : active ? [active] : [];
  const label = (family: ProtocolFamily) => {
    const cells = [...new Set(family.files.map((file) => file.cellName))];
    const steps = family.protocol?.n_executable_steps ?? 0;
    const chosen = selectedSteps(targets, family.signature, family).length;
    const where = cells.length === 0 ? "not in samples" : `${cells.length} cell${cells.length === 1 ? "" : "s"}`;
    const number = protocolNumber(families, family.signature) ?? "—";
    return `Protocol ${number} — ${steps} steps, ${where}${chosen ? ` · ${chosen} selected` : ""}`;
  };

  const groupLabel = (group: ProtocolFamilyGroup) => {
    const members = protocolGroupMembers(group, families);
    const cells = uniqueStrings(members.flatMap(groupedFamilyCellNames));
    const chosen = selectedStepsForGroup(targets, group, families).length;
    return `${group.name} - ${members.length} families, ${cells.length} cells${chosen ? ` - ${chosen} selected` : ""}`;
  };
  const selectorData = [
    ...protocolGroups
      .filter((group) => isSelectableProtocolGroup(group) && protocolGroupMembers(group, families).length > 0)
      .map((group) => ({ value: group.id, label: `Grouped - ${groupLabel(group)}` })),
    ...families.map((family) => ({ value: family.signature, label: label(family) })),
  ];

  return (
    <>
      <Stack gap={4}>
        <Group gap={8} wrap="nowrap" align="end">
          <Select
            size="xs"
            label="Protocol"
            style={{ flex: 1 }}
            data={selectorData}
            value={activeGroup?.id ?? active?.signature ?? null}
            onChange={(value) => value && onSelect(value)}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          <Tooltip label="Compare protocol families">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => setComparisonOpen(true)}
              aria-label="Compare protocol families"
            >
              <IconSettings size={15} />
            </ActionIcon>
          </Tooltip>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => setShowCells((value) => !value)}
            disabled={activeMembers.length === 0}
          >
            {showCells ? "Hide cells" : `Cells (${uniqueStrings(activeMembers.flatMap(groupedFamilyCellNames)).length})`}
          </Button>
        </Group>
        {showCells && activeMembers.length > 0 && (
          <Paper withBorder radius="md" p={6} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
            <Box className="cx-vertical-scroll" style={{ maxHeight: 96 }}>
              <Stack gap={2}>
                {activeMembers.flatMap((family) => family.files).map((file) => (
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
      <GroupedProtocolComparisonModal
        opened={comparisonOpen}
        onClose={() => setComparisonOpen(false)}
        families={families}
        activeSignature={active?.signature ?? activeSignature}
        existingGroups={protocolGroups}
        onApplyGroups={onApplyGroups}
      />
    </>
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
  protocolGroups,
  onSaveProtocolGroups,
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
  protocolGroups: ProtocolFamilyGroup[];
  onSaveProtocolGroups?: (groups: ProtocolFamilyGroup[]) => void;
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
  const [protocolGroupId, setProtocolGroupId] = useState<string | null>(draft.protocolGroupId);
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
  const [suggestionComparisonOpen, setSuggestionComparisonOpen] = useState(false);
  const [lastAutoGeneratedName, setLastAutoGeneratedName] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Pin the choice once, rather than falling back to families[0] on every
  // render. Protocol queries resolve one cell at a time and the list is kept
  // sorted by signature, so "the first family" is a different protocol at
  // 0.5s than at 2s. Steps selected before the list settled were being filed
  // against whichever protocol happened to sort first at that instant, which
  // then appeared under a different number once the rest arrived. If a named
  // group is removed, however, its selection is no longer valid and must fall
  // back to a raw family.
  useEffect(() => {
    const activeRawFamily = activeSignature !== null && families.some((family) =>
      familyMatchesSignature(family, activeSignature),
    );
    const activeGroup = activeSignature !== null && protocolGroups.some(
      (group) =>
        group.id === activeSignature &&
        isSelectableProtocolGroup(group) &&
        protocolGroupMembers(group, families).length > 0,
    );
    if (loading || families.length === 0 || activeRawFamily || activeGroup) return;
    setActiveSignature(families[0].signature);
  }, [loading, activeSignature, families, protocolGroups]);
  useEffect(() => {
    setShownNeighbours(null);
  }, [query, filters, activeSignature]);
  const activeGroup = protocolGroups.find(
    (group) => group.id === activeSignature && isSelectableProtocolGroup(group),
  ) ?? null;
  const activeFamily = families.find((f) => f.signature === activeSignature) ??
    (activeGroup ? protocolGroupReference(activeGroup, families) : null);
  const activeMembers = activeGroup ? protocolGroupMembers(activeGroup, families) : activeFamily ? [activeFamily] : [];
  const count = targetCount(targets);

  const setFamilySteps = (family: ProtocolFamily, steps: number[]) => {
    setProtocolGroupId(null);
    setTargets((current) => replaceTarget(current, family, steps));
  };

  const toggleSteps = (family: ProtocolFamily, steps: number[], checked: boolean) => {
    const current = new Set(selectedSteps(targets, family.signature, family));
    for (const step of steps) {
      if (checked) current.add(step);
      else current.delete(step);
    }
    setFamilySteps(family, [...current]);
  };

  const setActiveSelection = (steps: number[]) => {
    if (activeGroup) {
      setProtocolGroupId(activeGroup.id);
      setTargets((current) => replaceGroupTargets(current, activeGroup, families, steps));
    } else if (activeFamily) {
      setFamilySteps(activeFamily, steps);
    }
  };

  const toggleActiveSelection = (steps: number[], checked: boolean) => {
    const current = new Set(
      activeGroup
        ? selectedStepsForGroup(targets, activeGroup, families)
        : activeFamily
          ? selectedSteps(targets, activeFamily.signature, activeFamily)
          : [],
    );
    for (const step of steps) {
      if (checked) current.add(step);
      else current.delete(step);
    }
    setActiveSelection([...current]);
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
      protocol_group_id: protocolGroupId,
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
    setProtocolGroupId(null);
    setValidationError(null);
  };

  const editSegment = (segment: ProtocolSegment) => {
    setEditingId(segment.id);
    setName(segment.name);
    setTargets(segment.targets.map((target) => ({ ...target })));
    setProtocolGroupId(segment.protocol_group_id ?? null);
    setValidationError(null);
  };

  const selectedSuggestion = suggestions.find(
    (suggestion) => suggestion.id === suggestionId
  );
  const activeSuggestionSignatures = activeGroup
    ? new Set(protocolGroupMembers(activeGroup, families).map((family) => family.signature))
    : new Set(activeSignature ? [activeSignature] : []);
  const activeSuggestions = suggestions.filter(
    (suggestion) => Boolean(suggestion.protocolSignature && activeSuggestionSignatures.has(suggestion.protocolSignature)),
  );
  const applySuggestionTargets = (suggestion: ProtocolSegmentSuggestion) => {
    if (!activeGroup) {
      setProtocolGroupId(null);
      setTargets(
        suggestion.segment.targets.map((target) => ({
          ...target,
          step_indices: [...target.step_indices],
        })),
      );
      return;
    }
    const reference = protocolGroupReference(activeGroup, families);
    const source = suggestion.protocolSignature
      ? families.find((family) => familyMatchesSignature(family, suggestion.protocolSignature!))
      : null;
    const sourceTarget = source
      ? suggestion.segment.targets.find((target) => familyMatchesSignature(source, target.protocol_signature))
      : suggestion.segment.targets[0];
    if (!reference?.protocol || !source?.protocol || !sourceTarget) {
      setProtocolGroupId(null);
      setTargets(suggestion.segment.targets.map((target) => ({ ...target, step_indices: [...target.step_indices] })));
      return;
    }
    const options: ProtocolComparisonOptions = { ignoreEmptyRestPause: activeGroup.ignore_empty_rest_pause };
    const referenceSteps = source.signature === reference.signature
      ? sourceTarget.step_indices
      : mapComparableProtocolStepNumbers(source.protocol, reference.protocol, sourceTarget.step_indices, options);
    setProtocolGroupId(activeGroup.id);
    setTargets(replaceGroupTargets([], activeGroup, families, referenceSteps));
  };

  // Rendering the nested step tree is the expensive part of this modal. Keeping
  // it out of the name field's render path is what makes typing the segment
  // name fast: the memo excludes `name`, so a keystroke no longer rebuilds every
  // ProtocolGroupNode. It still recomputes when the actual inputs (active
  // family, selection, filters, expand state) change.
  const treeContent = useMemo(() => {
    if (loading || !activeFamily) return null;
    const family = activeFamily;
    const selected = activeGroup
      ? selectedStepsForGroup(targets, activeGroup, families)
      : selectedSteps(targets, family.signature, family);
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
                  onClick={() => toggleActiveSelection([...visibleSteps], true)}
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
              onClick={() => setActiveSelection([])}
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
                onToggleSteps={(steps, checked) => toggleActiveSelection(steps, checked)}
            />
          ))}
        </Stack>
      </Box>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeFamily, activeGroup, families, targets, filters, query, expandEpoch, expandAll, shownNeighbours]);

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
            <Stack gap={4}>
              <Group align="end" wrap="nowrap">
                <IconSparkles size={15} color="var(--mantine-primary-color-6)" style={{ flexShrink: 0 }} />
                <Text size="xs" fw={700}>Suggested DCIR pairs</Text>
              </Group>
              <Group align="end" wrap="nowrap" gap={8}>
                {/* Protocol selector and cells button */}
                <Select
                  size="xs"
                  label="Protocol"
                  style={{ width: 220, flexShrink: 0 }}
                  data={[
                    ...protocolGroups
                      .filter((group) => isSelectableProtocolGroup(group) && protocolGroupMembers(group, families).length > 0)
                      .map((group) => ({
                        value: group.id,
                        label: `Grouped - ${group.name} (${protocolGroupMembers(group, families).length} families)`,
                      })),
                    ...families.map((family) => ({
                      value: family.signature,
                      label: protocolFamilyLabel(families, family),
                    })),
                  ]}
                  value={activeGroup?.id ?? activeSignature}
                  onChange={(value) => {
                    if (value) {
                      setActiveSignature(value);
                      setSuggestionId(null);
                    }
                  }}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: true }}
                />
                <Tooltip label="Compare protocol families">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => setSuggestionComparisonOpen(true)}
                    aria-label="Compare protocol families"
                  >
                    <IconSettings size={15} />
                  </ActionIcon>
                </Tooltip>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() => {
                    // Toggle cell display logic would go here if needed
                  }}
                  disabled={activeMembers.length === 0}
                  style={{ flexShrink: 0 }}
                >
                  {activeMembers.length > 0 ? `Cells (${uniqueStrings(activeMembers.flatMap(groupedFamilyCellNames)).length})` : "Cells"}
                </Button>
                {/* Suggestions selector for active protocol only */}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    size="xs"
                    placeholder={
                      suggestionsLoading
                        ? "Looking for long-rest / short-pulse pairs..."
                        : "Choose a detected rest / pulse pair"
                    }
                    searchable
                    disabled={suggestionsLoading || !activeSignature}
                    data={
                      // Filter suggestions to active protocol and render flat (no grouping)
                      // since they're now single-protocol
                      activeSuggestions
                        .map((suggestion) => ({
                          value: suggestion.id,
                          label: suggestion.label,
                        }))
                    }
                    value={suggestionId}
                    onChange={(value) => {
                      if (!value) {
                        setSuggestionId(null);
                        return;
                      }
                      setSuggestionId(value);
                      const selected = suggestions.find((s) => s.id === value);
                      if (!selected) return;

                      // Auto-apply the suggestion, expanding it across an
                      // applied workflow group when one is active.
                      applySuggestionTargets(selected);

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
                        const protocolLabel = activeGroup?.name ??
                          `${firstCellName} - Protocol ${protocolNum ?? "-"}`;
                        const autoName = `${protocolLabel} - ${pairLabel}`;
                        setName(autoName);
                        setLastAutoGeneratedName(autoName);
                      }

                      setValidationError(null);
                    }}
                  />
                </Box>
              </Group>
              {suggestionsError && (
                <Text size="xs" c="red">
                  Automatic suggestions could not be loaded. You can still select the
                  rest and pulse steps manually below.
                </Text>
              )}
              {!suggestionsLoading &&
                !suggestionsError &&
                activeSignature &&
                activeSuggestions.length === 0 && (
                  <Text size="xs" c="dimmed">
                    No detected pairs for this protocol.
                  </Text>
                )}
              {selectedSuggestion?.description && (
                <Text size="xs" c="dimmed">
                  {selectedSuggestion.description}
                </Text>
              )}
            </Stack>
          </Paper>
        )}

        {showSuggestions && (
          <GroupedProtocolComparisonModal
            opened={suggestionComparisonOpen}
            onClose={() => setSuggestionComparisonOpen(false)}
            families={families}
            activeSignature={activeSignature}
            existingGroups={protocolGroups}
            onApplyGroups={onSaveProtocolGroups}
          />
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
          {!loading && families.length > 0 && !showSuggestions && (
            <>
              <Divider orientation="vertical" style={{ alignSelf: "stretch" }} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <ProtocolPicker
                  families={families}
                  protocolGroups={protocolGroups}
                  onApplyGroups={onSaveProtocolGroups}
                  activeSignature={activeSignature}
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
            protocolGroups={protocolGroups}
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
  protocolGroups = [],
  onSaveProtocolGroups,
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
            legacySignatures: file.protocol.legacy_signatures ?? [],
            protocol: file.protocol,
            files: [],
          };
          family.legacySignatures = uniqueStrings([
            ...family.legacySignatures,
            ...(file.protocol.legacy_signatures ?? []),
          ]);
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
    const known = (signature: string) =>
      loadedFamilies.some((family) => familyMatchesSignature(family, signature));
    const unavailable = draft.targets
      .filter((target) => !known(target.protocol_signature))
      .map((target): ProtocolFamily => ({
        signature: target.protocol_signature,
        legacySignatures: [],
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
      protocolGroupId: segment?.protocol_group_id ?? null,
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
                            const family = loadedFamilies.find((f) => familyMatchesSignature(f, target.protocol_signature));
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
          key={`${draft.id ?? "new"}-${draft.protocolGroupId ?? "none"}-${draft.targets.map((target) => target.protocol_signature).join("|")}`}
          draft={draft}
          families={editorFamilies}
          protocolGroups={protocolGroups}
          onSaveProtocolGroups={onSaveProtocolGroups}
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
