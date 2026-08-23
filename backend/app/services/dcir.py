"""DCIR protocol recognition and rest/pulse resistance calculations."""

from __future__ import annotations

import math
from time import perf_counter
from typing import Any

import numpy as np
import pandas as pd


def _profile_started(profiling: dict[str, Any] | None) -> float | None:
    return perf_counter() if profiling is not None else None


def _profile_finished(
    profiling: dict[str, Any] | None,
    name: str,
    started: float | None,
) -> None:
    if profiling is None or started is None:
        return
    profiling.setdefault("stages_ms", {})[name] = (
        profiling.setdefault("stages_ms", {}).get(name, 0.0)
        + (perf_counter() - started) * 1000.0
    )
    profiling.setdefault("calls", {})[name] = (
        profiling.setdefault("calls", {}).get(name, 0) + 1
    )


def _profile_count(
    profiling: dict[str, Any] | None,
    name: str,
    value: int,
) -> None:
    if profiling is None:
        return
    profiling.setdefault("counts", {})[name] = (
        profiling.setdefault("counts", {}).get(name, 0) + int(value)
    )


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def format_c_rate(value: float | None) -> str | None:
    """Prefer familiar C/X labels when a decimal rate is close to one."""
    rate = _finite_float(value)
    if rate is None or rate <= 0:
        return None
    if rate >= 1 and abs(rate - round(rate)) <= 0.03:
        return f"{int(round(rate))}C"
    denominator = round(1 / rate)
    if denominator >= 2 and abs(rate - 1 / denominator) <= max(0.01, rate * 0.04):
        return f"C/{denominator}"
    return f"{rate:.3g}C"


def candidate_label(candidate: dict) -> str:
    direction = str(candidate.get("direction") or "pulse").capitalize()
    rate = format_c_rate(candidate.get("c_rate"))
    if rate:
        return f"{direction} {rate}"
    current = _finite_float(candidate.get("current_ma"))
    if current is not None:
        return f"{direction} {abs(current):.3g} mA"
    return f"{direction} pulse"


def detect_candidates(
    protocol: dict,
    *,
    min_rest_s: float = 600,
    max_pulse_s: float = 120,
    min_ratio: float = 10,
) -> list[dict]:
    """Find executable long-rest/short-pulse pairs in a reconstructed protocol."""
    signature = str(protocol.get("signature") or "")
    steps = [
        step
        for step in (protocol.get("steps") or [])
        if isinstance(step, dict) and step.get("direction") != "control"
    ]
    candidates: list[dict] = []
    for rest, pulse in zip(steps, steps[1:]):
        if rest.get("direction") != "rest":
            continue
        direction = pulse.get("direction")
        if direction not in {"charge", "discharge"}:
            continue
        rest_s = _finite_float(rest.get("time_limit_s"))
        pulse_s = _finite_float(pulse.get("time_limit_s"))
        if rest_s is None or pulse_s is None or pulse_s <= 0:
            continue
        ratio = rest_s / pulse_s
        if rest_s < min_rest_s or pulse_s > max_pulse_s or ratio < min_ratio:
            continue
        current_ma = _finite_float(pulse.get("current_ma"))
        c_rate = _finite_float(pulse.get("c_rate"))
        candidate = {
            "id": (
                f"{signature}:{int(rest.get('number'))}:"
                f"{int(pulse.get('number'))}"
            ),
            "protocol_signature": signature,
            "rest_step_index": int(rest.get("number")),
            "pulse_step_index": int(pulse.get("number")),
            "direction": direction,
            "current_ma": current_ma,
            "c_rate": c_rate,
            "rest_duration_s": rest_s,
            "pulse_duration_s": pulse_s,
            "rest_pulse_ratio": ratio,
        }
        candidate["label"] = candidate_label(candidate)
        candidates.append(candidate)
    return candidates


