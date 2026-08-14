import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  ColorInput,
  Divider,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconActivityHeartbeat, IconBell, IconChartLine, IconDatabaseCog, IconDeviceDesktop, IconDeviceFloppy, IconDownload, IconFolderOpen, IconGauge, IconHistory, IconInfoCircle, IconPlus, IconRefresh, IconRulerMeasure, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { APP_BRANDING } from "../appChannel";

import {
  ApiError,
  get,
  post,
  put,
  type ActiveMaterialPreset,
  type ActiveMaterialPresetSettings,
  type ActivityEvent,
  type AppSession,
  type BackgroundJob,
  type ColorPalette,
  type ColorPaletteSettings,
  type CacheInventory,
  type CacheOffender,
  type CacheSettings,
  type DownloadSettings,
  type ElectrodeAreaPreset,
  type ElectrodeAreaPresetSettings,
  type PlotStylePresetSettings,
  type AutomationPauseState,
  type SourceMonitoringSettings,
} from "../api";
import { isTauriApp } from "../downloads";
import { FilenameTemplateEditor } from "../components/FilenameTemplateEditor";
import { WARMUP_NOW_EVENT } from "../features/analyses/editor/artifacts/CacheWarmupCoordinator";
import { PAUSE_QUERY_KEY } from "../components/QuickSettingsMenu";
import {
  loadAnalysisWorkspaceMemoryPolicy,
  saveAnalysisWorkspaceMemoryPolicy,
  type AnalysisWorkspaceMemoryPolicy,
} from "../features/analyses/workspace/analysisWorkspace";
import {
  loadAppUpdatePreferences,
  saveAppUpdatePreferences,
  UPDATE_PREFERENCES_CHANGED_EVENT,
  type AppUpdateIntervalUnit,
  type AppUpdatePreferences,
} from "../appUpdater";
import { useOptionalAppUpdate } from "../components/AppUpdateCoordinator";
import { useBetaInstall } from "../components/BetaInstallCoordinator";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

const CACHE_CATEGORY_HINTS = {
  scientific:
    "Parsed copies of your cycler files (raw datapoints and per-cycle tables) stored as fast Parquet caches, keyed by file checksum. Cleaning the category preserves caches whose original source is offline.",
  analysis_results:
    "Numerical outputs of analysis computations: the series and metrics behind each plot view. Cheap to regenerate from the scientific cache the next time a plot is opened.",
  analysis_artifacts:
    "Full rendered plot packages (SVG plus the interactive figure) that power instant saved-plot restore and portable reports. Regenerated on demand.",
  thumbnails:
    "The small preview images on saved-plot cards. They total a few megabytes, but recreating each one requires a full plot render, so automatic cleanup never touches them.",
} as const;

function CacheStat({
  label,
  hint,
  bytes,
}: {
  label: string;
  hint?: string;
  bytes: number;
}) {
  return (
    <div>
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed">{label}</Text>
        {hint ? (
          <Tooltip label={hint} multiline w={300} position="top-start" withArrow>
            <IconInfoCircle size={13} color="var(--mantine-color-gray-5)" style={{ cursor: "help", flexShrink: 0 }} />
          </Tooltip>
        ) : null}
      </Group>
      <Text fw={700}>{formatBytes(bytes)}</Text>
    </div>
  );
}

/**
 * The next three checks the current form would produce.
 *
 * Computed on the server: `calculate_next_run` handles interval and fixed-time
 * schedules, weekly steps, and local-time resolution, and reimplementing any of
 * that here would give us two schedule implementations to keep in agreement.
 *
 * The endpoint runs the same validation as the save, so an impossible retry span
 * surfaces here while the user is still editing rather than on Save.
 */
