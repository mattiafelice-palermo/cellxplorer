import {
  ActionIcon,
  Box,
  Button,
  Group,
  NumberInput,
  Paper,
  Popover,
  Select,
  Slider,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowLeft,
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
  normalizeCycleRangeForNavigation,
  normalizeManualTimeCapacityRange,
  normalizeTimeCapacityRange,
  resizeTimeCapacityCycleRange,
  shiftTimeCapacityCycleRange,
  timeCapacityPreviousViewDisabled,
  timeCapacityRangeNavigationDisabled,
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
  disabled,
  disabledReason,
  children,
  onClick,
}: {
  label: string;
  disabled: boolean;
  disabledReason?: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return withControlTooltip(
    label,
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
  navigationResetKey = "",
  spec,
}: {
  config: Pick<TimeCapacityConfig, "cycle_start" | "cycle_end" | "cycles">;
  maxAvailableCycle: number | null;
  onCommitRange: (range: TimeCapacityCycleRange) => void;
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
  const [sliderValue, setSliderValue] = useState<number | null>(null);
  const [jumpDraft, setJumpDraft] = useState("");
  const sliderCloseTimerRef = useRef<number | null>(null);
  const triggerHoveredRef = useRef(false);
  const dropdownHoveredRef = useRef(false);
  const sliderFocusRef = useRef(false);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    setHistory([]);
    setSliderOpened(false);
    setSliderValue(null);
  }, []);

  useEffect(() => {
    clearHistory();
  }, [clearHistory, navigationResetKey, selectionIdentity]);

  useEffect(() => {
    if (specificCyclesActive || !hasBound || cycleRangeWidth(boundedRange) >= maxAvailableCycle!) {
      setSliderOpened(false);
      setSliderValue(null);
    }
  }, [boundedRange, hasBound, maxAvailableCycle, specificCyclesActive]);

  const commitRange = useCallback(
    (nextRange: TimeCapacityCycleRange, recordHistory = true) => {
      const currentForHistory = normalizeCycleRangeForNavigation(
        config.cycle_start,
        config.cycle_end,
        maxAvailableCycle,
      );
      const sameStoredRange =
        config.cycle_start === nextRange.start && config.cycle_end === nextRange.end;
      if (sameStoredRange) return false;

      if (recordHistory) {
        const nextHistory = appendTimeCapacityCycleHistory(historyRef.current, currentForHistory);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      }
      onCommitRange(nextRange);
      return true;
    },
    [config.cycle_end, config.cycle_start, maxAvailableCycle, onCommitRange],
  );

  const commitManualStart = useCallback(
    (value: number | null) => {
      const next = normalizeManualTimeCapacityRange(
        storedRange,
        { start: value },
        maxAvailableCycle,
      );
      commitRange(next);
      return next.start;
    },
    [commitRange, maxAvailableCycle, storedRange],
  );

  const commitManualEnd = useCallback(
    (value: number | null) => {
      const next = normalizeManualTimeCapacityRange(
        storedRange,
        { end: value },
        maxAvailableCycle,
      );
      commitRange(next);
      return next.end;
    },
    [commitRange, maxAvailableCycle, storedRange],
  );

  const move = useCallback(
    (direction: -1 | 1, mode: "cycle" | "window") => {
      if (specificCyclesActive) return;
      if (!hasBound && (direction === 1 || mode === "window")) return;
      commitRange(shiftTimeCapacityCycleRange(boundedRange, direction, mode, maxAvailableCycle));
    },
    [boundedRange, commitRange, hasBound, maxAvailableCycle, specificCyclesActive],
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

  const openSlider = useCallback(() => {
    if (boundedNavigationDisabled || !hasBound || cycleRangeWidth(boundedRange) >= maxAvailableCycle!) return;
    setSliderValue(
      Math.round((boundedRange.start + boundedRange.end) / 2),
    );
    setSliderOpened(true);
  }, [boundedNavigationDisabled, boundedRange, hasBound, maxAvailableCycle]);

  const closeSlider = useCallback((opened: boolean) => {
    setSliderOpened(opened);
    if (!opened) setSliderValue(null);
  }, []);

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

  const commitSlider = useCallback(
    (value: number) => {
      if (boundedNavigationDisabled || !hasBound) return;
      const next = centerTimeCapacityCycleRange(boundedRange, value, maxAvailableCycle);
      commitRange(next);
      setSliderValue(Math.round((next.start + next.end) / 2));
    },
    [boundedNavigationDisabled, boundedRange, commitRange, hasBound, maxAvailableCycle],
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

  return (
    <Paper
      component="nav"
      aria-label="Cycle navigation"
      p="xs"
      mb="sm"
      withBorder
      radius="sm"
      style={{ minWidth: 0 }}
    >
      <Box
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
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
          style={{ minWidth: 0, width: "100%", justifySelf: "stretch" }}
        >
          <NavigationIconAction
            label="Previous cycle view"
            disabled={previousDisabled}
            disabledReason={previousDisabledReason}
            onClick={restorePrevious}
          >
            <IconArrowLeft size={15} />
          </NavigationIconAction>
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
          wrap="wrap"
          style={{ minWidth: 0, width: "100%", maxWidth: "100%", justifySelf: "stretch" }}
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
              disabled={boundedNavigationDisabled}
              disabledReason={disabledReason}
              onClick={() => move(-1, "window")}
            >
              <IconChevronsLeft size={14} />
            </NavigationSegmentButton>
            <NavigationSegmentButton
              label="Previous cycle"
              disabled={specificCyclesActive}
              disabledReason={disabledReason}
              onClick={() => move(-1, "cycle")}
            >
              <IconChevronLeft size={14} />
            </NavigationSegmentButton>
          </Button.Group>

          <DraftCycleNumberInput
            value={storedRange.start}
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
              <Slider
                aria-label="Cycle window position"
                min={1}
                max={maxAvailableCycle ?? 1}
                step={1}
                value={sliderValue ?? Math.round((boundedRange.start + boundedRange.end) / 2)}
                onChange={setSliderValue}
                onChangeEnd={commitSlider}
                label={(value) => `Cycle ${value}`}
                disabled={sliderDisabled}
              />
            </Popover.Dropdown>
          </Popover>
          <DraftCycleNumberInput
            value={storedRange.end}
            label="To cycle"
            onCommit={commitManualEnd}
            disabled={specificCyclesActive}
            disabledReason={disabledReason}
            max={hasBound ? maxAvailableCycle! : undefined}
          />

          <Button.Group>
            <NavigationSegmentButton
              label="Next cycle"
              disabled={boundedNavigationDisabled}
              disabledReason={disabledReason}
              onClick={() => move(1, "cycle")}
            >
              <IconChevronRight size={14} />
            </NavigationSegmentButton>
            <NavigationSegmentButton
              label="Next cycle window"
              disabled={boundedNavigationDisabled}
              disabledReason={disabledReason}
              onClick={() => move(1, "window")}
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
          style={{ minWidth: 0, width: "100%", justifySelf: "stretch" }}
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
