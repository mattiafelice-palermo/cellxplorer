import { ActionIcon, Button, Group, Popover, Stack, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

export function ImportPickerHelp({ opened, onChange }: { opened: boolean; onChange: (open: boolean) => void }) {
  return <Popover opened={opened} onChange={onChange} withinPortal={false} trapFocus returnFocus
    position="bottom-start" withArrow shadow="md" width={420}>
    <Popover.Target>
      <ActionIcon variant="subtle" color="gray" size="sm" aria-label="File picker help"
        title="File picker help" aria-expanded={opened} onClick={() => onChange(!opened)}>
        <IconInfoCircle size={16} />
      </ActionIcon>
    </Popover.Target>
    <Popover.Dropdown style={{ maxWidth: "85vw", maxHeight: "70vh", overflowY: "auto" }}>
      <Stack gap="xs">
        <Group justify="space-between"><Text fw={700} size="sm">Choosing files</Text>
          <Button size="compact-xs" data-autofocus onClick={() => onChange(false)}>Close</Button></Group>
        <Text size="sm">Click a file to preview it. Tick its checkbox to include it. Double-click a folder to open it, or tick its checkbox to include the files it contains.</Text>
        <Text size="sm">You can collect files from several folders. Choose <b>Review selection</b> under the file list to see everything you picked or remove a file.</Text>
        <Text size="sm">Files already in your library can still be previewed. Files with an unsupported format cannot be selected.</Text>
        <Text fw={600} size="sm">Shortcuts in the file list</Text>
        <Text size="sm"><b>Space</b> or <b>Ctrl-click</b> toggles a file. <b>Shift-click</b> selects a range. <b>Double-click</b> includes one file. <b>Ctrl+A</b> selects all available items shown.</Text>
        <Text size="xs" c="dimmed">Supported sources include Neware NDA, NDAX and cycling workbooks, BioLogic MPR recordings, and Maccor record exports and numbered channel files.</Text>
      </Stack>
    </Popover.Dropdown>
  </Popover>;
}
