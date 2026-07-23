"""DCIR protocol recognition and rest/pulse resistance calculations."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd


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

    work = frame.reset_index(drop=True).copy()
    steps = pd.to_numeric(work[step_column], errors="coerce")
    boundary = steps.ne(steps.shift())
    if "cycle" in work.columns:
        cycles = pd.to_numeric(work["cycle"], errors="coerce")
        boundary |= cycles.ne(cycles.shift())
    if "time_s" in work.columns:
        times = pd.to_numeric(work["time_s"], errors="coerce")
        boundary |= times.lt(times.shift())
    work["_run"] = boundary.fillna(True).cumsum()
    runs = [
        (int(run_id), chunk)
        for run_id, chunk in work.groupby("_run", sort=True)
    ]

    if origin_timestamp is None and "timestamp" in work.columns:
        timestamps = pd.to_datetime(work["timestamp"], errors="coerce").dropna()
        if len(timestamps):
            origin_timestamp = timestamps.min()

    rows: list[dict] = []
    for (_, rest), (_, pulse) in zip(runs, runs[1:]):
        rest_step = _finite_float(rest[step_column].iloc[0])
        pulse_step = _finite_float(pulse[step_column].iloc[0])
        if rest_step != rest_step_index or pulse_step != pulse_step_index:
            continue
        v_rest = _last_finite(rest, "voltage_v")
        v_pulse = _last_finite(pulse, "voltage_v")
        currents = (
            pd.to_numeric(pulse["current_ma"], errors="coerce").abs()
            if "current_ma" in pulse.columns
            else pd.Series(dtype="float64")
        )
        currents = currents[np.isfinite(currents) & (currents > 1e-12)]
        current_ma = float(currents.median()) if len(currents) else None
        if v_rest is None or v_pulse is None or current_ma is None:
            continue
        delta_v = (
            v_rest - v_pulse
            if direction == "discharge"
            else v_pulse - v_rest
        )
        dcir_mohm = 1_000_000.0 * delta_v / current_ma
        if not math.isfinite(dcir_mohm):
            continue

        cycle = _last_finite(pulse, "cycle")
        start_time_h = None
        if origin_timestamp is not None and "timestamp" in rest.columns:
            timestamps = pd.to_datetime(rest["timestamp"], errors="coerce").dropna()
            if len(timestamps):
                start_time_h = float(
                    (timestamps.iloc[0] - origin_timestamp).total_seconds() / 3600
                )
        c_rate = None
        nominal = _finite_float(nominal_capacity_mah)
        if nominal is not None and nominal > 0:
            c_rate = current_ma / nominal
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
                "rest_duration_s": _duration_seconds(rest),
                "pulse_duration_s": _duration_seconds(pulse),
            }
        )
    return pd.DataFrame(rows, columns=columns)
