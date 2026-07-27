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
  explainUpdateCheckFailure,
  parseReleaseNoteLines,
  type AppUpdateRelease,
  type AppUpdateState,
} from "../appUpdater";

type AppUpdateModalProps = {
  opened: boolean;
  state: AppUpdateState;
  currentVersion: string | null;
  upToDate: boolean;
  onClose: () => void;
  onDownload: () => void;
  onRetry: () => void;
  onRetryCheck: () => void;
  onRestart: () => void;
};

function ReleaseNotesBody({ release }: { release: AppUpdateRelease }) {
  const lines = parseReleaseNoteLines(release.notes);
  const blocks: Array<
    | { kind: "text"; text: string; key: string }
    | { kind: "bullets"; items: string[]; key: string }
  > = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind === "text") {
      blocks.push({ kind: "text", text: line.text, key: `${index}:text:${line.text}` });
      continue;
    }
    const items: string[] = [line.text];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].kind === "bullet") {
      items.push(lines[cursor].text);
      cursor += 1;
    }
    blocks.push({
      kind: "bullets",
      items,
      key: `${index}:bullets:${items.join("\n")}`,
    });
    index = cursor - 1;
  }

  return (
    <Paper withBorder radius="md" p="sm">
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={6}>
          {blocks.map((block) =>
            block.kind === "text" ? (
              <Text key={block.key} size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {block.text}
              </Text>
            ) : (
              <Stack
                key={block.key}
                component="ul"
                gap={6}
                m={0}
                pl="md"
                style={{ listStyleType: "disc" }}
              >
                {block.items.map((item, itemIndex) => (
                  <Text
                    component="li"
                    size="sm"
                    key={`${block.key}:${itemIndex}:${item}`}
                  >
                    {item}
                  </Text>
                ))}
              </Stack>
            ),
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}

function CurrentVersionBadge({ version }: { version: string | null }) {
  if (!version) return null;
  return (
    <Badge color="gray" variant="light">
      v{version}
    </Badge>
  );
}

export function AppUpdateModal({
  opened,
  state,
  currentVersion,
  upToDate,
  onClose,
  onDownload,
  onRetry,
  onRetryCheck,
  onRestart,
}: AppUpdateModalProps) {
  const release =
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" && state.release)
      ? state.release
      : null;

  const checkFailed = state.status === "error" && state.phase === "check";
  const checkingManual = state.status === "checking" && state.source === "manual";
  const showStatusOnly = !release && (checkFailed || upToDate || (opened && checkingManual));

  if (!release && !showStatusOnly) return null;

  const dismissible =
    !checkingManual && (canDismissUpdateModal(state) || upToDate || checkFailed);
  const downloading = state.status === "downloading";
  const launching = state.status === "launching";
  const transferError = state.status === "error" && state.phase !== "check";

  const progress = downloading
    ? computeDownloadProgress(state.downloadedBytes, state.totalBytes)
    : null;
  const indeterminate = downloading && progress?.percent === null;

  if (showStatusOnly) {
    const title = checkingManual
      ? "Checking for updates"
      : checkFailed
        ? "Could not check for updates"
        : "You’re up to date";
    return (
      <Modal
        opened={opened}
        onClose={onClose}
        title={
          <Group gap="sm" wrap="nowrap">
            <Text fw={600}>{title}</Text>
            <CurrentVersionBadge version={currentVersion} />
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
          {checkingManual ? (
            <Text size="sm">Looking for a newer CellXplorer release…</Text>
          ) : checkFailed ? (
            <Alert color="orange" title="Update check failed">
              <Text size="sm">{explainUpdateCheckFailure(state.message)}</Text>
            </Alert>
          ) : (
            <Text size="sm">
              {currentVersion
                ? `This installation is already running CellXplorer v${currentVersion}. No newer release was found.`
                : "This installation is already up to date. No newer release was found."}
            </Text>
          )}

          <Group justify="flex-end" gap="sm" mt={4}>
            {!checkingManual ? (
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            ) : null}
            {checkFailed && !checkingManual ? (
              <Button color="teal" onClick={onRetryCheck}>
                Try again
              </Button>
            ) : null}
          </Group>
        </Stack>
      </Modal>
    );
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="sm" wrap="nowrap">
          <Text fw={600}>Update available</Text>
          <Badge color="teal" variant="light">
            v{release!.version}
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
          <ReleaseNotesBody release={release!} />
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

        {transferError ? (
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
