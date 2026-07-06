"""Parsing service — the ONLY place NewareNDA is imported.

Route handlers never call the Neware library directly; they go through
here (usually indirectly via the cache service).
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Any

import NewareNDA
import pandas as pd

from . import fast_neware

logger = logging.getLogger(__name__)

PARSER_VERSION: str = NewareNDA.version.__version__

# Vectorized fast paths for NewareNDA — verified output-identical (see
# tests/test_fast_neware.py), so the cache parser version stays the same.
if os.environ.get("CELLXPLORER_FAST_NDAX", "1") != "0":
    fast_neware.install()

# canonical column names for the raw time-series cache
RAW_COLUMNS = {
    "Index": "record_index",
    "Cycle": "cycle",
    "Step": "step",
    "Step_Index": "step_index",
    "Status": "status",
    "Time": "time_s",
    "Voltage": "voltage_v",
    "Current(mA)": "current_ma",
    "Charge_Capacity(mAh)": "charge_capacity_mah",
    "Discharge_Capacity(mAh)": "discharge_capacity_mah",
    "Charge_Energy(mWh)": "charge_energy_mwh",
    "Discharge_Energy(mWh)": "discharge_energy_mwh",
    "Timestamp": "timestamp",
}


def compute_hash(path: str | Path) -> str:
    """Content hash = file identity. sha256, streamed."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    """Full parse of a Neware file into a normalized DataFrame."""
    df = NewareNDA.read(str(path), software_cycle_number=True, log_level="WARNING")
    keep = {src: dst for src, dst in RAW_COLUMNS.items() if src in df.columns}
    df = df.rename(columns=keep)
    # keep any aux columns (temperature etc.) under their original names
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    if "status" in df.columns:
        df["status"] = df["status"].astype(str)
    return df


def _flatten(d: Any, prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(_flatten(v, f"{prefix}{k}." if prefix else f"{k}."))
    elif isinstance(d, list):
        for i, v in enumerate(d):
            out.update(_flatten(v, f"{prefix}{i}."))
    else:
        key = prefix.rstrip(".")
        if d is not None and str(d).strip():
            out[key] = str(d)
    return out


def read_header_metadata(path: str | Path) -> dict:
    """Cheap header/metadata extraction (no full parse).

    Returns {raw: <flattened dict>, barcode, remarks, device_info, channel,
    start_time, active_mass_mg, nda_version}.
    """
    path = Path(path)
    try:
        meta = NewareNDA.read_metadata(str(path))
    except Exception as exc:  # corrupt/unsupported file: still importable
        logger.warning("metadata read failed for %s: %s", path, exc)
        return {"raw": {}, "error": str(exc)}

    flat = _flatten(meta)
    result: dict[str, Any] = {"raw": flat}

    def find(*needles: str) -> str | None:
        for key, val in flat.items():
            low = key.lower()
            if any(low.endswith(n) or low == n for n in needles):
                return val
        return None

    def find_path(*parts: str) -> str | None:
        for wanted in parts:
            wanted_low = wanted.lower()
            for key, val in flat.items():
                if wanted_low in key.lower():
                    return val
        return None

    result["barcode"] = find("barcode")
    result["remarks"] = find_path("head_info.remark.value") or find("remarks", "remark")
    result["nda_version"] = find("nda_version", "bts_version", "version")
    result["start_time"] = find("starttime", "start_time", "startime")
    dev = find("devtype", "device", "devicetype")
    dev_id = find("devid", "deviceid")
    unit = find("unitid")
    chl = find("chlid", "channel", "chl")
    result["device_info"] = " ".join(x for x in (dev, dev_id and f"#{dev_id}") if x) or None
    result["channel"] = "-".join(x for x in (unit, chl) if x) or None
    mass = find("active_mass_mg", "activemass")
    try:
        result["active_mass_mg"] = float(mass) if mass else None
    except ValueError:
        result["active_mass_mg"] = None
    return result
