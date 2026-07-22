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
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

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
  onToggleSteps,
}: {
  group: ProtocolGroup;
  selectedSet: Set<number>;
  byNumber: Map<number, ProtocolStep>;
  family: ProtocolFamily;
  visibleSteps: Set<number> | null;
  onToggleSteps: (steps: number[], checked: boolean) => void;
}) {
  const [open, setOpen] = useState(group.depth === 0);
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
        borderLeft: group.depth > 0 ? "2px solid var(--mantine-color-gray-3)" : undefined,
        paddingLeft: group.depth > 0 ? 10 : 0,
        marginLeft: group.depth > 0 ? 4 : 0,
      }}
    >
      <Group gap={6} wrap="nowrap" align="center">
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
            <Text size="xs" fw={isBlock ? 700 : 500} truncate>
              {group.summary}
            </Text>
            {isBlock && (
              <Badge size="xs" variant="light" style={{ flexShrink: 0 }}>
                x{group.repeat_count}
              </Badge>
            )}
            <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>
              {nSelected}/{owned.length}
            </Text>
          </Group>
        </Box>
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
          <Stack gap={4} pl="md">
            {group.children.map((child) => (
              <ProtocolGroupNode
                key={child.id}
                group={child}
                selectedSet={selectedSet}
                byNumber={byNumber}
                family={family}
                visibleSteps={visibleSteps}
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
          onClick={() =>
            onFilters([
              ...filters,
              { id: segmentId(), field: "rate", operator: ">=", value: "" },
            ])
          }
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
  loading,
  hasErrors,
  onClose,
  onSave,
}: {
  draft: SegmentDraft;
  families: ProtocolFamily[];
  loading: boolean;
  hasErrors: boolean;
  onClose: () => void;
  onSave: (segment: ProtocolSegment) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [targets, setTargets] = useState<ProtocolSegmentTarget[]>(draft.targets);
  const [ranges, setRanges] = useState<Record<string, RangeDraft>>({});
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<StepFilter[]>([]);
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

  const save = () => {
    if (!name.trim() || count === 0) return;
    onSave({
      id: draft.id ?? segmentId(),
      name: name.trim(),
      targets: targets.map((target) => ({
        ...target,
        step_indices: uniqueSorted(target.step_indices),
      })),
    });
  };

  return (
    <Modal opened onClose={onClose} title={draft.id ? "Edit protocol segment" : "Create protocol segment"} size="xl" centered>
      <Stack gap="sm">
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
              {targets.length} selected {targets.length === 1 ? "family" : "families"}
            </Text>
          </Box>
        </Group>

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
        {loading && (
          <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">Loading cell protocols...</Text></Group>
        )}

        <ScrollArea h="min(58vh, 620px)" type="auto" offsetScrollbars>
          <Stack gap="md" pr="xs">
            {!loading && families.length === 0 && (
              <Alert color="gray">Add cells or replicates with protocol data before creating a segment.</Alert>
            )}
            {families.map((family, familyIndex) => {
              const selected = selectedSteps(targets, family.signature);
              const selectedSet = new Set(selected);
              const groups = familyGroups(family);
              const allSteps = uniqueSorted(groupSteps(groups));
              const range = ranges[family.signature] ?? {
                from: allSteps[0] ?? null,
                to: allSteps[allSteps.length - 1] ?? null,
              };
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
              const cellNames = [...new Set(family.files.map((file) => file.cellName))];
              return (
                <Box key={family.signature}>
                  {familyIndex > 0 && <Divider mb="md" />}
                  <Group justify="space-between" align="start" wrap="nowrap">
                    <Box style={{ minWidth: 0 }}>
                      <Group gap="xs">
                        <Text size="sm" fw={700}>Protocol family {familyIndex + 1}</Text>
                        <Badge size="xs" variant="light">{selected.length}/{allSteps.length} steps</Badge>
                      </Group>
                      <Tooltip label={family.signature}>
                        <Text size="xs" c="dimmed" ff="monospace">{shortSignature(family.signature)}</Text>
                      </Tooltip>
                      {family.files.length > 0 ? (
                        <>
                          <Text size="xs" mt={3}>{cellNames.join(", ")}</Text>
                          {family.files.map((file) => (
                            <Tooltip key={`${file.cellId}-${file.fileId}`} label={`${file.hash} - ${file.filename}`}>
                              <Text size="xs" c="dimmed" truncate>
                                {file.cellName}: {file.testName} / {file.filename}
                              </Text>
                            </Tooltip>
                          ))}
                        </>
                      ) : (
                        <Text size="xs" c="yellow.8">Not present in the current samples</Text>
                      )}
                    </Box>
                    <Group gap={6} wrap="nowrap">
                      {visibleSteps && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="teal"
                          disabled={visibleSteps.size === 0}
                          onClick={() =>
                            toggleSteps(family.signature, [...visibleSteps], true)
                          }
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
                        Clear family
                      </Button>
                    </Group>
                  </Group>

                  <Group mt="sm" gap="xs" align="end" wrap="nowrap">
                    <NumberInput
                      label="From"
                      value={range.from ?? ""}
                      onChange={(value) =>
                        setRanges((current) => ({
                          ...current,
                          [family.signature]: { ...range, from: typeof value === "number" ? value : null },
                        }))
                      }
                      allowDecimal={false}
                      min={allSteps[0]}
                      max={allSteps[allSteps.length - 1]}
                      size="xs"
                      w={92}
                    />
                    <NumberInput
                      label="To"
                      value={range.to ?? ""}
                      onChange={(value) =>
                        setRanges((current) => ({
                          ...current,
                          [family.signature]: { ...range, to: typeof value === "number" ? value : null },
                        }))
                      }
                      allowDecimal={false}
                      min={allSteps[0]}
                      max={allSteps[allSteps.length - 1]}
                      size="xs"
                      w={92}
                    />
                    <Button
                      size="compact-xs"
                      variant="default"
                      disabled={range.from === null || range.to === null}
                      onClick={() => {
                        if (range.from === null || range.to === null) return;
                        const low = Math.min(range.from, range.to);
                        const high = Math.max(range.from, range.to);
                        toggleSteps(family.signature, allSteps.filter((step) => step >= low && step <= high), true);
                      }}
                    >
                      Select inclusive range
                    </Button>
                  </Group>

                  <Stack gap={6} mt="sm">
                    {groups.map((group) => (
                      <ProtocolGroupNode
                        key={`${family.signature}-${group.id}`}
                        group={group}
                        selectedSet={selectedSet}
                        byNumber={byNumber}
                        family={family}
                        visibleSteps={visibleSteps}
                        onToggleSteps={(steps, checked) => toggleSteps(family.signature, steps, checked)}
                      />
                    ))}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </ScrollArea>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || count === 0} onClick={save}>
            {draft.id ? "Save changes" : "Create segment"}
          </Button>
        </Group>
      </Stack>
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
            <Text fw={700} size="sm">Protocol segments</Text>
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
          <Text size="xs" c="dimmed">No custom segments.</Text>
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
          loading={loading}
          hasErrors={hasErrors}
          onClose={() => setDraft(null)}
          onSave={(segment) => {
            onSaveSegment(segment);
            setDraft(null);
          }}
        />
      )}
    </>
  );
}
