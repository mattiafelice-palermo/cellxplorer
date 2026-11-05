/** Preserve original physical record references in exploratory diagnostics. */
export function mprWarningExample(example: Record<string, number | string | boolean | null>): string | null {
  const record = typeof example.record_index === "number" ? `Original record ${example.record_index}` : null;
  const reason = typeof example.reason === "string" ? example.reason : null;
  return record && reason ? `${record}: ${reason}` : record ? `${record}.` : reason;
}
