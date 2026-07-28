import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  get,
  type CellProtocol,
  type FileProtocol,
  type ProtocolGroup,
  type ProtocolStep,
} from "../api";
import { normalizeGroup } from "./ProtocolSegmentsPanel";

const STEP_GRID = "40px minmax(180px, 1fr) 78px 74px 68px 74px 90px";

const DIRECTION_COLOR: Record<string, string> = {
  charge: "var(--mantine-color-teal-6)",
  discharge: "var(--mantine-color-indigo-5)",
  rest: "var(--mantine-color-gray-4)",
  control: "var(--mantine-color-grape-4)",
};

function factValue(step: ProtocolStep, keys: string[]): string | null {
  for (const key of keys) {
    const fact = (step.facts ?? []).find((entry) => entry.key === key);
    if (fact) return fact.value;
  }
  return null;
}

function protocolGroups(protocol: FileProtocol): ProtocolGroup[] {
  if (protocol.groups?.length) return protocol.groups.map(normalizeGroup);
  const stepNumbers = protocol.steps.map((step) => step.number);
  if (!stepNumbers.length) return [];
  return [
    normalizeGroup({
      id: "fallback",
      kind: "sequence",
      label: "Protocol steps",
      start_step: stepNumbers[0],
      end_step: stepNumbers[stepNumbers.length - 1],
      repeat_count: 1,
      control_step: null,
      depth: 0,
      step_numbers: stepNumbers,
      all_step_numbers: stepNumbers,
      children: [],
      summary: "Protocol steps",
    }),
  ];
}

function StepHeader() {
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
      <span>#</span>
      <span>step / condition</span>
      <span>rate</span>
      <span>cut-off</span>
      <span>until</span>
      <span>max time</span>
      <span />
    </Box>
  );
}

function ReadOnlyStepRow({
  step,
  number,
  highlighted,
}: {
  step: ProtocolStep | undefined;
  number: number;
  highlighted: boolean;
}) {
  const rate = step ? factValue(step, ["rate", "current"]) : null;
  const cutoff = step ? factValue(step, ["to", "hold"]) : null;
  const until = step ? factValue(step, ["until"]) : null;
  const maxTime = step ? factValue(step, ["limit", "duration"]) : null;
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
        background: highlighted ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined,
      }}
    >
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
        {(step?.conditions ?? []).map((condition, index) => (
          <Text
            key={`${condition.expression}-${index}`}
            size="10px"
            ff="monospace"
            c="var(--mantine-primary-color-7)"
            truncate
            pl={12}
          >
            {condition.expression}
          </Text>
        ))}
      </Box>
      <Text size="xs" ff="monospace" mt={2}>
        {rate ?? dash}
      </Text>
      <Text size="xs" ff="monospace" mt={2}>
        {cutoff ?? dash}
      </Text>
      <Text size="xs" ff="monospace" mt={2}>
        {until ?? dash}
      </Text>
      <Text size="xs" ff="monospace" mt={2}>
        {maxTime ?? dash}
      </Text>
      <Box mt={1}>
        {highlighted ? (
          <Badge size="xs" variant="light" color="var(--mantine-primary-color-6)">
            auto-selected
          </Badge>
        ) : null}
      </Box>
    </Box>
  );
}

