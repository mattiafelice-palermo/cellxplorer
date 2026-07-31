export type SourceExportValue = number | string | null;

export type SourceExportColumn = {
  header: string;
  values: SourceExportValue[];
};

/** Return the first plotted point belonging to every later source. */
export function sourceBoundaryPointIndices(
  sourcePositions: (number | null)[] | undefined,
  x: (number | null)[],
  y: (number | null)[],
): number[] {
  if (!sourcePositions) return [];
  const indices: number[] = [];
  for (let index = 1; index < sourcePositions.length; index += 1) {
    const position = sourcePositions[index];
    const previous = sourcePositions[index - 1];
    if (
      position !== null &&
      previous !== null &&
      position > previous &&
      x[index] !== null &&
      y[index] !== null &&
      Number.isFinite(x[index] as number) &&
      Number.isFinite(y[index] as number)
    ) {
      indices.push(index);
    }
  }
  return indices;
}

export function sourceExportColumns(
  label: string,
  globalCycle: (number | null)[],
  localCycle: (number | null)[] | undefined,
  sourcePosition: (number | null)[] | undefined,
  sourceFilename: (string | null)[] | undefined,
  sourceHash: (string | null)[] | undefined,
): SourceExportColumn[] {
  if (!localCycle && !sourcePosition && !sourceFilename && !sourceHash) return [];
  return [
    { header: "Cell", values: globalCycle.map(() => label) },
    { header: "Global cycle", values: globalCycle },
    { header: "Local cycle", values: localCycle ?? globalCycle.map(() => null) },
    { header: "Source position", values: sourcePosition ?? globalCycle.map(() => null) },
    { header: "Source file", values: sourceFilename ?? globalCycle.map(() => null) },
    { header: "Source hash", values: sourceHash ?? globalCycle.map(() => null) },
  ];
}
