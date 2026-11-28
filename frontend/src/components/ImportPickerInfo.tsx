import { ActionIcon, Button, Group, Popover, Stack, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { importedSourceLabel, type ImportedCell } from "../importedSourceIdentity";

function PickerInfo({ label, title, hoverText, children, warning }: {
  label: string; title: string; hoverText: string; children: ReactNode; warning?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  return <Tooltip label={hoverText} disabled={opened} multiline maw={320} withArrow>
    <span style={{ display: "inline-flex", flexShrink: 0 }}>
      <Popover opened={opened} onChange={setOpened} withArrow shadow="md" width={320} trapFocus returnFocus>
        <Popover.Target>
          <ActionIcon aria-label={label} aria-disabled={false} variant="subtle" size="sm" color={warning ? "orange" : "gray"}
            onClick={event => { event.stopPropagation(); setOpened(!opened); }}>
            {warning ? <IconAlertTriangle size={16} /> : <IconInfoCircle size={16} />}
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
          style={{ maxWidth: "90vw", maxHeight: "65vh", overflowY: "auto", overflowWrap: "anywhere" }}>
          <Stack gap="xs">
            <Group justify="space-between"><Text fw={700} size="sm">{title}</Text>
              <Button size="compact-xs" data-autofocus data-mantine-stop-propagation="true" onClick={() => setOpened(false)}>Close</Button>
            </Group>
            {children}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </span>
  </Tooltip>;
}

export function RegisteredFileInfo({ filename, cells }: { filename: string; cells?: ImportedCell[] }) {
  const description = importedSourceLabel(cells);
  return <PickerInfo label={`Why ${filename} is already in the database`} title="Already in your database" hoverText={description} warning>
    <Text size="sm">{description}</Text>
    <Text size="xs" c="dimmed">You can preview this file here.</Text>
  </PickerInfo>;
}

export function MprReadingHelp() {
  return <PickerInfo label="About MPR reading modes" title="MPR reading modes" hoverText="About Safe and Permissive reading">
    <Text size="sm"><b>Safe</b> shows measurements and results that CellXplorer can verify.</Text>
    <Text size="sm"><b>Permissive</b> can also show recorded measurements when CellXplorer cannot verify how the experiment was run. Uncertain cycles and capacities are left out.</Text>
  </PickerInfo>;
}
