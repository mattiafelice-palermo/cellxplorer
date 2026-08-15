export type CachedPlotThumbnailResponse = {
  thumbnail: string;
  data_signature?: string;
  plot_modified_at?: string | null;
};

/** A 404 is a terminal unavailable state for the previous thumbnail identity. */
export function normalizeCachedPlotThumbnailResponse(
  response: CachedPlotThumbnailResponse | undefined,
  errorStatus?: number,
): CachedPlotThumbnailResponse | null {
  if (errorStatus === 404 || !response) return null;
  return response;
}
