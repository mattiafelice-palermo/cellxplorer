import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { post, type AnalysisUsageResponse } from "../api";
import {
  destructiveImpactModalVisible,
  type DestructiveImpactConfirmOptions,
} from "../destructiveImpact";

export type { DestructiveImpactConfirmOptions } from "../destructiveImpact";

export type DestructiveImpactModalProps = {
  opened: boolean;
  onClose: () => void;
  title: string;
  cellIds?: number[];
  groupIds?: number[];
  confirmLabel: string;
  /** Body for the plain confirm shown when usage reports no impact. */
  plainMessage: string;
  onConfirm: (options: DestructiveImpactConfirmOptions) => void;
};

function analysisLabel(count: number): string {
  return count === 1 ? "analysis" : "analyses";
}

/** After a destructive mutation, optionally delete preflight empty candidates. */
export async function deleteEmptyAnalysesIfRequested(
  options: DestructiveImpactConfirmOptions,
): Promise<number[]> {
  if (!options.deleteEmptyAnalyses || options.emptyAfterCandidateIds.length === 0) {
    return [];
  }
  const result = await post<{ deleted_ids: number[] }>(
    "/api/analyses/purge-empty-candidates",
    { analysis_ids: options.emptyAfterCandidateIds },
  );
  return result.deleted_ids;
}

export function DestructiveImpactModal({
  opened,
  onClose,
  title,
  cellIds = [],
  groupIds = [],
  confirmLabel,
  plainMessage,
  onConfirm,
}: DestructiveImpactModalProps) {
  const [deleteEmpty, setDeleteEmpty] = useState(false);

  const usage = useQuery({
    queryKey: ["analyses-usage", cellIds, groupIds],
    queryFn: () =>
      post<AnalysisUsageResponse>("/api/analyses/usage", {
        cell_ids: cellIds,
        group_ids: groupIds,
      }),
    enabled: opened && (cellIds.length > 0 || groupIds.length > 0),
    retry: false,
  });

  useEffect(() => {
    if (!opened) {
      setDeleteEmpty(false);
    }
  }, [opened]);

  const analyses = usage.data?.analyses ?? [];
  const emptyCount = usage.data?.empty_after.length ?? 0;
  const hasImpact = analyses.length > 0;
  const groupOnly = groupIds.length > 0 && cellIds.length === 0;
  const subject = groupOnly
    ? groupIds.length === 1
      ? "This replicate"
      : `These ${groupIds.length} replicates`
    : cellIds.length === 1
      ? "This cell"
      : `These ${Math.max(cellIds.length, 1)} cells`;
  const emptyBadgeLabel = groupOnly
    ? "replicate removed — no samples left"
    : "will be left with no samples";
  const emptyDetail = groupOnly
    ? "The exploded replicate will be removed from this analysis."
    : "This analysis will keep no remaining samples.";

  return (
    <Modal
      opened={destructiveImpactModalVisible(opened, usage.isFetching)}
      onClose={onClose}
      title={title}
      size="lg"
    >
      <Stack gap="md">
        {usage.isError ? (
          <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
            Could not check analysis usage
            {usage.error instanceof Error ? `: ${usage.error.message}` : "."} You can still
            proceed, but affected analyses will not be listed.
          </Alert>
        ) : !hasImpact ? (
          <Text size="sm">{plainMessage}</Text>
        ) : null}

        {hasImpact ? (
          <>
            <Text size="sm">
              {subject} {analyses.length === 1 ? "is" : "are"} used in {analyses.length}{" "}
              {analysisLabel(analyses.length)}.
            </Text>
            <Stack gap="sm">
              {analyses.map((analysis) => {
                const affectedPlots = analysis.plots.filter((plot) => plot.affected);
                return (
                  <Stack
                    key={analysis.id}
                    gap={4}
                    p="sm"
                    style={{
                      borderRadius: 8,
                      border: analysis.becomes_empty
                        ? "1px solid var(--mantine-color-orange-5)"
                        : "1px solid var(--mantine-color-gray-3)",
                      background: analysis.becomes_empty
                        ? "light-dark(var(--mantine-color-orange-0), color-mix(in srgb, var(--mantine-color-orange-8) 28%, var(--mantine-color-dark-6)))"
                        : undefined,
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Text size="sm" fw={600}>
                        {analysis.title}
                      </Text>
                      {analysis.becomes_empty ? (
                        <Badge
                          size="sm"
                          color="orange"
                          variant="outline"
                          leftSection={<IconAlertTriangle size={12} />}
                        >
                          {emptyBadgeLabel}
                        </Badge>
                      ) : (
                        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                          {affectedPlots.length} plot
                          {affectedPlots.length === 1 ? "" : "s"} affected
                        </Text>
                      )}
                    </Group>
                    {affectedPlots.length > 0 ? (
                      <Text size="xs" c="dimmed">
                        {affectedPlots.map((plot) => plot.name).join(" · ")}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        {analysis.becomes_empty
                          ? emptyDetail
                          : "No saved plots are currently showing the removed samples."}
                      </Text>
                    )}
                  </Stack>
                );
              })}
            </Stack>
            {emptyCount > 0 ? (
              <Checkbox
                checked={deleteEmpty}
                onChange={(event) => setDeleteEmpty(event.currentTarget.checked)}
                label={`Also delete the ${emptyCount} ${analysisLabel(emptyCount)} that would be left empty`}
              />
            ) : null}
          </>
        ) : null}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            onClick={() => {
              onClose();
              onConfirm({
                deleteEmptyAnalyses: Boolean(hasImpact && deleteEmpty && emptyCount > 0),
                emptyAfterCandidateIds: usage.data?.empty_after ?? [],
              });
            }}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
