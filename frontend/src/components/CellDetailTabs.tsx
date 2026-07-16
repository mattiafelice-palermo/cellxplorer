import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  IconActivity,
  IconArrowRight,
  IconBattery,
  IconBatteryCharging,
  IconClock,
  IconFile,
  IconInfoCircle,
  IconListDetails,
  IconRefresh,
  IconRepeat,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { CellDetail, CellProtocol, get, ProtocolStep, SourceFile } from "../api";
import { CellQuickPlot } from "./CellQuickPlot";
import styles from "./CellDetailTabs.module.css";

function statusColor(status: string) {
  if (status === "parsed" || status === "online") return "teal";
  if (status === "changed") return "orange";
  if (status === "changing") return "yellow";
  if (status === "error" || status === "offline") return "red";
  return "gray";
}

function formatSeconds(value: number | null) {
  if (value === null) return "-";
  if (value >= 3600 && value % 3600 === 0) return `${value / 3600} h`;
  if (value >= 60 && value % 60 === 0) return `${value / 60} min`;
  return `${value} s`;
}

function formatNumber(value: number) {
  return Number(value.toPrecision(8)).toString();
}

function formatCRate(value: number) {
  if (value >= 1) {
    const rounded = Math.round(value);
    if (rounded > 0 && Math.abs(value - rounded) / rounded <= 0.02) return `${rounded}C`;
    return `${formatNumber(value)}C`;
  }
  if (value > 0) {
    const reciprocal = 1 / value;
    const standards = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];
    const closest = standards.reduce((best, candidate) =>
      Math.abs(candidate - reciprocal) < Math.abs(best - reciprocal) ? candidate : best
    );
    if (Math.abs(reciprocal - closest) / closest <= 0.08) {
      return `C/${closest}`;
    }
    const rounded = Math.round(reciprocal);
    if (rounded >= 2 && Math.abs(reciprocal - rounded) / rounded <= 0.02) return `C/${rounded}`;
  }
  return `${formatNumber(value)}C`;
}

function stepDetails(step: ProtocolStep) {
  const details: string[] = [];
  if (step.c_rate !== null) details.push(formatCRate(step.c_rate));
  else if (step.current_ma !== null) details.push(`${formatNumber(step.current_ma)} mA`);
  if (step.target_voltage_v !== null) details.push(`${formatNumber(step.target_voltage_v)} V target`);
  else if (step.stop_voltage_v !== null) details.push(`${formatNumber(step.stop_voltage_v)} V cutoff`);
  if (step.stop_c_rate !== null) details.push(`End at ${formatCRate(step.stop_c_rate)}`);
  else if (step.stop_current_ma !== null) details.push(`End at ${formatNumber(step.stop_current_ma)} mA`);
  if (step.time_limit_s !== null) {
    details.push(step.direction === "rest" ? formatSeconds(step.time_limit_s) : `${formatSeconds(step.time_limit_s)} limit`);
  }
  return details;
}

function StepIcon({ step }: { step: ProtocolStep }) {
  if (step.direction === "charge") return <IconBatteryCharging size={17} />;
  if (step.direction === "discharge") return <IconBattery size={17} />;
  if (step.direction === "rest") return <IconClock size={17} />;
  return <IconActivity size={17} />;
}

function ProtocolStepNode({ step, onClick }: { step: ProtocolStep; onClick: () => void }) {
  const details = stepDetails(step);
  const color = step.direction === "charge" ? "teal" : step.direction === "discharge" ? "blue" : "gray";
  return (
    <UnstyledButton
      className={styles.stepNode}
      data-direction={step.direction}
      onClick={onClick}
      aria-label={`Open step ${step.number}: ${step.type}`}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <ThemeIcon size="sm" radius="xl" color={color} variant="light"><StepIcon step={step} /></ThemeIcon>
        <Badge size="xs" color="gray" variant="light">Step {step.number}</Badge>
      </Group>
      <Text fw={700} size="sm" mt={7} lineClamp={1}>{step.type}</Text>
      <Stack gap={1} mt={4}>
        {details.slice(0, 3).map((detail) => (
          <Text key={detail} size="xs" c="dimmed" lineClamp={1}>{detail}</Text>
        ))}
      </Stack>
    </UnstyledButton>
  );
}

