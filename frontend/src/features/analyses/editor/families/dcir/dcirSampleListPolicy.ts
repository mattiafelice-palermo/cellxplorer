import type { SelectionEntry } from "../../../../../api";

export type DcirSampleSort =
  | "name_asc"
  | "name_desc"
  | "visible_first_asc"
  | "visible_first_desc";

export interface DcirSampleListItem {
  key: string;
  label: string;
  visible: boolean;
  entry: SelectionEntry;
}

export function dcirSampleEntryKey(
  entry: Pick<SelectionEntry, "kind" | "ref_id">,
) {
  return `${entry.kind}:${entry.ref_id}`;
}

export function filterAndSortDcirSampleItems(
  items: readonly DcirSampleListItem[],
  query: string,
  sort: DcirSampleSort,
) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) =>
    needle ? item.label.toLocaleLowerCase().includes(needle) : true,
  );
  const direction = sort.endsWith("desc") ? -1 : 1;
  const visibleFirst = sort.startsWith("visible_first");

  return [...filtered].sort((a, b) => {
    if (visibleFirst && a.visible !== b.visible) {
      return Number(b.visible) - Number(a.visible);
    }

    return (
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) * direction
      || a.key.localeCompare(b.key, undefined, { sensitivity: "base" })
    );
  });
}

export function dcirSampleKeysInRange(
  items: readonly DcirSampleListItem[],
  anchorKey: string | null,
  clickedKey: string,
) {
  const clickedIndex = items.findIndex((item) => item.key === clickedKey);
  if (clickedIndex < 0) return [];

  const anchorIndex = anchorKey == null
    ? -1
    : items.findIndex((item) => item.key === anchorKey);
  if (anchorIndex < 0) return [clickedKey];

  const start = Math.min(anchorIndex, clickedIndex);
  const end = Math.max(anchorIndex, clickedIndex);
  return items.slice(start, end + 1).map((item) => item.key);
}
