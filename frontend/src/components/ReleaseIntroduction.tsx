import { ActionIcon, Button, Group, Paper, SegmentedControl, Stack, Text, Title, Tooltip } from "@mantine/core";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import { useMemo, useState, type MouseEvent } from "react";
import { AnalysisSourceLimitations } from "./AnalysisSourceLimitations";
import { ImportedSourceIdentity } from "./ImportedSourceIdentity";
import Plot from "./Plot";
import { CellPreviewPlot, type CellPreviewSurfaceMode } from "./CellPreviewPlot";
import { cellPreviewVoltageLayout, cellPreviewVoltageTraces } from "./cellPreviewPlotModel";
import { SearchIntroduction } from "./SearchIntroduction";
import { DEFAULT_PLOT_STYLE, PALETTE } from "../features/analyses/editor/plotting/plotStyle";
import { hoverLabelLayout, legendLayout, plotAxisStyle } from "../features/analyses/editor/plotting/plotLayout";
import type { Badge } from "../api";
import styles from "./ReleaseIntroduction.module.css";

export const RELEASE_CARDS = [
  { id: "history", title: "Cumulative cycling quantities", description: "Plot cumulative charge and discharge capacity, energy, throughput or net imbalance. Values accumulate over the full Cell history, including cycles outside the displayed range.", location: "Cycles → Quantity" },
  { id: "fec", title: "Equivalent full cycles", description: "Use equivalent full cycles (FEC) as a quantity or X axis. Select combined-throughput or discharge-based normalization. A positive nominal capacity is required for each Cell.", location: "Cycles → Quantity or X axis" },
  { id: "identity", title: "Imported source identification", description: "Already-imported files show their current Cell names in the import browser and source preview. Open cell navigates to the associated Cell.", location: "Load cells → imported source preview" },
  { id: "warnings", title: "Source data limitations", description: "Analysis views group source limitations in a collapsed disclosure. Expand it to identify the affected Cell, source and unavailable quantities. Verified interpretation alone does not produce a warning.", location: "Analysis → source data limitations" },
] as const;

// No catalog, source files or real Cell identifiers are used by these examples.
const EXAMPLE_CELLS = [{ id: -1, name: "NMC · Cell 02" }];
const EXAMPLE_LIMITATIONS: Badge[] = [{
  kind: "exploratory_mpr", cell_id: -1, source_id: -1, cell_name: "NMC · Cell 02",
  file: "source_02.mpr", scientific_interpretation: "exploratory",
  detail: "Cycle identity is unverified; cycle-based quantities are unavailable.",
}];
const CYCLES = Array.from({ length: 200 }, (_, i) => i + 1);
const CONFIG = { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: false };

/** Same Plot wrapper, axes, palette and hover styling used by analysis plots. */
function CyclingExample({ fec, axis }: { fec: boolean; axis: "cycle" | "fec" }) {
  const figure = useMemo(() => {
    const style = DEFAULT_PLOT_STYLE;
    const trace = (name: string, x: number[], y: number[], color: string, dash: "solid" | "dash" = "solid") => ({
      type: "scatter" as const, mode: "lines" as const, name, x, y,
      line: { color, width: style.line_width, dash }, connectgaps: false,
      hovertemplate: "%{x:.3g}<br>%{y:.4g}<extra>" + name + "</extra>",
    });
    let cumulative = 0;
    const throughput = CYCLES.map(cycle => { cumulative += 200 * (1 - 0.0005 * cycle) * 2; return cumulative; });
    // Equal charge/discharge magnitudes; combined-throughput FEC is Q/Qnom.
    // Both synthetic Cells follow the same retention-versus-usage relation.
    const series = (depth: number) => {
      let usage = 0;
      const x: number[] = [], y: number[] = [];
      for (const _cycle of CYCLES) {
        const retention = 100 - 0.08 * usage;
        const directionalCapacity = depth * 200 * retention / 100;
        usage += (directionalCapacity + directionalCapacity) / (2 * 200);
        x.push(usage); y.push(retention);
      }
      return { x, y };
    };
    const full = series(1), half = series(0.5);
    const data = fec ? [
      trace("Full-depth cycling", axis === "fec" ? full.x : CYCLES, full.y, PALETTE[0]),
      trace("Partial-depth cycling", axis === "fec" ? half.x : CYCLES, half.y, PALETTE[1], "dash"),
    ] : [trace("Capacity throughput", CYCLES, throughput, PALETTE[0])];
    const layout: Partial<Plotly.Layout> = {
      autosize: true, height: 300, margin: { l: 65, r: 18, t: 18, b: 95 },
      paper_bgcolor: style.paper_bgcolor, plot_bgcolor: style.plot_bgcolor,
      font: { size: style.tick_font_size, color: "#212529" },
      xaxis: { ...plotAxisStyle(style), automargin: true, title: { text: fec && axis === "fec" ? "Equivalent full cycles" : "Cycle", font: { size: style.axis_title_size } }, ...(!fec ? { range: [80, 140] } : {}) },
      yaxis: { ...plotAxisStyle(style), automargin: true, title: { text: fec ? "Discharge capacity retention (%)" : "Capacity throughput (mAh)", font: { size: style.axis_title_size } } },
      showlegend: fec, legend: { ...legendLayout(style), y: -0.42, font: { size: style.legend_font_size } },
      hoverlabel: hoverLabelLayout(style), uirevision: fec ? axis : "full-history",
    };
    return { data, layout };
  }, [fec, axis]);
  return <Plot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 300 }} useResizeHandler />;
}

