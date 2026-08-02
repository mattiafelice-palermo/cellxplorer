import { Alert, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconFileSearch, IconUpload } from "@tabler/icons-react";

import type { BackgroundJob } from "../api";
import {
  importProgressCountLabel,
  importProgressCurrentLabel,
  importProgressMode,
  importProgressPercent,
  importRemainingEstimate,
  importStageExplanation,
  importStageTitle,
  type ImportProgressStage,
} from "../importProgress";

export function ImportProgressPanel({
  stage,
  job,
  error,
}: {
  stage: ImportProgressStage;
  job: BackgroundJob | null | undefined;
  error?: string | null;
}) {
  const mode = importProgressMode(stage, job);
  const percent = importProgressPercent(job);
  const current = importProgressCurrentLabel(stage, job);
  const estimate = importRemainingEstimate(job);
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
          <Progress
            value={mode === "determinate" ? percent ?? 0 : 100}
            striped
            animated
            aria-label={importStageTitle(stage)}
            aria-valuetext={mode === "determinate" ? `${Math.round(percent ?? 0)} percent` : "In progress"}
          />
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="xs" fw={600}>{importProgressCountLabel(stage, job)}</Text>
            {stage === "scan" && job && (
              <Text size="xs" c="dimmed">{job.discovered_files ?? 0} files found</Text>
            )}
          </Group>
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
