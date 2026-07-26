import { Badge, Box, Button, Center, Group, Paper, Stack, Text } from "@mantine/core";
import { IconDeviceFloppy } from "@tabler/icons-react";
import type { ReactNode } from "react";

import type { AnalysisDraftPlot, AnalysisTabKey } from "../api";

function tabLabel(tab: AnalysisTabKey): string {
  switch (tab) {
    case "cycles":
      return "Cycles";
    case "steps":
      return "Steps";
    case "dcir":
      return "DCIR";
    case "chargeability":
      return "Chargeability";
    case "crate":
      return "C-rate";
    case "recap":
      return "Recap";
    case "time_capacity":
      return "Time/capacity";
    default:
      return tab;
  }
}

export function DraftPlotCard({
  draft,
  liveUnsaved,
  activeTab,
  preview,
  onOpen,
  onSave,
}: {
  draft: AnalysisDraftPlot | null | undefined;
  liveUnsaved: boolean;
  activeTab: AnalysisTabKey;
  /** Saved-plot thumbnail pipeline (SavedPlotPreview / SavedTimeCapacityPreview). */
  preview?: ReactNode;
  onOpen: () => void;
  onSave: () => void;
}) {
  if (!draft && !liveUnsaved) return null;
  const tab = draft?.tab ?? activeTab;
  const title = draft?.name?.trim() || "Unsaved plot";

  return (
    <Paper
      p="sm"
      withBorder
      mb="sm"
      style={{
        border: "1px solid var(--mantine-color-yellow-3)",
        background: "light-dark(color-mix(in srgb, var(--mantine-color-yellow-1) 35%, white), color-mix(in srgb, var(--mantine-color-yellow-9) 22%, transparent))",
      }}
    >
      <Box
        p="xs"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        style={{ borderRadius: 8, cursor: "pointer" }}
      >
        <Group align="stretch" wrap="nowrap">
          <Box
            className="cx-plot-thumbnail-frame"
            w={260}
            style={{
              flexShrink: 0,
              border: "1px solid var(--mantine-color-yellow-3)",
              background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
            }}
          >
            {preview ?? (
              <Center h={130}>
                <Text size="xs" c="dimmed">
                  Draft preview
                </Text>
              </Center>
            )}
          </Box>
          <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
            <Group gap={6}>
              <Badge size="xs" variant="light" color="yellow">
                DRAFT
              </Badge>
              <Badge size="xs" variant="light" color="gray">
                {tabLabel(tab)}
              </Badge>
              <Text fw={700} truncate>
                {title}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Temporary — save it before closing this tab or opening another plot.
            </Text>
          </Stack>
          <Stack gap={6} justify="center" w={120} onClick={(event) => event.stopPropagation()}>
            <Button
              size="compact-xs"
              leftSection={<IconDeviceFloppy size={12} />}
              onClick={onSave}
            >
              Save as new plot
            </Button>
          </Stack>
        </Group>
      </Box>
    </Paper>
  );
}
