import { Alert, Button, Group, Loader, Modal, Paper, Progress, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconLoader2 } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type BackgroundJob,
  type AlphaBootstrapStageCopyResult,
  type AlphaBootstrapStatus,
  type BetaScientificPreparationStatus,
  type BetaBootstrapStageCopyResult,
  type BetaBootstrapStatus,
} from "../api";
import { APP_BRANDING } from "../appChannel";
import {
  betaBootstrapGateOpen,
  betaBootstrapLoadingStatus,
  copyStableLibraryDisabled,
  alphaSourceBlockingReason,
  alphaSourceCopyDisabled,
  mockBetaBootstrapStatus,
  parseDevBetaBootstrapMock,
  resolveBetaBootstrapSetupState,
  scientificPreparationResourceText,
  shouldRetryExistingStage,
  shouldShowBetaBootstrapUi,
  type BootstrapChannel,
  type BootstrapStatus,
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
  const bootstrapChannel: BootstrapChannel =
    APP_BRANDING.channel === "alpha" ? "alpha" : "beta";
  const isAlpha = bootstrapChannel === "alpha";
  const devMock = parseDevBetaBootstrapMock(
    window.location.search,
    import.meta.env.DEV,
    bootstrapChannel,
  );
  const enabled = shouldShowBetaBootstrapUi(APP_BRANDING.channel, tauri, devMock);
  const actionInFlight = useRef(false);
  const [phase, setPhase] = useState<CoordinatorPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retainedToken, setRetainedToken] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [alphaSource, setAlphaSource] = useState<"stable" | "beta" | null>(null);
  const [loadingElapsedSeconds, setLoadingElapsedSeconds] = useState(0);
  const [preparationContinuesInBackground, setPreparationContinuesInBackground] =
    useState(false);
  const [preparationModeError, setPreparationModeError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: [`${bootstrapChannel}-bootstrap-status`],
    queryFn: () => get<BootstrapStatus>(`/api/${bootstrapChannel}-bootstrap/status`),
    enabled: enabled && !devMock && backendReady,
    staleTime: Infinity,
    retry: 1,
  });

  const status = devMock
    ? mockBetaBootstrapStatus(devMock, bootstrapChannel)
    : statusQuery.data;
  const preparationStatus = useQuery({
    queryKey: [`${bootstrapChannel}-bootstrap-preparation-status`],
    queryFn: () =>
      get<BetaScientificPreparationStatus>(
        `/api/${bootstrapChannel}-bootstrap/preparation-status`,
      ),
    enabled: Boolean(
      enabled &&
        !devMock &&
        backendReady &&
        (gateRequiredOnLaunch || status?.scientificPreparationPending),
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
  const preparationResourceText = scientificPreparationResourceText(
    preparationJob ??
      (preparationPending
        ? {
            resource_mode: "foreground",
            workers: 1,
            transition_pending: false,
          }
        : undefined),
  );
  const betaStatus = !isAlpha ? (status as BetaBootstrapStatus | undefined) : undefined;
  const alphaStatus = isAlpha ? (status as AlphaBootstrapStatus | undefined) : undefined;
  const hasExistingBeta = betaStatus?.betaHasExistingLibrary ?? !betaStatus?.betaPristine;
  const hasExistingAlpha =
    alphaStatus?.alphaHasExistingLibrary ?? !alphaStatus?.alphaPristine;
  const hasExistingLibrary = isAlpha ? hasExistingAlpha : hasExistingBeta;
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
  const setupLoading = setupState === "loading" && !preparationPending;
  const loadingStatus = betaBootstrapLoadingStatus(
    backendReady,
    loadingElapsedSeconds,
    bootstrapChannel,
  );

  useEffect(() => {
    if (!setupLoading) {
      setLoadingElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLoadingElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [setupLoading]);

  useEffect(() => {
    if (!preparationPending) {
      setPreparationContinuesInBackground(false);
      setPreparationModeError(null);
    }
  }, [preparationPending]);

  const continuePreparationInBackground = useMutation({
    mutationFn: () =>
      post<{
        jobId: number;
        resourceMode: "background";
        workers: number;
        transitionPending: boolean;
      }>(`/api/${bootstrapChannel}-bootstrap/preparation-background`, {}),
    onSuccess: async () => {
      setPreparationModeError(null);
      setPreparationContinuesInBackground(true);
      await queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
    },
    onError: (error: Error) => {
      setPreparationModeError(
        error.message || "Could not move preparation to the background.",
      );
    },
  });

  const outstandingToken =
    retainedToken ?? status?.outstandingStageToken ?? null;

  const copyBlockedReason = useMemo(() => {
    if (isAlpha) return null;
    if (devMock === "blocked") {
      return betaStatus?.copyBlockingReason ?? betaStatus?.blockingReason;
    }
    if (!betaStatus?.stableDatabaseCompatible) {
      return (
        betaStatus?.copyBlockingReason ??
        betaStatus?.blockingReason ??
        "The Stable library cannot be copied safely."
      );
    }
    return null;
  }, [betaStatus, devMock, isAlpha]);

  const setupError =
    errorMessage ??
    status?.setupError ??
    (setupState === "blocked-error" && statusQuery.isError
      ? `Could not load CellXplorer ${isAlpha ? "Alpha" : "Beta"} setup status.`
      : null) ??
    status?.applyFailureMessage ??
    null;

  const applyToken = useCallback(async (
    token: string,
    confirmReplaceExisting: boolean,
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
    if (isAlpha) {
      await invoke("apply_alpha_bootstrap", {
        token,
        confirmReplaceExistingLibrary: confirmReplaceExisting,
      });
    } else {
      const confirmReplaceExistingBeta = confirmReplaceExisting;
      await invoke("apply_beta_bootstrap", { token, confirmReplaceExistingBeta });
    }
  }, [isAlpha]);

  const runCopyFlow = useCallback(async (source: "stable" | "beta" = "stable") => {
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
        const staged = isAlpha
          ? await post<AlphaBootstrapStageCopyResult>(
              "/api/alpha-bootstrap/stage-copy",
              {
                source,
                confirmReplaceExistingLibrary: hasExistingAlpha && confirmReplace,
              },
            )
          : await post<BetaBootstrapStageCopyResult>("/api/beta-bootstrap/stage-copy", {
              confirmReplaceExistingBeta: hasExistingBeta,
            });
        token = staged.token;
        setRetainedToken(token);
      }
      if (!token) {
        throw new Error("The staged copy token is missing.");
      }
      if (isAlpha) {
        await applyToken(token, hasExistingAlpha && confirmReplace);
      } else {
        await applyToken(token, hasExistingBeta && confirmReplace);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : typeof error === "string" && error.trim()
            ? error.trim()
          : `Could not copy the ${source === "beta" ? "Beta" : "Stable"} library.`;
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
  }, [applyToken, devMock, hasExistingAlpha, hasExistingBeta, isAlpha, outstandingToken, phase]);

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
        await post(`/api/${bootstrapChannel}-bootstrap/discard-stage`, {
          token: outstandingToken,
        });
      }
      await post(
        hasExistingLibrary
          ? `/api/${bootstrapChannel}-bootstrap/use-current`
          : `/api/${bootstrapChannel}-bootstrap/start-empty`,
      );
      setRetainedToken(null);
      await queryClient.invalidateQueries({
        queryKey: [`${bootstrapChannel}-bootstrap-status`],
      });
      setPhase("idle");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : `Could not keep the current ${isAlpha ? "Alpha" : "Beta"} library.`;
      setErrorMessage(message);
      setPhase("error");
    } finally {
      actionInFlight.current = false;
    }
  }, [bootstrapChannel, devMock, hasExistingLibrary, isAlpha, outstandingToken, queryClient]);

  const retryStatus = useCallback(() => {
    setErrorMessage(null);
    void queryClient.invalidateQueries({
      queryKey: [`${bootstrapChannel}-bootstrap-status`],
    });
  }, [bootstrapChannel, queryClient]);

  const discardStage = useCallback(async () => {
    if (!outstandingToken || actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      await post(`/api/${bootstrapChannel}-bootstrap/discard-stage`, {
        token: outstandingToken,
      });
      setRetainedToken(null);
      setErrorMessage(null);
      await queryClient.invalidateQueries({
        queryKey: [`${bootstrapChannel}-bootstrap-status`],
      });
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
  }, [bootstrapChannel, outstandingToken, queryClient]);

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

  const busy = phase === "staging" || phase === "applying" || phase === "restarting";
  const copyStableDisabled = isAlpha
    ? alphaSourceCopyDisabled(alphaStatus, "stable", busy, devMock)
    : copyStableLibraryDisabled(betaStatus, busy, devMock);
  const copyBetaDisabled = isAlpha
    ? alphaSourceCopyDisabled(alphaStatus, "beta", busy, devMock)
    : true;
  const stableBlockingReason = isAlpha
    ? alphaSourceBlockingReason(alphaStatus, "stable", devMock)
    : copyBlockedReason;
  const betaBlockingReason = isAlpha
    ? alphaSourceBlockingReason(alphaStatus, "beta", devMock)
    : null;
  const showChoice = setupState === "choice-required";
  const showLoading = setupLoading;
  const showBlocked = setupState === "blocked-error";
  const requiresSetupDecisionOrRecovery = showChoice || showBlocked;
  const modalOpen =
    requiresSetupDecisionOrRecovery ||
    (preparationPending
      ? !preparationContinuesInBackground
      : gateOpen);

  if (!enabled || !modalOpen) {
    return null;
  }

  return (
    <Modal
      opened
      onClose={() => undefined}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      centered
      size="md"
      title={
        preparationPending
          ? `Preparing copied ${isAlpha ? "Alpha" : "Beta"} library`
          : `Set up CellXplorer ${isAlpha ? "Alpha" : "Beta"}`
      }
      zIndex={400}
    >
      <Stack gap="md">
        {preparationPending ? (
          <>
            <Text size="sm">
              CellXplorer {isAlpha ? "Alpha" : "Beta"} is preparing the copied cells and scientific
              data. The library will open when this one-time pass finishes.
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
            <Text size="xs" c="dimmed">
              {preparationResourceText}
            </Text>
            <Text size="xs" c="dimmed">
              You may continue using CellXplorer while this job runs. Existing cells can remain
              incomplete until their source files have been prepared.
            </Text>
            {preparationModeError ? (
              <Alert color="red" title="Could not continue in background">
                {preparationModeError}
              </Alert>
            ) : null}
            <Group justify="flex-end">
              <Button
                variant="default"
                loading={continuePreparationInBackground.isPending}
                onClick={() => continuePreparationInBackground.mutate()}
              >
                Continue in background
              </Button>
            </Group>
          </>
        ) : null}

        {showLoading ? (
          <Paper withBorder p="sm">
            <Group gap="sm" align="flex-start" wrap="nowrap">
              <Loader size="sm" mt={2} color={APP_BRANDING.primaryColor} />
              <Stack gap={2}>
                <Text size="sm" fw={600}>
                  {loadingStatus.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {loadingStatus.detail}
                </Text>
                {loadingElapsedSeconds > 0 ? (
                  <Text size="xs" c="dimmed">
                    Elapsed time: {loadingElapsedSeconds} second
                    {loadingElapsedSeconds === 1 ? "" : "s"}
                  </Text>
                ) : null}
              </Stack>
            </Group>
          </Paper>
        ) : null}

        {showChoice ? (
          <Text size="sm">
            {isAlpha
              ? "Alpha keeps its library separate from CellXplorer and CellXplorer Beta. You can start empty, or copy a one-time snapshot of one of your existing libraries. The library you copy from is not modified, and the two stay independent afterwards."
              : hasExistingBeta
              ? "This Beta installation already has its own library. You can keep it, or replace it with a fresh snapshot of your current Stable library."
              : "Beta keeps its library separate from the stable app. You can copy a snapshot of your current Stable library, or start with a clean Beta library."}
        </Text>
      ) : null}

        {showChoice && !isAlpha && hasExistingBeta ? (
          <Alert color="yellow" title="Copying will overwrite Beta data">
            Copying from Stable replaces the current Beta database and Beta-managed imports. Stable
            itself is not changed.
          </Alert>
        ) : null}

        {showChoice && hasExistingBeta && confirmReplace ? (
          <Alert color="red" title={`Confirm ${isAlpha ? "Alpha" : "Beta"} library replacement`}>
            Continue only if you no longer need the current {isAlpha ? "Alpha" : "Beta"} data. The replacement is rolled
            back if activation fails, but after a successful copy the previous {isAlpha ? "Alpha" : "Beta"} library is
            removed.
          </Alert>
        ) : null}

        {showBlocked ? (
          <Alert color="red" title={`CellXplorer ${isAlpha ? "Alpha" : "Beta"} setup blocked`}>
            {setupError ?? `CellXplorer ${isAlpha ? "Alpha" : "Beta"} setup cannot continue until this problem is resolved.`}
          </Alert>
        ) : null}

        {copyBlockedReason && showChoice && !isAlpha ? (
          <Alert color="yellow" title="Copy unavailable">
            {copyBlockedReason}
          </Alert>
        ) : null}

        {isAlpha && showChoice && (stableBlockingReason || betaBlockingReason) ? (
          <Stack gap={4}>
            {stableBlockingReason ? (
              <Text size="xs" c="orange">
                Copy Stable library unavailable: {stableBlockingReason}
              </Text>
            ) : null}
            {betaBlockingReason ? (
              <Text size="xs" c="orange">
                Copy Beta library unavailable: {betaBlockingReason}
              </Text>
            ) : null}
          </Stack>
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
              A staged {isAlpha ? "library" : "Stable library"} copy is ready. Retry will activate it without copying again.
          </Text>
        ) : null}

        {phase === "staging" ? (
          <Stack gap="xs">
            <Group gap="xs">
              <IconLoader2 size={16} className="source-check-spin" />
              <Text size="sm">
                Copying and verifying {isAlpha && alphaSource === "beta" ? "Beta" : "Stable"} library…
              </Text>
            </Group>
            {isAlpha ? (
              <Loader color={APP_BRANDING.primaryColor} type="bars" aria-label="Library copy in progress" />
            ) : (
              <Progress
                value={100}
                striped
                animated
                color={APP_BRANDING.primaryColor}
                aria-label="Stable library copy in progress"
              />
            )}
          </Stack>
        ) : null}

        {phase === "applying" || phase === "restarting" ? (
          <Group gap="xs">
            <Loader size="sm" color={APP_BRANDING.primaryColor} />
            <Text size="sm">Restarting CellXplorer {isAlpha ? "Alpha" : "Beta"}…</Text>
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
          <Group justify="space-between" gap="sm" align="flex-end">
            <Group gap="xs">
              {outstandingToken ? (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  onClick={() => void discardStage()}
                  disabled={busy}
                >
                  Discard staged copy
                </Button>
              ) : null}
            </Group>
            {isAlpha ? (
              <Group gap="sm" align="flex-end" wrap="wrap" justify="flex-end">
                <Stack gap={2} maw={170}>
                  <Button
                    color={hasExistingAlpha && confirmReplace ? "red" : APP_BRANDING.primaryColor}
                    onClick={() => {
                      setAlphaSource("stable");
                      if (hasExistingAlpha && !confirmReplace) {
                        setConfirmReplace(true);
                        return;
                      }
                      void runCopyFlow("stable");
                    }}
                    disabled={copyStableDisabled}
                    title={stableBlockingReason ?? undefined}
                  >
                    {outstandingToken
                      ? hasExistingAlpha && confirmReplace
                        ? "Replace Alpha library"
                        : "Retry activation"
                      : hasExistingAlpha && confirmReplace
                        ? "Replace Alpha library"
                        : "Copy Stable library"}
                  </Button>
                  {stableBlockingReason ? (
                    <Text size="xs" c="orange" ta="center">
                      {stableBlockingReason}
                    </Text>
                  ) : null}
                </Stack>
                <Stack gap={2} maw={170}>
                  <Button
                    color={hasExistingAlpha && confirmReplace ? "red" : APP_BRANDING.primaryColor}
                    onClick={() => {
                      setAlphaSource("beta");
                      if (hasExistingAlpha && !confirmReplace) {
                        setConfirmReplace(true);
                        return;
                      }
                      void runCopyFlow("beta");
                    }}
                    disabled={copyBetaDisabled}
                    title={betaBlockingReason ?? undefined}
                  >
                    {outstandingToken
                      ? hasExistingAlpha && confirmReplace
                        ? "Replace Alpha library"
                        : "Retry activation"
                      : hasExistingAlpha && confirmReplace
                        ? "Replace Alpha library"
                        : "Copy Beta library"}
                  </Button>
                  {betaBlockingReason ? (
                    <Text size="xs" c="orange" ta="center">
                      {betaBlockingReason}
                    </Text>
                  ) : null}
                </Stack>
                <Button onClick={() => void runUseCurrent()} disabled={busy}>
                  Start empty
                </Button>
                {confirmReplace ? (
                  <Button variant="default" onClick={() => setConfirmReplace(false)} disabled={busy}>
                    Cancel
                  </Button>
                ) : null}
              </Group>
            ) : (
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
                  disabled={copyStableDisabled}
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
            )}
          </Group>
        ) : null}
      </Stack>
    </Modal>
  );
}
