"""Indexed raw-data planning for the Time/Capacity analysis path.

This module owns the physical-access part of Spec 050.3.  It deliberately
does not own any scientific transformation: once the selected rows have been
mapped, ``analysis_engine`` feeds them through the existing time, phase,
capacity, derivative, protocol and display helpers.

The plan is built from the bounded 050.2 raw-layout indexes.  A valid raw
cache without a usable index remains a valid scientific cache and is reported
as a legacy fallback, while an absent raw cache produces a fail-closed plan.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
import math
from time import perf_counter
from typing import Any

import pandas as pd

from . import cache, canonical_cycling, stitch


# The scientific consumers below compute phase, capacity, protocol masks and
# provenance from these fields.  Keep this projection explicit: adding a raw
# column here is a measured consumer decision, not a convenience read.
TIME_CAPACITY_REQUIRED_COLUMNS: tuple[str, ...] = canonical_cycling.REQUIRED_CYCLING_COLUMNS
TIME_CAPACITY_OPTIONAL_COLUMNS: tuple[str, ...] = (
    "working_potential_v",
    "counter_potential_v",
)


@dataclass(frozen=True)
class IndexedSourcePlan:
    """One successfully indexed source in the ordered Cell chain."""

    ref: stitch.CachedSourceRef
    segment: int
    index: dict[str, Any]
    observed_source_cycles: tuple[int, ...]
    cycle_map: dict[int, int]
    segment_metadata: dict[str, Any]

    @property
    def timestamp_bounds(self) -> dict[str, str | None]:
        return {
            "timestamp_start": self.index.get("timestamp_start"),
            "timestamp_end": self.index.get("timestamp_end"),
        }

    @property
    def voltage_data_availability(self) -> dict[str, bool]:
        value = self.index.get("voltage_data_availability")
        return value if isinstance(value, dict) else {}


@dataclass
class TimeCapacityStitchPlan:
    """The lightweight source-chain plan used before selected raw I/O."""

    refs: tuple[stitch.CachedSourceRef, ...]
    path: str
    sources: tuple[IndexedSourcePlan, ...]
    segments: list[dict[str, Any]]
    source_facts: dict[str, dict[str, Any]]
    missing: list[str]
    missing_positions: list[int]
    skipped_segments: list[int]
    fallback_reason: str | None = None

    @property
    def complete(self) -> bool:
        return not self.missing_positions


def time_capacity_raw_columns(available_columns: Iterable[str]) -> list[str]:
    """Return the exact raw projection needed by Time/Capacity consumers.

    Auxiliary electrode-potential columns are requested only when the source
    schema contains them.  ``timestamp`` is intentionally absent: indexed
    timestamp bounds serve source descriptors, and no selected-row scientific
    helper consumes the raw timestamp column.
    """

    available = set(available_columns)
    columns = [column for column in TIME_CAPACITY_REQUIRED_COLUMNS if column in available]
    columns.extend(
        column
        for column in TIME_CAPACITY_OPTIONAL_COLUMNS
        if column in available and column not in columns
    )
    return columns


def time_capacity_request_columns(
    available_columns: Iterable[str],
    settings: dict[str, Any],
    *,
    precision: str,
    compact: bool,
    protocol_active: bool = False,
) -> list[str]:
    """Return the raw projection consumed by one interactive request.

    The historical projection is intentionally retained for full-detail and
    non-compact responses.  Standard compact requests use a smaller explicit
    projection: ordinary Time/Voltage/Current does not consume either raw
    capacity column, and capacity-axis/derivative requests add those columns
    only when their scientific/display transform needs them.  Protocol masks
    add the step-index column.  Source capability facts and descriptors come
    from the indexed source metadata, so auxiliary electrode-potential columns
    are not needed unless the selected voltage channel uses one.
    """

    available = set(available_columns)
    if precision == "full" or not compact:
        return time_capacity_raw_columns(available)

    requested = [
        "record_index",
        "cycle",
        "status",
        "time_s",
        "current_ma",
    ]
    if protocol_active:
        requested.append("step_index" if "step_index" in available else "Step_Index")

    normal_view = settings.get("view") == "voltage_current"
    x_axis = settings.get("x_axis")
    if normal_view:
        voltage_quantity = settings.get("voltage_channel") or canonical_cycling.DEFAULT_VOLTAGE_QUANTITY
        requested.append(
            canonical_cycling.VOLTAGE_QUANTITIES.get(
                voltage_quantity,
                canonical_cycling.VOLTAGE_QUANTITIES[canonical_cycling.DEFAULT_VOLTAGE_QUANTITY],
            )
        )
        needs_capacity = x_axis in {
            "capacity_mah",
            "capacity_mah_g",
            "capacity_mah_cm2",
        }
    else:
        requested.append("voltage_v")
        needs_capacity = True

    if needs_capacity:
        requested.extend(("charge_capacity_mah", "discharge_capacity_mah"))
    return [
        column for column in time_capacity_raw_columns(available) if column in requested
    ]


def _set_diagnostic(diagnostics: dict[str, Any] | None, **values: Any) -> None:
    if diagnostics is not None:
        diagnostics.update(values)


def _fallback_plan(
    refs: tuple[stitch.CachedSourceRef, ...],
    *,
    indexed_sources: Sequence[IndexedSourcePlan],
    reason: str,
    diagnostics: dict[str, Any] | None,
) -> TimeCapacityStitchPlan:
    _set_diagnostic(
        diagnostics,
        path="legacy",
        fallback_reason=reason,
        indexed_source_count=len(indexed_sources),
    )
    return TimeCapacityStitchPlan(
        refs=refs,
        path="legacy",
        sources=tuple(indexed_sources),
        segments=[source.segment_metadata for source in indexed_sources],
        source_facts={
            source.ref.file_hash: {
                **source.timestamp_bounds,
                "voltage_data_availability": source.voltage_data_availability,
            }
            for source in indexed_sources
        },
        missing=[],
        missing_positions=[],
        skipped_segments=[],
        fallback_reason=reason,
    )


def build_time_capacity_stitch_plan(
    refs: Sequence[stitch.CachedSourceRef],
    *,
    diagnostics: dict[str, Any] | None = None,
) -> TimeCapacityStitchPlan:
    """Build a dense global-cycle plan without loading raw records.

    The first valid raw cache that lacks a current 050.2 index selects the
    whole-Cell legacy path.  A genuinely absent raw cache instead records the
    same missing position and skipped suffix semantics as ``stitch_raw``.
    """

    ordered_refs = tuple(refs)
    _set_diagnostic(
        diagnostics,
        source_count=len(ordered_refs),
        path="indexed",
        row_groups_read=0,
        row_groups_total=0,
        raw_rows_materialized=0,
        selected_rows=0,
        source_reads=[],
    )
    sources: list[IndexedSourcePlan] = []
    segments: list[dict[str, Any]] = []
    source_facts: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    missing_positions: list[int] = []
    skipped_segments: list[int] = []
    continuation_blocked = False
    global_next = 1

    for segment, ref in enumerate(ordered_refs):
        if continuation_blocked:
            skipped_segments.append(segment)
            continue

        # A plot request must not wait for an in-flight 050.2 conversion.  The
        # probe validates the raw/index pair only when the consistency boundary
        # is immediately available; a busy boundary takes the legacy path.
        with timed_stage(diagnostics, "raw_index_plan_validation"):
            index = cache.try_load_raw_layout_index(ref.file_hash, ref.parser_version)
        if index is None:
            if not cache.raw_path(ref.file_hash, ref.parser_version).is_file():
                missing.append(ref.file_hash)
                missing_positions.append(segment)
                continuation_blocked = True
                continue
            return _fallback_plan(
                ordered_refs,
                indexed_sources=sources,
                reason="raw_layout_unavailable",
                diagnostics=diagnostics,
            )

        available_columns = set(index.get("raw_column_names") or [])
        if not set(TIME_CAPACITY_REQUIRED_COLUMNS).issubset(available_columns):
            return _fallback_plan(
                ordered_refs,
                indexed_sources=sources,
                reason="required_columns_unavailable",
                diagnostics=diagnostics,
            )

        labels = tuple(int(value) for value in index.get("observed_source_cycles", ()))
        cycle_map = stitch.build_dense_cycle_map(labels, global_next)
        metadata = stitch.segment_metadata(
            file_hash=ref.file_hash,
            segment=segment,
            local_labels=list(labels),
            global_start=global_next,
        )
        source = IndexedSourcePlan(
            ref=ref,
            segment=segment,
            index=index,
            observed_source_cycles=labels,
            cycle_map=cycle_map,
            segment_metadata=metadata,
        )
        sources.append(source)
        segments.append(metadata)
        source_facts[ref.file_hash] = {
            **source.timestamp_bounds,
            "voltage_data_availability": source.voltage_data_availability,
        }
        if labels:
            global_next += len(labels)

    path = "missing" if missing_positions else "indexed"
    _set_diagnostic(
        diagnostics,
        path=path,
        missing_positions=list(missing_positions),
        skipped_segments=list(skipped_segments),
        indexed_source_count=len(sources),
        row_groups_total=sum(
            int(source.index.get("raw_row_group_count", 0)) for source in sources
        ),
    )
    return TimeCapacityStitchPlan(
        refs=ordered_refs,
        path=path,
        sources=tuple(sources),
        segments=segments,
        source_facts=source_facts,
        missing=missing,
        missing_positions=missing_positions,
        skipped_segments=skipped_segments,
    )


def requested_global_cycles(
    plan: TimeCapacityStitchPlan,
    *,
    explicit_cycles: Iterable[object],
    cycle_start: object,
    cycle_end: object,
) -> tuple[int, ...]:
    """Resolve Time/Capacity cycle settings against the dense plan."""

    if explicit_cycles:
        values: set[int] = set()
        for value in explicit_cycles:
            try:
                values.add(int(value))
            except (TypeError, ValueError):
                continue
        return tuple(sorted(values))

    known = tuple(
        int(global_cycle)
        for source in plan.sources
        for global_cycle in source.cycle_map.values()
    )
    if not known:
        return ()
    known_lower = min(known)
    known_upper = max(known)
    lower = known_lower if cycle_start is None else int(cycle_start)
    upper = known_upper if cycle_end is None else int(cycle_end)
    # Clamp before materializing the range.  Saved/direct requests can carry
    # stale or adversarially large endpoints, but the valid dense cycle plan is
    # always bounded by the indexed source chain.
    lower = max(lower, known_lower)
    upper = min(upper, known_upper)
    if upper < lower:
        return ()
    return tuple(range(lower, upper + 1))


def consecutive_time_cycle_facts(
    plan: TimeCapacityStitchPlan,
) -> dict[int, tuple[float, float]]:
    """Return global cycle coordinates and raw starts from indexed facts.

    The first tuple value is the canonical cumulative Time at the first row
    of the global cycle; the second is that cycle's source-local raw Time.
    This is owner-side metadata only, so a refinement can compute its prefix
    offset without loading preceding cycle rows.
    """

    if plan.path != "indexed" or not plan.complete:
        return {}

    facts: dict[int, tuple[float, float]] = {}
    running_reset_offset = 0.0
    previous_last_raw: float | None = None
    for source in plan.sources:
        metadata = source.index.get("consecutive_time")
        if not isinstance(metadata, dict):
            return {}
        first_raw = metadata.get("first_raw_time_s")
        last_raw = metadata.get("last_raw_time_s")
        reset_total = metadata.get("reset_total_s")
        starts = metadata.get("cycle_starts")
        if (
            not isinstance(first_raw, (int, float))
            or isinstance(first_raw, bool)
            or not math.isfinite(float(first_raw))
            or not isinstance(last_raw, (int, float))
            or isinstance(last_raw, bool)
            or not math.isfinite(float(last_raw))
            or not isinstance(reset_total, (int, float))
            or isinstance(reset_total, bool)
            or not math.isfinite(float(reset_total))
            or not isinstance(starts, dict)
        ):
            return {}

        if previous_last_raw is not None and float(first_raw) < previous_last_raw:
            running_reset_offset += previous_last_raw

        for local_cycle, global_cycle in source.cycle_map.items():
            start = starts.get(str(local_cycle))
            if not isinstance(start, dict):
                return {}
            raw_time = start.get("raw_time_s")
            reset_offset = start.get("reset_offset_s")
            if (
                not isinstance(raw_time, (int, float))
                or isinstance(raw_time, bool)
                or not math.isfinite(float(raw_time))
                or not isinstance(reset_offset, (int, float))
                or isinstance(reset_offset, bool)
                or not math.isfinite(float(reset_offset))
            ):
                return {}
            facts[int(global_cycle)] = (
                float(raw_time) + running_reset_offset + float(reset_offset),
                float(raw_time),
            )

        running_reset_offset += float(reset_total)
        previous_last_raw = float(last_raw)
    return facts


def consecutive_time_request_facts(
    plan: TimeCapacityStitchPlan,
    requested_cycles: Iterable[int],
    origin_cycle: int | None,
) -> tuple[float, float] | None:
    """Resolve the bounded-read prefix and canonical origin for a refinement."""

    requested = tuple(sorted({int(value) for value in requested_cycles}))
    if not requested or origin_cycle is None:
        return None
    facts = consecutive_time_cycle_facts(plan)
    candidate = facts.get(requested[0])
    origin = facts.get(int(origin_cycle))
    if candidate is None or origin is None:
        return None
    candidate_coordinate, candidate_raw_time = candidate
    origin_coordinate, _origin_raw_time = origin
    return candidate_coordinate - candidate_raw_time, origin_coordinate


def _empty_raw_frame(
    plan: TimeCapacityStitchPlan,
    requested_columns: Iterable[str] | None = None,
) -> pd.DataFrame:
    projected_columns = tuple(requested_columns) if requested_columns is not None else None
    columns: list[str] = []
    for source in plan.sources:
        available = source.index.get("raw_column_names", ())
        projected = (
            time_capacity_raw_columns(available)
            if projected_columns is None
            else [column for column in projected_columns if column in set(available)]
        )
        for column in projected:
            if column not in columns:
                columns.append(column)
    for column in ("source_cycle", "segment", "source_hash"):
        if column not in columns:
            columns.append(column)
    frame = pd.DataFrame({column: pd.Series(dtype="object") for column in columns})
    frame.attrs["stitch_complete"] = plan.complete
    frame.attrs["missing_positions"] = list(plan.missing_positions)
    frame.attrs["skipped_segments"] = list(plan.skipped_segments)
    frame.attrs["time_capacity_access_path"] = plan.path
    return frame


def load_indexed_time_capacity_raw(
    plan: TimeCapacityStitchPlan,
    requested_cycles: Iterable[int],
    *,
    requested_columns: Iterable[str] | None = None,
    diagnostics: dict[str, Any] | None = None,
    wait_for_layout: bool = False,
) -> pd.DataFrame | None:
    """Read and stitch only indexed source-local cycles for a request.

    ``None`` signals that the indexed read became unavailable after planning;
    the caller must use the existing full-read fallback to preserve safety.
    """

    projected_columns = tuple(requested_columns) if requested_columns is not None else None
    if plan.path != "indexed":
        if plan.path == "missing":
            return _empty_raw_frame(plan, projected_columns)
        return None

    requested = set(int(value) for value in requested_cycles)
    if not requested:
        result = _empty_raw_frame(plan, projected_columns)
        result.attrs["stitch_complete"] = True
        _set_diagnostic(diagnostics, selected_rows=0, raw_rows_materialized=0)
        return result

    frames: list[pd.DataFrame] = []
    aggregate_groups: set[tuple[str, int]] = set()
    materialized_rows = 0
    selected_rows = 0
    source_reads: list[dict[str, Any]] = []
    projection_union: list[str] = []

    for source in plan.sources:
        local_cycles = tuple(
            local_cycle
            for local_cycle in source.observed_source_cycles
            if source.cycle_map.get(local_cycle) in requested
        )
        available = source.index.get("raw_column_names", ())
        columns = (
            time_capacity_raw_columns(available)
            if projected_columns is None
            else [column for column in projected_columns if column in set(available)]
        )
        for column in columns:
            if column not in projection_union:
                projection_union.append(column)
        if not local_cycles:
            continue

        read_diagnostics = cache.RawCycleReadDiagnostics()
        with timed_stage(diagnostics, "row_group_io"):
            loaded = cache.load_raw_cycles(
                source.ref.file_hash,
                source.ref.parser_version,
                local_cycles,
                columns,
                diagnostics=read_diagnostics,
                wait_for_layout=wait_for_layout,
            )
        if loaded is None:
            _set_diagnostic(
                diagnostics,
                path="legacy",
                fallback_reason="indexed_read_unavailable",
                source_reads=source_reads,
            )
            return None

        raw_read_stages = read_diagnostics.stages_ms
        if diagnostics is not None and raw_read_stages:
            aggregate = diagnostics.setdefault("raw_read_stages_ms", {})
            for name, elapsed in raw_read_stages.items():
                aggregate[name] = aggregate.get(name, 0.0) + float(elapsed)

        with timed_stage(diagnostics, "exact_cycle_filter_global_mapping_concatenation"):
            if "record_index" in loaded.columns:
                with timed_stage(diagnostics, "raw_record_index_sort"):
                    loaded = loaded.sort_values("record_index", kind="stable").reset_index(drop=True)
            with timed_stage(diagnostics, "raw_cycle_mapping"):
                mapped = stitch.apply_cycle_mapping(
                    loaded,
                    segment=source.segment,
                    source_hash=source.ref.file_hash,
                    local_labels=list(source.observed_source_cycles),
                    cycle_map=source.cycle_map,
                )
        frames.append(mapped)
        selected_rows += len(mapped)
        materialized_rows += int(read_diagnostics.rows_read)
        aggregate_groups.update(
            (source.ref.file_hash, int(group)) for group in read_diagnostics.row_groups_read
        )
        source_reads.append(
            {
                "source_hash": source.ref.file_hash,
                "segment": source.segment,
                "requested_source_cycles": list(local_cycles),
                "row_groups_read": list(read_diagnostics.row_groups_read),
                "row_groups_total": read_diagnostics.row_groups_total,
                "rows_materialized": read_diagnostics.rows_read,
                "rows_selected": read_diagnostics.rows_returned,
                "columns_read": list(read_diagnostics.columns_read),
            }
        )

    with timed_stage(diagnostics, "exact_cycle_filter_global_mapping_concatenation"):
        if frames:
            with timed_stage(diagnostics, "raw_frame_concat"):
                result = pd.concat(frames, ignore_index=True)
            for column in projection_union:
                if column not in result.columns:
                    result[column] = pd.Series([float("nan")] * len(result), index=result.index)
        else:
            result = _empty_raw_frame(plan)

    result.attrs["stitch_complete"] = True
    result.attrs["missing_positions"] = []
    result.attrs["skipped_segments"] = []
    result.attrs["time_capacity_access_path"] = "indexed"
    _set_diagnostic(
        diagnostics,
        path="indexed",
        row_groups_read=len(aggregate_groups),
        raw_rows_materialized=materialized_rows,
        selected_rows=selected_rows,
        source_reads=source_reads,
    )
    return result


def load_indexed_time_capacity_derived(
    plan: TimeCapacityStitchPlan,
    requested_cycles: Iterable[int],
    columns: Iterable[str],
    *,
    diagnostics: dict[str, Any] | None = None,
    wait_for_layout: bool = False,
) -> pd.DataFrame | None:
    """Read exact prepared values for every contributing source.

    ``None`` is deliberately all-or-nothing: one missing, busy or invalid
    source sidecar makes the caller use the existing request-side scientific
    transforms for the whole resolved Cell.
    """

    if plan.path != "indexed":
        return None

    requested = set(int(value) for value in requested_cycles)
    requested_columns = list(dict.fromkeys(columns))
    frames: list[pd.DataFrame] = []
    source_reads: list[dict[str, Any]] = []
    row_groups_read = 0
    rows_materialized = 0

    for source in plan.sources:
        local_cycles = tuple(
            local_cycle
            for local_cycle in source.observed_source_cycles
            if source.cycle_map.get(local_cycle) in requested
        )
        if not local_cycles:
            continue
        read_diagnostics = cache.TimeCapacityDerivedReadDiagnostics()
        loaded = cache.load_time_capacity_derived(
            source.ref.file_hash,
            source.ref.parser_version,
            local_cycles,
            requested_columns,
            diagnostics=read_diagnostics,
            wait_for_layout=wait_for_layout,
        )
        source_reads.append(
            {
                "segment": source.segment,
                "requested_source_cycles": list(local_cycles),
                "row_groups_read": list(read_diagnostics.row_groups_read),
                "row_groups_total": read_diagnostics.row_groups_total,
                "rows_materialized": read_diagnostics.rows_read,
                "rows_selected": read_diagnostics.rows_returned,
                "columns_read": list(read_diagnostics.columns_read),
                "status": read_diagnostics.status,
            }
        )
        if loaded is None:
            _set_diagnostic(
                diagnostics,
                derived_access="fallback",
                derived_source_reads=source_reads,
                prepared_row_groups_read=row_groups_read,
                prepared_rows_materialized=rows_materialized,
            )
            return None
        with timed_stage(diagnostics, "prepared_derived_mapping"):
            if "record_index" in loaded.columns:
                loaded = loaded.sort_values("record_index", kind="stable").reset_index(drop=True)
            mapped = stitch.apply_cycle_mapping(
                loaded,
                segment=source.segment,
                source_hash=source.ref.file_hash,
                local_labels=list(source.observed_source_cycles),
                cycle_map=source.cycle_map,
            )
        frames.append(mapped)
        row_groups_read += len(set(read_diagnostics.row_groups_read))
        rows_materialized += int(read_diagnostics.rows_read)

    if frames:
        with timed_stage(diagnostics, "prepared_derived_mapping"):
            result = pd.concat(frames, ignore_index=True)
    else:
        result = pd.DataFrame(
            columns=["record_index", "cycle", *requested_columns, "source_cycle", "segment", "source_hash"]
        )
    _set_diagnostic(
        diagnostics,
        derived_access="prepared",
        prepared_row_groups_read=row_groups_read,
        prepared_rows_materialized=rows_materialized,
        derived_source_reads=source_reads,
    )
    return result


@contextmanager
def timed_stage(diagnostics: dict[str, Any] | None, name: str):
    """Accumulate optional per-Cell stage timings without production logging."""

    if diagnostics is None:
        yield
        return
    started = perf_counter()
    try:
        yield
    finally:
        stages = diagnostics.setdefault("stages", {})
        stages[name] = stages.get(name, 0.0) + (perf_counter() - started)


def timed_call(
    diagnostics: dict[str, Any] | None,
    name: str,
    function,
    *args,
    **kwargs,
):
    """Call one existing scientific helper while optionally timing it."""

    with timed_stage(diagnostics, name):
        return function(*args, **kwargs)
