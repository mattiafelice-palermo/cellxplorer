import { ActionIcon, Badge, Box, Button, Divider, Group, Popover, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import type { CellSummary, ComputeResult } from "../api";
import {
  cellFacts,
  relatedAnalysesForCell,
  type RelatedAnalysis,
} from "../cellSamplePopoverLogic";

export type { CellFacts, RelatedAnalysis } from "../cellSamplePopoverLogic";
export { cellFacts, relatedAnalysesForCell };

const CELL_HOVER_OPEN_DELAY_MS = 350;
const CELL_HOVER_CLOSE_DELAY_MS = 80;

/**
 * Read-only summary shown on hover; never triggers a request.
 * Mounts Mantine's Popover/Floating-UI tree and computes cellFacts lazily only
 * when the pointer lingers over a row, avoiding idle popover overhead across
 * large tables.
 */
export function CellHoverCard({
  cell,
  result,
  children,
}: {
  cell: Pick<CellSummary, "id" | "name"> & Partial<CellSummary>;
  result: ComputeResult | undefined;
  children: React.ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const scheduleOpen = () => {
    clearTimer();
    if (opened) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpened(true);
    }, CELL_HOVER_OPEN_DELAY_MS);
  };

  const cancelClose = () => {
    clearTimer();
  };

  const scheduleClose = () => {
    clearTimer();
    if (!opened) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpened(false);
    }, CELL_HOVER_CLOSE_DELAY_MS);
  };

  if (!opened) {
    return (
      <Box
        style={{ minWidth: 0 }}
        onMouseEnter={scheduleOpen}
        onMouseLeave={clearTimer}
      >
        {children}
      </Box>
    );
  }

  const facts = cellFacts(cell, result);
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={280}
      shadow="md"
      position="right"
      withArrow
      withinPortal
      trapFocus={false}
    >
      <Popover.Target>
        <Box
          style={{ minWidth: 0 }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {children}
        </Box>
      </Popover.Target>
      <Popover.Dropdown onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
        <Text size="sm" fw={700} style={{ wordBreak: "break-word" }}>
          {cell.name}
        </Text>
        {facts.length === 0 ? (
          <Text size="xs" c="dimmed" mt={6}>
            No cycling summary yet for this cell.
          </Text>
        ) : (
          <>
            <Stack gap={2} mt={8}>
              {facts.map((fact) => (
                <Group key={fact.label} justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    {fact.label}
                  </Text>
                  <Text size="xs" fw={600} style={{ whiteSpace: "nowrap" }}>
                    {fact.value}
                  </Text>
                </Group>
              ))}
            </Stack>
            <Text size="10px" c="dimmed" mt={8}>
              {facts[0].fromAnalysis
                ? "From this analysis, as plotted."
                : "From the cell record; open the analysis to compute more."}
            </Text>
          </>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Browse the other analyses a cell appears in and pull samples across.
 *
 * A replicate group can be imported whole or as its individual cells: group
 * membership belongs to the group, not to the analysis, so neither is the
 * obviously correct default.
 */
export function RelatedAnalysesPopover({
  related,
  onImport,
  label,
}: {
  related: RelatedAnalysis[];
  onImport: (entries: { kind: "cell" | "replicate_group"; ref_id: number }[]) => void;
  label: string;
}) {
  const [opened, setOpened] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={330}
      position="left-start"
      shadow="md"
      withArrow
      trapFocus={false}
    >
      <Popover.Target>
        <Tooltip label={related.length === 0 ? "Not used in other analyses" : "Other analyses using this cell"}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color={related.length === 0 ? "gray" : "var(--mantine-primary-color-6)"}
            disabled={related.length === 0}
            style={related.length === 0 ? { backgroundColor: "transparent" } : undefined}
            onClick={() => setOpened((v) => !v)}
            aria-label={label}
          >
            <IconChevronRight size={14} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Text size="xs" c="dimmed" mb={6}>
          Also used in {related.length} other analys{related.length === 1 ? "is" : "es"}
        </Text>
        <Box className="cx-vertical-scroll" style={{ maxHeight: 320 }}>
          <Stack gap={4}>
            {related.map((analysis) => {
              const isOpen = expanded === analysis.id;
              return (
                <Box key={analysis.id}>
                  <UnstyledButton
                    onClick={() => setExpanded(isOpen ? null : analysis.id)}
                    style={{ width: "100%" }}
                  >
                    <Group gap={6} wrap="nowrap" p={4}>
                      {isOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                      <Text size="sm" fw={600} truncate style={{ flex: 1, minWidth: 0 }}>
                        {analysis.title}
                      </Text>
                      <Badge size="xs" variant="light" color="gray">
                        {analysis.entries.length}
                      </Badge>
                    </Group>
                  </UnstyledButton>
                  {isOpen && (
                    <Stack gap={2} pl="md" pb={4}>
                      {analysis.entries.length === 0 && (
                        <Text size="xs" c="dimmed">
                          Nothing importable here.
                        </Text>
                      )}
                      {analysis.entries.map((entry) => (
                        <Box key={`${entry.kind}-${entry.ref_id}`}>
                          <Group gap={4} wrap="nowrap" align="center">
                            <Box style={{ flex: 1, minWidth: 0 }}>
                              <Text size="xs" truncate>
                                {entry.name}
                              </Text>
                              {entry.kind === "replicate_group" && (
                                <Text size="10px" c="dimmed">
                                  replicate · {entry.cells.length} cells
                                </Text>
                              )}
                            </Box>
                            {entry.alreadyHere ? (
                              <Text size="10px" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                                already added
                              </Text>
                            ) : (
                              <Tooltip
                                label={
                                  entry.kind === "replicate_group"
                                    ? "Add the replicate group"
                                    : "Add this cell"
                                }
                              >
                                <ActionIcon
                                  size="xs"
                                  variant="subtle"
                                  color="var(--mantine-primary-color-6)"
                                  onClick={() =>
                                    onImport([{ kind: entry.kind, ref_id: entry.ref_id }])
                                  }
                                  aria-label={`Add ${entry.name}`}
                                >
                                  <IconPlus size={12} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
                          {entry.kind === "replicate_group" && !entry.alreadyHere && (
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="var(--mantine-primary-color-6)"
                              mt={2}
                              onClick={() =>
                                onImport(
                                  entry.cells.map((c) => ({ kind: "cell" as const, ref_id: c.id }))
                                )
                              }
                            >
                              Add its {entry.cells.length} cells individually
                            </Button>
                          )}
                        </Box>
                      ))}
                      <Divider my={4} />
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="var(--mantine-primary-color-6)"
                        disabled={analysis.entries.every((e) => e.alreadyHere)}
                        onClick={() =>
                          onImport(
                            analysis.entries
                              .filter((e) => !e.alreadyHere)
                              .map((e) => ({ kind: e.kind, ref_id: e.ref_id }))
                          )
                        }
                      >
                        Add everything missing
                      </Button>
                    </Stack>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}
