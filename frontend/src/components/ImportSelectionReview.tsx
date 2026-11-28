import { ActionIcon, Box, Button, Drawer, Group, Paper, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFile, IconFolder, IconSearch, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { ImportBrowseEntry } from "../api";
import { importSourcePathKey } from "../importSourceReadability";

function parentFolder(path: string) {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (end < 0) return "";
  if (end === 0 || (end === 2 && path[1] === ":")) return path.slice(0, end + 1);
  return path.slice(0, end);
}

function groupSelection(entries: ImportBrowseEntry[]) {
  const folders = new Map<string, { path: string; label: string; entries: ImportBrowseEntry[] }>();
  const labels = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const path = parentFolder(entry.path);
    const key = importSourcePathKey(path);
    let group = folders.get(key);
    if (!group) {
      const label = path.split(/[\\/]/).pop() || path || "Selected sources";
      const folded = label.toLocaleLowerCase();
      if (labels.has(folded)) duplicates.add(folded);
      labels.add(folded);
      group = { path, label, entries: [] };
      folders.set(key, group);
    }
    group.entries.push(entry);
  }
  for (const group of folders.values()) {
    if (duplicates.has(group.label.toLocaleLowerCase())) group.label = group.path;
  }
  return [...folders.values()];
}

export function ImportSelectionReview({ entries, summary, activePath, onClose, onRemove, onClear, onPreview }: {
  entries: ImportBrowseEntry[];
  summary: string;
  activePath: string | null;
  onClose: () => void;
  onRemove: (path: string) => void;
  onClear: () => void;
  onPreview: (path: string) => void;
}) {
  const groups = useMemo(() => groupSelection(entries), [entries]);
  const [expanded, setExpanded] = useState(() => {
    const initial = groups.find(group => group.entries.some(entry => entry.path === activePath)) ?? groups[groups.length - 1];
    return new Set(initial ? [initial.path] : []);
  });
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visible = groups.map(group => ({
    ...group, matches: query ? group.entries.filter(entry => entry.path.toLocaleLowerCase().includes(query)) : group.entries,
  })).filter(group => group.matches.length);

  return (
    <Drawer.Root opened onClose={onClose} position="bottom" withinPortal={false} lockScroll={false}
      size="min(55%, 31rem)" transitionProps={{ duration: 0 }}
      styles={{ inner: { position: "absolute", inset: 0 }, overlay: { position: "absolute" },
        content: { display: "flex", flexDirection: "column", borderRadius: "var(--mantine-radius-md) var(--mantine-radius-md) 0 0" } }}>
      <Drawer.Overlay backgroundOpacity={0.28} />
      <Drawer.Content>
        <Drawer.Header>
          <Group gap="xs">
            <Drawer.Title fw={700}>Review selection</Drawer.Title>
            <Text size="sm" c="dimmed">{summary}{groups.length > 0 && !entries.some(e => e.kind === "folder")
              ? ' in ' + groups.length + (groups.length === 1 ? ' folder' : ' folders') : ''}</Text>
          </Group>
          <Button data-autofocus size="compact-sm" onClick={onClose}>Close</Button>
        </Drawer.Header>
        <Drawer.Body style={{ minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--mantine-spacing-xs)" }}>
          <Group wrap="nowrap" gap="xs">
            <TextInput size="xs" style={{ flex: 1 }} placeholder="Search selected files or folders"
              aria-label="Search selected files or folders" leftSection={<IconSearch size={14} />}
              value={search} onChange={event => setSearch(event.currentTarget.value)} />
            <Button size="compact-sm" variant="subtle" color="gray" disabled={!entries.length} onClick={onClear}>Clear all</Button>
          </Group>
          <Stack gap={4} className="cx-vertical-scroll" style={{ overflowY: "auto", minHeight: 0 }}>
            {!visible.length && <Text size="sm" c="dimmed">{entries.length ? "No matches in your selection." : "Your selection is empty."}</Text>}
            {visible.map(group => {
              const open = !!query || expanded.has(group.path);
              return <Paper withBorder key={group.path}>
                <UnstyledButton w="100%" px="sm" py={6} aria-expanded={open} title={group.path}
                  disabled={!!query} onClick={() => setExpanded(current => {
                    const next = new Set(current);
                    if (next.has(group.path)) next.delete(group.path);
                    else next.add(group.path);
                    return next;
                  })}>
                  <Group gap="xs" wrap="nowrap">
                    {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    <IconFolder size={16} style={{ flexShrink: 0 }} />
                    <Text size="sm" fw={600} truncate>{group.label}</Text>
                    <Text size="xs" c="dimmed">({group.matches.length})</Text>
                  </Group>
                </UnstyledButton>
                {open && group.matches.map(entry => (
                  <Group key={entry.path} pl="xl" pr="sm" py={3} gap="xs" wrap="nowrap">
                    {entry.kind === "file" ? <IconFile size={15} /> : <IconFolder size={15} />}
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      {entry.kind === "file" ? <UnstyledButton title={entry.path} w="100%" onClick={() => onPreview(entry.path)}>
                        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{entry.name}</Text>
                      </UnstyledButton> : <Text size="sm" title={entry.path} style={{ overflowWrap: "anywhere" }}>{entry.name}</Text>}
                    </Box>
                    <ActionIcon variant="subtle" color="gray" size="sm" title="Remove from selection"
                      aria-label={'Remove ' + entry.name} onClick={() => onRemove(entry.path)}><IconX size={14} /></ActionIcon>
                  </Group>
                ))}
              </Paper>;
            })}
          </Stack>
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
