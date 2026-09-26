import { ActionIcon, Badge, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconMoon, IconSun, IconSunset } from "@tabler/icons-react";
import Plot from "./Plot";

export type CellPreviewSurfaceMode = "theme" | "sun" | "gray" | "moon";

type CellPreviewLegendItem = { name: string; color: string };

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
}: {
  data: unknown[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
  style: React.CSSProperties;
  surfaceMode: CellPreviewSurfaceMode;
  onSurfaceModeChange: (mode: CellPreviewSurfaceMode) => void;
  updating?: boolean;
  legend?: CellPreviewLegendItem[];
}) {
  return (
    <>
      <Box className="preview-plot-surface" style={{ position: "relative" }}>
        <Group className="preview-surface-controls" justify="flex-end" gap="xs" h={28} data-preview-surface-controls="" aria-label="Preview plot background">
          {([
            { mode: "sun", label: "Light plot background", icon: <IconSun size={15} /> },
            { mode: "gray", label: "Gray plot background", icon: <IconSunset size={15} /> },
            { mode: "moon", label: "Dark plot background", icon: <IconMoon size={15} /> },
          ] as const).map((choice) => (
            <Tooltip key={choice.mode} label={choice.label} withArrow>
              <ActionIcon
                size="sm"
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
