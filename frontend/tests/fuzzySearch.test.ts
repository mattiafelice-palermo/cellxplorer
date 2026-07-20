import assert from "node:assert/strict";
import test from "node:test";

import { fuzzyScore, fuzzyScoreFields, highlightSegments } from "../src/fuzzySearch.ts";

const CELL = "ME_20260512_LFP_LPMoL_611_FM+CYFC_25C";

function best(targets: string[], query: string): string {
  const scored = targets
    .map((target) => ({ target, match: fuzzyScore(target, query) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => b.match!.score - a.match!.score);
  return scored[0]?.target ?? "";
}

test("matches a bare identifier fragment inside a delimited name", () => {
  assert.ok(fuzzyScore(CELL, "611"));
  assert.ok(fuzzyScore(CELL, "lpmol"));
});

test("multi-word queries match across delimiters", () => {
  assert.ok(fuzzyScore(CELL, "lpmol 611"));
  assert.ok(fuzzyScore(CELL, "611 cyfc"));
});

test("unmatched query returns null", () => {
  assert.equal(fuzzyScore(CELL, "zzz"), null);
  assert.equal(fuzzyScore(CELL, "611 zzz"), null);
});

test("empty query matches everything with a neutral score", () => {
  const match = fuzzyScore(CELL, "   ");
  assert.ok(match);
  assert.equal(match!.score, 0);
});

test("exact and prefix matches outrank scattered subsequences", () => {
  const targets = ["Discharge capacity comparison", "Detailed cycle history"];
  assert.equal(best(targets, "disc"), "Discharge capacity comparison");
});

test("the intended cell wins over incidentally similar names", () => {
  const targets = [
    "ME_20260512_LFP_LPMoL_611_FM+CYFC_25C",
    "ME_20260512_LFP_LPMoL_616_FM+CYFC_25C",
    "NG_20251127_LFP_LP_MoL_376_FM_CY_FC",
  ];
  assert.equal(best(targets, "611"), "ME_20260512_LFP_LPMoL_611_FM+CYFC_25C");
  assert.equal(best(targets, "616"), "ME_20260512_LFP_LPMoL_616_FM+CYFC_25C");
  assert.equal(best(targets, "376"), "NG_20251127_LFP_LP_MoL_376_FM_CY_FC");
});

test("word-boundary matches beat mid-token ones", () => {
  const targets = ["Voltage vs time", "Revoltage inner"];
  assert.equal(best(targets, "volt"), "Voltage vs time");
});

test("case is ignored", () => {
  assert.ok(fuzzyScore(CELL, "lpmol"));
  assert.ok(fuzzyScore(CELL, "LPMOL"));
  assert.ok(fuzzyScore("Test analysis 2", "TEST"));
});

test("returned indices mark the matched characters", () => {
  const match = fuzzyScore("Discharge capacity", "disc");
  assert.ok(match);
  assert.deepEqual(match!.indices, [0, 1, 2, 3]);
});

test("highlight segments reconstruct the original text", () => {
  const match = fuzzyScore(CELL, "611")!;
  const segments = highlightSegments(CELL, match.indices);
  assert.equal(segments.map((segment) => segment.text).join(""), CELL);
  assert.ok(segments.some((segment) => segment.matched));
});

test("highlight with no matches returns a single unmatched run", () => {
  assert.deepEqual(highlightSegments("abc", []), [{ text: "abc", matched: false }]);
});

// --- multi-field scoring: terms may match different fields of one object ---

/** A saved plot named "…capacity…" belonging to an analysis over CELL. */
const plotFields = [
  { text: "Discharge capacity (mAh) comparison", weight: 1 },
  { text: "Test analysis 2", weight: 0.6 },
  { text: `${CELL} • NG_20251127_LFP_LP_MoL_376_FM_CY_FC`, weight: 0.45, substringOnly: true },
];

test("a cell name plus a plot word matches the plot containing that cell", () => {
  // This is the case that previously found nothing: the terms live in
  // different fields.
  assert.ok(fuzzyScoreFields(plotFields, "LPMoL_611 capacity"));
  assert.ok(fuzzyScoreFields(plotFields, "611 capacity"));
  assert.ok(fuzzyScoreFields(plotFields, "capacity 611"));
});

test("a term matching no field disqualifies the object", () => {
  assert.equal(fuzzyScoreFields(plotFields, "capacity zzz"), null);
  assert.equal(fuzzyScoreFields(plotFields, "611 voltage"), null);
});

test("the parent analysis name is searchable from a plot", () => {
  assert.ok(fuzzyScoreFields(plotFields, "test analysis capacity"));
});

test("aggregated fields accept substrings but not scattered subsequences", () => {
  const fields = [
    { text: "Some plot", weight: 1 },
    { text: "ME_20260512_LFP_LPMoL_611_FM+CYFC_25C", weight: 0.45, substringOnly: true },
  ];
  // Real substring of the aggregated cell list.
  assert.ok(fuzzyScoreFields(fields, "plot lpmol"));
  // Scattered characters must NOT match a long aggregated blob.
  assert.equal(fuzzyScoreFields(fields, "plot mlc"), null);
});

test("title matches outrank matches found only in context fields", () => {
  const titleHit = fuzzyScoreFields(
    [{ text: "Capacity overview", weight: 1 }, { text: "other", weight: 0.45 }],
    "capacity",
  );
  const contextHit = fuzzyScoreFields(
    [{ text: "Voltage overview", weight: 1 }, { text: "capacity", weight: 0.45 }],
    "capacity",
  );
  assert.ok(titleHit!.score > contextHit!.score);
});

test("highlight indices come from the title field only", () => {
  const match = fuzzyScoreFields(plotFields, "611 capacity");
  assert.ok(match);
  const title = plotFields[0].text;
  // Every reported index must fall inside the title.
  assert.ok(match!.indices.every((index) => index >= 0 && index < title.length));
  const highlighted = match!.indices.map((index) => title[index]).join("");
  assert.ok(highlighted.toLowerCase().includes("capacity".slice(0, 4)));
});

test("empty query matches every object", () => {
  const match = fuzzyScoreFields(plotFields, "");
  assert.ok(match);
  assert.equal(match!.score, 0);
});
