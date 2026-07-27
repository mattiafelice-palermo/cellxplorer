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
  betaBootstrapGateOpen,
  copyStableLibraryDisabled,
  mockBetaBootstrapStatus,
  parseDevBetaBootstrapMock,
  resolveBetaBootstrapSetupState,
  shouldRetryExistingStage,
  shouldShowBetaBootstrapUi,
} from "../betaBootstrapPolicy";
import { addDebugEvent } from "../debug";
import { isTauriApp } from "../downloads";

type CoordinatorPhase = "idle" | "staging" | "applying" | "restarting" | "error";

export function BetaBootstrapCoordinator({ backendReady }: { backendReady: boolean }) {
  const queryClient = useQueryClient();
  const tauri = isTauriApp();
  const devMock = parseDevBetaBootstrapMock(window.location.search, import.meta.env.DEV);
  const enabled = shouldShowBetaBootstrapUi(APP_BRANDING.channel, tauri, devMock);
  const actionInFlight = useRef(false);
  const [phase, setPhase] = useState<CoordinatorPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retainedToken, setRetainedToken] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["beta-bootstrap-status"],
    queryFn: () => get<BetaBootstrapStatus>("/api/beta-bootstrap/status"),
    enabled: enabled && !devMock && backendReady,
    staleTime: Infinity,
    retry: 1,
  });

  const status = devMock ? mockBetaBootstrapStatus(devMock) : statusQuery.data;
  const setupState = resolveBetaBootstrapSetupState({
    enabled,
    mock: devMock,
    status,
    statusLoading: !devMock && (!backendReady || statusQuery.isLoading || statusQuery.isFetching),
    statusError: !devMock && statusQuery.isError,
  });
  const gateOpen = betaBootstrapGateOpen(setupState);

  const outstandingToken =
    retainedToken ?? status?.outstandingStageToken ?? null;

  const copyBlockedReason = useMemo(() => {
    if (devMock === "blocked") {
      return status?.copyBlockingReason ?? status?.blockingReason;
    }
    if (!status?.stableDatabaseCompatible) {
      return (
        status?.copyBlockingReason ??
        status?.blockingReason ??
        "The Stable library cannot be copied safely."
      );
    }
    return null;
  }, [devMock, status]);

  const setupError =
    errorMessage ??
    status?.setupError ??
    (setupState === "blocked-error" && statusQuery.isError
      ? "Could not load Beta setup status."
      : null) ??
    status?.applyFailureMessage ??
    null;

  const applyToken = useCallback(async (token: string) => {
    setPhase("applying");
    try {
      await post("/api/session/finish");
    } catch (error) {
      addDebugEvent("beta-bootstrap:session-finish-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    setPhase("restarting");
    const { invoke } = await import("@tauri-apps/api/core");
    // After a successful invoke the process exits. A returned error here is a
    // pre-stop validation failure and remains retryable with the same token.
    await invoke("apply_beta_bootstrap", { token });
  }, []);

  const runCopyFlow = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setErrorMessage(null);
    try {
      if (devMock === "copy-error") {
        throw new Error("The staged copy failed integrity checks.");
      }
      if (devMock) {
        setPhase("restarting");
        return;
      }

      let token = outstandingToken;
      if (!shouldRetryExistingStage(token)) {
        setPhase("staging");
        const staged = await post<BetaBootstrapStageCopyResult>("/api/beta-bootstrap/stage-copy");
        token = staged.token;
        setRetainedToken(token);
      }
      if (!token) {
        throw new Error("The staged copy token is missing.");
      }
      await applyToken(token);
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Could not copy the Stable library.";
      // If we already entered restarting, the backend may be gone — keep the
      // non-dismissible restart surface rather than offering a dead retry.
      if (phase === "restarting") {
        setErrorMessage(message);
        return;
      }
      setErrorMessage(message);
      setPhase("error");
    } finally {
      actionInFlight.current = false;
    }
  }, [applyToken, devMock, outstandingToken, phase]);

  const runStartEmpty = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setErrorMessage(null);
    try {
      if (devMock) {
        setPhase("idle");
        return;
      }
      await post("/api/beta-bootstrap/start-empty");
      setRetainedToken(null);
      await queryClient.invalidateQueries({ queryKey: ["beta-bootstrap-status"] });
      setPhase("idle");
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

  const retryStatus = useCallback(() => {
    setErrorMessage(null);
    void queryClient.invalidateQueries({ queryKey: ["beta-bootstrap-status"] });
  }, [queryClient]);

  const discardStage = useCallback(async () => {
    if (!outstandingToken || actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      await post("/api/beta-bootstrap/discard-stage", { token: outstandingToken });
      setRetainedToken(null);
      setErrorMessage(null);
      await queryClient.invalidateQueries({ queryKey: ["beta-bootstrap-status"] });
      setPhase("idle");
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Could not discard the staged copy.",
      );
      setPhase("error");
    } finally {
      actionInFlight.current = false;
    }
  }, [outstandingToken, queryClient]);

  const openFolder = useCallback(async (kind: "data" | "logs") => {
    if (!tauri) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_app_folder", { kind });
    } catch (error) {
      addDebugEvent("beta-bootstrap:open-folder-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [tauri]);

  if (!enabled || !gateOpen) {
    return null;
  }

  const busy = phase === "staging" || phase === "applying" || phase === "restarting";
  const copyDisabled = copyStableLibraryDisabled(status, busy, devMock);
  const showChoice = setupState === "choice-required";
  const showLoading = setupState === "loading";
  const showBlocked = setupState === "blocked-error";

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
        {showLoading ? (
          <Group gap="xs">
            <Loader size="sm" color={APP_BRANDING.primaryColor} />
            <Text size="sm">Checking Beta setup…</Text>
          </Group>
        ) : null}

        {showChoice ? (
          <Text size="sm">
            Beta keeps its library separate from the stable app. You can copy a snapshot of your
            current Stable library, or start with an empty Beta library.
          </Text>
        ) : null}

        {showBlocked ? (
          <Alert color="red" title="Beta setup blocked">
            {setupError ?? "Beta setup cannot continue until this problem is resolved."}
          </Alert>
        ) : null}

        {copyBlockedReason && showChoice ? (
          <Alert color="yellow" title="Copy unavailable">
            {copyBlockedReason}
          </Alert>
        ) : null}

        {status?.applyFailureMessage && showChoice ? (
          <Alert color="orange" title="Previous copy did not finish">
            {status.applyFailureMessage}
          </Alert>
        ) : null}

        {errorMessage && phase === "error" && !showBlocked ? (
          <Alert color="red" title="Setup failed">
            {errorMessage}
          </Alert>
        ) : null}

        {outstandingToken && showChoice ? (
          <Text size="xs" c="dimmed">
            A staged Stable library copy is ready. Retry will activate it without copying again.
          </Text>
        ) : null}

        {phase === "staging" ? (
          <Group gap="xs">
            <IconLoader2 size={16} className="source-check-spin" />
            <Text size="sm">Copying Stable library…</Text>
          </Group>
        ) : null}

        {phase === "applying" || phase === "restarting" ? (
          <Group gap="xs">
            <Loader size="sm" color={APP_BRANDING.primaryColor} />
            <Text size="sm">Restarting CellXplorer Beta…</Text>
          </Group>
        ) : null}

        {showBlocked ? (
          <Group justify="space-between" gap="sm">
            <Group gap="xs">
              <Button variant="default" size="compact-sm" onClick={() => void openFolder("data")}>
                Open data folder
              </Button>
              <Button variant="default" size="compact-sm" onClick={() => void openFolder("logs")}>
                Open logs
              </Button>
            </Group>
            <Button color={APP_BRANDING.primaryColor} onClick={retryStatus}>
              Retry
            </Button>
          </Group>
        ) : null}

        {showChoice ? (
          <Group justify="space-between" gap="sm">
            <Group gap="xs">
              {outstandingToken ? (
                <Button variant="subtle" size="compact-sm" onClick={() => void discardStage()} disabled={busy}>
                  Discard staged copy
                </Button>
              ) : null}
            </Group>
            <Group gap="sm">
              <Button variant="default" onClick={() => void runStartEmpty()} disabled={busy}>
                Start empty
              </Button>
              <Button
                color={APP_BRANDING.primaryColor}
                onClick={() => void runCopyFlow()}
                disabled={copyDisabled}
              >
                {outstandingToken ? "Retry activation" : "Copy Stable library"}
              </Button>
            </Group>
          </Group>
        ) : null}
      </Stack>
    </Modal>
  );
}