def _last_finite(frame: pd.DataFrame, column: str) -> float | None:
    if column not in frame.columns:
        return None
    values = pd.to_numeric(frame[column], errors="coerce")
    values = values[np.isfinite(values)]
    return float(values.iloc[-1]) if len(values) else None


def _duration_seconds(frame: pd.DataFrame) -> float | None:
    if "timestamp" in frame.columns:
        timestamps = pd.to_datetime(frame["timestamp"], errors="coerce").dropna()
        if len(timestamps) >= 2:
            return max(0.0, float((timestamps.iloc[-1] - timestamps.iloc[0]).total_seconds()))
    if "time_s" in frame.columns:
        values = pd.to_numeric(frame["time_s"], errors="coerce")
        values = values[np.isfinite(values)]
        if len(values):
            return max(0.0, float(values.max() - values.min()))
    return None


def per_occurrence(
    frame: pd.DataFrame,
    *,
    rest_step_index: int,
    pulse_step_index: int,
    direction: str,
    nominal_capacity_mah: float | None = None,
    origin_timestamp: pd.Timestamp | None = None,
    profiling: dict[str, Any] | None = None,
) -> pd.DataFrame:
    """Measure each adjacent rest/pulse occurrence in one source-file frame."""
    columns = [
        "occurrence",
        "cycle",
        "start_time_h",
        "v_rest_v",
        "v_pulse_v",
        "current_ma",
        "c_rate",
        "dcir_mohm",
        "rest_duration_s",
        "pulse_duration_s",
    ]
    if frame.empty:
        return pd.DataFrame(columns=columns)
    step_column = "step_index" if "step_index" in frame.columns else "step"
    if step_column not in frame.columns:
        return pd.DataFrame(columns=columns)

    started = _profile_started(profiling)
    work = frame.reset_index(drop=True)

    def numeric_array(column: str) -> np.ndarray | None:
        if column not in work.columns:
            return None
        return pd.to_numeric(work[column], errors="coerce").to_numpy(
            dtype="float64",
        )

    step_values = numeric_array(step_column)
    cycle_values = numeric_array("cycle")
    time_values = numeric_array("time_s")
    record_values = numeric_array("record_index")
    voltage_values = numeric_array("voltage_v")
    current_values = numeric_array("current_ma")
    timestamp_values = (
        pd.to_datetime(work["timestamp"], errors="coerce")
        if "timestamp" in work.columns
        else None
    )
    _profile_finished(profiling, "dcir_frame_normalization", started)

    started = _profile_started(profiling)
    steps = pd.Series(step_values, index=work.index)
    boundary = steps.ne(steps.shift())
    if cycle_values is not None:
        cycles = pd.Series(cycle_values, index=work.index)
        boundary |= cycles.ne(cycles.shift())
    if time_values is not None:
        times = pd.Series(time_values, index=work.index)
        boundary |= times.lt(times.shift())
    if record_values is not None:
        record_index = pd.Series(record_values, index=work.index)
        # A selective detail read retains source positions. Preserve the
        # existing adjacency/completeness rule when unrequested protocol
        # steps are omitted from the frame.
        boundary |= record_index.diff().ne(1)
    boundary_values = boundary.fillna(True).to_numpy(dtype=bool, copy=False)
    run_starts = np.flatnonzero(boundary_values)
    _profile_finished(profiling, "dcir_run_boundary_construction", started)

    started = _profile_started(profiling)
    run_ends = np.concatenate(
        (
            run_starts[1:],
            np.asarray([len(work)], dtype="int64"),
        )
    )
    runs = list(zip(run_starts.tolist(), run_ends.tolist()))
    if origin_timestamp is None and timestamp_values is not None:
        valid_timestamps = timestamp_values.dropna()
        if len(valid_timestamps):
            origin_timestamp = valid_timestamps.min()
    _profile_finished(profiling, "dcir_run_metadata_construction", started)
    _profile_count(profiling, "input_rows", len(work))
    _profile_count(profiling, "runs", len(runs))

    def last_finite(
        values: np.ndarray | None,
        start: int,
        end: int,
    ) -> float | None:
        if values is None:
            return None
        selected = values[start:end]
        finite = selected[np.isfinite(selected)]
        return float(finite[-1]) if len(finite) else None

    def timestamp_slice(start: int, end: int) -> pd.Series | None:
        if timestamp_values is None:
            return None
        return timestamp_values.iloc[start:end].dropna()

    def duration_seconds(
        start: int,
        end: int,
        timestamps: pd.Series | None,
    ) -> float | None:
        if timestamps is not None and len(timestamps) >= 2:
            return max(
                0.0,
                float((timestamps.iloc[-1] - timestamps.iloc[0]).total_seconds()),
            )
        if time_values is not None:
            selected = time_values[start:end]
            finite = selected[np.isfinite(selected)]
            if len(finite):
                return max(0.0, float(finite.max() - finite.min()))
        return None

    rows: list[dict] = []
    nominal = _finite_float(nominal_capacity_mah)
    for (rest_start, rest_end), (pulse_start, pulse_end) in zip(
        runs,
        runs[1:],
    ):
        started = _profile_started(profiling)
        rest_step = _finite_float(step_values[rest_start])
        pulse_step = _finite_float(step_values[pulse_start])
        matching = rest_step == rest_step_index and pulse_step == pulse_step_index
        _profile_finished(profiling, "dcir_adjacency_scanning", started)
        if not matching:
            continue

        started = _profile_started(profiling)
        v_rest = last_finite(voltage_values, rest_start, rest_end)
        v_pulse = last_finite(voltage_values, pulse_start, pulse_end)
        if current_values is not None:
            currents = np.abs(current_values[pulse_start:pulse_end])
            currents = currents[np.isfinite(currents) & (currents > 1e-12)]
            current_ma = float(np.median(currents)) if len(currents) else None
        else:
            current_ma = None
        cycle = last_finite(cycle_values, pulse_start, pulse_end)
        rest_timestamps = timestamp_slice(rest_start, rest_end)
        pulse_timestamps = timestamp_slice(pulse_start, pulse_end)
        start_time_h = None
        if origin_timestamp is not None and rest_timestamps is not None:
            if len(rest_timestamps):
                start_time_h = float(
                    (rest_timestamps.iloc[0] - origin_timestamp).total_seconds()
                    / 3600
                )
        rest_duration_s = duration_seconds(rest_start, rest_end, rest_timestamps)
        pulse_duration_s = duration_seconds(pulse_start, pulse_end, pulse_timestamps)
        c_rate = (
            current_ma / nominal
            if current_ma is not None and nominal is not None and nominal > 0
            else None
        )
        _profile_finished(profiling, "dcir_scalar_extraction", started)
        if v_rest is None or v_pulse is None or current_ma is None:
            continue

        started = _profile_started(profiling)
        delta_v = (
            v_rest - v_pulse
            if direction == "discharge"
            else v_pulse - v_rest
        )
        dcir_mohm = 1_000_000.0 * delta_v / current_ma
        if not math.isfinite(dcir_mohm):
            _profile_finished(profiling, "dcir_quantity_calculation", started)
            continue
        rows.append(
            {
                "occurrence": len(rows) + 1,
                "cycle": int(cycle) if cycle is not None else None,
                "start_time_h": start_time_h,
                "v_rest_v": v_rest,
                "v_pulse_v": v_pulse,
                "current_ma": current_ma,
                "c_rate": c_rate,
                "dcir_mohm": dcir_mohm,
                "rest_duration_s": rest_duration_s,
                "pulse_duration_s": pulse_duration_s,
            }
        )
        _profile_finished(profiling, "dcir_quantity_calculation", started)
        _profile_count(profiling, "valid_occurrences", 1)
    return pd.DataFrame(rows, columns=columns)
