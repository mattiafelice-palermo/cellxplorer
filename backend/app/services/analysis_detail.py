"""Shared exact raw-detail access for protocol-derived analysis families.

This module owns only the mechanical boundary between a family planner and
the cache detail reader.  Scientific grouping, pairing and extraction remain
in their existing family modules.  A missing or busy index returns ``None``
so callers can use their complete legacy raw path without waiting.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import pandas as pd

from . import cache, stitch


@dataclass
class IndexedRawBundle:
    frame: pd.DataFrame
    segments: list[dict]
    missing: list[str]
    source_cycles: dict[str, list[int]]
    timestamp_starts: dict[str, str | None]
    diagnostics: dict[str, dict]


def _columns_for_layout(
    layout: dict,
    required_columns: Iterable[str],
    optional_columns: Iterable[str],
) -> list[str] | None:
    available = set(layout.get("raw_column_names") or [])
    required = list(dict.fromkeys(required_columns))
    if any(column not in available for column in required):
        return None
    return required + [
        column
        for column in dict.fromkeys(optional_columns)
        if column in available and column not in required
    ]


def load_indexed_stitched_raw(
    refs: list[stitch.CachedSourceRef],
    steps_by_hash: dict[str, Iterable[int]],
    *,
    required_columns: Iterable[str],
    optional_columns: Iterable[str] = (),
) -> IndexedRawBundle | None:
    """Read exact selected steps from every source and stitch them safely.

    The source-cycle metadata comes from the validated raw-layout index, not
    from the reduced frame.  This preserves dense continuation numbering when
    a source has cycles but none of its rows belong to the selected protocol
    steps.
    """
    frames: dict[tuple[str, str], pd.DataFrame] = {}
    source_cycles: dict[str, list[int]] = {}
    timestamp_starts: dict[str, str | None] = {}
    diagnostics: dict[str, dict] = {}

    for ref in refs:
        layout = cache.try_load_raw_layout_index(ref.file_hash, ref.parser_version)
        if layout is None:
            return None
        columns = _columns_for_layout(
            layout,
            required_columns,
            optional_columns,
        )
        if columns is None:
            return None
        detail_diagnostics = cache.RawDetailReadDiagnostics()
        frame = cache.load_raw_detail(
            ref.file_hash,
            ref.parser_version,
            step_indices=steps_by_hash.get(ref.file_hash, ()),
            columns=columns,
            diagnostics=detail_diagnostics,
            wait_for_index=False,
        )
        diagnostics[ref.file_hash] = dict(vars(detail_diagnostics))
        if frame is None:
            return None
        frames[(ref.file_hash, ref.parser_version)] = frame
        source_cycles[ref.file_hash] = list(layout["observed_source_cycles"])
        timestamp_starts[ref.file_hash] = layout.get("timestamp_start")

    stitched, segments, missing = stitch.stitch_raw_with_loader(
        refs,
        lambda ref: frames[(ref.file_hash, ref.parser_version)],
        source_cycles=source_cycles,
    )
    if missing:
        # All source detail reads succeeded, so this indicates inconsistent
        # source metadata rather than a partial scientific result.  Let the
        # caller use the existing exact legacy path.
        return None
    return IndexedRawBundle(
        frame=stitched,
        segments=segments,
        missing=missing,
        source_cycles=source_cycles,
        timestamp_starts=timestamp_starts,
        diagnostics=diagnostics,
    )


def load_indexed_source_raw(
    ref: stitch.CachedSourceRef,
    step_indices: Iterable[int],
    *,
    required_columns: Iterable[str],
    optional_columns: Iterable[str] = (),
) -> tuple[pd.DataFrame, dict] | None:
    """Load one source's local cycle labels without dense stitching."""
    layout = cache.try_load_raw_layout_index(ref.file_hash, ref.parser_version)
    if layout is None:
        return None
    columns = _columns_for_layout(layout, required_columns, optional_columns)
    if columns is None:
        return None
    diagnostics = cache.RawDetailReadDiagnostics()
    frame = cache.load_raw_detail(
        ref.file_hash,
        ref.parser_version,
        step_indices=step_indices,
        columns=columns,
        diagnostics=diagnostics,
        wait_for_index=False,
    )
    if frame is None:
        return None
    return frame, dict(vars(diagnostics))


def source_timestamp_origin(bundle: IndexedRawBundle) -> pd.Timestamp | None:
    """Return the earliest full-source timestamp from layout metadata."""
    values = [
        pd.to_datetime(value, errors="coerce")
        for value in bundle.timestamp_starts.values()
        if value is not None
    ]
    values = [value for value in values if not pd.isna(value)]
    return min(values) if values else None
