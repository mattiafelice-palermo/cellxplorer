import { useCallback, useMemo, useState, type ComponentProps } from "react";
import type { PlotParams } from "react-plotly.js";
import {
  buildContinuationPreviewProvenanceLayout, previewSourceSpans, type PreviewXAxisViewport,
} from "../continuedImportPreviewPolicy";
import { CellPreviewPlot } from "./CellPreviewPlot";
import { cellPreviewCapacityLayout, cellPreviewVoltageLayout } from "./cellPreviewPlotModel";

type Props = Omit<ComponentProps<typeof CellPreviewPlot>, "layout"> & {
  layout: ReturnType<typeof cellPreviewVoltageLayout | typeof cellPreviewCapacityLayout>;
  spans: ReturnType<typeof previewSourceSpans>;
  sequentialAxis: boolean;
};

/** The drawn axis accounts for Plotly's autorange padding, zoom and responsive margins. */
export function ContinuedImportPlot({ layout, spans, sequentialAxis, ...props }: Props) {
  const [viewport, setViewport] = useState<PreviewXAxisViewport | null>(null);
  const measureAxis = useCallback<NonNullable<PlotParams["onUpdate"]>>((_figure, graphDiv) => {
    const axis = (graphDiv as HTMLElement & {
      _fullLayout?: { xaxis?: { range: [number, number]; _length: number } };
    })._fullLayout?.xaxis;
    if (!axis) return;
    const [start, end] = axis.range;
    const width = axis._length;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(width > 0)) return;
    setViewport((previous) => previous?.start === start && previous.end === end && previous.width === width
      ? previous : { start, end, width });
  }, []);
  const figureLayout = useMemo(() => {
    if (!spans.length) return layout;
    const guides = viewport ? buildContinuationPreviewProvenanceLayout(spans, viewport, sequentialAxis) : null;
    return {
      ...layout,
      margin: { ...layout.margin, t: 40 },
      shapes: [...layout.shapes, ...(guides?.shapes ?? [])],
      annotations: guides?.annotations ?? [],
    };
  }, [layout, spans, viewport, sequentialAxis]);
  return <CellPreviewPlot {...props} layout={figureLayout} onFigureChange={spans.length ? measureAxis : undefined} />;
}
