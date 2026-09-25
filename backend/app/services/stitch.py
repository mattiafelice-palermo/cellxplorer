"""Test stitching: combine a test's ordered files into one continuous
cycle-numbered record with explicit segment boundaries and provenance.

Observed source-local cycle labels map densely to global cycles in stable
numeric order. Missing local labels are never invented. A missing ordered
source cache stops continuation mapping for later sources so consumers can
fail closed instead of treating a partial chain as complete.

Spec 040.3: ordered sources are described by :class:`CachedSourceRef`
(hash + that source's own effective parser identity) rather than one
hash list plus a single parser version shared by the whole chain. A Cell's
ordered sources may legitimately carry different parser identities (mixed
formats, or one source rebuilt at a newer identity than another) without
losing continuation semantics — each source is loaded at its own pinned
identity.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import pandas as pd

from . import cache, canonical_cycling

_CP_CURRENT_TOLERANCE_MA = 1e-6


@dataclass(frozen=True)
class CachedSourceRef:
    """One ordered source's cache identity: content hash + parser identity."""

    file_hash: str
    parser_version: str


class _CpHalfSummaryUnavailable(Exception):
    """A transient cache miss that must not become a memoized negative result."""


@lru_cache(maxsize=2048)
def _memoized_cp_half_cycle_summary(
    file_hash: str, parser_version: str
) -> dict[str, Any]:
    summary = cache.load_biologic_cp_half_cycle_summary(file_hash, parser_version)
    if summary is None:
        raise _CpHalfSummaryUnavailable
    return summary


@lru_cache(maxsize=2048)
def _memoized_indexed_cp_half_cycle_summary(
    cache_root: str, file_hash: str, parser_version: str
) -> dict[str, Any] | None:
    """Cache positive and negative results for a validated raw index."""
    return cache.load_biologic_cp_half_cycle_summary(file_hash, parser_version)


def _cached_cp_half_cycle_summary(
    file_hash: str, parser_version: str
) -> dict[str, Any] | None:
    # Only BioLogic MPR sources can contain the CP protocol rows this summary
    # recognizes. Avoid probing Neware indexes. Older BioLogic indexes can lack
    # the optional summary field, so memoize fallback scans only after the
    # raw/index consistency check proves the index is stable.
    if not parser_version.startswith("bm:"):
        return None
    # A summary missing because its raw cache is not yet available is not an
    # immutable negative result. Do not memoize it across a later cache build.
    if not cache.raw_path(file_hash, parser_version).is_file():
        return None
    try:
        index = cache.try_load_raw_layout_index(file_hash, parser_version)
    except (OSError, cache.RawLayoutError, ValueError):
        index = None
    if index is not None:
        return _memoized_indexed_cp_half_cycle_summary(
            str(cache.CACHE_DIR), file_hash, parser_version
        )
    try:
        return _memoized_cp_half_cycle_summary(file_hash, parser_version)
    except _CpHalfSummaryUnavailable:
        return None


def _has_adjacent_opposite_cp_halves(ordered_sources: list[CachedSourceRef]) -> bool:
    summaries = [
        _cached_cp_half_cycle_summary(source.file_hash, source.parser_version)
        for source in ordered_sources
    ]
    return any(
        left is not None
        and right is not None
        and left.get("direction") != right.get("direction")
        for left, right in zip(summaries, summaries[1:])
    )


def stitch_metadata(frame: pd.DataFrame) -> dict[str, Any]:
    """Return stitch completeness metadata stored on a stitched frame."""
    return {
        "complete": bool(frame.attrs.get("stitch_complete", True)),
        "missing_positions": list(frame.attrs.get("missing_positions", [])),
        "skipped_segments": list(frame.attrs.get("skipped_segments", [])),
    }


def observed_local_cycles(cycle_series: pd.Series) -> tuple[list[int], list[str]]:
    """Return distinct numeric local cycle labels in stable sorted order."""
    return canonical_cycling.observed_cycle_labels(cycle_series)


def build_dense_cycle_map(local_labels: list[int], global_start: int) -> dict[int, int]:
    """Assign each observed local label exactly one dense global cycle."""
    return {local: global_start + index for index, local in enumerate(local_labels)}


