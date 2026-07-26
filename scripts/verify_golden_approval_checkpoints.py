#!/usr/bin/env python3
"""Independent scientific checkpoint verification for the golden corpus."""
from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

import numpy as np
import pandas as pd

from golden_analysis_support import GoldenFixtureEnvironment, fixture_root, load_manifest

FIXTURE = fixture_root()

MANDATORY_CHECKPOINTS = (
    "checkpoint_1_cc_cv_capacity",
    "checkpoint_2_efficiency",
    "checkpoint_3_time_capacity_reset",
    "checkpoint_4_steps_duration",
    "checkpoint_5_dcir",
    "checkpoint_6_chargeability",
    "checkpoint_7_rate_capability",
)


def _load_json(folder: str, name: str) -> dict[str, Any]:
    return json.loads((FIXTURE / folder / name).read_text(encoding="utf-8"))


def _case(env: GoldenFixtureEnvironment, case_id: str) -> dict[str, Any]:
    return next(item for item in env.manifest["cases"] if item["id"] == case_id)


def _raw_for_key(env: GoldenFixtureEnvironment, source_key: str) -> pd.DataFrame:
    source = next(item for item in env.manifest["sources"] if item["key"] == source_key)
    from golden_analysis_support import cache

    env.ensure_sources_parsed()
    return pd.read_parquet(cache.raw_path(source["sha256"]))


def _source_record(env: GoldenFixtureEnvironment, source_key: str):
    from app.models import SourceFile

    source = next(item for item in env.manifest["sources"] if item["key"] == source_key)
    return env.db.query(SourceFile).filter(SourceFile.hash == source["sha256"]).one()


def _nominal_capacity(env: GoldenFixtureEnvironment, source_key: str) -> float:
    source = next(item for item in env.manifest["sources"] if item["key"] == source_key)
    cell = next(
        item
        for item in env.manifest["entities"]["cells"]
        if item["id"] == source["fixture_cell_id"]
    )
    return float(cell["metadata"]["nominal_capacity_mah"])


def load_checkpoint_inputs(env: GoldenFixtureEnvironment) -> dict[str, Any]:
    """Load raw, protocol, expected, and freshly detected inputs once."""
    expected_names = (
        "cycles_baseline",
        "time_capacity_baseline",
        "steps_baseline",
        "dcir_baseline",
        "chargeability_baseline",
        "rate_capability_baseline",
    )
    spec_names = (
        "time_capacity_baseline",
        "steps_baseline",
        "dcir_baseline",
        "chargeability_baseline",
        "rate_capability_baseline",
    )
    return {
        "raw": {
            "cycles_time_steps": _raw_for_key(env, "cycles_time_steps"),
            "dcir": _raw_for_key(env, "dcir"),
            "chargeability": _raw_for_key(env, "chargeability"),
            "rate_capability": _raw_for_key(env, "rate_capability"),
        },
        "expected": {
            name: _load_json("expected", f"{name}.json")
            for name in expected_names
        },
        "specs": {
            name: _load_json("specs", f"{name}.json")
            for name in spec_names
        },
        "detected": {
            "rate_capability": env.run_case(_case(env, "rate_capability_baseline")),
        },
        "headers": {
            "chargeability": _source_record(env, "chargeability").header_meta,
        },
        "nominal_capacity_mah": {
            "chargeability": _nominal_capacity(env, "chargeability"),
            "rate_capability": _nominal_capacity(env, "rate_capability"),
        },
    }


def _charge_mask(df: pd.DataFrame) -> pd.Series:
    current = pd.to_numeric(df.get("current_ma"), errors="coerce")
    return current > 0


def _discharge_mask(df: pd.DataFrame) -> pd.Series:
    current = pd.to_numeric(df.get("current_ma"), errors="coerce")
    return current < 0


def _phase_total(df: pd.DataFrame, col: str, mask: pd.Series, cycle: int) -> float:
    sub = df.loc[mask & (df["cycle"] == cycle), ["step", col]].copy()
    sub[col] = pd.to_numeric(sub[col], errors="coerce")
    if sub.empty:
        return 0.0
    per_step = sub.groupby("step", sort=False)[col].agg(["min", "max"])
    return float((per_step["max"] - per_step["min"]).clip(lower=0.0).sum())


