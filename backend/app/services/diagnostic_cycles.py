"""Identify protocol diagnostic cycles for the portable report.

Mirror of ``frontend/src/diagnosticCycles.ts``. The report must state what a
filtered plot removed without depending on the app that produced it, so the
cycle list is resolved at export time and embedded in the document.

Keep the two implementations in step: same signals, same two-sided rule against
a rolling median, same defaults. The TypeScript side carries the reasoning and
the regression tests built from a real diagnostic block.
"""
from __future__ import annotations

from statistics import median

# Both are needed: a slow-rate check discharges for far longer than normal, and
# a fast-charge probe keeps a normal discharge and only its charge time differs.
DIAGNOSTIC_SIGNALS = ("discharge_time_h", "charge_time_h")
DEFAULT_WINDOW = 21
DEFAULT_TOLERANCE = 0.25
DEFAULT_MIN_CYCLES = 12


def find_diagnostic_cycles(
    cycles: list[int],
    values: list[float | None],
    *,
    window: int = DEFAULT_WINDOW,
    tolerance: float = DEFAULT_TOLERANCE,
    min_cycles: int = DEFAULT_MIN_CYCLES,
) -> set[int]:
    """Cycles whose value deviates from its neighbours in either direction."""
    flagged: set[int] = set()
    if len(cycles) < min_cycles:
        return flagged
    half = max(1, window // 2)
    for index, cycle in enumerate(cycles):
        value = values[index] if index < len(values) else None
        if value is None or not isinstance(value, (int, float)):
            continue
        neighbourhood = [
            other
            for other in values[max(0, index - half) : index + half + 1]
            if isinstance(other, (int, float)) and other > 0
        ]
        if not neighbourhood:
            continue
        local = median(neighbourhood)
        # A local median of zero carries no information about scale.
        if local <= 0:
            continue
        if abs(value - local) > local * tolerance:
            flagged.add(cycle)
    return flagged


def find_in_series(series: dict, *, tolerance: float = DEFAULT_TOLERANCE) -> set[int]:
    flagged: set[int] = set()
    quantities = series.get("quantities") or {}
    for signal in DIAGNOSTIC_SIGNALS:
        values = quantities.get(signal)
        if not values:
            continue
        flagged |= find_diagnostic_cycles(series.get("x") or [], values, tolerance=tolerance)
    return flagged


def find_across(result: dict, *, tolerance: float = DEFAULT_TOLERANCE) -> list[int]:
    """Union of diagnostic cycles across the plotted series, sorted."""
    flagged: set[int] = set()
    for series in result.get("cell_series") or []:
        if series.get("excluded"):
            continue
        flagged |= find_in_series(series, tolerance=tolerance)
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
    """Compact, auditable summary: '87-93, 170-176' rather than 123 numbers."""
    return ", ".join(
        str(start) if start == end else f"{start}–{end}"
        for start, end in cycle_ranges(cycles)
    )
