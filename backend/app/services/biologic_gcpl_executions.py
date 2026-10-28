"""Verified repeated GCPL acquisitions and acquisition-local phase pairing.

An execution label addresses one measured half, not a complete battery cycle.
Only a proven, non-overlapping, alternating acquisition cohort may promote
charge followed by discharge to a complete cycle. Ordinary continuation order
and every other adapter's cycle semantics are deliberately left alone.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

PROFILE = "gcpl-repeated-execution-v1"
MEASUREMENT_TYPE = "biologic_gcpl_repeated_execution"
MAX_EXECUTIONS = 4096
SUMMARY_KEY = "biologic_gcpl_repeated_executions"
_CURRENT_TOLERANCE = 1e-6


def acquisition_identity(log: Mapping[str, Any]) -> dict[str, Any] | None:
    """Require physical instrument/channel and exact source clock provenance."""
    device = log.get("device_serial")
    serial, channel = log.get("channel_serial"), log.get("channel_number")
    origin = log.get("ole_timestamp")
    start = log.get("start_time")
    if (not isinstance(device, str) or not device.strip() or len(device) > 96
            or type(serial) is not int or serial <= 0
            or type(channel) is not int or not 0 <= channel <= 255
            or not isinstance(origin, (float, int)) or isinstance(origin, bool)
            or not math.isfinite(origin) or not 20000 <= origin <= 100000
            or not isinstance(start, str) or not 1 <= len(start) <= 64):
        return None
    try:
        expected = datetime(1899, 12, 30) + timedelta(days=float(origin))
        if expected.isoformat(timespec="microseconds") != start:
            return None
    except (ValueError, OverflowError):
        return None
    return {"device_serial": device, "channel_serial": serial,
            "channel_number": channel, "acquisition_ole_hex": float(origin).hex(),
            "acquisition_start": start}


def is_repeated_frame(frame: pd.DataFrame) -> bool:
    if frame.empty or "measurement_type" not in frame.columns:
        return False
    return frame["measurement_type"].dropna().astype(str).unique().tolist() == [MEASUREMENT_TYPE]


def summary_from_frame(frame: pd.DataFrame) -> dict[str, Any] | None:
    """Build bounded pairing evidence from complete adapter-owned raw rows.

    Both row data and persisted adapter provenance must agree. A selected-row
    projection cannot stand in for a whole execution. Overflow declines pairing
    rather than truncating or rejecting otherwise readable raw trajectories.
    """
    required = {"record_index", "cycle", "cycle_complete", "step", "step_index",
                "timestamp", "total_time_s", "current_ma", "status",
                "charge_capacity_mah", "discharge_capacity_mah"}
    if not is_repeated_frame(frame) or not required.issubset(frame.columns):
        return None
    provenance = frame.attrs.get("biologic_gcpl", {})
    if not isinstance(provenance, dict) or provenance.get("execution_profile") != PROFILE:
        return None
    identity = provenance.get("execution_acquisition")
    if not isinstance(identity, dict) or set(identity) != {
        "device_serial", "channel_serial", "channel_number", "acquisition_ole_hex", "acquisition_start"
    }:
        return None
    try:
        reconstructed = acquisition_identity({
            **identity, "ole_timestamp": float.fromhex(identity["acquisition_ole_hex"]),
            "start_time": identity["acquisition_start"],
        })
    except (TypeError, ValueError):
        return None
    if reconstructed != identity or frame["cycle_complete"].fillna(True).astype(bool).any():
        return None
    execution = pd.to_numeric(frame["cycle"], errors="coerce").to_numpy(dtype=float)
    time = pd.to_numeric(frame["total_time_s"], errors="coerce").to_numpy(dtype=float)
    current = pd.to_numeric(frame["current_ma"], errors="coerce").to_numpy(dtype=float)
    record = pd.to_numeric(frame["record_index"], errors="coerce").to_numpy(dtype=float)
    timestamps = pd.to_datetime(frame["timestamp"], errors="coerce")
    if (not all(np.isfinite(values).all() for values in (execution, time, current, record))
            or timestamps.isna().any() or np.any(np.diff(time) < 0)
            or not np.array_equal(record, np.arange(1, len(frame) + 1))
            or provenance.get("execution_row_count") != len(frame)):
        return None
    starts = np.r_[0, np.flatnonzero(np.diff(execution) != 0) + 1]
    ends = np.r_[starts[1:], len(frame)]
    if (len(starts) < 2 or len(starts) > MAX_EXECUTIONS
            or not np.array_equal(execution[starts], np.arange(1, len(starts) + 1))
            or provenance.get("execution_count") != len(starts)):
        return None
    origin = pd.Timestamp(identity["acquisition_start"])
    expected_timestamps = origin + pd.to_timedelta(time, unit="s")
    if not np.array_equal(timestamps.to_numpy(), expected_timestamps.to_numpy()):
        return None
    episodes: list[dict[str, Any]] = []
    directions: set[int] = set()
    for label, (start, end) in enumerate(zip(starts, ends, strict=True), start=1):
        values = current[start:end]
        positive = bool(np.any(values > _CURRENT_TOLERANCE))
        negative = bool(np.any(values < -_CURRENT_TOLERANCE))
        if positive == negative or abs(values[0]) <= _CURRENT_TOLERANCE:
            return None
        direction = 1 if positive else -1
        directions.add(direction)
        active = np.abs(values) > _CURRENT_TOLERANCE
        # One active phase, followed only by owned neutral rest.
        if np.any(active[1:] & ~active[:-1]):
            return None
        step_indices = pd.to_numeric(frame["step_index"].iloc[start:end], errors="coerce")
        if step_indices.isna().any() or step_indices.nunique() != 1:
            return None
        capacity_column = "charge_capacity_mah" if direction > 0 else "discharge_capacity_mah"
        active_rows = frame.iloc[start:end].loc[active, ["step", capacity_column]]
        capacity = pd.to_numeric(active_rows[capacity_column], errors="coerce")
        if not np.isfinite(capacity).all() or (capacity < 0).any():
            return None
        by_step = active_rows.assign(_capacity=capacity).groupby("step", sort=False)["_capacity"]
        transferred = float((by_step.max() - by_step.min()).sum())
        episodes.append({"execution": label, "row_start": int(start), "row_end": int(end),
                         "start_s": float(time[start]), "end_s": float(time[end - 1]),
                         "direction": direction, "capacity_mah": transferred})
    if len(directions) != 1:
        return None
    return {"profile": PROFILE, "identity": dict(identity), "row_count": len(frame),
            "direction": directions.pop(), "episodes": episodes}


def validate_summary(value: Any) -> bool:
    """Validate a JSON index summary before it influences planning/fast paths."""
    if not isinstance(value, dict) or value.get("profile") != PROFILE:
        return False
    identity, episodes = value.get("identity"), value.get("episodes")
    if not isinstance(identity, dict) or not isinstance(episodes, list) or not 2 <= len(episodes) <= MAX_EXECUTIONS:
        return False
    try:
        if acquisition_identity({**identity, "ole_timestamp": float.fromhex(identity["acquisition_ole_hex"]),
                                 "start_time": identity["acquisition_start"]}) != identity:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    if type(value.get("direction")) is not int or value["direction"] not in {-1, 1}:
        return False
    cursor, previous_end = 0, -math.inf
    for label, episode in enumerate(episodes, start=1):
        if not isinstance(episode, dict):
            return False
        if any(type(episode.get(key)) is not int for key in ("execution", "row_start", "row_end", "direction")):
            return False
        if (episode["execution"] != label or episode["direction"] != value["direction"]
                or episode["row_start"] != cursor or episode["row_end"] <= cursor):
            return False
        start, end = episode.get("start_s"), episode.get("end_s")
        if (any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in (start, end))
                or start < 0 or end < start or start <= previous_end):
            return False
        capacity = episode.get("capacity_mah")
        if not isinstance(capacity, (int, float)) or isinstance(capacity, bool) or not math.isfinite(capacity) or capacity < 0:
            return False
        previous_end, cursor = end, episode["row_end"]
    return type(value.get("row_count")) is int and cursor == value["row_count"]


def pair_plan(left: dict[str, Any] | None, right: dict[str, Any] | None) -> list[tuple[int, dict[str, Any]]] | None:
    """Prove whole-episode chronology for two adjacent acquisition fragments."""
    if not validate_summary(left) or not validate_summary(right):
        return None
    if (left["identity"] != right["identity"] or left["direction"] == right["direction"]
            or any(episode["capacity_mah"] <= 0 for summary in (left, right) for episode in summary["episodes"])):
        return None
    episodes = sorted([(source, episode) for source, summary in enumerate((left, right))
                       for episode in summary["episodes"]], key=lambda item: item[1]["start_s"])
    for (_, previous), (_, following) in zip(episodes, episodes[1:]):
        if previous["end_s"] >= following["start_s"] or previous["direction"] == following["direction"]:
            return None
    return episodes


def paired_capacity_totals(summaries: Sequence[dict[str, Any] | None]) -> dict[str, float | int | None]:
    """Cheap Cell-list facts from the same validated chronology as raw stitch."""
    charges, discharges = [], []
    for index in eligible_pair_positions(summaries):
        episodes = pair_plan(summaries[index], summaries[index + 1])
        pending = None
        for _source, episode in episodes:
            if episode["direction"] > 0:
                pending = episode["capacity_mah"]
            elif pending is not None:
                charges.append(pending)
                discharges.append(episode["capacity_mah"])
                pending = None
    return {"count": len(charges),
            "total_charge_capacity_mah": sum(charges) if charges else None,
            "total_discharge_capacity_mah": sum(discharges) if discharges else None,
            "max_discharge_capacity_mah": max(discharges) if discharges else None}


def eligible_pair_positions(summaries: Sequence[dict[str, Any] | None]) -> list[int]:
    """Only an isolated two-source, adjacent cohort has verified pairing here.

    A third same-acquisition fragment could overlap/duplicate an execution.
    Never greedily choose whichever two happen to be first after reordering.
    An uninspectable repeated source also prevents proving cohort completeness.
    """
    if any(value is not None and value.get("pairing_unavailable") for value in summaries):
        return []
    cohorts: dict[tuple, list[int]] = {}
    for index, summary in enumerate(summaries):
        if validate_summary(summary):
            identity = tuple(sorted(summary["identity"].items()))
            cohorts.setdefault(identity, []).append(index)
    return [positions[0] for positions in cohorts.values()
            if len(positions) == 2 and positions[1] == positions[0] + 1
            and pair_plan(summaries[positions[0]], summaries[positions[1]]) is not None]


def pairing_summary_from_frame(frame: pd.DataFrame) -> dict[str, Any] | None:
    summary = summary_from_frame(frame)
    return summary if summary is not None else ({"pairing_unavailable": True} if is_repeated_frame(frame) else None)


def combine_pair(
    frames: Sequence[pd.DataFrame], *, global_start: int = 1,
    source_hashes: Sequence[str] = ("0", "1"), segment_start: int = 0,
) -> tuple[pd.DataFrame, list[dict[str, Any]], int] | None:
    """Chronologically combine a proven pair; preserve unpaired halves as raw."""
    if len(frames) != 2 or len(source_hashes) != 2:
        return None
    summaries = [summary_from_frame(frame) for frame in frames]
    episodes = pair_plan(*summaries)
    if episodes is None:
        return None
    maps: list[dict[int, int]] = [{}, {}]
    pending: tuple[int, int] | None = None
    next_cycle = global_start
    for source, episode in episodes:
        if episode["direction"] > 0:
            pending = source, episode["execution"]
        elif pending is not None:
            maps[pending[0]][pending[1]] = next_cycle
            maps[source][episode["execution"]] = next_cycle
            next_cycle += 1
            pending = None
    if next_cycle == global_start:
        return None
    prepared, metadata = [], []
    next_step = 1
    for source, frame in enumerate(frames):
        out = frame.copy()
        local = out["cycle"].astype("int64")
        out["source_cycle"] = local
        out["cycle"] = local.map(maps[source]).fillna(0).astype("int64")
        out["cycle_complete"] = out["cycle"].gt(0)
        out["display_only_cycle"] = ~out["cycle_complete"]
        out["segment"] = segment_start + source
        out["source_hash"] = source_hashes[source]
        local_steps = pd.unique(out["step"])
        step_map = {step: next_step + index for index, step in enumerate(local_steps)}
        out["step"] = out["step"].map(step_map).astype("int64")
        next_step += len(local_steps)
        out.attrs = {}
        prepared.append(out)
        complete = sorted(maps[source])
        metadata.append({"file_hash": source_hashes[source], "segment": segment_start + source,
                         "source_cycle_start": min(complete), "source_cycle_end": max(complete),
                         "source_cycle_count": len(complete), "cycle_start": global_start,
                         "cycle_end": next_cycle - 1, "incomplete_boundary_unknown": False,
                         "display_only_source_cycles": sorted(set(local).difference(complete)),
                         "cycle_mapping": dict(maps[source]),
                         "cycle_identity_source": "acquisition_charge_discharge_pairs"})
    merged = pd.concat(prepared, ignore_index=True).sort_values(
        ["total_time_s", "segment", "record_index"], kind="stable"
    ).reset_index(drop=True)
    merged["preview_time_s"] = merged["total_time_s"] - float(merged["total_time_s"].iloc[0])
    merged.attrs["cross_source_gcpl_cycle_ids"] = list(range(global_start, next_cycle))
    merged.attrs["raw_timestamp_start"] = merged["timestamp"].min().isoformat()
    return merged, metadata, next_cycle - global_start
