"""Display-only preparation for the continued-import preview.

The regular continuation stitcher intentionally treats every source as an
ordered block of source-local cycles.  The import workspace also offers a
second, preview-only interpretation for files that are physical fragments of
one experiment: raw rows are concatenated in source order and cycle numbers
are inferred from contiguous charge/discharge phases.  Nothing in this module
is written back to a scientific cache or used by the analysis pipeline.
"""
from __future__ import annotations

from collections.abc import Sequence

import pandas as pd


def _phase(status: object) -> str | None:
    if status is None or (not isinstance(status, str) and pd.isna(status)):
        return None
    value = str(status).casefold()
    # DChg contains "Chg", so discharge must be classified first.
    if "dchg" in value or "discharg" in value:
        return "discharge"
    if "chg" in value or "charg" in value:
        return "charge"
    return None


def infer_contiguous_cycle_ids(status: pd.Series) -> pd.Series:
    """Infer cycle ids from an ordered status stream.

    Rest/preamble rows stay with the surrounding cycle.  A charge phase after
    a discharge phase starts the next cycle; charge-to-discharge and repeated
    same-direction fragments remain in the current cycle.  This makes a chain
    of discharge-only file fragments one logical cycle while retaining the
    source boundaries separately on the returned frame.
    """

    phases = [_phase(value) for value in status.tolist()]
    first_active = next((index for index, value in enumerate(phases) if value), None)
    if first_active is None:
        raise ValueError("The raw source chain has no charge or discharge phase to infer cycles.")

    cycle_ids = [1] * len(phases)
    current_cycle = 1
    previous_active: str | None = None
    for index, phase in enumerate(phases):
        if phase is not None:
            if previous_active == "discharge" and phase == "charge":
                current_cycle += 1
            previous_active = phase
        cycle_ids[index] = current_cycle

    # Rows before the first active phase are a neutral preamble and belong to
    # the first observed cycle.  The loop already assigned them cycle 1; the
    # explicit variable documents that this is intentional.
    if first_active > 0:
        cycle_ids[:first_active] = [1] * first_active
    return pd.Series(cycle_ids, index=status.index, dtype="int64")


def prepare_stitched_raw(source_frames: Sequence[pd.DataFrame]) -> pd.DataFrame:
    """Return ordered raw rows with preview-only inferred cycles and provenance."""

    if not source_frames:
        return pd.DataFrame()

    prepared: list[pd.DataFrame] = []
    for segment, source_frame in enumerate(source_frames):
        frame = source_frame.copy()
        if "record_index" in frame.columns:
            frame = frame.sort_values("record_index", kind="stable")
        frame = frame.reset_index(drop=True)
        if "status" not in frame.columns:
            raise ValueError("The raw source chain has no status column to infer cycles.")

        if "cycle" in frame.columns:
            frame["source_cycle"] = pd.to_numeric(frame["cycle"], errors="coerce")
        else:
            frame["source_cycle"] = pd.Series(pd.NA, index=frame.index, dtype="Int64")
        frame["segment"] = segment
        # calc.per_cycle groups capacity counters by (cycle, step).  A step
        # number can restart in every physical file, so make it source-local
        # without changing the raw scientific columns.
        if "step" in frame.columns:
            step_values = frame["step"].astype("string")
        elif "step_index" in frame.columns:
            step_values = frame["step_index"].astype("string")
        else:
            step_values = pd.Series("0", index=frame.index, dtype="string")
        frame["__preview_step"] = f"{segment}:" + step_values
        frame["step"] = frame["__preview_step"]
        prepared.append(frame)

    merged = pd.concat(prepared, ignore_index=True)
    merged["cycle"] = infer_contiguous_cycle_ids(merged["status"])
    return merged


def voltage_preview_from_raw(
    frame: pd.DataFrame,
    *,
    max_points: int | None = None,
) -> dict[str, object]:
    """Build bounded mean-voltage points without changing a scientific cache."""

    if frame.empty or "cycle" not in frame.columns or "voltage_v" not in frame.columns:
        return {"x": [], "y": [], "quantity": "voltage", "label": "Voltage (V)"}
    rows = (
        frame[["cycle", "voltage_v"]]
        .dropna()
        .groupby("cycle", sort=True)["voltage_v"]
        .mean()
        .reset_index()
    )
    if max_points is not None and max_points > 0 and len(rows) > max_points:
        if max_points == 1:
            rows = rows.iloc[[0]]
        else:
            last = len(rows) - 1
            positions = sorted({round(index * last / (max_points - 1)) for index in range(max_points)})
            rows = rows.iloc[positions]
    return {
        "x": [int(value) for value in rows["cycle"]],
        "y": [float(value) for value in rows["voltage_v"]],
        "quantity": "voltage",
        "label": "Voltage (V)",
    }
