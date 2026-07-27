import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { post } from "../api";
import { hasDirtyAnalysisWorkspaceEditors } from "../analysisWorkspace";
import {
  appUpdateReducer,
  AUTO_CHECK_INITIAL_DELAY_MS,
  appUpdateIntervalMs,
  canDismissUpdateModal,
  checkAppUpdateTauri,
  DEFAULT_APP_UPDATE_PREFERENCES,
  loadAppUpdatePreferences,
  downloadAppUpdateTauri,
  failurePhaseForLocalUpdatePhase,
  getCurrentRelease,
  installAppUpdateTauri,
  mergeCheckResult,
  mockRelease,
  normalizeUpdaterError,
  parseDevUpdateMock,
  readNotifiedVersion,
  resolveEffectiveCheckSource,
  resolveUpdateDiscoveryFeedback,
  restartAppTauri,
  runDevUpdateMock,
  shouldPersistUpdateBadge,
  shouldShowUpdateUi,
  shouldSkipAutomaticCheck,
  showMainWindowForUpdateTauri,
  UPDATE_PREFERENCES_CHANGED_EVENT,
  writeNotifiedVersion,
  type AppUpdatePreferences,
  type AppUpdateDownloadEvent,
  type AppUpdateRelease,
  type AppUpdateState,
  type UpdateCheckSource,
} from "../appUpdater";
import { addDebugEvent } from "../debug";
import { isTauriApp } from "../downloads";
import { showWindowsUpdateNotification, listenForUpdateNotificationActivation } from "../updateNotifications";
import { AppUpdateModal } from "./AppUpdateModal";

type AppUpdateContextValue = {
  state: AppUpdateState;
  showUpdateBadge: boolean;
  updateUiEnabled: boolean;
  modalOpen: boolean;
  openUpdateModal: () => void;
  closeUpdateModal: () => void;
  checkForUpdate: (source: UpdateCheckSource) => Promise<void>;
  handleMenuClick: () => void;
  downloadAndLaunchInstaller: () => Promise<void>;
  retryDownload: () => Promise<void>;
  restartAfterInstallFailure: () => Promise<void>;
};

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

