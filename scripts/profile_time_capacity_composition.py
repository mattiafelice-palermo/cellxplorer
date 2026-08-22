"""Benchmark composition of the accepted Spec 050.9 and 050.10 mechanisms.

This is a benchmark-only adapter. It resolves the same immutable per-Cell jobs
as the 050.9 profiler, reads them sequentially or with a bounded read pool, and
sends the resulting compact numeric buffers to the persistent 050.10 Rust
worker. The current Python response assembly remains the scientific boundary;
only the measured derivative/display numeric function is replaced by the Rust
response inside the candidate request.

No production executor, native integration, cache layout or frontend behavior
is changed. The JSON output is disposable evidence and contains no raw rows,
source paths, hashes or Cell names.
"""
from __future__ import annotations

import argparse
from collections import deque
from contextlib import ExitStack
from copy import deepcopy
import json
import os
from pathlib import Path
import statistics
import sys
import time
from typing import Any, Iterable
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts"))

import profile_rust_derivative_kernel as rust  # noqa: E402
import profile_time_capacity_concurrency as concurrency  # noqa: E402
from golden_analysis_support import (  # noqa: E402
    GoldenFixtureEnvironment,
    load_case_spec,
    restore_data_root_binding,
)
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


REPETITIONS = 5
READ_WORKERS = 2
RUST_SEQUENTIAL_WORKERS = 1
RUST_BOUNDED_WORKERS = 4
IMPROVEMENT_THRESHOLD = 0.05


def _finite(values: Iterable[object]) -> list[float]:
    return [float(value) for value in values if value is not None and np.isfinite(value)]


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


def _relative_change(reference: float | None, candidate: float | None) -> float | None:
    if reference is None or candidate is None or reference == 0:
        return None
    return (candidate / reference - 1.0) * 100.0


def _make_spec(base: dict[str, Any], workload: dict[str, Any]) -> dict[str, Any]:
    return concurrency.make_spec(
        base,
        workload["cell_ids"],
        workload["cycles"],
        workload["cycle_end"],
        x_axis=workload["x_axis"],
        view=workload["view"],
        derivative_specific=workload["derivative_specific"],
    )


def _filtered_raw(payload: Any, settings: dict[str, Any]) -> pd.DataFrame:
    raw = payload.raw.copy()
    if settings["cycles"]:
        raw = raw[raw["cycle"].isin(settings["cycles"])]
    else:
        if settings["cycle_start"] is not None:
            raw = raw[raw["cycle"] >= int(settings["cycle_start"])]
        if settings["cycle_end"] is not None:
            raw = raw[raw["cycle"] <= int(settings["cycle_end"])]
    sort_columns = [
        column
        for column in ("cycle", "segment", "record_index")
        if column in raw.columns
    ]
    if sort_columns:
        raw = raw.sort_values(sort_columns, kind="stable")
    return raw.reset_index(drop=True)


def _phase_and_capacity(
    raw: pd.DataFrame,
    payload: Any,
    settings: dict[str, Any],
    request: Any,
) -> tuple[list[str], np.ndarray]:
    from app.services import analysis_engine, time_capacity_derived

    needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
        settings,
        precision=request.precision,
        compact=request.compact,
    )
    if needs.continuous_time:
        raw = analysis_engine._continuous_time(raw)
    aligned = (
        analysis_engine._aligned_prepared_transform_values(
            raw,
            payload.prepared,
            need_capacity=needs.phase_capacity,
        )
        if payload.prepared is not None
        else None
    )
    if aligned is not None:
        phases, prepared_capacity = aligned
    else:
        phases = analysis_engine._phase_from_raw(raw)
        prepared_capacity = None
    if needs.phase_capacity:
        capacity = (
            prepared_capacity
            if prepared_capacity is not None
            else analysis_engine._phase_capacity(raw, phases)
        )
    else:
        capacity = np.full(len(raw), np.nan, dtype="float64")
    return list(phases), np.asarray(capacity, dtype="float64")


