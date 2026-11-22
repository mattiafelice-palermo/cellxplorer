import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBell,
  IconCheck,
  IconDownload,
  IconFileImport,
  IconFlask,
  IconFolderOpen,
  IconInfoCircle,
  IconPower,
  IconRefresh,
  IconSearch,
  IconTable,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState, type MouseEvent } from "react";
import Plot from "./Plot";
import { cellPreviewVoltageTraces } from "./cellPreviewPlotModel";
import { SearchIntroduction } from "./SearchIntroduction";
import { DEFAULT_PLOT_STYLE, PALETTE } from "../features/analyses/editor/plotting/plotStyle";
import { hoverLabelLayout, plotAxisStyle } from "../features/analyses/editor/plotting/plotLayout";
import styles from "./ReleaseIntroduction.module.css";

export const RELEASE_CARDS = [
  {
    id: "maccor",
    category: "New cycler format",
    title: "Maccor text and native binary imports",
    description:
      "Import Maccor tab-separated .txt exports and native 4608 numbered channel files (.001–.999) with signed current, voltage, capacity, and complete-cycle summaries.",
    location: "Load cells → Maccor .txt or .001–.999",
  },
  {
    id: "analysis",
    category: "Analysis & plots",
    title: "Discharge-first pairing, Days axis & cycle jump",
    description:
      "Pair cycles as Discharge → Charge, plot time in Days, and jump straight to earlier cycles with one click when shorter cells sit outside the current range.",
    location: "Time / capacity & Cycles → Pairing & X axis",
  },
  {
    id: "imports",
    category: "Folder & network imports",
    title: "Faster remote imports, live phases & Cancel",
    description:
      "Network folders scan much faster with upfront compatibility checks, dedicated progress bars for every stage, and a working Cancel button.",
    location: "Load cells → Folder scan, inspection & registration",
  },
  {
    id: "biologic",
    category: "BioLogic EC-Lab",
    title: "Unit-aware mass picker & resilient .mpr reading",
    description:
      "Pick an EC-Lab recorded specimen mass directly, open readable .mpr files in Permissive mode by default, and keep Modulo Bat curves across EIS gaps.",
    location: "Load cells & Cell details → BioLogic .mpr",
  },
  {
    id: "platform",
    category: "Everyday experience",
    title: "Auto-updating files, smoother app & lighter setup",
    description:
      "Running tests now update automatically by default, large libraries feel snappier with paginated tables, and the Windows installer is 37% smaller.",
    location: "Settings → Source monitoring & App updates",
  },
] as const;

const CONFIG = { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: false };

/** Realistic NMC/graphite equilibrium voltage profile (V) vs state of charge in [0, 1]. */
function syntheticNmcOcv(soc: number): number {
  const s = Math.max(0, Math.min(1, soc));
  const lowerKnee = 0.35 * (1 - Math.exp(-s / 0.09));
  const plateau =
    0.46 * s +
    0.045 * Math.tanh((s - 0.25) * 10) +
    0.03 * Math.tanh((s - 0.65) * 9);
  const upperRise = 0.11 * Math.pow(s, 3.0);
  return 3.22 + lowerKnee + plateau + upperRise;
}

type TraceBuffers = {
  x: number[];
  voltage: number[];
  current: number[];
};

