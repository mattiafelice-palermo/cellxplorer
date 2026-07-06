// Central tag registry + collections management.
import {
  Alert,
  ActionIcon,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconTrash } from "@tabler/icons-react";
import { useState } from "react";

import { CollectionInfo, del, get, post, TagInfo } from "../api";

function Registry<T extends { id: number; name: string }>({
  title,
  hint,
  items,
  counts,
  onCreate,
  onDelete,
}: {
  title: string;
  hint: string;
  items: T[];
  counts: (item: T) => string;
  onCreate: (name: string) => void;
  onDelete: (item: T) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Paper p="md" withBorder style={{ flex: 1 }}>
      <Text fw={600}>{title}</Text>
      <Text size="xs" c="dimmed" mb="sm">
        {hint}
      </Text>
      <Group mb="sm">
        <TextInput
          size="xs"
          placeholder="New name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Button
          size="xs"
          disabled={!name.trim()}
          onClick={() => {
            onCreate(name.trim());
            setName("");
          }}
        >
          Create
        </Button>
      </Group>
      {items.length === 0 ? (
        <Alert color="gray" p="xs">
          None yet.
        </Alert>
      ) : (
        <Table>
          <Table.Tbody>
            {items.map((it) => (
              <Table.Tr key={it.id}>
                <Table.Td>{it.name}</Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {counts(it)}
                  </Text>
                </Table.Td>
                <Table.Td w={40}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      modals.openConfirmModal({
                        title: `Delete “${it.name}”?`,
                        children: (
                          <Text size="sm">
                            It will be removed from everything it labels. Data is untouched.
                          </Text>
                        ),
                        labels: { confirm: "Delete", cancel: "Cancel" },
                        confirmProps: { color: "red" },
                        onConfirm: () => onDelete(it),
                      })
                    }
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Paper>
  );
}

export function FacetsPage() {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => get<TagInfo[]>("/api/tags") });
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => get<CollectionInfo[]>("/api/collections"),
  });

  const err = (e: Error) => notifications.show({ message: e.message, color: "red" });
  const createTag = useMutation({
    mutationFn: (name: string) => post("/api/tags", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
    onError: err,
  });
  const deleteTag = useMutation({
    mutationFn: (id: number) => del(`/api/tags/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });
  const createCollection = useMutation({
    mutationFn: (name: string) => post("/api/collections", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
    onError: err,
  });
  const deleteCollection = useMutation({
    mutationFn: (id: number) => del(`/api/collections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });

  return (
    <Stack>
      <Title order={3}>Tags & collections</Title>
      <Text size="sm" c="dimmed">
        Rules of thumb: filter on it → <b>metadata</b>; flagging something unexpected →{" "}
        <b>tag</b>; how you navigate data → <b>folder</b>; a body of work → <b>project</b>; cells
        you'll plot together → <b>group</b>; grouping analyses by purpose → <b>collection</b>.
      </Text>
      <Group align="start" grow>
        <Registry
          title="Tag registry"
          hint="Free labels on cells AND analyses. Central registry: creating one is deliberate; assignment autocompletes against this list."
          items={tags.data ?? []}
          counts={(t) => `${t.n_cells} cells · ${t.n_analyses} analyses`}
          onCreate={(n) => createTag.mutate(n)}
          onDelete={(t) => deleteTag.mutate(t.id)}
        />
        <Registry
          title="Collections"
          hint="Named sets of analyses (e.g. “Paper X”, “Q1 review”). Flat and many-to-many — an analysis can be in several; collections never nest."
          items={collections.data ?? []}
          counts={(c) => `${c.n_analyses} analyses`}
          onCreate={(n) => createCollection.mutate(n)}
          onDelete={(c) => deleteCollection.mutate(c.id)}
        />
      </Group>
    </Stack>
  );
}