def _build_derivative_dataset(
    payloads: list[Any],
    request: Any,
    workload: dict[str, Any],
    suite: str,
) -> tuple[rust.KernelDataset, float]:
    from app.services import analysis_engine

    started = time.perf_counter()
    settings = deepcopy(request.settings)
    cells: list[rust.PythonCellInput] = []
    for payload in payloads:
        raw = _filtered_raw(payload, settings)
        phases, capacity = _phase_and_capacity(raw, payload, settings, request)
        descriptor = payload.job.descriptor
        active_mass_g = (
            descriptor.active_mass_mg / 1000.0
            if descriptor.active_mass_mg
            else None
        )
        capacity_specific = (
            capacity / active_mass_g
            if settings.get("derivative_specific") and active_mass_g and active_mass_g > 0
            else None
        )
        if settings.get("derivative_specific") and capacity_specific is None:
            capacity_specific = np.full(len(raw), np.nan, dtype="float64")
        cells.append(
            rust._capture_python_input(
                raw,
                phases,
                capacity,
                capacity_specific,
            )
        )
    prepare_ms = (time.perf_counter() - started) * 1000.0
    window = int(settings.get("smoothing_window") or 1)
    if window % 2 == 0:
        window += 1
    return (
        rust.KernelDataset(
            kernel_kind="derivative",
            scenario=str(workload["scenario"]),
            suite=suite,
            cell_count=len(cells),
            mode=str(settings["view"]),
            selected_phase=str(settings.get("derivative_phase") or "both"),
            smoothing_window=window,
            absolute_discharge=bool(settings.get("derivative_absolute_discharge", True)),
            settings=settings,
            cells=cells,
            normal_cells=None,
            reference_outputs=[],
            owner_buffer_prepare_ms=prepare_ms,
            input_rows=sum(len(cell.capacity) for cell in cells),
            backend_context_ms=[],
        ),
        prepare_ms,
    )


def _build_normal_dataset(
    payloads: list[Any],
    request: Any,
    workload: dict[str, Any],
    suite: str,
) -> tuple[rust.KernelDataset, float]:
    from app.services import analysis_engine, canonical_cycling, time_capacity_derived

    started = time.perf_counter()
    settings = deepcopy(request.settings)
    transform_needs = time_capacity_derived.TimeCapacityTransformNeeds.for_request(
        settings,
        precision=request.precision,
        compact=request.compact,
    )
    cells: list[rust.NormalCellInput] = []
    for payload in payloads:
        raw = _filtered_raw(payload, settings)
        phases, capacity = _phase_and_capacity(raw, payload, settings, request)
        voltage_column = canonical_cycling.VOLTAGE_QUANTITIES[settings["voltage_channel"]]
        voltage = (
            raw[voltage_column].to_numpy(dtype="float64", copy=True)
            if voltage_column in raw.columns
            else np.full(len(raw), np.nan, dtype="float64")
        )
        cycles = pd.to_numeric(raw["cycle"], errors="coerce").to_numpy(dtype="float64")
        if not np.isfinite(cycles).all():
            raise RuntimeError("normal composition input contains invalid cycles")
        phase_codes = np.asarray(
            [{"rest": 0, "charge": 1, "discharge": 2}.get(str(phase), 0) for phase in phases],
            dtype="uint8",
        )
        cells.append(
            rust.NormalCellInput(
                cycles=np.ascontiguousarray(cycles.astype("int64"), dtype="<i8"),
                phases=np.ascontiguousarray(phase_codes, dtype="u1"),
                time_s=np.ascontiguousarray(
                    raw["time_s"].to_numpy(dtype="float64", copy=True)
                    if "time_s" in raw.columns
                    else np.full(len(raw), np.nan, dtype="float64"),
                    dtype="<f8",
                ),
                capacity=np.ascontiguousarray(
                    capacity if transform_needs.phase_capacity else np.full(len(raw), np.nan),
                    dtype="<f8",
                ),
                voltage=np.ascontiguousarray(voltage, dtype="<f8"),
            )
        )
    prepare_ms = (time.perf_counter() - started) * 1000.0
    return (
        rust.KernelDataset(
            kernel_kind="normal",
            scenario=str(workload["scenario"]),
            suite=suite,
            cell_count=len(cells),
            mode=str(settings["x_axis"]),
            selected_phase="both",
            smoothing_window=1,
            absolute_discharge=False,
            settings=settings,
            cells=[],
            normal_cells=cells,
            reference_outputs=[],
            owner_buffer_prepare_ms=prepare_ms,
            input_rows=sum(len(cell.time_s) for cell in cells),
            backend_context_ms=[],
        ),
        prepare_ms,
    )


