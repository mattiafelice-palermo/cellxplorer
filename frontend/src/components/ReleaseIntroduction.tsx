import { ActionIcon, Button, Group, Paper, SegmentedControl, Stack, Text, Title, Tooltip, UnstyledButton } from "@mantine/core";
import { IconArrowLeft, IconArrowRight, IconChartLine, IconFile, IconInfoCircle, IconSearch } from "@tabler/icons-react";
import { useMemo, useState, type MouseEvent } from "react";
import { AnalysisSourceLimitations } from "./AnalysisSourceLimitations";
import { ImportedSourceIdentity } from "./ImportedSourceIdentity";
import Plot from "./Plot";
import { cellPreviewVoltageTraces } from "./cellPreviewPlotModel";
import { SearchIntroduction } from "./SearchIntroduction";
import { DEFAULT_PLOT_STYLE, PALETTE } from "../features/analyses/editor/plotting/plotStyle";
import { hoverLabelLayout, plotAxisStyle } from "../features/analyses/editor/plotting/plotLayout";
import type { Badge } from "../api";
import styles from "./ReleaseIntroduction.module.css";

export const RELEASE_CARDS = [
  { id: "history", category: "Cycle analysis", title: "Cumulative cycling quantities", description: "Cumulative capacity, energy, throughput and net imbalance use the full Cell history, including cycles outside the displayed range.", location: "Cycles → Quantity" },
  { id: "fec", category: "Cycle normalization", title: "Equivalent full cycles", description: "FEC normalizes cycling throughput by a positive, fixed nominal capacity. Use it on either axis, with a combined-throughput or discharge-based convention.", location: "Cycles → Quantity or X axis" },
  { id: "identity", category: "Import browser", title: "Imported source identification", description: "Imported sources display their current Cell names. Use Open cell in the import browser or source preview to inspect the associated Cell.", location: "Load cells → imported source preview" },
  { id: "warnings", category: "Source interpretation", title: "Source data limitations", description: "Source limitations are grouped by affected Cell and file. Expand the notice to inspect consequences and open source details.", location: "Analysis → source data limitations" },
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

function exampleLayout(xTitle: string, yTitle: string, height: number): Partial<Plotly.Layout> {
  const style = DEFAULT_PLOT_STYLE;
  const axis = (title: string) => ({ ...plotAxisStyle(style), automargin: true,
    title: { text: title, font: { size: style.axis_title_size }, standoff: 8 } });
  return {
    autosize: true, height, margin: { l: 66, r: 18, t: 20, b: 42 },
    paper_bgcolor: style.paper_bgcolor, plot_bgcolor: style.plot_bgcolor,
    font: { size: style.tick_font_size, color: "#212529" },
    xaxis: axis(xTitle), yaxis: axis(yTitle), showlegend: false,
    hoverlabel: hoverLabelLayout(style),
  };
}

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
    const layout = exampleLayout(fec && axis === "fec" ? "Equivalent full cycles" : "Cycle", fec ? "Capacity retention (%)" : "Throughput (mAh)", 188);
    layout.uirevision = fec ? axis : "full-history";
    if (!fec) {
      layout.xaxis = { ...layout.xaxis, range: [0, 200] };
      layout.shapes = [{ type: "rect", xref: "x", yref: "paper", x0: 80, x1: 140, y0: 0, y1: 1,
        fillcolor: "rgba(121,80,242,0.08)", line: { width: 0 }, layer: "below" }];
      layout.annotations = [{ x: 110, y: 1, xref: "x", yref: "paper", text: "Display window", showarrow: false, yanchor: "top", font: { size: 11 } }];
    }
    return { data, layout };
  }, [fec, axis]);
  return <>
    <Plot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 188 }} useResizeHandler />
    {fec && <Group gap="md" justify="center" className={styles.legend}>
      <Text size="xs"><span className={styles.legendLine} style={{ borderColor: PALETTE[0] }} />Full-depth cycling</Text>
      <Text size="xs"><span className={styles.legendLine} style={{ borderColor: PALETTE[1], borderTopStyle: "dashed" }} />Partial-depth cycling</Text>
    </Group>}
  </>;
}

