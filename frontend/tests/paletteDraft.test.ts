import assert from "node:assert/strict";
import test from "node:test";

import {
  builtInPaletteSelection,
  customPaletteSelection,
  duplicatePaletteColor,
  extendPalette,
  hexToHsl,
  hslToHex,
  movePaletteColor,
  normalizePaletteColor,
  paletteColorAt,
  paletteOverflowMode,
  removePaletteColor,
  reversePalette,
  savedPaletteSelection,
  seriesWithOwnColour,
  setPaletteColor,
  type PaletteSelection,
} from "../src/features/analyses/editor/plotting/paletteDraft.ts";

// --- normalizePaletteColor ------------------------------------------------

test("normalizePaletteColor accepts 6-digit hex with #", () => {
  assert.equal(normalizePaletteColor("#ff0000"), "#ff0000");
  assert.equal(normalizePaletteColor("#FF0000"), "#ff0000");
  assert.equal(normalizePaletteColor("#AbCdEf"), "#abcdef");
});

test("normalizePaletteColor expands 3-digit shorthand", () => {
  assert.equal(normalizePaletteColor("#f0a"), "#ff00aa");
  assert.equal(normalizePaletteColor("#F0A"), "#ff00aa");
  assert.equal(normalizePaletteColor("#123"), "#112233");
  assert.equal(normalizePaletteColor("#fff"), "#ffffff");
  assert.equal(normalizePaletteColor("#000"), "#000000");
});

test("normalizePaletteColor accepts hex without leading #", () => {
  assert.equal(normalizePaletteColor("ff0000"), "#ff0000");
  assert.equal(normalizePaletteColor("F0A"), "#ff00aa");
  assert.equal(normalizePaletteColor("ABCDEF"), "#abcdef");
});

test("normalizePaletteColor strips surrounding whitespace", () => {
  assert.equal(normalizePaletteColor("  #ff0000  "), "#ff0000");
  assert.equal(normalizePaletteColor("\t#f0a\n"), "#ff00aa");
  assert.equal(normalizePaletteColor(" ff0000 "), "#ff0000");
});

test("normalizePaletteColor rejects 8-digit colours with alpha", () => {
  assert.equal(normalizePaletteColor("#ff0000ff"), null);
  assert.equal(normalizePaletteColor("ff0000aa"), null);
  assert.equal(normalizePaletteColor("#FF0000FF"), null);
});

test("normalizePaletteColor rejects invalid input", () => {
  assert.equal(normalizePaletteColor(""), null);
  assert.equal(normalizePaletteColor("red"), null);
  assert.equal(normalizePaletteColor("#gggggg"), null);
  assert.equal(normalizePaletteColor("#ff00"), null);
  assert.equal(normalizePaletteColor("not-a-colour"), null);
  assert.equal(normalizePaletteColor("#"), null);
  assert.equal(normalizePaletteColor("##ff0000"), null);
});

// --- movePaletteColor -------------------------------------------------------

test("movePaletteColor moves a colour forward", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const result = movePaletteColor(colors, 0, 2);
  assert.deepEqual(result, ["#ff0000", "#00ff00", "#000000"]);
});

test("movePaletteColor moves a colour backward", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const result = movePaletteColor(colors, 2, 0);
  assert.deepEqual(result, ["#00ff00", "#000000", "#ff0000"]);
});

test("movePaletteColor returns unchanged when from is out of range", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(movePaletteColor(colors, -1, 0), colors);
  assert.equal(movePaletteColor(colors, 2, 0), colors);
});

test("movePaletteColor returns unchanged when to is out of range", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(movePaletteColor(colors, 0, -1), colors);
  assert.equal(movePaletteColor(colors, 0, 2), colors);
});

test("movePaletteColor returns unchanged when from equals to", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(movePaletteColor(colors, 0, 0), colors);
  assert.equal(movePaletteColor(colors, 1, 1), colors);
});

