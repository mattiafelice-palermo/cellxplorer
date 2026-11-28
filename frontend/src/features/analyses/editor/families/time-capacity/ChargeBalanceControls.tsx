import { Input, Select, SegmentedControl, Stack, Switch, Text } from "@mantine/core";
import { useState } from "react";
import type { ChargeBalanceReference, ChargeBalanceSettings } from "../../../../../api";
import { DebouncedNumberInput } from "../../../../../components/DebouncedInputs";

type CellOption = { id: number; name: string };

export function ChargeBalanceControls({ settings, cells, onChange }: {
  settings: ChargeBalanceSettings;
  cells: readonly CellOption[];
  onChange: (change: (previous: ChargeBalanceSettings) => ChargeBalanceSettings) => void;
}) {
  const options = [...new Map(cells.map(cell => [cell.id, cell])).values()];
  const [chosen, setChosen] = useState<string | null>(null);
  const cell = options.find(item => String(item.id) === chosen) ?? options[0];
  const entry = settings.references?.[cell?.id] ?? {};
  const measured = entry.basis !== "mass";
  const specific = entry.specific_capacity_mah_g === undefined ? 820 : entry.specific_capacity_mah_g;
  const capacity = measured ? entry.capacity_mah : entry.mass_mg && specific && entry.mass_mg * specific / 1000;
  const changeReference = (patch: Partial<ChargeBalanceReference>) => {
    if (!cell) return;
    onChange(previous => ({
      ...previous,
      references: {
        ...previous.references,
        [cell.id]: { ...previous.references?.[cell.id], ...patch },
      },
    }));
  };
  return (
    <Stack gap="xs">
      <Input.Wrapper label="Vertical axis">
        <SegmentedControl fullWidth aria-label="Vertical axis" value={settings.unit ?? "mah"}
          data={[{ value: "mah", label: "Balance (mAh)" }, { value: "soc", label: "Estimated SOC (%)" }]}
          onChange={value => onChange(previous => ({ ...previous, unit: value === "soc" ? "soc" : "mah" }))} />
      </Input.Wrapper>
      {settings.unit === "soc" && cell && (
        <Stack key={cell.id} gap="xs">
          {options.length > 1 && <Select label="Calibrate Cell" value={String(cell.id)}
            data={options.map(item => ({ value: String(item.id), label: item.name }))}
            searchable onChange={setChosen} allowDeselect={false} />}
          <DebouncedNumberInput label="Starting SOC (%)" description="At the Cell’s first recorded sample, across all cycle windows."
            min={0} max={100} value={entry.start_soc_pct ?? null} placeholder="Enter starting SOC"
            onCommit={value => changeReference({ start_soc_pct: value })} />
          <Select label="Capacity reference" value={measured ? "measured" : "mass"} allowDeselect={false}
            data={[{ value: "measured", label: "Measured usable capacity" }, { value: "mass", label: "Initial active mass" }]}
            onChange={value => changeReference({ basis: value === "mass" ? "mass" : "measured" })} />
          {measured ? (
            <DebouncedNumberInput label="Measured capacity (mAh)" placeholder="Enter capacity" min={0}
              value={entry.capacity_mah ?? null} onCommit={value => changeReference({ capacity_mah: value })}
              error={entry.capacity_mah != null && entry.capacity_mah <= 0 ? "Enter a positive capacity." : undefined} />
          ) : (
            <>
              <DebouncedNumberInput label="Initial active mass (mg)" placeholder="Enter mass" min={0}
                value={entry.mass_mg ?? null} onCommit={value => changeReference({ mass_mg: value })}
                error={entry.mass_mg != null && entry.mass_mg <= 0 ? "Enter a positive mass." : undefined} />
              <DebouncedNumberInput label="Specific capacity (mAh/g)" description="Zinc metal uses 820 mAh/g. Set this for your material."
                min={0} value={specific} onCommit={value => changeReference({ specific_capacity_mah_g: value })}
                error={specific != null && specific <= 0 ? "Enter a positive specific capacity." : undefined} />
              {capacity != null && capacity > 0 && <Text size="xs" c="dimmed">
                100% SOC corresponds to {Number(capacity.toPrecision(6))} mAh of theoretical capacity.
              </Text>}
            </>
          )}
        </Stack>
      )}
      <Switch label="Show voltage on right axis" checked={settings.show_voltage === true}
        onChange={event => { const checked = event.currentTarget.checked;
          onChange(previous => ({ ...previous, show_voltage: checked })); }} />
    </Stack>
  );
}
