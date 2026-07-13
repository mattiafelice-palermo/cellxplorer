"""Reconstruct a readable Neware protocol from preserved header metadata.

The output is deliberately structural. It reports explicit step settings and
loop boundaries without guessing scientific intent such as formation, RPT, or
rate capability.
"""
from __future__ import annotations

from collections import Counter
import re
from statistics import median
from typing import Any


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
    result["summary"] = _step_summary(result)
    return result


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


def _structural_groups(steps: list[dict]) -> list[dict]:
    if not steps:
        return []
    loops = [step for step in steps if step["type_id"] == 5 and step["loop_start_step"]]
    covered: set[int] = set()
    groups: list[dict] = []
    for loop in loops:
        start = loop["loop_start_step"]
        end = loop["number"] - 1
        member_ids = [step["number"] for step in steps if start <= step["number"] <= end]
        covered.update(member_ids)
        groups.append(
            {
                "kind": "repeated_block",
                "label": "Repeated block",
                "start_step": start,
                "end_step": end,
                "repeat_count": loop["loop_count"],
                "control_step": loop["number"],
                "step_numbers": member_ids,
                "summary": f"Steps {start}-{end}, repeated {loop['loop_count']} times",
            }
        )

    # Preserve every uncovered executable step in neutral contiguous runs.
    run: list[int] = []
    for step in steps:
        number = step["number"]
        if step["type_id"] in {5, 6} or number in covered:
            if run:
                groups.append(_sequence_group(run, run[0] == steps[0]["number"]))
                run = []
            continue
        if run and number != run[-1] + 1:
            groups.append(_sequence_group(run, run[0] == steps[0]["number"]))
            run = []
        run.append(number)
    if run:
        groups.append(_sequence_group(run, run[0] == steps[0]["number"]))
    return sorted(groups, key=lambda group: (group["start_step"], group["kind"] != "repeated_block"))


def _sequence_group(step_numbers: list[int], first: bool) -> dict:
    start, end = step_numbers[0], step_numbers[-1]
    label = "Initial sequence" if first else "Step sequence"
    return {
        "kind": "sequence",
        "label": label,
        "start_step": start,
        "end_step": end,
        "repeat_count": 1,
        "control_step": None,
        "step_numbers": step_numbers,
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
        "n_steps": len(steps),
        "n_executable_steps": len(executable),
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
