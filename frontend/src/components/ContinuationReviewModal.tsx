import {
  Accordion,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import type {
  ContinuationFinding,
  ContinuationInspectResult,
  ContinuationInspectSource,
} from "../api";
import {
  blockingFindings,
  informationalFindings,
} from "../continuationPolicy";

function findingSourceLabel(
  finding: ContinuationFinding,
  result: ContinuationInspectResult,
): string {
  if (!finding.source_keys.length) return "";
  const filenames = new Map(result.sources.map((source) => [source.key, source.filename]));
  return finding.source_keys
    .map((key) => filenames.get(key) ?? key)
    .join(" → ");
}

function findingDescription(
  finding: ContinuationFinding,
  result: ContinuationInspectResult,
): string {
  const sourceLabel = findingSourceLabel(finding, result);
  return sourceLabel ? `${finding.message} (${sourceLabel})` : finding.message;
}

function SourceErrorRow({ source }: { source: ContinuationInspectSource }) {
  return (
    <Paper withBorder p="xs">
      <Stack gap={2}>
        <Text size="sm" fw={700}>{source.filename}</Text>
        <Text size="sm" c="red">
          {source.inspection_error || "The source could not be prepared for continuation inspection."}
        </Text>
      </Stack>
    </Paper>
  );
}

function FindingHeader({
  finding,
  result,
}: {
  finding: ContinuationFinding;
  result: ContinuationInspectResult;
}) {
  return (
    <Stack gap={2} style={{ minWidth: 0 }}>
      <Text size="sm" fw={700}>{finding.title}</Text>
      <Text size="sm" c="dimmed">{findingDescription(finding, result)}</Text>
    </Stack>
  );
}

export function ContinuationReviewModal({
  opened,
  onClose,
  result,
  acknowledged,
  onAcknowledgementChange,
  disabled = false,
}: {
  opened: boolean;
  onClose: () => void;
  result: ContinuationInspectResult | null | undefined;
  acknowledged: ReadonlySet<string>;
  onAcknowledgementChange: (findingId: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const blocking = result ? blockingFindings(result) : [];
  const confirmations = result?.findings.filter((finding) => finding.severity === "confirmation") ?? [];
  const details = result ? informationalFindings(result) : [];
  const sourceErrors = result?.sources.filter((source) => source.inspection_status === "error") ?? [];

  return (
    <Modal opened={opened} onClose={onClose} title="Continuity review" centered size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Review the findings for this ordered source chain. Blocking findings cannot be
          acknowledged; confirmation findings must be checked before import.
        </Text>

        {sourceErrors.length > 0 && (
          <Stack gap="xs">
            <Group gap="xs">
              <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" aria-hidden="true" />
              <Text size="sm" fw={700} c="red">Source errors</Text>
              <Badge size="xs" color="red" variant="light">{sourceErrors.length}</Badge>
            </Group>
            {sourceErrors.map((source) => <SourceErrorRow key={source.key} source={source} />)}
          </Stack>
        )}

        {blocking.length > 0 && result && (
          <Stack gap="xs">
            <Group gap="xs">
              <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" aria-hidden="true" />
              <Text size="sm" fw={700} c="red">Blocking</Text>
              <Badge size="xs" color="red" variant="light">{blocking.length}</Badge>
            </Group>
            {blocking.map((finding) => (
              <Paper key={finding.id} withBorder p="xs">
                <Group gap="xs" align="start" wrap="nowrap">
                  <IconAlertTriangle size={15} color="var(--mantine-color-red-6)" aria-hidden="true" />
                  <FindingHeader finding={finding} result={result} />
                </Group>
              </Paper>
            ))}
          </Stack>
        )}

        {confirmations.length > 0 && result && (
          <Stack gap="xs">
            <Group gap="xs">
              <IconInfoCircle size={16} color="var(--mantine-color-orange-6)" aria-hidden="true" />
              <Text size="sm" fw={700}>Confirmation</Text>
              <Badge size="xs" color="orange" variant="light">{confirmations.length}</Badge>
            </Group>
            {confirmations.map((finding) => (
              <Paper key={finding.id} withBorder p="xs">
                <Checkbox
                  size="sm"
                  disabled={disabled}
                  checked={acknowledged.has(finding.id)}
                  onChange={(event) => onAcknowledgementChange(finding.id, event.currentTarget.checked)}
                  label={
                    <FindingHeader finding={finding} result={result} />
                  }
                />
              </Paper>
            ))}
          </Stack>
        )}

        {details.length > 0 && result && (
          <Accordion variant="contained">
            <Accordion.Item value="details">
              <Accordion.Control>Details ({details.length})</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="xs">
                  {details.map((finding) => (
                    <Paper key={finding.id} withBorder p="xs">
                      <FindingHeader finding={finding} result={result} />
                    </Paper>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        )}

        {result && sourceErrors.length === 0 && blocking.length === 0 && confirmations.length === 0 && details.length === 0 && (
          <Text size="sm" c="teal">No continuity findings were reported.</Text>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
