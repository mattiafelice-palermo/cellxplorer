import { get, postForm, type DownloadSettings, type SavedDownload } from "./api";

export interface DownloadResult {
  cancelled: boolean;
  path?: string;
  usedDefaultFolder: boolean;
}

export type ShareResult = "shared" | "cancelled" | "unsupported";

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
  return { cancelled: false, path: destination, usedDefaultFolder: false };
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
    return {
      cancelled: false,
      path: saved.path,
      usedDefaultFolder: true,
    };
  }

  if (isTauriApp()) return saveWithNativeDialog(blob, filename);
  browserDownload(blob, filename);
  return { cancelled: false, usedDefaultFolder: false };
}