/** Append one realistic CC-CV charge (+ optional post-charge rest) to trace buffers. */
function appendChargeSegment(
  buf: TraceBuffers,
  tStart: number,
  ccHours: number,
  cvHours: number,
  restHours: number,
  currentMa: number,
  irOhm: number,
  endSoc = 0.92,
) {
  const push = (t: number, v: number, c: number) => {
    buf.x.push(Number(t.toFixed(4)));
    buf.voltage.push(Number(v.toFixed(4)));
    buf.current.push(Number(c.toFixed(4)));
  };

  const ccSteps = Math.max(16, Math.round(ccHours * 8));
  const vIr = currentMa * irOhm;
  let lastV = 3.15;
  for (let i = 0; i <= ccSteps; i++) {
    const f = i / ccSteps;
    const soc = 0.02 + f * (endSoc - 0.02);
    const vRaw = syntheticNmcOcv(soc) + vIr * (0.75 + 0.5 * f * f);
    lastV = Math.min(4.2, vRaw);
    push(tStart + f * ccHours, lastV, currentMa);
    if (lastV >= 4.2 && cvHours > 0) {
      // Smoothly transition into CV hold right as upper cutoff is reached.
      break;
    }
  }

  const cvStart = buf.x[buf.x.length - 1] ?? tStart + ccHours;
  if (cvHours > 0) {
    const cvSteps = Math.max(8, Math.round(cvHours * 10));
    for (let i = 1; i <= cvSteps; i++) {
      const f = i / cvSteps;
      const taper = currentMa * Math.exp(-2.6 * f);
      push(cvStart + f * cvHours, 4.2, taper);
    }
  }

  const restStart = (cvHours > 0 ? cvStart + cvHours : buf.x[buf.x.length - 1] ?? tStart + ccHours);
  if (restHours > 0) {
    const restSteps = 8;
    const topV = buf.voltage[buf.voltage.length - 1] ?? 4.2;
    const settleV = Math.max(4.11, topV - 0.068);
    for (let i = 0; i <= restSteps; i++) {
      const f = i / restSteps;
      const vRelax = settleV + (topV - settleV) * Math.exp(-3.4 * f);
      push(restStart + f * restHours, vRelax, 0);
    }
    return restStart + restHours;
  }
  return restStart;
}

/** Append one realistic CC discharge (+ optional post-discharge rebound rest) to trace buffers. */
function appendDischargeSegment(
  buf: TraceBuffers,
  tStart: number,
  ccHours: number,
  restHours: number,
  currentMa: number,
  irOhm: number,
  depth = 1.0,
) {
  const push = (t: number, v: number, c: number) => {
    buf.x.push(Number(t.toFixed(4)));
    buf.voltage.push(Number(v.toFixed(4)));
    buf.current.push(Number(c.toFixed(4)));
  };

  const ccSteps = Math.max(18, Math.round(ccHours * 8));
  const vIr = currentMa * irOhm;
  const startSoc = 0.96 * depth;
  for (let i = 0; i <= ccSteps; i++) {
    const f = i / ccSteps;
    const soc = Math.max(0, startSoc * (1 - f));
    const endKnee = 0.28 * Math.exp(-soc / 0.045);
    const vRaw = syntheticNmcOcv(soc) - vIr * (0.7 + 0.45 * Math.pow(f, 2)) - endKnee;
    const v = Math.max(2.8, Math.min(4.16, vRaw));
    push(tStart + f * ccHours, v, -currentMa);
    if (v <= 2.8) break;
  }

  const restStart = buf.x[buf.x.length - 1] ?? tStart + ccHours;
  if (restHours > 0) {
    const restSteps = 8;
    const bottomV = buf.voltage[buf.voltage.length - 1] ?? 2.8;
    const reboundV = Math.min(3.15, bottomV + 0.32);
    for (let i = 0; i <= restSteps; i++) {
      const f = i / restSteps;
      const vRelax = reboundV - (reboundV - bottomV) * Math.exp(-3.2 * f);
      push(restStart + f * restHours, vRelax, 0);
    }
    return restStart + restHours;
  }
  return restStart;
}

function exampleLayout(
  xTitle: string,
  yTitle: string,
  height: number,
  margin: Partial<Plotly.Margin> = { l: 60, r: 18, t: 16, b: 40 },
): Partial<Plotly.Layout> {
  const style = DEFAULT_PLOT_STYLE;
  const axis = (title: string) => ({
    ...plotAxisStyle(style),
    automargin: true,
    title: { text: title, font: { size: style.axis_title_size }, standoff: 6 },
  });
  return {
    autosize: true,
    height,
    margin,
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
    font: { size: style.tick_font_size, color: "#212529" },
    xaxis: axis(xTitle),
    yaxis: axis(yTitle),
    showlegend: false,
    hoverlabel: hoverLabelLayout(style),
  };
}

