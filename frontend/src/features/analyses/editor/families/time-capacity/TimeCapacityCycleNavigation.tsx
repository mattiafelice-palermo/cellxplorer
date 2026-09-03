import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  NumberInput,
  Paper,
  Popover,
  Select,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import {
  IconArrowLeft,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconHome,
  IconInfoCircle,
  IconPlayerTrackNext,
  IconPlayerTrackPrev,
} from "@tabler/icons-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FocusEventHandler,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactElement,
  ReactNode,
} from "react";

import type { AnalysisSpec } from "../../../../../api";
import type { TimeCapacityConfig } from "./TimeCapacityPlotCard";
import {
  appendTimeCapacityCycleHistory,
  clampCycleWindow,
  cycleRangeWidth,
  cycleWindowOptions,
  navigateTimeCapacityCycleRange,
  normalizeCycleRangeForNavigation,
  normalizeManualTimeCapacityRange,
  normalizeTimeCapacityRange,
  resizeTimeCapacityCycleRange,
  selectTimeCapacityCycleHistory,
  shiftTimeCapacityCycleRange,
  timeCapacityPreviousViewDisabled,
  timeCapacityRangeNavigationDisabled,
  timeCapacityVirginDefaultCanApply,
  timeCapacityVirginCycleRange,
  timeCapacityCycleRangeAtPointerDelta,
  timeCapacityCycleRangeAtTrackPosition,
  timeCapacityCycleStartAtPointerDelta,
  timeCapacityCycleStartAtTrackPosition,
  timeCapacityCycleSliderGeometry,
  timeCapacityCycleNavigationDisabledAtBoundary,
  parseTimeCapacitySpecificCycles,
  type TimeCapacityCycleRange,
} from "./timeCapacityCycleNavigationPolicy";

interface DraftCycleNumberInputProps {
  value: number;
  label: string;
  onCommit: (value: number | null) => number;
  extreme: "first" | "last";
  disabled?: boolean;
  disabledReason?: string;
  max?: number;
}

function DraftCycleNumberInput({
  value,
  label,
  onCommit,
  extreme,
  disabled = false,
  disabledReason,
  max,
}: DraftCycleNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const focusedRef = useRef(false);
  const lastCommittedTextRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(String(value));
      lastCommittedTextRef.current = null;
    }
  }, [value]);

  const commit = useCallback(() => {
    const text = draft.trim();
    if (lastCommittedTextRef.current === text) return;
    lastCommittedTextRef.current = text;
    if (text === "") {
      setDraft(String(value));
      return;
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) {
      setDraft(String(value));
      return;
    }
    setDraft(String(onCommit(numeric)));
  }, [draft, onCommit]);

  const extremeValue = extreme === "first" ? 1 : max ?? null;
  const extremeLabel =
    extreme === "first"
      ? `Set ${label.toLowerCase()} to first cycle`
      : `Set ${label.toLowerCase()} to last cycle`;
  const applyExtreme = useCallback(() => {
    if (disabled || extremeValue === null) return;
    const committed = onCommit(extremeValue);
    lastCommittedTextRef.current = String(committed);
    setDraft(String(committed));
  }, [disabled, extremeValue, onCommit]);

  return withControlTooltip(
    label,
    <NumberInput
      value={draft}
      onChange={(next) => {
        setDraft(String(next));
        lastCommittedTextRef.current = null;
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          focusedRef.current = false;
          lastCommittedTextRef.current = draft.trim();
          setDraft(String(value));
          event.currentTarget.blur();
        } else if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
      aria-label={label}
      title={disabled ? disabledReason : label}
      min={1}
      max={max}
      allowDecimal={false}
      allowNegative={false}
      hideControls
      size="xs"
      w={78}
      disabled={disabled}
      leftSectionPointerEvents="all"
      leftSectionWidth={26}
      leftSection={
        <ActionIcon
          size="xs"
          variant="subtle"
          color="gray"
          aria-label={extremeLabel}
          title={extremeValue === null ? "Cycle extent is not available yet" : extremeLabel}
          disabled={disabled || extremeValue === null}
          // Keep the draft input focused so its blur handler cannot commit a
          // stale value before the extreme action is applied.
          onMouseDown={(event) => event.preventDefault()}
          onClick={applyExtreme}
        >
          {extreme === "first" ? <IconPlayerTrackPrev size={13} /> : <IconPlayerTrackNext size={13} />}
        </ActionIcon>
      }
      styles={{ input: { textAlign: "center", paddingLeft: 28, paddingRight: 8 } }}
    />,
    disabled,
    disabledReason,
  );
}

function withControlTooltip(
  label: string,
  child: ReactElement,
  disabled = false,
  disabledLabel?: string,
) {
  const tooltipLabel = disabled ? disabledLabel ?? label : label;
  if (!disabled) return <Tooltip label={tooltipLabel} withArrow>{child}</Tooltip>;
  return (
    <Tooltip label={tooltipLabel} withArrow>
      <Box component="span" style={{ display: "inline-block" }}>
        {child}
      </Box>
    </Tooltip>
  );
}

