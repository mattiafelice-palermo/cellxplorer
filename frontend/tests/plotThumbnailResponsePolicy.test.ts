import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCachedPlotThumbnailResponse,
} from "../src/features/analyses/editor/policies/plotThumbnailResponsePolicy.ts";

test("a thumbnail 404 replaces the previous identity with unavailable null", () => {
  assert.equal(
    normalizeCachedPlotThumbnailResponse(undefined, 404),
    null,
  );
  assert.deepEqual(
    normalizeCachedPlotThumbnailResponse({
      thumbnail: "data:image/png;base64,old",
      data_signature: "source-1",
    }),
    {
      thumbnail: "data:image/png;base64,old",
      data_signature: "source-1",
    },
  );
});