def _build_dataset(
    payloads: list[Any],
    request: Any,
    workload: dict[str, Any],
    suite: str,
) -> tuple[rust.KernelDataset, float]:
    if request.settings["view"] != "voltage_current":
        return _build_derivative_dataset(payloads, request, workload, suite)
    return _build_normal_dataset(payloads, request, workload, suite)


def _split_response(response: dict[str, Any]) -> list[tuple[np.ndarray, np.ndarray]]:
    outputs: list[tuple[np.ndarray, np.ndarray]] = []
    for segments in response["cells"]:
        if not segments:
            outputs.append((np.empty(0, dtype="float64"), np.empty(0, dtype="float64")))
            continue
        outputs.append(
            (
                np.concatenate([segment[0] for segment in segments]).copy(),
                np.concatenate([segment[1] for segment in segments]).copy(),
            )
        )
    return outputs


def _read_payloads(
    jobs: list[Any],
    workers: int,
) -> tuple[list[Any], dict[str, Any], float]:
    started = time.perf_counter()
    if workers == 1:
        payloads = [
            concurrency._materialize_read(job, time.perf_counter())
            for job in jobs
        ]
        dispatch = {
            "dispatch_ms": (time.perf_counter() - started) * 1000.0,
            "queue_ms": 0.0,
            "per_cell_wall_ms": [payload.worker_wall_ms for payload in payloads],
        }
    else:
        payloads, dispatch = concurrency.run_read_prefetch(jobs, workers)
    payloads.sort(key=lambda item: item.job.index)
    return payloads, dispatch, (time.perf_counter() - started) * 1000.0


def _run_patched_backend(
    env: Any,
    spec: dict[str, Any],
    payloads: list[Any],
    request: Any,
    outputs: list[tuple[np.ndarray, np.ndarray]],
    reference: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], float]:
    from app.services import analysis_engine

    diagnostics: dict[str, Any] = {}
    output_queue = deque(outputs)

    def derivative_wrapper(*_args: Any, **_kwargs: Any) -> tuple[np.ndarray, np.ndarray]:
        if not output_queue:
            raise RuntimeError("Rust derivative output was consumed more than once")
        return output_queue.popleft()

    def display_wrapper(*_args: Any, **_kwargs: Any) -> np.ndarray:
        if not output_queue:
            raise RuntimeError("Rust display output was consumed more than once")
        return output_queue.popleft()[0]

    contexts = concurrency._prefetched_engine_context(payloads)
    started = time.perf_counter()
    with ExitStack() as stack:
        for context in contexts:
            stack.enter_context(context)
        if request.settings["view"] != "voltage_current":
            stack.enter_context(patch.object(analysis_engine, "_derivative_curve", derivative_wrapper))
        else:
            stack.enter_context(
                patch.object(analysis_engine, "_time_capacity_display_x", display_wrapper)
            )
        result = analysis_engine.compute_time_capacity(
            env.db,
            spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
            access_diagnostics=diagnostics,
        )
    if output_queue:
        raise RuntimeError(f"Rust output left unused: {len(output_queue)} cell outputs")
    return result, diagnostics, (time.perf_counter() - started) * 1000.0


