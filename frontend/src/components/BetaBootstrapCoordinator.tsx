import { Alert, Button, Group, Loader, Modal, Progress, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconLoader2 } from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type BackgroundJob,
  type BetaScientificPreparationStatus,
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

export function BetaBootstrapCoordinator({
  backendReady,
  gateRequiredOnLaunch,
}: {
  backendReady: boolean;
  gateRequiredOnLaunch: boolean;
}) {
  const queryClient = useQueryClient();
  const tauri = isTauriApp();
  const devMock = parseDevBetaBootstrapMock(window.location.search, import.meta.env.DEV);
  const enabled = shouldShowBetaBootstrapUi(APP_BRANDING.channel, tauri, devMock);
  const actionInFlight = useRef(false);
  const [phase, setPhase] = useState<CoordinatorPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retainedToken, setRetainedToken] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["beta-bootstrap-status"],
    queryFn: () => get<BetaBootstrapStatus>("/api/beta-bootstrap/status"),
    enabled: enabled && !devMock && backendReady,
    staleTime: Infinity,
    retry: 1,
  });

  const status = devMock ? mockBetaBootstrapStatus(devMock) : statusQuery.data;
  const preparationStatus = useQuery({
    queryKey: ["beta-bootstrap-preparation-status"],
    queryFn: () =>
      get<BetaScientificPreparationStatus>(
        "/api/beta-bootstrap/preparation-status",
      ),
    enabled: Boolean(
      enabled &&
        !devMock &&
        backendReady &&
        status?.scientificPreparationPending,
    ),
    initialData:
      !devMock && status?.scientificPreparation
        ? {
            pending: Boolean(status.scientificPreparationPending),
            state: status.scientificPreparation,
          }
        : undefined,
    refetchInterval: (query) => (query.state.data?.pending ? 600 : false),
  });
  const preparationState =
    preparationStatus.data?.state ?? status?.scientificPreparation;
  const preparationPending = Boolean(
    !devMock &&
      (preparationStatus.data?.pending ??
        status?.scientificPreparationPending),
  );
  const backgroundJobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => get<BackgroundJob[]>("/api/background-jobs?limit=20"),
    enabled: enabled && preparationPending,
    refetchInterval: preparationPending ? 500 : false,
  });
  const preparationJob = backgroundJobs.data?.find(
    (job) =>
      job.id === preparationState?.jobId ||
      job.kind === "scientific_preparation",
  );
  const preparationTotal =
    preparationJob?.total ?? preparationState?.total ?? 0;
  const preparationCompleted =
    preparationJob?.completed ?? preparationState?.completed ?? 0;
  const preparationProgress =
    preparationTotal > 0
      ? Math.min(100, (preparationCompleted / preparationTotal) * 100)
      : null;
  const preparationCurrent = preparationJob?.items.find(
    (item) => item.status === "processing",
  );
  const hasExistingBeta = status?.betaHasExistingLibrary ?? !status?.betaPristine;
  const setupState = resolveBetaBootstrapSetupState({
    enabled,
    mock: devMock,
    status,
    statusLoading: !devMock && (!backendReady || statusQuery.isLoading || statusQuery.isFetching),
    statusError: !devMock && statusQuery.isError,
  });
  // Rust reads the local setup marker before React renders. A new installation
  // stays blocked while the backend performs the full validation; an already
  // acknowledged installation checks silently and never flashes this loader.
  const gateOpen = betaBootstrapGateOpen(
    setupState,
    gateRequiredOnLaunch || devMock === "loading",
  );

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

  const applyToken = useCallback(async (
    token: string,
    confirmReplaceExistingBeta: boolean,
  ) => {
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
    await invoke("apply_beta_bootstrap", { token, confirmReplaceExistingBeta });
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
        const staged = await post<BetaBootstrapStageCopyResult>("/api/beta-bootstrap/stage-copy", {
          confirmReplaceExistingBeta: hasExistingBeta,
        });
        token = staged.token;
        setRetainedToken(token);
      }
      if (!token) {
        throw new Error("The staged copy token is missing.");
      }
      await applyToken(token, hasExistingBeta && confirmReplace);
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : typeof error === "string" && error.trim()
            ? error.trim()
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
  }, [applyToken, devMock, hasExistingBeta, outstandingToken, phase]);

  const runUseCurrent = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setErrorMessage(null);
    try {
      if (devMock) {
        setPhase("idle");
        return;
      }
      if (outstandingToken) {
        await post("/api/beta-bootstrap/discard-stage", { token: outstandingToken });
      }
      await post("/api/beta-bootstrap/use-current");
      setRetainedToken(null);
      await queryClient.invalidateQueries({ queryKey: ["beta-bootstrap-status"] });
      setPhase("idle");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Could not keep the current Beta library.";
      setErrorMessage(message);
      setPhase("error");
    } finally {
      actionInFlight.current = false;
    }
  }, [devMock, outstandingToken, queryClient]);

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

  if (!enabled || (!gateOpen && !preparationPending)) {
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
      title={preparationPending ? "Preparing copied library" : "Set up CellXplorer Beta"}
      zIndex={400}
    >
      <Stack gap="md">
        {preparationPending ? (
          <>
            <Text size="sm">
              CellXplorer is preparing the copied cells and scientific data. The library will open
              when this one-time pass finishes.
            </Text>
            <Progress
              value={preparationProgress ?? 100}
              striped
              animated
              color={APP_BRANDING.primaryColor}
              aria-label="Copied library preparation progress"
            />
            <Text size="xs" c="dimmed">
              {preparationTotal > 0
                ? `${preparationCompleted} of ${preparationTotal} source files prepared`
                : "Finding scientific data that needs preparation…"}
            </Text>
            {preparationCurrent ? (
              <Text size="xs" c="dimmed" truncate title={preparationCurrent.label}>
                Preparing {preparationCurrent.label}
              </Text>
            ) : null}
          </>
        ) : null}

        {showLoading ? (
          <Group gap="xs">
            <Loader size="sm" color={APP_BRANDING.primaryColor} />
            <Text size="sm">Checking Beta setup…</Text>
          </Group>
        ) : null}

        {showChoice ? (
          <Text size="sm">
            {hasExistingBeta
              ? "This Beta installation already has its own library. You can keep it, or replace it with a fresh snapshot of your current Stable library."
              : "Beta keeps its library separate from the stable app. You can copy a snapshot of your current Stable library, or start with a clean Beta library."}
          </Text>
        ) : null}

        {showChoice && hasExistingBeta ? (
          <Alert color="yellow" title="Copying will overwrite Beta data">
            Copying from Stable replaces the current Beta database and Beta-managed imports. Stable
            itself is not changed.
          </Alert>
        ) : null}

        {showChoice && hasExistingBeta && confirmReplace ? (
          <Alert color="red" title="Confirm Beta library replacement">
            Continue only if you no longer need the current Beta data. The replacement is rolled
            back if activation fails, but after a successful copy the previous Beta library is
            removed.
          </Alert>
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
          <Stack gap="xs">
            <Group gap="xs">
              <IconLoader2 size={16} className="source-check-spin" />
              <Text size="sm">Copying and verifying Stable library…</Text>
            </Group>
            <Progress
              value={100}
              striped
              animated
              color={APP_BRANDING.primaryColor}
              aria-label="Stable library copy in progress"
            />
          </Stack>
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
              <Button variant="default" onClick={() => void runUseCurrent()} disabled={busy}>
                {hasExistingBeta ? "Use existing Beta library" : "Start clean"}
              </Button>
              {hasExistingBeta && confirmReplace ? (
                <Button
                  variant="default"
                  onClick={() => setConfirmReplace(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              ) : null}
              <Button
                color={hasExistingBeta && confirmReplace ? "red" : APP_BRANDING.primaryColor}
                onClick={() => {
                  if (hasExistingBeta && !confirmReplace) {
                    setConfirmReplace(true);
                    return;
                  }
                  void runCopyFlow();
                }}
                disabled={copyDisabled}
              >
                {outstandingToken
                  ? hasExistingBeta && confirmReplace
                    ? "Replace Beta library"
                    : "Retry activation"
                  : hasExistingBeta && confirmReplace
                    ? "Replace Beta library"
                    : "Copy Stable library"}
              </Button>
            </Group>
          </Group>
        ) : null}
      </Stack>
    </Modal>
  );
}
