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
from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import pickle
import statistics
import sys
import time
from time import perf_counter
from typing import Any, Iterable

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


def _selected_frame(frame: pd.DataFrame, settings: dict[str, Any], features: set[str]) -> tuple[pd.DataFrame, bool, bool]:
    """Return the selected/sorted frame and the two candidate invariant gates."""

    selected = frame.copy()
    if settings.get("cycles"):
        exact = set(pd.to_numeric(selected["cycle"], errors="coerce").dropna().astype(int).unique()) <= set(settings["cycles"])
        if "T7" not in features or not exact:
            selected = selected[selected["cycle"].isin(settings["cycles"])]
    else:
        exact = True
        if settings.get("cycle_start") is not None:
            exact = exact and bool((selected["cycle"] >= int(settings["cycle_start"])).all())
            if "T7" not in features or not exact:
                selected = selected[selected["cycle"] >= int(settings["cycle_start"])]
        if settings.get("cycle_end") is not None:
            exact = exact and bool((selected["cycle"] <= int(settings["cycle_end"])).all())
            if "T7" not in features or not exact:
                selected = selected[selected["cycle"] <= int(settings["cycle_end"])]
    sorted_invariant = _is_sorted_by_production_order(selected)
    if "T6" not in features or not sorted_invariant:
        selected = selected.sort_values(_sort_columns(selected), kind="stable")
    return selected.reset_index(drop=True), exact, sorted_invariant


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
    selected, exact_selection, sorted_invariant = _selected_frame(frame, settings, features)
    stage_ms["filter_sort"] = (perf_counter() - started) * 1000.0

    started = perf_counter()
    if "T1" not in features:
        phases = analysis_engine._phase_from_raw(selected)
    else:
        phases = ["rest"] * len(selected)
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
    if "T18" in features:
        max_points = max(400, int(round(max_points * max(320, viewport_width) / 1200.0)))
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
    selected_time = take_column("time_s")
    selected_cycle = take_column("cycle", "float64")
    selected_capacity = capacity[take] if capacity is not None else np.full(len(take), np.nan)
    if selected_frame is not None:
        source_hash = selected_frame["source_hash"].tolist() if "source_hash" in selected_frame else [None] * len(take)
        source_cycle = selected_frame["source_cycle"].tolist() if "source_cycle" in selected_frame else [None] * len(take)
        source_position = [None] * len(take)
    else:
        source_hash = selected["source_hash"].to_numpy(dtype=object)[take].tolist() if "source_hash" in selected else [None] * len(take)
        source_cycle = selected["source_cycle"].to_numpy(dtype=object)[take].tolist() if "source_cycle" in selected else [None] * len(take)
        source_position = [None] * len(take)
    stage_ms["gather"] = (perf_counter() - started) * 1000.0

    safe = _jsonsafe_plot_vectorized if "T14" in features else _jsonsafe_plot
    payload: dict[str, Any] = {
        "cycle": _jsonsafe_int(selected_cycle),
        "display_x": safe(selected_display_x, 6),
        "time_s": safe(selected_time, 3),
        "capacity_mah": safe(selected_capacity, 6),
        "voltage_v": safe(selected_voltage, 5),
        "current_ma": safe(selected_current, 5),
        "phase": list(np.asarray(phases, dtype=object)[take]),
        "source_cycle": source_cycle,
        "source_position": source_position,
        "source_hash": source_hash,
        "source_boundary_indices": [int(index) for index in np.flatnonzero(np.diff(take) > 1)],
    }
    if "T12" in features:
        payload.pop("time_s", None)
        payload["compact_payload_note"] = "time_s omitted; display_x is canonical"
    if "T13" in features:
        hash_values = payload.pop("source_hash")
        positions: dict[object, int] = {}
        source_indices: list[int | None] = []
        for value in hash_values:
            if value is None:
                source_indices.append(None)
                continue
            positions.setdefault(value, len(positions))
            source_indices.append(positions[value])
        payload["source_index"] = source_indices
        payload["source_table_size"] = len(positions)
    payload_bytes = len(json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    digest = _payload_digest(payload, exclude={"compact_payload_note", "source_table_size", "source_index"})
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
    exact = all(sample.digest == baseline.digest for sample in [warm, *samples])
    order_equal = all(sample.trace_order_digest == baseline.trace_order_digest for sample in [warm, *samples])
    median_wall = _median(walls)
    if not exact and candidate not in {"T12", "T13", "T18"}:
        classification = "reject"
        reason = "candidate changed the exact compact payload digest"
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


def _projection_ablation(captured: CapturedWorkload, repetitions: int) -> dict[str, Any]:
    frames = _raw_frames(captured)
    settings = _settings(captured)
    baselines = [_projection(frame, settings, "A0") for frame in frames]
    candidate_ids = ("T6", "T7", "T9", "T10", "T11", "T12", "T13", "T14", "T18")
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
    }


