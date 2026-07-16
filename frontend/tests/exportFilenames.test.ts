import assert from "node:assert/strict";
import test from "node:test";

import {
  insertFilenameToken,
  renderExportFilename,
  sanitizeExportFilename,
} from "../src/exportFilenames.ts";

test("filename templates mix tokens and ordinary text", () => {
  const value = renderExportFilename("{analysis} - {plot_title} final", {
    analysis: "LFP study",
    plotTitle: "Capacity retention",
    quantity: "Discharge capacity",
    xAxis: "Cycle",
    tab: "Cycles",
    sampleSummary: "3 samples",
    now: new Date(2026, 6, 16, 9, 8, 7),
  });
  assert.equal(value, "LFP study - Capacity retention final");
});

test("token buttons insert at the text cursor", () => {
  const result = insertFilenameToken("plot final", "{date}", 5, 5);
  assert.equal(result.value, "plot {date}final");
  assert.equal(result.cursor, 11);
});

test("filenames are made Windows-safe without losing useful text", () => {
  assert.equal(sanitizeExportFilename('LFP: "test" / plot.'), "LFP test plot");
});
