"""Semantic rate-capability sweep detection and CC-only capacity extraction.

Rate-capability protocols are recognized as repeated charge/discharge pairs.
One direction remains fixed while the other contains at least three distinct
rates. Rest/control scaffolding and monotonic rate order raise confidence but
are configurable signals rather than hard-coded Neware step numbers.

For a charge sweep, an adjacent CC -> CV sequence is kept as two logical
steps: the CV step helps identify a completed charge protocol, while the
plotted capacity comes only from the CC step.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..models import Cell, SourceFile
from . import cache, protocol

ProgressCallback = Callable[[int, int, str, str], None]


def _profile_started(profile: dict[str, Any] | None) -> float | None:
    """Start an opt-in diagnostic timer without adding ordinary-route work."""

    return perf_counter() if profile is not None else None


def _profile_finished(
    profile: dict[str, Any] | None,
    name: str,
    started: float | None,
) -> None:
    """Accumulate one bounded profiler-only stage."""

    if profile is None or started is None:
        return
    stages = profile.setdefault("stages_ms", {})
    stages[name] = stages.get(name, 0.0) + (perf_counter() - started) * 1000.0
    calls = profile.setdefault("calls", {})
    calls[name] = calls.get(name, 0) + 1


def _profile_count(
    profile: dict[str, Any] | None,
    name: str,
    value: int,
) -> None:
    """Accumulate a structural count only for an explicit profiling request."""

    if profile is None:
        return
    counts = profile.setdefault("counts", {})
    counts[name] = counts.get(name, 0) + int(value)

DEFAULT_CONFIG = {
    "min_points": 3,
    "cutoff_tolerance_v": 0.03,
    "rate_tolerance_fraction": 0.03,
    "families": {
        "charge": {
            "enabled": True,
            "charge_structure": "auto",
            "fixed_rate_c": None,
            "selected_rates_c": [],
            "monotonic": "prefer",
            "scaffold": "prefer",
        },
        "discharge": {
            "enabled": True,
            "charge_structure": "auto",
            "fixed_rate_c": None,
            "selected_rates_c": [],
            "monotonic": "prefer",
            "scaffold": "prefer",
        },
    },
}


def _finite(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def _close_rate(first: float, second: float, tolerance: float) -> bool:
    scale = max(abs(first), abs(second), 0.1)
    return abs(first - second) <= max(0.01, scale * tolerance)


def _step_token(step: dict) -> str:
    type_id = int(step.get("type_id") or 0)
    return {
        1: "cc_charge",
        2: "cc_discharge",
        3: "cv_charge",
        4: "rest",
        5: "control",
        6: "control",
        7: "cccv_charge",
        13: "rest",
        20: "cccv_discharge",
        21: "control",
        22: "rest",
    }.get(type_id, str(step.get("direction") or "other"))


def _charge_upper(steps: list[dict]) -> float | None:
    for step in reversed(steps):
        value = _finite(step.get("target_voltage_v"))
        if value is not None:
            return value
        value = _finite(step.get("stop_voltage_v"))
        if value is not None:
            return value
    return None


def _discharge_lower(step: dict) -> float | None:
    return _finite(step.get("stop_voltage_v")) or _finite(
        step.get("target_voltage_v")
    )


def _phase_fingerprint(phase: dict) -> dict:
    return {
        "structure": phase["structure"],
        "rate_c": round(float(phase["rate_c"]), 6),
        "step_indices": phase["step_indices"],
    }


def build_rate_pairs(reconstructed: dict) -> list[dict]:
    """Build protocol-level charge/discharge pairs without guessing sweeps."""
    steps = list(reconstructed.get("steps") or [])
    phases: list[dict] = []
    index = 0
    while index < len(steps):
        step = steps[index]
        type_id = int(step.get("type_id") or 0)
        rate = _finite(step.get("c_rate"))
        if type_id == 1 and rate and rate > 0:
            following = steps[index + 1] if index + 1 < len(steps) else None
            following_rate = _finite(following.get("c_rate")) if following else None
            if (
                following
                and int(following.get("type_id") or 0) == 3
                and following_rate
                and _close_rate(rate, following_rate, 0.03)
            ):
                phase_steps = [step, following]
                phases.append(
                    {
                        "direction": "charge",
                        "structure": "cc_cv",
                        "rate_c": rate,
                        "measurement_step_index": int(step["number"]),
                        "step_indices": [int(step["number"]), int(following["number"])],
                        "start_position": index,
                        "end_position": index + 1,
                        "upper_voltage_v": _charge_upper(phase_steps),
                    }
                )
                index += 2
                continue
            phases.append(
                {
                    "direction": "charge",
                    "structure": "cc",
                    "rate_c": rate,
                    "measurement_step_index": int(step["number"]),
                    "step_indices": [int(step["number"])],
                    "start_position": index,
                    "end_position": index,
                    "upper_voltage_v": _charge_upper([step]),
                }
            )
        elif type_id == 7 and rate and rate > 0:
            phases.append(
                {
                    "direction": "charge",
                    "structure": "cccv",
                    "rate_c": rate,
                    "measurement_step_index": int(step["number"]),
                    "step_indices": [int(step["number"])],
                    "start_position": index,
                    "end_position": index,
                    "upper_voltage_v": _charge_upper([step]),
                }
            )
        elif type_id in {2, 20} and rate and rate > 0:
            phases.append(
                {
                    "direction": "discharge",
                    "structure": "cc" if type_id == 2 else "cccv",
                    "rate_c": rate,
                    "measurement_step_index": int(step["number"]),
                    "step_indices": [int(step["number"])],
                    "start_position": index,
                    "end_position": index,
                    "lower_voltage_v": _discharge_lower(step),
                }
            )
        index += 1

    pairs: list[dict] = []
    for phase_index in range(len(phases) - 1):
        charge = phases[phase_index]
        discharge = phases[phase_index + 1]
        if charge["direction"] != "charge" or discharge["direction"] != "discharge":
            continue
        next_position = (
            phases[phase_index + 2]["start_position"]
            if phase_index + 2 < len(phases)
            else len(steps)
        )
        between = [
            _step_token(step)
            for step in steps[charge["end_position"] + 1 : discharge["start_position"]]
        ]
        after = [
            _step_token(step)
            for step in steps[discharge["end_position"] + 1 : next_position]
        ]
        pair = {
            "pair_ordinal": len(pairs),
            "charge": charge,
            "discharge": discharge,
            "charge_rate_c": float(charge["rate_c"]),
            "discharge_rate_c": float(discharge["rate_c"]),
            "upper_voltage_v": charge.get("upper_voltage_v"),
            "lower_voltage_v": discharge.get("lower_voltage_v"),
            "between_tokens": between,
            "after_tokens": after,
            "scaffold_signature": ">".join(
                [
                    charge["structure"],
                    *between,
                    f"{discharge['structure']}_discharge",
                    *after,
                ]
            ),
        }
        pair["protocol_fingerprint"] = hashlib.sha256(
            json.dumps(
                {
                    "charge": _phase_fingerprint(charge),
                    "discharge": _phase_fingerprint(discharge),
                    "upper_voltage_v": pair["upper_voltage_v"],
                    "lower_voltage_v": pair["lower_voltage_v"],
                    "scaffold": pair["scaffold_signature"],
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        pairs.append(pair)
    return pairs


def _numeric(
    frame: pd.DataFrame,
    column: str,
    *,
    execution_index: "_ExecutionIndex | None" = None,
) -> np.ndarray:
    if execution_index is not None:
        cached = execution_index.numeric(frame, column)
        if cached is not None:
            return cached
    if column not in frame:
        return np.full(len(frame), np.nan)
    return pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype="float64")


def _execution_groups(frame: pd.DataFrame) -> list[pd.DataFrame]:
    if frame.empty:
        return []
    if "step" in frame:
        return [group for _, group in frame.groupby("step", sort=True)]
    if "cycle" in frame:
        return [group for _, group in frame.groupby("cycle", sort=True)]
    return [frame]


def _ordered(frame: pd.DataFrame) -> pd.DataFrame:
    for column in ("record_index", "timestamp", "time_s"):
        if column in frame:
            return frame.sort_values(column)
    return frame


def _index_value(value: Any) -> Any:
    """Return a stable scalar key for a raw-frame lookup index."""

    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and np.isnan(value):
        return None
    return value


def _cycle_key(value: Any) -> int | float | None:
    if not isinstance(value, (int, float, np.integer, np.floating)):
        return None
    value = float(value)
    if not np.isfinite(value):
        return None
    return int(value) if value.is_integer() else value


def _group_sort_key(value: Any) -> tuple[int, Any]:
    if isinstance(value, (int, float, np.integer, np.floating)):
        return (0, float(value))
    if value is None:
        return (2, "")
    return (1, f"{type(value).__name__}:{value}")


class _ExecutionIndex:
    """Request-local row ownership index for one immutable raw source frame.

    The legacy path builds a full-frame boolean mask for every pair, phase and
    occurrence. This index scans the frame once, retains row positions, and
    materializes only the bounded rows requested by a phase/cycle lookup. The
    returned frames keep the source index and use the same `_ordered` helper as
    the legacy path.
    """

    def __init__(self, raw: pd.DataFrame) -> None:
        self.raw = raw
        self._has_cycle = "cycle" in raw
        self._by_step: dict[Any, list[int]] = defaultdict(list)
        self._by_cycle_step: dict[tuple[int | float, Any], list[int]] = defaultdict(list)
        self._measurement_group_positions: dict[
            Any, dict[Any, list[int]]
        ] = defaultdict(lambda: defaultdict(list))
        self._measurement_groups: dict[Any, list[pd.DataFrame]] = {}
        self._phase_positions_cache: dict[
            tuple[tuple[Any, ...], int | None], list[int]
        ] = {}
        self._phase_cache: dict[tuple[tuple[Any, ...], int | None], pd.DataFrame] = {}
        self._frame_positions: dict[int, np.ndarray] = {}
        self._cycle_values: np.ndarray | None = None
        self._order_rank: np.ndarray | None = None
        self._numeric_arrays = {
            column: pd.to_numeric(raw[column], errors="coerce").to_numpy(
                dtype="float64"
            )
            for column in (
                "voltage_v",
                "charge_capacity_mah",
                "discharge_capacity_mah",
                "current_ma",
            )
            if column in raw
        }

        order_column = next(
            (
                column
                for column in ("record_index", "timestamp", "time_s")
                if column in raw
            ),
            None,
        )
        if order_column is not None:
            order_work = pd.DataFrame(
                {
                    "value": raw[order_column].to_numpy(copy=False),
                    "position": np.arange(len(raw), dtype="int64"),
                }
            )
            ordered_positions = order_work.sort_values("value")[
                "position"
            ].to_numpy(dtype="int64", copy=False)
            order_rank = np.empty(len(raw), dtype="int64")
            order_rank[ordered_positions] = np.arange(
                len(raw),
                dtype="int64",
            )
            self._order_rank = order_rank

        step_values = raw["step_index"].to_numpy(copy=False)
        work = pd.DataFrame({"step_index": step_values})

        def positions(groups: Any) -> list[int]:
            return [int(value) for value in groups]

        for step_value, row_positions in work.groupby(
            "step_index", sort=False, dropna=True
        ).indices.items():
            step_key = _index_value(step_value)
            if step_key is not None:
                self._by_step[step_key] = positions(row_positions)

        if "step" in raw:
            group_work = pd.DataFrame({
                "step_index": step_values,
                "group": raw["step"].to_numpy(copy=False),
            })
            grouped = group_work.groupby(
                ["step_index", "group"], sort=True, dropna=True
            ).indices
        elif "cycle" in raw:
            group_work = pd.DataFrame({
                "step_index": step_values,
                "group": raw["cycle"].to_numpy(copy=False),
            })
            grouped = group_work.groupby(
                ["step_index", "group"], sort=True, dropna=True
            ).indices
        else:
            grouped = {
                (step_key, None): row_positions
                for step_key, row_positions in work.groupby(
                    "step_index", sort=False, dropna=True
                ).indices.items()
            }
        for (step_value, group_value), row_positions in grouped.items():
            step_key = _index_value(step_value)
            group_key = _index_value(group_value)
            if step_key is not None:
                self._measurement_group_positions[step_key][group_key] = positions(
                    row_positions
                )

        if self._has_cycle:
            cycle_values = pd.to_numeric(raw["cycle"], errors="coerce").to_numpy(
                dtype="float64"
            )
            self._cycle_values = cycle_values
            cycle_work = pd.DataFrame({
                "cycle": cycle_values,
                "step_index": step_values,
            })
            for (cycle_value, step_value), row_positions in cycle_work.groupby(
                ["cycle", "step_index"], sort=False, dropna=True
            ).indices.items():
                step_key = _index_value(step_value)
                cycle_key = _cycle_key(cycle_value)
                if step_key is not None and cycle_key is not None:
                    self._by_cycle_step[(cycle_key, step_key)] = positions(
                        row_positions
                    )

    @property
    def step_key_count(self) -> int:
        return len(self._by_step)

    @property
    def cycle_step_key_count(self) -> int:
        return len(self._by_cycle_step)

    def _frame(self, positions: list[int]) -> pd.DataFrame:
        if not positions:
            frame = self.raw.iloc[0:0]
            self._frame_positions[id(frame)] = np.empty(0, dtype="int64")
            return frame
        positions_array = np.asarray(positions, dtype="int64")
        frame = self.raw.iloc[positions_array]
        self._frame_positions[id(frame)] = positions_array
        return frame

    def register_frame(self, frame: pd.DataFrame) -> None:
        if isinstance(frame.index, pd.RangeIndex):
            self._frame_positions[id(frame)] = frame.index.to_numpy(
                dtype="int64",
                copy=False,
            )

    def numeric(self, frame: pd.DataFrame, column: str) -> np.ndarray | None:
        values = self._numeric_arrays.get(column)
        positions = self._frame_positions.get(id(frame))
        if values is None or positions is None:
            return None
        return values[positions]

    def ordered_positions(self, positions: list[int]) -> list[int]:
        if self._order_rank is None or len(positions) < 2:
            return positions
        position_array = np.asarray(positions, dtype="int64")
        order = np.argsort(
            self._order_rank[position_array],
            kind="stable",
        )
        return position_array[order].tolist()

    def measurement_groups(self, measurement_step_index: int) -> list[pd.DataFrame]:
        key = _index_value(measurement_step_index)
        if key not in self._measurement_groups:
            position_sets = self.measurement_group_positions(measurement_step_index)
            self._measurement_groups[key] = [
                self._frame(positions)
                for positions in position_sets
            ]
        return self._measurement_groups[key]

    def measurement_group_positions(
        self,
        measurement_step_index: int,
    ) -> list[list[int]]:
        key = _index_value(measurement_step_index)
        groups = self._measurement_group_positions.get(key, {})
        return [
            groups[group_key]
            for group_key in sorted(groups, key=_group_sort_key)
        ]

    def values(self, column: str, positions: list[int]) -> np.ndarray:
        values = self._numeric_arrays.get(column)
        if values is None:
            return np.full(len(positions), np.nan)
        return values[np.asarray(positions, dtype="int64")]

    def first_cycle(self, positions: list[int]) -> int | None:
        if self._cycle_values is None:
            return None
        for position in self.ordered_positions(positions):
            value = self._cycle_values[position]
            if not np.isnan(value):
                return int(value)
        return None

    def phase_rows(self, phase: dict, cycle: int | None) -> pd.DataFrame:
        key = (
            tuple(dict.fromkeys(phase.get("step_indices") or ())),
            cycle,
        )
        cached = self._phase_cache.get(key)
        if cached is not None:
            return cached
        result = _ordered(self._frame(self.phase_positions(phase, cycle)))
        self.register_frame(result)
        self._phase_cache[key] = result
        return result

    def phase_positions(self, phase: dict, cycle: int | None) -> list[int]:
        steps = tuple(dict.fromkeys(phase.get("step_indices") or ()))
        key = (steps, cycle)
        cached = self._phase_positions_cache.get(key)
        if cached is not None:
            return cached
        positions: list[int] = []
        if cycle is not None and self._has_cycle:
            for step in steps:
                positions.extend(self._by_cycle_step.get((cycle, _index_value(step)), []))
        else:
            for step in steps:
                positions.extend(self._by_step.get(_index_value(step), []))
        positions.sort()
        self._phase_positions_cache[key] = positions
        return positions

    def phase_voltage_values(self, phase: dict, cycle: int | None) -> np.ndarray:
        positions = self.ordered_positions(self.phase_positions(phase, cycle))
        values = self._numeric_arrays.get("voltage_v")
        if values is None:
            return np.full(len(positions), np.nan)
        return values[np.asarray(positions, dtype="int64")]


def _phase_rows(
    raw: pd.DataFrame,
    phase: dict,
    cycle: int | None,
    *,
    profiling: dict[str, Any] | None = None,
    execution_index: _ExecutionIndex | None = None,
) -> pd.DataFrame:
    started = _profile_started(profiling)
    try:
        if execution_index is not None:
            return execution_index.phase_rows(phase, cycle)
        selected = raw[raw["step_index"].isin(phase["step_indices"])]
        if cycle is not None and "cycle" in selected:
            selected = selected[
                pd.to_numeric(selected["cycle"], errors="coerce") == cycle
            ]
        return _ordered(selected)
    finally:
        _profile_finished(profiling, "execution_phase_row_filtering", started)


def _reached_voltage(
    frame: pd.DataFrame | None,
    *,
    direction: str,
    target_v: float | None,
    tolerance_v: float,
    profiling: dict[str, Any] | None = None,
    execution_index: _ExecutionIndex | None = None,
    numeric_values: np.ndarray | None = None,
) -> bool:
    started = _profile_started(profiling)
    try:
        if target_v is None or (
            frame is not None and frame.empty
        ) or (numeric_values is not None and not len(numeric_values)):
            return False
        voltage = (
            numeric_values
            if numeric_values is not None
            else _numeric(
                frame,
                "voltage_v",
                execution_index=execution_index,
            )
        )
        finite = voltage[np.isfinite(voltage)]
        if not len(finite):
            return False
        if direction == "charge":
            return float(np.nanmax(finite)) >= target_v - tolerance_v
        return float(np.nanmin(finite)) <= target_v + tolerance_v
    finally:
        _profile_finished(profiling, "execution_cutoff_validation", started)


def extract_pair_executions(
    raw: pd.DataFrame,
    pair: dict,
    *,
    cell: Cell,
    source: SourceFile,
    label: str,
    nominal_capacity_mah: float | None,
    active_mass_mg: float | None,
    electrode_area_cm2: float | None,
    cutoff_tolerance_v: float,
    profiling: dict[str, Any] | None = None,
    execution_index: _ExecutionIndex | None = None,
) -> list[dict]:
    """Extract both possible measurement directions from one protocol pair."""
    rows: list[dict] = []
    execution_index = execution_index or _ExecutionIndex(raw)
    mass_g = active_mass_mg / 1000.0 if active_mass_mg and active_mass_mg > 0 else None
    area = electrode_area_cm2 if electrode_area_cm2 and electrode_area_cm2 > 0 else None
    for family, phase, reference, capacity_column, direction in (
        (
            "charge",
            pair["charge"],
            pair["discharge"],
            "charge_capacity_mah",
            "charge",
        ),
        (
            "discharge",
            pair["discharge"],
            pair["charge"],
            "discharge_capacity_mah",
            "discharge",
        ),
    ):
        started = _profile_started(profiling)
        group_position_sets = execution_index.measurement_group_positions(
            int(phase["measurement_step_index"])
        )
        _profile_finished(profiling, "measurement_filtering_grouping", started)
        _profile_count(
            profiling,
            "measurement_rows",
            sum(len(positions) for positions in group_position_sets),
        )
        _profile_count(profiling, "measurement_groups", len(group_position_sets))
        for occurrence, positions in enumerate(group_position_sets, start=1):
            positions = execution_index.ordered_positions(positions)
            cycle = execution_index.first_cycle(positions)
            started = _profile_started(profiling)
            phase_voltage_values = execution_index.phase_voltage_values(phase, cycle)
            reference_voltage_values = execution_index.phase_voltage_values(
                reference,
                cycle,
            )
            _profile_finished(profiling, "execution_phase_row_filtering", started)
            phase_target = (
                pair.get("upper_voltage_v")
                if direction == "charge"
                else pair.get("lower_voltage_v")
            )
            reference_target = (
                pair.get("lower_voltage_v")
                if direction == "charge"
                else pair.get("upper_voltage_v")
            )
            measurement_complete = _reached_voltage(
                None,
                direction=direction,
                target_v=phase_target,
                tolerance_v=cutoff_tolerance_v,
                profiling=profiling,
                execution_index=execution_index,
                numeric_values=execution_index.values("voltage_v", positions),
            )
            phase_complete = _reached_voltage(
                None,
                direction=direction,
                target_v=phase_target,
                tolerance_v=cutoff_tolerance_v,
                profiling=profiling,
                execution_index=execution_index,
                numeric_values=phase_voltage_values,
            )
            reference_complete = _reached_voltage(
                None,
                direction="discharge" if direction == "charge" else "charge",
                target_v=reference_target,
                tolerance_v=cutoff_tolerance_v,
                profiling=profiling,
                execution_index=execution_index,
                numeric_values=reference_voltage_values,
            )
            started = _profile_started(profiling)
            capacity_values = execution_index.values(capacity_column, positions)
            capacity = (
                float(np.nanmax(capacity_values))
                if np.isfinite(capacity_values).any()
                else None
            )
            _profile_finished(profiling, "capacity_extraction", started)
            started = _profile_started(profiling)
            current_values = np.abs(execution_index.values("current_ma", positions))
            finite_current = current_values[np.isfinite(current_values)]
            current_ma = (
                float(np.nanmedian(finite_current)) if len(finite_current) else None
            )
            _profile_finished(profiling, "current_extraction", started)
            started = _profile_started(profiling)
            rate_c = float(
                pair["charge_rate_c"]
                if family == "charge"
                else pair["discharge_rate_c"]
            )
            _profile_finished(profiling, "rate_normalization", started)
            valid = bool(
                capacity is not None
                and capacity > 0
                and measurement_complete
                and phase_complete
                and reference_complete
            )
            rows.append(
                {
                    "id": (
                        f"{cell.id}-{source.hash[:12]}-{family}-"
                        f"{phase['measurement_step_index']}-{occurrence}"
                    ),
                    "family": family,
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "label": label,
                    "filename": source.filename,
                    "source_hash": source.hash,
                    "pair_ordinal": pair["pair_ordinal"],
                    "protocol_fingerprint": pair["protocol_fingerprint"],
                    "charge_structure": pair["charge"]["structure"],
                    "scaffold_signature": pair["scaffold_signature"],
                    "charge_step_indices": pair["charge"]["step_indices"],
                    "discharge_step_indices": pair["discharge"]["step_indices"],
                    "measurement_step_index": phase["measurement_step_index"],
                    "cycle": cycle,
                    "rate_c": rate_c,
                    "fixed_rate_c": float(
                        pair["discharge_rate_c"]
                        if family == "charge"
                        else pair["charge_rate_c"]
                    ),
                    "charge_rate_c": pair["charge_rate_c"],
                    "discharge_rate_c": pair["discharge_rate_c"],
                    "upper_voltage_v": pair.get("upper_voltage_v"),
                    "lower_voltage_v": pair.get("lower_voltage_v"),
                    "capacity_mah": capacity,
                    "capacity_mah_g": capacity / mass_g if capacity is not None and mass_g else None,
                    "capacity_mah_cm2": capacity / area if capacity is not None and area else None,
                    "current_ma": current_ma,
                    "current_ma_g": current_ma / mass_g if current_ma is not None and mass_g else None,
                    "current_ma_cm2": current_ma / area if current_ma is not None and area else None,
                    "observed_c_rate": (
                        current_ma / nominal_capacity_mah
                        if current_ma is not None
                        and nominal_capacity_mah
                        and nominal_capacity_mah > 0
                        else None
                    ),
                    "valid": valid,
                    "validation": {
                        "measurement_cutoff_reached": measurement_complete,
                        "phase_completed": phase_complete,
                        "reference_phase_completed": reference_complete,
                    },
                }
            )
    return rows


def _merged_config(spec: dict) -> dict:
    configured = ((spec.get("computation") or {}).get("rate_capability") or {})
    families = configured.get("families") or {}
    return {
        "min_points": max(2, int(configured.get("min_points", 3))),
        "cutoff_tolerance_v": max(
            0.001, float(configured.get("cutoff_tolerance_v", 0.03))
        ),
        "rate_tolerance_fraction": max(
            0.001, float(configured.get("rate_tolerance_fraction", 0.03))
        ),
        "families": {
            family: {
                **DEFAULT_CONFIG["families"][family],
                **(families.get(family) or {}),
            }
            for family in ("charge", "discharge")
        },
    }


def _monotonic(values: list[float], tolerance: float) -> bool:
    unique: list[float] = []
    for value in values:
        if not unique or not _close_rate(value, unique[-1], tolerance):
            unique.append(value)
    if len(unique) < 2:
        return True
    increasing = all(
        following >= previous
        or _close_rate(previous, following, tolerance)
        for previous, following in zip(unique, unique[1:])
    )
    decreasing = all(
        following <= previous
        or _close_rate(previous, following, tolerance)
        for previous, following in zip(unique, unique[1:])
    )
    return increasing or decreasing


def _monotonic_runs(rows: list[dict], tolerance: float) -> list[list[dict]]:
    """Split recovery/reference points from an otherwise monotonic sweep."""
    if not rows:
        return []
    runs: list[list[dict]] = []
    current = [rows[0]]
    direction = 0
    previous = rows[0]["rate_c"]
    for row in rows[1:]:
        value = row["rate_c"]
        if _close_rate(previous, value, tolerance):
            current.append(row)
            previous = value
            continue
        step_direction = 1 if value > previous else -1
        if direction == 0:
            direction = step_direction
        if step_direction != direction:
            runs.append(current)
            current = [row]
            direction = 0
        else:
            current.append(row)
        previous = value
    runs.append(current)
    return runs


def _distinct(values: list[float], tolerance: float) -> list[float]:
    result: list[float] = []
    for value in values:
        if not any(_close_rate(value, current, tolerance) for current in result):
            result.append(value)
    return result


def _compatible_pair(
    previous: dict,
    current: dict,
    *,
    family: str,
    tolerance: float,
    cutoff_tolerance_v: float,
) -> bool:
    if current["pair_ordinal"] - previous["pair_ordinal"] > 2:
        return False
    if current["charge_structure"] != previous["charge_structure"]:
        return False
    if not _close_rate(current["fixed_rate_c"], previous["fixed_rate_c"], tolerance):
        return False
    for key in ("upper_voltage_v", "lower_voltage_v"):
        first = _finite(previous.get(key))
        second = _finite(current.get(key))
        if first is None or second is None or abs(first - second) > cutoff_tolerance_v:
            return False
    return current["family"] == previous["family"] == family


def _block_fingerprint(block: dict) -> str:
    semantic = {
        "family": block["family"],
        "charge_structure": block["charge_structure"],
        "fixed_rate_c": round(block["fixed_rate_c"], 4),
        "rates_c": sorted(round(value, 4) for value in block["rates_c"]),
        "upper_voltage_v": round(block["upper_voltage_v"], 4),
        "lower_voltage_v": round(block["lower_voltage_v"], 4),
    }
    return hashlib.sha256(
        json.dumps(semantic, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def detect_sweep_blocks(
    executions: list[dict],
    family: str,
    config: dict,
) -> list[dict]:
    """Recognize contiguous fixed-rate/variable-rate runs from valid executions."""
    tolerance = config["rate_tolerance_fraction"]
    family_config = config["families"][family]
    valid = sorted(
        (row for row in executions if row["family"] == family and row["valid"]),
        key=lambda row: (row["pair_ordinal"], row.get("cycle") or -1),
    )
    candidate_rows: list[dict] = []
    seen_pairs: set[tuple[str, int]] = set()
    for row in valid:
        key = (row["source_hash"], row["pair_ordinal"])
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        candidate_rows.append(row)

    runs: list[list[dict]] = []
    current: list[dict] = []
    for row in candidate_rows:
        if (
            current
            and (
                row["source_hash"] != current[-1]["source_hash"]
                or not _compatible_pair(
                    current[-1],
                    row,
                    family=family,
                    tolerance=tolerance,
                    cutoff_tolerance_v=config["cutoff_tolerance_v"],
                )
            )
        ):
            runs.append(current)
            current = []
        current.append(row)
    if current:
        runs.append(current)

    monotonic_policy = family_config.get("monotonic") or "prefer"
    evaluated_runs = (
        [
            monotonic_run
            for run in runs
            for monotonic_run in _monotonic_runs(run, tolerance)
        ]
        if monotonic_policy != "ignore"
        else runs
    )
    blocks: list[dict] = []
    for run in evaluated_runs:
        rates = _distinct([row["rate_c"] for row in run], tolerance)
        if len(rates) < config["min_points"]:
            continue
        structure = str(family_config.get("charge_structure") or "auto")
        if structure != "auto" and run[0]["charge_structure"] != structure:
            continue
        configured_fixed = _finite(family_config.get("fixed_rate_c"))
        if configured_fixed is not None and not _close_rate(
            run[0]["fixed_rate_c"], configured_fixed, tolerance
        ):
            continue
        is_monotonic = _monotonic([row["rate_c"] for row in run], tolerance)
        if monotonic_policy == "require" and not is_monotonic:
            continue
        scaffold_counts = Counter(row["scaffold_signature"] for row in run)
        scaffold_consistency = max(scaffold_counts.values()) / len(run)
        scaffold_policy = family_config.get("scaffold") or "prefer"
        has_scaffold = any(
            token in {"rest", "control"}
            for row in run
            for token in row["scaffold_signature"].split(">")
        )
        if scaffold_policy == "require" and (
            scaffold_consistency < 0.7 or not has_scaffold
        ):
            continue
        source_hash = run[0]["source_hash"]
        pair_ordinals = [row["pair_ordinal"] for row in run]
        block_id = hashlib.sha256(
            (
                f"{run[0]['cell_id']}:{source_hash}:{family}:"
                f"{min(pair_ordinals)}:{max(pair_ordinals)}"
            ).encode()
        ).hexdigest()[:20]
        points = [
            row
            for row in valid
            if row["source_hash"] == source_hash
            and row["pair_ordinal"] in set(pair_ordinals)
        ]
        block = {
            "id": block_id,
            "family": family,
            "cell_id": run[0]["cell_id"],
            "cell_name": run[0]["cell_name"],
            "label": run[0]["label"],
            "filename": run[0]["filename"],
            "source_hash": source_hash,
            "charge_structure": run[0]["charge_structure"],
            "fixed_rate_c": float(run[0]["fixed_rate_c"]),
            "rates_c": rates,
            "upper_voltage_v": float(run[0]["upper_voltage_v"]),
            "lower_voltage_v": float(run[0]["lower_voltage_v"]),
            "monotonic": is_monotonic,
            "has_rest_control_scaffold": has_scaffold,
            "scaffold_consistency": scaffold_consistency,
            "scaffold_signature": scaffold_counts.most_common(1)[0][0],
            "pair_ordinals": pair_ordinals,
            "points": points,
            "score": (
                len(rates) * 10
                + (
                    3
                    if monotonic_policy != "ignore" and is_monotonic
                    else 0
                )
                + (
                    scaffold_consistency * 2
                    if scaffold_policy != "ignore" and has_scaffold
                    else 0
                )
                + min(len(points), 5) * 0.1
            ),
        }
        block["fingerprint"] = _block_fingerprint(block)
        blocks.append(block)
    return sorted(blocks, key=lambda block: (-block["score"], block["id"]))


def _selected_rate(point: dict, configured: list[object], tolerance: float) -> bool:
    selected = [
        number for value in configured if (number := _finite(value)) is not None
    ]
    return not selected or any(
        _close_rate(point["rate_c"], expected, tolerance) for expected in selected
    )


def build_common_rate_comparison(
    blocks: list[dict],
    cells: list[Cell],
    tolerance: float,
) -> tuple[list[dict], dict]:
    """Normalize both families to one lowest rate shared by every cell."""
    groups = {
        (block["cell_id"], block["family"]): block["points"]
        for block in blocks
    }
    required = [
        (cell.id, family)
        for cell in cells
        for family in ("charge", "discharge")
    ]
    if not required or any(not groups.get(key) for key in required):
        return blocks, {
            "available": False,
            "reason": (
                "Charge and discharge sweeps are required for every selected "
                "cell before a common reference can be calculated."
            ),
            "reference_rate_c": None,
            "common_rates_c": [],
            "points": [],
        }

    first_rates = _distinct(
        [float(point["rate_c"]) for point in groups[required[0]]],
        tolerance,
    )
    common_rates: list[float] = []
    for candidate in first_rates:
        matched_rates: list[float] = []
        for key in required:
            matches = [
                float(point["rate_c"])
                for point in groups[key]
                if _close_rate(float(point["rate_c"]), candidate, tolerance)
            ]
            if not matches:
                break
            matched_rates.extend(matches)
        else:
            common_rates.append(float(np.mean(matched_rates)))
    common_rates = sorted(_distinct(common_rates, tolerance))
    if not common_rates:
        return blocks, {
            "available": False,
            "reason": (
                "The selected cells do not share a rate measured in both "
                "charge and discharge."
            ),
            "reference_rate_c": None,
            "common_rates_c": [],
            "points": [],
        }

    reference_rate = common_rates[0]

    def mean_capacity(points: list[dict], rate: float) -> float | None:
        values = [
            float(point["capacity_mah"])
            for point in points
            if point.get("capacity_mah") is not None
            and _close_rate(float(point["rate_c"]), rate, tolerance)
        ]
        return float(np.mean(values)) if values else None

    references = {
        key: mean_capacity(groups[key], reference_rate)
        for key in required
    }
    if any(value is None or value <= 0 for value in references.values()):
        return blocks, {
            "available": False,
            "reason": "The shared reference-rate capacity is unavailable.",
            "reference_rate_c": reference_rate,
            "common_rates_c": common_rates,
            "points": [],
        }

    normalized_blocks: list[dict] = []
    for block in blocks:
        reference = references[(block["cell_id"], block["family"])]
        normalized_blocks.append(
            {
                **block,
                "points": [
                    {
                        **point,
                        "retention_pct": (
                            float(point["capacity_mah"]) / reference * 100.0
                            if point.get("capacity_mah") is not None
                            else None
                        ),
                        "retention_reference_rate_c": reference_rate,
                    }
                    for point in block["points"]
                ],
            }
        )

    labels = {
        block["cell_id"]: (block["cell_name"], block["label"])
        for block in normalized_blocks
    }
    comparison_points: list[dict] = []
    for cell in cells:
        charge_points = groups[(cell.id, "charge")]
        discharge_points = groups[(cell.id, "discharge")]
        charge_reference = references[(cell.id, "charge")]
        discharge_reference = references[(cell.id, "discharge")]
        for rate in common_rates:
            charge_capacity = mean_capacity(charge_points, rate)
            discharge_capacity = mean_capacity(discharge_points, rate)
            if charge_capacity is None or discharge_capacity is None:
                continue
            charge_retention = charge_capacity / charge_reference * 100.0
            discharge_retention = (
                discharge_capacity / discharge_reference * 100.0
            )
            cell_name, label = labels[cell.id]
            comparison_points.append(
                {
                    "id": f"{cell.id}-rate-asymmetry-{rate:.8g}",
                    "cell_id": cell.id,
                    "cell_name": cell_name,
                    "label": label,
                    "rate_c": rate,
                    "reference_rate_c": reference_rate,
                    "charge_capacity_mah": charge_capacity,
                    "discharge_capacity_mah": discharge_capacity,
                    "charge_retention_pct": charge_retention,
                    "discharge_retention_pct": discharge_retention,
                    "asymmetry_ratio": (
                        discharge_retention / charge_retention
                        if charge_retention > 0
                        else None
                    ),
                }
            )
    return normalized_blocks, {
        "available": True,
        "reason": None,
        "reference_rate_c": reference_rate,
        "common_rates_c": common_rates,
        "points": comparison_points,
    }


def compute(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    progress: ProgressCallback | None = None,
    *,
    request_context: Any = None,
    profiling: dict[str, Any] | None = None,
) -> dict:
    """Resolve the highest-confidence charge and discharge sweep per cell."""
    from . import analysis_engine as engine
    from . import scanner

    engine.ensure_canonical_cycling_available(
        db,
        spec,
        request_context=request_context,
    )
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        calc_version = provenance.get("calc_version") or calc_version
    all_pinned_versions: list[str] = []
    all_current_versions: list[str] = []
    protocol_cache: dict[tuple[str, float | None], dict] = dict(
        getattr(request_context, "protocol_cache", ())
    )
    config = _merged_config(spec)
    if request_context is None:
        units, missing_refs = engine.resolve_selection(db, spec)
        cells = list({unit["cell"].id: unit["cell"] for unit in units}.values())
        labels = {unit["cell"].id: unit["label"] for unit in units}
        engine.preload_cell_sources(db, cells)
        scalar_metadata = engine.load_scalar_metadata(db, cells)
    else:
        units = list(request_context.units)
        missing_refs = list(request_context.missing_refs)
        cells = list(request_context.cells)
        labels = dict(request_context.labels_by_cell)
        scalar_metadata = request_context.scalar_metadata

    chosen_blocks: list[dict] = []
    detected_blocks: list[dict] = []
    all_executions: list[dict] = []
    cell_results: list[dict] = []
    sources: list[dict] = []
    badges: list[dict] = []

    # Four intra-cell stages so a single-cell recognition still advances the bar.
    stages_per_cell = 4
    total_units = max(1, len(cells) * stages_per_cell)

    for cell_index, cell in enumerate(cells, start=1):
        base = (cell_index - 1) * stages_per_cell
        if progress:
            progress(base, total_units, cell.name, "Reading cycles")
        metadata = scalar_metadata.get(cell.id)
        nominal = engine.cell_nominal_capacity_mah(cell, metadata)
        active_mass = engine.cell_active_mass_mg(cell, metadata)
        area = engine.cell_electrode_area_cm2(cell, metadata)
        if request_context is None:
            hashes, files = engine.cell_ordered_hashes(db, cell)
            source_versions = engine.resolve_source_parser_versions(
                files, provenance, cell.id, use_current_versions
            )
        else:
            hashes = list(request_context.hashes_by_cell[cell.id])
            files = list(request_context.files_by_cell[cell.id])
            source_versions = request_context.parser_versions_by_cell[cell.id]
        all_pinned_versions.extend(source_versions[f.hash] for f in files)
        all_current_versions.extend(engine.current_parser_identity(f) for f in files)
        cell_blocks: list[dict] = []
        if progress:
            progress(base + 1, total_units, cell.name, "Detecting rate sweeps")
        for source in files:
            parser_version = source_versions[source.hash]
            if (
                parser_version == engine.current_parser_identity(source)
                and not cache.raw_path(source.hash, parser_version).exists()
                and Path(source.path).exists()
            ):
                scanner.parse_file(db, source)
            raw = cache.load_raw(source.hash, parser_version)
            execution_index = None
            if raw is not None:
                started = _profile_started(profiling)
                execution_index = _ExecutionIndex(raw)
                _profile_finished(profiling, "execution_index_building", started)
                _profile_count(profiling, "execution_index_rows", len(raw))
                _profile_count(
                    profiling,
                    "execution_index_step_keys",
                    execution_index.step_key_count,
                )
                _profile_count(
                    profiling,
                    "execution_index_cycle_step_keys",
                    execution_index.cycle_step_key_count,
                )
            protocol_key = (
                json.dumps(
                    source.header_meta or {},
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                ),
                nominal,
            )
            started = _profile_started(profiling)
            reconstructed = dict(
                getattr(request_context, "protocol_by_source", ())
            ).get(source.hash)
            if reconstructed is None:
                reconstructed = protocol_cache.get(protocol_key)
            if reconstructed is None:
                reconstructed = protocol.reconstruct_protocol(source.header_meta, nominal)
                protocol_cache[protocol_key] = reconstructed
            else:
                _profile_count(profiling, "protocol_reconstruction_cache_hits", 1)
            _profile_finished(profiling, "protocol_reconstruction", started)
            _profile_count(
                profiling,
                "reconstructed_protocol_steps",
                len(reconstructed.get("steps") or []),
            )
            started = _profile_started(profiling)
            pairs = build_rate_pairs(reconstructed)
            _profile_finished(profiling, "rate_pair_building", started)
            _profile_count(profiling, "rate_pairs", len(pairs))
            executions: list[dict] = []
            if raw is not None:
                for pair in pairs:
                    started = _profile_started(profiling)
                    executions.extend(
                        extract_pair_executions(
                            raw,
                            pair,
                            cell=cell,
                            source=source,
                            label=labels.get(cell.id, cell.name),
                            nominal_capacity_mah=nominal,
                            active_mass_mg=active_mass,
                            electrode_area_cm2=area,
                            cutoff_tolerance_v=config["cutoff_tolerance_v"],
                            profiling=profiling,
                            execution_index=execution_index,
                        )
                    )
                    _profile_finished(profiling, "execution_extraction", started)
            all_executions.extend(executions)
            _profile_count(profiling, "execution_rows", len(executions))
            _profile_count(
                profiling,
                "execution_groups",
                len({
                    (
                        row.get("source_hash"),
                        row.get("pair_ordinal"),
                        row.get("family"),
                        row.get("cycle"),
                    )
                    for row in executions
                }),
            )
            for family in ("charge", "discharge"):
                if not config["families"][family].get("enabled", True):
                    continue
                started = _profile_started(profiling)
                blocks = detect_sweep_blocks(executions, family, config)
                _profile_finished(profiling, f"sweep_detection_{family}", started)
                _profile_count(profiling, f"detected_blocks_{family}", len(blocks))
                detected_blocks.extend(blocks)
                cell_blocks.extend(blocks)

        if progress:
            progress(base + 2, total_units, cell.name, "Matching rate families")
        selected_for_cell: list[dict] = []
        started = _profile_started(profiling)
        for family in ("charge", "discharge"):
            candidates = [
                block
                for block in cell_blocks
                if block["family"] == family
                and config["families"][family].get("enabled", True)
            ]
            if candidates:
                chosen = max(candidates, key=lambda block: block["score"])
                selected_rates = config["families"][family].get(
                    "selected_rates_c"
                ) or []
                chosen = {
                    **chosen,
                    "points": [
                        point
                        for point in chosen["points"]
                        if _selected_rate(
                            point,
                            selected_rates,
                            config["rate_tolerance_fraction"],
                        )
                    ],
                }
                selected_for_cell.append(chosen)
                chosen_blocks.append(chosen)
        _profile_finished(profiling, "candidate_selection_and_selected_rate_filtering", started)
        _profile_count(profiling, "chosen_blocks", len(selected_for_cell))
        if progress:
            progress(base + 3, total_units, cell.name, "Building blocks")
        if not selected_for_cell:
            badges.append(
                {
                    "kind": "rate_capability_no_match",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "detail": "No completed fixed-rate/variable-rate capability sweep was detected.",
                }
            )
        cell_results.append(
            {
                "cell_id": cell.id,
                "cell_name": cell.name,
                "families": {
                    family: next(
                        (
                            {
                                "status": "matched",
                                "block_id": block["id"],
                                "point_count": len(block["points"]),
                                "rate_count": len(block["rates_c"]),
                            }
                            for block in selected_for_cell
                            if block["family"] == family
                        ),
                        {"status": "not_detected", "block_id": None, "point_count": 0, "rate_count": 0},
                    )
                    for family in ("charge", "discharge")
                },
            }
        )
        sources.append(
            {
                "cell_id": cell.id,
                "file_hashes": hashes,
                "files": engine.source_file_entries(files, source_versions),
            }
        )
        if progress:
            progress(base + stages_per_cell, total_units, cell.name, "Rate sweeps detected")

    available_blocks = detected_blocks
    available = {
        "charge_rates_c": sorted(
            {
                round(rate, 6)
                for block in available_blocks
                if block["family"] == "charge"
                for rate in block["rates_c"]
            }
        ),
        "discharge_rates_c": sorted(
            {
                round(rate, 6)
                for block in available_blocks
                if block["family"] == "discharge"
                for rate in block["rates_c"]
            }
        ),
        "charge_fixed_rates_c": sorted(
            {
                round(block["fixed_rate_c"], 6)
                for block in available_blocks
                if block["family"] == "charge"
            }
        ),
        "discharge_fixed_rates_c": sorted(
            {
                round(block["fixed_rate_c"], 6)
                for block in available_blocks
                if block["family"] == "discharge"
            }
        ),
        "charge_structures": sorted(
            {block["charge_structure"] for block in available_blocks}
        ),
    }
    compatibility: dict[str, dict] = {}
    selected_cell_ids = {cell.id for cell in cells}
    for family in ("charge", "discharge"):
        family_blocks = [
            block for block in chosen_blocks if block["family"] == family
        ]
        fingerprints = sorted({block["fingerprint"] for block in family_blocks})
        matched_cell_ids = {block["cell_id"] for block in family_blocks}
        compatibility[family] = {
            "compatible": bool(family_blocks) and len(fingerprints) == 1,
            "complete": bool(cells) and matched_cell_ids == selected_cell_ids,
            "fingerprints": fingerprints,
        }
        if family_blocks and len(fingerprints) > 1:
            badges.append(
                {
                    "kind": "rate_capability_protocol_mismatch",
                    "family": family,
                    "detail": f"Selected cells resolved to different {family}-rate capability patterns.",
                }
            )
    if missing_refs:
        badges.extend(
            {
                "kind": "missing_reference",
                "detail": f"Selection references {item['kind']} #{item['ref_id']}, which no longer exists.",
            }
            for item in missing_refs
        )
    started = _profile_started(profiling)
    chosen_blocks, comparison = build_common_rate_comparison(
        chosen_blocks,
        cells,
        config["rate_tolerance_fraction"],
    )
    _profile_finished(profiling, "common_rate_comparison", started)
    _profile_count(
        profiling,
        "comparison_points",
        len(comparison.get("points") or []),
    )
    started = _profile_started(profiling)
    invalid_pairs: set[tuple[int, str, int]] = set()
    for block in chosen_blocks:
        lower_ordinal = min(block["pair_ordinals"]) - 1
        upper_ordinal = max(block["pair_ordinals"]) + 1
        for row in all_executions:
            if (
                not row["valid"]
                and row["family"] == block["family"]
                and row["cell_id"] == block["cell_id"]
                and row["source_hash"] == block["source_hash"]
                and lower_ordinal <= row["pair_ordinal"] <= upper_ordinal
                and row["charge_structure"] == block["charge_structure"]
                and _close_rate(
                    row["fixed_rate_c"],
                    block["fixed_rate_c"],
                    config["rate_tolerance_fraction"],
                )
            ):
                invalid_pairs.add(
                    (row["cell_id"], row["source_hash"], row["pair_ordinal"])
                )
    _profile_finished(profiling, "invalid_neighbour_execution_validation", started)
    _profile_count(profiling, "invalid_execution_pairs", len(invalid_pairs))
    started = _profile_started(profiling)
    result = {
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "type": "rate_capability",
        "parser_version": engine.display_parser_version(all_pinned_versions),
        "calc_version": calc_version,
        "current_parser_version": engine.display_parser_version(all_current_versions),
        "current_calc_version": CALC_VERSION,
        "config": config,
        "blocks": chosen_blocks,
        "detected_blocks": [
            {key: value for key, value in block.items() if key != "points"}
            for block in detected_blocks
        ],
        "points": [
            point for block in chosen_blocks for point in block["points"]
        ],
        "comparison": comparison,
        "available": available,
        "invalid_execution_count": len(invalid_pairs),
        "cells": cell_results,
        "selection_contexts": [
            {
                "cell_id": unit["cell"].id,
                "entry_kind": unit["entry_kind"],
                "entry_ref_id": unit["entry_ref_id"],
            }
            for unit in units
        ],
        "compatibility": compatibility,
        "badges": badges,
        "sources": sources,
    }
    _profile_finished(profiling, "result_provenance_assembly", started)
    _profile_count(
        profiling,
        "final_response_points",
        len(result.get("points") or []),
    )
    return result
