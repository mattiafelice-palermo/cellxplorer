import { Button, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import type { Badge } from "../api";
import { sourceLimitations } from "../sourceLimitations";
import { mprWarningExample } from "../mprWarningExample";
export function AnalysisSourceLimitations({ badges }: { badges: readonly Badge[] }) {
  const sources = sourceLimitations(badges);
  if (!sources.length) return null;
  return <details style={{ color: "var(--mantine-color-orange-text)", fontSize: "var(--mantine-font-size-xs)" }}>
    <summary style={{ cursor: "pointer", width: "fit-content" }}>{sources.length} source{sources.length === 1 ? " has" : "s have"} data limitations</summary>
    <Stack gap="xs" mt="xs" style={{ maxHeight: 240, overflowY: "auto" }}>
      {sources.map((source, index) => <div key={`${source.cell_id}:${source.source_id ?? source.file ?? index}`}>
        <Text size="xs" fw={600}>{source.cell_name}{source.file ? ` · ${source.file}` : ""}</Text>
        <Text size="xs">{source.detail}</Text>
        {source.limitations?.map((warning, i) => <div key={i}>
          <Text size="xs">{warning.message}{warning.count && warning.count > 1 ? ` (${warning.count})` : ""}</Text>
          {warning.examples?.map(mprWarningExample).filter(Boolean).map((example, j) => <Text key={j} size="xs" c="dimmed">{example}</Text>)}
        </div>)}
        {source.cell_id != null && <Button component={Link} to={`/?cell=${source.cell_id}&cellTab=files`} size="compact-xs" variant="subtle">Open source details</Button>}
      </div>)}
    </Stack>
  </details>;
}