function NavigationSegmentButton({
  label,
  tooltipLabel,
  disabled,
  disabledReason,
  children,
  onActivate,
}: {
  label: string;
  tooltipLabel?: string;
  disabled: boolean;
  disabledReason?: string;
  children: ReactNode;
  onActivate: (ctrlKey: boolean) => void;
}) {
  return withControlTooltip(
    tooltipLabel ?? label,
    <Button
      size="xs"
      variant="default"
      px={6}
      style={{ minWidth: 29 }}
      aria-label={label}
      title={disabled ? disabledReason : label}
      disabled={disabled}
      // Pointer activation is intentionally handled on press, not release.
      // With sub-100 ms Time/Capacity responses, the ordinary browser
      // pointerdown-to-click gap had become the dominant perceived latency.
      // Physical clicks have detail > 0 and were already handled here;
      // keyboard and assistive clicks have detail 0 and retain native access.
      onPointerDown={(event) => {
        if (event.isPrimary && event.button === 0) onActivate(event.ctrlKey);
      }}
      onClick={(event) => {
        if (event.detail === 0) onActivate(event.ctrlKey);
      }}
    >
      {children}
    </Button>,
    disabled,
    disabledReason,
  );
}

interface CycleWindowSliderProps {
  range: TimeCapacityCycleRange;
  maxAvailableCycle: number;
  disabled: boolean;
  onPreview: (range: TimeCapacityCycleRange, continuousStart: number) => void;
  onCommit: (range: TimeCapacityCycleRange) => void;
  onCancel: () => void;
}

function CycleWindowSlider({
  range,
  maxAvailableCycle,
  disabled,
  onPreview,
  onCommit,
  onCancel,
}: CycleWindowSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startRange: TimeCapacityCycleRange;
    startPosition: number;
    latestRange: TimeCapacityCycleRange;
    latestPosition: number;
    visualWidthCycles: number;
  } | null>(null);
  const keyboardRangeRef = useRef<TimeCapacityCycleRange | null>(null);
  const sliderGeometry = timeCapacityCycleSliderGeometry(range, maxAvailableCycle);
  const visualPositionRef = useRef(range.start);
  if (!dragRef.current) visualPositionRef.current = range.start;
  const updateVisualHandle = useCallback(
    (position: number) => {
      visualPositionRef.current = position;
      const handle = handleRef.current;
      if (!handle) return;
      const width = range.end - range.start + 1;
      const availableStarts = Math.max(0, maxAvailableCycle - width);
      const travelPercent = Math.max(0, 100 - sliderGeometry.widthPercent);
      const left = availableStarts <= 0
        ? 0
        : ((Math.max(1, Math.min(availableStarts + 1, position)) - 1) / availableStarts) * travelPercent;
      handle.style.left = `${left}%`;
    },
    [maxAvailableCycle, range.end, range.start, sliderGeometry.widthPercent],
  );

  const previewAtPointer = useCallback(
    (
      clientX: number,
      startX: number,
      startRange: TimeCapacityCycleRange,
      startPosition: number,
      visualWidthCycles: number,
    ) => {
      const track = trackRef.current;
      if (!track) return { range: startRange, position: startPosition };
      const rect = track.getBoundingClientRect();
      const deltaX = clientX - startX;
      return {
        range: timeCapacityCycleRangeAtPointerDelta(
          startRange,
          deltaX,
          rect.width,
          maxAvailableCycle,
          visualWidthCycles,
        ),
        position: timeCapacityCycleStartAtPointerDelta(
          startRange,
          deltaX,
          rect.width,
          maxAvailableCycle,
          visualWidthCycles,
          startPosition,
        ),
      };
    },
    [maxAvailableCycle],
  );

  const handlePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      const track = trackRef.current;
      const clickedSegment =
        event.target instanceof Element &&
        event.target.closest("[data-cycle-window-segment]") !== null;
      let startRange = range;
      let startPosition = range.start;
      if (track && !clickedSegment) {
        const rect = track.getBoundingClientRect();
        startPosition = timeCapacityCycleStartAtTrackPosition(
          range,
          event.clientX - rect.left,
          rect.width,
          maxAvailableCycle,
        );
        startRange = timeCapacityCycleRangeAtTrackPosition(
          range,
          event.clientX - rect.left,
          rect.width,
          maxAvailableCycle,
        );
      }
      updateVisualHandle(startPosition);
      // The production plot is intentionally cycle-by-cycle. Grabbing the
      // existing handle must not issue a redundant low-resolution request and
      // make the first frame blink; a track click still previews immediately.
      if (startRange.start !== range.start || startRange.end !== range.end) {
        onPreview(startRange, startPosition);
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startRange,
        startPosition,
        latestRange: startRange,
        latestPosition: startPosition,
        visualWidthCycles: sliderGeometry.visualWidthCycles,
      };
    },
    [
      disabled,
      maxAvailableCycle,
      onPreview,
      range,
      sliderGeometry.visualWidthCycles,
      updateVisualHandle,
    ],
  );

  const handlePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const next = previewAtPointer(
        event.clientX,
        drag.startX,
        drag.startRange,
        drag.startPosition,
        drag.visualWidthCycles,
      );
      if (Math.abs(next.position - drag.latestPosition) < 1e-4) return;
      const rangeChanged =
        next.range.start !== drag.latestRange.start || next.range.end !== drag.latestRange.end;
      drag.latestRange = next.range;
      drag.latestPosition = next.position;
      updateVisualHandle(next.position);
      // Keep the thumb following every pointer pixel, but publish plot work
      // only when the selected integer cycle window changes. Each published
      // response is independently re-zeroed, so Cells cannot drift in phase.
      if (rangeChanged) onPreview(next.range, next.position);
    },
    [onPreview, previewAtPointer, updateVisualHandle],
  );

  const finishPointer = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // Browsers may coalesce the final pointer movement into pointerup. Use
      // its actual coordinate instead of committing the last pointermove
      // sample, which can lag behind by several cycles during a fast drag.
      const final = previewAtPointer(
        event.clientX,
        drag.startX,
        drag.startRange,
        drag.startPosition,
        drag.visualWidthCycles,
      );
      const finalRange = final.range;
      drag.latestRange = finalRange;
      drag.latestPosition = final.position;
      updateVisualHandle(final.position);
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onCommit(finalRange);
    },
    [onCommit, previewAtPointer, updateVisualHandle],
  );

  const handleKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        keyboardRangeRef.current = null;
        onCancel();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = shiftTimeCapacityCycleRange(
        range,
        event.key === "ArrowLeft" ? -1 : 1,
        "cycle",
        maxAvailableCycle,
      );
      keyboardRangeRef.current = next;
      if (next.start !== range.start || next.end !== range.end) onPreview(next, next.start);
    },
    [maxAvailableCycle, onCancel, onPreview, range],
  );

  const handleKeyUp = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const next = keyboardRangeRef.current;
      keyboardRangeRef.current = null;
      if (next) onCommit(next);
    },
    [onCommit],
  );

  return (
    <Box
      ref={trackRef}
      role="slider"
      aria-label="Cycle window position"
      aria-valuemin={1}
      aria-valuemax={maxAvailableCycle}
      aria-valuenow={Math.round((range.start + range.end) / 2)}
      aria-valuetext={`Cycles ${range.start} to ${range.end}`}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={() => {
        dragRef.current = null;
        updateVisualHandle(range.start);
        onCancel();
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      data-cycle-window-slider
      style={{
        position: "relative",
        height: 28,
        display: "flex",
        alignItems: "center",
        cursor: disabled ? "not-allowed" : "default",
        outline: "none",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Box
        component="span"
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: 6,
          borderRadius: 999,
          background: "var(--mantine-color-default-border)",
        }}
      />
      <Box
        ref={handleRef}
        component="span"
        aria-hidden
        data-cycle-window-segment
        style={{
          position: "absolute",
          left: `${
            Math.max(0, maxAvailableCycle - (range.end - range.start + 1)) <= 0
              ? 0
              : ((visualPositionRef.current - 1) /
                  Math.max(1, maxAvailableCycle - (range.end - range.start + 1))) *
                Math.max(0, 100 - sliderGeometry.widthPercent)
          }%`,
          width: `${sliderGeometry.widthPercent}%`,
          height: 10,
          borderRadius: 999,
          background: "var(--mantine-primary-color-6)",
          boxShadow: "0 0 0 1px var(--mantine-primary-color-7)",
          cursor: disabled ? "not-allowed" : "grab",
        }}
      />
      <Box
        component="span"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "var(--mantine-radius-sm)",
          pointerEvents: "none",
        }}
      />
    </Box>
  );
}

