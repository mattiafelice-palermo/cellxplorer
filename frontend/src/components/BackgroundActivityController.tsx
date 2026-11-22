import { Button, Group, Progress, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconActivity, IconLoader2 } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  readAcknowledgedFailedJobId,
  shouldShowActivityFailed,
  writeAcknowledgedFailedJobId,
} from "../activityAcknowledgement";
import {
  ANALYSIS_UPDATES_VIEWED,
  acknowledgeUpdates,
  readSeenUpdates,
  unreadUpdates,
} from "../analysisUpdateNoticePolicy";
import { get, type BackgroundJob, type SourceCheckJob } from "../api";
import { APP_BRANDING } from "../appChannel";
import { isTauriApp } from "../downloads";
import {
  invalidateAnalysisQueries,
  invalidateSourceScientificQueries,
} from "../features/analyses/workspace/analysisQueryCache";
import {
  backgroundImportRefreshPlan,
  importProgressCount,
  importProgressPercent,
} from "../importProgress";
import { ActivityCenter } from "./ActivityCenter";
import { AnalysisUpdateIndicator } from "./AnalysisUpdateIndicator";
import { SearchIndexProgressBar } from "./SearchIndexProgress";

/**
 * Owns background-job and source-check polling independently of the App shell
 * so 600–700 ms progress ticks do not re-render the active page.
 */
