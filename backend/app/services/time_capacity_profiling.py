"""Opt-in, aggregate diagnostics for the live Time/Capacity request.

The scientific result remains the source of truth.  This module projects the
existing 050.3 per-Cell diagnostics into a small profiling record without
including source paths, hashes, raw rows, full specs, or other private data.
"""
from __future__ import annotations

from collections.abc import Mapping
from math import isfinite
from typing import Any


def _numeric_sum(cells: list[Mapping[str, Any]], key: str) -> int | None:
    values: list[int] = []
    for cell in cells:
        value = cell.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            values.append(value)
        elif isinstance(value, float) and isfinite(value):
            values.append(int(value))
    return sum(values) if values else None


def _row_group_total(cells: list[Mapping[str, Any]], key: str) -> int | str | None:
    values = [cell.get(key) for cell in cells]
    if any(value == "full" for value in values):
        return "full"
    numeric = [
        int(value)
        for value in values
        if isinstance(value, (int, float))
        and not isinstance(value, bool)
        and isfinite(float(value))
    ]
    return sum(numeric) if numeric else None


def _raw_access(cells: list[Mapping[str, Any]], result_cache: str) -> str:
    if result_cache == "hit":
        return "not_applicable"
    paths = {
        str(cell.get("path"))
        for cell in cells
        if cell.get("path") in {"indexed", "legacy"}
    }
    if paths == {"indexed"}:
        return "indexed"
    if paths == {"legacy"}:
        return "legacy"
    if paths == {"indexed", "legacy"}:
        return "mixed"
    return "unknown"


def _categorical_value(cells: list[Mapping[str, Any]], key: str) -> str | None:
    values = {
        str(cell.get(key))
        for cell in cells
        if isinstance(cell.get(key), str) and cell.get(key)
    }
    if not values:
        return None
    return next(iter(values)) if len(values) == 1 else "mixed"


def _stage_totals_ms(cells: list[Mapping[str, Any]]) -> dict[str, float] | None:
    totals: dict[str, float] = {}
    for cell in cells:
        stages = cell.get("stages")
        if not isinstance(stages, Mapping):
            continue
        for name, value in stages.items():
            if not isinstance(name, str):
                continue
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            if not isfinite(float(value)):
                continue
            totals[name] = totals.get(name, 0.0) + float(value) * 1000.0
    return totals or None


def _transform_stage_profiles(cells: list[Mapping[str, Any]]) -> dict[str, dict[str, Any]] | None:
    """Aggregate profiler-only transform rows and downstream consumers."""

    profiles: dict[str, dict[str, Any]] = {}
    for cell in cells:
        transform_profile = cell.get("transform_profile")
        stages = cell.get("stages")
        if not isinstance(transform_profile, Mapping):
            continue
        for name, details in transform_profile.items():
            if not isinstance(name, str) or not isinstance(details, Mapping):
                continue
            if not isinstance(stages, Mapping):
                continue
            elapsed = stages.get(f"transform_{name}")
            if not isinstance(elapsed, (int, float)) or isinstance(elapsed, bool) or not isfinite(float(elapsed)):
                continue
            item = profiles.setdefault(
                name,
                {
                    "elapsed_ms": 0.0,
                    "input_rows": 0,
                    "output_rows": 0,
                    "cells": 0,
                    "consumed_by": set(),
                },
            )
            item["elapsed_ms"] += float(elapsed) * 1000.0
            input_rows = details.get("input_rows")
            if isinstance(input_rows, int) and not isinstance(input_rows, bool):
                item["input_rows"] += input_rows
            output_rows = details.get("output_rows")
            if isinstance(output_rows, int) and not isinstance(output_rows, bool):
                item["output_rows"] += output_rows
            item["cells"] += 1
            consumers = details.get("consumed_by")
            if isinstance(consumers, list):
                item["consumed_by"].update(value for value in consumers if isinstance(value, str))
    if not profiles:
        return None
    for item in profiles.values():
        item["consumed_by"] = sorted(item["consumed_by"])
    return profiles


