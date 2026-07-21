import { ActionIcon, Badge, Box, Button, Divider, Group, HoverCard, Popover, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useState } from "react";

import type { AnalysisSummary, CellSummary, ComputeResult } from "../api";

/**
 * Facts worth showing about one cell without waiting for anything.
 *
 * Two sources, deliberately in this order: the computed analysis when it is
 * loaded, because those numbers are the ones the plot is drawn from, and the
 * cell record otherwise, whose totals are filled in at import time. A cell that
 * has never been part of a computed analysis therefore still has something to
 * show.
 */
export interface CellFacts {
  label: string;
  value: string;
  fromAnalysis: boolean;
}

function format(value: number | null | undefined, digits: number, unit: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${value.toFixed(digits)} ${unit}`;
}

export function cellFacts(
  cell: Pick<CellSummary, "id" | "name"> & Partial<CellSummary>,
  result: ComputeResult | undefined
): CellFacts[] {
  const series = result?.cell_series?.find((s) => s.cell_id === cell.id && !s.excluded);
  const facts: CellFacts[] = [];
  const push = (label: string, value: string | null, fromAnalysis: boolean) => {
    if (value !== null) facts.push({ label, value, fromAnalysis });
  };

  if (series) {
    const mass = series.active_mass_mg;
    const metrics = series.metrics ?? {};
    const maxCapacity = metrics.max_discharge_capacity_mah as number | null | undefined;
    push("Cycles", metrics.n_cycles != null ? String(metrics.n_cycles) : null, true);
    // Specific capacity is the number people actually compare, but it only
    // exists when the active mass is known.
    if (mass && maxCapacity != null && Number.isFinite(maxCapacity)) {
      push("Max specific capacity", format(maxCapacity / (mass / 1000), 1, "mAh/g"), true);
    }
    push("Max discharge", format(maxCapacity ?? null, 2, "mAh"), true);
    push(
      "Retention (last)",
      format(metrics.retention_last_pct as number | null, 1, "%"),
      true
    );
    push(
      "Cycles to 80%",
      metrics.cycles_to_80_pct != null ? String(metrics.cycles_to_80_pct) : null,
      true
    );
    push("Mean CE", format(metrics.mean_ce_pct as number | null, 2, "%"), true);
  } else {
    push("Cycles", cell.total_cycles != null ? String(cell.total_cycles) : null, false);
    push("Total discharge", format(cell.total_discharge_capacity_mah, 2, "mAh"), false);
    const mass = cell.scientific_metadata?.active_mass_mg?.effective_value ?? null;
    push("Active mass", format(mass, 2, "mg"), false);
    push(
      "Files",
      cell.n_files != null ? `${cell.n_files} in ${cell.n_tests ?? 0} test(s)` : null,
      false
    );
  }
  return facts;
}

/** Read-only summary shown on hover; never triggers a request. */
export function CellHoverCard({
  cell,
  result,
  children,
}: {
  cell: Pick<CellSummary, "id" | "name"> & Partial<CellSummary>;
  result: ComputeResult | undefined;
  children: React.ReactNode;
}) {
  const facts = cellFacts(cell, result);
  return (
    <HoverCard width={280} shadow="md" openDelay={350} closeDelay={80} position="right" withArrow>
      <HoverCard.Target>
        <Box style={{ minWidth: 0 }}>{children}</Box>
      </HoverCard.Target>
      <HoverCard.Dropdown>
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
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

export interface RelatedAnalysis {
  id: number;
  title: string;
  /** Entries of that analysis, resolved to something importable. */
  entries: {
    kind: "cell" | "replicate_group";
    ref_id: number;
    name: string;
    /** Members, for a replicate group — so it can be imported either way. */
    cells: { id: number; name: string }[];
    alreadyHere: boolean;
  }[];
}

/**
 * Find the other analyses that contain a cell.
 *
 * Resolved entirely from caches the app already holds: analysis summaries carry
 * compact `entry_refs`, and cell and replicate-group lists are kept from
 * startup. No request is made, so this stays instant inside a popover.
 */
export function relatedAnalysesForCell(
  cellId: number,
  currentAnalysisId: number,
  analyses: AnalysisSummary[],
  cellsById: Map<number, { id: number; name: string }>,
  groupsById: Map<number, { id: number; name: string; cell_ids: number[] }>,
  presentRefs: { kind: string; ref_id: number }[]
): RelatedAnalysis[] {
  const here = new Set(presentRefs.map((r) => `${r.kind}:${r.ref_id}`));
  const out: RelatedAnalysis[] = [];

  for (const analysis of analyses) {
    if (analysis.id === currentAnalysisId) continue;
    const refs = analysis.entry_refs ?? [];
    const containsCell = refs.some((ref) =>
      ref.kind === "cell"
        ? ref.ref_id === cellId
        : (groupsById.get(ref.ref_id)?.cell_ids ?? []).includes(cellId)
    );
    if (!containsCell) continue;

    const entries: RelatedAnalysis["entries"] = [];
    for (const ref of refs) {
      if (ref.kind === "cell") {
        const cell = cellsById.get(ref.ref_id);
        if (!cell) continue;
        entries.push({
          kind: "cell",
          ref_id: ref.ref_id,
          name: cell.name,
          cells: [cell],
          alreadyHere: here.has(`cell:${ref.ref_id}`),
        });
      } else {
        const group = groupsById.get(ref.ref_id);
        if (!group) continue;
        entries.push({
          kind: "replicate_group",
          ref_id: ref.ref_id,
          name: group.name,
          cells: group.cell_ids
            .map((id) => cellsById.get(id))
            .filter((c): c is { id: number; name: string } => Boolean(c)),
          alreadyHere: here.has(`replicate_group:${ref.ref_id}`),
        });
      }
    }
    out.push({ id: analysis.id, title: analysis.title, entries });
  }
  return out;
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
            color={related.length === 0 ? "gray" : "teal"}
            disabled={related.length === 0}
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
                                  color="teal"
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
                              color="teal"
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
                        color="teal"
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