/** Actual import-preview graph, including voltage/current subplots and background controls. */
function VoltageExample() {
  const [surfaceMode, setSurfaceMode] = useState<CellPreviewSurfaceMode>("sun");
  const figure = useMemo(() => {
    const dark = surfaceMode === "moon";
    const colors = { background: dark ? "#171923" : surfaceMode === "gray" ? "#f1f3f5" : "#ffffff", text: dark ? "#e9ecef" : "#212529", border: dark ? "#868e96" : "#495057", grid: dark ? "#373a40" : "#e9ecef" };
    const points = Array.from({ length: 161 }, (_, i) => i);
    const voltage = points.map(i => {
      const phase = (i % 80) / 80;
      const charge = phase < 0.5;
      const stateOfCharge = charge ? phase * 2 : 2 - phase * 2;
      return 3.2 + 0.6 * stateOfCharge + 0.2 * Math.tanh((stateOfCharge - 0.5) * 6) + (charge ? 0.08 : -0.08);
    });
    const layout = cellPreviewVoltageLayout(colors, "Time (h)", "release-example-" + surfaceMode);
    return {
      data: cellPreviewVoltageTraces([{ x: points.map(i => i * 0.05), voltage, current: points.map(i => i % 80 < 40 ? 100 : -100), name: "Synthetic Cell", breakBefore: [72, 80] }]),
      layout: { ...layout, yaxis2: { ...layout.yaxis2, nticks: 3 } },
    };
  }, [surfaceMode]);
  return <CellPreviewPlot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 352 }} surfaceMode={surfaceMode} onSurfaceModeChange={setSurfaceMode} />;
}

export function ReleaseIntroduction({ onClose, onChooseFolders, reducedMotion }: {
  onClose: () => void; onChooseFolders: () => void; reducedMotion: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [axis, setAxis] = useState<"cycle" | "fec">("cycle");
  const [guide, setGuide] = useState(false);
  const card = RELEASE_CARDS[index];
  // Production identity/limitation panels contain links. Block all navigation in
  // synthetic examples, including modifier-clicks; no real Cell can be opened.
  const blockExampleNavigation = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("a")) { event.preventDefault(); event.stopPropagation(); }
  };
  if (guide) return <Stack gap="sm" className={styles.surface}>
    <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={() => setGuide(false)} style={{ alignSelf: "flex-start" }}>Back to release cards</Button>
    <SearchIntroduction onClose={onClose} onChooseFolders={onChooseFolders} reducedMotion={reducedMotion} />
  </Stack>;
  return <Stack gap="md" className={styles.surface}>
    <div className={styles.work + " cx-vertical-scroll"} role="region" aria-label="Release card content" tabIndex={0}>
      <Stack gap="md">
        <header aria-live="polite" aria-atomic="true">
          <Title order={3}>{card.title}</Title>
          <Text size="sm" c="dimmed" mt="xs">{card.description}</Text>
        </header>
        <Paper withBorder p="sm" className={styles.example} onClickCapture={blockExampleNavigation} onAuxClickCapture={blockExampleNavigation}>
          <Stack gap="sm">
            <Text size="xs" c="dimmed">Synthetic data · example only{card.id === "identity" || card.id === "warnings" ? " · Cell links are inactive" : ""}</Text>
            {card.id === "history" && <>
              <CyclingExample fec={false} axis="cycle" />
              <Text size="xs" c="dimmed">Cycles 80–140 displayed; throughput includes cycles 1–79.</Text>
            </>}
            {card.id === "fec" && <>
              <SegmentedControl aria-label="Example X axis" value={axis} onChange={value => setAxis(value as "cycle" | "fec")} data={[{ value: "cycle", label: "Cycle" }, { value: "fec", label: "FEC" }]} />
              <CyclingExample fec axis={axis} />
              <Text size="xs" c="dimmed">Combined-throughput convention; nominal capacity 200 mAh. Illustrative full-depth and half-depth cycling.</Text>
            </>}
            {card.id === "identity" && <>
              <Text size="sm">NMC_02_cycling.ndax</Text>
              <ImportedSourceIdentity cells={EXAMPLE_CELLS} onOpen={() => undefined} />
            </>}
            {card.id === "warnings" && <>
              <AnalysisSourceLimitations badges={EXAMPLE_LIMITATIONS} />
              <Text size="xs" c="dimmed">Source preview · synthetic voltage and current</Text>
              <VoltageExample />
            </>}
          </Stack>
        </Paper>
        <Text size="xs" c="dimmed">{card.location}</Text>
      </Stack>
    </div>
    <Stack gap="xs" className={styles.footer}>
      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed" aria-live="polite">{index + 1} of {RELEASE_CARDS.length}</Text>
        <Group gap={4} component="nav" aria-label="Release cards">
          {RELEASE_CARDS.map((item, step) => <Tooltip key={item.id} label={item.title}>
            <ActionIcon size="sm" variant={step === index ? "filled" : "default"} aria-label={item.title} aria-current={step === index ? "step" : undefined} onClick={() => setIndex(step)}>{step + 1}</ActionIcon>
          </Tooltip>)}
        </Group>
        <Group gap="xs">
          <Button size="sm" variant="default" leftSection={<IconArrowLeft size={16} />} disabled={index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>Previous</Button>
          <Button size="sm" rightSection={index < RELEASE_CARDS.length - 1 ? <IconArrowRight size={16} /> : undefined} onClick={() => index === RELEASE_CARDS.length - 1 ? onClose() : setIndex(value => Math.min(RELEASE_CARDS.length - 1, value + 1))}>{index === RELEASE_CARDS.length - 1 ? "Done" : "Next"}</Button>
        </Group>
      </Group>
      <Group justify="space-between" gap="xs">
        <Button size="compact-sm" variant="subtle" onClick={onClose}>Skip tour</Button>
        <Button size="compact-sm" variant="subtle" onClick={() => setGuide(true)}>File search guide</Button>
      </Group>
    </Stack>
  </Stack>;
}