/** Real Plot renderer and production voltage trace builder; no invented editor chrome. */
function VoltageExample() {
  const figure = useMemo(() => {
    const points = Array.from({ length: 161 }, (_, i) => i);
    const voltage = points.map(i => {
      const phase = (i % 80) / 80;
      const charge = phase < 0.5;
      const stateOfCharge = charge ? phase * 2 : 2 - phase * 2;
      return 3.2 + 0.6 * stateOfCharge + 0.2 * Math.tanh((stateOfCharge - 0.5) * 6) + (charge ? 0.08 : -0.08);
    });
    return {
      data: cellPreviewVoltageTraces([{ x: points.map(i => i * 0.05), voltage, name: "Synthetic Cell", breakBefore: [72, 80] }]),
      layout: exampleLayout("Time (h)", "Voltage (V)", 152),
    };
  }, []);
  return <Plot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 152 }} useResizeHandler />;
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
  if (guide) return <Stack gap="sm" className={styles.surface + " " + styles.guide}>
    <Button autoFocus variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={() => setGuide(false)} style={{ alignSelf: "flex-start" }}>Back to release cards</Button>
    <SearchIntroduction onClose={onClose} onChooseFolders={onChooseFolders} reducedMotion={reducedMotion} />
  </Stack>;
  return <Stack gap={0} className={styles.surface}>
    <div className={styles.work + " cx-vertical-scroll"} role="region" aria-label="Release card content" tabIndex={0}>
      <Stack gap={0}>
        <header className={styles.intro} aria-live="polite" aria-atomic="true">
          <Text size="xs" fw={700} tt="uppercase" className={styles.category}>{card.category}</Text>
          <Title order={3} className={styles.headline}>{card.title}</Title>
          <Text size="sm" c="dimmed" className={styles.description}>{card.description}</Text>
        </header>
        <Paper withBorder className={styles.example} onClickCapture={blockExampleNavigation} onAuxClickCapture={blockExampleNavigation}>
          <Text size="xs" c="dimmed" className={styles.exampleLabel}>Synthetic example{card.id === "identity" || card.id === "warnings" ? " · links inactive" : ""}</Text>
            {card.id === "history" && <>
              <Paper withBorder className={styles.plotPanel}>
              <Group className={styles.panelHeader} justify="space-between" gap="xs"><Group gap={6}><IconChartLine size={14} /><Text size="xs" fw={600}>Capacity throughput</Text></Group><Text size="xs" c="dimmed">Full Cell history</Text></Group>
              <CyclingExample fec={false} axis="cycle" />
              <Text size="xs" c="dimmed" className={styles.panelNote}>The highlighted display range does not reset the total.</Text>
              </Paper>
            </>}
            {card.id === "fec" && <>
              <Paper withBorder className={styles.plotPanel}>
              <Group className={styles.panelHeader} justify="space-between" gap="xs"><Text size="xs" fw={600}>Discharge capacity retention</Text>
                <SegmentedControl size="xs" aria-label="Example X axis" value={axis} onChange={value => setAxis(value as "cycle" | "fec")} data={[{ value: "cycle", label: "Cycle" }, { value: "fec", label: "FEC" }]} />
              </Group>
              <CyclingExample fec axis={axis} />
              <Text size="xs" c="dimmed" className={styles.panelNote}>Combined-throughput FEC · nominal capacity: 200 mAh</Text>
              </Paper>
            </>}
            {card.id === "identity" && <>
              <div className={styles.identity}>
                <Paper withBorder p="md" className={styles.filePanel}>
                  <Group gap="xs"><IconFile size={18} /><Text size="xs" c="dimmed">Source file</Text></Group>
                  <Text size="sm" fw={600} mt="xs" style={{ overflowWrap: "anywhere" }}>NMC_02_cycling.ndax</Text>
                  <Text size="xs" c="dimmed" mt={4}>Already imported</Text>
                </Paper>
                <IconArrowRight size={18} className={styles.connector} aria-hidden />
                <div className={styles.identityPanel}><ImportedSourceIdentity cells={EXAMPLE_CELLS} onOpen={() => undefined} /></div>
              </div>
            </>}
            {card.id === "warnings" && <>
              <Stack gap="sm" className={styles.warningExample}>
                <Paper withBorder className={styles.plotPanel}><VoltageExample /></Paper>
                <Paper withBorder p="sm" className={styles.limitationPanel}><AnalysisSourceLimitations badges={EXAMPLE_LIMITATIONS} /></Paper>
              </Stack>
            </>}
        </Paper>
        <Group justify="center" gap={6} className={styles.location}>
          <IconInfoCircle size={14} aria-hidden /><Text size="xs" c="dimmed">{card.location}</Text>
          <Tooltip label="File search guide"><ActionIcon size="sm" variant="subtle" aria-label="File search guide" onClick={() => setGuide(true)}><IconSearch size={14} /></ActionIcon></Tooltip>
        </Group>
      </Stack>
    </div>
    <div className={styles.footer}>
      <Button className={styles.skip} size="compact-sm" variant="subtle" color="gray" onClick={onClose}>Skip tour</Button>
      <Group gap={6} className={styles.progress} wrap="nowrap">
        <Text size="xs" c="dimmed" aria-live="polite" style={{ whiteSpace: "nowrap" }}>{index + 1} of {RELEASE_CARDS.length}</Text>
        <Group gap={0} component="nav" aria-label="Release cards" wrap="nowrap">
          {RELEASE_CARDS.map((item, step) => <Tooltip key={item.id} label={item.title}>
            <UnstyledButton className={styles.dot} aria-label={item.title} aria-current={step === index ? "step" : undefined} onClick={() => setIndex(step)}><span /></UnstyledButton>
          </Tooltip>)}
        </Group>
      </Group>
      <Group gap="xs" className={styles.actions} wrap="nowrap">
          <Button size="sm" variant="default" leftSection={<IconArrowLeft size={16} />} disabled={index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>Previous</Button>
          <Button size="sm" rightSection={index < RELEASE_CARDS.length - 1 ? <IconArrowRight size={16} /> : undefined} onClick={() => index === RELEASE_CARDS.length - 1 ? onClose() : setIndex(value => Math.min(RELEASE_CARDS.length - 1, value + 1))}>{index === RELEASE_CARDS.length - 1 ? "Done" : "Next"}</Button>
      </Group>
    </div>
  </Stack>;
}
