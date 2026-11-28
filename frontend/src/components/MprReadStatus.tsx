import { Alert, Stack, Text } from "@mantine/core";
import type { MprReadPresentation } from "../api";
import { mprWarningExample } from "../mprWarningExample";
import { sourceWarningText } from "../sourceLimitations";

export function MprReadStatus({ source, sourceName }: { source: MprReadPresentation | null | undefined; sourceName?: string }) {
  if (source?.read_mode !== "permissive" && !source?.exploratory) return null;
  return <Alert color="orange" title={source.exploratory ? "Exploratory measurements" : "Permissive MPR reading"} py="xs">
    {sourceName && <Text size="xs" fw={600} truncate title={sourceName}>{sourceName}</Text>}
    {source.exploratory
      ? "Some measurements could be read. Cycles, capacity and efficiency are unavailable where they could not be verified."
      : "Permissive mode is selected. Unsupported interpretations may be shown as exploratory measurements."}
    {source.exploratory && Boolean(source.interpretation_warnings?.length) && <Stack gap={4} mt="xs">
      {source.interpretation_warnings?.map((warning) => <div key={warning.code}>
        <Text size="xs">{sourceWarningText(warning)}{warning.count && warning.count > 1 ? ` (${warning.count})` : ""}</Text>
        {warning.examples?.map(mprWarningExample).filter(Boolean).map((example, index) =>
          <Text size="xs" c="dimmed" key={index}>{example}</Text>)}
      </div>)}
    </Stack>}
  </Alert>;
}
