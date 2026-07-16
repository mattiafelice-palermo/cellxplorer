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
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import {
  CellProtocol,
  FileProtocol,
  get,
  ProtocolSegment,
  ProtocolSegmentTarget,
  ProtocolStep,
} from "../api";

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

function familyGroups(family: ProtocolFamily) {
  if (family.protocol?.groups.length) return family.protocol.groups;
  const stepNumbers = family.unavailableSteps ?? family.protocol?.steps.map((step) => step.number) ?? [];
  if (stepNumbers.length === 0) return [];
  return [
    {
      kind: "sequence" as const,
      label: family.protocol ? "Protocol steps" : "Unavailable protocol steps",
      start_step: stepNumbers[0],
      end_step: stepNumbers[stepNumbers.length - 1],
      repeat_count: 1,
      control_step: null,
      step_numbers: stepNumbers,
      summary: family.protocol
        ? `Steps ${stepNumbers[0]}-${stepNumbers[stepNumbers.length - 1]}`
        : "This protocol is not present in the current analysis samples.",
    },
  ];
}

function stepLabel(step: ProtocolStep | undefined, number: number): string {
  if (!step) return `Step ${number}`;
  return `Step ${number} - ${step.summary || step.type}`;
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
              const allSteps = uniqueSorted(groups.flatMap((group) => group.step_numbers));
              const range = ranges[family.signature] ?? {
                from: allSteps[0] ?? null,
                to: allSteps[allSteps.length - 1] ?? null,
              };
              const byNumber = new Map(family.protocol?.steps.map((step) => [step.number, step]) ?? []);
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

                  <Accordion multiple variant="contained" mt="sm">
                    {groups.map((group, groupIndex) => {
                      const groupSteps = group.step_numbers;
                      const nSelected = groupSteps.filter((step) => selectedSet.has(step)).length;
                      const allSelected = groupSteps.length > 0 && nSelected === groupSteps.length;
                      return (
                        <Accordion.Item key={`${family.signature}-${group.start_step}-${groupIndex}`} value={`${family.signature}-${groupIndex}`}>
                          <Group gap={0} wrap="nowrap">
                            <Checkbox
                              ml="md"
                              checked={allSelected}
                              indeterminate={nSelected > 0 && !allSelected}
                              onChange={(event) =>
                                toggleSteps(family.signature, groupSteps, event.currentTarget.checked)
                              }
                              aria-label={`Select ${group.label}`}
                            />
                            <Accordion.Control style={{ flex: 1 }}>
                              <Group gap="xs" wrap="nowrap">
                              <Box style={{ minWidth: 0 }}>
                                <Text size="xs" fw={700}>{group.label}</Text>
                                <Text size="xs" c="dimmed">{group.summary}</Text>
                              </Box>
                              {group.kind === "repeated_block" && <Badge size="xs" variant="light">x{group.repeat_count}</Badge>}
                              </Group>
                            </Accordion.Control>
                          </Group>
                          <Accordion.Panel>
                            <Stack gap={5}>
                              {groupSteps.map((stepNumber) => (
                                (() => {
                                  const observed = observedStepSummary(family, stepNumber);
                                  return (
                                    <Checkbox
                                      key={stepNumber}
                                      size="xs"
                                      checked={selectedSet.has(stepNumber)}
                                      onChange={(event) =>
                                        toggleSteps(family.signature, [stepNumber], event.currentTarget.checked)
                                      }
                                      label={
                                        <Box>
                                          <Text size="xs">{stepLabel(byNumber.get(stepNumber), stepNumber)}</Text>
                                          {observed.executionCount > 0 && (
                                            <Tooltip label={<Text style={{ whiteSpace: "pre-line" }}>{observed.detail}</Text>} multiline>
                                              <Text size="10px" c="dimmed">
                                                Observed {observed.executionCount}x in {observed.fileCount} {observed.fileCount === 1 ? "file" : "files"}; cycles {compactCycles(observed.cycles)}
                                              </Text>
                                            </Tooltip>
                                          )}
                                        </Box>
                                      }
                                      styles={{ label: { fontSize: 12 } }}
                                    />
                                  );
                                })()
                              ))}
                            </Stack>
                          </Accordion.Panel>
                        </Accordion.Item>
                      );
                    })}
                  </Accordion>
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
