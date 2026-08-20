import {
  Alert,
  Badge,
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

import {
  get,
  previewFolderWatch,
  type ImportFolderWatchDraft,
  type Meta,
  type SourceMonitoringSettings,
} from "../api";
import {
  folderTrackingInlineSummary,
  formatFolderTrackingCadence,
  validateFolderTrackingPattern,
} from "../folderTrackingPolicy";
import { ImportInfoHint } from "./ImportModalShell";

function normalizedFilePath(value: string): string {
  return value.trim().replaceAll("/", "\\").replace(/[\\]+$/, "").toLocaleLowerCase();
}

export function FolderTrackingSettingsModal({
  opened,
  config,
  onClose,
  onSave,
  statusMessage,
  selectedSourcePaths,
}: {
  opened: boolean;
  config: ImportFolderWatchDraft | null;
  onClose: () => void;
  onSave: (config: ImportFolderWatchDraft) => void;
  statusMessage?: string | null;
  /** Staged source paths are supplied by the import flow to label its baseline preview. */
  selectedSourcePaths?: readonly (string | null | undefined)[];
}) {
  const [draft, setDraft] = useState<ImportFolderWatchDraft | null>(config);

  useEffect(() => {
    if (opened) setDraft(config);
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
  const selectedPathSet = useMemo(
    () => new Set(
      (selectedSourcePaths ?? [])
        .filter((path): path is string => Boolean(path))
        .map(normalizedFilePath),
    ),
    [selectedSourcePaths],
  );
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
    ? "The source folder is not available for this selection."
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
    <Modal opened={opened} onClose={onClose} title="Folder tracking settings" size="lg">
      <Stack gap="sm">
        <Alert color={draft.enabled ? "teal" : "gray"} title={draft.enabled ? "Tracking enabled" : "Tracking disabled"}>
          <Group justify="space-between" align="flex-start" gap="sm" wrap="nowrap">
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Text size="xs" c="dimmed" truncate title={draft.folder_path}>
                Folder: {draft.folder_path}
              </Text>
              <Text size="xs" c="dimmed" truncate title={folderTrackingInlineSummary(draft)}>
                {folderTrackingInlineSummary(draft)} · files directly in this folder
              </Text>
              {statusMessage && <Text size="xs" mt={4}>{statusMessage}</Text>}
              {folderPathError && <Text size="xs" c="red">{folderPathError}</Text>}
            </Stack>
            <Switch
              label="Enable tracking"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.currentTarget.checked })}
            />
          </Group>
        </Alert>
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
            {selectedSourcePaths !== undefined && (
              <Text size="xs" c="dimmed">
                Selected files will be imported; other files already present are baselined and will not be attached automatically.
              </Text>
            )}
            {previewQuery.isFetching ? (
              <Text size="xs" c="dimmed">Checking the folder…</Text>
            ) : previewQuery.data?.error ? (
              <Text size="xs" c="red">{previewQuery.data.error}</Text>
            ) : previewQuery.data && previewQuery.data.files.length > 0 ? (
              <Stack gap={2} mah={100} style={{ overflowY: "auto" }}>
                {previewQuery.data.files.map((file) => {
                  const selected = selectedPathSet.has(normalizedFilePath(file.path));
                  return (
                    <Group key={file.path} gap="xs" wrap="nowrap">
                      {selectedSourcePaths !== undefined && (
                        <Badge size="xs" variant="light" color={selected ? "teal" : "gray"}>
                          {selected ? "Selected" : "Baselined"}
                        </Badge>
                      )}
                      <Text size="xs" c="dimmed" truncate title={file.relative_path}>{file.relative_path}</Text>
                    </Group>
                  );
                })}
                {previewQuery.data.truncated && <Text size="xs" c="dimmed">Showing the first 200 matching files.</Text>}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed">No matching files found.</Text>
            )}
          </Stack>
          <Select
            label="Ordering"
            data={[
              { value: "timestamp_filename_hash", label: "Source start time, then filename" },
              { value: "filename", label: "Filename" },
            ]}
            value={draft.ordering_rule}
            onChange={(value) => update({ ordering_rule: value === "filename" ? "filename" : "timestamp_filename_hash" })}
          />
          <Group justify="space-between" align="center" gap="xs">
            <Text size="xs" c="dimmed">
              Checked with source monitoring: {formatFolderTrackingCadence(monitoringQuery.data)}.
            </Text>
          </Group>
          <Group justify="flex-end" gap="xs" mt="xs">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button disabled={saveDisabled} onClick={() => onSave(draft)}>
              Save settings
            </Button>
          </Group>
      </Stack>
    </Modal>
  );
}
