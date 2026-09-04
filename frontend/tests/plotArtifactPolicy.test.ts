import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactDataSignatureForWrite,
  portableResultDataSignature,
  previewQueryRootForPlot,
  serverArtifactMatchesExpectedData,
} from "../src/features/analyses/editor/policies/plotArtifactPolicy.ts";

test("failed artifact invalidation targets the consumer's preview family", () => {
  assert.equal(previewQueryRootForPlot("cycles"), "saved-plot-preview");
  assert.equal(previewQueryRootForPlot("time_capacity"), "saved-time-preview");
});

test("warmup writes reject a cached result from a different source generation", () => {
  assert.throws(
    () => artifactDataSignatureForWrite("old-source", "new-source"),
    /superseded scientific identity/,
  );
  assert.equal(
    artifactDataSignatureForWrite("source-a", "source-a"),
    "source-a",
  );
});

test("foreground consumers publish only a server response with the validated identity", () => {
  assert.equal(serverArtifactMatchesExpectedData("source-a", "source-a"), true);
  assert.equal(serverArtifactMatchesExpectedData("source-a", "source-b"), false);
  assert.equal(serverArtifactMatchesExpectedData("source-a", undefined), false);
});

test("portable snapshots require the compute endpoint's scientific identity", () => {
  assert.equal(portableResultDataSignature("source-a"), "source-a");
  assert.throws(
    () => portableResultDataSignature(undefined),
    /server-owned scientific signature/,
  );
});

test("portable figures sanitize Cycles-only live point-selection metadata", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(source, /data: withoutCyclePointSelectionMetadata\(traces\)/);
});
