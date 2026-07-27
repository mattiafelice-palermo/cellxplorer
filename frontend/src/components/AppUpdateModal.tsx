import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";

import {
  canDismissUpdateModal,
  computeDownloadProgress,
  parseReleaseNoteLines,
  type AppUpdateRelease,
  type AppUpdateState,
} from "../appUpdater";

type AppUpdateModalProps = {
  opened: boolean;
  state: AppUpdateState;
  onClose: () => void;
  onDownload: () => void;
  onRetry: () => void;
  onRestart: () => void;
};

function ReleaseNotesBody({ release }: { release: AppUpdateRelease }) {
  const lines = parseReleaseNoteLines(release.notes);

  return (
    <Paper withBorder radius="md" p="sm">
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={6}>
          {lines.map((line, index) =>
            line.kind === "bullet" ? (
              <Text
                component="li"
                size="sm"
                key={`${index}:${line.kind}:${line.text}`}
                ml="md"
                style={{ display: "list-item", listStyleType: "disc" }}
              >
                {line.text}
              </Text>
            ) : (
              <Text
                size="sm"
                key={`${index}:${line.kind}:${line.text}`}
                style={{ whiteSpace: "pre-wrap" }}
              >
                {line.text}
              </Text>
            ),
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}

export function AppUpdateModal({
  opened,
  state,
  onClose,
  onDownload,
  onRetry,
  onRestart,
}: AppUpdateModalProps) {
  const release =
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" && state.release)
      ? state.release
      : null;

  if (!release) return null;

  const dismissible = canDismissUpdateModal(state);
  const downloading = state.status === "downloading";
  const launching = state.status === "launching";
  const error = state.status === "error" && state.phase !== "check";

  const progress = downloading
    ? computeDownloadProgress(state.downloadedBytes, state.totalBytes)
    : null;
  const indeterminate = downloading && progress?.percent === null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="sm" wrap="nowrap">
          <Text fw={600}>Update available</Text>
          <Badge color="teal" variant="light">
            v{release.version}
          </Badge>
        </Group>
      }
      centered
      size="36rem"
      radius="md"
      padding="md"
      withCloseButton={false}
      closeOnClickOutside={dismissible}
      closeOnEscape={dismissible}
    >
      <Stack gap="sm">
        <Text size="sm">A new version of CellXplorer is ready to install.</Text>

        <Stack gap={6}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Release notes
          </Text>
          <ReleaseNotesBody release={release} />
        </Stack>

        {downloading ? (
          <Stack gap={8}>
            <Text size="sm" fw={500}>
              Downloading update…
            </Text>
            <Progress
              value={indeterminate ? 100 : (progress?.percent ?? 0)}
              animated={indeterminate}
              striped={indeterminate}
              color="teal"
              size="md"
            />
            {progress ? (
              <Text size="xs" c="dimmed">
                {progress.label}
              </Text>
            ) : null}
          </Stack>
        ) : null}

        {launching ? (
          <Stack gap={8}>
            <Text size="sm" fw={500}>
              Download complete. Launching installer…
            </Text>
            <Progress value={100} color="teal" size="md" />
          </Stack>
        ) : null}

        {error ? (
          <Alert color="red" title={state.phase === "install" ? "Install failed" : "Download failed"}>
            <Text size="sm">{state.message}</Text>
          </Alert>
        ) : null}

        {!downloading && !launching ? (
          <Text size="xs" c="dimmed">
            After download completes, the installer will launch automatically.
          </Text>
        ) : null}

        <Group justify="flex-end" gap="sm" mt={4}>
          {state.status === "available" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Later
              </Button>
              <Button color="teal" leftSection={<IconDownload size={16} />} onClick={onDownload}>
                Download update
              </Button>
            </>
          ) : null}

          {state.status === "error" && state.phase === "download" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Later
              </Button>
              <Button color="teal" onClick={onRetry}>
                Retry download
              </Button>
            </>
          ) : null}

          {state.status === "error" && state.phase === "install" ? (
            <Button color="teal" onClick={onRestart}>
              Restart CellXplorer
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}
