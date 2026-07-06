import { Alert, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { IconChartLine } from "@tabler/icons-react";

export function AnalysesIndexPage() {
  return (
    <Stack>
      <Title order={3}>Analysis Database</Title>
      <Paper withBorder p="lg">
        <Group gap="lg" align="start">
          <IconChartLine size={34} color="var(--mantine-color-teal-6)" />
          <Stack gap={6}>
            <Text fw={700}>Analysis database reset</Text>
            <Text size="sm" c="dimmed" maw={720}>
              Analysis functionality has been cleared so it can be rebuilt around the new import
              and cell logic.
            </Text>
          </Stack>
        </Group>
      </Paper>
      <Alert color="gray">No analysis tools are active in this pass.</Alert>
    </Stack>
  );
}
