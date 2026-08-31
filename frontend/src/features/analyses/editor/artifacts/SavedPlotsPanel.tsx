import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconDeviceFloppy, IconPencil } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AnalysisDraftPlot,
  AnalysisSpec,
  AnalysisTabKey,
  SavedAnalysisPlot,
} from "../../../../api";
import { draftAsSavedPlot, draftPlotFromWorkspace } from "../policies/analysisDraftPolicy";
import {
  SAVED_PLOT_NAME_MAX_LENGTH,
  validateSavedPlotName,
} from "../policies/analysisPlotPolicy";
import { DraftPlotCard } from "./DraftPlotCard";
import {
  SavedPlotPreview,
  SavedTimeCapacityPreview,
} from "./SavedPlotPreviews";

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
    case "settings":
      return "Settings";
    default:
      return tab;
  }
}

function TabDraftPlotCard({
  analysisId,
  tab,
  baseSpec,
  draft,
  liveUnsaved,
  allowPreviewGeneration,
  onOpen,
}: {
  analysisId: number;
  tab: AnalysisTabKey;
  baseSpec: AnalysisSpec;
  draft: AnalysisDraftPlot | null;
  liveUnsaved: boolean;
  allowPreviewGeneration: boolean;
  onOpen: () => void;
}) {
  const previewSource = useMemo(() => {
    if (liveUnsaved) {
      return draftPlotFromWorkspace(baseSpec, tab, draft?.name ?? null, draft?.updated_at ?? "1970-01-01T00:00:00.000Z");
    }
    return draft;
  }, [baseSpec, draft, liveUnsaved, tab]);

  const [stableDraft, setStableDraft] = useState(previewSource);
  useEffect(() => {
    if (!liveUnsaved) {
      setStableDraft(previewSource);
      return;
    }
    const timer = window.setTimeout(() => setStableDraft(previewSource), 700);
    return () => window.clearTimeout(timer);
  }, [liveUnsaved, previewSource]);

  const previewPlot = useMemo(
    () => (stableDraft ? draftAsSavedPlot(stableDraft) : null),
    [stableDraft],
  );

  const preview =
    previewPlot == null ? null : tab === "time_capacity" ? (
      <SavedTimeCapacityPreview
        analysisId={analysisId}
        baseSpec={baseSpec}
        plot={previewPlot}
        allowGeneration={allowPreviewGeneration}
      />
    ) : tab === "cycles" ||
      tab === "recap" ||
      tab === "dcir" ||
      tab === "steps" ||
      tab === "crate" ||
      tab === "chargeability" ? (
      <SavedPlotPreview
        analysisId={analysisId}
        baseSpec={baseSpec}
        plot={previewPlot}
        allowGeneration={allowPreviewGeneration}
      />
    ) : (
      <Center h={130}>
        <Text size="xs" c="dimmed">
          Draft preview
        </Text>
      </Center>
    );

  return (
    <DraftPlotCard
      draft={draft}
      liveUnsaved={liveUnsaved}
      activeTab={tab}
      preview={preview}
      onOpen={onOpen}
    />
  );
}