/** Realistic Maccor two-pane voltage/current preview with 2 complete cycles + partial 3rd tail. */
function MaccorExample({ mode }: { mode: "binary" | "text" }) {
  const figure = useMemo(() => {
    const style = DEFAULT_PLOT_STYLE;
    const currentMa = mode === "binary" ? 5.0 : 4.2;
    const stepScale = mode === "binary" ? 1.0 : 1.18;
    const ir = mode === "binary" ? 0.015 : 0.014;

    const buf: TraceBuffers = { x: [], voltage: [], current: [] };
    let t = 0;
    // Cycle 1 & Cycle 2 (CC-CV charge -> rest -> CC discharge -> rest)
    for (let c = 0; c < 2; c++) {
      const fade = 1 - c * 0.035;
      t = appendChargeSegment(buf, t, 3.4 * stepScale * fade, 0.75 * stepScale, 0.35, currentMa, ir);
      t = appendDischargeSegment(buf, t, 3.6 * stepScale * fade, 0.35, currentMa, ir, fade);
    }
    // Interrupted 3rd cycle partial charge preserved cleanly (~55% depth)
    const partialStart = t;
    const partialEnd = appendChargeSegment(buf, t, 2.0 * stepScale, 0, 0, currentMa, ir, 0.56);

    const data: Plotly.Data[] = [
      {
        type: "scatter",
        mode: "lines",
        name: "Voltage (V)",
        x: buf.x,
        y: buf.voltage,
        line: { color: PALETTE[0], width: style.line_width },
        hovertemplate: "%{x:.2f} h<br>%{y:.3f} V<extra>Voltage</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Current (mA)",
        x: buf.x,
        y: buf.current,
        yaxis: "y2",
        line: { color: PALETTE[1], width: 1.9 },
        hovertemplate: "%{x:.2f} h<br>%{y:.2f} mA<extra>Current</extra>",
      },
    ];

    const layout = exampleLayout("Test time (h)", "Voltage (V)", 174, { l: 58, r: 16, t: 10, b: 38 });
    layout.uirevision = mode;
    layout.xaxis = { ...layout.xaxis, anchor: "y2" };
    layout.yaxis = {
      ...plotAxisStyle(style),
      domain: [0.40, 1],
      range: [2.65, 4.48],
      automargin: true,
      title: { text: "Voltage (V)", font: { size: 12 }, standoff: 6 },
    };
    layout.yaxis2 = {
      ...plotAxisStyle(style),
      domain: [0, 0.24],
      range: [-6.8, 6.8],
      zeroline: true,
      zerolinecolor: "#adb5bd",
      zerolinewidth: 1,
      anchor: "x",
      automargin: true,
      title: { text: "I (mA)", font: { size: 12 }, standoff: 6 },
    };
    layout.shapes = [
      {
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: partialStart,
        x1: partialEnd,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(18,184,134,0.09)",
        line: { width: 0 },
        layer: "below",
      },
    ];
    layout.annotations = [
      {
        x: (partialStart + partialEnd) / 2,
        y: 0.99,
        xref: "x",
        yref: "paper",
        text: "Partial cycle kept",
        showarrow: false,
        yanchor: "top",
        font: { size: 10 },
      },
    ];
    return { data, layout };
  }, [mode]);

  return (
    <>
      <Plot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 174 }} useResizeHandler />
      <Group gap="md" justify="center" className={styles.legend}>
        <Text size="xs">
          <span className={styles.legendLine} style={{ borderColor: PALETTE[0] }} />
          Voltage (V)
        </Text>
        <Text size="xs">
          <span className={styles.legendLine} style={{ borderColor: PALETTE[1] }} />
          Signed current ({mode === "binary" ? "±5.0 mA · binary" : "±4.2 mA · text"})
        </Text>
      </Group>
    </>
  );
}

