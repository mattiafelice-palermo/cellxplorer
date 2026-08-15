/** Shared scientific-identity guards used by saved-preview and portable consumers. */

export type SavedPreviewQueryRoot = "saved-plot-preview" | "saved-time-preview";

export function previewQueryRootForPlot(tab: string): SavedPreviewQueryRoot {
  return tab === "time_capacity" ? "saved-time-preview" : "saved-plot-preview";
}

export function artifactDataSignatureForWrite(
  artifactDataSignature: string | undefined,
  warmupExpectedDataSignature?: string,
): string {
  if (!artifactDataSignature) {
    throw new Error("The computed plot has no server-owned scientific signature.");
  }
  if (
    warmupExpectedDataSignature &&
    warmupExpectedDataSignature !== artifactDataSignature
  ) {
    throw new Error("The warmup result belongs to a superseded scientific identity.");
  }
  return artifactDataSignature;
}

export function serverArtifactMatchesExpectedData(
  expectedDataSignature: string,
  storedDataSignature: string | undefined,
): boolean {
  return storedDataSignature === expectedDataSignature;
}

export function portableResultDataSignature(
  resultDataSignature: string | undefined,
): string {
  if (!resultDataSignature) {
    throw new Error(
      "The computed portable plot has no server-owned scientific signature.",
    );
  }
  return resultDataSignature;
}
