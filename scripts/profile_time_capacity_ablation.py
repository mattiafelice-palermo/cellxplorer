"""Benchmark-only ablation and composition harness for Spec 050.13.

The child deliberately does not change the production Time/Capacity route.  It
uses the same indexed fixture/application environments and separates three
boundaries that are easy to confuse:

* complete ordinary route baselines (delegated to the 050.12 paired router
  harness);
* isolated, repeatable per-Cell transform/projection experiments over raw
  frames loaded through the current indexed plan; and
* a persistent 2/4-process whole-Cell control whose workers receive only
  immutable plans/descriptors and reopen the cache themselves.

The JSON result is disposable evidence.  It contains timings, counts, hashes
and decision metadata, never raw rows, source paths, filenames or Cell names.
"""
from __future__ import annotations

import argparse
import ctypes
from concurrent.futures import ProcessPoolExecutor
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import dataclass
import gzip
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import pickle
import queue
import shutil
import statistics
import sys
import tempfile
import threading
import time
from time import perf_counter
from typing import Any, Iterable
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402
import profile_time_capacity_concurrency as concurrency  # noqa: E402
import profile_time_capacity_ordinary_latency as ordinary  # noqa: E402
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


REPETITIONS = 5
IMPROVEMENT_THRESHOLD = 0.05
SYNTHETIC_TIERS: tuple[tuple[str, int | None], ...] = (
    ("S100", None),
    ("S50", 96),
    ("S25", 48),
)
ABLATION_CANDIDATES = (
    "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10",
    "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19",
    "T20", "T21", "T22", "T23", "T24", "C1",
)


@dataclass(frozen=True)
class ProjectionSample:
    digest: str
    trace_order_digest: str
    payload_bytes: int
    rows: int
    points: int
    stage_ms: dict[str, float]
    payload: dict[str, Any]


@dataclass(frozen=True)
class CapturedWorkload:
    name: str
    spec: dict[str, Any]
    request: Any
    jobs: tuple[Any, ...]
    payloads: tuple[Any, ...]
    owner_setup_ms: float
    data_root: Path


def _finite(values: Iterable[object]) -> list[float]:
    return [float(value) for value in values if isinstance(value, (int, float)) and np.isfinite(value)]


def _median(values: Iterable[object]) -> float | None:
    finite = _finite(values)
    return statistics.median(finite) if finite else None


def _range(values: Iterable[object]) -> dict[str, float | None]:
    finite = _finite(values)
    return {
        "min_ms": min(finite) if finite else None,
        "median_ms": statistics.median(finite) if finite else None,
        "max_ms": max(finite) if finite else None,
    }


def _range_int(values: Iterable[object]) -> dict[str, int | None]:
    integers = [int(value) for value in values if isinstance(value, (int, np.integer))]
    return {
        "min": min(integers) if integers else None,
        "median": int(statistics.median(integers)) if integers else None,
        "max": max(integers) if integers else None,
    }


def _pct(reference: float | None, candidate: float | None) -> float | None:
    if reference is None or candidate is None or reference == 0:
        return None
    return (candidate / reference - 1.0) * 100.0


