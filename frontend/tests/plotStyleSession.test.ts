import assert from "node:assert/strict";
import test from "node:test";

import {
  copyRememberedPlotStyleSections,
  plotStyleKeyFor,
  readRememberedPlotStyleSections,
  rememberPlotStyleSections,
} from "../src/features/analyses/editor/plotting/plotStyleSession.ts";

test("draft plot-style keys are session-specific while saved keys are stable", () => {
  assert.notEqual(
    plotStyleKeyFor(42, "cycles", null, "draft-a"),
    plotStyleKeyFor(42, "cycles", null, "draft-b"),
  );
  assert.equal(
    plotStyleKeyFor(42, "cycles", "plot-1", "draft-a"),
    plotStyleKeyFor(42, "cycles", "plot-1", "draft-b"),
  );
});

test("plot-style accordion memory is copied independently when a draft is saved", () => {
  const source = "draft-session-source";
  const target = "saved-plot-target";
  rememberPlotStyleSections(source, ["lines", "axes"]);

  copyRememberedPlotStyleSections(source, target);
  assert.deepEqual(readRememberedPlotStyleSections(target), ["lines", "axes"]);

  rememberPlotStyleSections(source, ["series"]);
  assert.deepEqual(readRememberedPlotStyleSections(target), ["lines", "axes"]);
});

test("a plot without prior accordion memory starts collapsed", () => {
  const target = "new-saved-plot-without-memory";
  copyRememberedPlotStyleSections("missing-draft-session", target);
  assert.deepEqual(readRememberedPlotStyleSections(target), []);
});
