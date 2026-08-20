import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  get,
  previewFolderWatch,
  type ImportFolderWatchDraft,
  type Meta,
  type SourceMonitoringSettings,
} from "../api";
import { folderTrackingInlineSummary, validateFolderTrackingPattern } from "../folderTrackingPolicy";
import { ImportFilesystemPickerModal } from "./ImportFilesystemPickerModal";
import { ImportInfoHint } from "./ImportModalShell";

function monitorCadence(settings: SourceMonitoringSettings | undefined): string {
  if (!settings) return "Loading global source-monitor cadence…";
  if (settings.schedule_mode === "scheduled") {
    return `on the global schedule (${settings.scheduled_every_value} ${settings.scheduled_every_unit})`;
  }
  return `every ${settings.interval_value} ${settings.interval_unit}`;
}

export function FolderTrackingSettingsModal({
  opened,
  config,
  onClose,
  onSave,
  statusMessage,
}: {
  opened: boolean;
  config: ImportFolderWatchDraft | null;
  onClose: () => void;
  onSave: (config: ImportFolderWatchDraft) => void;
  statusMessage?: string | null;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ImportFolderWatchDraft | null>(config);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  useEffect(() => {
    if (opened) setDraft(config);
    if (!opened) setFolderPickerOpen(false);
  }, [config, opened]);

  const patternError = draft
    ? validateFolderTrackingPattern(draft.pattern_kind, draft.pattern)
    : null;
  const metaQuery = useQuery<Meta>({
    queryKey: ["app-meta"],
    queryFn: () => get<Meta>("/api/meta"),
    enabled: opened,
    staleTime: Infinity,
  });
  const monitoringQuery = useQuery<SourceMonitoringSettings>({
    queryKey: ["source-monitor-settings"],
    queryFn: () => get<SourceMonitoringSettings>("/api/source-monitor/settings"),
    enabled: opened,
    staleTime: 10_000,
  });
  const extensionOptions = useMemo(() => {
    const values = new Set([
      ...(metaQuery.data?.source_extensions ?? []),
      ...(draft?.extensions ?? []),
    ]);
    return [...values].sort().map((extension) => ({
      value: extension.replace(/^\./, ""),
      label: `.${extension.replace(/^\./, "")}`,
    }));
  }, [draft?.extensions, metaQuery.data?.source_extensions]);
  const previewQuery = useQuery({
    queryKey: [
      "folder-watch-preview",
      draft?.folder_path,
      draft?.pattern_kind,
      draft?.pattern,
      draft?.extensions,
    ],
    queryFn: () => {
      if (!draft) throw new Error("Folder tracking settings are not ready.");
      return previewFolderWatch(draft);
    },
    enabled: opened
      && Boolean(draft)
      && !patternError
      && Boolean(draft?.folder_path.trim())
      && Boolean(draft?.extensions.length),
    staleTime: 2_000,
  });

  if (!draft) return null;
  const update = (patch: Partial<ImportFolderWatchDraft>) =>
    setDraft((current) => current ? { ...current, ...patch } : current);
  const folderPathError = !draft.folder_path.trim()
    ? "A folder is required."
    : previewQuery.data?.error
      ?? (previewQuery.isError ? "This folder could not be read." : null);
  const extensionsError = draft.extensions.length === 0
    ? "Select at least one supported source extension."
    : null;
  const saveDisabled = Boolean(
    patternError
    || folderPathError
    || extensionsError
    || metaQuery.isError
    || previewQuery.isFetching,
  );

  return (
    <>
      <Modal opened={opened} onClose={onClose} title="Folder tracking settings" size="lg">
        <Stack gap="sm">
          <Alert color={draft.enabled ? "teal" : "gray"} title={draft.enabled ? "Tracking enabled" : "Tracking disabled"}>
            <Text size="xs" c="dimmed" truncate title={draft.folder_path}>
              {folderTrackingInlineSummary(draft)}
            </Text>
            {statusMessage && <Text size="xs" mt={4}>{statusMessage}</Text>}
          </Alert>
          <Group align="end" wrap="nowrap">
            <TextInput
              label="Folder"
              value={draft.folder_path}
              error={folderPathError}
              onChange={(event) => update({ folder_path: event.currentTarget.value })}
              style={{ flex: 1 }}
              title={draft.folder_path}
            />
            <Button variant="default" onClick={() => setFolderPickerOpen(true)}>
              Browse…
            </Button>
          </Group>
          {folderPathError && <Text size="xs" c="red">{folderPathError}</Text>}
          <Group grow align="start">
            <Select
              label="Filename matching"
              data={[{ value: "glob", label: "Glob pattern" }, { value: "regex", label: "Regular expression" }]}
              value={draft.pattern_kind}
              onChange={(value) => update({ pattern_kind: value === "regex" ? "regex" : "glob" })}
            />
            <TextInput
              label={(
                <Group gap={4} component="span">
                  <span>Pattern</span>
                  <ImportInfoHint label="Use a glob or regular expression against the filename. The extension filter is applied separately." />
                </Group>
              )}
              value={draft.pattern}
              error={patternError}
              placeholder="Example: *_discharge* or ^CellA_\\d+"
              onChange={(event) => update({ pattern: event.currentTarget.value })}
            />
          </Group>
          <MultiSelect
            label="Source extensions"
            data={extensionOptions}
            value={draft.extensions}
            onChange={(values) => update({ extensions: values })}
            error={extensionsError}
            searchable
            clearable={false}
            renderOption={({ option, checked }) => (
              <Group gap="xs">
                <Checkbox checked={checked} readOnly tabIndex={-1} size="xs" />
                <Text size="sm">{option.label}</Text>
              </Group>
            )}
          />
          <Text size="xs" c="dimmed">
            Parser formats: {draft.source_formats.length ? draft.source_formats.join(", ") : "all formats for the selected extensions"}
          </Text>
          <Stack gap={4}>
            <Text size="xs" fw={700}>Current matching files</Text>
            {previewQuery.isFetching ? (
              <Text size="xs" c="dimmed">Checking the folder…</Text>
            ) : previewQuery.data?.error ? (
              <Text size="xs" c="red">{previewQuery.data.error}</Text>
            ) : previewQuery.data && previewQuery.data.files.length > 0 ? (
              <Stack gap={2} mah={100} style={{ overflowY: "auto" }}>
                {previewQuery.data.files.map((file) => (
                  <Text key={file.path} size="xs" c="dimmed" truncate title={file.relative_path}>{file.relative_path}</Text>
                ))}
                {previewQuery.data.truncated && <Text size="xs" c="dimmed">Showing the first 200 matching files.</Text>}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed">No matching files found.</Text>
            )}
          </Stack>
          <Group grow align="start">
            <TextInput label="Scan scope" value="Files directly in this folder" readOnly />
            <Select
              label="Ordering"
              data={[
                { value: "timestamp_filename_hash", label: "Source start time, then filename" },
                { value: "filename", label: "Filename" },
              ]}
              value={draft.ordering_rule}
              onChange={(value) => update({ ordering_rule: value === "filename" ? "filename" : "timestamp_filename_hash" })}
            />
          </Group>
          <Group justify="space-between" align="center" gap="xs">
            <Text size="xs" c="dimmed">
              Checked with source monitoring: {monitorCadence(monitoringQuery.data)}.
            </Text>
            <Button variant="subtle" size="compact-xs" onClick={() => navigate("/settings/monitoring")}>
              Source monitoring settings
            </Button>
          </Group>
          <Group justify="flex-end" gap="xs" mt="xs">
            <Switch
              label="Enable tracking"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.currentTarget.checked })}
            />
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button disabled={saveDisabled} onClick={() => onSave(draft)}>
              Save settings
            </Button>
          </Group>
        </Stack>
      </Modal>
      <ImportFilesystemPickerModal
        mode="folder"
        opened={folderPickerOpen}
        loading={false}
        initialPath={draft.folder_path || null}
        onClose={() => setFolderPickerOpen(false)}
        onFolderConfirm={(path) => {
          update({ folder_path: path });
          setFolderPickerOpen(false);
        }}
      />
    </>
  );
}
