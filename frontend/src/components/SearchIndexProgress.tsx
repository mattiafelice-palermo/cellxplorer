import { Progress, Stack, Text } from "@mantine/core";
import { searchIndexProgressLabel } from "../importSearch";
export { searchIndexProgressLabel } from "../importSearch";

type Props = { phase?: string; discovered?: number; completed?: number; total?: number };

export function SearchIndexProgressBar({ phase, discovered = 0, completed = 0, total = 0, size = "sm" }: Props & { size?: number | "sm" }) {
  const discovering = phase === "discovering" || !phase;
  const percent = total > 0 ? Math.max(0, Math.min(100, 100 * completed / total)) : 100;
  const label = searchIndexProgressLabel(phase, discovered, completed, total);
  return <Progress.Root size={size} radius="xl" role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={discovering ? undefined : percent}
    aria-valuetext={discovering ? "Total unknown while discovering files" : `${completed} of ${total} headers checked`}>
    <Progress.Section value={discovering ? 100 : percent} animated={discovering} striped={discovering} withAria={false} />
  </Progress.Root>;
}

export function SearchIndexProgress({ phase, discovered = 0, completed = 0, total = 0 }: Props) {
  return <Stack gap={4} style={{ minWidth: 0 }}>
    <Text size="xs" c="dimmed" role="status">{searchIndexProgressLabel(phase, discovered, completed, total)}</Text>
    <SearchIndexProgressBar phase={phase} discovered={discovered} completed={completed} total={total} />
  </Stack>;
}
