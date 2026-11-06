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
export function ColumnResizeHandle({ label, width, onResize, showDivider = true }: {
  label: string; width: number; onResize: (width: number) => void; showDivider?: boolean;
}) {
  const start = useRef<{ x: number; width: number; scale: number; preview: number; table: HTMLTableElement | null; column: HTMLElement | null; tableWidth: number } | null>(null);
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
      const table = parent.closest("table");
      const index = (parent as HTMLTableCellElement).cellIndex;
      const column = table?.querySelectorAll("col")[index] ?? null;
      start.current = { x: event.clientX, width: parent.offsetWidth, scale,
        preview: parent.offsetWidth, table, column, tableWidth: table?.offsetWidth ?? 0 };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const drag = start.current;
      if (!drag) return;
      drag.preview = Math.max(48, Math.min(1600, Math.round(drag.width + (event.clientX - drag.x) / drag.scale)));
      if (drag.column && drag.table) {
        drag.column.style.width = `${drag.preview}px`;
        drag.table.style.width = `${drag.tableWidth + drag.preview - drag.width}px`;
      } else onResize(drag.preview);
    }}
    onPointerUp={() => { if (start.current) onResize(start.current.preview); start.current = null; }}
    onPointerCancel={() => { if (start.current) onResize(start.current.preview); start.current = null; }}
    onLostPointerCapture={() => { if (start.current) onResize(start.current.preview); start.current = null; }}
    style={{ position: "absolute", right: -4, top: 0, width: 8, height: "100%",
      cursor: "col-resize", touchAction: "none", zIndex: 3,
      borderRight: showDivider ? "1px solid var(--mantine-color-default-border)" : undefined }} />;
}
