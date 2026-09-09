import { Button, Modal, Progress, Stack, Text } from "@mantine/core";
import { IconActivity } from "@tabler/icons-react";
import { useState, useSyncExternalStore } from "react";
import { APP_BRANDING } from "../appChannel";
import { readWarmupDebug, subscribeWarmupDebug } from "../features/analyses/editor/families/time-capacity/timeCapacityWarmupDebug";

/** Temporary diagnostic UI; keep separate from ordinary background Activity. */
export function NavigationWarmupDebugButton() {
  const [opened, setOpened] = useState(false);
  const status = useSyncExternalStore(subscribeWarmupDebug, readWarmupDebug);
  const percent = status.total ? 100 * status.completed / status.total : 0;
  const color = status.state === "Error" ? "red" : APP_BRANDING.primaryColor;
  return <>
    <Button variant="subtle" size="compact-sm" color={color}
      leftSection={<IconActivity size={14} />} onClick={() => setOpened(true)}
      aria-label={`Navigation warmup: ${status.state}, ${status.completed} of ${status.total} Cells checked`}
      title={status.reason}>
      <Stack gap={2} style={{ minWidth: 160 }}>
        <Text size="xs">Warmup · {status.state} {status.total ? `${Math.floor(percent)}%` : ""}</Text>
        <Progress value={percent} size={3} color={color} animated={status.inFlight}
          aria-label="Navigation warmup progress" />
      </Stack>
    </Button>
    <Modal opened={opened} onClose={() => setOpened(false)} title="Navigation warmup · debug" size="md">
      <Stack gap="xs">
        <Text size="sm" fw={700}>{status.state}</Text>
        <Text size="sm">{status.reason}</Text>
        <Progress value={percent} color={color} animated={status.inFlight}
          aria-label="Cell preparation progress" />
        <Text size="sm">{status.completed} / {status.total} Cells checked {status.total ? `(${percent.toFixed(1)}%)` : ""}</Text>
        <Text size="xs" c="dimmed">Full-resolution data is prepared once per eligible Cell. Navigation assembles windows on demand instead of storing every overlapping window.</Text>
        <Text size="sm">Analysis: {status.analysisId ?? "—"}</Text>
        <Text size="xs" style={{ overflowWrap: "anywhere" }}>Plot: {status.plot || "—"}</Text>
        <Text size="sm">Preparation batch: {status.inFlight ? "Running" : "Idle"}</Text>
        <Text size="sm">{status.inFlight ? "In flight" : "Last request"}: {status.request}</Text>
        <Text size="sm">Last response: {status.lastMs === null ? "—" : `${Math.round(status.lastMs)} ms`}</Text>
        <Text size="sm">Reused: {status.hits} · Newly prepared: {status.misses} · Skipped: {status.skipped}</Text>
        <Text size="xs" c="dimmed">Clicks pause new admissions, including opening this panel. It resumes after idle; mouse movement does not pause it. An in-flight request is allowed to finish.</Text>
      </Stack>
    </Modal>
  </>;
}
