import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Popover,
  Progress,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronDown,
  IconDownload,
  IconInfoCircle,
  IconPlus,
  IconTable,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import {
  type BackgroundJob,
  type PlotAspectRatioKey,
  type PlotExportFormat,
  type PlotStyle,
} from "../../../../api";
import { DebouncedNumberInput } from "../../../../components/DebouncedInputs";
import { sanitizeExportFilename } from "../../../../exportFilenames";
import { resolveExportPlan } from "./plotExport";
import { type PlotExplainer } from "./plotExplainers";
import { DEFAULT_PLOT_STYLE, normalizePlotStyle } from "./plotStyle";

const ASPECT_RATIO_OPTIONS: { value: PlotAspectRatioKey; label: string }[] = [
  { value: "view", label: "Current view" },
  { value: "square", label: "1:1 square" },
  { value: "four_three", label: "4:3" },
  { value: "sixteen_nine", label: "16:9" },
  { value: "a4_landscape", label: "A4 landscape" },
  { value: "a4_portrait", label: "A4 portrait" },
  { value: "custom", label: "Custom" },
];

const EXPORT_FORMAT_OPTIONS: { value: PlotExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
  { value: "pdf", label: "PDF" },
];

export type PlotDataExportScope = "full_series" | "plot_range";

function dataExportFormatLabel(format: PlotStyle["data_export_format"]): string {
  if (format === "xlsx") return "XLSX";
  if (format === "parquet") return "Parquet";
  return "CSV";
}

function exportFilenameBase(value: string): string {
  return value.replace(/\.(?:csv|xlsx|parquet|png|svg|pdf)$/i, "");
}

function filenameSuffixWidth(suffix: string): number {
  return Math.max(56, suffix.length * 8 + 18);
}

export function jobProgress(job: BackgroundJob | undefined): number {
  if (!job) return 0;
  if (job.total <= 0) return job.status === "completed" ? 100 : 0;
  return Math.max(0, Math.min(100, (job.completed / job.total) * 100));
}
export function ComputeProgress({ job, label }: { job: BackgroundJob | undefined; label: string }) {
  return (
    <Stack gap="xs" w={360} maw="80%">
      <Text size="sm" fw={600} ta="center">
        {job?.description || label}
      </Text>
      <Progress value={jobProgress(job)} animated={job?.status === "running"} />
      <Text size="xs" c="dimmed" ta="center">
        {job?.total ? `${job.completed} of ${job.total} cells` : "Preparing cached data"}
      </Text>
    </Stack>
  );
}

