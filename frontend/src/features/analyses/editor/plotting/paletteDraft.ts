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
import type { SeriesStyleOverride } from "../../../../api";

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

/**
 * Convert a hex colour to HSL.
 *
 * Parses the input via `normalizePaletteColor` and returns hue in [0,360),
 * saturation and lightness in [0,1]. Returns `null` for invalid input.
 *
 * The conversion is deterministic and round-trips to hex via `hslToHex` within
 * floating-point precision (tolerant of ~1/255 per channel due to integer RGB).
 */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const normalized = normalizePaletteColor(hex);
  if (normalized === null) return null;

  // Extract RGB from #rrggbb.
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    // Achromatic (grey): no hue or saturation.
    return { h: 0, s: 0, l };
  }

  // Saturation.
  const s = l < 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min);

  // Hue.
  let h: number;
  const c = max - min;
  if (max === r) {
    h = (g - b) / c + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / c + 2;
  } else {
    h = (r - g) / c + 4;
  }
  h = (h / 6) * 360;

  return { h, s, l };
}

/**
 * Convert HSL to a hex colour.
 *
 * Takes hue in any range (wraps modulo 360), saturation and lightness clamped
 * to [0,1]. Always returns lowercase `#rrggbb`.
 *
 * The inverse of `hexToHsl`. Deterministic and tolerant of floating-point
 * rounding due to integer RGB quantisation.
 */
export function hslToHex(h: number, s: number, l: number): string {
  // Normalise hue to [0, 360).
  h = ((h % 360) + 360) % 360;
  // Clamp saturation and lightness to [0, 1].
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r: number;
  let g: number;
  let b: number;

  if (h < 60) {
    [r, g, b] = [c, x, 0];
  } else if (h < 120) {
    [r, g, b] = [x, c, 0];
  } else if (h < 180) {
    [r, g, b] = [0, c, x];
  } else if (h < 240) {
    [r, g, b] = [0, x, c];
  } else if (h < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }

  // Convert to 0–255 and round to nearest integer.
  const rr = Math.round((r + m) * 255);
  const gg = Math.round((g + m) * 255);
  const bb = Math.round((b + m) * 255);

  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

/**
 * Extend a palette to a target length by generating new distinct colours.
 *
 * If `count <= colors.length`, returns the first `count` colours (a slice).
 * Otherwise returns an array of exactly `count` colours whose first
 * `colors.length` entries are the originals, unchanged and in order.
 *
 * Generated colours are produced deterministically by rotating hue from the
 * original palette. Each colour cycles through a source from the originals,
 * and the hue is rotated by the golden angle (137.508 degrees) per cycle.
 * The golden angle spreads hues evenly across the colour wheel without ever
 * revisiting a previous hue, which is what keeps generated colours
 * distinguishable from one another.
 *
 * For generated index `k` (0-based, i.e. overall index `colors.length + k`):
 *   source = colors[k % colors.length]  (converted to HSL)
 *   h = (source.h + 137.508 * (Math.floor(k / colors.length) + 1)) % 360
 *   s = source.s
 *   l = source.l
 *
 * If `colors` is empty, returns an empty array regardless of `count`.
 *
 * If any colour fails to parse, it is skipped when picking sources. If NONE
 * parse, falls back to repeating the input cyclically, so the function never
 * throws.
 *
 * Always a pure function: calling twice with identical arguments returns
 * deeply equal arrays.
 */
export function extendPalette(colors: string[], count: number): string[] {
  // Empty input always returns empty output.
  if (colors.length === 0) {
    return [];
  }

  // If count <= length, return a slice.
  if (count <= colors.length) {
    return colors.slice(0, count);
  }

  // Try to parse all colours to HSL once. Track which ones are valid.
  const parsed: Array<{ h: number; s: number; l: number } | null> = colors.map((hex) =>
    hexToHsl(hex),
  );

  // Find valid sources (colours that parsed successfully).
  const validIndices: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i] !== null) {
      validIndices.push(i);
    }
  }

  // If no colours parsed, fall back to repeating the input cyclically.
  if (validIndices.length === 0) {
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      result.push(colors[i % colors.length]!);
    }
    return result;
  }

  // Build the result: originals first, then generated.
  const result = [...colors];

  const GOLDEN_ANGLE = 137.508;

  for (let i = colors.length; i < count; i++) {
    // How many complete cycles through the valid sources have we done?
    const k = i - colors.length;
    const cycle = Math.floor(k / validIndices.length);
    const sourceIdx = validIndices[k % validIndices.length]!;
    const source = parsed[sourceIdx]!;

    // Rotate hue by the golden angle per cycle.
    const newH = (source.h + GOLDEN_ANGLE * (cycle + 1)) % 360;

    // Generate the colour.
    const generated = hslToHex(newH, source.s, source.l);
    result.push(generated);
  }

  return result;
}

/**
 * Get the colour at an index from a palette, using either repeat or generate
 * overflow mode.
 *
 * In `"repeat"` mode, wraps around: `colors[index % colors.length]`.
 *
 * In `"generate"` mode, extends the palette to `index + 1` colours and returns
 * the colour at that index, so colours beyond the original length are generated
 * deterministically rather than repeating.
 *
 * If `colors` is empty, returns `"#000000"` (black) rather than throwing,
 * acting as a fallback for plots with no palette defined.
 */
export function paletteColorAt(
  colors: string[],
  index: number,
  mode: "repeat" | "generate",
): string {
  if (colors.length === 0) {
    return "#000000";
  }

  if (mode === "repeat") {
    return colors[index % colors.length]!;
  }

  // mode === "generate"
  const extended = extendPalette(colors, index + 1);
  return extended[index]!;
}
