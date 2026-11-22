import { ActionIcon, Button, Group, Popover, Stack, Text } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconArrowLeft, IconInfoCircle, IconX } from "@tabler/icons-react";
import { useRef, useState } from "react";

import type { TimeCapacityCycleRange } from "./timeCapacityCycleNavigationPolicy";
import type { TimeCapacityOutOfWindowNoticeInfo } from "./timeCapacityOutOfWindowNoticePolicy";

function formatCellRangeSummary(info: TimeCapacityOutOfWindowNoticeInfo): string {
  const preview = info.cells
    .slice(0, 3)
    .map((cell) => `${cell.name} (${cell.totalCycles === 1 ? "cycle 1" : `1–${cell.totalCycles}`})`);
  const remaining = info.cells.length - preview.length;
  return remaining > 0
    ? `${preview.join(", ")}, and ${remaining} more.`
    : `${preview.join(", ")}.`;
}

export function OutOfWindowCellsNotice({
  info,
  onJumpToRange,
}: {
  info: TimeCapacityOutOfWindowNoticeInfo | null;
  onJumpToRange: (range: TimeCapacityCycleRange) => void;
}) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  if (info === null) return null;

  const opened = dismissedKey !== info.dismissKey;
  const dismiss = () => {
    setDismissedKey(info.dismissKey);
    button.current?.focus({ preventScroll: true });
  };
  const count = info.cells.length;
  const heading =
    count === 1
      ? "1 selected cell has data in earlier cycles"
      : `${count} selected cells have data in earlier cycles`;
  const windowLabel = info.isSpecificCycles
    ? `selected cycles (from cycle ${info.windowStart})`
    : info.windowStart === info.windowEnd
      ? `cycle ${info.windowStart}`
      : `cycles ${info.windowStart}–${info.windowEnd}`;
  const jumpLabel =
    info.jumpRange.start === info.jumpRange.end
      ? `Show cycle ${info.jumpRange.start}`
      : `Show cycles ${info.jumpRange.start}–${info.jumpRange.end}`;

  return (
    <Popover
      opened={opened}
      onClose={dismiss}
      closeOnClickOutside={false}
      position="bottom"
      withArrow
      arrowSize={10}
      width={330}
      shadow="sm"
      transitionProps={{ transition: "fade", duration: reducedMotion ? 0 : 150 }}
      styles={{
        arrow: { borderColor: "var(--mantine-color-blue-6)" },
        dropdown: {
          backgroundColor:
            "light-dark(var(--mantine-color-blue-0), color-mix(in srgb, var(--mantine-color-blue-9) 22%, var(--mantine-color-dark-7)))",
          borderColor: "var(--mantine-color-blue-6)",
        },
      }}
    >
      <Popover.Target>
        <ActionIcon
          ref={button}
          size="sm"
          variant="light"
          color="blue"
          aria-label="Why are some selected cells not shown?"
          onClick={() => (opened ? dismiss() : setDismissedKey(null))}
        >
          <IconInfoCircle size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Stack gap={6} style={{ flex: 1, minWidth: 0 }} role="status">
            <Text size="sm" fw={600}>
              {heading}
            </Text>
            <Text size="xs">
              This view shows {windowLabel}, which is after{" "}
              {count === 1 ? "that cell ended" : "those cells ended"}: {formatCellRangeSummary(info)}
            </Text>
            <Group gap="xs">
              <Button
                size="compact-xs"
                variant="light"
                color="blue"
                leftSection={<IconArrowLeft size={13} />}
                onClick={() => {
                  setDismissedKey(info.dismissKey);
                  onJumpToRange(info.jumpRange);
                }}
              >
                {jumpLabel}
              </Button>
            </Group>
          </Stack>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="blue"
            aria-label="Close earlier cycles notice"
            onClick={dismiss}
          >
            <IconX size={15} />
          </ActionIcon>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