function ReadOnlyGroupNode({
  group,
  byNumber,
  highlightedSteps,
}: {
  group: ProtocolGroup;
  byNumber: Map<number, ProtocolStep>;
  highlightedSteps: Set<number>;
}) {
  const [open, setOpen] = useState(group.depth === 0);
  const isBlock = group.kind === "repeated_block";
  const owned = group.all_step_numbers;
  const highlightedCount = owned.filter((step) => highlightedSteps.has(step)).length;
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
          {highlightedCount ? `${highlightedCount} highlighted · ` : ""}
          {owned.length} steps
        </Text>
      </Group>
      {open && (
        <Box mt={4}>
          {group.step_numbers.length > 0 && (
            <Box mb={6}>
              <StepHeader />
              {group.step_numbers.map((stepNumber) => (
                <ReadOnlyStepRow
                  key={stepNumber}
                  step={byNumber.get(stepNumber)}
                  number={stepNumber}
                  highlighted={highlightedSteps.has(stepNumber)}
                />
              ))}
            </Box>
          )}
          <Stack gap={6} pl="md" pr={6} pb={6}>
            {group.children.map((child) => (
              <ReadOnlyGroupNode
                key={child.id}
                group={child}
                byNumber={byNumber}
                highlightedSteps={highlightedSteps}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}

/**
 * Read-only protocol tree for inspecting which steps automatic recognition selected.
 * Does not mutate analysis specs or expose selection checkboxes.
 */
export function ProtocolStructureViewer({
  opened,
  onClose,
  cells,
  highlightedByCell,
  title = "Detected protocol steps",
}: {
  opened: boolean;
  onClose: () => void;
  cells: { id: number; name: string }[];
  highlightedByCell: Map<number, Set<number>>;
  title?: string;
}) {
  const [cellId, setCellId] = useState<number | null>(cells[0]?.id ?? null);
  useEffect(() => {
    if (!opened) return;
    if (cells.some((cell) => cell.id === cellId)) return;
    setCellId(cells[0]?.id ?? null);
  }, [opened, cells, cellId]);

  const protocol = useQuery({
    queryKey: ["cell-protocol", cellId, "with-observed-steps"],
    queryFn: () =>
      get<CellProtocol>(`/api/cells/${cellId}/protocol?include_observed=true`),
    enabled: opened && cellId != null,
  });

  const fileOptions = useMemo(() => {
    const files =
      protocol.data?.tests.flatMap((test) =>
        test.files.map((file) => ({
          value: String(file.id),
          label: file.filename,
          file,
        })),
      ) ?? [];
    return files;
  }, [protocol.data]);

  const [fileId, setFileId] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    if (fileOptions.some((option) => option.value === fileId)) return;
    setFileId(fileOptions[0]?.value ?? null);
  }, [opened, fileOptions, fileId]);

  const selectedFile = fileOptions.find((option) => option.value === fileId)?.file;
  const groups = selectedFile ? protocolGroups(selectedFile.protocol) : [];
  const byNumber = useMemo(() => {
    const map = new Map<number, ProtocolStep>();
    for (const step of selectedFile?.protocol.steps ?? []) map.set(step.number, step);
    return map;
  }, [selectedFile]);
  const highlightedSteps: Set<number> =
    cellId != null ? highlightedByCell.get(cellId) ?? new Set<number>() : new Set<number>();

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      centered
      size="min(1100px, calc(100vw - 3rem))"
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Highlighted steps were selected by the automatic parser.
        </Text>
        <Group gap="sm" grow>
          {cells.length > 1 && (
            <Select
              label="Cell"
              data={cells.map((cell) => ({ value: String(cell.id), label: cell.name }))}
              value={cellId != null ? String(cellId) : null}
              onChange={(value) => setCellId(value ? Number(value) : null)}
            />
          )}
          {fileOptions.length > 1 && (
            <Select
              label="Protocol file"
              data={fileOptions.map(({ value, label }) => ({ value, label }))}
              value={fileId}
              onChange={setFileId}
            />
          )}
        </Group>
        <ScrollArea h="min(60vh, 620px)" type="auto" offsetScrollbars>
          {protocol.isLoading ? (
            <Group gap="xs" p="md">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Loading protocol…
              </Text>
            </Group>
          ) : protocol.isError ? (
            <Text size="sm" c="red" p="md">
              {(protocol.error as Error).message || "Could not load protocol."}
            </Text>
          ) : !groups.length ? (
            <Text size="sm" c="dimmed" p="md">
              No protocol structure available for this cell.
            </Text>
          ) : (
            <Stack gap="sm" pr="xs">
              {groups.map((group) => (
                <ReadOnlyGroupNode
                  key={group.id}
                  group={group}
                  byNumber={byNumber}
                  highlightedSteps={highlightedSteps}
                />
              ))}
            </Stack>
          )}
        </ScrollArea>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
