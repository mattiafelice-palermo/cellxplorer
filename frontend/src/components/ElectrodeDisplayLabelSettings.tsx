import { Button, Group, Paper, Stack, TagsInput, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { get, put } from "../api";
import { DEFAULT_ELECTRODE_LABELS, FIXED_ELECTRODE_LABELS, type ElectrodeDisplayLabels } from "../electrodeDisplayLabels";

export function ElectrodeDisplayLabelSettings() {
  const qc = useQueryClient();
  const labels = useQuery({ queryKey: ["electrode-display-labels"],
    queryFn: () => get<ElectrodeDisplayLabels>("/api/settings/electrode-display-labels") });
  const [draft, setDraft] = useState(DEFAULT_ELECTRODE_LABELS);
  useEffect(() => { if (labels.data) setDraft(labels.data); }, [labels.data]);
  const save = useMutation({
    mutationFn: () => put<ElectrodeDisplayLabels>("/api/settings/electrode-display-labels", draft),
    onSuccess: result => {
      qc.setQueryData(["electrode-display-labels"], result);
      notifications.show({ color: "teal", message: "Electrode display labels saved." });
    },
    onError: (error: Error) => notifications.show({ color: "red", message: error.message }),
  });
  return <Paper withBorder p="md"><Stack gap="sm">
    <Title order={4}>Electrode display labels</Title>
    <Text size="sm" c="dimmed">Choose these labels in the Time / capacity series editor. Add custom words with Enter. Measurement channel names stay fixed.</Text>
    {(Object.keys(draft) as (keyof ElectrodeDisplayLabels)[]).map(channel =>
      <TagsInput key={channel} label={FIXED_ELECTRODE_LABELS[channel]} value={draft[channel]}
        disabled={!labels.data || save.isPending} maxTags={50}
        onChange={value => setDraft(current => ({ ...current, [channel]: value }))} />)}
    {labels.isError && <Text c="red" size="sm">Could not load labels.</Text>}
    <Group justify="flex-end"><Button disabled={!labels.data || Object.values(draft).some(values => values.length === 0)}
      loading={save.isPending} onClick={() => save.mutate()}>Save display labels</Button></Group>
  </Stack></Paper>;
}
