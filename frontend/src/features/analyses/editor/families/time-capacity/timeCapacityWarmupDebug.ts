// Temporary Spec 057 diagnostics. No server writes, persisted state, or result arrays.
export interface WarmupDebug {
  active: boolean;
  state: "Waiting" | "Running" | "Paused" | "Complete" | "Error";
  reason: string;
  analysisId: number | null;
  plot: string;
  completed: number;
  total: number;
  hits: number;
  misses: number;
  request: string;
  lastMs: number | null;
  inFlight: boolean;
  running: number;
}
export const EMPTY_WARMUP_DEBUG: WarmupDebug = {
  active: false, state: "Waiting", reason: "Open a Time/Capacity plot to start warming.",
  analysisId: null, plot: "", completed: 0, total: 0, hits: 0, misses: 0,
  request: "—", lastMs: null, inFlight: false, running: 0,
};
const owners = new Map<symbol, WarmupDebug>();
const listeners = new Set<() => void>();
let snapshot = EMPTY_WARMUP_DEBUG;
function refresh() {
  const values = [...owners.values()];
  const next = values.find(value => value.active) ??
    values.find(value => value.inFlight) ?? EMPTY_WARMUP_DEBUG;
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  listeners.forEach(listener => listener());
}
export function publishWarmupDebug(owner: symbol, value: WarmupDebug) {
  owners.set(owner, value);
  refresh();
}
export function removeWarmupDebug(owner: symbol) { owners.delete(owner); refresh(); }
export function readWarmupDebug() { return snapshot; }
export function subscribeWarmupDebug(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
