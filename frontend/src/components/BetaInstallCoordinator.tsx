import { modals } from "@mantine/modals";
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

import { APP_CHANNEL } from "../appChannel";
import { hasDirtyAnalysisWorkspaceEditors } from "../features/analyses/workspace/analysisWorkspace";
import { post } from "../api";
import {
  appUpdateIntervalMs,
  DEFAULT_APP_UPDATE_PREFERENCES,
  firstAutomaticCheckDelayMs,
  loadAppUpdatePreferences,
  showMainWindowForUpdateTauri,
  UPDATE_PREFERENCES_CHANGED_EVENT,
  type AppUpdateRelease,
  type UpdateCheckSource,
} from "../appUpdater";
import {
  betaInstallReducer,
  checkBetaInstallTauri,
  clearBetaNotifiedVersion,
  detectBetaInstallationTauri,
  downloadBetaInstallTauri,
  explainBetaCheckFailure,
  finishSessionAndInstallBeta,
  getBetaInstallRelease,
  installBetaTauri,
  isProtectedBetaInstallFlow,
  listenForBetaInstallNotificationActivation,
  mergeBetaCheckResult,
  openBetaApplicationTauri,
  readBetaNotifiedVersion,
  resolveBetaDiscoveryFeedback,
  shouldShowBetaInstallUi,
  shouldRunBetaAvailabilityCheck,
  showBetaInstallNotificationTauri,
  startBetaCheckSchedule,
  writeBetaNotifiedVersion,
  type BetaInstallationInfo,
  type BetaInstallState,
} from "../betaInstaller";
import { addDebugEvent } from "../debug";
import { isTauriApp } from "../downloads";
import { BetaInstallModal } from "./BetaInstallModal";

type BetaInstallContextValue = {
  installationInfo: BetaInstallationInfo | null;
  installState: BetaInstallState;
  modalOpen: boolean;
  refreshInstallation: () => Promise<void>;
  checkForBeta: (source: UpdateCheckSource) => Promise<void>;
  openBetaInstallModal: () => void;
  openBetaApplication: () => Promise<void>;
};

const BetaInstallContext = createContext<BetaInstallContextValue | null>(null);

