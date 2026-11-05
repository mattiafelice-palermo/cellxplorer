import { Button, Group, Modal, NumberInput, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { post, type ActiveMaterialPreset, type ActiveMaterialPresetSettings,
  type ElectrodeAreaPreset, type ElectrodeAreaPresetSettings } from "../api";

type Props = { disabled?: boolean } & (
  | { kind: "material"; onCreated: (preset: ActiveMaterialPreset) => void }
  | { kind: "area"; onCreated: (preset: ElectrodeAreaPreset) => void });

/** Append through the server so another editor's newer presets are retained. */
export function AddScientificPresetButton(props: Props) {
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState<number | string>("");
  const [description, setDescription] = useState("");
  const isMaterial = props.kind === "material";
  const save = useMutation({
    mutationFn: async () => {
      const common = { name: name.trim(), description: description.trim() || null };
      if (props.kind === "material") {
        const result = await post<ActiveMaterialPresetSettings>("/api/settings/active-material-presets", {
          ...common, specific_capacity_mah_g: Number(value),
        });
        return { kind: "material" as const, result };
      }
      const result = await post<ElectrodeAreaPresetSettings>("/api/settings/electrode-area-presets", {
        ...common, area_cm2: Number(value),
      });
      return { kind: "area" as const, result };
    },
    onSuccess: (saved) => {
      if (saved.kind === "material" && props.kind === "material") {
        queryClient.setQueryData(["active-material-presets"], saved.result);
        const preset = saved.result.presets[saved.result.presets.length - 1];
        if (preset) props.onCreated(preset);
      } else if (saved.kind === "area" && props.kind === "area") {
        queryClient.setQueryData(["electrode-area-presets"], saved.result);
        const preset = saved.result.presets[saved.result.presets.length - 1];
        if (preset) props.onCreated(preset);
      }
      setOpened(false);
      setName(""); setValue(""); setDescription("");
      notifications.show({ message: "Preset added to settings.", color: "teal" });
    },
    onError: (error: Error) => notifications.show({ message: error.message || "Could not add preset.", color: "red" }),
  });
  const valid = name.trim().length > 0 && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0;
  return <>
    <Button size="compact-sm" variant="subtle" disabled={props.disabled} leftSection={<IconPlus size={14} />} onClick={() => setOpened(true)}>
      Add {isMaterial ? "material" : "area"} preset
    </Button>
    <Modal opened={opened} onClose={() => { if (!save.isPending) setOpened(false); }}
      title={isMaterial ? "Add active-material preset" : "Add electrode-area preset"}>
      <Stack gap="sm">
        <TextInput label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} autoFocus />
        <NumberInput label={isMaterial ? "Specific capacity (mAh/g)" : "Electrode area (cm²)"}
          min={0.000001} decimalScale={6} value={value} onChange={setValue} />
        <TextInput label="Description (optional)" value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" disabled={save.isPending} onClick={() => setOpened(false)}>Cancel</Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Add preset</Button>
        </Group>
      </Stack>
    </Modal>
  </>;
}
