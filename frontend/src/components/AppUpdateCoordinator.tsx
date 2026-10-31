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
import { APP_CHANNEL } from "../appChannel";
import { hasDirtyAnalysisWorkspaceEditors } from "../features/analyses/workspace/analysisWorkspace";
import {
  appUpdateReducer,
  checkAppUpdateTauri,
  DEFAULT_APP_UPDATE_PREFERENCES,
  firstAutomaticCheckDelayMs,
  loadAppUpdatePreferences,
  downloadAppUpdateTauri,
  describeInstallFailure,
  getCurrentRelease,
  installAppUpdateTauri,
  appUpdateIntervalMs,
  canDismissUpdateModal,
  canUseLocalInstaller,
  stageLocalAppUpdateTauri,
  discardLocalAppUpdateTauri,
  isProtectedUpdateFlow,
  mergeCheckResult,
  mockRelease,
  normalizeUpdaterError,
  parseDevUpdateMock,
  readLastUpdateCheckedAt,
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
  UPDATE_SCHEDULE_CHANGED_EVENT,
  writeLastUpdateCheckedAt,
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
  refreshing: boolean;
  refreshError: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  openUpdateModal: () => void;
  closeUpdateModal: () => void;
  checkForUpdate: (source: UpdateCheckSource) => Promise<void>;
  handleMenuClick: () => void;
  downloadAndLaunchInstaller: () => Promise<void>;
  retryDownload: () => Promise<void>;
  retryInstall: () => Promise<void>;
  restartAfterInstallFailure: () => Promise<void>;
  stageLocalInstaller: (installerPath: string, signaturePath: string) => Promise<void>;
  discardLocalInstaller: () => Promise<void>;
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
  const updateUiEnabled = shouldShowUpdateUi(tauri, devMock, APP_CHANNEL);

  const [state, dispatch] = useReducer(appUpdateReducer, { status: "idle" });
  const [modalOpen, setModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [upToDateModal, setUpToDateModal] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readLastUpdateCheckedAt(window.localStorage),
  );
  const [nextCheckAt, setNextCheckAt] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<AppUpdatePreferences>(() =>
    typeof window === "undefined"
      ? DEFAULT_APP_UPDATE_PREFERENCES
      : loadAppUpdatePreferences(window.localStorage),
  );
  const stateRef = useRef(state);
  const modalOpenRef = useRef(modalOpen);
  const checkInFlight = useRef<Promise<void> | null>(null);
  const checkFeedbackSource = useRef<UpdateCheckSource>("automatic");
  const checkModalDismissed = useRef(false);
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
        void performCheckRef.current("manual");
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
        if (!checkModalDismissed.current) {
          setUpToDateModal(!merged);
          setModalOpen(true);
        }
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
    [preferences],
  );

  const recordCheckCompleted = useCallback(() => {
    const iso = new Date().toISOString();
    writeLastUpdateCheckedAt(window.localStorage, iso);
    setLastCheckedAt(iso);
    window.dispatchEvent(new Event(UPDATE_SCHEDULE_CHANGED_EVENT));
  }, []);

  const performCheck = useCallback(
    async (source: UpdateCheckSource) => {
      if (!updateUiEnabled) return;
      if (downloadInFlight.current) return;
      if (getCurrentRelease(stateRef.current)?.localInstaller) {
        if (source === "manual") openMatchingUpdateModal();
        return;
      }
      if (isProtectedUpdateFlow(stateRef.current)) {
        if (source === "manual") openMatchingUpdateModal();
        return;
      }
      if (checkInFlight.current) {
        if (source === "manual") {
          checkModalDismissed.current = false;
          checkFeedbackSource.current = "manual";
          openMatchingUpdateModal();
          dispatch({ type: "check_started", source: "manual" });
        }
        await checkInFlight.current;
        return;
      }

      if (source === "automatic" && shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current)) {
        return;
      }

      checkFeedbackSource.current = source;
      if (source === "manual") checkModalDismissed.current = false;
      const epochAtStart = checkEpochRef.current;
      setRefreshing(true);
      setRefreshError(null);
      if (source === "manual") { setUpToDateModal(false); setModalOpen(true); }
      dispatch({ type: "check_started", source });

      // Start on the next microtask so even synchronous dev paths publish the
      // in-flight promise before its finally block clears it.
      const run = Promise.resolve().then(async () => {
        try {
          if (
            devMock === "available" ||
            devMock === "download" ||
            devMock === "unknown-size" ||
            devMock === "download-error" ||
            devMock === "install-error"
          ) {
            if (
              epochAtStart !== checkEpochRef.current ||
              (checkFeedbackSource.current === "automatic" &&
                shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
            ) {
              return;
            }
            applyRelease(mockRelease(), checkFeedbackSource.current);
            recordCheckCompleted();
            return;
          }
          if (!tauri) {
            if (
              epochAtStart !== checkEpochRef.current ||
              (checkFeedbackSource.current === "automatic" &&
                shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
            ) {
              return;
            }
            applyRelease(null, checkFeedbackSource.current);
            recordCheckCompleted();
            return;
          }
          const release = await checkAppUpdateTauri();
          if (!mountedRef.current) return;
          if (
            epochAtStart !== checkEpochRef.current ||
            (checkFeedbackSource.current === "automatic" &&
              shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
          ) {
            return;
          }
          applyRelease(release, checkFeedbackSource.current);
          recordCheckCompleted();
        } catch (error) {
          if (!mountedRef.current) return;
          if (
            epochAtStart !== checkEpochRef.current ||
            (checkFeedbackSource.current === "automatic" &&
              shouldSkipAutomaticCheck(stateRef.current, modalOpenRef.current))
          ) {
            return;
          }
          const feedbackSource = checkFeedbackSource.current;
          const message = normalizeUpdaterError(error, "Could not check for updates.");
          setRefreshError(message);
          if (feedbackSource === "automatic") {
            addDebugEvent("app-update:check-error", { message });
            dispatch({ type: "check_error", source: "automatic", message });
          } else {
            setUpToDateModal(false);
            dispatch({ type: "check_error", source: "manual", message });
            if (!checkModalDismissed.current) setModalOpen(true);
          }
          recordCheckCompleted();
        } finally {
          checkInFlight.current = null;
          if (mountedRef.current) setRefreshing(false);
        }
      });

      checkInFlight.current = run;
      await run;
    },
    [applyRelease, devMock, recordCheckCompleted, tauri, updateUiEnabled, openMatchingUpdateModal],
  );

  useEffect(() => {
    performCheckRef.current = performCheck;
  }, [performCheck]);

  useEffect(() => {
    if (!updateUiEnabled || devMock) {
      setNextCheckAt(null);
      return;
    }
    let disposed = false;
    const timers: number[] = [];
    const intervalMs = appUpdateIntervalMs(preferences);
    const firstDelay = firstAutomaticCheckDelayMs(intervalMs);

    const markNext = (delayMs: number) => {
      const iso = new Date(Date.now() + delayMs).toISOString();
      setNextCheckAt(iso);
      window.dispatchEvent(new Event(UPDATE_SCHEDULE_CHANGED_EVENT));
    };

    const runAutomatic = () => {
      if (disposed) return;
      markNext(intervalMs);
      void performCheck("automatic");
    };

    markNext(firstDelay);
    timers.push(window.setTimeout(runAutomatic, firstDelay));
    const intervalId = window.setInterval(runAutomatic, intervalMs);
    timers.push(intervalId);

    return () => {
      disposed = true;
      setNextCheckAt(null);
      window.clearTimeout(timers[0]);
      window.clearInterval(intervalId);
    };
  }, [devMock, performCheck, preferences, updateUiEnabled]);

  useEffect(() => {
    if (updateUiEnabled && devMock === "available") {
      applyRelease(mockRelease(), "automatic");
    }
  }, [applyRelease, devMock, updateUiEnabled]);

  useEffect(() => {
    if (!updateUiEnabled || !devMock || devMock === "available") return;
    dispatch({ type: "check_success", source: "manual", release: mockRelease() });
    setModalOpen(true);
  }, [devMock, updateUiEnabled]);

  const openUpdateModal = useCallback(() => {
    openMatchingUpdateModal();
    void performCheck("manual");
  }, [openMatchingUpdateModal, performCheck]);

  const closeUpdateModal = useCallback(() => {
    if (upToDateModal) {
      setUpToDateModal(false);
      setModalOpen(false);
      return;
    }
    if (!canDismissUpdateModal(stateRef.current)) return;
    checkModalDismissed.current = true;
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

  const runVerifiedInstall = useCallback(
    async (release: AppUpdateRelease) => {
      if (!mountedRef.current) return;

      // Render truthful preparation feedback while the authenticated handoff runs.
      dispatch({ type: "launching", release });

      try {
        // This records diagnostic session bookkeeping only. It must not delay
        // verified installer preparation; native consent/shutdown still owns
        // every safety deadline and the backend lifecycle.
        void post("/api/session/finish").catch((error) => {
          addDebugEvent("app-update:session-finish-error", {
            message: normalizeUpdaterError(error, "Session finish failed."),
          });
        });

        if (devMock) {
          if (devMock === "install-error") {
            throw { message: "Mock installer preparation failed. No installation was started.", handoff: "aborted", backendStopped: false };
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

        // On Windows the passive NSIS updater takes over and the current process exits.
        await installAppUpdateTauri(release.version);
      } catch (error) {
        if (!mountedRef.current) return;
        dispatch({
          type: "install_error",
          release,
          ...describeInstallFailure(error),
        });
      }
    },
    [devMock],
  );

  const runDownload = useCallback(
    async (release: AppUpdateRelease) => {
      if (downloadInFlight.current) return;
      downloadInFlight.current = true;
      checkEpochRef.current += 1;
      dispatch({ type: "download_started", release });

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
        await runVerifiedInstall(release);
      } catch (error) {
        if (!mountedRef.current) return;
        const message = normalizeUpdaterError(error, "Could not complete the update.");
        dispatch({ type: "download_error", release, message });
      } finally {
        downloadInFlight.current = false;
      }
    },
    [runVerifiedInstall, devMock],
  );

  const downloadAndLaunchInstaller = useCallback(async () => {
    if (checkInFlight.current) {
      await checkInFlight.current;
    }
    const current = stateRef.current;
    if (current.status !== "available") return;
    const confirmed = await confirmDirtyWorkspace(
      current.release.localInstaller ? "Install local update?" : "Download update?",
      "The installer will close CellXplorer and unsaved plot changes in open analysis tabs will be lost.",
    );
    if (!confirmed) return;
    checkEpochRef.current += 1;
    setModalOpen(true);
    if (current.release.localInstaller) {
      if (downloadInFlight.current) return;
      downloadInFlight.current = true;
      try { await runVerifiedInstall(current.release); }
      finally { downloadInFlight.current = false; }
      return;
    }
    await runDownload(current.release);
  }, [runDownload, runVerifiedInstall]);

  const stageLocalInstaller = useCallback(async (installerPath: string, signaturePath: string) => {
    if (!tauri) throw new Error("Local installer verification requires the installed Windows application.");
    if (downloadInFlight.current || !canUseLocalInstaller(stateRef.current)) throw new Error("Finish the active update operation first.");
    downloadInFlight.current = true;
    checkEpochRef.current += 1;
    try {
      if (checkInFlight.current) await checkInFlight.current;
      const release = await stageLocalAppUpdateTauri(installerPath, signaturePath);
      if (!mountedRef.current) return;
      stateRef.current = { status: "available", release };
      dispatch({ type: "reset_available", release });
      setUpToDateModal(false);
      setModalOpen(true);
    } finally { downloadInFlight.current = false; }
  }, [tauri]);

  const discardLocalInstaller = useCallback(async () => {
    if (downloadInFlight.current || !canUseLocalInstaller(stateRef.current)) throw new Error("Finish the active update operation first.");
    if (!getCurrentRelease(stateRef.current)?.localInstaller) return;
    downloadInFlight.current = true;
    checkEpochRef.current += 1;
    try {
      await discardLocalAppUpdateTauri();
      if (!mountedRef.current) return;
      dispatch({ type: "discard_local" });
      stateRef.current = { status: "idle" };
      setModalOpen(false);
      setUpToDateModal(false);
    } finally { downloadInFlight.current = false; }
  }, []);

  const retryDownload = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "error" || !current.release || current.phase !== "download") {
      return;
    }
    dispatch({ type: "reset_available", release: current.release });
    await runDownload(current.release);
  }, [runDownload]);

  const retryInstall = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "error" || !current.release || current.phase !== "install") {
      return;
    }
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    checkEpochRef.current += 1;
    setModalOpen(true);
    try {
      // Rust restores the verified bytes after a pre-exit install error, so this
      // retry starts the installer again without downloading the release again.
      await runVerifiedInstall(current.release);
    } finally {
      downloadInFlight.current = false;
    }
  }, [runVerifiedInstall]);

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
    openUpdateModal();
  }, [openUpdateModal]);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      state,
      showUpdateBadge: shouldPersistUpdateBadge(state),
      updateUiEnabled,
      modalOpen,
      refreshing,
      refreshError,
      lastCheckedAt,
      nextCheckAt,
      openUpdateModal,
      closeUpdateModal,
      checkForUpdate: performCheck,
      handleMenuClick,
      downloadAndLaunchInstaller,
      retryDownload,
      retryInstall,
      restartAfterInstallFailure,
      stageLocalInstaller,
      discardLocalInstaller,
    }),
    [
      closeUpdateModal,
      downloadAndLaunchInstaller,
      handleMenuClick,
      lastCheckedAt,
      modalOpen,
      refreshing,
      refreshError,
      nextCheckAt,
      openUpdateModal,
      performCheck,
      restartAfterInstallFailure,
      stageLocalInstaller,
      discardLocalInstaller,
      retryDownload,
      retryInstall,
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
        refreshing={refreshing}
        refreshError={refreshError}
        onRefresh={() => void performCheck("manual")}
        onClose={closeUpdateModal}
        onDownload={() => void downloadAndLaunchInstaller()}
        onRetry={() => void retryDownload()}
        onRetryInstall={() => void retryInstall()}
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