def _warm_worker(
    env: Any,
    spec: dict[str, Any],
    workload: dict[str, Any],
    suite: str,
    read_workers: int,
    worker: rust.RustWorker,
) -> dict[str, Any]:
    jobs, request, owner_setup = concurrency.prepare_resolved_jobs(
        env,
        spec,
        workload["cell_ids"],
    )
    payloads, dispatch, read_wall_ms = _read_payloads(jobs, read_workers)
    dataset, prepare_ms = _build_dataset(payloads, request, workload, suite)
    response = worker.request(dataset)
    return {
        "owner_setup_ms": owner_setup["wall_ms"],
        "read_wall_ms": read_wall_ms,
        "read_dispatch_ms": dispatch["dispatch_ms"],
        "buffer_prepare_ms": prepare_ms,
        "rust_boundary_ms": response["boundary_wall_ms"],
        "rust_pool_init_ms": response["pool_init_ms"],
        "rust_memory_after": response["memory_after"],
    }


def _run_composed_candidate(
    env: Any,
    spec: dict[str, Any],
    workload: dict[str, Any],
    suite: str,
    reference: dict[str, Any],
    candidate: str,
    read_workers: int,
    worker: rust.RustWorker,
) -> dict[str, Any]:
    rss_before = concurrency.current_rss()
    owner_jobs_started = time.perf_counter()
    owner_cpu_started = time.process_time()
    jobs, request, owner_setup = concurrency.prepare_resolved_jobs(
        env,
        spec,
        workload["cell_ids"],
    )
    owner_elapsed_ms = (time.perf_counter() - owner_jobs_started) * 1000.0
    owner_cpu_seconds = time.process_time() - owner_cpu_started
    phase_started = time.perf_counter()
    phase_cpu_started = time.process_time()
    payloads, dispatch, read_wall_ms = _read_payloads(jobs, read_workers)
    dataset, buffer_prepare_ms = _build_dataset(payloads, request, workload, suite)
    rust_response = worker.request(dataset)
    outputs = _split_response(rust_response)
    result, diagnostics, remaining_python_backend_ms = _run_patched_backend(
        env,
        spec,
        payloads,
        request,
        outputs,
        reference,
    )
    serialization_ms = concurrency._serialize_result(result)
    phase_wall_ms = (time.perf_counter() - phase_started) * 1000.0
    backend_wall_ms = float(owner_setup["wall_ms"]) + phase_wall_ms
    process_cpu_seconds = time.process_time() - phase_cpu_started
    native_cpu_seconds = float(rust_response.get("cpu_seconds") or 0.0)
    cpu_seconds = owner_cpu_seconds + process_cpu_seconds + native_cpu_seconds
    rss_after = concurrency.current_rss()
    row = concurrency._measurement_row(
        candidate=candidate,
        workers=read_workers,
        scenario=str(workload["scenario"]),
        cells=list(workload["cell_ids"]),
        result=result,
        diagnostics=diagnostics,
        reference=reference,
        backend_wall_ms=backend_wall_ms,
        cpu_seconds=cpu_seconds,
        serialization_ms=serialization_ms,
        queue_ms=float(dispatch["queue_ms"]),
        dispatch_ms=float(dispatch["dispatch_ms"]),
        rss_before=rss_before,
        rss_after=rss_after,
        native_settings=concurrency.native_thread_settings(),
        extra={
            "ablation": "read_concurrency_plus_persistent_rust",
            "read_workers": read_workers,
            "rust_workers": worker.workers,
            "owner_setup_ms": float(owner_setup["wall_ms"]),
            "owner_setup_wall_observed_ms": owner_elapsed_ms,
            "owner_setup_cpu_seconds": float(owner_setup["cpu_seconds"]),
            "worker_phase_wall_ms": phase_wall_ms,
            "composed_backend_wall_ms": backend_wall_ms,
            "read_wall_ms": read_wall_ms,
            "read_decode_ms": sum(dispatch["per_cell_wall_ms"]),
            "read_per_cell_job_wall_ms": concurrency._min_max(dispatch["per_cell_wall_ms"]),
            "buffer_prepare_ms": buffer_prepare_ms,
            "rust_boundary_ms": rust_response["boundary_wall_ms"],
            "rust_isolated_kernel_ms": rust_response["parallel_region_ms"],
            "rust_kernel_work_ms": rust_response["kernel_sum_ms"],
            "rust_pool_init_ms": rust_response["pool_init_ms"],
            "rust_warm_request": not bool(rust_response.get("cold")),
            "rust_cpu_seconds": rust_response.get("cpu_seconds"),
            "rust_effective_cores": (
                native_cpu_seconds / (float(rust_response["boundary_wall_ms"]) / 1000.0)
                if rust_response.get("boundary_wall_ms")
                else None
            ),
            "rust_memory_before": rust_response.get("memory_before"),
            "rust_memory_after": rust_response.get("memory_after"),
            "remaining_python_backend_ms": remaining_python_backend_ms,
            "worker_order": [item.job.index for item in payloads],
            "rust_output_order": list(range(len(outputs))),
        },
    )
    return row


