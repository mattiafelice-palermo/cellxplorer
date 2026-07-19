import { get, post, postForm, type DownloadEntry, type DownloadSettings, type SavedDownload } from "./api";

export interface DownloadResult {
  cancelled: boolean;
  path?: string;
  usedDefaultFolder: boolean;
  entry?: DownloadEntry;
}

export type ShareResult = "shared" | "cancelled" | "unsupported";

export const DOWNLOAD_EVENT = "cellxplorer:download";

function announceDownload(entry: DownloadEntry | undefined): void {
  if (!entry) return;
  window.dispatchEvent(new CustomEvent<DownloadEntry>(DOWNLOAD_EVENT, { detail: entry }));
}

export async function shareDownload(
  blob: Blob,
  filename: string,
  title: string,
  text: string,
): Promise<ShareResult> {
  if (!navigator.share) return "unsupported";
  const file = new File([blob], filename, { type: blob.type || "text/html" });
  const data: ShareData = { title, text, files: [file] };
  if (navigator.canShare && !navigator.canShare(data)) return "unsupported";
  try {
    await navigator.share(data);
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw error;
  }
}

export function isTauriApp(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function registerClientDownload(
  filename: string,
  path: string,
  bytes: number | null,
): Promise<DownloadEntry | undefined> {
  try {
    return await post<DownloadEntry>("/api/downloads/history", { filename, path, bytes });
  } catch {
    return undefined;
  }
}

async function saveWithNativeDialog(blob: Blob, filename: string): Promise<DownloadResult> {
  const [{ save }, { writeFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const destination = await save({
    title: "Save export",
    defaultPath: filename,
  });
  if (!destination) return { cancelled: true, usedDefaultFolder: false };
  await writeFile(destination, new Uint8Array(await blob.arrayBuffer()));
  const entry = await registerClientDownload(filename, destination, blob.size);
  announceDownload(entry);
  return { cancelled: false, path: destination, usedDefaultFolder: false, entry };
}

export async function saveDownload(blob: Blob, filename: string): Promise<DownloadResult> {
  let settings: DownloadSettings;
  try {
    settings = await get<DownloadSettings>("/api/settings");
  } catch {
    if (isTauriApp()) return saveWithNativeDialog(blob, filename);
    browserDownload(blob, filename);
    return { cancelled: false, usedDefaultFolder: false };
  }
  if (settings.download_mode === "folder") {
    const form = new FormData();
    form.append("file", blob, filename);
    const saved = await postForm<SavedDownload>("/api/downloads", form);
    announceDownload(saved.entry);
    return {
      cancelled: false,
      path: saved.path,
      usedDefaultFolder: true,
      entry: saved.entry,
    };
  }

  if (isTauriApp()) return saveWithNativeDialog(blob, filename);
  browserDownload(blob, filename);
  // Browser downloads land in the user's browser download folder with no
  // path the app can act on; record a history entry so the manager is not
  // empty, but without file actions.
  const entry = await registerClientDownload(filename, "", blob.size);
  announceDownload(entry);
  return { cancelled: false, usedDefaultFolder: false, entry };
}