def _identity_ablation(env: Any, base: dict[str, Any], cell_ids: list[int], repetitions: int) -> dict[str, Any]:
    from app.services import analysis_cache

    spec = concurrency.make_spec(base, cell_ids, [], None, x_axis="time", view="voltage_current")
    rows: list[dict[str, float]] = []
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
            request_options={"viewport_width": 1200, "precision": "standard", "compact": True},
        )
        render_ms = (perf_counter() - started) * 1000.0
        rows.append({"scientific_ms": scientific_ms, "render_ms": render_ms, "total_ms": scientific_ms + render_ms})
    return {
        "candidate": "T4",
        "repetitions": repetitions,
        "two_identity_passes_ms": _range(item["total_ms"] for item in rows),
        "scientific_signature_ms": _range(item["scientific_ms"] for item in rows),
        "render_key_ms": _range(item["render_ms"] for item in rows),
        "keys_are_distinct_by_contract": bool(rows and scientific != render),
        "classification": "retain_support",
        "reason": "shared fingerprint is a supporting owner optimization; the current two keys intentionally differ by render options",
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


def _serialization_ablation(sample: ProjectionSample, repetitions: int) -> dict[str, Any]:
    values = sample.payload
    one: list[float] = []
    two: list[float] = []
    for _ in range(repetitions):
        started = perf_counter()
        body = json.dumps(values, separators=(",", ":"), allow_nan=False).encode("utf-8")
        one.append((perf_counter() - started) * 1000.0)
        started = perf_counter()
        json.dumps(values, separators=(",", ":"), allow_nan=False).encode("utf-8")
        json.dumps(values, separators=(",", ":"), allow_nan=False).encode("utf-8")
        two.append((perf_counter() - started) * 1000.0)
    return {
        "candidate": "T16",
        "one_encode_ms": _range(one),
        "two_encode_ms": _range(two),
        "delta_pct": _pct(_median(two), _median(one)),
        "body_bytes": len(body),
        "scientific_digest_equal": _payload_digest(values) == _payload_digest(json.loads(body)),
        "classification": "retain_support",
        "reason": "one authoritative JSON byte construction is materially faster in isolation, but complete-route/cache-body/header integration is required before promotion",
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

    payload = worker_concurrency._materialize_read(job, perf_counter())
    result, diagnostics = worker_concurrency._resolved_cell_result(job, payload, request)
    return {
        "digest": _payload_digest(result),
        "rows": sum(len(value) for value in result.get("trace", {}).values() if isinstance(value, list)),
        "pid": os.getpid(),
        "cpu_seconds": max(0.0, time.process_time() - _PROCESS_CPU_BASE),
        "diagnostic_keys": sorted(diagnostics.keys()),
    }


def _serial_cell_control(captured: CapturedWorkload, repetitions: int) -> tuple[list[str], dict[str, Any]]:
    digests: list[str] = []
    walls: list[float] = []
    for _ in range(repetitions):
        started = perf_counter()
        current: list[str] = []
        for job in captured.jobs:
            payload = concurrency._materialize_read(job, perf_counter())
            result, _diagnostics = concurrency._resolved_cell_result(job, payload, captured.request)
            current.append(_payload_digest(result))
        walls.append((perf_counter() - started) * 1000.0)
        if not digests:
            digests = current
        elif current != digests:
            raise RuntimeError("serial whole-Cell control was not deterministic")
    return digests, {"steady_state_ms": _range(walls), "median_ms": _median(walls)}


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
            parity = True
            cpu_by_pid: dict[int, float] = {
                int(item["pid"]): float(item["cpu_seconds"])
                for item in warm
            }
            cpu_samples: list[float] = []
            rss_samples: list[float] = []
            for _ in range(repetitions):
                started = perf_counter()
                results = list(pool.map(_process_cell_worker, tasks))
                samples.append((perf_counter() - started) * 1000.0)
                parity = parity and [item["digest"] for item in results] == serial_digests
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
                except Exception:
                    pass
            median = _median(samples)
            rows.append({
                "candidate": "T19" if workers == 2 else "T20",
                "workers": workers,
                "startup_and_warmup_ms": startup_ms,
                "steady_state_ms": _range(samples),
                "serial_control_ms": serial_timing["steady_state_ms"],
                "ipc_descriptor_bytes": serialized_bytes,
                "worker_rss_evidence": _range(rss_samples) if rss_samples else "not available without psutil",
                "worker_cpu_seconds": _range(cpu_samples),
                "effective_cores": _median(cpu_samples) / (median / 1000.0) if cpu_samples and median else None,
                "scientific_digest_equal": parity and [item["digest"] for item in warm] == serial_digests,
                "effective_core_evidence": "approximate sum of per-worker process-time deltas divided by steady-state wall; scheduler/native-thread effects are not inferred",
                "classification": "retain_support" if parity and median is not None else "reject",
                "reason": "persistent process control is isolated evidence; complete-route promotion requires owner merge and memory/CPU acceptance",
            })
    return rows


def _candidate_catalog() -> list[dict[str, Any]]:
    return [
        {"candidate": "T1", "wave": 1, "boundary": "phase classification", "mode": "reject", "reason": "phase is emitted for compact traces and consumed by overlap/mirror, provenance segmentation and derivative consumers; ordinary consecutive mode alone is insufficient"},
        {"candidate": "T2", "wave": 1, "boundary": "scalar metadata", "mode": "reject", "reason": "active mass, nominal capacity and electrode area remain part of the trace contract and capacity-axis semantics"},
        {"candidate": "T3", "wave": 1, "boundary": "owner Cell/source resolution", "mode": "retain_support", "reason": "050.9 already resolves immutable descriptors in the owner; duplicate implementation would be redundant in this child"},
        {"candidate": "T4", "wave": 1, "boundary": "cache identity", "mode": "measured", "reason": "measure shared-fingerprint proxy; result-key render options intentionally differ"},
        {"candidate": "T5", "wave": 1, "boundary": "raw layout/index descriptor", "mode": "retain_support", "reason": "050.12 already records one request-local plan; freshness publication/race semantics need a production design child"},
        {"candidate": "T6", "wave": 1, "boundary": "raw record ordering", "mode": "measured", "reason": "only safe when the indexed reader order is proven equivalent to cycle/segment/record order"},
        {"candidate": "T7", "wave": 1, "boundary": "exact cycle filtering", "mode": "measured", "reason": "only safe when indexed requested-cycle selection is exact"},
        {"candidate": "T8", "wave": 1, "boundary": "cycle mapping", "mode": "measured", "reason": "bounded dense lookup candidate with a fail-closed span gate"},
        {"candidate": "T9", "wave": 2, "boundary": "downsample index selection", "mode": "measured", "reason": "independent envelope implementation"},
        {"candidate": "T10", "wave": 2, "boundary": "post-downsample gather", "mode": "measured", "reason": "direct array take avoids the central pandas iloc gather"},
        {"candidate": "T11", "wave": 2, "boundary": "fused downsample/gather", "mode": "measured", "reason": "composition of T9 and T10"},
        {"candidate": "T12", "wave": 2, "boundary": "compact arrays", "mode": "measured", "reason": "display_x canonicality is measured, but frontend fallback/export consumers keep this supporting-only"},
        {"candidate": "T13", "wave": 2, "boundary": "provenance projection", "mode": "measured", "reason": "index/table encoding is reconstructed in the benchmark but not wired to the existing frontend contract"},
        {"candidate": "T14", "wave": 2, "boundary": "ndarray to Python list", "mode": "measured", "reason": "same null and rounding semantics"},
        {"candidate": "T15", "wave": 2, "boundary": "NumPy-aware JSON serializer", "mode": "reject", "reason": "optional serializer availability and packaging compatibility are not assumed; no dependency is added for a benchmark-only child"},
        {"candidate": "T16", "wave": 2, "boundary": "one authoritative JSON body", "mode": "measured", "reason": "one-encode proxy with cache/header ownership retained"},
        {"candidate": "T17", "wave": 2, "boundary": "bounded write-behind", "mode": "reject", "reason": "requires a durable queue/shutdown/race contract and is deferred rather than introduced as speculative production behavior"},
        {"candidate": "T18", "wave": 2, "boundary": "adaptive point budget", "mode": "measured", "reason": "backend-only point/byte evidence; visual equivalence remains an external gate"},
        {"candidate": "T19", "wave": 3, "boundary": "persistent Python process pool", "mode": "measured", "reason": "two resident workers receive immutable descriptors and reopen indexed caches"},
        {"candidate": "T20", "wave": 3, "boundary": "persistent Python process pool", "mode": "measured", "reason": "four resident workers receive immutable descriptors and reopen indexed caches"},
        {"candidate": "T21", "wave": 3, "boundary": "workload-gated process pool", "mode": "retain_support", "reason": "only becomes meaningful if T19/T20 win complete-route evidence; no timing-history heuristic is introduced"},
        {"candidate": "T22", "wave": 3, "boundary": "in-process Rust/PyO3", "mode": "retain_support", "reason": "050.10 ordinary native evidence is reused as a control; no new native dependency is justified by the current compact projection boundary"},
        {"candidate": "T23", "wave": 3, "boundary": "Rust/Rayon display kernel", "mode": "reject", "reason": "ordinary native complete-boundary evidence was neutral-to-slower before a material transfer reduction"},
        {"candidate": "T24", "wave": 3, "boundary": "persistent Rust subprocess", "mode": "reject", "reason": "the existing 050.10 process boundary is a control, not a measured ordinary-path win"},
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
    serialization = _serialization_ablation(
        _projection(_raw_frames(captured["S25-6-time"])[0], _settings(captured["S25-6-time"]), "A0"),
        repetitions,
    )
    identity = _identity_ablation(env, base, cell_ids[:6], repetitions)
    mapping = _cycle_mapping_ablation(captured["S25-6-time"], repetitions)
    capacity = _capacity_breakdown(captured["S25-6-capacity"], repetitions)
    processes = _process_ablation(captured["S25-6-time"], repetitions) if include_process else [{"status": "NOT RUN", "reason": "--skip-process"}]

    composition: list[dict[str, Any]] = []
    target = captured["S25-6-time"]
    frames = _raw_frames(target)
    settings = _settings(target)
    baselines = [_projection(frame, settings, "A0") for frame in frames]
    independent_winners = {
        item["candidate"]
        for item in ablations["S25-6-time"]["candidates"]
        if item["classification"] == "promote"
    }
    if mapping["classification"] == "promote":
        independent_winners.add("T8")
    stacks = (
        ("W1", ["T8"]),
        ("W2", ["T8", "T16"]),
        ("W3", ["T8", "T16", "T19"]),
    )
    for stack, candidate_features in stacks:
        candidate_name = "+".join(candidate_features) or "A0"
        cell_rows = [
            _measure_projection(frame, settings, candidate_name, baseline, repetitions)
            for frame, baseline in zip(frames, baselines)
        ]
        baseline_wall = sum(sum(item.stage_ms.values()) for item in baselines)
        candidate_wall = sum(float(item["wall_ms"]["median_ms"]) for item in cell_rows)
        exact = all(item["scientific_digest_equal"] for item in cell_rows)
        order_equal = all(item["trace_order_equal"] for item in cell_rows)
        eligible_features = [
            feature for feature in candidate_features
            if feature in {"T6", "T7", "T9", "T10", "T11", "T14"}
        ]
        all_independent_winners = all(feature in independent_winners for feature in eligible_features)
        all_stack_winners = all(feature in independent_winners for feature in candidate_features)
        if not exact or not order_equal:
            classification = "reject"
        elif not all_independent_winners or not all_stack_winners or not eligible_features:
            classification = "retain_support"
        elif candidate_wall <= baseline_wall * (1.0 - IMPROVEMENT_THRESHOLD):
            classification = "promote"
        else:
            classification = "retain_support"
        composition.append({
            "stack": stack,
            "candidate_features": candidate_features,
            "independent_winners": sorted(independent_winners),
            "eligible_projection_features": eligible_features,
            "wall_ms": _range([float(item["wall_ms"]["median_ms"]) for item in cell_rows]),
            "baseline_wall_ms": baseline_wall,
            "delta_pct": _pct(baseline_wall, candidate_wall),
            "scientific_digest_equal": exact,
            "trace_order_equal": order_equal,
            "classification": classification,
            "reason": "composition is gated by independently promoted candidates; process/cache candidates remain separate controls",
        })

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
    args = parser.parse_args()
    if args.repetitions < 5:
        parser.error("050.13 final evidence requires at least five warm repetitions")

    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    base = load_case_spec(
        fixture_root,
        {"id": "time_capacity_profile", "kind": "time_capacity", "spec_path": "specs/time_capacity_baseline.json"},
    )
    saved_data_root = os.environ.get("CELLXPLORER_DATA")
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