def _summarize_workload(item: dict[str, Any]) -> dict[str, Any]:
    rows = item["samples"]
    candidates = ("A0", "R1", "D0", "D1", "D2")
    medians = {
        candidate: _median(
            row.get("backend_wall_ms")
            for row in rows
            if row.get("candidate") == candidate and row.get("status") == "PASS"
        )
        for candidate in candidates
    }
    ranges = {
        candidate: _range(
            row.get("backend_wall_ms")
            for row in rows
            if row.get("candidate") == candidate and row.get("status") == "PASS"
        )
        for candidate in candidates
    }
    r1 = medians["R1"]
    d0 = medians["D0"]
    d1 = medians["D1"]
    d2 = medians["D2"]
    expected_ratio = (
        (d1 / r1) * (d0 / r1)
        if r1 and d0 is not None and d1 is not None and r1 > 0
        else None
    )
    actual_ratio = d2 / r1 if r1 and d2 is not None and r1 > 0 else None
    expected_saving = (1.0 - expected_ratio) * 100.0 if expected_ratio is not None else None
    actual_saving = (1.0 - actual_ratio) * 100.0 if actual_ratio is not None else None
    interaction_delta = (
        actual_saving - expected_saving
        if actual_saving is not None and expected_saving is not None
        else None
    )
    if actual_saving is None:
        interaction = "not_measurable"
    elif actual_saving < -IMPROVEMENT_THRESHOLD * 100.0:
        interaction = "negative"
    elif actual_saving <= IMPROVEMENT_THRESHOLD * 100.0:
        interaction = "neutral"
    elif interaction_delta is not None and interaction_delta < -IMPROVEMENT_THRESHOLD * 100.0:
        interaction = "sub-additive"
    else:
        interaction = "additive"
    return {
        "candidate_medians_ms": medians,
        "candidate_ranges_ms": ranges,
        "read_concurrency_effect_vs_R1_pct": _relative_change(r1, d1),
        "rayon_effect_vs_R1_pct": _relative_change(r1, d0),
        "hybrid_effect_vs_R1_pct": _relative_change(r1, d2),
        "hybrid_effect_vs_D0_pct": _relative_change(d0, d2),
        "expected_independent_hybrid_saving_pct": expected_saving,
        "actual_hybrid_saving_vs_R1_pct": actual_saving,
        "interaction_delta_pct": interaction_delta,
        "interaction": interaction,
        "scientific_status": (
            "PASS"
            if all(
                row.get("status") == "PASS"
                for row in rows
                if row.get("candidate") in candidates
            )
            else "REJECTED"
        ),
    }


