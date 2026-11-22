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
    columns = [c for c in ("mpr_acquisition_segment", "acquisition_segment") if c in frame]
    if len(frame) < 2 or not columns:
        return []
    changed = np.zeros(len(frame) - 1, dtype=bool)
    source = frame["segment"].to_numpy() if "segment" in frame else None
    for column in columns:
        acquisition = pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype=float)
        present = np.isfinite(acquisition)
        involved = present[1:] | present[:-1]
        changed |= involved & (acquisition[1:] != acquisition[:-1])
        if source is not None:
            changed |= involved & (source[1:] != source[:-1])
    return (np.flatnonzero(changed) + 1).tolist()