/** Realistic NMC cycling preview for Charge/Discharge pairing, Hours/Days axis, and cycle jump. */
function CyclingExample({
  pairing,
  timeUnit,
  showEarlier,
}: {
  pairing: "charge-first" | "discharge-first";
  timeUnit: "hours" | "days";
  showEarlier: boolean;
}) {
  const figure = useMemo(() => {
    const style = DEFAULT_PLOT_STYLE;
    const toAxis = (hours: number[]) =>
      timeUnit === "days" ? hours.map((h) => Number((h / 24).toFixed(4))) : hours;

    const buildSeries = (totalCycles: number, rateMa: number, ir: number, fadePerCycle: number) => {
      const buf: TraceBuffers = { x: [], voltage: [], current: [] };
      let t = pairing === "discharge-first" ? -10.0 : 0;
      if (pairing === "discharge-first") {
        // Pre-cycle charge + rest ending right at t = 0 h to illustrate negative cycle-aligned origin.
        t = appendChargeSegment(buf, t, 8.2, 1.2, 0.6, rateMa, ir);
        t = 0;
      }
      for (let c = 0; c < totalCycles; c++) {
        const capacityFactor = 1 - c * fadePerCycle;
        if (pairing === "discharge-first") {
          t = appendDischargeSegment(buf, t, 9.2 * capacityFactor, 0.6, rateMa, ir, capacityFactor);
          t = appendChargeSegment(buf, t, 8.6 * capacityFactor, 1.1, 0.5, rateMa, ir, 0.92 * capacityFactor);
        } else {
          t = appendChargeSegment(buf, t, 8.6 * capacityFactor, 1.1, 0.5, rateMa, ir, 0.92 * capacityFactor);
          t = appendDischargeSegment(buf, t, 9.2 * capacityFactor, 0.6, rateMa, ir, capacityFactor);
        }
      }
      return buf;
    };

    const cellA = buildSeries(4, 1.8, 0.025, 0.02);
    const data: Plotly.Data[] = [
      {
        type: "scatter",
        mode: "lines",
        name: "Cell A (cycles 1–40)",
        x: toAxis(cellA.x),
        y: cellA.voltage,
        line: { color: PALETTE[0], width: style.line_width },
        hovertemplate: "%{x:.3g}<br>%{y:.3f} V<extra>Cell A</extra>",
      },
    ];

    if (showEarlier) {
      const cellB = buildSeries(2, 1.8, 0.042, 0.055);
      data.push({
        type: "scatter",
        mode: "lines",
        name: "Cell B (cycles 1–12)",
        x: toAxis(cellB.x),
        y: cellB.voltage,
        line: { color: PALETTE[1], width: style.line_width, dash: "dash" },
        hovertemplate: "%{x:.3g}<br>%{y:.3f} V<extra>Cell B</extra>",
      });
    }

    const layout = exampleLayout(
      timeUnit === "days" ? "Time (days)" : "Time (h)",
      "Voltage (V)",
      142,
      { l: 58, r: 16, t: 12, b: 36 },
    );
    layout.yaxis = { ...layout.yaxis, range: [2.72, 4.28] };
    layout.uirevision = `${pairing}-${timeUnit}-${showEarlier}`;
    if (pairing === "discharge-first") {
      layout.shapes = [
        {
          type: "line",
          xref: "x",
          yref: "paper",
          x0: 0,
          x1: 0,
          y0: 0,
          y1: 1,
          line: { color: "#868e96", width: 1, dash: "dot" },
        },
      ];
    }
    return { data, layout };
  }, [pairing, timeUnit, showEarlier]);

  return (
    <Plot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 142 }} useResizeHandler />
  );
}

/** Realistic BioLogic Modulo Bat voltage trace using production cellPreviewVoltageTraces gap breaks. */
function VoltageExample() {
  const figure = useMemo(() => {
    const pre: TraceBuffers = { x: [], voltage: [], current: [] };
    const tPreEnd = appendChargeSegment(pre, 0, 3.8, 0.85, 0.65, 2.2, 0.022);
    const gapStart = tPreEnd;
    const gapEnd = gapStart + 1.55;

    const post: TraceBuffers = { x: [], voltage: [], current: [] };
    const tDisEnd = appendDischargeSegment(post, gapEnd, 4.1, 0.6, 2.2, 0.022, 0.96);
    appendChargeSegment(post, tDisEnd, 3.6, 0.4, 0, 2.2, 0.022, 0.86);

    const points = [...pre.x, ...post.x];
    const voltage = [...pre.voltage, ...post.voltage];
    const breakIndex = pre.x.length;

    const layout = exampleLayout("Time (h)", "Voltage (V)", 146, { l: 58, r: 16, t: 14, b: 36 });
    layout.yaxis = { ...layout.yaxis, range: [2.68, 4.35] };
    layout.uirevision = "biologic-mb-gap";
    layout.shapes = [
      {
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: gapStart,
        x1: gapEnd,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(134,142,150,0.12)",
        line: { width: 0 },
        layer: "below",
      },
    ];
    layout.annotations = [
      {
        x: (gapStart + gapEnd) / 2,
        y: 0.36,
        xref: "x",
        yref: "paper",
        text: "EIS excluded<br>gap kept",
        showarrow: false,
        yanchor: "middle",
        font: { size: 10 },
      },
    ];
    return {
      data: cellPreviewVoltageTraces([{ x: points, voltage, name: "Sample_MB_02", breakBefore: [breakIndex] }]),
      layout,
    };
  }, []);

  return (
    <Plot data={figure.data} layout={figure.layout} config={CONFIG} style={{ width: "100%", height: 146 }} useResizeHandler />
  );
}

