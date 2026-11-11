import { TextInput, type TextInputProps } from "@mantine/core";
import { useEffect, useRef } from "react";

/** Select the suggested title once, including when a dialog advances to its details step. */
export function SelectInitialTitleInput(props: TextInputProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  return <TextInput {...props} ref={input} data-autofocus />;
}
