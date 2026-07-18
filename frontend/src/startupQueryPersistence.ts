import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { DatabaseStatus } from "./api";

const STORAGE_KEY = "cellxplorer-startup-query-snapshot";
const FORMAT_VERSION = 1;
const WRITE_DELAY_MS = 200;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StartupSnapshot {
  formatVersion: number;
  databaseInstanceId: string;
  schemaRevision: string | null;
  savedAt: number;
  state: DehydratedState;
}

const STARTUP_QUERY_KEYS: QueryKey[] = [
  ["cells", ""],
  ["analyses", ""],
  ["replicate-groups"],
  ["tree"],
];

export function configureStartupQueryDefaults(queryClient: QueryClient): void {
  for (const queryKey of STARTUP_QUERY_KEYS) {
    // These are compact navigation summaries, not scientific data. Keeping
    // them resident prevents an unvisited page from disappearing from the
    // next persisted startup snapshot after React Query's normal GC window.
    queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  }
}

export function isStartupQueryKey(queryKey: QueryKey): boolean {
  if (!Array.isArray(queryKey)) return false;
  if (queryKey.length === 1 && queryKey[0] === "tree") return true;
  if (queryKey.length === 1 && queryKey[0] === "replicate-groups") return true;
  if (queryKey.length !== 2 || queryKey[1] !== "") return false;
  return (
    queryKey[0] === "cells" ||
    queryKey[0] === "replicate-groups" ||
    queryKey[0] === "analyses"
  );
}

function parseSnapshot(raw: string | null): StartupSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StartupSnapshot>;
    if (
      value.formatVersion !== FORMAT_VERSION ||
      typeof value.databaseInstanceId !== "string" ||
      !value.databaseInstanceId ||
      typeof value.savedAt !== "number" ||
      !value.state
    ) {
      return null;
    }
    return value as StartupSnapshot;
  } catch {
    return null;
  }
}

export class StartupQueryPersistence {
  private readonly storage: StorageLike | null;
  private snapshot: StartupSnapshot | null = null;
  private databaseInstanceId: string | null = null;
  private schemaRevision: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pageHideHandler: (() => void) | null = null;

  constructor(storage: StorageLike | null) {
    this.storage = storage;
  }

  restore(queryClient: QueryClient): void {
    if (!this.storage) return;
    this.snapshot = parseSnapshot(this.storage.getItem(STORAGE_KEY));
    if (this.snapshot) hydrate(queryClient, this.snapshot.state);
  }

  start(queryClient: QueryClient): void {
    this.unsubscribe?.();
    this.unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!event?.query || !isStartupQueryKey(event.query.queryKey)) return;
      if (event.query.state.status !== "success") return;
      this.scheduleWrite(queryClient);
    });
    if (typeof window !== "undefined") {
      if (this.pageHideHandler) window.removeEventListener("pagehide", this.pageHideHandler);
      this.pageHideHandler = () => this.flush(queryClient);
      window.addEventListener("pagehide", this.pageHideHandler);
    }
  }

  reconcile(queryClient: QueryClient, status: DatabaseStatus): void {
    const identity = status.compatible ? status.database_instance_id : null;
    const snapshotMatches =
      !!identity &&
      !!this.snapshot &&
      this.snapshot.databaseInstanceId === identity &&
      this.snapshot.schemaRevision === status.schema_revision;

    if (this.snapshot && !snapshotMatches) {
      this.clearStoredSnapshot();
      queryClient.removeQueries({ predicate: (query) => isStartupQueryKey(query.queryKey) });
      void queryClient.refetchQueries({
        predicate: (query) => isStartupQueryKey(query.queryKey),
        type: "active",
      });
    }

    this.databaseInstanceId = identity;
    this.schemaRevision = status.schema_revision;
    if (identity) this.scheduleWrite(queryClient, 0);
  }

  flush(queryClient: QueryClient): void {
    if (!this.storage || !this.databaseInstanceId) return;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const snapshot: StartupSnapshot = {
      formatVersion: FORMAT_VERSION,
      databaseInstanceId: this.databaseInstanceId,
      schemaRevision: this.schemaRevision,
      savedAt: Date.now(),
      state: dehydrate(queryClient, {
        shouldDehydrateQuery: (query) =>
          query.state.status === "success" && isStartupQueryKey(query.queryKey),
      }),
    };
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      this.snapshot = snapshot;
    } catch {
      // Storage can be unavailable or full. The live query cache still works.
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (typeof window !== "undefined" && this.pageHideHandler) {
      window.removeEventListener("pagehide", this.pageHideHandler);
    }
    this.pageHideHandler = null;
  }

  private scheduleWrite(queryClient: QueryClient, delay = WRITE_DELAY_MS): void {
    if (!this.databaseInstanceId) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(queryClient), delay);
  }

  private clearStoredSnapshot(): void {
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // A blocked storage API should not prevent live database loading.
    }
    this.snapshot = null;
  }
}

export const startupQueryPersistence = new StartupQueryPersistence(
  typeof window === "undefined" ? null : window.localStorage
);
