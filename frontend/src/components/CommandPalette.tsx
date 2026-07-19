import {
  Badge,
  Box,
  Group,
  Kbd,
  Modal,
  ScrollArea,
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
import { fuzzyScore, highlightSegments } from "../fuzzySearch";

type ResultKind = "cell" | "analysis" | "plot" | "replicate" | "folder";

interface PaletteItem {
  key: string;
  kind: ResultKind;
  /** Text the query is matched against. */
  title: string;
  subtitle?: string;
  to: string;
}

const KIND_LABEL: Record<ResultKind, string> = {
  cell: "Cell",
  analysis: "Analysis",
  plot: "Saved plot",
  replicate: "Replicate group",
  folder: "Folder",
};

function KindIcon({ kind }: { kind: ResultKind }) {
  const size = 16;
  if (kind === "cell") return <IconDatabase size={size} />;
  if (kind === "replicate") return <IconLayersIntersect size={size} />;
  if (kind === "folder") return <IconFolder size={size} />;
  return <IconChartLine size={size} />;
}

function flattenFolders(nodes: FolderNode[], trail: string[] = []): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const folder of nodes) {
    items.push({
      key: `folder:${folder.id}`,
      kind: "folder",
      title: folder.name,
      subtitle: trail.length ? trail.join(" / ") : "Top level",
      to: `/projects?folder=${folder.id}`,
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
          <Text key={index} span fw={800} c="teal.7">
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

  // Everything below is already held by the startup summaries, so the palette
  // searches instantly without touching the network.
  const items = useMemo<PaletteItem[]>(() => {
    if (!opened) return [];
    const cells = queryClient.getQueryData<CellSummary[]>(["cells", ""]) ?? [];
    const analyses = queryClient.getQueryData<AnalysisSummary[]>(["analyses", ""]) ?? [];
    const groups = queryClient.getQueryData<ReplicateGroupSummary[]>(["replicate-groups"]) ?? [];
    const tree = queryClient.getQueryData<Tree>(["tree"]);

    const result: PaletteItem[] = [];
    for (const cell of cells) {
      result.push({
        key: `cell:${cell.id}`,
        kind: "cell",
        title: cell.name,
        subtitle: cell.archived ? "Archived cell" : cell.description || undefined,
        to: `/?cell=${cell.id}`,
      });
    }
    for (const analysis of analyses) {
      result.push({
        key: `analysis:${analysis.id}`,
        kind: "analysis",
        title: analysis.title,
        subtitle: analysis.folder ? `in ${analysis.folder.name}` : undefined,
        to: `/analyses/${analysis.id}`,
      });
      for (const plot of analysis.saved_plots ?? []) {
        result.push({
          key: `plot:${analysis.id}:${plot.id}`,
          kind: "plot",
          title: plot.name,
          subtitle: `in ${analysis.title}`,
          // Opens the analysis on the tab this plot belongs to.
          to: `/analyses/${analysis.id}?tab=${encodeURIComponent(plot.tab)}&plot=${encodeURIComponent(plot.id)}`,
        });
      }
    }
    for (const group of groups) {
      result.push({
        key: `replicate:${group.id}`,
        kind: "replicate",
        title: group.name,
        subtitle: `${group.cell_ids.length} cell${group.cell_ids.length === 1 ? "" : "s"}`,
        to: `/?replicate=${group.id}`,
      });
    }
    if (tree) result.push(...flattenFolders(tree.folders));
    return result;
  }, [opened, queryClient]);

  const matches = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      return items.slice(0, 12).map((item) => ({ item, score: 0, indices: [] as number[] }));
    }
    const scored: { item: PaletteItem; score: number; indices: number[] }[] = [];
    for (const item of items) {
      const match = fuzzyScore(item.title, trimmed);
      if (match) {
        scored.push({ item, score: match.score, indices: match.indices });
        continue;
      }
      // Fall back to the subtitle so "in Test analysis 2" still finds plots.
      if (item.subtitle) {
        const subtitleMatch = fuzzyScore(item.subtitle, trimmed);
        if (subtitleMatch) scored.push({ item, score: subtitleMatch.score - 40, indices: [] });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
    return scored.slice(0, 40);
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem) => {
    onClose();
    navigate(item.to);
  };

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
              setActive((index) => Math.min(index + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const chosen = matches[active];
              if (chosen) choose(chosen.item);
            }
          }}
        />
      </Box>
      <Box style={{ borderTop: "1px solid var(--mantine-color-gray-2)" }}>
        {matches.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="xl">
            {items.length === 0
              ? "Still loading the library..."
              : `No match for "${query.trim()}"`}
          </Text>
        ) : (
          <ScrollArea.Autosize mah={380} type="auto" scrollbars="y" scrollbarSize={8}
            styles={{ thumb: { backgroundColor: "var(--mantine-color-teal-4)" } }}>
            <Stack gap={0} p={4} ref={listRef}>
              {matches.map(({ item, indices }, index) => (
                <Group
                  key={item.key}
                  data-index={index}
                  wrap="nowrap"
                  gap="sm"
                  px="sm"
                  py={8}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                  style={{
                    borderRadius: 8,
                    cursor: "pointer",
                    background: index === active ? "var(--mantine-color-teal-0)" : undefined,
                  }}
                >
                  <Box c={index === active ? "teal.7" : "gray.6"} style={{ display: "flex" }}>
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
                  </Box>
                  <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                    {KIND_LABEL[item.kind]}
                  </Badge>
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
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
          {matches.length} result{matches.length === 1 ? "" : "s"}
        </Text>
      </Group>
    </Modal>
  );
}