test("movePaletteColor does not mutate the original array", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const original = [...colors];
  movePaletteColor(colors, 0, 2);
  assert.deepEqual(colors, original);
});

// --- duplicatePaletteColor --------------------------------------------------

test("duplicatePaletteColor inserts a copy immediately after the index", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const result = duplicatePaletteColor(colors, 1);
  assert.deepEqual(result, ["#000000", "#ff0000", "#ff0000", "#00ff00"]);
});

test("duplicatePaletteColor duplicates at the start", () => {
  const colors = ["#000000", "#ff0000"];
  const result = duplicatePaletteColor(colors, 0);
  assert.deepEqual(result, ["#000000", "#000000", "#ff0000"]);
});

test("duplicatePaletteColor duplicates at the end", () => {
  const colors = ["#000000", "#ff0000"];
  const result = duplicatePaletteColor(colors, 1);
  assert.deepEqual(result, ["#000000", "#ff0000", "#ff0000"]);
});

test("duplicatePaletteColor increases the array length by one", () => {
  const colors = ["#000000"];
  const result = duplicatePaletteColor(colors, 0);
  assert.equal(result.length, 2);
});

test("duplicatePaletteColor returns unchanged when index is out of range", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(duplicatePaletteColor(colors, -1), colors);
  assert.equal(duplicatePaletteColor(colors, 2), colors);
});

test("duplicatePaletteColor does not mutate the original", () => {
  const colors = ["#000000", "#ff0000"];
  const original = [...colors];
  duplicatePaletteColor(colors, 0);
  assert.deepEqual(colors, original);
});

// --- removePaletteColor -----------------------------------------------------

test("removePaletteColor removes the colour at the index", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const result = removePaletteColor(colors, 1);
  assert.deepEqual(result, ["#000000", "#00ff00"]);
});

test("removePaletteColor removes from the start", () => {
  const colors = ["#000000", "#ff0000"];
  const result = removePaletteColor(colors, 0);
  assert.deepEqual(result, ["#ff0000"]);
});

test("removePaletteColor removes from the end", () => {
  const colors = ["#000000", "#ff0000"];
  const result = removePaletteColor(colors, 1);
  assert.deepEqual(result, ["#000000"]);
});

test("removePaletteColor returns unchanged when the array has only one colour", () => {
  const colors = ["#000000"];
  assert.equal(removePaletteColor(colors, 0), colors);
});

test("removePaletteColor returns unchanged when index is out of range", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(removePaletteColor(colors, -1), colors);
  assert.equal(removePaletteColor(colors, 2), colors);
});

test("removePaletteColor does not mutate the original", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const original = [...colors];
  removePaletteColor(colors, 1);
  assert.deepEqual(colors, original);
});

// --- reversePalette ---------------------------------------------------------

test("reversePalette reverses the array order", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const result = reversePalette(colors);
  assert.deepEqual(result, ["#00ff00", "#ff0000", "#000000"]);
});

test("reversePalette works with a single colour", () => {
  const colors = ["#000000"];
  const result = reversePalette(colors);
  assert.deepEqual(result, ["#000000"]);
});

test("reversePalette works with an empty array", () => {
  const colors: string[] = [];
  const result = reversePalette(colors);
  assert.deepEqual(result, []);
});

test("reversePalette does not mutate the original", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const original = [...colors];
  reversePalette(colors);
  assert.deepEqual(colors, original);
});

// --- setPaletteColor -------------------------------------------------------

test("setPaletteColor replaces and normalises a valid colour", () => {
  const colors = ["#000000", "#ff0000", "#00ff00"];
  const result = setPaletteColor(colors, 1, "#ABC");
  assert.deepEqual(result, ["#000000", "#aabbcc", "#00ff00"]);
});

test("setPaletteColor normalises case", () => {
  const colors = ["#000000"];
  const result = setPaletteColor(colors, 0, "FF0000");
  assert.deepEqual(result, ["#ff0000"]);
});

