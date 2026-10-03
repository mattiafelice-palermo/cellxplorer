/** Shared renderer, Appearance and visibility eligibility for replicate members. */
export function cycleCellIsDisplayed(
  result: { aggregates: readonly { group_id: number }[] },
  series: { group_id: number | null },
  showIndividual: boolean,
): boolean {
  return series.group_id === null || showIndividual ||
    !result.aggregates.some((aggregate) => aggregate.group_id === series.group_id);
}

export function hasFiniteCycleValues(values: readonly (number | null)[] | undefined): boolean {
  return Boolean(values?.some((value) => value !== null && Number.isFinite(value)));
}
