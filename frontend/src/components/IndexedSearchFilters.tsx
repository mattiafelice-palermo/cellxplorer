import { Accordion, ActionIcon, Alert, Badge, Button, Checkbox, Group, NumberInput, ScrollArea, Select, type SelectProps, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconInfoCircle, IconSearch, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../api";
import type { FileSearchConfig } from "../importSearch";
import { DATE_FIELDS, FILTER_CATEGORIES, FILTER_FIELDS, FILTER_OPERATORS, RANGE_FIELDS, SORT_OPTIONS, activeSearchFilters, filterChips, filterExpansion, localDateInput, normalizedSearchSort, searchableFilterCategories, type SearchFilters, type SavedSearch, type TextCondition } from "../importSearchFilters";

function Help({ text, label }: { text: string; label: string }) {
  return <Tooltip label={text} multiline w={320} withArrow events={{ hover: true, focus: true, touch: false }}><ActionIcon size="sm" variant="subtle" aria-label={label}><IconInfoCircle size={15} /></ActionIcon></Tooltip>;
}
// Menus are portalled outside the zoomed modal; scale their contents, not their
// positioning box, so Floating UI keeps the dropdown aligned with its input.
function FilterSelect(props: SelectProps) {
  return <Select {...props} classNames={{ dropdown: "cx-indexed-filter-dropdown" }} />;
}
const YES_NO = [{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const UNKNOWN = [{ value: "exclude", label: "Known values only" }, { value: "include", label: "Include unknown values" }, { value: "only", label: "Unknown values only" }];

export function IndexedSearchFilters({ filters, onChange, config, techniques, relationships, queryText, onLoadSearch, active }: {
  filters: SearchFilters; onChange: (next: SearchFilters) => void; config?: FileSearchConfig; techniques: string[];
  relationships?: { analyses: { id: number; name: string }[]; replicates: { id: number; name: string }[] };
  queryText: string; onLoadSearch: (q: string, filters: SearchFilters) => void; active: boolean;
}) {
  const [find, setFind] = useState("");
  const [expanded, setExpanded] = useState<string[]>(["file"]);
  const viewport = useRef<HTMLDivElement>(null);
  // Filtering changes the content height; reset the previous section's scroll offset.
  // Keep manual expansion separately so clearing discovery restores the user's sections.
  useEffect(() => { viewport.current?.scrollTo({ top: 0 }); }, [find]);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [patternField, setPatternField] = useState("filename");
  const [patternCase, setPatternCase] = useState(false);
  const [patternError, setPatternError] = useState<string | null>(null);
  const regex = filters.conditions?.find((c) => c.operator === "regex");
  useEffect(() => { setPattern(regex?.value ?? ""); setPatternField(regex?.field ?? "filename"); setPatternCase(regex?.case_sensitive ?? false); setPatternError(null); }, [regex]);
  const presets = useQuery({ queryKey: ["indexed-search-presets"], queryFn: () => get<SavedSearch[]>("/api/import-search/presets"), enabled: active });
  const client = useQueryClient();
  const save = useMutation({ mutationFn: (value: SavedSearch[]) => put<SavedSearch[]>("/api/import-search/presets", value), onSuccess: (value) => { client.setQueryData(["indexed-search-presets"], value); setName(""); } });
  const sections = searchableFilterCategories(find);
  const chips = filterChips(filters);
  const patch = (values: Partial<SearchFilters>) => onChange({ ...filters, ...values });
  const range = (key: string, values: Record<string, unknown>) => patch({ ranges: { ...filters.ranges, [key]: { ...filters.ranges?.[key], ...values } } });
  const textConditions = (filters.conditions ?? []).filter((c) => c.operator !== "regex");
  const setTextConditions = (value: TextCondition[]) => patch({ conditions: [...value, ...(regex ? [regex] : [])] });
  const textChange = (index: number, value: Partial<TextCondition>) => setTextConditions(textConditions.map((c, i) => i === index ? { ...c, ...value } : c));
  const facet = (key: "root_id" | "extension" | "supplier" | "technique", label: string, data: { value: string; label: string }[] | string[], disabled = false) => <FilterSelect key={key} label={label} size="sm" searchable clearable disabled={disabled} value={filters[key] ?? null} data={data} onChange={(value) => patch({ [key]: value ?? undefined })} />;
  return <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
    <TextInput aria-label="Search filters" placeholder="Find a filter… cycles, date, filename" style={{ flexShrink: 0 }} leftSection={<IconSearch size={16} />} size="sm" value={find} onChange={(e) => setFind(e.currentTarget.value)} rightSection={find ? <ActionIcon variant="subtle" size="sm" aria-label="Clear filter search" onClick={() => setFind("")}>×</ActionIcon> : null} />
    <Group gap="xs" style={{ flexShrink: 0 }}><Button variant="subtle" size="compact-sm" onClick={() => { setFind(""); setExpanded(FILTER_CATEGORIES.map((c) => c.id)); }}>Expand all</Button><Button variant="subtle" size="compact-sm" onClick={() => { setFind(""); setExpanded([]); }}>Collapse all</Button><Help label="About indexed filter values" text="Filters search local indexed facts and current database relationships. They never open cycling records. Missing or unindexed facts are Unknown. Source facts and editable Cell metadata are separate." /></Group>
    <ScrollArea viewportRef={viewport} offsetScrollbars style={{ flex: 1, minHeight: 0, overflow: "hidden" }} scrollbarSize={12} viewportProps={{ style: { overflowAnchor: "none" } }}>
      {!sections.length && <Text size="sm" c="dimmed" p="sm">No filter found. Try “date”, “cycles”, “analysis” or “text”.</Text>}
      <Accordion multiple value={filterExpansion(find, expanded)} onChange={(value) => { if (!find.trim()) setExpanded(value); }} variant="default" transitionDuration={find.trim() ? 0 : 150}>
        {sections.map((section) => <Accordion.Item key={section.id} value={section.id}>
          <Accordion.Control><Group gap="xs" wrap="nowrap"><Text size="sm" fw={600}>{section.label}</Text>{chips.some((c) => c.category === section.id) && <Badge size="sm" variant="light">{chips.filter((c) => c.category === section.id).length}</Badge>}</Group></Accordion.Control>
          <Accordion.Panel><Stack gap="sm">
            {section.id === "file" && <>
              {facet("root_id", "Search location", config?.roots.filter((r) => r.enabled).map((r) => ({ value: r.id, label: r.path })) ?? [])}
              {facet("extension", "File format", config?.formats ?? [])}
              {facet("supplier", "Supplier", ["Neware", "BioLogic"])}
            </>}
            {RANGE_FIELDS.filter((f) => f.category === section.id).map((field) => {
              const value = filters.ranges?.[field.key] ?? {};
              return <Stack key={field.key} gap={4}><Group gap={4}><Text size="sm" fw={500}>{field.label} ({field.unit})</Text>{section.id === "cycling" && <Help label={`About ${field.label}`} text="Only explicit cheap source-header values or already persisted facts for this exact source version are used. No records are read or calculated. Continued Cell totals are not used." />}</Group>
                <Group gap="xs" grow wrap="nowrap"><NumberInput aria-label={`${field.label} minimum`} placeholder="Minimum" size="sm" min={0} disabled={value.unknown === "only"} value={value.min == null ? "" : value.min / field.scale} onChange={(n) => range(field.key, { min: typeof n === "number" ? n * field.scale : undefined })} /><NumberInput aria-label={`${field.label} maximum`} placeholder="Maximum" size="sm" min={0} disabled={value.unknown === "only"} value={value.max == null ? "" : value.max / field.scale} onChange={(n) => range(field.key, { max: typeof n === "number" ? n * field.scale : undefined })} /></Group>
                <FilterSelect aria-label={`${field.label} missing values`} size="sm" value={value.unknown ?? "exclude"} data={UNKNOWN} onChange={(unknown) => range(field.key, { unknown })} />
              </Stack>;
            })}
            {section.id === "dates" && DATE_FIELDS.map((field) => {
              const value = filters.ranges?.[field.key] ?? {};
              return <Stack key={field.key} gap={4}>
                <Group gap={4}><Text size="sm" fw={500}>{field.label}</Text><Help label={`About ${field.label}`} text={field.key === "start_time" ? "The timestamp reported by the source header, distinct from filesystem dates. A timezone-less header is interpreted as UTC for indexing; displayed dates use your local time." : field.key === "file_created_at" ? "Filesystem creation time when supported. It may reflect a copied file rather than the start of the experiment." : "Filesystem modification time or the time this catalog first indexed the path. Displayed bounds use your local time."} /></Group>
                {(["min", "max"] as const).map((bound) => <TextInput key={bound} size="sm" type="datetime-local" label={bound === "min" ? "On or after" : "On or before"} aria-label={`${field.label} ${bound}`} value={localDateInput(value[bound])} disabled={value.unknown === "only"} onChange={(e) => range(field.key, { [bound]: e.currentTarget.value ? new Date(e.currentTarget.value).getTime() / 1000 + (bound === "max" ? 59.999 : 0) : undefined })} />)}
                <Group gap={4}>{[0, 7, 30].map((days) => <Button size="compact-xs" variant="subtle" key={days} onClick={() => { const date = new Date(); if (!days) date.setHours(0, 0, 0, 0); else date.setDate(date.getDate() - days); range(field.key, { min: date.getTime() / 1000, max: Date.now() / 1000, unknown: "exclude" }); }}>{days ? `Last ${days} days` : "Today"}</Button>)}</Group>
                <FilterSelect aria-label={`${field.label} missing values`} size="sm" value={value.unknown ?? "exclude"} data={UNKNOWN} onChange={(unknown) => range(field.key, { unknown })} />
              </Stack>;
            })}
            {section.id === "header" && <>
              {facet("technique", "Technique", [...new Set([...techniques, ...(filters.technique ? [filters.technique] : [])])], !config?.metadata_enabled)}
              <FilterSelect label="Add a header condition" size="sm" placeholder="Barcode, remarks, part number…" value={null} data={FILTER_FIELDS.filter((f) => ["barcode", "remarks", "part_number", "device_info", "channel"].includes(f.value))} disabled={!config?.metadata_enabled || textConditions.length >= 15} onChange={(field) => { if (field) { setTextConditions([...textConditions, { field, operator: "contains", value: "" }]); setFind(""); setExpanded((old) => [...new Set([...old, "text"])]); } }} />
              {!config?.metadata_enabled && <Text size="sm" c="dimmed">Source metadata indexing is disabled in Locations.</Text>}
            </>}
            {section.id === "app" && <>
              <Help label="About CellXplorer relationships" text="Matches known registered source paths, including resolved drive aliases. Copies elsewhere are not checksum-verified duplicates. Analysis and replicate membership belong to the linked Cell, including its whole source chain; per-plot visibility is separate." />
              {([['registered', 'Already in Cell Database'], ['analysis_usage', 'Used in an analysis'], ['replicate_usage', 'In a replicate group']] as const).map(([key, label]) => <FilterSelect key={key} label={label} size="sm" data={YES_NO} value={filters[key] ?? "any"} onChange={(value) => patch({ [key]: value ?? undefined })} />)}
              <FilterSelect label="Specific analysis" searchable clearable size="sm" data={relationships?.analyses.map((a) => ({ value: String(a.id), label: a.name })) ?? []} value={filters.analysis_id ? String(filters.analysis_id) : null} onChange={(value) => patch({ analysis_id: value ? Number(value) : undefined })} />
              <FilterSelect label="Specific replicate group" searchable clearable size="sm" data={relationships?.replicates.map((a) => ({ value: String(a.id), label: a.name })) ?? []} value={filters.replicate_id ? String(filters.replicate_id) : null} onChange={(value) => patch({ replicate_id: value ? Number(value) : undefined })} />
              <FilterSelect label="Add a Cell condition" placeholder="Name, notes or curated metadata…" size="sm" value={null} data={FILTER_FIELDS.filter((f) => f.value.startsWith("cell_"))} disabled={textConditions.length >= 15} onChange={(field) => { if (field) { setTextConditions([...textConditions, { field, operator: "contains", value: "" }]); setFind(""); setExpanded((old) => [...new Set([...old, "text"])]); } }} />
            </>}
            {section.id === "text" && <>
              <FilterSelect label="Combine text conditions" data={[{ value: "all", label: "Match all conditions" }, { value: "any", label: "Match any condition" }]} size="sm" value={filters.match ?? "all"} onChange={(value) => patch({ match: value === "any" ? "any" : "all" })} />
              {textConditions.map((condition, index) => <Stack gap={4} key={index}>
                <Group gap="xs" wrap="nowrap"><FilterSelect aria-label={`Condition ${index + 1} field`} size="sm" searchable data={FILTER_FIELDS} value={condition.field} onChange={(field) => textChange(index, { field: field ?? "any" })} style={{ flex: 1 }} /><Tooltip label="Remove condition"><ActionIcon variant="subtle" size="sm" aria-label={`Remove condition ${index + 1}`} onClick={() => setTextConditions(textConditions.filter((_, i) => i !== index))}><IconTrash size={15} /></ActionIcon></Tooltip></Group>
                <FilterSelect aria-label={`Condition ${index + 1} operator`} size="sm" data={FILTER_OPERATORS} value={condition.operator} onChange={(operator) => textChange(index, { operator: operator ?? "contains" })} />
                {!["present", "missing"].includes(condition.operator) && <TextInput aria-label={`Condition ${index + 1} text`} placeholder="Text to match" size="sm" value={condition.value} onChange={(e) => textChange(index, { value: e.currentTarget.value })} />}
                <Checkbox size="sm" label="Case sensitive" checked={Boolean(condition.case_sensitive)} onChange={(e) => textChange(index, { case_sensitive: e.currentTarget.checked })} />
              </Stack>)}
              <Button size="sm" variant="default" disabled={textConditions.length >= 15} onClick={() => setTextConditions([...textConditions, { field: "any", operator: "contains", value: "" }])}>Add condition</Button>
            </>}
            {section.id === "regex" && <>
              <Group gap={4}><Text size="sm" fw={500}>Regular expression</Text><Help label="About regular expressions" text="Pattern searches run only when applied, in an isolated process with a three-second limit. Narrow the search or simplify a pattern if it times out. This condition uses the text section’s all/any setting." /></Group>
              <FilterSelect label="Search field" size="sm" searchable data={FILTER_FIELDS} value={patternField} onChange={(v) => setPatternField(v ?? "filename")} />
              <TextInput label="Pattern" placeholder="e.g. BQV_[0-9]+" size="sm" value={pattern} onChange={(e) => setPattern(e.currentTarget.value)} error={patternError} maxLength={256} />
              <Checkbox label="Case sensitive" size="sm" checked={patternCase} onChange={(e) => setPatternCase(e.currentTarget.checked)} />
              <Group gap="xs"><Button size="sm" variant="default" onClick={() => { setPatternError(null); patch({ conditions: [...textConditions, ...(pattern ? [{ field: patternField, operator: "regex", value: pattern, case_sensitive: patternCase }] : [])] }); }}>Apply pattern</Button>{regex && <Button size="sm" variant="subtle" onClick={() => patch({ conditions: textConditions })}>Remove pattern</Button>}</Group>
            </>}
            {section.id === "folder" && <Help label="About indexed folder counts" text="Counts unique recognized compatible source paths in the immediate folder, across the chosen indexed scope, before result filters. These are catalog counts, not a fresh disk enumeration. Incomplete or offline indexing is labelled partial." />}
            {section.id === "saved" && <>
              <FilterSelect label="Sort results" size="sm" searchable value={normalizedSearchSort(filters.sort)} data={SORT_OPTIONS} onChange={(value) => patch({ sort: value ?? undefined })} />
              <FilterSelect label="Saved search" placeholder="Choose a search" searchable clearable size="sm" value={chosen} data={presets.data?.map((p) => ({ value: p.id, label: p.name })) ?? []} onChange={(id) => { setChosen(id); const saved = presets.data?.find((p) => p.id === id); if (saved) onLoadSearch(saved.q, saved.filters); }} />
              <TextInput label="Save current search as" size="sm" value={name} maxLength={80} onChange={(e) => setName(e.currentTarget.value)} />
              <Group gap="xs"><Button size="sm" variant="default" loading={save.isPending} disabled={!name.trim() || (presets.data?.length ?? 0) >= 30} onClick={() => save.mutate([...(presets.data ?? []), { id: crypto.randomUUID(), name: name.trim(), q: queryText, filters: activeSearchFilters(filters) }])}>Save search</Button>{chosen && <Button size="sm" variant="subtle" color="red" disabled={save.isPending} onClick={() => { save.mutate((presets.data ?? []).filter((p) => p.id !== chosen)); setChosen(null); }}>Delete saved search</Button>}</Group>
              {save.isError && <Alert color="red">{save.error instanceof Error ? save.error.message : "Saved search could not be updated."}</Alert>}
            </>}
          </Stack></Accordion.Panel>
        </Accordion.Item>)}
      </Accordion>
    </ScrollArea>
  </Stack>;
}
