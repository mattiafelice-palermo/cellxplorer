import { Alert, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconLoader2 } from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type BetaBootstrapStageCopyResult,
  type BetaBootstrapStatus,
} from "../api";
import { APP_BRANDING } from "../appChannel";
import {
  betaBootstrapModalOpen,
  copyStableLibraryDisabled,
  mockBetaBootstrapStatus,
  parseDevBetaBootstrapMock,
  shouldShowBetaBootstrapUi,
} from "../betaBootstrapPolicy";
import { addDebugEvent } from "../debug";
import { isTauriApp } from "../downloads";

type CoordinatorPhase = "choice" | "staging" | "restarting" | "error";

export function BetaBootstrapCoordinator({ backendReady }: { backendReady: boolean }) {
  const queryClient = useQueryClient();
  const tauri = isTauriApp();
  const devMock = parseDevBetaBootstrapMock(window.location.search, import.meta.env.DEV);
  const enabled = shouldShowBetaBootstrapUi(APP_BRANDING.channel, tauri, devMock) && backendReady;
  const actionInFlight = useRef(false);
  const [phase, setPhase] = useState<CoordinatorPhase>("choice");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["beta-bootstrap-status"],
    queryFn: () => get<BetaBootstrapStatus>("/api/beta-bootstrap/status"),
    enabled: enabled && !devMock,
    staleTime: Infinity,
    retry: 1,
  });

  const status = devMock ? mockBetaBootstrapStatus(devMock) : statusQuery.data;
  const modalOpen = betaBootstrapModalOpen(status, devMock);

  const copyBlockedReason = useMemo(() => {
    if (devMock === "blocked") {
      return status?.blockingReason;
    }
    if (!status?.stableDatabaseCompatible) {
      return status?.blockingReason ?? "The Stable library cannot be copied safely.";
    }
    return null;
  }, [devMock, status]);

  const runCopyFlow = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setErrorMessage(null);
    setPhase("staging");
    try {
      if (devMock === "copy-error") {
        throw new Error("The staged copy failed integrity checks.");
      }
      if (devMock) {
        setPhase("restarting");
        return;
      }
      const staged = await post<BetaBootstrapStageCopyResult>("/api/beta-bootstrap/stage-copy");
      try {
        await post("/api/session/finish");
      } catch (error) {
        addDebugEvent("beta-bootstrap:session-finish-error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      setPhase("restarting");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("apply_beta_bootstrap", { token: staged.token });
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Could not copy the Stable library.";
      setErrorMessage(message);
      setPhase("error");
    } finally {
      actionInFlight.current = false;
    }
  }, [devMock]);

  const runStartEmpty = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setErrorMessage(null);
    try {
      if (devMock) {
        setPhase("choice");
        return;
      }
      await post("/api/beta-bootstrap/start-empty");
      await queryClient.invalidateQueries({ queryKey: ["beta-bootstrap-status"] });
      setPhase("choice");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Could not start with an empty library.";
      setErrorMessage(message);
      setPhase("error");
    } finally {
      actionInFlight.current = false;
    }
  }, [devMock, queryClient]);

  if (!enabled || !modalOpen) {
    return null;
  }

  const staging = phase === "staging";
  const restarting = phase === "restarting";
  const copyDisabled = copyStableLibraryDisabled(status, staging || restarting, devMock);
  const actionsDisabled = staging || restarting;

  return (
    <Modal
      opened
      onClose={() => undefined}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      centered
      size="md"
      title="Set up CellXplorer Beta"
      zIndex={400}
    >
      <Stack gap="md">
        <Text size="sm">
          Beta keeps its library separate from the stable app. You can copy a snapshot of your
          current Stable library, or start with an empty Beta library.
        </Text>
        {copyBlockedReason ? (
          <Alert color="yellow" title="Copy unavailable">
            {copyBlockedReason}
          </Alert>
        ) : null}
        {errorMessage ? (
          <Alert color="red" title="Setup failed">
            {errorMessage}
          </Alert>
        ) : null}
        {staging ? (
          <Group gap="xs">
            <IconLoader2 size={16} className="source-check-spin" />
            <Text size="sm">Copying Stable library…</Text>
          </Group>
        ) : null}
        {restarting ? (
          <Group gap="xs">
            <Loader size="sm" color={APP_BRANDING.primaryColor} />
            <Text size="sm">Restarting CellXplorer Beta…</Text>
          </Group>
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button
            variant="default"
            onClick={() => void runStartEmpty()}
            disabled={actionsDisabled}
          >
            Start empty
          </Button>
          <Button
            color={APP_BRANDING.primaryColor}
            onClick={() => void runCopyFlow()}
            disabled={copyDisabled || actionsDisabled}
          >
            Copy Stable library
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
