// ---------------------------------------------------------------------------
// Debounced inputs: keep keystrokes/drags in local state and commit to the
// spec only after a pause (or blur/Enter). Committing per keystroke re-built
// the whole spec, re-rendered the Plotly figure and (for computation fields)
// fired a compute request per character — that was the typing lag.
import { ColorInput, NumberInput, TextInput } from "@mantine/core";
import { useEffect, useRef, useState, type ComponentProps } from "react";

const COMMIT_DELAY_MS = 450;

export function useDebouncedCommit<T>(value: T, onCommit: (value: T) => void) {
  const [local, setLocal] = useState<T>(value);
  const focusedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const change = (next: T) => {
    setLocal(next);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commitRef.current(next);
    }, COMMIT_DELAY_MS);
  };
  const flush = () => {
    clearTimer();
    commitRef.current(local);
  };
  return { local, change, flush, focusedRef };
}

export function DebouncedTextInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
  ComponentProps<typeof TextInput>,
  "value" | "onChange"
>) {
  const { local, change, flush, focusedRef } = useDebouncedCommit(value, onCommit);
  return (
    <TextInput
      {...props}
      value={local}
      onChange={(e) => change(e.currentTarget.value)}
      onFocus={() => (focusedRef.current = true)}
      onBlur={() => {
        focusedRef.current = false;
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
        props.onKeyDown?.(e);
      }}
    />
  );
}

export function DebouncedNumberInput({
  value,
  onCommit,
  ...props
}: { value: number | null; onCommit: (value: number | null) => void } & Omit<
  ComponentProps<typeof NumberInput>,
  "value" | "onChange"
>) {
  const { local, change, flush, focusedRef } = useDebouncedCommit<number | "">(
    value ?? "",
    (v) => onCommit(typeof v === "number" ? v : null)
  );
  return (
    <NumberInput
      {...props}
      value={local}
      onChange={(v) => change(typeof v === "number" ? v : "")}
      onFocus={() => (focusedRef.current = true)}
      onBlur={() => {
        focusedRef.current = false;
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
        props.onKeyDown?.(e);
      }}
    />
  );
}

export function DebouncedColorInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
  ComponentProps<typeof ColorInput>,
  "value" | "onChange"
>) {
  const { local, change, focusedRef } = useDebouncedCommit(value, onCommit);
  return (
    <ColorInput
      {...props}
      value={local}
      onChange={change}
      onFocus={() => (focusedRef.current = true)}
      onBlur={() => (focusedRef.current = false)}
    />
  );
}
