import { Alert, Button, Group, Popover, ScrollArea, Select, Stack, Text, TextInput } from "@mantine/core";
import { IconChevronDown, IconDeviceFloppy } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../api";
import { activeSearchFilters, type SavedSearch, type SearchFilters } from "../importSearchFilters";

/** Saved searches belong to the source-search toolbar, separate from field discovery. */
export function SavedSearchMenu({ active, queryText, filters, onLoad, onPopupChange }: {
  active: boolean; queryText: string; filters: SearchFilters; onLoad: (q: string, filters: SearchFilters) => void;
  onPopupChange: (opened: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [choicesOpen, setChoicesOpen] = useState(false);
  useEffect(() => { onPopupChange(active && opened); return () => onPopupChange(false); }, [active, opened, onPopupChange]);
  useEffect(() => { if (!active) { setOpened(false); setChoicesOpen(false); } }, [active]);
  useEffect(() => {
    if (!active || !opened) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The owner disables its Escape listener while this popup is open:
      // window capture listeners otherwise run in registration order.
      event.preventDefault(); event.stopImmediatePropagation();
      if (choicesOpen) setChoicesOpen(false);
      else setOpened(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [active, opened, choicesOpen]);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const client = useQueryClient();
  const presets = useQuery({ queryKey: ["indexed-search-presets"], queryFn: () => get<SavedSearch[]>("/api/import-search/presets"), enabled: active });
  const save = useMutation({ mutationFn: (value: SavedSearch[]) => put<SavedSearch[]>("/api/import-search/presets", value), onSuccess: (value) => { client.setQueryData(["indexed-search-presets"], value); setName(""); if (chosen && !value.some((entry) => entry.id === chosen)) setChosen(null); } });
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" shadow="md" withArrow returnFocus trapFocus closeOnEscape={false}>
    <Popover.Target><Button size="sm" variant="default" aria-expanded={opened} aria-label="Save search menu" leftSection={<IconDeviceFloppy size={16} />} rightSection={<IconChevronDown size={14} />} onClick={() => setOpened((value) => !value)}>Save search</Button></Popover.Target>
    <Popover.Dropdown style={{ width: "min(calc(320px * var(--cellxplorer-ui-zoom, 1)), calc(100vw - 32px))" }}>
      <ScrollArea.Autosize mah="65vh" offsetScrollbars><Stack gap="sm" style={{ zoom: "var(--cellxplorer-ui-zoom, 1)" }}>
        <Text size="sm" fw={700}>Saved searches</Text>
        <TextInput data-autofocus label="Save current search as" size="sm" placeholder="Search name" value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim() && presets.isSuccess && !save.isPending && (presets.data?.length ?? 0) < 30) save.mutate([...(presets.data ?? []), { id: crypto.randomUUID(), name: name.trim(), q: queryText, filters: activeSearchFilters(filters) }]); }} />
        <Button size="sm" variant="filled" loading={save.isPending} disabled={!name.trim() || !presets.isSuccess || (presets.data?.length ?? 0) >= 30} onClick={() => save.mutate([...(presets.data ?? []), { id: crypto.randomUUID(), name: name.trim(), q: queryText, filters: activeSearchFilters(filters) }])}>Save current search</Button>
        {(presets.data?.length ?? 0) >= 30 && <Text size="sm" c="dimmed">30 saved searches. Delete one to save another.</Text>}
        <Select label="Saved search" placeholder={presets.isPending ? "Loading searches…" : "Choose a search"} searchable clearable size="sm" comboboxProps={{ withinPortal: false }} dropdownOpened={choicesOpen} onDropdownOpen={() => setChoicesOpen(true)} onDropdownClose={() => setChoicesOpen(false)} disabled={!presets.isSuccess} value={chosen} data={presets.data?.map((entry) => ({ value: entry.id, label: entry.name })) ?? []} onChange={setChosen} />
        <Group gap="xs"><Button size="sm" variant="default" disabled={!chosen || save.isPending} onClick={() => { const entry = presets.data?.find((value) => value.id === chosen); if (entry) { onLoad(entry.q, entry.filters); setOpened(false); } }}>Load search</Button><Button size="sm" variant="subtle" color="red" disabled={!chosen || save.isPending} onClick={() => save.mutate((presets.data ?? []).filter((entry) => entry.id !== chosen))}>Delete</Button></Group>
        {presets.isError && <Alert color="red">Saved searches could not be loaded. <Button variant="subtle" onClick={() => void presets.refetch()}>Retry</Button></Alert>}
        {save.isError && <Alert color="red">{save.error instanceof Error ? save.error.message : "Saved search could not be updated."}</Alert>}
      </Stack></ScrollArea.Autosize>
    </Popover.Dropdown>
  </Popover>;
}
