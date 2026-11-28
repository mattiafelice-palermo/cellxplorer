import { ActionIcon, Box, Button, Drawer, Group, Paper, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFile, IconFolder, IconSearch, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { ImportBrowseEntry, ImportFolderFile } from "../api";
import { reviewFolderTree, flattenImportFolderTree, type FolderImportNode } from "../importFolderTree";

export function ImportSelectionReview({ entries, summary, origins, scanning, scanError, scanNote, onRetry, activePath, onClose, onRemove, onClear, onPreview }: {
  entries: ImportBrowseEntry[];
  summary: string;
  origins: ReadonlyMap<string, ImportFolderFile>;
  scanning: boolean;
  scanError: string | null;
  scanNote: string | null;
  onRetry: () => void;
  activePath: string | null;
  onClose: () => void;
  onRemove: (paths: string[]) => void;
  onClear: () => void;
  onPreview: (path: string) => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const roots = useMemo(() => reviewFolderTree(entries, origins, query), [entries, origins, query]);
  const [expanded, setExpanded] = useState(() => {
    const initial = roots.find(root => flattenImportFolderTree(root).some(file => file.path === activePath)) ?? roots[roots.length - 1];
    return new Set(initial ? [initial.key] : []);
  });
  function folder(node: FolderImportNode, depth: number) {
    const open = !!query || expanded.has(node.key);
    const files = flattenImportFolderTree(node);
    return <Box key={node.key} pl={depth ? "md" : 0}>
      <Group gap={4} wrap="nowrap">
        <UnstyledButton px="xs" py={6} style={{ flex: 1, minWidth: 0 }} aria-expanded={open}
          aria-label={node.name} disabled={!!query} onClick={() => setExpanded(current => {
            const next = new Set(current);
            if (next.has(node.key)) next.delete(node.key); else next.add(node.key);
            return next;
          })}>
          <Group gap="xs" wrap="nowrap">
            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            <IconFolder size={16} /><Text size="sm" fw={600} truncate>{node.name}</Text>
            <Text size="xs" c="dimmed">({files.length})</Text>
          </Group>
        </UnstyledButton>
        {!query && <ActionIcon size="sm" color="gray" variant="subtle" aria-label={"Remove folder " + node.name}
          onClick={() => onRemove(files.flatMap(file => file.path ? [file.path] : []))}><IconX size={14} /></ActionIcon>}
      </Group>
      {open && <>{node.children.map(child => folder(child, depth + 1))}
        {node.files.map(file => file.path && <Group key={file.path} pl="xl" py={3} gap="xs" wrap="nowrap">
          <IconFile size={15} /><UnstyledButton style={{ flex: 1, minWidth: 0 }} title={file.path} onClick={() => onPreview(file.path!)}>
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>{file.filename}</Text>
          </UnstyledButton>
          <ActionIcon size="sm" color="gray" variant="subtle" aria-label={"Remove " + file.filename}
            onClick={() => onRemove([file.path!])}><IconX size={14} /></ActionIcon>
        </Group>)}</>}
    </Box>;
  }
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
            <Text size="sm" c="dimmed">{summary}{!query && !scanning && !scanError && roots.length ? " in " + roots.length + (roots.length === 1 ? " folder" : " folders") : ""}</Text>
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
            {scanning && <Text size="sm" role="status">Finding importable files in the selected folders…</Text>}
            {scanError && <Group><Text size="sm" c="red" role="alert">{scanError}</Text><Button size="compact-sm" onClick={onRetry}>Retry</Button></Group>}
            {(scanning || scanError) && entries.filter(entry => entry.kind === "folder").map(entry =>
              <Group key={entry.path} px="xs" wrap="nowrap"><IconFolder size={16} />
                <Text size="sm" style={{ flex: 1 }} truncate title={entry.path}>{entry.name}</Text>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label={"Remove folder " + entry.name}
                  onClick={() => onRemove([entry.path])}><IconX size={14} /></ActionIcon>
              </Group>)}
            {scanNote && !scanning && !scanError && <Text size="xs" c="dimmed">{scanNote}</Text>}
            {!roots.length && !scanning && !scanError && <Text size="sm" c="dimmed">{entries.length ? "No matches in your selection." : "Your selection is empty."}</Text>}
            {roots.map(node => <Paper withBorder px="xs" key={node.key}>{folder(node, 0)}</Paper>)}
          </Stack>
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
