import { Button, Group, Paper, Pill, Stack, Text } from "@mantine/core";
import { useRef, useState } from "react";

import {
  EXPORT_FILENAME_TOKENS,
  type ExportFilenameToken,
} from "../exportFilenames";

interface TemplateParts {
  gaps: string[];
  tokens: ExportFilenameToken[];
}

function parseTemplate(value: string): TemplateParts {
  const tokenPattern = new RegExp(
    `(${EXPORT_FILENAME_TOKENS.map((token) => token.replace(/[{}]/g, "\\$&")).join("|")})`,
    "g",
  );
  const pieces = value.split(tokenPattern);
  const gaps: string[] = [""];
  const tokens: ExportFilenameToken[] = [];

  pieces.forEach((piece) => {
    if (EXPORT_FILENAME_TOKENS.includes(piece as ExportFilenameToken)) {
      tokens.push(piece as ExportFilenameToken);
      gaps.push("");
    } else {
      gaps[gaps.length - 1] += piece;
    }
  });
  return { gaps, tokens };
}

function serializeTemplate(parts: TemplateParts): string {
  return parts.tokens.reduce(
    (value, token, index) => `${value}${token}${parts.gaps[index + 1]}`,
    parts.gaps[0] ?? "",
  );
}

export function FilenameTemplateEditor({
  value,
  onChange,
  label = "Filename",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const parts = parseTemplate(value);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [activeGap, setActiveGap] = useState(parts.gaps.length - 1);

  const updateGap = (index: number, text: string) => {
    const next = parseTemplate(value);
    next.gaps[index] = text;
    onChange(serializeTemplate(next));
  };

  const insertToken = (token: ExportFilenameToken) => {
    const next = parseTemplate(value);
    const gapIndex = Math.min(activeGap, next.gaps.length - 1);
    const input = inputRefs.current[gapIndex];
    const cursor = input?.selectionStart ?? next.gaps[gapIndex].length;
    const gap = next.gaps[gapIndex];
    next.gaps.splice(gapIndex, 1, gap.slice(0, cursor), gap.slice(cursor));
    next.tokens.splice(gapIndex, 0, token);
    onChange(serializeTemplate(next));
    window.setTimeout(() => {
      const target = inputRefs.current[gapIndex + 1];
      target?.focus();
      target?.setSelectionRange(0, 0);
      setActiveGap(gapIndex + 1);
    });
  };

  const removeToken = (index: number) => {
    const next = parseTemplate(value);
    next.gaps.splice(index, 2, `${next.gaps[index]}${next.gaps[index + 1]}`);
    next.tokens.splice(index, 1);
    onChange(serializeTemplate(next));
    window.setTimeout(() => inputRefs.current[index]?.focus());
    setActiveGap(index);
  };

  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>{label}</Text>
      <Paper
        withBorder
        px="xs"
        py={7}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 5,
          minHeight: 42,
        }}
      >
        {parts.gaps.map((gap, index) => (
          <Group key={`gap-${index}`} gap={5} wrap="nowrap">
            <input
              ref={(element) => { inputRefs.current[index] = element; }}
              aria-label={`${label} custom text ${index + 1}`}
              value={gap}
              onFocus={() => setActiveGap(index)}
              onChange={(event) => updateGap(index, event.currentTarget.value)}
              placeholder={parts.tokens.length === 0 && index === 0 ? "Type a filename" : ""}
              style={{
                width: `${Math.max(gap.length + 1, parts.tokens.length === 0 ? 18 : 2)}ch`,
                minWidth: parts.tokens.length === 0 ? 150 : 18,
                maxWidth: "100%",
                border: 0,
                outline: 0,
                padding: "3px 1px",
                background: "transparent",
                font: "inherit",
              }}
            />
            {index < parts.tokens.length && (
              <Pill
                withRemoveButton
                onRemove={() => removeToken(index)}
                removeButtonProps={{ "aria-label": `Remove ${parts.tokens[index]}` }}
                bg="light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))"
                c="teal.8"
              >
                {parts.tokens[index]}
              </Pill>
            )}
          </Group>
        ))}
      </Paper>
      <Group gap={6}>
        {EXPORT_FILENAME_TOKENS.map((token) => (
          <Button
            key={token}
            size="compact-xs"
            variant="light"
            onClick={() => insertToken(token)}
          >
            {token}
          </Button>
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        Automatic fields are fixed chips. Type before, after, or between them to add custom text.
      </Text>
    </Stack>
  );
}
