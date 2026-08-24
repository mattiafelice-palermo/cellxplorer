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
  MouseEventHandler,
  PointerEventHandler,
  ReactElement,
  ReactNode,
} from "react";

import type { AnalysisSpec } from "../../../../../api";
import type { TimeCapacityConfig } from "./TimeCapacityPlotCard";
import {
  appendTimeCapacityCycleHistory,
  centerTimeCapacityCycleRange,
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
  type TimeCapacityCycleRange,
} from "./timeCapacityCycleNavigationPolicy";

interface DraftCycleNumberInputProps {
  value: number;
  label: string;
  onCommit: (value: number | null) => number;
  disabled?: boolean;
  disabledReason?: string;
  max?: number;
}

function DraftCycleNumberInput({
  value,
  label,
  onCommit,
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
      w={62}
      disabled={disabled}
      styles={{ input: { textAlign: "center" } }}
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
  onClick,
}: {
  label: string;
  tooltipLabel?: string;
  disabled: boolean;
  disabledReason?: string;
  children: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
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
      onClick={onClick}
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
  onPreview: (range: TimeCapacityCycleRange) => void;
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
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startRange: TimeCapacityCycleRange;
    latestRange: TimeCapacityCycleRange;
  } | null>(null);
  const keyboardRangeRef = useRef<TimeCapacityCycleRange | null>(null);
  const width = cycleRangeWidth(range);
  const segmentLeft = ((range.start - 1) / maxAvailableCycle) * 100;
  const segmentWidth = (width / maxAvailableCycle) * 100;

  const rangeAtPointer = useCallback(
    (clientX: number, startX: number, startRange: TimeCapacityCycleRange) => {
      const track = trackRef.current;
      if (!track) return startRange;
      const rect = track.getBoundingClientRect();
      return timeCapacityCycleRangeAtPointerDelta(
        startRange,
        clientX - startX,
        rect.width,
        maxAvailableCycle,
      );
    },
    [maxAvailableCycle],
  );

  const handlePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startRange: range,
        latestRange: range,
      };
    },
    [disabled, range],
  );

  const handlePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const next = rangeAtPointer(event.clientX, drag.startX, drag.startRange);
      if (next.start === drag.latestRange.start && next.end === drag.latestRange.end) return;
      drag.latestRange = next;
      onPreview(next);
    },
    [onPreview, rangeAtPointer],
  );

  const finishPointer = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onCommit(drag.latestRange);
    },
    [onCommit],
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
      if (next.start !== range.start || next.end !== range.end) onPreview(next);
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
        component="span"
        aria-hidden
        data-cycle-window-segment
        style={{
          position: "absolute",
          left: `${segmentLeft}%`,
          width: `${segmentWidth}%`,
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
  onCommitRange,
  onPreviewRangeChange,
  isVirgin = false,
  navigationResetKey = "",
  spec,
}: {
  config: Pick<TimeCapacityConfig, "cycle_start" | "cycle_end" | "cycles">;
  maxAvailableCycle: number | null;
  onCommitRange: (range: TimeCapacityCycleRange) => void;
  onPreviewRangeChange?: (range: TimeCapacityCycleRange | null) => void;
  isVirgin?: boolean;
  navigationResetKey?: string | number;
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
  const currentWidth = cycleRangeWidth(storedRange);
  const hasBound = maxAvailableCycle !== null && maxAvailableCycle > 0;
  const specificCyclesActive = timeCapacityRangeNavigationDisabled(config.cycles);
  const boundDependentDisabled = !hasBound;
  const boundedNavigationDisabled = specificCyclesActive || boundDependentDisabled;
  const disabledReason = specificCyclesActive
    ? "Clear Specific cycles in the Cycles settings to navigate a continuous range"
    : "Cycle extent is not available yet";
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
  const [jumpDraft, setJumpDraft] = useState("");
  const { ref: navigationRef, width: navigationWidth } = useElementSize();
  const sliderCloseTimerRef = useRef<number | null>(null);
  const triggerHoveredRef = useRef(false);
  const dropdownHoveredRef = useRef(false);
  const sliderFocusRef = useRef(false);
  const virginDefaultPendingRef = useRef(isVirgin);
  const virginDefaultAppliedRef = useRef(false);
  const applyingVirginDefaultRef = useRef(false);

  const visibleRange = sliderPreviewRange ?? boundedRange;

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
    if (specificCyclesActive || !hasBound || cycleRangeWidth(boundedRange) >= maxAvailableCycle!) {
      setSliderOpened(false);
      setSliderPreviewRange(null);
      onPreviewRangeChange?.(null);
    }
  }, [boundedRange, hasBound, maxAvailableCycle, onPreviewRangeChange, specificCyclesActive]);

  const commitRange = useCallback(
    (nextRange: TimeCapacityCycleRange, recordHistory = true) => {
      if (!applyingVirginDefaultRef.current) {
        virginDefaultPendingRef.current = false;
      }
      const currentForHistory = normalizeCycleRangeForNavigation(
        config.cycle_start,
        config.cycle_end,
        maxAvailableCycle,
      );
      const sameStoredRange =
        config.cycle_start === nextRange.start && config.cycle_end === nextRange.end;
      if (sameStoredRange) return false;

      setSliderPreviewRange(null);
      onPreviewRangeChange?.(null);

      if (recordHistory) {
        const nextHistory = appendTimeCapacityCycleHistory(historyRef.current, currentForHistory);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      }
      onCommitRange(nextRange);
      return true;
    },
    [config.cycle_end, config.cycle_start, maxAvailableCycle, onCommitRange, onPreviewRangeChange],
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
      if (specificCyclesActive) return;
      const next = navigateTimeCapacityCycleRange(
        boundedRange,
        direction,
        mode,
        maxAvailableCycle,
        boundary,
      );
      if (next) commitRange(next);
    },
    [boundedRange, commitRange, maxAvailableCycle, specificCyclesActive],
  );

  const resize = useCallback(
    (value: string | null) => {
      if (!value || boundedNavigationDisabled || !hasBound) return;
      commitRange(resizeTimeCapacityCycleRange(boundedRange, Number(value), maxAvailableCycle));
    },
    [boundedNavigationDisabled, boundedRange, commitRange, hasBound, maxAvailableCycle],
  );

  const jump = useCallback(() => {
    if (!jumpDraft.trim() || boundedNavigationDisabled || !hasBound) return;
    const target = Number(jumpDraft);
    if (!Number.isFinite(target) || target <= 0) return;
    const committed = commitRange(
      centerTimeCapacityCycleRange(boundedRange, target, maxAvailableCycle),
    );
    if (committed) setJumpDraft("");
  }, [boundedNavigationDisabled, boundedRange, commitRange, hasBound, jumpDraft, maxAvailableCycle]);

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
    if (boundedNavigationDisabled || !hasBound || cycleRangeWidth(boundedRange) >= maxAvailableCycle!) return;
    setSliderPreviewRange(null);
    onPreviewRangeChange?.(null);
    setSliderOpened(true);
  }, [boundedNavigationDisabled, boundedRange, hasBound, maxAvailableCycle, onPreviewRangeChange]);

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
    (range: TimeCapacityCycleRange) => {
      setSliderPreviewRange(range);
      onPreviewRangeChange?.(range);
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

  const sliderAtFullExtent = hasBound && cycleRangeWidth(boundedRange) >= maxAvailableCycle!;
  const sliderDisabled = boundedNavigationDisabled || sliderAtFullExtent;
  const sliderDisabledReason = specificCyclesActive || !hasBound
    ? disabledReason
    : sliderAtFullExtent
      ? "The current window already shows all cycles"
      : "Move cycle window";
  const previousDisabled = timeCapacityPreviousViewDisabled(config.cycles, history.length);
  const previousDisabledReason = specificCyclesActive
    ? disabledReason
    : "No previous cycle view";
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
              w={60}
              disabled={boundedNavigationDisabled}
            />,
            boundedNavigationDisabled,
            disabledReason,
          )}

          <Button.Group>
            <NavigationSegmentButton
              label="Previous cycle window"
              tooltipLabel="Previous window · Ctrl+click: first window"
              disabled={boundedNavigationDisabled}
              disabledReason={disabledReason}
              onClick={(event) => move(-1, "window", event.ctrlKey ? "first" : undefined)}
            >
              <IconChevronsLeft size={14} />
            </NavigationSegmentButton>
            <NavigationSegmentButton
              label="Previous cycle"
              tooltipLabel="Previous cycle · Ctrl+click: first window"
              disabled={specificCyclesActive}
              disabledReason={disabledReason}
              onClick={(event) => move(-1, "cycle", event.ctrlKey ? "first" : undefined)}
            >
              <IconChevronLeft size={14} />
            </NavigationSegmentButton>
          </Button.Group>

          <DraftCycleNumberInput
            value={visibleRange.start}
            label="From cycle"
            onCommit={commitManualStart}
            disabled={specificCyclesActive}
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
            disabled={specificCyclesActive}
            disabledReason={disabledReason}
            max={hasBound ? maxAvailableCycle! : undefined}
          />

          <Button.Group>
            <NavigationSegmentButton
              label="Next cycle"
              tooltipLabel="Next cycle · Ctrl+click: last window"
              disabled={boundedNavigationDisabled}
              disabledReason={disabledReason}
              onClick={(event) => move(1, "cycle", event.ctrlKey ? "last" : undefined)}
            >
              <IconChevronRight size={14} />
            </NavigationSegmentButton>
            <NavigationSegmentButton
              label="Next cycle window"
              tooltipLabel="Next window · Ctrl+click: last window"
              disabled={boundedNavigationDisabled}
              disabledReason={disabledReason}
              onClick={(event) => move(1, "window", event.ctrlKey ? "last" : undefined)}
            >
              <IconChevronsRight size={14} />
            </NavigationSegmentButton>
          </Button.Group>
          {specificCyclesActive && (
            <Tooltip label={disabledReason} withArrow>
              <Text size="xs" c="dimmed" style={{ flex: "0 1 auto" }}>
                Specific cycles active
              </Text>
            </Tooltip>
          )}
          {!specificCyclesActive && !hasBound && (
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
            Jump to
          </Text>
          {withControlTooltip(
            "Jump to cycle",
            <NumberInput
              aria-label="Jump to cycle"
              placeholder="Cycle"
              value={jumpDraft}
              onChange={(value) => setJumpDraft(String(value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jump();
                }
              }}
              min={1}
              max={hasBound ? maxAvailableCycle! : undefined}
              allowDecimal={false}
              allowNegative={false}
              hideControls
              size="xs"
              w={72}
              disabled={boundedNavigationDisabled}
            />,
            boundedNavigationDisabled,
            disabledReason,
          )}
        </Group>
      </Box>
    </Paper>
  );
}
