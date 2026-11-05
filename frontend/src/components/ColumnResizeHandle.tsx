import { useEffect, useRef, useState } from "react";

export function useColumnWidths<T extends Record<string, number>>(key: string, defaults: T) {
  const [widths, setWidths] = useState<T>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
      return Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name,
        typeof saved[name] === "number" && Number.isFinite(saved[name])
          ? Math.max(48, Math.min(1600, saved[name])) : value])) as T;
    } catch { return { ...defaults }; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(widths)); } catch { /* storage may be disabled */ }
  }, [key, widths]);
  return { widths, resize: (name: keyof T, width: number) => setWidths(current => ({
    ...current, [name]: Math.max(48, Math.min(1600, Math.round(width))),
  })) };
}

/** Pointer capture avoids leaking window listeners when a table unmounts mid-drag. */
export function ColumnResizeHandle({ label, width, onResize }: {
  label: string; width: number; onResize: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number; scale: number } | null>(null);
  return <span role="separator" aria-label={`Resize ${label} column`}
    aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={48} aria-valuemax={1600}
    tabIndex={0}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); event.stopPropagation();
        onResize(width + (event.key === "ArrowRight" ? 16 : -16));
      }
    }}
    onPointerDown={event => {
      event.preventDefault(); event.stopPropagation();
      const parent = event.currentTarget.parentElement!;
      const scale = parent.getBoundingClientRect().width / parent.offsetWidth || 1;
      start.current = { x: event.clientX, width: parent.offsetWidth, scale };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (start.current) onResize(start.current.width + (event.clientX - start.current.x) / start.current.scale);
    }}
    onPointerUp={() => { start.current = null; }}
    onPointerCancel={() => { start.current = null; }}
    onLostPointerCapture={() => { start.current = null; }}
    style={{ position: "absolute", right: -4, top: 0, width: 8, height: "100%",
      cursor: "col-resize", touchAction: "none", zIndex: 3,
      borderRight: "1px solid var(--mantine-color-default-border)" }} />;
}
