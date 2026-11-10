import { Modal } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { get } from "../api";
import { APP_CHANNEL } from "../appChannel";
import { isTauriApp } from "../downloads";
import { isAfterReleaseIntroBaseline, markReleaseIntroSeen, releaseIntroWasSeen } from "../whatsNew";
import { ReleaseIntroduction } from "./ReleaseIntroduction";
import styles from "./ReleaseIntroduction.module.css";
import { useOptionalAppUpdate } from "./AppUpdateCoordinator";

export function WhatsNewCoordinator({ opened, onOpen, onClose, onTrySearch, ready, version }: {
  opened: boolean; onOpen: () => void; onClose: () => void; onTrySearch: () => void;
  ready: boolean; version: string | null;
}) {
  const desktop = isTauriApp();
  const packaged = desktop && !import.meta.env.DEV;
  const reducedMotion = useReducedMotion();
  const updates = useOptionalAppUpdate();
  const shown = useRef(false);
  // Reuse the bootstrap coordinator's query: never announce a feature over first-launch setup.
  const bootstrap = useQuery({
    queryKey: [`${APP_CHANNEL}-bootstrap-status`],
    queryFn: () => get<{ setupState?: string; needsChoice: boolean; blockingReason: string | null }>(`/api/${APP_CHANNEL}-bootstrap/status`),
    enabled: desktop && APP_CHANNEL !== "stable" && ready,
    staleTime: Infinity,
    retry: 1,
  });
  const setupComplete = APP_CHANNEL === "stable" || (bootstrap.data?.setupState === "complete" && !bootstrap.data.needsChoice && !bootstrap.data.blockingReason);
  useEffect(() => {
    if (!packaged || !ready || !setupComplete || !version || !isAfterReleaseIntroBaseline(version) ||
      opened || updates?.modalOpen || shown.current || releaseIntroWasSeen(window.localStorage)) return;
    // Wait for any existing dialog to close; never interrupt an import or setup decision.
    const announce = () => {
      if (document.querySelector('[role="dialog"]')) return;
      shown.current = true;
      observer.disconnect();
      onOpen();
    };
    const observer = new MutationObserver(announce);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(announce, 350);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [packaged, ready, setupComplete, version, opened, updates?.modalOpen, onOpen]);
  const close = () => {
    shown.current = true;
    if (packaged && version && isAfterReleaseIntroBaseline(version)) markReleaseIntroSeen(window.localStorage);
    onClose();
  };
  return <Modal opened={opened} onClose={close} title="What’s new" size="52rem" centered padding="lg" classNames={{ content: styles.modalContent, body: styles.modalBody, header: styles.modalHeader }}>
    {opened && <ReleaseIntroduction onClose={close} onChooseFolders={() => { close(); onTrySearch(); }} reducedMotion={Boolean(reducedMotion)} />}
  </Modal>;
}