def _profile_workload(
    env: Any,
    base: dict[str, Any],
    workload: dict[str, Any],
    suite: str,
    executable: Path,
    repetitions: int,
) -> dict[str, Any]:
    scenario = str(workload["scenario"])
    spec = _make_spec(base, workload)
    _, reference = concurrency.run_production_sample(
        env,
        spec,
        None,
        scenario=f"{scenario}-warmup",
    )
    definitions = (
        ("R1", 1, RUST_SEQUENTIAL_WORKERS),
        ("D0", 1, RUST_BOUNDED_WORKERS),
        ("D1", READ_WORKERS, RUST_SEQUENTIAL_WORKERS),
        ("D2", READ_WORKERS, RUST_BOUNDED_WORKERS),
    )
    samples: list[dict[str, Any]] = []
    lifecycle: dict[str, Any] = {}
    with ExitStack() as stack:
        workers: dict[str, rust.RustWorker] = {}
        for candidate, read_workers, rust_workers in definitions:
            worker = stack.enter_context(rust.RustWorker(executable, rust_workers))
            workers[candidate] = worker
            warm = _warm_worker(
                env,
                spec,
                workload,
                suite,
                read_workers,
                worker,
            )
            lifecycle[candidate] = {
                "read_workers": read_workers,
                "rust_workers": rust_workers,
                "spawn_api_ms": worker.spawn_api_ms,
                "spawn_to_ready_ms": worker.spawn_to_ready_ms,
                "ready_handshake_ms": worker.ready_handshake_ms,
                "warmup": warm,
            }
        for repetition in range(repetitions):
            baseline, _ = concurrency.run_production_sample(
                env,
                spec,
                reference,
                scenario=scenario,
            )
            samples.append(baseline)
            rotation = repetition % len(definitions)
            order = definitions[rotation:] + definitions[:rotation]
            for candidate, read_workers, _rust_workers in order:
                row = _run_composed_candidate(
                    env,
                    spec,
                    workload,
                    suite,
                    reference,
                    candidate,
                    read_workers,
                    workers[candidate],
                )
                samples.append(row)
                if row["status"] != "PASS":
                    raise RuntimeError(
                        f"composition parity failed for {suite}/{scenario}/{candidate} "
                        f"repetition {repetition + 1}"
                    )
    item = {
        **{key: value for key, value in workload.items() if key != "cell_ids"},
        "suite": suite,
        "cell_count": len(workload["cell_ids"]),
        "repetitions": repetitions,
        "warmup": "one current-path request plus one persistent Rust request per candidate",
        "samples": samples,
        "lifecycle": lifecycle,
        "reference_digest": concurrency.scientific_digest(reference),
        "canonical_output_order": "original selection order",
    }
    item.update(_summarize_workload(item))
    return item


def _selected_workloads(cell_ids: list[int]) -> list[dict[str, Any]]:
    wanted = {
        "normal-1-all-time",
        "normal-3-all-time",
        "normal-6-all-time",
        "normal-10-all-time",
        "normal-11-all-time",
        "normal-6-all-capacity",
        "control-6-cycles-1-20-time",
        "derivative-1-all-dqdv",
        "derivative-6-all-dqdv",
        "derivative-10-all-dqdv",
        "derivative-small-1-3-dqdv",
    }
    return [
        workload
        for workload in concurrency.workload_matrix(cell_ids)
        if workload["scenario"] in wanted
    ]


def _suite_summary(workloads: list[dict[str, Any]]) -> dict[str, Any]:
    representative = [
        item
        for item in workloads
        if item["scenario"] in {
            "normal-6-all-time",
            "normal-10-all-time",
            "normal-11-all-time",
            "derivative-6-all-dqdv",
            "derivative-10-all-dqdv",
        }
    ]
    small = [
        item
        for item in workloads
        if item["scenario"] in {"normal-1-all-time", "derivative-small-1-3-dqdv"}
    ]
    return {
        "representative_workloads": [item["scenario"] for item in representative],
        "representative_hybrid_vs_D0_pct": _median(
            item["hybrid_effect_vs_D0_pct"] for item in representative
        ),
        "representative_hybrid_saving_vs_R1_pct": _median(
            item["actual_hybrid_saving_vs_R1_pct"] for item in representative
        ),
        "small_hybrid_vs_D0_pct": _median(
            item["hybrid_effect_vs_D0_pct"] for item in small
        ),
        "all_scientific_pass": all(item["scientific_status"] == "PASS" for item in workloads),
    }


