import {
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Menu,
  NumberInput,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronUp,
  IconFilter,
} from "@tabler/icons-react";
import type { Dispatch, SetStateAction } from "react";

import {
  CELL_LIBRARY_STATUS_ORDER,
  activeCellLibraryColumnFilter,
  type CellLibraryColumn,
  type CellLibraryFilters,
  type CellLibrarySort,
  type SortDirection,
} from "../libraryTableLogic";

const COLUMN_LABELS: Record<CellLibraryColumn, string> = {
  cell: "Cell",
  replicates: "Replicates",
  cycles: "Cycles",
  maxSpecificDischarge: "Max specific discharge",
  totalCharge: "Total charge",
  totalDischarge: "Total discharge",
  status: "Status",
  created: "Created",
};

function sortLabels(column: CellLibraryColumn): { asc: string; desc: string } {
  if (column === "cell") {
    return { asc: "Sort A to Z", desc: "Sort Z to A" };
  }
  if (column === "created") {
    return { asc: "Oldest to newest", desc: "Newest to oldest" };
  }
  if (column === "status") {
    return { asc: "Sort ascending", desc: "Sort descending" };
  }
  return { asc: "Sort smallest to largest", desc: "Sort largest to smallest" };
}

function clearColumnFilter(
  column: CellLibraryColumn,
  setFilters: Dispatch<SetStateAction<CellLibraryFilters>>,
) {
  setFilters((current) => {
    switch (column) {
      case "cell":
        return { ...current, cellText: "" };
      case "replicates":
        return {
          ...current,
          replicateNameText: "",
          replicateCountMin: null,
          replicateCountMax: null,
        };
      case "cycles":
        return { ...current, cyclesMin: null, cyclesMax: null };
      case "maxSpecificDischarge":
        return {
          ...current,
          maxSpecificDischargeMin: null,
          maxSpecificDischargeMax: null,
        };
      case "totalCharge":
        return { ...current, totalChargeMin: null, totalChargeMax: null };
      case "totalDischarge":
        return { ...current, totalDischargeMin: null, totalDischargeMax: null };
      case "status":
        return { ...current, statuses: [] };
      case "created":
        return { ...current, createdFrom: "", createdTo: "" };
      default:
        return current;
    }
  });
}

function numericBound(value: number | null): number | "" {
  return value ?? "";
}

