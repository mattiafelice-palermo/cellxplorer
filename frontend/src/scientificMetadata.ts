export function nominalCapacityFromMass(
  activeMassMg: number | null | undefined,
  specificCapacityMahG: number | null | undefined,
): number | null {
  if (
    activeMassMg === null ||
    activeMassMg === undefined ||
    activeMassMg <= 0 ||
    specificCapacityMahG === null ||
    specificCapacityMahG === undefined ||
    specificCapacityMahG <= 0
  ) {
    return null;
  }
  return (activeMassMg * specificCapacityMahG) / 1000;
}