test("setPaletteColor normalises 3-digit to 6-digit", () => {
  const colors = ["#000000"];
  const result = setPaletteColor(colors, 0, "#f0a");
  assert.deepEqual(result, ["#ff00aa"]);
});

test("setPaletteColor returns unchanged when value is invalid", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(setPaletteColor(colors, 0, "not-a-colour"), colors);
  assert.equal(setPaletteColor(colors, 1, "#gggggg"), colors);
  assert.equal(setPaletteColor(colors, 0, "#ff0000ff"), colors);
});

test("setPaletteColor returns unchanged when index is out of range", () => {
  const colors = ["#000000", "#ff0000"];
  assert.equal(setPaletteColor(colors, -1, "#00ff00"), colors);
  assert.equal(setPaletteColor(colors, 2, "#00ff00"), colors);
});

test("setPaletteColor does not mutate the original", () => {
  const colors = ["#000000", "#ff0000"];
  const original = [...colors];
  setPaletteColor(colors, 0, "#00ff00");
  assert.deepEqual(colors, original);
});

// --- Palette Selection builders -----------------------------------------------

test("builtInPaletteSelection returns the correct structure", () => {
  const result = builtInPaletteSelection("viridis");
  assert.equal(result.palette, "viridis");
  assert.equal(result.palette_id, null);
  assert.deepEqual(result.palette_colors, []);
});

test("savedPaletteSelection returns the correct structure", () => {
  const colors = ["#ff0000", "#00ff00", "#0000ff"];
  const result = savedPaletteSelection("abc123", colors);
  assert.equal(result.palette, "custom");
  assert.equal(result.palette_id, "abc123");
  assert.deepEqual(result.palette_colors, colors);
});

test("savedPaletteSelection copies the colours array", () => {
  const colors = ["#ff0000", "#00ff00"];
  const result = savedPaletteSelection("id1", colors);
  // Mutate the original.
  colors[0] = "#0000ff";
  colors.push("#ffff00");
  // The snapshot should be unchanged.
  assert.deepEqual(result.palette_colors, ["#ff0000", "#00ff00"]);
});

test("customPaletteSelection returns the correct structure", () => {
  const colors = ["#ff0000", "#00ff00"];
  const result = customPaletteSelection(colors);
  assert.equal(result.palette, "custom");
  assert.equal(result.palette_id, null);
  assert.deepEqual(result.palette_colors, colors);
});

test("customPaletteSelection copies the colours array", () => {
  const colors = ["#ff0000", "#00ff00"];
  const result = customPaletteSelection(colors);
  // Mutate the original.
  colors[0] = "#0000ff";
  colors.push("#ffff00");
  // The snapshot should be unchanged.
  assert.deepEqual(result.palette_colors, ["#ff0000", "#00ff00"]);
});

test("palette selection builders produce PaletteSelection shapes", () => {
  const built: PaletteSelection = builtInPaletteSelection("plasma");
  assert.ok("palette" in built);
  assert.ok("palette_id" in built);
  assert.ok("palette_colors" in built);

  const saved: PaletteSelection = savedPaletteSelection("id2", ["#123456"]);
  assert.ok("palette" in saved);
  assert.ok("palette_id" in saved);
  assert.ok("palette_colors" in saved);

  const custom: PaletteSelection = customPaletteSelection(["#654321"]);
  assert.ok("palette" in custom);
  assert.ok("palette_id" in custom);
  assert.ok("palette_colors" in custom);
});

// --- seriesWithOwnColour ---------------------------------------------------

test("seriesWithOwnColour returns keys with non-null, non-empty colours", () => {
  const overrides = {
    c1: { color: "#ff0000" },
    c2: { color: "#00ff00", line_width: 2 },
    c3: { line_width: 3 },
  };
  const result = seriesWithOwnColour(overrides);
  assert.deepEqual(result.sort(), ["c1", "c2"]);
});

