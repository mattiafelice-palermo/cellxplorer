import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { previewFolderWatch, type ImportFolderWatchDraft } from "../api";
import {
  validateFolderTrackingPattern,
} from "../folderTrackingPolicy";

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
  const [draft, setDraft] = useState<ImportFolderWatchDraft | null>(config);

  useEffect(() => {
    if (opened) setDraft(config);
  }, [config, opened]);

  const patternError = draft
    ? validateFolderTrackingPattern(draft.pattern_kind, draft.pattern)
    : null;
  const previewQuery = useQuery({
    queryKey: [
      "folder-watch-preview",
      draft?.folder_path,
      draft?.pattern_kind,
      draft?.pattern,
      draft?.extension,
      draft?.recursive,
      draft?.recursion_depth,
    ],
    queryFn: () => {
      if (!draft) throw new Error("Folder tracking settings are not ready.");
      return previewFolderWatch(draft);
    },
    enabled: opened && Boolean(draft) && !patternError && Boolean(draft?.folder_path.trim()),
    staleTime: 2_000,
  });

  if (!draft) return null;
  const update = (patch: Partial<ImportFolderWatchDraft>) => setDraft((current) => current ? { ...current, ...patch } : current);

  return (
    <Modal opened={opened} onClose={onClose} title="Folder tracking settings" size="lg">
      <Stack gap="sm">
        <Alert color={draft.enabled ? "teal" : "gray"} title={`Tracking: ${draft.enabled ? "enabled" : "disabled"}`}>
          <Stack gap={2}>
            <Text size="xs"><strong>Folder:</strong> {draft.folder_path}</Text>
            <Text size="xs"><strong>Matching:</strong> {draft.pattern} · {draft.recursive ? "including subfolders" : "files directly in this folder"}</Text>
            <Text size="xs"><strong>Ordering:</strong> {draft.ordering_rule === "filename" ? "filename" : "source start time, then filename"}</Text>
          </Stack>
          {statusMessage && <Text size="xs" mt={4}>{statusMessage}</Text>}
        </Alert>
        <TextInput
          label="Folder"
          value={draft.folder_path}
          onChange={(event) => update({ folder_path: event.currentTarget.value })}
          description="The watcher scans this folder after the Cell is imported."
        />
        <Group grow align="start">
          <Select
            label="Filename matching"
            data={[{ value: "glob", label: "Glob pattern" }, { value: "regex", label: "Regular expression" }]}
            value={draft.pattern_kind}
            onChange={(value) => update({ pattern_kind: value === "regex" ? "regex" : "glob" })}
          />
          <TextInput
            label="Pattern"
            value={draft.pattern}
            error={patternError}
            onChange={(event) => update({ pattern: event.currentTarget.value })}
            description="Example: *.ndax or ^CellA_\\d+\\.mpr$"
          />
        </Group>
        <Stack gap={4}>
          <Text size="xs" fw={700}>Current matching files</Text>
          {previewQuery.isFetching ? (
            <Text size="xs" c="dimmed">Checking the folder…</Text>
          ) : previewQuery.data?.error ? (
            <Text size="xs" c="dimmed">{previewQuery.data.error}</Text>
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
          <TextInput label="Extension / parser format" value={`.${draft.extension}`} readOnly />
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
        <Switch
          label="Include subfolders"
          checked={draft.recursive}
          onChange={(event) => update({ recursive: event.currentTarget.checked })}
        />
        {draft.recursive && (
          <NumberInput
            label="Subfolder depth"
            min={1}
            max={32}
            value={draft.recursion_depth || 1}
            onChange={(value) => update({ recursion_depth: typeof value === "number" ? value : 1 })}
          />
        )}
        <Group grow align="end">
          <NumberInput
            label="Cadence override"
            placeholder="Global monitor cadence"
            min={1}
            max={365}
            value={draft.cadence_value ?? ""}
            onChange={(value) => update({ cadence_value: typeof value === "number" ? value : null })}
          />
          <Select
            label="Cadence unit"
            data={["minutes", "hours", "days"]}
            value={draft.cadence_unit}
            clearable
            onChange={(value) => update({ cadence_unit: value as ImportFolderWatchDraft["cadence_unit"] })}
          />
        </Group>
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={Boolean(patternError) || !draft.folder_path.trim()} onClick={() => onSave(draft)}>
            Save settings
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
