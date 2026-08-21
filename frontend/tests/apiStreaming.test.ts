import assert from "node:assert/strict";
import test from "node:test";

import { postJsonOrNdjson } from "../src/api.ts";

test("NDJSON helper handles split UTF-8 code points and arbitrary line chunks", async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  (globalThis as { window?: unknown }).window = {
    location: { hostname: "127.0.0.1", port: "8642" },
  };
  const payload = [
    JSON.stringify({ type: "start", label: "café" }),
    JSON.stringify({ type: "complete", count: 1 }),
  ].join("\n") + "\n";
  const encoded = new TextEncoder().encode(payload);
  const cafeByte = encoded.indexOf(0xc3);
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, cafeByte + 1));
          controller.enqueue(encoded.slice(cafeByte + 1, Math.floor(encoded.length / 2)));
          controller.enqueue(encoded.slice(Math.floor(encoded.length / 2)));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  try {
    const events: unknown[] = [];
    const response = await postJsonOrNdjson<unknown, unknown>(
      "/api/analyses/1/time-capacity/stream",
      { spec: {} },
      { parseEvent: (value) => value, onEvent: (event) => events.push(event) },
    );
    assert.equal(response.mode, "ndjson");
    assert.deepEqual(events, [
      { type: "start", label: "café" },
      { type: "complete", count: 1 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("JSON cache hits stay one-shot through the same helper", async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  (globalThis as { window?: unknown }).window = {
    location: { hostname: "127.0.0.1", port: "8642" },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ cache_status: "hit", cell_traces: [] }), {
      headers: { "content-type": "application/json" },
    });
  try {
    const response = await postJsonOrNdjson<{ cache_status: string }, never>(
      "/api/analyses/1/time-capacity/stream",
      {},
    );
    assert.equal(response.mode, "json");
    assert.equal(response.value?.cache_status, "hit");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  }
});
