import { APP_CHANNEL } from "./appChannel";

export const SEARCH_INTRO_ID = "indexed-source-search-v1";
export const SEARCH_INTRO_BASELINE = "0.28.0-alpha.2";
export const WHATS_NEW_STORAGE_KEY = `cellxplorer:${APP_CHANNEL}:whats-new:${SEARCH_INTRO_ID}`;

/** Full SemVer ordering matters: the next Alpha build can share the same version core. */
export function isAfterSearchIntroBaseline(version: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const current = parse(version);
  const baseline = parse(SEARCH_INTRO_BASELINE)!;
  if (!current) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(current[i]) !== Number(baseline[i])) return Number(current[i]) > Number(baseline[i]);
  }
  if (!current[4]) return true;
  const a = current[4].split(".");
  const b = baseline[4].split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return false;
    if (b[i] === undefined) return true;
    const numericA = /^\d+$/.test(a[i]);
    const numericB = /^\d+$/.test(b[i]);
    if (numericA && numericB) return Number(a[i]) > Number(b[i]);
    if (numericA !== numericB) return !numericA;
    return a[i] > b[i];
  }
  return false;
}

export function searchIntroWasSeen(storage: Pick<Storage, "getItem">): boolean {
  try { return storage.getItem(WHATS_NEW_STORAGE_KEY) === "seen"; } catch { return false; }
}

export function markSearchIntroSeen(storage: Pick<Storage, "setItem">): void {
  try { storage.setItem(WHATS_NEW_STORAGE_KEY, "seen"); } catch { /* A storage restriction must not prevent closing. */ }
}
