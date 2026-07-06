"""Test stitching: combine a test's ordered files into one continuous
cycle-numbered per-cycle record with explicit segment boundaries.

Cycle numbers are offset so each file's cycles continue after the previous
file's last cycle. Returns (DataFrame with source_hash/segment columns,
segments list, missing list). Missing = files whose cache at the requested
versions is unavailable.
"""
from __future__ import annotations

import pandas as pd

from . import cache


def stitch_cycles(
    ordered_hashes: list[str], parser_version: str, calc_version: str
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    frames: list[pd.DataFrame] = []
    segments: list[dict] = []
    missing: list[str] = []
    offset = 0
    for i, h in enumerate(ordered_hashes):
        df = cache.load_cycles(h, parser_version, calc_version)
        if df is None:
            missing.append(h)
            continue
        df = df.copy()
        if len(df):
            first, last = int(df["cycle"].min()), int(df["cycle"].max())
            df["cycle"] = df["cycle"] - first + 1 + offset
            segments.append(
                {
                    "file_hash": h,
                    "segment": i,
                    "cycle_start": offset + 1,
                    "cycle_end": offset + (last - first + 1),
                }
            )
            offset += last - first + 1
        df["segment"] = i
        df["source_hash"] = h
        frames.append(df)
    if not frames:
        return pd.DataFrame(), segments, missing
    return pd.concat(frames, ignore_index=True), segments, missing
