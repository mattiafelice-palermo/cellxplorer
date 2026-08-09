import { Box } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  ANALYSIS_WORKSPACE_MOUNTED_EVENT,
  ANALYSIS_WORKSPACE_POLICY_EVENT,
  ANALYSIS_WORKSPACE_ACTIVE_EVENT,
  loadAnalysisWorkspace,
  loadAnalysisWorkspaceMemoryPolicy,
  markAnalysisWorkspaceMounted,
  showAnalysisWorkspaceView,
  type AnalysisWorkspaceMemoryPolicy,
} from "./analysisWorkspace";
import {
  AnalysesIndexView,
  type AnalysesIndexNavigationOptions,
  type AnalysesIndexRouteIntent,
} from "../database/AnalysesIndexView";
import { AnalysisEditor } from "../editor/AnalysisEditor";

function analysisIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/analyses\/(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function AnalysisWorkspaceDatabase() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeIntent: AnalysesIndexRouteIntent = {
    openCreate: searchParams.get("new") === "1",
    openPortableImport: searchParams.get("portableImport") === "1",
    portableSource: searchParams.get("portableSource"),
  };

  const consumeRouteKeys = useCallback(
    (keys: Array<"new" | "portableImport" | "portableSource">) => {
      const next = new URLSearchParams(searchParams);
      keys.forEach((key) => next.delete(key));
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, { replace: true });
      }
    },
    [searchParams, setSearchParams],
  );

  const navigateToAnalysis = useCallback(
    (analysisId: number, options?: AnalysesIndexNavigationOptions) => {
      const plotQuery = options?.plotId
        ? `?plot=${encodeURIComponent(options.plotId)}`
        : "";
      navigate(`/analyses/${analysisId}${plotQuery}`);
    },
    [navigate],
  );

  const navigateToFolder = useCallback(
    (folderId: number) => navigate(`/projects?folder=${folderId}`),
    [navigate],
  );

  return (
    <AnalysesIndexView
      routeIntent={routeIntent}
      consumeRouteKeys={consumeRouteKeys}
      navigateToAnalysis={navigateToAnalysis}
      navigateToFolder={navigateToFolder}
    />
  );
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
    if (activeId !== null) return <AnalysisEditor key={activeId} analysisId={activeId} />;
    return <AnalysisWorkspaceDatabase />;
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
        <AnalysisWorkspaceDatabase />
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
          <AnalysisEditor
            analysisId={analysisId}
            workspaceVisible={displayedId === analysisId}
          />
        </Box>
      ))}
    </Box>
  );
}
