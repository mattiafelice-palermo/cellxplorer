import assert from "node:assert/strict";
import test from "node:test";

import {
  builtInPaletteSelection,
  customPaletteSelection,
  duplicatePaletteColor,
  movePaletteColor,
  normalizePaletteColor,
  paletteOverflowMode,
  removePaletteColor,
  reversePalette,
  savedPaletteSelection,
  seriesWithOwnColour,
  setPaletteColor,
  type PaletteSelection,
} from "../src/paletteDraft.ts";

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