export function CellLibraryColumnMenu({
  column,
  sort,
  filters,
  setFilters,
  setSort,
  replicateFiltersEnabled,
  replicateFiltersFailed,
  align = "left",
}: {
  column: CellLibraryColumn;
  sort: CellLibrarySort;
  filters: CellLibraryFilters;
  setFilters: Dispatch<SetStateAction<CellLibraryFilters>>;
  setSort: (column: CellLibraryColumn, direction: SortDirection) => void;
  replicateFiltersEnabled: boolean;
  replicateFiltersFailed: boolean;
  align?: "left" | "right";
}) {
  const filtered = activeCellLibraryColumnFilter(column, filters);
  const sorted = sort.column === column;
  const labels = sortLabels(column);
  const replicateDisabled = column === "replicates" && !replicateFiltersEnabled;
  const replicateSortDisabled = column === "replicates" && !replicateFiltersEnabled;

  return (
    <Menu closeOnItemClick={false} withinPortal position="bottom-start" shadow="md">
      <Menu.Target>
        <UnstyledButton
          aria-label={`Sort and filter ${COLUMN_LABELS[column]}`}
          onClick={(event) => event.stopPropagation()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: align === "right" ? "flex-end" : "flex-start",
            gap: 6,
            width: "100%",
          }}
        >
          <Text size="sm" fw={700} truncate>
            {COLUMN_LABELS[column]}
          </Text>
          {sorted ? (
            sort.direction === "asc" ? (
              <IconChevronUp size={14} />
            ) : (
              <IconChevronDown size={14} />
            )
          ) : filtered ? (
            <IconFilter size={13} color="var(--mantine-color-teal-6)" />
          ) : (
            <IconArrowsSort size={13} color="var(--mantine-color-gray-5)" />
          )}
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown onClick={(event) => event.stopPropagation()} miw={250}>
        <Menu.Item
          disabled={replicateSortDisabled}
          onClick={() => setSort(column, "asc")}
          leftSection={<IconChevronUp size={14} />}
        >
          {labels.asc}
        </Menu.Item>
        <Menu.Item
          disabled={replicateSortDisabled}
          onClick={() => setSort(column, "desc")}
          leftSection={<IconChevronDown size={14} />}
        >
          {labels.desc}
        </Menu.Item>
        <Divider my="xs" />
        <Box px="sm" pb="xs">
          {column === "cell" && (
            <TextInput
              size="xs"
              label="Contains"
              placeholder="Search this column"
              value={filters.cellText}
              onChange={(event) =>
                setFilters((current) => ({ ...current, cellText: event.currentTarget.value }))
              }
            />
          )}
          {column === "replicates" && (
            <Stack gap="xs">
              {replicateFiltersFailed ? (
                <Text size="xs" c="red">
                  Replicate membership could not be loaded.
                </Text>
              ) : null}
              <TextInput
                size="xs"
                label="Replicate name contains"
                value={filters.replicateNameText}
                disabled={replicateDisabled}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    replicateNameText: event.currentTarget.value,
                  }))
                }
              />
              <Group grow align="end">
                <NumberInput
                  size="xs"
                  label="Minimum count"
                  min={0}
                  disabled={replicateDisabled}
                  value={numericBound(filters.replicateCountMin)}
                  onChange={(value) =>
                    setFilters((current) => ({
                      ...current,
                      replicateCountMin: typeof value === "number" ? value : null,
                    }))
                  }
                />
                <NumberInput
                  size="xs"
                  label="Maximum count"
                  min={0}
                  disabled={replicateDisabled}
                  value={numericBound(filters.replicateCountMax)}
                  onChange={(value) =>
                    setFilters((current) => ({
                      ...current,
                      replicateCountMax: typeof value === "number" ? value : null,
                    }))
                  }
                />
              </Group>
            </Stack>
          )}
          {column === "cycles" && (
            <Group grow align="end">
              <NumberInput
                size="xs"
                label="Minimum"
                min={0}
                value={numericBound(filters.cyclesMin)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    cyclesMin: typeof value === "number" ? value : null,
                  }))
                }
              />
              <NumberInput
                size="xs"
                label="Maximum"
                min={0}
                value={numericBound(filters.cyclesMax)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    cyclesMax: typeof value === "number" ? value : null,
                  }))
                }
              />
            </Group>
          )}
          {column === "maxSpecificDischarge" && (
            <Group grow align="end">
              <NumberInput
                size="xs"
                label="Minimum (mAh/g)"
                min={0}
                value={numericBound(filters.maxSpecificDischargeMin)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    maxSpecificDischargeMin: typeof value === "number" ? value : null,
                  }))
                }
              />
              <NumberInput
                size="xs"
                label="Maximum (mAh/g)"
                min={0}
                value={numericBound(filters.maxSpecificDischargeMax)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    maxSpecificDischargeMax: typeof value === "number" ? value : null,
                  }))
                }
              />
            </Group>
          )}
          {column === "totalCharge" && (
            <Group grow align="end">
              <NumberInput
                size="xs"
                label="Minimum (mAh)"
                min={0}
                value={numericBound(filters.totalChargeMin)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    totalChargeMin: typeof value === "number" ? value : null,
                  }))
                }
              />
              <NumberInput
                size="xs"
                label="Maximum (mAh)"
                min={0}
                value={numericBound(filters.totalChargeMax)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    totalChargeMax: typeof value === "number" ? value : null,
                  }))
                }
              />
            </Group>
          )}
          {column === "totalDischarge" && (
            <Group grow align="end">
              <NumberInput
                size="xs"
                label="Minimum (mAh)"
                min={0}
                value={numericBound(filters.totalDischargeMin)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    totalDischargeMin: typeof value === "number" ? value : null,
                  }))
                }
              />
              <NumberInput
                size="xs"
                label="Maximum (mAh)"
                min={0}
                value={numericBound(filters.totalDischargeMax)}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    totalDischargeMax: typeof value === "number" ? value : null,
                  }))
                }
              />
            </Group>
          )}
          {column === "status" && (
            <ScrollArea.Autosize mah={220} type="auto">
              <Stack gap={5}>
                {CELL_LIBRARY_STATUS_ORDER.map((status) => (
                  <Checkbox
                    key={status}
                    size="xs"
                    label={status}
                    checked={filters.statuses.includes(status)}
                    onChange={() =>
                      setFilters((current) => ({
                        ...current,
                        statuses: current.statuses.includes(status)
                          ? current.statuses.filter((item) => item !== status)
                          : [...current.statuses, status],
                      }))
                    }
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
          {column === "created" && (
            <Stack gap="xs">
              <TextInput
                type="date"
                size="xs"
                label="From"
                value={filters.createdFrom}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, createdFrom: event.currentTarget.value }))
                }
              />
              <TextInput
                type="date"
                size="xs"
                label="To"
                value={filters.createdTo}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, createdTo: event.currentTarget.value }))
                }
              />
            </Stack>
          )}
          {filtered && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              mt="sm"
              onClick={() => clearColumnFilter(column, setFilters)}
            >
              Clear filter
            </Button>
          )}
        </Box>
      </Menu.Dropdown>
    </Menu>
  );
}
