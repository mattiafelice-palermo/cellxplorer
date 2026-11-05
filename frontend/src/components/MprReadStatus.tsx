import { Alert, Stack, Text } from "@mantine/core";
import type { MprReadPresentation } from "../api";
import { mprWarningExample } from "../mprWarningExample";

export function MprReadStatus({ source, sourceName }: { source: MprReadPresentation | null | undefined; sourceName?: string }) {
  if (source?.read_mode !== "permissive" && !source?.exploratory) return null;
  return <Alert color="orange" title="Permissive MPR reading" py="xs">
    {sourceName && <Text size="xs" fw={600} truncate title={sourceName}>{sourceName}</Text>}
    {source.exploratory
      ? "Exploratory measurements. Cycle identity, capacity and efficiency are unavailable where their interpretation is uncertain."
      : "Permissive mode is selected. Unsupported interpretations may be shown as exploratory measurements."}
    {source.exploratory && Boolean(source.interpretation_warnings?.length) && <Stack gap={4} mt="xs">
      {source.interpretation_warnings?.map((warning) => <div key={warning.code}>
        <Text size="xs">{warning.message}{warning.count && warning.count > 1 ? ` (${warning.count})` : ""}</Text>
        {warning.examples?.map(mprWarningExample).filter(Boolean).map((example, index) =>
          <Text size="xs" c="dimmed" key={index}>{example}</Text>)}
      </div>)}
    </Stack>}
  </Alert>;
}
