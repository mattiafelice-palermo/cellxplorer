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
  canDismissBetaInstallModal,
  type BetaInstallState,
} from "../betaInstaller";
import { computeDownloadProgress, parseReleaseNoteLines, type AppUpdateRelease } from "../appUpdater";

type BetaInstallModalProps = {
  opened: boolean;
  state: BetaInstallState;
  onClose: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onRetryCheck: () => void;
};

function ReleaseNotesBody({ release }: { release: AppUpdateRelease }) {
  const lines = parseReleaseNoteLines(release.notes);
  return (
    <Paper withBorder radius="md" p="sm">
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={6}>
          {lines.map((line, index) =>
            line.kind === "bullet" ? (
              <Text component="li" size="sm" key={`${index}:${line.text}`} ml="md">
                {line.text}
              </Text>
            ) : (
              <Text key={`${index}:${line.text}`} size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {line.text}
              </Text>
            ),
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}

export function BetaInstallModal({
  opened,
  state,
  onClose,
  onInstall,
  onRetry,
  onRetryCheck,
}: BetaInstallModalProps) {
  const release =
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" && state.release)
      ? state.release
      : null;

  const checkFailed = state.status === "error" && state.phase === "check";
  const checking = state.status === "checking";
  const unavailable = state.status === "unavailable";
  const showStatusOnly = !release && (checkFailed || checking || unavailable);

  if (!release && !showStatusOnly) return null;

  const dismissible = canDismissBetaInstallModal(state);
  const downloading = state.status === "downloading";
  const launching = state.status === "launching";
  const transferError = state.status === "error" && state.phase !== "check";

  const progress = downloading
    ? computeDownloadProgress(state.downloadedBytes, state.totalBytes)
    : null;
  const indeterminate = downloading && progress?.percent === null;

  if (showStatusOnly) {
    return (
      <Modal
        opened={opened}
        onClose={onClose}
        title={
          <Text fw={600}>
            {checking
              ? "Checking for CellXplorer Beta"
              : unavailable
                ? "No CellXplorer Beta available"
                : "Could not check for CellXplorer Beta"}
          </Text>
        }
        centered
        size="36rem"
        radius="md"
        padding="md"
        withCloseButton={false}
        closeOnClickOutside={!checking}
        closeOnEscape={!checking}
      >
        <Stack gap="sm">
          {checking ? (
            <Text size="sm">Looking for a CellXplorer Beta preview release…</Text>
          ) : unavailable ? (
            <Text size="sm">
              There is no newer CellXplorer Beta preview release available right now.
            </Text>
          ) : (
            <Alert color="orange" title="Beta check failed">
              <Text size="sm">{state.message}</Text>
            </Alert>
          )}
          <Group justify="flex-end" gap="sm" mt={4}>
            {!checking ? (
              <>
                <Button variant="default" onClick={onClose}>
                  Close
                </Button>
                {!unavailable ? (
                  <Button color="teal" onClick={onRetryCheck}>
                    Try again
                  </Button>
                ) : null}
              </>
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
          <Text fw={600}>CellXplorer Beta {release!.version} is available</Text>
          <Badge color="betaBlue" variant="light">
            Preview
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
        <Text size="sm">
          Beta installs beside the stable app and uses a separate library. It will not replace
          this installation.
        </Text>

        <Stack gap={6}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Release notes
          </Text>
          <ReleaseNotesBody release={release!} />
        </Stack>

        {downloading ? (
          <Stack gap={8}>
            <Text size="sm" fw={500}>
              Downloading CellXplorer Beta
            </Text>
            <Progress
              value={indeterminate ? 100 : (progress?.percent ?? 0)}
              animated={indeterminate}
              striped={indeterminate}
              color="betaBlue"
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
              Download complete. Launching CellXplorer Beta installer…
            </Text>
            <Progress value={100} color="betaBlue" size="md" />
          </Stack>
        ) : null}

        {transferError ? (
          <Alert color="red" title={state.phase === "install" ? "Install failed" : "Download failed"}>
            <Text size="sm">{state.message}</Text>
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm" mt={4}>
          {state.status === "available" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button color="betaBlue" leftSection={<IconDownload size={16} />} onClick={onInstall}>
                Install CellXplorer Beta
              </Button>
            </>
          ) : null}

          {state.status === "error" && state.phase === "download" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button color="betaBlue" onClick={onRetry}>
                Retry download
              </Button>
            </>
          ) : null}

          {state.status === "error" && state.phase === "install" ? (
            <Button color="betaBlue" onClick={onRetry}>
              Retry install
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}
