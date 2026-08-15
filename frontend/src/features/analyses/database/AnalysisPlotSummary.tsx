import {
  Box,
  Group,
  HoverCard,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, get, type AnalysisSavedPlotSummary } from "../../../api";
import { normalizeCachedPlotThumbnailResponse } from "../editor/policies/plotThumbnailResponsePolicy";

export type AnalysisPlotPreviewSource = {
  id: number;
  title: string;
  saved_plots: AnalysisSavedPlotSummary[];
  modified_at?: string | null;
  sources_changed?: boolean;
};

function humanize(value: string): string {
  if (!value) return "Unspecified";
  const words = value.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function formatTab(value: string): string {
  if (value === "time_capacity") return "Time / capacity";
  if (value === "c_rate") return "C-rate";
  return humanize(value);
}

function CachedPlotThumbnail({
  analysisId,
  plotId,
  analysisModifiedAt,
  sourcesChanged,
}: {
  analysisId: number;
  plotId: string;
  analysisModifiedAt?: string | null;
  sourcesChanged?: boolean;
}) {
  const thumbnail = useQuery({
    queryKey: [
      "analysis-database-thumbnail",
      analysisId,
      plotId,
      analysisModifiedAt ?? null,
      Boolean(sourcesChanged),
    ],
    queryFn: async () => {
      try {
        const response = await get<{
          thumbnail: string;
          data_signature?: string;
          plot_modified_at?: string | null;
        }>(
          `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}/thumbnail/latest`
            + "?variant=preview"
        );
        return normalizeCachedPlotThumbnailResponse(response);
      } catch (error) {
        // A changed source or saved-plot revision makes the previous asset
        // unavailable. Resolve that state to null so React Query cannot keep
        // rendering the old image after the server returns 404.
        if (error instanceof ApiError && error.status === 404) {
          return normalizeCachedPlotThumbnailResponse(undefined, 404);
        }
        throw error;
      }
    },
    staleTime: Infinity,
    retry: false,
    refetchInterval: (query) => query.state.data?.thumbnail ? false : 3_000,
  });
  if (thumbnail.data?.thumbnail) {
    return (
      <Box
        className="cx-plot-thumbnail-frame"
        w="100%"
        h="100%"
        style={{ display: "grid", placeItems: "center" }}
      >
        <Box
          component="img"
          className="cx-plot-thumbnail"
          src={thumbnail.data.thumbnail}
          alt="Cached plot preview"
          maw="100%"
          mah="100%"
          style={{ display: "block" }}
        />
      </Box>
    );
  }
  return (
    <Text size="xs" c="dimmed" ta="center">
      {thumbnail.isLoading ? "Loading preview..." : "Preview not cached"}
    </Text>
  );
}

/**
 * Shared saved-plot count and hover preview used by the Analysis Database and
 * Projects explorer. Keep the two surfaces on this component so their plot
 * ordering, 4:3 preview asset, loading state, and open behavior cannot drift.
 */
export function AnalysisPlotSummary<T extends AnalysisPlotPreviewSource>({
  analysis,
  onOpenPlot,
}: {
  analysis: T;
  onOpenPlot: (analysis: T, plot: AnalysisSavedPlotSummary, background: boolean) => void;
}) {
  const plots = analysis.saved_plots ?? [];
  const count = plots.length;
  const [hoveredPlotId, setHoveredPlotId] = useState(plots[0]?.id ?? null);
  const hoveredPlot = plots.find((plot) => plot.id === hoveredPlotId) ?? plots[0];
  if (!count) return <Text size="sm" c="dimmed">No plots</Text>;
  return (
    <HoverCard
      width={760}
      shadow="md"
      position="right"
      openDelay={160}
      closeDelay={120}
      withinPortal
    >
      <HoverCard.Target>
        <UnstyledButton onClick={(event) => event.stopPropagation()}>
          <Text size="sm" td="underline" style={{ textDecorationStyle: "dotted" }}>
            {count} plot{count === 1 ? "" : "s"}
          </Text>
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Group align="stretch" gap="md" wrap="nowrap">
          <Stack gap={4} w={330} mah={330} style={{ overflowY: "auto" }}>
            {plots.map((plot) => (
              <UnstyledButton
                key={plot.id}
                p="xs"
                onMouseEnter={() => setHoveredPlotId(plot.id)}
                onFocus={() => setHoveredPlotId(plot.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenPlot(analysis, plot, event.ctrlKey || event.metaKey);
                }}
                style={{
                  borderRadius: 5,
                  background:
                    hoveredPlot?.id === plot.id
                      ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))"
                      : undefined,
                }}
              >
                <Text size="sm" fw={600}>{plot.name}</Text>
                <Text size="xs" c="dimmed">
                  {formatTab(plot.tab)} - {plot.subtitle || humanize(plot.quantity)}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
          <Box w={390} style={{ flexShrink: 0 }}>
            <Box
              bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
              style={{
                aspectRatio: "4 / 3",
                display: "grid",
                placeItems: "center",
                overflow: "hidden",
              }}
            >
              {hoveredPlot ? (
                <CachedPlotThumbnail
                  analysisId={analysis.id}
                  plotId={hoveredPlot.id}
                  analysisModifiedAt={analysis.modified_at}
                  sourcesChanged={analysis.sources_changed}
                />
              ) : null}
            </Box>
            <Text size="xs" c="dimmed" mt={6} truncate>{hoveredPlot?.name}</Text>
          </Box>
        </Group>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
