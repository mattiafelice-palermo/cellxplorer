export type ImportPathBreadcrumb = {
  label: string;
  targetPath: string;
};

export type ImportPathEditAction = "navigate" | "cancel" | null;

function splitWindowsParts(value: string): string[] {
  return value.split(/\\+/).filter(Boolean);
}

function driveBreadcrumbs(path: string): ImportPathBreadcrumb[] | null {
  const match = path.match(/^([A-Za-z]):\\+/);
  if (!match) return null;

  const drive = `${match[1].toUpperCase()}:`;
  const root = `${drive}\\`;
  const parts = splitWindowsParts(path.slice(match[0].length));
  const breadcrumbs: ImportPathBreadcrumb[] = [{ label: drive, targetPath: root }];
  let target = root;
  for (const part of parts) {
    target = `${target}${part}\\`;
    breadcrumbs.push({ label: part, targetPath: target.slice(0, -1) });
  }
  return breadcrumbs;
}

function uncBreadcrumbs(path: string): ImportPathBreadcrumb[] | null {
  if (!/^\\{2}/.test(path)) return null;
  const parts = splitWindowsParts(path.replace(/^\\+/, ""));
  if (parts.length < 2) return null;

  const shareRoot = `\\\\${parts[0]}\\${parts[1]}`;
  const breadcrumbs: ImportPathBreadcrumb[] = [{ label: shareRoot, targetPath: shareRoot }];
  let target = shareRoot;
  for (const part of parts.slice(2)) {
    target = `${target}\\${part}`;
    breadcrumbs.push({ label: part, targetPath: target });
  }
  return breadcrumbs;
}

/** Parse Windows filesystem paths without treating them as browser URLs. */
export function parseImportPathBreadcrumbs(path: string): ImportPathBreadcrumb[] {
  const trimmed = path.trim();
  if (!trimmed) return [];

  const normalizedSeparators = trimmed.replaceAll("/", "\\");
  return (
    driveBreadcrumbs(normalizedSeparators) ??
    uncBreadcrumbs(normalizedSeparators) ??
    [{ label: normalizedSeparators, targetPath: normalizedSeparators }]
  );
}

export function importPathsEqual(left: string, right: string): boolean {
  const normalize = (path: string) =>
    path.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

export function importPathEditAction(
  key: string,
  pathInput: string,
): ImportPathEditAction {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && pathInput.trim()) return "navigate";
  return null;
}

export function shouldEnterImportPathEdit(
  key: string,
  ctrlKey: boolean,
  focusedInTextInput: boolean,
): boolean {
  return key.toLocaleLowerCase() === "l" && ctrlKey && !focusedInTextInput;
}
