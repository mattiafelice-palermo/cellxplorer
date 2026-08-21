import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  invalidateAnalysisQueries,
  invalidateSourceScientificQueries,
  refreshPersistedAnalysisQueries,
  sourceUpdateCellId,
} from "../src/features/analyses/workspace/analysisQueryCache.ts";

test("source replacement keeps the server cell target when selection moves", () => {
  const currentSelectionId = 8;
  const response = { cell_id: 7 };
  assert.equal(sourceUpdateCellId(response), 7);
  assert.notEqual(sourceUpdateCellId(response), currentSelectionId);
});

test("scientific invalidation covers results, previews, artifacts, and database thumbnails", async () => {
  const queryClient = new QueryClient();
  const keys = [
    ["analysis-database-thumbnail", 7, "plot-1"],
    ["saved-plot-preview", 7, "plot-1", "preview"],
    ["plot-artifact", 7, "plot-1", "preview"],
    ["time-capacity", 7],
  ] as const;
  for (const key of keys) queryClient.setQueryData(key, { ready: true });

  await invalidateAnalysisQueries(queryClient);

  for (const key of keys) {
    assert.equal(queryClient.getQueryState(key)?.isInvalidated, true, String(key));
  }
  queryClient.clear();
});

test("source invalidation covers affected cell variants and replicate previews", async () => {
  const queryClient = new QueryClient();
  const affected = [
    ["cell-protocol", 7],
    ["cell-protocol", 7, "with-observed-steps"],
    ["cell-source-header", 7, 41],
    ["cell-cycles", 7],
    ["replicate-preview", 12],
  ] as const;
  const unaffected = [
    ["cell-protocol", 8],
    ["cell-source-header", 8, 42],
    ["cell-cycles", 8],
    ["replicate-preview", 13],
    ["analysis", 7],
  ] as const;
  for (const key of [...affected, ...unaffected]) {
    queryClient.setQueryData(key, { ready: true });
  }

  await invalidateSourceScientificQueries(queryClient, {
    cellIds: [7],
    replicateGroupIds: [12],
  });

  for (const key of affected) {
    assert.equal(queryClient.getQueryState(key)?.isInvalidated, true, String(key));
  }
  for (const key of unaffected) {
    assert.notEqual(queryClient.getQueryState(key)?.isInvalidated, true, String(key));
  }
  queryClient.clear();
});

test("source invalidation cancels superseded active reads and refetches them", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let calls = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: ["cell-protocol", 7],
    queryFn: ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<{ version: string }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ version: "stale" }), {
            once: true,
          });
        });
      }
      return Promise.resolve({ version: "fresh" });
    },
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);

  await invalidateSourceScientificQueries(queryClient, { cellIds: [7] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 2);
  assert.deepEqual(queryClient.getQueryData(["cell-protocol", 7]), {
    version: "fresh",
  });
  unsubscribe();
  queryClient.clear();
});

test("analysis invalidation cancels a superseded active result before refreshing it", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let calls = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: ["time-capacity", 7],
    queryFn: ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<{ version: string }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ version: "stale" }), {
            once: true,
          });
        });
      }
      return Promise.resolve({ version: "fresh" });
    },
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);

  await invalidateAnalysisQueries(queryClient, 7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 2);
  assert.deepEqual(queryClient.getQueryData(["time-capacity", 7]), {
    version: "fresh",
  });
  unsubscribe();
  queryClient.clear();
});

test("persisted analysis refresh updates detail/index without scientific invalidation", async () => {
  const queryClient = new QueryClient();
  const saved = { id: 7, title: "Saved title", spec: { selection: { entries: [] } } };
  const scientificKeys = [
    ["compute", 7],
    ["time-capacity", 7, "compatible", "range-20"],
    ["steps", 7, "steps-signature"],
    ["dcir", 7, "dcir-signature"],
    ["chargeability", 7, "chargeability-signature"],
    ["rate-capability", 7, "rate-signature"],
    ["saved-plot-preview", 7, "plot-1", "preview"],
    ["plot-thumbnail", 7, "plot-1", "preview"],
    ["plot-artifact", 7, "plot-1", "preview"],
  ] as const;
  for (const key of scientificKeys) queryClient.setQueryData(key, { ready: true });
  queryClient.setQueryData(["analysis", 7], { id: 7, title: "Old title" });
  queryClient.setQueryData(["analysis", 8], { id: 8, title: "Other title" });
  queryClient.setQueryData(["analyses"], [{ id: 7, title: "Old title" }]);

  await refreshPersistedAnalysisQueries(queryClient, 7, saved);

  assert.deepEqual(queryClient.getQueryData(["analysis", 7]), saved);
  assert.equal(queryClient.getQueryState(["analyses"])?.isInvalidated, true);
  assert.deepEqual(queryClient.getQueryData(["analysis", 8]), { id: 8, title: "Other title" });
  for (const key of scientificKeys) {
    assert.notEqual(queryClient.getQueryState(key)?.isInvalidated, true, String(key));
  }
  queryClient.clear();
});

test("analysis invalidation scopes editor saves but globally refreshes mounted analyses", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const calls = new Map<number, number>();
  const firstResolvers = new Map<number, (value: { version: string }) => void>();
  const observers = [1, 2].map(
    (analysisId) =>
      new QueryObserver(queryClient, {
        queryKey: ["time-capacity", analysisId],
        queryFn: ({ signal }) => {
          const call = (calls.get(analysisId) ?? 0) + 1;
          calls.set(analysisId, call);
          if (call === 1) {
            return new Promise<{ version: string }>((resolve) => {
              firstResolvers.set(analysisId, resolve);
              signal.addEventListener("abort", () => resolve({ version: "cancelled" }), {
                once: true,
              });
            });
          }
          return Promise.resolve({ version: "fresh" });
        },
      }),
  );
  const unsubscribers = observers.map((observer) =>
    observer.subscribe(() => undefined),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...calls.entries()], [[1, 1], [2, 1]]);

  await invalidateAnalysisQueries(queryClient, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.get(1), 2);
  assert.equal(calls.get(2), 1);

  firstResolvers.get(2)?.({ version: "initial" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await invalidateAnalysisQueries(queryClient);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.get(1), 3);
  assert.equal(calls.get(2), 2);
  assert.deepEqual(queryClient.getQueryData(["time-capacity", 1]), {
    version: "fresh",
  });
  assert.deepEqual(queryClient.getQueryData(["time-capacity", 2]), {
    version: "fresh",
  });

  unsubscribers.forEach((unsubscribe) => unsubscribe());
  queryClient.clear();
});
