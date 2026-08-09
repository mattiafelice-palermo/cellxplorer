import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWarmup,
  warmupErrorMessage,
  type WarmupSignals,
} from "../src/features/analyses/editor/artifacts/warmupCompletion.ts";

/** Nothing has happened yet: the only state that may legitimately stay pending. */
function idle(overrides: Partial<WarmupSignals> = {}): WarmupSignals {
  return {
    generationFailed: false,
    thumbnailPairReady: false,
    thumbnailErrored: false,
    artifactErrored: false,
    previewErrored: false,
    previewSucceeded: false,
    traceCount: 0,
    renderedFresh: false,
    rebuiltThumbnail: false,
    ...overrides,
  };
}

test("a task still in flight stays pending", () => {
  assert.deepEqual(resolveWarmup(idle()), { status: "pending" });
  // Computed with traces, thumbnail not written yet — still working.
  assert.deepEqual(
    resolveWarmup(idle({ previewSucceeded: true, traceCount: 3 })),
    { status: "pending" },
  );
});

test("a failed thumbnail lookup completes instead of stalling the queue", () => {
  // The reported deadlock: the lookup fails, so the artifact and compute
  // queries never run and every other branch stays false. This must not be
  // pending — a pending state here wedges the whole session's warmup.
  const resolution = resolveWarmup(
    idle({ thumbnailErrored: true, thumbnailError: new Error("Failed to fetch") }),
  );
  assert.equal(resolution.status, "done");
  assert.equal(resolution.status === "done" && resolution.error, "Failed to fetch");
});

test("a failed artifact lookup completes instead of stalling the queue", () => {
  const resolution = resolveWarmup(
    idle({ artifactErrored: true, artifactError: new Error("500 Internal Server Error") }),
  );
  assert.equal(resolution.status, "done");
  assert.equal(
    resolution.status === "done" && resolution.error,
    "500 Internal Server Error",
  );
});

test("lookup failures fall back to a readable message", () => {
  assert.equal(
    (resolveWarmup(idle({ thumbnailErrored: true })) as { error: string }).error,
    "Thumbnail lookup failed",
  );
  assert.equal(
    (resolveWarmup(idle({ artifactErrored: true })) as { error: string }).error,
    "Plot artifact lookup failed",
  );
});

test("the four pre-existing terminal branches are unchanged", () => {
  assert.deepEqual(resolveWarmup(idle({ generationFailed: true })), {
    status: "done",
    error: "Thumbnail generation failed",
  });
  assert.deepEqual(resolveWarmup(idle({ thumbnailPairReady: true })), {
    status: "done",
    detail: "Already cached",
  });
  assert.deepEqual(
    resolveWarmup(idle({ previewErrored: true, previewError: new Error("compute blew up") })),
    { status: "done", error: "compute blew up" },
  );
  assert.deepEqual(
    resolveWarmup(idle({ previewSucceeded: true, traceCount: 0 })),
    { status: "done" },
  );
});

test("success detail distinguishes fresh compute, rebuild and cache hit", () => {
  assert.equal(
    (resolveWarmup(idle({ thumbnailPairReady: true, renderedFresh: true })) as {
      detail: string;
    }).detail,
    "Computed data and rendered thumbnail",
  );
  assert.equal(
    (resolveWarmup(idle({ thumbnailPairReady: true, rebuiltThumbnail: true })) as {
      detail: string;
    }).detail,
    "Thumbnail rebuilt from cached plot",
  );
  assert.equal(
    (resolveWarmup(idle({ thumbnailPairReady: true })) as { detail: string }).detail,
    "Already cached",
  );
});

test("a real success outranks a stale lookup error", () => {
  // Order matters: if the pair landed, the task succeeded regardless of an
  // earlier failed lookup attempt.
  const resolution = resolveWarmup(
    idle({ thumbnailPairReady: true, thumbnailErrored: true, artifactErrored: true }),
  );
  assert.equal(resolution.status, "done");
  assert.equal(resolution.status === "done" && resolution.error, undefined);
});

test("generation failure outranks everything", () => {
  const resolution = resolveWarmup(
    idle({ generationFailed: true, thumbnailPairReady: true }),
  );
  assert.equal(
    resolution.status === "done" && resolution.error,
    "Thumbnail generation failed",
  );
});

test("no reachable combination of terminal signals stays pending", () => {
  // Exhaustive guard: any single terminal signal must resolve.
  const terminals: Partial<WarmupSignals>[] = [
    { generationFailed: true },
    { thumbnailPairReady: true },
    { thumbnailErrored: true },
    { artifactErrored: true },
    { previewErrored: true },
    { previewSucceeded: true, traceCount: 0 },
  ];
  for (const terminal of terminals) {
    assert.equal(
      resolveWarmup(idle(terminal)).status,
      "done",
      `${JSON.stringify(terminal)} must resolve`,
    );
  }
});

test("error messages degrade gracefully", () => {
  assert.equal(warmupErrorMessage(new Error("boom"), "fallback"), "boom");
  assert.equal(warmupErrorMessage("string failure", "fallback"), "string failure");
  assert.equal(warmupErrorMessage(new Error(""), "fallback"), "fallback");
  assert.equal(warmupErrorMessage(undefined, "fallback"), "fallback");
  assert.equal(warmupErrorMessage({ weird: true }, "fallback"), "fallback");
});