function confirmBetaInstall(title: string, body: string): Promise<boolean> {
  if (!hasDirtyAnalysisWorkspaceEditors()) return Promise.resolve(true);
  return new Promise((resolve) => {
    modals.openConfirmModal({
      title,
      children: body,
      labels: { confirm: "Install", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function BetaInstallProvider({ children }: { children: ReactNode }) {
  const enabled = shouldShowBetaInstallUi(APP_CHANNEL, isTauriApp());
  const [state, dispatch] = useReducer(betaInstallReducer, { status: "idle" });
  const [modalOpen, setModalOpen] = useState(false);
  const [installationInfo, setInstallationInfo] = useState<BetaInstallationInfo | null>(null);
  const [preferences, setPreferences] = useState(() =>
    typeof window === "undefined"
      ? DEFAULT_APP_UPDATE_PREFERENCES
      : loadAppUpdatePreferences(window.localStorage),
  );

  const stateRef = useRef(state);
  const preferencesRef = useRef(preferences);
  const modalOpenRef = useRef(modalOpen);
  const checkInFlight = useRef<Promise<void> | null>(null);
  const downloadInFlight = useRef(false);
  const mountedRef = useRef(true);
  const performCheckRef = useRef<(source: UpdateCheckSource) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    modalOpenRef.current = modalOpen;
  }, [modalOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshInstallation = useCallback(async () => {
    if (!enabled) return;
    try {
      const info = await detectBetaInstallationTauri();
      if (mountedRef.current) {
        setInstallationInfo(info);
      }
    } catch (error) {
      addDebugEvent("beta-install:detect-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refreshInstallation();
  }, [enabled, refreshInstallation]);

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

  const applyRelease = useCallback(
    (release: AppUpdateRelease | null, source: UpdateCheckSource) => {
      const merged = mergeBetaCheckResult(stateRef.current, release);
      dispatch(
        source === "manual" && !merged
          ? { type: "manual_no_release" }
          : { type: "check_success", release: merged },
      );

      const feedback = resolveBetaDiscoveryFeedback({
        source,
        release: merged,
        notificationsEnabled: preferences.notificationsEnabled,
        notifiedVersion: readBetaNotifiedVersion(window.localStorage),
      });

      if (feedback === "silent") {
        return;
      }

      if (feedback === "open-modal") {
        if (merged) {
          writeBetaNotifiedVersion(window.localStorage, merged.version);
        }
        setModalOpen(true);
        return;
      }

      if (!merged) return;

      void showBetaInstallNotificationTauri(merged.version).then((shown) => {
        if (!mountedRef.current) return;
        if (shown) {
          writeBetaNotifiedVersion(window.localStorage, merged.version);
        }
      });
    },
    [preferences.notificationsEnabled],
  );

  const performCheck = useCallback(
    async (source: UpdateCheckSource) => {
      if (!enabled) return;
      if (installationInfo?.installed) return;
      if (!shouldRunBetaAvailabilityCheck({
        betaUpdatesEnabled: preferences.betaUpdatesEnabled,
        betaInstalled: Boolean(installationInfo?.installed),
      }) && source === "automatic") {
        return;
      }
      if (checkInFlight.current) {
        await checkInFlight.current;
        return;
      }

      dispatch({ type: "check_started" });

      const run = (async () => {
        try {
          const release = await checkBetaInstallTauri();
          if (!mountedRef.current) return;
          if (source === "automatic" && !preferencesRef.current.betaUpdatesEnabled) {
            return;
          }
          applyRelease(release, source);
        } catch (error) {
          if (!mountedRef.current) return;
          if (source === "automatic") {
            addDebugEvent("beta-install:auto-check-error", {
              message: explainBetaCheckFailure(error),
            });
            dispatch({ type: "check_success", release: null });
            return;
          }
          dispatch({
            type: "check_error",
            message: explainBetaCheckFailure(error),
          });
          setModalOpen(true);
        }
      })();

      checkInFlight.current = run;
      try {
        await run;
      } finally {
        checkInFlight.current = null;
      }
    },
    [applyRelease, enabled, installationInfo?.installed, preferences.betaUpdatesEnabled],
  );

  performCheckRef.current = performCheck;

  useEffect(() => {
    if (!enabled || preferences.betaUpdatesEnabled) return;
    const protectedFlow = isProtectedBetaInstallFlow(stateRef.current);
    dispatch({ type: "preference_disabled" });
    clearBetaNotifiedVersion(window.localStorage);
    if (!protectedFlow) {
      setModalOpen(false);
    }
  }, [enabled, preferences.betaUpdatesEnabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenForBetaInstallNotificationActivation(async (payload) => {
      try {
        await showMainWindowForUpdateTauri();
      } catch {
        /* focus best-effort */
      }
      const current = getBetaInstallRelease(stateRef.current);
      if (current?.version === payload.version) {
        setModalOpen(true);
        return;
      }
      await performCheckRef.current("manual");
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
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (!preferences.betaUpdatesEnabled) return;
    if (installationInfo?.installed) return;

    const intervalMs = appUpdateIntervalMs(preferences);
    const initialDelay = firstAutomaticCheckDelayMs(intervalMs);

    return startBetaCheckSchedule({
      host: window,
      intervalMs,
      initialDelayMs: initialDelay,
      runCheck: () => {
        void performCheckRef.current("automatic");
      },
    });
  }, [enabled, installationInfo?.installed, preferences]);

  const downloadAndInstall = useCallback(async () => {
    const release = getBetaInstallRelease(stateRef.current);
    if (!release || downloadInFlight.current) return;

    const confirmed = await confirmBetaInstall(
      "Install CellXplorer Beta?",
      "The installer will close this Stable CellXplorer session. Unsaved plot changes will be lost. The stable installation and library will not be replaced.",
    );
    if (!confirmed) return;

    downloadInFlight.current = true;
    dispatch({ type: "download_started", release });

    try {
      await downloadBetaInstallTauri(release.version, (event) => {
        dispatch({ type: "download_event", release, event });
      });
      dispatch({ type: "launching", release });
      await finishSessionAndInstallBeta({
        finishSession: () => post("/api/session/finish"),
        install: () => installBetaTauri(release.version),
        onSessionFinishError: (error) => {
          addDebugEvent("beta-install:session-finish-error", {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const phase =
        stateRef.current.status === "launching" || stateRef.current.status === "downloading"
          ? stateRef.current.status === "launching"
            ? "install"
            : "download"
          : "download";
      if (phase === "install") {
        dispatch({ type: "install_error", release, message });
      } else {
        dispatch({ type: "download_error", release, message });
      }
    } finally {
      downloadInFlight.current = false;
    }
  }, []);

  const value = useMemo<BetaInstallContextValue>(
    () => ({
      installationInfo,
      installState: state,
      modalOpen,
      refreshInstallation,
      checkForBeta: performCheck,
      openBetaInstallModal: () => {
        setModalOpen(true);
        void performCheck("manual");
      },
      openBetaApplication: async () => {
        await openBetaApplicationTauri();
      },
    }),
    [installationInfo, modalOpen, performCheck, refreshInstallation, state],
  );

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <BetaInstallContext.Provider value={value}>
      {children}
      <BetaInstallModal
        opened={modalOpen}
        state={state}
        onClose={() => setModalOpen(false)}
        onInstall={() => void downloadAndInstall()}
        onRetry={() => void downloadAndInstall()}
        onRetryCheck={() => void performCheck("manual")}
      />
    </BetaInstallContext.Provider>
  );
}

export function useBetaInstall(): BetaInstallContextValue | null {
  return useContext(BetaInstallContext);
}

export function useBetaInstallRequired(): BetaInstallContextValue {
  const context = useContext(BetaInstallContext);
  if (!context) {
    throw new Error("useBetaInstallRequired must be used within BetaInstallProvider on Stable.");
  }
  return context;
}
