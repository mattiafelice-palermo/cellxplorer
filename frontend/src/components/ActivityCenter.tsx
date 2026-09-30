import {
  Accordion, ActionIcon, Alert, Badge, Box, Button, Divider, Group, Modal,
  Paper, Progress, ScrollArea, Stack, Tabs, Text, Tooltip,
} from "@mantine/core";
import { IconActivity, IconArrowRight, IconChartLine, IconCheck, IconRefresh, IconAlertTriangle, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { get, type AnalysisUpdateNotice, type BackgroundJob } from "../api";
import { importProgressCount, importProgressPercent } from "../importProgress";

const statusPresentation = {
  ready: { label: "Ready", color: "teal", detail: "Updated source data is available. Plots can be opened now." },
  refreshing: { label: "Refreshing", color: "teal", detail: "Saved plots and previews are being prepared in the background." },
  paused: { label: "Queued", color: "gray", detail: "Background plot preparation will resume when the app is idle." },
  preparing_data: { label: "Preparing data", color: "teal", detail: "The attached source is still being parsed." },
  needs_attention: { label: "Needs attention", color: "orange", detail: "Some data or plot preparation failed. Open the analysis or the Processing tab for details." },
  on_demand: { label: "On demand", color: "gray", detail: "Source data is available; this plot is prepared when opened." },
  removed: { label: "Removed", color: "gray", detail: "This analysis has been removed since the update." },
  changed_since_update: { label: "Changed since update", color: "gray", detail: "The analysis or its updated source membership changed after this notification." },
} as const;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const jobKey = (job: BackgroundJob) => `${job.token ?? job.started_at}:${job.id}`;

function UpdateEntries({ notices, onOpenAnalysis }: {
  notices: AnalysisUpdateNotice[]; onOpenAnalysis: (id: number) => void;
}) {
  return notices.length === 0 ? (
    <Text size="sm" c="dimmed" py="md">
      No analyses have received new cell data yet. Updates will appear here after changed sources are adopted or continuation files are attached.
    </Text>
  ) : (
    <Accordion variant="separated" defaultValue={String(notices[0].id)}>
      {notices.map((notice) => (
        <Accordion.Item value={String(notice.id)} key={notice.id}>
          <Accordion.Control icon={<IconChartLine size={17} />}>
            <Group justify="space-between" wrap="nowrap" gap="xs" pr="xs">
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={700}>{notice.message}</Text>
                <Text size="xs" c="dimmed" mt={3}>
                  {notice.analyses.length} {notice.analyses.length === 1 ? "analysis" : "analyses"} · {plural(notice.cell_count, "cell")} updated
                </Text>
              </Box>
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }} title={new Date(notice.created_at).toLocaleString()}>
                {new Date(notice.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap={0}>
              {notice.analyses.map((analysis, index) => {
                const state = statusPresentation[analysis.status];
                return (
                  <Box key={analysis.id}>
                    {index > 0 ? <Divider my="xs" /> : null}
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Box style={{ minWidth: 0, flex: 1 }}>
                        <Button variant="subtle" size="compact-sm" px={0} disabled={analysis.status === "removed"}
                          onClick={() => onOpenAnalysis(analysis.id)} maw="100%" title={analysis.title}
                          styles={{ label: { display: "block", overflow: "hidden", textOverflow: "ellipsis" } }}>
                          {analysis.title}
                        </Button>
                        <Text size="xs" c="dimmed" mt={2} title={analysis.cells.map((cell) => cell.name).join(", ")}>
                          {plural(analysis.cell_ids.length, "cell")} updated
                          {analysis.added_cycles != null && analysis.added_cycles > 0 ? ` · +${analysis.added_cycles} source cycles` : ""}
                        </Text>
                      </Box>
                      <Tooltip label={state.detail} multiline maw={280} withArrow>
                        <Badge variant="light" color={state.color} size="sm" style={{ flexShrink: 0 }}
                          leftSection={analysis.status === "ready" ? <IconCheck size={12} /> :
                            analysis.status === "needs_attention" ? <IconAlertTriangle size={12} /> :
                            analysis.status === "refreshing" || analysis.status === "preparing_data" ? <IconRefresh size={12} /> : undefined}>
                          {state.label}
                        </Badge>
                      </Tooltip>
                      <Tooltip label="Open analysis" withArrow>
                        <ActionIcon variant="subtle" size="sm" aria-label={`Open ${analysis.title}`}
                          disabled={analysis.status === "removed"} onClick={() => onOpenAnalysis(analysis.id)}>
                          <IconArrowRight size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Box>
                );
              })}
              <Text size="xs" c="dimmed" mt="sm">Detected {new Date(notice.created_at).toLocaleString()}</Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

export function ActivityCenter({ opened, onClose, jobs, loading, failed, onOpenAnalysis, onProcessingViewed, databaseId, onUpdatesViewed, onSettings }: {
  opened: boolean; onClose: () => void; jobs: BackgroundJob[]; loading: boolean; failed: boolean;
  onOpenAnalysis: (id: number) => void; onProcessingViewed: () => void;
  databaseId: string | null; onUpdatesViewed: (notices: AnalysisUpdateNotice[]) => void;
  onSettings: () => void;
}) {
  const [tab, setTab] = useState<string | null>("updates");
  const notices = useQuery({
    queryKey: ["analysis-updates", databaseId],
    queryFn: () => get<AnalysisUpdateNotice[]>("/api/analysis-updates?limit=30"),
    enabled: opened && Boolean(databaseId),
    // Poll only while the panel is visible. This endpoint reads relational
    // summaries and in-memory job state; it never starts scientific work.
    refetchInterval: opened ? 2000 : false,
  });
  useEffect(() => {
    if (opened && tab === "updates" && notices.data) onUpdatesViewed(notices.data);
  }, [opened, tab, notices.data, onUpdatesViewed]);
  // Reset while closed, before a future open render. Resetting on open lets
  // another effect observe the previous Processing tab and acknowledge failures
  // even though the user is being shown the default Updates tab.
  useEffect(() => { if (!opened) setTab("updates"); }, [opened]);
  useEffect(() => { if (opened && tab === "processing") onProcessingViewed(); }, [opened, tab, onProcessingViewed]);
  const activeCount = jobs.filter((job) => job.status === "running" || job.status === "paused").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  return (
    <Modal opened={opened} onClose={onClose} title={<Group gap="xs"><Text fw={600}>Activity Center</Text><Tooltip label="Notification settings"><ActionIcon variant="subtle" color="gray" aria-label="Notification settings" onClick={onSettings}><IconSettings size={17} /></ActionIcon></Tooltip></Group>} size="lg">
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="updates" leftSection={<IconChartLine size={15} />}
            rightSection={notices.data?.length ? <Badge variant="light" size="xs">{notices.data.length}</Badge> : undefined}>Updates</Tabs.Tab>
          <Tabs.Tab value="processing" leftSection={<IconActivity size={15} />}
            rightSection={failedCount ? <Badge variant="light" color="red" size="xs">{failedCount} failed</Badge> :
              activeCount ? <Badge variant="light" size="xs">{activeCount}</Badge> : undefined}>Processing</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="updates">
          <Text size="xs" c="dimmed" mb="sm">New cell data affecting your analyses.</Text>
          <ScrollArea.Autosize mah="65vh" type="auto" offsetScrollbars>
            {notices.isLoading ? <Text size="sm" c="dimmed">Loading analysis updates…</Text> :
              notices.isError ? <Alert color="red" title="Could not load analysis updates">
                <Button variant="subtle" size="compact-sm" onClick={() => void notices.refetch()}>Try again</Button>
              </Alert> : <UpdateEntries notices={notices.data ?? []} onOpenAnalysis={onOpenAnalysis} />}
          </ScrollArea.Autosize>
          <Text size="xs" c="dimmed" mt="sm">Select an analysis to open it. Status shows its current readiness.</Text>
        </Tabs.Panel>
        <Tabs.Panel value="processing">
          <Text size="xs" c="dimmed" mb="sm">Cache preparation, previews, and other background work.</Text>
          <ScrollArea.Autosize mah="65vh" type="auto" offsetScrollbars>
            <ProcessingJobs jobs={jobs} loading={loading} failed={failed} />
          </ScrollArea.Autosize>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function ProcessingJobs({ jobs, loading, failed }: { jobs: BackgroundJob[]; loading: boolean; failed: boolean }) {
  const activeJob = jobs.find((job) => job.status === "running") ?? null;
  return <>
{loading ? (
          <Text c="dimmed" size="sm">Loading background activity...</Text>
        ) : failed ? (
          <Alert color="red">Could not load background activity.</Alert>
        ) : (jobs ?? []).length === 0 ? (
          <Text c="dimmed" size="sm">No background work has run in this session.</Text>
        ) : (
          <Accordion
            variant="separated"
            defaultValue={
              activeJob
                ? jobKey(activeJob)
                : jobs?.[0]
                  ? jobKey(jobs[0])
                  : null
            }
          >
            {(jobs ?? []).map((job) => {
              const progress = importProgressPercent(job) ?? (job.total ? 0 : 100);
              const count = importProgressCount(job);
              const jobColor = job.status === "failed" ? "red" : job.status === "running" ? "teal" : "gray";
              return (
                <Accordion.Item key={jobKey(job)} value={jobKey(job)}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap" pr="sm">
                      <div>
                        <Group gap="xs">
                          <Text fw={700}>{job.title}</Text>
                          <Badge size="sm" variant="light" color={jobColor}>{job.status}</Badge>
                        </Group>
                        <Text size="sm" c="dimmed" mt={2}>{job.description}</Text>
                      </div>
                      <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                        {count.current} / {count.total}
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <Progress
                        value={progress}
                        animated={job.status === "running"}
                        color={jobColor}
                      />
                      <Group gap="xl">
                        <Text size="xs" c="dimmed">
                          Started {new Date(job.started_at).toLocaleString()}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {job.completed_at
                            ? `Finished ${new Date(job.completed_at).toLocaleString()}`
                            : "Still running"}
                        </Text>
                      </Group>
                      {Object.keys(job.counters).length ? (
                        <Group gap={6}>
                          {Object.entries(job.counters).map(([label, count]) => (
                            <Badge
                              key={label}
                              size="sm"
                              variant="light"
                              color={label === "failed" || label === "offline" ? "red" : label === "changed" || label === "reparsed" ? "orange" : label === "cached" ? "gray" : "teal"}
                            >
                              {count} {label === "reparsed" ? "re-parsed" : label === "cached" ? "from cache" : label}
                            </Badge>
                          ))}
                        </Group>
                      ) : null}
                      {job.error ? <Alert color="red">{job.error}</Alert> : null}
                      {job.items.length ? (
                        <ScrollArea h={Math.min(300, Math.max(90, job.items.length * 43))} type="auto" offsetScrollbars>
                          <Stack gap={6}>
                            {job.items.map((item) => (
                              <Paper key={item.id} withBorder px="sm" py={8} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                                <Group justify="space-between" wrap="nowrap">
                                  <div style={{ minWidth: 0 }}>
                                    <Text size="sm" truncate title={item.label}>{item.label}</Text>
                                    {item.detail ? <Text size="xs" c="dimmed">{item.detail}</Text> : null}
                                    {item.error ? <Text size="xs" c="red">{item.error}</Text> : null}
                                  </div>
                                  <Badge
                                    size="sm"
                                    variant="light"
                                    color={
                                      item.status === "ready"
                                        ? "teal"
                                        : item.status === "changed"
                                          ? "orange"
                                          : item.status === "failed" || item.status === "offline"
                                            ? "red"
                                            : "gray"
                                    }
                                  >
                                    {item.status}
                                  </Badge>
                                </Group>
                              </Paper>
                            ))}
                          </Stack>
                        </ScrollArea>
                      ) : null}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        )}
  </>;
}
