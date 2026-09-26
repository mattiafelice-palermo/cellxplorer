import { ActionIcon, Badge, Box, Group, Stack, Text, Tooltip } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconMoon, IconSun, IconSunset } from "@tabler/icons-react";
import type { ReactNode } from "react";
import Plot from "./Plot";

export type CellPreviewSurfaceMode = "theme" | "sun" | "gray" | "moon";

type CellPreviewLegendItem = { name: string; color: string };

export function CellPreviewToolbar({
  surfaceMode,
  onSurfaceModeChange,
  children,
  compactChildren,
  compactSecondaryContent,
}: {
  surfaceMode: CellPreviewSurfaceMode;
  onSurfaceModeChange: (mode: CellPreviewSurfaceMode) => void;
  children?: ReactNode;
  compactChildren?: ReactNode;
  compactSecondaryContent?: ReactNode;
}) {
  const { ref: toolbarRef, width } = useElementSize();
  const hasToolbarContent = children !== undefined && children !== null;
  const compact = hasToolbarContent && width > 0 && width < 430;
  const toolbarHeight = hasToolbarContent ? (compact ? 64 : 40) : 28;
  const surfaceControls = (
    <Group
      className="preview-surface-controls"
      justify="flex-end"
      gap={4}
      data-preview-surface-controls=""
      aria-label="Preview plot background"
      h={24}
      style={{ flex: "none" }}
    >
      {([
        { mode: "sun", label: "Light plot background", icon: <IconSun size={14} /> },
        { mode: "gray", label: "Gray plot background", icon: <IconSunset size={14} /> },
        { mode: "moon", label: "Dark plot background", icon: <IconMoon size={14} /> },
      ] as const).map((choice) => (
        <Tooltip key={choice.mode} label={choice.label} withArrow>
          <ActionIcon
            size={24}
            variant="default"
            color={surfaceMode === choice.mode ? "teal" : undefined}
            aria-label={choice.label}
            aria-pressed={surfaceMode === choice.mode}
            style={{ background: "var(--mantine-color-default)" }}
            onClick={() => onSurfaceModeChange(choice.mode)}
          >{choice.icon}</ActionIcon>
        </Tooltip>
      ))}
    </Group>
  );

  return (
    <Box ref={toolbarRef} h={toolbarHeight}>
      {compact ? (
        <Stack gap={0}>
          <Group
            justify={compactSecondaryContent ? "space-between" : "flex-end"}
            gap={4}
            wrap="nowrap"
            h={24}
          >
            {compactSecondaryContent}
            {surfaceControls}
          </Group>
          <Group justify="center" gap="xs" wrap="nowrap" h={40}>
            {compactChildren ?? children}
          </Group>
        </Stack>
      ) : (
        <Group justify="space-between" gap="xs" wrap="nowrap" h={toolbarHeight}>
          <Box style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
            {children}
          </Box>
          {surfaceControls}
        </Group>
      )}
    </Box>
  );
}

/** Shared chart surface for the Add-to-plot picker and staged import previews. */
export function CellPreviewPlot({
  data,
  layout,
  config,
  style,
  surfaceMode,
  onSurfaceModeChange,
  updating = false,
  legend = [],
  toolbarContent,
  showToolbar = true,
}: {
  data: unknown[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
  style: React.CSSProperties;
  surfaceMode: CellPreviewSurfaceMode;
  onSurfaceModeChange: (mode: CellPreviewSurfaceMode) => void;
  updating?: boolean;
  legend?: CellPreviewLegendItem[];
  toolbarContent?: ReactNode;
  showToolbar?: boolean;
}) {
  return (
    <>
      <Box className="preview-plot-surface" style={{ position: "relative" }}>
        {showToolbar && (
          <CellPreviewToolbar
            surfaceMode={surfaceMode}
            onSurfaceModeChange={onSurfaceModeChange}
          >
            {toolbarContent}
          </CellPreviewToolbar>
        )}
        <Plot data={data as never} layout={layout as never} config={config as never} style={style} />
        {updating && <Badge color="gray" variant="filled" role="status" style={{ position: "absolute", top: 8, right: 8, pointerEvents: "none" }}>Updating preview…</Badge>}
      </Box>
      <Group gap="md" justify="center" h={20}>
          {legend.map((item) => (
            <Group gap={5} key={item.name} wrap="nowrap">
              <Box w={16} h={0} style={{ borderTop: `2px solid ${item.color}`, flex: "0 0 auto" }} />
              <Text size="xs">{item.name}</Text>
            </Group>
          ))}
      </Group>
    </>
  );
}
