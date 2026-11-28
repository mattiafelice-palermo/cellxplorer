import { importSourcePathKey } from "./importSourceReadability.ts";
import type { ImportBrowseEntry } from "./api";
import type { ImportFolderFile } from "./api";

export type FolderImportNode = {
  key: string;
  name: string;
  files: ImportFolderFile[];
  children: FolderImportNode[];
};

export function buildImportFolderTree(rootName: string, candidates: ImportFolderFile[]): FolderImportNode {
  const root: FolderImportNode = { key: "", name: rootName, files: [], children: [] };
  const nodes = new Map<string, FolderImportNode>([["", root]]);
  for (const candidate of candidates) {
    const selectionRoot = candidate.selection_root;
    const rootKey = selectionRoot
      ? selectionRoot.kind === "folder"
        ? `root:${selectionRoot.path.toLocaleLowerCase()}`
        : "root:loose-files"
      : "root:legacy";
    let parent = nodes.get(rootKey);
    if (!parent) {
      parent = {
        key: rootKey,
        name: selectionRoot?.label || "Selected files",
        files: [],
        children: [],
      };
      nodes.set(rootKey, parent);
      root.children.push(parent);
    }
    const parts = candidate.relative_path.replaceAll("\\", "/").split("/").filter(Boolean);
    let key = rootKey;
    for (const part of parts.slice(0, -1)) {
      key = key ? `${key}/${part}` : part;
      let node = nodes.get(key);
      if (!node) {
        node = { key, name: part, files: [], children: [] };
        nodes.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.files.push(candidate);
  }
  const sort = (node: FolderImportNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.filename.localeCompare(b.filename));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function flattenImportFolderTree(node: FolderImportNode): ImportFolderFile[] {
  return [
    ...node.children.flatMap(flattenImportFolderTree),
    ...node.files,
  ];
}


/** Use the same nested tree as the folder import step. Loose files group by their own directory. */
export function reviewFolderTree(entries: ImportBrowseEntry[], origins: ReadonlyMap<string, ImportFolderFile>, query: string) {
  const files: ImportFolderFile[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.path.toLocaleLowerCase().includes(query)) continue;
    const candidate = origins.get(importSourcePathKey(entry.path));
    if (candidate) {
      files.push(candidate);
      continue;
    }
    const end = entry.path.length - entry.name.length;
    const parent = entry.path.slice(0, end).replace(/[\\/]+$/, "");
    files.push({ path: entry.path, size: entry.size ?? 0, filename: entry.name, relative_path: entry.name,
      selection_root: { kind: "folder", path: parent, label: parent.split(/[\\/]/).pop() || parent || "Selected files" } });
  }
  const roots = buildImportFolderTree("Selected files", files).children;
  const labels = new Set<string>(), ambiguous = new Set<string>();
  for (const root of roots) {
    const name = root.name.toLocaleLowerCase();
    if (labels.has(name)) ambiguous.add(name);
    labels.add(name);
  }
  for (const root of roots) {
    if (ambiguous.has(root.name.toLocaleLowerCase())) root.name = (root.files[0] ?? flattenImportFolderTree(root)[0]).selection_root.path;
  }
  return roots;
}

export function materializeFolderSelection(current: ReadonlyMap<string, ImportBrowseEntry>, folders: string[], files: ImportFolderFile[]) {
  const next = new Map(current);
  const selectedRoots = new Set(folders.filter(path => current.get(path)?.kind === "folder").map(importSourcePathKey));
  for (const path of folders) next.delete(path);
  for (const file of files) {
    if (file.path && selectedRoots.has(importSourcePathKey(file.selection_root.path)) && !next.has(file.path)) {
      next.set(file.path, { kind: "file", path: file.path, name: file.filename, size: file.size, modified_at: null });
    }
  }
  return next;
}

export function reviewFolderMembers(files: Iterable<ImportFolderFile>) {
  const members = new Map<string, ImportBrowseEntry[]>();
  for (const file of files) {
    if (!file.path) continue;
    const entry: ImportBrowseEntry = { path: file.path, name: file.filename, kind: "file", size: file.size, modified_at: null };
    let folder = importSourcePathKey(file.selection_root.path);
    const parts = file.relative_path.split(/[\\/]/);
    for (const part of parts) {
      const list = members.get(folder);
      if (list) list.push(entry); else members.set(folder, [entry]);
      folder += "\\" + part.toLocaleLowerCase();
    }
  }
  return members;
}
