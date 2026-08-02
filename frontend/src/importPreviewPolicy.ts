import type { ImportPreview, ImportPreviewResult } from "./api";

export type ImportPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: ImportPreviewResult }
  | { status: "error"; message: string };

export type ImportPreviewDraftState = ImportPreview & {
  preview_state: ImportPreviewState;
};

export type ImportPreviewDraft = Pick<
  ImportPreview,
  "staged_name" | "source_path" | "hash" | "size" | "inspection"
>;

export function importPreviewQueryKey(hash: string): readonly [string, string] {
  return ["import-capacity-preview", hash.toLowerCase()];
}

export function importPreviewRequest(draft: ImportPreviewDraft) {
  return {
    staged_name: draft.staged_name,
    source_path: draft.source_path,
    expected_hash: draft.hash,
    expected_size: draft.inspection?.size ?? draft.size,
    expected_mtime_ns: draft.inspection?.mtime_ns ?? null,
  };
}

export function importPreviewStateFromResult(result: ImportPreviewResult): ImportPreviewState {
  return result.preview_error
    ? { status: "error", message: result.preview_error }
    : { status: "ready", preview: result };
}

export function importPreviewStateMessage(state: ImportPreviewState): string | null {
  return state.status === "error" ? state.message : null;
}
