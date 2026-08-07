/**
 * Palette editing: colour parsing, array manipulation, and draft state.
 *
 * The appearance editor lets users build and edit palettes — reorder colours,
 * change values, duplicate, delete. All palette operations are here in pure
 * functions tested independently, so a plot cannot disagree with the editor
 * about which colour is which.
 *
 * Pure by design — no React, no Plotly, no network. Everything here is unit
 * tested in `frontend/tests/paletteDraft.test.ts`.
 */
import type { SeriesStyleOverride } from "./api";

/**
 * Normalise a hex colour string to lowercase `#rrggbb`.
 *
 * Accepts `#rgb`, `#rrggbb`, or the same without the leading `#`, any case,
 * with surrounding whitespace allowed.
 *
 * Returns `null` for anything else: 8-digit colours (with alpha) are rejected
 * rather than silently truncated, because palettes are opaque only — an alpha
 * value in the input flags a UI mistake or paste error that deserves to fail.
 */
export function normalizePaletteColor(value: string): string | null {
  if (typeof value !== "string") return null;

  // Strip surrounding whitespace.
  const trimmed = value.trim();

  // Remove leading `#` if present.
  let hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  // Only hex digits allowed.
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  // Must be 3 or 6 digits; 8-digit colours with alpha are rejected.
  if (hex.length === 3) {
    // Expand 3-digit shorthand: `f0a` -> `ff00aa`.
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  } else if (hex.length !== 6) {
    return null;
  }

  return `#${hex.toLowerCase()}`;
}

/**
 * Move a colour in the palette array.
 *
 * Returns a new array with the item at `from` moved to `to`. If either index
 * is out of range, returns the original array unchanged (same reference, so
 * no array churn for guard clauses).
 */
export function movePaletteColor(colors: string[], from: number, to: number): string[] {
  if (
    from < 0 ||
    from >= colors.length ||
    to < 0 ||
    to >= colors.length ||
    from === to
  ) {
    return colors;
  }

  const next = [...colors];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Duplicate a colour immediately after its index.
 *
 * Returns a new array with a copy of the item at `index` inserted after it.
 * Out-of-range index returns the original array unchanged.
 */
export function duplicatePaletteColor(colors: string[], index: number): string[] {
  if (index < 0 || index >= colors.length) {
    return colors;
  }

  const next = [...colors];
  next.splice(index + 1, 0, colors[index]!);
  return next;
}

/**
 * Remove a colour from the palette array.
 *
 * Returns a new array with the item at `index` removed. A palette must never
 * become empty — if the array has only one colour, returns unchanged. Out-of-range
 * index also returns unchanged.
 */
export function removePaletteColor(colors: string[], index: number): string[] {
  if (index < 0 || index >= colors.length || colors.length <= 1) {
    return colors;
  }

  const next = [...colors];
  next.splice(index, 1);
  return next;
}

/**
 * Reverse a palette array.
 *
 * Returns a new reversed array; the original is not mutated.
 */
export function reversePalette(colors: string[]): string[] {
  return [...colors].reverse();
}

/**
 * Set a colour at a specific index.
 *
 * Normalises the value via `normalizePaletteColor`. If the value is invalid
 * or the index is out of range, returns the original array unchanged.
 * Otherwise returns a new array with the colour replaced and normalised.
 */
export function setPaletteColor(
  colors: string[],
  index: number,
  value: string,
): string[] {
  if (index < 0 || index >= colors.length) {
    return colors;
  }

  const normalized = normalizePaletteColor(value);
  if (normalized === null) {
    return colors;
  }

  const next = [...colors];
  next[index] = normalized;
  return next;
}

/**
 * What a plot saves to know which palette was used and which colours were active.
 *
 * A palette selection can reference a built-in by name (`palette: "viridis"`),
 * a saved custom palette by ID (`palette: "custom", palette_id: "abc123"`),
 * or an in-use colour list that is no longer tied to any preset
 * (`palette: "custom", palette_id: null`).
 */
export interface PaletteSelection {
  palette: string;
  palette_id: string | null;
  palette_colors: string[];
}

/**
 * Select a built-in palette preset.
 *
 * The colours are empty because they are resolved at plot time from the
 * preset's current definition.
 */
export function builtInPaletteSelection(key: string): PaletteSelection {
  return {
    palette: key,
    palette_id: null,
    palette_colors: [],
  };
}

/**
 * Select a previously saved custom palette.
 *
 * Takes a COPY of the colour array so the snapshot keeps the plot reproducible
 * if the saved palette is later renamed, edited, or deleted.
 */
export function savedPaletteSelection(id: string, colors: string[]): PaletteSelection {
  return {
    palette: "custom",
    palette_id: id,
    palette_colors: [...colors],
  };
}

/**
 * Use a custom colour list that is no longer tied to any preset.
 *
 * This state arises after a preset is reversed, hand-edited, or re-ordered:
 * it is no longer that preset. Takes a COPY of the input so the snapshot
 * cannot be mutated later.
 */
export function customPaletteSelection(colors: string[]): PaletteSelection {
  return {
    palette: "custom",
    palette_id: null,
    palette_colors: [...colors],
  };
}

/**
 * Which series have an explicit per-series colour override.
 *
 * Returns the keys (e.g. "c1", "g3") whose override sets a non-null,
 * non-empty `color`. Used to warn that applying a palette will not visibly
 * change those series, because an explicit colour still wins over the palette.
 */
export function seriesWithOwnColour(
  overrides: Record<string, { color?: string | null }> | undefined,
): string[] {
  if (!overrides) return [];

  const out: string[] = [];
  for (const [key, override] of Object.entries(overrides)) {
    if (override.color && typeof override.color === "string" && override.color.length > 0) {
      out.push(key);
    }
  }
  return out;
}

/**
 * Normalise a palette overflow mode, defaulting to "repeat".
 *
 * Returns `"generate"` only for exactly the string `"generate"`. Everything
 * else — undefined, null, empty string, unknown values, any garbage — returns
 * `"repeat"`. This ensures plots saved before this feature existed (which have
 * no overflow mode field, hence undefined) render with the original repeat
 * behaviour by default.
 */
export function paletteOverflowMode(
  value: string | null | undefined,
): "repeat" | "generate" {
  return value === "generate" ? "generate" : "repeat";
}
