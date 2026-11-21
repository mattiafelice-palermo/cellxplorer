import { ActionIcon, Group, Popover, Text } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconInfoCircle, IconX } from "@tabler/icons-react";
import { useRef, useState } from "react";

export function NegativeTimeNotice({ cycle }: { cycle: number | null }) {
  const [dismissedCycle, setDismissedCycle] = useState<number | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  if (cycle === null) return null;
  const opened = dismissedCycle !== cycle;
  function dismiss() {
    setDismissedCycle(cycle);
    button.current?.focus({ preventScroll: true });
  }
  return (
    <Popover opened={opened} onClose={dismiss} closeOnClickOutside={false}
      position="bottom" withArrow arrowSize={10} width={290} shadow="sm"
      transitionProps={{ transition: "fade", duration: reducedMotion ? 0 : 150 }}
      styles={{ arrow: { borderColor: "var(--mantine-color-orange-6)" }, dropdown: {
        backgroundColor: "light-dark(var(--mantine-color-orange-0), color-mix(in srgb, var(--mantine-color-orange-9) 20%, var(--mantine-color-dark-7)))",
        borderColor: "var(--mantine-color-orange-6)",
      } }}>
      <Popover.Target>
        <ActionIcon ref={button} size="sm" variant="light" color="orange" aria-label="Why does time start below zero?"
          onClick={() => opened ? dismiss() : setDismissedCycle(null)}>
          <IconInfoCircle size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Text size="sm" role="status">Some measurements were recorded before cycle {cycle} began. That cycle starts at time zero on this plot, so the earlier measurements appear at negative times.</Text>
          <ActionIcon size="sm" variant="subtle" color="orange" aria-label="Close time explanation" onClick={dismiss}>
            <IconX size={15} />
          </ActionIcon>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