function SchedulePreviewLine({ form }: { form: SourceMonitoringSettings }) {
  const [debounced, setDebounced] = useState(form);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(form), 400);
    return () => window.clearTimeout(timer);
  }, [form]);

  const preview = useQuery({
    queryKey: ["source-monitor-schedule-preview", JSON.stringify(debounced)],
    queryFn: () =>
      post<{ runs: string[] }>("/api/source-monitor/schedule-preview", debounced),
    retry: false,
    // Keep the last good schedule on screen while a new one is in flight, so the
    // line does not flicker empty on every keystroke.
    placeholderData: (previous) => previous,
  });

  const error = preview.error;
  if (error instanceof ApiError && error.status === 422) {
    return (
      <Alert color="orange" variant="light" title="This schedule will not work">
        {error.message}
      </Alert>
    );
  }
  // Any other failure (backend down, network) — say nothing rather than show a
  // schedule that might no longer be what the server would do.
  if (!preview.data) return null;

  return (
    <Paper withBorder p="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb={4}>
        Next checks
      </Text>
      <Text size="sm" c={form.enabled ? undefined : "dimmed"}>
        {preview.data.runs.map((run) => new Date(run).toLocaleString()).join(" · ")}
      </Text>
      {form.enabled ? null : (
        <Text size="xs" c="dimmed" mt={4}>
          Automatic checks are off — this is what the schedule would do once enabled.
        </Text>
      )}
    </Paper>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [analysisMemoryPolicy, setAnalysisMemoryPolicy] = useState<AnalysisWorkspaceMemoryPolicy>(
    loadAnalysisWorkspaceMemoryPolicy,
  );
  const [savedUpdatePreferences, setSavedUpdatePreferences] = useState<AppUpdatePreferences>(() =>
    loadAppUpdatePreferences(window.localStorage),
  );
  const [updatePreferences, setUpdatePreferences] = useState<AppUpdatePreferences>(
    savedUpdatePreferences,
  );
  const appUpdate = useOptionalAppUpdate();
  const betaInstall = useBetaInstall();
  const activeTab = location.pathname.endsWith("/activity")
    ? "activity"
    : location.pathname.endsWith("/cache")
      ? "cache"
    : location.pathname.endsWith("/monitoring")
      ? "monitoring"
    : location.pathname.endsWith("/metadata")
      ? "metadata"
    : location.pathname.endsWith("/plots")
      ? "plots"
    : location.pathname.endsWith("/desktop")
      ? "desktop"
    : location.pathname.endsWith("/updates")
      ? "updates"
    : location.pathname.endsWith("/performance")
      ? "performance"
      : "downloads";
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<DownloadSettings>("/api/settings"),
    enabled: activeTab === "downloads",
  });
  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: () => get<ActivityEvent[]>("/api/activity?limit=200"),
    enabled: activeTab === "activity",
  });
  const sessions = useQuery({
    queryKey: ["app-sessions"],
    queryFn: () => get<AppSession[]>("/api/sessions?limit=50"),
    enabled: activeTab === "activity",
  });
  const monitoring = useQuery({
    queryKey: ["source-monitor-settings"],
    queryFn: () => get<SourceMonitoringSettings>("/api/source-monitor/settings"),
    enabled: activeTab === "monitoring",
  });
  const automationPause = useQuery({
    queryKey: PAUSE_QUERY_KEY,
    queryFn: () => get<AutomationPauseState>("/api/automation/pause"),
    enabled: activeTab === "monitoring",
    refetchInterval: 60_000,
  });
  const resumeAutomation = useMutation({
    mutationFn: () => post<AutomationPauseState>("/api/automation/pause", { minutes: null }),
    onSuccess: (data) => {
      queryClient.setQueryData(PAUSE_QUERY_KEY, data);
      notifications.show({ message: "Automatic updates resumed.", color: "teal" });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const areaPresets = useQuery({
    queryKey: ["electrode-area-presets"],
    queryFn: () => get<ElectrodeAreaPresetSettings>("/api/settings/electrode-area-presets"),
    enabled: activeTab === "metadata",
  });
  const materialPresets = useQuery({
    queryKey: ["active-material-presets"],
    queryFn: () =>
      get<ActiveMaterialPresetSettings>("/api/settings/active-material-presets"),
    enabled: activeTab === "metadata",
  });
  const plotStylePresets = useQuery({
    queryKey: ["plot-style-presets"],
    queryFn: () => get<PlotStylePresetSettings>("/api/settings/plot-style-presets"),
    enabled: activeTab === "plots",
  });
  const colorPalettes = useQuery({
    queryKey: ["color-palettes"],
    queryFn: () => get<ColorPaletteSettings>("/api/settings/color-palettes"),
    enabled: activeTab === "plots",
  });
  const cacheSettings = useQuery({
    queryKey: ["cache-settings"],
    queryFn: () => get<CacheSettings>("/api/cache/settings"),
    enabled: activeTab === "cache",
  });
  const cacheInventory = useQuery({
    queryKey: ["cache-inventory"],
    queryFn: () => get<CacheInventory>("/api/cache/inventory?limit=30"),
    enabled: activeTab === "cache",
  });
  const [mode, setMode] = useState<DownloadSettings["download_mode"]>("ask");
  const [folder, setFolder] = useState("");
  const [filenameTemplate, setFilenameTemplate] = useState(
    "{analysis} - {plot_title}"
  );
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const [monitorForm, setMonitorForm] = useState<SourceMonitoringSettings>({
    enabled: false,
    schedule_mode: "interval",
    interval_value: 6,
    interval_unit: "hours",
    scheduled_every_value: 1,
    scheduled_every_unit: "days",
    daily_time: "02:00",
    auto_update: false,
    scan_batch_size: 100,
    stability_value: 5,
    stability_unit: "seconds",
    retry_count: 3,
    retry_delay_value: 5,
    retry_delay_unit: "minutes",
    next_run_at: null,
    last_started_at: null,
    last_finished_at: null,
    last_status: null,
  });
  const [presetForm, setPresetForm] = useState<ElectrodeAreaPreset[]>([]);
  const [materialPresetForm, setMaterialPresetForm] = useState<ActiveMaterialPreset[]>([]);
  const [paletteForm, setPaletteForm] = useState<ColorPalette[]>([]);
  const [cacheForm, setCacheForm] = useState<CacheSettings>({
    warmup_enabled: true,
    only_when_hidden: false,
    idle_seconds: 15,
    scientific_limit_bytes: 10 * 1024 ** 3,
    analysis_limit_bytes: 1024 ** 3,
  });

  useEffect(() => {
    if (!settings.data) return;
    setMode(settings.data.download_mode);
    setFolder(settings.data.download_folder ?? "");
    setFilenameTemplate(settings.data.export_filename_template);
  }, [settings.data]);

  useEffect(() => {
    if (monitoring.data) setMonitorForm(monitoring.data);
  }, [monitoring.data]);

  useEffect(() => {
    if (areaPresets.data) setPresetForm(areaPresets.data.presets);
  }, [areaPresets.data]);

  useEffect(() => {
    if (materialPresets.data) setMaterialPresetForm(materialPresets.data.presets);
  }, [materialPresets.data]);
  useEffect(() => {
    if (colorPalettes.data) setPaletteForm(colorPalettes.data.palettes);
  }, [colorPalettes.data]);
  useEffect(() => {
    if (cacheSettings.data) setCacheForm(cacheSettings.data);
  }, [cacheSettings.data]);

  useEffect(() => {
    if (activeTab !== "desktop" || !isTauriApp()) return;
    setAutostartLoading(true);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("is_autostart_enabled"))
      .then(setAutostartEnabled)
      .catch((error) =>
        notifications.show({
          message: error instanceof Error ? error.message : "Could not read the startup setting.",
          color: "red",
        }),
      )
      .finally(() => setAutostartLoading(false));
  }, [activeTab]);

  const changeAutostart = async (enabled: boolean) => {
    setAutostartLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const saved = await invoke<boolean>("set_autostart_enabled", { enabled });
      setAutostartEnabled(saved);
      notifications.show({
        message: saved
          ? `${APP_BRANDING.productName} will launch in the tray when Windows starts.`
          : "Launch at Windows startup disabled.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not update the startup setting.",
        color: "red",
      });
    } finally {
      setAutostartLoading(false);
    }
  };

  const saveSettings = useMutation({
    mutationFn: () =>
      put<DownloadSettings>("/api/settings", {
        download_mode: mode,
        download_folder: folder.trim() || null,
        export_filename_template: filenameTemplate.trim(),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["settings"], saved);
      setFolder(saved.download_folder ?? "");
      setFilenameTemplate(saved.export_filename_template);
      notifications.show({ message: "Download settings saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save settings.", color: "red" }),
  });

  const saveMonitoring = useMutation({
    mutationFn: () => put<SourceMonitoringSettings>("/api/source-monitor/settings", monitorForm),
    onSuccess: (saved) => {
      queryClient.setQueryData(["source-monitor-settings"], saved);
      setMonitorForm(saved);
      notifications.show({ message: "Automatic source monitoring saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save source monitoring.", color: "red" }),
  });
  const saveAreaPresets = useMutation({
    mutationFn: () =>
      put<ElectrodeAreaPresetSettings>("/api/settings/electrode-area-presets", {
        presets: presetForm,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["electrode-area-presets"], saved);
      setPresetForm(saved.presets);
      notifications.show({ message: "Electrode-area presets saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save area presets.", color: "red" }),
  });
  const saveMaterialPresets = useMutation({
    mutationFn: () =>
      put<ActiveMaterialPresetSettings>("/api/settings/active-material-presets", {
        presets: materialPresetForm,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["active-material-presets"], saved);
      setMaterialPresetForm(saved.presets);
      notifications.show({ message: "Active-material presets saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({
        message: error.message || "Could not save material presets.",
        color: "red",
      }),
  });
  const saveColorPalettes = useMutation({
    mutationFn: () =>
      put<ColorPaletteSettings>("/api/settings/color-palettes", {
        palettes: paletteForm,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["color-palettes"], saved);
      setPaletteForm(saved.palettes);
      notifications.show({ message: "Color palettes saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({
        message: error.message || "Could not save color palettes.",
        color: "red",
      }),
  });
  const saveCacheSettings = useMutation({
    mutationFn: () => put<CacheSettings>("/api/cache/settings", cacheForm),
    onSuccess: (saved) => {
      queryClient.setQueryData(["cache-settings"], saved);
      setCacheForm(saved);
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      notifications.show({ message: "Cache settings saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save cache settings.", color: "red" }),
  });
  const refreshCacheNow = useMutation({
    mutationFn: () => post<{ id?: number }>("/api/cache/warmup/start?force=true"),
    onSuccess: (job) => {
      // Ask the idle coordinator to run at once instead of waiting for the
      // configured idle delay.
      window.dispatchEvent(new Event(WARMUP_NOW_EVENT));
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      const total = (job as { total?: number } | undefined)?.total ?? 0;
      notifications.show({
        message: total
          ? `Preparing ${total} plot${total === 1 ? "" : "s"} that need a refresh.`
          : "All saved plots are already up to date.",
        color: "teal",
      });
    },
    onError: (error: Error) =>
      notifications.show({
        message: error.message || "Could not start cache preparation.",
        color: "red",
      }),
  });
  const prepareScientific = useMutation({
    mutationFn: () =>
      post<BackgroundJob | { id: null; total: number; completed: number }>(
        "/api/cache/scientific/prepare",
      ),
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["cells"] });
      notifications.show({
        message: job.total
          ? `Preparing ${job.total} source file${job.total === 1 ? "" : "s"}.`
          : "All scientific data is already prepared.",
        color: "teal",
      });
    },
    onError: (error: Error) =>
      notifications.show({
        message: error.message || "Could not start scientific preparation.",
        color: "red",
      }),
  });
  const rebuildCache = useMutation({
    mutationFn: (kind: "thumbnails" | "saved-plots") =>
      post<{ bytes_removed: number; job: BackgroundJob }>(
        kind === "thumbnails"
          ? "/api/cache/thumbnails/rebuild"
          : "/api/cache/saved-plots/rebuild",
      ),
    onSuccess: (result, kind) => {
      window.dispatchEvent(new Event(WARMUP_NOW_EVENT));
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["analysis-database-thumbnail"] });
      notifications.show({
        message: result.job.total
          ? `${kind === "thumbnails" ? "Preview" : "Saved-plot"} rebuild queued for ${result.job.total} plot${result.job.total === 1 ? "" : "s"}.`
          : "There are no saved plots to rebuild.",
        color: "teal",
      });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });
  const cleanCache = useMutation({
    mutationFn: (payload: { category?: string; kind?: string; identifier?: string; force?: boolean }) =>
      post<{
        ok: boolean;
        bytes_removed: number;
        protected_items?: number;
        protected_bytes?: number;
      }>("/api/cache/cleanup", payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      notifications.show({
        message: result.protected_items
          ? `Freed ${formatBytes(result.bytes_removed)}. Preserved ${result.protected_items} offline or active cache item${result.protected_items === 1 ? "" : "s"} (${formatBytes(result.protected_bytes ?? 0)}).`
          : `Freed ${formatBytes(result.bytes_removed)}.`,
        color: result.protected_items ? "orange" : "teal",
      });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const deletePlotPreset = useMutation({
    mutationFn: (presetId: string) =>
      put<PlotStylePresetSettings>("/api/settings/plot-style-presets", {
        presets: (plotStylePresets.data?.presets ?? []).filter(
          (preset) => preset.id !== presetId
        ),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["plot-style-presets"], saved);
      notifications.show({ message: "Plot preset removed.", color: "teal" });
    },
  });
  const setDefaultPlotPreset = useMutation({
    mutationFn: (presetId: string) => {
      const target = (plotStylePresets.data?.presets ?? []).find(
        (preset) => preset.id === presetId,
      );
      if (!target) throw new Error("Plot preset not found.");
      return put<PlotStylePresetSettings>("/api/settings/plot-style-presets", {
        presets: (plotStylePresets.data?.presets ?? []).map((preset) => ({
          ...preset,
          is_default:
            preset.id === presetId
              ? !target.is_default
              : preset.plot_family === target.plot_family
                ? false
                : preset.is_default,
        })),
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["plot-style-presets"], saved);
      notifications.show({ message: "Default plot preset updated.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const chooseFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose default download folder",
      });
      if (typeof selected === "string") setFolder(selected);
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not open the folder picker.",
        color: "red",
      });
    }
  };

  const dirty =
    Boolean(settings.data) &&
    (settings.data?.download_mode !== mode ||
      (settings.data?.download_folder ?? "") !== folder ||
      settings.data?.export_filename_template !== filenameTemplate);
  const monitorConfig = (value: SourceMonitoringSettings) => ({
    enabled: value.enabled,
    schedule_mode: value.schedule_mode,
    interval_value: value.interval_value,
    interval_unit: value.interval_unit,
    scheduled_every_value: value.scheduled_every_value,
    scheduled_every_unit: value.scheduled_every_unit,
    daily_time: value.daily_time,
    auto_update: value.auto_update,
    scan_batch_size: value.scan_batch_size,
    stability_value: value.stability_value,
    stability_unit: value.stability_unit,
    retry_count: value.retry_count,
    retry_delay_value: value.retry_delay_value,
    retry_delay_unit: value.retry_delay_unit,
  });
  const monitoringDirty = Boolean(monitoring.data) &&
    JSON.stringify(monitorConfig(monitorForm)) !== JSON.stringify(monitorConfig(monitoring.data!));
  const presetsDirty = Boolean(areaPresets.data) &&
    JSON.stringify(presetForm) !== JSON.stringify(areaPresets.data?.presets ?? []);
  const materialPresetsDirty = Boolean(materialPresets.data) &&
    JSON.stringify(materialPresetForm) !==
      JSON.stringify(materialPresets.data?.presets ?? []);
  const palettesDirty = Boolean(colorPalettes.data) &&
    JSON.stringify(paletteForm) !== JSON.stringify(colorPalettes.data?.palettes ?? []);
  const cacheDirty = Boolean(cacheSettings.data) &&
    JSON.stringify(cacheForm) !== JSON.stringify(cacheSettings.data);
  const offenders = cacheInventory.data?.offenders ?? [];
  const offenderKey = (item: CacheOffender) => `${item.kind}:${item.id}`;
  const [selectedOffenders, setSelectedOffenders] = useState<string[]>([]);
  const lastOffenderIndex = useRef<number | null>(null);
  const visibleSelected = offenders.filter((item) => selectedOffenders.includes(offenderKey(item)));
  const toggleOffenderAt = (index: number, shiftKey: boolean) => {
    const key = offenderKey(offenders[index]);
    setSelectedOffenders((current) => {
      const selected = new Set(current);
      if (shiftKey && lastOffenderIndex.current !== null) {
        const [from, to] = [lastOffenderIndex.current, index].sort((a, b) => a - b);
        const turnOn = !selected.has(key);
        for (let i = from; i <= to; i += 1) {
          const rangeKey = offenderKey(offenders[i]);
          if (turnOn) selected.add(rangeKey);
          else selected.delete(rangeKey);
        }
      } else if (selected.has(key)) {
        selected.delete(key);
      } else {
        selected.add(key);
      }
      return [...selected];
    });
    lastOffenderIndex.current = index;
  };
  const cleanCacheBulk = useMutation({
    mutationFn: async (items: CacheOffender[]) => {
      let freed = 0;
      const failures: string[] = [];
      for (const item of items) {
        try {
          const result = await post<{ ok: boolean; bytes_removed: number }>("/api/cache/cleanup", {
            kind: item.kind,
            identifier: item.id,
            force: item.kind === "scientific" && !item.source_available,
          });
          freed += result.bytes_removed;
        } catch (error) {
          failures.push(item.label);
          void error;
        }
      }
      return { freed, failures };
    },
    onSuccess: ({ freed, failures }) => {
      setSelectedOffenders([]);
      lastOffenderIndex.current = null;
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      if (failures.length) {
        notifications.show({
          message: `Freed ${formatBytes(freed)}. Could not clean: ${failures.join(", ")}.`,
          color: "orange",
        });
      } else {
        notifications.show({ message: `Freed ${formatBytes(freed)}.`, color: "teal" });
      }
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const requestBulkOffenderCleanup = () => {
    if (visibleSelected.length === 0) return;
    const offline = visibleSelected.filter(
      (item) => item.kind === "scientific" && !item.source_available
    );
    const totalBytes = visibleSelected.reduce((sum, item) => sum + item.bytes, 0);
    modals.openConfirmModal({
      title: `Clean ${visibleSelected.length} cache item${visibleSelected.length === 1 ? "" : "s"}?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">This will free {formatBytes(totalBytes)} of regenerable data.</Text>
          {offline.length ? (
            <Alert color="orange">
              {offline.length === 1
                ? `The source file of "${offline[0].label}" is unavailable — its cache may be the only locally readable copy of that data.`
                : `${offline.length} selected items have unavailable source files — their caches may be the only locally readable copies of that data.`}
            </Alert>
          ) : null}
        </Stack>
      ),
      labels: { confirm: offline.length ? "Remove anyway" : "Clean cache", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => cleanCacheBulk.mutate(visibleSelected),
    });
  };
  const requestCategoryCleanup = (category: string, label: string) =>
    modals.openConfirmModal({
      title: `Clean ${label}?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">
            This removes regenerable cache files only. Your database and original cycling files are not changed.
          </Text>
          {category === "scientific" ? (
            <Alert color="orange">
              Scientific caches whose original source is offline, plus any cache currently being
              written, will be preserved automatically.
            </Alert>
          ) : null}
        </Stack>
      ),
      labels: { confirm: "Clean cache", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => cleanCache.mutate({ category }),
    });
  const requestCacheRebuild = (
    kind: "thumbnails" | "saved-plots",
    label: string,
  ) =>
    modals.openConfirmModal({
      title: `Rebuild ${label}?`,
      children: (
        <Text size="sm">
          Existing regenerable cache files will be cleared, then every saved plot that needs them
          will be prepared again in the background.
        </Text>
      ),
      labels: { confirm: "Start rebuild", cancel: "Cancel" },
      onConfirm: () => rebuildCache.mutate(kind),
    });
  const requestOffenderCleanup = (item: CacheOffender) => {
    const unavailable = item.kind === "scientific" && !item.source_available;
    modals.openConfirmModal({
      title: `Clean cache for ${item.label}?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">This will free {formatBytes(item.bytes)} of regenerable data.</Text>
          {unavailable ? (
            <Alert color="orange">
              The original source file is unavailable. This cache may be the only locally readable copy of its parsed data.
            </Alert>
          ) : null}
        </Stack>
      ),
      labels: { confirm: unavailable ? "Remove anyway" : "Clean cache", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => cleanCache.mutate({
        kind: item.kind,
        identifier: item.id,
        force: unavailable,
      }),
    });
  };
  const formatDateTime = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet";
  const updatePreferencesDirty =
    JSON.stringify(updatePreferences) !== JSON.stringify(savedUpdatePreferences);
  const saveUpdatePreferences = () => {
    const betaOptInEnabled = updatePreferences.betaUpdatesEnabled;
    saveAppUpdatePreferences(window.localStorage, updatePreferences);
    setSavedUpdatePreferences(updatePreferences);
    window.dispatchEvent(new Event(UPDATE_PREFERENCES_CHANGED_EVENT));
    if (!APP_BRANDING.isBeta && betaOptInEnabled) {
      void betaInstall?.checkForBeta("manual");
    }
    notifications.show({
      message: "Application update settings saved.",
      color: "teal",
    });
  };
  return (
    <Stack gap="lg" maw={980}>
      <Title order={2}>Settings</Title>

      <Tabs
        value={activeTab}
        onChange={(value) => navigate(
          value === "activity"
            ? "/settings/activity"
            : value === "cache"
              ? "/settings/cache"
            : value === "monitoring"
              ? "/settings/monitoring"
              : value === "metadata"
                ? "/settings/metadata"
              : value === "plots"
                ? "/settings/plots"
              : value === "desktop"
                ? "/settings/desktop"
              : value === "updates"
                ? "/settings/updates"
              : value === "performance"
                ? "/settings/performance"
                : "/settings",
        )}
      >
        <Tabs.List>
          <Tabs.Tab value="downloads" leftSection={<IconDownload size={15} />}>Downloads</Tabs.Tab>
          <Tabs.Tab value="monitoring" leftSection={<IconActivityHeartbeat size={15} />}>Source monitoring</Tabs.Tab>
          <Tabs.Tab value="metadata" leftSection={<IconRulerMeasure size={15} />}>Cell metadata</Tabs.Tab>
          <Tabs.Tab value="plots" leftSection={<IconChartLine size={15} />}>Plots & export</Tabs.Tab>
          <Tabs.Tab value="desktop" leftSection={<IconDeviceDesktop size={15} />}>Desktop</Tabs.Tab>
          <Tabs.Tab value="updates" leftSection={<IconBell size={15} />}>App updates</Tabs.Tab>
          <Tabs.Tab value="performance" leftSection={<IconGauge size={15} />}>Performance</Tabs.Tab>
          <Tabs.Tab value="cache" leftSection={<IconDatabaseCog size={15} />}>Cache</Tabs.Tab>
          <Tabs.Tab value="activity" leftSection={<IconHistory size={15} />}>Activity log</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="downloads" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Downloads</Title>
                <Text c="dimmed" size="sm">
                  Applies to plot images, PDF and SVG files, and CSV or Excel exports.
                </Text>
              </div>

              {settings.isError ? <Alert color="red">Could not load download settings.</Alert> : null}

              <div>
                <Text fw={600} size="sm" mb={6}>Save behavior</Text>
                <SegmentedControl
                  value={mode}
                  onChange={(value) => setMode(value as DownloadSettings["download_mode"])}
                  data={[
                    { label: "Choose each time", value: "ask" },
                    { label: "Use default folder", value: "folder" },
                  ]}
                />
              </div>

              {mode === "folder" ? (
                <div>
                  <Text fw={600} size="sm" mb={6}>Default folder</Text>
                  <Group align="end" wrap="nowrap">
                    <TextInput
                      value={folder}
                      onChange={(event) => setFolder(event.currentTarget.value)}
                      placeholder="C:\\Users\\name\\Documents\\CellXplorer exports"
                      style={{ flex: 1 }}
                      disabled={settings.isLoading}
                    />
                    {isTauriApp() ? (
                      <Button variant="default" leftSection={<IconFolderOpen size={16} />} onClick={chooseFolder}>
                        Browse
                      </Button>
                    ) : null}
                  </Group>
                  <Text c="dimmed" size="xs" mt={6}>
                    {isTauriApp()
                      ? "CellXplorer validates this folder before saving. Existing files are never overwritten."
                      : "In the browser, paste the full local folder path. CellXplorer validates it before saving."}
                  </Text>
                </div>
              ) : (
                <Text c="dimmed" size="sm">
                  {isTauriApp()
                    ? "A native Save As window will open for every export."
                    : "Your browser handles each download; whether it asks for a location follows its download settings."}
                </Text>
              )}

              <div>
                <Text fw={600} size="sm" mb={6}>Default export filename</Text>
                <FilenameTemplateEditor
                  value={filenameTemplate}
                  onChange={setFilenameTemplate}
                  label="Template"
                />
              </div>

              <Group justify="flex-end">
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={() => saveSettings.mutate()}
                  loading={saveSettings.isPending}
                  disabled={settings.isLoading || !dirty || (mode === "folder" && !folder.trim())}
                >
                  Save settings
                </Button>
              </Group>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="plots" pt="lg">
          <Stack gap="lg">
            <Paper withBorder p="lg">
              <Stack gap="md">
                <div>
                  <Title order={4}>Plot style presets</Title>
                  <Text c="dimmed" size="sm">
                    Create presets from the analysis style panel, where you can see the live plot.
                    Manage or remove them here.
                  </Text>
                </div>
                {plotStylePresets.isError && (
                  <Alert color="red">Could not load plot-style presets.</Alert>
                )}
                {(plotStylePresets.data?.presets ?? []).length === 0 ? (
                  <Alert color="gray">No saved plot-style presets.</Alert>
                ) : (
                  <Table withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Plot family</Table.Th>
                        <Table.Th>Default</Table.Th>
                        <Table.Th w={48} />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(plotStylePresets.data?.presets ?? []).map((preset) => (
                        <Table.Tr key={preset.id}>
                          <Table.Td>{preset.name}</Table.Td>
                          <Table.Td>{preset.plot_family.replace("_", " / ")}</Table.Td>
                          <Table.Td>
                            <Switch
                              checked={preset.is_default}
                              onChange={() => setDefaultPlotPreset.mutate(preset.id)}
                              aria-label={`Use ${preset.name} as default`}
                            />
                          </Table.Td>
                          <Table.Td>
                            <Button
                              variant="subtle"
                              color="red"
                              size="compact-xs"
                              onClick={() => deletePlotPreset.mutate(preset.id)}
                            >
                              <IconTrash size={15} />
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Stack>
            </Paper>

            <Paper withBorder p="lg">
              <Stack gap="md">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Title order={4}>Custom color palettes</Title>
                    <Text c="dimmed" size="sm">
                      Categorical palettes repeat in order. Sequential palettes run from the first
                      color to the last across the plotted series.
                    </Text>
                  </div>
                  <Button
                    variant="default"
                    leftSection={<IconPlus size={15} />}
                    onClick={() =>
                      setPaletteForm((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          name: "New palette",
                          kind: "categorical",
                          colors: ["#12b886", "#2563eb", "#f97316"],
                        },
                      ])
                    }
                  >
                    Add palette
                  </Button>
                </Group>
                {colorPalettes.isError && (
                  <Alert color="red">Could not load custom color palettes.</Alert>
                )}
                {paletteForm.map((palette, paletteIndex) => (
                  <Paper key={palette.id} withBorder p="md">
                    <Stack gap="sm">
                      <Group align="end" wrap="nowrap">
                        <TextInput
                          label="Name"
                          value={palette.name}
                          style={{ flex: 1 }}
                          onChange={(event) =>
                            setPaletteForm((current) =>
                              current.map((item, index) =>
                                index === paletteIndex
                                  ? { ...item, name: event.currentTarget.value }
                                  : item
                              )
                            )
                          }
                        />
                        <Select
                          label="Type"
                          value={palette.kind}
                          data={[
                            { value: "categorical", label: "Categorical" },
                            { value: "sequential", label: "Sequential" },
                          ]}
                          onChange={(value) =>
                            value &&
                            setPaletteForm((current) =>
                              current.map((item, index) =>
                                index === paletteIndex
                                  ? { ...item, kind: value as ColorPalette["kind"] }
                                  : item
                              )
                            )
                          }
                        />
                        <Button
                          variant="subtle"
                          color="red"
                          onClick={() =>
                            setPaletteForm((current) =>
                              current.filter((_, index) => index !== paletteIndex)
                            )
                          }
                        >
                          <IconTrash size={16} />
                        </Button>
                      </Group>
                      <Group gap="xs" align="end">
                        {palette.colors.map((color, colorIndex) => (
                          <Group key={`${palette.id}-${colorIndex}`} gap={4} wrap="nowrap">
                            <ColorInput
                              w={130}
                              label={`Color ${colorIndex + 1}`}
                              value={color}
                              onChange={(value) =>
                                setPaletteForm((current) =>
                                  current.map((item, index) =>
                                    index === paletteIndex
                                      ? {
                                          ...item,
                                          colors: item.colors.map((entry, entryIndex) =>
                                            entryIndex === colorIndex ? value : entry
                                          ),
                                        }
                                      : item
                                  )
                                )
                              }
                            />
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="red"
                              disabled={palette.colors.length === 1}
                              onClick={() =>
                                setPaletteForm((current) =>
                                  current.map((item, index) =>
                                    index === paletteIndex
                                      ? {
                                          ...item,
                                          colors: item.colors.filter(
                                            (_, entryIndex) => entryIndex !== colorIndex
                                          ),
                                        }
                                      : item
                                  )
                                )
                              }
                            >
                              <IconX size={14} />
                            </Button>
                          </Group>
                        ))}
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<IconPlus size={14} />}
                          onClick={() =>
                            setPaletteForm((current) =>
                              current.map((item, index) =>
                                index === paletteIndex
                                  ? { ...item, colors: [...item.colors, "#868e96"] }
                                  : item
                              )
                            )
                          }
                        >
                          Color
                        </Button>
                      </Group>
                    </Stack>
                  </Paper>
                ))}
                <Group justify="flex-end">
                  <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    loading={saveColorPalettes.isPending}
                    disabled={colorPalettes.isLoading || !palettesDirty}
                    onClick={() => saveColorPalettes.mutate()}
                  >
                    Save palettes
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="metadata" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={4}>Electrode-area presets</Title>
                  <Text c="dimmed" size="sm">
                    Reusable areas for imports and cell metadata. Values are electrode areas, not coin-cell casing sizes.
                  </Text>
                </div>
                <Button
                  variant="default"
                  leftSection={<IconPlus size={15} />}
                  onClick={() =>
                    setPresetForm((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        name: "New area",
                        area_cm2: 1,
                        description: null,
                        is_default: current.length === 0,
                      },
                    ])
                  }
                >
                  Add preset
                </Button>
              </Group>
              {areaPresets.isError && <Alert color="red">Could not load electrode-area presets.</Alert>}
              <Table withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th w={150}>Area (cm²)</Table.Th>
                    <Table.Th>Description</Table.Th>
                    <Table.Th w={90}>Default</Table.Th>
                    <Table.Th w={48} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {presetForm.map((preset, index) => (
                    <Table.Tr key={preset.id}>
                      <Table.Td>
                        <TextInput
                          value={preset.name}
                          onChange={(event) =>
                            setPresetForm((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, name: event.currentTarget.value } : item
                              )
                            )
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          min={0.000001}
                          decimalScale={6}
                          value={preset.area_cm2}
                          onChange={(value) =>
                            setPresetForm((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, area_cm2: Number(value) || 0 } : item
                              )
                            )
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          value={preset.description ?? ""}
                          onChange={(event) =>
                            setPresetForm((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, description: event.currentTarget.value || null }
                                  : item
                              )
                            )
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <Switch
                          checked={preset.is_default}
                          onChange={() =>
                            setPresetForm((current) =>
                              current.map((item, itemIndex) => ({
                                ...item,
                                is_default: itemIndex === index,
                              }))
                            )
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <Button
                          variant="subtle"
                          color="red"
                          size="compact-xs"
                          aria-label={`Remove ${preset.name}`}
                          onClick={() =>
                            setPresetForm((current) => current.filter((_, itemIndex) => itemIndex !== index))
                          }
                        >
                          <IconTrash size={15} />
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {presetForm.length === 0 && <Alert color="gray">No presets. Custom areas remain available.</Alert>}
              <Group justify="flex-end">
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  loading={saveAreaPresets.isPending}
                  disabled={areaPresets.isLoading || !presetsDirty}
                  onClick={() => saveAreaPresets.mutate()}
                >
                  Save presets
                </Button>
              </Group>

              <Divider />
              <Stack gap="md">
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Title order={4}>Active-material presets</Title>
                      <Text c="dimmed" size="sm">
                        Nominal capacity is calculated as mass × specific capacity. These are
                        editable laboratory reference values.
                      </Text>
                    </div>
                    <Button
                      variant="default"
                      leftSection={<IconPlus size={15} />}
                      onClick={() =>
                        setMaterialPresetForm((current) => [
                          ...current,
                          {
                            id: crypto.randomUUID(),
                            name: "New material",
                            specific_capacity_mah_g: 150,
                            description: null,
                            is_default: current.length === 0,
                          },
                        ])
                      }
                    >
                      Add material
                    </Button>
                  </Group>
                  {materialPresets.isError && (
                    <Alert color="red">Could not load active-material presets.</Alert>
                  )}
                  <Table withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Name</Table.Th>
                        <Table.Th w={190}>Specific capacity (mAh/g)</Table.Th>
                        <Table.Th>Description</Table.Th>
                        <Table.Th w={90}>Default</Table.Th>
                        <Table.Th w={48} />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {materialPresetForm.map((preset, index) => (
                        <Table.Tr key={preset.id}>
                          <Table.Td>
                            <TextInput
                              value={preset.name}
                              onChange={(event) =>
                                setMaterialPresetForm((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, name: event.currentTarget.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </Table.Td>
                          <Table.Td>
                            <NumberInput
                              min={0.000001}
                              decimalScale={6}
                              value={preset.specific_capacity_mah_g}
                              onChange={(value) =>
                                setMaterialPresetForm((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          specific_capacity_mah_g: Number(value) || 0,
                                        }
                                      : item
                                  )
                                )
                              }
                            />
                          </Table.Td>
                          <Table.Td>
                            <TextInput
                              value={preset.description ?? ""}
                              onChange={(event) =>
                                setMaterialPresetForm((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          description: event.currentTarget.value || null,
                                        }
                                      : item
                                  )
                                )
                              }
                            />
                          </Table.Td>
                          <Table.Td>
                            <Switch
                              checked={preset.is_default}
                              onChange={() =>
                                setMaterialPresetForm((current) =>
                                  current.map((item, itemIndex) => ({
                                    ...item,
                                    is_default: itemIndex === index,
                                  }))
                                )
                              }
                            />
                          </Table.Td>
                          <Table.Td>
                            <Button
                              variant="subtle"
                              color="red"
                              size="compact-xs"
                              aria-label={`Remove ${preset.name}`}
                              onClick={() =>
                                setMaterialPresetForm((current) =>
                                  current.filter((_, itemIndex) => itemIndex !== index)
                                )
                              }
                            >
                              <IconTrash size={15} />
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                  {materialPresetForm.length === 0 && (
                    <Alert color="gray">
                      No material presets. Custom nominal capacity remains available.
                    </Alert>
                  )}
                  <Group justify="flex-end">
                    <Button
                      leftSection={<IconDeviceFloppy size={16} />}
                      loading={saveMaterialPresets.isPending}
                      disabled={materialPresets.isLoading || !materialPresetsDirty}
                      onClick={() => saveMaterialPresets.mutate()}
                    >
                      Save materials
                    </Button>
                  </Group>
              </Stack>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="monitoring" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="lg">
              <div>
                <Title order={4}>Automatic source monitoring</Title>
                <Text c="dimmed" size="sm">
                  Check active-cell source files while CellXplorer is running in the background.
                  Cells marked Complete in the Cell Database are excluded.
                </Text>
              </div>

              {monitoring.isError ? <Alert color="red">Could not load source monitoring settings.</Alert> : null}

              {automationPause.data?.paused ? (
                <Alert color="yellow" title="Automatic updates paused">
                  <Stack gap="xs">
                    <Text size="sm">
                      Scheduled source checks and cache warmup stay paused until the deadline or you resume.
                      Manual checks still run.
                    </Text>
                    <Group>
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="yellow"
                        loading={resumeAutomation.isPending}
                        onClick={() => resumeAutomation.mutate()}
                      >
                        Resume now
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              ) : null}

              <Paper withBorder p="md" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>Enable automatic checks</Text>
                    <Text size="sm" c="dimmed">Missed checks run once when CellXplorer is available again.</Text>
                  </div>
                  <Switch
                    checked={monitorForm.enabled}
                    disabled={monitoring.isLoading}
                    onChange={(event) => setMonitorForm((current) => ({
                      ...current,
                      enabled: event.currentTarget.checked,
                    }))}
                  />
                </Group>
              </Paper>

              <div>
                <Text fw={600} size="sm" mb={6}>Schedule</Text>
                <SegmentedControl
                  value={monitorForm.schedule_mode}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    schedule_mode: value as SourceMonitoringSettings["schedule_mode"],
                  }))}
                  data={[
                    { label: "Every interval", value: "interval" },
                    { label: "At a set time", value: "scheduled" },
                  ]}
                />
              </div>

              {monitorForm.schedule_mode === "interval" ? (
                <Group align="end" grow>
                  <NumberInput
                    label="Every"
                    min={1}
                    max={10000}
                    value={monitorForm.interval_value}
                    onChange={(value) => setMonitorForm((current) => ({
                      ...current,
                      interval_value: Number(value) || 1,
                    }))}
                  />
                  <Select
                    label="Unit"
                    value={monitorForm.interval_unit}
                    allowDeselect={false}
                    data={[
                      { label: "Minutes", value: "minutes" },
                      { label: "Hours", value: "hours" },
                      { label: "Days", value: "days" },
                    ]}
                    onChange={(value) => value && setMonitorForm((current) => ({
                      ...current,
                      interval_unit: value as SourceMonitoringSettings["interval_unit"],
                    }))}
                  />
                </Group>
              ) : (
                <Group align="end" grow>
                  <NumberInput
                    label="Every"
                    min={1}
                    max={monitorForm.scheduled_every_unit === "weeks" ? 52 : 365}
                    value={monitorForm.scheduled_every_value}
                    onChange={(value) => setMonitorForm((current) => ({
                      ...current,
                      scheduled_every_value: Number(value) || 1,
                    }))}
                  />
                  <Select
                    label="Unit"
                    value={monitorForm.scheduled_every_unit}
                    allowDeselect={false}
                    data={[
                      { label: "Days", value: "days" },
                      { label: "Weeks", value: "weeks" },
                    ]}
                    onChange={(value) => value && setMonitorForm((current) => ({
                      ...current,
                      scheduled_every_unit: value as SourceMonitoringSettings["scheduled_every_unit"],
                    }))}
                  />
                  <TextInput
                    label="Local time"
                    type="time"
                    value={monitorForm.daily_time}
                    onChange={(event) => setMonitorForm((current) => ({
                      ...current,
                      daily_time: event.currentTarget.value,
                    }))}
                  />
                </Group>
              )}

              <Paper withBorder p="md" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>Update stable changed files automatically</Text>
                    <Text size="sm" c="dimmed">
                      Rebuilds changed caches one at a time after the source check completes.
                    </Text>
                  </div>
                  <Switch
                    checked={monitorForm.auto_update}
                    onChange={(event) => setMonitorForm((current) => ({
                      ...current,
                      auto_update: event.currentTarget.checked,
                    }))}
                  />
                </Group>
              </Paper>

              <Group align="end" grow>
                <NumberInput
                  label="Metadata scan batch size"
                  description="Files submitted together for the lightweight size and timestamp scan."
                  min={10}
                  max={5000}
                  value={monitorForm.scan_batch_size}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    scan_batch_size: Number(value) || 10,
                  }))}
                />
                <NumberInput
                  label="Stability window"
                  description="One shared wait before changed candidates are checked again."
                  min={1}
                  max={monitorForm.stability_unit === "minutes" ? 60 : 3600}
                  value={monitorForm.stability_value}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    stability_value: Number(value) || 1,
                  }))}
                />
                <Select
                  label="Stability unit"
                  value={monitorForm.stability_unit}
                  allowDeselect={false}
                  data={[
                    { label: "Seconds", value: "seconds" },
                    { label: "Minutes", value: "minutes" },
                  ]}
                  onChange={(value) => value && setMonitorForm((current) => ({
                    ...current,
                    stability_unit: value as SourceMonitoringSettings["stability_unit"],
                  }))}
                />
              </Group>

              <Group align="end" grow>
                <NumberInput
                  label="Retry attempts"
                  description="Additional attempts for files that are still changing."
                  min={2}
                  max={10}
                  value={monitorForm.retry_count}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    retry_count: Number(value) || 2,
                  }))}
                />
                <NumberInput
                  label="Retry every"
                  description="Retries stop before the next regular source check."
                  min={1}
                  max={monitorForm.retry_delay_unit === "hours" ? 24 : monitorForm.retry_delay_unit === "minutes" ? 1440 : 3600}
                  value={monitorForm.retry_delay_value}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    retry_delay_value: Number(value) || 1,
                  }))}
                />
                <Select
                  label="Retry delay unit"
                  value={monitorForm.retry_delay_unit}
                  allowDeselect={false}
                  data={[
                    { label: "Seconds", value: "seconds" },
                    { label: "Minutes", value: "minutes" },
                    { label: "Hours", value: "hours" },
                  ]}
                  onChange={(value) => value && setMonitorForm((current) => ({
                    ...current,
                    retry_delay_unit: value as SourceMonitoringSettings["retry_delay_unit"],
                  }))}
                />
              </Group>

              <SchedulePreviewLine form={monitorForm} />

              <Paper withBorder p="md">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Next check</Text>
                    <Text fw={600}>{monitorForm.enabled ? formatDateTime(monitorForm.next_run_at) : "Disabled"}</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last started</Text>
                    <Text fw={600}>{formatDateTime(monitorForm.last_started_at)}</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last finished</Text>
                    <Text fw={600}>{formatDateTime(monitorForm.last_finished_at)}</Text>
                  </div>
                  <Badge variant="light" color={monitorForm.last_status === "failed" ? "red" : "teal"}>
                    {monitorForm.last_status ?? "Not scheduled"}
                  </Badge>
                </Group>
              </Paper>

              <Text size="sm" c="dimmed">
                Metadata checks use bounded threads. Only stable candidates are hashed, and automatic
                cache updates run sequentially at reduced thread priority. A growing source is marked
                Source changing and retried without rescanning the full database.
              </Text>

              <Group justify="flex-end">
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={() => saveMonitoring.mutate()}
                  loading={saveMonitoring.isPending}
                  disabled={monitoring.isLoading || !monitoringDirty}
                >
                  Save settings
                </Button>
              </Group>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="desktop" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Windows behavior</Title>
                <Text c="dimmed" size="sm">
                  Closing the main window keeps CellXplorer and its background jobs available from the tray.
                </Text>
              </div>
              {!isTauriApp() ? (
                <Alert color="gray">These controls are available in the installed Windows application.</Alert>
              ) : (
                <Paper withBorder p="md" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                  <Group justify="space-between" wrap="nowrap">
                    <div>
                      <Text fw={600}>Launch when Windows starts</Text>
                      <Text size="sm" c="dimmed">
                        Starts hidden in the tray so enabled source monitoring can run in the background.
                      </Text>
                    </div>
                    <Switch
                      checked={autostartEnabled}
                      disabled={autostartLoading}
                      onChange={(event) => changeAutostart(event.currentTarget.checked)}
                    />
                  </Group>
                </Paper>
              )}
              <Text size="sm" c="dimmed">
                Right-click the tray icon to open CellXplorer, check and update active-cell sources, or quit completely.
              </Text>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="updates" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="lg">
              <div>
                <Title order={4}>Application updates</Title>
                <Text c="dimmed" size="sm">
                  Choose how often the installed Windows app checks for a newer signed release.
                </Text>
              </div>

              {APP_BRANDING.isBeta ? (
                <Paper
                  withBorder
                  p="md"
                  bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
                >
                  <Stack gap={4}>
                    <Text fw={600}>Beta release channel</Text>
                    <Text size="sm" c="dimmed">
                      This installation receives CellXplorer Beta updates. Stable CellXplorer remains
                      a separate application.
                    </Text>
                  </Stack>
                </Paper>
              ) : null}

              {!isTauriApp() ? (
                <Alert color="gray">
                  Update checks run only in the installed Windows application. You can still
                  configure the preferences here for testing.
                </Alert>
              ) : null}

              <Paper
                withBorder
                p="md"
                bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
              >
                <Stack gap="md">
                  <div>
                    <Text fw={600}>Automatic check interval</Text>
                    <Text size="sm" c="dimmed">
                      Short intervals are useful for testing. For normal use, several hours avoids
                      unnecessary network requests.
                    </Text>
                  </div>
                  <Group align="end" wrap="nowrap">
                    <NumberInput
                      label="Every"
                      min={1}
                      max={
                        updatePreferences.intervalUnit === "seconds"
                          ? 86_400
                          : updatePreferences.intervalUnit === "minutes"
                            ? 1_440
                            : updatePreferences.intervalUnit === "hours"
                              ? 168
                              : 365
                      }
                      allowDecimal={false}
                      value={updatePreferences.intervalValue}
                      onChange={(value) =>
                        setUpdatePreferences((current) => ({
                          ...current,
                          intervalValue: Math.max(1, Number(value) || 1),
                        }))
                      }
                      style={{ flex: 1 }}
                    />
                    <Select
                      label="Unit"
                      value={updatePreferences.intervalUnit}
                      data={[
                        { value: "seconds", label: "Seconds" },
                        { value: "minutes", label: "Minutes" },
                        { value: "hours", label: "Hours" },
                        { value: "days", label: "Days" },
                      ]}
                      onChange={(value) =>
                        setUpdatePreferences((current) => ({
                          ...current,
                          intervalUnit: (value ?? "hours") as AppUpdateIntervalUnit,
                        }))
                      }
                      allowDeselect={false}
                      w={180}
                    />
                  </Group>
                  <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
                    <div>
                      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last checked on</Text>
                      <Text fw={600}>{formatDateTime(appUpdate?.lastCheckedAt ?? null)}</Text>
                    </div>
                    <div>
                      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Next check foreseen at</Text>
                      <Text fw={600}>
                        {appUpdate?.updateUiEnabled
                          ? formatDateTime(appUpdate.nextCheckAt)
                          : "Not scheduled"}
                      </Text>
                    </div>
                  </Group>
                </Stack>
              </Paper>

              <Paper
                withBorder
                p="md"
                bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
              >
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>Show Windows update notification</Text>
                    <Text size="sm" c="dimmed">
                      Show a Windows notification when an automatic check finds a new version.
                      The power-menu update badge remains available when this is disabled.
                    </Text>
                  </div>
                  <Switch
                    checked={updatePreferences.notificationsEnabled}
                    onChange={(event) =>
                      setUpdatePreferences((current) => ({
                        ...current,
                        notificationsEnabled: event.currentTarget.checked,
                      }))
                    }
                    aria-label="Show Windows update notification"
                  />
                </Group>
              </Paper>

              {!APP_BRANDING.isBeta ? (
              <Paper
                withBorder
                p="md"
                bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
              >
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <div>
                    <Text fw={600}>Notify me about CellXplorer Beta</Text>
                    <Text size="sm" c="dimmed">
                      Check for the separate Beta app. Installing Beta keeps this stable installation
                      and its data unchanged.
                    </Text>
                  </div>
                  <Switch
                    checked={updatePreferences.betaUpdatesEnabled}
                    onChange={(event) =>
                      setUpdatePreferences((current) => ({
                        ...current,
                        betaUpdatesEnabled: event.currentTarget.checked,
                      }))
                    }
                    aria-label="Notify me about CellXplorer Beta"
                  />
                </Group>
              </Paper>
              ) : null}

              {!APP_BRANDING.isBeta && betaInstall?.installationInfo?.installed ? (
                <Paper withBorder p="md">
                  <Group justify="space-between" wrap="nowrap" align="center">
                    <div>
                      <Text fw={600}>CellXplorer Beta is installed</Text>
                      <Text size="sm" c="dimmed">
                        {betaInstall.installationInfo.installedVersion
                          ? `Version ${betaInstall.installationInfo.installedVersion}`
                          : "Installed beside this stable copy."}
                      </Text>
                    </div>
                    <Button variant="default" onClick={() => void betaInstall.openBetaApplication()}>
                      Open Beta
                    </Button>
                  </Group>
                </Paper>
              ) : null}

              {!APP_BRANDING.isBeta &&
              !betaInstall?.installationInfo?.installed &&
              betaInstall?.installState.status === "available" ? (
                <Paper withBorder p="md">
                  <Group justify="space-between" wrap="nowrap" align="center">
                    <div>
                      <Text fw={600}>
                        CellXplorer Beta {betaInstall.installState.release.version} is available
                      </Text>
                      <Text size="sm" c="dimmed">
                        Install the separate preview app without replacing this stable installation.
                      </Text>
                    </div>
                    <Button color="betaBlue" onClick={() => betaInstall.openBetaInstallModal()}>
                      Review Beta
                    </Button>
                  </Group>
                </Paper>
              ) : null}

              <Group justify="flex-end">
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  disabled={!updatePreferencesDirty}
                  onClick={saveUpdatePreferences}
                >
                  Save settings
                </Button>
              </Group>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="performance" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Analysis tabs</Title>
                <Text c="dimmed" size="sm">
                  Choose whether analyses remain ready in memory while you switch between tabs.
                </Text>
              </div>
              <SegmentedControl
                fullWidth
                value={analysisMemoryPolicy}
                onChange={(value) => {
                  const policy = value as AnalysisWorkspaceMemoryPolicy;
                  setAnalysisMemoryPolicy(policy);
                  saveAnalysisWorkspaceMemoryPolicy(policy);
                }}
                data={[
                  { value: "keep-mounted", label: "Keep open analyses in memory" },
                  { value: "unmount", label: "Release inactive analyses" },
                ]}
              />
              <Text size="sm">
                {analysisMemoryPolicy === "keep-mounted"
                  ? "Recommended for fast switching. Analyses visited in this session stay mounted and may use additional RAM and graphics memory."
                  : "Uses fewer resources. Returning to an analysis may briefly rebuild its interactive plot from cache."}
              </Text>
              <Alert color="var(--mantine-primary-color-6)" variant="light">
                Hidden analyses do not recompute together after a source update. The visible analysis refreshes first; another tab refreshes when you open it.
              </Alert>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="cache" pt="lg">
          <Stack gap="lg">
            <Paper withBorder p="lg">
              <Stack gap="md">
                <div>
                  <Title order={4}>Background preparation</Title>
                  <Text c="dimmed" size="sm">
                    Quietly rebuild missing plot data and thumbnails while CellXplorer is idle. Work runs one plot at a time at reduced CPU priority and pauses before starting more work when you return.
                  </Text>
                </div>
                {cacheSettings.isError ? <Alert color="red">Could not load cache settings.</Alert> : null}
                <Switch
                  checked={cacheForm.warmup_enabled}
                  onChange={(event) => setCacheForm((current) => ({ ...current, warmup_enabled: event.currentTarget.checked }))}
                  label="Prepare analysis caches in the background"
                />
                <Switch
                  checked={cacheForm.only_when_hidden}
                  disabled={!cacheForm.warmup_enabled}
                  onChange={(event) => setCacheForm((current) => ({ ...current, only_when_hidden: event.currentTarget.checked }))}
                  label="Only while the app window is hidden"
                />
                <NumberInput
                  label="Idle delay"
                  description="Seconds without keyboard, mouse, or touch input before a new plot is prepared."
                  value={cacheForm.idle_seconds}
                  onChange={(value) => setCacheForm((current) => ({ ...current, idle_seconds: Number(value) || 15 }))}
                  min={5}
                  max={3600}
                  suffix=" s"
                  maw={240}
                />
                <Group justify="space-between">
                  <Button
                    variant="default"
                    leftSection={<IconRefresh size={16} />}
                    loading={refreshCacheNow.isPending}
                    onClick={() => refreshCacheNow.mutate()}
                  >
                    Check and prepare now
                  </Button>
                  <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    disabled={!cacheDirty}
                    loading={saveCacheSettings.isPending}
                    onClick={() => saveCacheSettings.mutate()}
                  >
                    Save settings
                  </Button>
                </Group>
                <Text size="xs" c="dimmed">
                  "Check and prepare now" rescans every saved plot, queues the ones whose cache is
                  missing or out of date, and starts preparing them immediately instead of waiting
                  for the idle delay.
                </Text>
              </Stack>
            </Paper>

            <Paper withBorder p="lg">
              <Stack gap="md">
                <Group justify="space-between">
                  <div>
                    <Title order={4}>Storage budgets</Title>
                    <Text c="dimmed" size="sm">Limits apply to regenerable data only. Saved thumbnails are protected from automatic cleanup.</Text>
                  </div>
                  <Group gap="xs">
                    <Button
                      variant="default"
                      leftSection={<IconRefresh size={16} />}
                      loading={cacheInventory.isFetching}
                      onClick={() => cacheInventory.refetch()}
                    >
                      Recalculate
                    </Button>
                    <Button
                      leftSection={<IconDeviceFloppy size={16} />}
                      disabled={!cacheDirty}
                      loading={saveCacheSettings.isPending}
                      onClick={() => saveCacheSettings.mutate()}
                    >
                      Save budgets
                    </Button>
                  </Group>
                </Group>
                <Group grow align="start">
                  <Select
                    label="Scientific cache"
                    description="Raw and per-cycle Parquet data."
                    value={cacheForm.scientific_limit_bytes === null ? "unlimited" : String(cacheForm.scientific_limit_bytes)}
                    onChange={(value) => setCacheForm((current) => ({ ...current, scientific_limit_bytes: value === "unlimited" ? null : Number(value) }))}
                    data={[
                      { value: String(5 * 1024 ** 3), label: "5 GB" },
                      { value: String(10 * 1024 ** 3), label: "10 GB" },
                      { value: String(25 * 1024 ** 3), label: "25 GB" },
                      { value: String(50 * 1024 ** 3), label: "50 GB" },
                      { value: "unlimited", label: "Unlimited" },
                    ]}
                  />
                  <Select
                    label="Analysis cache"
                    description="Computed results and full plot artifacts."
                    value={cacheForm.analysis_limit_bytes === null ? "unlimited" : String(cacheForm.analysis_limit_bytes)}
                    onChange={(value) => setCacheForm((current) => ({ ...current, analysis_limit_bytes: value === "unlimited" ? null : Number(value) }))}
                    data={[
                      { value: String(512 * 1024 ** 2), label: "512 MB" },
                      { value: String(1024 ** 3), label: "1 GB" },
                      { value: String(2 * 1024 ** 3), label: "2 GB" },
                      { value: String(5 * 1024 ** 3), label: "5 GB" },
                      { value: "unlimited", label: "Unlimited" },
                    ]}
                  />
                </Group>
                {cacheInventory.data ? (
                  <Group gap="xl">
                    <CacheStat label="Total cache" bytes={cacheInventory.data.total_bytes} />
                    <CacheStat
                      label="Scientific data"
                      hint={CACHE_CATEGORY_HINTS.scientific}
                      bytes={cacheInventory.data.categories.scientific?.bytes ?? 0}
                    />
                    <CacheStat
                      label="Computed results"
                      hint={CACHE_CATEGORY_HINTS.analysis_results}
                      bytes={cacheInventory.data.categories.analysis_results?.bytes ?? 0}
                    />
                    <CacheStat
                      label="Plot artifacts"
                      hint={CACHE_CATEGORY_HINTS.analysis_artifacts}
                      bytes={cacheInventory.data.categories.analysis_artifacts?.bytes ?? 0}
                    />
                    <CacheStat
                      label="Thumbnails"
                      hint={CACHE_CATEGORY_HINTS.thumbnails}
                      bytes={(cacheInventory.data.categories.thumbnails?.bytes ?? 0) + (cacheInventory.data.categories.thumbnail_indexes?.bytes ?? 0)}
                    />
                  </Group>
                ) : null}
                <Stack gap="xs">
                  <Group justify="space-between" wrap="wrap">
                    <Text size="sm" fw={700}>Scientific data</Text>
                    <Group gap="xs">
                      <Button
                        variant="default"
                        color="red"
                        onClick={() => requestCategoryCleanup("scientific", "eligible scientific data")}
                      >
                        Clean eligible
                      </Button>
                      <Button
                        variant="default"
                        leftSection={<IconRefresh size={16} />}
                        loading={prepareScientific.isPending}
                        onClick={() => prepareScientific.mutate()}
                      >
                        Prepare missing
                      </Button>
                    </Group>
                  </Group>
                  <Divider />
                  <Group justify="space-between" wrap="wrap">
                    <Text size="sm" fw={700}>Computed results and plot artifacts</Text>
                    <Group gap="xs">
                      <Button
                        variant="default"
                        color="red"
                        onClick={() => requestCategoryCleanup("analysis_results", "computed analysis results")}
                      >
                        Clean results
                      </Button>
                      <Button
                        variant="default"
                        color="red"
                        onClick={() => requestCategoryCleanup("analysis_artifacts", "full plot artifacts")}
                      >
                        Clean artifacts
                      </Button>
                      <Button
                        variant="default"
                        leftSection={<IconRefresh size={16} />}
                        disabled={!cacheForm.warmup_enabled}
                        loading={rebuildCache.isPending && rebuildCache.variables === "saved-plots"}
                        onClick={() => requestCacheRebuild("saved-plots", "all saved plots")}
                      >
                        Rebuild saved plots
                      </Button>
                    </Group>
                  </Group>
                  <Divider />
                  <Group justify="space-between" wrap="wrap">
                    <Text size="sm" fw={700}>Thumbnails</Text>
                    <Group gap="xs">
                      <Button
                        variant="default"
                        color="red"
                        onClick={() => requestCategoryCleanup("thumbnails", "saved-plot thumbnails")}
                      >
                        Clean previews
                      </Button>
                      <Button
                        variant="default"
                        leftSection={<IconRefresh size={16} />}
                        disabled={!cacheForm.warmup_enabled}
                        loading={rebuildCache.isPending && rebuildCache.variables === "thumbnails"}
                        onClick={() => requestCacheRebuild("thumbnails", "saved-plot previews")}
                      >
                        Rebuild previews
                      </Button>
                    </Group>
                  </Group>
                </Stack>
              </Stack>
            </Paper>

            <Paper withBorder p="lg">
              <Stack gap="md">
                <Group justify="space-between" align="start">
                  <div>
                    <Title order={4}>Largest cache items</Title>
                    <Text c="dimmed" size="sm">Original files and database records are never removed. Offline sources are highlighted before their cache can be cleared. Shift+click selects a range, Ctrl+click a row toggles it.</Text>
                  </div>
                  <Button
                    color="red"
                    variant="light"
                    disabled={visibleSelected.length === 0}
                    loading={cleanCacheBulk.isPending}
                    leftSection={<IconTrash size={16} />}
                    onClick={requestBulkOffenderCleanup}
                  >
                    Remove selected ({visibleSelected.length})
                  </Button>
                </Group>
                {cacheInventory.isError ? <Alert color="red">Could not calculate cache usage.</Alert> : null}
                <ScrollArea type="auto">
                  <Table verticalSpacing="sm" miw={760}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={36}>
                          <Checkbox
                            size="sm"
                            aria-label="Select all cache items"
                            checked={offenders.length > 0 && visibleSelected.length === offenders.length}
                            indeterminate={visibleSelected.length > 0 && visibleSelected.length < offenders.length}
                            onChange={() => {
                              lastOffenderIndex.current = null;
                              setSelectedOffenders(
                                visibleSelected.length === offenders.length
                                  ? []
                                  : offenders.map(offenderKey)
                              );
                            }}
                          />
                        </Table.Th>
                        <Table.Th>Item</Table.Th><Table.Th>Type</Table.Th><Table.Th>Size</Table.Th><Table.Th>Last used</Table.Th><Table.Th>Source</Table.Th><Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {offenders.map((item, index) => (
                        <Table.Tr
                          key={offenderKey(item)}
                          bg={selectedOffenders.includes(offenderKey(item)) ? "var(--mantine-color-red-0)" : undefined}
                          onClick={(event) => {
                            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                              event.preventDefault();
                              toggleOffenderAt(index, event.shiftKey);
                            }
                          }}
                          style={{ userSelect: "none" }}
                        >
                          <Table.Td>
                            <Checkbox
                              size="sm"
                              aria-label={`Select ${item.label}`}
                              checked={selectedOffenders.includes(offenderKey(item))}
                              onChange={() => {}}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleOffenderAt(index, (event.nativeEvent as MouseEvent).shiftKey);
                              }}
                            />
                          </Table.Td>
                          <Table.Td><Text size="sm" fw={600} lineClamp={1}>{item.label}</Text></Table.Td>
                          <Table.Td><Badge variant="light">{item.kind === "scientific" ? "Cell data" : "Analysis plots"}</Badge></Table.Td>
                          <Table.Td>{formatBytes(item.bytes)}</Table.Td>
                          <Table.Td>{item.last_used_at ? new Date(item.last_used_at).toLocaleString() : "Unknown"}</Table.Td>
                          <Table.Td>{item.kind === "scientific" ? <Badge color={item.source_available ? "teal" : "orange"} variant="light">{item.source_available ? "Available" : "Offline"}</Badge> : "Regenerable"}</Table.Td>
                          <Table.Td><Button size="xs" variant="subtle" color="red" onClick={(event) => { event.stopPropagation(); requestOffenderCleanup(item); }}>Clean</Button></Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              </Stack>
            </Paper>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="activity" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Activity log</Title>
                <Text c="dimmed" size="sm">
                  Persistent history of imports, edits, source checks and other library changes.
                </Text>
              </div>
              <div>
                <Group justify="space-between" mb="xs">
                  <Text fw={700}>Application sessions</Text>
                  <Badge variant="light">{sessions.data?.length ?? 0}</Badge>
                </Group>
                {sessions.isError ? (
                  <Alert color="red">Could not load application sessions.</Alert>
                ) : (
                  <ScrollArea h={Math.min(220, Math.max(100, (sessions.data?.length ?? 0) * 42 + 44))} type="auto">
                    <Table striped highlightOnHover>
                      <Table.Thead>
                        <Table.Tr><Table.Th>Started</Table.Th><Table.Th>Finished</Table.Th><Table.Th>Mode</Table.Th><Table.Th>Status</Table.Th><Table.Th>Version</Table.Th></Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {(sessions.data ?? []).map((session) => (
                          <Table.Tr key={session.id}>
                            <Table.Td>{new Date(session.started_at).toLocaleString()}</Table.Td>
                            <Table.Td>{session.finished_at ? new Date(session.finished_at).toLocaleString() : "-"}</Table.Td>
                            <Table.Td>{session.startup_mode}</Table.Td>
                            <Table.Td><Badge size="sm" variant="light" color={session.status === "running" || session.status === "closed" ? "teal" : "orange"}>{session.status}</Badge></Table.Td>
                            <Table.Td>{session.app_version ?? "development"}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </ScrollArea>
                )}
              </div>
              {activity.isLoading ? (
                <Text c="dimmed" size="sm">Loading activity...</Text>
              ) : activity.isError ? (
                <Alert color="red">Could not load activity.</Alert>
              ) : (activity.data ?? []).length === 0 ? (
                <Text c="dimmed" size="sm">No activity recorded yet.</Text>
              ) : (
                <ScrollArea h="calc(100vh - 260px)" mih={360} type="auto">
                  <Stack gap="xs" pr="sm">
                    {(activity.data ?? []).map((event) => (
                      <Paper key={event.id} p="sm" withBorder bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                        <Group gap="xs" mb={4}>
                          <Badge
                            size="sm"
                            color={event.severity === "error" ? "red" : event.severity === "warning" ? "orange" : "teal"}
                            variant="light"
                          >
                            {event.category}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            Started {new Date(event.started_at).toLocaleString()}
                          </Text>
                          <Text size="xs" c="dimmed">
                            Finished {new Date(event.finished_at).toLocaleString()}
                          </Text>
                        </Group>
                        <Text fw={700}>{event.message}</Text>
                        {Object.keys(event.details ?? {}).length > 0 ? (
                          <Code block mt="xs">{JSON.stringify(event.details, null, 2)}</Code>
                        ) : null}
                      </Paper>
                    ))}
                  </Stack>
                </ScrollArea>
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