export function SavedPlotsPanel({
  analysisId,
  activeTab,
  baseSpec,
  plots,
  activeSavedPlotId,
  activePlotDirty,
  onSaveNew,
  onOpen,
  onRename,
  onDelete,
  allowPreviewGeneration,
  hasSamples,
  canSaveNew,
  draft,
  liveUnsaved,
  onOpenDraft,
}: {
  analysisId: number;
  activeTab: AnalysisTabKey;
  baseSpec: AnalysisSpec;
  plots: SavedAnalysisPlot[];
  activeSavedPlotId: string | null;
  activePlotDirty: boolean;
  onSaveNew: () => void;
  onOpen: (plot: SavedAnalysisPlot) => void;
  onRename: (plotId: string, name: string) => void;
  onDelete: (plotId: string) => void;
  allowPreviewGeneration: boolean;
  hasSamples: boolean;
  canSaveNew: boolean;
  draft: AnalysisDraftPlot | null;
  liveUnsaved: boolean;
  onOpenDraft: () => void;
}) {
  const visiblePlots = plots.filter((plot) => plot.tab === activeTab);
  const visiblePlotKey = visiblePlots.map((plot) => plot.id).join("|");
  const [generationPlotIds, setGenerationPlotIds] = useState<Set<string>>(new Set());
  const [renamePlot, setRenamePlot] = useState<SavedAnalysisPlot | null>(null);
  const [renameName, setRenameName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameValidation = validateSavedPlotName(renameName);
  const focusRenameInput = () => {
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  };

  useEffect(() => {
    if (!renamePlot) return;
    const frame = window.requestAnimationFrame(focusRenameInput);
    return () => window.cancelAnimationFrame(frame);
  }, [renamePlot]);

  const closeRename = () => {
    setRenamePlot(null);
    setRenameName("");
  };

  const submitRename = () => {
    if (!renamePlot || renameValidation.error) return;
    onRename(renamePlot.id, renameValidation.value);
    closeRename();
  };

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let idleCallback: number | null = null;
    const ids = visiblePlotKey ? visiblePlotKey.split("|") : [];
    const prioritized = activeSavedPlotId && ids.includes(activeSavedPlotId)
      ? activeSavedPlotId
      : null;
    setGenerationPlotIds(allowPreviewGeneration && prioritized ? new Set([prioritized]) : new Set());
    if (!allowPreviewGeneration) return;

    const queue = ids.filter((id) => id !== prioritized);
    const schedule = () => {
      if (cancelled || queue.length === 0) return;
      const admitOne = () => {
        if (cancelled) return;
        const nextId = queue.shift();
        if (nextId) setGenerationPlotIds((current) => new Set(current).add(nextId));
        if (queue.length > 0) timer = window.setTimeout(schedule, 250);
      };
      if ("requestIdleCallback" in window) {
        idleCallback = window.requestIdleCallback(admitOne, { timeout: 1500 });
      } else {
        timer = globalThis.setTimeout(admitOne, 250);
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (idleCallback !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallback);
      }
    };
  }, [activeSavedPlotId, allowPreviewGeneration, visiblePlotKey]);

  if (activeTab === "settings") return null;

  return (
    <>
      <TabDraftPlotCard
        analysisId={analysisId}
        tab={activeTab}
        baseSpec={baseSpec}
        draft={draft}
        liveUnsaved={liveUnsaved}
        allowPreviewGeneration={allowPreviewGeneration}
        onOpen={onOpenDraft}
      />
      <Paper p="sm" withBorder>
      <Group justify="space-between" mb="xs">
        <div>
          <Text fw={700} size="sm">
            Saved plots
          </Text>
          <Text size="xs" c="dimmed">
            {tabLabel(activeTab)} ({visiblePlots.length})
          </Text>
        </div>
        <Group gap="xs">
          <Button
            size="xs"
            leftSection={<IconDeviceFloppy size={14} />}
            disabled={!hasSamples || !canSaveNew}
            onClick={onSaveNew}
          >
            Save new plot
          </Button>
        </Group>
      </Group>
      {visiblePlots.length === 0 ? (
        <Alert color="gray">No saved plots for this tab.</Alert>
      ) : (
        <Stack gap="xs">
          {visiblePlots.map((plot) => {
            const active = plot.id === activeSavedPlotId;
            return (
              <Box
                key={plot.id}
                p="xs"
                role="button"
                tabIndex={0}
                onMouseDownCapture={(event) => {
                  if ((event.target as HTMLElement).closest("button")) return;
                  onOpen(plot);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(plot);
                  }
                }}
                style={{
                  border: active
                    ? "1px solid var(--mantine-primary-color-3)"
                    : "1px solid var(--mantine-color-gray-2)",
                  background: active ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <Group align="stretch" wrap="nowrap">
                  <Box
                    className="cx-plot-thumbnail-frame"
                    w={260}
                    style={{ flexShrink: 0 }}
                  >
                    {plot.tab === "time_capacity" ? (
                      <SavedTimeCapacityPreview
                        analysisId={analysisId}
                        baseSpec={baseSpec}
                        plot={plot}
                        allowGeneration={generationPlotIds.has(plot.id)}
                      />
                    ) : plot.tab === "cycles" ||
                      plot.tab === "recap" ||
                      plot.tab === "dcir" ||
                      plot.tab === "steps" ||
                      plot.tab === "crate" ||
                      plot.tab === "chargeability" ? (
                      <SavedPlotPreview
                        analysisId={analysisId}
                        baseSpec={baseSpec}
                        plot={plot}
                        allowGeneration={generationPlotIds.has(plot.id)}
                      />
                    ) : (
                      <Center h={130}>
                        <Text size="xs" c="dimmed">
                          {tabLabel(plot.tab)}
                        </Text>
                      </Center>
                    )}
                  </Box>
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={6}>
                      <Badge size="xs" variant="light" color={active ? "var(--mantine-primary-color-6)" : "gray"}>
                        {tabLabel(plot.tab)}
                      </Badge>
                      <Text fw={700} truncate>
                        {plot.name}
                      </Text>
                      {active && activePlotDirty ? (
                        <Badge size="xs" variant="light" color="yellow">
                          Edited
                        </Badge>
                      ) : null}
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {plot.subtitle}
                    </Text>
                    {plot.description && (
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {plot.description}
                      </Text>
                    )}
                    <Text size="10px" c="dimmed">
                      Saved {new Date(plot.modified_at).toLocaleString()}
                    </Text>
                  </Stack>
                  <Stack gap={6} justify="center" w={86}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<IconPencil size={14} />}
                      aria-label={`Rename ${plot.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenamePlot(plot);
                        setRenameName(plot.name);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={(event) => {
                        event.stopPropagation();
                        modals.openConfirmModal({
                          title: "Delete this saved plot?",
                          children: (
                            <Text size="sm">
                              &quot;{plot.name}&quot; will be removed from this analysis. This cannot be undone.
                            </Text>
                          ),
                          labels: { confirm: "Delete", cancel: "Cancel" },
                          confirmProps: { color: "red" },
                          onConfirm: () => onDelete(plot.id),
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </Stack>
                </Group>
              </Box>
            );
          })}
        </Stack>
      )}
      </Paper>
      <Modal
        opened={renamePlot !== null}
        onClose={closeRename}
        onEnterTransitionEnd={focusRenameInput}
        title="Rename saved plot"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <Stack gap="md">
            <TextInput
              ref={renameInputRef}
              label="Plot name"
              value={renameName}
              autoFocus
              maxLength={SAVED_PLOT_NAME_MAX_LENGTH}
              error={renameName.length > 0 ? renameValidation.error : null}
              onChange={(event) => setRenameName(event.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button type="button" variant="default" onClick={closeRename}>
                Cancel
              </Button>
              <Button type="submit" disabled={Boolean(renameValidation.error)}>
                Rename
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
