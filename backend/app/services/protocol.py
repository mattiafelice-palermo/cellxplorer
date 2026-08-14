"""Reconstruct a readable Neware protocol from preserved header metadata.

The output is deliberately structural. It reports explicit step settings and
loop boundaries without guessing scientific intent such as formation, RPT, or
rate capability.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import re
from statistics import median
from typing import Any

import pandas as pd


STEP_TYPES = {
    1: ("CC charge", "charge"),
    2: ("CC discharge", "discharge"),
    3: ("CV charge", "charge"),
    4: ("Rest", "rest"),
    5: ("Cycle", "control"),
    6: ("End", "control"),
    7: ("CCCV charge", "charge"),
    8: ("CP discharge", "discharge"),
    9: ("CP charge", "charge"),
    10: ("CR discharge", "discharge"),
    13: ("Pause", "rest"),
    16: ("Pulse", "other"),
    17: ("Simulation", "other"),
    19: ("CV discharge", "discharge"),
    20: ("CCCV discharge", "discharge"),
    21: ("Control", "control"),
    22: ("OCV", "rest"),
    26: ("CPCV discharge", "discharge"),
    27: ("CPCV charge", "charge"),
}

COMMON_C_RATE_DENOMINATORS = (2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100)

SIGNATURE_FIELDS = (
    "number",
    "type_id",
    "current_ma",
    "target_voltage_v",
    "stop_voltage_v",
    "stop_current_ma",
    "time_limit_s",
    "record_interval_s",
    "record_voltage_delta_v",
    "protection_upper_v",
    "protection_lower_v",
    "loop_start_step",
    "loop_count",
)


def _number(value: object) -> float | None:
    if value is None:
        return None
    match = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", str(value))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _scaled(value: object, factor: float) -> float | None:
    number = _number(value)
    return None if number is None else number / factor


def _unique_numbers(values: list[float | None], digits: int = 6) -> list[float]:
    return sorted({round(value, digits) for value in values if value is not None})


def _step_prefix(flat: dict[str, str]) -> str | None:
    # NDAX metadata sometimes contains both the saved protocol (Step) and an
    # identical editor copy (EditStep). Prefer the executed Step tree.
    if any(key.startswith("Step.Step_Info.Step") for key in flat):
        return "Step.Step_Info."
    if any(key.startswith("EditStep.Step_Info.Step") for key in flat):
        return "EditStep.Step_Info."
    return None


def _step_maps(flat: dict[str, str]) -> list[tuple[int, dict[str, str]]]:
    prefix = _step_prefix(flat)
    if prefix is None:
        return []
    pattern = re.compile(rf"^{re.escape(prefix)}Step(\d+)\.(.+)$")
    steps: dict[int, dict[str, str]] = {}
    for key, value in flat.items():
        match = pattern.match(key)
        if match:
            steps.setdefault(int(match.group(1)), {})[match.group(2)] = value
    return sorted(steps.items())


def _infer_nominal_capacity_mah(step_maps: list[tuple[int, dict[str, str]]]) -> float | None:
    candidates: list[float] = []
    for _, data in step_maps:
        current_ma = _number(data.get("Limit.Main.Curr.Value"))
        explicit_rate = _number(data.get("Limit.Main.Rate.Value"))
        if current_ma is not None and explicit_rate is not None and explicit_rate != 0:
            candidates.append(abs(current_ma / explicit_rate))
    return median(candidates) if candidates else None


def _step_dict(step_number: int, data: dict[str, str], nominal_capacity_mah: float | None) -> dict:
    type_id = int(_number(data.get("Step_Type")) or 0)
    label, direction = STEP_TYPES.get(type_id, (f"Step type {type_id}", "other"))
    current_ma = _number(data.get("Limit.Main.Curr.Value"))
    explicit_rate = _number(data.get("Limit.Main.Rate.Value"))
    inferred_rate = None
    if explicit_rate is None and current_ma is not None and nominal_capacity_mah:
        inferred_rate = abs(current_ma) / nominal_capacity_mah
    stop_voltage_v = _scaled(data.get("Limit.Main.Stop_Volt.Value"), 10000.0)
    target_voltage_v = _scaled(data.get("Limit.Main.Volt.Value"), 10000.0)
    time_limit_s = _scaled(data.get("Limit.Main.Time.Value"), 1000.0)
    stop_current_ma = _number(data.get("Limit.Main.Stop_Curr.Value"))
    stop_c_rate = None
    if stop_current_ma is not None and nominal_capacity_mah:
        stop_c_rate = abs(stop_current_ma) / nominal_capacity_mah
    result = {
        "number": step_number,
        "type_id": type_id,
        "type": label,
        "direction": direction,
        "current_ma": current_ma,
        "c_rate": explicit_rate if explicit_rate is not None else inferred_rate,
        "c_rate_source": "explicit" if explicit_rate is not None else "inferred" if inferred_rate is not None else None,
        "target_voltage_v": target_voltage_v,
        "stop_voltage_v": stop_voltage_v,
        "stop_current_ma": stop_current_ma,
        "stop_c_rate": stop_c_rate,
        "stop_c_rate_source": "inferred" if stop_c_rate is not None else None,
        "time_limit_s": time_limit_s,
        "record_interval_s": _scaled(data.get("Record.Main.Time.Value"), 1000.0),
        "record_voltage_delta_v": _scaled(data.get("Record.Main.Volt.Value"), 10000.0),
        "protection_upper_v": _scaled(data.get("Protect.Main.Volt.Upper.Value"), 10000.0),
        "protection_lower_v": _scaled(data.get("Protect.Main.Volt.Lower.Value"), 10000.0),
        "loop_start_step": int(_number(data.get("Limit.Other.Start_Step.Value")) or 0) or None,
        "loop_count": int(_number(data.get("Limit.Other.Cycle_Count.Value")) or 0) or None,
    }
    result["conditions"] = _step_conditions(data)
    result["summary"] = _step_summary(result)
    result["facts"] = _step_facts(result)
    return result


def _step_conditions(data: dict[str, str]) -> list[dict]:
    """The step's limit conditions, reported exactly as the file states them.

    Many steps are indistinguishable by their settings alone — seven C/3
    discharges in the Alava protocol share a rate and a cutoff — and the
    condition is the only thing separating "discharge fully" from "discharge
    half the reference capacity". The expression references cycler variables
    (``User1``, ``ChargeAh``), which are the protocol author's own words.

    Values are passed through verbatim. In particular the comparison operator
    is *not* translated: ``CmpType`` is an undocumented integer here, and
    rendering a guessed ``<=`` beside a real expression would look precise
    while risking being backwards.
    """
    conditions: list[dict] = []
    for index in (1, 2):
        prefix = f"Limit.Other.Cnd{index}."
        expression = data.get(prefix + "Expression")
        if not expression:
            continue
        jump = _number(data.get(prefix + "Jump_Line"))
        global_user_id = int(
            _number(data.get(prefix + "GlobleUserID")) or 0
        ) or None
        stores_as = (
            f"User{global_user_id - 70}"
            if global_user_id is not None and 71 <= global_user_id <= 170
            else None
        )
        conditions.append(
            {
                "expression": str(expression),
                "name": str(data.get(prefix + "ExpressionName") or "") or None,
                "value": _number(data.get(prefix + "Value")),
                "comparator_id": int(_number(data.get(prefix + "CmpType")) or 0) or None,
                # 65526 is a sentinel the cycler uses for "no jump", not a step.
                "jump_step": int(jump) if jump and 0 < jump < 60000 else None,
                # Neware records a capacity expression into a numbered global
                # user variable through this field. The file calls it
                # ``GlobleUserID``; IDs 71, 72, ... correspond to User1,
                # User2, ... . Exposing the relationship lets scientific
                # matchers trace formulas without depending on the author's
                # chosen variable number.
                "global_user_id": global_user_id,
                "stores_as": stores_as,
            }
        )
    for key, value in data.items():
        if key.endswith("LimitCndData.Value2.Expression"):
            conditions.append(
                {
                    "expression": str(value),
                    "name": str(data.get("LimitCndData.Value2.ExpressionName") or "") or None,
                    "value": None,
                    "comparator_id": None,
                    "jump_step": None,
                    "global_user_id": None,
                    "stores_as": None,
                }
            )
    return conditions


def _format_duration(seconds: float) -> str:
    if seconds >= 3600 and seconds % 3600 == 0:
        return f"{seconds / 3600:g} h"
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds / 60:g} min"
    return f"{seconds:g} s"


def _format_c_rate(value: float) -> str:
    if value <= 0:
        return f"{value:g}C"
    if value >= 1:
        rounded = round(value)
        if rounded and abs(value - rounded) / rounded <= 0.02:
            return f"{rounded:g}C"
        return f"{value:g}C"
    reciprocal = 1 / value
    closest = min(COMMON_C_RATE_DENOMINATORS, key=lambda denominator: abs(denominator - reciprocal))
    if abs(reciprocal - closest) / closest <= 0.08:
        return f"C/{closest:g}"
    rounded = round(reciprocal)
    if rounded >= 2 and abs(reciprocal - rounded) / rounded <= 0.02:
        return f"C/{rounded:g}"
    return f"{value:g}C"


def _step_facts(step: dict) -> list[dict]:
    """The same settings as ``summary``, split into labelled values.

    ``summary`` packs a step into one pipe-separated line, which is dense to
    read when a protocol runs to a hundred steps. These parts let a UI lay the
    settings out with their meanings visible, without re-deriving C-rates or
    durations client-side and risking a different rounding.

    Every value here also appears in ``summary``; a test holds the two together.
    """
    facts: list[dict] = []

    def add(key: str, label: str, value: str, note: str | None = None) -> None:
        facts.append({"key": key, "label": label, "value": value, "note": note})

    if step["c_rate"] is not None:
        add(
            "rate",
            "Rate",
            _format_c_rate(step["c_rate"]),
            None if step["c_rate_source"] == "explicit" else "inferred",
        )
    elif step["current_ma"] is not None:
        add("current", "Current", f"{step['current_ma']:g} mA")
    if step["target_voltage_v"] is not None:
        add("hold", "Hold at", f"{step['target_voltage_v']:g} V")
    if step["stop_voltage_v"] is not None:
        add("to", "To", f"{step['stop_voltage_v']:g} V")
    if step["stop_c_rate"] is not None:
        add(
            "until",
            "Until",
            _format_c_rate(step["stop_c_rate"]),
            "inferred" if step["stop_c_rate_source"] == "inferred" else None,
        )
    elif step["stop_current_ma"] is not None:
        add("until", "Until", f"{step['stop_current_ma']:g} mA")
    if step["time_limit_s"] is not None:
        duration = _format_duration(step["time_limit_s"])
        if step["direction"] == "rest":
            add("duration", "Duration", duration)
        else:
            add("limit", "Time limit", duration)
    if step["loop_start_step"] is not None:
        add(
            "repeat",
            "Repeat",
            f"steps {step['loop_start_step']}-{step['number'] - 1} x{step['loop_count']}",
        )
    return facts


def _step_summary(step: dict) -> str:
    parts = [step["type"]]
    if step["c_rate"] is not None:
        suffix = "" if step["c_rate_source"] == "explicit" else " (inferred)"
        parts.append(f"{_format_c_rate(step['c_rate'])}{suffix}")
    elif step["current_ma"] is not None:
        parts.append(f"{step['current_ma']:g} mA")
    if step["target_voltage_v"] is not None:
        parts.append(f"at {step['target_voltage_v']:g} V")
    if step["stop_voltage_v"] is not None:
        parts.append(f"to {step['stop_voltage_v']:g} V")
    if step["stop_c_rate"] is not None:
        parts.append(f"until {_format_c_rate(step['stop_c_rate'])}")
    elif step["stop_current_ma"] is not None:
        parts.append(f"until {step['stop_current_ma']:g} mA")
    if step["direction"] == "rest" and step["time_limit_s"] is not None:
        parts.append(_format_duration(step["time_limit_s"]))
    elif step["time_limit_s"] is not None:
        parts.append(f"limit {_format_duration(step['time_limit_s'])}")
    if step["loop_start_step"] is not None:
        parts.append(f"repeat steps {step['loop_start_step']}-{step['number'] - 1} x{step['loop_count']}")
    return " | ".join(parts)


def _protocol_signature(
    steps: list[dict],
    *,
    extra_fields: tuple[str, ...] = (),
) -> str:
    """Hash executable settings without source or inferred display values."""
    canonical_steps = []
    fields = SIGNATURE_FIELDS + tuple(
        field for field in extra_fields if field not in SIGNATURE_FIELDS
    )
    for step in steps:
        item = {field: step.get(field) for field in fields}
        item["explicit_c_rate"] = (
            step.get("c_rate") if step.get("c_rate_source") == "explicit" else None
        )
        canonical_steps.append(item)
    payload = json.dumps(
        {"signature_version": 1, "steps": canonical_steps},
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def observed_step_coverage(frame: pd.DataFrame | None) -> list[dict]:
    """Summarize executed protocol-step occurrences from a raw cache slice."""
    if frame is None or frame.empty or "step_index" not in frame.columns:
        return []

    columns = ["step_index"]
    if "cycle" in frame.columns:
        columns.append("cycle")
    if "step" in frame.columns:
        columns.append("step")
    work = frame.loc[:, columns].copy()
    work["step_index"] = pd.to_numeric(work["step_index"], errors="coerce")
    work = work.dropna(subset=["step_index"])
    if work.empty:
        return []
    work["step_index"] = work["step_index"].astype("int64")

    if "step" in work.columns:
        work["step"] = pd.to_numeric(work["step"], errors="coerce")
        execution_counts = work.groupby("step_index", sort=True)["step"].nunique(dropna=True)
    else:
        work["__run_start"] = work["step_index"].ne(work["step_index"].shift()).astype("int64")
        execution_counts = work.groupby("step_index", sort=True)["__run_start"].sum()

    cycles_by_step: dict[int, list[int]] = {}
    if "cycle" in work.columns:
        work["cycle"] = pd.to_numeric(work["cycle"], errors="coerce")
        cycles_by_step = {
            int(step_index): sorted({int(value) for value in values.dropna()})
            for step_index, values in work.groupby("step_index", sort=True)["cycle"]
        }

    return [
        {
            "step_index": int(step_index),
            "execution_count": int(execution_count),
            "cycle_count": len(cycles_by_step.get(int(step_index), [])),
            "cycles": cycles_by_step.get(int(step_index), []),
        }
        for step_index, execution_count in execution_counts.items()
    ]


# Control steps carry no measurement: 5 is a Cycle (loop) marker, 6 is End.
_CONTROL_TYPE_IDS = {5, 6}


def _structural_groups(steps: list[dict]) -> list[dict]:
    """Describe the protocol as the nested block structure the file declares.

    A Neware loop step repeats the range ``[loop_start_step, its own number - 1]``,
    and those ranges nest: an ageing block sits inside an outer test block that
    may itself repeat hundreds of times. Reporting every loop as a peer — as
    this once did — flattens a three-deep structure into overlapping siblings,
    where an inner block appears alongside the block that contains it.

    Nesting them also makes the interesting parts selectable without guessing
    what they mean. The steps between an outer loop's start and its first inner
    loop become a sequence child of that outer loop, which is how a diagnostic
    block or a single ageing cycle becomes one clickable node. No attempt is
    made to name such nodes: protocols vary, and a wrong scientific label is
    worse than a plain structural one.
    """
    if not steps:
        return []
    by_number = {step["number"]: step for step in steps}
    loops = [step for step in steps if step.get("loop_start_step")]
    # A malformed loop pointing forwards would make the range logic meaningless.
    loops = [loop for loop in loops if loop["loop_start_step"] < loop["number"]]
    lo = min(by_number)
    hi = max(by_number)
    return _nodes_in_range(lo, hi, loops, by_number, depth=0, first_overall=lo)


def _loop_body(loop: dict) -> tuple[int, int]:
    """The steps a loop repeats: from its start step up to just before itself."""
    return loop["loop_start_step"], loop["number"] - 1


def _nodes_in_range(
    lo: int,
    hi: int,
    loops: list[dict],
    by_number: dict[int, dict],
    depth: int,
    first_overall: int,
) -> list[dict]:
    """Build the nodes covering steps ``lo..hi``, nesting any loops within."""
    enclosed = [
        loop
        for loop in loops
        if lo <= loop["loop_start_step"] and loop["number"] <= hi
    ]
    # Keep only the loops not contained in another enclosed loop's body, so each
    # recursion level handles one tier and hands the rest to its children.
    direct: list[dict] = []
    for loop in enclosed:
        start, end = _loop_body(loop)
        inside_another = any(
            other is not loop
            and other["loop_start_step"] <= start
            and loop["number"] <= _loop_body(other)[1]
            for other in enclosed
        )
        if not inside_another:
            direct.append(loop)
    direct.sort(key=lambda loop: loop["loop_start_step"])

    nodes: list[dict] = []
    cursor = lo
    for loop in direct:
        start, end = _loop_body(loop)
        nodes.extend(_sequence_nodes(cursor, start - 1, by_number, depth, first_overall))
        children = _nodes_in_range(start, end, loops, by_number, depth + 1, first_overall)
        nodes.append(_loop_node(loop, children, by_number, depth))
        cursor = loop["number"] + 1
    nodes.extend(_sequence_nodes(cursor, hi, by_number, depth, first_overall))
    return nodes


def _executable_between(lo: int, hi: int, by_number: dict[int, dict]) -> list[int]:
    return [
        number
        for number in range(lo, hi + 1)
        if number in by_number and by_number[number]["type_id"] not in _CONTROL_TYPE_IDS
    ]


def _sequence_nodes(
    lo: int,
    hi: int,
    by_number: dict[int, dict],
    depth: int,
    first_overall: int,
) -> list[dict]:
    """Contiguous runs of measuring steps, split where the numbering breaks."""
    if lo > hi:
        return []
    nodes: list[dict] = []
    run: list[int] = []
    for number in _executable_between(lo, hi, by_number):
        if run and number != run[-1] + 1:
            nodes.append(_sequence_group(run, run[0] == first_overall, depth))
            run = []
        run.append(number)
    if run:
        nodes.append(_sequence_group(run, run[0] == first_overall, depth))
    return nodes


def _loop_node(
    loop: dict, children: list[dict], by_number: dict[int, dict], depth: int
) -> dict:
    start, end = _loop_body(loop)
    body = _executable_between(start, end, by_number)
    # A block with no nested block owns its steps outright. Wrapping them in a
    # lone sequence child would add a tier that says nothing: the child would
    # simply restate the block's own range.
    if not any(child["kind"] == "repeated_block" for child in children):
        children = []
    claimed = {number for child in children for number in child["all_step_numbers"]}
    direct_steps = [number for number in body if number not in claimed]
    all_steps = sorted(set(body) | claimed)
    return {
        "id": f"loop-{loop['number']}",
        "kind": "repeated_block",
        "label": "Repeated block",
        "start_step": start,
        "end_step": end,
        "repeat_count": loop["loop_count"],
        "control_step": loop["number"],
        "depth": depth,
        # Steps belonging to this block itself; nested blocks own the rest.
        "step_numbers": direct_steps,
        # Everything the block runs, including nested blocks — what a caller
        # should select when it selects this block.
        "all_step_numbers": all_steps,
        "children": children,
        "summary": f"Steps {start}-{end}, repeated {loop['loop_count']} times",
    }


def _sequence_group(step_numbers: list[int], first: bool, depth: int = 0) -> dict:
    start, end = step_numbers[0], step_numbers[-1]
    label = "Initial sequence" if first else "Step sequence"
    return {
        "id": f"seq-{start}-{end}",
        "kind": "sequence",
        "label": label,
        "start_step": start,
        "end_step": end,
        "repeat_count": 1,
        "control_step": None,
        "depth": depth,
        "step_numbers": step_numbers,
        "all_step_numbers": list(step_numbers),
        "children": [],
        "summary": f"Steps {start}-{end}" if start != end else f"Step {start}",
    }


def _window_counts(steps: list[dict], direction: str) -> list[dict]:
    values: list[float] = []
    for step in steps:
        if step["direction"] != direction:
            continue
        value = step["stop_voltage_v"]
        if value is None and "CV" in step["type"]:
            value = step["target_voltage_v"]
        if value is not None:
            values.append(round(value, 6))
    counts = Counter(values)
    return [
        {"voltage_v": voltage, "step_count": count}
        for voltage, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def build_declared_protocol(
    steps: list[dict],
    *,
    nominal_capacity_mah: float | None = None,
    warnings: list[str] | None = None,
    capabilities: dict[str, bool] | None = None,
    summary_extra: dict[str, Any] | None = None,
    signature_extra_fields: tuple[str, ...] = (),
) -> dict:
    """Build the shared declared-protocol response from adapter-owned steps.

    Source adapters own decoding and semantic classification.  This helper is
    the format-neutral response boundary: it supplies the same step/group,
    summary, signature, facts, and warning shape used by the existing Neware
    reconstruction without requiring a vendor-specific protocol API.
    """

    normalized_steps: list[dict] = []
    for source_step in steps:
        step = dict(source_step)
        step.setdefault("conditions", [])
        step["summary"] = _step_summary(step)
        step["facts"] = _step_facts(step)
        normalized_steps.append(step)

    control_ids = {5, 6, 21}
    executable = [
        step for step in normalized_steps if int(step.get("type_id") or 0) not in control_ids
    ]
    protection_windows = sorted(
        {
            (step.get("protection_lower_v"), step.get("protection_upper_v"))
            for step in executable
            if step.get("protection_lower_v") is not None
            or step.get("protection_upper_v") is not None
        }
    )
    record_intervals = _unique_numbers(
        [step.get("record_interval_s") for step in executable]
    )
    result_warnings = list(warnings or [])
    if not normalized_steps:
        result_warnings.append("No verified declared protocol step was found.")
    result_capabilities = dict(capabilities or {})
    result_capabilities.setdefault(
        "declared_protocol_available", bool(normalized_steps)
    )
    summary = {
        "charge_cutoffs": _window_counts(executable, "charge"),
        "discharge_cutoffs": _window_counts(executable, "discharge"),
        "protection_windows": [
            {"lower_v": lower, "upper_v": upper}
            for lower, upper in protection_windows
        ],
        "record_intervals_s": record_intervals,
    }
    if summary_extra:
        summary.update(summary_extra)
    return {
        "signature": _protocol_signature(
            normalized_steps,
            extra_fields=signature_extra_fields,
        ),
        "n_steps": len(normalized_steps),
        "n_executable_steps": len(executable),
        "nominal_capacity_mah": nominal_capacity_mah,
        "nominal_capacity_inferred": False,
        "steps": normalized_steps,
        "groups": _structural_groups(normalized_steps),
        "summary": summary,
        "warnings": result_warnings,
        "capabilities": result_capabilities,
    }


def reconstruct_protocol(flat: dict[str, str] | None, nominal_capacity_mah: float | None = None) -> dict:
    flat = flat or {}
    mapped_steps = _step_maps(flat)
    inferred_nominal = nominal_capacity_mah is None
    effective_nominal = nominal_capacity_mah or _infer_nominal_capacity_mah(mapped_steps)
    steps = [_step_dict(number, data, effective_nominal) for number, data in mapped_steps]
    executable = [step for step in steps if step["type_id"] not in {5, 6}]
    protection_windows = sorted(
        {
            (step["protection_lower_v"], step["protection_upper_v"])
            for step in executable
            if step["protection_lower_v"] is not None or step["protection_upper_v"] is not None
        }
    )
    record_intervals = _unique_numbers([step["record_interval_s"] for step in executable])
    warnings: list[str] = []
    protocol_conditions = flat.get("Excel.Capabilities.ProtocolConditions.Value")
    if protocol_conditions is not None and str(protocol_conditions).casefold() == "false":
        warnings.append(
            "This Neware Excel export does not contain protocol condition expressions; "
            "automatic Chargeability recognition may be unavailable."
        )
    if not steps:
        warnings.append("No Neware step definition was found in the stored header metadata.")
    if inferred_nominal and effective_nominal is not None:
        warnings.append("Nominal capacity was reconstructed from explicit protocol current/C-rate pairs for C-rate conversions.")
    if any(step["c_rate_source"] == "inferred" for step in executable):
        warnings.append("Some C-rates were inferred from current and nominal capacity.")
    if any(step["c_rate_source"] is None and step["current_ma"] is not None for step in executable):
        warnings.append("Some current-controlled steps have no C-rate because nominal capacity is unavailable.")
    charge_cutoffs = _window_counts(executable, "charge")
    discharge_cutoffs = _window_counts(executable, "discharge")
    if len(charge_cutoffs) > 1 or len(discharge_cutoffs) > 1:
        warnings.append("The protocol contains multiple operational voltage windows; all are shown rather than forcing one cutoff pair.")
    return {
        "signature": _protocol_signature(steps),
        "n_steps": len(steps),
        "n_executable_steps": len(executable),
        # The basis for every C-rate shown, so a reader can convert back to mA.
        "nominal_capacity_mah": effective_nominal,
        "nominal_capacity_inferred": inferred_nominal and effective_nominal is not None,
        "steps": steps,
        "groups": _structural_groups(steps),
        "summary": {
            "charge_cutoffs": charge_cutoffs,
            "discharge_cutoffs": discharge_cutoffs,
            "protection_windows": [
                {"lower_v": lower, "upper_v": upper} for lower, upper in protection_windows
            ],
            "record_intervals_s": record_intervals,
        },
        "warnings": warnings,
    }


def predominant_cutoff(flat: dict[str, str] | None, direction: str) -> float | None:
    windows = reconstruct_protocol(flat)["summary"][f"{direction}_cutoffs"]
    return windows[0]["voltage_v"] if windows else None
