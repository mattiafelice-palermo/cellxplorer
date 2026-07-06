export interface DebugEvent {
  time: string;
  kind: string;
  data: unknown;
}

declare global {
  interface Window {
    __cellxplorerDebug?: DebugEvent[];
  }
}

export function addDebugEvent(kind: string, data: unknown) {
  if (typeof window === "undefined") return;
  const events = window.__cellxplorerDebug ?? [];
  events.push({ time: new Date().toISOString(), kind, data });
  window.__cellxplorerDebug = events.slice(-80);
}

export function getDebugEvents(): DebugEvent[] {
  if (typeof window === "undefined") return [];
  return window.__cellxplorerDebug ?? [];
}

export function describeRequestBody(body: BodyInit | null | undefined) {
  if (body instanceof FormData) {
    return {
      type: "FormData",
      fields: Array.from(body.entries()).map(([key, value]) =>
        value instanceof File
          ? { key, file: value.name, size: value.size, type: value.type || null }
          : { key, value: String(value) }
      ),
    };
  }
  if (typeof body === "string") return { type: "string", length: body.length };
  if (body == null) return null;
  return { type: Object.prototype.toString.call(body) };
}
