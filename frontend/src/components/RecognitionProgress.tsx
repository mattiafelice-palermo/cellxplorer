import { Progress, Stack, Text } from "@mantine/core";

export function RecognitionProgress({
  percent,
  label,
  waiting,
}: {
  percent: number;
  label: string;
  /** True until the background job appears (cache-miss path starting). */
  waiting?: boolean;
}) {
  const animated = waiting || percent < 100;
  const value = waiting ? 100 : percent;
  return (
    <Stack gap="xs" w={360} maw="80%">
      <Text size="sm" fw={600} ta="center">
        {label || "Preparing recognition…"}
      </Text>
      <Progress
        value={value}
        animated={animated}
        striped={waiting}
        color="teal"
      />
      <Text size="xs" c="dimmed" ta="center">
        {waiting
          ? "Starting recognition"
          : percent > 0
            ? `${Math.round(percent)}%`
            : "Working…"}
      </Text>
    </Stack>
  );
}
