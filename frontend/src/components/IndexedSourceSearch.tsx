import { Alert, Badge, Button, Checkbox, Group, Modal, Paper, ScrollArea, Select, Stack, Text, TextInput, Tooltip, Box } from "@mantine/core";
import { useDebouncedValue, useResizeObserver } from "@mantine/hooks";
import { IconSearch, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { get, post, type ImportBrowseEntry } from "../api";
import { importPathsEqual } from "../importPathBreadcrumbs";
import { toggleImportFileSelection } from "../importBrowserSelection";
import { indexedFileAvailable, indexedFileStatus, type FileSearchResults, type FileSearchSettings as Settings, type IndexedFile } from "../importSearch";
import { FileSearchSettings } from "./FileSearchSettings";

export function IndexedSourceSearch({ selected, currentPath, onPreview, onSelection, onDialogChange }: {
  selected: ReadonlyMap<string, ImportBrowseEntry>; currentPath?: string | null;
  onPreview: (file: IndexedFile) => void;
  onSelection: (next: Map<string, ImportBrowseEntry>, files: IndexedFile[]) => void;
  onDialogChange: (opened: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [queryText] = useDebouncedValue(text, 120);
  const [root, setRoot] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [supplier, setSupplier] = useState<string | null>(null);
  const [technique, setTechnique] = useState("");
  const [queryTechnique] = useDebouncedValue(technique, 120);
  const [page, setPage] = useState(0);
  const [manage, setManage] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  useEffect(() => { onDialogChange(manage); return () => onDialogChange(false); }, [manage, onDialogChange]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [viewport, viewportRect] = useResizeObserver<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const resultList = useRef<HTMLDivElement>(null);
  const settings = useQuery({ queryKey: ["file-search-settings"], queryFn: () => get<Settings>("/api/import-search/settings"), refetchInterval: 2000 });
  const config = settings.data?.config;
  const query = useQuery({
    queryKey: ["indexed-source-search", queryText, root, format, supplier, queryTechnique, page, config],
    queryFn: () => {
      const params = new URLSearchParams({ q: queryText, offset: String(page * 100) });
      if (root) params.set("root_id", root);
      if (format) params.set("extension", format);
      if (supplier) params.set("supplier", supplier);
      if (config?.metadata_enabled && queryTechnique) params.set("technique", queryTechnique);
      return get<FileSearchResults>(`/api/import-search/results?${params}`);
    },
    enabled: Boolean(config?.roots.some((r) => r.enabled)),
    refetchInterval: settings.data?.roots.some((r) => ["scanning", "queued"].includes(r.status)) ? 2000 : false,
  });
  // Keep rows mounted during progress and completion refetches so focus survives.
  const progress = JSON.stringify(settings.data?.roots.map((r) => [r.id, r.status, r.count, r.pending, r.last_success]));
  const previousProgress = useRef(progress);
  useEffect(() => {
    if (previousProgress.current !== progress && config?.roots.some((r) => r.enabled)) void query.refetch();
    previousProgress.current = progress;
  }, [progress, config, query.refetch]);
  useEffect(() => { void post("/api/import-search/refresh", { due_only: true }); }, []);
  useEffect(() => { setPage(0); setAnchor(null); viewport.current?.scrollTo({ top: 0 }); setScrollTop(0); }, [queryText, root, format, supplier, queryTechnique]);
  useEffect(() => { viewport.current?.scrollTo({ top: 0 }); setScrollTop(0); }, [page]);
  const files: IndexedFile[] = (query.data?.items ?? []).map((file) => ({ ...file, kind: "file" }));
  const available = files.filter(indexedFileAvailable);
  const rowHeight = 88;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  const lastRow = Math.min(files.length, firstRow + Math.ceil((viewportRect.height || 176) / rowHeight) + 5);
  const focusedRow = files.findIndex((file) => file.path === focused);
  const visibleRows = [...new Set([
    ...Array.from({ length: Math.max(0, lastRow - firstRow) }, (_, index) => firstRow + index),
    ...(focusedRow >= 0 ? [focusedRow] : []),
  ])].sort((a, b) => a - b);
  const moveFocus = (index: number) => {
    const file = files[Math.max(0, Math.min(files.length - 1, index))];
    if (!file) return;
    const y = Math.max(0, files.indexOf(file) * rowHeight - (viewportRect.height >= rowHeight * 2 ? rowHeight : 0));
    viewport.current?.scrollTo({ top: y });
    setScrollTop(y);
    setFocused(file.path);
    requestAnimationFrame(() => {
      const row = resultList.current?.querySelector<HTMLElement>(`[data-row-index="${files.indexOf(file)}"]`);
      row?.focus({ preventScroll: true });
    });
  };
  const isSelected = (file: IndexedFile) => [...selected.keys()].some((path) => importPathsEqual(path, file.path));
  const select = (file: IndexedFile, shiftKey = false, include = false) => {
    if (!indexedFileAvailable(file)) return;
    // Canonical catalog dedup covers overlapping roots; normalize existing staged keys across scopes.
    const normalized = new Map(selected);
    for (const candidate of available) {
      const alias = [...normalized.keys()].find((path) => importPathsEqual(path, candidate.path));
      if (alias && alias !== candidate.path) { normalized.delete(alias); normalized.set(candidate.path, candidate); }
    }
    const next = include ? normalized.set(file.path, file)
      : toggleImportFileSelection(file, available, normalized, anchor, { shiftKey }).selected;
    setAnchor(file.path);
    onSelection(next, files);
  };
  const selectPage = (clear = false) => {
    const next = new Map(selected);
    for (const file of available) {
      const alias = [...next.keys()].find((path) => importPathsEqual(path, file.path));
      if (clear && alias) next.delete(alias);
      else if (!clear && !alias) next.set(file.path, file);
    }
    onSelection(next, files);
  };
  const enabledRoots = config?.roots.filter((r) => r.enabled) ?? [];
  const incomplete = query.data?.roots.filter((r) => enabledRoots.some((root) => root.id === r.id) && r.status !== "ready") ?? [];
  return <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
    <Group wrap="nowrap"><TextInput size="xs" aria-label="Search indexed locations" placeholder={config?.metadata_enabled ? "Search names, paths, barcode, remarks…" : "Search names and paths…"} leftSection={<IconSearch size={16} />} value={text} onChange={(event) => setText(event.currentTarget.value)} style={{ flex: 1, minWidth: 0 }} /><Button size="xs" variant="default" leftSection={<IconSettings size={16} />} onClick={() => setManage(true)}>Manage locations</Button></Group>
    <Group gap={6}><Select size="xs" aria-label="Search location filter" placeholder="All locations" clearable data={enabledRoots.map((r) => ({ value: r.id, label: r.path }))} value={root} onChange={setRoot} style={{ flex: "1 1 110px", minWidth: 0 }} /><Select size="xs" aria-label="Search format filter" placeholder="All formats" clearable data={config?.formats ?? []} value={format} onChange={setFormat} style={{ flex: "1 1 95px", minWidth: 0 }} /><Select size="xs" aria-label="Search supplier filter" placeholder="All suppliers" clearable data={["Neware", "BioLogic"]} value={supplier} onChange={setSupplier} style={{ flex: "1 1 105px", minWidth: 0 }} />{config?.metadata_enabled && <TextInput size="xs" aria-label="Exact technique filter" placeholder="Technique (exact)" value={technique} onChange={(event) => setTechnique(event.currentTarget.value)} style={{ flex: "1 1 110px", minWidth: 0 }} />}</Group>
    <Tooltip label="Shift-click selects a range; double-click includes. Ctrl+A selects this page. Search never imports a file."><Text size="xs" c="dimmed">Click to preview / Space or Ctrl-click to include</Text></Tooltip>
    {incomplete.length > 0 && <Tooltip label="Results may be incomplete while locations are indexing, paused, or unavailable. Last known files remain searchable."><Text size="xs" c="dimmed">{incomplete.length} location{incomplete.length === 1 ? "" : "s"} indexing, paused, or unavailable</Text></Tooltip>}
    {query.isError && <Alert color="red">Search could not be loaded. <Button variant="subtle" onClick={() => void query.refetch()}>Retry</Button></Alert>}
    {!enabledRoots.length ? <Paper withBorder p="lg"><Stack align="center"><Text size="sm">Choose folders to search, including network locations. Only NDAX, MPR and structured Neware Excel sources are indexed.</Text><Button onClick={() => setManage(true)}>Add a search location</Button></Stack></Paper> : <>
      <Group justify="space-between"><Text size="xs" c="dimmed" role="status" data-search-query={!query.isFetching && query.data ? queryText : undefined}>{query.isPending ? "Searching…" : `${query.data?.total ?? 0} results`}</Text><Button size="xs" variant="subtle" disabled={!available.length} onClick={() => selectPage(available.every(isSelected))}>{available.length && available.every(isSelected) ? "Clear this page" : "Select this page"}</Button></Group>
      <ScrollArea viewportRef={viewport} onScrollPositionChange={({ y }) => setScrollTop(y)} viewportProps={{ role: "listbox", "aria-label": "Indexed file results", "aria-multiselectable": true }} style={{ flex: 1, minHeight: 0 }} offsetScrollbars scrollbarSize={12}><Box ref={resultList} style={{ height: files.length * rowHeight + 12, minHeight: !files.length ? 60 : undefined, position: "relative" }}>
        {visibleRows.map((rowIndex) => { const file = files[rowIndex]; return <Box key={file.canonical} data-row-index={rowIndex} role="option" aria-posinset={rowIndex + 1} aria-setsize={files.length} aria-selected={isSelected(file)} aria-label={`${file.name}. ${indexedFileStatus(file)}`} tabIndex={0}
          onFocus={() => setFocused(file.path)} onClick={(event) => { setFocused(file.path); onPreview(file); if (!event.shiftKey) setAnchor(file.path); if (event.ctrlKey || event.metaKey || event.shiftKey) select(file, event.shiftKey); }}
          onDoubleClick={(event) => { event.preventDefault(); select(file, false, true); }}
          onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(rowIndex + (event.key === "ArrowDown" ? 1 : -1)); } if (event.key === "Enter") { event.preventDefault(); onPreview(file); } if (event.key === " ") { event.preventDefault(); select(file, event.shiftKey); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selectPage(); } }}
          px="xs" py={8} style={{ position: "absolute", top: rowIndex * rowHeight, height: rowHeight, width: "100%", boxSizing: "border-box", userSelect: "none", cursor: "pointer", borderBottom: "1px solid var(--mantine-color-default-border)", background: isSelected(file) ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : focused === file.path ? "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))" : undefined }}>
          <Group wrap="nowrap" gap="xs"><Checkbox aria-label={`Include ${file.name}`} disabled={!indexedFileAvailable(file)} checked={isSelected(file)} onClick={(event) => event.stopPropagation()} onChange={() => select(file)} /><Stack gap={2} style={{ flex: 1, minWidth: 0 }}><Tooltip label={file.path}><Text size="sm" fw={500} c={file.registered ? "dimmed" : undefined} truncate>{file.name}</Text></Tooltip><Text size="xs" c="dimmed" truncate title={file.path}>{file.relative_path} · {file.root_path}</Text>{Object.keys(file.metadata).length > 0 && <Text size="xs" c="dimmed" truncate title={Object.entries(file.metadata).map(([k, v]) => `${k}: ${v}`).join(" · ")}>{Object.values(file.metadata).join(" · ")}</Text>}</Stack><Stack gap={2} align="flex-end"><Text size="xs" c="dimmed">{((file.size ?? 0) / 1048576).toFixed(2)} MB · {file.extension}</Text><Text size="xs" c="dimmed" title={file.modified_at ?? undefined}>{file.modified_at ? new Date(file.modified_at).toLocaleDateString() : ""}</Text><Badge size="xs" variant="light" color="gray">{indexedFileStatus(file)}</Badge></Stack></Group>
        </Box>; })}
        {!query.isPending && !files.length && <Text size="sm" c="dimmed" ta="center" py="xl">No matching indexed files. Try fewer terms or check your search locations.</Text>}
      </Box></ScrollArea>
      <Group justify="space-between"><Button size="xs" variant="default" disabled={!page} onClick={() => setPage((p) => p - 1)}>Previous</Button><Text size="xs" c="dimmed">Page {page + 1} · Up to 100 files per page</Text><Button size="xs" variant="default" disabled={!query.data?.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button></Group>
    </>}
    <Modal opened={manage} closeOnEscape={!settingsDialogOpen} closeOnClickOutside={!settingsDialogOpen} onClose={() => setManage(false)} title="Search locations" size="lg"><FileSearchSettings initialPath={currentPath} onDialogChange={setSettingsDialogOpen} /></Modal>
  </Stack>;
}