def _close(
    actual: float | None,
    expected: float | None,
    *,
    rel_tol: float = 1e-6,
    abs_tol: float = 1e-6,
) -> bool:
    if actual is None or expected is None:
        return actual is expected
    return math.isclose(
        float(actual), float(expected), rel_tol=rel_tol, abs_tol=abs_tol
    )


def checkpoint_cc_cv_capacity(raw: pd.DataFrame, expected: dict[str, Any]) -> dict[str, Any]:
    cycle = 1
    manual = _phase_total(raw, "charge_capacity_mah", _charge_mask(raw), cycle)
    golden = expected["cell_series"][0]["quantities"]["charge_capacity_mah"][0]
    match = _close(manual, golden, abs_tol=1e-6)
    return {
        "case": "cycles_baseline",
        "cycle": cycle,
        "formula": "sum per charge step of max(charge_capacity_mah)-min(charge_capacity_mah)",
        "unit": "mAh",
        "independent_mah": manual,
        "golden_mah": golden,
        "abs_diff_mah": abs(manual - golden),
        "match": match,
    }


def checkpoint_efficiency(raw: pd.DataFrame, expected: dict[str, Any]) -> dict[str, Any]:
    cycle = 1
    charge = _charge_mask(raw)
    discharge = _discharge_mask(raw)
    charge_capacity = _phase_total(raw, "charge_capacity_mah", charge, cycle)
    discharge_capacity = _phase_total(raw, "discharge_capacity_mah", discharge, cycle)
    charge_energy = _phase_total(raw, "charge_energy_mwh", charge, cycle)
    discharge_energy = _phase_total(raw, "discharge_energy_mwh", discharge, cycle)
    manual_ce = discharge_capacity / charge_capacity * 100.0
    manual_ee = discharge_energy / charge_energy * 100.0
    series = expected["cell_series"][0]
    golden_ce = series["quantities"]["coulombic_efficiency_pct"][0]
    golden_ee = series["quantities"]["energy_efficiency_pct"][0]
    ce_match = _close(manual_ce, golden_ce, abs_tol=1e-4)
    ee_match = _close(manual_ee, golden_ee, abs_tol=1e-4)
    return {
        "case": "cycles_baseline",
        "cycle": cycle,
        "ce_formula": "discharge_capacity_mah / charge_capacity_mah * 100",
        "ee_formula": "discharge_energy_mwh / charge_energy_mwh * 100",
        "independent_ce_pct": manual_ce,
        "golden_ce_pct": golden_ce,
        "independent_ee_pct": manual_ee,
        "golden_ee_pct": golden_ee,
        "ce_match": ce_match,
        "ee_match": ee_match,
        "match": ce_match and ee_match,
    }


def _independent_phases(frame: pd.DataFrame) -> list[str]:
    status = frame.get("status", pd.Series("", index=frame.index)).astype(str).str.lower()
    current = pd.to_numeric(
        frame.get("current_ma", pd.Series(np.nan, index=frame.index)),
        errors="coerce",
    ).to_numpy(dtype="float64")
    discharge = (
        status.str.contains("dchg").to_numpy()
        | status.str.contains("discharge").to_numpy()
        | (current < 0)
    )
    charge = (
        ~discharge
        & (
            status.str.contains("chg").to_numpy()
            | status.str.contains("charge").to_numpy()
            | (current > 0)
        )
    )
    return np.select(
        [discharge, charge], ["discharge", "charge"], default="rest"
    ).tolist()


def _independent_continuous_time(frame: pd.DataFrame) -> np.ndarray:
    values = pd.to_numeric(frame["time_s"], errors="coerce").to_numpy(dtype="float64")
    if len(values) < 2:
        return values
    resets = np.flatnonzero(np.diff(values) < 0)
    offsets = np.zeros(len(values), dtype="float64")
    offsets[resets + 1] = values[resets]
    return values + np.cumsum(offsets)