type PhaseDemoItem = {
  label: string;
  detail: string;
  percent: number;
  state: "done" | "active" | "pending";
};

function ImportPhasesExample({
  stage,
  cancelled,
}: {
  stage: "scan" | "inspect" | "register";
  cancelled: boolean;
}) {
  const phases: PhaseDemoItem[] = useMemo(() => {
    if (stage === "scan") {
      return [
        { label: "1. Discover folders & files", detail: "120 folders · 610 files", percent: 100, state: "done" },
        {
          label: "2. Multi-core compatibility screen",
          detail: cancelled ? "Cancelled at 468 / 610 files" : "468 / 610 checked",
          percent: 77,
          state: cancelled ? "pending" : "active",
        },
      ];
    }
    if (stage === "inspect") {
      return [
        { label: "1. Choose network reader threads", detail: "8 workers ready", percent: 100, state: "done" },
        {
          label: "2. Read headers & match Cells",
          detail: cancelled ? "Stopped cleanly at 418 MB" : "418 / 652 MB",
          percent: 64,
          state: cancelled ? "pending" : "active",
        },
        { label: "3. Summarize skipped & ready files", detail: "Waiting", percent: 0, state: "pending" },
      ];
    }
    return [
      { label: "1. Validate selected sources", detail: "582 accepted", percent: 100, state: "done" },
      { label: "2. Save Cell order & metadata", detail: "Committed", percent: 100, state: "done" },
      {
        label: "3. Prepare cycling cache",
        detail: cancelled ? "Paused" : "Background warmup · 52%",
        percent: 52,
        state: "active",
      },
    ];
  }, [stage, cancelled]);

  return (
    <div className={styles.phaseList}>
      {phases.map((phase) => (
        <div key={phase.label} className={styles.phaseRow}>
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Group gap={6} wrap="nowrap">
              {phase.state === "done" ? (
                <IconCheck size={13} color="var(--mantine-color-teal-6)" aria-hidden />
              ) : phase.state === "active" ? (
                <span className={styles.phaseDotActive} aria-hidden />
              ) : (
                <span className={styles.phaseDot} aria-hidden />
              )}
              <Text size="xs" fw={phase.state === "active" ? 600 : 500}>
                {phase.label}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              {phase.detail}
            </Text>
          </Group>
          <Progress
            size="sm"
            radius="xl"
            aria-label={phase.label}
            value={phase.percent}
            color={phase.state === "done" ? "teal" : phase.state === "active" ? "violet" : "gray"}
            striped={phase.state === "active" && !cancelled}
            animated={phase.state === "active" && !cancelled}
          />
        </div>
      ))}
    </div>
  );
}