export function BackgroundActivityController({
  enabled,
  databaseId,
  onNavigate,
}: {
  enabled: boolean;
  databaseId: string | null;
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [activityOpen, setActivityOpen] = useState(false);
  const [acknowledgedFailedJobId, setAcknowledgedFailedJobId] = useState<number | null>(
    () => readAcknowledgedFailedJobId(window.localStorage),
  );
  const handledSourceCheckJob = useRef<number | null>(null);
  const handledSourceChangingState = useRef("");
  const backgroundJobSnapshots = useRef(new Map<number, string>());
  const lastImportCacheRefreshAt = useRef(0);

  const backgroundJobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => get<BackgroundJob[]>("/api/background-jobs?limit=20"),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "running") ? 700 : 5000,
  });

  useEffect(() => {
    const jobs = backgroundJobs.data ?? [];
    const refresh = (keys: string[][]) => {
      keys.forEach((queryKey) => {
        void queryClient.invalidateQueries({ queryKey });
      });
    };
    const plan = backgroundImportRefreshPlan(
      backgroundJobSnapshots.current,
      jobs,
      Date.now(),
      lastImportCacheRefreshAt.current,
    );
    backgroundJobSnapshots.current = plan.snapshots;
    lastImportCacheRefreshAt.current = plan.lastCacheRefreshAt;
    if (plan.registrationCommitted) {
      refresh([
        ["cells"],
        ["files"],
        ["tree"],
        ["replicate-groups"],
        ["activity"],
        ["background-jobs"],
      ]);
    }
    if (plan.cacheAdvanced && !plan.cacheTerminal) {
      refresh([["cells"], ["files"]]);
    }
    if (plan.cacheTerminal) {
      refresh([["cells"], ["files"], ["activity"], ["background-jobs"]]);
    }
  }, [backgroundJobs.data, queryClient]);

  const failedJobIds = useMemo(
    () =>
      (backgroundJobs.data ?? [])
        .filter((job) => job.status === "failed")
        .map((job) => job.id),
    [backgroundJobs.data],
  );

  const acknowledgeFailedJobs = () => {
    if (failedJobIds.length === 0) return;
    const highestFailedId = Math.max(...failedJobIds);
    if (highestFailedId > (acknowledgedFailedJobId ?? -1)) {
      writeAcknowledgedFailedJobId(window.localStorage, highestFailedId);
      setAcknowledgedFailedJobId(highestFailedId);
    }
  };

  const sourceCheckJob = useQuery({
    queryKey: ["source-check-job"],
    queryFn: () => get<SourceCheckJob | null>("/api/source-check-jobs/latest"),
    enabled,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 600 : false),
  });

  useEffect(() => {
    const job = sourceCheckJob.data;
    if (!job) return;
    if (job.status === "running") {
      const state = `${job.id}:${job.deferred ?? 0}`;
      if (handledSourceChangingState.current !== state) {
        handledSourceChangingState.current = state;
        queryClient.invalidateQueries({ queryKey: ["cells"] });
        queryClient.invalidateQueries({ queryKey: ["cell"] });
      }
      return;
    }
    if (handledSourceCheckJob.current === job.id) return;
    handledSourceCheckJob.current = job.id;
    queryClient.invalidateQueries({ queryKey: ["cells"] });
    queryClient.invalidateQueries({ queryKey: ["cell"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["tree"] });
    queryClient.invalidateQueries({ queryKey: ["activity"] });
    // The list carries sources_changed, so it must refresh too — this is what
    // makes an analysis go bold right after an automatic source check.
    queryClient.invalidateQueries({ queryKey: ["analyses"] });
    // Source adoption can affect any analysis that references the changed
    // Cell, not only the currently visible tab.
    void invalidateAnalysisQueries(queryClient);
    if (job.update_after_check && job.ready_cell_ids?.length) {
      void invalidateSourceScientificQueries(queryClient, {
        cellIds: job.ready_cell_ids,
      });
    }
    if (job.status === "failed") {
      notifications.show({ message: job.error || "Source check failed.", color: "red" });
    } else {
      const updateWarnings = Boolean(job.offline || job.errors || job.deferred || job.update_errors?.length);
      const deferredSuffix = job.deferred ? ` ${job.deferred} deferred because the source was still changing.` : "";
      notifications.show({
        message: job.update_after_check
          ? `Checked ${job.completed} sources and updated ${job.updated ?? 0} changed file${job.updated === 1 ? "" : "s"}.${deferredSuffix}`
          : `Checked ${job.completed} source file${job.completed === 1 ? "" : "s"} (${job.changed} changed, ${job.offline} offline).${deferredSuffix}`,
        color: job.update_after_check
          ? (updateWarnings ? "orange" : "teal")
          : (job.changed || job.offline || job.errors ? "orange" : "teal"),
      });
      if (job.skipped_complete) {
        notifications.show({
          message: `Skipped ${job.skipped_complete} completed cell${job.skipped_complete === 1 ? "" : "s"}.`,
          color: "gray",
        });
      }
    }
    if (isTauriApp()) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("set_tray_status", { message: null }),
      );
    }
  }, [queryClient, sourceCheckJob.data]);

  const activeJob = backgroundJobs.data?.find((job) => job.status === "running") ?? null;
  const activeJobCount = importProgressCount(activeJob);
  const activityProgress = importProgressPercent(activeJob) ?? (activeJob ? 100 : 0);

  return (
    <>
      <AnalysisUpdateIndicator
        databaseId={databaseId}
        activityOpen={activityOpen}
        onOpen={() => setActivityOpen(true)}
        onSettings={() => onNavigate("/settings/notifications")}
      >
        <Button
          className="background-activity-button"
          size="compact-sm"
          variant="subtle"
          color={
            shouldShowActivityFailed(failedJobIds, acknowledgedFailedJobId)
              ? "red"
              : APP_BRANDING.primaryColor
          }
          leftSection={
            activeJob ? (
              <IconLoader2 size={14} className="source-check-spin" />
            ) : (
              <IconActivity size={14} />
            )
          }
          onClick={() => setActivityOpen(true)}
        >
          {activeJob ? (
            <Stack gap={2} className="background-activity-content">
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="xs" fw={600} truncate maw={210}>
                  {activeJob.kind === "source_search_index"
                    ? activeJob.phase_detail ?? "Finding source files"
                    : activeJob.description}
                </Text>
                <Text size="xs" c="dimmed">
                  {activeJob.kind === "source_search_index" && (!activeJob.phase || activeJob.phase === "discovering")
                    ? `${activeJob.discovered_files ?? 0} found`
                    : `${activeJobCount.current}/${activeJobCount.total}`}
                </Text>
              </Group>
              {activeJob.kind === "source_search_index" ? (
                <SearchIndexProgressBar
                  size={3}
                  phase={activeJob.phase}
                  discovered={activeJob.discovered_files}
                  completed={activeJob.completed}
                  total={activeJob.total}
                />
              ) : (
                <Progress value={activityProgress} size={3} animated color={APP_BRANDING.primaryColor} />
              )}
            </Stack>
          ) : (
            "Activity"
          )}
        </Button>
      </AnalysisUpdateIndicator>
      {activityOpen ? (
        <ActivityCenter
          opened={activityOpen}
          onSettings={() => {
            setActivityOpen(false);
            onNavigate("/settings/notifications");
          }}
          onClose={() => setActivityOpen(false)}
          jobs={backgroundJobs.data ?? []}
          databaseId={databaseId}
          onUpdatesViewed={(notices) => {
            if (!databaseId || !unreadUpdates(notices, readSeenUpdates(window.localStorage, databaseId)).length) return;
            acknowledgeUpdates(window.localStorage, databaseId, notices);
            window.dispatchEvent(new Event(ANALYSIS_UPDATES_VIEWED));
          }}
          loading={backgroundJobs.isLoading}
          failed={backgroundJobs.isError}
          onOpenAnalysis={(id) => {
            setActivityOpen(false);
            onNavigate(`/analyses/${id}`);
          }}
          onProcessingViewed={acknowledgeFailedJobs}
        />
      ) : null}
    </>
  );
}
