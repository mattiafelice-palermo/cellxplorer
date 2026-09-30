import { Alert, Badge, Button, Checkbox, Group, Modal, Paper, Select, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFolderPlus, IconRefresh, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { get, post, put } from "../api";
import type { FileSearchConfig, FileSearchSettings as Settings } from "../importSearch";

const FolderPicker = lazy(() => import("./ImportFilesystemPickerModal").then((module) => ({ default: module.ImportFilesystemPickerModal })));

export function FileSearchSettings({ initialPath, onDialogChange }: { initialPath?: string | null; onDialogChange?: (opened: boolean) => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["file-search-settings"], queryFn: () => get<Settings>("/api/import-search/settings"), refetchInterval: 2000 });
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState(initialPath ?? "");
  const [browse, setBrowse] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  useEffect(() => { onDialogChange?.(adding || rebuilding || browse); return () => onDialogChange?.(false); }, [adding, rebuilding, browse, onDialogChange]);
  const mutation = useMutation({
    mutationFn: (config: FileSearchConfig) => put<Settings>("/api/import-search/settings", config),
    onSuccess: (result) => { queryClient.setQueryData(["file-search-settings"], result); setAdding(false); },
    onError: (error: Error) => notifications.show({ color: "red", message: error.message }),
  });
  const operation = useMutation({
    mutationFn: ({ url, body }: { url: string; body?: unknown }) => post(url, body ?? {}),
    onSuccess: () => { setRebuilding(false); void queryClient.invalidateQueries({ queryKey: ["file-search-settings"] }); },
    onError: (error: Error) => notifications.show({ color: "red", message: error.message }),
  });
  const config = query.data?.config;
  const save = (patch: Partial<FileSearchConfig>) => config && mutation.mutate({ ...config, ...patch });
  const busy = mutation.isPending || operation.isPending;
  return <Stack gap="md">
    <Group justify="space-between"><div><Title order={4}>File search</Title><Text size="sm" c="dimmed">Find sources across the folders you choose, including network locations.</Text></div><IconSearch size={20} /></Group>
    <Text size="sm" c="dimmed">The search catalog stays on this computer. Initial scanning and source previews run separately from search. No external search service or installation is needed.</Text>
    {query.isError && <Alert color="red">Could not load search settings. <Button variant="subtle" onClick={() => void query.refetch()}>Retry</Button></Alert>}
    {config && <>
      <Group><Button leftSection={<IconFolderPlus size={16} />} onClick={() => { setPath(initialPath ?? ""); setAdding(true); }}>Add search location</Button>{initialPath && <Button variant="default" disabled={busy} onClick={() => save({ roots: [...config.roots, { id: crypto.randomUUID(), path: initialPath, enabled: true }] })}>Add current folder</Button>}<Button variant="default" leftSection={<IconRefresh size={16} />} disabled={busy || !config.roots.length} onClick={() => operation.mutate({ url: "/api/import-search/refresh" })}>Refresh all</Button><Button variant="default" disabled={busy} onClick={() => save({ paused: !config.paused })}>{config.paused ? "Resume indexing" : "Pause indexing"}</Button></Group>
      {!config.roots.length && <Paper withBorder p="md"><Text size="sm">No search locations yet. Add a folder to build its searchable catalog.</Text></Paper>}
      {config.roots.map((root) => {
        const state = query.data?.roots.find((item) => item.id === root.id);
        return <Paper key={root.id} withBorder p="sm"><Stack gap="xs">
          <Group wrap="nowrap"><Switch aria-label={`Enable ${root.path}`} checked={root.enabled} disabled={busy} onChange={(event) => save({ roots: config.roots.map((r) => r.id === root.id ? { ...r, enabled: event.currentTarget.checked } : r) })} /><Text size="sm" fw={600} style={{ flex: 1, overflowWrap: "anywhere" }}>{root.path}</Text><Badge variant="light" color={state?.status === "ready" ? undefined : "gray"}>{!root.enabled ? "Disabled" : state?.status?.replaceAll("_", " ") ?? "Queued"}</Badge></Group>
          <Group justify="space-between"><Text size="xs" c="dimmed">{state?.count ?? 0} files · {state?.pending ?? 0} pending{state?.last_success ? ` · Updated ${new Date(state.last_success).toLocaleString()}` : " · Not scanned yet"}</Text><Group gap="xs"><Button size="xs" variant="default" disabled={busy || !root.enabled} onClick={() => operation.mutate({ url: "/api/import-search/refresh", body: { root_id: root.id } })}>Rescan</Button><Button size="xs" variant="subtle" leftSection={<IconTrash size={14} />} disabled={busy} onClick={() => save({ roots: config.roots.filter((r) => r.id !== root.id) })}>Remove</Button></Group></Group>
          {state?.message && <Text size="xs" c="dimmed">{state.message}</Text>}
        </Stack></Paper>;
      })}
      <Paper withBorder p="md"><Stack gap="md">
        <Checkbox.Group label="Indexed formats" value={config.formats} onChange={(formats) => save({ formats })}><Group mt="xs">{[".ndax", ".mpr", ".xlsx"].map((format) => <Checkbox key={format} disabled={busy} value={format} label={format === ".xlsx" ? "Structured Neware .xlsx" : format} />)}</Group></Checkbox.Group>
        <Switch label="Search source metadata" description="Barcode, remarks, part number, start time and technique when the source header provides them. Disabling this stops enrichment and hides metadata matches; workbook format checks continue." checked={config.metadata_enabled} disabled={busy} onChange={(event) => save({ metadata_enabled: event.currentTarget.checked })} />
        <Select label="Refresh when indexed search opens" description="Runs in the background only when this interval has elapsed since the last attempt." data={[{ value: "0", label: "Manual only" }, { value: "24", label: "After 24 hours" }, { value: "72", label: "After 3 days" }, { value: "168", label: "After 1 week" }]} value={String(config.refresh_hours)} disabled={busy} onChange={(value) => save({ refresh_hours: Number(value) })} />
        <Group justify="space-between"><Text size="xs" c="dimmed">Removing a location or rebuilding only changes the search catalog. Your source files and Cell Database are preserved.</Text><Button variant="default" disabled={busy} onClick={() => setRebuilding(true)}>Rebuild catalog</Button></Group>
      </Stack></Paper>
      <Modal opened={adding} closeOnEscape={!browse} closeOnClickOutside={!browse} onClose={() => setAdding(false)} title="Add search location">
        <Stack><Text size="sm" c="dimmed">Choose a root folder. Subfolders are scanned without following links or junctions.</Text><TextInput label="Folder path" placeholder="C:\\Data or \\\\server\\share\\cycling" value={path} onChange={(event) => setPath(event.currentTarget.value)} /><Group justify="space-between"><Button variant="default" onClick={() => setBrowse(true)}>Browse folders</Button><Button loading={mutation.isPending} disabled={!path.trim()} onClick={() => save({ roots: [...config.roots, { id: crypto.randomUUID(), path: path.trim(), enabled: true }] })}>Add location</Button></Group></Stack>
      </Modal>
      <Modal opened={rebuilding} onClose={() => setRebuilding(false)} title="Rebuild search catalog"><Stack><Text size="sm">Recreate indexed file information from enabled search locations? Search results will return as scanning progresses.</Text><Group justify="flex-end"><Button variant="default" onClick={() => setRebuilding(false)}>Cancel</Button><Button loading={operation.isPending} onClick={() => operation.mutate({ url: "/api/import-search/rebuild" })}>Rebuild</Button></Group></Stack></Modal>
      {browse && <Suspense fallback={<Text size="sm">Opening folder picker…</Text>}><FolderPicker opened loading={false} mode="folder" initialPath={path || initialPath} onClose={() => setBrowse(false)} onFolderConfirm={(folder) => { setPath(folder); setBrowse(false); }} /></Suspense>}
    </>}
    <Text size="xs" c="dimmed">Indexing progress appears in Activity Center → Processing. Offline locations retain their last known results.</Text>
  </Stack>;
}