def _derivative_profile(cells: list[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Aggregate safe derivative counts while keeping raw data out of the payload."""

    totals = {
        "cells": 0,
        "input_rows": 0,
        "segments_processed": 0,
        "eligible_segments": 0,
        "finite_input_rows": 0,
        "output_finite_rows": 0,
        "output_segments": 0,
        "phase_rows": {"charge": 0, "discharge": 0, "rest": 0},
        "stages_ms": {},
    }
    found = False
    for cell in cells:
        profile = cell.get("derivative_profile")
        if not isinstance(profile, Mapping):
            continue
        found = True
        totals["cells"] += 1
        for key in (
            "input_rows",
            "segments_processed",
            "eligible_segments",
            "finite_input_rows",
            "output_finite_rows",
            "output_segments",
        ):
            value = profile.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                totals[key] += value
        phase_rows = profile.get("phase_rows")
        if isinstance(phase_rows, Mapping):
            for phase in totals["phase_rows"]:
                value = phase_rows.get(phase)
                if isinstance(value, int) and not isinstance(value, bool):
                    totals["phase_rows"][phase] += value
        stages = cell.get("stages")
        if isinstance(stages, Mapping):
            for name in (
                "derivative_status_classification",
                "derivative_segment_scan",
                "derivative_segment_prepare",
                "derivative_rolling",
                "derivative_gradient",
                "derivative_ratio_filter",
                "derivative_postprocess",
            ):
                value = stages.get(name)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(float(value)):
                    totals["stages_ms"][name.removeprefix("derivative_")] = (
                        totals["stages_ms"].get(name.removeprefix("derivative_"), 0.0)
                        + float(value) * 1000.0
                    )
    return totals if found else None


def _resolved_cell_count(
    result: Mapping[str, Any], diagnostics: Mapping[str, Any] | None,
) -> int | None:
    diagnostic_cells = diagnostics.get("cells", []) if diagnostics else []
    diagnostic_ids = {
        cell.get("cell_id")
        for cell in diagnostic_cells
        if isinstance(cell, Mapping)
        and isinstance(cell.get("cell_id"), int)
        and not isinstance(cell.get("cell_id"), bool)
    }
    if diagnostic_ids:
        return len(diagnostic_ids)

    traces = result.get("cell_traces")
    if not isinstance(traces, list):
        return None
    cell_ids = {
        trace.get("cell_id")
        for trace in traces
        if isinstance(trace, Mapping)
        and isinstance(trace.get("cell_id"), int)
        and not isinstance(trace.get("cell_id"), bool)
    }
    return len(cell_ids)


def build_time_capacity_profile(
    *,
    request_id: str,
    result_cache: str,
    diagnostics: Mapping[str, Any] | None = None,
    backend_total_ms: float | None = None,
    backend_compute_ms: float | None = None,
    backend_serialize_ms: float | None = None,
    response_bytes: int | None = None,
    result: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the namespaced profiling block for an explicit profile request."""

    raw_cells = diagnostics.get("cells", []) if diagnostics else []
    cells = [cell for cell in raw_cells if isinstance(cell, Mapping)]
    profile: dict[str, Any] = {
        "profile_version": 1,
        "request_id": request_id,
        "result_cache": result_cache,
        "raw_access": _raw_access(cells, result_cache),
    }
    for key, value in (
        ("backend_total_ms", backend_total_ms),
        ("backend_compute_ms", backend_compute_ms),
        ("backend_serialize_ms", backend_serialize_ms),
        ("response_bytes", response_bytes),
    ):
        if value is not None:
            profile[key] = value

    if result_cache != "hit":
        stages = _stage_totals_ms(cells)
        if stages is not None:
            profile["backend_stages_ms"] = stages
        transform_stages = _transform_stage_profiles(cells)
        if transform_stages is not None:
            profile["transform_stages"] = transform_stages
        derivative_profile = _derivative_profile(cells)
        if derivative_profile is not None:
            profile["derivative_profile"] = derivative_profile
        for key in ("row_groups_read", "row_groups_total"):
            value = _row_group_total(cells, key)
            if value is not None:
                profile[key] = value
        for key in ("prepared_row_groups_read", "prepared_rows_materialized"):
            value = _numeric_sum(cells, key)
            if value is not None:
                profile[key] = value
        for key in (
            "derived_access",
            "phase_source",
            "phase_capacity_source",
        ):
            value = _categorical_value(cells, key)
            if value is not None:
                profile[key] = value
        for key in ("raw_rows_materialized", "selected_rows_before_transforms"):
            value = _numeric_sum(cells, key)
            if value is not None:
                profile[key] = value

    if result is not None:
        rendering = result.get("rendering")
        if isinstance(rendering, Mapping) and isinstance(rendering.get("total_points"), int):
            profile["returned_points"] = rendering["total_points"]
        resolved_cells = _resolved_cell_count(result, diagnostics)
        if resolved_cells is not None:
            # One resolved Cell can produce more than one Plotly trace. The
            # frontend owns the separate Plotly trace count at completion.
            profile["resolved_cell_count"] = resolved_cells
    return profile
