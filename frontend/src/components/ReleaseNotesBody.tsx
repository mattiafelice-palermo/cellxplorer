import { Paper, ScrollArea, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

import {
  buildReleaseNoteBlocks,
  type AppUpdateRelease,
} from "../appUpdater";

export function ReleaseNotesBody({ release }: { release: AppUpdateRelease }) {
  const blocks = buildReleaseNoteBlocks(release.notes);

  return (
    <Paper withBorder radius="md" p="sm">
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={6}>
          {blocks.map((block, index) =>
            block.kind === "heading" ? (
              <Text
                key={`${index}:heading:${block.text}`}
                size="xs"
                c="dimmed"
                tt="uppercase"
                fw={700}
                mt={index === 0 ? 0 : 4}
              >
                {renderInlineEmphasis(block.text)}
              </Text>
            ) : block.kind === "text" ? (
              <Text key={`${index}:text:${block.text}`} size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {renderInlineEmphasis(block.text)}
              </Text>
            ) : (
              <Stack
                key={`${index}:bullets:${block.items.join("\n")}`}
                component="ul"
                gap={6}
                m={0}
                pl="md"
                style={{ listStyleType: "disc" }}
              >
                {block.items.map((item, itemIndex) => (
                  <Text component="li" size="sm" key={`${itemIndex}:${item}`}>
                    {renderInlineEmphasis(item)}
                  </Text>
                ))}
              </Stack>
            ),
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}

function renderInlineEmphasis(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*\n]+\*\*|__[^_\n]+__)/g)
    .filter(Boolean)
    .map((part, index) => {
      const strong =
        (part.startsWith("**") && part.endsWith("**")) ||
        (part.startsWith("__") && part.endsWith("__"));
      if (!strong) return part;
      return (
        <Text component="strong" inherit fw={700} key={`${index}:${part}`}>
          {part.slice(2, -2)}
        </Text>
      );
    });
}
