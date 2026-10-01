import { Accordion, ActionIcon, Badge, Button, Checkbox, Group, NumberInput, ScrollArea, Select, type SelectProps, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconInfoCircle, IconSearch, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { DISCOVERY_FIELDS, discoverFilters, type DiscoveryMatch } from "../filterDiscovery";
import type { FileSearchConfig } from "../importSearch";
import { DATE_FIELDS, FILTER_CATEGORIES, FILTER_FIELDS, FILTER_OPERATORS, RANGE_FIELDS, SORT_OPTIONS, filterChips, localDateInput, normalizedSearchSort, type SearchFilters, type TextCondition } from "../importSearchFilters";

function Help({ text, label }: { text: string; label: string }) {
  return <Tooltip label={text} multiline w={320} withArrow events={{ hover: true, focus: true, touch: false }}><ActionIcon size="sm" variant="subtle" aria-label={label}><IconInfoCircle size={15} /></ActionIcon></Tooltip>;
}
// Menus are portalled outside the zoomed modal; scale their contents, not their
// positioning box, so Floating UI keeps the dropdown aligned with its input.
function FilterSelect(props: SelectProps) {
  return <Select {...props} classNames={{ dropdown: "cx-indexed-filter-dropdown" }} />;
}
function DiscoveryLabel({ match }: { match: DiscoveryMatch }) {
  const tokens = match.field.label.split(/(\s+)/);
  const reason = match.option ? `Matched option: ${match.term}` : match.kind === "synonym" ? `Also called: ${match.term}` : match.kind === "plural" ? "Matched singular/plural form" : null;
  return <Text component="span" size="sm" fw={400}>{tokens.map((token, index) => match.highlight.includes(token.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "")) ? <strong key={index}>{token}</strong> : token)}{reason && <Text component="span" size="xs" c="dimmed"> ({reason})</Text>}</Text>;
}
const YES_NO = [{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const UNKNOWN = [{ value: "exclude", label: "Known values only" }, { value: "include", label: "Include unknown values" }, { value: "only", label: "Unknown values only" }];

export function IndexedSearchFilters({ filters, onChange, config, techniques, relationships }: {
  filters: SearchFilters; onChange: (next: SearchFilters) => void; config?: FileSearchConfig; techniques: string[];
  relationships?: { analyses: { id: number; name: string }[]; replicates: { id: number; name: string }[] };
}) {
  const [find, setFind] = useState("");
  const [expanded, setExpanded] = useState<string[]>(["file"]);
  const viewport = useRef<HTMLDivElement>(null);
  // Filtering changes the content height; reset the previous section's scroll offset.
  // Keep manual expansion separately so clearing discovery restores the user's sections.
  useEffect(() => { viewport.current?.scrollTo({ top: 0 }); }, [find]);
  const [pattern, setPattern] = useState("");
  const [patternField, setPatternField] = useState("filename");
  const [patternCase, setPatternCase] = useState(false);
  const [patternError, setPatternError] = useState<string | null>(null);
  const regex = filters.conditions?.find((c) => c.operator === "regex");
  useEffect(() => { setPattern(regex?.value ?? ""); setPatternField(regex?.field ?? "filename"); setPatternCase(regex?.case_sensitive ?? false); setPatternError(null); }, [regex]);
  const discovery = discoverFilters(find, DISCOVERY_FIELDS.map((field) => ({ ...field, options:
    field.key === "extension" ? config?.formats ?? [] : field.key === "root_id" ? config?.roots.filter((root) => root.enabled).map((root) => root.path) :
    field.key === "technique" ? techniques : field.key === "analysis_id" ? relationships?.analyses.map((entry) => entry.name) :
    field.key === "replicate_id" ? relationships?.replicates.map((entry) => entry.name) : field.options })));
  const matches = new Map(discovery.matches.map((match) => [match.field.key, match]));
  const sections = FILTER_CATEGORIES.filter((section) => discovery.matches.some((match) => match.field.category === section.id));
  const show = (key: string) => matches.has(key);
  const label = (key: string) => <DiscoveryLabel match={matches.get(key)!} />;
  const options = (key: string, data: {value: string; label: string}[]) => {
    if (!find.trim() || !matches.get(key)?.option) return data;
    const found = discoverFilters(find, data.map((option) => ({ key: option.value, category: "option", label: option.label })));
    return data.filter((option) => found.matches.some((match) => match.field.key === option.value));
  };
  const chips = filterChips(filters);
  const patch = (values: Partial<SearchFilters>) => onChange({ ...filters, ...values });
  const range = (key: string, values: Record<string, unknown>) => patch({ ranges: { ...filters.ranges, [key]: { ...filters.ranges?.[key], ...values } } });
  const textConditions = (filters.conditions ?? []).filter((c) => c.operator !== "regex");
  const setTextConditions = (value: TextCondition[]) => patch({ conditions: [...value, ...(regex ? [regex] : [])] });
  const textChange = (index: number, value: Partial<TextCondition>) => setTextConditions(textConditions.map((c, i) => i === index ? { ...c, ...value } : c));
  const facet = (key: "root_id" | "extension" | "supplier" | "technique", label: string, data: { value: string; label: string }[] | string[], disabled = false) => show(key) ? <FilterSelect key={key} label={<DiscoveryLabel match={matches.get(key)!} />} size="sm" searchable clearable disabled={disabled} value={filters[key] ?? null} data={data} onChange={(value) => patch({ [key]: value ?? undefined })} /> : null;
  return <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
    <TextInput aria-label="Search filters" placeholder="Find a filter… cycles, date, filename" style={{ flexShrink: 0 }} leftSection={<IconSearch size={16} />} size="sm" value={find} onChange={(e) => setFind(e.currentTarget.value)} rightSection={find ? <ActionIcon variant="subtle" size="sm" aria-label="Clear filter search" onClick={() => setFind("")}>×</ActionIcon> : null} />
    {discovery.suggestion && <Text size="sm" c="dimmed" role="status" style={{ flexShrink: 0 }}>Closest matching term: <strong>{discovery.suggestion}</strong></Text>}
    <Group gap="xs" style={{ flexShrink: 0 }}><Button variant="subtle" size="compact-sm" onClick={() => { setFind(""); setExpanded(FILTER_CATEGORIES.map((c) => c.id)); }}>Expand all</Button><Button variant="subtle" size="compact-sm" onClick={() => { setFind(""); setExpanded([]); }}>Collapse all</Button><Help label="About indexed filter values" text="Filters search local indexed facts and current database relationships. They never open cycling records. Missing or unindexed facts are Unknown. Source facts and editable Cell metadata are separate." /></Group>
    <ScrollArea viewportRef={viewport} offsetScrollbars style={{ flex: 1, minHeight: 0, overflow: "hidden" }} scrollbarSize={12} viewportProps={{ style: { overflowAnchor: "none" } }}>
      {!sections.length && <Text size="sm" c="dimmed" p="sm">No filter found. Try “date”, “cycles”, “analysis” or “text”.</Text>}
      <Accordion multiple value={find.trim() ? sections.map((section) => section.id) : expanded} onChange={(value) => { if (!find.trim()) setExpanded(value); }} variant="separated" transitionDuration={find.trim() ? 0 : 150}>
        {sections.map((section) => <Accordion.Item key={section.id} value={section.id}>
          <Accordion.Control><Group gap="xs" wrap="nowrap"><Text size="sm" fw={600}>{section.label}</Text>{chips.some((c) => c.category === section.id) && <Badge size="sm" variant="light">{chips.filter((c) => c.category === section.id).length}</Badge>}</Group></Accordion.Control>
          <Accordion.Panel><Stack gap="sm">
            {section.id === "file" && <>
              {facet("root_id", "Search location", config?.roots.filter((r) => r.enabled).map((r) => ({ value: r.id, label: r.path })) ?? [])}
              {facet("extension", "File format", config?.formats ?? [])}
              {facet("supplier", "Supplier", ["Neware", "BioLogic"])}
            </>}
            {RANGE_FIELDS.filter((f) => f.category === section.id && show(f.key)).map((field) => {
              const value = filters.ranges?.[field.key] ?? {};
              return <Stack key={field.key} gap={4}><Group gap={4}><Text component="span" size="sm">{label(field.key)} ({field.unit})</Text>{section.id === "cycling" && <Help label={`About ${field.label}`} text="Only explicit cheap source-header values or already persisted facts for this exact source version are used. No records are read or calculated. Continued Cell totals are not used." />}</Group>
                <Group gap="xs" grow wrap="nowrap"><NumberInput aria-label={`${field.label} minimum`} placeholder="Minimum" size="sm" min={0} disabled={value.unknown === "only"} value={value.min == null ? "" : value.min / field.scale} onChange={(n) => range(field.key, { min: typeof n === "number" ? n * field.scale : undefined })} /><NumberInput aria-label={`${field.label} maximum`} placeholder="Maximum" size="sm" min={0} disabled={value.unknown === "only"} value={value.max == null ? "" : value.max / field.scale} onChange={(n) => range(field.key, { max: typeof n === "number" ? n * field.scale : undefined })} /></Group>
                <FilterSelect aria-label={`${field.label} missing values`} size="sm" value={value.unknown ?? "exclude"} data={UNKNOWN} onChange={(unknown) => range(field.key, { unknown })} />
              </Stack>;
            })}
            {section.id === "dates" && DATE_FIELDS.filter((field) => show(field.key)).map((field) => {
              const value = filters.ranges?.[field.key] ?? {};
              return <Stack key={field.key} gap={4}>
                <Group gap={4}>{label(field.key)}<Help label={`About ${field.label}`} text={field.key === "start_time" ? "The timestamp reported by the source header, distinct from filesystem dates. A timezone-less header is interpreted as UTC for indexing; displayed dates use your local time." : field.key === "file_created_at" ? "Filesystem creation time when supported. It may reflect a copied file rather than the start of the experiment." : "Filesystem modification time or the time this catalog first indexed the path. Displayed bounds use your local time."} /></Group>
                {(["min", "max"] as const).map((bound) => <TextInput key={bound} size="sm" type="datetime-local" label={bound === "min" ? "On or after" : "On or before"} aria-label={`${field.label} ${bound}`} value={localDateInput(value[bound])} disabled={value.unknown === "only"} onChange={(e) => range(field.key, { [bound]: e.currentTarget.value ? new Date(e.currentTarget.value).getTime() / 1000 + (bound === "max" ? 59.999 : 0) : undefined })} />)}
                <Group gap={4}>{[0, 7, 30].map((days) => <Button size="compact-xs" variant="subtle" key={days} onClick={() => { const date = new Date(); if (!days) date.setHours(0, 0, 0, 0); else date.setDate(date.getDate() - days); range(field.key, { min: date.getTime() / 1000, max: Date.now() / 1000, unknown: "exclude" }); }}>{days ? `Last ${days} days` : "Today"}</Button>)}</Group>
                <FilterSelect aria-label={`${field.label} missing values`} size="sm" value={value.unknown ?? "exclude"} data={UNKNOWN} onChange={(unknown) => range(field.key, { unknown })} />
              </Stack>;
            })}
            {section.id === "header" && <>
              {facet("technique", "Technique", [...new Set([...techniques, ...(filters.technique ? [filters.technique] : [])])], !config?.metadata_enabled)}
              {show("header_condition") && <FilterSelect label={label("header_condition")} size="sm" placeholder="Barcode, remarks, part number…" value={null} data={options("header_condition", FILTER_FIELDS.filter((f) => ["barcode", "remarks", "part_number", "device_info", "channel"].includes(f.value)))} disabled={!config?.metadata_enabled || textConditions.length >= 15} onChange={(field) => { if (field) { setTextConditions([...textConditions, { field, operator: "contains", value: "" }]); setFind(""); setExpanded((old) => [...new Set([...old, "text"])]); } }} />}
              {!config?.metadata_enabled && <Text size="sm" c="dimmed">Source metadata indexing is disabled in Locations.</Text>}
            </>}
            {section.id === "app" && <>
              <Help label="About CellXplorer relationships" text="Matches known registered source paths, including resolved drive aliases. Copies elsewhere are not checksum-verified duplicates. Analysis and replicate membership belong to the linked Cell, including its whole source chain; per-plot visibility is separate." />
              {([['registered', 'Already in Cell Database'], ['analysis_usage', 'Used in an analysis'], ['replicate_usage', 'In a replicate group']] as const).filter(([key]) => show(key)).map(([key]) => <FilterSelect key={key} label={<DiscoveryLabel match={matches.get(key)!} />} size="sm" data={YES_NO} value={filters[key] ?? "any"} onChange={(value) => patch({ [key]: value ?? undefined })} />)}
              {show("analysis_id") && <FilterSelect label={label("analysis_id")} searchable clearable size="sm" data={relationships?.analyses.map((a) => ({ value: String(a.id), label: a.name })) ?? []} value={filters.analysis_id ? String(filters.analysis_id) : null} onChange={(value) => patch({ analysis_id: value ? Number(value) : undefined })} />}
              {show("replicate_id") && <FilterSelect label={label("replicate_id")} searchable clearable size="sm" data={relationships?.replicates.map((a) => ({ value: String(a.id), label: a.name })) ?? []} value={filters.replicate_id ? String(filters.replicate_id) : null} onChange={(value) => patch({ replicate_id: value ? Number(value) : undefined })} />}
              {show("cell_condition") && <FilterSelect label={label("cell_condition")} placeholder="Name, notes or curated metadata…" size="sm" value={null} data={options("cell_condition", FILTER_FIELDS.filter((f) => f.value.startsWith("cell_")))} disabled={textConditions.length >= 15} onChange={(field) => { if (field) { setTextConditions([...textConditions, { field, operator: "contains", value: "" }]); setFind(""); setExpanded((old) => [...new Set([...old, "text"])]); } }} />}
            </>}
            {section.id === "text" && <>
              <FilterSelect label="Combine text conditions" data={[{ value: "all", label: "Match all conditions" }, { value: "any", label: "Match any condition" }]} size="sm" value={filters.match ?? "all"} onChange={(value) => patch({ match: value === "any" ? "any" : "all" })} />
              {textConditions.map((condition, index) => {
                if (find.trim() && matches.get("text_condition")?.option && !options("text_condition", FILTER_FIELDS).some((field) => field.value === condition.field)) return null;
                return <Stack gap={4} key={index}>
                <Group gap="xs" wrap="nowrap"><FilterSelect aria-label={`Condition ${index + 1} field`} size="sm" searchable data={FILTER_FIELDS} value={condition.field} onChange={(field) => textChange(index, { field: field ?? "any" })} style={{ flex: 1 }} /><Tooltip label="Remove condition"><ActionIcon variant="subtle" size="sm" aria-label={`Remove condition ${index + 1}`} onClick={() => setTextConditions(textConditions.filter((_, i) => i !== index))}><IconTrash size={15} /></ActionIcon></Tooltip></Group>
                <FilterSelect aria-label={`Condition ${index + 1} operator`} size="sm" data={FILTER_OPERATORS} value={condition.operator} onChange={(operator) => textChange(index, { operator: operator ?? "contains" })} />
                {!["present", "missing"].includes(condition.operator) && <TextInput aria-label={`Condition ${index + 1} text`} placeholder="Text to match" size="sm" value={condition.value} onChange={(e) => textChange(index, { value: e.currentTarget.value })} />}
                <Checkbox size="sm" label="Case sensitive" checked={Boolean(condition.case_sensitive)} onChange={(e) => textChange(index, { case_sensitive: e.currentTarget.checked })} />
              </Stack>; })}
              <FilterSelect label={label("text_condition")} placeholder="Add a condition for…" size="sm" searchable value={null} disabled={textConditions.length >= 15} data={options("text_condition", FILTER_FIELDS.filter((field) => field.value !== "any"))} onChange={(field) => { if (field) setTextConditions([...textConditions, { field, operator: "contains", value: "" }]); }} />
              {!find.trim() && <Button size="sm" variant="default" disabled={textConditions.length >= 15} onClick={() => setTextConditions([...textConditions, { field: "any", operator: "contains", value: "" }])}>Add condition</Button>}
            </>}
            {section.id === "regex" && <>
              <Group gap={4}>{label("regex")}<Help label="About regular expressions" text="Pattern searches run only when applied, in an isolated process with a three-second limit. Narrow the search or simplify a pattern if it times out. This condition uses the text section’s all/any setting." /></Group>
              <FilterSelect label="Search field" size="sm" searchable data={FILTER_FIELDS} value={patternField} onChange={(v) => setPatternField(v ?? "filename")} />
              <TextInput label="Pattern" placeholder="e.g. BQV_[0-9]+" size="sm" value={pattern} onChange={(e) => setPattern(e.currentTarget.value)} error={patternError} maxLength={256} />
              <Checkbox label="Case sensitive" size="sm" checked={patternCase} onChange={(e) => setPatternCase(e.currentTarget.checked)} />
              <Group gap="xs"><Button size="sm" variant="default" onClick={() => { setPatternError(null); patch({ conditions: [...textConditions, ...(pattern ? [{ field: patternField, operator: "regex", value: pattern, case_sensitive: patternCase }] : [])] }); }}>Apply pattern</Button>{regex && <Button size="sm" variant="subtle" onClick={() => patch({ conditions: textConditions })}>Remove pattern</Button>}</Group>
            </>}
            {section.id === "folder" && <Help label="About indexed folder counts" text="Counts unique recognized compatible source paths in the immediate folder, across the chosen indexed scope, before result filters. These are catalog counts, not a fresh disk enumeration. Incomplete or offline indexing is labelled partial." />}
            {section.id === "saved" && <>
              <FilterSelect label={label("sort")} size="sm" searchable value={normalizedSearchSort(filters.sort)} data={SORT_OPTIONS} onChange={(value) => patch({ sort: value ?? undefined })} />

            </>}
          </Stack></Accordion.Panel>
        </Accordion.Item>)}
      </Accordion>
    </ScrollArea>
  </Stack>;
}
