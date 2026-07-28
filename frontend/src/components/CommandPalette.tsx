import {
  Badge,
  Box,
  Group,
  Kbd,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconChartLine,
  IconDatabase,
  IconFolder,
  IconLayersIntersect,
  IconPhoto,
  IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type {
  AnalysisSummary,
  CellSummary,
  FolderNode,
  ReplicateGroupSummary,
  Tree,
} from "../api";
import { fuzzyScoreFields, highlightSegments, type SearchField } from "../fuzzySearch";

type ResultKind = "analysis" | "plot" | "cell" | "replicate" | "folder";

/** Section order in the result list. */
const SECTIONS: { kind: ResultKind; label: string }[] = [
  { kind: "analysis", label: "Analyses" },
  { kind: "plot", label: "Plots" },
  { kind: "cell", label: "Cells" },
  { kind: "replicate", label: "Replicate groups" },
  { kind: "folder", label: "Projects" },
];

/** Results shown per section when the query is empty. */
const EMPTY_QUERY_PER_SECTION = 3;
/** Results shown per section while searching. */
const MAX_PER_SECTION = 8;

interface PaletteItem {
  key: string;
  kind: ResultKind;
  title: string;
  subtitle?: string;
  to: string;
  /** Fields the query is scored against; the first one is the title. */
  fields: SearchField[];
  /**
   * Related names (contained cells, replicate members, folder contents) shown
   * as evidence when they — rather than the title — explain the match.
   */
  samples?: string[];
}

/** How many evidence lines to list under a result. */
const MAX_EVIDENCE = 3;

/**
 * Names that explain a match the title cannot: for every query term missing
 * from the title, collect the related names containing it, with the matched
 * characters marked for highlighting.
 */
function matchEvidence(
  item: PaletteItem,
  query: string,
): { total: number; shown: { text: string; indices: number[] }[] } {
  const samples = item.samples;
  const trimmed = query.trim();
  if (!samples?.length || !trimmed) return { total: 0, shown: [] };
  const titleLower = item.title.toLowerCase();
  const unexplained = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term && !titleLower.includes(term));
  if (unexplained.length === 0) return { total: 0, shown: [] };

  const matched: { text: string; indices: number[] }[] = [];
  for (const sample of samples) {
    const lower = sample.toLowerCase();
    const indices = new Set<number>();
    for (const term of unexplained) {
      let at = lower.indexOf(term);
      while (at >= 0) {
        for (let offset = 0; offset < term.length; offset += 1) indices.add(at + offset);
        at = lower.indexOf(term, at + term.length);
      }
    }
    if (indices.size > 0) {
      matched.push({ text: sample, indices: [...indices].sort((a, b) => a - b) });
    }
  }
  return { total: matched.length, shown: matched.slice(0, MAX_EVIDENCE) };
}

function KindIcon({ kind }: { kind: ResultKind }) {
  const size = 16;
  if (kind === "cell") return <IconDatabase size={size} />;
  if (kind === "replicate") return <IconLayersIntersect size={size} />;
  if (kind === "folder") return <IconFolder size={size} />;
  if (kind === "plot") return <IconPhoto size={size} />;
  return <IconChartLine size={size} />;
}

function flattenFolders(nodes: FolderNode[], trail: string[] = []): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const folder of nodes) {
    const path = trail.join(" / ");
    const contents = [
      ...folder.cells.map((cell) => cell.name),
      ...folder.analyses.map((analysis) => analysis.title),
    ];
    items.push({
      key: `folder:${folder.id}`,
      kind: "folder",
      title: folder.name,
      subtitle: trail.length ? path : "Top level",
      to: `/projects?folder=${folder.id}`,
      fields: [
        { text: folder.name, weight: 1 },
        { text: path, weight: 0.5 },
        { text: contents.join(" • "), weight: 0.45, substringOnly: true },
      ],
      samples: contents,
    });
    items.push(...flattenFolders(folder.children, [...trail, folder.name]));
  }
  return items;
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  return (
    <>
      {highlightSegments(text, indices).map((segment, index) =>
        segment.matched ? (
          <Text key={index} span fw={800} c="var(--mantine-primary-color-7)">
            {segment.text}
          </Text>
        ) : (
          <Text key={index} span>
            {segment.text}
          </Text>
        ),
      )}
    </>
  );
}

