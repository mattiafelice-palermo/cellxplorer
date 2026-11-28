import { Button, Menu, NumberInput, Stack, type NumberInputProps } from "@mantine/core";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import type { RecordedMass } from "../api";

type MassSource = {
  filename: string;
  active_mass_mg?: number | null;
  recorded_masses?: RecordedMass[];
  maccor_scap?: number | null;
  maccor_mass_from_scap?: boolean;
};

export function CellMassInput({ sources, defaultMassMg, ...input }: NumberInputProps & { sources: MassSource[]; defaultMassMg?: number | null }) {
  const hasSCap = sources.some((source) => source.maccor_scap != null);
  if (!hasSCap && !sources.some((source) => source.recorded_masses?.length)) {
    return <NumberInput {...input} />;
  }
  const source = sources.length === 1 ? sources[0] : undefined;
  const description = source?.maccor_mass_from_scap && source.maccor_scap != null && source.active_mass_mg != null
    ? `Source default ${Number(source.active_mass_mg.toPrecision(7))} mg from SCap (${Number(source.maccor_scap.toPrecision(7))} g)`
    : input.description;
  return (
    <Stack gap={4}>
      <NumberInput {...input} label="Mass for calculations (mg)" description={description} />
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button size="compact-xs" variant="subtle" w="fit-content" disabled={input.disabled}
            rightSection={<IconChevronDown size={14} />}>
            {hasSCap ? "Choose mass from source" : "Choose recorded mass"}
          </Button>
        </Menu.Target>
        <Menu.Dropdown mah={320} style={{ overflowY: "auto" }}>
          {sources.map((source, index) => source.recorded_masses?.length || source.maccor_scap != null ? (
            <div key={index}>
              {sources.length > 1 && <Menu.Label>{index + 1}. {source.filename}</Menu.Label>}
              {source.recorded_masses?.map(({ kind, value, unit }) => {
                const massMg = unit === "g" ? value * 1000 : value;
                const label = kind === "characteristic" ? "Characteristic mass" : "Active material mass";
                return (
                  <Menu.Item key={kind} onClick={() => input.onChange?.(massMg)}
                    rightSection={(input.value === "" || input.value == null ? defaultMassMg : input.value) === massMg ? <IconCheck size={14} /> : undefined}>
                    {label} · {Number(value.toPrecision(7))} {unit}{massMg === defaultMassMg ? " (default)" : ""}
                  </Menu.Item>
                );
              })}
              {source.maccor_scap != null && <>
                <Menu.Label>
                  Recorded SCap · {Number(source.maccor_scap.toPrecision(7))}{source.maccor_mass_from_scap ? " g (source default)" : ""}
                </Menu.Label>
                {(["g", "mg"] as const).map((unit) => {
                  const massMg = source.maccor_scap! * (unit === "g" ? 1000 : 1);
                  return Number.isFinite(massMg) && (
                    <Menu.Item key={unit} onClick={() => input.onChange?.(massMg)}
                      rightSection={(input.value === "" || input.value == null ? defaultMassMg : input.value) === massMg ? <IconCheck size={14} /> : undefined}>
                      Use SCap as {unit === "g" ? "grams" : "milligrams"} · {Number(massMg.toPrecision(7))} mg
                    </Menu.Item>
                  );
                })}
              </>}
            </div>
          ) : null)}
          <Menu.Divider />
          <Menu.Item onClick={() => input.onChange?.("")}>Restore source default</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}