def apply_cycle_mapping(
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
            mapped_cycles = source_cycles.map(cycle_map)
            display_only = mapped_cycles.isna()
            # Zero is a display-only curve address in stitched consumers. It
            # is deliberately outside the positive, dense complete-cycle
            # namespace and must never advance that namespace.
            out["cycle"] = mapped_cycles.fillna(0).astype("int64")
            out["display_only_cycle"] = display_only.to_numpy(dtype=bool)
    out["segment"] = segment
    out["source_hash"] = source_hash
    return out


def segment_metadata(
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


def _cp_half_cycle_candidate(frame: pd.DataFrame) -> tuple[int, int] | None:
    """Return the sole local cycle and current direction of an incomplete CP half.

    This deliberately recognizes only a source containing one wholly
    incomplete, single-polarity CP cycle. It does not infer cycle boundaries
    for mixed protocols, OCV, multiple local cycles, or ambiguous current.
    """
    required = {"cycle", "cycle_complete", "measurement_type", "current_ma"}
    if not required.issubset(frame.columns) or frame.empty:
        return None
    kinds = frame["measurement_type"].dropna().astype(str).unique().tolist()
    if kinds != ["biologic_cp"]:
        return None
    if frame["cycle_complete"].fillna(False).astype(bool).any():
        return None
    labels, errors = observed_local_cycles(frame["cycle"])
    if errors or len(labels) != 1:
        return None
    current = pd.to_numeric(frame["current_ma"], errors="coerce")
    if current.isna().any():
        return None
    positive = bool((current > _CP_CURRENT_TOLERANCE_MA).any())
    negative = bool((current < -_CP_CURRENT_TOLERANCE_MA).any())
    if positive == negative:
        return None
    return labels[0], 1 if positive else -1


def _mark_cp_half_complete(frame: pd.DataFrame, local_cycle: int, global_cycle: int) -> None:
    rows = pd.to_numeric(frame["source_cycle"], errors="coerce").eq(local_cycle)
    frame.loc[rows, "cycle"] = global_cycle
    frame.loc[rows, "cycle_complete"] = True
    if "display_only_cycle" in frame.columns:
        frame.loc[rows, "display_only_cycle"] = False


def _set_cp_pair_segment_metadata(
    metadata: dict[str, Any], local_cycle: int, global_cycle: int
) -> None:
    metadata.pop("display_only_source_cycles", None)
    metadata.update(
        {
            "source_cycle_start": local_cycle,
            "source_cycle_end": local_cycle,
            "source_cycle_count": 1,
            "cycle_start": global_cycle,
            "cycle_end": global_cycle,
        }
    )


def _stitch_ordered(
    ordered_sources: list[CachedSourceRef],
    load_fn: Callable[[CachedSourceRef], pd.DataFrame | None],
    *,
    sort_output: bool,
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    frames: list[pd.DataFrame] = []
    segments: list[dict] = []
    missing: list[str] = []
    missing_positions: list[int] = []
    skipped_segments: list[int] = []
    timestamp_starts: list[pd.Timestamp] = []
    observed_cycle_overrides: dict[int, list[int]] = {}
    complete_cycle_overrides: dict[int, list[int]] = {}
    selective_row_groups: set[int] = set()
    selective_rows_read = 0
    global_next = 1
    continuation_blocked = False
    pending_cp_half: tuple[int, int, int, int] | None = None
    paired_cp_cycle_ids: set[int] = set()

    for segment, source_ref in enumerate(ordered_sources):
        file_hash = source_ref.file_hash
        loaded = load_fn(source_ref)
        if loaded is None:
            missing.append(file_hash)
            missing_positions.append(segment)
            continuation_blocked = True
            continue
        if continuation_blocked:
            skipped_segments.append(segment)
            continue

        raw_timestamp_start = loaded.attrs.get("_raw_timestamp_start")
        if raw_timestamp_start is not None:
            parsed_start = pd.to_datetime(raw_timestamp_start, errors="coerce")
            if pd.notna(parsed_start):
                timestamp_starts.append(parsed_start)
        raw_observed_cycles = loaded.attrs.get("_raw_observed_source_cycles")
        if isinstance(raw_observed_cycles, list):
            try:
                observed_cycle_overrides[segment] = [int(value) for value in raw_observed_cycles]
            except (TypeError, ValueError):
                observed_cycle_overrides.pop(segment, None)
        raw_complete_cycles = loaded.attrs.get("_raw_complete_source_cycles")
        if isinstance(raw_complete_cycles, list):
            try:
                complete_cycle_overrides[segment] = [int(value) for value in raw_complete_cycles]
            except (TypeError, ValueError):
                complete_cycle_overrides.pop(segment, None)
        raw_groups = loaded.attrs.get("_raw_step_row_groups")
        if isinstance(raw_groups, tuple):
            selective_row_groups.update(int(value) for value in raw_groups)
        raw_rows_read = loaded.attrs.get("_raw_step_rows_read")
        if isinstance(raw_rows_read, int):
            selective_rows_read += raw_rows_read
        local_labels, errors = (
            (observed_cycle_overrides[segment], [])
            if segment in observed_cycle_overrides
            else observed_local_cycles(loaded["cycle"])
            if "cycle" in loaded.columns
            else ([], [])
        )
        if errors or (len(loaded) > 0 and not local_labels):
            missing.append(file_hash)
            missing_positions.append(segment)
            continuation_blocked = True
            continue

        cp_candidate = _cp_half_cycle_candidate(loaded)
        paired_cp_cycle: int | None = None
        if pending_cp_half is not None:
            pending_frame_index, pending_segment_index, pending_local_cycle, pending_direction = pending_cp_half
            previous_candidate = _cp_half_cycle_candidate(
                frames[pending_frame_index].assign(
                    cycle=frames[pending_frame_index]["source_cycle"]
                )
            )
            if (
                cp_candidate is not None
                and segment == pending_segment_index + 1
                and previous_candidate is not None
                and cp_candidate[1] == -pending_direction
            ):
                paired_cp_cycle = global_next
                paired_cp_cycle_ids.add(paired_cp_cycle)
                _mark_cp_half_complete(
                    frames[pending_frame_index], pending_local_cycle, paired_cp_cycle
                )
                _set_cp_pair_segment_metadata(
                    segments[pending_segment_index], pending_local_cycle, paired_cp_cycle
                )
                pending_cp_half = None
            else:
                # A non-CP source, a gap, or repeated polarity breaks the pair.
                pending_cp_half = None

        if segment in complete_cycle_overrides:
            complete_labels = complete_cycle_overrides[segment]
        elif "cycle_complete" in loaded.columns:
            complete_mask = loaded["cycle_complete"].fillna(False).astype(bool)
            complete_labels, complete_errors = canonical_cycling.observed_cycle_labels(
                loaded.loc[complete_mask, "cycle"]
            )
            if complete_errors:
                missing.append(file_hash)
                missing_positions.append(segment)
                continuation_blocked = True
                continue
        else:
            complete_labels = list(local_labels)
        if paired_cp_cycle is not None and cp_candidate is not None:
            complete_labels = [cp_candidate[0]]
        cycle_map = build_dense_cycle_map(complete_labels, global_next)
        mapped = apply_cycle_mapping(
            loaded,
            segment=segment,
            source_hash=file_hash,
            local_labels=local_labels,
            cycle_map=cycle_map,
        )
        if not sort_output and "record_index" in mapped.columns:
            mapped = mapped.sort_values("record_index", kind="stable").reset_index(drop=True)
        segments.append(
            segment_metadata(
                file_hash=file_hash,
                segment=segment,
                local_labels=complete_labels,
                global_start=global_next,
            )
        )
        if paired_cp_cycle is not None and cp_candidate is not None:
            _mark_cp_half_complete(mapped, cp_candidate[0], paired_cp_cycle)
        display_only_labels = sorted(set(local_labels).difference(complete_labels))
        if display_only_labels:
            segments[-1]["display_only_source_cycles"] = display_only_labels
        if complete_labels:
            global_next += len(complete_labels)
        frames.append(mapped)
        if cp_candidate is not None and paired_cp_cycle is None:
            pending_cp_half = (len(frames) - 1, len(segments) - 1, cp_candidate[0], cp_candidate[1])

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
    if timestamp_starts:
        result.attrs["raw_timestamp_start"] = min(timestamp_starts)
    if selective_row_groups:
        result.attrs["raw_step_row_groups"] = tuple(sorted(selective_row_groups))
        result.attrs["raw_step_rows_read"] = selective_rows_read
    if paired_cp_cycle_ids:
        result.attrs["cross_source_cp_cycle_ids"] = sorted(paired_cp_cycle_ids)
    return result, segments, missing


def stitch_cycles(
    ordered_sources: list[CachedSourceRef], calc_version: str
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    """Stitch per-cycle caches, each source loaded at its own pinned identity."""
    stitched, segments, missing = _stitch_ordered(
        ordered_sources,
        lambda ref: cache.load_cycles(ref.file_hash, ref.parser_version, calc_version),
        sort_output=True,
    )
    has_empty_source_summary = any(
        int(segment.get("source_cycle_count", 0)) == 0 for segment in segments
    )
    if (
        not has_empty_source_summary
        or missing
        or not ordered_sources
        or not _has_adjacent_opposite_cp_halves(ordered_sources)
    ):
        return stitched, segments, missing

    # CP files can each contain one legitimate half-cycle. Their per-source
    # cycle caches are correctly empty; only the ordered Cell chain can prove
    # an adjacent, opposite-polarity pair. Use raw caches only for this
    # otherwise-empty cycle view and keep ordinary cycle rendering on its
    # summary-cache fast path.
    raw, raw_segments, raw_missing = _stitch_ordered(
        ordered_sources,
        lambda ref: cache.load_raw(ref.file_hash, ref.parser_version),
        sort_output=False,
    )
    if (
        raw_missing
        or "cycle" not in raw.columns
        or "segment" not in raw.columns
        or "measurement_type" not in raw.columns
        or "cycle_complete" not in raw.columns
    ):
        return stitched, segments, missing
    from . import calc

    cp_rows = raw["measurement_type"].astype(str).eq("biologic_cp")
    complete_rows = raw["cycle_complete"].fillna(False).astype(bool)
    global_cycles = pd.to_numeric(raw["cycle"], errors="coerce")
    paired_segments = raw.loc[cp_rows & complete_rows].groupby(global_cycles[cp_rows & complete_rows]).agg(
        segments=("segment", "nunique"),
    )
    paired_cycle_ids = set(
        int(cycle)
        for cycle in paired_segments.index[paired_segments["segments"] > 1]
        if pd.notna(cycle) and int(cycle) > 0
    )
    if not paired_cycle_ids:
        return stitched, segments, missing

    paired_rows = raw.loc[cp_rows & complete_rows & global_cycles.isin(paired_cycle_ids)]
    inferred = calc.per_cycle(paired_rows)
    # Per-cycle caches do not know that an adjacent CP pair contributes a
    # global cycle. Reuse their summaries, but re-address source-local cycle
    # labels through the raw stitch mapping before combining them with the
    # inferred CP summaries. Otherwise a CP pair before another source can
    # leave that source's cached cycle at 1, colliding with the CP cycle.
    cached_cycles = stitched.copy()
    mapping_columns = {"segment", "source_cycle", "cycle"}
    if mapping_columns.issubset(cached_cycles.columns):
        complete_raw = raw.loc[
            global_cycles.gt(0),
            ["segment", "source_cycle", "cycle"],
        ]
        complete_raw = complete_raw.drop_duplicates(["segment", "source_cycle"])
        source_cycle_map = {
            (int(row.segment), int(row.source_cycle)): int(row.cycle)
            for row in complete_raw.itertuples(index=False)
            if pd.notna(row.segment) and pd.notna(row.source_cycle) and pd.notna(row.cycle)
        }
        cached_cycles["cycle"] = [
            source_cycle_map.get(
                (int(segment), int(source_cycle)), cycle
            )
            if pd.notna(segment) and pd.notna(source_cycle)
            else cycle
            for segment, source_cycle, cycle in zip(
                cached_cycles["segment"],
                cached_cycles["source_cycle"],
                cached_cycles["cycle"],
            )
        ]
    combined = pd.concat([cached_cycles, inferred], ignore_index=True, sort=False)
    if "cycle" in combined.columns:
        combined = combined.sort_values("cycle", kind="stable").reset_index(drop=True)
    combined.attrs.update(raw.attrs)
    return combined, raw_segments, raw_missing


def stitch_raw(
    ordered_sources: list[CachedSourceRef],
) -> tuple[pd.DataFrame, list[dict], list[str]]:
    """Stitch raw caches, each source loaded at its own pinned identity."""
    return _stitch_ordered(
        ordered_sources,
        lambda ref: cache.load_raw(ref.file_hash, ref.parser_version),
        sort_output=False,
    )


def stitch_raw_steps(
    ordered_sources: list[CachedSourceRef],
    step_indices_by_hash: dict[str, set[int]],
    columns: list[str],
) -> tuple[pd.DataFrame, list[dict], list[str]] | None:
    """Read selected raw step rows, or return ``None`` for safe fallback."""

    def load(ref: CachedSourceRef) -> pd.DataFrame | None:
        loaded = cache.load_raw_step_rows(
            ref.file_hash,
            ref.parser_version,
            step_indices_by_hash.get(ref.file_hash, set()),
            columns,
        )
        if loaded is None:
            raise RuntimeError("selective raw step access unavailable")
        return loaded

    try:
        return _stitch_ordered(ordered_sources, load, sort_output=False)
    except RuntimeError as exc:
        if str(exc) != "selective raw step access unavailable":
            raise
        return None