function StepDetailModal({ step, onClose }: { step: ProtocolStep | null; onClose: () => void }) {
  if (!step) return null;
  const stopCurrent = step.stop_c_rate !== null
    ? `${formatCRate(step.stop_c_rate)} (${formatNumber(step.stop_current_ma!)} mA, inferred from nominal capacity)`
    : step.stop_current_ma === null ? "-" : `${formatNumber(step.stop_current_ma)} mA`;
  const rows = [
    ["Direction", step.direction],
    ["Applied current", step.current_ma === null ? "-" : `${formatNumber(step.current_ma)} mA`],
    ["Applied C-rate", step.c_rate === null ? "-" : `${formatCRate(step.c_rate)}${step.c_rate_source === "inferred" ? " (inferred)" : ""}`],
    ["Target voltage", step.target_voltage_v === null ? "-" : `${formatNumber(step.target_voltage_v)} V`],
    ["Voltage cutoff", step.stop_voltage_v === null ? "-" : `${formatNumber(step.stop_voltage_v)} V`],
    ["Current termination", stopCurrent],
    ["Time limit", formatSeconds(step.time_limit_s)],
    ["Record interval", formatSeconds(step.record_interval_s)],
    ["Protection window", `${step.protection_lower_v ?? "?"}-${step.protection_upper_v ?? "?"} V`],
  ];
  return (
    <Modal opened onClose={onClose} title={`Step ${step.number}: ${step.type}`} centered size="lg">
      <Text size="sm" c="dimmed" mb="md">Values shown here preserve the exact file settings; inferred values are explicitly labelled.</Text>
      <Table withTableBorder striped>
        <Table.Tbody>
          {rows.map(([label, value]) => (
            <Table.Tr key={label}><Table.Td w="38%"><Text size="sm" c="dimmed">{label}</Text></Table.Td><Table.Td><Text size="sm">{value}</Text></Table.Td></Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Modal>
  );
}

function ReconstructionModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const rules = [
    "The app reads the numbered steps saved in the Neware file and keeps them in their original order.",
    "A Neware Cycle instruction says which earlier steps to repeat and how many times.",
    "Those steps are placed inside a Repeated block. Steps outside a repeat stay in a normal sequence.",
    "C-rates saved in the file are used directly. A missing rate can be calculated from current and nominal capacity and is labelled as inferred.",
    "Simple rates are written in familiar form, such as C/2, C/3, or C/20. The exact current remains available in the step details.",
  ];
  return (
    <Modal opened={opened} onClose={onClose} title="Protocol reconstruction" centered size="lg">
      <Text size="sm" mb="md">The app builds this view by following the instructions saved in the file. It does not use AI or guess the test type.</Text>
      <Stack gap="sm">
        {rules.map((rule, index) => (
          <Group key={rule} align="flex-start" wrap="nowrap" gap="sm">
            <Badge circle color="teal" variant="light" mt={1}>{index + 1}</Badge>
            <Text size="sm">{rule}</Text>
          </Group>
        ))}
      </Stack>
      <Alert color="gray" icon={<IconInfoCircle size={16} />} mt="lg">
        The app does not name blocks as formation, durability, RPT, or rate tests. Open the exact step table whenever you need every original setting.
      </Alert>
    </Modal>
  );
}

function ProtocolPanel({ cellId }: { cellId: number }) {
  const protocol = useQuery({
    queryKey: ["cell-protocol", cellId],
    queryFn: () => get<CellProtocol>(`/api/cells/${cellId}/protocol`),
  });
  const files = useMemo(
    () =>
      (protocol.data?.tests ?? []).flatMap((test) =>
        test.files.map((file) => ({ ...file, testName: test.name }))
      ),
    [protocol.data]
  );
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<ProtocolStep | null>(null);
  const [reconstructionOpen, setReconstructionOpen] = useState(false);
  const selected = files.find((file) => String(file.id) === selectedFileId) ?? files[0];

  if (protocol.isLoading) return <Loader size="sm" />;
  if (protocol.isError) return <Alert color="red">Could not reconstruct this protocol.</Alert>;
  if (!selected) return <Alert color="gray">No source files are attached to this cell.</Alert>;
  const data = selected.protocol;
  const byNumber = new Map(data.steps.map((step) => [step.number, step]));

  return (
    <Stack gap="sm">
      {files.length > 1 && (
        <Select
          label="Test and source file"
          data={files.map((file) => ({
            value: String(file.id),
            label: `${file.testName} / ${file.filename}`,
          }))}
          value={String(selected.id)}
          onChange={setSelectedFileId}
          searchable
        />
      )}
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text fw={700}>{selected.filename}</Text>
          <Text size="xs" c="dimmed" lineClamp={1}>{selected.path}</Text>
        </div>
        <Button
          variant="subtle"
          size="compact-sm"
          style={{ flexShrink: 0 }}
          leftSection={<IconInfoCircle size={15} />}
          onClick={() => setReconstructionOpen(true)}
        >
          How grouping works
        </Button>
      </Group>
      {data.warnings.map((warning) => (
        <Alert key={warning} color="yellow" icon={<IconInfoCircle size={16} />}>
          {warning}
        </Alert>
      ))}
      <Group gap="xs">
        <Badge variant="light">{data.n_executable_steps} executable steps</Badge>
        {data.summary.charge_cutoffs.map((cutoff) => (
          <Badge key={`c-${cutoff.voltage_v}`} color="teal" variant="light">
            charge cutoff {formatNumber(cutoff.voltage_v)} V ({cutoff.step_count})
          </Badge>
        ))}
        {data.summary.discharge_cutoffs.map((cutoff) => (
          <Badge key={`d-${cutoff.voltage_v}`} color="blue" variant="light">
            discharge cutoff {formatNumber(cutoff.voltage_v)} V ({cutoff.step_count})
          </Badge>
        ))}
        {data.summary.protection_windows.map((window, index) => (
          <Badge key={`p-${index}`} color="gray" variant="light">
            protection {window.lower_v ?? "?"}-{window.upper_v ?? "?"} V
          </Badge>
        ))}
      </Group>

      <Stack gap="sm">
        {data.groups.map((group, index) => {
          const members = group.step_numbers.map((number) => byNumber.get(number)).filter((step): step is ProtocolStep => Boolean(step));
          return (
            <Box
              key={`${group.kind}-${group.start_step}-${index}`}
              className={styles.protocolFlow}
              data-repeated={group.kind === "repeated_block"}
            >
              <Group justify="space-between" align="start" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  {group.kind === "repeated_block" && <ThemeIcon color="teal" variant="light" size="sm"><IconRepeat size={15} /></ThemeIcon>}
                  <div>
                    <Text fw={700} size="sm">{group.label}</Text>
                  <Text size="xs" c="dimmed">{group.summary}</Text>
                  </div>
                </Group>
                {group.kind === "repeated_block" && (
                  <Badge color="teal" variant="light">x{group.repeat_count}</Badge>
                )}
              </Group>
              <ScrollArea type="auto" offsetScrollbars mt="sm">
                <Group gap="xs" wrap="nowrap" align="stretch" pb={5}>
                  {members.map((step, stepIndex) => (
                    <Group key={step.number} gap="xs" wrap="nowrap" align="center">
                      <ProtocolStepNode step={step} onClick={() => setSelectedStep(step)} />
                      {stepIndex < members.length - 1 && <IconArrowRight className={styles.flowArrow} size={19} />}
                    </Group>
                  ))}
                </Group>
              </ScrollArea>
            </Box>
          );
        })}
      </Stack>

      <Accordion variant="separated">
        <Accordion.Item value="steps">
          <Accordion.Control>Exact step table</Accordion.Control>
          <Accordion.Panel>
            <ScrollArea type="auto">
              <Table striped highlightOnHover miw={980}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>#</Table.Th><Table.Th>Mode</Table.Th><Table.Th>Direction</Table.Th>
                    <Table.Th>Current</Table.Th><Table.Th>C-rate</Table.Th><Table.Th>Target V</Table.Th>
                    <Table.Th>Stop V</Table.Th><Table.Th>Stop current</Table.Th><Table.Th>Time limit</Table.Th>
                    <Table.Th>Record</Table.Th><Table.Th>Protection</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.steps.map((step) => (
                    <Table.Tr key={step.number}>
                      <Table.Td>{step.number}</Table.Td>
                      <Table.Td><Text size="xs" fw={600}>{step.type}</Text></Table.Td>
                      <Table.Td>{step.direction}</Table.Td>
                      <Table.Td>{step.current_ma === null ? "-" : `${formatNumber(step.current_ma)} mA`}</Table.Td>
                      <Table.Td>
                        {step.c_rate === null ? "-" : formatCRate(step.c_rate)}
                        {step.c_rate_source === "inferred" && <Text size="10px" c="dimmed">inferred</Text>}
                      </Table.Td>
                      <Table.Td>{step.target_voltage_v ?? "-"}</Table.Td>
                      <Table.Td>{step.stop_voltage_v ?? "-"}</Table.Td>
                      <Table.Td>
                        {step.stop_c_rate !== null ? formatCRate(step.stop_c_rate) : step.stop_current_ma === null ? "-" : `${formatNumber(step.stop_current_ma)} mA`}
                        {step.stop_c_rate_source === "inferred" && <Text size="10px" c="dimmed">{formatNumber(step.stop_current_ma!)} mA; inferred</Text>}
                      </Table.Td>
                      <Table.Td>{formatSeconds(step.time_limit_s)}</Table.Td>
                      <Table.Td>{formatSeconds(step.record_interval_s)}</Table.Td>
                      <Table.Td>{step.protection_lower_v ?? "?"}-{step.protection_upper_v ?? "?"} V</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <StepDetailModal step={selectedStep} onClose={() => setSelectedStep(null)} />
      <ReconstructionModal opened={reconstructionOpen} onClose={() => setReconstructionOpen(false)} />
    </Stack>
  );
}

function MetadataPanel({ cell }: { cell: CellDetail }) {
  const displayMetadataKey = (key: string) => {
    if (key === "voltage_upper_v") return "protection_voltage_upper_v (legacy key)";
    if (key === "voltage_lower_v") return "protection_voltage_lower_v (legacy key)";
    return key;
  };
  const sourceMetadata = cell.tests.flatMap((test) =>
    test.files.flatMap((file, index) =>
      [
        ["file", file.filename], ["path", file.path], ["channel", file.channel],
        ["device_info", file.device_info], ["start_time", file.start_time],
        ["nda_version", file.nda_version], ["barcode", file.barcode], ["remarks", file.remarks],
        ["active_mass_mg", file.active_mass_mg], ["nominal_capacity_mah", file.nominal_capacity_mah],
        ["parser_version", file.parser_version],
      ]
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([key, value]) => [`${test.name} / file ${index + 1} / ${key}`, String(value)] as const)
    )
  );
  const scientificRows = [
    ["Active material preset", cell.scientific_presets.active_material.name, ""],
    [
      "Active material specific capacity",
      cell.scientific_presets.active_material.specific_capacity_mah_g,
      "mAh/g",
    ],
    ["Active material mass / source", cell.scientific_metadata.active_mass_mg.source_value, "mg"],
    ["Active material mass / override", cell.scientific_metadata.active_mass_mg.override_value, "mg"],
    ["Active material mass / effective", cell.scientific_metadata.active_mass_mg.effective_value, "mg"],
    ["Nominal capacity / source", cell.scientific_metadata.nominal_capacity_mah.source_value, "mAh"],
    ["Nominal capacity / override", cell.scientific_metadata.nominal_capacity_mah.override_value, "mAh"],
    ["Nominal capacity / effective", cell.scientific_metadata.nominal_capacity_mah.effective_value, "mAh"],
    ["Electrode area / override", cell.scientific_metadata.electrode_area_cm2.override_value, "cm²"],
    ["Electrode area / effective", cell.scientific_metadata.electrode_area_cm2.effective_value, "cm²"],
    ["Electrode area preset", cell.scientific_presets.electrode_area_preset_name, ""],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value, unit]) => [label, `${value}${unit ? ` ${unit}` : ""}`] as const);
  const cellMetadata = Object.entries(cell.metadata).filter(
    ([key]) => !key.startsWith("override.")
  );
  const rows = [...scientificRows, ...cellMetadata, ...sourceMetadata];
  if (!rows.length) return <Alert color="gray">No metadata stored.</Alert>;
  return (
    <ScrollArea h={520} type="auto">
      <Table withTableBorder striped>
        <Table.Tbody>
          {rows.map(([key, value], index) => (
            <Table.Tr key={`${key}-${index}`}>
              <Table.Td w="38%"><Text size="xs" c="dimmed">{displayMetadataKey(String(key))}</Text></Table.Td>
              <Table.Td><Text size="xs">{String(value)}</Text></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function FilesPanel({
  cell,
  onUpdateFile,
  updating,
}: {
  cell: CellDetail;
  onUpdateFile?: (file: SourceFile) => void;
  updating?: boolean;
}) {
  return (
    <Stack gap="xs">
      {cell.tests.map((test) => (
        <Paper key={test.id} withBorder p="sm">
          <Text fw={700} mb="xs">{test.name}</Text>
          <ScrollArea type="auto">
            <Table miw={780}>
              <Table.Thead><Table.Tr><Table.Th>File</Table.Th><Table.Th>Rows</Table.Th><Table.Th>Cycles</Table.Th><Table.Th>Source</Table.Th><Table.Th>Parse</Table.Th><Table.Th>Hash</Table.Th>{onUpdateFile && <Table.Th />}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {test.files.map((file) => (
                  <Table.Tr key={file.id}>
                    <Table.Td><Text size="sm" fw={600}>{file.filename}</Text><Text size="xs" c="dimmed" lineClamp={1}>{file.path}</Text></Table.Td>
                    <Table.Td>{file.row_count ?? "-"}</Table.Td><Table.Td>{file.cycle_count ?? "-"}</Table.Td>
                    <Table.Td><Badge color={statusColor(file.location_status)} variant="light">{file.location_status}</Badge></Table.Td>
                    <Table.Td><Badge color={statusColor(file.parse_status)} variant="light">{file.parse_status}</Badge></Table.Td>
                    <Table.Td><Code fz={10}>{file.hash.slice(0, 12)}...</Code></Table.Td>
                    {onUpdateFile && <Table.Td><Tooltip label="Read the changed source and rebuild its cache"><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} disabled={file.location_status !== "changed"} loading={updating} onClick={() => onUpdateFile(file)}>Update</Button></Tooltip></Table.Td>}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      ))}
    </Stack>
  );
}

export function CellDetailTabs({ cell, onUpdateFile, updating }: { cell: CellDetail; onUpdateFile?: (file: SourceFile) => void; updating?: boolean }) {
  return (
    <Tabs defaultValue="overview" keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="overview" leftSection={<IconActivity size={14} />}>Overview</Tabs.Tab>
        <Tabs.Tab value="protocol" leftSection={<IconListDetails size={14} />}>Protocol</Tabs.Tab>
        <Tabs.Tab value="metadata" leftSection={<IconInfoCircle size={14} />}>Metadata</Tabs.Tab>
        <Tabs.Tab value="files" leftSection={<IconFile size={14} />}>Files</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="overview" pt="sm"><Paper withBorder p="sm"><CellQuickPlot cellId={cell.id} cellName={cell.name} /></Paper></Tabs.Panel>
      <Tabs.Panel value="protocol" pt="sm"><ProtocolPanel cellId={cell.id} /></Tabs.Panel>
      <Tabs.Panel value="metadata" pt="sm"><MetadataPanel cell={cell} /></Tabs.Panel>
      <Tabs.Panel value="files" pt="sm"><FilesPanel cell={cell} onUpdateFile={onUpdateFile} updating={updating} /></Tabs.Panel>
    </Tabs>
  );
}
