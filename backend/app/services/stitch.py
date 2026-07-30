"""Test stitching: combine a test's ordered files into one continuous
cycle-numbered record with explicit segment boundaries and provenance.

Observed source-local cycle labels map densely to global cycles in stable
numeric order. Missing local labels are never invented. A missing ordered
source cache stops continuation mapping for later sources so consumers can
fail closed instead of treating a partial chain as complete.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd

from . import cache


def stitch_metadata(frame: pd.DataFrame) -> dict[str, Any]:
    """Return stitch completeness metadata stored on a stitched frame."""
    return {
        "complete": bool(frame.attrs.get("stitch_complete", True)),
        "missing_positions": list(frame.attrs.get("missing_positions", [])),
        "skipped_segments": list(frame.attrs.get("skipped_segments", [])),
    }


def observed_local_cycles(cycle_series: pd.Series) -> tuple[list[int], list[str]]:
    """Return distinct numeric local cycle labels in stable sorted order."""
    if cycle_series.empty:
        return [], []

    raw = cycle_series.dropna()
    if raw.empty:
        return [], []

    numeric = pd.to_numeric(raw, errors="coerce")
    errors: list[str] = []
    invalid = raw[numeric.isna()]
    if not invalid.empty:
        sample = ", ".join(str(value) for value in invalid.unique()[:5])
        errors.append(f"non-numeric cycle values: {sample}")
        return [], errors

    rounded = numeric.round()
    if not np.allclose(numeric.to_numpy(dtype="float64"), rounded.to_numpy(dtype="float64")):
        errors.append("non-integer cycle values")
        return [], errors

    labels = sorted(int(value) for value in rounded.unique())
    return labels, errors


def build_dense_cycle_map(local_labels: list[int], global_start: int) -> dict[int, int]:
    """Assign each observed local label exactly one dense global cycle."""
    return {local: global_start + index for index, local in enumerate(local_labels)}


def _apply_cycle_mapping(
    df: pd.DataFrame,
    *,
    segment: int,
    source_hash: str,
    local_labels: list[int],
    cycle_map: dict[int, int],
) -> pd.DataFrame:
    out = df.copy()
    if "cycle" in out.columns:
        source_cycles = pd.to_numeric(out["cycle"], errors="coerce")
        out["source_cycle"] = source_cycles
        if local_labels:
            out["cycle"] = source_cycles.map(cycle_map)
    out["segment"] = segment
    out["source_hash"] = source_hash
    return out


def _segment_metadata(
    *,
    file_hash: str,
    segment: int,
    local_labels: list[int],
    global_start: int,
) -> dict[str, Any]:
    if not local_labels:
        return {
            "file_hash": file_hash,
            "segment": segment,
            "source_cycle_start": None,
            "source_cycle_end": None,
            "source_cycle_count": 0,
            "cycle_start": None,
            "cycle_end": None,
            "incomplete_boundary_unknown": True,
        }
    global_end = global_start + len(local_labels) - 1
    return {
        "file_hash": file_hash,
        "segment": segment,
        "source_cycle_start": local_labels[0],
        "source_cycle_end": local_labels[-1],
        "source_cycle_count": len(local_labels),
        "cycle_start": global_start,
        "cycle_end": global_end,
        "incomplete_boundary_unknown": True,
    }


def _stitch_ordered(
    ordered_hashes: list[str],
    load_fn: Callable[[str], pd.DataFrame | None],
    *,
    sort_output: bool,
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    frames: list[pd.DataFrame] = []
    segments: list[dict] = []
    missing: list[str] = []
    missing_positions: list[int] = []
    skipped_segments: list[int] = []
    global_next = 1
    continuation_blocked = False

    for segment, file_hash in enumerate(ordered_hashes):
        loaded = load_fn(file_hash)
        if loaded is None:
            missing.append(file_hash)
            missing_positions.append(segment)
            continuation_blocked = True
            continue
        if continuation_blocked:
            skipped_segments.append(segment)
            continue

        local_labels, errors = observed_local_cycles(loaded["cycle"]) if "cycle" in loaded.columns else ([], [])
        if errors or (len(loaded) > 0 and not local_labels):
            missing.append(file_hash)
            missing_positions.append(segment)
            continuation_blocked = True
            continue

        cycle_map = build_dense_cycle_map(local_labels, global_next)
        mapped = _apply_cycle_mapping(
            loaded,
            segment=segment,
            source_hash=file_hash,
            local_labels=local_labels,
            cycle_map=cycle_map,
        )
        if not sort_output and "record_index" in mapped.columns:
            mapped = mapped.sort_values("record_index", kind="stable").reset_index(drop=True)
        segments.append(
            _segment_metadata(
                file_hash=file_hash,
                segment=segment,
                local_labels=local_labels,
                global_start=global_next,
            )
        )
        if local_labels:
            global_next += len(local_labels)
        frames.append(mapped)

    if not frames:
        result = pd.DataFrame()
    else:
        result = pd.concat(frames, ignore_index=True)
        if sort_output and not result.empty and "source_cycle" in result.columns:
            result = result.sort_values(["segment", "source_cycle"], kind="stable").reset_index(
                drop=True
            )

    result.attrs["stitch_complete"] = not missing_positions
    result.attrs["missing_positions"] = missing_positions
    result.attrs["skipped_segments"] = skipped_segments
    return result, segments, missing


def stitch_cycles(
    ordered_hashes: list[str], parser_version: str, calc_version: str
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    return _stitch_ordered(
        ordered_hashes,
        lambda file_hash: cache.load_cycles(file_hash, parser_version, calc_version),
        sort_output=True,
    )


def stitch_raw(
    ordered_hashes: list[str], parser_version: str
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    return _stitch_ordered(
        ordered_hashes,
        lambda file_hash: cache.load_raw(file_hash, parser_version),
        sort_output=False,
    )