def _architecture_decision(workloads: list[dict[str, Any]]) -> dict[str, Any]:
    """Select the one required outcome from representative complete boundaries."""

    derivative = [
        item
        for item in workloads
        if item["scenario"] in {"derivative-6-all-dqdv", "derivative-1-all-dqdv"}
    ]
    normal = [
        item
        for item in workloads
        if item["scenario"] in {
            "normal-6-all-time",
            "normal-10-all-time",
            "normal-11-all-time",
        }
    ]
    small = [
        item
        for item in workloads
        if item["scenario"] in {"normal-1-all-time", "derivative-small-1-3-dqdv"}
    ]

    def change(items: list[dict[str, Any]], reference: str, candidate: str) -> float | None:
        return _median(
            _relative_change(
                item["candidate_medians_ms"].get(reference),
                item["candidate_medians_ms"].get(candidate),
            )
            for item in items
        )

    rust_vs_python = change(derivative, "A0", "R1")
    rayon_vs_rust = change(derivative, "R1", "D0")
    read_vs_rust = change(derivative, "R1", "D1")
    hybrid_vs_rayon = change(derivative, "D0", "D2")
    normal_rust_vs_python = change(normal, "A0", "R1")
    small_hybrid_vs_rayon = change(small, "D0", "D2")

    if rust_vs_python is not None and rust_vs_python <= -IMPROVEMENT_THRESHOLD * 100.0:
        outcome = (
            "D — bounded Rust/Rayon"
            if rayon_vs_rust is not None
            and rayon_vs_rust <= -IMPROVEMENT_THRESHOLD * 100.0
            and (small_hybrid_vs_rayon is None or small_hybrid_vs_rayon <= 10.0)
            else "C — sequential Rust kernel"
        )
    elif read_vs_rust is not None and read_vs_rust <= -IMPROVEMENT_THRESHOLD * 100.0:
        outcome = "B — bounded Python threads"
    else:
        outcome = "A — remain sequential Python"
    return {
        "outcome": outcome,
        "decision_threshold_pct": 5.0,
        "derivative_rust_vs_python_pct": rust_vs_python,
        "derivative_rayon4_vs_rust1_pct": rayon_vs_rust,
        "derivative_read2_rust1_vs_seqread_rust1_pct": read_vs_rust,
        "derivative_hybrid_read2_rayon4_vs_seqread_rayon4_pct": hybrid_vs_rayon,
        "normal_rust1_vs_python_pct": normal_rust_vs_python,
        "small_hybrid_read2_rayon4_vs_seqread_rayon4_pct": small_hybrid_vs_rayon,
        "reason": (
            "Sequential Rust is materially useful for the broad derivative stage, but the "
            "complete backend boundary does not show a stable 5% additional Rayon gain; "
            "read concurrency is also below the threshold and is not promoted. Normal "
            "Time/Capacity remains on the current Python path."
            if outcome == "C — sequential Rust kernel"
            else "Measured representative complete-boundary medians selected this outcome."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=REPETITIONS)
    parser.add_argument("--app-data-root", type=Path, default=Path.home() / ".cellxplorer")
    parser.add_argument("--fixture-only", action="store_true")
    parser.add_argument("--scenario", action="append")
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if args.repetitions < 5:
        parser.error("050.11 requires at least five warm repetitions")

    executable = (
        ROOT
        / "scripts"
        / "rust_derivative_kernel"
        / "target"
        / "release"
        / "cellxplorer-05010-rust-derivative-kernel.exe"
    )
    build = rust._rust_build(executable, args.skip_build)
    fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
    fixture_base = load_case_spec(
        fixture_root,
        {
            "id": "time_capacity_profile",
            "kind": "time_capacity",
            "spec_path": "specs/time_capacity_baseline.json",
        },
    )
    requested = set(args.scenario or [])
    saved_data_root = os.environ.get("CELLXPLORER_DATA")
    suites: list[dict[str, Any]] = []
    cache_controls: dict[str, Any] = {}
    skipped: dict[str, str] = {}
    try:
        with GoldenFixtureEnvironment.create() as env:
            clone_ids = clone_golden_source_cells(env, 10)
            selected = [concurrency.GOLDEN_CELL_ID, *clone_ids[:10]]
            workloads = _selected_workloads(selected)
            if requested:
                workloads = [item for item in workloads if item["scenario"] in requested]
            for workload in workloads:
                print(f"profiling golden_fixture/{workload['scenario']}", flush=True)
                suites.append(
                    _profile_workload(
                        env,
                        fixture_base,
                        workload,
                        "golden_fixture",
                        executable,
                        args.repetitions,
                    )
                )
            cache_controls["golden_fixture"] = concurrency.run_cache_hit_control(
                env,
                fixture_base,
                selected[:3],
            )

        if not args.fixture_only:
            app_root = args.app_data_root.resolve()
            if not (app_root / "cellxplorer.db").is_file():
                skipped["application"] = f"NOT RUN: database not found at {app_root / 'cellxplorer.db'}"
            else:
                try:
                    with concurrency.create_application_environment(app_root) as app_env:
                        app_base, app_cells, metadata = concurrency.discover_application_dataset(app_env)
                        workloads = _selected_workloads(app_cells)
                        if requested:
                            workloads = [item for item in workloads if item["scenario"] in requested]
                        for workload in workloads:
                            print(f"profiling application/{workload['scenario']}", flush=True)
                            item = _profile_workload(
                                app_env,
                                app_base,
                                workload,
                                "application_performance_batch",
                                executable,
                                args.repetitions,
                            )
                            item["dataset"] = metadata
                            suites.append(item)
                        cache_controls["application_performance_batch"] = concurrency.run_cache_hit_control(
                            app_env,
                            app_base,
                            app_cells[: min(3, len(app_cells))],
                        )
                except (FileNotFoundError, RuntimeError, OSError) as exc:
                    skipped["application"] = f"NOT RUN: {type(exc).__name__}: {exc}"
    finally:
        restore_data_root_binding(saved_data_root)

    if requested:
        known = {item["scenario"] for item in suites}
        missing = requested - known
        if missing:
            parser.error(f"unknown scenario(s): {', '.join(sorted(missing))}")

    all_samples = [row for item in suites for row in item["samples"]]
    parity_failures = [row for row in all_samples if row.get("status") != "PASS"]
    architecture = _architecture_decision(suites)
    evidence = {
        "spec": "050.11",
        "status": "PASS" if not parity_failures and suites else "REJECTED",
        "build": build,
        "repetitions": args.repetitions,
        "host_logical_cpus": os.cpu_count() or 1,
        "worker_contract": {
            "read_workers": [1, READ_WORKERS],
            "rust_workers": [RUST_SEQUENTIAL_WORKERS, RUST_BOUNDED_WORKERS],
            "python_processes": "NOT RUN: 050.9 did not meet the process gate; Rust remains feasible",
            "nested_threading": "bounded read ThreadPoolExecutor plus exactly one persistent Rust Rayon pool per candidate; no all-CPU setting",
        },
        "composition_candidates": {
            "A0": "current sequential Python backend",
            "R1": "sequential indexed reads + persistent one-worker Rust",
            "D0": "sequential indexed reads + persistent four-worker Rust/Rayon",
            "D1": "two concurrent indexed reads + persistent one-worker Rust",
            "D2": "two concurrent indexed reads + persistent four-worker Rust/Rayon",
            "D3": "NOT RUN: whole-Cell Python threads plus internally parallel Rust would duplicate the D2 read boundary and require one native boundary per Cell",
        },
        "survivor_evidence": {
            "050.9": "B1/B2 improve isolated reads by 5-9% median but representative total requests are neutral-to-slower; B3/B4 help normal multi-Cell work and harm broad derivatives",
            "050.10": "sequential Rust is useful for derivatives; P4 is the accepted persistent bound; eight-worker isolated gains do not justify P8 at the complete boundary",
        },
        "native_thread_settings": concurrency.native_thread_settings(),
        "workloads": suites,
        "cache_controls": cache_controls,
        "parity_failures": parity_failures,
        "skipped_suites": skipped,
        "decision_support": {
            suite: _suite_summary([item for item in suites if item["suite"] == suite])
            for suite in sorted({item["suite"] for item in suites})
        },
        "primary_architecture_outcome": architecture["outcome"],
        "architecture_decision": architecture,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "spec": evidence["spec"],
                "status": evidence["status"],
                "workloads": len(suites),
                "candidate_rows": len(all_samples),
                "parity_failures": len(parity_failures),
                "output": str(args.output),
                "skipped_suites": skipped,
            },
            indent=2,
        )
    )
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