test("seriesWithOwnColour ignores null colours", () => {
  const overrides = {
    c1: { color: "#ff0000" },
    c2: { color: null },
  };
  const result = seriesWithOwnColour(overrides);
  assert.deepEqual(result, ["c1"]);
});

test("seriesWithOwnColour ignores empty string colours", () => {
  const overrides = {
    c1: { color: "#ff0000" },
    c2: { color: "" },
  };
  const result = seriesWithOwnColour(overrides);
  assert.deepEqual(result, ["c1"]);
});

test("seriesWithOwnColour ignores undefined colours", () => {
  const overrides = {
    c1: { color: "#ff0000" },
    c2: { color: undefined },
    c3: {},
  };
  const result = seriesWithOwnColour(overrides);
  assert.deepEqual(result, ["c1"]);
});

test("seriesWithOwnColour returns empty array when overrides is undefined", () => {
  const result = seriesWithOwnColour(undefined);
  assert.deepEqual(result, []);
});

test("seriesWithOwnColour returns empty array when no colours are set", () => {
  const overrides = {
    c1: { line_width: 2 },
    c2: { color: null },
  };
  const result = seriesWithOwnColour(overrides);
  assert.deepEqual(result, []);
});

// --- paletteOverflowMode ---------------------------------------------------

test("paletteOverflowMode returns 'generate' for the string 'generate'", () => {
  assert.equal(paletteOverflowMode("generate"), "generate");
});

test("paletteOverflowMode returns 'repeat' for 'repeat'", () => {
  assert.equal(paletteOverflowMode("repeat"), "repeat");
});

test("paletteOverflowMode returns 'repeat' for undefined", () => {
  assert.equal(paletteOverflowMode(undefined), "repeat");
});

test("paletteOverflowMode returns 'repeat' for null", () => {
  assert.equal(paletteOverflowMode(null), "repeat");
});

test("paletteOverflowMode returns 'repeat' for empty string", () => {
  assert.equal(paletteOverflowMode(""), "repeat");
});

test("paletteOverflowMode returns 'repeat' for unknown values", () => {
  assert.equal(paletteOverflowMode("unknown"), "repeat");
  assert.equal(paletteOverflowMode("GENERATE"), "repeat");
  assert.equal(paletteOverflowMode("nonsense"), "repeat");
});

// --- hexToHsl / hslToHex ---------------------------------------------------

test("hexToHsl parses a valid 6-digit hex colour", () => {
  const result = hexToHsl("#ff0000");
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.h - 0) < 1); // Red hue near 0
  assert.ok(Math.abs(result!.s - 1) < 0.01);
  assert.ok(Math.abs(result!.l - 0.5) < 0.01);
});

test("hexToHsl parses green", () => {
  const result = hexToHsl("#00ff00");
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.h - 120) < 1); // Green hue near 120
  assert.ok(Math.abs(result!.s - 1) < 0.01);
  assert.ok(Math.abs(result!.l - 0.5) < 0.01);
});

test("hexToHsl parses blue", () => {
  const result = hexToHsl("#0000ff");
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.h - 240) < 1); // Blue hue near 240
  assert.ok(Math.abs(result!.s - 1) < 0.01);
  assert.ok(Math.abs(result!.l - 0.5) < 0.01);
});

test("hexToHsl parses grey (achromatic)", () => {
  const result = hexToHsl("#808080");
  assert.ok(result !== null);
  assert.equal(result!.s, 0); // No saturation for grey
  assert.ok(Math.abs(result!.l - 0.5) < 0.01);
});

test("hexToHsl parses black", () => {
  const result = hexToHsl("#000000");
  assert.ok(result !== null);
  assert.equal(result!.s, 0);
  assert.equal(result!.l, 0);
});

test("hexToHsl parses white", () => {
  const result = hexToHsl("#ffffff");
  assert.ok(result !== null);
  assert.equal(result!.s, 0);
  assert.equal(result!.l, 1);
});

test("hexToHsl returns null for invalid input", () => {
  assert.equal(hexToHsl("not-a-colour"), null);
  assert.equal(hexToHsl("#gggggg"), null);
  assert.equal(hexToHsl(""), null);
});