def _independent_phase_capacity(
    frame: pd.DataFrame,
    phases: list[str],
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    charge = pd.to_numeric(
        frame.get("charge_capacity_mah", pd.Series(np.nan, index=frame.index)),
        errors="coerce",
    ).to_numpy(dtype="float64")
    discharge = pd.to_numeric(
        frame.get("discharge_capacity_mah", pd.Series(np.nan, index=frame.index)),
        errors="coerce",
    ).to_numpy(dtype="float64")
    phase_array = np.asarray(phases)
    best = np.where(
        np.isnan(charge),
        discharge,
        np.where(np.isnan(discharge), charge, np.maximum(charge, discharge)),
    )
    raw_capacity = np.where(
        (phase_array == "discharge") & np.isfinite(discharge),
        discharge,
        np.where((phase_array == "charge") & np.isfinite(charge), charge, best),
    )
    cycles = pd.to_numeric(frame["cycle"], errors="coerce").to_numpy()
    output = raw_capacity.copy()
    resets: list[dict[str, Any]] = []
    carry = 0.0
    previous = float("nan")
    previous_key: tuple[Any, str] | None = None
    for index, value in enumerate(raw_capacity):
        key = (cycles[index], str(phase_array[index]))
        if key != previous_key:
            carry = 0.0
            previous = float("nan")
            previous_key = key
        if np.isfinite(value):
            if np.isfinite(previous) and value < previous and value < previous * 0.5:
                carry += previous
                resets.append(
                    {
                        "row_index": index,
                        "cycle": int(cycles[index]),
                        "phase": str(phase_array[index]),
                        "counter_before_mah": float(previous),
                        "counter_after_mah": float(value),
                        "cumulative_after_mah": float(value + carry),
                    }
                )
            previous = float(value)
            output[index] = value + carry
    return output, resets


def _numeric_array_match(
    expected: list[Any],
    actual: np.ndarray,
    *,
    rel_tol: float = 1e-6,
    abs_tol: float = 1e-6,
) -> dict[str, Any]:
    if len(expected) != len(actual):
        return {
            "match": False,
            "expected_count": len(expected),
            "actual_count": len(actual),
            "first_mismatch_index": None,
            "expected_null_positions": [],
            "actual_null_positions": [],
        }
    expected_nulls = [index for index, value in enumerate(expected) if value is None]
    actual_nulls = [
        index for index, value in enumerate(actual) if not np.isfinite(float(value))
    ]
    first_mismatch = None
    for index, (golden, measured) in enumerate(zip(expected, actual)):
        if golden is None:
            equal = not np.isfinite(float(measured))
        else:
            equal = np.isfinite(float(measured)) and _close(
                float(measured),
                float(golden),
                rel_tol=rel_tol,
                abs_tol=abs_tol,
            )
        if not equal:
            first_mismatch = index
            break
    return {
        "match": first_mismatch is None,
        "expected_count": len(expected),
        "actual_count": len(actual),
        "first_mismatch_index": first_mismatch,
        "expected_null_positions": expected_nulls,
        "actual_null_positions": actual_nulls,
    }


def checkpoint_time_capacity_reset(
    raw: pd.DataFrame,
    expected: dict[str, Any],
    spec: dict[str, Any],
) -> dict[str, Any]:
    settings = spec["computation"]["time_capacity"]
    selected = raw.copy()
    cycles = [int(value) for value in settings.get("cycles") or []]
    if cycles:
        selected = selected[selected["cycle"].isin(cycles)]
    else:
        if settings.get("cycle_start") is not None:
            selected = selected[selected["cycle"] >= int(settings["cycle_start"])]
        if settings.get("cycle_end") is not None:
            selected = selected[selected["cycle"] <= int(settings["cycle_end"])]
    order = [
        column
        for column in ("cycle", "segment", "record_index")
        if column in selected.columns
    ]
    selected = selected.sort_values(order).reset_index(drop=True)
    phases = _independent_phases(selected)
    raw_step_time = pd.to_numeric(
        selected["time_s"], errors="coerce"
    ).to_numpy(dtype="float64")
    raw_time_reset_positions = (
        np.flatnonzero(np.diff(raw_step_time) < 0) + 1
    ).astype(int).tolist()
    continuous_time = _independent_continuous_time(selected)
    capacity, counter_resets = _independent_phase_capacity(selected, phases)
    trace = expected["cell_traces"][0]
    time_factor = (
        3600.0
        if settings.get("time_unit") == "h"
        else 60.0
        if settings.get("time_unit") == "min"
        else 1.0
    )
    display_x = continuous_time / time_factor
    if len(display_x):
        display_x = display_x - display_x[0]

    def capacity_reset_positions(values: list[Any] | np.ndarray) -> list[int]:
        numeric = np.asarray(
            [np.nan if value is None else float(value) for value in values],
            dtype="float64",
        )
        return (
            np.flatnonzero(
                np.isfinite(numeric[1:])
                & np.isfinite(numeric[:-1])
                & (numeric[1:] < numeric[:-1] * 0.5)
            )
            + 1
        ).astype(int).tolist()

    expected_capacity_reset_positions = capacity_reset_positions(
        trace["capacity_mah"]
    )
    actual_capacity_reset_positions = capacity_reset_positions(capacity)
    checks = {
        "time_s": _numeric_array_match(trace["time_s"], continuous_time),
        "display_x": _numeric_array_match(trace["display_x"], display_x),
        "capacity_mah": _numeric_array_match(trace["capacity_mah"], capacity),
        "current_ma": _numeric_array_match(
            trace["current_ma"],
            pd.to_numeric(selected["current_ma"], errors="coerce").to_numpy(),
        ),
        "voltage_v": _numeric_array_match(
            trace["voltage_v"],
            pd.to_numeric(selected["voltage_v"], errors="coerce").to_numpy(),
        ),
        "cycle": {
            "match": trace["cycle"]
            == pd.to_numeric(selected["cycle"], errors="coerce").astype(int).tolist(),
            "expected_count": len(trace["cycle"]),
            "actual_count": len(selected),
        },
        "phase": {
            "match": trace["phase"] == phases,
            "expected_count": len(trace["phase"]),
            "actual_count": len(phases),
        },
    }
    reset_positions_match = (
        bool(raw_time_reset_positions)
        and expected_capacity_reset_positions == actual_capacity_reset_positions
    )
    match = reset_positions_match and all(
        item["match"] for item in checks.values()
    )
    return {
        "case": "time_capacity_baseline",
        "raw_row_count": len(selected),
        "raw_step_time_reset_count": len(raw_time_reset_positions),
        "raw_step_time_reset_positions": raw_time_reset_positions,
        "raw_counter_reset_count": len(counter_resets),
        "raw_counter_resets": counter_resets,
        "expected_capacity_reset_positions": expected_capacity_reset_positions,
        "actual_capacity_reset_positions": actual_capacity_reset_positions,
        "reset_positions_match": reset_positions_match,
        "array_checks": checks,
        "note": (
            "Expected Time/Capacity arrays are compared directly with independently "
            "reconstructed raw-row time, phase, voltage, current, display axis, and "
            "continuous half-cycle capacity. Null and reset positions are compared explicitly."
        ),
        "match": match,
    }


def checkpoint_steps_duration(
    raw: pd.DataFrame,
    expected: dict[str, Any],
    spec: dict[str, Any],
) -> dict[str, Any]:
    segment = spec["protocol_segments"][0]
    step_indices = [int(value) for value in segment["targets"][0]["step_indices"]]
    block = expected["cell_series"][0]["block_meta"][0]
    step_column = "step_index" if "step_index" in raw.columns else "step"
    selected = raw.loc[
        (raw["cycle"] >= int(block["cycle_start"]))
        & (raw["cycle"] <= int(block["cycle_end"]))
        & (raw[step_column].isin(step_indices))
    ]
    timestamps = pd.to_datetime(selected["timestamp"], errors="coerce").dropna()
    manual_hours = float(
        (timestamps.max() - timestamps.min()).total_seconds() / 3600.0
    )
    golden_hours = expected["cell_series"][0]["quantities"]["block_duration_h"][0]
    return {
        "case": "steps_baseline",
        "raw_rows": {
            "cycle_start": block["cycle_start"],
            "cycle_end": block["cycle_end"],
            "step_indices": step_indices,
            "row_count": len(selected),
        },
        "formula": "timestamp span of selected raw block rows / 3600",
        "unit": "h",
        "independent_h": manual_hours,
        "golden_h": golden_hours,
        "match": _close(manual_hours, golden_hours, abs_tol=1e-3),
    }


def _last_finite(frame: pd.DataFrame, column: str) -> float | None:
    values = pd.to_numeric(frame.get(column), errors="coerce")
    values = values[np.isfinite(values)]
    return float(values.iloc[-1]) if len(values) else None


def _manual_dcir_occurrences(
    raw: pd.DataFrame,
    *,
    rest_step_index: int,
    pulse_step_index: int,
    direction: str,
) -> list[dict[str, Any]]:
    step_column = "step_index" if "step_index" in raw.columns else "step"
    work = raw.reset_index(drop=True).copy()
    steps = pd.to_numeric(work[step_column], errors="coerce")
    boundary = steps.ne(steps.shift())
    if "cycle" in work:
        cycles = pd.to_numeric(work["cycle"], errors="coerce")
        boundary |= cycles.ne(cycles.shift())
    if "time_s" in work:
        times = pd.to_numeric(work["time_s"], errors="coerce")
        boundary |= times.lt(times.shift())
    work["_run"] = boundary.fillna(True).cumsum()
    runs = [
        (int(run_id), frame)
        for run_id, frame in work.groupby("_run", sort=True)
    ]
    measurements: list[dict[str, Any]] = []
    for (rest_run, rest), (pulse_run, pulse) in zip(runs, runs[1:]):
        rest_step = int(pd.to_numeric(rest[step_column], errors="coerce").iloc[0])
        pulse_step = int(pd.to_numeric(pulse[step_column], errors="coerce").iloc[0])
        if rest_step != rest_step_index or pulse_step != pulse_step_index:
            continue
        rest_voltage = _last_finite(rest, "voltage_v")
        pulse_voltage = _last_finite(pulse, "voltage_v")
        currents = pd.to_numeric(pulse["current_ma"], errors="coerce").abs()
        currents = currents[np.isfinite(currents) & (currents > 1e-12)]
        median_current = float(currents.median()) if len(currents) else None
        if rest_voltage is None or pulse_voltage is None or median_current is None:
            continue
        delta_voltage = (
            rest_voltage - pulse_voltage
            if direction == "discharge"
            else pulse_voltage - rest_voltage
        )
        resistance = 1_000_000.0 * delta_voltage / median_current
        cycle = _last_finite(pulse, "cycle")
        measurements.append(
            {
                "cycle": int(cycle) if cycle is not None else None,
                "rest_run": rest_run,
                "pulse_run": pulse_run,
                "rest_row_indices": [int(rest.index[0]), int(rest.index[-1])],
                "pulse_row_indices": [int(pulse.index[0]), int(pulse.index[-1])],
                "v_rest_v": rest_voltage,
                "v_pulse_v": pulse_voltage,
                "median_abs_pulse_current_ma": median_current,
                "dcir_mohm": resistance,
            }
        )
    return measurements


def checkpoint_dcir(
    raw: pd.DataFrame,
    expected: dict[str, Any],
    spec: dict[str, Any],
) -> dict[str, Any]:
    segments = {item["id"]: item for item in spec["dcir_segments"]}
    expected_series = {
        item["series_id"]: item for item in expected["cell_series"]
    }
    results: list[dict[str, Any]] = []
    for series in spec["computation"]["dcir"]["series"]:
        target = segments[series["segment_id"]]["targets"][0]
        direction = str(target["direction"])
        measurements = _manual_dcir_occurrences(
            raw,
            rest_step_index=int(target["rest_step_index"]),
            pulse_step_index=int(target["pulse_step_index"]),
            direction=direction,
        )
        measured = measurements[0] if measurements else None
        golden_series = expected_series.get(series["id"])
        golden_meta = (
            golden_series["measurement_meta"][0]
            if golden_series and golden_series["measurement_meta"]
            else None
        )
        golden_resistance = (
            golden_series["quantities"]["dcir_mohm"][0]
            if golden_series
            else None
        )
        component_matches = {
            "v_rest_v": bool(
                measured
                and golden_meta
                and _close(measured["v_rest_v"], golden_meta["v_rest_v"], abs_tol=1e-6)
            ),
            "v_pulse_v": bool(
                measured
                and golden_meta
                and _close(measured["v_pulse_v"], golden_meta["v_pulse_v"], abs_tol=1e-6)
            ),
            "median_abs_pulse_current_ma": bool(
                measured
                and golden_meta
                and _close(
                    measured["median_abs_pulse_current_ma"],
                    golden_meta["current_ma"],
                    abs_tol=1e-6,
                )
            ),
            "dcir_mohm": bool(
                measured
                and _close(measured["dcir_mohm"], golden_resistance, abs_tol=1e-3)
            ),
        }
        results.append(
            {
                "series_id": series["id"],
                "direction": direction,
                "rest_step_index": int(target["rest_step_index"]),
                "pulse_step_index": int(target["pulse_step_index"]),
                "raw_occurrence_count": len(measurements),
                "first_raw_measurement": measured,
                "golden_measurement_meta": golden_meta,
                "golden_dcir_mohm": golden_resistance,
                "component_matches": component_matches,
                "match": all(component_matches.values()),
            }
        )
    return {
        "case": "dcir_baseline",
        "measurements": results,
        "match": bool(results) and all(item["match"] for item in results),
    }


def checkpoint_chargeability(
    raw: pd.DataFrame,
    expected: dict[str, Any],
    spec: dict[str, Any],
    header_metadata: dict[str, Any],
    nominal_capacity_mah: float,
) -> dict[str, Any]:
    from app.services import chargeability
    from app.services import protocol as protocol_service

    reconstructed = protocol_service.reconstruct_protocol(
        header_metadata,
        nominal_capacity_mah,
    )
    candidates = chargeability.detect_candidates(reconstructed)
    filters = spec["computation"]["chargeability"]
    tolerance = float(filters.get("soc_tolerance_pct") or 0)
    candidates = [
        item
        for item in candidates
        if item["initial_soc_pct"]
        <= float(filters["initial_soc_max_pct"]) + tolerance
        and item["final_soc_pct"]
        >= float(filters["final_soc_min_pct"]) - tolerance
        and item["current_ceiling_c"]
        >= float(filters["min_current_ceiling_c"])
    ]
    candidate = candidates[0] if candidates else None
    golden_candidate = expected["candidates"][0]
    golden_match = expected["matches"][0]
    reference_step = (
        int(candidate["reference_step_index"])
        if candidate and candidate.get("reference_step_index") is not None
        else None
    )
    reference_rows = (
        raw.loc[raw["step_index"] == reference_step]
        if reference_step is not None
        else raw.iloc[0:0]
    )
    measured: list[tuple[float, str, int | None]] = []
    for quantity in ("discharge_capacity_mah", "charge_capacity_mah"):
        values = pd.to_numeric(reference_rows.get(quantity), errors="coerce")
        if values.notna().any():
            index = values.idxmax()
            capacity = float(values.loc[index])
            cycle = (
                int(reference_rows.loc[index, "cycle"])
                if "cycle" in reference_rows
                else None
            )
            measured.append((capacity, quantity, cycle))
    raw_reference = max(measured, default=None, key=lambda item: item[0])
    raw_reference_capacity = raw_reference[0] if raw_reference else None
    field_matches = {
        "initial_soc_pct": bool(
            candidate
            and _close(
                candidate["initial_soc_pct"],
                golden_candidate["initial_soc_pct"],
                abs_tol=1e-8,
            )
        ),
        "final_soc_pct": bool(
            candidate
            and _close(
                candidate["final_soc_pct"],
                golden_candidate["final_soc_pct"],
                abs_tol=1e-8,
            )
        ),
        "current_ceiling_c": bool(
            candidate
            and _close(
                candidate["current_ceiling_c"],
                golden_candidate["current_ceiling_c"],
                abs_tol=1e-8,
            )
        ),
        "reference_step_index": bool(
            candidate
            and reference_step == golden_candidate["reference_step_index"]
        ),
        "reference_capacity_mah": _close(
            raw_reference_capacity,
            golden_match["reference_capacity_mah"],
            abs_tol=1e-6,
        ),
        "reference_quantity": bool(
            raw_reference
            and raw_reference[1] == golden_match["reference"]["quantity"]
        ),
        "reference_cycle": bool(
            raw_reference
            and raw_reference[2] == golden_match["reference"]["cycle"]
        ),
    }
    return {
        "case": "chargeability_baseline",
        "protocol_candidate_count": len(candidates),
        "protocol_fields": candidate,
        "raw_reference_step_index": reference_step,
        "raw_reference_row_count": len(reference_rows),
        "raw_reference_capacity_mah": raw_reference_capacity,
        "raw_reference_quantity": raw_reference[1] if raw_reference else None,
        "raw_reference_cycle": raw_reference[2] if raw_reference else None,
        "golden_reference_capacity_mah": golden_match["reference_capacity_mah"],
        "field_matches": field_matches,
        "match": all(field_matches.values()),
    }


def _raw_point_rate(
    raw: pd.DataFrame,
    point: dict[str, Any],
    nominal_capacity_mah: float,
) -> float | None:
    rows = raw.loc[
        (raw["cycle"] == int(point["cycle"]))
        & (raw["step_index"] == int(point["measurement_step_index"]))
    ]
    currents = pd.to_numeric(rows.get("current_ma"), errors="coerce").abs()
    currents = currents[np.isfinite(currents) & (currents > 1e-12)]
    if not len(currents) or nominal_capacity_mah <= 0:
        return None
    return float(currents.median() / nominal_capacity_mah)


def _common_raw_rates(
    charge_rates: list[float],
    discharge_rates: list[float],
    tolerance_fraction: float,
) -> list[float]:
    common: list[float] = []
    for charge_rate in sorted(charge_rates):
        matches = [
            discharge_rate
            for discharge_rate in discharge_rates
            if abs(discharge_rate - charge_rate)
            <= max(abs(discharge_rate), abs(charge_rate), 1e-12)
            * tolerance_fraction
        ]
        if matches:
            rate = float(np.mean([charge_rate, *matches]))
            if not any(
                abs(rate - existing)
                <= max(abs(rate), abs(existing), 1e-12) * tolerance_fraction
                for existing in common
            ):
                common.append(rate)
    return sorted(common)


def checkpoint_rate_capability(
    raw: pd.DataFrame,
    expected: dict[str, Any],
    spec: dict[str, Any],
    detected: dict[str, Any],
    nominal_capacity_mah: float,
) -> dict[str, Any]:
    tolerance_fraction = float(
        spec["computation"]["rate_capability"]["rate_tolerance_fraction"]
    )
    raw_rates: dict[str, list[float]] = {"charge": [], "discharge": []}
    point_records: list[dict[str, Any]] = []
    for block in detected["blocks"]:
        family = str(block["family"])
        for point in block["points"]:
            raw_rate = _raw_point_rate(raw, point, nominal_capacity_mah)
            if raw_rate is not None:
                raw_rates[family].append(raw_rate)
            point_records.append(
                {
                    "family": family,
                    "cycle": point["cycle"],
                    "measurement_step_index": point["measurement_step_index"],
                    "detected_rate_c": point["rate_c"],
                    "raw_median_current_rate_c": raw_rate,
                }
            )
    common_rates = _common_raw_rates(
        raw_rates["charge"],
        raw_rates["discharge"],
        tolerance_fraction,
    )
    raw_reference_rate = common_rates[0] if common_rates else None
    golden_reference_rate = expected["comparison"]["reference_rate_c"]
    reference_match = bool(
        raw_reference_rate is not None
        and abs(raw_reference_rate - golden_reference_rate)
        <= max(abs(raw_reference_rate), abs(golden_reference_rate))
        * tolerance_fraction
    )

    first_charge = next(
        point
        for block in detected["blocks"]
        if block["family"] == "charge"
        for point in block["points"]
    )
    expected_point = next(
        point
        for block in expected["blocks"]
        if block["family"] == "charge"
        for point in block["points"]
        if point["cycle"] == first_charge["cycle"]
        and point["measurement_step_index"]
        == first_charge["measurement_step_index"]
    )
    cc_rows = raw.loc[
        (raw["cycle"] == int(first_charge["cycle"]))
        & (
            raw["step_index"]
            == int(first_charge["measurement_step_index"])
        ),
        "charge_capacity_mah",
    ]
    cc_values = pd.to_numeric(cc_rows, errors="coerce")
    raw_cc_capacity = float(cc_values.max()) if cc_values.notna().any() else None
    cv_step = int(first_charge["charge_step_indices"][-1])
    cv_rows = raw.loc[
        (raw["cycle"] == int(first_charge["cycle"]))
        & (raw["step_index"] == cv_step),
        "charge_capacity_mah",
    ]
    cv_values = pd.to_numeric(cv_rows, errors="coerce")
    raw_cv_capacity = float(cv_values.max()) if cv_values.notna().any() else None
    all_golden_references = {
        point["retention_reference_rate_c"]
        for block in expected["blocks"]
        for point in block["points"]
    }
    field_matches = {
        "cc_only_capacity": _close(
            raw_cc_capacity,
            expected_point["capacity_mah"],
            rel_tol=1e-5,
            abs_tol=1e-3,
        ),
        "common_reference_rate": reference_match,
        "all_plotted_reference_rates": (
            len(all_golden_references) == 1
            and _close(
                next(iter(all_golden_references)),
                golden_reference_rate,
                abs_tol=1e-12,
            )
        ),
        "cv_is_separate": (
            raw_cv_capacity is not None
            and raw_cc_capacity is not None
            and cv_step != int(first_charge["measurement_step_index"])
        ),
    }
    return {
        "case": "rate_capability_baseline",
        "raw_detected_point_rates": point_records,
        "raw_common_rates_c": common_rates,
        "raw_reference_rate_c": raw_reference_rate,
        "golden_reference_rate_c": golden_reference_rate,
        "point_cycle": first_charge["cycle"],
        "measurement_step_index": first_charge["measurement_step_index"],
        "raw_cc_capacity_mah": raw_cc_capacity,
        "golden_cc_capacity_mah": expected_point["capacity_mah"],
        "cv_step_index": cv_step,
        "raw_cv_step_capacity_mah": raw_cv_capacity,
        "field_matches": field_matches,
        "match": all(field_matches.values()),
    }


def build_checkpoint_report(inputs: dict[str, Any]) -> dict[str, Any]:
    raw = inputs["raw"]
    expected = inputs["expected"]
    specs = inputs["specs"]
    return {
        "checkpoint_1_cc_cv_capacity": checkpoint_cc_cv_capacity(
            raw["cycles_time_steps"],
            expected["cycles_baseline"],
        ),
        "checkpoint_2_efficiency": checkpoint_efficiency(
            raw["cycles_time_steps"],
            expected["cycles_baseline"],
        ),
        "checkpoint_3_time_capacity_reset": checkpoint_time_capacity_reset(
            raw["cycles_time_steps"],
            expected["time_capacity_baseline"],
            specs["time_capacity_baseline"],
        ),
        "checkpoint_4_steps_duration": checkpoint_steps_duration(
            raw["cycles_time_steps"],
            expected["steps_baseline"],
            specs["steps_baseline"],
        ),
        "checkpoint_5_dcir": checkpoint_dcir(
            raw["dcir"],
            expected["dcir_baseline"],
            specs["dcir_baseline"],
        ),
        "checkpoint_6_chargeability": checkpoint_chargeability(
            raw["chargeability"],
            expected["chargeability_baseline"],
            specs["chargeability_baseline"],
            inputs["headers"]["chargeability"],
            inputs["nominal_capacity_mah"]["chargeability"],
        ),
        "checkpoint_7_rate_capability": checkpoint_rate_capability(
            raw["rate_capability"],
            expected["rate_capability_baseline"],
            specs["rate_capability_baseline"],
            inputs["detected"]["rate_capability"],
            inputs["nominal_capacity_mah"]["rate_capability"],
        ),
    }


def checkpoint_failures(report: dict[str, Any]) -> list[str]:
    """Fail closed: every mandatory checkpoint must expose match=True."""
    failures: list[str] = []
    for checkpoint in MANDATORY_CHECKPOINTS:
        result = report.get(checkpoint)
        if not isinstance(result, dict) or result.get("match") is not True:
            failures.append(checkpoint)
    return failures


def report_with_expected_mutation(
    inputs: dict[str, Any],
    mutation,
) -> dict[str, Any]:
    """Test helper: mutate expected inputs without copying large raw frames."""
    changed = dict(inputs)
    changed["expected"] = deepcopy(inputs["expected"])
    mutation(changed["expected"])
    return build_checkpoint_report(changed)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify all seven Spec 015 scientific approval checkpoints."
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional JSON report path (keep it outside committed fixtures).",
    )
    args = parser.parse_args()
    load_manifest()
    with tempfile.TemporaryDirectory(prefix="golden-approval-") as tmp:
        from golden_analysis_support import bind_isolated_data_root

        data_root = Path(tmp)
        bind_isolated_data_root(data_root)
        with GoldenFixtureEnvironment.create(data_root=data_root) as env:
            report = build_checkpoint_report(load_checkpoint_inputs(env))
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized, encoding="utf-8")
        print(f"Wrote scientific checkpoint report to {output}")
    else:
        print(serialized, end="")
    failures = checkpoint_failures(report)
    if failures:
        raise SystemExit(f"Checkpoint verification failed: {failures}")
    print("All seven mandatory checkpoints independently match.")


if __name__ == "__main__":
    main()
