import { Button, Menu, NumberInput, Stack, type NumberInputProps } from "@mantine/core";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import type { RecordedMass } from "../api";

type MassSource = { filename: string; recorded_masses?: RecordedMass[] };

export function CellMassInput({ sources, ...input }: NumberInputProps & { sources: MassSource[] }) {
  if (!sources.some((source) => source.recorded_masses?.length)) {
    return <NumberInput {...input} />;
  }
  return (
    <Stack gap={4}>
      <NumberInput {...input} label="Mass for calculations (mg)" />
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button size="compact-xs" variant="subtle" w="fit-content" disabled={input.disabled}
            rightSection={<IconChevronDown size={14} />}>
            Choose recorded mass
          </Button>
        </Menu.Target>
        <Menu.Dropdown mah={320} style={{ overflowY: "auto" }}>
          {sources.map((source, index) => source.recorded_masses?.length ? (
            <div key={index}>
              {sources.length > 1 && <Menu.Label>{index + 1}. {source.filename}</Menu.Label>}
              {source.recorded_masses.map(({ kind, value, unit }) => {
                const massMg = unit === "g" ? value * 1000 : value;
                const label = kind === "characteristic" ? "Characteristic mass" : "Active material mass";
                return (
                  <Menu.Item key={kind} onClick={() => input.onChange?.(massMg)}
                    rightSection={input.value === massMg ? <IconCheck size={14} /> : undefined}>
                    {label} · {Number(value.toPrecision(7))} {unit}
                  </Menu.Item>
                );
              })}
            </div>
          ) : null)}
          <Menu.Divider />
          <Menu.Item onClick={() => input.onChange?.("")}>Restore source default</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}
