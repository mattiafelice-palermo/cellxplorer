import { ActionIcon, Alert, Badge, Button, Checkbox, Group, Highlight, Paper, ScrollArea, Select, Stack, Text, TextInput, Tooltip, Box } from "@mantine/core";
import { useDebouncedValue, useResizeObserver } from "@mantine/hooks";
import { IconArrowLeft, IconFolder, IconInfoCircle, IconSearch, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { get, post, type ImportBrowseEntry } from "../api";
import { importPathsEqual } from "../importPathBreadcrumbs";
import { toggleImportFileSelection } from "../importBrowserSelection";
import { indexedFileAvailable, indexedFileStatus, indexedMatchExplanation, searchLocationName, searchRootStatus, type FileSearchResults, type FileSearchSettings as Settings, type IndexedFile } from "../importSearch";
import { FileSearchSettings } from "./FileSearchSettings";

export function IndexedSourceSearch({ active, selected, currentPath, onPreview, onSelection, onDialogChange, onReveal }: {
  active: boolean; onReveal: (file: IndexedFile) => void;
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
  const [technique, setTechnique] = useState<string | null>(null);
  const queryTechnique = technique;
  const [page, setPage] = useState(0);
  const [manage, setManage] = useState(false);
  const [addImmediately, setAddImmediately] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  useEffect(() => { onDialogChange(active && (manage || settingsDialogOpen)); return () => onDialogChange(false); }, [active, manage, settingsDialogOpen, onDialogChange]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (active && manage && !settingsDialogOpen && event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); setManage(false);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [active, manage, settingsDialogOpen]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [viewport, viewportRect] = useResizeObserver<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const resultList = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCallback = useRef(onPreview);
  previewCallback.current = onPreview;
  useEffect(() => () => { if (previewTimer.current) clearTimeout(previewTimer.current); }, []);
  useEffect(() => { if (!active && previewTimer.current) clearTimeout(previewTimer.current); }, [active]);
  const preview = (file: IndexedFile, delayed = false) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (delayed) previewTimer.current = setTimeout(() => previewCallback.current(file), 80);
    else previewCallback.current(file);
  };
  const settings = useQuery({ queryKey: ["file-search-settings"], queryFn: () => get<Settings>("/api/import-search/settings"), enabled: active, refetchInterval: active ? 2000 : false });
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
    enabled: active && Boolean(config?.roots.some((r) => r.enabled)),
    refetchInterval: active && settings.data?.roots.some((r) => ["scanning", "queued"].includes(r.status)) ? 2000 : false,
  });
  // Keep rows mounted during progress and completion refetches so focus survives.
  const progress = JSON.stringify(settings.data?.roots.map((r) => [r.id, r.status, r.count, r.pending, r.last_success]));
  const previousProgress = useRef(progress);
  useEffect(() => {
    if (active && previousProgress.current !== progress && config?.roots.some((r) => r.enabled)) void query.refetch();
    previousProgress.current = progress;
  }, [active, progress, config, query.refetch]);
  useEffect(() => { if (active) void post("/api/import-search/refresh", { due_only: true }).catch(() => undefined); }, [active]);
  useEffect(() => {
    if (!config) return;
    if (root && !config.roots.some((r) => r.enabled && r.id === root)) setRoot(null);
    if (format && !config.formats.includes(format)) setFormat(null);
    if (!config.metadata_enabled) setTechnique(null);
  }, [config, root, format]);
  useEffect(() => { setPage(0); setAnchor(null); viewport.current?.scrollTo({ top: 0 }); setScrollTop(0); }, [queryText, root, format, supplier, queryTechnique]);
  useEffect(() => { viewport.current?.scrollTo({ top: 0 }); setScrollTop(0); }, [page]);
  useEffect(() => { if (active && !manage) requestAnimationFrame(() => viewport.current?.scrollTo({ top: scrollTop })); }, [active, manage]);
  useEffect(() => { if (query.data && page && page * 100 >= query.data.total) setPage(Math.max(0, Math.ceil(query.data.total / 100) - 1)); }, [query.data, page]);
  const files: IndexedFile[] = (query.data?.items ?? []).map((file) => ({ ...file, kind: "file", root_status: settings.data?.roots.find((r) => r.id === file.root_id)?.status ?? file.root_status }));
  const available = files.filter(indexedFileAvailable);
  const rowHeight = 76;
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
    preview(file, true);
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
  const incomplete = settings.data?.roots.filter((r) => enabledRoots.some((root) => root.id === r.id) && r.status !== "ready") ?? [];
  const highlights = queryText.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const total = query.data?.total ?? 0;
  return <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
    {manage ? <>
      <Group justify="space-between"><Text fw={700} size="sm">Search locations</Text><Button size="sm" variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={() => setManage(false)}>Back to results</Button></Group>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} offsetScrollbars><FileSearchSettings compact initialBrowse={addImmediately} initialPath={currentPath} onDialogChange={setSettingsDialogOpen} /></ScrollArea>
    </> : <>
    <Group wrap="nowrap"><TextInput size="sm" aria-label="Search indexed locations" placeholder={config?.metadata_enabled ? "Search names, folders, barcode, remarks…" : "Search names and folders…"} leftSection={<IconSearch size={16} />} value={text} onChange={(event) => setText(event.currentTarget.value)} style={{ flex: 1, minWidth: 0 }} /><Tooltip label="Search matches filenames, folders and source-export headers: barcode, remarks, part number, start time and technique. A header field is reported by the source file; it is not the editable Cell name or notes. For example, ‘Part number’ is a label stored in the instrument export; CellXplorer preserves it without inferring its meaning." multiline w={340} withArrow events={{ hover: true, focus: true, touch: false }}><ActionIcon variant="subtle" size="sm" aria-label="Explain searchable metadata"><IconInfoCircle size={16} /></ActionIcon></Tooltip><Button size="sm" variant="default" leftSection={<IconSettings size={16} />} onClick={() => { setAddImmediately(false); setManage(true); }}>Locations</Button></Group>
    <Group gap={6}>
      <Select size="sm" aria-label="Search location filter" placeholder="All locations" clearable searchable data={enabledRoots.map((r) => ({ value: r.id, label: searchLocationName(r.path) + (enabledRoots.filter((other) => searchLocationName(other.path) === searchLocationName(r.path)).length > 1 ? ` — ${r.path}` : "") }))} value={root} onChange={setRoot} style={{ flex: "1 1 130px", minWidth: 0 }} />
      <Select size="sm" aria-label="Search format filter" placeholder="All formats" clearable data={config?.formats ?? []} value={format} onChange={setFormat} style={{ flex: "1 1 100px", minWidth: 0 }} />
      <Select size="sm" aria-label="Search supplier filter" placeholder="All suppliers" clearable data={["Neware", "BioLogic"]} value={supplier} onChange={setSupplier} style={{ flex: "1 1 110px", minWidth: 0 }} />
      {config?.metadata_enabled && <Select size="sm" searchable clearable aria-label="Search technique filter" placeholder="All techniques" data={[...new Set([...(query.data?.techniques ?? []), ...(technique ? [technique] : [])])]} value={technique} onChange={setTechnique} style={{ flex: "1 1 110px", minWidth: 0 }} />}
      {(root || format || supplier || technique) && <Button size="compact-sm" variant="subtle" onClick={() => { setRoot(null); setFormat(null); setSupplier(null); setTechnique(null); }}>Reset filters</Button>}
    </Group>
    {incomplete.length > 0 && <Group gap={6}>{incomplete.map((state) => <Tooltip key={state.id} label={state.message ?? `${state.count ?? 0} files indexed · ${state.pending ?? 0} awaiting metadata`} multiline w={300}><Button size="compact-xs" color={state.status === "offline" ? "red" : state.status === "needs_attention" ? "orange" : "gray"} variant="light" onClick={() => setManage(true)}>{searchLocationName(state.path)}: {searchRootStatus(state.status)}</Button></Tooltip>)}</Group>}
    {(query.isError || settings.isError) && <Alert color="red">Search could not be loaded. <Button variant="subtle" onClick={() => { void settings.refetch(); void query.refetch(); }}>Retry</Button></Alert>}
    {settings.isPending ? <Text size="sm" c="dimmed">Loading search locations…</Text> : !enabledRoots.length ? <Paper withBorder p="lg"><Stack align="center"><Text size="sm">{config?.roots.length ? "Your search locations are disabled." : "Add a folder to find files across its subfolders."}</Text><Button onClick={() => { setAddImmediately(!config?.roots.length); setManage(true); }}>{config?.roots.length ? "Enable search locations" : "Add a search location"}</Button></Stack></Paper> : <>
      <Group justify="space-between"><Tooltip label="Click or use arrows to preview. Space/Ctrl-click includes; Shift-click selects a range. Double-click includes. Ctrl+A selects this page."><Text size="xs" c="dimmed" role="status" data-search-query={!query.isFetching && query.data ? queryText : undefined}>{query.isPending ? "Searching…" : `${total} result${total === 1 ? "" : "s"}`} · Click to preview, Space to include</Text></Tooltip><Button size="compact-sm" variant="subtle" disabled={!available.length} onClick={() => selectPage(available.every(isSelected))}>{available.length && available.every(isSelected) ? "Clear this page" : "Select this page"}</Button></Group>
      <ScrollArea viewportRef={viewport} onScrollPositionChange={({ y }) => { if (active && !manage) setScrollTop(y); }} viewportProps={{ role: "listbox", "aria-label": "Indexed file results", "aria-multiselectable": true }} style={{ flex: 1, minHeight: 0 }} offsetScrollbars scrollbarSize={12}><Box ref={resultList} style={{ height: files.length * rowHeight + 12, minHeight: !files.length ? 60 : undefined, position: "relative" }}>
        {visibleRows.map((rowIndex) => { const file = files[rowIndex]; const explanation = indexedMatchExplanation(file, queryText); const folder = file.relative_path.replace(/[\\/][^\\/]*$/, ""); const status = indexedFileStatus(file); return <Box key={file.canonical} data-row-index={rowIndex} role="option" aria-posinset={rowIndex + 1} aria-setsize={files.length} aria-selected={isSelected(file)} aria-label={`${file.name}. ${status}`} tabIndex={0}
          onFocus={() => setFocused(file.path)} onClick={(event) => { setFocused(file.path); preview(file); if (!event.shiftKey) setAnchor(file.path); if (event.ctrlKey || event.metaKey || event.shiftKey) select(file, event.shiftKey); }}
          onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button,input,label")) return; event.preventDefault(); select(file, false, true); }}
          onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveFocus(event.key === "Home" ? 0 : event.key === "End" ? files.length - 1 : rowIndex + (event.key === "ArrowDown" ? 1 : -1)); } if (event.key === "Enter") { event.preventDefault(); preview(file); } if (event.key === " ") { event.preventDefault(); select(file, event.shiftKey); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selectPage(); } }}
          px="xs" py={6} style={{ position: "absolute", top: rowIndex * rowHeight, height: rowHeight, width: "100%", boxSizing: "border-box", userSelect: "none", cursor: "pointer", borderBottom: "1px solid var(--mantine-color-default-border)", background: isSelected(file) ? "var(--mantine-primary-color-light)" : focused === file.path ? "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))" : undefined }}>
          <Group wrap="nowrap" gap="xs">
            <Checkbox aria-label={`Include ${file.name}`} disabled={!indexedFileAvailable(file)} checked={isSelected(file)} onClick={(event) => event.stopPropagation()} onChange={() => select(file)} />
            <Stack gap={1} style={{ flex: 1, minWidth: 0 }}><Tooltip label={file.name}><Text size="sm" fw={500} c={file.registered || file.root_status === "offline" ? "dimmed" : undefined} truncate><Highlight component="span" highlight={highlights}>{file.name}</Highlight></Text></Tooltip><Text size="xs" c="dimmed" truncate title={file.path}>{searchLocationName(file.root_path)}{folder !== file.relative_path ? ` / ${folder}` : ""}</Text>{explanation && <Tooltip label={explanation} multiline w={420} withArrow events={{ hover: true, focus: true, touch: false }}><Text size="xs" c={queryText.trim() ? undefined : "dimmed"} truncate tabIndex={0} aria-label={explanation}><Highlight component="span" highlight={highlights}>{explanation}</Highlight></Text></Tooltip>}</Stack>
            <Stack gap={1} align="flex-end"><Text size="xs" c="dimmed">{((file.size ?? 0) / 1048576).toFixed(2)} MB</Text><Text size="xs" c="dimmed" title={file.modified_at ?? undefined}>{file.modified_at ? `Modified ${new Date(file.modified_at).toLocaleDateString()}` : ""}</Text><Badge size="xs" variant="light" color={file.root_status === "offline" ? "red" : file.metadata_state === "unavailable" ? "orange" : "gray"}>{status}</Badge></Stack>
            <Tooltip label="Show in folder"><ActionIcon size="sm" variant="subtle" aria-label={`Show ${file.name} in folder`} onClick={(event) => { event.stopPropagation(); onReveal(file); }}><IconFolder size={16} /></ActionIcon></Tooltip>
          </Group>
        </Box>; })}
        {!query.isPending && !files.length && <Text size="sm" c="dimmed" ta="center" py="xl">No matching files. Try fewer terms or reset the filters.</Text>}
      </Box></ScrollArea>
      {total > 100 && <Group justify="space-between"><Button size="xs" variant="default" disabled={!page} onClick={() => setPage((p) => p - 1)}>Previous</Button><Text size="xs" c="dimmed">{page * 100 + 1}–{Math.min((page + 1) * 100, total)} of {total}</Text><Button size="xs" variant="default" disabled={!query.data?.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button></Group>}
    </>}
    </>}
  </Stack>;
}
