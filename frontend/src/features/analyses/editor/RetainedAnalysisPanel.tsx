import { Box } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, type AnalysisTabKey, type SavedAnalysisPlot } from "../../../api";
import { ANALYSIS_WORKSPACE_POLICY_EVENT, loadAnalysisWorkspaceMemoryPolicy } from "../workspace/analysisWorkspace";
import { familyPreloadAdmissionAllowed, familyPreloadCandidates, familyPreloadIdentity } from "./policies/analysisFamilyRetention";
import { PlotFamilyActivityContext } from "./plotting/plotFamilyActivity";

/** Freeze the committed subtree as well as its spec while a different family is active. */
export function RetainedAnalysisPanel({
  value, label, active, visible, retain, preparing, retainable, validPlotIds, plotId, onSettled, children,
}: {
  value: AnalysisTabKey;
  label: string;
  active: boolean;
  visible: boolean;
  retain: boolean;
  preparing: boolean;
  retainable: boolean;
  validPlotIds: ReadonlySet<string>;
  plotId: string | null;
  onSettled: () => void;
  children: ReactNode;
}) {
  const previous = useRef<{ children: ReactNode; plotId: string | null } | null>(null);
  const validPrevious = previous.current && (
    previous.current.plotId === null || validPlotIds.has(previous.current.plotId)
  );
  const content = active || preparing ? children : retain && validPrevious ? previous.current?.children : null;
  useLayoutEffect(() => {
    if ((active || preparing) && retainable) previous.current = { children, plotId };
    else if (!retain || !validPrevious || active) previous.current = null;
  }, [active, children, plotId, preparing, retain, retainable, validPrevious]);
  const activity = useMemo(() => ({
    enabled: visible && (active || preparing),
    cacheOnly: preparing && !active,
    onSettled,
  }), [active, onSettled, preparing, visible]);
  if (!content) return null;
  return (
    <Box
      role="tabpanel"
      aria-label={label}
      aria-hidden={!active}
      data-retained-family={value}
      {...(!active ? { inert: "" } : {})}
      pt="sm"
      style={active ? undefined : {
        position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none", overflow: "hidden",
      }}
    >
      <PlotFamilyActivityContext.Provider value={activity}>{content}</PlotFamilyActivityContext.Provider>
    </Box>
  );
}

const SCIENTIFIC_QUERY_ROOTS = new Set(["compute", "time-capacity", "steps", "dcir", "chargeability", "rate-capability"]);

/** Speculation is cache-only, serial, idle, and limited to two unopened family views. */
export function useAnalysisFamilyRetention({
  activeTab, workspaceVisible, plots, preferred, enabled,
}: {
  activeTab: AnalysisTabKey;
  workspaceVisible: boolean;
  plots: readonly SavedAnalysisPlot[];
  preferred: Partial<Record<AnalysisTabKey, string>>;
  enabled: boolean;
}) {
  const qc = useQueryClient();
  // A hot-reloaded frontend can still be connected to an older backend process.
  // It must explicitly advertise cache-only support before any speculation.
  const capabilities = useQuery({
    queryKey: ["analysis-preload-capabilities"],
    queryFn: () => get<{ capabilities?: { analysis_cache_only?: boolean } }>("/api/health"),
    staleTime: 60_000,
  });
  const canPreload = capabilities.data?.capabilities?.analysis_cache_only === true;
  const [retain, setRetain] = useState(() => loadAnalysisWorkspaceMemoryPolicy() === "keep-mounted");
  const [visited, setVisited] = useState<ReadonlySet<AnalysisTabKey>>(() => new Set());
  const [preload, setPreload] = useState<SavedAnalysisPlot | null>(null);
  const attempted = useRef(new Set<string>());
  const speculative = useRef(new Set<AnalysisTabKey>());
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;
    setVisited((current) => current.has(activeTab) ? current : new Set([...current, activeTab]));
    speculative.current.delete(activeTab);
    lastActivity.current = Date.now();
    setPreload(null);
  }, [activeTab, enabled]);
  useEffect(() => {
    const onPolicy = () => setRetain(loadAnalysisWorkspaceMemoryPolicy() === "keep-mounted");
    const onActivity = () => { lastActivity.current = Date.now(); };
    window.addEventListener(ANALYSIS_WORKSPACE_POLICY_EVENT, onPolicy);
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "focus"];
    events.forEach((event) => window.addEventListener(event, onActivity, { passive: true }));
    return () => {
      window.removeEventListener(ANALYSIS_WORKSPACE_POLICY_EVENT, onPolicy);
      events.forEach((event) => window.removeEventListener(event, onActivity));
    };
  }, []);
  const settled = useCallback(() => setPreload(null), []);
  useEffect(() => {
    if (!workspaceVisible || !retain || !enabled || !canPreload) {
      setPreload(null);
      speculative.current.clear();
      return;
    }
    if (preload) {
      // Empty/unsupported saved configurations may never issue a query.
      const timeout = window.setTimeout(settled, 10_000);
      return () => window.clearTimeout(timeout);
    }
    let idle: number | null = null;
    const admissionAllowed = () => familyPreloadAdmissionAllowed({
      idleMs: Date.now() - lastActivity.current,
      speculativeCount: speculative.current.size,
      foregroundFetching: qc.isFetching({ predicate: (query) => SCIENTIFIC_QUERY_ROOTS.has(String(query.queryKey[0])) }),
      documentVisible: document.visibilityState === "visible",
    });
    const timer = window.setInterval(() => {
      if (idle !== null || !admissionAllowed()) return;
      const next = familyPreloadCandidates(plots, activeTab, visited, attempted.current, preferred)[0];
      if (!next) return;
      const admit = () => {
        idle = null;
        if (!admissionAllowed()) return;
        attempted.current.add(familyPreloadIdentity(next));
        speculative.current.add(next.tab);
        setPreload(next);
      };
      if ("requestIdleCallback" in window) idle = window.requestIdleCallback(admit);
      else admit();
    }, 500);
    return () => {
      window.clearInterval(timer);
      if (idle !== null) window.cancelIdleCallback(idle);
    };
  }, [activeTab, canPreload, enabled, plots, preferred, preload, qc, retain, settled, visited, workspaceVisible]);
  return { retain, visited, preload, settled };
}