function confirmDirtyWorkspace(title: string, body: string): Promise<boolean> {
  if (!hasDirtyAnalysisWorkspaceEditors()) return Promise.resolve(true);
  return new Promise((resolve) => {
    modals.openConfirmModal({
      title,
      children: body,
      labels: { confirm: "Continue", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const tauri = isTauriApp();
  const devMock = parseDevUpdateMock(
    typeof window === "undefined" ? "" : window.location.search,
    import.meta.env.DEV,
  );
  const updateUiEnabled = shouldShowUpdateUi(tauri, devMock);

  const [state, dispatch] = useReducer(appUpdateReducer, { status: "idle" });
  const [modalOpen, setModalOpen] = useState(false);
  const [upToDateModal, setUpToDateModal] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<AppUpdatePreferences>(() =>
    typeof window === "undefined"
      ? DEFAULT_APP_UPDATE_PREFERENCES
      : loadAppUpdatePreferences(window.localStorage),
  );
  const stateRef = useRef(state);
  const modalOpenRef = useRef(modalOpen);
  const checkInFlight = useRef<Promise<void> | null>(null);
  const checkFeedbackSource = useRef<UpdateCheckSource>("automatic");
  const checkEpochRef = useRef(0);
  const downloadInFlight = useRef(false);
  const mountedRef = useRef(true);
  const performCheckRef = useRef<(source: UpdateCheckSource) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    modalOpenRef.current = modalOpen;
  }, [modalOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((version) => {
        if (!cancelled && mountedRef.current) setCurrentVersion(version);
      })
      .catch(() => {
        /* keep null; modal still works without a badge */
      });
    return () => {
      cancelled = true;
    };
  }, [tauri]);

  useEffect(() => {
    if (devMock) {
      addDebugEvent("app-update:mock", { mode: devMock });
    }
  }, [devMock]);

  useEffect(() => {
    const reloadPreferences = () => {
      setPreferences(loadAppUpdatePreferences(window.localStorage));
    };
    window.addEventListener(UPDATE_PREFERENCES_CHANGED_EVENT, reloadPreferences);
    window.addEventListener("storage", reloadPreferences);
    return () => {
      window.removeEventListener(UPDATE_PREFERENCES_CHANGED_EVENT, reloadPreferences);
      window.removeEventListener("storage", reloadPreferences);
    };
  }, []);

  const openMatchingUpdateModal = useCallback(() => {
    setUpToDateModal(false);
    setModalOpen(true);
  }, []);

  const handleNotificationActivate = useCallback(
    async (version: string) => {
      try {
        await showMainWindowForUpdateTauri();
      } catch (error) {
        addDebugEvent("app-update:notification-focus-error", {
          message: normalizeUpdaterError(error, "Could not focus the main window."),
        });
      }

      const current = stateRef.current;
      const release = getCurrentRelease(current);
      if (release && release.version === version) {
        openMatchingUpdateModal();
        return;
      }

      await performCheckRef.current("manual");
    },
    [openMatchingUpdateModal],
  );

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenForUpdateNotificationActivation((payload) => {
      void handleNotificationActivate(payload.version);
    }).then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleNotificationActivate, tauri]);

  const applyRelease = useCallback(
    (release: AppUpdateRelease | null, source: UpdateCheckSource) => {
      const feedbackSource = resolveEffectiveCheckSource(source, checkFeedbackSource.current);
      const merged = mergeCheckResult(stateRef.current, release);
      dispatch({ type: "check_success", source: feedbackSource, release: merged });

      const feedback = resolveUpdateDiscoveryFeedback({
        source: feedbackSource,
        release: merged,
        notificationsEnabled: preferences.notificationsEnabled,
        notifiedVersion: readNotifiedVersion(window.localStorage),
      });

      if (feedback === "silent") {
        return;
      }

      if (feedback === "open-modal") {
        if (merged) {
          writeNotifiedVersion(window.localStorage, merged.version);
        }
        setUpToDateModal(!merged);
        setModalOpen(true);
        return;
      }

      setUpToDateModal(false);

      if (feedback === "badge-only" || !merged) {
        return;
      }

      void showWindowsUpdateNotification({
        release: merged,
      }).then((result) => {
        if (!mountedRef.current) return;
        if (result === "shown") {
          writeNotifiedVersion(window.localStorage, merged.version);
          return;
        }
        addDebugEvent("app-update:notification-result", {
          result,
          version: merged.version,
        });
      });
    },
    [preferences.notificationsEnabled],
  );

  const performCheck = useCallback(
    async (source: UpdateCheckSource) => {
      if (checkInFlight.current) {
        if (source === "manual") {
          checkFeedbackSource.current = "manual";
        }
        await checkInFlight.current;
        return;
      }

      if (source === "automatic" && shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current)) {
        return;
      }

      checkFeedbackSource.current = source;
      const epochAtStart = checkEpochRef.current;
      dispatch({ type: "check_started", source });

      const run = (async () => {
        try {
          if (
            devMock === "available" ||
            devMock === "download" ||
            devMock === "unknown-size" ||
            devMock === "download-error" ||
            devMock === "install-error"
          ) {
            if (
              source === "automatic" &&
              (epochAtStart !== checkEpochRef.current ||
                shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
            ) {
              return;
            }
            applyRelease(mockRelease(), checkFeedbackSource.current);
            return;
          }
          if (!tauri) {
            if (
              source === "automatic" &&
              (epochAtStart !== checkEpochRef.current ||
                shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
            ) {
              return;
            }
            applyRelease(null, checkFeedbackSource.current);
            return;
          }
          const release = await checkAppUpdateTauri();
          if (!mountedRef.current) return;
          if (
            source === "automatic" &&
            (epochAtStart !== checkEpochRef.current ||
              shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
          ) {
            return;
          }
          applyRelease(release, checkFeedbackSource.current);
        } catch (error) {
          if (!mountedRef.current) return;
          if (
            source === "automatic" &&
            (epochAtStart !== checkEpochRef.current ||
              shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
          ) {
            return;
          }
          const feedbackSource = checkFeedbackSource.current;
          const message = normalizeUpdaterError(error, "Could not check for updates.");
          if (feedbackSource === "automatic") {
            addDebugEvent("app-update:check-error", { message });
            dispatch({ type: "check_error", source: "automatic", message });
          } else {
            setUpToDateModal(false);
            dispatch({ type: "check_error", source: "manual", message });
            setModalOpen(true);
          }
        } finally {
          checkInFlight.current = null;
        }
      })();

      checkInFlight.current = run;
      await run;
    },
    [applyRelease, devMock, tauri],
  );

  useEffect(() => {
    performCheckRef.current = performCheck;
  }, [performCheck]);

  useEffect(() => {
    if (!updateUiEnabled || devMock) return;
    let disposed = false;
    const timers: number[] = [];

    const schedule = (delayMs: number) => {
      const id = window.setTimeout(() => {
        if (!disposed) void performCheck("automatic");
      }, delayMs);
      timers.push(id);
    };

    const intervalMs = appUpdateIntervalMs(preferences);
    schedule(Math.min(AUTO_CHECK_INITIAL_DELAY_MS, intervalMs));
    const intervalId = window.setInterval(() => {
      if (!disposed) void performCheck("automatic");
    }, intervalMs);
    timers.push(intervalId);

    return () => {
      disposed = true;
      window.clearTimeout(timers[0]);
      window.clearInterval(intervalId);
    };
  }, [devMock, performCheck, preferences, updateUiEnabled]);

  useEffect(() => {
    if (devMock === "available") {
      applyRelease(mockRelease(), "automatic");
    }
  }, [applyRelease, devMock]);

  useEffect(() => {
    if (!devMock || devMock === "available") return;
    dispatch({ type: "check_success", source: "manual", release: mockRelease() });
    setModalOpen(true);
  }, [devMock]);

  const openUpdateModal = useCallback(() => {
    if (stateRef.current.status === "available") {
      checkEpochRef.current += 1;
      setUpToDateModal(false);
      setModalOpen(true);
    }
  }, []);

  const closeUpdateModal = useCallback(() => {
    if (upToDateModal) {
      setUpToDateModal(false);
      setModalOpen(false);
      return;
    }
    if (!canDismissUpdateModal(stateRef.current)) return;
    setModalOpen(false);
    if (stateRef.current.status === "error" && stateRef.current.phase === "check") {
      dispatch({ type: "dismiss_check_error" });
      return;
    }
    if (stateRef.current.status === "error" && stateRef.current.phase === "download") {
      dispatch({ type: "reset_available", release: stateRef.current.release! });
    }
  }, [upToDateModal]);

  const retryCheck = useCallback(() => {
    setUpToDateModal(false);
    dispatch({ type: "dismiss_check_error" });
    void performCheck("manual");
  }, [performCheck]);

  const runDownload = useCallback(
    async (release: AppUpdateRelease) => {
      if (downloadInFlight.current) return;
      downloadInFlight.current = true;
      checkEpochRef.current += 1;
      dispatch({ type: "download_started", release });
      let phase: "download" | "install" = "download";

      const pushProgress = (event: AppUpdateDownloadEvent) => {
        dispatch({ type: "download_event", release, event });
      };

      try {
        if (devMock) {
          await runDevUpdateMock(devMock, pushProgress);
        } else {
          await downloadAppUpdateTauri(release.version, pushProgress);
        }

        if (!mountedRef.current) return;
        phase = "install";
        dispatch({ type: "launching", release });

        try {
          await post("/api/session/finish");
        } catch (error) {
          addDebugEvent("app-update:session-finish-error", {
            message: normalizeUpdaterError(error, "Session finish failed."),
          });
        }

        if (devMock) {
          if (devMock === "install-error") {
            throw new Error("Mock install launch failed.");
          }
          addDebugEvent("app-update:mock-install", { version: release.version });
          notifications.show({
            message: "Mock update finished. No installer was launched.",
            color: "teal",
          });
          dispatch({ type: "reset_available", release });
          setModalOpen(false);
          return;
        }

        // Successful Windows install invocation is non-returning after on_before_exit.
        await installAppUpdateTauri(release.version);
      } catch (error) {
        if (!mountedRef.current) return;
        const message = normalizeUpdaterError(error, "Could not complete the update.");
        const failurePhase = failurePhaseForLocalUpdatePhase(
          phase === "install" || devMock === "install-error" ? "install" : "download",
        );
        if (failurePhase === "install") {
          dispatch({
            type: "install_error",
            release,
            message,
            lifecycleMayNeedRestart: true,
          });
        } else {
          dispatch({ type: "download_error", release, message });
        }
      } finally {
        downloadInFlight.current = false;
      }
    },
    [devMock],
  );

  const downloadAndLaunchInstaller = useCallback(async () => {
    if (checkInFlight.current) {
      await checkInFlight.current;
    }
    const current = stateRef.current;
    if (current.status !== "available") return;
    const confirmed = await confirmDirtyWorkspace(
      "Download update?",
      "The installer will close CellXplorer and unsaved plot changes in open analysis tabs will be lost.",
    );
    if (!confirmed) return;
    checkEpochRef.current += 1;
    setModalOpen(true);
    await runDownload(current.release);
  }, [runDownload]);

  const retryDownload = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "error" || !current.release || current.phase !== "download") {
      return;
    }
    dispatch({ type: "reset_available", release: current.release });
    await runDownload(current.release);
  }, [runDownload]);

  const restartAfterInstallFailure = useCallback(async () => {
    try {
      if (devMock) {
        window.location.reload();
        return;
      }
      await restartAppTauri();
    } catch (error) {
      notifications.show({
        message: normalizeUpdaterError(error, "Could not restart CellXplorer."),
        color: "red",
      });
    }
  }, [devMock]);

  const handleMenuClick = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "available") {
      checkEpochRef.current += 1;
      setUpToDateModal(false);
      setModalOpen(true);
      return;
    }
    if (current.status === "checking") return;
    void performCheck("manual");
  }, [performCheck]);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      state,
      showUpdateBadge: shouldPersistUpdateBadge(state),
      updateUiEnabled,
      modalOpen,
      openUpdateModal,
      closeUpdateModal,
      checkForUpdate: performCheck,
      handleMenuClick,
      downloadAndLaunchInstaller,
      retryDownload,
      restartAfterInstallFailure,
    }),
    [
      closeUpdateModal,
      downloadAndLaunchInstaller,
      handleMenuClick,
      modalOpen,
      openUpdateModal,
      performCheck,
      restartAfterInstallFailure,
      retryDownload,
      state,
      updateUiEnabled,
    ],
  );

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <AppUpdateModal
        opened={modalOpen}
        state={state}
        currentVersion={currentVersion}
        upToDate={upToDateModal}
        onClose={closeUpdateModal}
        onDownload={() => void downloadAndLaunchInstaller()}
        onRetry={() => void retryDownload()}
        onRetryCheck={retryCheck}
        onRestart={() => void restartAfterInstallFailure()}
      />
    </AppUpdateContext.Provider>
  );
}

export function useAppUpdate(): AppUpdateContextValue {
  const context = useContext(AppUpdateContext);
  if (!context) {
    throw new Error("useAppUpdate must be used within AppUpdateProvider");
  }
  return context;
}

export function useOptionalAppUpdate(): AppUpdateContextValue | null {
  return useContext(AppUpdateContext);
}
