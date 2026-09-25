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
  skipped: number;
  request: string;
  lastMs: number | null;
  inFlight: boolean;
  running: number;
}
export const EMPTY_WARMUP_DEBUG: WarmupDebug = {
  active: false, state: "Waiting", reason: "Open a Time/Capacity plot to start warming.",
  analysisId: null, plot: "", completed: 0, total: 0, hits: 0, misses: 0, skipped: 0,
  request: "—", lastMs: null, inFlight: false, running: 0,
};
const WARMUP_INDICATOR_SETTING = "cellxplorer.debug.timeCapacityWarmupIndicator";
export const WARMUP_INDICATOR_CHANGE_EVENT = "cellxplorer:time-capacity-warmup-indicator";
export function readWarmupIndicatorEnabled(): boolean {
  try { return window.localStorage.getItem(WARMUP_INDICATOR_SETTING) === "true"; }
  catch { return false; }
}
export function setWarmupIndicatorEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(WARMUP_INDICATOR_SETTING, String(enabled)); }
  catch { /* Debug preference is optional when storage is unavailable. */ }
  window.dispatchEvent(new Event(WARMUP_INDICATOR_CHANGE_EVENT));
}
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