function NavigationIconAction({
  label,
  disabled,
  disabledReason,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return withControlTooltip(
    label,
    <ActionIcon
      size="sm"
      variant="subtle"
      aria-label={label}
      title={disabled ? disabledReason : label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </ActionIcon>,
    disabled,
    disabledReason,
  );
}

interface CyclePositionTriggerProps {
  opened: boolean;
  disabled: boolean;
  tooltipLabel: string;
  onClick: () => void;
  onPointerEnter?: PointerEventHandler<HTMLButtonElement>;
  onPointerLeave?: PointerEventHandler<HTMLButtonElement>;
  onFocus?: FocusEventHandler<HTMLButtonElement>;
  onBlur?: FocusEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

const CyclePositionTrigger = forwardRef<HTMLButtonElement, CyclePositionTriggerProps>(
  function CyclePositionTrigger(
    {
      opened,
      disabled,
      tooltipLabel,
      onClick,
      onPointerEnter,
      onPointerLeave,
      onFocus,
      onBlur,
      onKeyDown,
    },
    ref,
  ) {
    return (
    <UnstyledButton
      ref={ref}
      type="button"
      aria-label="Open cycle position slider"
      aria-haspopup="dialog"
      aria-expanded={opened}
      title={disabled ? tooltipLabel : undefined}
      disabled={disabled}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      styles={{
        root: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 38,
          minWidth: 38,
          height: 28,
          borderRadius: "var(--mantine-radius-sm)",
          color: opened
            ? "var(--mantine-primary-color-6)"
            : "var(--mantine-color-dimmed)",
          opacity: disabled ? 0.45 : 1,
          "&:hover": disabled
            ? undefined
            : {
                background: "var(--mantine-primary-color-light)",
                color: "var(--mantine-primary-color-7)",
              },
          "&:focus-visible": {
            outline: "2px solid var(--mantine-primary-color-5)",
            outlineOffset: 1,
          },
        },
      }}
    >
      <Box component="span" aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        <Box component="span" style={{ width: 10, height: 1, background: "currentColor" }} />
        <Box component="span" style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
        <Box component="span" style={{ width: 10, height: 1, background: "currentColor" }} />
      </Box>
    </UnstyledButton>
    );
  },
);

export function TimeCapacityCycleNavigation({
  config,
  maxAvailableCycle,
  viewportCycleRange = null,
  onCommitRange,
  onCommitSpecificCycles,
  onResetViewport,
  onPreviewRangeChange,
  onWarmRange,
  isVirgin = false,
  navigationResetKey = "",
  viewportChangeKey,
  spec,
}: {
  config: Pick<TimeCapacityConfig, "cycle_start" | "cycle_end" | "cycles">;
  maxAvailableCycle: number | null;
  viewportCycleRange?: TimeCapacityCycleRange | null;
  onCommitRange: (range: TimeCapacityCycleRange) => void;
  onCommitSpecificCycles: (cycles: number[]) => void;
  onResetViewport?: () => void;
  onPreviewRangeChange?: (
    range: TimeCapacityCycleRange | null,
    continuousStart?: number | null,
  ) => void;
  onWarmRange?: (range: TimeCapacityCycleRange) => void;
  isVirgin?: boolean;
  navigationResetKey?: string | number;
  viewportChangeKey?: number;
  spec: AnalysisSpec;
}) {
  const storedRange = useMemo(
    () => normalizeTimeCapacityRange(config.cycle_start, config.cycle_end),
    [config.cycle_end, config.cycle_start],
  );
  const boundedRange = useMemo(
    () => normalizeCycleRangeForNavigation(config.cycle_start, config.cycle_end, maxAvailableCycle),
    [config.cycle_end, config.cycle_start, maxAvailableCycle],
  );
  const navigationRange = useMemo(
    () =>
      viewportCycleRange
        ? normalizeCycleRangeForNavigation(
            viewportCycleRange.start,
            viewportCycleRange.end,
            maxAvailableCycle,
          )
        : boundedRange,
    [boundedRange, maxAvailableCycle, viewportCycleRange],
  );
  // Plotly may still be finishing the previous frame when the user presses an
  // arrow again. Keep an optimistic button-only range so rapid presses compose
  // instead of reusing a stale render and silently dropping a step.
  const buttonRangeRef = useRef(navigationRange);
  useEffect(() => {
    buttonRangeRef.current = navigationRange;
  }, [navigationRange.end, navigationRange.start, navigationResetKey]);
  const currentWidth = cycleRangeWidth(viewportCycleRange ? navigationRange : storedRange);
  const hasBound = maxAvailableCycle !== null && maxAvailableCycle > 0;
  const specificCyclesActive = timeCapacityRangeNavigationDisabled(config.cycles);
  const boundDependentDisabled = !hasBound;
  const boundedNavigationDisabled = boundDependentDisabled;
  const disabledReason = "Cycle extent is not available yet";
  const previousNavigationDisabled =
    boundedNavigationDisabled ||
    timeCapacityCycleNavigationDisabledAtBoundary(
      navigationRange,
      -1,
      "cycle",
      maxAvailableCycle,
    );
  const nextNavigationDisabled =
    boundedNavigationDisabled ||
    timeCapacityCycleNavigationDisabledAtBoundary(
      navigationRange,
      1,
      "cycle",
      maxAvailableCycle,
    );
  const previousNavigationDisabledReason = boundedNavigationDisabled
    ? disabledReason
    : "Already at the first cycle";
  const nextNavigationDisabledReason = boundedNavigationDisabled
    ? disabledReason
    : "Already at the last cycle";
  const selectionIdentity = useMemo(
    () =>
      JSON.stringify(
        (spec.selection.entries ?? []).map((entry) => ({ kind: entry.kind, ref_id: entry.ref_id })),
      ),
    [spec.selection.entries],
  );
  const windowOptions = useMemo(
    () => cycleWindowOptions(currentWidth, maxAvailableCycle),
    [currentWidth, maxAvailableCycle],
  );
  const [history, setHistory] = useState<TimeCapacityCycleRange[]>([]);
  const historyRef = useRef<TimeCapacityCycleRange[]>([]);
  const [sliderOpened, setSliderOpened] = useState(false);
  const [sliderPreviewRange, setSliderPreviewRange] = useState<TimeCapacityCycleRange | null>(null);
  const [specificCyclesDraft, setSpecificCyclesDraft] = useState(() => (config.cycles ?? []).join(", "));
  const { ref: navigationRef, width: navigationWidth } = useElementSize();
  const sliderCloseTimerRef = useRef<number | null>(null);
  const triggerHoveredRef = useRef(false);
  const dropdownHoveredRef = useRef(false);
  const sliderFocusRef = useRef(false);
  const specificCyclesResetKeyRef = useRef(navigationResetKey);
  const specificCyclesViewportChangeKeyRef = useRef(viewportChangeKey);
  const virginDefaultPendingRef = useRef(isVirgin);
  const virginDefaultAppliedRef = useRef(false);
  const applyingVirginDefaultRef = useRef(false);

  const visibleRange = sliderPreviewRange ?? navigationRange;

  useEffect(() => {
    virginDefaultPendingRef.current = isVirgin;
    virginDefaultAppliedRef.current = false;
  }, [isVirgin, navigationResetKey]);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    setHistory([]);
    setSliderOpened(false);
    setSliderPreviewRange(null);
    onPreviewRangeChange?.(null);
  }, [onPreviewRangeChange]);

  useEffect(() => {
    clearHistory();
  }, [clearHistory, navigationResetKey, selectionIdentity]);

  useEffect(() => {
    if (!hasBound || cycleRangeWidth(navigationRange) >= maxAvailableCycle!) {
      setSliderOpened(false);
      setSliderPreviewRange(null);
      onPreviewRangeChange?.(null);
    }
  }, [hasBound, maxAvailableCycle, navigationRange, onPreviewRangeChange]);

  useEffect(() => {
    // The component stays mounted while plots are switched. Refresh the field
    // for the newly selected plot, but do not overwrite text the user has
    // entered while editing the current one.
    if (specificCyclesResetKeyRef.current === navigationResetKey) return;
    specificCyclesResetKeyRef.current = navigationResetKey;
    setSpecificCyclesDraft((config.cycles ?? []).join(", "));
  }, [config.cycles, navigationResetKey]);

  useEffect(() => {
    if (specificCyclesViewportChangeKeyRef.current === viewportChangeKey) return;
    specificCyclesViewportChangeKeyRef.current = viewportChangeKey;
    setSpecificCyclesDraft("");
  }, [viewportChangeKey]);

  const commitRange = useCallback(
    (nextRange: TimeCapacityCycleRange, recordHistory = true) => {
      if (!applyingVirginDefaultRef.current) {
        virginDefaultPendingRef.current = false;
      }
      const currentForHistory = navigationRange;
      const sameStoredRange =
        config.cycle_start === nextRange.start && config.cycle_end === nextRange.end;
      setSpecificCyclesDraft("");
      if (sameStoredRange) {
        onResetViewport?.();
        setSliderPreviewRange(null);
        onPreviewRangeChange?.(null);
        return false;
      }

      if (recordHistory) {
        const nextHistory = appendTimeCapacityCycleHistory(historyRef.current, currentForHistory);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      }
      // Publish the committed endpoint while the parent still has access to
      // the live pan refs. It can then retain that exact viewport while the
      // narrow committed query replaces the wider resident buffer.
      onCommitRange(nextRange);
      setSliderPreviewRange(null);
      onPreviewRangeChange?.(null);
      return true;
    },
    [
      config.cycle_end,
      config.cycle_start,
      navigationRange,
      onCommitRange,
      onPreviewRangeChange,
      onResetViewport,
    ],
  );

  useEffect(() => {
    if (!timeCapacityVirginDefaultCanApply(
      isVirgin,
      virginDefaultPendingRef.current,
      virginDefaultAppliedRef.current,
      specificCyclesActive,
      maxAvailableCycle,
    )) return;
    const next = timeCapacityVirginCycleRange(maxAvailableCycle);
    if (!next) return;
    applyingVirginDefaultRef.current = true;
    commitRange(next, false);
    applyingVirginDefaultRef.current = false;
    virginDefaultAppliedRef.current = true;
    virginDefaultPendingRef.current = false;
  }, [commitRange, hasBound, isVirgin, maxAvailableCycle, specificCyclesActive]);

  const commitManualStart = useCallback(
    (value: number | null) => {
      const next = normalizeManualTimeCapacityRange(
        visibleRange,
        { start: value },
        maxAvailableCycle,
      );
      commitRange(next);
      return next.start;
    },
    [commitRange, maxAvailableCycle, visibleRange],
  );

  const commitManualEnd = useCallback(
    (value: number | null) => {
      const next = normalizeManualTimeCapacityRange(
        visibleRange,
        { end: value },
        maxAvailableCycle,
      );
      commitRange(next);
      return next.end;
    },
    [commitRange, maxAvailableCycle, visibleRange],
  );

  const move = useCallback(
    (
      direction: -1 | 1,
      mode: "cycle" | "window",
      boundary?: "first" | "last",
    ) => {
      const next = navigateTimeCapacityCycleRange(
        buttonRangeRef.current,
        direction,
        mode,
        maxAvailableCycle,
        boundary,
      );
      if (next) {
        buttonRangeRef.current = next;
        commitRange(next);
      }
    },
    [commitRange, maxAvailableCycle],
  );

  const resize = useCallback(
    (value: string | null) => {
      if (!value || boundedNavigationDisabled || !hasBound) return;
      commitRange(resizeTimeCapacityCycleRange(navigationRange, Number(value), maxAvailableCycle));
    },
    [boundedNavigationDisabled, commitRange, hasBound, maxAvailableCycle, navigationRange],
  );

  const commitSpecificCycles = useCallback(() => {
    if (!hasBound) return;
    const parsed = parseTimeCapacitySpecificCycles(specificCyclesDraft, maxAvailableCycle);
    if (parsed === null) return;
    if (parsed.length === 0 && !specificCyclesActive) return;
    onCommitSpecificCycles(parsed);
  }, [hasBound, maxAvailableCycle, onCommitSpecificCycles, specificCyclesActive, specificCyclesDraft]);

  const showAll = useCallback(() => {
    if (boundedNavigationDisabled || !hasBound) return;
    commitRange(clampCycleWindow(1, maxAvailableCycle!, maxAvailableCycle!));
  }, [boundedNavigationDisabled, commitRange, hasBound, maxAvailableCycle]);

  const restorePrevious = useCallback(() => {
    const previous = historyRef.current[historyRef.current.length - 1];
    if (!previous) return;
    const nextHistory = historyRef.current.slice(0, -1);
    historyRef.current = nextHistory;
    setHistory(nextHistory);
    const restored = hasBound
      ? normalizeCycleRangeForNavigation(previous.start, previous.end, maxAvailableCycle)
      : previous;
    commitRange(restored, false);
  }, [commitRange, hasBound, maxAvailableCycle]);

  const restoreHistoryEntry = useCallback(
    (index: number) => {
      const selected = selectTimeCapacityCycleHistory(historyRef.current, index);
      if (!selected) return;
      historyRef.current = selected.history;
      setHistory(selected.history);
      const restored = hasBound
        ? normalizeCycleRangeForNavigation(selected.range.start, selected.range.end, maxAvailableCycle)
        : selected.range;
      commitRange(restored, false);
    },
    [commitRange, hasBound, maxAvailableCycle],
  );

  const openSlider = useCallback(() => {
    if (boundedNavigationDisabled || !hasBound || cycleRangeWidth(navigationRange) >= maxAvailableCycle!) return;
    setSliderPreviewRange(null);
    onPreviewRangeChange?.(null);
    onWarmRange?.(navigationRange);
    setSliderOpened(true);
  }, [
    boundedNavigationDisabled,
    hasBound,
    maxAvailableCycle,
    navigationRange,
    onPreviewRangeChange,
    onWarmRange,
  ]);

  const closeSlider = useCallback((opened: boolean) => {
    setSliderOpened(opened);
    if (!opened) {
      setSliderPreviewRange(null);
      onPreviewRangeChange?.(null);
    }
  }, [onPreviewRangeChange]);

  const clearSliderCloseTimer = useCallback(() => {
    if (sliderCloseTimerRef.current !== null) {
      window.clearTimeout(sliderCloseTimerRef.current);
      sliderCloseTimerRef.current = null;
    }
  }, []);

  const scheduleSliderClose = useCallback(() => {
    clearSliderCloseTimer();
    sliderCloseTimerRef.current = window.setTimeout(() => {
      sliderCloseTimerRef.current = null;
      if (!triggerHoveredRef.current && !dropdownHoveredRef.current && !sliderFocusRef.current) {
        closeSlider(false);
      }
    }, 160);
  }, [clearSliderCloseTimer, closeSlider]);

  const handleTriggerPointerEnter = useCallback(() => {
    triggerHoveredRef.current = true;
    clearSliderCloseTimer();
    openSlider();
  }, [clearSliderCloseTimer, openSlider]);

  const handleTriggerPointerLeave = useCallback(() => {
    triggerHoveredRef.current = false;
    scheduleSliderClose();
  }, [scheduleSliderClose]);

  const handleTriggerFocus = useCallback(() => {
    sliderFocusRef.current = true;
    clearSliderCloseTimer();
    openSlider();
  }, [clearSliderCloseTimer, openSlider]);

  const handleTriggerBlur = useCallback(() => {
    sliderFocusRef.current = false;
    scheduleSliderClose();
  }, [scheduleSliderClose]);

  const handleDropdownPointerEnter = useCallback(() => {
    dropdownHoveredRef.current = true;
    clearSliderCloseTimer();
  }, [clearSliderCloseTimer]);

  const handleDropdownPointerLeave = useCallback(() => {
    dropdownHoveredRef.current = false;
    scheduleSliderClose();
  }, [scheduleSliderClose]);

  const handleDropdownFocus = useCallback(() => {
    sliderFocusRef.current = true;
    clearSliderCloseTimer();
  }, [clearSliderCloseTimer]);

  const handleDropdownBlur = useCallback(() => {
    sliderFocusRef.current = false;
    scheduleSliderClose();
  }, [scheduleSliderClose]);

  const handleTriggerKeyDown = useCallback<KeyboardEventHandler<HTMLButtonElement>>(
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      triggerHoveredRef.current = false;
      dropdownHoveredRef.current = false;
      sliderFocusRef.current = false;
      clearSliderCloseTimer();
      closeSlider(false);
    },
    [clearSliderCloseTimer, closeSlider],
  );

  useEffect(
    () => () => {
      clearSliderCloseTimer();
    },
    [clearSliderCloseTimer],
  );

  const previewSlider = useCallback(
    (range: TimeCapacityCycleRange, continuousStart: number) => {
      setSliderPreviewRange((current) =>
        current && current.start === range.start && current.end === range.end ? current : range,
      );
      onPreviewRangeChange?.(range, continuousStart);
    },
    [onPreviewRangeChange],
  );

  const commitSlider = useCallback(
    (range: TimeCapacityCycleRange) => {
      if (boundedNavigationDisabled || !hasBound) return;
      commitRange(normalizeCycleRangeForNavigation(range.start, range.end, maxAvailableCycle));
    },
    [boundedNavigationDisabled, commitRange, hasBound, maxAvailableCycle],
  );

  const sliderAtFullExtent = hasBound && cycleRangeWidth(navigationRange) >= maxAvailableCycle!;
  const sliderDisabled = boundedNavigationDisabled || sliderAtFullExtent;
  const sliderDisabledReason = !hasBound
    ? disabledReason
    : sliderAtFullExtent
      ? "The current window already shows all cycles"
      : "Move cycle window";
  const previousDisabled = timeCapacityPreviousViewDisabled(config.cycles, history.length);
  const previousDisabledReason = "No previous cycle view";
  const twoRowNavigation = navigationWidth === 0 || navigationWidth < 760;

  return (
    <Paper
      component="nav"
      aria-label="Cycle navigation"
      ref={navigationRef}
      p="xs"
      mb="sm"
      withBorder
      radius="sm"
      style={{ minWidth: 0 }}
    >
      <Box
        style={{
          display: "grid",
          gridTemplateColumns: twoRowNavigation
            ? "repeat(2, minmax(0, 1fr))"
            : "minmax(0, 1fr) minmax(0, max-content) minmax(0, 1fr)",
          gridTemplateAreas: twoRowNavigation ? '"left right" "center center"' : undefined,
          alignItems: "center",
          columnGap: 6,
          rowGap: 6,
          minWidth: 0,
        }}
      >
        <Group
          gap={4}
          align="center"
          justify="flex-start"
          wrap="wrap"
          style={{
            minWidth: 0,
            width: "100%",
            justifySelf: "stretch",
            gridArea: twoRowNavigation ? "left" : undefined,
          }}
        >
          <NavigationIconAction
            label="Previous cycle view"
            disabled={previousDisabled}
            disabledReason={previousDisabledReason}
            onClick={restorePrevious}
          >
            <IconArrowLeft size={15} />
          </NavigationIconAction>
          <Menu shadow="md" withinPortal position="bottom-start">
            <Menu.Target>
              <ActionIcon
                size="sm"
                variant="subtle"
                aria-label="Open previous cycle views"
                title={previousDisabled ? previousDisabledReason : "Open previous cycle views"}
                disabled={previousDisabled}
              >
                <IconChevronDown size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {history.length === 0 ? (
                <Menu.Item disabled>No previous cycle views</Menu.Item>
              ) : (
                history
                  .slice()
                  .reverse()
                  .map((entry, menuIndex) => {
                    const index = history.length - menuIndex - 1;
                    return (
                      <Menu.Item
                        key={`${entry.start}-${entry.end}-${index}`}
                        aria-label={`Restore cycles ${entry.start} to ${entry.end}`}
                        onClick={() => restoreHistoryEntry(index)}
                      >
                        Cycles {entry.start}–{entry.end}
                      </Menu.Item>
                    );
                  })
              )}
            </Menu.Dropdown>
          </Menu>
          <NavigationIconAction
            label="Show all cycles"
            disabled={boundedNavigationDisabled}
            disabledReason={disabledReason}
            onClick={showAll}
          >
            <IconHome size={15} />
          </NavigationIconAction>
        </Group>

        <Group
          gap={6}
          align="center"
          justify="center"
          wrap="nowrap"
          style={{
            minWidth: 0,
            width: "100%",
            maxWidth: "100%",
            justifySelf: "stretch",
            overflowX: twoRowNavigation ? "auto" : undefined,
            gridArea: twoRowNavigation ? "center" : undefined,
          }}
        >
          <Text size="xs" fw={700} style={{ flex: "0 0 auto" }}>
            Cycle navigation
          </Text>
          {withControlTooltip(
            "Cycle window size",
            <Select
              aria-label="Cycle window size"
              title="Cycle window size"
              data={windowOptions.map((value: number) => ({ value: String(value), label: String(value) }))}
              value={String(currentWidth)}
              onChange={resize}
              allowDeselect={false}
              searchable={false}
              size="xs"
              w={76}
              withScrollArea={false}
              comboboxProps={{ width: 96 }}
              styles={{
                input: { whiteSpace: "nowrap", textAlign: "center" },
                option: { whiteSpace: "nowrap" },
                dropdown: { overflowX: "hidden" },
              }}
              disabled={boundedNavigationDisabled}
            />,
            boundedNavigationDisabled,
            disabledReason,
          )}

          <Button.Group>
            <NavigationSegmentButton
              label="Previous cycle window"
              tooltipLabel="Previous window · Ctrl+click: first window"
              disabled={previousNavigationDisabled}
              disabledReason={previousNavigationDisabledReason}
              onActivate={(ctrlKey) => move(-1, "window", ctrlKey ? "first" : undefined)}
            >
              <IconChevronsLeft size={14} />
            </NavigationSegmentButton>
            <NavigationSegmentButton
              label="Previous cycle"
              tooltipLabel="Previous cycle · Ctrl+click: first window"
              disabled={previousNavigationDisabled}
              disabledReason={previousNavigationDisabledReason}
              onActivate={(ctrlKey) => move(-1, "cycle", ctrlKey ? "first" : undefined)}
            >
              <IconChevronLeft size={14} />
            </NavigationSegmentButton>
          </Button.Group>

          <DraftCycleNumberInput
            value={visibleRange.start}
            label="From cycle"
            onCommit={commitManualStart}
            extreme="first"
            disabled={boundDependentDisabled}
            disabledReason={disabledReason}
            max={hasBound ? maxAvailableCycle! : undefined}
          />
          <Popover
            opened={sliderOpened}
            onChange={closeSlider}
            position="top"
            offset={6}
            withArrow
            arrowPosition="center"
            arrowSize={8}
            arrowRadius={2}
            withinPortal
            shadow="md"
            radius="sm"
            width={250}
            closeOnClickOutside
            closeOnEscape
          >
            <Popover.Target>
              <CyclePositionTrigger
                opened={sliderOpened}
                disabled={sliderDisabled}
                tooltipLabel={sliderDisabled ? sliderDisabledReason : "Move cycle window"}
                onClick={openSlider}
                onPointerEnter={handleTriggerPointerEnter}
                onPointerLeave={handleTriggerPointerLeave}
                onFocus={handleTriggerFocus}
                onBlur={handleTriggerBlur}
                onKeyDown={handleTriggerKeyDown}
              />
            </Popover.Target>
            <Popover.Dropdown
              p="sm"
              onPointerEnter={handleDropdownPointerEnter}
              onPointerLeave={handleDropdownPointerLeave}
              onFocus={handleDropdownFocus}
              onBlur={handleDropdownBlur}
            >
              <CycleWindowSlider
                range={visibleRange}
                maxAvailableCycle={maxAvailableCycle ?? 1}
                disabled={sliderDisabled}
                onPreview={previewSlider}
                onCommit={commitSlider}
                onCancel={() => closeSlider(false)}
              />
            </Popover.Dropdown>
          </Popover>
          <DraftCycleNumberInput
            value={visibleRange.end}
            label="To cycle"
            onCommit={commitManualEnd}
            extreme="last"
            disabled={boundDependentDisabled}
            disabledReason={disabledReason}
            max={hasBound ? maxAvailableCycle! : undefined}
          />

          <Button.Group>
            <NavigationSegmentButton
              label="Next cycle"
              tooltipLabel="Next cycle · Ctrl+click: last window"
              disabled={nextNavigationDisabled}
              disabledReason={nextNavigationDisabledReason}
              onActivate={(ctrlKey) => move(1, "cycle", ctrlKey ? "last" : undefined)}
            >
              <IconChevronRight size={14} />
            </NavigationSegmentButton>
            <NavigationSegmentButton
              label="Next cycle window"
              tooltipLabel="Next window · Ctrl+click: last window"
              disabled={nextNavigationDisabled}
              disabledReason={nextNavigationDisabledReason}
              onActivate={(ctrlKey) => move(1, "window", ctrlKey ? "last" : undefined)}
            >
              <IconChevronsRight size={14} />
            </NavigationSegmentButton>
          </Button.Group>
          {specificCyclesActive && (
            <Tooltip label="Specific cycles are selected; cycle navigation remains available." withArrow>
              <Text size="xs" c="dimmed" style={{ flex: "0 1 auto" }}>
                Specific cycles selected
              </Text>
            </Tooltip>
          )}
          {!hasBound && (
            <Tooltip label={disabledReason} withArrow>
              <Text size="xs" c="dimmed" style={{ flex: "0 1 auto" }}>
                Cycle extent pending
              </Text>
            </Tooltip>
          )}
        </Group>

        <Group
          gap={4}
          align="center"
          justify="flex-end"
          wrap="wrap"
          style={{
            minWidth: 0,
            width: "100%",
            justifySelf: "stretch",
            gridArea: twoRowNavigation ? "right" : undefined,
          }}
        >
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            Specific cycle
          </Text>
          <Tooltip
            label="Enter one cycle (145), a comma-separated list (1, 5, 10), or a range (120-140). Combine values and ranges, then press Enter. Clear the field and press Enter to remove the selection."
            multiline
            w={300}
            withArrow
          >
            <ActionIcon size="sm" variant="subtle" aria-label="Specific cycle syntax">
              <IconInfoCircle size={14} />
            </ActionIcon>
          </Tooltip>
          {withControlTooltip(
            "Specific cycle",
            <TextInput
              aria-label="Specific cycle"
              placeholder="145, 1, 5, 120-140"
              value={specificCyclesDraft}
              onChange={(event) => setSpecificCyclesDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitSpecificCycles();
                }
              }}
              size="xs"
              w={132}
              disabled={!hasBound}
            />,
            !hasBound,
            disabledReason,
          )}
        </Group>
      </Box>
    </Paper>
  );
}