def _hash_bytes(digest: hashlib._Hash, value: object) -> None:
    if isinstance(value, np.ndarray):
        array = np.ascontiguousarray(value)
        digest.update(str(array.dtype).encode("utf-8"))
        digest.update(str(array.shape).encode("ascii"))
        digest.update(array.tobytes())
        return
    digest.update(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8"))


def _payload_digest(payload: dict[str, Any], *, exclude: set[str] | None = None) -> str:
    excluded = exclude or set()
    digest = hashlib.sha256()
    for key in sorted(payload):
        if key in excluded:
            continue
        digest.update(key.encode("utf-8"))
        _hash_bytes(digest, payload[key])
    return digest.hexdigest()


def _jsonsafe_plot(values: np.ndarray, digits: int | None) -> list[float | None]:
    array = np.asarray(values, dtype="float64")
    if digits is not None:
        array = np.round(array, digits)
    return [None if np.isnan(value) else float(value) for value in array]


def _jsonsafe_plot_vectorized(values: np.ndarray, digits: int | None) -> list[float | None]:
    """A benchmark candidate with the same null/rounding contract."""

    array = np.asarray(values, dtype="float64")
    if digits is not None:
        array = np.round(array, digits)
    output = array.tolist()
    return [None if value is None or (isinstance(value, float) and np.isnan(value)) else float(value) for value in output]


def _jsonsafe_int(values: np.ndarray) -> list[int | None]:
    return [None if np.isnan(value) else int(value) for value in np.asarray(values, dtype="float64")]


def _features(candidate: str) -> set[str]:
    return {part for part in candidate.split("+") if part and part not in {"A0", "W1", "W2", "W3"}}


def _feature_exclusions(candidate: str, settings: dict[str, Any] | None = None) -> set[str]:
    """Fields a candidate deliberately removes from its consumer contract."""

    features = _features(candidate)
    excluded = {"compact_payload_note", "source_table_size", "source_index", "source_table"}
    if "T1" in features:
        excluded.update({"phase", "phase_omitted_for_narrow_target"})
    if "T12" in features and (settings is None or _ordinary_phase_free(settings)):
        excluded.add("time_s")
    return excluded


def _consumer_payload(
    sample: ProjectionSample,
    candidate: str,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reconstruct the representation seen by the tested consumer.

    T13 never creates the expanded hash array.  Its parity check expands the
    compact table only in this benchmark-side comparator, after timing, so the
    candidate's production-boundary work remains the compact representation.
    """

    # These underscore fields are benchmark diagnostics appended after the
    # measured payload projection; they are never visible to a consumer.
    payload = {
        key: value for key, value in sample.payload.items() if not key.startswith("_")
    }
    features = _features(candidate)
    if "T13" in features and ("source_table" in payload or "source_index" in payload):
        table = payload.get("source_table") or []
        indices = payload.get("source_index") or []
        payload["source_hash"] = [
            table[int(index)] if isinstance(index, int) and 0 <= index < len(table) else None
            for index in indices
        ]
    return payload


def _consumer_digest(
    sample: ProjectionSample,
    candidate: str,
    settings: dict[str, Any] | None = None,
) -> str:
    return _payload_digest(
        _consumer_payload(sample, candidate, settings),
        exclude=_feature_exclusions(candidate, settings),
    )


def _consumer_order_digest(
    sample: ProjectionSample,
    candidate: str,
    settings: dict[str, Any] | None = None,
) -> str:
    payload = _consumer_payload(sample, candidate, settings)
    order = {
        "cycle": payload.get("cycle"),
        "phase": payload.get("phase") if "T1" not in _features(candidate) else None,
        "source_cycle": payload.get("source_cycle"),
        "source_boundary_indices": payload.get("source_boundary_indices"),
    }
    return _payload_digest(order)


def _sort_columns(frame: pd.DataFrame) -> list[str]:
    return ["cycle", "segment", "record_index"] if "record_index" in frame.columns else ["cycle", "segment"]


def _is_sorted_by_production_order(frame: pd.DataFrame) -> bool:
    if frame.empty:
        return True
    columns = _sort_columns(frame)
    expected = frame.sort_values(columns, kind="stable").index.to_numpy()
    return np.array_equal(expected, frame.index.to_numpy())


def _vectorized_downsample_indices(
    length: int,
    max_points: int,
    visible: np.ndarray,
    series: list[np.ndarray] | None = None,
) -> np.ndarray:
    """Independent vectorized candidate preserving the production envelope rule."""

    if length <= max_points:
        return np.arange(length, dtype="int64")
    transitions = np.flatnonzero(visible[1:] != visible[:-1]) + 1
    mandatory = np.array([0, length - 1], dtype="int64")
    if len(transitions):
        mandatory = np.unique(np.concatenate((mandatory, np.maximum(0, transitions - 1), transitions)))
    usable = [
        np.asarray(values, dtype="float64")
        for values in (series or [])
        if len(values) == length and np.isfinite(values).any()
    ] or [np.arange(length, dtype="float64")]
    remaining = max(1, max_points - len(mandatory))
    points_per_bucket = max(2, len(usable) * 2) * 3
    bucket_count = max(1, remaining // points_per_bucket)
    edges = np.linspace(0, length, bucket_count + 1).astype("int64")
    selected: set[int] = set(int(value) for value in mandatory)
    for start, end in zip(edges[:-1], edges[1:]):
        if end <= start:
            continue
        for values in usable:
            local = values[start:end]
            finite = np.flatnonzero(np.isfinite(local))
            if not len(finite):
                continue
            finite_values = local[finite]
            points = (
                int(start + finite[int(np.argmin(finite_values))]),
                int(start + finite[int(np.argmax(finite_values))]),
            )
            for point in points:
                selected.update(range(max(0, point - 1), min(length, point + 2)))
    if len(selected) < max_points:
        fill = np.linspace(0, length - 1, max_points - len(selected) + 2).astype("int64")
        selected.update(int(value) for value in fill)
    return np.asarray(sorted(selected), dtype="int64")


def _dense_cycle_mapping(frame: pd.DataFrame, cycle_map: dict[int, int]) -> pd.Series:
    """Map integer local cycles through a dense lookup when its span is bounded."""

    values = pd.to_numeric(frame["cycle"], errors="coerce").to_numpy(dtype="float64")
    if not cycle_map:
        return pd.Series(values, index=frame.index)
    labels = np.asarray(list(cycle_map), dtype="int64")
    low, high = int(labels.min()), int(labels.max())
    if high - low > max(4096, len(labels) * 32):
        raise ValueError("cycle-label span is not dense enough")
    lookup = np.full(high - low + 1, np.nan, dtype="float64")
    lookup[labels - low] = np.asarray([cycle_map[int(value)] for value in labels], dtype="float64")
    numeric = np.full(len(values), np.nan, dtype="float64")
    finite = np.isfinite(values)
    indices = values[finite].astype("int64") - low
    valid = (indices >= 0) & (indices < len(lookup))
    output_indices = np.flatnonzero(finite)[valid]
    numeric[output_indices] = lookup[indices[valid]]
    return pd.Series(numeric, index=frame.index)


def _apply_owner_cycle_mapping(frame: pd.DataFrame, settings: dict[str, Any]) -> pd.DataFrame:
    """Apply the owner-provided dense source maps without rediscovering them.

    The map is resolved by ``build_time_capacity_stitch_plan``.  This helper
    only executes the candidate's per-row lookup; it does not inspect the
    frame to infer source boundaries or rebuild a global cycle map.
    """

    maps = settings.get("_cycle_maps_by_source") or {}
    if not maps or "source_hash" not in frame.columns or "source_cycle" not in frame.columns:
        return frame
    mapped = frame.copy()
    values = mapped["cycle"].to_numpy(dtype="float64", copy=True)
    source_hashes = mapped["source_hash"].to_numpy(dtype=object)
    source_cycles = mapped["source_cycle"].to_numpy(dtype=object)
    for file_hash, cycle_map in maps.items():
        mask = source_hashes == file_hash
        if not np.any(mask):
            continue
        local = pd.DataFrame({"cycle": source_cycles[mask]})
        values[np.flatnonzero(mask)] = _dense_cycle_mapping(local, cycle_map).to_numpy(dtype="float64")
    mapped["cycle"] = values
    return mapped


def _selected_frame(frame: pd.DataFrame, settings: dict[str, Any], features: set[str]) -> tuple[pd.DataFrame, bool, bool]:
    """Return the selected/sorted frame and the two candidate invariant gates."""

    selected = frame.copy()
    exact_invariant = bool(settings.get("_exact_selection_invariant"))
    canonical_order_invariant = bool(settings.get("_indexed_canonical_order_invariant"))
    if settings.get("cycles"):
        exact = exact_invariant
        if "T7" not in features or not exact:
            selected = selected[selected["cycle"].isin(settings["cycles"])]
    else:
        exact = exact_invariant
        if settings.get("cycle_start") is not None:
            if "T7" not in features or not exact:
                selected = selected[selected["cycle"] >= int(settings["cycle_start"])]
        if settings.get("cycle_end") is not None:
            if "T7" not in features or not exact:
                selected = selected[selected["cycle"] <= int(settings["cycle_end"])]
    sorted_invariant = canonical_order_invariant
    if "T6" not in features or not sorted_invariant:
        selected = selected.sort_values(_sort_columns(selected), kind="stable")
    return selected.reset_index(drop=True), exact, sorted_invariant


def _ordinary_phase_free(settings: dict[str, Any]) -> bool:
    """The narrow T1 target; other consumers keep the canonical phase array."""

    return (
        settings.get("view") == "voltage_current"
        and settings.get("x_axis") == "time"
        and settings.get("display_mode") == "consecutive"
    )


def _projection(
    frame: pd.DataFrame,
    settings: dict[str, Any],
    candidate: str,
    *,
    viewport_width: int = 1200,
) -> ProjectionSample:
    """Run the current per-Cell projection shape with one candidate feature set."""

    from app.services import analysis_engine

    features = _features(candidate)
    stage_ms: dict[str, float] = {}
    started = perf_counter()
    source_mapped = _apply_owner_cycle_mapping(frame, settings) if "T8" in features else frame
    selected, exact_selection, sorted_invariant = _selected_frame(source_mapped, settings, features)
    stage_ms["filter_sort"] = (perf_counter() - started) * 1000.0
    if "T8" in features:
        stage_ms["cycle_mapping"] = (perf_counter() - started) * 1000.0 - stage_ms["filter_sort"]

    started = perf_counter()
    phase_free_target = "T1" in features and _ordinary_phase_free(settings)
    if not phase_free_target:
        phases = analysis_engine._phase_from_raw(selected)
    else:
        phases = []
    if settings.get("x_axis") == "time":
        selected = analysis_engine._continuous_time(selected)
    phase_ms = (perf_counter() - started) * 1000.0
    stage_ms["continuous_time_phase"] = phase_ms

    started = perf_counter()
    capacity = None
    if settings.get("x_axis") in {"capacity_mah", "capacity_mah_g", "capacity_mah_cm2"}:
        capacity = analysis_engine._phase_capacity(selected, phases)
    capacity_ms = (perf_counter() - started) * 1000.0
    stage_ms["capacity"] = capacity_ms

    voltage_column = "voltage_v"
    voltage = selected[voltage_column].to_numpy(dtype="float64") if voltage_column in selected else np.full(len(selected), np.nan)
    current = selected["current_ma"].to_numpy(dtype="float64") if "current_ma" in selected else np.full(len(selected), np.nan)
    started = perf_counter()
    display_x = analysis_engine._time_capacity_display_x(
        selected,
        phases,
        capacity,
        None,
        None,
        settings,
    )
    stage_ms["display_x"] = (perf_counter() - started) * 1000.0

    max_points = int(settings.get("max_points_per_cell") or 4000)
    if "T18" in features and not settings.get("_full_export"):
        # The old candidate was a no-op at 1200 px.  Use a real viewport budget
        # for the representative compact path while keeping full export out of
        # this candidate entirely.
        max_points = max(400, min(max_points, int(round(max(320, viewport_width) * 2.0))))
    visible = np.isfinite(voltage)
    if len(selected) > max_points:
        started = perf_counter()
        if "T9" in features or "T11" in features:
            take = _vectorized_downsample_indices(len(selected), max_points, visible, [voltage])
        else:
            take = analysis_engine._downsample_indices(len(selected), max_points, visible, [voltage])
        stage_ms["downsample"] = (perf_counter() - started) * 1000.0
        boundaries = (
            np.flatnonzero(selected["segment"].to_numpy()[1:] != selected["segment"].to_numpy()[:-1]) + 1
            if "segment" in selected.columns and len(selected) > 1
            else np.array([], dtype="int64")
        )
        take = np.unique(np.concatenate((take, boundaries)))
    else:
        take = np.arange(len(selected), dtype="int64")
        stage_ms["downsample"] = 0.0

    started = perf_counter()
    direct_take = "T10" in features or "T11" in features
    selected_frame = None if direct_take else selected.iloc[take]

    def take_column(name: str, dtype: str = "float64") -> np.ndarray:
        values = selected[name].to_numpy(dtype=dtype) if name in selected.columns else np.full(len(selected), np.nan)
        return values[take]

    selected_voltage = voltage[take]
    selected_current = current[take]
    selected_display_x = display_x[take]
    omit_time = "T12" in features and _ordinary_phase_free(settings)
    selected_time = np.array([], dtype="float64") if omit_time else take_column("time_s")
    selected_cycle = take_column("cycle", "float64")
    selected_capacity = capacity[take] if capacity is not None else np.full(len(take), np.nan)
    compact_hash_values: np.ndarray | None = None
    if selected_frame is not None:
        if "T13" in features and "source_hash" in selected_frame:
            compact_hash_values = selected_frame["source_hash"].to_numpy(dtype=object)
            source_hash = None
        else:
            source_hash = selected_frame["source_hash"].tolist() if "source_hash" in selected_frame else [None] * len(take)
        source_cycle = selected_frame["source_cycle"].tolist() if "source_cycle" in selected_frame else [None] * len(take)
        source_position = [None] * len(take)
    else:
        if "T13" in features and "source_hash" in selected:
            compact_hash_values = selected["source_hash"].to_numpy(dtype=object)[take]
            source_hash = None
        else:
            source_hash = selected["source_hash"].to_numpy(dtype=object)[take].tolist() if "source_hash" in selected else [None] * len(take)
        source_cycle = selected["source_cycle"].to_numpy(dtype=object)[take].tolist() if "source_cycle" in selected else [None] * len(take)
        source_position = [None] * len(take)
    stage_ms["gather"] = (perf_counter() - started) * 1000.0

    safe = _jsonsafe_plot_vectorized if "T14" in features else _jsonsafe_plot
    payload: dict[str, Any] = {
        "cycle": _jsonsafe_int(selected_cycle),
        "display_x": safe(selected_display_x, 6),
        "capacity_mah": safe(selected_capacity, 6),
        "voltage_v": safe(selected_voltage, 5),
        "current_ma": safe(selected_current, 5),
        "source_cycle": source_cycle,
        "source_position": source_position,
        "source_boundary_indices": [int(index) for index in np.flatnonzero(np.diff(take) > 1)],
    }
    if not omit_time:
        payload["time_s"] = safe(selected_time, 3)
    if source_hash is not None:
        payload["source_hash"] = source_hash
    if not phase_free_target:
        payload["phase"] = list(np.asarray(phases, dtype=object)[take])
    if "T13" in features:
        hash_values = compact_hash_values if compact_hash_values is not None else np.array([], dtype=object)
        source_order = list(settings.get("_source_order") or [])
        used = {value for value in hash_values if value is not None}
        source_table = [value for value in source_order if value in used]
        for value in hash_values:
            if value is not None and value not in source_table:
                source_table.append(value)
        positions = {value: index for index, value in enumerate(source_table)}
        source_indices = [positions.get(value) if value is not None else None for value in hash_values]
        payload["source_index"] = source_indices
        payload["source_table"] = source_table
    payload_bytes = len(json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    digest = _payload_digest(payload, exclude={"source_index", "source_table"})
    trace_order_digest = _payload_digest(
        {
            "cycle": payload.get("cycle"),
            "phase": payload.get("phase"),
            "source_cycle": payload.get("source_cycle"),
            "source_boundary_indices": payload.get("source_boundary_indices"),
        }
    )
    stage_ms["payload_projection"] = (perf_counter() - started) * 1000.0
    payload["_invariant_exact_selection"] = exact_selection
    payload["_invariant_sorted_input"] = sorted_invariant
    payload["_direct_take"] = direct_take
    payload["_rows"] = len(selected)
    payload["_point_budget"] = max_points
    payload["_phase_omitted_for_narrow_target"] = phase_free_target
    payload["_time_omitted_for_narrow_target"] = omit_time
    return ProjectionSample(
        digest=digest,
        trace_order_digest=trace_order_digest,
        payload_bytes=payload_bytes,
        rows=len(selected),
        points=len(take),
        stage_ms=stage_ms,
        payload=payload,
    )


def _measure_projection(
    frame: pd.DataFrame,
    settings: dict[str, Any],
    candidate: str,
    baseline: ProjectionSample,
    repetitions: int,
    *,
    viewport_width: int = 1200,
) -> dict[str, Any]:
    warm = _projection(frame, settings, candidate, viewport_width=viewport_width)
    samples: list[ProjectionSample] = []
    for _ in range(repetitions):
        samples.append(_projection(frame, settings, candidate, viewport_width=viewport_width))
    walls = [sum(sample.stage_ms.values()) for sample in samples]
    exact = all(
        _consumer_digest(sample, candidate, settings) == _consumer_digest(baseline, candidate, settings)
        for sample in [warm, *samples]
    )
    order_equal = all(
        _consumer_order_digest(sample, candidate, settings)
        == _consumer_order_digest(baseline, candidate, settings)
        for sample in [warm, *samples]
    )
    median_wall = _median(walls)
    viewport_contract_equal = exact
    if "T18" in _features(candidate):
        baseline_cycles = set(_consumer_payload(baseline, candidate, settings).get("cycle") or [])
        viewport_contract_equal = all(
            set(_consumer_payload(sample, candidate, settings).get("cycle") or []) == baseline_cycles
            for sample in [warm, *samples]
        )
    if not exact:
        if "T18" in _features(candidate) and viewport_contract_equal:
            classification = "retain_support"
            reason = "viewport budget intentionally changes sampled points; cycle coverage remains exact and visual acceptance is still required"
        else:
            classification = "reject"
            reason = "candidate changed the consumer-equivalent compact payload digest"
    elif candidate in {"T12", "T13", "T18"}:
        classification = "retain_support"
        reason = "display/payload shape requires frontend or manual visual acceptance"
    elif exact and median_wall is not None and median_wall <= sum(baseline.stage_ms.values()) * (1.0 - IMPROVEMENT_THRESHOLD):
        classification = "promote"
        reason = "exact parity and at least 5% isolated projection improvement"
    else:
        classification = "reject"
        reason = "exact but below the 5% isolated promotion threshold"
    return {
        "candidate": candidate,
        "repetitions": repetitions,
        "wall_ms": _range(walls),
        "baseline_wall_ms": sum(baseline.stage_ms.values()),
        "delta_pct": _pct(sum(baseline.stage_ms.values()), median_wall),
        "stage_medians_ms": {
            name: _median(sample.stage_ms.get(name) for sample in samples)
            for name in sorted({name for sample in samples for name in sample.stage_ms})
        },
        "rows": warm.rows,
        "returned_points": warm.points,
        "payload_bytes": warm.payload_bytes,
        "payload_bytes_delta_pct": _pct(baseline.payload_bytes, warm.payload_bytes),
        "scientific_digest_equal": exact,
        "consumer_semantics_equal": exact and order_equal,
        "viewport_contract_equal": viewport_contract_equal,
        "trace_order_equal": order_equal,
        "invariant_gates": {
            "exact_selection": bool(warm.payload.get("_invariant_exact_selection")),
            "sorted_input": bool(warm.payload.get("_invariant_sorted_input")),
        },
        "classification": classification,
        "reason": reason,
    }


def _capture_workload(env: Any, base: dict[str, Any], name: str, cell_ids: list[int], *, cycle_end: int | None, x_axis: str = "time") -> CapturedWorkload:
    spec = concurrency.make_spec(
        base,
        cell_ids,
        [],
        cycle_end,
        x_axis=x_axis,
        view="voltage_current",
    )
    jobs, request, owner = concurrency.prepare_resolved_jobs(env, spec, cell_ids)
    payloads = tuple(concurrency._materialize_read(job, perf_counter()) for job in jobs)
    request.settings["_indexed_canonical_order_invariant"] = bool(jobs) and all(
        job.plan.path == "indexed" for job in jobs
    )
    request.settings["_exact_selection_invariant"] = bool(jobs) and all(
        job.plan.path == "indexed" and tuple(job.requested_cycles) for job in jobs
    )
    source_maps: dict[str, dict[int, int]] = {}
    source_order: list[str] = []
    for job in jobs:
        for source in job.plan.sources:
            file_hash = source.ref.file_hash
            if file_hash not in source_maps:
                source_maps[file_hash] = dict(source.cycle_map)
                source_order.append(file_hash)
    request.settings["_cycle_maps_by_source"] = source_maps
    request.settings["_source_order"] = source_order
    return CapturedWorkload(
        name=name,
        spec=spec,
        request=request,
        jobs=tuple(jobs),
        payloads=payloads,
        owner_setup_ms=float(owner["wall_ms"]),
        data_root=Path(env.data_root).resolve(),
    )


def _raw_frames(captured: CapturedWorkload) -> list[pd.DataFrame]:
    return [payload.raw.copy() for payload in captured.payloads]


def _settings(captured: CapturedWorkload) -> dict[str, Any]:
    return deepcopy(captured.request.settings)


def _projection_ablation(
    captured: CapturedWorkload,
    repetitions: int,
    *,
    baselines: list[ProjectionSample] | None = None,
) -> dict[str, Any]:
    frames = _raw_frames(captured)
    settings = _settings(captured)
    baselines = baselines or [_projection(frame, settings, "A0") for frame in frames]
    candidate_ids = ("T1", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14", "T18")
    rows: list[dict[str, Any]] = []
    for candidate in candidate_ids:
        candidate_rows = [
            _measure_projection(frame, settings, candidate, baseline, repetitions)
            for frame, baseline in zip(frames, baselines)
        ]
        rows.append(
            {
                "candidate": candidate,
                "cell_rows": candidate_rows,
                "median_wall_ms": _median(item["wall_ms"]["median_ms"] for item in candidate_rows),
                "median_delta_pct": _median(item["delta_pct"] for item in candidate_rows),
                "classification": (
                    "promote"
                    if candidate_rows and all(item["classification"] == "promote" for item in candidate_rows)
                    else "retain_support"
                    if candidate in {"T12", "T13", "T18"}
                    else "reject"
                ),
            }
        )
    viewport = _viewport_budget_ablation(captured, repetitions, baselines=baselines) if captured.name == "S25-6-time" else {"status": "NOT RUN"}
    return {
        "workload": captured.name,
        "cell_count": len(frames),
        "owner_setup_ms": captured.owner_setup_ms,
        "rows_per_cell": [len(frame) for frame in frames],
        "baseline": {
            "wall_ms": _range([sum(item.stage_ms.values()) for item in baselines]),
            "returned_points": [item.points for item in baselines],
            "payload_bytes": [item.payload_bytes for item in baselines],
        },
        "candidates": rows,
        "viewport_budget": viewport,
    }


def _viewport_budget_ablation(
    captured: CapturedWorkload,
    repetitions: int,
    *,
    baselines: list[ProjectionSample] | None = None,
) -> dict[str, Any]:
    """Measure actual narrow/standard/wide compact budgets on the S25 target."""

    frames = _raw_frames(captured)
    settings = _settings(captured)
    baselines = baselines or [_projection(frame, settings, "A0") for frame in frames]
    rows: list[dict[str, Any]] = []
    for width in (600, 1200, 2400):
        cell_rows = [
            _measure_projection(
                frame,
                settings,
                "T18",
                baseline,
                repetitions,
                viewport_width=width,
            )
            for frame, baseline in zip(frames, baselines)
        ]
        rows.append(
            {
                "viewport_width": width,
                "returned_points": [item["returned_points"] for item in cell_rows],
                "payload_bytes": [item["payload_bytes"] for item in cell_rows],
                "projection_wall_ms": _range(
                    item["wall_ms"]["median_ms"] for item in cell_rows
                ),
                "baseline_points": [item.points for item in baselines],
                "baseline_payload_bytes": [item.payload_bytes for item in baselines],
                "cycle_coverage_equal": all(item["viewport_contract_equal"] for item in cell_rows),
                "semantic_parity": all(item["consumer_semantics_equal"] for item in cell_rows),
            }
        )
    return {
        "candidate": "T18",
        "viewports_px": rows,
        "full_export_unchanged": _full_export_t18_control(captured),
        "classification": "retain_support",
        "reason": "viewport budgets are measured; visual equivalence remains a manual gate",
    }


def _full_export_t18_control(captured: CapturedWorkload) -> bool:
    """The adaptive budget is explicitly disabled for the full-export marker."""

    frame = _raw_frames(captured)[0]
    settings = _settings(captured)
    settings["_full_export"] = True
    baseline = _projection(frame, settings, "A0")
    candidate = _projection(frame, settings, "T18")
    return (
        baseline.digest == candidate.digest
        and baseline.trace_order_digest == candidate.trace_order_digest
        and baseline.points == candidate.points
    )


def _shared_fingerprint_payload(
    db: Any,
    spec: dict[str, Any],
    provenance: dict[str, Any] | None,
    *,
    use_current_versions: bool,
) -> dict[str, Any]:
    """Build the common owner fingerprint once for the T4 experiment."""

    from app.services import analysis_cache, analysis_engine

    units, missing = analysis_engine.resolve_selection(db, spec)
    selected = [unit["cell"] for unit in units]
    analysis_engine.preload_cell_sources(db, selected)
    scalar_metadata = analysis_engine.load_scalar_metadata(db, selected)
    unit_fingerprints: list[dict[str, Any]] = []
    for unit in units:
        cell = unit["cell"]
        hashes, files = analysis_engine.cell_ordered_hashes(db, cell)
        source_versions = analysis_engine.resolve_source_parser_versions(
            files, provenance, cell.id, use_current_versions
        )
        unit_fingerprints.append(
            {
                "entry_kind": unit["entry_kind"],
                "entry_ref_id": unit["entry_ref_id"],
                "cell_id": cell.id,
                "cell_name": cell.name,
                "label": unit["label"],
                "group_id": unit["group_id"],
                "group_name": unit["group_name"],
                "hashes": hashes,
                "source_parser_versions": [source_versions[h] for h in hashes],
                "active_mass_mg": analysis_engine.cell_active_mass_mg(cell, scalar_metadata.get(cell.id)),
                "nominal_capacity_mah": analysis_engine.cell_nominal_capacity_mah(cell, scalar_metadata.get(cell.id)),
                "electrode_area_cm2": analysis_engine.cell_electrode_area_cm2(cell, scalar_metadata.get(cell.id)),
                "archived": bool(cell.archived),
            }
        )
    return {
        "cache_version": analysis_cache.ANALYSIS_CACHE_VERSION,
        "result_schema_version": analysis_cache.RESULT_SCHEMA_VERSIONS["time_capacity"],
        "kind": "time_capacity",
        "calc_version": (
            provenance.get("calc_version")
            if provenance and not use_current_versions and provenance.get("calc_version")
            else analysis_cache.CALC_VERSION
        ),
        "spec": analysis_cache._scientific_spec(spec, "time_capacity"),
        "units": unit_fingerprints,
        "missing": missing,
    }


def _identity_ablation(env: Any, base: dict[str, Any], cell_ids: list[int], repetitions: int) -> dict[str, Any]:
    from app.services import analysis_cache

    spec = concurrency.make_spec(base, cell_ids, [], None, x_axis="time", view="voltage_current")
    options = {"viewport_width": 1200, "precision": "standard", "compact": True}
    rows: list[dict[str, float | bool]] = []
    for _ in range(repetitions):
        started = perf_counter()
        scientific = analysis_cache.time_capacity_data_signature(env.db, spec, None, use_current_versions=False)
        scientific_ms = (perf_counter() - started) * 1000.0
        started = perf_counter()
        render = analysis_cache.result_key(
            env.db,
            "time_capacity",
            spec,
            None,
            use_current_versions=False,
            request_options=options,
        )
        render_ms = (perf_counter() - started) * 1000.0
        started = perf_counter()
        shared = _shared_fingerprint_payload(env.db, spec, None, use_current_versions=False)
        candidate_scientific = analysis_cache._digest({**shared, "options": {}})
        candidate_render = analysis_cache._digest({**shared, "options": options})
        shared_ms = (perf_counter() - started) * 1000.0
        rows.append(
            {
                "scientific_ms": scientific_ms,
                "render_ms": render_ms,
                "total_ms": scientific_ms + render_ms,
                "shared_ms": shared_ms,
                "scientific_key_equal": candidate_scientific == scientific,
                "render_key_equal": candidate_render == render,
            }
        )
    baseline_median = _median(item["total_ms"] for item in rows)
    candidate_median = _median(item["shared_ms"] for item in rows)
    exact = bool(rows) and all(
        bool(item["scientific_key_equal"]) and bool(item["render_key_equal"]) for item in rows
    )
    return {
        "candidate": "T4",
        "repetitions": repetitions,
        "a0_two_identity_passes_ms": _range(item["total_ms"] for item in rows),
        "shared_fingerprint_pass_ms": _range(item["shared_ms"] for item in rows),
        "scientific_signature_ms": _range(item["scientific_ms"] for item in rows),
        "render_key_ms": _range(item["render_ms"] for item in rows),
        "keys_exact_equal": exact,
        "delta_pct": _pct(baseline_median, candidate_median),
        "classification": "promote"
        if exact and baseline_median is not None and candidate_median is not None and candidate_median <= baseline_median * (1.0 - IMPROVEMENT_THRESHOLD)
        else "retain_support",
        "reason": "one shared owner fingerprint payload derives both exact scientific and render-specific keys",
    }


def _cycle_mapping_ablation(captured: CapturedWorkload, repetitions: int) -> dict[str, Any]:
    """Compare the current pandas/dict mapping with a bounded dense lookup."""

    timings: list[dict[str, float]] = []
    parity = True
    rows = 0
    for payload, job in zip(captured.payloads, captured.jobs):
        frame = payload.raw
        if "source_cycle" not in frame.columns or "source_hash" not in frame.columns:
            continue
        for source in job.plan.sources:
            mask = frame["source_hash"].eq(source.ref.file_hash)
            local = pd.DataFrame({"cycle": frame.loc[mask, "source_cycle"]}).reset_index(drop=True)
            if local.empty:
                continue
            rows += len(local)
            mapping = dict(source.cycle_map)
            expected = pd.to_numeric(local["cycle"], errors="coerce").map(mapping).to_numpy(dtype="float64")
            candidate = _dense_cycle_mapping(local, mapping).to_numpy(dtype="float64")
            parity = parity and np.array_equal(expected, candidate, equal_nan=True)
            for _ in range(repetitions):
                started = perf_counter()
                pd.to_numeric(local["cycle"], errors="coerce").map(mapping).to_numpy(dtype="float64")
                dict_ms = (perf_counter() - started) * 1000.0
                started = perf_counter()
                _dense_cycle_mapping(local, mapping).to_numpy(dtype="float64")
                dense_ms = (perf_counter() - started) * 1000.0
                timings.append({"dict_ms": dict_ms, "dense_ms": dense_ms})
    dict_median = _median(item["dict_ms"] for item in timings)
    dense_median = _median(item["dense_ms"] for item in timings)
    return {
        "candidate": "T8",
        "rows": rows,
        "repetitions": repetitions,
        "dict_map_ms": _range(item["dict_ms"] for item in timings),
        "dense_map_ms": _range(item["dense_ms"] for item in timings),
        "delta_pct": _pct(dict_median, dense_median),
        "scientific_digest_equal": parity,
        "classification": "promote" if parity and dict_median is not None and dense_median is not None and dense_median <= dict_median * (1.0 - IMPROVEMENT_THRESHOLD) else "reject",
        "reason": "dense lookup is promoted only with exact mapping parity and a 5% isolated improvement",
    }


def _serializer_ablation(sample: ProjectionSample, repetitions: int) -> dict[str, Any]:
    """Measure list conversion plus stdlib/orjson serialization semantics."""

    import orjson

    values = sample.payload
    numeric_keys = {
        "cycle",
        "display_x",
        "time_s",
        "capacity_mah",
        "voltage_v",
        "current_ma",
    }
    numpy_payload: dict[str, Any] = {}
    conversion_ms: list[float] = []
    std_ms: list[float] = []
    orjson_ms: list[float] = []
    std_body = b""
    native_body = b""
    semantic_equal = True
    for _ in range(repetitions):
        started = perf_counter()
        numpy_payload = {
            key: np.asarray(value, dtype="float64")
            if key in numeric_keys and isinstance(value, list) and all(item is not None for item in value)
            else value
            for key, value in values.items()
        }
        conversion_ms.append((perf_counter() - started) * 1000.0)
        started = perf_counter()
        std_body = json.dumps(values, separators=(",", ":"), allow_nan=False).encode("utf-8")
        std_ms.append((perf_counter() - started) * 1000.0)
        started = perf_counter()
        native_body = orjson.dumps(numpy_payload, option=orjson.OPT_SERIALIZE_NUMPY)
        orjson_ms.append((perf_counter() - started) * 1000.0)
        semantic_equal = semantic_equal and json.loads(std_body) == json.loads(native_body)
    return {
        "candidate": "T15",
        "repetitions": repetitions,
        "numpy_list_conversion_ms": _range(conversion_ms),
        "stdlib_json_ms": _range(std_ms),
        "orjson_numpy_ms": _range(orjson_ms),
        "stdlib_body_bytes": len(std_body),
        "orjson_body_bytes": len(native_body),
        "body_size_delta_pct": _pct(len(std_body), len(native_body)),
        "semantic_equal": semantic_equal,
        "production_dependency_changed": False,
        "classification": "retain_support" if semantic_equal else "reject",
        "reason": "benchmark-only NumPy-aware serializer comparison; production dependency/package policy remains unchanged",
    }


def _cache_patch_stack(stack: ExitStack, analysis_cache: Any, cache_root: Path) -> None:
    """Point every disposable route-cache tier at one temporary directory."""

    stack.enter_context(patch.object(analysis_cache, "_ROOT", cache_root))
    stack.enter_context(patch.object(analysis_cache, "_RESULTS", cache_root / "results"))
    stack.enter_context(patch.object(analysis_cache, "_ARTIFACTS", cache_root / "artifacts"))
    stack.enter_context(patch.object(analysis_cache, "_THUMBNAILS", cache_root / "thumbnails"))
    stack.enter_context(patch.object(analysis_cache, "_THUMBNAIL_INDEXES", cache_root / "thumbnail-index"))
    stack.enter_context(patch.object(analysis_cache, "_PREPARED", cache_root / "prepared"))
    stack.enter_context(patch.object(analysis_cache, "_budget_total", None))


def _one_body_route_sample(
    env: Any,
    analysis_id: int,
    reference: dict[str, Any],
    *,
    scenario: str,
) -> tuple[float, dict[str, Any], dict[str, Any]]:
    """Run the real S25 route with one authoritative body for store + HTTP."""

    from fastapi import Response

    from app.routers import analyses as analyses_router
    from app.services import analysis_cache

    holder: dict[int, bytes] = {}
    metrics: dict[str, Any] = {
        "encode_ms": [],
        "cache_write_ms": [],
        "body_bytes": 0,
        "header_bytes": 0,
    }

    def store_once(kind: str, key: str, result: dict[str, Any], *args: Any, **kwargs: Any) -> None:
        value = dict(result)
        badges = value.pop("badges", None) or []
        value.pop("cache_status", None)
        started = perf_counter()
        body = analysis_cache._json_bytes(value)
        metrics["encode_ms"].append((perf_counter() - started) * 1000.0)
        holder[id(result)] = body
        metrics["body_bytes"] = len(body)
        metrics["header_bytes"] = len(analysis_cache._json_bytes({"badges": badges}))
        write_started = perf_counter()
        result_path = analysis_cache._result_path(kind, key)
        analysis_cache._store_budgeted(result_path, body)
        analysis_cache._write_sidecar(analysis_cache._sidecar_path(kind, key), {"badges": badges})
        metrics["cache_write_ms"].append((perf_counter() - write_started) * 1000.0)

    original_fast_json = analyses_router.fast_json

    def one_body_fast_json(value: Any, *, status_code: int = 200) -> Response:
        body = holder.get(id(value))
        if body is None:
            return original_fast_json(value, status_code=status_code)
        content = analysis_cache.splice_result_body(
            body,
            value.get("badges") or [],
            value.get("cache_status") or "miss",
            {
                "data_signature": value.get("data_signature"),
                "source_data_signature": value.get("source_data_signature"),
            },
        )
        return Response(content=content, media_type="application/json", status_code=status_code)

    with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05013-one-body-{scenario}-") as root:
        cache_root = Path(root)
        with ExitStack() as stack:
            _cache_patch_stack(stack, analysis_cache, cache_root)
            stack.enter_context(patch.object(analysis_cache, "store_result", store_once))
            stack.enter_context(patch.object(analyses_router, "fast_json", one_body_fast_json))
            started = perf_counter()
            response = analyses_router.compute_time_capacity_analysis(
                analysis_id,
                analyses_router.ComputeRequest(
                    recompute=False,
                    profile=False,
                    viewport_width=1200,
                    precision="standard",
                    compact=True,
                ),
                env.db,
            )
            wall_ms = (perf_counter() - started) * 1000.0
    payload = json.loads(response.body)
    if ordinary.scientific_digest(payload) != ordinary.scientific_digest(reference) or ordinary.result_order(payload) != ordinary.result_order(reference):
        raise RuntimeError(f"one-body route scientific parity failed in {scenario}")
    return wall_ms, payload, metrics


def _one_body_route_ablation(
    env: Any,
    analysis_id: int,
    reference: dict[str, Any],
    repetitions: int,
) -> dict[str, Any]:
    baseline: list[float] = []
    candidate: list[float] = []
    candidate_metrics: list[dict[str, Any]] = []
    for index in range(repetitions):
        plain_ms, _ = ordinary.run_unprofiled_route_sample(
            env, analysis_id, reference, scenario=f"S25-one-body-baseline-{index}"
        )
        candidate_ms, _payload, metrics = _one_body_route_sample(
            env,
            analysis_id,
            reference,
            scenario=f"S25-one-body-candidate-{index}",
        )
        baseline.append(plain_ms)
        candidate.append(candidate_ms)
        candidate_metrics.append(metrics)
    baseline_median = _median(baseline)
    candidate_median = _median(candidate)
    return {
        "candidate": "T16",
        "repetitions": repetitions,
        "a0_complete_route_ms": _range(baseline),
        "one_body_complete_route_ms": _range(candidate),
        "delta_pct": _pct(baseline_median, candidate_median),
        "body_bytes": candidate_metrics[-1]["body_bytes"] if candidate_metrics else None,
        "header_bytes": candidate_metrics[-1]["header_bytes"] if candidate_metrics else None,
        "encode_ms": _range(
            value for item in candidate_metrics for value in item["encode_ms"]
        ),
        "cache_write_ms": _range(
            value for item in candidate_metrics for value in item["cache_write_ms"]
        ),
        "scientific_semantics_equal": True,
        "classification": "promote"
        if candidate_median is not None and baseline_median is not None and candidate_median <= baseline_median * (1.0 - IMPROVEMENT_THRESHOLD)
        else "retain_support",
        "reason": "complete S25 route uses the same immutable scientific body for cache persistence and the HTTP response",
    }


def _write_behind_ablation(sample: ProjectionSample, repetitions: int) -> dict[str, Any]:
    """Benchmark-only persistence control with fixed bytes/key and bounded queue."""

    body = json.dumps(sample.payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    key = hashlib.sha256(body).hexdigest()
    compressed = gzip.compress(body, compresslevel=3)
    sync_encode: list[float] = []
    one_encode: list[float] = []
    write_behind: list[float] = []
    flush_times: list[float] = []
    max_depth = 0
    backpressure_count = 0
    with tempfile.TemporaryDirectory(prefix="cellxplorer-05013-write-behind-") as root:
        root_path = Path(root)
        for index in range(repetitions):
            path = root_path / f"sync-{index}-{key}.gz"
            started = perf_counter()
            encoded = gzip.compress(json.dumps(sample.payload, separators=(",", ":"), allow_nan=False).encode("utf-8"), compresslevel=3)
            path.write_bytes(encoded)
            sync_encode.append((perf_counter() - started) * 1000.0)

            path = root_path / f"one-encode-{index}-{key}.gz"
            started = perf_counter()
            path.write_bytes(compressed)
            one_encode.append((perf_counter() - started) * 1000.0)

            path = root_path / f"queued-{index}-{key}.gz"
            work: queue.Queue[tuple[Path, bytes] | None] = queue.Queue(maxsize=1)
            state = {"depth": 0, "max_depth": 0}

            def writer() -> None:
                while True:
                    item = work.get()
                    state["depth"] = work.qsize()
                    if item is None:
                        work.task_done()
                        return
                    item[0].write_bytes(item[1])
                    state["depth"] = work.qsize()
                    work.task_done()

            thread = threading.Thread(target=writer, daemon=True)
            thread.start()
            started = perf_counter()
            try:
                work.put_nowait((path, compressed))
            except queue.Full:
                backpressure_count += 1
                work.put((path, compressed))
            state["max_depth"] = max(state["max_depth"], work.qsize())
            write_behind.append((perf_counter() - started) * 1000.0)
            flush_started = perf_counter()
            work.put(None)
            work.join()
            thread.join(timeout=5.0)
            flush_times.append((perf_counter() - flush_started) * 1000.0)
            max_depth = max(max_depth, state["max_depth"])
            if path.read_bytes() != compressed:
                raise RuntimeError("bounded write-behind changed immutable cache bytes")
    return {
        "candidate": "T17",
        "repetitions": repetitions,
        "fixed_body_bytes": len(body),
        "fixed_compressed_bytes": len(compressed),
        "synchronous_encode_write_ms": _range(sync_encode),
        "one_encode_synchronous_write_ms": _range(one_encode),
        "bounded_write_behind_enqueue_ms": _range(write_behind),
        "bounded_write_behind_flush_ms": _range(flush_times),
        "queue_maxsize": 1,
        "max_observed_depth": max_depth,
        "backpressure_events": backpressure_count,
        "shutdown_joined": True,
        "immutable_bytes_and_key_equal": True,
        "classification": "retain_support",
        "reason": "benchmark-only queue control; production lifecycle, retry and crash durability remain out of scope",
    }


def _frame_digest(frame: pd.DataFrame) -> str:
    digest = hashlib.sha256()
    for column in frame.columns:
        digest.update(str(column).encode("utf-8"))
        values = pd.util.hash_pandas_object(frame[column], index=True).to_numpy(dtype="uint64")
        digest.update(values.tobytes())
    return digest.hexdigest()


def _owner_reuse_ablation(
    env: Any,
    base: dict[str, Any],
    cell_ids: list[int],
    repetitions: int,
) -> dict[str, Any]:
    """Compare repeated owner resolution with reuse of immutable resolved jobs."""

    spec = concurrency.make_spec(base, cell_ids, [], 48, x_axis="time", view="voltage_current")
    jobs, request, owner = concurrency.prepare_resolved_jobs(env, spec, cell_ids)
    baseline: list[float] = []
    candidate: list[float] = []
    parity = True

    def execute(run_jobs: list[Any], run_request: Any) -> str:
        items: list[dict[str, Any]] = []
        for job in run_jobs:
            payload = concurrency._materialize_read(job, perf_counter())
            result, _diagnostics = concurrency._resolved_cell_result(job, payload, run_request)
            items.append({"index": job.index, "result": result})
        return _payload_digest(_merge_process_results(items))

    for _ in range(repetitions):
        started = perf_counter()
        fresh_jobs, fresh_request, _fresh_owner = concurrency.prepare_resolved_jobs(env, spec, cell_ids)
        baseline_digest = execute(fresh_jobs, fresh_request)
        baseline.append((perf_counter() - started) * 1000.0)
        started = perf_counter()
        candidate_digest = execute(jobs, request)
        candidate.append((perf_counter() - started) * 1000.0)
        parity = parity and baseline_digest == candidate_digest
    baseline_median = _median(baseline)
    candidate_median = _median(candidate)
    return {
        "candidate": "T3",
        "repetitions": repetitions,
        "fresh_owner_plus_pipeline_ms": _range(baseline),
        "reused_owner_pipeline_ms": _range(candidate),
        "owner_setup_once_ms": float(owner["wall_ms"]),
        "delta_pct": _pct(baseline_median, candidate_median),
        "scientific_digest_equal": parity,
        "immutable_job_count": len(jobs),
        "classification": "promote"
        if parity and baseline_median is not None and candidate_median is not None and candidate_median <= baseline_median * (1.0 - IMPROVEMENT_THRESHOLD)
        else "retain_support",
        "reason": "owner-resolved immutable Cell/source/scalar descriptors are reused while every raw read and Cell transform remains actual",
    }


def _layout_descriptor_ablation(captured: CapturedWorkload, repetitions: int) -> dict[str, Any]:
    """Measure request-local plan reuse while retaining the indexed read check."""

    from app.services import time_capacity_path

    baseline: list[float] = []
    candidate: list[float] = []
    parity = True
    for _ in range(repetitions):
        baseline_started = perf_counter()
        baseline_digests: list[str] = []
        for job in captured.jobs:
            plan = time_capacity_path.build_time_capacity_stitch_plan(job.refs, diagnostics={})
            raw = time_capacity_path.load_indexed_time_capacity_raw(
                plan,
                job.requested_cycles,
                requested_columns=job.requested_columns,
                diagnostics={},
                wait_for_layout=True,
            )
            if raw is None:
                raise RuntimeError("fresh layout descriptor read became unavailable")
            baseline_digests.append(_frame_digest(raw))
        baseline.append((perf_counter() - baseline_started) * 1000.0)

        candidate_started = perf_counter()
        candidate_digests: list[str] = []
        for job in captured.jobs:
            # The indexed reader performs its layout/freshness recheck at the
            # actual read boundary; only plan construction is reused here.
            raw = time_capacity_path.load_indexed_time_capacity_raw(
                job.plan,
                job.requested_cycles,
                requested_columns=job.requested_columns,
                diagnostics={},
                wait_for_layout=True,
            )
            if raw is None:
                raise RuntimeError("reused layout descriptor read became unavailable")
            candidate_digests.append(_frame_digest(raw))
        candidate.append((perf_counter() - candidate_started) * 1000.0)
        parity = parity and baseline_digests == candidate_digests
    baseline_median = _median(baseline)
    candidate_median = _median(candidate)
    return {
        "candidate": "T5",
        "repetitions": repetitions,
        "fresh_plan_and_indexed_read_ms": _range(baseline),
        "reused_plan_indexed_read_ms": _range(candidate),
        "delta_pct": _pct(baseline_median, candidate_median),
        "raw_digest_equal": parity,
        "freshness_recheck": "load_indexed_time_capacity_raw(wait_for_layout=True)",
        "classification": "promote"
        if parity and baseline_median is not None and candidate_median is not None and candidate_median <= baseline_median * (1.0 - IMPROVEMENT_THRESHOLD)
        else "retain_support",
        "reason": "validated request-local indexed plans are reused; the reader still performs the publication/freshness boundary check",
    }


def _capacity_breakdown(captured: CapturedWorkload, repetitions: int) -> dict[str, Any]:
    from app.services import analysis_engine, time_capacity_derived, time_capacity_path

    rows: list[dict[str, float]] = []
    settings = _settings(captured)
    for payload, job in zip(captured.payloads, captured.jobs):
        raw = payload.raw.copy()
        raw, _exact, _sorted = _selected_frame(raw, settings, set())
        for _ in range(repetitions):
            timings: dict[str, float] = {}
            started = perf_counter()
            prepared = time_capacity_path.load_indexed_time_capacity_derived(
                job.plan,
                job.requested_cycles,
                ["phase_code", "phase_capacity_mah"],
                diagnostics={},
                wait_for_layout=True,
            )
            timings["prepared_derived_read_decode"] = (perf_counter() - started) * 1000.0
            started = perf_counter()
            aligned = analysis_engine._aligned_prepared_transform_values(raw, prepared, need_capacity=True)
            timings["alignment_join_index_matching"] = (perf_counter() - started) * 1000.0
            if aligned is None:
                raise RuntimeError("prepared capacity alignment unexpectedly failed")
            phases, capacity = aligned
            started = perf_counter()
            decoded = time_capacity_derived.decode_phases(prepared["phase_code"].to_numpy())
            if decoded is None:
                raise RuntimeError("prepared phase code failed validation")
            timings["phase_code_materialization"] = (perf_counter() - started) * 1000.0
            started = perf_counter()
            copied_capacity = np.asarray(capacity, dtype="float64").copy()
            timings["prepared_capacity_materialization_copy"] = (perf_counter() - started) * 1000.0
            timings["fallback_validation_residual"] = max(
                0.0,
                sum(timings.values()) - timings["prepared_derived_read_decode"] - timings["alignment_join_index_matching"] - timings["phase_code_materialization"] - timings["prepared_capacity_materialization_copy"],
            )
            del phases, copied_capacity
            rows.append(timings)
    names = sorted({name for item in rows for name in item})
    return {
        "candidate": "C1",
        "repetitions": repetitions,
        "stage_medians_ms": {name: _median(item[name] for item in rows) for name in names},
        "stage_ranges_ms": {name: _range(item[name] for item in rows) for name in names},
        "classification": "retain_support",
        "reason": "the breakdown identifies alignment/materialization work; reduction needs a separately reviewed prepared-row contract",
    }


_PROCESS_ROOT: str | None = None
_PROCESS_CPU_BASE = 0.0


def _process_initializer(data_root: str) -> None:
    global _PROCESS_ROOT, _PROCESS_CPU_BASE
    _PROCESS_ROOT = data_root
    from golden_analysis_support import bind_isolated_data_root

    bind_isolated_data_root(Path(data_root))
    _PROCESS_CPU_BASE = time.process_time()


def _process_cell_worker(task: tuple[Any, Any]) -> dict[str, Any]:
    job, request = task
    import profile_time_capacity_concurrency as worker_concurrency

    started = perf_counter()
    payload = worker_concurrency._materialize_read(job, perf_counter())
    result, diagnostics = worker_concurrency._resolved_cell_result(job, payload, request)
    return {
        "index": job.index,
        "result": result,
        "digest": _payload_digest(result),
        "rows": sum(len(value) for value in result.get("trace", {}).values() if isinstance(value, list)),
        "pid": os.getpid(),
        "worker_wall_ms": (perf_counter() - started) * 1000.0,
        "cpu_seconds": max(0.0, time.process_time() - _PROCESS_CPU_BASE),
        "diagnostic_keys": sorted(diagnostics.keys()),
    }


def _merge_process_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Perform the deterministic owner-side result assembly used by T19/T20."""

    ordered = sorted(results, key=lambda item: int(item["index"]))
    cell_results = [item["result"] for item in ordered]
    badges: list[Any] = []
    for result in cell_results:
        badges.extend(deepcopy(result.get("badges") or []))
    return {
        "cell_traces": [deepcopy(result.get("trace")) for result in cell_results],
        "badges": badges,
        "voltage_facts": [
            fact
            for result in cell_results
            for fact in (result.get("voltage_facts") or [])
        ],
        "source_versions": [
            version
            for result in cell_results
            for version in (result.get("source_versions") or [])
        ],
        "current_parser_versions": [
            version
            for result in cell_results
            for version in (result.get("current_parser_versions") or [])
        ],
    }


def _serial_cell_control(captured: CapturedWorkload, repetitions: int) -> tuple[list[str], dict[str, Any]]:
    digests: list[str] = []
    walls: list[float] = []
    merged_digest: str | None = None
    order: list[int] = []
    for _ in range(repetitions):
        started = perf_counter()
        current: list[str] = []
        results: list[dict[str, Any]] = []
        for job in captured.jobs:
            payload = concurrency._materialize_read(job, perf_counter())
            result, _diagnostics = concurrency._resolved_cell_result(job, payload, captured.request)
            current.append(_payload_digest(result))
            results.append({"index": job.index, "result": result})
        merged = _merge_process_results(results)
        # Include final owner JSON body assembly in the comparable serial
        # control.  This is the body that a composed output strategy would
        # persist/return; badges remain part of the small owner header in the
        # production route, but the benchmark keeps the assembly explicit.
        _ = json.dumps(merged, separators=(",", ":"), allow_nan=False).encode("utf-8")
        walls.append((perf_counter() - started) * 1000.0)
        if not digests:
            digests = current
            merged_digest = _payload_digest(merged)
            order = [int(item["index"]) for item in sorted(results, key=lambda item: item["index"])]
        elif current != digests:
            raise RuntimeError("serial whole-Cell control was not deterministic")
        elif _payload_digest(merged) != merged_digest:
            raise RuntimeError("serial parent assembly was not deterministic")
    return digests, {
        "steady_state_ms": _range(walls),
        "median_ms": _median(walls),
        "merged_digest": merged_digest,
        "cell_order": order,
    }


def _process_ablation(captured: CapturedWorkload, repetitions: int) -> list[dict[str, Any]]:
    serial_digests, serial_timing = _serial_cell_control(captured, repetitions)
    tasks = [(job, captured.request) for job in captured.jobs]
    serialized_bytes = len(pickle.dumps(tasks, protocol=pickle.HIGHEST_PROTOCOL))
    rows: list[dict[str, Any]] = []
    context = multiprocessing.get_context("spawn")
    for workers in (2, 4):
        if len(tasks) < workers:
            rows.append({"candidate": "T19" if workers == 2 else "T20", "workers": workers, "classification": "reject", "reason": "fewer selected Cells than the worker count"})
            continue
        startup_started = perf_counter()
        with ProcessPoolExecutor(
            max_workers=workers,
            mp_context=context,
            initializer=_process_initializer,
            initargs=(str(captured.data_root),),
        ) as pool:
            # The parent environment's root is attached by the caller below;
            # the warmup verifies that the resident pool can read the same
            # immutable cache descriptors before steady-state timing.
            try:
                warm = list(pool.map(_process_cell_worker, tasks))
            except Exception as exc:
                rows.append({"candidate": "T19" if workers == 2 else "T20", "workers": workers, "classification": "reject", "reason": f"process control unavailable: {type(exc).__name__}: {exc}"})
                continue
            startup_ms = (perf_counter() - startup_started) * 1000.0
            samples: list[float] = []
            receive_samples: list[float] = []
            merge_samples: list[float] = []
            body_samples: list[float] = []
            output_ipc_sizes: list[int] = []
            worker_wall_samples: list[float] = []
            parity = True
            order_parity = True
            cpu_by_pid: dict[int, float] = {
                int(item["pid"]): float(item["cpu_seconds"])
                for item in warm
            }
            cpu_samples: list[float] = []
            rss_samples: list[float] = []
            parent_rss_samples: list[float] = []
            for _ in range(repetitions):
                parent_before = None
                try:
                    import psutil

                    parent_before = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
                except Exception:
                    pass
                started = perf_counter()
                results = list(pool.map(_process_cell_worker, tasks))
                receive_ms = (perf_counter() - started) * 1000.0
                merge_started = perf_counter()
                merged = _merge_process_results(results)
                merge_ms = (perf_counter() - merge_started) * 1000.0
                body_started = perf_counter()
                _ = json.dumps(merged, separators=(",", ":"), allow_nan=False).encode("utf-8")
                body_ms = (perf_counter() - body_started) * 1000.0
                receive_samples.append(receive_ms)
                merge_samples.append(merge_ms)
                body_samples.append(body_ms)
                samples.append(receive_ms + merge_ms + body_ms)
                output_ipc_sizes.append(len(pickle.dumps(results, protocol=pickle.HIGHEST_PROTOCOL)))
                worker_wall_samples.append(sum(float(item.get("worker_wall_ms") or 0.0) for item in results))
                parity = parity and [item["digest"] for item in results] == serial_digests
                order_parity = order_parity and [int(item["index"]) for item in sorted(results, key=lambda item: item["index"])] == serial_timing["cell_order"] and _payload_digest(merged) == serial_timing["merged_digest"]
                cpu_total = 0.0
                for item in results:
                    pid = int(item["pid"])
                    current = float(item["cpu_seconds"])
                    cpu_total += max(0.0, current - cpu_by_pid.get(pid, 0.0))
                    cpu_by_pid[pid] = current
                cpu_samples.append(cpu_total)
                try:
                    import psutil

                    rss_samples.append(
                        sum(process.memory_info().rss for process in psutil.Process().children(recursive=False)) / (1024 * 1024)
                    )
                    parent_after = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
                    if parent_before is not None:
                        parent_rss_samples.append(parent_after)
                except Exception:
                    pass
            median = _median(samples)
            rows.append({
                "candidate": "T19" if workers == 2 else "T20",
                "workers": workers,
                "startup_and_warmup_ms": startup_ms,
                "steady_state_ms": _range(samples),
                "receive_unpickle_ms": _range(receive_samples),
                "parent_merge_ms": _range(merge_samples),
                "parent_body_assembly_ms": _range(body_samples),
                "serial_control_ms": serial_timing["steady_state_ms"],
                "ipc_descriptor_bytes": serialized_bytes,
                "ipc_output_result_bytes": _range_int(output_ipc_sizes),
                "worker_result_wall_ms": _range(worker_wall_samples),
                "worker_rss_evidence": _range(rss_samples) if rss_samples else "not available without psutil",
                "parent_rss_evidence": _range(parent_rss_samples) if parent_rss_samples else "not available without psutil",
                "worker_cpu_seconds": _range(cpu_samples),
                "effective_cores": _median(cpu_samples) / (median / 1000.0) if cpu_samples and median else None,
                "scientific_digest_equal": parity and [item["digest"] for item in warm] == serial_digests,
                "merged_result_digest_equal": order_parity,
                "deterministic_cell_order": order_parity,
                "effective_core_evidence": "approximate sum of per-worker process-time deltas divided by steady-state wall; scheduler/native-thread effects are not inferred",
                "classification": "retain_support" if parity and order_parity and median is not None else "reject",
                "reason": "actual compact Cell results cross IPC; steady state includes receive/unpickle, deterministic parent merge and final assembly",
            })
    return rows


def _rust_display_ablation(captured: CapturedWorkload, repetitions: int) -> dict[str, Any]:
    """Run the benchmark-only coarse native display-preparation boundary."""

    library_names = (
        "cellxplorer_05013_time_capacity_display.dll",
        "libcellxplorer_05013_time_capacity_display.so",
        "libcellxplorer_05013_time_capacity_display.dylib",
    )
    library = next(
        (
            path
            for name in library_names
            for path in (ROOT / "scripts" / "rust_time_capacity_display" / "target" / "release" / name,)
            if path.is_file()
        ),
        None,
    )
    if library is None:
        return {
            "status": "NOT RUN",
            "reason": "native benchmark library was not built; no production dependency is inferred",
            "build_command": "cargo build --release --manifest-path scripts/rust_time_capacity_display/Cargo.toml",
        }

    from app.services import analysis_engine

    native = ctypes.CDLL(str(library))
    function = native.cx_time_capacity_display_prepare
    pointer = ctypes.c_void_p
    function.argtypes = [
        pointer,
        ctypes.c_size_t,
        ctypes.c_int64,
        ctypes.c_int64,
        pointer,
        ctypes.c_size_t,
        pointer,
        pointer,
        pointer,
        pointer,
        pointer,
        pointer,
        pointer,
        ctypes.c_size_t,
        pointer,
    ]
    function.restype = ctypes.c_size_t
    settings = _settings(captured)
    frames = _raw_frames(captured)
    rows: list[dict[str, Any]] = []
    for frame in frames:
        selected, _exact, _sorted = _selected_frame(frame, settings, set())
        cycles = selected["cycle"].to_numpy(dtype="int64")
        voltage = selected["voltage_v"].to_numpy(dtype="float64")
        time_s = selected["time_s"].to_numpy(dtype="float64")
        order = {value: index for index, value in enumerate(settings.get("_source_order") or [])}
        source_index = np.asarray(
            [order.get(value, -1) for value in selected["source_hash"].to_numpy(dtype=object)],
            dtype="int32",
        )
        visible = np.isfinite(voltage)
        max_points = int(settings.get("max_points_per_cell") or 4000)
        if len(selected) > max_points:
            take = analysis_engine._downsample_indices(len(selected), max_points, visible, [voltage])
            boundaries = (
                np.flatnonzero(selected["segment"].to_numpy()[1:] != selected["segment"].to_numpy()[:-1]) + 1
                if "segment" in selected.columns and len(selected) > 1
                else np.array([], dtype="int64")
            )
            take = np.unique(np.concatenate((take, boundaries))).astype("uint64")
        else:
            take = np.arange(len(selected), dtype="uint64")
        expected_voltage = np.take(voltage, take)
        expected_time = np.take(time_s, take)
        expected_cycles = np.take(cycles, take)
        expected_source = np.take(source_index, take)
        cycle_start = int(settings.get("cycle_start") if settings.get("cycle_start") is not None else int(cycles.min()))
        cycle_end = int(settings.get("cycle_end") if settings.get("cycle_end") is not None else int(cycles.max()))
        for workers in (1, 2, 4):
            native_times: list[float] = []
            boundary_times: list[float] = []
            parity = True
            eligible = None
            for _ in range(repetitions + 1):
                out_voltage = np.empty(len(take), dtype="float64")
                out_time = np.empty(len(take), dtype="float64")
                out_cycles = np.empty(len(take), dtype="int64")
                out_source = np.empty(len(take), dtype="int32")
                eligible_out = ctypes.c_size_t(0)
                started = perf_counter()
                returned = function(
                    cycles.ctypes.data_as(pointer),
                    cycles.size,
                    cycle_start,
                    cycle_end,
                    take.ctypes.data_as(pointer),
                    take.size,
                    voltage.ctypes.data_as(pointer),
                    time_s.ctypes.data_as(pointer),
                    source_index.ctypes.data_as(pointer),
                    out_voltage.ctypes.data_as(pointer),
                    out_time.ctypes.data_as(pointer),
                    out_cycles.ctypes.data_as(pointer),
                    out_source.ctypes.data_as(pointer),
                    workers,
                    ctypes.byref(eligible_out),
                )
                native_ms = (perf_counter() - started) * 1000.0
                if not native_times:
                    eligible = int(eligible_out.value)
                parity = parity and int(returned) == len(take)
                parity = parity and np.array_equal(out_voltage, expected_voltage, equal_nan=True)
                parity = parity and np.array_equal(out_time, expected_time, equal_nan=True)
                parity = parity and np.array_equal(out_cycles, expected_cycles)
                parity = parity and np.array_equal(out_source, expected_source)
                if _ >= 1:
                    native_times.append(native_ms)
                    copy_started = perf_counter()
                    _ = (out_voltage.tolist(), out_time.tolist(), out_cycles.tolist(), out_source.tolist())
                    boundary_times.append((perf_counter() - copy_started) * 1000.0)
            python_times: list[float] = []
            for _ in range(repetitions):
                started = perf_counter()
                _ = (np.take(voltage, take), np.take(time_s, take), np.take(cycles, take), np.take(source_index, take))
                python_times.append((perf_counter() - started) * 1000.0)
            native_median = _median(native_times)
            python_median = _median(python_times)
            rows.append(
                {
                    "candidate": "T22" if workers == 1 else "T23",
                    "workers": workers,
                    "input_rows": len(selected),
                    "returned_points": len(take),
                    "eligible_rows": eligible,
                    "native_call_ms": _range(native_times),
                    "native_boundary_copy_ms": _range(boundary_times),
                    "python_numpy_gather_ms": _range(python_times),
                    "delta_pct": _pct(python_median, native_median),
                    "scientific_digest_equal": parity,
                    "classification": "retain_support"
                    if parity and native_median is not None
                    else "reject",
                    "reason": "coarse cycle eligibility plus compact final gather; worker count is bounded to 1/2/4",
                }
            )
    return {
        "status": "PASS",
        "library": str(library),
        "boundary": "cycle-range filter + exact display take + compact voltage/time/cycle/source transfer",
        "rows": rows,
    }


def _rust_process_control() -> dict[str, Any]:
    return {
        "candidate": "T24",
        "status": "NOT RUN",
        "classification": "retain_support",
        "reason": "A resident Rust process would require a new framed request/response protocol, lifecycle/error/restart semantics and a second owner merge boundary; the bounded in-process control is measured instead",
        "not_analogous_to_05010": True,
    }


def _serial_stack_ablation(
    captured: CapturedWorkload,
    baselines: list[ProjectionSample],
    repetitions: int,
) -> dict[str, Any]:
    """Time one actual serial/do-less-work projection stack."""

    frames = _raw_frames(captured)
    settings = _settings(captured)
    candidate = "T1+T6+T7+T8+T11+T14"
    rows = [
        _measure_projection(frame, settings, candidate, baseline, repetitions)
        for frame, baseline in zip(frames, baselines)
    ]
    return {
        "stack": "W1",
        "candidate": candidate,
        "actual_mechanisms": ["phase-free ordinary target", "planner order invariant", "indexed exact selection invariant", "owner cycle maps", "vectorized downsample + direct gather", "vectorized JSON-safe list conversion"],
        "boundary": "six per-Cell compact projection calls over real S25",
        "wall_ms": _range(item["wall_ms"]["median_ms"] for item in rows),
        "baseline_wall_ms": sum(sum(item.stage_ms.values()) for item in baselines),
        "delta_pct": _pct(
            sum(sum(item.stage_ms.values()) for item in baselines),
            sum(float(item["wall_ms"]["median_ms"]) for item in rows),
        ),
        "consumer_semantics_equal": all(item["consumer_semantics_equal"] for item in rows),
        "trace_order_equal": all(item["trace_order_equal"] for item in rows),
        "complete_route": False,
        "classification": "measured",
    }


def _composition_summary(
    serial_stack: dict[str, Any],
    one_body: dict[str, Any],
    process_rows: list[dict[str, Any]],
    native: dict[str, Any],
    repetitions: int,
) -> list[dict[str, Any]]:
    """Assemble only boundaries that were actually executed and measured."""

    rows: list[dict[str, Any]] = [serial_stack]
    rows.append(
        {
            "stack": "W2",
            "candidate": "W1+T16",
            "actual_mechanisms": ["complete S25 route", "one authoritative cache/HTTP body"],
            "boundary": "router miss, scientific body persistence and HTTP response",
            "wall_ms": one_body.get("one_body_complete_route_ms"),
            "baseline_wall_ms": one_body.get("a0_complete_route_ms"),
            "delta_pct": one_body.get("delta_pct"),
            "consumer_semantics_equal": one_body.get("scientific_semantics_equal"),
            "complete_route": True,
            "classification": one_body.get("classification"),
        }
    )
    for item in process_rows:
        workers = item.get("workers")
        rows.append(
            {
                "stack": "W3" if workers == 2 else "W4",
                "candidate": f"W1+T{19 if workers == 2 else 20}",
                "actual_mechanisms": ["persistent process pool", "actual compact result IPC", "owner order merge", "one final JSON body assembly"],
                "boundary": "six-Cell whole-result process control",
                "wall_ms": item.get("steady_state_ms"),
                "baseline_wall_ms": item.get("serial_control_ms"),
                "delta_pct": _pct(
                    item.get("serial_control_ms", {}).get("median_ms") if isinstance(item.get("serial_control_ms"), dict) else None,
                    item.get("steady_state_ms", {}).get("median_ms") if isinstance(item.get("steady_state_ms"), dict) else None,
                ),
                "consumer_semantics_equal": item.get("scientific_digest_equal") and item.get("merged_result_digest_equal"),
                "complete_route": False,
                "classification": item.get("classification"),
            }
        )
    native_rows = native.get("rows") if isinstance(native, dict) else []
    for item in native_rows:
        if item.get("workers") not in {1, 2, 4}:
            continue
        rows.append(
            {
                "stack": "W5" if item.get("workers") == 1 else "W5-rayon",
                "candidate": item.get("candidate"),
                "actual_mechanisms": ["native cycle eligibility pass", "exact display take", "compact output transfer"],
                "boundary": "coarse in-process native display preparation",
                "wall_ms": item.get("native_call_ms"),
                "baseline_wall_ms": item.get("python_numpy_gather_ms"),
                "delta_pct": item.get("delta_pct"),
                "consumer_semantics_equal": item.get("scientific_digest_equal"),
                "complete_route": False,
                "classification": item.get("classification"),
            }
        )
    rows.append(
        {
            "stack": "FINAL",
            "candidate": "simplest evidence-backed choice",
            "actual_mechanisms": ["selection is based on the measured rows above"],
            "boundary": "decision record only; no unmeasured cross-boundary claim",
            "complete_route": False,
            "classification": "retain_support",
            "reason": "the benchmark ranks serial, one-body, process and native boundaries separately; production composition remains a later child",
        }
    )
    return rows


def _run_correction_suite(
    env: Any,
    base: dict[str, Any],
    cell_ids: list[int],
    analysis_id: int,
    repetitions: int,
) -> dict[str, Any]:
    """R1/R2 correction wave: real S25 plus one small-cycle control."""

    target = _capture_workload(env, base, "S25-6-time", cell_ids[:6], cycle_end=48)
    small = _capture_workload(env, base, "small-1-cycles-1-3-time", cell_ids[:1], cycle_end=3)
    frames = _raw_frames(target)
    settings = _settings(target)
    baselines = [_projection(frame, settings, "A0") for frame in frames]
    projection = _projection_ablation(target, repetitions, baselines=baselines)
    small_frames = _raw_frames(small)
    small_settings = _settings(small)
    small_baseline = _projection(small_frames[0], small_settings, "A0")
    small_control = {
        "workload": small.name,
        "rows": [
            _measure_projection(small_frames[0], small_settings, candidate, small_baseline, repetitions)
            for candidate in ("T1", "T12", "T13")
        ],
    }
    serializer = _serializer_ablation(baselines[0], repetitions)
    identity = _identity_ablation(env, base, cell_ids[:6], repetitions)
    owner_reuse = _owner_reuse_ablation(env, base, cell_ids[:6], repetitions)
    layout_reuse = _layout_descriptor_ablation(target, repetitions)
    mapping = _cycle_mapping_ablation(target, repetitions)
    write_behind = _write_behind_ablation(baselines[0], repetitions)
    route_reference_row, route_reference = ordinary.run_profiled_route_sample(
        env,
        analysis_id,
        None,
        scenario="S25-6-time-correction-warmup",
    )
    one_body = _one_body_route_ablation(env, analysis_id, route_reference, repetitions)
    process_rows = _process_ablation(target, repetitions)
    native = _rust_display_ablation(target, repetitions)
    capacity = _capacity_breakdown(
        _capture_workload(env, base, "S25-6-capacity", cell_ids[:6], cycle_end=48, x_axis="capacity_mah"),
        repetitions,
    )
    serial_stack = _serial_stack_ablation(target, baselines, repetitions)
    composition = _composition_summary(serial_stack, one_body, process_rows, native, repetitions)
    return {
        "authoritative_workload": {
            "name": target.name,
            "cells": len(target.jobs),
            "cycle_end": 48,
            "x_axis": "time",
            "view": "voltage_current",
            "display_mode": settings.get("display_mode"),
            "precision": target.request.precision,
            "compact": target.request.compact,
            "viewport_width": target.request.viewport_width,
        },
        "small_control": small_control,
        "projection": projection,
        "identity": identity,
        "owner_reuse": owner_reuse,
        "layout_reuse": layout_reuse,
        "mapping": mapping,
        "serializer": serializer,
        "one_body_route": one_body,
        "write_behind": write_behind,
        "process_controls": process_rows,
        "native_display": native,
        "rust_process_control": _rust_process_control(),
        "capacity_control": capacity,
        "composition": composition,
        "route_warmup": {
            "status": route_reference_row.get("status"),
            "wall_ms": route_reference_row.get("backend_wall_ms"),
            "reference_digest": ordinary.scientific_digest(route_reference),
        },
        "repetitions": repetitions,
    }


def _candidate_catalog() -> list[dict[str, Any]]:
    return [
        {"candidate": "T1", "wave": 1, "boundary": "phase classification", "mode": "measured", "reason": "phase is omitted only for compact ordinary voltage_current/time/consecutive; alternate consumers retain the canonical phase path"},
        {"candidate": "T2", "wave": 1, "boundary": "scalar metadata", "mode": "reject", "reason": "active mass, nominal capacity and electrode area remain part of the trace contract and capacity-axis semantics"},
        {"candidate": "T3", "wave": 1, "boundary": "owner Cell/source resolution", "mode": "measured", "reason": "fresh owner resolution is compared with reuse of immutable resolved jobs and actual per-Cell reads/transforms"},
        {"candidate": "T4", "wave": 1, "boundary": "cache identity", "mode": "measured", "reason": "measure shared-fingerprint proxy; result-key render options intentionally differ"},
        {"candidate": "T5", "wave": 1, "boundary": "raw layout/index descriptor", "mode": "measured", "reason": "fresh plan construction is compared with request-local plan reuse while indexed reads keep wait_for_layout freshness checks"},
        {"candidate": "T6", "wave": 1, "boundary": "raw record ordering", "mode": "measured", "reason": "only safe when the indexed reader order is proven equivalent to cycle/segment/record order"},
        {"candidate": "T7", "wave": 1, "boundary": "exact cycle filtering", "mode": "measured", "reason": "only safe when indexed requested-cycle selection is exact"},
        {"candidate": "T8", "wave": 1, "boundary": "cycle mapping", "mode": "measured", "reason": "bounded dense lookup candidate with a fail-closed span gate"},
        {"candidate": "T9", "wave": 2, "boundary": "downsample index selection", "mode": "measured", "reason": "independent envelope implementation"},
        {"candidate": "T10", "wave": 2, "boundary": "post-downsample gather", "mode": "measured", "reason": "direct array take avoids the central pandas iloc gather"},
        {"candidate": "T11", "wave": 2, "boundary": "fused downsample/gather", "mode": "measured", "reason": "composition of T9 and T10"},
        {"candidate": "T12", "wave": 2, "boundary": "compact arrays", "mode": "measured", "reason": "display_x canonicality is measured, but frontend fallback/export consumers keep this supporting-only"},
        {"candidate": "T13", "wave": 2, "boundary": "provenance projection", "mode": "measured", "reason": "index/table encoding is reconstructed in the benchmark but not wired to the existing frontend contract"},
        {"candidate": "T14", "wave": 2, "boundary": "ndarray to Python list", "mode": "measured", "reason": "same null and rounding semantics"},
        {"candidate": "T15", "wave": 2, "boundary": "NumPy-aware JSON serializer", "mode": "measured", "reason": "benchmark-only NumPy/list conversion plus orjson semantics; production packaging is unchanged"},
        {"candidate": "T16", "wave": 2, "boundary": "one authoritative JSON body", "mode": "measured", "reason": "complete S25 route uses one scientific body for cache persistence and HTTP response with a separate header splice"},
        {"candidate": "T17", "wave": 2, "boundary": "bounded write-behind", "mode": "measured", "reason": "fixed immutable bytes/key compare synchronous, one-encode synchronous and bounded queue critical paths"},
        {"candidate": "T18", "wave": 2, "boundary": "adaptive point budget", "mode": "measured", "reason": "backend-only point/byte evidence; visual equivalence remains an external gate"},
        {"candidate": "T19", "wave": 3, "boundary": "persistent Python process pool", "mode": "measured", "reason": "two resident workers receive immutable descriptors and reopen indexed caches"},
        {"candidate": "T20", "wave": 3, "boundary": "persistent Python process pool", "mode": "measured", "reason": "four resident workers receive immutable descriptors and reopen indexed caches"},
        {"candidate": "T21", "wave": 3, "boundary": "workload-gated process pool", "mode": "retain_support", "reason": "only becomes meaningful if T19/T20 win complete-route evidence; no timing-history heuristic is introduced"},
        {"candidate": "T22", "wave": 3, "boundary": "in-process Rust/PyO3", "mode": "measured", "reason": "benchmark-only coarse cycle eligibility plus compact display gather with exact output parity"},
        {"candidate": "T23", "wave": 3, "boundary": "Rust/Rayon display kernel", "mode": "measured", "reason": "same coarse native boundary is measured sequentially and with bounded Rayon 2/4 workers"},
        {"candidate": "T24", "wave": 3, "boundary": "persistent Rust subprocess", "mode": "supporting-proof", "reason": "not run: a resident process needs a new framed protocol, lifecycle/error/restart semantics and another owner merge boundary; this concrete cost is recorded"},
        {"candidate": "C1", "wave": 4, "boundary": "prepared capacity residual", "mode": "measured", "reason": "decomposes prepared read, alignment, phase-code and capacity-copy costs"},
    ]


def _sanitize_route_result(item: dict[str, Any]) -> dict[str, Any]:
    samples = []
    for sample in item.get("samples", []):
        samples.append({
            key: sample.get(key)
            for key in (
                "backend_wall_ms", "profiled_route_wall_ms", "profiling_overhead_ms",
                "request_total_ms", "request_residual_ms", "response_serialization_ms",
                "request_stages_ms", "request_sql", "cache_store_stages_ms", "engine_timing",
                "status", "cell_count",
            )
            if key in sample
        })
    return {
        key: item.get(key)
        for key in ("scenario", "cell_count", "repetitions", "backend_median_ms", "backend_range_ms", "reference_digest", "canonical_output_order")
        if key in item
    } | {"samples": samples}


def _route_baselines(env: Any, base: dict[str, Any], cell_ids: list[int], repetitions: int, *, fixture: bool) -> dict[str, Any]:
    workloads = [
        {
            "scenario": "ordinary-6-all-time",
            "cell_ids": cell_ids[:6],
            "cycles": [],
            "cycle_end": None,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        },
        {
            "scenario": "ordinary-6-all-capacity",
            "cell_ids": cell_ids[:6],
            "cycles": [],
            "cycle_end": None,
            "x_axis": "capacity_mah",
            "view": "voltage_current",
            "range_transition": None,
        },
        {
            "scenario": "ordinary-1-cycles-1-3-time",
            "cell_ids": cell_ids[:1],
            "cycles": [1, 2, 3],
            "cycle_end": 3,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        },
    ]
    for count in (10, 11):
        if len(cell_ids) >= count:
            workloads.insert(
                1,
                {
                    "scenario": f"ordinary-{count}-all-time",
                    "cell_ids": cell_ids[:count],
                    "cycles": [],
                    "cycle_end": None,
                    "x_axis": "time",
                    "view": "voltage_current",
                    "range_transition": None,
                },
            )
    results = []
    for workload in workloads:
        print(f"profiling {'fixture' if fixture else 'application'}/{workload['scenario']}", flush=True)
        result = ordinary.profile_workload(env, base, workload, repetitions=repetitions)
        results.append(_sanitize_route_result(result))
    return {"workloads": results}


def _synthetic_route_baselines(env: Any, base: dict[str, Any], cell_ids: list[int], repetitions: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for tier, cycle_end in SYNTHETIC_TIERS:
        workload = {
            "scenario": f"{tier}-6-all-time",
            "cell_ids": cell_ids[:6],
            "cycles": [],
            "cycle_end": cycle_end,
            "x_axis": "time",
            "view": "voltage_current",
            "range_transition": None,
        }
        print(f"profiling synthetic/{workload['scenario']}", flush=True)
        results.append(_sanitize_route_result(ordinary.profile_workload(env, base, workload, repetitions=repetitions)))
    return results


def _run_suite(env: Any, base: dict[str, Any], cell_ids: list[int], repetitions: int, *, include_process: bool) -> dict[str, Any]:
    captured: dict[str, CapturedWorkload] = {}
    for tier, cycle_end in SYNTHETIC_TIERS:
        name = f"{tier}-6-time"
        captured[name] = _capture_workload(env, base, name, cell_ids[:6], cycle_end=cycle_end)
    captured["S25-6-capacity"] = _capture_workload(env, base, "S25-6-capacity", cell_ids[:6], cycle_end=48, x_axis="capacity_mah")

    ablations = {
        name: _projection_ablation(item, repetitions)
        for name, item in captured.items()
        if name.endswith("-6-time") or name == "S25-6-capacity"
    }
    serialization = _serializer_ablation(
        _projection(_raw_frames(captured["S25-6-time"])[0], _settings(captured["S25-6-time"]), "A0"),
        repetitions,
    )
    identity = _identity_ablation(env, base, cell_ids[:6], repetitions)
    mapping = _cycle_mapping_ablation(captured["S25-6-time"], repetitions)
    capacity = _capacity_breakdown(captured["S25-6-capacity"], repetitions)
    processes = _process_ablation(captured["S25-6-time"], repetitions) if include_process else [{"status": "NOT RUN", "reason": "--skip-process"}]

    target = captured["S25-6-time"]
    target_frames = _raw_frames(target)
    target_settings = _settings(target)
    target_baselines = [_projection(frame, target_settings, "A0") for frame in target_frames]
    serial_stack = _serial_stack_ablation(target, target_baselines, repetitions)
    composition = [
        serial_stack,
        {
            "stack": "W2/W3/W4/W5",
            "status": "NOT RUN IN BROAD LEGACY MATRIX",
            "reason": "complete route/process/native compositions are executed only by --correction on authoritative S25; no proxy stack is reported here",
        },
    ]

    return {
        "route_baseline": {"synthetic_workloads": _synthetic_route_baselines(env, base, cell_ids, repetitions)},
        "synthetic_tiers": {
            tier: {
                "cycle_end": cycle_end,
                "workload": f"{tier}-6-time",
                "rows_per_cell": ablations[f"{tier}-6-time"]["rows_per_cell"],
                "returned_points_per_cell": ablations[f"{tier}-6-time"]["baseline"]["returned_points"],
                "downsampling_active": all(points < rows for points, rows in zip(ablations[f"{tier}-6-time"]["baseline"]["returned_points"], ablations[f"{tier}-6-time"]["rows_per_cell"])),
            }
            for tier, cycle_end in SYNTHETIC_TIERS
        },
        "isolated_ablation": ablations,
        "identity": identity,
        "mapping": mapping,
        "serialization": serialization,
        "capacity": capacity,
        "process_controls": processes,
        "composition": composition,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=REPETITIONS)
    parser.add_argument("--app-data-root", type=Path, default=Path.home() / ".cellxplorer")
    parser.add_argument("--fixture-only", action="store_true")
    parser.add_argument("--skip-process", action="store_true")
    parser.add_argument(
        "--correction",
        action="store_true",
        help="Run the bounded R1/R2 S25 correction wave instead of the initial broad matrix",
    )
    args = parser.parse_args()
    if args.correction and args.repetitions < 1:
        parser.error("correction evidence requires at least one warm repetition")
    if not args.correction and args.repetitions < 5:
        parser.error("050.13 final evidence requires at least five warm repetitions")

    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    base = load_case_spec(
        fixture_root,
        {"id": "time_capacity_profile", "kind": "time_capacity", "spec_path": "specs/time_capacity_baseline.json"},
    )
    saved_data_root = os.environ.get("CELLXPLORER_DATA")
    if args.correction:
        evidence: dict[str, Any] = {
            "spec": "050.13",
            "status": "PASS",
            "mode": "R1/R2 correction",
            "repetitions": args.repetitions,
            "host_logical_cpus": os.cpu_count() or 1,
            "candidate_catalog": _candidate_catalog(),
            "correction_scope": {
                "authoritative": "real application S25, six Cells, Time, Consecutive, compact, 1200 px",
                "small_control": "one Cell, cycles 1-3",
                "secondary": "S25 six-Cell Capacity only for capacity residual control",
                "excluded": ["S100", "S50", "full real 1/6/10/11-Cell matrix"],
                "default_repetitions": 3,
            },
            "verification_commands": [
                "python scripts/profile_time_capacity_ablation.py --correction --repetitions 3 --output tmp/050.13-correction.json",
                "python -m unittest tests.test_time_capacity_ablation",
                "python scripts/preflight.py",
            ],
            "application": {},
            "fixture": {},
            "skipped": {},
        }
        try:
            from app.models import Analysis
            from profile_time_capacity_concurrency import create_application_environment, discover_application_dataset

            if args.fixture_only:
                with GoldenFixtureEnvironment.create() as env:
                    clone_ids = clone_golden_source_cells(env, 10)
                    cells = [concurrency.GOLDEN_CELL_ID, *clone_ids]
                    spec = concurrency.make_spec(base, cells[:6], [], 48, x_axis="time", view="voltage_current")
                    analysis = Analysis(title="050.13 correction S25", spec=spec)
                    env.db.add(analysis)
                    env.db.commit()
                    evidence["fixture"]["correction"] = _run_correction_suite(
                        env, base, cells, int(analysis.id), args.repetitions
                    )
            else:
                app_root = args.app_data_root.resolve()
                if not (app_root / "cellxplorer.db").is_file():
                    evidence["skipped"]["application"] = f"database not found at {app_root / 'cellxplorer.db'}"
                else:
                    with create_application_environment(app_root) as env:
                        app_base, app_cells, metadata = discover_application_dataset(env)
                        evidence["application"]["dataset"] = {
                            key: value
                            for key, value in metadata.items()
                            if key not in {"cell_names", "source_paths", "source_hashes"}
                        }
                        if len(app_cells) < 6:
                            evidence["skipped"]["application"] = "fewer than six available Cells"
                        else:
                            spec = concurrency.make_spec(
                                app_base,
                                app_cells[:6],
                                [],
                                48,
                                x_axis="time",
                                view="voltage_current",
                            )
                            analysis = Analysis(title="050.13 correction S25", spec=spec)
                            env.db.add(analysis)
                            env.db.commit()
                            evidence["application"]["correction"] = _run_correction_suite(
                                env, app_base, app_cells, int(analysis.id), args.repetitions
                            )
        except Exception as exc:
            evidence["status"] = "FAIL"
            evidence["failure"] = {"type": type(exc).__name__, "message": str(exc)}
        finally:
            from golden_analysis_support import restore_data_root_binding

            restore_data_root_binding(saved_data_root)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps({"spec": evidence["spec"], "status": evidence["status"], "mode": evidence["mode"], "output": str(args.output)}, indent=2))
        return 0 if evidence["status"] == "PASS" else 1

    evidence: dict[str, Any] = {
        "spec": "050.13",
        "status": "PASS",
        "repetitions": args.repetitions,
        "host_logical_cpus": os.cpu_count() or 1,
        "candidate_catalog": _candidate_catalog(),
        "contracts": {
            "ordinary_request": "voltage_current / standard / compact / viewport 1200",
            "synthetic_source": "committed indexed golden source cloned into disposable Cells; S100/S50/S25 vary only broad cycle range",
            "route_baseline": "paired unprofiled 050.12 router call; profiled twin retained only for stage evidence",
            "isolated_boundary": "indexed raw frame after owner plan/read, then current per-Cell filter/transform/downsample/projection shape",
            "process_worker": "persistent spawn pool; immutable ReadJob/ResolvedRequest only; worker opens cache and creates no SQLAlchemy Session",
            "promotion": "exact digest/order parity plus at least 5% isolated improvement; complete route and manual gates remain separate",
        },
        "fixture": {},
        "application": {},
        "skipped": {},
    }
    try:
        with GoldenFixtureEnvironment.create() as env:
            clone_ids = clone_golden_source_cells(env, 10)
            fixture_cells = [concurrency.GOLDEN_CELL_ID, *clone_ids]
            evidence["fixture"]["route_baseline"] = _route_baselines(
                env, base, fixture_cells, args.repetitions, fixture=True
            )
            evidence["fixture"]["ablation"] = _run_suite(
                env, base, fixture_cells, args.repetitions, include_process=not args.skip_process
            )

        if not args.fixture_only:
            app_root = args.app_data_root.resolve()
            if not (app_root / "cellxplorer.db").is_file():
                evidence["skipped"]["application"] = f"database not found at {app_root / 'cellxplorer.db'}"
            else:
                from profile_time_capacity_concurrency import create_application_environment, discover_application_dataset

                with create_application_environment(app_root) as env:
                    app_base, app_cells, metadata = discover_application_dataset(env)
                    if len(app_cells) < 6:
                        evidence["skipped"]["application"] = "fewer than six available Cells"
                    else:
                        evidence["application"]["dataset"] = {
                            key: value for key, value in metadata.items() if key not in {"cell_names", "source_paths", "source_hashes"}
                        }
                        evidence["application"]["route_baseline"] = _route_baselines(
                            env, app_base, app_cells, args.repetitions, fixture=False
                        )
                        evidence["application"]["ablation"] = _run_suite(
                            env, app_base, app_cells, args.repetitions, include_process=not args.skip_process
                        )
    except Exception as exc:
        evidence["status"] = "FAIL"
        evidence["failure"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        from golden_analysis_support import restore_data_root_binding

        restore_data_root_binding(saved_data_root)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "spec": evidence["spec"],
        "status": evidence["status"],
        "fixture_route_workloads": len(evidence.get("fixture", {}).get("route_baseline", {}).get("workloads", [])),
        "application_present": bool(evidence.get("application")),
        "output": str(args.output),
    }, indent=2))
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())