export function ReleaseIntroduction({
  onClose,
  onChooseFolders,
  reducedMotion,
}: {
  onClose: () => void;
  onChooseFolders: () => void;
  reducedMotion: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [maccorMode, setMaccorMode] = useState<"binary" | "text">("binary");
  const [pairing, setPairing] = useState<"charge-first" | "discharge-first">("discharge-first");
  const [timeUnit, setTimeUnit] = useState<"hours" | "days">("hours");
  const [showEarlier, setShowEarlier] = useState(false);
  const [importStage, setImportStage] = useState<"scan" | "inspect" | "register">("inspect");
  const [importCancelled, setImportCancelled] = useState(false);
  const [massOption, setMassOption] = useState<"active" | "total">("active");
  const [autoWatch, setAutoWatch] = useState(true);
  const [guide, setGuide] = useState(false);

  const card = RELEASE_CARDS[index];
  const blockExampleNavigation = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("a")) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  if (guide) {
    return (
      <Stack gap="sm" className={styles.surface + " " + styles.guide}>
        <Button
          autoFocus
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
          onClick={() => setGuide(false)}
          style={{ alignSelf: "flex-start" }}
        >
          Back to release cards
        </Button>
        <SearchIntroduction onClose={onClose} onChooseFolders={onChooseFolders} reducedMotion={reducedMotion} />
      </Stack>
    );
  }

  return (
    <Stack gap={0} className={styles.surface}>
      <div className={styles.work + " cx-vertical-scroll"} role="region" aria-label="Release card content" tabIndex={0}>
        <Stack gap={0}>
          <header className={styles.intro} aria-live="polite" aria-atomic="true">
            <Text size="xs" fw={700} tt="uppercase" className={styles.category}>
              {card.category}
            </Text>
            <Title order={3} className={styles.headline}>
              {card.title}
            </Title>
            <Text size="sm" c="dimmed" className={styles.description}>
              {card.description}
            </Text>
          </header>

          <Paper
            withBorder
            className={styles.example}
            onClickCapture={blockExampleNavigation}
            onAuxClickCapture={blockExampleNavigation}
          >
            <Text size="xs" c="dimmed" className={styles.exampleLabel}>
              Synthetic example
            </Text>

            {card.id === "maccor" && (
              <Paper withBorder className={styles.plotPanel}>
                <Group className={styles.panelHeader} justify="space-between" gap="xs">
                  <Group gap={6}>
                    <IconFileImport size={14} aria-hidden />
                    <Text size="xs" fw={600}>
                      {maccorMode === "binary" ? "Sample_Ch04.001" : "Sample_Ch04.txt"}
                    </Text>
                  </Group>
                  <SegmentedControl
                    size="xs"
                    aria-label="Maccor format"
                    value={maccorMode}
                    onChange={(value) => setMaccorMode(value as "binary" | "text")}
                    data={[
                      { value: "binary", label: "Native .001" },
                      { value: "text", label: "Text .txt" },
                    ]}
                  />
                </Group>
                <MaccorExample mode={maccorMode} />
                <Text size="xs" c="dimmed" className={styles.panelNote}>
                  {maccorMode === "binary"
                    ? "Native Maccor 4608 channel recording · CC-CV complete cycles and partial tails stay available."
                    : "Tab-separated Maccor text export · preserves interrupted cycles even without a full cycle pair."}
                </Text>
              </Paper>
            )}

            {card.id === "analysis" && (
              <Paper withBorder className={styles.plotPanel}>
                <Group className={styles.panelHeader} justify="space-between" gap="xs" wrap="wrap">
                  <SegmentedControl
                    size="xs"
                    aria-label="Cycle pairing"
                    value={pairing}
                    onChange={(value) => setPairing(value as "charge-first" | "discharge-first")}
                    data={[
                      { value: "charge-first", label: "Charge → Discharge" },
                      { value: "discharge-first", label: "Discharge → Charge" },
                    ]}
                  />
                  <SegmentedControl
                    size="xs"
                    aria-label="Time axis unit"
                    value={timeUnit}
                    onChange={(value) => setTimeUnit(value as "hours" | "days")}
                    data={[
                      { value: "hours", label: "Hours" },
                      { value: "days", label: "Days" },
                    ]}
                  />
                </Group>
                <CyclingExample pairing={pairing} timeUnit={timeUnit} showEarlier={showEarlier} />
                <div className={styles.panelNote}>
                  <Alert
                    variant="light"
                    color={showEarlier ? "teal" : "orange"}
                    p="xs"
                    icon={showEarlier ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}
                  >
                    <Group justify="space-between" gap="xs" wrap="wrap">
                      <Text size="xs">
                        {showEarlier
                          ? "Showing cycles 1–12 — Cell B is now plotted alongside Cell A."
                          : "Cell B only has data in earlier cycles (1–12), outside cycles 20–40."}
                      </Text>
                      <Button
                        size="compact-xs"
                        variant={showEarlier ? "subtle" : "light"}
                        color={showEarlier ? "gray" : "orange"}
                        onClick={() => setShowEarlier((value) => !value)}
                      >
                        {showEarlier ? "Reset range" : "Show cycles 1–12"}
                      </Button>
                    </Group>
                  </Alert>
                </div>
              </Paper>
            )}

            {card.id === "imports" && (
              <Paper withBorder className={styles.plotPanel}>
                <Group className={styles.panelHeader} justify="space-between" gap="xs" wrap="wrap">
                  <Group gap={6}>
                    <IconFolderOpen size={14} aria-hidden />
                    <Text size="xs" fw={600}>
                      \\lab-share\cycling-data\batch-01
                    </Text>
                  </Group>
                  <SegmentedControl
                    size="xs"
                    aria-label="Import stage"
                    value={importStage}
                    onChange={(value) => {
                      setImportStage(value as "scan" | "inspect" | "register");
                      setImportCancelled(false);
                    }}
                    data={[
                      { value: "scan", label: "Scan" },
                      { value: "inspect", label: "Inspect" },
                      { value: "register", label: "Register" },
                    ]}
                  />
                </Group>
                <ImportPhasesExample stage={importStage} cancelled={importCancelled} />
                <Group justify="space-between" gap="xs" className={styles.panelNote}>
                  <Text size="xs" c="dimmed">
                    {importCancelled
                      ? "Stopped immediately — network read halted cleanly."
                      : "Phase 3 confirmation now appears bottom-left so Done stays unobstructed."}
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="default"
                    leftSection={<IconX size={12} />}
                    onClick={() => setImportCancelled((value) => !value)}
                  >
                    {importCancelled ? "Resume preview" : "Cancel"}
                  </Button>
                </Group>
              </Paper>
            )}

            {card.id === "biologic" && (
              <Paper withBorder className={styles.plotPanel}>
                <Group className={styles.panelHeader} justify="space-between" gap="xs" wrap="wrap">
                  <Group gap={6}>
                    <IconFlask size={14} aria-hidden />
                    <Text size="xs" fw={600}>
                      Sample_MB_02.mpr
                    </Text>
                    <Badge size="xs" variant="light" color="teal">
                      Permissive default
                    </Badge>
                  </Group>
                  <SegmentedControl
                    size="xs"
                    aria-label="EC-Lab specimen mass"
                    value={massOption}
                    onChange={(value) => setMassOption(value as "active" | "total")}
                    data={[
                      { value: "active", label: "12.4 mg active" },
                      { value: "total", label: "18.6 mg total" },
                    ]}
                  />
                </Group>
                <VoltageExample />
                <Text size="xs" c="dimmed" className={styles.panelNote}>
                  {massOption === "active"
                    ? "2.28 mAh ÷ 12.40 mg (EC-Lab active material) → 184.2 mAh/g · PEIS-only files flagged upfront."
                    : "2.28 mAh ÷ 18.60 mg (EC-Lab total electrode) → 122.8 mAh/g · MB curves keep real EIS gaps."}
                </Text>
              </Paper>
            )}

            {card.id === "platform" && (
              <div className={styles.platformGrid}>
                <Paper withBorder p="xs" className={styles.platformCard}>
                  <Group justify="space-between" gap={4}>
                    <Group gap={5}>
                      <IconRefresh size={14} aria-hidden />
                      <Text size="xs" fw={600}>
                        Auto-updating files
                      </Text>
                    </Group>
                    <Badge size="xs" variant="light" color="teal">
                      On by default
                    </Badge>
                  </Group>
                  <Switch
                    size="xs"
                    checked={autoWatch}
                    onChange={(event) => setAutoWatch(event.currentTarget.checked)}
                    label="Check & update active files"
                  />
                  <Text size="xs" c="dimmed">
                    Active cycler tests stay synced in the background automatically.
                  </Text>
                </Paper>

                <Paper withBorder p="xs" className={styles.platformCard}>
                  <Group gap={5}>
                    <IconTable size={14} aria-hidden />
                    <Text size="xs" fw={600}>
                      Smoother tables & startup
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    Opens faster on laptops, paginates Analyses, and briefly highlights new cells.
                  </Text>
                  <Group gap={5} wrap="wrap">
                    <Badge size="xs" variant="outline" color="gray">
                      25
                    </Badge>
                    <Badge size="xs" variant="filled">
                      50
                    </Badge>
                    <Badge size="xs" variant="outline" color="gray">
                      100 rows
                    </Badge>
                    <span className={styles.newCellChip}>Cell 12 · new</span>
                  </Group>
                </Paper>

                <Paper withBorder p="xs" className={styles.platformCard}>
                  <Group justify="space-between" gap={4}>
                    <Group gap={5}>
                      <IconDownload size={14} aria-hidden />
                      <Text size="xs" fw={600}>
                        37% smaller installer
                      </Text>
                    </Group>
                    <Badge size="xs" variant="light" color="teal">
                      87 → 55 MB
                    </Badge>
                  </Group>
                  <Stack gap={4}>
                    <Group justify="space-between" gap="xs">
                      <Text size="xs" c="dimmed">
                        Before · 87 MB
                      </Text>
                      <Progress size="xs" value={100} color="gray" w={92} aria-label="Previous installer 87 MB" />
                    </Group>
                    <Group justify="space-between" gap="xs">
                      <Text size="xs" fw={600}>
                        Now · 55 MB
                      </Text>
                      <Progress size="xs" value={63} color="teal" w={92} aria-label="Current installer 55 MB" />
                    </Group>
                  </Stack>
                </Paper>

                <Paper withBorder p="xs" className={styles.platformCard}>
                  <Group gap={5}>
                    <IconBell size={14} aria-hidden />
                    <Text size="xs" fw={600}>
                      Clearer app updates
                    </Text>
                  </Group>
                  <div className={styles.updateBubble}>
                    <Group justify="space-between" gap={6}>
                      <Group gap={5}>
                        <IconPower size={12} aria-hidden />
                        <Text size="xs" fw={600}>
                          Update available
                        </Text>
                      </Group>
                      <Text size="xs" c="dimmed">
                        Release notes
                      </Text>
                    </Group>
                  </div>
                  <Text size="xs" c="dimmed">
                    Brings CellXplorer to the front cleanly after updating.
                  </Text>
                </Paper>
              </div>
            )}
          </Paper>

          <Group justify="center" gap={6} className={styles.location}>
            <IconInfoCircle size={14} aria-hidden />
            <Text size="xs" c="dimmed">
              {card.location}
            </Text>
            <Tooltip label="File search guide">
              <ActionIcon size="sm" variant="subtle" aria-label="File search guide" onClick={() => setGuide(true)}>
                <IconSearch size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Stack>
      </div>

      <div className={styles.footer}>
        <Button className={styles.skip} size="compact-sm" variant="subtle" color="gray" onClick={onClose}>
          Skip tour
        </Button>
        <Group gap={6} className={styles.progress} wrap="nowrap">
          <Text size="xs" c="dimmed" aria-live="polite" style={{ whiteSpace: "nowrap" }}>
            {index + 1} of {RELEASE_CARDS.length}
          </Text>
          <Group gap={0} component="nav" aria-label="Release cards" wrap="nowrap">
            {RELEASE_CARDS.map((item, step) => (
              <Tooltip key={item.id} label={item.title}>
                <UnstyledButton
                  className={styles.dot}
                  aria-label={item.title}
                  aria-current={step === index ? "step" : undefined}
                  onClick={() => setIndex(step)}
                >
                  <span />
                </UnstyledButton>
              </Tooltip>
            ))}
          </Group>
        </Group>
        <Group gap="xs" className={styles.actions} wrap="nowrap">
          <Button
            size="sm"
            variant="default"
            leftSection={<IconArrowLeft size={16} />}
            disabled={index === 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            rightSection={index < RELEASE_CARDS.length - 1 ? <IconArrowRight size={16} /> : undefined}
            onClick={() =>
              index === RELEASE_CARDS.length - 1
                ? onClose()
                : setIndex((value) => Math.min(RELEASE_CARDS.length - 1, value + 1))
            }
          >
            {index === RELEASE_CARDS.length - 1 ? "Done" : "Next"}
          </Button>
        </Group>
      </div>
    </Stack>
  );
}