function PlotExplainerButton({ explainer }: { explainer?: PlotExplainer }) {
  if (!explainer) return null;
  return (
    <Popover withinPortal position="bottom-end" shadow="md" width={360}>
      <Popover.Target>
        <Tooltip label="How this plot is calculated">
          <ActionIcon size={30} variant="subtle" color="var(--mantine-primary-color-6)" aria-label="Plot explainer">
            <IconInfoCircle size={18} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <div>
            <Text fw={800}>{explainer.title}</Text>
            <Text size="sm" c="dimmed">
              {explainer.formula}
            </Text>
            {explainer.secondaryFormula && (
              <Text size="sm" c="dimmed" mt={4}>
                {explainer.secondaryFormula}
              </Text>
            )}
          </div>
          {explainer.requires.length > 0 && (
            <div>
              <Text size="xs" fw={800} tt="uppercase" c="dimmed" mb={4}>
                Requires
              </Text>
              <Group gap={6}>
                {explainer.requires.map((item) => (
                  <Badge key={item} size="sm" variant="light" color="var(--mantine-primary-color-6)">
                    {item}
                  </Badge>
                ))}
              </Group>
            </div>
          )}
          {explainer.notes.length > 0 && (
            <Stack gap={4}>
              <Text size="xs" fw={800} tt="uppercase" c="dimmed">
                Notes
              </Text>
              {explainer.notes.map((note) => (
                <Text key={note} size="sm">
                  {note}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function PlotHeader({
  analysisTitle,
  plotName,
  subtitle,
  explainer,
  onExport,
  onDataExport,
  dataExportScopeEnabled = false,
  getExportPreview,
  style,
  viewSize,
  layout,
  canExport = false,
  canPlotExport,
  edited = false,
  onNewPlot,
  newPlotEnabled = false,
  onUpdatePlot,
  updatePlotEnabled = false,
  updatePlotLabel = "Update",
}: {
  analysisTitle?: string;
  tabName?: string;
  plotName: string;
  subtitle: string;
  quantityName?: string;
  xAxisName?: string;
  sampleSummary?: string;
  explainer?: PlotExplainer;
  onExport?: (format: PlotExportFormat, baseName: string, exportStyle: PlotStyle) => void;
  onDataExport?: (
    baseName: string,
    exportStyle: PlotStyle,
    scope: PlotDataExportScope,
  ) => void;
  /** Time/Capacity can export either the full series or the current plot range. */
  dataExportScopeEnabled?: boolean;
  getExportPreview?: (exportStyle: PlotStyle) => Promise<string | null>;
  style?: PlotStyle;
  viewSize?: { width: number; height: number } | null;
  layout?: Partial<Plotly.Layout>;
  canExport?: boolean;
  /** Plot/image/vector export readiness; defaults to the data-export readiness. */
  canPlotExport?: boolean;
  /** Amber chip when the open saved plot has unsaved edits. */
  edited?: boolean;
  onNewPlot?: () => void;
  /** Green and clickable when the analysis has samples. */
  newPlotEnabled?: boolean;
  onUpdatePlot?: () => void;
  /** Amber/active when the open saved plot has unsaved edits, or when saving a draft. */
  updatePlotEnabled?: boolean;
  /** `Save as` for new drafts; `Update` for edited saved plots. */
  updatePlotLabel?: string;
}) {
  const persistedExportStyle = normalizePlotStyle(style);
  const persistedStyleSignature = JSON.stringify(persistedExportStyle);
  const [exportStyle, setExportStyleState] = useState<PlotStyle>(
    () => persistedExportStyle,
  );
  useEffect(() => {
    setExportStyleState(persistedExportStyle);
    // The signature changes only when the persisted style changes. Keeping the
    // normalized object out of the dependency list prevents local export
    // choices from being reset on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedStyleSignature]);
  const plotExportEnabled = canPlotExport ?? canExport;
  const selectedFormat = exportStyle.export_format ?? "png";
  const [exportPopoverOpen, setExportPopoverOpen] = useState(false);
  const [dataExportPopoverOpen, setDataExportPopoverOpen] = useState(false);
  const [dataExportScope, setDataExportScope] = useState<PlotDataExportScope>("full_series");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const exportPreviewSignature = JSON.stringify(exportStyle);
  const plan = resolveExportPlan(exportStyle, viewSize ?? null, layout ?? {});
  const exportWidthValue = plan.pixelWidth;
  const exportHeightValue = plan.pixelHeight;
  const ppi = Math.max(36, exportStyle.export_ppi || DEFAULT_PLOT_STYLE.export_ppi);
  const printWidthCm = (exportWidthValue / ppi) * 2.54;
  const printHeightCm = (exportHeightValue / ppi) * 2.54;
  const setExportStyle = (fn: (style: PlotStyle) => void) => {
    setExportStyleState((current) => {
      const next = normalizePlotStyle(current);
      fn(next);
      return next;
    });
  };
  const setAspect = (value: PlotAspectRatioKey) => {
    setExportStyle((next) => {
      next.export_aspect_ratio = value;
    });
  };
  const setExportWidth = (value: number) => {
    setExportStyle((next) => {
      next.export_width = value;
    });
  };
  const defaultFilename = `${analysisTitle?.trim() || "Analysis"} - ${
    plotName === "Unsaved plot" || plotName === "New plot"
      ? subtitle || "Plot"
      : plotName
  }`;
  const defaultFilenameSignature = sanitizeExportFilename(defaultFilename, "plot");
  const [filename, setFilename] = useState(defaultFilenameSignature);
  const filenameEdited = useRef(false);
  useEffect(() => {
    if (!filenameEdited.current) setFilename(defaultFilenameSignature);
  }, [defaultFilenameSignature]);
  const renderedFilename = sanitizeExportFilename(filename, "plot");
  const exportPlot = () => {
    onExport?.(selectedFormat, renderedFilename, exportStyle);
    setExportPopoverOpen(false);
  };
  const exportData = () => {
    onDataExport?.(renderedFilename, exportStyle, dataExportScope);
    setDataExportPopoverOpen(false);
  };

  // live thumbnail of the actual export output (same figure, scaled down),
  // regenerated while the popover is open and settings change
  useEffect(() => {
    if (!exportPopoverOpen || !getExportPreview || !plotExportEnabled) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getExportPreview(exportStyle)
        .then((url) => {
          if (!cancelled) setPreviewUrl(url);
        })
        .catch(() => {
          if (!cancelled) setPreviewUrl(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    exportPopoverOpen,
    exportPreviewSignature,
    plotExportEnabled,
    viewSize?.width,
    viewSize?.height,
  ]);

  useEffect(() => {
    if (plotExportEnabled) return;
    setPreviewUrl(null);
    setExportPopoverOpen(false);
  }, [plotExportEnabled]);

  return (
    <>
    <Group justify="space-between" mb="xs" align="start">
      <div>
        <Group gap={8} align="center" wrap="nowrap">
          <Text fw={800} size="lg">
            {plotName}
          </Text>
          {edited ? (
            <Badge size="xs" variant="light" color="yellow">
              Edited
            </Badge>
          ) : null}
        </Group>
        <Text size="sm" c="dimmed">
          {subtitle}
        </Text>
      </div>
      <Group gap="xs" align="start">
        <PlotExplainerButton explainer={explainer} />
        {onDataExport && style && (
          <Button.Group>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconTable size={14} />}
              disabled={!canExport}
              onClick={exportData}
            >
              {dataExportFormatLabel(exportStyle.data_export_format)}
            </Button>
            <Popover
              withinPortal
              position="bottom-end"
              shadow="md"
              width="min(540px, calc(100vw - 24px))"
              opened={dataExportPopoverOpen}
              onChange={setDataExportPopoverOpen}
            >
              <Popover.Target>
                <Button
                  size="xs"
                  variant="default"
                  px={6}
                  disabled={!canExport}
                  aria-label="Data export settings"
                  onClick={() => setDataExportPopoverOpen((open) => !open)}
                >
                  <IconChevronDown size={14} />
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Select
                    label="Format"
                    data={[
                      { value: "csv", label: "CSV (text)" },
                      { value: "xlsx", label: "Excel (.xlsx)" },
                      { value: "parquet", label: "Parquet (.parquet)" },
                    ]}
                    value={exportStyle.data_export_format}
                    comboboxProps={{ withinPortal: false }}
                    onChange={(value) =>
                      value &&
                      setExportStyle(
                        (next) => void (next.data_export_format = value as PlotStyle["data_export_format"])
                      )
                    }
                  />
                  {dataExportScopeEnabled ? (
                    <Select
                      label="Data range"
                      data={[
                        { value: "full_series", label: "Full data series" },
                        { value: "plot_range", label: "Current range shown in plot" },
                      ]}
                      value={dataExportScope}
                      comboboxProps={{ withinPortal: false }}
                      onChange={(value) =>
                        value && setDataExportScope(value as PlotDataExportScope)
                      }
                    />
                  ) : null}
                  <Select
                    label="Numeric precision"
                    data={[
                      { value: "standard", label: "Standard (recommended)" },
                      { value: "full", label: "Full source precision" },
                    ]}
                    value={exportStyle.data_precision}
                    comboboxProps={{ withinPortal: false }}
                    onChange={(value) =>
                      value &&
                      setExportStyle(
                        (next) => void (next.data_precision = value as PlotStyle["data_precision"])
                      )
                    }
                  />
                  {exportStyle.data_export_format === "csv" && (
                    <>
                      <Select
                        label="Decimal separator"
                        data={[
                          { value: "point", label: "Point (3.14)" },
                          { value: "comma", label: "Comma (3,14)" },
                        ]}
                        value={exportStyle.data_decimal_separator}
                        comboboxProps={{ withinPortal: false }}
                        onChange={(value) =>
                          value &&
                          setExportStyle((next) => {
                            next.data_decimal_separator = value as PlotStyle["data_decimal_separator"];
                            // comma decimals cannot share the comma delimiter
                            if (value === "comma" && next.data_delimiter === "comma") {
                              next.data_delimiter = "semicolon";
                            }
                          })
                        }
                      />
                      <Select
                        label="Column separator"
                        data={[
                          { value: "comma", label: "Comma  ," , disabled: exportStyle.data_decimal_separator === "comma" },
                          { value: "semicolon", label: "Semicolon  ;" },
                          { value: "tab", label: "Tab" },
                        ]}
                        value={exportStyle.data_delimiter}
                        comboboxProps={{ withinPortal: false }}
                        onChange={(value) =>
                          value &&
                          setExportStyle(
                            (next) => void (next.data_delimiter = value as PlotStyle["data_delimiter"])
                          )
                        }
                      />
                    </>
                  )}
                  <Divider />
                  <TextInput
                    label="Filename"
                    value={filename}
                    rightSection={
                      <Text size="xs" c="dimmed" style={{ pointerEvents: "none" }}>
                        .{exportStyle.data_export_format}
                      </Text>
                    }
                    rightSectionWidth={filenameSuffixWidth(`.${exportStyle.data_export_format}`)}
                    rightSectionPointerEvents="none"
                    styles={{
                      input: {
                        paddingRight: filenameSuffixWidth(`.${exportStyle.data_export_format}`) + 8,
                      },
                    }}
                    onChange={(event) => {
                      filenameEdited.current = true;
                      setFilename(exportFilenameBase(event.currentTarget.value));
                    }}
                  />
                  <Button
                    fullWidth
                    leftSection={<IconTable size={14} />}
                    onClick={exportData}
                  >
                    Download {dataExportFormatLabel(exportStyle.data_export_format)}
                  </Button>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          </Button.Group>
        )}
        {onExport && (
          <Button.Group>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconDownload size={14} />}
              disabled={!plotExportEnabled}
              onClick={exportPlot}
            >
              {selectedFormat.toUpperCase()}
            </Button>
            <Popover
              withinPortal
              position="bottom-end"
              shadow="md"
              width="min(760px, calc(100vw - 24px))"
              opened={exportPopoverOpen}
              onChange={setExportPopoverOpen}
            >
              <Popover.Target>
                <Button
                  size="xs"
                  variant="default"
                  px={6}
                  disabled={!plotExportEnabled}
                  aria-label="Export settings"
                  onClick={() => setExportPopoverOpen((open) => !open)}
                >
                  <IconChevronDown size={14} />
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: getExportPreview
                      ? "repeat(auto-fit, minmax(min(300px, 100%), 1fr))"
                      : "1fr",
                    gap: 16,
                    alignItems: "start",
                  }}
                >
                  {getExportPreview && plotExportEnabled && (
                    <Stack gap={6}>
                      <Text size="xs" fw={600} c="dimmed">
                        {selectedFormat === "png"
                          ? `Preview | ${Math.round(exportWidthValue)} x ${Math.round(exportHeightValue)} px`
                          : "Preview | Vector output"}
                      </Text>
                      <div
                        style={{
                          border: "1px solid var(--mantine-color-gray-3)",
                          borderRadius: 4,
                          padding: 2,
                          background:
                            "repeating-conic-gradient(#f1f3f5 0% 25%, #ffffff 0% 50%) 50% / 12px 12px",
                          minHeight: 220,
                          height: 300,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                        }}
                      >
                        {previewUrl ? (
                          <img
                            src={previewUrl}
                            alt="Export preview"
                            style={{
                              maxWidth: "100%",
                              maxHeight: "100%",
                              width: "auto",
                              height: "auto",
                              display: "block",
                            }}
                          />
                        ) : (
                          <Loader size={16} />
                        )}
                      </div>
                      <Text size="10px" c="dimmed">
                        The aspect ratio applies to the data rectangle; labels, margins, and outside legends are added around it.
                      </Text>
                    </Stack>
                  )}
                    <Stack gap="xs">
                      <Select
                        label="Format"
                        data={EXPORT_FORMAT_OPTIONS}
                        value={selectedFormat}
                        comboboxProps={{ withinPortal: false }}
                        onChange={(value) =>
                          value && setExportStyle((next) => void (next.export_format = value as PlotExportFormat))
                        }
                      />
                      <Select
                        label="Aspect ratio"
                        data={ASPECT_RATIO_OPTIONS}
                        value={exportStyle.export_aspect_ratio}
                        comboboxProps={{ withinPortal: false }}
                        onChange={(value) => value && setAspect(value as PlotAspectRatioKey)}
                      />
                      {selectedFormat === "png" ? (
                        <>
                          <Group grow align="start">
                            <DebouncedNumberInput
                              label="Width (px)"
                              min={320}
                              step={100}
                              value={exportWidthValue}
                              onCommit={(value) => value !== null && setExportWidth(value)}
                            />
                            <DebouncedNumberInput
                              label="Height (px)"
                              min={240}
                              step={100}
                              disabled={exportStyle.export_aspect_ratio !== "custom"}
                              value={exportHeightValue}
                              onCommit={(value) =>
                                value !== null && setExportStyle((next) => void (next.export_height = value))
                              }
                            />
                          </Group>
                          <DebouncedNumberInput
                            label="Print density (PPI)"
                            description="Sets physical print size; it does not change the pixel dimensions above."
                            min={36}
                            max={1200}
                            step={24}
                            value={exportStyle.export_ppi}
                            onCommit={(value) =>
                              setExportStyle(
                                (next) => void (next.export_ppi = value ?? DEFAULT_PLOT_STYLE.export_ppi)
                              )
                            }
                          />
                          <Text size="10px" c="dimmed">
                            Print size at {Math.round(ppi)} PPI: {printWidthCm.toFixed(1)} x {printHeightCm.toFixed(1)} cm
                          </Text>
                        </>
                      ) : (
                        <Text size="xs" c="dimmed">
                          {selectedFormat.toUpperCase()} is vector-based, so it has no pixel resolution or PPI setting.
                          It can be resized without losing sharpness.
                        </Text>
                      )}
                      <Switch
                        label="Include title in figure"
                        checked={exportStyle.export_include_title}
                        onChange={(event) =>
                          setExportStyle((next) => void (next.export_include_title = event.currentTarget.checked))
                        }
                      />
                    </Stack>
                    <Stack
                      gap="xs"
                      style={{ gridColumn: "1 / -1" }}
                    >
                      <Divider />
                      <TextInput
                        label="Filename"
                        value={filename}
                        rightSection={
                          <Text size="xs" c="dimmed" style={{ pointerEvents: "none" }}>
                            .{selectedFormat}
                          </Text>
                        }
                        rightSectionWidth={filenameSuffixWidth(`.${selectedFormat}`)}
                        rightSectionPointerEvents="none"
                        styles={{
                          input: {
                            paddingRight: filenameSuffixWidth(`.${selectedFormat}`) + 8,
                          },
                        }}
                        onChange={(event) => {
                          filenameEdited.current = true;
                          setFilename(exportFilenameBase(event.currentTarget.value));
                        }}
                      />
                      <Button
                        fullWidth
                        leftSection={<IconDownload size={14} />}
                        disabled={!plotExportEnabled}
                        onClick={exportPlot}
                      >
                        Download {selectedFormat.toUpperCase()}
                      </Button>
                    </Stack>
                </div>
              </Popover.Dropdown>
            </Popover>
          </Button.Group>
        )}
        {onUpdatePlot ? (
          <Button
            size="xs"
            color="yellow"
            variant={updatePlotEnabled ? "filled" : "light"}
            disabled={!updatePlotEnabled}
            onClick={onUpdatePlot}
          >
            {updatePlotLabel}
          </Button>
        ) : null}
        {onNewPlot ? (
          <Button
            size="xs"
            color="var(--mantine-primary-color-6)"
            variant={newPlotEnabled ? "filled" : "light"}
            leftSection={<IconPlus size={14} />}
            disabled={!newPlotEnabled}
            onClick={onNewPlot}
          >
            New
          </Button>
        ) : null}
      </Group>
    </Group>
    </>
  );
}
