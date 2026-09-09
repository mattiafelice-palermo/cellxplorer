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

from collections import OrderedDict
from collections.abc import Iterable, Sequence
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
import math
import sys
import threading
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
    _planning_facts: _SourcePlanningFacts | None = None

    @property
    def complete(self) -> bool:
        return not self.missing_positions


class _FrozenDict(dict):
    """Read-only JSON mapping that still supports dict consumers and pickle.

    A deliberate deepcopy produces an independent editable snapshot, as existing
    diagnostic/test callers expect. Ordinary plans share only frozen contents.
    """

    def _immutable(self, *args, **kwargs):
        raise TypeError("source planning facts are immutable")

    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _immutable

    def __reduce__(self):
        return (_FrozenDict, (dict(self),))

    def __deepcopy__(self, memo):
        return deepcopy(dict(self), memo)


def _freeze(value):
    if isinstance(value, dict):
        return _FrozenDict((key, _freeze(item)) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


@dataclass(frozen=True)
class _SourcePlanningFacts:
    source: IndexedSourcePlan
    time_facts: _FrozenDict
    bounds: tuple[int, int] | None


@dataclass(frozen=True)
class _PlanningMemoEntry:
    # Retain the validated object, not just id(index): object IDs can be reused.
    validated_index: dict[str, Any]
    facts: _SourcePlanningFacts
    size: int


_SOURCE_PLAN_MEMO_MAX_ENTRIES = 64
_SOURCE_PLAN_MEMO_MAX_BYTES = 8 * 1024 * 1024
_source_plan_memo: OrderedDict[tuple, _PlanningMemoEntry] = OrderedDict()
_source_plan_memo_lock = threading.RLock()


def clear_source_plan_memo() -> None:
    with _source_plan_memo_lock:
        _source_plan_memo.clear()


def source_plan_memo_stats() -> dict[str, int]:
    with _source_plan_memo_lock:
        return {"entries": len(_source_plan_memo),
                "bytes": sum(entry.size for entry in _source_plan_memo.values())}


def _retained_size(value, limit: int) -> int:
    """Bound retained Python containers, including the original index snapshot."""
    pending = [value]
    seen = set()
    size = 0
    while pending:
        item = pending.pop()
        if id(item) in seen:
            continue
        seen.add(id(item))
        size += sys.getsizeof(item)
        if size > limit:
            return size
        if isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, (tuple, list)):
            pending.extend(item)
        elif isinstance(item, (_SourcePlanningFacts, IndexedSourcePlan, stitch.CachedSourceRef)):
            pending.append(vars(item))
    return size


def _memo_facts(plan: TimeCapacityStitchPlan) -> _SourcePlanningFacts | None:
    facts = plan._planning_facts
    if (facts is not None and plan.path == "indexed" and plan.complete
            and len(plan.sources) == 1 and plan.sources[0] is facts.source
            and plan.refs == (facts.source.ref,)
            and isinstance(facts.source.index, _FrozenDict)
            and isinstance(facts.source.cycle_map, _FrozenDict)):
        return facts
    return None


def _source_plan_from_facts(facts: _SourcePlanningFacts) -> TimeCapacityStitchPlan:
    source = facts.source
    # The envelope and user-facing metadata containers remain request-owned.
    return TimeCapacityStitchPlan(
        refs=(source.ref,), path="indexed", sources=(source,),
        segments=[deepcopy(source.segment_metadata)],
        source_facts={source.ref.file_hash: {
            **source.timestamp_bounds,
            "voltage_data_availability": dict(source.voltage_data_availability),
        }}, missing=[], missing_positions=[], skipped_segments=[],
        _planning_facts=facts,
    )


def _remember_source_plan(key: tuple, index: dict, plan: TimeCapacityStitchPlan) -> TimeCapacityStitchPlan:
    if (_SOURCE_PLAN_MEMO_MAX_ENTRIES < 1
            or _retained_size(index, _SOURCE_PLAN_MEMO_MAX_BYTES) > _SOURCE_PLAN_MEMO_MAX_BYTES):
        return plan
    original = plan.sources[0]
    source = IndexedSourcePlan(
        ref=original.ref, segment=0, index=_freeze(index),
        observed_source_cycles=original.observed_source_cycles,
        cycle_map=_freeze(original.cycle_map), segment_metadata=_freeze(original.segment_metadata),
    )
    bounds = (1, len(source.cycle_map)) if source.cycle_map else None
    facts = _SourcePlanningFacts(source, _freeze(consecutive_time_cycle_facts(plan)), bounds)
    size = _retained_size((key, index, facts), _SOURCE_PLAN_MEMO_MAX_BYTES)
    if size > _SOURCE_PLAN_MEMO_MAX_BYTES:
        return plan
    with _source_plan_memo_lock:
        _source_plan_memo.pop(key, None)
        while _source_plan_memo and (
            len(_source_plan_memo) >= _SOURCE_PLAN_MEMO_MAX_ENTRIES
            or sum(entry.size for entry in _source_plan_memo.values()) + size > _SOURCE_PLAN_MEMO_MAX_BYTES
        ):
            _source_plan_memo.popitem(last=False)
        _source_plan_memo[key] = _PlanningMemoEntry(index, facts, size)
    return _source_plan_from_facts(facts)


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
    are needed only when the selected voltage/current view includes them.
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
        configured_channels = settings.get("voltage_channels")
        voltage_quantities = (
            configured_channels
            if isinstance(configured_channels, list)
            else [settings.get("voltage_channel") or canonical_cycling.DEFAULT_VOLTAGE_QUANTITY]
        )
        requested.extend(
            canonical_cycling.VOLTAGE_QUANTITIES[quantity]
            for quantity in voltage_quantities
            if quantity in canonical_cycling.VOLTAGE_QUANTITIES
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
    memo_key = (
        str(cache.CACHE_DIR), ordered_refs[0].file_hash, ordered_refs[0].parser_version,
        cache.RAW_CACHE_LAYOUT_VERSION, cache.CALC_VERSION,
    ) if len(ordered_refs) == 1 else None
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
        if memo_key is not None:
            # Never bypass the current nonblocking consistency probe, even on a
            # hit. The cache loader returns the same object only for a validated
            # unchanged raw/index pair; replacement/clear produces a new object.
            with _source_plan_memo_lock:
                entry = _source_plan_memo.get(memo_key)
                if entry is not None and index is entry.validated_index:
                    _source_plan_memo.move_to_end(memo_key)
                    _set_diagnostic(
                        diagnostics, missing_positions=[], skipped_segments=[],
                        indexed_source_count=1,
                        row_groups_total=int(index.get("raw_row_group_count", 0)),
                    )
                    return _source_plan_from_facts(entry.facts)
                _source_plan_memo.pop(memo_key, None)
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
    plan = TimeCapacityStitchPlan(
        refs=ordered_refs,
        path=path,
        sources=tuple(sources),
        segments=segments,
        source_facts=source_facts,
        missing=missing,
        missing_positions=missing_positions,
        skipped_segments=skipped_segments,
    )
    if memo_key is not None and path == "indexed" and plan.complete:
        return _remember_source_plan(memo_key, sources[0].index, plan)
    return plan


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

    facts = _memo_facts(plan)
    if facts is not None:
        if facts.bounds is None:
            return ()
        known_lower, known_upper = facts.bounds
    else:
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

    memo = _memo_facts(plan)
    if memo is not None:
        return dict(memo.time_facts)

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
