"""Publish independent BioLogic quantity verdicts through raw, cache and preview consumers."""
from __future__ import annotations

import numpy as np
import pandas as pd


UNRESOLVED_CYCLE_SOURCE = "unresolved_biologic_cycles"


def record_limitations(frame: pd.DataFrame, technique: str, limitations: dict[str, str]) -> None:
    if not limitations:
        return
    state = frame.attrs.setdefault("biologic_gcpl", {})
    state["quantity_limitations"] = limitations
    warnings = state.setdefault("parser_warnings", [])
    for quantity, reason in limitations.items():
        if quantity != "phases":
            warnings.append({
                "code": "biologic_quantity_unavailable", "scope": "source", "count": 1,
                "message": f"{technique} {quantity} could not be fully verified. {reason}",
            })
    if "capacity" in limitations:
        frame["capacity_verified"] = False
        frame["charge_capacity_mah"] = np.nan
        frame["discharge_capacity_mah"] = np.nan
    if "cycles" in limitations:
        state["cycle_source"] = UNRESOLVED_CYCLE_SOURCE
        frame["cycle"] = 1  # Storage address for the original rows.
    if {"cycles", "phases", "status"}.intersection(limitations):
        frame["cycle_complete"] = False
        frame["measurement_type"] = UNRESOLVED_CYCLE_SOURCE
        if "biologic_mb_time_s" not in frame:
            frame["mpr_elapsed_time_s"] = frame["total_time_s"]
