import {
  Box,
  Button,
  Divider,
  Group,
  Indicator,
  Loader,
  Menu,
  SegmentedControl,
  Stack,
  Text,
  useMantineColorScheme,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconBug,
  IconChevronDown,
  IconDownload,
  IconPower,
  IconRefresh,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { get, post, type AutomationPauseState } from "../api";
import { APP_BRANDING } from "../appChannel";
import { hasDirtyAnalysisWorkspaceEditors } from "../features/analyses/workspace/analysisWorkspace";
import {
  getUpdateMenuLabel,
  isUpdateMenuDisabled,
  isUpdateMenuLoading,
} from "../appUpdater";
import { isTauriApp } from "../downloads";
import { useOptionalAppUpdate } from "./AppUpdateCoordinator";

const PAUSE_QUERY_KEY = ["automation-pause"] as const;

const PAUSE_PRESETS = [
  { label: "30 min", minutes: 30 },
  { label: "2 h", minutes: 120 },
  { label: "8 h", minutes: 480 },
  { label: "24 h", minutes: 1440 },
] as const;

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} m left`;
  if (minutes > 0) return `${minutes} m left`;
  return "less than 1 m left";
}

function confirmDestructiveReload(
  title: string,
  body: string,
  confirmLabel: string,
  onConfirm: () => void,
) {
  if (!hasDirtyAnalysisWorkspaceEditors()) {
    onConfirm();
    return;
  }
  modals.openConfirmModal({
    title,
    children: <Text size="sm">{body}</Text>,
    labels: { confirm: confirmLabel, cancel: "Cancel" },
    confirmProps: { color: "red" },
    onConfirm,
  });
}

export function QuickSettingsMenu({ onOpenDebug }: { onOpenDebug?: () => void }) {
  const queryClient = useQueryClient();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const tauri = isTauriApp();
  const appUpdate = useOptionalAppUpdate();
  const brandColor = APP_BRANDING.primaryColor;
  const [menuOpen, setMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const pause = useQuery({
    queryKey: PAUSE_QUERY_KEY,
    queryFn: () => get<AutomationPauseState>("/api/automation/pause"),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!menuOpen || !pause.data?.paused) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [menuOpen, pause.data?.paused]);

  const setPause = useMutation({
    mutationFn: (minutes: number | null) =>
      post<AutomationPauseState>("/api/automation/pause", { minutes }),
    onSuccess: (data) => {
      setNowMs(Date.now());
      queryClient.setQueryData(PAUSE_QUERY_KEY, data);
    },
  });

  const pausedUntil = pause.data?.paused_until ?? null;
  const secondsRemaining = (() => {
    if (!pausedUntil) return null;
    const untilMs = Date.parse(pausedUntil);
    if (Number.isNaN(untilMs)) return pause.data?.seconds_remaining ?? null;
    return Math.max(0, Math.floor((untilMs - nowMs) / 1000));
  })();
  const isPaused = Boolean(pausedUntil && (secondsRemaining ?? 0) > 0);

  const reloadInterface = () => {
    confirmDestructiveReload(
      "Reload the interface?",
      "Unsaved plot changes in open analysis tabs will be lost. The backend and its caches stay running.",
      "Reload",
      () => window.location.reload(),
    );
  };

  const restartApp = () => {
    confirmDestructiveReload(
      "Restart CellXplorer?",
      "Unsaved plot changes in open analysis tabs will be lost. The app and its Python backend will fully relaunch.",
      "Restart",
      () => {
        void (async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("restart_app");
            // A successful schedule exits the process; reaching here means the
            // command returned without restarting.
            notifications.show({
              message: "Restart did not complete. The app is still running.",
              color: "red",
            });
          } catch (error) {
            // Do not fall back to reload: stop_backend may already have run,
            // and a page reload would look like progress while the backend is gone.
            // Delay the toast so a successful exit (IPC drop) does not flash it.
            const message =
              error instanceof Error ? error.message : "Could not restart CellXplorer.";
            window.setTimeout(() => {
              notifications.show({ message, color: "red" });
            }, 1500);
          }
        })();
      },
    );
  };

  return (
    <Menu
      shadow="md"
      width={320}
      position="bottom-end"
      opened={menuOpen}
      onChange={setMenuOpen}
    >
      <Menu.Target>
        <Indicator
          color={brandColor}
          size={16}
          label="1"
          offset={4}
          position="top-end"
          disabled={!appUpdate?.showUpdateBadge}
        >
          <Indicator
            color="yellow"
            size={8}
            offset={4}
            position="bottom-end"
            disabled={!isPaused}
            processing={isPaused}
          >
            <Button
              size="sm"
              variant="subtle"
              color={isPaused ? "yellow" : brandColor}
              px="sm"
              aria-label={
                appUpdate?.showUpdateBadge
                  ? "Power and settings menu, 1 application update available"
                  : "Power and settings menu"
              }
              rightSection={<IconChevronDown size={14} stroke={1.75} />}
            >
              <IconPower size={18} stroke={1.75} />
            </Button>
          </Indicator>
        </Indicator>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconRefresh size={14} />} onClick={reloadInterface}>
          Reload interface
        </Menu.Item>
        {tauri ? (
          <Menu.Item leftSection={<IconPower size={14} />} onClick={restartApp}>
            Restart CellXplorer
          </Menu.Item>
        ) : null}

        <Divider my={6} />

        <Box px="sm" py={4}>
          <Text size="xs" c="dimmed" mb={6}>
            Appearance
          </Text>
          <SegmentedControl
            size="xs"
            fullWidth
            value={colorScheme}
            onChange={(value) => setColorScheme(value as "auto" | "light" | "dark")}
            data={[
              { label: "Auto", value: "auto" },
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
            ]}
          />
        </Box>

        <Divider my={6} />

        <Box px="sm" py={4}>
          <Text size="xs" c="dimmed" mb={6}>
            Background automation
          </Text>
          <Stack gap={8}>
            <Group gap={8} wrap="nowrap">
              <Box
                w={8}
                h={8}
                style={{
                  borderRadius: 999,
                  background: isPaused
                    ? "var(--mantine-color-yellow-6)"
                    : "var(--mantine-color-teal-6)",
                  flexShrink: 0,
                }}
              />
              <Text size="sm">
                {isPaused
                  ? `Paused · ${formatRemaining(secondsRemaining ?? 0)}`
                  : "Running"}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Pause for
            </Text>
            <Group gap={6}>
              {PAUSE_PRESETS.map((preset) => (
                <Button
                  key={preset.minutes}
                  size="compact-xs"
                  variant="light"
                  color="gray"
                  loading={setPause.isPending}
                  onClick={() => setPause.mutate(preset.minutes)}
                >
                  {preset.label}
                </Button>
              ))}
            </Group>
            {isPaused ? (
              <Button
                size="compact-xs"
                variant="light"
                color={brandColor}
                loading={setPause.isPending}
                onClick={() => setPause.mutate(null)}
              >
                Resume now
              </Button>
            ) : null}
          </Stack>
        </Box>

        {onOpenDebug ? (
          <>
            <Divider my={6} />
            <Menu.Item
              leftSection={<IconBug size={14} />}
              onClick={() => {
                setMenuOpen(false);
                onOpenDebug();
              }}
            >
              Debug
            </Menu.Item>
          </>
        ) : null}

        {appUpdate?.updateUiEnabled ? (
          <>
            <Divider my={6} />
            <Menu.Item
              leftSection={
                isUpdateMenuLoading(appUpdate.state) ? (
                  <Loader size={14} color={brandColor} />
                ) : (
                  <IconDownload size={14} />
                )
              }
              disabled={isUpdateMenuDisabled(appUpdate.state)}
              onClick={() => {
                setMenuOpen(false);
                appUpdate.handleMenuClick();
              }}
            >
              {getUpdateMenuLabel(appUpdate.state)}
            </Menu.Item>
          </>
        ) : null}
      </Menu.Dropdown>
    </Menu>
  );
}

export { PAUSE_QUERY_KEY };
