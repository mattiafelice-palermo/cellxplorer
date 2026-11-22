"""Canonical mapping of Maccor native measurements and tab-separated records."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .source_format_errors import InvalidSourceFormatError, UnsupportedSourceFormatError


# End-of-step codes observed immediately before a new executed step in this dialect.
_STEP_END = (129, 132, 133)


def _validate_records(table: pd.DataFrame) -> None:
    if (table["Rec"].iloc[0] < 1 or table["Rec"].diff().iloc[1:].ne(1).any()
            or table["Cycle C"].lt(1).any() or table["Cycle C"].diff().lt(0).any()):
        raise InvalidSourceFormatError("Expected consecutive Maccor records and ordered Cycle C labels.")
    if "Cycle P" in table and table["Cycle P"].ne(0).any():
        raise UnsupportedSourceFormatError("Maccor exports with an active Cycle P counter are unsupported.")
    if (table[["TestTime", "StepTime", "Current [A]", "Cap. [Ah]", "Ener. [Wh]"]] < 0).any().any():
        raise InvalidSourceFormatError("Expected nonnegative Maccor times and unsigned current, Ah and Wh.")
    if table["TestTime"].diff().lt(0).any():
        raise InvalidSourceFormatError("Maccor TestTime decreases in acquisition order.")
    if not table["Md"].isin(("C", "D", "R", "SBw")).all():
        raise UnsupportedSourceFormatError("Unsupported Maccor operating mode.")
    if not table["ES"].isin((0, 1, 4, 5, *_STEP_END, 195)).all():
        raise UnsupportedSourceFormatError("Unsupported Maccor end status.")


def _check_clocks(table: pd.DataFrame, step: pd.Series) -> None:
    # These header labels omit units. Compare both numeric clocks to elapsed
    # wall time within steps. Suspension and adjustments can shift local dates.
    clocks = table[["TestTime", "StepTime", "DPT Time"]]
    elapsed = clocks - clocks.groupby(step, sort=False).transform("first")
    wall = elapsed["DPT Time"].dt.total_seconds()
    informative = wall.ge(4) & elapsed["TestTime"].gt(0)
    if not informative.any() and not table[["TestTime", "StepTime"]].any().any():
        return
    for name in ("TestTime", "StepTime"):
        seconds = elapsed.loc[informative, name] * 60
        observed = wall[informative]
        matches = (seconds - observed).abs().le(1.1 + observed * 0.01)
        if matches.empty or matches.mean() < 0.9:
            raise UnsupportedSourceFormatError(f"Maccor {name} in minutes could not be verified against DPT Time.")


def canonical_records(table: pd.DataFrame, *, verify_minute_units: bool) -> pd.DataFrame:
    """Map ordered magnitudes and counters to the CellXplorer cycling contract."""
    _validate_records(table)
    cycle, program, mode, es = (table[name] for name in ("Cycle C", "Step", "Md", "ES"))
    standby = mode.eq("SBw")
    neutral = standby | mode.eq("R")
    if (neutral & table["Current [A]"].ne(0)).any() or (standby != es.eq(195)).any():
        raise InvalidSourceFormatError("Inconsistent Maccor rest or standby record.")
    if table.loc[mode.eq("R"), ["Cap. [Ah]", "Ener. [Wh]"]].ne(0).any().any():
        raise UnsupportedSourceFormatError("Unsupported Maccor rest counters.")

    # A witnessed SBw interruption retains the execution's elapsed time and
    # counters. Its own current stays zero. A different/resumed operation
    # cannot provide this evidence for an isolated standby record.
    same_program = cycle.eq(cycle.shift()) & program.eq(program.shift())
    if standby.any():
        before, after = mode.shift(), mode.shift(-1)
        witnessed = (same_program & same_program.shift(-1, fill_value=False)
                     & before.isin(("C", "D")) & before.eq(after)
                     & table["StepTime"].diff().ge(0) & table["StepTime"].diff().shift(-1).ge(0))
        if (standby & ~witnessed).any():
            raise UnsupportedSourceFormatError("Maccor standby is outside a verified continuing step.")
    direction = mode.where(~standby, mode.shift())
    boundary = (~same_program | direction.ne(direction.shift())
                | table["StepTime"].diff().lt(0) | es.shift().isin(_STEP_END))
    step = boundary.cumsum()
    if verify_minute_units:
        _check_clocks(table, step)

    charge, discharge = direction.eq("C"), direction.eq("D")
    signed_current = table["Current [A]"] * np.where(discharge, -1000.0, 1000.0)
    raw = pd.DataFrame({
        "record_index": table["Rec"], "cycle": cycle, "step_index": program, "step": step,
        "status": mode.map({"C": "Chg", "D": "DChg", "R": "Rest", "SBw": "Standby"}),
        "time_s": table["StepTime"] * 60, "total_time_s": table["TestTime"] * 60,
        "timestamp": table["DPT Time"], "current_ma": signed_current, "voltage_v": table["Voltage [V]"],
        "maccor_mode": mode, "maccor_end_status": es, "cv_mode_known": False,
    })
    if standby.any():
        # Zero current at this record does not reset the measured step counter.
        raw["maccor_standby_phase"] = direction.where(standby).map({"C": "charge", "D": "discharge"})
    for native, quantity, original in (
        ("Cap. [Ah]", "capacity_mah", "maccor_capacity_ah"),
        ("Ener. [Wh]", "energy_mwh", "maccor_energy_wh"),
    ):
        counters = table[native].groupby(step, sort=False)
        if counters.diff().lt(0).any():
            raise InvalidSourceFormatError(f"Maccor {native} decreases within an executed step.")
        raw[original] = table[native]
        # Shared scientific consumers sum measured per-execution spans. A
        # continued counter on the next programmed step must not count twice.
        span = (table[native] - counters.transform("first")) * 1000
        raw[f"charge_{quantity}"] = span.where(charge, 0.0)
        raw[f"discharge_{quantity}"] = span.where(discharge, 0.0)

    ends = es.groupby(step, sort=False)
    closed = ends.first().eq(0) & ends.last().isin(_STEP_END)
    incomplete = (~neutral & ~step.map(closed)).groupby(cycle).any()
    measured = table["Current [A]"].gt(0)
    paired = (charge & measured).groupby(cycle).any() & (discharge & measured).groupby(cycle).any()
    complete = paired & ~incomplete
    if table["Rec"].iloc[0] != 1:
        complete.iloc[0] = False
    raw["cycle_complete"] = cycle.map(complete)
    # VAR channels are source-defined. Preserve values under their declared
    # names without assigning units, electrode roles, or protocol semantics.
    for name in table.columns:
        if name.startswith("VAR") and name[3:].isdigit():
            raw[f"maccor_{name}"] = table[name]
    return raw