test("hslToHex converts HSL back to hex lowercase", () => {
  const hex = hslToHex(0, 1, 0.5);
  assert.equal(hex, "#ff0000");
});

test("hslToHex handles hue wrapping modulo 360", () => {
  const hex1 = hslToHex(0, 1, 0.5);
  const hex2 = hslToHex(360, 1, 0.5);
  const hex3 = hslToHex(-360, 1, 0.5);
  assert.equal(hex1, hex2);
  assert.equal(hex2, hex3);
});

test("hslToHex clamps saturation and lightness", () => {
  // Saturation > 1 should clamp to 1.
  const hex1 = hslToHex(0, 2, 0.5);
  assert.equal(hex1, "#ff0000"); // Full saturation red
  // Lightness > 1 should clamp to 1.
  const hex2 = hslToHex(0, 1, 2);
  assert.equal(hex2, "#ffffff"); // Clamped to white
  // Negative values should clamp to 0.
  const hex3 = hslToHex(0, -1, 0.5);
  assert.equal(hex3, "#808080"); // Desaturated = grey
});

test("hexToHsl and hslToHex round-trip", () => {
  const original = "#e74c3c";
  const hsl = hexToHsl(original);
  assert.ok(hsl !== null);
  const roundTrip = hslToHex(hsl!.h, hsl!.s, hsl!.l);
  // Allow 1/255 tolerance per channel due to rounding.
  const origRgb = {
    r: parseInt(original.slice(1, 3), 16),
    g: parseInt(original.slice(3, 5), 16),
    b: parseInt(original.slice(5, 7), 16),
  };
  const rtRgb = {
    r: parseInt(roundTrip.slice(1, 3), 16),
    g: parseInt(roundTrip.slice(3, 5), 16),
    b: parseInt(roundTrip.slice(5, 7), 16),
  };
  assert.ok(Math.abs(origRgb.r - rtRgb.r) <= 1);
  assert.ok(Math.abs(origRgb.g - rtRgb.g) <= 1);
  assert.ok(Math.abs(origRgb.b - rtRgb.b) <= 1);
});

test("hexToHsl and hslToHex round-trip for multiple colours", () => {
  const colours = ["#ff0000", "#00ff00", "#0000ff", "#123456", "#abcdef"];
  for (const colour of colours) {
    const hsl = hexToHsl(colour);
    assert.ok(hsl !== null);
    const roundTrip = hslToHex(hsl!.h, hsl!.s, hsl!.l);
    const origRgb = {
      r: parseInt(colour.slice(1, 3), 16),
      g: parseInt(colour.slice(3, 5), 16),
      b: parseInt(colour.slice(5, 7), 16),
    };
    const rtRgb = {
      r: parseInt(roundTrip.slice(1, 3), 16),
      g: parseInt(roundTrip.slice(3, 5), 16),
      b: parseInt(roundTrip.slice(5, 7), 16),
    };
    assert.ok(Math.abs(origRgb.r - rtRgb.r) <= 1);
    assert.ok(Math.abs(origRgb.g - rtRgb.g) <= 1);
    assert.ok(Math.abs(origRgb.b - rtRgb.b) <= 1);
  }
});

// --- extendPalette ----------------------------------------------------------

test("extendPalette with count < length returns a slice", () => {
  const colours = ["#ff0000", "#00ff00", "#0000ff"];
  const result = extendPalette(colours, 2);
  assert.deepEqual(result, ["#ff0000", "#00ff00"]);
});

test("extendPalette with count == length returns the originals", () => {
  const colours = ["#ff0000", "#00ff00", "#0000ff"];
  const result = extendPalette(colours, 3);
  assert.deepEqual(result, colours);
});

