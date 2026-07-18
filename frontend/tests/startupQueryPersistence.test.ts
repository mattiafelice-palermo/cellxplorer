import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient } from "@tanstack/react-query";

import {
  configureStartupQueryDefaults,
  isStartupQueryKey,
  StartupQueryPersistence,
} from "../src/startupQueryPersistence.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const status = {
  status: "ready",
  compatible: true,
  app_version: "0.8.0",
  schema_revision: "0002",
  supported_revision: "0002",
  previous_revision: null,
  migration_performed: false,
  legacy_database: false,
  backup_path: null,
  message: "Ready",
  database_instance_id: "11111111-1111-1111-1111-111111111111",
};

test("startup snapshot allowlist excludes scientific and searched query data", () => {
  assert.equal(isStartupQueryKey(["cells", ""]), true);
  assert.equal(isStartupQueryKey(["analyses", ""]), true);
  assert.equal(isStartupQueryKey(["replicate-groups"]), true);
  assert.equal(isStartupQueryKey(["tree"]), true);
  assert.equal(isStartupQueryKey(["cells", "nickel"]), false);
  assert.equal(isStartupQueryKey(["cell", 4]), false);
  assert.equal(isStartupQueryKey(["analysis-compute", 4]), false);
});

test("startup summaries are not garbage-collected while the app is open", () => {
  const client = new QueryClient();
  configureStartupQueryDefaults(client);

  assert.equal(client.getQueryDefaults(["cells", ""]).gcTime, Infinity);
  assert.equal(client.getQueryDefaults(["analyses", ""]).gcTime, Infinity);
  assert.equal(client.getQueryDefaults(["replicate-groups"]).gcTime, Infinity);
  assert.equal(client.getQueryDefaults(["tree"]).gcTime, Infinity);
  assert.notEqual(client.getQueryDefaults(["cells", "nickel"]).gcTime, Infinity);
});

test("startup summaries restore only for the same database and schema", () => {
  const storage = new MemoryStorage();
  const firstClient = new QueryClient();
  firstClient.setQueryData(["cells", ""], [{ id: 1, name: "Cell A" }]);
  firstClient.setQueryData(["cell", 1], { id: 1, raw: "not persisted" });
  const firstPersistence = new StartupQueryPersistence(storage);
  firstPersistence.reconcile(firstClient, status);
  firstPersistence.flush(firstClient);

  const restoredClient = new QueryClient();
  const restoredPersistence = new StartupQueryPersistence(storage);
  restoredPersistence.restore(restoredClient);
  assert.deepEqual(restoredClient.getQueryData(["cells", ""]), [
    { id: 1, name: "Cell A" },
  ]);
  assert.equal(restoredClient.getQueryData(["cell", 1]), undefined);

  restoredPersistence.reconcile(restoredClient, {
    ...status,
    database_instance_id: "22222222-2222-2222-2222-222222222222",
  });
  assert.equal(restoredClient.getQueryData(["cells", ""]), undefined);
});
