/** Crossfade two actual WebGL renderings; never interpolate scientific coordinates. */
export type TimeCapacityRefinementCrossfade = {
  reveal(): void;
  cancel(): void;
};

const MAX_SNAPSHOT_PIXELS = 4 * 1024 * 1024; // At most 16 MiB of RGBA pixels.

function frameGeometry(graph: HTMLElement): string | null {
  const layout = (graph as HTMLElement & {
    _fullLayout?: Record<string, unknown> & { _replotting?: boolean };
  })._fullLayout;
  if (!layout || layout._replotting) return null;
  const axes = Object.keys(layout).filter((key) => /^[xy]axis\d*$/.test(key)).sort();
  if (!axes.length || axes.length > 8) return null;
  return JSON.stringify(axes.map((key) => {
    const axis = layout[key] as Record<string, unknown>;
    return [key, axis.type, axis.range, axis.domain, axis._offset, axis._length];
  }));
}

export function captureTimeCapacityRefinement(
  graph: HTMLElement,
  reducedMotion: boolean,
): TimeCapacityRefinementCrossfade | null {
  if (reducedMotion) return null;
  const geometry = frameGeometry(graph);
  if (geometry === null) return null;
  // Interactive ordinary traces use scattergl. Unsupported/SVG surfaces replace
  // immediately rather than cloning an unbounded SVG tree or forcing a replot.
  // A visibility restyle may be displaying Plot.tsx's held frame while its
  // underlying canvas is cleared; that canvas is not the visible old picture.
  if (graph.querySelector(".scatterlayer .trace, .cellxplorer-gl-frame-hold")) return null;
  const sources = Array.from(graph.querySelectorAll<HTMLCanvasElement>(".gl-canvas-context, .gl-canvas-focus"));
  if (!sources.length || sources.length > 2 || sources.some((source) =>
    !source.parentElement || !source.width || !source.height || typeof source.animate !== "function",
  ) || sources.reduce((pixels, source) => pixels + source.width * source.height, 0) > MAX_SNAPSHOT_PIXELS) return null;

  const snapshots: Array<{ source: HTMLCanvasElement; overlay: HTMLCanvasElement; rect: DOMRect }> = [];
  const animations: Animation[] = [];
  let cancelled = false;
  let revealed = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const animation of animations) animation.cancel();
    for (const { overlay } of snapshots) {
      overlay.remove();
      overlay.width = overlay.height = 0;
    }
  };
  try {
    for (const source of sources) {
      const overlay = document.createElement("canvas");
      overlay.width = source.width;
      overlay.height = source.height;
      snapshots.push({ source, overlay, rect: source.getBoundingClientRect() });
      const context = overlay.getContext("2d");
      if (!context) { cancel(); return null; }
      // Plotly scattergl preserves its drawing buffer. Copy the already-drawn
      // viewport once; do not regenerate old traces or read sample arrays.
      context.drawImage(source, 0, 0);
      overlay.className = "cellxplorer-refinement-frame";
      overlay.style.cssText = source.style.cssText;
      overlay.style.pointerEvents = "none";
      overlay.setAttribute("aria-hidden", "true");
    }
  } catch {
    cancel();
    return null;
  }
  return {
    cancel,
    reveal() {
      if (cancelled || revealed) return;
      revealed = true;
      // A resized/remounted surface must never receive a misplaced old frame.
      if (frameGeometry(graph) !== geometry || graph.querySelector(".cellxplorer-gl-frame-hold") || snapshots.some(({ source, overlay, rect }) => {
        const next = source.getBoundingClientRect();
        return !graph.contains(source) || !source.parentElement ||
          source.width !== overlay.width || source.height !== overlay.height ||
          next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height;
      })) { cancel(); return; }
      try {
        for (const { source, overlay } of snapshots) {
          source.parentElement!.appendChild(overlay);
          const options = { duration: 220, easing: "ease-out" };
          animations.push(source.animate([{ opacity: 0 }, { opacity: 1 }], options));
          animations.push(overlay.animate([{ opacity: 1 }, { opacity: 0 }], options));
        }
        // One composited dissolve, with immediate cleanup on completion/abort.
        void Promise.all(animations.map((animation) => animation.finished)).then(cancel, cancel);
      } catch {
        cancel();
      }
    },
  };
}
