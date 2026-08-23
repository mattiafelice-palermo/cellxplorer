import PlotlyLib from "plotly.js-dist-min";
import { useEffect, useRef, useState } from "react";

export function useDelayedFlag(active: boolean, delay = 250, minimum = 400): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let timer: number | undefined;
    if (active && !visible) {
      timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
    } else if (!active && visible) {
      const remaining = Math.max(0, minimum - (Date.now() - shownAt.current));
      if (remaining === 0) setVisible(false);
      else timer = window.setTimeout(() => setVisible(false), remaining);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, visible, delay, minimum]);
  return visible;
}

let webGlSupport: boolean | null = null;



export function supportsWebGl(): boolean {
  if (webGlSupport !== null) return webGlSupport;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    webGlSupport = Boolean(
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true })
    );
  } catch {
    webGlSupport = false;
  }
  return webGlSupport;
}

export function interactivePlotTraces(traces: Plotly.Data[]): Plotly.Data[] {
  if (!supportsWebGl()) return traces;
  return traces.map((trace) => {
    const value = trace as Record<string, unknown>;
    // Plotly's SVG renderer remains the reliable fallback for filled bands.
    // Every ordinary line/marker series uses WebGL in the interactive view.
    if ((value.type ?? "scatter") !== "scatter" || value.fill) return trace;
    return { ...trace, type: "scattergl" } as Plotly.Data;
  });
}



export function newComputeToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Plotly image export is synchronous-heavy even though it returns a promise.
// Serializing thumbnail work prevents several saved plots from blocking the UI


export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    const start = () => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: 500 });
      } else {
        window.setTimeout(resolve, 32);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(start));
  });
}


type ZoomMemory = {
  onRelayout: (event: Readonly<Plotly.PlotRelayoutEvent>) => void;
  apply: (layout: Partial<Plotly.Layout>) => Partial<Plotly.Layout>;
  /** Attach to the plot wrapper's onPointerDownCapture so only relayouts
   *  triggered by real pointer interaction are ever recorded. */
  armOnPointerDown: () => void;
};

export function useZoomMemory(signature: string, enabled = true): ZoomMemory {
  const stored = useRef<{
    signature: string;
    x?: [number, number];
    y?: [number, number];
  } | null>(null);
  // Plotly also emits relayout events with range keys on PROGRAMMATIC paths
  // (an autosize echo after Plots.resize once recorded the plain autorange
  // as if it were a zoom; every later rebuild then pinned it and other
  // quantities rendered "empty"). Only pointer-armed events are recorded.
  const armed = useRef(false);
  // Omitting previously injected ranges from the next layout is NOT enough
  // to bring autorange back (plotly keeps the last explicit range), so
  // withdrawal must set autorange:true exactly once.
  const injected = useRef(false);

  const armOnPointerDown = () => {
    armed.current = true;
  };

  const onRelayout = (event: Readonly<Plotly.PlotRelayoutEvent>) => {
    if (!enabled) return;
    const ev = event as Record<string, unknown>;
    if (
      ev["xaxis.autorange"] === true ||
      ev["xaxis2.autorange"] === true ||
      ev["yaxis.autorange"] === true ||
      ev["yaxis2.autorange"] === true
    ) {
      stored.current = null; // double-click / modebar autoscale
      armed.current = false;
      return;
    }
    if (!armed.current) return; // programmatic echo â€” never record
    const xRange = Array.isArray(ev["xaxis.range"]) ? ev["xaxis.range"] as unknown[] : [];
    const yRange = Array.isArray(ev["yaxis.range"]) ? ev["yaxis.range"] as unknown[] : [];
    const xr0 = ev["xaxis.range[0]"] ?? xRange[0];
    const xr1 = ev["xaxis.range[1]"] ?? xRange[1];
    const yr0 = ev["yaxis.range[0]"] ?? yRange[0];
    const yr1 = ev["yaxis.range[1]"] ?? yRange[1];
    const hasX = typeof xr0 === "number" && typeof xr1 === "number";
    const hasY = typeof yr0 === "number" && typeof yr1 === "number";
    if (!hasX && !hasY) return;
    armed.current = false;
    const prev = stored.current?.signature === signature ? stored.current : null;
    stored.current = {
      signature,
      x: hasX ? [xr0 as number, xr1 as number] : prev?.x,
      y: hasY ? [yr0 as number, yr1 as number] : prev?.y,
    };
  };

  const apply = (layout: Partial<Plotly.Layout>): Partial<Plotly.Layout> => {
    if (!enabled) return layout;
    const mem = stored.current;
    if (mem && mem.signature === signature) {
      const out = { ...layout } as Record<string, unknown>;
      if (mem.x) out.xaxis = { ...(layout.xaxis ?? {}), range: [...mem.x], autorange: false };
      if (mem.y) out.yaxis = { ...(layout.yaxis ?? {}), range: [...mem.y], autorange: false };
      injected.current = true;
      return out as Partial<Plotly.Layout>;
    }
    if (injected.current) {
      // the previous build carried injected ranges â€” restore autorange once
      injected.current = false;
      stored.current = null;
      const out = { ...layout } as Record<string, unknown>;
      out.xaxis = { ...(layout.xaxis ?? {}), autorange: true };
      out.yaxis = { ...(layout.yaxis ?? {}), autorange: true };
      return out as Partial<Plotly.Layout>;
    }
    return layout;
  };

  return { onRelayout, apply, armOnPointerDown };
}

export function usePlotSizeSync(plotDivRef: { current: HTMLElement | null }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);

  const sync = () => {
    if (frameRef.current !== null) return; // coalesce bursts into one frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const gd = plotDivRef.current;
      const box = boxRef.current;
      if (!gd || !box || !gd.isConnected) return;
      const target = Math.round(box.clientWidth);
      if (target < 10) return; // hidden/degenerate â€” never resize into 0
      const full = (gd as unknown as { _fullLayout?: { width?: number } })._fullLayout;
      const current = Math.round(full?.width ?? gd.clientWidth);
      if (Math.abs(current - target) <= 1) return; // converged
      try {
        (PlotlyLib as unknown as { Plots: { resize: (gd: HTMLElement) => void } }).Plots.resize(gd);
      } catch {
        // plot may be mid-unmount; ignore
      }
    });
  };

  // Callback ref, NOT a mount-time effect: the plot container only renders
  // once data arrives, so an effect that ran at mount observed nothing and
  // window resizes were never seen. This attaches the ResizeObserver the
  // moment the container element actually appears (and re-attaches after
  // remounts), so window/panel/tab-driven size changes all reach the plot.
  const containerRef = (node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    boxRef.current = node;
    if (node) {
      const observer = new ResizeObserver(() => sync());
      observer.observe(node);
      observerRef.current = observer;
      sync();
    }
  };

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    []
  );

  return { containerRef, sync };
}
