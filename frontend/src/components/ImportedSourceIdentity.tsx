import { Button, Paper, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { importedSourceLabel, type ImportedCell } from "../importedSourceIdentity";
export function ImportedSourceIdentity({ cells = [], onOpen }: { cells?: ImportedCell[]; onOpen: () => void }) {
  return <Paper withBorder p="xs"><Stack gap={4}>
    <Text size="sm" fw={700}>In your database</Text>
    <Text size="xs">{importedSourceLabel(cells)}</Text>
    {cells.map(cell => <Button key={cell.id} component={Link} to={`/?cell=${cell.id}`} onClick={onOpen}
      variant="subtle" size="compact-xs" style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
      <Text size="xs" truncate>Open cell: {cell.name}</Text>
    </Button>)}
  </Stack></Paper>;
}
