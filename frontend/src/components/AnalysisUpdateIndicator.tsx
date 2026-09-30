import { ActionIcon, Badge, Button, Group, Popover, Text, type ButtonProps } from "@mantine/core";
import { IconActivity, IconSettings, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { cloneElement, useEffect, useRef, useState, type ReactElement, type ComponentPropsWithoutRef } from "react";
import { get, type AnalysisUpdateNotice } from "../api";
import { APP_BRANDING } from "../appChannel";
import { ANALYSIS_UPDATES_VIEWED, acknowledgeUpdates, readSeenUpdates, unreadUpdates, updateSummary } from "../analysisUpdateNoticePolicy";
import { isTauriApp } from "../downloads";
import { listenForAnalysisUpdateNotification, showAnalysisUpdateNotification } from "../analysisUpdateNotifications";
import { loadNotificationPreferences, NOTIFICATION_PREFERENCES_CHANGED, readToastBaseline, saveToastBaseline } from "../notificationPreferences";

export function AnalysisUpdateIndicator({ databaseId, activityOpen, onOpen, onSettings, children }: {
  databaseId: string | null; activityOpen: boolean; onOpen: () => void; onSettings: () => void; children: ReactElement<ButtonProps & ComponentPropsWithoutRef<"button">>;
}) {
  const [preferences, setPreferences] = useState(() => loadNotificationPreferences(window.localStorage));
  const attempted = useRef(new Set<string>());
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const [seen, setSeen] = useState(() => readSeenUpdates(window.localStorage, databaseId ?? ""));
  const [bubbleVersion, setBubbleVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const notices = useQuery({
    queryKey: ["analysis-updates", databaseId],
    queryFn: () => get<AnalysisUpdateNotice[]>("/api/analysis-updates?limit=30"),
    enabled: Boolean(databaseId),
    refetchInterval: 5000,
    refetchIntervalInBackground: isTauriApp() && preferences.windowsDataUpdatesEnabled,
  });
  useEffect(() => {
    const refresh = () => setPreferences(loadNotificationPreferences(window.localStorage));
    window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED, refresh);
    return () => window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED, refresh);
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten = () => undefined as void;
    void listenForAnalysisUpdateNotification((payload) => {
      if (!disposed && payload.databaseId === databaseId) openRef.current();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten(); };
  }, [databaseId]);
  useEffect(() => {
    if (!databaseId || !notices.data || !isTauriApp()) return;
    const baseline = readToastBaseline(window.localStorage, databaseId);
    const ids = notices.data.map((notice) => notice.id);
    if (baseline == null || !preferences.windowsDataUpdatesEnabled || activityOpen) {
      saveToastBaseline(window.localStorage, databaseId, [...(baseline ?? []), ...ids]);
      return;
    }
    const pending = unreadUpdates(notices.data, readSeenUpdates(window.localStorage, databaseId))
      .filter((notice) => !baseline.includes(notice.id) && !attempted.current.has(`${databaseId}:${notice.id}`));
    if (!pending.length) return;
    pending.forEach((notice) => attempted.current.add(`${databaseId}:${notice.id}`));
    const counts = updateSummary(pending);
    void showAnalysisUpdateNotification(databaseId, counts.analyses, counts.cells).then((shown) => {
      if (shown) saveToastBaseline(window.localStorage, databaseId,
        [...(readToastBaseline(window.localStorage, databaseId) ?? []), ...pending.map((notice) => notice.id)]);
    });
  }, [databaseId, notices.data, preferences.windowsDataUpdatesEnabled, activityOpen]);
  useEffect(() => {
    const refresh = () => setSeen(readSeenUpdates(window.localStorage, databaseId ?? ""));
    refresh();
    window.addEventListener(ANALYSIS_UPDATES_VIEWED, refresh);
    return () => window.removeEventListener(ANALYSIS_UPDATES_VIEWED, refresh);
  }, [databaseId]);
  const unread = unreadUpdates(notices.data ?? [], seen);
  const summary = updateSummary(unread);
  const version = unread.map((notice) => `${notice.id}:${notice.finished_at}`).join("|");
  useEffect(() => {
    if (!preferences.inAppEnabled || !version || activityOpen || version === dismissedVersion) {
      setBubbleVersion(null);
      return;
    }
    setBubbleVersion(version);
    const timer = window.setTimeout(() => {
      setDismissedVersion(version);
      setBubbleVersion(null);
    }, 7000);
    return () => window.clearTimeout(timer);
  }, [version, dismissedVersion, activityOpen, preferences.inAppEnabled]);
  const dismiss = () => { setDismissedVersion(version); setBubbleVersion(null); };
  const open = () => {
    if (databaseId) acknowledgeUpdates(window.localStorage, databaseId, notices.data ?? []);
    setSeen(readSeenUpdates(window.localStorage, databaseId ?? ""));
    dismiss();
    onOpen();
  };
  const hasUnread = preferences.inAppEnabled && unread.length > 0;
  return (
    <Popover opened={preferences.inAppEnabled && Boolean(bubbleVersion) && !activityOpen} onClose={dismiss} position="bottom-end"
      withArrow shadow="sm" width={340} withinPortal transitionProps={{ duration: 160 }}>
      <Popover.Target>
        {cloneElement(children, {
          onClick: open,
          ...(hasUnread ? {
            variant: "outline", color: APP_BRANDING.primaryColor,
            leftSection: <IconActivity size={14} />,
            children: `Activity · ${summary.analyses} ${summary.analyses === 1 ? "analysis" : "analyses"} updated`,
            rightSection: <Badge size="xs" variant="filled" color={APP_BRANDING.primaryColor}>{summary.analyses}</Badge>,
            "aria-label": `Activity: ${summary.analyses} ${summary.analyses === 1 ? "analysis" : "analyses"} received new data`,
          } : {}),
        })}
      </Popover.Target>
      <Popover.Dropdown maw="calc(100vw - 24px)">
        <Group gap="xs" wrap="nowrap" align="flex-start" role="status" aria-live="polite">
          <div style={{ minWidth: 0, flex: 1 }}>
            <Text size="sm" fw={600}>Your analyses have new data</Text>
            <Text size="xs" c="dimmed" mt={3}>{summary.analyses} {summary.analyses === 1 ? "analysis" : "analyses"} · {summary.cells} {summary.cells === 1 ? "cell" : "cells"} updated</Text>
          </div>
          <Button variant="subtle" size="compact-sm" onClick={open}>Review</Button>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Notification settings" onClick={() => { dismiss(); onSettings(); }}><IconSettings size={14} /></ActionIcon>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Dismiss update message" onClick={dismiss}><IconX size={14} /></ActionIcon>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
