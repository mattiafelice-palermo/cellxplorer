import { NumberInput } from "@mantine/core";
import { useDebouncedCommit } from "./DebouncedInputs";

/** Keep partial numbers local; Enter or leaving the field applies the edit immediately. */
export function PreviewCycleInput({ label, value, min, max, onCommit }: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}) {
  const { local, change, flush, reset, focusedRef } = useDebouncedCommit<number | string>(value ?? "", input => {
    if (input === "" || value === undefined || !Number.isFinite(Number(input))) {
      reset(value ?? "");
      return;
    }
    const next = Math.max(min, Math.min(max, Math.trunc(Number(input))));
    reset(next);
    if (next !== value) onCommit(next);
  }, 200);

  return <NumberInput aria-label={label} min={min} max={max || undefined} w={86}
    allowDecimal={false} allowNegative={false} clampBehavior="none" disabled={value === undefined}
    value={local} onChange={(next) => next === "" ? reset("") : change(next)}
    onFocus={() => { focusedRef.current = true; }}
    onBlur={() => { focusedRef.current = false; flush(); }} onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        flush();
      } else if (event.key === "Escape") {
        reset(value ?? "");
      }
    }} />;
}
