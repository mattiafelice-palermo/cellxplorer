"""Explicit, measurement-only MPR fallback after semantic interpretation fails.

The structural reader remains authoritative. This module never repairs bytes,
deduplicates measurements, infers current from a control target, or emits cycles.
"""
from __future__ import annotations

import struct
import numpy as np
import pandas as pd

from .biologic_mpr import MprDocument, InvalidMprError, mpr_technique_id, MPR_CP_TECHNIQUE_ID, MPR_OCV_TECHNIQUE_ID

MODE_KEY = "mpr_read_mode"
NOTICE = ("Permissive MPR reading: scientific interpretation is unverified. "
          "Recorded voltage curves are available; unresolved cycles, capacity and CE are unavailable.")


def validate_metadata_envelopes(document: MprDocument) -> None:
    """Reject truncated nested fields before any semantic fallback is allowed."""
    from . import biologic_gcpl as gcpl

    payload = bytes(document.vmp_set.payload)
    if not payload:
        raise InvalidMprError("MPR settings payload is truncated")
    profile = gcpl._GCPL_SETTINGS_PROFILE_BY_TECHNIQUE_ID.get(payload[0])
    if profile is not None:
        end = profile.parameter_offset + 4
        if len(payload) < end:
            raise InvalidMprError("MPR GCPL settings payload is truncated")
        count, parameters = struct.unpack_from("<HH", payload, profile.parameter_offset)
        if parameters == profile.parameter_count and end + count * profile.parameter_itemsize > len(payload):
            raise InvalidMprError("MPR GCPL settings parameter block is truncated")
        for name, offset in gcpl._GCPL_PASCAL_FIELDS.items():
            if offset >= len(payload) or offset + 1 + payload[offset] > len(payload):
                raise InvalidMprError(f"MPR settings {name} string is truncated")
    if document.vmp_log is not None:
        payload = bytes(document.vmp_log.payload)
        for name, offset in gcpl._GCPL_LOG_PASCAL_FIELDS.items():
            if offset < len(payload) and offset + 1 + payload[offset] > len(payload):
                raise InvalidMprError(f"MPR LOG {name} string is truncated")


def map_measurements(document: MprDocument, error: Exception) -> pd.DataFrame:
    records = document.vmp_data.records
    names = set(records.dtype.names or ())
    is_curve = mpr_technique_id(document) in {MPR_CP_TECHNIQUE_ID, MPR_OCV_TECHNIQUE_ID}
    voltage_field = "raw_context_dependent_working_potential" if is_curve else "raw_ewe_v"
    if voltage_field not in names:
        voltage_field = None
    required = {"elapsed_time_s"}
    if not required.issubset(names) or voltage_field is None or not len(records):
        raise InvalidMprError("MPR exploratory reading requires decoded time, voltage and sequence fields")
    time = records["elapsed_time_s"].astype(float)
    working = records[voltage_field].astype(float)
    if not np.isfinite(time).all() or not np.isfinite(working).all() or np.any(time < 0):
        raise InvalidMprError("MPR exploratory time and voltage must be finite and time non-negative")
    cp_counter = mpr_technique_id(document) == MPR_CP_TECHNIQUE_ID and "raw_mean_counter_potential" in names
    counter = (records["raw_mean_counter_potential"].astype(float) if cp_counter else
               records["raw_ece_v"].astype(float) if "raw_ece_v" in names and not is_curve else None)
    if counter is not None and not np.isfinite(counter).all():
        raise InvalidMprError("MPR exploratory counter potential must be finite")
    ns = records["raw_sample_index"].astype(np.int64) if "raw_sample_index" in names else np.zeros(len(records), dtype=np.int64)
    if np.any(ns < 0):
        raise InvalidMprError("MPR exploratory sequence identity cannot be negative")
    # Preserve acquisition order and native elapsed clock. Each regression starts
    # a separate display segment; canonical step time is local to that segment.
    regression = np.r_[False, np.diff(time) < 0]
    boundaries = np.r_[True, np.diff(ns) != 0] | regression
    starts = np.maximum.accumulate(np.where(boundaries, np.arange(len(time)), 0))
    steps = np.cumsum(boundaries)
    segments = 1 + np.cumsum(regression)
    frame = pd.DataFrame({
        "record_index": np.arange(1, len(time) + 1, dtype=np.int64),
        "cycle": segments, "step_index": ns + 1, "step": steps,
        "status": "Unverified", "time_s": time - time[starts],
        "voltage_v": working if counter is None else working - counter,
        "current_ma": np.nan, "charge_capacity_mah": np.nan,
        "discharge_capacity_mah": np.nan, "timestamp": pd.NaT,
        "cycle_complete": False, "source_technique": "biologic_exploratory",
        "mpr_elapsed_time_s": time, "mpr_acquisition_segment": segments,
        "mpr_read_mode": "permissive",
    })
    if counter is not None:
        frame["working_potential_v"] = working
        frame["counter_potential_v"] = counter
    for name in records.dtype.names or ():
        # Preserve all independently decoded fields as source evidence. They are
        # not canonical scientific quantities and are never used by calc.
        frame[f"mpr_{name}"] = records[name]
    warnings = [{"code": "biologic_permissive_reading", "severity": "warning",
                 "scope": "source", "message": NOTICE, "count": 1,
                 "examples": [{"reason": str(error)[:1000]}]}]
    for code, positions, message in (
        ("biologic_instrument_errors", np.flatnonzero(records["raw_flags"] & 8) if "raw_flags" in names else np.array([], dtype=int),
         "BioLogic instrument error flags are present in the original records."),
        ("biologic_clock_regressions", np.flatnonzero(regression),
         "The recorded acquisition clock moves backward; curves are split into separate segments."),
    ):
        if len(positions):
            warnings.append({"code": code, "severity": "warning", "scope": "source", "message": message,
                             "count": len(positions), "examples": [{"record_index": int(index) + 1} for index in positions[:3]]})
    frame.attrs["biologic_gcpl"] = {
        "cycle_source": "exploratory_unverified", "read_mode": "permissive",
        "scientific_interpretation": "unverified", "original_record_count": len(frame),
        "parser_warnings": warnings,
    }
    return frame
