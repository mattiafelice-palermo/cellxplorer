"""Automatic chargeability-protocol matching and raw-curve extraction.

A chargeability definition is semantic: an initial SoC bound, a final SoC
bound, and a minimum permitted charging rate. Protocol authors remain free to
renumber steps and user variables. Matching follows the arithmetic relations in
the protocol conditions and validates the selected CV event against executed
raw data.

No protocol expression is evaluated. A deliberately small AST parser accepts
only linear arithmetic over names and numeric constants.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from ..config import CALC_VERSION
from ..models import Cell, SourceFile
from . import cache, parsing, protocol

ProgressCallback = Callable[[int, int, str, str], None]


@dataclass(frozen=True)
class LinearExpression:
    coefficients: dict[str, float]
    constant: float = 0.0

    def scaled(self, factor: float) -> "LinearExpression":
        return LinearExpression(
            {name: value * factor for name, value in self.coefficients.items()},
            self.constant * factor,
        )

    def combined(
        self, other: "LinearExpression", factor: float = 1.0
    ) -> "LinearExpression":
        coefficients = dict(self.coefficients)
        for name, value in other.coefficients.items():
            coefficients[name] = coefficients.get(name, 0.0) + factor * value
            if abs(coefficients[name]) < 1e-12:
                coefficients.pop(name)
        return LinearExpression(coefficients, self.constant + factor * other.constant)


def _linear_node(node: ast.AST) -> LinearExpression | None:
    if isinstance(node, ast.Expression):
        return _linear_node(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return LinearExpression({}, float(node.value))
    if isinstance(node, ast.Name):
        return LinearExpression({node.id: 1.0})
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _linear_node(node.operand)
        if value is None:
            return None
        return value if isinstance(node.op, ast.UAdd) else value.scaled(-1.0)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
        left = _linear_node(node.left)
        right = _linear_node(node.right)
        if left is None or right is None:
            return None
        return left.combined(right, -1.0 if isinstance(node.op, ast.Sub) else 1.0)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        left = _linear_node(node.left)
        right = _linear_node(node.right)
        if left is None or right is None:
            return None
        if not left.coefficients:
            return right.scaled(left.constant)
        if not right.coefficients:
            return left.scaled(right.constant)
        return None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        numerator = _linear_node(node.left)
        denominator = _linear_node(node.right)
        if (
            numerator is None
            or denominator is None
            or denominator.coefficients
            or abs(denominator.constant) < 1e-12
        ):
            return None
        return numerator.scaled(1.0 / denominator.constant)
    return None


def parse_linear_expression(expression: str) -> LinearExpression | None:
    """Return a safe linear representation, or ``None`` when unsupported."""
    try:
        parsed = ast.parse(str(expression).replace("^", "**"), mode="eval")
    except (SyntaxError, ValueError):
        return None
    return _linear_node(parsed)


def _capacity_measurement_name(name: str, direction: str) -> bool:
    compact = "".join(character for character in name.lower() if character.isalnum())
    if direction == "charge":
        return (
            "charge" in compact
            and "discharge" not in compact
            and "dchg" not in compact
            and ("ah" in compact or "capacity" in compact)
        )
    return (
        ("discharge" in compact or "dchg" in compact)
        and ("ah" in compact or "capacity" in compact)
    )


def capacity_fraction(
    expression: str, direction: str
) -> tuple[str, float] | None:
    """Solve ``measurement / reference`` from a zero-valued condition.

    ``ChargeAh - 0.6*Anything`` and algebraically equivalent linear forms
    return ``("Anything", 0.6)``. The reference variable name is deliberately
    opaque; only its reuse across preparation and measurement steps matters.
    """
    linear = parse_linear_expression(expression)
    if linear is None or abs(linear.constant) > 1e-9:
        return None
    measurement_names = [
        name
        for name in linear.coefficients
        if _capacity_measurement_name(name, direction)
    ]
    if len(measurement_names) != 1:
        return None
    measurement = measurement_names[0]
    references = [name for name in linear.coefficients if name != measurement]
    if len(references) != 1:
        return None
    reference = references[0]
    measurement_coefficient = linear.coefficients[measurement]
    if abs(measurement_coefficient) < 1e-12:
        return None
    fraction = -linear.coefficients[reference] / measurement_coefficient
    if not np.isfinite(fraction) or fraction <= 0:
        return None
    return reference, float(fraction)


def _condition_fraction(step: dict, direction: str) -> tuple[str, float] | None:
    for condition in step.get("conditions") or []:
        relation = capacity_fraction(str(condition.get("expression") or ""), direction)
        if relation is not None:
            return relation
    return None


def _assignment_steps(steps: list[dict]) -> dict[str, list[dict]]:
    assignments: dict[str, list[dict]] = {}
    for step in steps:
        for condition in step.get("conditions") or []:
            stores_as = condition.get("stores_as")
            expression = parse_linear_expression(
                str(condition.get("expression") or "")
            )
            is_capacity_measurement = (
                expression is not None
                and abs(expression.constant) <= 1e-9
                and len(expression.coefficients) == 1
                and any(
                    _capacity_measurement_name(name, direction)
                    for name in expression.coefficients
                    for direction in ("charge", "discharge")
                )
            )
            if stores_as and is_capacity_measurement:
                assignments.setdefault(str(stores_as).lower(), []).append(step)
    return assignments


def _candidate_fingerprint(candidate: dict) -> str:
    semantic = {
        "initial_soc_pct": round(float(candidate["initial_soc_pct"]), 3),
        "final_soc_pct": round(float(candidate["final_soc_pct"]), 3),
        "current_ceiling_c": round(float(candidate["current_ceiling_c"]), 3),
        "target_voltage_v": round(float(candidate.get("target_voltage_v") or 0.0), 4),
        "mode": candidate.get("mode"),
    }
    return hashlib.sha256(
        json.dumps(semantic, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def detect_candidates(reconstructed: dict) -> list[dict]:
    """Find CV charge steps whose SoC window is declared by capacity ratios."""
    steps = list(reconstructed.get("steps") or [])
    assignments = _assignment_steps(steps)
    candidates: list[dict] = []
    for index, step in enumerate(steps):
        if step.get("direction") != "charge" or step.get("type_id") not in {3, 7, 27}:
            continue
        charge_relation = _condition_fraction(step, "charge")
        if charge_relation is None:
            continue
        reference_name, added_fraction = charge_relation
        preparation: dict | None = None
        preparation_fraction: float | None = None
        for previous in reversed(steps[:index]):
            relation = _condition_fraction(previous, "discharge")
            if relation and relation[0].lower() == reference_name.lower():
                preparation = previous
                preparation_fraction = relation[1]
                break
        if preparation is None or preparation_fraction is None:
            continue
        initial_soc = 100.0 * (1.0 - preparation_fraction)
        final_soc = initial_soc + 100.0 * added_fraction
        current_ceiling_c = step.get("c_rate")
        if (
            current_ceiling_c is None
            or not np.isfinite(current_ceiling_c)
            or not (-5.0 <= initial_soc <= 105.0)
            or not (-5.0 <= final_soc <= 105.0)
        ):
            continue
        assignment = next(
            (
                item
                for item in reversed(assignments.get(reference_name.lower(), []))
                if int(item.get("number") or 0) < int(step.get("number") or 0)
            ),
            None,
        )
        candidate = {
            "step_index": int(step["number"]),
            "preparation_step_index": int(preparation["number"]),
            "reference_step_index": (
                int(assignment["number"]) if assignment is not None else None
            ),
            "reference_variable": reference_name,
            "initial_soc_pct": initial_soc,
            "final_soc_pct": final_soc,
            "added_soc_pct": 100.0 * added_fraction,
            "removed_soc_pct": 100.0 * preparation_fraction,
            "current_ceiling_c": float(current_ceiling_c),
            "current_ceiling_ma": step.get("current_ma"),
            "target_voltage_v": step.get("target_voltage_v"),
            "stop_current_ma": step.get("stop_current_ma"),
            "time_limit_s": step.get("time_limit_s"),
            "mode": str(step.get("type") or "CV charge"),
            "condition": next(
                (
                    condition.get("expression")
                    for condition in step.get("conditions") or []
                    if capacity_fraction(str(condition.get("expression") or ""), "charge")
                    is not None
                ),
                None,
            ),
        }
        candidate["fingerprint"] = _candidate_fingerprint(candidate)
        candidates.append(candidate)
    return candidates


def _numeric(frame: pd.DataFrame, column: str) -> np.ndarray:
    if column not in frame:
        return np.full(len(frame), np.nan)
    return pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype="float64")


def _json_values(values: np.ndarray) -> list[float | None]:
    return [None if not np.isfinite(value) else float(value) for value in values]


def _reference_capacity(
    raw: pd.DataFrame, candidate: dict
) -> tuple[float | None, dict | None]:
    step_index = candidate.get("reference_step_index")
    if step_index is None or raw.empty:
        return None, None
    before = raw[raw["step_index"] == int(step_index)]
    if before.empty:
        return None, None
    measured: list[tuple[float, str, pd.Series]] = []
    for quantity in ("discharge_capacity_mah", "charge_capacity_mah"):
        if quantity not in before:
            continue
        values = pd.to_numeric(before[quantity], errors="coerce")
        maximum = float(values.max()) if values.notna().any() else float("nan")
        if np.isfinite(maximum) and maximum > 0:
            measured.append((maximum, quantity, values))
    if not measured:
        return None, None
    capacity, direction, values = max(measured, key=lambda item: item[0])
    row = before.loc[values.idxmax()]
    return capacity, {
        "kind": "protocol_recorded",
        "step_index": int(step_index),
        "cycle": int(row["cycle"]) if "cycle" in row and pd.notna(row["cycle"]) else None,
        "quantity": direction,
    }


def _occurrence_rows(
    raw: pd.DataFrame,
    candidate: dict,
    *,
    cell: Cell,
    source: SourceFile,
    label: str,
    nominal_capacity_mah: float | None,
    active_mass_mg: float | None,
    electrode_area_cm2: float | None,
) -> list[dict]:
    selected = raw[raw["step_index"] == int(candidate["step_index"])].copy()
    if selected.empty:
        return []
    grouping = "step" if "step" in selected else None
    groups = selected.groupby(grouping, sort=True) if grouping else [(1, selected)]
    reference_capacity, reference = _reference_capacity(raw, candidate)
    rows: list[dict] = []
    for occurrence_index, (_execution, frame) in enumerate(groups, start=1):
        order_column = (
            "record_index"
            if "record_index" in frame
            else "timestamp"
            if "timestamp" in frame
            else None
        )
        if order_column:
            frame = frame.sort_values(order_column)
        timestamps = (
            pd.to_datetime(frame["timestamp"], errors="coerce")
            if "timestamp" in frame
            else pd.Series(pd.NaT, index=frame.index)
        )
        if timestamps.notna().any():
            elapsed_s = (timestamps - timestamps.min()).dt.total_seconds().to_numpy(dtype="float64")
        else:
            elapsed_s = _numeric(frame, "time_s")
            finite = elapsed_s[np.isfinite(elapsed_s)]
            if len(finite):
                elapsed_s = elapsed_s - finite[0]
        capacity = _numeric(frame, "charge_capacity_mah")
        finite_capacity = capacity[np.isfinite(capacity)]
        capacity_origin = finite_capacity[0] if len(finite_capacity) else 0.0
        added_capacity = capacity - capacity_origin
        current = np.abs(_numeric(frame, "current_ma"))
        c_rate = (
            current / nominal_capacity_mah
            if nominal_capacity_mah and nominal_capacity_mah > 0
            else np.full(len(frame), np.nan)
        )
        mass_g = active_mass_mg / 1000.0 if active_mass_mg and active_mass_mg > 0 else None
        specific_capacity = (
            added_capacity / mass_g if mass_g else np.full(len(frame), np.nan)
        )
        areal_capacity = (
            added_capacity / electrode_area_cm2
            if electrode_area_cm2 and electrode_area_cm2 > 0
            else np.full(len(frame), np.nan)
        )
        specific_current = current / mass_g if mass_g else np.full(len(frame), np.nan)
        areal_current = (
            current / electrode_area_cm2
            if electrode_area_cm2 and electrode_area_cm2 > 0
            else np.full(len(frame), np.nan)
        )
        soc = (
            float(candidate["initial_soc_pct"])
            + 100.0 * added_capacity / reference_capacity
            if reference_capacity and reference_capacity > 0
            else np.full(len(frame), np.nan)
        )
        cycle_values = (
            pd.to_numeric(frame["cycle"], errors="coerce").dropna()
            if "cycle" in frame
            else pd.Series(dtype="float64")
        )
        delivered = (
            float(np.nanmax(added_capacity))
            if np.isfinite(added_capacity).any()
            else None
        )
        duration_s = (
            float(np.nanmax(elapsed_s)) if np.isfinite(elapsed_s).any() else None
        )
        observed_final_soc = (
            float(candidate["initial_soc_pct"]) + 100.0 * delivered / reference_capacity
            if delivered is not None and reference_capacity
            else None
        )
        rows.append(
            {
                "id": f"{cell.id}-{source.hash[:12]}-{candidate['step_index']}-{occurrence_index}",
                "cell_id": cell.id,
                "cell_name": cell.name,
                "label": label,
                "filename": source.filename,
                "source_hash": source.hash,
                "protocol_signature": candidate.get("protocol_signature"),
                "step_index": candidate["step_index"],
                "occurrence": occurrence_index,
                "cycle": int(cycle_values.iloc[0]) if len(cycle_values) else None,
                "initial_soc_pct": candidate["initial_soc_pct"],
                "final_soc_pct": candidate["final_soc_pct"],
                "observed_final_soc_pct": observed_final_soc,
                "current_ceiling_c": candidate["current_ceiling_c"],
                "current_ceiling_ma": candidate.get("current_ceiling_ma"),
                "target_voltage_v": candidate.get("target_voltage_v"),
                "mode": candidate.get("mode"),
                "fingerprint": candidate["fingerprint"],
                "reference_capacity_mah": reference_capacity,
                "reference": reference,
                "duration_s": duration_s,
                "delivered_capacity_mah": delivered,
                "actual_peak_current_ma": (
                    float(np.nanmax(current)) if np.isfinite(current).any() else None
                ),
                "actual_peak_c_rate": (
                    float(np.nanmax(c_rate)) if np.isfinite(c_rate).any() else None
                ),
                "x": {
                    "time_s": _json_values(elapsed_s),
                    "soc_pct": _json_values(np.asarray(soc, dtype="float64")),
                    "capacity_mah": _json_values(added_capacity),
                    "capacity_mah_g": _json_values(specific_capacity),
                    "capacity_mah_cm2": _json_values(areal_capacity),
                },
                "y": {
                    "current_ma": _json_values(current),
                    "c_rate": _json_values(c_rate),
                    "current_ma_g": _json_values(specific_current),
                    "current_ma_cm2": _json_values(areal_current),
                },
            }
        )
    return rows


def _filters(spec: dict) -> dict:
    configured = ((spec.get("computation") or {}).get("chargeability") or {})
    return {
        "initial_soc_max_pct": float(configured.get("initial_soc_max_pct", 20.0)),
        "final_soc_min_pct": float(configured.get("final_soc_min_pct", 80.0)),
        "min_current_ceiling_c": float(configured.get("min_current_ceiling_c", 7.0)),
        "soc_tolerance_pct": max(0.0, float(configured.get("soc_tolerance_pct", 2.0))),
    }


def _matches(candidate: dict, filters: dict) -> bool:
    tolerance = filters["soc_tolerance_pct"]
    return (
        candidate["initial_soc_pct"] <= filters["initial_soc_max_pct"] + tolerance
        and candidate["final_soc_pct"] >= filters["final_soc_min_pct"] - tolerance
        and candidate["current_ceiling_c"] >= filters["min_current_ceiling_c"]
    )


def compute(
    db: Session,
    spec: dict,
    provenance: dict | None,
    use_current_versions: bool = False,
    progress: ProgressCallback | None = None,
) -> dict:
    """Resolve matching chargeability events for every selected cell."""
    from . import analysis_engine as engine
    from . import scanner

    parser_version = parsing.PARSER_VERSION
    calc_version = CALC_VERSION
    if provenance and not use_current_versions:
        parser_version = provenance.get("parser_version") or parser_version
        calc_version = provenance.get("calc_version") or calc_version
    current_parser = parser_version == parsing.PARSER_VERSION
    filters = _filters(spec)
    units, missing_refs = engine.resolve_selection(db, spec)
    cells = list({unit["cell"].id: unit["cell"] for unit in units}.values())
    labels = {unit["cell"].id: unit["label"] for unit in units}
    engine.preload_cell_sources(db, cells)
    scalar_metadata = engine.load_scalar_metadata(db, cells)
    matches: list[dict] = []
    all_candidates: list[dict] = []
    cell_results: list[dict] = []
    sources: list[dict] = []
    badges: list[dict] = []

    stages_per_cell = 3
    total_units = max(1, len(cells) * stages_per_cell)

    for cell_index, cell in enumerate(cells, start=1):
        base = (cell_index - 1) * stages_per_cell
        if progress:
            progress(base, total_units, cell.name, "Reading cycles")
        metadata = scalar_metadata.get(cell.id)
        nominal = engine.cell_nominal_capacity_mah(cell, metadata)
        active_mass = engine.cell_active_mass_mg(cell, metadata)
        area = engine.cell_electrode_area_cm2(cell, metadata)
        hashes, files = engine.cell_ordered_hashes(db, cell)
        cell_matches: list[dict] = []
        cell_candidates: list[dict] = []
        if progress:
            progress(base + 1, total_units, cell.name, "Matching chargeability protocol")
        for source in files:
            if (
                current_parser
                and not cache.raw_path(source.hash, parser_version).exists()
                and Path(source.path).exists()
            ):
                scanner.parse_file(db, source)
            raw = cache.load_raw(source.hash, parser_version)
            reconstructed = protocol.reconstruct_protocol(source.header_meta, nominal)
            signature = str(reconstructed.get("signature") or "")
            detected = detect_candidates(reconstructed)
            for candidate in detected:
                candidate = {
                    **candidate,
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "filename": source.filename,
                    "source_hash": source.hash,
                    "protocol_signature": signature,
                    "matches_filters": _matches(candidate, filters),
                }
                cell_candidates.append(candidate)
                all_candidates.append(candidate)
                if candidate["matches_filters"] and raw is not None:
                    measured = _occurrence_rows(
                        raw,
                        candidate,
                        cell=cell,
                        source=source,
                        label=labels.get(cell.id, cell.name),
                        nominal_capacity_mah=nominal,
                        active_mass_mg=active_mass,
                        electrode_area_cm2=area,
                    )
                    cell_matches.extend(measured)
                    matches.extend(measured)
        if progress:
            progress(base + 2, total_units, cell.name, "Extracting charge curves")
        if not cell_candidates:
            badges.append(
                {
                    "kind": "chargeability_no_candidates",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "detail": "No voltage-controlled charge step with an inferable SoC window was found.",
                }
            )
        elif not cell_matches:
            badges.append(
                {
                    "kind": "chargeability_no_match",
                    "cell_id": cell.id,
                    "cell_name": cell.name,
                    "detail": "Chargeability candidates were found, but none satisfy the selected SoC and current limits.",
                }
            )
        fingerprints = sorted({item["fingerprint"] for item in cell_matches})
        cell_results.append(
            {
                "cell_id": cell.id,
                "cell_name": cell.name,
                "candidate_count": len(cell_candidates),
                "match_count": len(cell_matches),
                "fingerprints": fingerprints,
                "status": (
                    "matched"
                    if cell_matches
                    else "no_match"
                    if cell_candidates
                    else "no_candidates"
                ),
            }
        )
        sources.append(
            {
                "cell_id": cell.id,
                "file_hashes": hashes,
            }
        )
        if progress:
            progress(
                base + stages_per_cell,
                total_units,
                cell.name,
                "Chargeability match complete",
            )

    matched_fingerprints = sorted({item["fingerprint"] for item in matches})
    matched_cell_ids = {item["cell_id"] for item in matches}
    compatible = bool(matches) and len(matched_fingerprints) == 1
    complete = bool(cells) and matched_cell_ids == {cell.id for cell in cells}
    if matches and not compatible:
        badges.append(
            {
                "kind": "chargeability_protocol_mismatch",
                "detail": "Selected cells matched different chargeability protocols; curves are shown but are not directly equivalent.",
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
    return {
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "type": "chargeability",
        "parser_version": parser_version,
        "calc_version": calc_version,
        "current_parser_version": parsing.PARSER_VERSION,
        "current_calc_version": CALC_VERSION,
        "filters": filters,
        "available_filters": {
            "initial_soc_pct": sorted(
                {round(float(item["initial_soc_pct"]), 6) for item in all_candidates}
            ),
            "final_soc_pct": sorted(
                {round(float(item["final_soc_pct"]), 6) for item in all_candidates}
            ),
            "current_ceiling_c": sorted(
                {round(float(item["current_ceiling_c"]), 6) for item in all_candidates}
            ),
            "target_voltage_v": sorted(
                {
                    round(float(item["target_voltage_v"]), 6)
                    for item in all_candidates
                    if item.get("target_voltage_v") is not None
                }
            ),
        },
        "candidates": all_candidates,
        "matches": matches,
        "cells": cell_results,
        "compatibility": {
            "compatible": compatible,
            "complete": complete,
            "fingerprints": matched_fingerprints,
        },
        "badges": badges,
        "sources": sources,
    }