export function CommandPalette({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (opened) {
      setQuery("");
      setActive(0);
    }
  }, [opened]);

  // Everything is read from the startup query cache, so searching never
  // touches the network.
  const items = useMemo<PaletteItem[]>(() => {
    if (!opened) return [];
    const cells = queryClient.getQueryData<CellSummary[]>(["cells", ""]) ?? [];
    const analyses = queryClient.getQueryData<AnalysisSummary[]>(["analyses", ""]) ?? [];
    const groups = queryClient.getQueryData<ReplicateGroupSummary[]>(["replicate-groups"]) ?? [];
    const tree = queryClient.getQueryData<Tree>(["tree"]);

    const cellById = new Map(cells.map((cell) => [cell.id, cell]));
    const groupById = new Map(groups.map((group) => [group.id, group]));

    /** Names of every cell an analysis reaches, directly or via a group. */
    const analysisSampleNames = (analysis: AnalysisSummary): string[] => {
      const names: string[] = [];
      for (const entry of analysis.entry_refs ?? []) {
        if (entry.kind === "cell") {
          const cell = cellById.get(entry.ref_id);
          if (cell) names.push(cell.name);
        } else if (entry.kind === "replicate_group") {
          const group = groupById.get(entry.ref_id);
          if (!group) continue;
          names.push(group.name);
          for (const cellId of group.cell_ids) {
            const cell = cellById.get(cellId);
            if (cell) names.push(cell.name);
          }
        }
      }
      return names;
    };

    const result: PaletteItem[] = [];

    for (const analysis of analyses) {
      const sampleNames = analysisSampleNames(analysis);
      const samplesText = sampleNames.join(" • ");
      const context: SearchField[] = [
        { text: analysis.folder?.name ?? "", weight: 0.5 },
        { text: (analysis.quantity ?? "").replace(/_/g, " "), weight: 0.5 },
        { text: samplesText, weight: 0.45, substringOnly: true },
      ];
      result.push({
        key: `analysis:${analysis.id}`,
        kind: "analysis",
        title: analysis.title,
        subtitle: analysis.folder ? `in ${analysis.folder.name}` : undefined,
        to: `/analyses/${analysis.id}`,
        fields: [{ text: analysis.title, weight: 1 }, ...context],
        samples: sampleNames,
      });
      for (const plot of analysis.saved_plots ?? []) {
        result.push({
          key: `plot:${analysis.id}:${plot.id}`,
          kind: "plot",
          title: plot.name,
          subtitle: `in ${analysis.title}`,
          to: `/analyses/${analysis.id}?tab=${encodeURIComponent(plot.tab)}&plot=${encodeURIComponent(plot.id)}`,
          fields: [
            { text: plot.name, weight: 1 },
            { text: analysis.title, weight: 0.6 },
            { text: plot.tab.replace(/_/g, " "), weight: 0.4 },
            ...context.slice(0, 1),
            { text: samplesText, weight: 0.45, substringOnly: true },
          ],
          samples: sampleNames,
        });
      }
    }

    for (const cell of cells) {
      result.push({
        key: `cell:${cell.id}`,
        kind: "cell",
        title: cell.name,
        subtitle: cell.archived ? "Archived cell" : cell.description || undefined,
        to: `/?cell=${cell.id}`,
        fields: [
          { text: cell.name, weight: 1 },
          { text: cell.description ?? "", weight: 0.4 },
          { text: (cell.tags ?? []).join(" "), weight: 0.5 },
        ],
      });
    }

    for (const group of groups) {
      const memberNames = group.cell_ids
        .map((id) => cellById.get(id)?.name)
        .filter((name): name is string => Boolean(name));
      result.push({
        key: `replicate:${group.id}`,
        kind: "replicate",
        title: group.name,
        subtitle: `${group.cell_ids.length} cell${group.cell_ids.length === 1 ? "" : "s"}`,
        to: `/?replicate=${group.id}`,
        fields: [
          { text: group.name, weight: 1 },
          { text: group.description ?? "", weight: 0.4 },
          { text: memberNames.join(" • "), weight: 0.45, substringOnly: true },
        ],
        samples: memberNames,
      });
    }

    if (tree) result.push(...flattenFolders(tree.folders));
    return result;
  }, [opened, queryClient]);

  /** Matches grouped into sections, plus a flat list for keyboard nav. */
  const { sections, flat } = useMemo(() => {
    const trimmed = query.trim();
    const scored: { item: PaletteItem; score: number; indices: number[] }[] = [];
    for (const item of items) {
      const match = fuzzyScoreFields(item.fields, trimmed);
      if (match) scored.push({ item, score: match.score, indices: match.indices });
    }
    scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));

    const limit = trimmed ? MAX_PER_SECTION : EMPTY_QUERY_PER_SECTION;
    const grouped = SECTIONS.map((section) => ({
      ...section,
      entries: scored.filter((entry) => entry.item.kind === section.kind).slice(0, limit),
    })).filter((section) => section.entries.length > 0);

    return { sections: grouped, flat: grouped.flatMap((section) => section.entries) };
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem) => {
    onClose();
    navigate(item.to);
  };

  let runningIndex = -1;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      withCloseButton={false}
      size="lg"
      padding={0}
      yOffset="12vh"
      transitionProps={{ duration: 120 }}
      overlayProps={{ blur: 4, backgroundOpacity: 0.45 }}
      styles={{ body: { padding: 0 } }}
    >
      <Box p="xs">
        <TextInput
          data-autofocus
          variant="unstyled"
          size="md"
          placeholder="Search cells, analyses, plots, replicates and folders..."
          leftSection={<IconSearch size={18} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, flat.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const chosen = flat[active];
              if (chosen) choose(chosen.item);
            }
          }}
        />
      </Box>
      <Box style={{ borderTop: "1px solid var(--mantine-color-gray-2)" }}>
        {flat.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="xl">
            {items.length === 0
              ? "Still loading the library..."
              : `No match for "${query.trim()}"`}
          </Text>
        ) : (
          <Box className="cx-vertical-scroll" style={{ maxHeight: 420 }}>
            <Stack gap={2} p={4} ref={listRef}>
              {sections.map((section) => (
                <Box key={section.kind}>
                  <Text size="xs" fw={700} c="dimmed" px="sm" pt={6} pb={2} tt="uppercase">
                    {section.label}
                  </Text>
                  {section.entries.map(({ item, indices }) => {
                    runningIndex += 1;
                    const index = runningIndex;
                    const evidence = matchEvidence(item, query);
                    return (
                      <Group
                        key={item.key}
                        data-index={index}
                        wrap="nowrap"
                        gap="sm"
                        px="sm"
                        py={7}
                        align="flex-start"
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(item)}
                        style={{
                          borderRadius: 8,
                          cursor: "pointer",
                          background:
                            index === active ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined,
                        }}
                      >
                        <Box
                          c={index === active ? "var(--mantine-primary-color-7)" : "gray.6"}
                          style={{ display: "flex", paddingTop: 2 }}
                        >
                          <KindIcon kind={item.kind} />
                        </Box>
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm" fw={600} truncate="end">
                            <Highlighted text={item.title} indices={indices} />
                          </Text>
                          {item.subtitle && (
                            <Text size="xs" c="dimmed" truncate="end">
                              {item.subtitle}
                            </Text>
                          )}
                          {/* Why this matched, when the title does not say so. */}
                          {evidence.shown.map((line) => (
                            <Text
                              key={line.text}
                              size="xs"
                              c="dimmed"
                              truncate="end"
                              pl={8}
                              style={{ borderLeft: "2px solid var(--mantine-primary-color-2)" }}
                              mt={2}
                            >
                              <Highlighted text={line.text} indices={line.indices} />
                            </Text>
                          ))}
                          {evidence.total > evidence.shown.length && (
                            <Text size="xs" c="dimmed" pl={8} mt={2}>
                              +{evidence.total - evidence.shown.length} more
                            </Text>
                          )}
                        </Box>
                        {index === active && (
                          <Badge size="xs" variant="light" color="var(--mantine-primary-color-6)" style={{ flexShrink: 0 }}>
                            Enter
                          </Badge>
                        )}
                      </Group>
                    );
                  })}
                </Box>
              ))}
            </Stack>
          </Box>
        )}
      </Box>
      <Group
        justify="space-between"
        px="sm"
        py={6}
        style={{ borderTop: "1px solid var(--mantine-color-gray-2)" }}
      >
        <Group gap={6}>
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd>
          <Text size="xs" c="dimmed">navigate</Text>
          <Kbd size="xs">Enter</Kbd>
          <Text size="xs" c="dimmed">open</Text>
          <Kbd size="xs">Esc</Kbd>
          <Text size="xs" c="dimmed">close</Text>
        </Group>
        <Text size="xs" c="dimmed">
          {flat.length} result{flat.length === 1 ? "" : "s"}
        </Text>
      </Group>
    </Modal>
  );
}
