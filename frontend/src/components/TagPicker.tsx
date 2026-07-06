// Tag assignment with autocomplete against the central registry.
// Creating a NEW tag is deliberate: it requires an explicit confirm step.
import { Button, Group, Stack, TagsInput, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { get, post, TagInfo } from "../api";

export function TagPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
}) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => get<TagInfo[]>("/api/tags") });
  const known = new Set((tags.data ?? []).map((t) => t.name));
  const [pending, setPending] = useState<string | null>(null);

  const createTag = useMutation({
    mutationFn: (name: string) => post("/api/tags", { name }),
    onSuccess: (_d, name) => {
      qc.invalidateQueries({ queryKey: ["tags"] });
      onChange([...value, name]);
    },
  });

  const handleChange = (next: string[]) => {
    const unknown = next.find((t) => !known.has(t));
    if (unknown) {
      setPending(unknown);
      modals.openConfirmModal({
        title: "Register new tag?",
        children: (
          <Text size="sm">
            “{unknown}” is not in the tag registry yet. Tags are for flagging and finding — create
            it as a new registered tag?
          </Text>
        ),
        labels: { confirm: "Create tag", cancel: "Cancel" },
        onConfirm: () => createTag.mutate(unknown),
        onCancel: () => setPending(null),
        onClose: () => setPending(null),
      });
      return; // don't apply until confirmed
    }
    onChange(next);
  };

  return (
    <TagsInput
      label="Tags"
      description="Autocompletes against registered tags; new tags need confirmation"
      data={[...known]}
      value={value}
      onChange={handleChange}
      placeholder={pending ? `Confirming “${pending}”…` : "Add tag"}
    />
  );
}
