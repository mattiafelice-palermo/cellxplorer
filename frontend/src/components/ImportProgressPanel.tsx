import { Alert, Box, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconFileSearch, IconUpload } from "@tabler/icons-react";

import type { BackgroundJob } from "../api";
import {
  importProgressCurrentLabel,
  importProgressPhases,
  importRemainingEstimate,
  importStageExplanation,
  importStageTitle,
  type ImportProgressPhaseRow,
  type ImportProgressStage,
} from "../importProgress";

function PhaseStatusIcon({ status }: { status: ImportProgressPhaseRow["status"] }) {
  if (status === "completed") {
    return <IconCheck size={13} color="var(--mantine-color-teal-6)" style={{ flex: "none" }} />;
  }
  if (status === "failed") {
    return <IconAlertTriangle size={13} color="var(--mantine-color-red-6)" style={{ flex: "none" }} />;
  }
  if (status === "active") {
    return <Loader size={11} style={{ flex: "none" }} />;
  }
  return (
    <Box
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: "var(--mantine-color-dimmed)",
        opacity: 0.5,
        marginLeft: 3,
        marginRight: 3,
        flex: "none",
      }}
    />
  );
}

export function ImportProgressPanel({
  stage,
  job,
  preparationJob,
  error,
}: {
  stage: ImportProgressStage;
  job: BackgroundJob | null | undefined;
  preparationJob?: BackgroundJob | null;
  error?: string | null;
}) {
  const phases = importProgressPhases(stage, job, preparationJob);
  const preparationActive =
    stage === "register"
    && Boolean(preparationJob)
    && phases.some((row) => row.id === "preparation" && row.status === "active");
  const current = preparationActive
    ? preparationJob?.current_item_label ?? null
    : importProgressCurrentLabel(stage, job);
  const estimate = importRemainingEstimate(preparationActive ? preparationJob : job);
  const failed = job?.status === "failed" || Boolean(error);
  const stageIcon = stage === "inspect" ? <IconFileSearch size={17} /> : <IconUpload size={17} />;
  return (
    <Stack gap="xs" p="sm">
      <Group gap="xs" wrap="nowrap">
        {failed ? <IconAlertTriangle size={18} color="var(--mantine-color-red-7)" /> : stageIcon}
        <Text fw={700} size="sm">{failed ? "Import failed" : importStageTitle(stage)}</Text>
        {!failed && !job && <Loader size="xs" aria-label="Import progress is loading" />}
      </Group>
      <Text size="xs" c="dimmed">{failed ? "No partial Cell registration was kept." : importStageExplanation(stage)}</Text>
      {failed ? (
        <Alert color="red" title="The import did not complete">
          {error || job?.error || "The server could not complete this import stage."}
        </Alert>
      ) : (
        <>
          <Stack gap={6}>
            {phases.map((row) => {
              const barValue = row.status === "completed"
                ? 100
                : row.status === "pending"
                  ? 0
                  : row.mode === "determinate"
                    ? (row.percent ?? 0)
                    : 100;
              const barColor = row.status === "completed"
                ? "teal"
                : row.status === "failed"
                  ? "red"
                  : undefined;
              const valueText = row.status === "completed"
                ? "100 percent"
                : row.status === "pending"
                  ? "Waiting"
                  : row.mode === "determinate"
                    ? `${Math.round(row.percent ?? 0)} percent`
                    : "In progress";
              return (
                <Stack key={row.id} gap={3}>
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                      <PhaseStatusIcon status={row.status} />
                      <Text
                        size="xs"
                        fw={row.status === "active" ? 600 : 500}
                        c={row.status === "pending" ? "dimmed" : undefined}
                        truncate
                      >
                        {row.label}
                      </Text>
                    </Group>
                    {row.detail && (
                      <Text
                        size="xs"
                        c={row.status === "failed" ? "red" : "dimmed"}
                        truncate
                        style={{ flex: "0 1 auto", minWidth: 0 }}
                        title={row.detail}
                      >
                        {row.detail}
                      </Text>
                    )}
                  </Group>
                  <Progress
                    size={row.status === "active" ? "sm" : "xs"}
                    value={barValue}
                    color={barColor}
                    striped={row.status === "active"}
                    animated={row.status === "active"}
                    aria-label={row.label}
                    aria-valuetext={valueText}
                  />
                </Stack>
              );
            })}
          </Stack>
          {current && (
            <Text size="xs" c="dimmed" truncate title={current}>
              Current: {current}
            </Text>
          )}
          {estimate && (
            <Text size="xs" c="dimmed">
              {estimate.scope === "total" ? "Estimated inspection time" : "Estimated remaining"}: approximately {estimate.minimumLabel}–{estimate.maximumLabel}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}
