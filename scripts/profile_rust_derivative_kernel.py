"""Benchmark the Spec 050.9 derivative hotspot against an isolated Rust/Rayon worker.

The benchmark is intentionally not a production binding.  Python resolves the
same cache-backed derivative inputs used by the current engine, then sends one
coarse request containing immutable numeric segment buffers to a persistent
Rust process.  C0 is the current ``analysis_engine._derivative_curve`` reference;
C1/C2/C3 are the same Rust kernel with 1/2/4 Rayon workers.

The JSON report contains timings, boundary-copy accounting, lifecycle data and
scientific parity only.  It never writes to the user's database or emits raw
rows, source paths, hashes or Cell names.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from copy import deepcopy
import ctypes
import json
import os
from pathlib import Path
import platform
import statistics
import struct
import subprocess
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

from golden_analysis_support import (  # noqa: E402
    GoldenFixtureEnvironment,
    load_case_spec,
    restore_data_root_binding,
)
from profile_time_capacity_concurrency import (  # noqa: E402
    _materialize_read,
    _resolved_cell_result,
    ApplicationEnvironment,
    create_application_environment,
    discover_application_dataset,
    make_spec,
    native_thread_settings,
    prepare_resolved_jobs,
)
from profile_time_capacity_transforms import clone_golden_source_cells  # noqa: E402


MAGIC = 0x4358_0501
VERSION = 1
READY_MARKER = 0x5245_4144
DEFAULT_REPETITIONS = 5
RELATIVE_TOLERANCE = 1e-7
ABSOLUTE_TOLERANCE = 1e-9
RAYON_WORKERS = (1, 2, 4)


@dataclass
class SegmentInput:
    phase: str
    capacity: np.ndarray
    voltage: np.ndarray
    explicit_cv: np.ndarray


@dataclass
class PythonCellInput:
    frame: pd.DataFrame
    phases: list[str]
    capacity: np.ndarray
    capacity_specific: np.ndarray | None
    segments: list[SegmentInput]


@dataclass
class KernelDataset:
    scenario: str
    suite: str
    cell_count: int
    mode: str
    selected_phase: str
    smoothing_window: int
    absolute_discharge: bool
    settings: dict[str, Any]
    cells: list[PythonCellInput]
    reference_outputs: list[tuple[np.ndarray, np.ndarray]]
    owner_buffer_prepare_ms: float
    backend_context_ms: list[float]


def _median(values: Iterable[object]) -> float | None:
    finite = [float(value) for value in values if value is not None and np.isfinite(value)]
    return statistics.median(finite) if finite else None


def _range(values: Iterable[object]) -> dict[str, float | None]:
    finite = [float(value) for value in values if value is not None and np.isfinite(value)]
    return {
        "min_ms": min(finite) if finite else None,
        "median_ms": statistics.median(finite) if finite else None,
        "max_ms": max(finite) if finite else None,
    }


def _phase_code(phase: str) -> int:
    return {"charge": 0, "discharge": 1, "rest": 2}.get(str(phase), 2)


def _selected_phase_code(phase: str) -> int:
    return {"charge": 0, "discharge": 1, "both": 2}.get(str(phase), 2)


def _contiguous_bounds(frame: pd.DataFrame, phases: list[str]) -> list[tuple[int, int]]:
    count = len(frame)
    if not count:
        return []
    phase_values = np.asarray(phases, dtype=object)
    cycles = frame["cycle"].to_numpy() if "cycle" in frame.columns else np.zeros(count)
    segments = frame["segment"].to_numpy() if "segment" in frame.columns else np.zeros(count)
    changed = (
        (cycles[1:] != cycles[:-1])
        | (segments[1:] != segments[:-1])
        | (phase_values[1:] != phase_values[:-1])
    )
    starts = np.concatenate((np.array([0], dtype=int), np.flatnonzero(changed) + 1))
    ends = np.concatenate((starts[1:], np.array([count], dtype=int)))
    return list(zip(starts.tolist(), ends.tolist()))


def _capture_python_input(
    frame: pd.DataFrame,
    phases: list[str],
    capacity: np.ndarray,
    capacity_specific: np.ndarray | None,
) -> PythonCellInput:
    """Capture exactly the arguments passed to the current derivative kernel."""

    import app.services.calc as calc

    voltage = frame["voltage_v"].to_numpy(dtype="float64", copy=True)
    capacity_values = np.asarray(capacity, dtype="float64").copy()
    if "status" in frame.columns:
        explicit = calc.status_matches(frame["status"], "cv") & ~calc.status_matches(
            frame["status"], "cccv"
        )
    else:
        explicit = np.zeros(len(frame), dtype=bool)
    statuses = np.where(explicit, "CV_Chg", "CC_Chg")
    python_frame = pd.DataFrame(
        {
            "cycle": frame["cycle"].to_numpy(copy=True)
            if "cycle" in frame.columns
            else np.zeros(len(frame), dtype=int),
            "segment": frame["segment"].to_numpy(copy=True)
            if "segment" in frame.columns
            else np.zeros(len(frame), dtype=int),
            "voltage_v": voltage,
            "status": statuses,
        }
    )
    segments: list[SegmentInput] = []
    for start, end in _contiguous_bounds(python_frame, phases):
        segments.append(
            SegmentInput(
                phase=str(phases[start]),
                capacity=np.ascontiguousarray(capacity_values[start:end], dtype="<f8"),
                voltage=np.ascontiguousarray(voltage[start:end], dtype="<f8"),
                explicit_cv=np.ascontiguousarray(explicit[start:end], dtype=np.uint8),
            )
        )
    return PythonCellInput(
        frame=python_frame,
        phases=list(phases),
        capacity=capacity_values,
        capacity_specific=(
            np.asarray(capacity_specific, dtype="float64").copy()
            if capacity_specific is not None
            else None
        ),
        segments=segments,
    )


def _build_dataset(
    env: Any,
    base: dict[str, Any],
    workload: dict[str, Any],
    suite: str,
    repetitions: int,
) -> KernelDataset:
    from app.services import analysis_engine

    spec = make_spec(
        base,
        workload["cell_ids"],
        workload["cycles"],
        workload["cycle_end"],
        x_axis=workload["x_axis"],
        view=workload["view"],
        derivative_specific=workload["derivative_specific"],
    )
    jobs, request, _owner_setup = prepare_resolved_jobs(env, spec, workload["cell_ids"])
    payloads = [
        _materialize_read(job, time.perf_counter())
        for job in jobs
    ]
    captured: list[PythonCellInput] = []
    reference_outputs: list[tuple[np.ndarray, np.ndarray]] = []
    owner_prepare_ms = 0.0
    original = analysis_engine._derivative_curve

    def capture_wrapper(
        frame: pd.DataFrame,
        phases: list[str],
        capacity: np.ndarray,
        capacity_specific: np.ndarray | None,
        settings: dict[str, Any],
        diagnostics: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        nonlocal owner_prepare_ms
        prepare_started = time.perf_counter()
        captured.append(_capture_python_input(frame, phases, capacity, capacity_specific))
        owner_prepare_ms += (time.perf_counter() - prepare_started) * 1000.0
        output = original(frame, phases, capacity, capacity_specific, settings, diagnostics)
        reference_outputs.append((output[0].copy(), output[1].copy()))
        return output

    with patch.object(analysis_engine, "_derivative_curve", capture_wrapper):
        for job, payload in zip(jobs, payloads):
            _resolved_cell_result(job, payload, request)
    if len(captured) != len(jobs):
        raise RuntimeError(
            f"derivative capture expected {len(jobs)} cells, captured {len(captured)}"
        )
    if len(reference_outputs) != len(jobs):
        raise RuntimeError(
            f"derivative reference expected {len(jobs)} cells, captured {len(reference_outputs)}"
        )

    # The full current request is context evidence only.  Rust is not wired into
    # this request path; C1-C3 remain isolated kernel/boundary measurements.
    backend_context_ms: list[float] = []
    analysis_engine.compute_time_capacity(
        env.db,
        spec,
        None,
        viewport_width=1200,
        precision="standard",
        compact=True,
    )
    for _ in range(repetitions):
        started = time.perf_counter()
        analysis_engine.compute_time_capacity(
            env.db,
            spec,
            None,
            viewport_width=1200,
            precision="standard",
            compact=True,
        )
        backend_context_ms.append((time.perf_counter() - started) * 1000.0)

    settings = deepcopy(request.settings)
    window = int(settings.get("smoothing_window") or 1)
    if window % 2 == 0:
        window += 1
    return KernelDataset(
        scenario=str(workload["scenario"]),
        suite=suite,
        cell_count=len(captured),
        mode=str(settings["view"]),
        selected_phase=str(settings.get("derivative_phase") or "both"),
        smoothing_window=window,
        absolute_discharge=bool(settings.get("derivative_absolute_discharge", True)),
        settings=settings,
        cells=captured,
        reference_outputs=reference_outputs,
        owner_buffer_prepare_ms=owner_prepare_ms,
        backend_context_ms=backend_context_ms,
    )


def _encode_request(dataset: KernelDataset) -> tuple[bytes, int, int, float]:
    started = time.perf_counter()
    mode = 0 if dataset.mode == "dqdv" else 1
    selected_phase = _selected_phase_code(dataset.selected_phase)
    frame = bytearray(
        struct.pack(
            "<IHBBBBII",
            MAGIC,
            VERSION,
            mode,
            selected_phase,
            int(dataset.absolute_discharge),
            0,
            dataset.smoothing_window,
            len(dataset.cells),
        )
    )
    numeric_bytes = 0
    for cell in dataset.cells:
        frame.extend(struct.pack("<I", len(cell.segments)))
        for segment in cell.segments:
            capacity = np.ascontiguousarray(segment.capacity, dtype="<f8")
            voltage = np.ascontiguousarray(segment.voltage, dtype="<f8")
            explicit = np.ascontiguousarray(segment.explicit_cv, dtype=np.uint8)
            if not (len(capacity) == len(voltage) == len(explicit)):
                raise RuntimeError("derivative segment buffers are not aligned")
            frame.extend(struct.pack("<IB3x", len(capacity), _phase_code(segment.phase)))
            frame.extend(capacity.tobytes(order="C"))
            frame.extend(voltage.tobytes(order="C"))
            frame.extend(explicit.tobytes(order="C"))
            numeric_bytes += capacity.nbytes + voltage.nbytes + explicit.nbytes
    return bytes(frame), numeric_bytes, len(frame), (time.perf_counter() - started) * 1000.0


def _read_exact(stream: Any, count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise RuntimeError("Rust derivative worker closed its output stream")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _u32(body: bytes, offset: int) -> tuple[int, int]:
    return struct.unpack_from("<I", body, offset)[0], offset + 4


def _u16(body: bytes, offset: int) -> tuple[int, int]:
    return struct.unpack_from("<H", body, offset)[0], offset + 2


def _u64(body: bytes, offset: int) -> tuple[int, int]:
    return struct.unpack_from("<Q", body, offset)[0], offset + 8


def _decode_response(body: bytes) -> dict[str, Any]:
    offset = 0
    magic, offset = _u32(body, offset)
    version, offset = _u16(body, offset)
    worker_count, offset = _u16(body, offset)
    pool_init_ns, offset = _u64(body, offset)
    parallel_region_ns, offset = _u64(body, offset)
    kernel_sum_ns, offset = _u64(body, offset)
    cell_count, offset = _u32(body, offset)
    if magic != MAGIC or version != VERSION:
        raise RuntimeError("Rust derivative worker returned an unsupported response")
    cells: list[list[tuple[np.ndarray, np.ndarray]]] = []
    cell_kernel_ms: list[float] = []
    output_numeric_bytes = 0
    for _ in range(cell_count):
        cell_kernel_ns, offset = _u64(body, offset)
        cell_kernel_ms.append(cell_kernel_ns / 1_000_000.0)
        segment_count, offset = _u32(body, offset)
        cell_segments: list[tuple[np.ndarray, np.ndarray]] = []
        for _ in range(segment_count):
            count, offset = _u32(body, offset)
            x_end = offset + count * 8
            y_end = x_end + count * 8
            if y_end > len(body):
                raise RuntimeError("truncated Rust derivative worker response")
            x = np.frombuffer(body, dtype="<f8", count=count, offset=offset)
            y = np.frombuffer(body, dtype="<f8", count=count, offset=x_end)
            offset = y_end
            output_numeric_bytes += count * 16
            cell_segments.append((x, y))
        cells.append(cell_segments)
    if offset != len(body):
        raise RuntimeError("Rust derivative worker response has trailing bytes")
    return {
        "worker_count": int(worker_count),
        "pool_init_ms": pool_init_ns / 1_000_000.0,
        "parallel_region_ms": parallel_region_ns / 1_000_000.0,
        "kernel_sum_ms": kernel_sum_ns / 1_000_000.0,
        "cells": cells,
        "cell_kernel_ms": cell_kernel_ms,
        "output_numeric_bytes": output_numeric_bytes,
        "response_payload_bytes": len(body),
        "_body": body,
    }


def _windows_memory_snapshot(pid: int) -> dict[str, int | None]:
    if platform.system() != "Windows":
        return {"working_set_bytes": None, "peak_working_set_bytes": None}

    class Counters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("page_fault_count", ctypes.c_ulong),
            ("peak_working_set_size", ctypes.c_size_t),
            ("working_set_size", ctypes.c_size_t),
            ("quota_peak_paged_pool_usage", ctypes.c_size_t),
            ("quota_paged_pool_usage", ctypes.c_size_t),
            ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
            ("quota_non_paged_pool_usage", ctypes.c_size_t),
            ("pagefile_usage", ctypes.c_size_t),
            ("peak_pagefile_usage", ctypes.c_size_t),
        ]

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return {"working_set_bytes": None, "peak_working_set_bytes": None}
    try:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        if not ok:
            return {"working_set_bytes": None, "peak_working_set_bytes": None}
        return {
            "working_set_bytes": int(counters.working_set_size),
            "peak_working_set_bytes": int(counters.peak_working_set_size),
        }
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _windows_cpu_seconds(pid: int) -> float | None:
    if platform.system() != "Windows":
        return None

    class FileTime(ctypes.Structure):
        _fields_ = [("low", ctypes.c_ulong), ("high", ctypes.c_ulong)]

    PROCESS_QUERY_INFORMATION = 0x0400
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        creation = FileTime()
        exit_time = FileTime()
        kernel = FileTime()
        user = FileTime()
        if not ctypes.windll.kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        kernel_ticks = (int(kernel.high) << 32) | int(kernel.low)
        user_ticks = (int(user.high) << 32) | int(user.low)
        return (kernel_ticks + user_ticks) / 10_000_000.0
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


class RustWorker:
    def __init__(self, executable: Path, workers: int):
        started = time.perf_counter()
        self.process = subprocess.Popen(
            [str(executable), "--workers", str(workers)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self.spawn_api_ms = (time.perf_counter() - started) * 1000.0
        if self.process.stdout is None:
            raise RuntimeError("Rust derivative worker ready pipe is unavailable")
        ready_length = struct.unpack("<I", _read_exact(self.process.stdout, 4))[0]
        ready_body = _read_exact(self.process.stdout, ready_length)
        if len(ready_body) != 12:
            raise RuntimeError("Rust derivative worker ready handshake is malformed")
        ready_magic, ready_version, ready_workers, ready_marker = struct.unpack(
            "<IHHI", ready_body
        )
        if (
            ready_magic != MAGIC
            or ready_version != VERSION
            or ready_workers != workers
            or ready_marker != READY_MARKER
        ):
            raise RuntimeError("Rust derivative worker ready handshake is invalid")
        self.spawn_to_ready_ms = (time.perf_counter() - started) * 1000.0
        self.ready_handshake_ms = self.spawn_to_ready_ms - self.spawn_api_ms
        self.workers = workers
        self.first = True

    def request(self, dataset: KernelDataset) -> dict[str, Any]:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("Rust derivative worker pipes are unavailable")
        total_started = time.perf_counter()
        frame, input_numeric_bytes, input_payload_bytes, encode_ms = _encode_request(dataset)
        before_memory = _windows_memory_snapshot(self.process.pid)
        before_cpu = _windows_cpu_seconds(self.process.pid)
        write_started = time.perf_counter()
        self.process.stdin.write(struct.pack("<I", len(frame)))
        self.process.stdin.write(frame)
        self.process.stdin.flush()
        write_ms = (time.perf_counter() - write_started) * 1000.0
        read_started = time.perf_counter()
        response_length = struct.unpack("<I", _read_exact(self.process.stdout, 4))[0]
        body = _read_exact(self.process.stdout, response_length)
        read_ms = (time.perf_counter() - read_started) * 1000.0
        decode_started = time.perf_counter()
        response = _decode_response(body)
        decode_ms = (time.perf_counter() - decode_started) * 1000.0
        after_memory = _windows_memory_snapshot(self.process.pid)
        after_cpu = _windows_cpu_seconds(self.process.pid)
        total_ms = (time.perf_counter() - total_started) * 1000.0
        response.update(
            {
                "encode_ms": encode_ms,
                "write_ms": write_ms,
                "read_ms": read_ms,
                "decode_ms": decode_ms,
                "boundary_wall_ms": total_ms,
                "python_to_native_ms": encode_ms + write_ms,
                "native_to_python_ms": read_ms + decode_ms,
                "input_numeric_bytes": input_numeric_bytes,
                "input_payload_bytes": input_payload_bytes,
                "output_bytes": response["output_numeric_bytes"],
                "copied_bytes": input_numeric_bytes,
                "borrowed_input": False,
                "output_conversion": "zero-copy NumPy views over response bytes",
                "cpu_seconds": (
                    max(0.0, after_cpu - before_cpu)
                    if after_cpu is not None and before_cpu is not None
                    else None
                ),
                "kernel_work_seconds": response["kernel_sum_ms"] / 1000.0,
                "memory_before": before_memory,
                "memory_after": after_memory,
                "cold": self.first,
            }
        )
        self.first = False
        return response

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.returncode:
            stderr = b""
            if self.process.stderr is not None:
                stderr = self.process.stderr.read()
            raise RuntimeError(
                f"Rust derivative worker exited {self.process.returncode}: "
                f"{stderr.decode(errors='replace')[-1000:]}"
            )

    def __enter__(self) -> "RustWorker":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _flatten_python_output(outputs: list[tuple[np.ndarray, np.ndarray]]) -> tuple[np.ndarray, np.ndarray]:
    if not outputs:
        return np.empty(0, dtype="float64"), np.empty(0, dtype="float64")
    return np.concatenate([item[0] for item in outputs]), np.concatenate([item[1] for item in outputs])


def _python_segment_kernel(
    segment: SegmentInput,
    *,
    mode: str,
    selected_phase: str,
    smoothing_window: int,
    absolute_discharge: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """Run only the selected numeric kernel on the Rust input boundary."""

    count = len(segment.capacity)
    x = np.full(count, np.nan, dtype="float64")
    y = np.full(count, np.nan, dtype="float64")
    if segment.phase not in {"charge", "discharge"} or (
        selected_phase != "both" and selected_phase != segment.phase
    ):
        return x, y
    finite_count = int((np.isfinite(segment.capacity) & np.isfinite(segment.voltage)).sum())
    if finite_count < 2:
        return x, y
    min_periods = min(smoothing_window, 3, finite_count)
    q_s = pd.Series(segment.capacity).rolling(
        smoothing_window,
        center=True,
        min_periods=min_periods,
    ).mean().to_numpy()
    v_s = pd.Series(segment.voltage).rolling(
        smoothing_window,
        center=True,
        min_periods=min_periods,
    ).mean().to_numpy()
    dq = np.gradient(q_s)
    dv = np.gradient(v_s)
    with np.errstate(divide="ignore", invalid="ignore"):
        derivative = np.divide(dq, dv) if mode == "dqdv" else np.divide(dv, dq)
    denominator = dv if mode == "dqdv" else dq
    derivative[np.abs(denominator) < 1e-10] = np.nan
    derivative[~np.isfinite(derivative)] = np.nan
    derivative[np.asarray(segment.explicit_cv, dtype=bool)] = np.nan
    q_finite = q_s[np.isfinite(q_s)]
    v_finite = v_s[np.isfinite(v_s)]
    if len(q_finite) >= 2 and len(v_finite) >= 2:
        q_span = float(np.nanpercentile(q_finite, 95) - np.nanpercentile(q_finite, 5))
        v_span = float(np.nanpercentile(v_finite, 95) - np.nanpercentile(v_finite, 5))
        scale = q_span / max(v_span, 1e-9) if mode == "dqdv" else v_span / max(q_span, 1e-9)
        if scale > 0 and np.isfinite(scale):
            derivative[np.abs(derivative) > scale * 50.0] = np.nan
    if segment.phase == "discharge" and absolute_discharge:
        derivative = np.abs(derivative)
    x[:] = v_s if mode == "dqdv" else q_s
    y[:] = derivative
    return x, y


def _run_python_segment_kernel(dataset: KernelDataset) -> list[tuple[np.ndarray, np.ndarray]]:
    outputs: list[tuple[np.ndarray, np.ndarray]] = []
    for cell in dataset.cells:
        segments = [
            _python_segment_kernel(
                segment,
                mode=dataset.mode,
                selected_phase=dataset.selected_phase,
                smoothing_window=dataset.smoothing_window,
                absolute_discharge=dataset.absolute_discharge,
            )
            for segment in cell.segments
        ]
        if segments:
            outputs.append(
                (
                    np.concatenate([item[0] for item in segments]),
                    np.concatenate([item[1] for item in segments]),
                )
            )
        else:
            empty = np.empty(0, dtype="float64")
            outputs.append((empty, empty))
    return outputs


def _flatten_rust_output(response: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, list[int]]:
    x_values: list[np.ndarray] = []
    y_values: list[np.ndarray] = []
    ordering: list[int] = []
    for index, cell in enumerate(response["cells"]):
        ordering.append(index)
        for x, y in cell:
            x_values.append(x)
            y_values.append(y)
    if not x_values:
        empty = np.empty(0, dtype="float64")
        return empty, empty, ordering
    return np.concatenate(x_values), np.concatenate(y_values), ordering


def _parity(
    reference: tuple[np.ndarray, np.ndarray],
    candidate: tuple[np.ndarray, np.ndarray],
    ordering_equal: bool = True,
) -> dict[str, Any]:
    reference_x, reference_y = reference
    candidate_x, candidate_y = candidate
    shape_equal = reference_x.shape == candidate_x.shape and reference_y.shape == candidate_y.shape
    if not shape_equal:
        return {
            "equal": False,
            "shape_equal": False,
            "finite_placement_equal": False,
            "max_absolute_deviation": None,
            "max_relative_deviation": None,
            "relative_tolerance": RELATIVE_TOLERANCE,
            "absolute_tolerance": ABSOLUTE_TOLERANCE,
            "ordering_equal": ordering_equal,
        }
    finite_x = np.isfinite(reference_x) == np.isfinite(candidate_x)
    finite_y = np.isfinite(reference_y) == np.isfinite(candidate_y)
    finite_placement_equal = bool(finite_x.all() and finite_y.all())
    finite_values = np.concatenate(
        [
            np.abs(reference_x[np.isfinite(reference_x) & np.isfinite(candidate_x)] - candidate_x[np.isfinite(reference_x) & np.isfinite(candidate_x)]),
            np.abs(reference_y[np.isfinite(reference_y) & np.isfinite(candidate_y)] - candidate_y[np.isfinite(reference_y) & np.isfinite(candidate_y)]),
        ]
    )
    reference_finite = np.concatenate(
        [reference_x[np.isfinite(reference_x) & np.isfinite(candidate_x)], reference_y[np.isfinite(reference_y) & np.isfinite(candidate_y)]]
    )
    max_abs = float(np.max(finite_values)) if len(finite_values) else 0.0
    max_rel = float(
        np.max(finite_values / np.maximum(np.abs(reference_finite), ABSOLUTE_TOLERANCE))
    ) if len(finite_values) else 0.0
    numeric_equal = bool(
        np.allclose(
            reference_x,
            candidate_x,
            rtol=RELATIVE_TOLERANCE,
            atol=ABSOLUTE_TOLERANCE,
            equal_nan=True,
        )
        and np.allclose(
            reference_y,
            candidate_y,
            rtol=RELATIVE_TOLERANCE,
            atol=ABSOLUTE_TOLERANCE,
            equal_nan=True,
        )
    )
    return {
        "equal": bool(shape_equal and finite_placement_equal and numeric_equal and ordering_equal),
        "shape_equal": shape_equal,
        "finite_placement_equal": finite_placement_equal,
        "max_absolute_deviation": max_abs,
        "max_relative_deviation": max_rel,
        "relative_tolerance": RELATIVE_TOLERANCE,
        "absolute_tolerance": ABSOLUTE_TOLERANCE,
        "ordering_equal": ordering_equal,
    }


def _run_python_reference(dataset: KernelDataset, repetitions: int) -> dict[str, Any]:
    # Warm the same segment-boundary adapter separately from reported C0 medians.
    _run_python_segment_kernel(dataset)
    samples: list[dict[str, Any]] = []
    for _ in range(repetitions):
        started_cpu = time.process_time()
        started = time.perf_counter()
        outputs = _run_python_segment_kernel(dataset)
        wall_ms = (time.perf_counter() - started) * 1000.0
        cpu_seconds = time.process_time() - started_cpu
        parity_result = _parity(
            _flatten_python_output(dataset.reference_outputs),
            _flatten_python_output(outputs),
        )
        samples.append(
            {
                "candidate": "C0",
                "workers": 0,
                "isolated_kernel_wall_ms": wall_ms,
                "complete_boundary_wall_ms": wall_ms,
                "python_to_native_ms": 0.0,
                "native_to_python_ms": 0.0,
                "rust_kernel_ms": None,
                "rayon_parallel_region_ms": None,
                "cpu_seconds": cpu_seconds,
                "effective_cores": cpu_seconds / (wall_ms / 1000.0) if wall_ms > 0 else None,
                "copied_bytes": 0,
                "borrowed_input": True,
                "output_conversion": "in-process NumPy arrays",
                "scientific_parity": parity_result,
                "status": "PASS" if parity_result["equal"] else "REJECTED",
            }
        )
    return {"samples": samples, "reference_outputs": dataset.reference_outputs}


def _run_rust_candidate(
    executable: Path,
    dataset: KernelDataset,
    reference_outputs: list[tuple[np.ndarray, np.ndarray]],
    repetitions: int,
    workers: int,
) -> dict[str, Any]:
    candidate_label = {1: "C1", 2: "C2", 4: "C3"}[workers]
    warm_samples: list[dict[str, Any]] = []
    cold_sample: dict[str, Any] | None = None
    with RustWorker(executable, workers) as worker:
        spawn_api_ms = worker.spawn_api_ms
        spawn_to_ready_ms = worker.spawn_to_ready_ms
        ready_handshake_ms = worker.ready_handshake_ms
        for repetition in range(repetitions + 1):
            response = worker.request(dataset)
            rust_x, rust_y, ordering = _flatten_rust_output(response)
            reference_x, reference_y = _flatten_python_output(reference_outputs)
            parity_result = _parity(
                (reference_x, reference_y),
                (rust_x, rust_y),
                ordering_equal=ordering == list(range(dataset.cell_count)),
            )
            row = {
                "candidate": candidate_label,
                "workers": workers,
                "isolated_kernel_wall_ms": response["parallel_region_ms"],
                "complete_boundary_wall_ms": response["boundary_wall_ms"],
                "python_to_native_ms": response["python_to_native_ms"],
                "native_to_python_ms": response["native_to_python_ms"],
                "rust_kernel_ms": response["kernel_sum_ms"],
                "rayon_parallel_region_ms": response["parallel_region_ms"],
                "per_cell_kernel_ms": response["cell_kernel_ms"],
                "rayon_pool_init_ms": response["pool_init_ms"],
                "cpu_seconds": response["cpu_seconds"],
                "kernel_work_seconds": response["kernel_work_seconds"],
                "effective_cores": (
                    response["kernel_sum_ms"] / response["parallel_region_ms"]
                    if response["parallel_region_ms"] > 0
                    else None
                ),
                "spawn_api_ms": spawn_api_ms if repetition == 0 else None,
                "spawn_to_ready_ms": spawn_to_ready_ms if repetition == 0 else None,
                "ready_handshake_ms": ready_handshake_ms if repetition == 0 else None,
                "copied_bytes": response["copied_bytes"],
                "input_numeric_bytes": response["input_numeric_bytes"],
                "output_bytes": response["output_bytes"],
                "borrowed_input": response["borrowed_input"],
                "output_conversion": response["output_conversion"],
                "memory_before": response["memory_before"],
                "memory_after": response["memory_after"],
                "scientific_parity": parity_result,
                "status": "PASS" if parity_result["equal"] else "REJECTED",
            }
            if repetition == 0:
                cold_sample = {**row, "lifecycle": "cold_first_call"}
            else:
                warm_samples.append({**row, "lifecycle": "warm"})
    if cold_sample is None:
        raise RuntimeError("Rust candidate produced no cold lifecycle sample")
    return {"cold": cold_sample, "samples": warm_samples}


def _select_workloads(cell_ids: list[int], requested: set[str]) -> list[dict[str, Any]]:
    workloads: list[dict[str, Any]] = []
    for count in (1, 3, 6, 10):
        if len(cell_ids) < count:
            continue
        workloads.append(
            {
                "scenario": f"derivative-{count}-all-dqdv",
                "cell_ids": cell_ids[:count],
                "cycles": [],
                "cycle_end": None,
                "x_axis": "capacity_mah",
                "view": "dqdv",
                "derivative_specific": False,
            }
        )
    if len(cell_ids) >= 1:
        workloads.extend(
            [
                {
                    "scenario": "derivative-1-all-dvdq",
                    "cell_ids": cell_ids[:1],
                    "cycles": [],
                    "cycle_end": None,
                    "x_axis": "capacity_mah",
                    "view": "dvdq",
                    "derivative_specific": False,
                },
                {
                    "scenario": "derivative-small-1-3-dqdv",
                    "cell_ids": cell_ids[:1],
                    "cycles": list(range(1, 4)),
                    "cycle_end": 3,
                    "x_axis": "capacity_mah",
                    "view": "dqdv",
                    "derivative_specific": False,
                },
            ]
        )
    if requested:
        unknown = requested - {str(item["scenario"]) for item in workloads}
        if unknown:
            raise ValueError(f"unknown derivative workload(s): {', '.join(sorted(unknown))}")
        return [item for item in workloads if item["scenario"] in requested]
    return workloads


def _rust_build(executable: Path, skip_build: bool) -> dict[str, Any]:
    manifest = ROOT / "scripts" / "rust_derivative_kernel" / "Cargo.toml"
    started = time.perf_counter()
    if not skip_build:
        subprocess.run(
            ["cargo", "build", "--release", "--manifest-path", str(manifest), "--locked"],
            cwd=ROOT,
            check=True,
        )
    rustc = subprocess.run(["rustc", "-Vv"], capture_output=True, text=True, check=True)
    rustc_lines = {}
    for line in rustc.stdout.splitlines():
        if ": " in line:
            key, value = line.split(": ", 1)
            if key in {"rustc", "binary", "commit-hash", "host", "release", "LLVM version"}:
                rustc_lines[key] = value
    if not executable.is_file():
        raise FileNotFoundError(executable)
    return {
        "status": "PASS",
        "profile": "release",
        "target": rustc_lines.get("host"),
        "rustc": rustc_lines,
        "build_flags": ["--release"],
        "build_wall_ms": (time.perf_counter() - started) * 1000.0,
        "binding": "persistent length-prefixed subprocess; no production Python extension",
        "rayon_version": "1.12.0 (Cargo.lock)",
    }


def _decision(c0: float | None, candidate: float | None) -> str:
    if c0 is None or candidate is None or c0 <= 0:
        return "not_measurable"
    improvement = (c0 - candidate) / c0
    return "useful" if improvement >= 0.05 else "not_material"


def _relative_change(reference: float | None, candidate: float | None) -> float | None:
    if reference is None or candidate is None or reference == 0:
        return None
    return (candidate / reference - 1.0) * 100.0


def _summarize_workload(item: dict[str, Any]) -> dict[str, Any]:
    rows = item["rows"]
    medians = {
        candidate: _median(
            row.get("isolated_kernel_wall_ms")
            for row in rows
            if row.get("candidate") == candidate
        )
        for candidate in ("C0", "C1", "C2", "C3")
    }
    boundary_medians = {
        candidate: _median(
            row.get("complete_boundary_wall_ms")
            for row in rows
            if row.get("candidate") == candidate
        )
        for candidate in ("C0", "C1", "C2", "C3")
    }
    return {
        "candidate_kernel_medians_ms": medians,
        "candidate_kernel_ranges_ms": {
            candidate: _range(
                row.get("isolated_kernel_wall_ms")
                for row in rows
                if row.get("candidate") == candidate
            )
            for candidate in ("C0", "C1", "C2", "C3")
        },
        "candidate_boundary_medians_ms": boundary_medians,
        "sequential_native_change_pct": _relative_change(medians["C0"], medians["C1"]),
        "rayon_2_change_vs_c1_pct": _relative_change(medians["C1"], medians["C2"]),
        "rayon_4_change_vs_c1_pct": _relative_change(medians["C1"], medians["C3"]),
        "decisions": {
            "sequential_native": _decision(medians["C0"], medians["C1"]),
            "rayon_2": _decision(medians["C1"], medians["C2"]),
            "rayon_4": _decision(medians["C1"], medians["C3"]),
        },
        "backend_context_median_ms": item.get("backend_context_median_ms"),
        "scientific_status": "PASS" if all(row["status"] == "PASS" for row in rows) else "REJECTED",
    }


def _profile_suite(
    env: Any,
    base: dict[str, Any],
    cell_ids: list[int],
    suite: str,
    executable: Path,
    repetitions: int,
    requested: set[str],
) -> list[dict[str, Any]]:
    workloads = _select_workloads(cell_ids, requested)
    results: list[dict[str, Any]] = []
    for workload in workloads:
        print(f"profiling {suite}/{workload['scenario']}", flush=True)
        dataset = _build_dataset(env, base, workload, suite, repetitions)
        python_reference = _run_python_reference(dataset, repetitions)
        rows = python_reference["samples"]
        lifecycle: dict[str, Any] = {}
        for workers in RAYON_WORKERS:
            candidate = _run_rust_candidate(
                executable,
                dataset,
                python_reference["reference_outputs"],
                repetitions,
                workers,
            )
            rows.extend(candidate["samples"])
            lifecycle[{1: "C1", 2: "C2", 4: "C3"}[workers]] = candidate["cold"]
        item = {
            "suite": suite,
            "scenario": dataset.scenario,
            "cell_count": dataset.cell_count,
            "segment_count": sum(len(cell.segments) for cell in dataset.cells),
            "input_rows": sum(len(cell.capacity) for cell in dataset.cells),
            "owner_buffer_prepare_ms": dataset.owner_buffer_prepare_ms,
            "owner_buffer_prepare_note": "status classification, contiguous segment scan, finite flags and numeric buffer materialization; measured once outside C0-C3 kernel timers",
            "mode": dataset.mode,
            "selected_phase": dataset.selected_phase,
            "smoothing_window": dataset.smoothing_window,
            "repetitions": repetitions,
            "backend_context_median_ms": _median(dataset.backend_context_ms),
            "backend_context_range_ms": _range(dataset.backend_context_ms),
            "backend_context_note": "current Python request only; Rust candidates remain isolated and are not wired into production",
            "rows": rows,
            "cold_lifecycle": lifecycle,
        }
        item.update(_summarize_workload(item))
        results.append(item)
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=DEFAULT_REPETITIONS)
    parser.add_argument(
        "--app-data-root",
        type=Path,
        default=Path.home() / ".cellxplorer",
    )
    parser.add_argument("--fixture-only", action="store_true")
    parser.add_argument("--scenario", action="append")
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if args.repetitions < 5:
        parser.error("050.10 requires at least five warm repetitions")

    executable = (
        ROOT
        / "scripts"
        / "rust_derivative_kernel"
        / "target"
        / "release"
        / "cellxplorer-05010-rust-derivative-kernel.exe"
    )
    build = _rust_build(executable, args.skip_build)
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
    skipped: dict[str, str] = {}
    try:
        with GoldenFixtureEnvironment.create() as env:
            clone_ids = clone_golden_source_cells(env, 10)
            selected = [101, *clone_ids[:9]]
            suites.extend(
                _profile_suite(
                    env,
                    fixture_base,
                    selected,
                    "golden_fixture",
                    executable,
                    args.repetitions,
                    requested,
                )
            )
        if not args.fixture_only:
            app_root = args.app_data_root.resolve()
            if not (app_root / "cellxplorer.db").is_file():
                skipped["application"] = f"database not found at {app_root / 'cellxplorer.db'}"
            else:
                try:
                    with create_application_environment(app_root) as env:
                        app_base, app_cells, metadata = discover_application_dataset(env)
                        app_items = _profile_suite(
                            env,
                            app_base,
                            app_cells,
                            "application_performance_batch",
                            executable,
                            args.repetitions,
                            requested,
                        )
                        for item in app_items:
                            item["dataset"] = {
                                "analysis_id": metadata.get("analysis_id"),
                                "saved_selection_cell_count": metadata.get("saved_selection_cell_count"),
                                "benchmark_cell_count": metadata.get("benchmark_cell_count"),
                            }
                        suites.extend(app_items)
                except (FileNotFoundError, RuntimeError, OSError) as exc:
                    skipped["application"] = f"NOT RUN: {type(exc).__name__}: {exc}"
    finally:
        restore_data_root_binding(saved_data_root)

    if not suites:
        raise RuntimeError("050.10 produced no workload evidence")
    report = {
        "spec": "050.10",
        "status": "PASS" if all(item["scientific_status"] == "PASS" for item in suites) else "REJECTED",
        "kernel": {
            "name": "derivative rolling + gradient + ratio/filter + postprocess",
            "source_evidence": "050.9 derivative stage and its recorded substages",
            "algorithm": "same centered rolling, NumPy-gradient-equivalent finite differences, ratio thresholds, percentile scale filter, CV mask and discharge sign rule",
            "python_reference_boundary": "C0 consumes the same already-segmented numeric buffers as C1/C2/C3; the current engine output is the parity oracle",
            "production_integration": "NOT RUN / prohibited by child scope",
        },
        "binding": build,
        "workloads": suites,
        "skipped_suites": skipped,
        "native_settings": native_thread_settings(),
        "boundary_contract": {
            "python_owner": "request/ORM/session lifecycle, source/protocol/provenance resolution, cache identity and result assembly",
            "rust_owner": "numeric derivative kernel over contiguous per-segment float64/u8 buffers",
            "input_copy_status": "copied into a length-prefixed subprocess frame; borrowed zero-copy input is not claimed",
            "output_conversion": "NumPy views over response bytes; output conversion is recorded separately",
            "owner_preparation": "status classification, contiguous segment scan, finite flags and buffer materialization measured once outside C0-C3 kernel timers",
            "workers": [1, 2, 4],
            "rayon_scheduling": "not separately measured; per-Cell elapsed times, aggregate kernel work and parallel_region_ms are retained",
            "nested_native_threading": "Rayon only in the isolated worker; Python/native settings are recorded above",
        },
        "scientific_gate": {
            "relative_tolerance": RELATIVE_TOLERANCE,
            "absolute_tolerance": ABSOLUTE_TOLERANCE,
            "finite_nonfinite_placement": "required equal",
            "cell_ordering": "required selection order",
            "provenance": "not part of numeric kernel output; Python ownership retained",
        },
        "decision_summary": {
            "sequential_native": "see per-workload C1 vs C0; choose only if boundary and build costs remain acceptable",
            "rayon": "see per-workload C2/C3 vs C1; small-work crossing cost is intentionally included",
            "cold_warm": "cold first call and warm medians are separate; Rayon pool initialization is reported only on the first call",
            "050.11_handoff": "select at most the smallest independently useful native mechanism after reviewing C1/C2/C3, boundary, lifecycle and parity evidence",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "spec": report["spec"],
                "status": report["status"],
                "workloads": len(suites),
                "output": str(args.output),
                "skipped_suites": skipped,
            },
            indent=2,
        )
    )
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
