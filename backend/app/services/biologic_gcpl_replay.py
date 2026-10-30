"""Omit only a fully evidenced adjacent GCPL measurement-block replay.

This is an adapter admission rule, not general deduplication. Any failed proof
returns the original records so normal time/semantic validation still rejects
the source. Original bytes, retained timestamps and half-cycle values never change.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

MAX_REPLAY_ROWS = 4096
MAX_REPLAY_BLOCKS = 32
REST_COUNTER_TOLERANCE_MAH = 2e-8
TIME_TOLERANCE_S = 1e-6


@dataclass(frozen=True)
class ReplayRecovery:
    records: np.ndarray
    retained_positions: np.ndarray | None = None
    skipped_blocks: tuple[dict[str, int], ...] = ()

    def warnings(self) -> list[dict[str, Any]]:
        if not self.skipped_blocks:
            return []
        count = sum(item["record_end"] - item["record_start"] + 1 for item in self.skipped_blocks)
        return [{
            "code": "biologic_replayed_records_skipped", "scope": "source", "severity": "info", "count": count,
            "message": (f"Skipped {count} repeated records in {len(self.skipped_blocks)} replayed blocks. "
                        "Calculations use the remaining measurements; the original file is unchanged."),
            "examples": list(self.skipped_blocks),
        }]


def recover_replayed_blocks(
    records: np.ndarray, settings: Mapping[str, Any] | None, *, fully_compared_layout: bool,
) -> ReplayRecovery:
    unchanged = ReplayRecovery(records)
    names = records.dtype.names or ()
    required = {"raw_flags", "raw_sample_index", "elapsed_time_s", "raw_half_cycle_index",
                "raw_q_charge_discharge_mAh", "raw_dq_mAh", "raw_control_v_or_mA", "raw_ewe_v", "raw_ece_v"}
    if not required.issubset(names) or len(records) < 2:
        return unchanged
    time = records["elapsed_time_s"]
    regressions = np.flatnonzero(np.diff(time) < -TIME_TOLERANCE_S) + 1
    if not len(regressions):
        return unchanged
    if (not fully_compared_layout or not settings
            or settings.get("settings_profile") != "gcpl-technique-77-v1"
            or len(regressions) > MAX_REPLAY_BLOCKS
            or any(records.dtype.fields[name][0].kind not in "biuf" for name in names)
            or sum(records.dtype.fields[name][0].itemsize for name in names) != records.dtype.itemsize):
        return unchanged
    sequences = settings.get("sequences") or []
    if [(item.get("step_index"), item.get("direction")) for item in sequences] != [
        (1, "rest"), (2, "charge"), (3, "discharge")
    ]:
        return unchanged

    keep = np.ones(len(records), dtype=bool)
    skipped: list[dict[str, int]] = []
    for start_value in regressions:
        start = int(start_value)
        if not keep[start]:
            return unchanged
        window = max(0, start - MAX_REPLAY_ROWS)
        candidates = np.flatnonzero(time[window:start] == time[start]) + window
        if len(candidates) != 1:
            return unchanged
        first = int(candidates[0])
        length = start - first
        end = start + length
        if end >= len(records) or not keep[first:start].all() or time[end] <= time[start - 1]:
            return unchanged
        # A complete loop must start at the rest boundary and resume at a new
        # rest boundary. A matching suffix of a phase is not sufficient proof.
        if ((first > 0 and records["raw_sample_index"][first - 1] == 0
             and records["raw_flags"][first - 1] & 3 == 3)
                or records["raw_sample_index"][end] != 0
                or records["raw_flags"][end] & 3 != 3):
            return unchanged
        earlier, replay = records[first:start], records[start:end]
        if (np.any(np.diff(earlier["elapsed_time_s"]) < 0)
                or any(not np.isfinite(earlier[name]).all() or not np.isfinite(replay[name]).all() for name in names)):
            return unchanged
        mode = earlier["raw_flags"] & 3
        ns = earlier["raw_sample_index"]
        boundaries = np.r_[0, np.flatnonzero((np.diff(mode) != 0) | (np.diff(ns) != 0)) + 1]
        ends = np.r_[boundaries[1:], length]
        if ([(int(ns[index]), int(mode[index])) for index in boundaries] != [(0, 3), (1, 1), (2, 1)]
                or np.any(ends - boundaries < 2)
                or np.any(earlier["raw_flags"] & 8)):
            return unchanged
        half = earlier["raw_half_cycle_index"].astype(np.int64)
        if (not np.array_equal(half, np.repeat(half[0] + np.arange(3), ends - boundaries))
                or not np.all(replay["raw_half_cycle_index"].astype(np.int64) - half == 2)):
            return unchanged
        rest = mode == 3
        # Mode 3 owns neutral current. The final rest record can already carry
        # the next charge control target; that target must still match exactly.
        if (any(np.any(earlier[name][rest] != 0) or np.any(replay[name][rest] != 0)
                for name in ("raw_current_ma", "current_ma") if name in names)
                or np.any(earlier["raw_dq_mAh"][rest] != 0)
                or np.any(replay["raw_dq_mAh"][rest] != 0)):
            return unchanged
        for name in names:
            if name == "raw_half_cycle_index":
                continue
            if name == "raw_q_charge_discharge_mAh":
                difference = replay[name][rest] - earlier[name][rest]
                if (not np.array_equal(earlier[name][~rest], replay[name][~rest])
                        or np.any(np.abs(difference) > REST_COUNTER_TOLERANCE_MAH)
                        or not np.all(difference == difference[0])):
                    return unchanged
            elif not np.array_equal(earlier[name], replay[name]):
                return unchanged
        keep[start:end] = False
        skipped.append({"record_start": start + 1, "record_end": end,
                        "matching_record_start": first + 1, "matching_record_end": start})
    positions = np.flatnonzero(keep)
    if np.any(np.diff(time[positions]) < -TIME_TOLERANCE_S):
        return unchanged
    return ReplayRecovery(records[positions], positions, tuple(skipped))
