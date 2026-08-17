/** Resolve the CJS/ESM interop shape used by react-plotly.js/factory. */
export function resolvePlotlyFactory<T>(module: T | { default: T }): T {
  return typeof module === "function"
    ? (module as T)
    : (module as { default: T }).default;
}
