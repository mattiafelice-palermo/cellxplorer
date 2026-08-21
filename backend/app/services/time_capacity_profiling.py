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
        for key in ("row_groups_read", "row_groups_total"):
            value = _row_group_total(cells, key)
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
