import { Box } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  ANALYSIS_WORKSPACE_MOUNTED_EVENT,
  ANALYSIS_WORKSPACE_POLICY_EVENT,
  ANALYSIS_WORKSPACE_ACTIVE_EVENT,
  loadAnalysisWorkspace,
  loadAnalysisWorkspaceMemoryPolicy,
  markAnalysisWorkspaceMounted,
  showAnalysisWorkspaceView,
  type AnalysisWorkspaceMemoryPolicy,
} from "../analysisWorkspace";
import { AnalysesIndexPage } from "../pages/AnalysesIndexPage";
import { AnalysisPage } from "../pages/AnalysisPage";

function analysisIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/analyses\/(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function AnalysisWorkspaceContent() {
  const location = useLocation();
  const activeId = analysisIdFromPath(location.pathname);
  const [displayedId, setDisplayedId] = useState<number | null>(activeId);
  const onHome = displayedId === null;
  const [policy, setPolicy] = useState<AnalysisWorkspaceMemoryPolicy>(
    loadAnalysisWorkspaceMemoryPolicy,
  );
  // The process-level mount registry outlives this route, while its React
  // editors do not. Start with only the visible editor so returning to the
  // database home never reconstructs every remembered tab before first paint.
  const [mountedIds, setMountedIds] = useState<number[]>(() => activeId === null ? [] : [activeId]);
  const mountedIdsRef = useRef(new Set(mountedIds));
  const restoredTabIds = useRef(loadAnalysisWorkspace().tabs.map((tab) => tab.id));

  const mountLocally = (analysisId: number) => {
    mountedIdsRef.current.add(analysisId);
    setMountedIds((current) => current.includes(analysisId) ? current : [...current, analysisId]);
    markAnalysisWorkspaceMounted(analysisId);
  };

  useEffect(() => {
    if (activeId === null) return;
    mountLocally(activeId);
  }, [activeId]);

  useEffect(() => {
    setDisplayedId(activeId);
    showAnalysisWorkspaceView(activeId);
  }, [activeId]);

  useEffect(() => {
    const onMountedChange = (event: Event) => {
      const detail = (event as CustomEvent<{ analysisId: number; mounted: boolean }>).detail;
      if (detail.mounted) mountedIdsRef.current.add(detail.analysisId);
      else mountedIdsRef.current.delete(detail.analysisId);
      setMountedIds((current) => detail.mounted
        ? current.includes(detail.analysisId) ? current : [...current, detail.analysisId]
        : current.filter((id) => id !== detail.analysisId));
    };
    const onPolicyChange = (event: Event) => {
      setPolicy((event as CustomEvent<AnalysisWorkspaceMemoryPolicy>).detail);
    };
    const onActiveChange = (event: Event) => {
      setDisplayedId((event as CustomEvent<number | null>).detail);
    };
    window.addEventListener(ANALYSIS_WORKSPACE_MOUNTED_EVENT, onMountedChange);
    window.addEventListener(ANALYSIS_WORKSPACE_POLICY_EVENT, onPolicyChange);
    window.addEventListener(ANALYSIS_WORKSPACE_ACTIVE_EVENT, onActiveChange);
    return () => {
      window.removeEventListener(ANALYSIS_WORKSPACE_MOUNTED_EVENT, onMountedChange);
      window.removeEventListener(ANALYSIS_WORKSPACE_POLICY_EVENT, onPolicyChange);
      window.removeEventListener(ANALYSIS_WORKSPACE_ACTIVE_EVENT, onActiveChange);
    };
  }, []);

  useEffect(() => {
    if (policy !== "keep-mounted" || restoredTabIds.current.length === 0) return;
    let cancelled = false;
    let timer: number | null = null;
    let idleCallback: number | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      const stillOpen = new Set(loadAnalysisWorkspace().tabs.map((tab) => tab.id));
      const nextId = restoredTabIds.current.find(
        (id) => stillOpen.has(id) && !mountedIdsRef.current.has(id),
      );
      if (nextId === undefined) return;

      const mountNext = () => {
        if (cancelled) return;
        const openNow = loadAnalysisWorkspace().tabs.some((tab) => tab.id === nextId);
        if (openNow) mountLocally(nextId);
        // Give this editor time to fetch and construct its active Plotly view
        // before admitting another restored tab.
        timer = window.setTimeout(scheduleNext, 1200);
      };

      if ("requestIdleCallback" in window) {
        idleCallback = window.requestIdleCallback(mountNext, { timeout: 4000 });
      } else {
        timer = globalThis.setTimeout(mountNext, 800);
      }
    };

    // The visible route always paints first. Restored background editors are
    // repopulated only after startup has yielded to the browser.
    timer = window.setTimeout(scheduleNext, 500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (idleCallback !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallback);
      }
    };
  }, [policy]);

  if (policy === "unmount") {
    if (activeId !== null) return <AnalysisPage key={activeId} />;
    return <AnalysesIndexPage />;
  }

  return (
    <Box pos="relative">
      <Box
        style={onHome ? undefined : {
          position: "absolute",
          inset: 0,
          visibility: "hidden",
          pointerEvents: "none",
        }}
        aria-hidden={!onHome}
      >
        <AnalysesIndexPage />
      </Box>
      {mountedIds.map((analysisId) => (
        <Box
          key={analysisId}
          style={displayedId === analysisId ? undefined : {
            position: "absolute",
            inset: 0,
            visibility: "hidden",
            pointerEvents: "none",
          }}
          aria-hidden={displayedId !== analysisId}
        >
          <AnalysisPage
            analysisIdOverride={analysisId}
            workspaceVisible={displayedId === analysisId}
          />
        </Box>
      ))}
    </Box>
  );
}
