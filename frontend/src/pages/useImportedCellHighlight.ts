import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  importedCellHighlightKey, importRevealTarget, type ImportedCellHighlight,
} from "../importedCellHighlight";

export function useImportedCellHighlight(
  rows: readonly { cell: { id: number } }[], page: number, size: number, setPage: (page: number) => void,
) {
  const body = useRef<HTMLTableSectionElement>(null);
  const qc = useQueryClient();
  const { data: batch } = useQuery<ImportedCellHighlight | null>({
    queryKey: importedCellHighlightKey, queryFn: () => null, enabled: false,
  });
  useEffect(() => {
    if (!batch) return;
    const clear = () => qc.setQueryData(importedCellHighlightKey, null);
    const remaining = batch.expiresAt - Date.now();
    if (remaining <= 0) { clear(); return; }
    const timer = window.setTimeout(clear, remaining);
    return () => window.clearTimeout(timer);
  }, [qc, batch]);

  useEffect(() => {
    if (!batch || batch.expiresAt <= Date.now() || !body.current) return;
    const target = batch.reveal.length ? importRevealTarget(rows, batch.reveal, page, size) : null;
    if (target && target.page !== page) { setPage(target.page); return; }
    if (target) {
      body.current.querySelector(`[data-cell-row-id="${target.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      qc.setQueryData(importedCellHighlightKey, { ...batch, reveal: [] });
    }

    const pending = new Set(batch.pending);
    const observer = new IntersectionObserver(entries => {
      const seen = new Set<number>();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const row = entry.target as HTMLTableRowElement;
        row.dataset.importHighlight = "true";
        seen.add(Number(row.dataset.cellRowId));
        observer.unobserve(row);
      }
      if (seen.size) qc.setQueryData<ImportedCellHighlight | null>(importedCellHighlightKey, current => {
        if (!current) return current;
        const pending = current.pending.filter(id => !seen.has(id));
        return pending.length ? { ...current, pending } : null;
      });
    });
    for (const row of body.current.rows) {
      if (pending.has(Number(row.dataset.cellRowId))) observer.observe(row);
    }
    return () => observer.disconnect();
  }, [batch, rows, page, size, setPage, qc]);
  return body;
}