test("extendPalette with count > length preserves originals as prefix", () => {
  const colours = ["#ff0000", "#00ff00"];
  const result = extendPalette(colours, 4);
  // First two must be exactly the originals.
  assert.equal(result[0], "#ff0000");
  assert.equal(result[1], "#00ff00");
  // Total length must be exactly 4.
  assert.equal(result.length, 4);
});

test("extendPalette returns exactly count colours", () => {
  const colours = ["#ff0000", "#00ff00"];
  for (const count of [1, 2, 5, 10]) {
    const result = extendPalette(colours, count);
    assert.equal(result.length, count);
  }
});

test("extendPalette with empty input returns empty array", () => {
  const result = extendPalette([], 5);
  assert.deepEqual(result, []);
});

test("extendPalette is deterministic", () => {
  const colours = ["#ff0000", "#00ff00", "#0000ff"];
  const result1 = extendPalette(colours, 10);
  const result2 = extendPalette(colours, 10);
  assert.deepEqual(result1, result2);
});

test("extendPalette generated colours are valid hex", () => {
  const colours = ["#ff0000"];
  const result = extendPalette(colours, 5);
  for (const colour of result) {
    assert.match(colour, /^#[0-9a-f]{6}$/);
  }
});

test("extendPalette first generated colour differs from all originals", () => {
  const colours = ["#ff0000", "#00ff00", "#0000ff"];
  const result = extendPalette(colours, 4);
  const generated = result[3]; // First generated colour
  assert.ok(!colours.includes(generated));
});

test("extendPalette with all-invalid input does not throw", () => {
  const invalid = ["not-a-colour", "#gggggg", ""];
  const result = extendPalette(invalid, 3);
  assert.equal(result.length, 3);
});

test("extendPalette with partial invalid input skips them", () => {
  const colours = ["#ff0000", "not-a-colour", "#0000ff"];
  const result = extendPalette(colours, 6);
  // First three are originals (including the invalid one, which stays as-is).
  assert.equal(result[0], "#ff0000");
  assert.equal(result[1], "not-a-colour");
  assert.equal(result[2], "#0000ff");
  // Remaining three are generated from the two valid colours.
  assert.equal(result.length, 6);
  // Generated colours should be valid hex.
  assert.match(result[3], /^#[0-9a-f]{6}$/);
  assert.match(result[4], /^#[0-9a-f]{6}$/);
  assert.match(result[5], /^#[0-9a-f]{6}$/);
});

// --- paletteColorAt ---------------------------------------------------------

test("paletteColorAt with repeat mode wraps like modulo", () => {
  const colours = ["#ff0000", "#00ff00", "#0000ff"];
  assert.equal(paletteColorAt(colours, 0, "repeat"), "#ff0000");
  assert.equal(paletteColorAt(colours, 1, "repeat"), "#00ff00");
  assert.equal(paletteColorAt(colours, 2, "repeat"), "#0000ff");
  assert.equal(paletteColorAt(colours, 3, "repeat"), "#ff0000"); // Wraps
  assert.equal(paletteColorAt(colours, 4, "repeat"), "#00ff00");
  assert.equal(paletteColorAt(colours, 5, "repeat"), "#0000ff");
});

test("paletteColorAt with generate mode matches extendPalette", () => {
  const colours = ["#ff0000", "#00ff00"];
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const result = paletteColorAt(colours, index, "generate");
    const extended = extendPalette(colours, index + 1);
    assert.equal(result, extended[index]);
  }
});

test("paletteColorAt with empty palette returns black", () => {
  const empty: string[] = [];
  assert.equal(paletteColorAt(empty, 0, "repeat"), "#000000");
  assert.equal(paletteColorAt(empty, 5, "generate"), "#000000");
});

test("paletteColorAt with single colour repeats in repeat mode", () => {
  const colours = ["#ff0000"];
  assert.equal(paletteColorAt(colours, 0, "repeat"), "#ff0000");
  assert.equal(paletteColorAt(colours, 1, "repeat"), "#ff0000");
  assert.equal(paletteColorAt(colours, 100, "repeat"), "#ff0000");
});
