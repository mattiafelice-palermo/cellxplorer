import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Progress,
  Stack,
  Text,
} from "@mantine/core";
import { IconDownload, IconRefresh } from "@tabler/icons-react";

import { APP_BRANDING } from "../appChannel";
import {
  canDismissUpdateModal,
  canRefreshAppUpdate,
  computeDownloadProgress,
  describeUpdateCheckFailure,
  explainUpdateCheckFailure,
  UPDATE_APPLYING_DESCRIPTION,
  UPDATE_APPLYING_LABEL,
  type AppUpdateRelease,
  type AppUpdateState,
} from "../appUpdater";
import { ReleaseNotesBody } from "./ReleaseNotesBody";

type AppUpdateModalProps = {
  opened: boolean;
  state: AppUpdateState;
  currentVersion: string | null;
  upToDate: boolean;
  onClose: () => void;
  onDownload: () => void;
  onRetry: () => void;
  onRetryInstall: () => void;
  onRetryCheck: () => void;
  onRestart: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string | null;
};

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
  onRetryInstall,
  onRetryCheck,
  onRestart,
  onRefresh,
  refreshing = false,
  refreshError = null,
}: AppUpdateModalProps) {
  const release =
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" && state.release)
      ? state.release
      : null;

  const checkFailed = state.status === "error" && state.phase === "check";
  const checkFailure =
    checkFailed ? describeUpdateCheckFailure(state.message) : null;
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
        withCloseButton={dismissible}
        closeButtonProps={{ "aria-label": "Close update dialog" }}
        closeOnClickOutside={dismissible}
        closeOnEscape={dismissible}
      >
        <Stack gap="sm">
          {checkingManual ? (
            <Text size="sm">Looking for a newer CellXplorer release…</Text>
          ) : checkFailed ? (
            <Alert color="orange" title={checkFailure!.title}>
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
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={onRefresh}
              loading={refreshing} disabled={refreshing || !canRefreshAppUpdate(state)}>Refresh</Button>
            {!checkingManual ? (
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            ) : null}
            {checkFailed && !checkingManual && checkFailure!.canRetry ? (
              <Button color={APP_BRANDING.primaryColor} onClick={onRetryCheck}>
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
          <Text fw={600}>{launching ? UPDATE_APPLYING_LABEL : transferError ? "Update failed" : "Update available"}</Text>
          <Badge color={APP_BRANDING.primaryColor} variant="light">
            v{release!.version}
          </Badge>
        </Group>
      }
      centered
      size="36rem"
      radius="md"
      padding="md"
      withCloseButton={dismissible}
      closeButtonProps={{ "aria-label": "Close update dialog" }}
      closeOnClickOutside={dismissible}
      closeOnEscape={dismissible}
    >
      <Stack gap="sm">
        <Text size="sm">{transferError ? "The update could not be completed." : release!.localInstaller ? "The local signed installer is verified and ready. This performs a real update or reinstall, not a dry run." : "A new version of CellXplorer is ready to install."}</Text>
        {release!.localInstaller ? <Badge variant="light" color="gray" style={{ alignSelf: "flex-start" }}>Local installer</Badge> : null}
        {!release!.localInstaller ? <Group justify="flex-end">
          <Button variant="default" size="sm" leftSection={<IconRefresh size={16} />} onClick={onRefresh}
            loading={refreshing} disabled={refreshing || !canRefreshAppUpdate(state)}>Refresh</Button>
        </Group> : null}
        {refreshError && !release!.localInstaller ? <Alert color="orange" title="Could not refresh updates">
          <Text size="sm">{refreshError}</Text>
          <Text size="xs">The previously found release is still shown. Refresh to try again.</Text>
        </Alert> : null}

        <Stack gap={6}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {release!.localInstaller ? "Local update" : "Release notes"}
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
              color={APP_BRANDING.primaryColor}
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
              {UPDATE_APPLYING_LABEL}
            </Text>
            <Text size="sm">{UPDATE_APPLYING_DESCRIPTION}</Text>
            <Progress
              value={100}
              animated
              striped
              color={APP_BRANDING.primaryColor}
              size="md"
            />
          </Stack>
        ) : null}

        {transferError ? (
          <Alert color="red" title={state.phase === "install" ? "Install failed" : "Download failed"}>
            <Text size="sm">{state.message}</Text>
          </Alert>
        ) : null}

        {state.status === "error" && state.phase === "install" ? (
          <Text size="sm" c="dimmed">
            {state.lifecycleMayNeedRestart === false
              ? "The installer handoff was cancelled before CellXplorer shut down. You can close this dialog or retry installation."
              : "The application connection may be unavailable. Restart CellXplorer to restore it before continuing work."}
          </Text>
        ) : null}

        {state.status === "available" ? (
          <Text size="xs" c="dimmed">
            {release!.localInstaller ? "No network download is needed. Install uses the same protected updater handoff and Windows approval; CellXplorer closes only after preparation succeeds." : "After download completes, CellXplorer will close and the passive updater will finish installation automatically."}
          </Text>
        ) : null}

        <Group justify="flex-end" gap="sm" mt={4} py="xs"
          style={{ position: "sticky", bottom: 0, background: "var(--mantine-color-body)", zIndex: 1 }}>
          {state.status === "available" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Later
              </Button>
              <Button
                color={APP_BRANDING.primaryColor}
                leftSection={<IconDownload size={16} />}
                onClick={onDownload}
                disabled={refreshing}
              >
                {release!.localInstaller ? "Install local update" : "Download update"}
              </Button>
            </>
          ) : null}

          {state.status === "error" && state.phase === "download" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Later
              </Button>
              <Button color={APP_BRANDING.primaryColor} onClick={onRetry}>
                Retry download
              </Button>
            </>
          ) : null}

          {state.status === "error" && state.phase === "install" ? (
            <>
              {dismissible ? (
                <Button variant="default" onClick={onClose}>Close</Button>
              ) : null}
              <Button variant="default" onClick={onRestart}>
                Restart CellXplorer
              </Button>
              <Button color={APP_BRANDING.primaryColor} onClick={onRetryInstall}>
                Retry install
              </Button>
            </>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}
