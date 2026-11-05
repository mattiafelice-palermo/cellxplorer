"""Display-only handling for MPR records without a verified interpretation.

Native clocks and acquisition order are evidence. They must not enter the
ordinary step-clock concatenation or cycle-origin normalization rules.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def native_time(frame: pd.DataFrame) -> np.ndarray:
    if "mpr_elapsed_time_s" not in frame.columns:
        return np.full(len(frame), np.nan)
    return pd.to_numeric(frame["mpr_elapsed_time_s"], errors="coerce").to_numpy(dtype=float)


def break_before(frame: pd.DataFrame) -> list[int]:
    """Break sampled curves when their acquisition/source identity changes."""
    if len(frame) < 2 or "mpr_acquisition_segment" not in frame.columns:
        return []
    acquisition = pd.to_numeric(frame["mpr_acquisition_segment"], errors="coerce").to_numpy(dtype=float)
    exploratory = np.isfinite(acquisition)
    changed = (exploratory[1:] | exploratory[:-1]) & (
        (exploratory[1:] != exploratory[:-1]) | (acquisition[1:] != acquisition[:-1])
    )
    if "segment" in frame.columns:
        source = frame["segment"].to_numpy()
        changed |= (exploratory[1:] | exploratory[:-1]) & (source[1:] != source[:-1])
    return (np.flatnonzero(changed) + 1).tolist()
