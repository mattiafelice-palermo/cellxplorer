"""Identify protocol diagnostic/support cycles for the portable report.

This mirrors the frontend cycle-plot filter. It uses the lower of the charge
and discharge capacities for each cycle, compares that value with a local
post-formation median for the same series, and hides lower-tail outliers. The
rule is intentionally generic: it does not depend on DCIR protocol
recognition, and the report keeps the complete underlying result.
"""
from __future__ import annotations

import math
from statistics import median

DIAGNOSTIC_SIGNALS = ("charge_capacity_mah", "discharge_capacity_mah")
DEFAULT_WINDOW = 21
DEFAULT_TOLERANCE = 0.25
DEFAULT_MIN_CYCLES = 12
DEFAULT_FORMATION_CYCLES = 0


def _finite_positive(value: object) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def find_diagnostic_cycles(
    cycles: list[int],
    capacities: list[float | None],
    *,
    window: int = DEFAULT_WINDOW,
    tolerance: float = DEFAULT_TOLERANCE,
    min_cycles: int = DEFAULT_MIN_CYCLES,
    formation_cycles: int = DEFAULT_FORMATION_CYCLES,
) -> set[int]:
    """Return lower-capacity outliers against a local post-formation median."""
    flagged: set[int] = set()
    post_formation_count = sum(cycle > formation_cycles for cycle in cycles)
    if post_formation_count < min_cycles:
        return flagged

    half = max(1, window // 2)
    for index, cycle in enumerate(cycles):
        if cycle <= formation_cycles:
            continue
        value = _finite_positive(capacities[index] if index < len(capacities) else None)
        if value is None:
            continue
        neighbourhood = []
        for neighbour_index in range(
            max(0, index - half), min(len(capacities), index + half + 1)
        ):
            if cycles[neighbour_index] <= formation_cycles:
                continue
            other = _finite_positive(capacities[neighbour_index])
            if other is not None:
                neighbourhood.append(other)
        if not neighbourhood:
            continue
        local = median(neighbourhood)
        if local > 0 and value < local * (1 - tolerance):
            flagged.add(cycle)
    return flagged


def find_in_series(
    series: dict,
    *,
    tolerance: float = DEFAULT_TOLERANCE,
    formation_cycles: int = DEFAULT_FORMATION_CYCLES,
) -> set[int]:
    quantities = series.get("quantities") or {}
    charge = quantities.get(DIAGNOSTIC_SIGNALS[0])
    discharge = quantities.get(DIAGNOSTIC_SIGNALS[1])
    cycles = series.get("x") or []
    if not charge or not discharge:
        return set()

    capacities: list[float | None] = []
    for index in range(len(cycles)):
        charge_capacity = _finite_positive(charge[index] if index < len(charge) else None)
        discharge_capacity = _finite_positive(
            discharge[index] if index < len(discharge) else None
        )
        capacities.append(
            min(charge_capacity, discharge_capacity)
            if charge_capacity is not None and discharge_capacity is not None
            else None
        )
    return find_diagnostic_cycles(
        cycles,
        capacities,
        tolerance=tolerance,
        formation_cycles=formation_cycles,
    )


def find_across(
    result: dict,
    *,
    tolerance: float = DEFAULT_TOLERANCE,
    formation_cycles: int = DEFAULT_FORMATION_CYCLES,
) -> list[int]:
    """Union of diagnostic cycles across the plotted series, sorted."""
    flagged: set[int] = set()
    for series in result.get("cell_series") or []:
        if series.get("excluded"):
            continue
        flagged |= find_in_series(
            series,
            tolerance=tolerance,
            formation_cycles=formation_cycles,
        )
    return sorted(flagged)


def cycle_ranges(cycles: list[int]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for cycle in sorted(set(cycles)):
        if ranges and cycle == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], cycle)
        else:
            ranges.append((cycle, cycle))
    return ranges


def format_ranges(cycles: list[int]) -> str:
    """Compact, auditable summary of hidden cycle runs."""
    return ", ".join(
        str(start) if start == end else f"{start}–{end}"
        for start, end in cycle_ranges(cycles)
    )
