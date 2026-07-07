// Flat analysis index — every analysis, filed or not, in one list.
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { AnalysisFull, AnalysisSummary, del, get, post } from "../api";

export function AnalysesIndexPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const analyses = useQuery({
    queryKey: ["analyses", search],
    queryFn: () =>
      get<AnalysisSummary[]>(`/api/analyses${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });

  const create = useMutation({
    mutationFn: () => post<AnalysisFull>("/api/analyses", { title: "Untitled analysis" }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["analyses"] });
      navigate(`/analyses/${a.id}`);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/analyses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analyses"] }),
  });

  const rows = analyses.data ?? [];

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Analyses</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => create.mutate()} loading={create.isPending}>
          New analysis
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        An analysis is a saved recipe: which cells and replicate groups to compare, how to compute,
        and the provenance of the last saved result. It never changes unless you change it.
      </Text>
      <TextInput
        leftSection={<IconSearch size={14} />}
        placeholder="Search titles"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maw={360}
      />
      {rows.length === 0 ? (
        <Alert color="gray">
          No analyses yet. Create one, then add replicate groups or individual cells to compare
          capacities, efficiencies, retention and more.
        </Alert>
      ) : (
        <Table highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Selection</Table.Th>
              <Table.Th>Quantity</Table.Th>
              <Table.Th>Last computed</Table.Th>
              <Table.Th w={44}></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((a) => (
              <Table.Tr key={a.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/analyses/${a.id}`)}>
                <Table.Td>
                  <Text size="sm" fw={600}>
                    {a.title}
                  </Text>
                  {a.folder && (
                    <Text size="xs" c="dimmed">
                      filed in {a.folder.name}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="outline">
                    {a.type}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">
                    {a.n_entries} entr{a.n_entries === 1 ? "y" : "ies"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{a.quantity?.replace(/_/g, " ") ?? "—"}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {a.computed_at
                      ? `${new Date(a.computed_at).toLocaleString()} · parser ${a.parser_version} · calc ${a.calc_version}`
                      : "never"}
                  </Text>
                </Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Delete analysis (data untouched)">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        modals.openConfirmModal({
                          title: `Delete “${a.title}”?`,
                          children: (
                            <Text size="sm">The recipe and provenance are removed. Data is untouched.</Text>
                          ),
                          labels: { confirm: "Delete", cancel: "Cancel" },
                          confirmProps: { color: "red" },
                          onConfirm: () => remove.mutate(a.id),
                        })
                      }
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
